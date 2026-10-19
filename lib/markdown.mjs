// Plain-text exports shared by the CLI and the viewer (inlined into the HTML).

export function planToMarkdown(plan, sched) {
  const L = [];
  const m = plan.meta;
  const o = plan.overview || {};
  const roles = new Map((plan.roles || []).map((r) => [r.id, r]));
  const who = (id) => (id && roles.get(id) ? roles.get(id).person || roles.get(id).label : '');
  const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const phaseLabel = new Map((plan.phases || []).map((p) => [p.id, p.label]));

  L.push(`# ${m.title}`, '');
  if (m.subtitle) L.push(m.subtitle, '');
  L.push(`**Dates:** ${sched.start} → ${sched.end} (${sched.workdays} working days)  `);
  if (m.owner) L.push(`**Owner:** ${m.owner}  `);
  if (m.status) L.push(`**Status:** ${m.status}  `);
  if (m.evidence === 'illustrative') L.push('_Illustrative plan: dates, people and amounts are placeholders until confirmed._');
  L.push('');
  if (o.goal) L.push('## Goal', '', o.goal, '');
  if (o.problem) L.push('## Why now', '', o.problem, '');
  if (o.scope) {
    L.push('## Scope', '');
    if (o.scope.in?.length) L.push('**In scope**', '', ...o.scope.in.map((s) => `- ${s}`), '');
    if (o.scope.out?.length) L.push('**Out of scope**', '', ...o.scope.out.map((s) => `- ${s}`), '');
  }
  if (o.success_criteria?.length) {
    L.push('## Success criteria', '', '| Criterion | Target |', '|---|---|');
    for (const c of o.success_criteria) L.push(`| ${cell(c.label)} | ${cell(c.target)} |`);
    L.push('');
  }
  if (plan.phases?.length) {
    L.push('## Phases', '', '| Phase | Start | End | Goal |', '|---|---|---|---|');
    for (const p of plan.phases) {
      const s = sched.phases[p.id] || {};
      L.push(`| ${cell(p.label)} | ${s.start || ''} | ${s.end || ''} | ${cell(p.goal)} |`);
    }
    L.push('');
  }
  if (plan.milestones?.length) {
    L.push('## Milestones', '', '| Date | Milestone | Kind | Owner |', '|---|---|---|---|');
    for (const ms of [...plan.milestones].sort((a, b) => (sched.nodes[a.id].ef < sched.nodes[b.id].ef ? -1 : 1))) {
      L.push(`| ${sched.nodes[ms.id].ef} | ${cell(ms.label)}${sched.nodes[ms.id].critical ? ' ★' : ''} | ${ms.kind || ''} | ${cell(who(ms.owner))} |`);
    }
    L.push('');
  }
  if (plan.tasks?.length) {
    L.push('## Work plan', '', '★ = on the critical path', '', '| Task | Phase | Owner | Start | End | Days | Status |', '|---|---|---|---|---|---|---|');
    for (const t of plan.tasks) {
      const n = sched.nodes[t.id];
      L.push(`| ${cell(t.label)}${n.critical ? ' ★' : ''} | ${cell(phaseLabel.get(t.phase))} | ${cell(who(t.owner))} | ${n.es} | ${n.ef} | ${n.dur} | ${t.status || 'planned'} |`);
    }
    L.push('');
  }
  if (plan.raci?.length) {
    const used = (plan.roles || []).filter((r) => plan.raci.some((x) => x.a === r.id || [x.r, x.c, x.i].some((l) => l?.includes(r.id))));
    L.push('## RACI', '', `| Activity | ${used.map((r) => cell(r.label)).join(' | ')} |`, `|---|${used.map(() => ':-:').join('|')}|`);
    for (const x of plan.raci) {
      L.push(`| ${cell(x.activity)} | ${used.map((r) => (x.a === r.id ? 'A' : x.r?.includes(r.id) ? 'R' : x.c?.includes(r.id) ? 'C' : x.i?.includes(r.id) ? 'I' : '')).join(' | ')} |`);
    }
    L.push('');
  }
  if (plan.risks?.length) {
    L.push('## Risks', '', '| ID | Risk | L | I | Score | Owner | Mitigation |', '|---|---|---|---|---|---|---|');
    for (const r of [...plan.risks].sort((a, b) => b.likelihood * b.impact - a.likelihood * a.impact)) {
      L.push(`| ${r.id} | ${cell(r.title)} | ${r.likelihood} | ${r.impact} | ${r.likelihood * r.impact} | ${cell(who(r.owner))} | ${cell(r.mitigation)} |`);
    }
    L.push('');
  }
  if (plan.decisions?.length) {
    L.push('## Open decisions', '');
    for (const d of plan.decisions) L.push(`- **${d.title}**${d.due ? ` (due ${d.due})` : ''}${d.owner ? ` — ${who(d.owner)}` : ''}${d.status && d.status !== 'open' ? ` · ${d.status}` : ''}`);
    L.push('');
  }
  if (o.assumptions?.length) L.push('## Assumptions', '', ...o.assumptions.map((s) => `- ${s}`), '');
  if (o.constraints?.length) L.push('## Constraints', '', ...o.constraints.map((s) => `- ${s}`), '');
  return L.join('\n');
}

export function planToCsv(plan, sched) {
  const roles = new Map((plan.roles || []).map((r) => [r.id, r]));
  const phases = new Map((plan.phases || []).map((p) => [p.id, p.label]));
  const ws = new Map((plan.workstreams || []).map((p) => [p.id, p.label]));
  const q = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = [['id', 'type', 'name', 'phase', 'workstream', 'owner', 'start', 'end', 'working_days', 'depends_on', 'status', 'progress', 'critical', 'slack_days']];
  for (const t of plan.tasks || []) {
    const n = sched.nodes[t.id];
    rows.push([t.id, 'task', t.label, phases.get(t.phase), ws.get(t.workstream), roles.get(t.owner)?.label, n.es, n.ef, n.dur,
      (t.depends_on || []).map((d) => (typeof d === 'string' ? d : `${d.id}:${d.type || 'FS'}${d.lag ? (d.lag > 0 ? '+' : '') + d.lag : ''}`)).join(' '),
      t.status || 'planned', t.progress ?? '', n.critical ? 'yes' : 'no', n.slack]);
  }
  for (const ms of plan.milestones || []) {
    const n = sched.nodes[ms.id];
    rows.push([ms.id, 'milestone', ms.label, phases.get(ms.phase), '', roles.get(ms.owner)?.label, n.ef, n.ef, 0,
      (ms.depends_on || []).map((d) => (typeof d === 'string' ? d : d.id)).join(' '), ms.achieved ? 'done' : '', '', n.critical ? 'yes' : 'no', n.slack]);
  }
  return rows.map((r) => r.map(q).join(',')).join('\n');
}
