# OpenCode Spotify V0.5

A native OpenCode **2.3.0** sidebar player and music browser, powered exclusively
by an automatically authenticated Spicetify extension. TypeScript + TSX + OpenCode
RPC; no Python, native media helper, OAuth application or separate GUI.

V0.5 uses OpenTUI 0.9 to draw a centered album cover, add draggable seek and
volume controls, and roll synchronized lyrics through a compact carousel. The
same view distinguishes instrumental passages, plain lyrics, unavailable lyrics
and source errors. Playback-clock motion, album colors and an optional soft
artwork wash are adjustable from the settings gear.

## Install the updated development extension

**This version requires the bundled protocol-2 / auto-1 extension.** Do not run
two differently named copies of the bridge. No installed extension or global
configuration was changed by this implementation.

From PowerShell:

```powershell
cd D:\hobby_projects\spotifyopencode\plugin
npm install
npm run typecheck
npm test
npm pack --dry-run
pwsh -NoProfile -File scripts/install-extension.ps1
```

The last command only inspects the Spicetify CLI, configuration, existing
registration and destination. To request an installation:

```powershell
pwsh -NoProfile -File scripts/install-extension.ps1 -Install
```

The script asks **before** replacing files/registration and asks separately
before `spicetify apply` (which may restart Spotify). It backs up the existing
configuration and bridge, preserves unrelated extension entries and refuses
detected differently named registered copies using port 18765. Review the printed
paths and remove duplicate bridge registrations manually if needed. Rollback:
restore the printed timestamped configuration and extension backups, then run
`spicetify apply` only when ready. Do not run Spicetify install scripts.

## Launch — no manual authentication

Open Spotify and OpenCode in either order. Multiple OpenCode processes share an
authenticated owner at port 18765; an unrelated listener produces an error and is
never terminated.

```cmd
cd /d D:\hobby_projects\spotifyopencode
opencode --standalone
```

Open a session and show its sidebar. Existing Todo/MCP sections remain additive.
The approved installer generates/reuses a per-installation secret, provisions both
ends and restricts credential permissions. Normal restarts do not change it. The
first authenticated desktop connection automatically pins its actual Origin;
subsequent connections must match exactly. No keys, dialogs or copy/paste steps.

Repair (reuses credentials): `pwsh -NoProfile -File scripts/install-extension.ps1 -Repair`.
Explicit rotation: add `-ResetCredentials`, approve `RESET`, apply, and restart all
OpenCode processes. Uninstall: `-Uninstall` (preserves credentials/backups for
reinstallation). Inspection, replacement and apply remain explicit opt-ins.

## Use the player

- **Sidebar** shows the cover, transport, heart, seek, volume and surrounding
  lyrics. Short layouts prioritize navigation and transport. **More** exposes
  related playback actions, including shuffle and repeat.
- **Focus controls** from the command palette. Tab and Shift+Tab select a
  control, Enter and Space activate it, and Escape returns focus to OpenCode.
  On a focused slider, Left/Right adjust and Home/End go to the limits.
  Click or drag either slider. A drag previews locally and sends one command
  on release. The default seek step is 10 seconds.
- **Music** opens the queue, library, playlists, search, lyrics and playback
  dialogs. **Lyrics** supports follow/manual scrolling, F to resume follow,
  S for settings and R to refresh the source.
- **Settings** groups playback, lyrics, appearance and diagnostics. Existing
  preferences are read from `lyrics-v0.4`. Reduced motion freezes decorative
  effects and keeps slider focus feedback visible.
- **Queue:** Current, Queued and Next up sections; refresh, play, add and safe
  UID-specific removal. Removal is absent for current/upcoming/ambiguous entries.
- **Playlists:** navigate folders with nested titles, browse paginated tracks or
  play an entire playlist. Liked Songs and track search support paging, play and
  queue actions. Search submits explicitly, so there are no requests on each
  keystroke.
- **Palette:** music, lyrics, settings, queue, search, play/pause, next, previous,
  shuffle, repeat, current-track like/unlike and refresh state. No global shortcut
  is overridden.

Unavailable actions are disabled or return an actionable error. Errors from one
feature do not disconnect the rest. API responses acknowledge API completion, not
independent observation of audio output; timed-out mutations are never retried.

## Lyrics sources and script behavior

Spotify's existing authenticated color-lyrics provider remains the default and
supplies line text/timing. **LRCLIB** is opt-in and server-side: it requires a
project URL or email as client contact, matches exact title/artist/album/duration,
disables redirects, caps response size/time, serializes requests, caches results
and honors `Retry-After`. Its attribution is shown. No credentials or existing
lyrics are sent. lrc.red was evaluated but is not implemented and appears disabled
with its identification/attribution requirement.

No transliteration is generated. “Romanized preferred” chooses only a verified
Latin or provider-flagged romanized candidate; unconfirmed Latin and original-script
fallbacks are labelled. Partial line timing is preserved; missing timestamps never
become zero. Genuine word timings are validated and rendered when supplied, but the
maintained Spotify endpoint (and LRCLIB line timing) currently supplies line-only
payloads, so karaoke highlighting is not claimed for live Spotify lyrics.

## Limitations and verification

See [verification](docs/VERIFICATION.md) for native renderer evidence and live
checks. OpenTUI selects Kitty or Sixel when detected and usable. Its colored
block renderer also draws decoded covers. RGB terminals can show album-derived
colors or a soft artwork wash. The progress highlight follows playback time.

Artwork requests use Spotify's `i.scdn.co` image path with bounded sizes and
no redirects. Caches stay in memory. Queue dialogs refresh after actions or
explicit refresh. Exact selected-track playlist context and selected-track
library mutations remain subject to the existing Spotify API limits.

The bridge uses mutual HMAC authentication plus loopback/Host/Origin restrictions.
Credentials live in the user's configuration and provisioned extension, not the
package or localStorage. Other Spotify extensions with equivalent privileges or a
compromised local account can access them. Authorized OpenCode clients can control
the player. See [security/protocol](docs/PROTOCOL.md). Do not expose OpenCode to
untrusted clients.

Spotify lyrics are kept in memory and are not logged/exported/persisted by this
plugin. Optional LRCLIB use is disclosed in Settings; provider terms and
redistribution rights still apply. Private Spicetify Platform and GraphQL APIs can
break after Spotify updates.

See [UI design](docs/UI_UX_DESIGN.md), [feature matrix](docs/FEATURE_MATRIX.md),
[architecture](docs/ARCHITECTURE.md), [verification](docs/VERIFICATION.md) and
[roadmap](docs/ROADMAP.md). npm name availability must be rechecked before release;
nothing has been published.
