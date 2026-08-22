// Tests for the monthly snapshot generator.
//
// Every test drives runSnapshot() into a fresh temp directory, so nothing here
// touches the real snapshots/ or CHANGELOG.md.

import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, cpSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  runSnapshot, computeRows, toCsv, buildSummary, diffInputs, monthKey,
  listSnapshots, SALARY_POINTS, INPUT_FILES, CSV_COLUMNS, SCHEMA_VERSION,
} from './snapshot.mjs';
import { stateData } from '../engine/index.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_COUNT = Object.keys(stateData).length;

// ── temp-repo scaffolding ─────────────────────────────────────────────────

const tempRoots = [];

/** A throwaway repo root with the real engine data copied in. */
function makeTempRepo() {
  const root = mkdtempSync(path.join(tmpdir(), 'srdata-'));
  tempRoots.push(root);
  mkdirSync(path.join(root, 'engine', 'data'), { recursive: true });
  cpSync(path.join(REPO_ROOT, 'engine', 'data'), path.join(root, 'engine', 'data'), { recursive: true });
  writeFileSync(path.join(root, '.engine-commit'), 'a'.repeat(40) + '\n');
  return root;
}

after(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

const parseCsv = (text) => {
  const lines = text.trimEnd().split('\n');
  return { header: lines[0].split(','), rows: lines.slice(1).map((l) => l.split(',')) };
};

// ── 1. file set ───────────────────────────────────────────────────────────

describe('snapshot produces the exact expected file set', () => {
  let root, result;
  before(() => {
    root = makeTempRepo();
    result = runSnapshot({ repoRoot: root, month: '2026-08', now: new Date('2026-08-22T06:00:00Z') });
  });

  const expectedFiles = [
    'snapshots/2026-08/meta.json',
    'snapshots/2026-08/inputs/state-data.json',
    'snapshots/2026-08/inputs/state-tax-tables.json',
    'snapshots/2026-08/inputs/federal.json',
    'snapshots/2026-08/computed/disposable-income.csv',
    'snapshots/2026-08/computed/summary.json',
    'CHANGELOG.md',
  ];

  for (const rel of expectedFiles) {
    test(`writes ${rel}`, () => {
      assert.ok(existsSync(path.join(root, rel)), `missing ${rel}`);
    });
  }

  test('writes nothing else under the snapshot directory', () => {
    const seen = [];
    const walk = (dir, prefix) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
        else seen.push(rel);
      }
    };
    walk(path.join(root, 'snapshots', '2026-08'), '');
    assert.deepStrictEqual(
      seen.sort(),
      ['computed/disposable-income.csv', 'computed/summary.json', 'inputs/federal.json',
        'inputs/state-data.json', 'inputs/state-tax-tables.json', 'meta.json'],
    );
  });

  test('inputs are byte-for-byte copies of the engine data', () => {
    for (const file of INPUT_FILES) {
      assert.strictEqual(
        readFileSync(path.join(root, 'snapshots/2026-08/inputs', file), 'utf8'),
        readFileSync(path.join(root, 'engine/data', file), 'utf8'),
        `${file} is not a verbatim copy`,
      );
    }
  });

  test('meta.json carries the documented fields', () => {
    const meta = JSON.parse(readFileSync(path.join(root, 'snapshots/2026-08/meta.json'), 'utf8'));
    assert.strictEqual(meta.schema_version, SCHEMA_VERSION);
    assert.strictEqual(meta.month, '2026-08');
    assert.strictEqual(meta.observation_type, 'observed');
    assert.strictEqual(meta.generated_at, '2026-08-22T06:00:00.000Z');
    assert.strictEqual(meta.engine_version, 'a'.repeat(40));
    assert.strictEqual(meta.state_count, STATE_COUNT);
    assert.strictEqual(meta.row_count, STATE_COUNT * SALARY_POINTS.length);
    assert.strictEqual(meta.previous_snapshot, null);
    assert.ok(!Number.isNaN(Date.parse(meta.generated_at)), 'generated_at must be a valid timestamp');
  });

  test('the run reports itself as the first snapshot', () => {
    assert.strictEqual(result.previousMonth, null);
    assert.deepStrictEqual(result.changes, []);
  });
});

// ── 2. CSV shape ──────────────────────────────────────────────────────────

describe('disposable-income.csv', () => {
  let csv;
  before(() => {
    const root = makeTempRepo();
    runSnapshot({ repoRoot: root, month: '2026-08', now: new Date('2026-08-22T06:00:00Z') });
    csv = parseCsv(readFileSync(path.join(root, 'snapshots/2026-08/computed/disposable-income.csv'), 'utf8'));
  });

  test('has exactly 200 data rows (50 states x 4 salary points)', () => {
    assert.strictEqual(STATE_COUNT * SALARY_POINTS.length, 200, 'fixture assumption');
    assert.strictEqual(csv.rows.length, 200);
  });

  test('header matches the documented column order', () => {
    assert.deepStrictEqual(csv.header, CSV_COLUMNS);
  });

  test('every cell is present and numeric where it should be', () => {
    for (const row of csv.rows) {
      assert.strictEqual(row.length, CSV_COLUMNS.length);
      assert.match(row[0], /^[A-Z]{2}$/, 'state code');
      for (let i = 1; i < row.length; i++) {
        assert.match(row[i], /^-?\d+$/, `column ${CSV_COLUMNS[i]} must be a whole number, got ${row[i]}`);
      }
    }
  });

  test('every state appears once per salary point', () => {
    for (const salary of SALARY_POINTS) {
      const states = csv.rows.filter((r) => Number(r[1]) === salary).map((r) => r[0]);
      assert.strictEqual(states.length, STATE_COUNT);
      assert.strictEqual(new Set(states).size, STATE_COUNT, `duplicate state at salary ${salary}`);
    }
  });
});

// ── 3. ranks ──────────────────────────────────────────────────────────────

describe('rank_at_salary', () => {
  const rows = computeRows();

  for (const salary of SALARY_POINTS) {
    test(`is 1..${STATE_COUNT} with no duplicates at $${salary}`, () => {
      const ranks = rows.filter((r) => r.salary_annual === salary).map((r) => r.rank_at_salary);
      assert.strictEqual(ranks.length, STATE_COUNT);
      assert.strictEqual(new Set(ranks).size, STATE_COUNT, 'duplicate ranks');
      assert.deepStrictEqual([...ranks].sort((a, b) => a - b), Array.from({ length: STATE_COUNT }, (_, i) => i + 1));
    });

    test(`orders by disposable income, best first, at $${salary}`, () => {
      const forSalary = rows.filter((r) => r.salary_annual === salary)
        .sort((a, b) => a.rank_at_salary - b.rank_at_salary);
      for (let i = 1; i < forSalary.length; i++) {
        assert.ok(
          forSalary[i - 1].disposable_monthly >= forSalary[i].disposable_monthly,
          `rank ${i} (${forSalary[i - 1].state}) should not have less than rank ${i + 1} (${forSalary[i].state})`,
        );
      }
    });
  }

  test('ranking is deterministic across runs', () => {
    const a = computeRows().map((r) => `${r.salary_annual}:${r.state}:${r.rank_at_salary}`).join('|');
    const b = computeRows().map((r) => `${r.salary_annual}:${r.state}:${r.rank_at_salary}`).join('|');
    assert.strictEqual(a, b);
  });
});

// ── 4. summary.json ───────────────────────────────────────────────────────

describe('summary.json', () => {
  const summary = buildSummary(computeRows());

  test('covers every salary point', () => {
    assert.deepStrictEqual(Object.keys(summary.by_salary).map(Number), SALARY_POINTS);
  });

  for (const salary of SALARY_POINTS) {
    test(`min <= median <= max and a full ${STATE_COUNT}-state ranking at $${salary}`, () => {
      const s = summary.by_salary[String(salary)];
      assert.ok(s.disposable_monthly.min <= s.disposable_monthly.median);
      assert.ok(s.disposable_monthly.median <= s.disposable_monthly.max);
      assert.strictEqual(s.disposable_monthly.spread, s.disposable_monthly.max - s.disposable_monthly.min);
      assert.strictEqual(s.ranking.length, STATE_COUNT);
      assert.strictEqual(s.ranking[0].rank, 1);
      assert.strictEqual(s.ranking[STATE_COUNT - 1].rank, STATE_COUNT);
      assert.strictEqual(s.best_state.disposable_monthly, s.disposable_monthly.max);
      assert.strictEqual(s.worst_state.disposable_monthly, s.disposable_monthly.min);
    });
  }
});

// ── 5. diff logic ─────────────────────────────────────────────────────────

describe('diffInputs', () => {
  const base = () => ({
    'state-data.json': { CA: { name: 'California', housing: 2104, groceries: 452 } },
    'state-tax-tables.json': { CA: { std: 5540, brackets: [[0.01, 11079], [0.133, null]] } },
    'federal.json': { incomeTax: { standardDeduction: 16100 }, fica: { socialSecurityWageBase: 184500 } },
  });

  test('finds nothing when the inputs are identical', () => {
    assert.deepStrictEqual(diffInputs(base(), base()), []);
  });

  test('reports a changed per-state field with old and new values', () => {
    const after = base();
    after['state-data.json'].CA.housing = 2200;
    const changes = diffInputs(base(), after);
    assert.deepStrictEqual(changes, [
      { file: 'state-data.json', state: 'CA', field: 'housing', old: '2104', new: '2200' },
    ]);
  });

  test('reports a changed federal field by dotted path, with no state', () => {
    const after = base();
    after['federal.json'].fica.socialSecurityWageBase = 190000;
    const changes = diffInputs(base(), after);
    assert.deepStrictEqual(changes, [
      { file: 'federal.json', state: '—', field: 'fica.socialSecurityWageBase', old: '184500', new: '190000' },
    ]);
  });

  test('treats a bracket table as a single field', () => {
    const after = base();
    after['state-tax-tables.json'].CA.brackets[0][1] = 12000;
    const changes = diffInputs(base(), after);
    assert.strictEqual(changes.length, 1);
    assert.strictEqual(changes[0].field, 'brackets');
    assert.match(changes[0].old, /11079/);
    assert.match(changes[0].new, /12000/);
  });

  test('reports an added state', () => {
    const after = base();
    after['state-data.json'].ZZ = { name: 'Newstate' };
    const changes = diffInputs(base(), after);
    assert.strictEqual(changes.length, 1);
    assert.strictEqual(changes[0].state, 'ZZ');
    assert.strictEqual(changes[0].old, '—');
  });
});

// ── 6. changelog across consecutive runs ─────────────────────────────────

describe('CHANGELOG.md across runs', () => {
  let root, changelog;

  before(() => {
    root = makeTempRepo();
    // Month 1 — first ever snapshot.
    runSnapshot({ repoRoot: root, month: '2026-07', now: new Date('2026-07-02T06:00:00Z') });

    // Month 2 — mutate one engine input so there is a real change to detect.
    const dataFile = path.join(root, 'engine', 'data', 'state-data.json');
    const data = JSON.parse(readFileSync(dataFile, 'utf8'));
    data.CA.housing = data.CA.housing + 96;
    writeFileSync(dataFile, JSON.stringify(data, null, 2) + '\n');
    runSnapshot({ repoRoot: root, month: '2026-08', now: new Date('2026-08-02T06:00:00Z') });

    // Month 3 — nothing touched, so this one must report no changes.
    runSnapshot({ repoRoot: root, month: '2026-09', now: new Date('2026-09-02T06:00:00Z') });

    changelog = readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  });

  test('first run records that there was nothing to compare against', () => {
    assert.match(changelog, /## 2026-07 —[^\n]*\n\nFirst snapshot — no previous month to compare against\./);
  });

  test('detects the synthetic change and names the state, field, old and new value', () => {
    const section = changelog.split('## 2026-08')[1].split('## 2026-09')[0];
    assert.match(section, /1 input change vs 2026-07:/);
    assert.match(section, /\| state-data\.json \| CA \| housing \| 2104 \| 2200 \|/);
  });

  test('the unchanged run appends "No input changes."', () => {
    const section = changelog.split('## 2026-09')[1];
    assert.match(section, /No input changes\. \(Compared against 2026-08\.\)/);
  });

  test('sections are appended in order and history is never rewritten', () => {
    const order = [...changelog.matchAll(/^## (\d{4}-\d{2}) /gm)].map((m) => m[1]);
    assert.deepStrictEqual(order, ['2026-07', '2026-08', '2026-09']);
    // The July section still says what it said before the later runs ran.
    assert.match(changelog, /## 2026-07 —[^\n]*\n\nFirst snapshot/);
  });

  test('each run diffs against the newest earlier snapshot', () => {
    assert.deepStrictEqual(listSnapshots(path.join(root, 'snapshots')), ['2026-07', '2026-08', '2026-09']);
    const meta = JSON.parse(readFileSync(path.join(root, 'snapshots/2026-09/meta.json'), 'utf8'));
    assert.strictEqual(meta.previous_snapshot, '2026-08');
  });
});

// ── 7. re-running the same month is idempotent ───────────────────────────

describe('re-running the same month', () => {
  test('overwrites the snapshot rather than duplicating it, and still appends', () => {
    const root = makeTempRepo();
    runSnapshot({ repoRoot: root, month: '2026-08', now: new Date('2026-08-02T06:00:00Z') });
    const first = readFileSync(path.join(root, 'snapshots/2026-08/computed/disposable-income.csv'), 'utf8');
    runSnapshot({ repoRoot: root, month: '2026-08', now: new Date('2026-08-03T06:00:00Z') });
    const second = readFileSync(path.join(root, 'snapshots/2026-08/computed/disposable-income.csv'), 'utf8');

    assert.strictEqual(first, second, 'same month, same inputs -> same numbers');
    assert.deepStrictEqual(listSnapshots(path.join(root, 'snapshots')), ['2026-08']);
    // A re-run must not diff the month against itself.
    const meta = JSON.parse(readFileSync(path.join(root, 'snapshots/2026-08/meta.json'), 'utf8'));
    assert.strictEqual(meta.previous_snapshot, null);
  });
});

// ── 8. month key ──────────────────────────────────────────────────────────

describe('monthKey', () => {
  test('formats in UTC and zero-pads', () => {
    assert.strictEqual(monthKey(new Date('2026-08-02T06:00:00Z')), '2026-08');
    assert.strictEqual(monthKey(new Date('2026-12-31T23:59:59Z')), '2026-12');
    // A local-midnight date late in the month must not roll into the next one.
    assert.strictEqual(monthKey(new Date('2027-01-01T00:00:00Z')), '2027-01');
  });
});

// ── 9. CSV escaping is not silently needed ───────────────────────────────

describe('CSV safety', () => {
  test('no value contains a comma, quote or newline, so plain joining is safe', () => {
    const csv = toCsv(computeRows());
    for (const line of csv.trimEnd().split('\n')) {
      assert.strictEqual(line.split(',').length, CSV_COLUMNS.length, `unexpected comma in: ${line}`);
      assert.ok(!line.includes('"'), 'unexpected quote');
    }
  });
});
