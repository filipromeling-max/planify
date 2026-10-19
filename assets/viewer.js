/* planify viewer — renders the embedded plan into five views. No dependencies. */
(function () {
  'use strict';
  const DATA = JSON.parse(document.getElementById('plan-data').textContent);
  const plan = DATA.plan;
  let S = DATA.schedule;
  const BASE = DATA.schedule;
  const CAL = new Calendar(plan.meta.calendar);
  const meta = plan.meta;
  const ov = plan.overview || {};
  const DAY = 86400000;
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ms = (d) => Date.parse(d + 'T00:00:00Z');
  const iso = (t) => new Date(t).toISOString().slice(0, 10);
  const locale = meta.locale || undefined;
  const fmt = (d, o = { day: 'numeric', month: 'short' }) => (d ? new Date(ms(d)).toLocaleDateString(locale, { timeZone: 'UTC', ...o }) : '');
  const fmtY = (d) => fmt(d, { day: 'numeric', month: 'short', year: 'numeric' });
  const money = (n) => new Intl.NumberFormat(locale, { style: plan.budget?.currency ? 'currency' : 'decimal', currency: plan.budget?.currency || undefined, maximumFractionDigits: 0 }).format(n);

  const roles = new Map((plan.roles || []).map((r) => [r.id, r]));
  const phases = plan.phases || [];
  const phaseIdx = new Map(phases.map((p, i) => [p.id, i]));
  const tasks = plan.tasks || [];
  const milestones = plan.milestones || [];
  const items = new Map([...tasks.map((t) => [t.id, { ...t, kind: 'task' }]), ...milestones.map((m) => [m.id, { ...m, kind: 'milestone' }])]);
  const who = (id) => (id && roles.get(id) ? roles.get(id).person || roles.get(id).label : '');
  const roleName = (id) => (id && roles.get(id) ? roles.get(id).label : '');
  const phaseColor = (id) => (phaseIdx.has(id) ? phases[phaseIdx.get(id)].color || `var(--p${phaseIdx.get(id) % 8})` : 'var(--ink-3)');
  const depIds = (x) => (x.depends_on || []).map((d) => (typeof d === 'string' ? { id: d, type: 'FS', lag: 0 } : { type: 'FS', lag: 0, ...d }));
  const riskScore = (r) => r.likelihood * r.impact;
  const band = (s) => (s >= 15 ? 4 : s >= 10 ? 3 : s >= 5 ? 2 : 1);

  // ---- theme ---------------------------------------------------------------
  const themeBtn = $('#theme');
  const setTheme = (t) => {
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem('planify-theme', t); } catch (_) {}
    themeBtn.setAttribute('aria-label', t === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
    themeBtn.querySelector('.ico').textContent = t === 'dark' ? '☀' : '☾';
  };
  setTheme(document.documentElement.getAttribute('data-theme') || 'light');
  themeBtn.addEventListener('click', () => setTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'));

  // ---- header ------------------------------------------------------------------
  function renderMeta() {
    $('#meta-line').innerHTML = [
      meta.status ? `<span class="pill status-${esc(meta.status)}">${esc(meta.status.replace('_', ' '))}</span>` : '',
      meta.evidence === 'illustrative' ? '<span class="pill illustrative" title="Dates, people and amounts are placeholders until confirmed">Illustrative</span>' : '',
      `<span>${fmtY(S.start)} → ${fmtY(S.end)}</span>`,
      meta.owner ? `<span>${esc(meta.owner)}</span>` : '',
      meta.version ? `<span>v${esc(meta.version)}</span>` : '',
    ].join('');
  }
  renderMeta();

  // ---- what-if -------------------------------------------------------------------
  // Overrides live beside the plan (never in it): { taskId: { not_before, duration } }.
  // Every change reruns the real scheduler, so the page can never show an impossible date.
  const SIM = {
    over: {},
    history: [],
    active() { return Object.keys(this.over).length > 0; },
    plan(over = this.over) {
      const p = structuredClone(plan);
      for (const t of p.tasks || []) {
        const o = over[t.id];
        if (!o) continue;
        if (o.not_before) { delete t.start; t.not_before = o.not_before; }
        if (o.duration) { delete t.end; t.duration = o.duration; }
      }
      return p;
    },
    // Returns null on success or an error message.
    apply(next) {
      const r = schedule(this.plan(next));
      if (r.errors.length) return r.errors[0].message;
      this.history.push(this.over);
      this.over = next;
      S = r.result;
      refresh();
      return null;
    },
    preview(next) {
      const r = schedule(this.plan(next));
      return r.errors.length ? { error: r.errors[0].message } : { result: r.result };
    },
    undo() { if (!this.history.length) return; this.over = this.history.pop(); S = this.active() ? schedule(this.plan()).result : BASE; refresh(); },
    reset() { if (!this.active()) return; this.history.push(this.over); this.over = {}; S = BASE; refresh(); },
  };
  const moveTask = (id, workdays) => {
    const n = S.nodes[id];
    const o = SIM.over[id] || {};
    return { ...SIM.over, [id]: { ...o, not_before: CAL.shift(n.es, workdays), duration: o.duration || n.dur } };
  };
  const resizeTask = (id, dur) => ({ ...SIM.over, [id]: { ...(SIM.over[id] || {}), duration: Math.max(1, dur) } });
  const finishShift = (res) => wdDiff(BASE.end, res.end);

  function renderSimBar() {
    const bar = $('#sim-bar');
    if (!SIM.active()) { bar.hidden = true; document.documentElement.classList.remove('simulating'); return; }
    const d = finishShift(S);
    const target = meta.end ? wdDiff(S.end, meta.end) : null;
    const n = Object.keys(SIM.over).length;
    bar.hidden = false;
    document.documentElement.classList.add('simulating');
    bar.innerHTML = `<div class="sim-inner">
      <span class="sim-tag">What-if</span>
      <span>Finish ${d === 0 ? 'stays on' : 'moves to'} <b>${fmtY(S.end)}</b>${d ? ` <span class="${d > 0 ? 'bad' : 'ok'}">(${d > 0 ? '+' : '−'}${plural(Math.abs(d), 'working day')})</span>` : ''}${target !== null && target < 0 ? `, <span class="bad">${plural(-target, 'day')} past target</span>` : ''} · ${plural(n, 'change')} · not saved</span>
      <span class="sim-actions"><button class="btn" data-sim="undo" title="Undo (⌘Z / Ctrl+Z)">Undo</button><button class="btn" data-sim="reset">Discard</button><button class="btn primary" data-sim="save">Save adjusted plan</button></span>
    </div>`;
  }

  function refresh() {
    renderMeta();
    renderSimBar();
    const current = views.find((v) => $(`#view-${v}`).classList.contains('active'));
    for (const v of views) rendered[v] = false;
    if (current === 'roadmap' && $('#gantt')) { drawGantt(); rendered.roadmap = true; } else { RENDER[current](); rendered[current] = true; }
    if (G.selected) select(G.selected, true);
  }

  // ---- tabs ----------------------------------------------------------------------
  const views = ['overview', 'roadmap', 'structure', 'team', 'risks'];
  $('#tabs').innerHTML = views.map((v) => `<a href="#${v}" data-view="${v}">${$(`#view-${v}`).dataset.title}</a>`).join('');
  const rendered = {};
  const show = (v) => {
    if (!views.includes(v)) v = 'overview';
    $$('section.view').forEach((s) => s.classList.toggle('active', s.id === `view-${v}`));
    $$('#tabs a').forEach((a) => a.setAttribute('aria-current', a.dataset.view === v ? 'page' : 'false'));
    if (!rendered[v]) { RENDER[v](); rendered[v] = true; }
  };
  window.addEventListener('hashchange', () => show(location.hash.slice(1)));
  const go = (v) => { if (location.hash.slice(1) === v) show(v); else location.hash = v; };

  // One delegated handler for cross-view links: any person, task, phase or filter is one click from its place on the roadmap.
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-role],[data-goto],[data-only],[data-phase],[data-view-go],[data-scroll],[data-sim]');
    if (!t) return;
    if (t.dataset.sim) { e.stopPropagation(); if (t.dataset.sim === 'save') actions.json(); else SIM[t.dataset.sim](); return; }
    if (t.dataset.viewGo) return go(t.dataset.viewGo);
    if (t.dataset.scroll) return $('#' + t.dataset.scroll)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    e.stopPropagation();
    if (t.dataset.role) { G.only = { kind: 'owner', id: t.dataset.role }; G.collapsed.clear(); }
    if (t.dataset.only) { G.only = { kind: t.dataset.only }; G.collapsed.clear(); }
    if (t.dataset.phase) { G.only = null; G.group = 'phase'; G.collapsed = new Set(phases.map((p) => p.id).filter((id) => id !== t.dataset.phase)); }
    if (t.dataset.goto) { G.only = null; G.filter = ''; G.collapsed.clear(); G.selected = t.dataset.goto; }
    rendered.roadmap = false;
    go('roadmap');
    if (t.dataset.goto) requestAnimationFrame(() => { select(t.dataset.goto); $(`#gantt [data-id="${CSS.escape(t.dataset.goto)}"].g-bar, #gantt [data-id="${CSS.escape(t.dataset.goto)}"].g-ms`)?.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' }); });
  });
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'z' && SIM.history.length && !e.target.closest('input,textarea')) { e.preventDefault(); SIM.undo(); }
  });

  // ---- overview --------------------------------------------------------------
  // Leads with the answer a sponsor asks for (when do we finish, what sets that date,
  // what needs attention) so nobody has to compute it from separate numbers.
  const wdDiff = (a, b) => (ms(b) >= ms(a) ? CAL.count(a, b) - 1 : -(CAL.count(b, a) - 1));
  const plural = (n, w) => `${n} ${w}${Math.abs(n) === 1 ? '' : 's'}`;

  function verdict() {
    const target = meta.end;
    let head;
    if (target) {
      const d = wdDiff(S.end, target);
      head = d >= 0
        ? `Finishes <b>${fmtY(S.end)}</b>, ${d === 0 ? 'exactly on' : `${plural(d, 'working day')} ahead of`} the ${fmt(target)} target.`
        : `Finishes <b>${fmtY(S.end)}</b>, <span class="bad">${plural(-d, 'working day')} after</span> the ${fmt(target)} target.`;
    } else {
      head = `Finishes <b>${fmtY(S.end)}</b>, ${plural(S.workdays, 'working day')} after it starts.`;
    }
    if (S.baseline) {
      const d = S.baseline.delta;
      head += ` <span class="drift ${d > 0 ? 'bad' : 'ok'}">${d === 0 ? 'On' : `${plural(Math.abs(d), 'working day')} ${d > 0 ? 'later than' : 'earlier than'}`} the baseline.</span>`;
    }
    const drivers = S.criticalPath.filter((id) => S.nodes[id].kind === 'task' && items.get(id).status !== 'done' && items.get(id).status !== 'cancelled');
    const nextMs = milestones.map((m) => ({ m, d: S.nodes[m.id].ef })).filter((x) => !x.m.achieved && ms(x.d) >= ms(S.today)).sort((a, b) => ms(a.d) - ms(b.d))[0];
    return { head, drivers, nextMs };
  }

  function renderOverview() {
    const el = $('#view-overview');
    const { head, drivers, nextMs } = verdict();
    const late = Object.entries(S.nodes).filter(([, n]) => n.late).length;
    const highRisks = (plan.risks || []).filter((r) => r.status !== 'closed' && riskScore(r) >= 10).length;
    const openDecisions = (plan.decisions || []).filter((d) => !d.status || d.status === 'open');
    const dueSoon = openDecisions.filter((d) => d.due && nextMs && ms(d.due) <= ms(nextMs.d)).length;
    const behind = Object.values(S.nodes).filter((n) => n.behind).length;
    const slipped = Object.values(S.nodes).filter((n) => n.kind === 'task' && n.delta > 0 && !n.actual).length;
    const updates = plan.updates || [];
    const lastUpdate = updates[updates.length - 1];
    const shown = drivers.slice(0, 5);
    const driverHtml = shown.map((id) => `<button class="link" data-goto="${esc(id)}">${esc(items.get(id).label)}</button>`).join('<span class="arrow">→</span>') + (drivers.length > shown.length ? `<span class="muted"> and ${drivers.length - shown.length} more</span>` : '');

    const attention = [
      !S.tracking && late ? `<button class="attn bad" data-only="late">${plural(late, 'item')} behind schedule</button>` : '',
      behind ? `<button class="attn bad" data-only="pace">${plural(behind, 'task')} behind pace</button>` : '',
      slipped ? `<button class="attn warn" data-only="slip">${plural(slipped, 'task')} finishing later than baseline</button>` : '',
      highRisks ? `<button class="attn warn" data-view-go="risks">${plural(highRisks, 'high risk')} open</button>` : '',
      openDecisions.length ? `<button class="attn" data-scroll="decisions">${plural(openDecisions.length, 'decision')} needed${dueSoon ? `, ${dueSoon} before the next milestone` : ''}</button>` : '',
    ].filter(Boolean).join('');

    el.innerHTML = `
      <div class="panel verdict">
        <div class="eyebrow">${SIM.active() ? 'What-if, not saved' : `As of ${fmtY(S.today)}`} · ${S.progress}% of planned work done${S.baseline ? ` · measured against “${esc(S.baseline.label)}”, ${fmt(S.baseline.taken)}` : ''}</div>
        <p class="headline">${head}</p>
        ${drivers.length ? `<p class="drivers"><span class="muted">The date is set by</span> ${driverHtml}. <span class="muted">A slip in any of these moves the finish.</span></p>` : ''}
        ${nextMs ? `<p class="next"><span class="muted">Next milestone</span> <b>${esc(nextMs.m.label)}</b> on ${fmt(nextMs.d)}${ms(nextMs.d) > ms(S.today) ? `, in ${plural(wdDiff(S.today, nextMs.d), 'working day')}` : ', today'}.</p>` : ''}
        ${lastUpdate && lastUpdate.changes?.length ? `<p class="next"><span class="muted">Since the last update</span> <button class="link" data-scroll="history">${plural(lastUpdate.changes.length, 'change')}</button>${lastUpdate.finish_was && lastUpdate.finish_was !== lastUpdate.finish ? `, finish ${wdDiff(lastUpdate.finish_was, lastUpdate.finish) > 0 ? '+' : '−'}${plural(Math.abs(wdDiff(lastUpdate.finish_was, lastUpdate.finish)), 'working day')}` : ', finish unchanged'} <span class="muted">(${fmt(lastUpdate.date)}${lastUpdate.summary ? `, ${esc(lastUpdate.summary)}` : ''})</span>.</p>` : ''}
        ${attention ? `<div class="attn-row">${attention}</div>` : '<div class="attn-row"><span class="attn ok">Nothing is behind schedule</span></div>'}
        ${miniTimeline()}
      </div>
      <div class="grid g2">
        <div class="panel">
          <h2>Goal</h2>
          ${ov.goal ? `<p class="goal">${esc(ov.goal)}</p>` : '<p class="muted small">No goal written yet. State the outcome with a number and a date, such as “Resolve 60% of requests without an agent by March”.</p>'}
          ${ov.problem ? `<p class="muted">${esc(ov.problem)}</p>` : ''}
          ${ov.success_criteria?.length ? `<table class="criteria"><tbody>${ov.success_criteria.map((c) => `<tr><td>${esc(c.label)}</td><td class="num">${esc(c.target || '')}</td></tr>`).join('')}</tbody></table>` : ''}
        </div>
        <div class="panel"><h2>Milestones</h2>${milestoneList()}</div>
        ${updates.length ? historyPanel(updates) : ''}
        <div class="panel">
          <h2>Scope</h2>
          ${ov.scope?.in?.length ? `<ul class="scope in">${ov.scope.in.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>` : ''}
          ${ov.scope?.out?.length ? `<ul class="scope out">${ov.scope.out.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>` : ''}
          ${!ov.scope?.in?.length && !ov.scope?.out?.length ? '<p class="muted small">Scope is not written down yet. Agreeing what is out of scope prevents most later arguments.</p>' : ''}
        </div>
        ${plan.decisions?.length ? `<div class="panel" id="decisions"><h2>Decisions needed</h2><ul class="clean">${plan.decisions.map((d) => `<li><span style="flex:1"><b>${esc(d.title)}</b>${d.detail ? `<div class="small muted">${esc(d.detail)}</div>` : ''}</span><span class="small muted right">${d.status && d.status !== 'open' ? esc(d.status) : d.due ? `by ${fmt(d.due)}` : ''}${d.owner ? `<br>${esc(who(d.owner))}` : ''}</span></li>`).join('')}</ul></div>` : ''}
        ${ov.assumptions?.length || ov.constraints?.length ? `<div class="panel">${ov.assumptions?.length ? `<h2>Assumptions</h2><ul class="clean">${ov.assumptions.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>` : ''}${ov.constraints?.length ? `<h2 style="margin-top:16px">Constraints</h2><ul class="clean">${ov.constraints.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>` : ''}</div>` : ''}
        ${plan.budget?.lines?.length ? renderBudget() : ''}
      </div>`;
  }

  // Newest first; each update says what moved and what it did to the finish date.
  function historyPanel(updates) {
    return `<div class="panel" id="history"><h2>Progress log</h2><ol class="history">${[...updates].reverse().map((u) => {
      const d = u.finish_was ? wdDiff(u.finish_was, u.finish) : 0;
      const changes = u.changes || [];
      return `<li><div class="h-head"><span class="when">${fmt(u.date)}</span><b>${esc(u.summary || 'Update')}</b>${u.by ? `<span class="muted small"> · ${esc(u.by)}</span>` : ''}${u.finish_was ? `<span class="h-delta ${d > 0 ? 'bad' : d < 0 ? 'ok' : 'muted'}">${d === 0 ? 'finish unchanged' : `finish ${d > 0 ? '+' : '−'}${Math.abs(d)}d → ${fmt(u.finish)}`}</span>` : `<span class="h-delta muted">finish ${fmt(u.finish)}</span>`}</div>${changes.length ? `<ul>${changes.slice(0, 4).map((c) => `<li>${esc(c)}</li>`).join('')}</ul>${changes.length > 4 ? `<details><summary>${changes.length - 4} more</summary><ul>${changes.slice(4).map((c) => `<li>${esc(c)}</li>`).join('')}</ul></details>` : ''}` : ''}</li>`;
    }).join('')}</ol></div>`;
  }

  // Phases drawn to scale with milestones and today on the same line; a phase opens the roadmap focused on it.
  function miniTimeline() {
    const shown = phases.filter((p) => S.phases[p.id]);
    if (!shown.length) return '';
    const t0 = ms(S.start), span = Math.max(DAY, ms(S.end) - t0 + DAY);
    const pct = (d) => Math.min(100, Math.max(0, ((ms(d) - t0) / span) * 100));
    // Overlapping phases get their own lane so none hides another.
    const laneEnds = [];
    const lane = new Map();
    for (const p of [...shown].sort((a, b) => ms(S.phases[a.id].start) - ms(S.phases[b.id].start))) {
      const ph = S.phases[p.id];
      let l = laneEnds.findIndex((end) => ms(end) < ms(ph.start));
      if (l < 0) { l = laneEnds.length; laneEnds.push(ph.end); } else laneEnds[l] = ph.end;
      lane.set(p.id, l);
    }
    const segs = shown.map((p) => {
      const ph = S.phases[p.id];
      return `<button class="mt-seg" data-phase="${esc(p.id)}" style="top:${lane.get(p.id) * 32}px;left:${pct(ph.start)}%;width:${Math.max(1.5, pct(ph.end) + (DAY / span) * 100 - pct(ph.start))}%;--c:${phaseColor(p.id)}" title="${esc(p.label)}: ${fmt(ph.start)} – ${fmt(ph.end)}, ${ph.progress}% done"><i style="width:${ph.progress}%"></i><span>${esc(p.label)}</span></button>`;
    }).join('');
    const marks = milestones.map((m) => `<span class="mt-ms${m.achieved ? ' ok' : ''}" style="top:${laneEnds.length * 32}px;left:${pct(S.nodes[m.id].ef)}%" title="${esc(m.label)} · ${fmt(S.nodes[m.id].ef)}"></span>`).join('');
    const today = ms(S.today) >= t0 && ms(S.today) <= ms(S.end) ? `<span class="mt-today" style="left:${pct(S.today)}%"><em>Today</em></span>` : '';
    return `<div class="mini-tl" aria-label="Phases on a time line"><div class="mt-track" style="height:${laneEnds.length * 32 + 12}px">${segs}${marks}${today}</div><div class="mt-axis"><span>${fmt(S.start)}</span><span>${fmt(S.end)}</span></div></div>`;
  }

  function milestoneList() {
    if (!milestones.length) return '<p class="muted small">No milestones yet. Give each phase an exit gate with criteria.</p>';
    return `<ol class="ms-list">${milestones.map((m) => ({ m, n: S.nodes[m.id] })).sort((a, b) => ms(a.n.ef) - ms(b.n.ef)).map(({ m, n }) => {
      const state = m.achieved ? 'ok' : n.late ? 'bad' : ms(n.ef) < ms(S.today) ? '' : 'todo';
      const moved = n.base && n.delta ? ` <span class="tag ${n.delta > 0 ? 'bad' : 'ok'}" title="Baseline ${fmt(n.base.ef)}">${n.delta > 0 ? '+' : '−'}${Math.abs(n.delta)}d</span>` : '';
      return `<li class="${state}"><span class="when">${fmt(n.ef)}${moved}</span><span><button class="link strong" data-goto="${esc(m.id)}">${esc(m.label)}</button>${m.achieved ? ' <span class="tag ok">achieved</span>' : n.late ? ' <span class="tag bad">late</span>' : ''}${m.criteria?.length ? `<span class="small muted block">${m.criteria.map(esc).join(' · ')}</span>` : ''}</span></li>`;
    }).join('')}</ol>`;
  }

  function renderBudget() {
    const lines = plan.budget.lines;
    const total = plan.budget.total ?? lines.reduce((a, l) => a + l.amount, 0);
    const max = Math.max(...lines.map((l) => l.amount), 1);
    return `<div class="panel"><h2>Budget <span class="small" style="text-transform:none;letter-spacing:0;color:var(--ink)">${money(total)}</span></h2>
      ${lines.map((l) => `<div class="load-row" style="grid-template-columns:minmax(110px,180px) 1fr 90px"><span class="small">${esc(l.label)}</span><div class="load-bar"><i style="width:${(l.amount / max) * 100}%;background:${l.phase ? phaseColor(l.phase) : 'var(--accent)'}"></i></div><span class="small mono" style="text-align:right">${money(l.amount)}</span></div>`).join('')}</div>`;
  }

  // ---- roadmap (Gantt) ------------------------------------------------------
  const G = { group: 'phase', zoom: null, deps: true, crit: true, base: true, filter: '', only: null, collapsed: new Set(), selected: null };
  const onlyLabel = () => !G.only ? '' : G.only.kind === 'late' ? 'Behind schedule' : G.only.kind === 'pace' ? 'Behind pace' : G.only.kind === 'slip' ? 'Later than baseline' : G.only.kind === 'critical' ? 'Critical path' : `${roleName(G.only.id)}${roles.get(G.only.id)?.person ? ` (${roles.get(G.only.id).person})` : ''}`;
  function renderRoadmap() {
    const el = $('#view-roadmap');
    const span = (ms(S.end) - ms(S.start)) / DAY;
    G.zoom = G.zoom || (span <= 75 ? 'week' : span <= 320 ? 'month' : 'quarter');
    const groupOpts = [['phase', 'Phase'], plan.workstreams?.length ? ['workstream', 'Workstream'] : null, roles.size ? ['owner', 'Owner'] : null].filter(Boolean);
    el.innerHTML = `
      <div class="controls">
        <span><span class="ctl-label">Group</span><span class="seg-ctl" id="g-group">${groupOpts.map(([k, l]) => `<button data-v="${k}" aria-pressed="${G.group === k}">${l}</button>`).join('')}</span></span>
        <span><span class="ctl-label">Scale</span><span class="seg-ctl" id="g-zoom">${['week', 'month', 'quarter'].map((k) => `<button data-v="${k}" aria-pressed="${G.zoom === k}">${k[0].toUpperCase() + k.slice(1)}</button>`).join('')}</span></span>
        <label class="check"><input type="checkbox" id="g-deps" ${G.deps ? 'checked' : ''}> Dependencies</label>
        <label class="check"><input type="checkbox" id="g-crit" ${G.crit ? 'checked' : ''}> Critical path</label>
        ${S.baseline ? `<label class="check"><input type="checkbox" id="g-base" ${G.base ? 'checked' : ''}> Baseline</label>` : ''}
        <input type="search" id="g-filter" placeholder="Find a task or person" aria-label="Find a task or person" value="${esc(G.filter)}">
        ${G.only ? `<button class="only-chip" id="g-only" aria-label="Show everything">Showing: ${esc(onlyLabel())} <span aria-hidden="true">×</span></button>` : `<button class="btn quiet" data-only="critical">Only the critical path</button>`}
      </div>
      <p class="hint">Drag a bar to try a what-if: move it to delay the task, drag its right edge to change its length. Click a bar to trace what it depends on. Keyboard: Tab to a bar, ← → to move, Shift + ← → to resize.</p>
      <div class="gantt-wrap" id="gantt"></div>
      <div class="legend">
        <span><i style="background:var(--p0)"></i>Task (fill = progress)</span>
        <span><svg width="12" height="12" style="vertical-align:middle;margin-right:6px"><path d="M6 0 L12 6 L6 12 L0 6Z" fill="var(--ink-2)"/></svg>Milestone</span>
        <span><i style="border:2px solid var(--crit);background:none"></i>Critical path</span>
        <span><i style="border:1.6px dashed var(--bad);background:none"></i>Behind schedule</span>
        <span><i style="background:none;border-left:2px dashed var(--today);width:2px;border-radius:0"></i>Today</span>
        <span><svg width="10" height="10" style="vertical-align:middle;margin-right:6px"><circle cx="5" cy="5" r="4" fill="var(--bad)"/></svg>High risk attached</span>
        <span class="sim-only"><i style="border:1.5px dashed var(--ink-3);background:none"></i>Before this what-if</span>
        ${S.baseline ? `<span><i style="height:4px;background:var(--ink-3);opacity:.55"></i>Baseline: ${esc(S.baseline.label)}</span><span><i style="background:repeating-linear-gradient(135deg,var(--ink-3) 0 2px,transparent 2px 5px);opacity:.6"></i>Forecast beyond plan</span>` : ''}
      </div>`;
    $$('#g-group button').forEach((b) => b.addEventListener('click', () => { G.group = b.dataset.v; G.collapsed.clear(); renderRoadmap(); }));
    $$('#g-zoom button').forEach((b) => b.addEventListener('click', () => { G.zoom = b.dataset.v; renderRoadmap(); }));
    $('#g-deps').addEventListener('change', (e) => { G.deps = e.target.checked; $('#gantt').classList.toggle('hide-deps', !G.deps); });
    $('#g-crit').addEventListener('change', (e) => { G.crit = e.target.checked; $('#gantt').classList.toggle('hide-crit', !G.crit); });
    $('#g-base')?.addEventListener('change', (e) => { G.base = e.target.checked; $('#gantt').classList.toggle('hide-base', !G.base); });
    $('#g-filter').addEventListener('input', (e) => { G.filter = e.target.value; drawGantt(); });
    $('#g-only')?.addEventListener('click', (e) => { e.stopPropagation(); G.only = null; renderRoadmap(); });
    drawGantt();
  }

  function groupKey(it) {
    if (G.group === 'workstream') return it.workstream || '_none';
    if (G.group === 'owner') return it.owner || '_none';
    return it.phase || '_none';
  }
  function groupMeta(key) {
    if (key === '_none') return { label: G.group === 'phase' ? 'Milestones & other' : 'Unassigned', color: 'var(--ink-3)' };
    if (G.group === 'workstream') { const w = plan.workstreams.find((x) => x.id === key); const i = plan.workstreams.indexOf(w); return { label: w.label, sub: who(w.owner), color: w.color || `var(--p${i % 8})` }; }
    if (G.group === 'owner') { const r = roles.get(key); return { label: r.label, sub: r.person || '', color: `var(--p${[...roles.keys()].indexOf(key) % 8})` }; }
    const p = phases[phaseIdx.get(key)];
    return { label: p.label, sub: p.goal || '', color: phaseColor(key) };
  }

  function drawGantt() {
    const wrap = $('#gantt');
    const narrow = window.innerWidth < 700;
    const dayW = { week: 22, month: 6.5, quarter: 2.2 }[G.zoom];
    const labelW = narrow ? 170 : 300;
    const rowH = 30, groupH = 34, headH = 46;
    const startD = new Date(ms(S.start));
    const t0 = ms(S.start) - ((startD.getUTCDay() + 6) % 7) * DAY - (G.zoom === 'week' ? 0 : 7 * DAY);
    const endPad = G.zoom === 'week' ? 10 : G.zoom === 'month' ? 21 : 45;
    const t1 = Math.max(ms(S.end), meta.end ? ms(meta.end) : 0) + endPad * DAY;
    const days = Math.round((t1 - t0) / DAY);
    const x = (d) => labelW + ((ms(d) - t0) / DAY) * dayW;
    const W = labelW + days * dayW;

    const q = G.filter.trim().toLowerCase();
    const match = (it) => {
      const n = S.nodes[it.id];
      if (G.only?.kind === 'late' && !n.late) return false;
      if (G.only?.kind === 'pace' && !n.behind) return false;
      if (G.only?.kind === 'slip' && !(n.delta > 0 && !n.actual)) return false;
      if (G.only?.kind === 'critical' && !n.critical) return false;
      if (G.only?.kind === 'owner' && it.owner !== G.only.id) return false;
      return !q || [it.label, it.id, who(it.owner), roleName(it.owner), it.detail].some((s) => String(s || '').toLowerCase().includes(q));
    };
    const riskOf = new Map();
    for (const r of plan.risks || []) if (r.status !== 'closed') for (const a of r.affects || []) if (!riskOf.has(a) || riskScore(riskOf.get(a)) < riskScore(r)) riskOf.set(a, r);
    G.geo = { dayW };

    // groups in declared order
    const order = G.group === 'phase' ? phases.map((p) => p.id) : G.group === 'workstream' ? plan.workstreams.map((w) => w.id) : [...roles.keys()];
    const groups = new Map(order.map((k) => [k, []]));
    for (const it of items.values()) {
      if (!match(it)) continue;
      let k = groupKey(it);
      if (it.kind === 'milestone' && G.group !== 'phase' && !it[G.group === 'owner' ? 'owner' : 'workstream']) k = '_none';
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(it);
    }
    const rows = [];
    for (const [k, list] of groups) {
      if (!list.length) continue;
      // Order rows by the original plan so a what-if never reshuffles what the reader is looking at.
      list.sort((a, b) => ms(BASE.nodes[a.id].es) - ms(BASE.nodes[b.id].es) || (a.kind === 'milestone') - (b.kind === 'milestone'));
      rows.push({ type: 'group', key: k, list });
      if (!G.collapsed.has(k)) for (const it of list) rows.push({ type: it.kind, it });
    }
    let y = headH;
    const rowY = new Map();
    for (const r of rows) { r.y = y; y += r.type === 'group' ? groupH : rowH; if (r.it) rowY.set(r.it.id, r.y + rowH / 2); }
    const H = Math.max(y + 12, headH + 60);

    const out = [];
    out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Roadmap for ${esc(meta.title)}">`);
    out.push(`<defs><marker id="arr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L8 4 L0 8 z" fill="var(--ink-3)"/></marker><marker id="arr-c" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L8 4 L0 8 z" fill="var(--crit)"/></marker></defs>`);
    out.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="var(--panel)"/>`);

    // weekend shading + grid
    if (G.zoom === 'week') {
      const wd = new Set(S.calendar.workdays);
      const hol = new Set(S.calendar.holidays);
      for (let i = 0; i < days; i++) {
        const t = t0 + i * DAY;
        const dow = new Date(t).getUTCDay();
        if (!wd.has(dow) || hol.has(iso(t))) out.push(`<rect class="g-weekend" x="${labelW + i * dayW}" y="${headH}" width="${dayW}" height="${H - headH}"/>`);
      }
    }
    // header ticks
    const ticks = [];
    const majors = [];
    for (let i = 0; i <= days; i++) {
      const t = t0 + i * DAY;
      const d = new Date(t);
      const dow = d.getUTCDay();
      const dom = d.getUTCDate();
      const mon = d.getUTCMonth();
      if (G.zoom === 'week' && dow === 1) ticks.push({ t, label: `${dom}` , sub: `W${isoWeek(d)}` });
      if (G.zoom === 'month' && dow === 1) ticks.push({ t, label: `${dom}` });
      if (G.zoom === 'quarter' && dom === 1) ticks.push({ t, label: d.toLocaleDateString(locale, { month: 'short', timeZone: 'UTC' }) });
      if (G.zoom !== 'quarter' && dom === 1) majors.push({ t, label: d.toLocaleDateString(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }) });
      if (G.zoom === 'quarter' && dom === 1 && mon % 3 === 0) majors.push({ t, label: `Q${mon / 3 + 1} ${d.getUTCFullYear()}` });
    }
    if (!majors.length || ((majors[0].t - t0) / DAY) * dayW > 130) majors.unshift({ t: t0, label: G.zoom === 'quarter' ? `Q${Math.floor(new Date(t0).getUTCMonth() / 3) + 1} ${new Date(t0).getUTCFullYear()}` : new Date(t0).toLocaleDateString(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }), soft: true });
    for (const tk of ticks) out.push(`<line class="g-grid" x1="${labelW + ((tk.t - t0) / DAY) * dayW}" x2="${labelW + ((tk.t - t0) / DAY) * dayW}" y1="${headH - 18}" y2="${H}"/>`);
    for (const mj of majors) if (!mj.soft) out.push(`<line class="g-month" x1="${labelW + ((mj.t - t0) / DAY) * dayW}" x2="${labelW + ((mj.t - t0) / DAY) * dayW}" y1="0" y2="${H}"/>`);

    // rows (labels go to a left pane that stays pinned while scrolling)
    const left = [];
    for (const r of rows) {
      if (r.type === 'group') {
        const gm = groupMeta(r.key);
        let a = null, b = null;
        for (const it of r.list) { const n = S.nodes[it.id]; if (!a || ms(n.es) < ms(a)) a = n.es; if (!b || ms(n.ef) > ms(b)) b = n.ef; }
        const collapsed = G.collapsed.has(r.key);
        out.push(`<g class="g-row"><rect class="g-rowbg" x="0" y="${r.y}" width="${W}" height="${groupH}"/>`);
        out.push(`<line class="g-grid" x1="0" x2="${W}" y1="${r.y}" y2="${r.y}"/>`);
        left.push(`<g class="g-grp" data-group="${esc(r.key)}" style="cursor:pointer"><rect class="g-rowbg" x="0" y="${r.y}" width="${labelW}" height="${groupH}"/><line class="g-grid" x1="0" x2="${labelW}" y1="${r.y}" y2="${r.y}"/><rect x="10" y="${r.y + 11}" width="4" height="12" rx="2" fill="${gm.color}"/>`);
        left.push(`<text class="g-label group" x="22" y="${r.y + 21}">${collapsed ? '▸' : '▾'} ${esc(clip(gm.label, narrow ? 18 : 34))}<tspan class="g-sub" dx="8">${r.list.length}</tspan></text></g>`);
        out.push(`<rect class="g-group-bar" x="${x(a)}" y="${r.y + 13}" width="${Math.max(3, x(b) + dayW - x(a))}" height="8" rx="4" fill="${gm.color}" opacity=".85"/>`);
        out.push('</g>');
        continue;
      }
      const it = r.it;
      const n = S.nodes[it.id];
      const cy = r.y + rowH / 2;
      const color = G.group === 'phase' ? phaseColor(it.phase) : groupMeta(groupKey(it)).color;
      const cls = [n.critical ? 'critical' : '', n.late ? 'late' : '', it.status === 'done' || it.achieved ? 'done' : '', it.status === 'blocked' ? 'blocked' : ''].join(' ');
      out.push(`<g class="g-row" data-id="${esc(it.id)}"><rect class="g-rowbg" x="0" y="${r.y}" width="${W}" height="${rowH}"/>`);
      const ownerTxt = who(it.owner);
      left.push(`<text class="g-label" x="28" y="${cy + 4}" data-id="${esc(it.id)}">${esc(clip(it.label, narrow ? 20 : 38))}</text>`);
      const b0 = BASE.nodes[it.id];
      const movedFromBase = SIM.active() && (b0.es !== n.es || b0.ef !== n.ef);
      if (it.kind === 'milestone') {
        const mx = x(n.ef) + dayW / 2;
        if (n.base && n.base.ef !== n.ef) { const bxm = x(n.base.ef) + dayW / 2; out.push(`<path class="g-baseline" d="M${bxm} ${cy + 6} L${bxm + 4} ${cy + 10} L${bxm} ${cy + 14} L${bxm - 4} ${cy + 10}Z"/>`); }
        if (movedFromBase) { const gx = x(b0.ef) + dayW / 2; out.push(`<path class="g-ghost" d="M${gx} ${cy - 7} L${gx + 7} ${cy} L${gx} ${cy + 7} L${gx - 7} ${cy}Z"/>`); }
        out.push(`<g class="g-ms ${cls}" data-id="${esc(it.id)}"><path d="M${mx} ${cy - 8} L${mx + 8} ${cy} L${mx} ${cy + 8} L${mx - 8} ${cy}Z" fill="${it.achieved ? 'var(--ok)' : color}"/></g>`);
        out.push(`<text class="g-bar-text" x="${mx + 13}" y="${cy + 4}">${esc(fmt(n.ef))}${ownerTxt ? ' · ' + esc(ownerTxt) : ''}</text>`);
      } else {
        const bx = x(n.es), bw = Math.max(dayW, x(n.ef) + dayW - x(n.es));
        const prog = Number.isFinite(it.progress) ? it.progress : it.status === 'done' ? 100 : 0;
        if (n.base) out.push(`<rect class="g-baseline" x="${x(n.base.es)}" y="${cy + 9}" width="${Math.max(dayW, x(n.base.ef) + dayW - x(n.base.es))}" height="3" rx="1.5"/>`);
        if (movedFromBase) out.push(`<rect class="g-ghost" x="${x(b0.es)}" y="${cy - 9}" width="${Math.max(dayW, x(b0.ef) + dayW - x(b0.es))}" height="18" rx="5"/>`);
        out.push(`<g class="g-bar ${cls}${SIM.over[it.id] ? ' changed' : ''}" data-id="${esc(it.id)}" tabindex="0" role="button" aria-label="${esc(it.label)}, ${fmt(n.es)} to ${fmt(n.ef)}, ${n.dur} working days${n.critical ? ', critical path' : ''}">`);
        out.push(`<rect class="track" x="${bx}" y="${cy - 8}" width="${bw}" height="16" rx="4" fill="${color}"/>`);
        if (prog > 0) out.push(`<rect x="${bx}" y="${cy - 8}" width="${(bw * prog) / 100}" height="16" rx="4" fill="${color}"/>`);
        if (n.forecast && n.base && ms(n.ef) > ms(n.base.ef)) { const fx = Math.max(bx, x(n.base.ef) + dayW); out.push(`<rect class="g-forecast" x="${fx}" y="${cy - 8}" width="${bx + bw - fx}" height="16" rx="4"/>`); }
        out.push(`<rect class="edge" x="${bx}" y="${cy - 8}" width="${bw}" height="16" rx="4"/>`);
        out.push(`<rect class="grip" x="${bx + bw - 4}" y="${cy - 6}" width="3" height="12" rx="1.5"/>`);
        out.push('</g>');
        const risk = riskOf.get(it.id);
        const hot = risk && riskScore(risk) >= 10;
        if (hot) out.push(`<circle class="g-risk" cx="${bx + bw + 9}" cy="${cy}" r="4" fill="${riskScore(risk) >= 15 ? 'var(--bad)' : 'var(--warn)'}"><title>${esc(risk.title)} (risk ${riskScore(risk)})</title></circle>`);
        out.push(`<text class="g-bar-text" x="${bx + bw + (hot ? 18 : 6)}" y="${cy + 4}">${ownerTxt ? esc(ownerTxt) : ''}${it.status && it.status !== 'planned' ? `${ownerTxt ? ' · ' : ''}${esc(it.status.replace('_', ' '))}` : ''}${prog > 0 && prog < 100 ? ` ${prog}%` : ''}${n.behind ? ` <tspan class="bad">· behind pace</tspan>` : ''}</text>`);
      }
      out.push('</g>');
    }

    // dependencies
    const deps = [];
    for (const it of items.values()) {
      if (!rowY.has(it.id)) continue;
      for (const d of depIds(it)) {
        if (!rowY.has(d.id)) continue;
        const p = items.get(d.id), pn = S.nodes[d.id], sn = S.nodes[it.id];
        const crit = pn.critical && sn.critical && pn.slack === sn.slack;
        const fromX = d.type === 'SS' ? (p.kind === 'milestone' ? x(pn.es) + dayW / 2 : x(pn.es)) : p.kind === 'milestone' ? x(pn.ef) + dayW / 2 + 8 : x(pn.ef) + dayW;
        const toX = d.type === 'FF' ? x(sn.ef) + dayW : it.kind === 'milestone' ? x(sn.ef) + dayW / 2 - 8 : x(sn.es);
        const y1 = rowY.get(d.id), y2 = rowY.get(it.id);
        const dir = y2 > y1 ? 1 : -1;
        let path;
        if (d.type === 'FF') path = `M${fromX} ${y1} H${Math.max(fromX, toX) + 10} V${y2} H${toX + 2}`;
        else if (toX - fromX >= 12) path = `M${fromX} ${y1} H${fromX + 6} V${y2} H${toX - 1}`;
        else path = `M${fromX} ${y1} H${fromX + 6} V${y2 - dir * 12} H${toX - 10} V${y2} H${toX - 1}`;
        deps.push(`<path class="g-dep${crit ? ' critical' : ''}" data-from="${esc(d.id)}" data-to="${esc(it.id)}" d="${path}" marker-end="url(#${crit ? 'arr-c' : 'arr'})"/>`);
      }
    }
    out.push(`<g class="g-deps">${deps.join('')}</g>`);

    // today + deadline
    const todayX = x(S.today);
    if (todayX > labelW && todayX < W) out.push(`<line class="g-today" x1="${todayX}" x2="${todayX}" y1="${headH - 6}" y2="${H}"/><text class="g-today-label" x="${todayX + 4}" y="${H - 6}">Today</text>`);
    if (meta.end) { const dx = x(meta.end) + dayW; out.push(`<line class="g-deadline" x1="${dx}" x2="${dx}" y1="${headH - 6}" y2="${H}"/><text class="g-today-label" style="fill:var(--bad)" x="${dx + 4}" y="${headH + 10}">Target end</text>`); }

    // header and label pane are drawn last and pinned by translating them on scroll
    out.push(`<g id="g-left"><rect x="0" y="0" width="${labelW}" height="${H}" fill="var(--panel)"/>${left.join('')}<line x1="${labelW}" x2="${labelW}" y1="0" y2="${H}" stroke="var(--line-2)"/></g>`);
    out.push(`<g id="g-top"><rect class="g-head" x="0" y="0" width="${W}" height="${headH}"/>`);
    for (const mj of majors) out.push(`<text class="g-head-major" x="${labelW + ((mj.t - t0) / DAY) * dayW + 6}" y="17">${esc(mj.label)}</text>`);
    for (const tk of ticks) out.push(`<text class="g-head-text" x="${labelW + ((tk.t - t0) / DAY) * dayW + 3}" y="${headH - 8}">${esc(tk.label)}${tk.sub && dayW * 7 > 44 ? ` <tspan opacity=".6">${tk.sub}</tspan>` : ''}</text>`);
    out.push(`<line x1="0" x2="${W}" y1="${headH}" y2="${headH}" stroke="var(--line-2)"/></g>`);
    out.push(`<g id="g-corner"><rect x="0" y="0" width="${labelW}" height="${headH}" fill="var(--panel)"/><text class="g-head-major" x="14" y="${headH - 10}">${G.group === 'owner' ? 'Owner / task' : G.group === 'workstream' ? 'Workstream / task' : 'Phase / task'}</text><line x1="0" x2="${labelW}" y1="${headH}" y2="${headH}" stroke="var(--line-2)"/><line x1="${labelW}" x2="${labelW}" y1="0" y2="${headH}" stroke="var(--line-2)"/></g>`);
    out.push('</svg>');
    wrap.innerHTML = rows.length ? out.join('') : `<div class="empty">Nothing matches${G.filter ? ` “${esc(G.filter)}”` : ''}${G.only ? ` in ${esc(onlyLabel())}` : ''}.</div>`;
    wrap.classList.toggle('hide-deps', !G.deps);
    const pin = () => {
      const l = $('#g-left', wrap), t = $('#g-top', wrap), c = $('#g-corner', wrap);
      if (!l) return;
      l.setAttribute('transform', `translate(${wrap.scrollLeft},0)`);
      t.setAttribute('transform', `translate(0,${wrap.scrollTop})`);
      c.setAttribute('transform', `translate(${wrap.scrollLeft},${wrap.scrollTop})`);
    };
    wrap.onscroll = pin;
    wrap.classList.toggle('hide-crit', !G.crit);
    wrap.classList.toggle('hide-base', !G.base);

    // scroll to today on first draw when the project is underway
    if (!wrap.dataset.scrolled && todayX - labelW > (wrap.clientWidth - labelW) * 0.6) wrap.scrollLeft = todayX - labelW - (wrap.clientWidth - labelW) * 0.35;
    wrap.dataset.scrolled = '1';
    pin();
    if (G.selected) highlight(G.selected);

    $$('.g-grp', wrap).forEach((g) => g.addEventListener('click', () => { const k = g.dataset.group; G.collapsed.has(k) ? G.collapsed.delete(k) : G.collapsed.add(k); drawGantt(); }));
    $$('.g-bar, .g-ms, .g-label[data-id]', wrap).forEach((el) => {
      el.addEventListener('mousemove', (e) => { if (!drag) tip(e, el.dataset.id); });
      el.addEventListener('mouseleave', () => { if (!drag) tipEl.classList.remove('on'); });
      el.addEventListener('click', (e) => { e.stopPropagation(); if (justDragged) { justDragged = false; return; } select(el.dataset.id); });
    });
    $$('.g-bar', wrap).forEach((el) => {
      el.addEventListener('pointerdown', startDrag);
      el.addEventListener('keydown', barKey);
    });
    wrap.onclick = () => select(null);
    if (G.focus) { $(`.g-bar[data-id="${CSS.escape(G.focus)}"]`, wrap)?.focus({ preventScroll: true }); G.focus = null; }
  }

  // ---- direct manipulation: drag to move or resize, with the consequence previewed before release ----
  let drag = null, justDragged = false;
  function startDrag(e) {
    if (e.button !== 0 || e.pointerType === 'touch') return;
    const el = e.currentTarget, id = el.dataset.id, track = $('rect.track', el);
    const bx = +track.getAttribute('x'), bw = +track.getAttribute('width');
    const svg = el.ownerSVGElement, pt = svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const sx = pt.matrixTransform(svg.getScreenCTM().inverse()).x;
    drag = { id, el, mode: sx > bx + bw - 10 ? 'resize' : 'move', x0: e.clientX, days: 0, moved: false, bw, next: null };
    el.setPointerCapture(e.pointerId);
    el.addEventListener('pointermove', moveDrag);
    el.addEventListener('pointerup', endDrag);
    el.addEventListener('pointercancel', endDrag);
  }
  function moveDrag(e) {
    const dx = e.clientX - drag.x0;
    if (!drag.moved && Math.abs(dx) < 4) return;
    drag.moved = true;
    drag.el.classList.add('dragging');
    const days = Math.round(dx / G.geo.dayW);
    const n = S.nodes[drag.id];
    if (drag.mode === 'move') drag.el.setAttribute('transform', `translate(${days * G.geo.dayW},0)`);
    else $$('rect.track, rect.edge', drag.el).forEach((r) => r.setAttribute('width', Math.max(G.geo.dayW, drag.bw + days * G.geo.dayW)));
    if (days === drag.days && drag.next) return positionTip(e);
    drag.days = days;
    // Convert calendar-day movement into working days, then preview the whole plan.
    let next;
    if (drag.mode === 'move') {
      const target = CAL.snapForward(addDays(n.es, days));
      next = moveTask(drag.id, days >= 0 ? CAL.count(n.es, target) - 1 : -(CAL.count(target, n.es) - 1));
    } else {
      next = resizeTask(drag.id, CAL.count(n.es, addDays(n.ef, days)));
    }
    const p = SIM.preview(next);
    drag.next = p.error ? null : next;
    const it = items.get(drag.id);
    if (p.error) tipEl.innerHTML = `<b>${esc(it.label)}</b><div class="bad">${esc(p.error)}</div>`;
    else {
      const r = p.result, m = r.nodes[drag.id], d = wdDiff(S.end, r.end);
      const pinned = drag.mode === 'move' && m.es !== CAL.snapForward(addDays(n.es, days)) && days < 0;
      tipEl.innerHTML = `<b>${esc(it.label)}</b><div>${fmt(m.es)} → ${fmt(m.ef)} · ${plural(m.dur, 'working day')}</div>${pinned ? `<div class="muted">Can't start earlier: its dependencies finish first.</div>` : ''}<div class="${d > 0 ? 'bad' : d < 0 ? 'ok' : 'muted'}">Project finish ${d === 0 ? 'unchanged' : `${d > 0 ? '+' : '−'}${plural(Math.abs(d), 'working day')} → ${fmt(r.end)}`}</div>`;
    }
    tipEl.classList.add('on');
    positionTip(e);
  }
  function endDrag() {
    const d = drag;
    drag = null;
    d.el.removeEventListener('pointermove', moveDrag);
    d.el.removeEventListener('pointerup', endDrag);
    d.el.removeEventListener('pointercancel', endDrag);
    tipEl.classList.remove('on');
    if (!d.moved) return;
    justDragged = true;
    setTimeout(() => (justDragged = false), 0);
    if (d.next && d.days !== 0) { G.selected = d.id; SIM.apply(d.next); } else drawGantt();
  }
  function barKey(e) {
    const id = e.currentTarget.dataset.id;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(id); return; }
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const step = e.key === 'ArrowRight' ? 1 : -1;
    const err = SIM.apply(e.shiftKey ? resizeTask(id, S.nodes[id].dur + step) : moveTask(id, step));
    G.focus = id;
    if (!err && G.selected !== id) select(id);
    $(`#gantt .g-bar[data-id="${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
  }

  function clip(s, n) { s = String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  function isoWeek(d) {
    const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const day = t.getUTCDay() || 7;
    t.setUTCDate(t.getUTCDate() + 4 - day);
    const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    return Math.ceil(((t - y0) / DAY + 1) / 7);
  }

  const tipEl = document.createElement('div');
  tipEl.className = 'tip';
  document.body.appendChild(tipEl);
  function describe(id) {
    const it = items.get(id), n = S.nodes[id];
    const when = it.kind === 'milestone' ? fmtY(n.ef) : `${fmt(n.es)} → ${fmtY(n.ef)} · ${n.dur} working day${n.dur === 1 ? '' : 's'}`;
    return { it, n, when };
  }
  function tip(e, id) {
    const { it, n, when } = describe(id);
    tipEl.innerHTML = `<b>${esc(it.label)}</b><div class="muted">${when}</div>${it.owner ? `<div>${esc(roleName(it.owner))}${roles.get(it.owner)?.person ? ` · ${esc(roles.get(it.owner).person)}` : ''}</div>` : ''}<div class="small">${n.critical ? '<span style="color:var(--crit)">Critical path</span>' : `${n.slack} day${n.slack === 1 ? '' : 's'} of slack`}${n.late && !S.tracking ? ' · <span style="color:var(--bad)">behind schedule</span>' : ''}${n.delta ? ` · <span class="${n.delta > 0 ? 'bad' : 'ok'}">${n.delta > 0 ? '+' : '−'}${Math.abs(n.delta)}d vs baseline</span>` : ''}${n.behind ? ' · <span class="bad">behind pace</span>' : ''}</div>`;
    tipEl.classList.add('on');
    positionTip(e);
  }
  function positionTip(e) {
    const pad = 14;
    let left = e.clientX + pad, top = e.clientY + pad;
    const r = tipEl.getBoundingClientRect();
    if (left + r.width > innerWidth - 8) left = e.clientX - r.width - pad;
    if (top + r.height > innerHeight - 8) top = e.clientY - r.height - pad;
    tipEl.style.left = left + 'px';
    tipEl.style.top = top + 'px';
  }

  function chain(id) {
    const set = new Set([id]);
    const up = (i) => { for (const d of depIds(items.get(i))) if (!set.has(d.id)) { set.add(d.id); up(d.id); } };
    const succ = new Map();
    for (const it of items.values()) for (const d of depIds(it)) { if (!succ.has(d.id)) succ.set(d.id, []); succ.get(d.id).push(it.id); }
    const down = (i) => { for (const s of succ.get(i) || []) if (!set.has(s)) { set.add(s); down(s); } };
    up(id); down(id);
    return set;
  }
  function highlight(id) {
    const wrap = $('#gantt');
    if (!wrap) return;
    $$('.hl', wrap).forEach((e) => e.classList.remove('hl'));
    wrap.classList.toggle('dim', !!id);
    if (!id) return;
    const set = chain(id);
    $$('.g-bar, .g-ms', wrap).forEach((e) => e.classList.toggle('hl', set.has(e.dataset.id)));
    $$('.g-dep', wrap).forEach((e) => e.classList.toggle('hl', set.has(e.dataset.from) && set.has(e.dataset.to)));
  }
  function select(id) {
    G.selected = id;
    highlight(id);
    const dr = $('#drawer');
    if (!id) { dr.classList.remove('on'); return; }
    const { it, n, when } = describe(id);
    const preds = depIds(it).map((d) => `${esc(items.get(d.id)?.label || d.id)}${d.type !== 'FS' ? ` <span class="muted">(${d.type})</span>` : ''}${d.lag ? ` <span class="muted">${d.lag > 0 ? '+' : ''}${d.lag}d</span>` : ''}`);
    const succs = [...items.values()].filter((x) => depIds(x).some((d) => d.id === id)).map((x) => esc(x.label));
    const risks = (plan.risks || []).filter((r) => r.affects?.includes(id));
    const deliverable = it.deliverable && (plan.wbs || []).find((w) => w.id === it.deliverable);
    dr.innerHTML = `<button class="x" aria-label="Close">×</button>
      <div class="small muted">${it.kind === 'milestone' ? 'Milestone' : 'Task'}${SIM.over[id] ? ' · changed in this what-if' : ''}</div>
      <h3 style="margin:2px 0 4px;font-size:16px">${esc(it.label)}</h3>
      <div class="muted">${when}</div>
      ${it.detail ? `<p style="margin:10px 0 0">${esc(it.detail)}</p>` : ''}
      <dl class="kv">
        ${it.phase ? `<dt>Phase</dt><dd><span class="dot" style="background:${phaseColor(it.phase)}"></span> ${esc(phases[phaseIdx.get(it.phase)].label)}</dd>` : ''}
        ${it.owner ? `<dt>Owner</dt><dd><button class="link" data-role="${esc(it.owner)}" title="Show all their work">${esc(roleName(it.owner))}${roles.get(it.owner)?.person ? ` · ${esc(roles.get(it.owner).person)}` : ''}</button></dd>` : ''}
        ${it.status ? `<dt>Status</dt><dd>${esc(it.status.replace('_', ' '))}${Number.isFinite(it.progress) ? ` · ${it.progress}%` : ''}</dd>` : ''}
        ${it.actual_start || it.actual_finish ? `<dt>Actual</dt><dd>${it.actual_start ? `started ${fmt(it.actual_start)}` : ''}${it.actual_finish ? `${it.actual_start ? ', ' : ''}finished ${fmt(it.actual_finish)}` : ''}</dd>` : ''}
        ${n.base ? `<dt>Baseline</dt><dd>${it.kind === 'milestone' ? fmt(n.base.ef) : `${fmt(n.base.es)} → ${fmt(n.base.ef)}`}${n.delta ? ` <span class="${n.delta > 0 ? 'bad' : 'ok'}">(${n.delta > 0 ? 'now ' + plural(n.delta, 'working day') + ' later' : 'now ' + plural(-n.delta, 'working day') + ' earlier'})</span>` : ' <span class="muted">(on baseline)</span>'}</dd>` : ''}
        ${n.expected !== undefined ? `<dt>Pace</dt><dd>${n.reported}% reported, ${n.expected}% expected by today${n.behind ? ' <b class="bad">behind</b>' : ''}</dd>` : ''}
        ${n.forecast ? `<dt>Forecast</dt><dd>${it.kind === 'task' && (it.actual_start || it.progress) ? 'Remaining work counted from today' : 'Not started yet, so it can start today at the earliest'}</dd>` : ''}
        ${it.effort_days ? `<dt>Effort</dt><dd>${it.effort_days} person-days</dd>` : ''}
        ${deliverable ? `<dt>Delivers</dt><dd>${esc(deliverable.label)}</dd>` : ''}
        <dt>Slack</dt><dd>${n.critical ? '<b style="color:var(--crit)">None. It is on the critical path</b>' : `${plural(n.slack, 'working day')}: it can finish as late as ${fmt(n.lf)} without moving the end date`}</dd>
        ${preds.length ? `<dt>After</dt><dd>${preds.join('<br>')}</dd>` : ''}
        ${succs.length ? `<dt>Unblocks</dt><dd>${succs.join('<br>')}</dd>` : ''}
        ${it.criteria?.length ? `<dt>Criteria</dt><dd>${it.criteria.map(esc).join('<br>')}</dd>` : ''}
        ${risks.length ? `<dt>Risks</dt><dd>${risks.map((r) => `<span class="score s${band(riskScore(r))}">${riskScore(r)}</span> ${esc(r.title)}`).join('<br>')}</dd>` : ''}
      </dl>
      ${it.kind === 'task' ? `<div class="whatif" aria-label="What if">
        <span class="small muted">What if it</span>
        ${it.actual_start ? '' : '<button class="btn" data-w="-1">starts a day earlier</button><button class="btn" data-w="1">starts a day later</button>'}
        <button class="btn" data-d="-1">takes a day less</button><button class="btn" data-d="1">takes a day more</button>
        <p class="small bad" id="whatif-msg" hidden></p>
      </div>` : ''}`;
    dr.classList.add('on');
    $$('.whatif [data-w], .whatif [data-d]', dr).forEach((b) => b.addEventListener('click', () => {
      const err = SIM.apply(b.dataset.w ? moveTask(id, +b.dataset.w) : resizeTask(id, S.nodes[id].dur + +b.dataset.d));
      if (err) { const m = $('#whatif-msg'); m.textContent = err; m.hidden = false; }
    }));
    $('.x', dr).addEventListener('click', () => select(null));
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { select(null); closeMenu(); }
    if (e.key === 'Enter' && e.target.matches('.node.clickable')) e.target.click();
  });

  // ---- structure -------------------------------------------------------------
  function renderStructure() {
    const el = $('#view-structure');
    const wbs = plan.wbs || [];
    const kids = new Map();
    for (const w of wbs) { const k = w.parent || '_root'; if (!kids.has(k)) kids.set(k, []); kids.get(k).push(w); }
    const tasksOf = new Map();
    for (const t of tasks) if (t.deliverable) { if (!tasksOf.has(t.deliverable)) tasksOf.set(t.deliverable, []); tasksOf.get(t.deliverable).push(t); }
    const rollup = (id) => {
      let w = 0, p = 0, n = 0;
      const walk = (i) => { for (const t of tasksOf.get(i) || []) { const d = S.nodes[t.id].dur; w += d; p += d * (Number.isFinite(t.progress) ? t.progress : t.status === 'done' ? 100 : 0); n++; } for (const c of kids.get(i) || []) walk(c.id); };
      walk(id);
      return { n, pct: w ? Math.round(p / w) : null };
    };
    const code = new Map();
    const number = (parent, prefix) => (kids.get(parent) || []).forEach((w, i) => { const c = prefix ? `${prefix}.${i + 1}` : `${i + 1}`; code.set(w.id, c); number(w.id, c); });
    const roots = kids.get('_root') || [];
    if (roots.length === 1) { code.set(roots[0].id, '0'); number(roots[0].id, ''); } else number('_root', '');

    const card = (w, color) => {
      const r = rollup(w.id);
      return `<div class="node" style="--c:${color}"><div class="code">${code.get(w.id)}${w.kind ? ` · ${esc(w.kind.replace('_', ' '))}` : ''}</div><b>${esc(w.label)}</b>${w.owner || r.n ? `<div class="sub">${[who(w.owner), r.n ? `${r.n} task${r.n === 1 ? '' : 's'}` : ''].filter(Boolean).map(esc).join(' · ')}</div>` : ''}${r.pct !== null ? `<div class="bar" title="${r.pct}% complete"><i style="width:${r.pct}%"></i></div>` : ''}${w.detail ? `<div class="sub">${esc(w.detail)}</div>` : ''}</div>`;
    };
    const column = (id, color, depth) => (kids.get(id) || []).map((c) => `<div style="margin:8px 0 0 ${depth * 14}px">${card(c, color)}</div>${column(c.id, color, depth + 1)}`).join('');
    const hybridTree = (rootsList, cardFn, kidsMap, colorOf) => {
      const lvl1 = (r) => (kidsMap.get(r.id) || []).map((c, i) => `<li>${cardFn(c, colorOf(c, i))}${(kidsMap.get(c.id) || []).length ? `<div style="align-self:stretch">${columnGeneric(c.id, colorOf(c, i), 0, cardFn, kidsMap)}</div>` : ''}</li>`).join('');
      // A single-child chain at the top (sponsor → steering → PM) stacks vertically; the tree fans out at the first real branch.
      const top = (r, i) => {
        const chain = [r];
        while ((kidsMap.get(chain[chain.length - 1].id) || []).length === 1) chain.push(kidsMap.get(chain[chain.length - 1].id)[0]);
        const last = chain[chain.length - 1];
        const cards = chain.map((c, k) => cardFn(c, k === 0 && rootsList.length === 1 ? 'var(--ink-2)' : colorOf(c, i))).join('<div class="chain-link"></div>');
        return `<li>${cards}${(kidsMap.get(last.id) || []).length ? `<ul>${lvl1(last)}</ul>` : ''}</li>`;
      };
      return `<div class="tree-wrap"><ul class="tree">${rootsList.map(top).join('')}</ul></div>`;
    };
    function columnGeneric(id, color, depth, cardFn, kidsMap) {
      return (kidsMap.get(id) || []).map((c) => `<div style="margin:8px 0 0 ${depth * 14 + 10}px">${cardFn(c, color)}</div>${columnGeneric(c.id, color, depth + 1, cardFn, kidsMap)}`).join('');
    }

    // org chart
    const orgKids = new Map();
    for (const r of plan.roles || []) { const k = r.reports_to || '_root'; if (!orgKids.has(k)) orgKids.set(k, []); orgKids.get(k).push(r); }
    const orgCard = (r, color) => `<div class="node${tasks.some((t) => t.owner === r.id) ? ' clickable" data-role="' + esc(r.id) + '" role="button" tabindex="0" title="Show their work on the roadmap' : ''}" style="--c:${color}"><div class="code">${esc(r.kind || 'role')}${r.fte !== undefined ? ` · ${r.fte} FTE` : ''}</div><b>${esc(r.label)}</b>${r.person || r.org ? `<div class="sub">${[r.person, r.org].filter(Boolean).map(esc).join(' · ')}</div>` : ''}</div>`;
    const kindColor = { sponsor: 'var(--crit)', steering: 'var(--p7)', lead: 'var(--p0)', team: 'var(--p1)', vendor: 'var(--p2)', stakeholder: 'var(--p4)' };
    const orgRoots = (orgKids.get('_root') || []).filter((r) => (orgKids.get(r.id) || []).length || !['stakeholder'].includes(r.kind));
    const loose = (orgKids.get('_root') || []).filter((r) => !orgRoots.includes(r));

    const phaseCards = phases.map((p) => {
      const ph = S.phases[p.id];
      const delivs = [...new Set(tasks.filter((t) => t.phase === p.id && t.deliverable).map((t) => t.deliverable))].map((id) => wbs.find((w) => w.id === id)?.label).filter(Boolean);
      const gates = milestones.filter((m) => m.phase === p.id);
      return `<div class="panel" style="border-top:3px solid ${phaseColor(p.id)}"><h3>${esc(p.label)}</h3><div class="small muted">${ph ? `${fmt(ph.start)} – ${fmtY(ph.end)} · ${ph.workdays} working days · ${ph.progress}%` : 'No scheduled work'}${p.owner ? ` · ${esc(who(p.owner))}` : ''}</div>${p.goal ? `<p style="margin:8px 0">${esc(p.goal)}</p>` : ''}${delivs.length ? `<div class="small muted" style="margin-top:6px">Deliverables</div>${delivs.map((d) => `<span class="chip">${esc(d)}</span>`).join('')}` : ''}${gates.length ? `<div class="small muted" style="margin-top:8px">Exit</div>${gates.map((m) => `<div class="small">◆ <b>${esc(m.label)}</b> · ${fmt(S.nodes[m.id].ef)}${m.criteria?.length ? `<div class="muted">${m.criteria.map(esc).join(' · ')}</div>` : ''}</div>`).join('')}` : ''}</div>`;
    }).join('');

    el.innerHTML = `
      <div class="stack">
        ${phases.length ? `<div><div class="grid g3">${phaseCards}</div></div>` : ''}
        <div class="panel"><h2>Work breakdown structure</h2>${wbs.length ? hybridTree(roots, card, kids, (c, i) => `var(--p${i % 8})`) : '<div class="empty">No WBS defined. Add <span class="mono">wbs</span> entries to break the outcome into deliverables.</div>'}</div>
        <div class="grid g2">
          <div class="panel"><h2>Project organisation</h2>${(plan.roles || []).length ? hybridTree(orgRoots, orgCard, orgKids, (r) => kindColor[r.kind] || 'var(--accent)') + (loose.length ? `<div class="small muted" style="margin-top:12px">Stakeholders</div>${loose.map((r) => `<span class="chip">${esc(r.label)}${r.person ? ` · ${esc(r.person)}` : ''}</span>`).join('')}` : '') : '<div class="empty">No roles defined.</div>'}</div>
          <div class="panel"><h2>Governance</h2>${plan.governance?.forums?.length ? `<div class="stack">${plan.governance.forums.map((f) => `<div class="forum"><b>${esc(f.label)}</b>${f.cadence ? ` <span class="chip">${esc(f.cadence)}</span>` : ''}${f.purpose ? `<div class="small" style="margin-top:4px">${esc(f.purpose)}</div>` : ''}<div class="small muted" style="margin-top:6px">${f.chair ? `Chair: ${esc(roleName(f.chair))}` : ''}${f.members?.length ? ` · ${f.members.map(roleName).map(esc).join(', ')}` : ''}</div></div>`).join('')}</div>${plan.governance.escalation ? `<p class="small muted">Escalation: ${esc(plan.governance.escalation)}</p>` : ''}` : '<div class="empty">No governance forums defined.</div>'}
            ${plan.workstreams?.length ? `<h2 style="margin-top:18px">Workstreams</h2><ul class="clean">${plan.workstreams.map((w, i) => `<li><span class="dot" style="background:${w.color || `var(--p${i % 8})`}"></span><span style="flex:1"><b>${esc(w.label)}</b>${w.detail ? `<div class="small muted">${esc(w.detail)}</div>` : ''}</span><span class="small muted">${esc(who(w.owner))} · ${tasks.filter((t) => t.workstream === w.id).length} tasks</span></li>`).join('')}</ul>` : ''}
          </div>
        </div>
      </div>`;
  }

  // ---- team -------------------------------------------------------------------
  function renderTeam() {
    const el = $('#view-team');
    const raci = plan.raci || [];
    const used = (plan.roles || []).filter((r) => raci.some((x) => x.a === r.id || [x.r, x.c, x.i].some((l) => l?.includes(r.id))));
    const tag = (x, r) => (x.a === r.id ? 'A' : x.r?.includes(r.id) ? 'R' : x.c?.includes(r.id) ? 'C' : x.i?.includes(r.id) ? 'I' : '');
    const raciHtml = raci.length ? `<div class="table-wrap"><table class="raci"><thead><tr><th>Activity / decision</th>${used.map((r) => `<th class="role" title="${esc(r.person || '')}" scope="col">${esc(r.label)}</th>`).join('')}</tr></thead><tbody>${raci.map((x) => `<tr><td class="act">${esc(x.activity)}</td>${used.map((r) => { const t = tag(x, r); return `<td class="cell">${t ? `<span class="r-tag ${t}">${t}</span>` : ''}</td>`; }).join('')}</tr>`).join('')}</tbody></table></div>
      <div class="legend"><span><span class="r-tag R">R</span> Responsible — does the work</span><span><span class="r-tag A">A</span> Accountable — one owner, signs off</span><span><span class="r-tag C">C</span> Consulted</span><span><span class="r-tag I">I</span> Informed</span></div>` : '<div class="empty">No RACI defined.</div>';

    // workload: effort per role, split by phase
    const load = new Map();
    for (const t of tasks) {
      if (!t.owner) continue;
      const e = t.effort_days ?? S.nodes[t.id].dur;
      if (!load.has(t.owner)) load.set(t.owner, new Map());
      const m = load.get(t.owner);
      m.set(t.phase || '_', (m.get(t.phase || '_') || 0) + e);
    }
    const totals = [...load].map(([r, m]) => [r, m, [...m.values()].reduce((a, b) => a + b, 0)]).sort((a, b) => b[2] - a[2]);
    const max = Math.max(1, ...totals.map((x) => x[2]));
    const usesEffort = tasks.some((t) => t.effort_days !== undefined);
    const loadHtml = totals.length ? totals.map(([r, m, tot]) => {
      const fte = roles.get(r)?.fte;
      const cap = fte ? fte * S.workdays : null;
      const over = cap && tot > cap;
      return `<div class="load-row"><span class="small"><button class="link strong" data-role="${esc(r)}" title="Show their work on the roadmap">${esc(roleName(r))}</button>${roles.get(r)?.person ? `<br><span class="muted">${esc(roles.get(r).person)}</span>` : ''}</span><div class="load-bar" style="width:${(tot / max) * 100}%">${[...m].map(([p, v]) => `<i title="${esc(phases[phaseIdx.get(p)]?.label || '')}: ${v}d" style="width:${(v / tot) * 100}%;background:${phaseColor(p)}"></i>`).join('')}</div><span class="small mono" style="text-align:right;${over ? 'color:var(--bad)' : ''}">${Math.round(tot)}d${cap ? `<br><span class="muted">of ${Math.round(cap)}</span>` : ''}</span></div>`;
    }).join('') : '<div class="empty">Assign task owners to see workload.</div>';

    el.innerHTML = `<div class="stack">
      <div class="panel"><h2>RACI matrix</h2>${raciHtml}</div>
      <div class="grid g2">
        <div class="panel"><h2>Workload by role <span class="small muted" style="text-transform:none;letter-spacing:0">${usesEffort ? 'person-days' : 'task working days'}, by phase</span></h2>${loadHtml}</div>
        <div class="panel"><h2>People & roles</h2>${(plan.roles || []).length ? `<div class="table-wrap"><table><thead><tr><th>Role</th><th>Person</th><th>Org</th><th>FTE</th></tr></thead><tbody>${plan.roles.map((r) => `<tr><td><button class="link strong" data-role="${esc(r.id)}" title="Show their work on the roadmap">${esc(r.label)}</button>${r.kind ? ` <span class="chip">${esc(r.kind)}</span>` : ''}${r.detail ? `<div class="small muted">${esc(r.detail)}</div>` : ''}</td><td>${esc(r.person || '—')}</td><td>${esc(r.org || '')}</td><td class="mono">${r.fte ?? ''}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No roles defined.</div>'}</div>
      </div></div>`;
  }

  // ---- risks ------------------------------------------------------------------
  function renderRisks() {
    const el = $('#view-risks');
    const risks = (plan.risks || []).slice().sort((a, b) => riskScore(b) - riskScore(a));
    if (!risks.length) { el.innerHTML = '<div class="empty">No risks recorded. Add <span class="mono">risks</span> with likelihood and impact 1–5.</div>'; return; }
    const cells = [];
    for (let l = 5; l >= 1; l--) {
      cells.push(`<div class="axis">${l}</div>`);
      for (let i = 1; i <= 5; i++) {
        const here = risks.filter((r) => r.likelihood === l && r.impact === i && r.status !== 'closed');
        cells.push(`<div class="cell s${band(l * i)}" title="Likelihood ${l} × impact ${i} = ${l * i}">${here.map((r) => `<span class="rid" data-risk="${esc(r.id)}" title="${esc(r.title)}">${esc(r.id)}</span>`).join('')}</div>`);
      }
    }
    cells.push('<div></div>', ...[1, 2, 3, 4, 5].map((i) => `<div class="axis">${i}</div>`));
    el.innerHTML = `<div class="grid g2" style="grid-template-columns:minmax(0,1fr) minmax(0,1.6fr)">
      <div class="panel"><h2>Heat map <span class="small muted" style="text-transform:none;letter-spacing:0">open items</span></h2>
        <div style="display:flex;gap:6px"><div class="axis heat-y small muted" style="display:grid;place-items:center">Likelihood →</div><div style="flex:1"><div class="heat">${cells.join('')}</div><div class="small muted" style="text-align:center;margin-top:4px">Impact →</div></div></div></div>
      <div class="panel"><h2>Register</h2><div class="table-wrap"><table><thead><tr><th>ID</th><th>Risk</th><th>Score</th><th>Owner</th><th>Mitigation</th><th>Status</th></tr></thead><tbody>
        ${risks.map((r) => `<tr id="risk-${esc(r.id)}"><td class="mono">${esc(r.id)}</td><td><b>${esc(r.title)}</b>${r.type && r.type !== 'risk' ? ` <span class="chip">${esc(r.type)}</span>` : ''}${r.detail ? `<div class="small muted">${esc(r.detail)}</div>` : ''}${r.affects?.length ? `<div class="small muted">Affects ${r.affects.map((a) => `<button class="link" data-goto="${esc(a)}">${esc(items.get(a)?.label || a)}</button>`).join(', ')}</div>` : ''}</td><td><span class="score s${band(riskScore(r))}" title="L${r.likelihood} × I${r.impact}">${riskScore(r)}</span></td><td class="small">${esc(who(r.owner))}</td><td class="small">${esc(r.mitigation || '—')}</td><td class="small">${esc(r.status || 'open')}</td></tr>`).join('')}
      </tbody></table></div></div></div>`;
    $$('.rid', el).forEach((b) => b.addEventListener('click', () => {
      const row = $(`#risk-${CSS.escape(b.dataset.risk)}`);
      row.scrollIntoView({ behavior: 'smooth', block: 'center' });
      row.classList.add('flash');
      setTimeout(() => row.classList.remove('flash'), 1400);
    }));
  }

  const RENDER = { overview: renderOverview, roadmap: renderRoadmap, structure: renderStructure, team: renderTeam, risks: renderRisks };

  // ---- export --------------------------------------------------------------------
  const menu = $('#export');
  const closeMenu = () => menu.classList.remove('open');
  $('#export-btn').addEventListener('click', (e) => { e.stopPropagation(); menu.classList.toggle('open'); });
  document.addEventListener('click', closeMenu);
  const slug = (meta.output || meta.title).replace(/\.html?$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'plan';
  const download = (name, type, content) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(content instanceof Blob ? content : new Blob([content], { type }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  };
  function roadmapSvg() {
    if (!rendered.roadmap) { RENDER.roadmap(); rendered.roadmap = true; }
    const svg = $('#gantt svg').cloneNode(true);
    ['#g-left', '#g-top', '#g-corner'].forEach((sel) => $(sel, svg)?.removeAttribute('transform'));
    const cs = getComputedStyle(document.documentElement);
    const css = [...document.getElementById('planify-css').sheet.cssRules].map((r) => r.cssText).filter((t) => /\.g-|svg text/.test(t) && !/\.dim|\.hide-|hover/.test(t)).join('\n');
    const resolve = (s) => s.replace(/var\((--[a-z0-9-]+)\)/gi, (_, v) => cs.getPropertyValue(v).trim() || '#888');
    const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
    style.textContent = resolve(css);
    svg.insertBefore(style, svg.firstChild);
    $$('[fill^="var("], [stroke^="var("]', svg).forEach((n) => { for (const a of ['fill', 'stroke']) if (n.getAttribute(a)) n.setAttribute(a, resolve(n.getAttribute(a))); });
    $$('[style*="var("]', svg).forEach((n) => n.setAttribute('style', resolve(n.getAttribute('style'))));
    return new XMLSerializer().serializeToString(svg);
  }
  const actions = {
    print: () => { Object.keys(RENDER).forEach((v) => { if (!rendered[v]) { RENDER[v](); rendered[v] = true; } }); setTimeout(() => window.print(), 50); },
    svg: () => download(`${slug}-roadmap.svg`, 'image/svg+xml', roadmapSvg()),
    png: () => {
      const src = roadmapSvg();
      const img = new Image();
      img.onload = () => {
        const scale = 2, c = document.createElement('canvas');
        c.width = img.width * scale; c.height = img.height * scale;
        const ctx = c.getContext('2d');
        ctx.scale(scale, scale);
        ctx.drawImage(img, 0, 0);
        c.toBlob((b) => download(`${slug}-roadmap.png`, 'image/png', b));
      };
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(src);
    },
    md: () => download(`${slug}.md`, 'text/markdown', planToMarkdown(SIM.active() ? SIM.plan() : plan, S)),
    copymd: async (btn) => { try { await navigator.clipboard.writeText(planToMarkdown(SIM.active() ? SIM.plan() : plan, S)); flashBtn(btn, 'Copied'); } catch (_) { actions.md(); } },
    csv: () => download(`${slug}-tasks.csv`, 'text/csv', planToCsv(SIM.active() ? SIM.plan() : plan, S)),
    json: () => download(`${slug}${SIM.active() ? '-adjusted' : ''}.plan.json`, 'application/json', JSON.stringify(SIM.active() ? SIM.plan() : plan, null, 2)),
  };
  function flashBtn(btn, text) { const old = btn.innerHTML; btn.innerHTML = text; setTimeout(() => (btn.innerHTML = old), 1200); }
  $$('#export .menu-list button').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); actions[b.dataset.act](b); if (b.dataset.act !== 'copymd') closeMenu(); }));

  window.addEventListener('resize', () => { if (rendered.roadmap && $('#view-roadmap').classList.contains('active')) drawGantt(); });
  show(location.hash.slice(1) || 'overview');
})();
