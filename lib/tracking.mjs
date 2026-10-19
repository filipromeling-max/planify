// Progress tracking: freeze a baseline, and record status updates as a change log.
// Each update keeps a compact snapshot of the plan's state so the next update can
// describe what changed without anyone writing the list by hand.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const day = (iso) => (iso ? `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}` : '');

export function takeBaseline(plan, sched, label) {
  const nodes = {};
  for (const [id, n] of Object.entries(sched.nodes)) nodes[id] = { start: n.es, end: n.ef };
  return { label: label || 'Baseline', taken: sched.today, end: sched.end, nodes };
}

export function snapshot(plan, sched) {
  const tasks = {};
  for (const t of plan.tasks || []) {
    const n = sched.nodes[t.id];
    tasks[t.id] = {
      label: t.label, status: t.status || 'planned', progress: t.progress ?? null,
      actual_start: t.actual_start || null, actual_finish: t.actual_finish || null,
      inputs: JSON.stringify([t.start, t.end, t.duration, t.not_before, t.depends_on]),
      ef: n.ef,
    };
  }
  const milestones = {};
  for (const m of plan.milestones || []) milestones[m.id] = { label: m.label, achieved: !!(m.achieved || m.achieved_on), ef: sched.nodes[m.id].ef };
  const risks = {};
  for (const r of plan.risks || []) risks[r.id] = { title: r.title, score: r.likelihood * r.impact, status: r.status || 'open' };
  const decisions = {};
  for (const d of plan.decisions || []) decisions[d.id] = { title: d.title, status: d.status || 'open' };
  return { finish: sched.end, tasks, milestones, risks, decisions };
}

// Human-readable list of what moved between two snapshots.
export function diff(prev, next) {
  const out = [];
  const pct = (v) => (v === null || v === undefined ? '0%' : `${v}%`);
  for (const [id, t] of Object.entries(next.tasks)) {
    const p = prev.tasks[id];
    if (!p) { out.push(`Added task: ${t.label}`); continue; }
    // One line per task: the most informative thing that happened to it.
    const st = (x) => x.replace('_', ' ');
    if (!p.actual_finish && t.actual_finish) out.push(`${t.label} finished on ${day(t.actual_finish)}`);
    else if (t.status === 'done' && p.status !== 'done') out.push(`${t.label} done`);
    else if (!p.actual_start && t.actual_start) out.push(`${t.label} started on ${day(t.actual_start)}${t.progress ? `, ${pct(t.progress)} done` : ''}${['blocked', 'at_risk'].includes(t.status) ? `, ${st(t.status)}` : ''}`);
    else if (p.status !== t.status && p.progress !== t.progress) out.push(`${t.label}: ${st(t.status)}, ${pct(p.progress)} → ${pct(t.progress)} done`);
    else if (p.status !== t.status) out.push(`${t.label}: ${st(p.status)} → ${st(t.status)}`);
    else if (p.progress !== t.progress) out.push(`${t.label}: ${pct(p.progress)} → ${pct(t.progress)} done`);
    if (p.inputs !== t.inputs) out.push(`${t.label} re-planned, now ends ${day(t.ef)} (was ${day(p.ef)})`);
  }
  for (const [id, t] of Object.entries(prev.tasks)) if (!next.tasks[id]) out.push(`Removed task: ${t.label}`);
  for (const [id, m] of Object.entries(next.milestones)) {
    const p = prev.milestones[id];
    if (!p) out.push(`Added milestone: ${m.label}`);
    else if (!p.achieved && m.achieved) out.push(`${m.label} achieved`);
    else if (!m.achieved && p.ef !== m.ef) out.push(`${m.label} moves to ${day(m.ef)} (was ${day(p.ef)})`);
  }
  for (const [id, r] of Object.entries(next.risks)) {
    const p = prev.risks[id];
    if (!p) out.push(`New risk: ${r.title} (${r.score})`);
    else if (p.status !== r.status) out.push(`Risk ${r.status === 'closed' ? 'closed' : r.status}: ${r.title}`);
    else if (p.score !== r.score) out.push(`Risk ${r.score > p.score ? 'up' : 'down'} ${p.score} → ${r.score}: ${r.title}`);
  }
  for (const [id, d] of Object.entries(next.decisions)) {
    const p = prev.decisions[id];
    if (!p) out.push(`New decision needed: ${d.title}`);
    else if (p.status !== d.status) out.push(`Decision ${d.status}: ${d.title}`);
  }
  return out;
}

// Append an update entry. Only the newest entry keeps a snapshot, so the file stays small.
export function recordUpdate(plan, sched, { summary, by } = {}) {
  const updates = plan.updates || [];
  const last = updates[updates.length - 1];
  const state = snapshot(plan, sched);
  const entry = { date: sched.today };
  if (summary) entry.summary = summary;
  if (by) entry.by = by;
  entry.finish = sched.end;
  if (last?.state) {
    entry.finish_was = last.state.finish;
    entry.changes = diff(last.state, state);
  } else {
    entry.changes = [];
  }
  entry.state = state;
  return [...updates.map(({ state: _drop, ...u }) => u), entry];
}
