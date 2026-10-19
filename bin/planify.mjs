#!/usr/bin/env node
// planify CLI: validate → schedule → render a project plan as standalone HTML.

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { resolve, dirname, basename, join } from 'node:path';
import { validate } from '../lib/validate.mjs';
import { schedule } from '../lib/schedule.mjs';
import { renderHtml, VERSION } from '../lib/render.mjs';
import { planToMarkdown, planToCsv } from '../lib/markdown.mjs';
import { takeBaseline, recordUpdate } from '../lib/tracking.mjs';

const argv = process.argv.slice(2);
const VALUED = new Set(['--label', '--summary', '--by', '--today']);
const flags = new Set();
const opts = {};
const args = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const [k, v] = a.split(/=(.*)/s);
  if (VALUED.has(k)) opts[k.slice(2)] = v !== undefined ? v : argv[++i];
  else if (a.startsWith('--')) flags.add(a);
  else args.push(a);
}
const json = flags.has('--json');
const [cmd, ...rest] = args;

const USAGE = `planify ${VERSION}

Usage:
  planify finalize <candidate.plan.json> [output.html] [--json]   validate, schedule, render, check
  planify validate <candidate.plan.json> [--json]                 validate and schedule only
  planify baseline <candidate.plan.json> [--label "…"] [--replace] freeze today's schedule and start tracking
  planify update <candidate.plan.json> --summary "…" [--by "…"] [output.html]
                                                                  record a status update, then finalize
  planify export md|csv <candidate.plan.json> [output]            Markdown summary or task CSV
  planify doctor                                                  check the install

The output path defaults to meta.output, resolved from the current directory.
--today YYYY-MM-DD overrides the "as of" date for baseline and update.`;

function load(path) {
  const abs = resolve(path);
  if (!existsSync(abs)) fail([{ code: 'cli/not-found', path: abs, message: `Candidate not found: ${abs}`, fix: 'Write the candidate first.' }]);
  try {
    return JSON.parse(readFileSync(abs, 'utf8'));
  } catch (e) {
    fail([{ code: 'plan/json', path: abs, message: `Invalid JSON: ${e.message}`, fix: 'Fix the syntax (trailing commas and comments are not allowed).' }]);
  }
}

function fail(errors, warnings = [], gate = 'validate') {
  if (json) process.stdout.write(JSON.stringify({ ok: false, gate, errors, warnings }, null, 2) + '\n');
  else {
    console.error(`✗ ${gate} failed with ${errors.length} error${errors.length === 1 ? '' : 's'}`);
    for (const e of errors) console.error(`  ${e.code}  ${e.path}\n    ${e.message}\n    fix: ${e.fix}`);
    printWarnings(warnings);
  }
  process.exit(1);
}

function printWarnings(warnings) {
  if (!warnings.length) return;
  console.error(`! ${warnings.length} warning${warnings.length === 1 ? '' : 's'}`);
  for (const w of warnings) console.error(`  ${w.code}  ${w.path}\n    ${w.message}\n    fix: ${w.fix}`);
}

function check(plan) {
  const v = validate(plan);
  if (v.errors.length) fail(v.errors, v.warnings, 'validate');
  const s = schedule(plan);
  if (s.errors.length) fail(s.errors, [...v.warnings, ...s.warnings], 'schedule');
  return { warnings: [...v.warnings, ...s.warnings], sched: s.result };
}

function summary(plan, sched) {
  return {
    title: plan.meta.title,
    start: sched.start,
    end: sched.end,
    workdays: sched.workdays,
    tasks: (plan.tasks || []).length,
    milestones: (plan.milestones || []).length,
    critical_path: sched.criticalPath,
    evidence: plan.meta.evidence,
  };
}

function finalize(plan, sched, warnings, candidatePath, outArg) {
    const out = resolve(outArg || plan.meta.output || join(dirname(resolve(candidatePath)), basename(candidatePath).replace(/(\.plan)?\.json$/i, '') + '.html'));
    const html = renderHtml(plan, sched, warnings);

    // Self-check the artifact before it replaces anything on disk.
    const problems = [];
    const m = html.match(/<script type="application\/json" id="plan-data">([\s\S]*?)<\/script>/);
    try {
      const back = JSON.parse(m[1]);
      if (back.plan.meta.title !== plan.meta.title) problems.push('embedded plan does not round-trip');
    } catch (e) {
      problems.push(`embedded data does not parse: ${e.message}`);
    }
    for (const id of ['view-overview', 'view-roadmap', 'view-structure', 'view-team', 'view-risks', 'plan-data', 'planify-css']) {
      if (!html.includes(`id="${id}"`)) problems.push(`missing #${id}`);
    }
    if (/https?:\/\/(?!www\.w3\.org)/.test(html.replace(/<script type="application\/json"[\s\S]*?<\/script>/, ''))) problems.push('artifact references a network URL; it must be standalone');
    if (problems.length) fail(problems.map((p) => ({ code: 'render/check', path: out, message: p, fix: 'This is a planify bug; report it with the candidate.' })), warnings, 'check');

    mkdirSync(dirname(out), { recursive: true });
    const tmp = out + '.tmp';
    writeFileSync(tmp, html);
    renameSync(tmp, out);
    const receipt = { ok: true, generator: `planify ${VERSION}`, output: out, bytes: Buffer.byteLength(html), gates: ['validate', 'schedule', 'render', 'check'], warnings, summary: summary(plan, sched) };
    writeFileSync(out.replace(/\.html?$/i, '') + '.receipt.json', JSON.stringify(receipt, null, 2));
    if (json) process.stdout.write(JSON.stringify(receipt, null, 2) + '\n');
    else {
      console.log(`✓ ${out}`);
      console.log(`  ${sched.start} → ${sched.end} · ${sched.workdays} working days · ${receipt.summary.tasks} tasks · ${receipt.summary.milestones} milestones`);
      console.log(`  critical path: ${sched.criticalPath.join(' → ')}`);
      printWarnings(warnings);
    }
}

function save(path, plan) {
  const abs = resolve(path);
  writeFileSync(abs + '.tmp', JSON.stringify(plan, null, 2) + '\n');
  renameSync(abs + '.tmp', abs);
}

switch (cmd) {
  case 'validate': {
    if (!rest[0]) { console.error(USAGE); process.exit(2); }
    const plan = load(rest[0]);
    const { warnings, sched } = check(plan);
    if (json) process.stdout.write(JSON.stringify({ ok: true, gate: 'validate', warnings, summary: summary(plan, sched) }, null, 2) + '\n');
    else {
      console.log(`✓ valid · ${sched.start} → ${sched.end} · ${sched.workdays} working days · critical path: ${sched.criticalPath.join(' → ')}`);
      printWarnings(warnings);
    }
    break;
  }

  case 'finalize':
  case 'render': {
    if (!rest[0]) { console.error(USAGE); process.exit(2); }
    const plan = load(rest[0]);
    const { warnings, sched } = check(plan);
    finalize(plan, sched, warnings, rest[0], rest[1]);
    break;
  }

  case 'baseline': {
    if (!rest[0]) { console.error(USAGE); process.exit(2); }
    const plan = load(rest[0]);
    if (opts.today) plan.meta.today = opts.today;
    if (plan.baseline && !flags.has('--replace')) {
      fail([{ code: 'track/baseline-exists', path: '$.baseline', message: `This plan already has a baseline ("${plan.baseline.label}", ${plan.baseline.taken}).`, fix: 'Re-baseline only after an approved re-plan, with --replace and a --label that names the approval.' }], [], 'baseline');
    }
    delete plan.baseline;
    const { sched } = check(plan);
    plan.baseline = takeBaseline(plan, sched, opts.label);
    const tracked = check(plan);
    plan.updates = recordUpdate(plan, tracked.sched, { summary: flags.has('--replace') ? `Re-baselined: ${plan.baseline.label}` : `Baseline taken: ${plan.baseline.label}` });
    if (opts.today) delete plan.meta.today;
    save(rest[0], plan);
    if (json) process.stdout.write(JSON.stringify({ ok: true, gate: 'baseline', baseline: { label: plan.baseline.label, taken: plan.baseline.taken, end: plan.baseline.end } }, null, 2) + '\n');
    else console.log(`✓ baseline "${plan.baseline.label}" taken ${plan.baseline.taken} · finish ${plan.baseline.end} · tracking is on`);
    break;
  }

  case 'update': {
    if (!rest[0]) { console.error(USAGE); process.exit(2); }
    const plan = load(rest[0]);
    if (!plan.baseline) fail([{ code: 'track/no-baseline', path: '$.baseline', message: 'Status updates need a baseline to measure against.', fix: 'Run `planify baseline <candidate>` once the plan is agreed, then record updates.' }], [], 'update');
    const pinned = plan.meta.today;
    if (opts.today) plan.meta.today = opts.today;
    const first = check(plan);
    plan.updates = recordUpdate(plan, first.sched, { summary: opts.summary, by: opts.by });
    if (opts.today && pinned === undefined) delete plan.meta.today; else if (opts.today) plan.meta.today = pinned;
    save(rest[0], plan);
    const u = plan.updates[plan.updates.length - 1];
    if (!json) {
      console.log(`✓ update recorded ${u.date}: ${u.changes.length} change${u.changes.length === 1 ? '' : 's'}, finish ${u.finish}${u.finish_was && u.finish_was !== u.finish ? ` (was ${u.finish_was})` : ''}`);
      for (const c of u.changes) console.log(`  · ${c}`);
    }
    if (opts.today) plan.meta.today = opts.today;
    const { warnings, sched } = check(plan);
    finalize(plan, sched, warnings, rest[0], rest[1]);
    break;
  }

  case 'export': {
    const [kind, path, outPath] = rest;
    if (!['md', 'csv'].includes(kind) || !path) { console.error(USAGE); process.exit(2); }
    const plan = load(path);
    const { sched } = check(plan);
    const text = kind === 'md' ? planToMarkdown(plan, sched) : planToCsv(plan, sched);
    if (outPath) { writeFileSync(resolve(outPath), text); console.log(`✓ ${resolve(outPath)}`); }
    else process.stdout.write(text + '\n');
    break;
  }

  case 'doctor': {
    const major = Number(process.versions.node.split('.')[0]);
    console.log(`planify ${VERSION} · node ${process.versions.node} ${major >= 18 ? '✓' : '✗ (needs ≥ 18)'}`);
    process.exit(major >= 18 ? 0 : 1);
    break;
  }

  default:
    console.log(USAGE);
    process.exit(cmd ? 2 : 0);
}
