# Vendored engine

This directory is a **verbatim copy** of `packages/calc-engine` from the
StateRelocator site repository. It is vendored, not linked: no git submodule,
no npm dependency, no network fetch at runtime.

## Source

| | |
| --- | --- |
| Repository | staterelocator (site) |
| Commit | `da85f86f8bd4c2db94a32f7f6345c80658583861` |
| Short | `da85f86` |
| Commit date | 2026-08-22T20:46:48+03:00 |
| Subject | Add on-page SEO: title, description, canonical, OG/Twitter, JSON-LD, sitemap |
| Vendored on | 2026-08-22 |

The same hash is recorded in `.engine-commit` at the repo root, which
`scripts/snapshot.mjs` reads and writes into every snapshot's `meta.json`
as `engine_version`. That is what ties a snapshot's numbers to the exact code
that produced them.

## Why vendored

This repo runs unattended on a monthly cron. A run three years from now must
produce the same numbers from the same inputs without depending on another
repository still existing, another package still resolving, or a network being
reachable. A submodule would add a fetch that can fail and a pointer that can
drift; `npm link` would not survive a fresh CI checkout at all. A copy has
none of those failure modes.

The tradeoff is that this copy does **not** track the site repo automatically.
That is deliberate — a snapshot's value is that it is pinned.

## Contents

| File | Role |
| --- | --- |
| `index.js` | the engine — pure functions, no DOM, no dependencies |
| `data/*.json` | canonical data; these are what get copied into each snapshot's `inputs/` |
| `data/*.js` | generated ES modules the engine actually imports (Infinity baked in) |
| `package.json` | present only so Node treats these files as ES modules |

## Updating

Do not hand-edit anything here. To pick up a newer engine:

1. Copy `packages/calc-engine` over this directory again.
2. Update the hash in `.engine-commit` and in the table above.
3. Run `npm test`.
4. Commit the vendor bump **on its own**, separate from any snapshot commit,
   so the changelog reader can tell a data change from an engine change.

Snapshots taken before the bump keep their old `engine_version` and stay
reproducible against that commit.
