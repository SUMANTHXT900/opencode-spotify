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

## Optimized design (applied)

Four parallel jobs, each with npm caching (`setup-node` cache),
per-job timeouts, `concurrency.cancel-in-progress` (never on `main`),
and `paths` filters (docs-only changes skip CI):

| Job | Runner | Steps | Purpose |
|---|---|---|---|
| fast-checks | ubuntu-latest (5 min) | ci, typecheck, bridge `--check`, pack dry-run, audit | Platform-independent gates, cheapest minutes |
| unit-windows | windows-2025 (8 min) | ci, `test:fast` (27 files) | Fast OS-specific feedback |
| render-windows | windows-2025 (8 min) | ci + Bun 1.3.14 + Bun cache, render/vt/artwork | VT stays on Windows (ConPTY width model) |
| pack-windows | windows-2025 (10 min) | ci, build:cli ×1, `verify-package` ×1 | Single release gate |

De-duplication: `test:vt` runs once (render job); `verify-package` runs once
(pack job); `pack --dry-run` only in fast-checks; `audit` once in fast-checks
(same `--audit-level=high` fail policy). Coverage preserved: every gate still
runs exactly once.

## How to benchmark (pending hosted runs)

Local validation first (no hosted workflow spam):

```powershell
Set-Location plugin
npm run typecheck
npm run test:fast          # fast subset (target ~1 min warm)
npm run test:render; npm run test:vt; npm run test:artwork
node scripts/verify-package.mjs   # single full pack gate
```

Then run the new CI 3× warm (cache hit) + 1× cold (cache-busted) and record
medians: per-step timings, cache hit rates, wall-clock (slowest job), and
total runner minutes. Targets: warm wall ≤3 min, cold ≤5 min (stretch;
pack-windows is the expected critical path). If missed, the remaining
bottleneck and the fastest reliable alternative must be reported — checks
are never skipped for timing.

## Public-workflow security (unchanged, verified)

Least-privilege `contents: read`, SHA-pinned actions, `persist-credentials:
false`, no publishing credentials in CI, release stays manual OIDC with
`NPM_PUBLISH_ENABLED` kill switch + `npm-release` environment. Fork PRs get
the same unprivileged jobs; no privileged PR workflow executes untrusted code.
