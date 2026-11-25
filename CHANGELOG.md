# Changelog

## 0.6.0-beta.2 (unpublished)

- Installer reliability: reconciled registration mutations, tri-state
  inspection (registered/absent/unknown), operation-specific timeouts,
  sanitized diagnostics, stable/beta channel labels, environment summary,
  re-prompting confirmations, backup-first Spicetify apply.
- Coexistence: warn-only local/global conflict handling with documented
  host duplicate-ID limitation.
- Spicetify onboarding 2.0: Winget source refresh, trusted-vs-upstream
  drift warnings, post-install verification, unified
  both/plugin-only/Spicetify-only/repair/continue/exit menu.
- Player: concise narrow-sidebar connection states, extended TUI startup
  retry (~18s), no redesign.
- Packaging: host-provided TUI peers optional; engine contract unchanged.
- CI: 4 parallel jobs (Linux fast, Windows fast-unit, Windows render, Windows
  pack), `test:fast` subset, caching, concurrency, path filters, timeouts.
- Docs: beta.2 release notes, QA gates (§8), CI profiling and public
  readiness reports, CONTRIBUTING/SECURITY/templates/Dependabot.

## 0.6.0-beta.1 (unpublished)

- First distribution milestone: compiled CLI, global registration, Windows
  detection, Spicetify lifecycle, bridge sync, `verify:package`, manual OIDC
  release workflow. Player unchanged from V0.5.7.

## 0.5.7 and earlier

- See `docs/VERIFICATION.md` and `docs/V0.6.0_RELEASE_NOTES.md` for the
  V0.5.x player, rendering, and VT history.
