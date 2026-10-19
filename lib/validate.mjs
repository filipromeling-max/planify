// Structural and referential validation for a planify candidate.
// Every finding carries a stable code, a JSON path and a concrete fix hint so an
// agent can repair the candidate without reading this file.

import { isIsoDay } from './calendar.mjs';

const ID = /^[a-z0-9][a-z0-9._-]*$/;

export const ENUMS = {
  status: ['draft', 'proposed', 'approved', 'active', 'on_hold', 'closed'],
  evidence: ['confirmed', 'illustrative'],
  taskStatus: ['planned', 'in_progress', 'done', 'blocked', 'at_risk', 'cancelled'],
  depType: ['FS', 'SS', 'FF'],
  milestoneKind: ['gate', 'delivery', 'decision', 'external', 'launch'],
  wbsKind: ['outcome', 'deliverable', 'work_package'],
  roleKind: ['sponsor', 'steering', 'lead', 'team', 'stakeholder', 'vendor'],
  riskStatus: ['open', 'mitigating', 'accepted', 'closed'],
  riskType: ['risk', 'issue', 'assumption', 'dependency'],
  decisionStatus: ['open', 'decided', 'deferred'],
  quality: ['showcase', 'standard'],
};

const TOP = ['schema_version', 'plan_type', 'meta', 'overview', 'phases', 'workstreams', 'tasks',
  'milestones', 'wbs', 'roles', 'governance', 'raci', 'risks', 'decisions', 'budget', 'baseline', 'updates'];

export function validate(plan) {
  const errors = [];
  const warnings = [];
  const err = (code, path, message, fix) => errors.push({ code, path, message, fix });
  const warn = (code, path, message, fix) => warnings.push({ code, path, message, fix });

  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    err('plan/not-object', '$', 'Candidate must be a JSON object.', 'Start from examples/*.plan.json.');
    return { errors, warnings };
  }

  for (const k of Object.keys(plan)) {
    if (!TOP.includes(k)) err('plan/unknown-field', `$.${k}`, `Unknown top-level field "${k}".`, `Allowed: ${TOP.join(', ')}.`);
  }
  if (plan.schema_version !== 1) err('plan/schema-version', '$.schema_version', 'schema_version must be 1.', 'Set "schema_version": 1.');
  if (plan.plan_type !== 'project') err('plan/plan-type', '$.plan_type', 'plan_type must be "project".', 'Set "plan_type": "project".');

  const meta = plan.meta;
  if (!meta || typeof meta !== 'object') {
    err('plan/meta-missing', '$.meta', 'meta is required.', 'Add meta with title, start and evidence.');
  } else {
    if (!nonEmpty(meta.title)) err('plan/meta-title', '$.meta.title', 'meta.title is required.', 'Name the project in a few words.');
    if (!isIsoDay(meta.start)) err('plan/meta-start', '$.meta.start', 'meta.start must be an ISO day (YYYY-MM-DD).', 'Ask the user for the start date, or mark the plan illustrative and pick one.');
    if (meta.end !== undefined && !isIsoDay(meta.end)) err('plan/meta-end', '$.meta.end', 'meta.end must be an ISO day.', 'Use YYYY-MM-DD or drop the field.');
    if (isIsoDay(meta.start) && isIsoDay(meta.end) && meta.end < meta.start) err('plan/date-order', '$.meta.end', 'meta.end is before meta.start.', 'Swap or correct the dates.');
    if (!ENUMS.evidence.includes(meta.evidence)) err('plan/meta-evidence', '$.meta.evidence', `meta.evidence must be one of ${ENUMS.evidence.join(', ')}.`, 'Use "illustrative" when dates, people or amounts were invented.');
    if (meta.status !== undefined && !ENUMS.status.includes(meta.status)) err('plan/enum', '$.meta.status', `meta.status must be one of ${ENUMS.status.join(', ')}.`, 'Pick the closest status.');
    if (meta.quality_profile !== undefined && !ENUMS.quality.includes(meta.quality_profile)) err('plan/enum', '$.meta.quality_profile', 'quality_profile must be showcase or standard.', 'Use "showcase".');
    if (meta.today !== undefined && !isIsoDay(meta.today)) err('plan/meta-today', '$.meta.today', 'meta.today must be an ISO day.', 'Drop it to use the render date.');
    const cal = meta.calendar;
    if (cal !== undefined) {
      if (cal.workdays !== undefined && (!Array.isArray(cal.workdays) || !cal.workdays.length || cal.workdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6))) {
        err('plan/calendar', '$.meta.calendar.workdays', 'workdays must be a non-empty list of weekday numbers 0 (Sun) to 6 (Sat).', 'Use [1,2,3,4,5] for Mon–Fri.');
      }
      (cal.holidays || []).forEach((h, i) => { if (!isIsoDay(h)) err('plan/calendar', `$.meta.calendar.holidays[${i}]`, 'Holiday must be an ISO day.', 'Use YYYY-MM-DD.'); });
    }
  }

  // ---- id registries -------------------------------------------------------
  const ids = new Map();
  const registry = {};
  const collect = (key, list) => {
    registry[key] = new Map();
    if (list === undefined) return;
    if (!Array.isArray(list)) { err('plan/not-array', `$.${key}`, `${key} must be an array.`, `Wrap the entries in [...].`); return; }
    list.forEach((item, i) => {
      const p = `$.${key}[${i}]`;
      if (!item || typeof item !== 'object') { err('plan/not-object', p, 'Entry must be an object.', 'Use {"id": ..., "label": ...}.'); return; }
      if (key === 'raci') return;
      if (typeof item.id !== 'string' || !ID.test(item.id)) { err('plan/id', `${p}.id`, `id "${item.id}" must be lowercase kebab/snake (a-z0-9 . _ -).`, 'Use a short stable slug such as "design-review".'); return; }
      if (ids.has(item.id)) err('plan/duplicate-id', `${p}.id`, `id "${item.id}" is already used at ${ids.get(item.id)}.`, 'Every id must be unique across the whole plan.');
      ids.set(item.id, p);
      registry[key].set(item.id, item);
      const labelField = key === 'risks' || key === 'decisions' ? 'title' : 'label';
      if (!nonEmpty(item[labelField])) err('plan/label', `${p}.${labelField}`, `${labelField} is required.`, 'Give the entry a short reader-facing name.');
    });
  };
  for (const k of ['phases', 'workstreams', 'tasks', 'milestones', 'wbs', 'roles', 'risks', 'decisions']) collect(k, plan[k]);
  collect('raci', plan.raci);

  if (!registry.tasks.size && !registry.milestones.size) {
    err('plan/empty', '$.tasks', 'A plan needs at least one task or milestone.', 'Add the work that delivers the goal.');
  }

  const ref = (kind, value, path, required = false) => {
    if (value === undefined || value === null) {
      if (required) err('plan/missing-ref', path, `A ${kind.replace(/s$/, '')} reference is required.`, `Point at an id in ${kind}.`);
      return;
    }
    if (!registry[kind].has(value)) err('plan/unknown-ref', path, `"${value}" is not an id in ${kind}.`, `Use one of: ${[...registry[kind].keys()].slice(0, 12).join(', ') || '(none defined)'}.`);
  };
  const refList = (kind, value, path) => {
    if (value === undefined) return;
    if (!Array.isArray(value)) { err('plan/not-array', path, 'Must be an array of ids.', 'Wrap in [...].'); return; }
    value.forEach((v, i) => ref(kind, v, `${path}[${i}]`));
  };
  const schedulable = new Set([...registry.tasks.keys(), ...registry.milestones.keys()]);

  // ---- tasks -----------------------------------------------------------------
  (plan.tasks || []).forEach((t, i) => {
    const p = `$.tasks[${i}]`;
    if (!t || typeof t !== 'object') return;
    ref('phases', t.phase, `${p}.phase`, registry.phases.size > 0);
    ref('workstreams', t.workstream, `${p}.workstream`);
    ref('roles', t.owner, `${p}.owner`);
    ref('wbs', t.deliverable, `${p}.deliverable`);
    if (t.start !== undefined && !isIsoDay(t.start)) err('plan/date', `${p}.start`, 'start must be an ISO day.', 'Use YYYY-MM-DD or drop it and rely on depends_on.');
    for (const k of ['actual_start', 'actual_finish']) if (t[k] !== undefined && !isIsoDay(t[k])) err('plan/date', `${p}.${k}`, `${k} must be an ISO day.`, 'Use YYYY-MM-DD for the day it really happened.');
    if (isIsoDay(t.actual_start) && isIsoDay(t.actual_finish) && t.actual_finish < t.actual_start) err('plan/date-order', `${p}.actual_finish`, `Task "${t.id}" finished before it started.`, 'Correct the actual dates.');
    if (t.actual_finish && !t.actual_start) warn('track/finish-without-start', `${p}.actual_start`, `Task "${t.id}" has an actual finish but no actual start.`, 'Add actual_start so the roadmap shows the real span; the planned start is used meanwhile.');
    if (t.actual_finish && t.status && t.status !== 'done') warn('track/status-mismatch', `${p}.status`, `Task "${t.id}" has an actual finish but status "${t.status}".`, 'Set status to "done" or remove actual_finish.');
    const today = plan.meta?.today || new Date().toISOString().slice(0, 10);
    for (const k of ['actual_start', 'actual_finish']) if (isIsoDay(t[k]) && t[k] > today) err('track/actual-in-future', `${p}.${k}`, `${k} ${t[k]} is after today (${today}).`, 'Actual dates record what happened; use start or not_before for future plans.');
    if (t.not_before !== undefined && !isIsoDay(t.not_before)) err('plan/date', `${p}.not_before`, 'not_before must be an ISO day.', 'Use YYYY-MM-DD for the earliest allowed start.');
    if (t.end !== undefined && !isIsoDay(t.end)) err('plan/date', `${p}.end`, 'end must be an ISO day.', 'Use YYYY-MM-DD or give duration instead.');
    if (isIsoDay(t.start) && isIsoDay(t.end) && t.end < t.start) err('plan/date-order', `${p}.end`, `Task "${t.id}" ends before it starts.`, 'Correct the dates.');
    if (t.duration !== undefined && (!Number.isFinite(t.duration) || t.duration <= 0)) err('plan/duration', `${p}.duration`, 'duration must be a positive number of working days.', 'Use e.g. 5 for one working week.');
    if (t.end !== undefined && t.duration !== undefined) err('plan/over-constrained', p, `Task "${t.id}" sets both end and duration.`, 'Keep one: end for fixed dates, duration for dependency-driven scheduling.');
    if (t.end === undefined && t.duration === undefined) err('plan/unschedulable', p, `Task "${t.id}" has neither end nor duration.`, 'Add "duration" in working days.');
    if (t.status !== undefined && !ENUMS.taskStatus.includes(t.status)) err('plan/enum', `${p}.status`, `status must be one of ${ENUMS.taskStatus.join(', ')}.`, 'Pick the closest status.');
    if (t.progress !== undefined && (!Number.isFinite(t.progress) || t.progress < 0 || t.progress > 100)) err('plan/progress', `${p}.progress`, 'progress must be 0–100.', 'Use a percentage.');
    if (t.effort_days !== undefined && (!Number.isFinite(t.effort_days) || t.effort_days < 0)) err('plan/effort', `${p}.effort_days`, 'effort_days must be ≥ 0.', 'Use person-days.');
    checkDeps(t.depends_on, `${p}.depends_on`, t.id);
    if (!t.owner && registry.roles.size) warn('plan/no-owner', `${p}.owner`, `Task "${t.id}" has no owner.`, 'Assign a role so the RACI and workload views include it.');
  });

  (plan.milestones || []).forEach((m, i) => {
    const p = `$.milestones[${i}]`;
    if (!m || typeof m !== 'object') return;
    ref('phases', m.phase, `${p}.phase`);
    ref('roles', m.owner, `${p}.owner`);
    if (m.achieved_on !== undefined && !isIsoDay(m.achieved_on)) err('plan/date', `${p}.achieved_on`, 'achieved_on must be an ISO day.', 'Use YYYY-MM-DD.');
    if (m.date !== undefined && !isIsoDay(m.date)) err('plan/date', `${p}.date`, 'date must be an ISO day.', 'Use YYYY-MM-DD or drop it and use depends_on.');
    if (m.date === undefined && !(Array.isArray(m.depends_on) && m.depends_on.length)) err('plan/unschedulable', p, `Milestone "${m.id}" has neither date nor depends_on.`, 'Give a fixed date or the tasks that complete it.');
    if (m.kind !== undefined && !ENUMS.milestoneKind.includes(m.kind)) err('plan/enum', `${p}.kind`, `kind must be one of ${ENUMS.milestoneKind.join(', ')}.`, 'Pick the closest kind.');
    checkDeps(m.depends_on, `${p}.depends_on`, m.id);
  });

  function checkDeps(deps, path, self) {
    if (deps === undefined) return;
    if (!Array.isArray(deps)) { err('plan/not-array', path, 'depends_on must be an array.', 'Use ["task-id"] or [{"id": "task-id", "type": "SS", "lag": 2}].'); return; }
    deps.forEach((d, j) => {
      const id = typeof d === 'string' ? d : d && d.id;
      const pp = `${path}[${j}]`;
      if (id === self) err('plan/self-dependency', pp, `"${self}" depends on itself.`, 'Remove the entry.');
      else if (!schedulable.has(id)) err('plan/unknown-ref', pp, `"${id}" is not a task or milestone id.`, 'Depend on an existing task or milestone.');
      if (typeof d === 'object' && d) {
        if (d.type !== undefined && !ENUMS.depType.includes(d.type)) err('plan/enum', `${pp}.type`, 'Dependency type must be FS, SS or FF.', 'FS (finish→start) is the default.');
        if (d.lag !== undefined && !Number.isInteger(d.lag)) err('plan/lag', `${pp}.lag`, 'lag must be an integer number of working days.', 'Use e.g. 2 or -1.');
      }
    });
  }

  // ---- structure -------------------------------------------------------------
  (plan.phases || []).forEach((ph, i) => ref('roles', ph.owner, `$.phases[${i}].owner`));
  (plan.workstreams || []).forEach((w, i) => ref('roles', w.owner, `$.workstreams[${i}].owner`));
  (plan.wbs || []).forEach((w, i) => {
    const p = `$.wbs[${i}]`;
    ref('wbs', w.parent, `${p}.parent`);
    ref('roles', w.owner, `${p}.owner`);
    if (w.kind !== undefined && !ENUMS.wbsKind.includes(w.kind)) err('plan/enum', `${p}.kind`, `kind must be one of ${ENUMS.wbsKind.join(', ')}.`, 'Pick the closest kind.');
  });
  const wbsRoots = (plan.wbs || []).filter((w) => !w.parent);
  if (registry.wbs.size && wbsRoots.length !== 1) warn('plan/wbs-roots', '$.wbs', `WBS has ${wbsRoots.length} root nodes.`, 'A single root (the project outcome) reads best; give the others a parent.');
  cycleCheck((plan.wbs || []).map((w) => [w.id, w.parent ? [w.parent] : []]), '$.wbs', 'parent');

  (plan.roles || []).forEach((r, i) => {
    const p = `$.roles[${i}]`;
    ref('roles', r.reports_to, `${p}.reports_to`);
    if (r.kind !== undefined && !ENUMS.roleKind.includes(r.kind)) err('plan/enum', `${p}.kind`, `kind must be one of ${ENUMS.roleKind.join(', ')}.`, 'Pick the closest kind.');
    if (r.fte !== undefined && (!Number.isFinite(r.fte) || r.fte < 0)) err('plan/fte', `${p}.fte`, 'fte must be ≥ 0.', 'Use 1 for full time, 0.5 for half.');
  });
  cycleCheck((plan.roles || []).map((r) => [r.id, r.reports_to ? [r.reports_to] : []]), '$.roles', 'reports_to');

  const gov = plan.governance;
  if (gov !== undefined) {
    (gov.forums || []).forEach((f, i) => {
      const p = `$.governance.forums[${i}]`;
      if (!nonEmpty(f.label)) err('plan/label', `${p}.label`, 'label is required.', 'Name the forum.');
      ref('roles', f.chair, `${p}.chair`);
      refList('roles', f.members, `${p}.members`);
    });
  }

  (plan.raci || []).forEach((row, i) => {
    const p = `$.raci[${i}]`;
    if (!row || typeof row !== 'object') return;
    if (!nonEmpty(row.activity)) err('plan/label', `${p}.activity`, 'activity is required.', 'Name the activity or decision.');
    for (const k of ['r', 'c', 'i']) refList('roles', row[k], `${p}.${k}`);
    if (typeof row.a !== 'string') err('plan/raci-accountable', `${p}.a`, `"${row.activity}" needs exactly one accountable role.`, 'Set "a" to a single role id.');
    else ref('roles', row.a, `${p}.a`);
    if (!Array.isArray(row.r) || !row.r.length) warn('plan/raci-responsible', `${p}.r`, `"${row.activity}" has no responsible role.`, 'Add who does the work.');
  });

  (plan.risks || []).forEach((r, i) => {
    const p = `$.risks[${i}]`;
    for (const k of ['likelihood', 'impact']) {
      if (!Number.isInteger(r[k]) || r[k] < 1 || r[k] > 5) err('plan/risk-score', `${p}.${k}`, `${k} must be an integer 1–5.`, '1 = rare/negligible, 5 = almost certain/severe.');
    }
    if (r.type !== undefined && !ENUMS.riskType.includes(r.type)) err('plan/enum', `${p}.type`, `type must be one of ${ENUMS.riskType.join(', ')}.`, 'Use "risk" for uncertain events.');
    if (r.status !== undefined && !ENUMS.riskStatus.includes(r.status)) err('plan/enum', `${p}.status`, `status must be one of ${ENUMS.riskStatus.join(', ')}.`, 'Pick the closest status.');
    ref('roles', r.owner, `${p}.owner`);
    refList('tasks', r.affects, `${p}.affects`);
    if (r.likelihood * r.impact >= 12 && !nonEmpty(r.mitigation) && r.status !== 'closed') warn('plan/risk-unmitigated', `${p}.mitigation`, `High risk "${r.id}" has no mitigation.`, 'State what reduces likelihood or impact.');
  });

  (plan.decisions || []).forEach((d, i) => {
    const p = `$.decisions[${i}]`;
    ref('roles', d.owner, `${p}.owner`);
    if (d.due !== undefined && !isIsoDay(d.due)) err('plan/date', `${p}.due`, 'due must be an ISO day.', 'Use YYYY-MM-DD.');
    if (d.status !== undefined && !ENUMS.decisionStatus.includes(d.status)) err('plan/enum', `${p}.status`, `status must be one of ${ENUMS.decisionStatus.join(', ')}.`, 'Pick the closest status.');
    refList('milestones', d.blocks, `${p}.blocks`);
  });

  const budget = plan.budget;
  if (budget !== undefined) {
    (budget.lines || []).forEach((l, i) => {
      const p = `$.budget.lines[${i}]`;
      if (!nonEmpty(l.label)) err('plan/label', `${p}.label`, 'label is required.', 'Name the cost line.');
      if (!Number.isFinite(l.amount) || l.amount < 0) err('plan/amount', `${p}.amount`, 'amount must be a number ≥ 0.', 'Use a plain number without currency symbols.');
      ref('phases', l.phase, `${p}.phase`);
    });
  }

  // ---- tracking ----------------------------------------------------------------
  const bl = plan.baseline;
  if (bl !== undefined) {
    if (!bl || typeof bl !== 'object' || typeof bl.nodes !== 'object' || !isIsoDay(bl.taken) || !isIsoDay(bl.end)) {
      err('track/baseline', '$.baseline', 'baseline must have taken, end and nodes.', 'Create it with `planify baseline`; do not write it by hand.');
    } else {
      for (const [id, n] of Object.entries(bl.nodes)) if (!isIsoDay(n?.start) || !isIsoDay(n?.end)) err('track/baseline', `$.baseline.nodes.${id}`, 'Baseline entries need start and end ISO days.', 'Re-take the baseline with `planify baseline --replace`.');
      const added = [...schedulable].filter((id) => !bl.nodes[id]);
      if (added.length) warn('track/not-in-baseline', '$.baseline', `${added.length} item${added.length === 1 ? ' is' : 's are'} not in the baseline: ${added.slice(0, 5).join(', ')}.`, 'Expected after adding scope; re-baseline only if the sponsor approved the new scope.');
    }
  }
  if (plan.updates !== undefined) {
    if (!Array.isArray(plan.updates)) err('plan/not-array', '$.updates', 'updates must be an array.', 'Record updates with `planify update`.');
    else plan.updates.forEach((u, i) => { if (!isIsoDay(u?.date)) err('track/update', `$.updates[${i}].date`, 'Each update needs a date.', 'Record updates with `planify update`.'); });
  }

  // ---- coverage warnings -------------------------------------------------------
  const usedPhases = new Set([...(plan.tasks || []).map((t) => t.phase), ...(plan.milestones || []).map((m) => m.phase)]);
  for (const id of registry.phases.keys()) if (!usedPhases.has(id)) warn('plan/empty-phase', '$.phases', `Phase "${id}" has no tasks or milestones.`, 'Add its work or remove the phase.');
  const usedDeliverables = new Set((plan.tasks || []).map((t) => t.deliverable));
  const wbsParents = new Set((plan.wbs || []).map((w) => w.parent));
  for (const [id, w] of registry.wbs) {
    if (!wbsParents.has(id) && w.parent && !usedDeliverables.has(id)) warn('plan/wbs-unplanned', '$.wbs', `Deliverable "${id}" has no tasks pointing at it.`, 'Link the tasks that produce it via task.deliverable.');
  }
  if (registry.tasks.size >= 6 && !registry.milestones.size) warn('plan/no-milestones', '$.milestones', 'The plan has no milestones.', 'Add gates or deliveries the sponsor will track.');

  function cycleCheck(edges, path, field) {
    const g = new Map(edges);
    const state = new Map();
    const visit = (n, stack) => {
      if (state.get(n) === 2) return;
      if (state.get(n) === 1) { err('plan/cycle', path, `Cycle via ${field}: ${[...stack, n].join(' → ')}.`, `Break the loop in ${field}.`); return; }
      state.set(n, 1);
      for (const m of g.get(n) || []) if (g.has(m)) visit(m, [...stack, n]);
      state.set(n, 2);
    };
    for (const n of g.keys()) visit(n, []);
  }

  return { errors, warnings };
}

function nonEmpty(s) {
  return typeof s === 'string' && s.trim().length > 0;
}
