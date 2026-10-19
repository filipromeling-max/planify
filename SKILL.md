---
name: planify
description: "Create validated project plans and project structures as explorable standalone HTML: an overview with goal, scope and success criteria; a Gantt roadmap with dependencies, milestones and the computed critical path; a work breakdown structure, project organisation and governance; a RACI matrix with workload; and a risk heat map and register. Dark/light themes, print/PDF, PNG/SVG roadmap, Markdown and CSV export. Use when the user asks to plan a project, programme, migration, launch, engagement or event; to build a roadmap, timeline, Gantt, WBS, RACI, project charter, governance model or risk register; or to turn notes, a brief, a statement of work or a Jira/Notion export into a plan. Not for architecture or system diagrams (use archify) or live trackers."
license: MIT
metadata:
  version: "1.0"
---

# Planify

Turn a project description into one checked, standalone HTML plan. You write a JSON candidate; the CLI validates it, schedules it (working-day calendar, FS/SS/FF dependencies, critical path), renders it and checks the artifact.

Run commands from the user's working directory. Replace `bin/planify.mjs` in every command with this skill's absolute path to it. Unless the user names a location, give each new plan its own folder `.planify/<slug>-<YYYYMMDD-HHMMSS>/` (local time, chosen once) holding `candidate.plan.json` and `<slug>.html`, and set `meta.output` to that HTML path relative to the working directory. Reuse the folder for repairs and revisions of the same plan.

## 1. Gather what the plan needs

Read [Authoring guide](references/authoring-guide.md) and the example `examples/customer-portal.plan.json` in one batch before writing. The example teaches shape, not facts.

A plan stands on four facts: **goal**, **start date**, **scope**, and **who is involved**. Take them from the request, attached documents or the repository. If the start date or goal is missing and the user is available, ask once, in one message, for only the missing ones. If they want a draft anyway, invent plausible values, set `meta.evidence` to `"illustrative"` and say so in the reply. Never present invented dates, people, budgets or rates as confirmed.

For a codebase-backed plan (a migration, a refactor, a release), read the repository first: real module names make better work packages than generic ones.

## 2. Write the complete candidate

Write `candidate.plan.json` in one pass. Build it top-down so each layer constrains the next:

1. `overview`: goal as one outcome sentence with a measurable target, scope in/out, success criteria.
2. `phases` (3–6) and, when work runs in parallel tracks, `workstreams`.
3. `wbs`: one root outcome → deliverables → work packages (nouns, not verbs). This is the project structure.
4. `roles`: who sponsors, decides, leads and does the work, with `reports_to` to form the organisation chart.
5. `tasks`: verbs that produce work packages (`deliverable`), with `owner`, `duration` in working days and `depends_on`. Fix `start` only where an external date really pins it.
6. `milestones`: a gate at the end of each phase with `criteria`, plus external dates and the launch.
7. `governance`, `raci` (exactly one `a` per row), `risks` (likelihood × impact 1–5 with mitigation), `decisions`, `budget` when known.

Prefer dependencies over hand-picked dates: the scheduler places the work, finds the critical path and flags dates that cannot hold. Use the pattern for the project type in the authoring guide as a starting skeleton, then make it specific.

## 3. Finalize

```bash
node bin/planify.mjs finalize <folder>/candidate.plan.json --json
```

A zero exit means validate → schedule → render → check all passed and the HTML plus `<slug>.receipt.json` are written atomically. Keep the candidate unchanged while it runs.

A non-zero exit is never success. Each error has `code`, `path`, `message` and `fix`; apply the fixes to the candidate (not the HTML) and rerun the same command. Common ones:

- `plan/unknown-ref`: an id is misspelled or the entity is missing; add it or correct the reference.
- `plan/cycle`: two tasks wait for each other; split the later iteration into its own task.
- `plan/dependency-violation`: a fixed `start` or milestone `date` is earlier than its dependencies allow. If the date is a real commitment, the plan does not fit: shorten or parallelise work on the critical path and tell the user; otherwise remove the fixed date.
- `plan/over-constrained` / `plan/unschedulable`: give each task exactly one of `end` or `duration`.

Warnings do not block delivery. Resolve the ones that are cheap (`plan/no-owner`, `plan/wbs-unplanned`, `plan/risk-unmitigated`). Never hide `plan/deadline-missed`: if the scheduled finish is after `meta.end`, say so to the user with the gap and the critical-path items that drive it.

After three failed repair rounds on the same error, stop and report it with the candidate path.

## 4. Revisions

For a change request ("move UAT a week", "add a data workstream", "Kim is now on the migration"), edit the existing candidate and rerun `finalize` to the same output. Update `status` and `progress` on tasks and `achieved` on milestones for progress reports; set `meta.today` only when the user wants the plan shown as of a specific date.

Other commands:

```bash
node bin/planify.mjs validate <candidate.plan.json>          # check and schedule without rendering
node bin/planify.mjs export md <candidate.plan.json> [out]   # Markdown summary for Confluence, Notion, email
node bin/planify.mjs export csv <candidate.plan.json> [out]  # task list for Excel, Jira or MS Project import
```

## What readers can do with the page

The Overview opens on a stated verdict (finish date against target, the tasks that set it, what is behind), not a grid of numbers. On the Roadmap a reader can drag a bar (or use the arrow keys) to try a what-if: the real scheduler reruns, the finish date and critical path update, the original dates stay as dashed outlines, and *Save adjusted plan* downloads a candidate you can finalize. When a user sends back an adjusted plan, treat it as a revision: diff it against the candidate, confirm the changes with them, and finalize.

Clicking a person anywhere filters the Roadmap to their work; clicking a phase opens the Roadmap focused on it.

## Optional visual review

`finalize` checks the artifact structurally; it does not look at it. When the user asks for a visual check, or for a large plan (more than ~60 tasks), open the HTML in a browser and look at the Roadmap view. If it is crowded, merge small tasks into fewer, larger ones in the candidate. Never edit the generated HTML by hand: the next `finalize` overwrites it.

## Output

Reply in the user's language, briefly. The page carries the content.

- Lead with a clickable Markdown link to the HTML with a descriptive title and its absolute path, wrapped in `<...>` when it contains spaces.
- Then one or two sentences: the scheduled span and finish date, what drives the critical path, and anything that changes how the plan should be read: illustrative values, a missed target date, high open risks, decisions that block a gate.
- Do not recap commands, receipts or the JSON. If asked whether it was checked, answer in one line, such as "Automated checks passed; not visually reviewed."

Example: `Created [Customer portal relaunch plan](</abs/path/customer-portal.html>). 19 weeks, finishing 19 Jan; the critical path runs through design freeze and the account and case journeys. Dates and people are illustrative until you confirm them.`
