// Monthly snapshot of StateRelocator's data inputs and computed outputs.
//
// Run unattended by .github/workflows/snapshot.yml. Everything it needs is in
// this repo — the engine is vendored, there are no dependencies, and nothing
// is fetched at runtime. A run three years from now behaves like today's.
//
//   node scripts/snapshot.mjs                 write this month's snapshot
//   node scripts/snapshot.mjs --month 2026-08 write a specific month
//
// Exported as functions too, so scripts/snapshot.test.mjs can drive the whole
// thing into a temp directory.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { calcDisposable, stateData } from '../engine/index.js';

export const SCHEMA_VERSION = 1;

// Annual figures; calcDisposable takes a monthly salary.
export const SALARY_POINTS = [50000, 75000, 100000, 150000];

export const INPUT_FILES = ['state-data.json', 'state-tax-tables.json', 'federal.json'];

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── helpers ───────────────────────────────────────────────────────────────

const round = (n) => Math.round(n);

/** "2026-08" for a given Date, in UTC. */
export function monthKey(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** Snapshot directories that already exist, oldest first. */
export function listSnapshots(snapshotsDir) {
  if (!existsSync(snapshotsDir)) return [];
  return readdirSync(snapshotsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^\d{4}-\d{2}$/.test(e.name))
    .map((e) => e.name)
    .sort();
}

// ── computed outputs ──────────────────────────────────────────────────────

/**
 * One row per state per salary point, ranked within each salary point.
 * Rank 1 is the most disposable income left. Ties break on state code so the
 * output is deterministic run to run.
 */
export function computeRows() {
  const rows = [];
  for (const salaryAnnual of SALARY_POINTS) {
    const monthly = salaryAnnual / 12;
    const forSalary = Object.keys(stateData).map((state) => {
      const r = calcDisposable(monthly, state);
      return {
        state,
        salary_annual: salaryAnnual,
        total_tax_monthly: round(r.totalTax),
        take_home_monthly: round(r.takeHome),
        housing_monthly: round(r.housing),
        groceries_monthly: round(r.groceries),
        disposable_monthly: round(r.disposable),
        disposable_annual: round(r.disposable * 12),
        _exact: r.disposable,
      };
    });

    forSalary.sort((a, b) => (b._exact - a._exact) || a.state.localeCompare(b.state));
    forSalary.forEach((row, i) => { row.rank_at_salary = i + 1; });
    // Back to a stable, human-scannable order within each salary block.
    forSalary.sort((a, b) => a.state.localeCompare(b.state));
    rows.push(...forSalary);
  }
  return rows;
}

export const CSV_COLUMNS = [
  'state', 'salary_annual', 'total_tax_monthly', 'take_home_monthly',
  'housing_monthly', 'groceries_monthly', 'disposable_monthly',
  'disposable_annual', 'rank_at_salary',
];

export function toCsv(rows) {
  const lines = [CSV_COLUMNS.join(',')];
  for (const row of rows) lines.push(CSV_COLUMNS.map((c) => row[c]).join(','));
  return lines.join('\n') + '\n';
}

function median(sorted) {
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[m - 1] + sorted[m]) / 2) : sorted[m];
}

export function buildSummary(rows) {
  const bySalary = {};
  for (const salaryAnnual of SALARY_POINTS) {
    const forSalary = rows.filter((r) => r.salary_annual === salaryAnnual);
    const ranked = [...forSalary].sort((a, b) => a.rank_at_salary - b.rank_at_salary);
    const values = forSalary.map((r) => r.disposable_monthly).sort((a, b) => a - b);
    const best = ranked[0];
    const worst = ranked[ranked.length - 1];
    bySalary[String(salaryAnnual)] = {
      salary_annual: salaryAnnual,
      salary_monthly: round(salaryAnnual / 12),
      disposable_monthly: {
        min: values[0],
        median: median(values),
        max: values[values.length - 1],
        spread: values[values.length - 1] - values[0],
      },
      best_state: { state: best.state, name: stateData[best.state].name, disposable_monthly: best.disposable_monthly },
      worst_state: { state: worst.state, name: stateData[worst.state].name, disposable_monthly: worst.disposable_monthly },
      ranking: ranked.map((r) => ({
        rank: r.rank_at_salary,
        state: r.state,
        name: stateData[r.state].name,
        disposable_monthly: r.disposable_monthly,
        disposable_annual: r.disposable_annual,
      })),
    };
  }
  return { schema_version: SCHEMA_VERSION, salary_points: SALARY_POINTS, by_salary: bySalary };
}

// ── input diffing ─────────────────────────────────────────────────────────

/**
 * Flatten one input file into "field path" -> value, one entry per leaf, with
 * arrays kept whole (a bracket table only reads as a change if the whole table
 * changed, which is how a human would describe it).
 */
function flatten(value, prefix = '') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { [prefix]: value };
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    Object.assign(out, flatten(v, prefix ? `${prefix}.${k}` : k));
  }
  return out;
}

const show = (v) => (v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));

/**
 * Compare two sets of input files. Returns a flat list of changes.
 * `state` is the leading path segment for the per-state files, "—" otherwise.
 */
export function diffInputs(previous, current) {
  const changes = [];
  for (const file of INPUT_FILES) {
    const isPerState = file !== 'federal.json';
    const before = flatten(previous[file] ?? {});
    const after = flatten(current[file] ?? {});
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    for (const key of keys) {
      const oldValue = before[key];
      const newValue = after[key];
      if (JSON.stringify(oldValue) === JSON.stringify(newValue)) continue;
      const [head, ...rest] = key.split('.');
      changes.push({
        file,
        state: isPerState ? head : '—',
        field: isPerState ? rest.join('.') : key,
        old: show(oldValue),
        new: show(newValue),
      });
    }
  }
  return changes;
}

export function renderChangelogSection(month, isoTimestamp, changes, previousMonth) {
  const lines = [`## ${month} — snapshot taken ${isoTimestamp}`, ''];
  if (!previousMonth) {
    lines.push('First snapshot — no previous month to compare against.', '');
    return lines.join('\n');
  }
  if (changes.length === 0) {
    lines.push(`No input changes. (Compared against ${previousMonth}.)`, '');
    return lines.join('\n');
  }
  lines.push(
    `${changes.length} input ${changes.length === 1 ? 'change' : 'changes'} vs ${previousMonth}:`,
    '',
    '| File | State | Field | Old | New |',
    '| --- | --- | --- | --- | --- |',
  );
  for (const c of changes) {
    const cell = (s) => String(s).replace(/\|/g, '\\|');
    lines.push(`| ${c.file} | ${c.state} | ${cell(c.field)} | ${cell(c.old)} | ${cell(c.new)} |`);
  }
  lines.push('');
  return lines.join('\n');
}

// ── the run ───────────────────────────────────────────────────────────────

/**
 * Write one snapshot. Everything is parameterised so the tests can drive it
 * into a temp directory with fixture inputs.
 */
export function runSnapshot({
  repoRoot = REPO_ROOT,
  engineDataDir = path.join(repoRoot, 'engine', 'data'),
  now = new Date(),
  month = monthKey(now),
  engineVersion,
} = {}) {
  const snapshotsDir = path.join(repoRoot, 'snapshots');
  const outDir = path.join(snapshotsDir, month);
  const inputsDir = path.join(outDir, 'inputs');
  const computedDir = path.join(outDir, 'computed');

  if (engineVersion === undefined) {
    const commitFile = path.join(repoRoot, '.engine-commit');
    engineVersion = existsSync(commitFile) ? readFileSync(commitFile, 'utf8').trim() : 'unknown';
  }

  // Which snapshot do we diff against? The newest one that is not this month.
  const previousMonth = listSnapshots(snapshotsDir).filter((m) => m !== month).pop() ?? null;

  mkdirSync(inputsDir, { recursive: true });
  mkdirSync(computedDir, { recursive: true });

  // 1. inputs — verbatim copies, byte for byte.
  const currentInputs = {};
  for (const file of INPUT_FILES) {
    const raw = readFileSync(path.join(engineDataDir, file), 'utf8');
    writeFileSync(path.join(inputsDir, file), raw);
    currentInputs[file] = JSON.parse(raw);
  }

  // 2. computed
  const rows = computeRows();
  writeFileSync(path.join(computedDir, 'disposable-income.csv'), toCsv(rows));
  writeFileSync(path.join(computedDir, 'summary.json'), JSON.stringify(buildSummary(rows), null, 2) + '\n');

  // 3. meta
  const meta = {
    schema_version: SCHEMA_VERSION,
    month,
    generated_at: now.toISOString(),
    engine_version: engineVersion,
    // "observed" = generated from the live engine at the time. Backfilled
    // months rebuilt from historical rates will say "reconstructed" and live
    // in the same directory layout with the same schema.
    observation_type: 'observed',
    salary_points: SALARY_POINTS,
    state_count: Object.keys(stateData).length,
    row_count: rows.length,
    previous_snapshot: previousMonth,
  };
  writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');

  // 4. changelog — append only, never rewrite.
  const previousInputs = {};
  if (previousMonth) {
    for (const file of INPUT_FILES) {
      const p = path.join(snapshotsDir, previousMonth, 'inputs', file);
      if (existsSync(p)) previousInputs[file] = readJson(p);
    }
  }
  const changes = previousMonth ? diffInputs(previousInputs, currentInputs) : [];
  const section = renderChangelogSection(month, meta.generated_at, changes, previousMonth);

  const changelogPath = path.join(repoRoot, 'CHANGELOG.md');
  if (!existsSync(changelogPath)) {
    writeFileSync(changelogPath, [
      '# Changelog',
      '',
      'One section per snapshot run, appended newest-last. Each records what',
      'changed in the **inputs** since the previous snapshot — the raw tax and',
      'cost data, not the computed outputs, which move whenever the inputs do.',
      '',
      'This file is append-only. Past entries are never rewritten, even if a',
      'later run shows they were based on data that turned out to be wrong.',
      '',
    ].join('\n'));
  }
  appendFileSync(changelogPath, '\n' + section);

  return { month, outDir, meta, changes, previousMonth, rows };
}

// ── CLI ───────────────────────────────────────────────────────────────────

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const monthArg = process.argv.indexOf('--month');
  const month = monthArg !== -1 ? process.argv[monthArg + 1] : undefined;
  if (month !== undefined && !/^\d{4}-\d{2}$/.test(month)) {
    console.error(`--month must look like 2026-08, got: ${month}`);
    process.exit(1);
  }
  const result = runSnapshot(month ? { month } : {});
  console.log(`snapshot ${result.month} written to snapshots/${result.month}/`);
  console.log(`  engine ${result.meta.engine_version.slice(0, 7)} · ${result.meta.row_count} rows · ${result.meta.state_count} states`);
  console.log(result.previousMonth
    ? `  vs ${result.previousMonth}: ${result.changes.length} input change(s)`
    : '  first snapshot — nothing to diff against');
}
