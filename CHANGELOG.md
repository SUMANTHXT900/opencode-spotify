# Changelog

## Unreleased

- Documentation restructure only: user guide, maintainer guide, and release QA
  checklist replace the beta-era working docs. No functional product changes
  (docs/comments plus a test-only capture-path fix).

## 0.6.0-beta.3 (unpublished)

Registry state: `0.6.0-beta.1` and `0.6.0-beta.2` are published (`latest` points
at beta.1, `beta` at beta.2). Beta.3 has no registry artifact; QA uses the local
tarball.

### Added

- Global installer CLI (`setup`, `status`, `update`, `repair`, `doctor`,
  `uninstall`) with read-then-plan-then-confirm flow, `--dry-run`, owner-aware
  Spicetify lifecycle, bridge synchronization, and self-verification.
- Inline Ink dashboard on interactive TTYs with deterministic plain fallback
  (`--plain` / `--no-ink`, non-TTY, `CI`, `TERM=dumb`, `OPENCODE_SPOTIFY_UI=plain`).
  `@inkjs/ui@~2.0.0` used only for the themed wide/colour progress bar and its
  `ThemeProvider`; `Select`, `ConfirmInput`, `TextInput`, `Spinner`,
  `StatusMessage`, and `Alert` deliberately unused.
- Per-user installer lock (`installer.lock`: atomic creation, PID + process start
  time, heartbeat, guarded stale reclaim, nonce re-check); `status`/`doctor` stay
  available while a second mutating run exits 1.
- Cooperative cancellation: first Ctrl+C requests (protected steps finish, then
  partial/130), second forces with owned tree-kill; terminal restored on every
  exit path; 130 only for genuine user cancel.
- Reviewed Spicetify official-installer path: pinned script
  (`spicetify/cli@f4a824f`, 8,307 bytes), deterministic Marketplace-region removal
  (executed script 8,236 bytes), policy-enforced file execution (no
  `Invoke-Expression`, no policy bypass), post-install Authenticode + version
  verification, and dynamic latest-stable release target (never a hardcoded
  version, no fallback, no downgrade).
- Packaging: compiled CLI + provisioner (`npm run build:cli`), exact-version
  global registration, placeholder-secret enforcement, and the one-gate
  `verify:package` check (pack list, isolated install, packed import resolution,
  server/TUI load, installed `bin --version`/`--help`).
- Manual OIDC release workflow: prepare-then-publish with SHA-256 + SHA-512 digest
  attestation, `beta`/`latest` channel handling, `NPM_PUBLISH_ENABLED` kill
  switch, and SHA-pinned actions.

### Changed

- `engines`: Node `>=22.18.0`, Bun `>=1.3.14`; `compat.json` Node minimum
  `22.18.0` (doctor enforces the full version). OpenCode 2.4.2 compatible;
  minimum stays 2.3.0. Official-installer evidence is x64-only; ARM64 uses manual
  guidance unless a release/architecture is explicitly reviewed.
- TUI failure fixed: beta.2 shipped OpenTUI/Solid as optional peers and consumer
  installs failed on the first OpenTUI import; beta.3 restores them as exact
  runtime dependencies.
- Beta.2's static Spicetify target and earlier installer flow replaced by the
  dynamic-target + pinned-script model above.
- `--json` accepted by `status` and `doctor` only; rejected with exit 2 for
  `setup`, `update`, `repair`, and `uninstall`.
- `uninstall` defaults to plugin-only (registration + owned bridge; credentials
  and backups kept). Complete permanent removal requires typed `UNINSTALL`
  interactively, or `--complete` with `--non-interactive` and `--yes`.

### Fixed

- Registration reconciliation, tri-state inspection, operation-specific timeouts,
  sanitized diagnostics, and backup-first `spicetify apply`.
- CRLF-safe PATH handling; backup validation via the shared inspector
  (`xpui.spa` 1,000,000–128 MiB, `login.spa` 100,000–64 MiB); truthful restore
  notes; unknown-owner config preserved; orphan/residual reporting with exit 1;
  winget removal flags; retry after the program is gone; re-verified registration
  removal.
- UI state: results clear progress/prompts, `done` not sticky, versions events
  refresh, real-only percentages, one Spicetify approval per action, maintenance
  menu offering Repair (including local) and Uninstall with achievable-only
  update entries.

### Security

- Mutual HMAC + loopback/Host/Origin-checked bridge auth; per-installation 256-bit
  secret in user configuration and installed extension only; placeholder in the
  package enforced by verification.
- Secret scan is bridge-placeholder and 64-hex plus path-denylist only — not a
  general PII/secret scan.
- Release path uses short-lived OIDC, SHA-pinned actions, read-only top-level
  permissions, and publishes the exact tarball release preparation verified.
  Provenance omitted while the repository is private.

## 0.6.0-beta.2 (published, superseded by beta.3 for TUI loading)

- Installer reliability: reconciled registration mutations, tri-state inspection,
  operation-specific timeouts, sanitized diagnostics, stable/beta channel labels,
  re-prompting confirmations, backup-first Spicetify apply.
- Coexistence: warn-only local/global conflict handling with documented host
  duplicate-ID limitation.
- Spicetify onboarding with source refresh, trust/upgrade guidance,
  post-install verification, and unified both/plugin-only/Spicetify-only/repair/
  continue/exit menu.
- Player: concise narrow-sidebar connection states, extended TUI startup retry
  (~18s); no redesign.
- Player unchanged from V0.5.7 otherwise.

## 0.6.0-beta.1 (published; `latest` still points here)

- First distribution milestone: compiled CLI, global registration, Windows
  detection, Spicetify lifecycle, bridge sync, `verify:package`, manual OIDC
  release workflow. Player unchanged from V0.5.7.
- `latest` on npm resolves to this prerelease. It is not a stable release.

## 0.5.7 and earlier

- V0.5.7 player: pinned `sidebar.footer` card, five-line lyric window, staged
  Indic-ghost clear, non-focusable sidebar, `cellMeasure` max-of-three width
  model with `cellSafety` reserve, 512 px no-upscale artwork, panel-first lyrics
  routing. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the renderer
  history and [docs/RELEASE_QA.md](docs/RELEASE_QA.md) for the live checklist.
