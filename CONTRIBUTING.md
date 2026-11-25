# Contributing to opencode-spotify

Windows-only project. Keep changes reviewable and avoid unrelated work.

## Setup

```powershell
Set-Location plugin
npm ci --ignore-scripts --no-audit
npm run typecheck
npm run test:fast
```

The full suite (`npm test`, rendering, VT, artwork, `npm run verify:package`)
is required before any release preparation. Rendering fixtures need Bun 1.3.14;
`pwsh` is required by the Windows test fixtures.

## Rules

- TypeScript + TSX + OpenCode RPC. No Python, no native media helper, no OAuth
  app, no separate GUI.
- Never touch Spotify/Spicetify/user OpenCode config from tests. Fake runtimes
  only; no live installs, no `spicetify apply`, no publishing from tests.
- Installer changes must stay argv-based (`shell:false`), preserve exit codes
  and timeout status, sanitize secrets, and keep destructive operations behind
  explicit confirmation (default "no").
- Never silently migrate stable users to beta; never downgrade automatically;
  never mix package managers against an existing Spicetify install.
- Keep the player monochrome (artwork is the only color) and pointer-first.

## Pull requests

- One topic per PR; include automated test evidence (`typecheck`, `test:fast`
  or full `test`, plus rendering/pack gates when touched).
- Do not commit `bridge.json`, backups, credentials, captures, screenshots
  with private content, or `release-artifacts/` tarballs.
- Public-repo note: this project ships no secrets. Report vulnerabilities
  privately per `SECURITY.md`, never in a public issue.
