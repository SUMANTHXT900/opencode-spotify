# User guide — opencode-spotify

Spotify playback, synchronized lyrics, and album artwork inside the OpenCode terminal
(Windows, live use).

## Contents

- [Platforms and prerequisites](#platforms-and-prerequisites)
- [Install walkthrough](#install-walkthrough)
- [Existing Spicetify handling](#existing-spicetify-handling)
- [Startup](#startup)
- [Player](#player)
- [Lyrics, artwork, queue, and playlists](#lyrics-artwork-queue-and-playlists)
- [Channels](#channels)
- [Status and doctor](#status-and-doctor)
- [Repair](#repair)
- [Uninstall](#uninstall)
- [Troubleshooting](#troubleshooting)
- [Limitations](#limitations)
- [Optional lyrics providers and privacy](#optional-lyrics-providers-and-privacy)

## Platforms and prerequisites

| Component | Requirement |
|-----------|-------------|
| Windows | Required (installer and live use); other OSes are unsupported |
| Node.js | ≥ 22.18.0 (the installer CLI) |
| Bun | ≥ 1.3.14 (the OpenCode-hosted TUI) |
| PowerShell | `pwsh` 7 for the official-installer path and bridge provisioning |
| OpenCode | ≥ 2.3.0 (compatible with 2.4.2) |
| Spotify Desktop | Live use only |
| Spicetify CLI | ≥ 2.0.0, live use only (the installer can set it up for you) |

`@opentui/core@0.9.0` declares `node >= 26.4.0` as install metadata; `npm ci` prints
`EBADENGINE` on Node 22/24 and still succeeds with `engine-strict` off. The installer
runs on Node and the TUI runs under the OpenCode host's Bun. Nothing else needs
manual installing — no OpenTUI, Solid, React, or Ink setup.

## Install walkthrough

### 1a. Registry path

Run `setup` — it performs the global registration itself as one of its plan
steps, so a single command installs:

```powershell
npx opencode-spotify@0.6.0-beta.3 setup
```

Pin the exact version so the plugin and the installed bridge stay coordinated. Never
pair the global entry with a duplicate local path entry, and never float the version.
One entry loads both halves — the server owner and the TUI.

### 1b. Local-tarball path (release QA / offline)

To verify a release tarball byte-for-byte, install it by local path into an
isolated prefix, then register the absolute installed path:

```powershell
cmd /d /s /c "call npm install --global --prefix `"<isolated-prefix>`" `"<path>\opencode-spotify-0.6.0-beta.3.tgz`""
cmd /d /s /c "call opencode plugin add `"<isolated-prefix>\node_modules\opencode-spotify`""
```

Calling the `.cmd` shims through `cmd /d /s /c "call …"` avoids PowerShell
execution-policy problems with `npm.ps1`.

### 2. Run setup

`setup` is the default command: it detects (read-only), shows a numbered plan with
real step descriptions, asks approval, then executes with backups first and verifies
afterwards. `--dry-run` shows the plan and changes nothing. From the registry:

```powershell
npx opencode-spotify@0.6.0-beta.3 setup --dry-run
npx opencode-spotify@0.6.0-beta.3 setup
```

From a local-tarball install, run the installed tarball's CLI directly (same commands,
local path instead of `npx`):

```powershell
node "<isolated-prefix>\node_modules\opencode-spotify\bin\opencode-spotify.js" setup --dry-run
node "<isolated-prefix>\node_modules\opencode-spotify\bin\opencode-spotify.js" setup
```

The plan covers global registration, bridge files/credentials, port `18765`,
Spicetify handling (below), the Marketplace install (below), and `spicetify
apply` — which stays a separate consent even after `--yes` approves the bridge
files. Re-running `setup` on an existing installation opens the maintenance
menu — Update to latest (only when an update is genuinely achievable), Repair
installation, Uninstall, Exit — plus a switch entry when the registration is a
local development path. `--non-interactive` never prompts;
it prints the explicit `update` / `repair` / `uninstall` commands instead.

On an interactive TTY the installer uses an inline Ink dashboard; `--plain` /
`--no-ink`, non-TTY output, `CI`, `TERM=dumb`, or
`OPENCODE_SPOTIFY_UI=plain` select deterministic plain output (`status` and
`doctor` additionally accept `--json` for a single parseable document). The first Ctrl+C
requests cooperative cancellation (protected steps finish, then the run stops with
exit 130); a second forces.

### 3. Spicetify choices during setup

- `--spicetify=ask` (default) asks how to handle a missing Spicetify CLI.
- `--spicetify=auto` proceeds automatically (fresh install uses the pinned official
  installer script with the release target resolved from the latest stable GitHub
  release at run time; every existing copy — script, Winget, Scoop, or
  Chocolatey — is migrated through that same official installer on update, so no
  second copy is ever installed and package managers are never mixed).
- `--spicetify=manual` prints the pinned installer URL/hash, the resolved target,
  and the official docs; it downloads and executes nothing.
- `--spicetify=skip` leaves Spicetify alone.
- The Spicetify Marketplace is installed by default after the official flow
  (deterministic installer, latest Marketplace release); pass
  `--no-marketplace` to skip it.

Apply behavior: setup prepares the bridge files first and asks separately before
running `spicetify apply`. In non-interactive runs, `apply` additionally needs
`--yes --apply`.

## Existing Spicetify handling

A fresh install never overlays another owner's copy. On update, every existing
copy is migrated through the pinned official installer — package managers are
never mixed and no second copy is installed:

| Owner | Upgrade | Removal |
|-------|---------|---------|
| Official script (`%LOCALAPPDATA%\spicetify`) | Pinned official installer | Validated local directory plus exact PATH entries |
| winget | Migrated to the official installer | `winget uninstall --id Spicetify.Spicetify -e --accept-source-agreements --disable-interactivity` |
| scoop / Chocolatey | Migrated to the official installer | That manager (`spicetify-cli`) |
| Unknown | Refused with manual guidance | Disclosed, never deleted |

Fresh installs refuse to overlay any existing copy. The Marketplace region is
removed from the official script by a reviewed patch (no Marketplace prompt,
URL, or download there — see [MAINTAINERS.md](MAINTAINERS.md)); the adapter
then installs the Marketplace deterministically by default (`--no-marketplace`
opts out).

## Startup

Open Spotify and OpenCode in either order, then:

```powershell
opencode --standalone
```

The player renders in the pinned sidebar footer. Multiple OpenCode processes share one
authenticated owner at `127.0.0.1:18765`; an unrelated listener produces an error and
is never terminated. The first authenticated desktop connection pins its actual
Origin; later connections must match exactly.

The bridge reports **"Config error"** when there is no Spicetify install or
credential yet. That is a concise connection-state label, not a crash — run `setup`
first. Project-local config is never modified; if a project-local `opencode-spotify`
entry shadows the global install, setup warns and leaves it alone. Keep exactly one
registration: remove (or `-`-disable) the project-local entry and restart OpenCode,
including any background `serve` process (or run `opencode service restart`),
to clear a `Duplicate plugin ID` state.

## Player

- **Sidebar** stays pinned in the footer, outside the scrollbox, so Context / MCP /
  Todo growth does not move it.
- **Mouse first.** The sidebar does not take editor focus and registers no Spotify
  key bindings. Click or drag either slider. Native OpenCode dialogs and text fields
  keep their usual keyboard behavior.
- **Music** opens queue, library, playlists, search, lyrics, and playback dialogs.
  **Lyrics** prefers the Now Playing panel, with dialog fallback. **More** exposes
  shuffle, repeat, and related playback actions. The gear opens **Settings**
  (playback, lyrics, appearance, diagnostics).
- Appearance is monochrome-only: cover on/off and size, neutral background, reduced
  motion, instrumental dots. Legacy accent keys are accepted but no longer painted.
  Existing `lyrics-v0.4` preferences are retained.
- Unavailable actions are disabled or return an actionable error. Errors are scoped
  per feature. Timed-out mutations are never retried.

## Lyrics, artwork, queue, and playlists

- **Lyrics window:** two previous lines, the current line, and two upcoming lines,
  degrading 5 → 3 → 1 rows on short terminals. Artwork shrinks or hides before
  controls do. Missing timestamps are never zero-filled; word timings are validated
  when supplied but the UI does not paint karaoke fills (live Spotify payloads are
  currently line-timed).
- **Spotify lyrics** (default): the extension asks Spotify's authenticated
  color-lyrics endpoint for the current track's line text and timing.
- **LRCLIB** (opt-in, server-side): enable it in Settings and supply a project URL
  or email as client contact. Requires exact title/artist/album/duration match, no
  redirects, capped size/time, serialized requests, caching, and `Retry-After`
  support. Attribution is shown. No credentials or existing lyrics are sent.
- **Script honesty:** "Romanized preferred" selects only a verified Latin or
  provider-flagged romanized candidate; other cases are labelled, never
  transliterated. "Original" prefers original-script candidates with fallback notes.
- **Artwork:** the largest reported candidate, decoded to at most 512 px, memory-only
  cache, fixed `https://i.scdn.co` image path with redirects rejected. It is the only
  color in the UI. OpenTUI `protocol="auto"` selects Kitty/Sixel when detected and
  falls back to colored blocks.
- **Queue:** current / queued / next up with refresh, play, add, and safe
  UID-specific removal (URI + UID must uniquely match; no clear fallback).
- **Playlists:** folder navigation, paged tracks, play-entire-playlist, plus paged
  Liked Songs and explicit-submit search (no per-keystroke requests). Exact
  selected-track playlist context and selected-track library mutations remain subject
  to Spotify API limits.

## Channels

The installer distinguishes two labels when checking for updates:

- **stable** — ordinary releases, safe for everyone.
- **beta** — prereleases such as `0.6.0-beta.3`, for testers.

Releases publish by tag: `vX.Y.Z` ships to the `latest` dist-tag, `vX.Y.Z-beta.N`
to the `beta` dist-tag, each with its own CI verification and GitHub Release.

A prerelease is never labelled stable, and a stable install never advertises or
downgrades to an older tag. A beta install offers a newer beta or stable, whichever
is compatible. The updater never replaces a local development registration on its own.

## Status and doctor

Both are read-only and safe to run any time, including with `--offline`:

```powershell
npx opencode-spotify@0.6.0-beta.3 status
npx opencode-spotify@0.6.0-beta.3 status --json
npx opencode-spotify@0.6.0-beta.3 doctor
npx opencode-spotify@0.6.0-beta.3 doctor --json
```

`--json` emits exactly one valid JSON document with no UI text. `--json` is rejected
with exit 2 for `setup`, `update`, `repair`, and `uninstall`, which have no single
JSON document.

## Repair

```powershell
npx opencode-spotify@0.6.0-beta.3 repair --dry-run
npx opencode-spotify@0.6.0-beta.3 repair
```

Repair fixes missing or damaged owned files and registration and reuses the existing
secret — no rotation. Explicit credential rotation is not a CLI flag: run the
packed `install-extension.ps1` provisioner directly with `-ResetCredentials`
plus `-Install` or `-Repair` (typed confirmation), then restart OpenCode
afterwards.

## Uninstall

```powershell
npx opencode-spotify@0.6.0-beta.3 uninstall --dry-run
npx opencode-spotify@0.6.0-beta.3 uninstall
```

- **Plugin-only (default):** removes the global registration and the owned bridge.
  Credentials and backups are kept so a reinstall reuses the same secret. Dry-run
  prompts for nothing and claims nothing.
- **Complete permanent removal:** additionally deletes credentials and owner-safe
  Spicetify state. Interactively it requires typing `UNINSTALL` (empty input, Back,
  and Escape cancel without mutating); non-interactively it requires `--complete`
  (or `OPENCODE_SPOTIFY_UNINSTALL=complete`) plus `--non-interactive` and `--yes`.
  Spotify is restored from a validated backup **before** anything Spicetify-owned is
  deleted; a failed or unverifiable restore deletes nothing. Unknown owners are
  disclosed, never deleted. No new secret-bearing backup is created. A run that
  leaves any residual exits 1 and names it.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Bridge "Config error" | Run `setup`; expected with no Spicetify install/credential |
| `Duplicate plugin ID` | Keep one registration; remove or `-`-disable the project-local entry, restart OpenCode incl. background processes (or `opencode service restart`) |
| Lyrics unavailable for a track | Track has no synced payload; try Refresh in Settings, or enable LRCLIB |
| Playback action disabled | Capability-gated by the Spotify client; the reason is shown |
| Something broke after a Spotify update | Private Spicetify/Spotify APIs can break; run `doctor`, then `repair` |
| Execution-policy block (`E_POLICY_BLOCKED`, exit 92) | Follow the printed manual instructions; no bypass is attempted |
| Second installer exits 1 | Another run holds the installer lock; use `status`/`doctor` meanwhile |
| Non-interactive complete removal exits 2 | Pass `--complete` plus `--non-interactive` and `--yes`; nothing changed |
| Spotify download/metadata mismatch | Terminal font shaping, CDN payloads, and audio need user-side checks |

## Limitations

- Automated checks only — no live QA is claimed. Terminal font shaping, Kitty/Sixel
  output, audio responsiveness, and every Spotify CDN payload still require
  user-side checks.
- Private Spicetify Platform and GraphQL APIs can break after Spotify updates.
- Exact selected-track playlist context and selected-track library mutations remain
  subject to existing Spotify API limits.
- Artwork uses Spotify's `i.scdn.co` path with bounded sizes and no redirects;
  caches are memory-only. Spotify lyrics are memory-only and are not logged,
  exported, or persisted.
- Other equally privileged Spotify extensions or a compromised local account could
  access credentials. Authorized OpenCode clients can control playback. Do not
  expose OpenCode to untrusted clients.

## Optional lyrics providers and privacy

- Lyrics providers: Spotify (default, authenticated) and LRCLIB (opt-in). lrc.red
  was evaluated and is shown disabled in Settings with the reason — it is not
  implemented. No private Spicy Lyrics backend, hosted transliteration, or
  dynamic-color service is contacted.
- What LRCLIB receives: exact track title, artist, album, rounded duration, and your
  project URL/email in the User-Agent. It never receives the bridge secret, track
  URIs, terminal state, credentials, or existing lyrics.
- Bridge credentials live in your user configuration and the installed extension
  only (Windows ACLs restrict them to you and SYSTEM; POSIX uses 0700/0600), never
  in the package or tarball. The packed bridge always carries a placeholder secret.
- The bundled secret scanner covers bridge 64-hex values plus a path denylist only —
  it is not a general PII/secret scan.
