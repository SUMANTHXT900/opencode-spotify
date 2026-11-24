# OpenCode Spotify

Native OpenCode sidebar player and music browser, powered exclusively by an
automatically authenticated Spicetify extension.

TypeScript + TSX + OpenCode RPC. No Python, no native media helper, no OAuth
app, no separate GUI.

Not affiliated with Spotify AB or the OpenCode project. Spotify and OpenCode
are trademarks of their respective owners. The package name is descriptive.

> **V0.6.0-beta.1 · Distribution implementation · Private · Windows**
>
> The player from V0.5.7 is unchanged. V0.6.0-beta.1 adds the global installer,
> onboarding, update/repair/diagnostics/uninstall commands, npm packaging,
> and release infrastructure.
>
> This project is **not published to npm yet**. All `npx` commands are the
> post-publication path. Automated verification is complete for the
> implementation; physical npm-registry installation QA and the release
> approval are still pending. See
> [docs/DISTRIBUTION.md](docs/DISTRIBUTION.md) and
> [docs/V0.6.0_RELEASE_NOTES.md](docs/V0.6.0_RELEASE_NOTES.md).

## What it does

- Pinned monochrome sidebar card: connection header, Music / Lyrics / More
  navigation, framed true-pixel album art, title, artist, progress,
  fixed-width transport, compact volume, and a synchronized lyric window.
- Dedicated session **Now Playing** panel with immersive lyrics, with dialog
  fallback where the host offers no panel slot.
- Queue, library, playlists, Liked Songs, search, lyrics, and playback
  dialogs with mouse-first controls.
- Lyrics window degrades gracefully (5 → 3 → 1 lines); artwork shrinks or
  hides before controls do on short terminals.
- Monochrome chrome throughout — artwork is the only color. No accent fills,
  karaoke colors, gradients, glow, album palettes, or seekbar shimmer.
- Seeks preview continuously and commit on release; volume drags update
  immediately with coalesced audio commits. Reduced Motion keeps slider
  feedback while removing lyric transitions.

---

## Requirements

| Component | Version |
|-----------|---------|
| OpenCode | ≥ 2.3.0 |
| OpenTUI | 0.9 |
| Node.js | CI uses 24.12.0; the package declares ≥ 22.18 |
| Bun | 1.3.14 in CI; required by the full test suite |
| PowerShell | `pwsh` is required by the Windows test fixtures |
| Spotify Desktop + Spicetify CLI | For live use only; not needed to run tests |

The V0.6.0 package uses bridge protocol **2 / auto-1**. Do not run two
differently named copies of the bridge at once.

---

## Develop from the checkout

From the repository root in PowerShell:

```powershell
Set-Location plugin
npm ci --ignore-scripts --no-audit
npm run typecheck
npm test
npm run build:cli   # compile the installer CLI before running bin/ or packaging
```

The full suite includes native renderer and bridge fixtures. It does not
connect to a real Spotify client or install an extension. The native fixtures
run under Bun because the locked OpenTUI native binding requires a newer Node
runtime than the one used by the Node test runner. The individual commands below
let you rerun those fixtures separately or reproduce the remaining CI checks.

## Optional: run against Spotify Desktop

From `plugin/`, the installer without flags only inspects the local setup.
Installation, repair, credential rotation, and removal are separate explicit
operations. Do not run these commands to validate CI.

```powershell
pwsh -NoProfile -File scripts/install-extension.ps1

# Install (asks before replacing files/registration,
# and separately before `spicetify apply`)
pwsh -NoProfile -File scripts/install-extension.ps1 -Install

# Reuse credentials after reinstall
pwsh -NoProfile -File scripts/install-extension.ps1 -Repair

# Explicit credential rotation (approve RESET, apply, restart OpenCode)
pwsh -NoProfile -File scripts/install-extension.ps1 -Repair -ResetCredentials

# Uninstall bridge only (keeps credentials/backups for reinstall)
pwsh -NoProfile -File scripts/install-extension.ps1 -Uninstall
```

The installer generates or reuses a per-installation secret, provisions both
ends, restricts credential permissions, backs up existing config/bridge,
preserves unrelated extension entries, and refuses duplicate bridge
registrations on port `18765`. Roll back by restoring the printed
timestamped backups, then run `spicetify apply` only when ready.

To load the local plugin, add its path to `plugins` in a local OpenCode
configuration. For example, a new `opencode.jsonc` at the repository root
can contain:

```jsonc
{ "plugins": ["./plugin"] }
```

If a config already exists, merge the entry instead of replacing it. Then
launch from the repository root:

```powershell
opencode --standalone
```

Open Spotify and OpenCode in either order. Multiple OpenCode processes share
one authenticated owner at `127.0.0.1:18765`; an unrelated listener produces
an error and is never terminated. The first authenticated desktop connection
pins its actual Origin; later connections must match exactly.

---

## Commands

| Command (from `plugin/`) | Description |
|---------------------------|-------------|
| `npm run typecheck` | TypeScript check |
| `npm test` | Unit suite |
| `npm run test:render` | Native OpenTUI renderer fixtures (Bun) |
| `npm run test:vt` | VT emission / width-model harness (Bun) |
| `npm run test:artwork` | Artwork pipeline checks (Bun) |
| `npm pack --dry-run` | Packaging check, no publish |
| `npm run verify:package` | Full tarball check: compiled CLI, pack file-list audit, isolated install, bin `--version`/`--help` |
| `npm run build:cli` | Compile the installer CLI to `dist/` (required before packaging) |
| `node --check spicetify/opencode-spotify-bridge.js` | Bridge syntax check |
| `npm audit --audit-level=high` | Report all advisories; fail on high or critical |
| `pwsh -NoProfile -File scripts/install-extension.ps1` | Installer inspection only |

---

## Distribution (V0.6.0-beta.1, unpublished)

V0.6.0-beta.1 keeps the V0.5.7 player and adds the npm distribution path. Status:
**private, not published** — build and verify from the checkout.

Windows prerequisites for install/verify/publish are the same table as
above (Node ≥ 22.18, OpenCode ≥ 2.3.0, Spicetify ≥ 2.0.0 for live use).
Full detail lives in [docs/DISTRIBUTION.md](docs/DISTRIBUTION.md); release
state in [docs/V0.6.0_RELEASE_NOTES.md](docs/V0.6.0_RELEASE_NOTES.md).

After publication, the global registration is one exact-version entry:

```jsonc
{ "plugins": ["opencode-spotify@0.6.0-beta.1"] }
```

One entry loads both server and TUI; never pair it with a duplicate local
path entry. Pin the exact version so plugin and bridge stay coordinated.
The installer performs this through the native
`opencode plugin add opencode-spotify@0.6.0-beta.1` command rather than editing
JSONC by hand.

CLI (available from the checkout via `npm run build:cli`, and after
publication via `npx`):

| Command | Effect |
|---------|--------|
| `setup` (default) | Install or maintain the installation |
| `status` | Read-only summary (`--json` supported) |
| `update` | Compatible updates only; never downgrades |
| `repair` | Fix owned files/registration; reuses the secret |
| `doctor` | Read-only diagnostics |
| `uninstall` | Remove registration and bridge; keeps credentials unless `--remove-credentials` |

```powershell
# Post-publication only — do not run yet:
npx opencode-spotify@0.6.0-beta.1 setup
npx opencode-spotify@0.6.0-beta.1 status --json
npx opencode-spotify@0.6.0-beta.1 update --dry-run
```

---

## Using the player

- **Sidebar** stays pinned in the footer, outside the scrollbox, so
  Context / MCP / Todo growth does not move it.
- **Mouse first.** The sidebar does not take editor focus and registers no
  Spotify key bindings. Click or drag either slider. Native OpenCode dialogs
  and text fields keep their usual keyboard behavior.
- **Music** opens queue, library, playlists, search, lyrics, and playback
  dialogs. **Lyrics** prefers the Now Playing panel, with dialog fallback.
- **More** exposes shuffle, repeat, and related playback actions.
- **Settings** groups playback, lyrics, appearance, and diagnostics.
  Appearance is monochrome-only (cover on/off and size, neutral background,
  reduced motion, instrumental dots). Legacy accent keys are accepted but no
  longer painted. Existing `lyrics-v0.4` preferences are retained.
- **Queue:** Current / Queued / Next up with refresh, play, add, and safe
  UID-specific removal. **Playlists:** folder navigation, paged tracks,
  play-entire-playlist, plus paged Liked Songs and search (explicit submit,
  no per-keystroke requests).

Unavailable actions are disabled or return an actionable error. Errors are
scoped per feature. Timed-out mutations are never retried.

---

## Lyrics sources

- Spotify's authenticated color-lyrics provider is the default (line
  text and timing).
- **LRCLIB** is opt-in and server-side. Requires a project URL or email as
  client contact, exact title/artist/album/duration match, no redirects,
  capped size/time, serialized requests, caching, and `Retry-After` support.
  Attribution is shown. No credentials or existing lyrics are sent.
- No transliteration is generated. “Romanized preferred” selects only a
  verified Latin or provider-flagged romanized candidate; other cases are
  labelled.
- Missing timestamps are never zero-filled. Word timings are validated when
  supplied but not painted as karaoke fills; live Spotify payloads are
  currently line-timed, so karaoke highlighting is not claimed.

---

## Limitations

- Automated checks only — **no agent-performed live QA is claimed**.
  Terminal font shaping, Kitty/Sixel output, audio responsiveness, and every
  Spotify CDN payload still require user-side checks.
- Private Spicetify Platform and GraphQL APIs can break after Spotify
  updates.
- Exact selected-track playlist context and selected-track library mutations
  remain subject to existing Spotify API limits.
- Artwork uses Spotify's `i.scdn.co` path with bounded sizes and no
  redirects; caches are memory-only. Spotify lyrics are memory-only and are
  not logged, exported, or persisted by this plugin. Optional LRCLIB use is
  disclosed in Settings; provider terms still apply.
- Mutual HMAC authentication plus loopback / Host / Origin restrictions.
  Credentials live in user configuration and the provisioned extension — not
  in the package or localStorage. Other equally privileged Spotify
  extensions or a compromised local account could access them. Authorized
  OpenCode clients can control playback. Do not expose OpenCode to untrusted
  clients.
- This package is not affiliated with Spotify AB or the OpenCode project.
  `reference/` contains unshipped research material, including an AGPL-3.0
  project; it is ignored and excluded from the package, and no AGPL source was
  copied into `src/` or `spicetify/` (MIT licensing applies only to the
  shipped code). Confirm this provenance before any future reuse.

---

## Docs

| Doc | Contents |
|-----|----------|
| [Verification](docs/VERIFICATION.md) | Automated results, renderer evidence, live-check history |
| [Architecture](docs/ARCHITECTURE.md) | Structure and key decisions |
| [UI / UX design](docs/UI_UX_DESIGN.md) | Layout, modes, monochrome rules |
| [Feature matrix](docs/FEATURE_MATRIX.md) | Capability coverage |
| [Protocol](docs/PROTOCOL.md) | Bridge auth and transport |
| [Roadmap](docs/ROADMAP.md) | Direction (V0.5.7 scope only; V0.6 work is tracked in the release notes) |
| [Distribution](docs/DISTRIBUTION.md) | V0.6.0 install, update, rollback, verification, and release process |
| [V0.6.0 release notes](docs/V0.6.0_RELEASE_NOTES.md) | Distribution milestone status: unpublished, verification pending |

---

## License

MIT — see `LICENSE` at the repository root (also shipped as `plugin/LICENSE`
so the packed tarball carries it). Spotify, Spicetify, OpenCode, and OpenTUI
retain their own terms. Optional lyric providers retain theirs.
