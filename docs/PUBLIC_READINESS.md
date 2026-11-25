# Public repository readiness report — V0.6.0-beta.2 (audit, not a visibility change)

> The repository is still private. Do **not** change visibility until the
> developer reviews this report and explicitly approves public exposure.

## Security and privacy (read-only audit, no values printed)

- No hardcoded production secrets, tokens, private keys, or credential files
  in tracked files or reachable history (only placeholder `__OPENCODE_SPOTIFY_SECRET__`,
  two documented Spotify hashes, and the words `NPM_TOKEN` in workflow/docs).
  No `.npmrc`, `.env`, `bridge.json`, backups, or captures tracked.
  If any credential were ever exposed, rotation (not just file removal) would
  be required — none found.
- Workflows least-privilege (`contents: read`, OIDC-only publish, kill switch
  `NPM_PUBLISH_ENABLED`, SHA-pinned actions, `persist-credentials: false`).
- Privacy: no real usernames/home paths/IPs/credentials in tracked docs (only
  `C:\Users\<user>` template + `$HOME`/`$APPDATA` generics). Screenshots
  correctly untracked/ignored. One live-capture text file contains two lyric
  lines (`docs/V0.5.3_LIVE_SIDEBAR.txt:20-30`) — redact or annotate before
  launch (optional). Commit author email becomes public on open-sourcing
  (accept or future `.mailmap`/private email; no history rewrite).
- `reference/` (incl. AGPL `spicy-lyrics/`) untracked, ignored, and excluded
  from the pack; README/DISTRIBUTION disclose it. Re-confirm provenance before
  any reuse.

## Licensing and documentation

- `LICENSE` (root) byte-identical to `plugin/LICENSE`; `package.json`
  `license: MIT` consistent. Third-party terms disclaimed (Spotify, Spicetify,
  OpenCode, OpenTUI, lyric providers).
- Added: `CONTRIBUTING.md`, `SECURITY.md`, `CHANGELOG.md`, issue/PR templates,
  `dependabot.yml` (npm + actions, weekly).
- Remaining drift to fix before launch: version strings now beta.2 across
  READMEs/DISTRIBUTION/help text (done in tree); retained tarball in
  `release-artifacts/` is still beta.1 and must be rebuilt via
  `node scripts/verify-package.mjs --keep-dir` + sidecars at release time.

## Recommended repository settings (not applied)

- Branch protection on `main`: required PR review, required CI checks
  (fast-checks, unit-windows, render-windows, pack-windows), no force-pushes.
- Secret scanning + push protection on; Dependabot on (added config).
- Fork PR workflows unprivileged; release stays manual (`workflow_dispatch`,
  `npm-release` environment reviewers, `main`-only rule).

## Public-launch checklist

Blocked: (1) commit reviewed beta.2 tree; (2) rebuild/retain beta.2 tarball +
sidecars; (3) redact/annotate lyric lines (optional but recommended);
(4) green CI on the launch commit; (5) apply repo settings above;
(6) first publish stays manual (`npm login` + 2FA, `--tag beta`), then QA,
then stable promotion only. Ready: licenses, ignores, attributes, pack
exclusions, workflow posture, compat/API surface, clean tags/branches.
