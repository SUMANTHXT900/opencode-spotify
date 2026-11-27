# opencode-spotify

Spotify playback, synchronized lyrics and album artwork inside your OpenCode terminal.

An independent, MIT-licensed OpenCode plugin (Windows, live use). Not affiliated with
Spotify AB or the OpenCode project.

## Features

- Pinned sidebar card in the OpenCode footer: connection header, Music / Lyrics / More
  navigation, framed album art, track and artist, progress, transport, compact volume,
  and a synchronized lyric window (5 → 3 → 1 lines as space shrinks).
- Dedicated Now Playing panel with immersive lyrics, with dialog fallback where the
  host offers no panel slot.
- Queue, library, playlists, Liked Songs, search, lyrics, and playback dialogs with
  mouse-first controls. Seeks preview while dragging and commit on release.
- Monochrome chrome — album artwork is the only color.
- Guided installer CLI (`setup`, `status`, `update`, `repair`, `doctor`, `uninstall`)
  with per-installation secret provisioning, Spicetify lifecycle handling, and
  self-verification.

## Requirements

| Component | Version |
|-----------|---------|
| Windows | Required (installer and live use) |
| Node.js | ≥ 22.18.0 |
| Bun | ≥ 1.3.14 (OpenCode-hosted TUI) |
| PowerShell | `pwsh` 7 — required for bridge provisioning and the official installer |
| OpenCode | ≥ 2.3.0 (compatible with 2.4.2) |
| Spicetify CLI | ≥ 2.0.0 (live use only) |
| Spotify Desktop | Live use only |

Spicetify installs through the pinned, hash-verified official installer on x64
(on ARM64, or when no matching release asset exists, the installer prints manual
guidance instead). Updates migrate every existing copy — official script, Winget,
Scoop, or Chocolatey — through that same official installer. The Spicetify
Marketplace is installed by default (skip with `--no-marketplace`). No OpenTUI, Solid,
React, or Ink packages need manual installing — the package ships the exact
runtime dependencies it needs; the host does not inject them.

## Install

```powershell
npx opencode-spotify@0.6.0-beta.3 setup
```

`setup` performs the global registration itself as one of its plan steps, so no
separate `opencode plugin add` is needed. Re-running `setup` on an
already-registered install opens the maintenance menu (Update to latest when
achievable, Repair installation, Uninstall, Exit) — choose **Repair** to
install the bridge. See [getting-started](#getting-started) and the
[user guide](https://github.com/SUMANTHXT900/opencode-spotify/blob/main/docs/USER_GUIDE.md).

Then open Spotify and OpenCode in either order.

## Getting started

1. Install Spotify Desktop and sign in.
2. Run `setup` (above). It inspects your machine, shows a plan, asks approval, then
   provisions the bridge, registers the plugin globally, and verifies its work.
   Missing Spicetify is handled for you (automatic on x64, guided manual path on
   ARM64 or on request).
3. Launch `opencode --standalone`. The player renders in the pinned sidebar footer.
4. Click **Music** for queue, library, playlists, search, lyrics, and playback.
   Click **Lyrics** for the Now Playing panel. The gear opens Settings.

## Commands

| Command | Effect |
|---------|--------|
| `setup` (default; `install` aliases it) | Install or maintain the installation |
| `status` | Read-only installation summary (`--json` supported) |
| `update` | Compatible updates only; never downgrades |
| `repair` | Fix owned files/registration; reuses the secret |
| `doctor` | Read-only diagnostics (`--json` supported) |
| `uninstall` | Remove the global registration and owned bridge files |

```powershell
npx opencode-spotify@0.6.0-beta.3 setup
npx opencode-spotify@0.6.0-beta.3 status --json
npx opencode-spotify@0.6.0-beta.3 update --dry-run
npx opencode-spotify@0.6.0-beta.3 doctor
```

`--json` is accepted by `status` and `doctor` only; other commands reject it with
exit 2. `setup` is also the default command (running the CLI with no command runs
setup). Useful flags: `--dry-run`, `--yes`, `--offline`, `--spicetify
<ask|auto|manual|skip>`, `--apply`, `--allow-spicetify-upgrade`, `--plain`,
`--non-interactive`, `--package-spec`.

## Uninstall

```powershell
npx opencode-spotify@0.6.0-beta.3 uninstall
```

`uninstall` defaults to **plugin-only**: it removes the global registration and the
owned bridge while keeping credentials and backups so a reinstall reuses the same
secret. **Complete permanent removal** additionally deletes credentials and
owner-safe Spicetify state; interactively it requires typing `UNINSTALL`, and
non-interactively it requires `--complete` with `--non-interactive` and `--yes`.
Spotify is restored from a validated backup before anything Spicetify-owned is
deleted; unknown ownership is disclosed, never deleted.

## Troubleshooting

- `status` and `doctor` are read-only — run them any time, including with `--offline`.
- Bridge reports "Config error" with no Spicetify install: expected until `setup`
  provisions the bridge.
- `Duplicate plugin ID`: keep exactly one registration — remove the project-local
  entry (or `-`-disable it) and restart OpenCode, including any background process
  (or run `opencode service restart`).
- After a Spotify update, private Spicetify/Spotify APIs can break: run `doctor`,
  then `repair`.
- More fixes in the [user guide](https://github.com/SUMANTHXT900/opencode-spotify/blob/main/docs/USER_GUIDE.md).

## Privacy and compatibility

- Mutual HMAC authentication over loopback only (`127.0.0.1:18765`) with exact
  Host/Origin checks. Credentials live in your user configuration and the installed
  extension — never in the package, logs, or localStorage. Spotify lyrics are
  memory-only. Optional LRCLIB use is disclosed in Settings; provider terms apply.
- Bridge wire protocol **2 / auto-1**. Minimum OpenCode 2.3.0, minimum Spicetify
  2.0.0, win32-only live use. Do not run two differently named copies of the bridge
  at once.

## Repository and license

- Repository: https://github.com/SUMANTHXT900/opencode-spotify
- Issues: https://github.com/SUMANTHXT900/opencode-spotify/issues
- Docs: https://github.com/SUMANTHXT900/opencode-spotify/tree/main/docs
- License: MIT. Spotify, Spicetify, OpenCode, and OpenTUI retain their own
  terms; optional lyric providers retain theirs. Not affiliated with Spotify AB
  or the OpenCode project.
