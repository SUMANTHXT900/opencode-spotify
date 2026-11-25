# CI profiling report — V0.6.0-beta.2

## Baseline (pre-beta.2, single serial job)

- Workflow: `.github/workflows/ci.yml` (old): one `windows-2025` job, 20 min
  timeout, 13 serial steps.
- Observed hosted timings (task brief + background run): ~19m51s and ~15m24s
  Windows runs; local full `npm test` ≈ 141s dominated by
  `verify-artifact` (~140s: 4× `verify-package` invocations) + VT (~44s).
  `docs/VERIFICATION.md` records pass/fail only, no wall-clock timings.
- Redundancy (confirmed by step analysis):
  - `build:cli` ×5 (CI step + package-smoke + verify-artifact keep-dir +
    re-verify + standalone verify step).
  - Full `verify-package` (pack + isolated install + provision smoke) ×4.
  - `vt-emission` ×2 (inside `npm test` glob + standalone `npm run test:vt`).
  - `npm pack --dry-run` vs real pack both run serially.
  - `npm audit` serial at the end.

## Optimized design (applied; Windows-only, 2 parallel jobs)

Two `windows-2025` jobs, each with npm caching (`setup-node` cache),
per-job timeouts, `concurrency.cancel-in-progress` (never on `main`),
and `paths` filters (docs-only changes skip CI). No Linux/macOS jobs: the
installer, rendering assertions and packed provisioner smoke are
Windows-specific by design.

| Job | Timeout | Steps | Purpose |
|---|---|---|---|
| checks-unit | 8 min | ci, typecheck, bridge `--check`, pack dry-run, audit, `test:fast` (24 files) | Static gates + fast unit feedback, no Bun |
| render-pack | 12 min | ci, Bun 1.3.14 + Bun cache, render/vt/artwork, `test:bun`, `verify-package` ×1 | Bun-native suites + single release gate |

`test:fast` excludes the packaging fixtures (packaging is verified once in
render-pack) and the Bun-native suites (`artwork.test.ts`,
`layout-render.test.ts`, `tui-state.test.ts` shell out to `bun`, which the
unit job deliberately lacks — proven by runs #6 and #8). `test:bun` runs
exactly those three files in the Bun job. `test:vt` runs once; `verify-package` (which builds `dist/` itself)
runs once; `pack --dry-run` and `audit` run once in checks-unit (same
`--audit-level=high` fail policy). Coverage preserved: every gate still runs
exactly once; per-job `npm ci` is the only duplication, kept cheap by the
npm cache (a shared-workspace artifact would cost more in upload/download
than a warm cache restore).

Run #6 post-mortem (commit 8483fc6, 4-job design with a Linux job): three
independent defects, all fixed before rerun — (1) `actions/cache` SHA did
not resolve (replaced with the published v4 SHA, verified via API);
(2) fresh `npm ci` skipped the optional TUI peers, so Linux typecheck and
the Windows unit job failed (`solid-js`/`@opentui` types, `artwork.test.ts`
needs `bun`); fixed by pinning the dev-time renderer stack in
`devDependencies` (consumers unaffected); (3) `artwork`/`layout-render`
tests require `bun` and moved to the Bun job via `test:bun`. The
`pack-windows` job passed in run #6 (3m24s), confirming packaging was green.

## How to benchmark (pending hosted runs)

Local validation first (no hosted workflow spam):

```powershell
Set-Location plugin
npm run typecheck
npm run test:fast          # Bun-less fast subset (25 files)
npm run test:bun            # Bun-native suites (needs Bun on PATH)
npm run test:render; npm run test:vt; npm run test:artwork
node scripts/verify-package.mjs   # single full pack gate
```

## Hosted run history (main branch)

- Run #6 (commit 8483fc6, superseded 4-job design with Linux job): failed —
  bad `actions/cache` SHA, missing types on fresh `npm ci` (optional peers),
  `artwork.test.ts` shelling to absent `bun` in the Bun-less unit job.
  `pack-windows` passed (3m24s).
- Run #7 (commit c3bc577, devDeps + cache-SHA fix): fast-checks PASS (28s),
  render PASS (2m3s), pack PASS (3m31s), unit FAIL (same `bun` ENOENT —
  fixed by moving Bun-native suites to `test:bun` in render-pack).
- Before/after vs the 19m51s and 15m24s serial baselines: the parallel wall
  is now bounded by render-pack (~6 min cold-estimate); per-job medians and
  cache hit/miss rates still to be collected from the new 2-job runs
  (3× warm + 1× cold proposed; not yet executed — no hosted spam).

Then run the new CI 3× warm (cache hit) + 1× cold (cache-busted) and record
medians: per-step timings, cache hit rates, wall-clock (slowest job), and
total runner minutes. Targets: warm wall ≤6 min, cold ≤9 min
(render-pack is the expected critical path). If missed, the remaining
bottleneck and the fastest reliable alternative must be reported — checks
are never skipped for timing.

## Public-workflow security (unchanged, verified)

Least-privilege `contents: read`, SHA-pinned actions, `persist-credentials:
false`, no publishing credentials in CI, release stays manual OIDC with
`NPM_PUBLISH_ENABLED` kill switch + `npm-release` environment. Fork PRs get
the same unprivileged jobs; no privileged PR workflow executes untrusted code.
