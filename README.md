# staterelocator-data

Monthly snapshots of the data behind [staterelocator.com](https://staterelocator.com):
the raw tax and cost-of-living inputs, and the disposable income they produce
for every US state at four salary points.

One snapshot per month, committed by a GitHub Actions cron job. Nothing here is
ever rewritten — the point is to build a record of how these numbers move over
time, so a claim like "Californians lost $180/month of disposable income during
2027" can be checked against something rather than asserted.

**These are estimates.** They inherit every limitation the site's own
disclaimers describe: single-filer W-2 modelling, statewide medians, no local
income taxes. See [Accuracy](#accuracy) below.

---

## Layout

```
engine/                       vendored calc engine — see engine/VENDORED.md
  index.js                    the tax math, copied from the site repo
  data/*.json                 canonical inputs (what gets snapshotted)
  data/*.js                   generated modules the engine imports
scripts/
  snapshot.mjs                generates one month's snapshot
  snapshot.test.mjs           42 tests, node --test, no framework
snapshots/
  2026-08/
    inputs/                   verbatim copies of the three JSON inputs
    computed/                 disposable-income.csv, summary.json
    meta.json                 provenance for this snapshot
CHANGELOG.md                  append-only log of input changes, month by month
.engine-commit                the vendored engine's source commit hash
```

No dependencies. No build step. `npm test` and `npm run snapshot` work on a
fresh checkout with nothing but Node 22.

---

## Schema

### `meta.json`

| Field | Type | Meaning |
| --- | --- | --- |
| `schema_version` | number | Currently `1`. Bumped only for breaking layout changes. |
| `month` | string | `YYYY-MM`, matching the directory name. |
| `generated_at` | string | ISO 8601 UTC timestamp of the run. |
| `engine_version` | string | Full commit hash of the site repo the engine was vendored from. This is what ties the numbers to the code that produced them. |
| `observation_type` | string | `observed` or `reconstructed` — see [Backfill](#backfill) below. |
| `salary_points` | number[] | Annual salaries computed, currently `[50000, 75000, 100000, 150000]`. |
| `state_count` | number | 50. |
| `row_count` | number | `state_count × salary_points.length`, so 200. |
| `previous_snapshot` | string \| null | The month this run diffed against, or `null` for the first. |

### `computed/disposable-income.csv`

200 data rows plus a header. One row per state per salary point.

| Column | Meaning |
| --- | --- |
| `state` | Two-letter postal code. |
| `salary_annual` | Gross annual salary in USD. |
| `total_tax_monthly` | Federal income tax + FICA + state income tax + state SDI/PFML, per month. |
| `take_home_monthly` | `salary_annual / 12 − total_tax_monthly`. |
| `housing_monthly` | Census ACS median gross rent. Already includes tenant-paid utilities. |
| `groceries_monthly` | MIT Living Wage Calculator, single adult. |
| `disposable_monthly` | `take_home_monthly − housing_monthly − groceries_monthly`. |
| `disposable_annual` | Twelve months of disposable income. |
| `rank_at_salary` | 1–50 within that salary point. 1 = most left over. Ties break on state code, so the ranking is stable run to run. |

**Rounding.** Every column is rounded to whole dollars from the unrounded
figure, independently. That means the columns in a row may not add up to the
cent — `disposable_annual` is `round(exact_disposable × 12)`, not
`disposable_monthly × 12`. Rounding each value from the precise number is more
accurate than compounding a rounded one; if you need the columns to reconcile
exactly, recompute from the inputs.

Rows are ordered by salary point, then alphabetically by state code — not by
rank. Sort by `rank_at_salary` if you want league-table order.

### `computed/summary.json`

`by_salary` is keyed by annual salary as a string. Each entry has:

- `disposable_monthly`: `min`, `median`, `max`, `spread`
- `best_state` / `worst_state`: code, name, and monthly figure
- `ranking`: all 50 states, rank 1 first

The median is the same integer median the site's map uses: for an even count,
the mean of the two middle values, rounded.

### `inputs/`

Byte-for-byte copies of `engine/data/*.json`. Not reformatted, not
re-serialised — a test asserts they are identical to the source. Bracket caps
that are open-ended are `null` here, because JSON has no `Infinity`; the engine
converts them when it loads.

### `CHANGELOG.md`

Append-only. Each run adds one dated section describing what changed in
`inputs/` since the previous snapshot, as a table of file, state, field, old
value and new value. A whole bracket table counts as one field — that is how a
person would describe the change, rather than as forty separate cell edits.

Runs that find nothing say `No input changes.` The very first run says
`First snapshot — no previous month to compare against`, which is a different
fact and is recorded differently on purpose.

Past sections are never edited, even if a later run shows an entry was based on
data that turned out to be wrong. Corrections get appended, not applied
retroactively.

---

## Backfill

`observation_type` exists so that historical months reconstructed later can
live in the same tree with the same schema, without pretending to be something
they are not:

- **`observed`** — generated by a cron run at the time, from the engine as it
  stood that month. Everything currently in this repo.
- **`reconstructed`** — generated afterwards from historical rate tables, to
  fill in months before this repo existed. Same directory layout, same CSV
  columns, same `meta.json` fields.

A reconstructed snapshot would additionally record where its rates came from
and when it was built, since `generated_at` would be long after the month it
describes. Anyone analysing a time series should filter on
`observation_type` rather than assume every month was captured live — a
reconstructed month carries the biases of whatever archive it was rebuilt from.

Reconstructed months will need an engine that can take a rate table as an
argument rather than importing today's. That is a change to the site repo's
engine, not to this one.

---

## Running it locally

```bash
npm test
```

```bash
npm run snapshot
```

`npm run snapshot` writes to `snapshots/<current UTC month>/` and appends to
`CHANGELOG.md`. Re-running the same month overwrites that month's files rather
than creating a duplicate, and does not diff the month against itself. To
generate a specific month:

```bash
node scripts/snapshot.mjs --month 2026-09
```

---

## The workflow

`.github/workflows/snapshot.yml` runs at 06:00 UTC on the 2nd of each month,
and can be triggered by hand from the Actions tab. It checks out, sets up Node
22, **runs the tests**, generates the snapshot, commits as `github-actions[bot]`
and pushes.

Tests run before the snapshot deliberately: a broken vendored engine should
fail the run, not quietly commit wrong numbers into a permanent record.

The commit is skipped if there is nothing staged. That should never happen —
`meta.json` carries a fresh timestamp every run — so if it does, the workflow
emits a warning rather than passing silently.

### Monitoring

If the `HEALTHCHECK_URL` secret is set, a successful run pings it. If the
secret is missing the step logs that it skipped and exits clean, so the repo
works before the check exists. A failed ping is a warning, not a failure — a
monitoring outage should not mark a good snapshot as broken.

This matters more than it looks. A cron job that silently stops is worse than
no cron job, because you find out months later with a gap you cannot fill.

---

## Why there is no keepalive workflow

**GitHub disables scheduled workflows on public repositories after 60 days
with no repository activity.** The obvious mitigation is a "keepalive" action
that manufactures activity. Do not add one here.

The most popular such action, `gautamkrishnar/keepalive-workflow`, **has been
disabled by GitHub Staff for violating the Terms of Service** — specifically
for encouraging excessive usage by circumventing the 60-day inactivity policy.
Its repository now returns a takedown notice. Any equivalent that fabricates
commits purely to reset the timer is the same behaviour under a different name,
and the enforcement risk lands on this repo.

What protects this repo instead:

1. **The snapshot commit is genuine activity.** A real commit lands on the
   default branch every month — a 30-day cadence inside a 60-day window, with
   the whole window to spare. This is not a dummy commit; it is the repo doing
   the thing it exists to do. The only way the timer expires is if the workflow
   stops producing commits for two consecutive months.
2. **Healthchecks.io catches exactly that case.** Configure the check to expect
   a monthly ping with a grace period of a few days, and a missed run alerts
   you within a day or two — long before the 60-day limit is anywhere close.
3. **Recovery is one command.** If a workflow ever is disabled, GitHub emails
   the repository owner, and re-enabling takes:

   ```bash
   gh workflow enable snapshot.yml
   ```

If you would rather not rely on that at all, **make the repository private** —
the 60-day rule applies only to public repositories. The cost is that the data
stops being openly readable, and Actions minutes become metered (this workflow
uses roughly one minute a month against a 2,000-minute free allowance).

Sources: [Disabling and enabling a workflow](https://docs.github.com/actions/managing-workflow-runs/disabling-and-enabling-a-workflow) ·
[keepalive-workflow takedown](https://github.com/gautamkrishnar/keepalive-workflow) ·
[alternative discussion](https://github.com/ddev/github-action-add-on-test/issues/46)

---

## Updating the vendored engine

`engine/` is a pinned copy, deliberately. It does not follow the site repo. To
pick up a newer engine, follow the steps in
[`engine/VENDORED.md`](engine/VENDORED.md) and commit the bump on its own,
separate from any snapshot commit, so that a reader can tell an engine change
from a data change.

Snapshots taken before a bump keep their old `engine_version` and remain
reproducible against that commit.

---

## Accuracy

Every figure here is an estimate carried over from the site, and inherits its
limitations:

- Single-filer W-2 wage earner claiming the standard deduction. No itemised
  deductions, credits, self-employment or investment income.
- **No local income taxes** — New York City, Ohio municipalities, and Indiana
  and Maryland counties are all absent. Maryland in particular reads several
  points cheaper than reality.
- Housing is a **statewide** median. Metro areas are typically well above it.
- `total_tax_monthly` includes mandatory state SDI/PFML contributions for CA,
  WA, OR, NJ, RI and HI.

Do not use this data for tax filing, tax planning, or a relocation decision
without professional advice. It is built for comparing states against each
other and tracking how that comparison shifts over time.

---

## Licence

Not yet chosen. The upstream data is public (IRS, SSA, Census Bureau, Tax
Foundation, MIT Living Wage Calculator); the compilation and code here need a
licence before anyone should assume they can reuse them.
