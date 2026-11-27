# Contributing to opencode-spotify

Windows-only project. Keep changes reviewable and avoid unrelated work.

## User install vs dev setup

To **use** the plugin, install the published package — do not clone the repo.

```powershell
opencode plugin add opencode-spotify
npx opencode-spotify setup
```

See the [README](README.md) and [docs/USER_GUIDE.md](docs/USER_GUIDE.md).
Clone and follow the setup below only to **develop** the plugin.

## Setup

```powershell
Set-Location plugin
npm ci --ignore-scripts --no-audit --no-fund
npm run test:accounting
npm run typecheck
npm test
```

`npm test` runs the Node bucket. Release preparation also requires the native
`test:bun`, persistent `test:vt`, bridge syntax, dependency audit, workflow
validation, and `verify:package` gates. The native fixtures need Bun ≥ 1.3.14;
`pwsh` is required by the Windows tests. See
[docs/MAINTAINERS.md](docs/MAINTAINERS.md) for the CI gate layout.

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

- One topic per PR; include automated test evidence (`typecheck`, `npm test`,
  plus rendering or packaging gates when touched).
- Do not commit `bridge.json`, backups, credentials, captures, screenshots
  with private content, or `release-artifacts/` tarballs.
- Public-repo note: this project ships no secrets. Report vulnerabilities
  privately per `SECURITY.md`, never in a public issue.
- For CI internals, the installer trust spec, and the release process, see
  [docs/MAINTAINERS.md](docs/MAINTAINERS.md). For the developer install
  checklist, see [docs/RELEASE_QA.md](docs/RELEASE_QA.md).
