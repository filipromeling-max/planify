# Authoring guide

Everything a candidate can contain, the rules the validator enforces, and starting skeletons per project type. The machine-readable shape is in `schemas/plan.schema.json`; the validator in `lib/validate.mjs` is the authority when they differ.

## Conventions

- **ids** are lowercase slugs (`a-z 0-9 . _ -`), unique across the whole plan, never reused for a different thing. Keep them stable across revisions so references hold.
- **Dates** are ISO days `YYYY-MM-DD`. Durations, lags and slack are **working days** under `meta.calendar` (default Mon–Fri, no holidays).
- **Labels** are what the reader sees: short, specific, sentence case. Tasks are verbs ("Migrate billing accounts"), deliverables and work packages are nouns ("Migrated billing accounts").
- Every reference (`phase`, `owner`, `deliverable`, `depends_on`, `reports_to`, `affects`…) must point at an existing id.

## Top level

| Field | Required | Purpose |
|---|---|---|
| `schema_version` | yes | Always `1`. |
| `plan_type` | yes | Always `"project"`. |
| `meta` | yes | Title, dates, calendar, status, evidence. |
| `overview` | recommended | Goal, problem, scope, success criteria, assumptions, constraints. |
| `phases` | recommended | Sequential stages. Every task needs a `phase` once phases exist. |
| `workstreams` | optional | Parallel tracks that cut across phases. |
| `tasks` | yes* | Scheduled work. (*At least one task or milestone.) |
| `milestones` | recommended | Zero-duration events: gates, deliveries, decisions, launches. |
| `wbs` | recommended | Deliverable hierarchy: the project structure. |
| `roles` | recommended | People and groups; `reports_to` forms the organisation chart. |
| `governance` | optional | Forums with cadence, chair and members; escalation path. |
| `raci` | optional | Responsibility matrix for key activities and decisions. |
| `risks` | recommended | Risks, issues, assumptions and dependencies with scores. |
| `decisions` | optional | Open questions the plan depends on. |
| `budget` | optional | Cost lines, optionally by phase. |

## meta

```json
"meta": {
  "title": "Customer portal relaunch",
  "subtitle": "One line on what and why.",
  "owner": "Head of Digital",
  "status": "draft | proposed | approved | active | on_hold | closed",
  "evidence": "confirmed | illustrative",
  "start": "2026-09-07",
  "end": "2027-02-26",
  "today": "2026-10-19",
  "version": "1.2",
  "locale": "en-GB",
  "output": ".planify/portal-20261019-101500/portal.html",
  "calendar": { "workdays": [1, 2, 3, 4, 5], "holidays": ["2026-12-25"] }
}
```

- `start` and `evidence` are required. `evidence: "illustrative"` shows a badge and a footer note; use it whenever dates, people or amounts were invented.
- `end` is the **target** finish. The scheduler never moves work to meet it; when the scheduled finish is later it raises `plan/deadline-missed` and the roadmap draws a red target line.
- `today` pins the "Today" line and the behind-schedule flags; omit it to use the render date.
- `locale` changes date and currency formatting (`sv-SE`, `de-DE`, …).

## overview

```json
"overview": {
  "goal": "Launch a self-service portal that resolves 60% of support requests without an agent by March 2027.",
  "problem": "Why now, in one or two sentences.",
  "scope": { "in": ["…"], "out": ["…"] },
  "success_criteria": [{ "label": "Self-service resolution rate", "target": "≥ 60%" }],
  "assumptions": ["…"],
  "constraints": ["…"]
}
```

Write the goal as an outcome with a measurable target and a date, not as an activity. Out-of-scope items prevent more arguments than in-scope ones; always include a few.

## phases and workstreams

```json
"phases": [{ "id": "build", "label": "Build", "goal": "Feature-complete portal in staging.", "owner": "tech-lead", "color": "#4c6ef5" }],
"workstreams": [{ "id": "data", "label": "Data & migration", "owner": "data-eng", "detail": "…" }]
```

Phases are when; workstreams are who/what in parallel. The roadmap can group by either, or by owner. 3–6 phases read best. `color` is optional; the default palette works in both themes.

## tasks

```json
{ "id": "billing", "label": "Billing journey", "phase": "build", "workstream": "eng", "owner": "dev-team",
  "duration": 20, "depends_on": ["g-design", { "id": "platform", "type": "SS", "lag": 5 }],
  "deliverable": "w-journeys", "status": "in_progress", "progress": 40, "effort_days": 60,
  "detail": "Invoices, payment methods, direct debit." }
```

- Exactly one of `duration` (working days) or `end`. `start` is optional; without it the task starts at project start or as soon as its dependencies allow.
- `not_before` is a soft earliest start ("not before the contract is signed on 3 Nov"): the task starts on that day or when its dependencies allow, whichever is later. Prefer it over `start` when a date is a lower bound rather than a commitment.
- `depends_on` entries are ids (finish → start) or `{ "id", "type": "FS" | "SS" | "FF", "lag" }`. Lag is working days and may be negative.
- A fixed `start` earlier than the dependencies allow is an error (`plan/dependency-violation`), not a silent move.
- `status`: `planned` (default), `in_progress`, `done`, `blocked`, `at_risk`, `cancelled`. `progress` 0–100. A task whose finish is before today and is not done is flagged behind schedule.
- `effort_days` (person-days) drives the workload view; without it the task's duration is used.
- `deliverable` links the task to a WBS node so the structure view shows tasks and progress per deliverable.

Granularity: aim for tasks of 3–20 working days. For a plan over six months, model work in 2–4 week tasks rather than a long list of small ones; more than ~60 tasks crowds the roadmap.

## milestones

```json
{ "id": "g-design", "label": "Design freeze", "phase": "design", "kind": "gate", "owner": "design-lead",
  "depends_on": ["proto", "usability"], "criteria": ["SUS ≥ 75 in round 2"], "achieved": false }
```

- Either a fixed `date` or `depends_on` (it lands when the last dependency finishes). A fixed date earlier than its dependencies is an error.
- `kind`: `gate` (phase exit), `delivery`, `decision`, `external` (a date set outside the project), `launch`.
- Tasks can depend on milestones: a gate is the cleanest way to say "build starts after design freeze".
- Give every gate `criteria`; they appear in the overview and the phase cards.

## wbs (project structure)

```json
{ "id": "portal", "label": "New customer portal", "kind": "outcome" },
{ "id": "w-app", "label": "Portal application", "parent": "portal", "kind": "deliverable", "owner": "tech-lead" },
{ "id": "w-journeys", "label": "Account, billing, cases", "parent": "w-app", "kind": "work_package" }
```

One root (the outcome), deliverables beneath it, work packages beneath those. Decompose by **deliverable**, not by phase or department, and keep siblings mutually exclusive (100% rule: the children add up to the parent, nothing more). Three levels are usually enough. Numbering (1, 1.2, …) is generated.

## roles

```json
{ "id": "tech-lead", "label": "Tech lead", "person": "Robin", "org": "Platform team", "kind": "lead", "reports_to": "pm", "fte": 1, "detail": "…" }
```

- `kind`: `sponsor`, `steering`, `lead`, `team`, `vendor`, `stakeholder`. Stakeholders without reports are listed beside the organisation chart rather than in it.
- Model roles, not only people: "Dev team (4)" with `fte: 4` is fine. `fte` × scheduled working days gives the capacity shown in the workload view.
- Do not invent names. Use the role label and leave `person` out when unknown.

## governance

```json
"governance": {
  "forums": [{ "label": "Steering group", "cadence": "Monthly", "chair": "sponsor", "members": ["pm", "tech-lead"], "purpose": "Scope, budget and gate decisions." }],
  "escalation": "Stand-up → PM (same day) → Steering group (within 5 days)"
}
```

## raci

```json
{ "activity": "Go-live decision", "r": ["pm"], "a": "sponsor", "c": ["tech-lead", "security"], "i": ["steerco"] }
```

Exactly one accountable role (`a`) per row, at least one responsible (`r`). Use 5–12 rows covering the decisions people will actually argue about: scope change, design sign-off, architecture, release, data, go-live, budget.

## risks

```json
{ "id": "r2", "title": "Migration data quality worse than sampled", "type": "risk",
  "likelihood": 4, "impact": 4, "owner": "data-eng", "mitigation": "Full dry run on production copy.",
  "status": "open", "affects": ["migration-design", "migrate"], "detail": "…" }
```

- `likelihood` and `impact` are integers 1–5; score = L × I. Bands: 1–4 low, 5–9 medium, 10–14 high, 15–25 critical.
- `type`: `risk` (default), `issue` (already happening), `assumption`, `dependency`.
- `status`: `open`, `mitigating`, `accepted`, `closed`. Closed items stay in the register but leave the heat map.
- `affects` links to tasks; the task drawer in the roadmap lists them.
- Write risks as cause → effect ("Data quality worse than sampled, delaying migration"), never as vague worries ("Data").

## decisions

```json
{ "id": "d1", "title": "Phased or big-bang migration?", "owner": "sponsor", "due": "2026-11-13", "status": "open", "blocks": ["g-golive"], "detail": "…" }
```

## budget

```json
"budget": { "currency": "EUR", "total": 420000, "lines": [{ "label": "Build team", "amount": 240000, "phase": "build" }] }
```

`total` defaults to the sum of lines. Amounts are plain numbers.

## Tracking: baseline, actuals and updates

These fields are written as the project runs. `baseline` and `updates` are written by the CLI, never by hand.

| Field | On | Meaning |
|---|---|---|
| `actual_start` | task | Day work really started. Overrides the planned start and its dependencies |
| `actual_finish` | task | Day work really finished. Implies done |
| `achieved_on` | milestone | Day it was really reached |
| `baseline` | plan | Frozen schedule from `planify baseline`. Its presence turns tracking on |
| `updates` | plan | Change log from `planify update`; the newest entry keeps a snapshot used for the next diff |

With a baseline present, the scheduler:

- places unstarted work no earlier than today
- extends work in progress to `today + remaining`, where remaining = duration × (1 − progress)
- reports each item's drift against the baseline (`+5d`) and the project's finish drift
- flags a task **behind pace** when its reported progress is 20+ points below the share of its baseline window that has elapsed

Status updates should name what happened, not what should have happened. Actual dates in the future are rejected.

## Patterns by project type

Starting skeletons. Rename, cut and specialise; never ship the skeleton as-is.

**Software delivery / product build**
Discovery → Design → Build → Test & harden → Launch → Hypercare. Workstreams: Experience, Engineering, Data, Change & support. Gates: discovery sign-off, design freeze, feature complete, go-live. Risks to consider: integration capacity, scope creep, test environment availability.

**Migration / modernisation (cloud, platform, data)**
Assess → Plan & design landing zone → Pilot (one representative workload) → Migration waves (one task per wave) → Decommission → Optimise. Workstreams per platform area. Gates: migration plan approved, pilot accepted, each wave cut-over, legacy off. Model waves as FS chains with the cut-over as milestones; put rollback criteria in gate criteria.

**Consulting engagement / assessment**
Mobilise → Current-state analysis → Options & target state → Roadmap & business case → Handover. Deliverables are reports and workshops. Gates are steering-group read-outs. RACI between client and supplier roles (`org` on roles distinguishes them).

**Product or marketing launch**
Strategy & positioning → Asset production → Channel readiness → Launch → Post-launch review. External milestones for fixed launch or event dates (`kind: "external"` with a fixed `date`) so the scheduler shows whether the work fits.

**Event**
Concept & budget → Venue & suppliers → Programme & speakers → Registration & marketing → Run-of-show → Event day → Wrap-up. The event day is a fixed-date milestone; work flows backwards from it via dependencies.

**Organisational change / process rollout**
Case for change → Design future process → Pilot → Train & communicate → Roll out by unit (waves) → Embed & measure. Stakeholder roles matter more here: list them and give them `i`/`c` in the RACI.

**Research / pilot / proof of concept**
Frame hypotheses → Set up → Run experiments (time-boxed tasks) → Analyse → Decide (decision milestone with explicit go/no-go criteria).

## Quality checklist before finalize

- The goal is an outcome with a number and a date.
- Every phase ends in a gate milestone with criteria.
- Every task has an owner and produces a WBS work package.
- Dependencies, not dates, place most tasks; fixed dates exist only for real external constraints.
- The WBS has one root and sibling items do not overlap.
- RACI rows have one A each.
- The top risks have owners and mitigations; at least one risk touches the critical path.
- Invented facts are flagged with `evidence: "illustrative"`.
