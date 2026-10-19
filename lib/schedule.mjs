// Critical-path scheduler. Tasks are placed on working days from fixed dates or
// from their dependencies (FS / SS / FF with lag); a backward pass gives slack,
// and zero-slack work is the critical path.

import { Calendar, toMs } from './calendar.mjs';

const later = (a, b) => (!a ? b : !b ? a : toMs(a) >= toMs(b) ? a : b);
const earlier = (a, b) => (!a ? b : !b ? a : toMs(a) <= toMs(b) ? a : b);

export function schedule(plan) {
  const errors = [];
  const warnings = [];
  const cal = new Calendar(plan.meta.calendar);
  const projectStart = cal.snapForward(plan.meta.start);

  const nodes = new Map();
  for (const t of plan.tasks || []) nodes.set(t.id, { id: t.id, kind: 'task', src: t, deps: normDeps(t.depends_on), succ: [] });
  for (const m of plan.milestones || []) nodes.set(m.id, { id: m.id, kind: 'milestone', src: m, deps: normDeps(m.depends_on), succ: [] });
  for (const n of nodes.values()) for (const d of n.deps) nodes.get(d.id)?.succ.push({ id: n.id, type: d.type, lag: d.lag });

  const order = topo(nodes, errors);
  if (!order) return { errors, warnings };

  // ---- forward pass ----------------------------------------------------------
  for (const id of order) {
    const n = nodes.get(id);
    const s = n.src;
    if (n.kind === 'milestone') {
      let earliest = null;
      for (const d of n.deps) earliest = later(earliest, cal.shift(nodes.get(d.id).ef, d.lag));
      if (s.date) {
        n.es = n.ef = s.date;
        if (earliest && toMs(s.date) < toMs(earliest)) {
          errors.push({ code: 'plan/dependency-violation', path: `$.milestones[id=${id}].date`, message: `Milestone "${id}" is fixed on ${s.date} but its dependencies finish ${earliest}.`, fix: `Move the date to ${earliest} or later, shorten the work before it, or drop the date to let it follow the work.` });
        }
      } else {
        n.es = n.ef = earliest;
      }
      n.dur = 0;
      continue;
    }

    let es = cal.snapForward(s.start || projectStart);
    if (s.not_before && toMs(s.not_before) > toMs(es)) es = cal.snapForward(s.not_before);
    let required = null;
    const durGuess = s.duration ?? (s.start && s.end ? cal.count(cal.snapForward(s.start), s.end) : 1);
    for (const d of n.deps) {
      const p = nodes.get(d.id);
      let c;
      if (d.type === 'SS') c = cal.shift(p.es, d.lag);
      else if (d.type === 'FF') c = cal.shift(cal.shift(p.ef, d.lag), -(Math.max(1, Math.ceil(durGuess)) - 1));
      else c = cal.shift(p.ef, 1 + d.lag);
      c = cal.snapForward(c);
      required = later(required, c);
    }
    if (required && toMs(required) > toMs(es)) {
      if (s.start) {
        errors.push({ code: 'plan/dependency-violation', path: `$.tasks[id=${id}].start`, message: `Task "${id}" starts ${s.start} but its dependencies allow ${required} at the earliest.`, fix: `Start it on ${required} or later, or remove "start" so the scheduler places it after its dependencies.` });
      } else {
        es = required;
      }
    }
    n.es = es;
    if (s.end) {
      n.ef = cal.snapBack(s.end);
      n.dur = Math.max(1, cal.count(es, n.ef));
    } else {
      n.dur = Math.max(1, Math.ceil(s.duration));
      n.ef = cal.endOf(es, n.dur);
    }
  }
  if (errors.length) return { errors, warnings };

  let projectEnd = null;
  for (const n of nodes.values()) projectEnd = later(projectEnd, n.ef);
  if (plan.meta.end && toMs(projectEnd) > toMs(plan.meta.end)) {
    warnings.push({ code: 'plan/deadline-missed', path: '$.meta.end', message: `Scheduled work finishes ${projectEnd}, after the target end ${plan.meta.end}.`, fix: 'Shorten or parallelise critical-path tasks, cut scope, or move the target date. Keep this warning visible to the user if the gap is real.' });
  }

  // ---- backward pass ---------------------------------------------------------
  for (const id of [...order].reverse()) {
    const n = nodes.get(id);
    let lf = projectEnd;
    for (const sc of n.succ) {
      const s = nodes.get(sc.id);
      let c;
      if (sc.type === 'SS') c = n.dur ? cal.endOf(cal.shift(s.ls, -sc.lag), n.dur) : cal.shift(s.ls, -sc.lag);
      else if (sc.type === 'FF') c = cal.shift(s.lf, -sc.lag);
      else c = s.kind === 'milestone' ? cal.shift(s.ls, -sc.lag) : cal.shift(s.ls, -(1 + sc.lag));
      lf = earlier(lf, c);
    }
    n.lf = lf;
    n.ls = n.dur > 1 ? cal.shift(lf, -(n.dur - 1)) : lf;
    n.slack = toMs(n.lf) >= toMs(n.ef) ? cal.count(n.ef, n.lf) - 1 : -(cal.count(n.lf, n.ef) - 1);
    n.critical = n.slack <= 0;
  }

  // ---- roll-ups --------------------------------------------------------------
  const today = plan.meta.today || new Date().toISOString().slice(0, 10);
  const out = {};
  for (const n of nodes.values()) {
    const status = n.src.status || (n.kind === 'milestone' ? undefined : 'planned');
    const done = status === 'done' || (n.kind === 'task' && n.src.progress === 100);
    out[n.id] = {
      kind: n.kind, es: n.es, ef: n.ef, ls: n.ls, lf: n.lf, dur: n.dur, slack: n.slack, critical: n.critical,
      late: !done && status !== 'cancelled' && toMs(n.ef) < toMs(today) && (n.kind === 'task' || !n.src.achieved),
    };
  }

  const phases = {};
  for (const ph of plan.phases || []) {
    const members = [...nodes.values()].filter((n) => n.src.phase === ph.id);
    if (!members.length) continue;
    let start = null, end = null, w = 0, p = 0;
    for (const m of members) {
      start = earlier(start, m.es);
      end = later(end, m.ef);
      if (m.kind === 'task') { w += m.dur; p += m.dur * progressOf(m.src); }
    }
    phases[ph.id] = { start, end, progress: w ? Math.round(p / w) : 0, workdays: cal.count(start, end) };
  }

  let w = 0, p = 0;
  for (const n of nodes.values()) if (n.kind === 'task') { w += n.dur; p += n.dur * progressOf(n.src); }

  return {
    errors, warnings,
    result: {
      start: projectStart, end: projectEnd, today,
      workdays: cal.count(projectStart, projectEnd),
      progress: w ? Math.round(p / w) : 0,
      criticalPath: order.filter((id) => out[id].critical),
      nodes: out, phases,
      calendar: { workdays: [...cal.workdays], holidays: [...cal.holidays] },
    },
  };
}

function progressOf(t) {
  if (Number.isFinite(t.progress)) return t.progress;
  return t.status === 'done' ? 100 : 0;
}

function normDeps(deps = []) {
  return deps.map((d) => (typeof d === 'string' ? { id: d, type: 'FS', lag: 0 } : { id: d.id, type: d.type || 'FS', lag: d.lag || 0 }));
}

function topo(nodes, errors) {
  const state = new Map();
  const order = [];
  let failed = false;
  const visit = (id, stack) => {
    if (failed) return;
    if (state.get(id) === 2) return;
    if (state.get(id) === 1) {
      const loop = [...stack.slice(stack.indexOf(id)), id];
      errors.push({ code: 'plan/cycle', path: '$.tasks', message: `Dependency cycle (each item waits for the next): ${loop.join(" → ")}.`, fix: 'Remove one dependency in the loop; work that feeds back is usually a later iteration and needs its own task.' });
      failed = true;
      return;
    }
    state.set(id, 1);
    for (const d of nodes.get(id).deps) if (nodes.has(d.id)) visit(d.id, [...stack, id]);
    state.set(id, 2);
    order.push(id);
  };
  for (const id of nodes.keys()) visit(id, []);
  return failed ? null : order;
}
