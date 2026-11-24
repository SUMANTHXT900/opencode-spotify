# Distribution (V0.6.0)

How `opencode-spotify` ships, installs, updates, and recovers. V0.6.0 is the
first distribution milestone: the package becomes installable from npm while
the V0.5.7 player behavior is unchanged.

> **Status: private, not yet npm-published.** The tarball pipeline below is
> implemented and runs in CI, but no version has been published. Every `npx`
> command in this doc is the post-publication path — do not run it until
> [V0.6.0_RELEASE_NOTES.md](V0.6.0_RELEASE_NOTES.md) says a version exists.

## Architecture

`OpenCode TUI → authenticated OpenCode RPC → server-owned Spotify service →
authenticated loopback WebSocket → Spicetify extension → Spotify Desktop`.

- The npm package ships `src/` (server plugin, TUI, RPC contract), the
  maintained `spicetify/` bridge, `scripts/install-extension.ps1`, `bin/`
  (the launcher), compiled `dist/cli/` + `dist/scripts/provision.js`, and
  `compat.json`. Package exports are `.` (server), `./tui` (terminal UI), and
  `./rpc` (typed RPC contract).
- Node refuses to type-strip TypeScript under `node_modules`, so the
  installer and bridge provisioner are compiled to plain JavaScript before
  packing (`npm run build:cli`). OpenCode loads the plugin parts from `src/`
  through its own runtime.
- One receiver owns `127.0.0.1:18765` per machine. Extra OpenCode processes
  attach as authenticated observers; on owner exit they contend with jitter
  for the fixed port. See [PROTOCOL.md](PROTOCOL.md).
- The bridge carries an **unprovisioned placeholder secret**
  (`__OPENCODE_SPOTIFY_SECRET__`). The per-installation secret is generated at
  install time and substituted into the *installed copy only* — never into the
  package. `scripts/verify-package.mjs` fails the build if a real secret ever
  lands in the tarball.

## Prerequisites

| Component | Requirement |
|-----------|-------------|
| Windows | Supported for live use; other OSes are unsupported for playback |
| Node.js | ≥ 22.18 (CI builds on 24.12.0; the packaged CLI is compiled JavaScript) |
| Bun | 1.3.14 for the native renderer/artwork fixtures (`npm run test:render`, `test:vt`, `test:artwork`) |
| PowerShell | `pwsh` for the installer fixtures and bridge provisioning |
| OpenCode | ≥ 2.3.0 |
| Spicetify CLI | ≥ 2.0.0 (live use only; never needed for tests or packaging) |
| Spotify Desktop | Live use only; never needed for tests or packaging |

Bridge wire protocol is **2 / auto-1**. Never run two differently named
copies of the bridge at once.

## Global registration

Register the package **once**, globally, by exact version, using the native
OpenCode command. This is the supported mutation path — it writes the global
config while preserving unrelated settings:

```powershell
opencode plugin add opencode-spotify@0.6.0-beta.1
```

The global config path is resolved from `opencode debug paths config`
(verified: `C:\Users\<user>\.config\opencode`, file `opencode.json(c)`;
`$XDG_CONFIG_HOME/opencode/opencode.json(c)` when that variable is set).
Machine-wide `%ProgramData%\opencode\opencode.json` takes higher precedence
when present. The equivalent JSON is illustrative only:

```jsonc
// global opencode.json(c) — illustrative only; prefer `opencode plugin add`
{ "plugins": ["opencode-spotify@0.6.0-beta.1"] }
```

- Only one entry is needed in the global `opencode.json(c)`: it loads both
  halves — the server owner (`src/index.ts`, RPC + WebSocket receiver) and
  the TUI (`src/tui.tsx`, sidebar footer + session panel). Do not add a
  second local-path entry alongside the global one — the updater treats a
  local development registration as authoritative and will never replace it
  with a registry version on its own.
- Project-local config is never modified. Setup warns when a project-local
  `opencode-spotify` shadows the global install but leaves it alone.
- `cli.json` is only for TUI-only packages: it loads just the TUI half and
  cannot provision the bridge or own the port. Provisioning and updates
  always go through the global registration plus the CLI below.

## CLI commands and flags

All commands are read-then-plan-then-confirm. Nothing mutates before an
explicit approval, and `--dry-run` always shows the plan first.

| Command | Effect |
|---------|--------|
| `setup` (default; `install` aliases it) | Install, or maintain an existing installation |
| `status` | Read-only installation summary (`--json` for machines) |
| `update` | Check for and apply compatible updates |
| `repair` | Repair missing or damaged owned files and registration |
| `doctor` | Read-only diagnostics with actionable guidance |
| `uninstall` | Remove the global registration and owned bridge files |

| Flag | Meaning |
|------|---------|
| `--dry-run` | Show the plan without changing anything |
| `--yes` / `-y` | Approve planned modifications (required when non-interactive) |
| `--json` | Machine-readable output where supported |
| `--no-color` | Disable ANSI color |
| `--offline` | Do not query npm or GitHub |
| `--spicetify <ask\|auto\|manual\|skip>` | How to handle a missing Spicetify CLI (`ask` default) |
| `--apply` | Run `spicetify apply` after bridge preparation (default: no apply; interactive asks separately; non-interactive needs `--yes --apply`) |
| `--allow-spicetify-upgrade` | Permit a combined Spicetify CLI update |
| `--remove-credentials` | Separately confirmed credential removal on uninstall |
| `--package-spec <spec>` | Override the npm spec used for global registration (pinning/tests) |
| `--non-interactive` | Never prompt; missing consent is an error |
| `-h/--help`, `-v/--version` | Side-effect-free; exit before any environment detection |

Post-publication usage (not yet live):

```powershell
npx opencode-spotify@0.6.0-beta.1 setup
npx opencode-spotify@0.6.0-beta.1 status --json
npx opencode-spotify@0.6.0-beta.1 update --dry-run
npx opencode-spotify@0.6.0-beta.1 doctor
```

Until publication, run from the checkout instead: `plugin/` scripts plus
`pwsh -NoProfile -File scripts/install-extension.ps1` (inspection only;
`-Install` / `-Repair` / `-Uninstall` are separate explicit operations).

## Onboarding tree

```
setup
├─ detect (read-only: Windows, Node, pwsh, OpenCode, Spotify, Spicetify,
│           bridge files/registration, port 18765, registry versions)
├─ plan (numbered steps: provision secret -> install bridge files ->
│        register extension -> spicetify apply only with --apply -> register plugin)
├─ confirm (interactive prompt, or --yes; --dry-run stops here)
├─ execute (backups first, user+SYSTEM-only ACLs, unrelated extensions kept)
└─ verify (status re-read; failures print rollback pointers)
update  → never downgrades; never replaces a local dev registration;
          Spicetify moves only with --allow-spicetify-upgrade
repair  → reuses the existing secret (no rotation)
repair + rotation → explicit RESET approval only
uninstall → removes owned bridge files/registration, keeps
            credentials+backups unless --remove-credentials is confirmed
doctor/status → read-only, safe to run any time (also with --offline)
```

## Spicetify installation policy

- Automatic installation uses **winget only**, pinned to package
  `Spicetify.Spicetify` from the `winget` source with an exact id match.
- The unsigned upstream `install.ps1` (mutable `main`-branch content with no
  published signature or checksum) is **never downloaded or executed
  automatically**. A checksum of a downloaded copy could only prove what was
  fetched, not that it is genuine, so it is not used as authentication.
- Without winget, setup stops the automatic path and prints the official
  manual instructions (`https://spicetify.app/docs/getting-started`), then
  offers a recheck. Cancellation leaves no changes; a failed attempt prints
  the manual path instead of retrying another source silently.

## Update policy

- **Pin the exact plugin version** in the global registration
  (`opencode-spotify@0.6.0-beta.1`, never a range or `latest` tag). The plugin and
  the installed bridge move as a pair: a floating spec can silently pair a new
  plugin with a stale bridge (or vice versa) and produce protocol mismatches.
- **No silent Spotify changes.** The updater never applies `spicetify apply`,
  rotates credentials, or upgrades Spicetify without a separate explicit
  approval. Downgrades are never automatic, even if the registry reports an
  older version.
- **Bridge reuse.** Reinstalls and repairs keep the existing installation
  secret and the pinned desktop Origin. Rotation is a deliberate,
  separately-confirmed operation followed by an OpenCode restart.

## Compatibility

- Bridge protocol **2 / handshake auto-1** (see [PROTOCOL.md](PROTOCOL.md)).
- Minimum **OpenCode 2.3.0**, minimum **Spicetify 2.0.0** (enforced by the
  CLI compatibility check; older versions report `too-old`, never silently).
  Native `opencode plugin add/remove/list/update` and the one-entry
  server+TUI package contract are verified live on OpenCode 2.4.1; 2.3.0
  support follows the official plugin-management and multi-part package
  documentation, and the installer refuses to mutate on anything older
  without an upgrade.
- V0.6.x keeps the V0.5.7 wire protocol and storage keys (`lyrics-v0.4`
  settings are retained).

## Backup and recovery

Before any mutation the installer snapshots the existing state with
timestamps: OpenCode config entries, Spicetify config, installed bridge
files, and credential files. Unrelated extension entries are preserved, and
duplicate bridge registrations are deduplicated rather than appended.

To roll back: restore the printed timestamped backups, then run
`spicetify apply` only when ready. `-Uninstall` removes the bridge but keeps
credentials and backups so a reinstall reuses the same secret.

## Local tarball verification

CI and the release workflow both run the same check the developer runs:

```powershell
Set-Location plugin
node scripts/verify-package.mjs   # or: npm run verify:package
```

It `npm pack`s to a temp dir (no publish), asserts the tarball contains
`package.json`, `README.md`, `LICENSE`, `src/index.ts`, `src/tui.tsx`,
`src/rpc.ts`, `bin/opencode-spotify.js`,
`spicetify/opencode-spotify-bridge.js`, and `scripts/install-extension.ps1`;
asserts `bin`/exports/version/license metadata resolve to real files; asserts
no `tests/`, `node_modules`, `.env`, `bridge.json`, credentials, captures, or
PII are packed; asserts the bridge still carries the placeholder secret;
installs the tarball into an isolated temp prefix with `--ignore-scripts`;
and runs the installed `bin/opencode-spotify.js --version` / `--help` from an
unrelated cwd. It addresses the tarball by local file path only, never the
registry name; it performs no global installs and no Spotify operations.
Temp dirs are removed even on failure. `plugin/tests/package-smoke.test.ts`
spawns this script cross-platform inside `npm test`.

## npm publish sequence (beta first, then stable)

npm requires a `latest` tag on every package and gives the first published
version `latest` even when `--tag beta` is used. The first release is therefore
a **prerelease** version (for example `0.6.0-beta.1`) published under `beta`;
`latest` also points at that prerelease until a stable version is published.
That is not a stable release, and it is the only way to test through the real
registry before stable promotion. Do not publish a stable `0.6.0` before the
physical QA gates pass.

1. Land the reviewed implementation on `main` or a `release/*` branch with CI
   green, including the packed-package verification.
2. Set `plugin/package.json` to the prerelease version (for example
   `0.6.0-beta.1`), commit, and tag/record the exact source revision if desired.
3. **First publication is manual and cannot use OIDC**: npm trusted publishing
   can only be configured for a package that already exists. Log in with
   `npm login` + 2FA, run `npm run build:cli`, `npm run verify:package`, then
   `npm pack`, and publish the verified tarball with
   `npm publish ./opencode-spotify-<version>.tgz --tag beta --access public`.
   Never use `--provenance` while this GitHub repository is private.
4. Verify the registry package, dist-tags, and integrity; install it with
   `npx opencode-spotify@beta setup` and perform the physical QA gates below.
5. Only after physical QA passes, build the stable `0.6.0` artifact (version
   metadata differs from the tested beta), rerun the full automated suite and
   package verification, then publish stable and move `latest` to it. The
   previously tested beta is not silently promoted; the stable artifact is a
   separately verified build.
6. Configure npm Trusted Publishing (repo `SUMANTHXT900/opencode-spotify`,
   workflow `release.yml`, environment `npm-release`, direct publish allowed)
   after the package exists. Subsequent releases may use the manual release
   workflow, which requires `NPM_PUBLISH_ENABLED=true`, `PUBLISH`, and
   `qa_passed=true` for `latest`.

## Trusted publishing setup (pending — workflow stays inactive until done)

- On the npm package: add this repository as a **trusted publisher**
  (GitHub Actions OIDC). This requires the package to exist already. No
  `NPM_TOKEN` exists and none is accepted by the workflow.
- In GitHub: create the `npm-release` environment with required reviewers
  where the account plan allows it (branch restriction to `main` recommended).
  GitHub may auto-create an unprotected environment if it does not exist, so
  the repository variable below is the load-bearing kill switch.
- Set the repository Actions variable `NPM_PUBLISH_ENABLED` to exactly `true`
  (Settings -> Variables -> Actions). The publish job is skipped without it.
- OIDC needs npm ≥ 11.5.1. The publish job sets up Node 24.12.0 via pinned
  `setup-node` and upgrades to pinned `npm@11.6.2` only if the runner's npm
  is older.
- Trusted-publisher configurations created after Sep 2026 default to
  stage-only publishing; explicitly allow direct `npm publish`. A new
  configuration must complete its first successful publish within two days.
- Until the package exists and the trusted publisher, environment, and kill
  switch are configured, `workflow_dispatch` validates and builds but cannot
  reach `npm publish`.

## Private-repository caveat

This repository is currently private. npm does not support provenance for
publishes originating from a private repository, so the release workflow omits
`--provenance` while private. Trusted publishing itself works from a private
repository, but the npm “repository” link will not be publicly viewable and no
public provenance badge appears. Do not make the repository public without
separate approval. Revisit this section when visibility changes.

## Physical QA gates

Automated checks are not installation evidence. Before any `latest` tag, a
developer must run the Windows Terminal checklist in
[VERIFICATION.md](VERIFICATION.md) ( Indic-script transitions, typing during
lyric changes, mouse controls without focus theft, dialogs, 120×40 / 100×40 /
short heights with Todo/MCP expansion, screenshot pair on residue) and record
the outcome there. No agent-performed live QA is claimed.

## Security

- Mutual HMAC authentication over loopback only (`127.0.0.1:18765`), exact
  Host/Origin pinning after cryptographic enrollment, bounded
  connection/message/rate limits — see [PROTOCOL.md](PROTOCOL.md) and
  [SECURITY_AUDIT.md](SECURITY_AUDIT.md).
- Credentials live in user configuration and the installed extension copy,
  never in the package, tarball, logs, or localStorage. The packed bridge
  always carries the placeholder; verification enforces it.
- The release path uses short-lived OIDC, SHA-pinned actions, read-only
  top-level permissions, and publishes the exact tarball CI verified —
  nothing is rebuilt between verification and publish.
