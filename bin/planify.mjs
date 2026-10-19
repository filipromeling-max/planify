#!/usr/bin/env node
// planify CLI: validate → schedule → render a project plan as standalone HTML.

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { resolve, dirname, basename, join } from 'node:path';
import { validate } from '../lib/validate.mjs';
import { schedule } from '../lib/schedule.mjs';
import { renderHtml, VERSION } from '../lib/render.mjs';
import { planToMarkdown, planToCsv } from '../lib/markdown.mjs';

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const args = argv.filter((a) => !a.startsWith('--'));
const json = flags.has('--json');
const [cmd, ...rest] = args;

const USAGE = `planify ${VERSION}

Usage:
  planify finalize <candidate.plan.json> [output.html] [--json]   validate, schedule, render, check
  planify validate <candidate.plan.json> [--json]                 validate and schedule only
  planify export md|csv <candidate.plan.json> [output]            Markdown summary or task CSV
  planify doctor                                                  check the install

The output path defaults to meta.output, resolved from the current directory.`;

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
    const out = resolve(rest[1] || plan.meta.output || join(dirname(resolve(rest[0])), basename(rest[0]).replace(/(\.plan)?\.json$/i, '') + '.html'));
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
