# V0.5 Architecture

`OpenCode TUI → authenticated OpenCode RPC → server-owned Spotify service →
authenticated loopback WebSocket → maintained Spicetify JS → Spotify Desktop`.

## Package and transport

- Package exports `.` / `./tui` / `./rpc` and the existing project registration
  are preserved. The package ships its maintained `spicetify/` extension. V0.5
  targets OpenTUI 0.9 for native image rendering.
- `owner.ts` reference-counts one receiver per server process (versioned symbol
  protects against incompatible hot-reload classes). Final disposal closes
  sockets and rejects requests. Separate processes mutually authenticate an
  observer connection to the existing owner, forward allowlisted requests and
  mirror snapshots. On owner exit they contend with jitter for the fixed port.
- `SpicetifyServer.ts` extends the existing `ws` receiver with mutual HMAC
  authentication, exact Origin checking, message/connection/request bounds,
  validated state and correlated request/reply timeouts. No automatic mutation
  retries. State is authoritative here, not in a TUI or shared server/TUI memory.
- State: epoch/revision, connection, metadata, playback and lightweight
  capability/queue/lyrics revisions. Lyrics, queue and artwork are memory-only
  side documents. Artwork cache capacity and in-flight fetch count are bounded.
  Playlist/library/search pages are fetched lazily and not broadcast.
- `rpc.ts` supplies Standard Schema typed methods, a validated command dispatcher,
  authoritative snapshots, separately hydrated lyrics/source candidates and an
  ephemeral updated event. Existing OpenCode authentication protects RPC. No RPC
  returns credentials.
- TUI snapshots are revision-gated. RPC source subscription is renewed on
  OpenCode's `server.connected`; startup hydration retries are bounded. A single
  adaptive local timer runs only while playing (250 ms for line/static lyrics,
  100 ms for genuine word timing), with monotonic interpolation and a bounded
  authoritative refresh when the anchor goes stale. There is no continuous
  state polling.

## Data and lifecycle

- Extension progress events are bounded to two-second snapshots; 2.5-second
  changed-local-state checks catch settings changed outside OpenCode while paused.
  Track changes reset lyrics/timeline. The original browsing/search normalization
  and private queue API are retained. Millisecond seek uses Platform.seekTo.
- `refresh_lyrics` is a backward-compatible, parameterless command. It requests a
  fresh current-track lyric payload and returns `{accepted:true}` only after the
  request is scheduled; the actual `lyrics`/`lyrics_unavailable` event is
  correlated by the current URI/request generation. Old extensions do not list
  the command, so the TUI falls back to RPC source hydration.
- `getLyricsSources` is an OpenCode RPC, not a bridge message. It combines the
  latest Spotify document with optional LRCLIB candidates for the current track.
  The server checks that the requested URI is still current before and after the
  async lookup and returns bounded candidates plus separate provider availability.
- `LyricsSourceManager` performs opt-in outbound HTTPS to LRCLIB only. It sends
  exact track metadata (title, artist, album, rounded duration) plus a user-provided
  project URL/email in the User-Agent. It does not send credentials, track URIs,
  lyrics or terminal data. Redirects are rejected, responses are size/time
  bounded, requests are sequential and `Retry-After` is honored. No other
  provider or private Spicy Lyrics backend is contacted.
- `credentials.ts` and the approved installer provision persistent 256-bit
  credentials under the user's configuration directory and in the installed
  extension only. Both sides contribute nonces (handshake `auto-1`).
  Origin is pinned only after successful cryptographic authentication.
  Read [PROTOCOL.md](PROTOCOL.md) for trust boundaries and handshake details.

## Distribution (V0.6.0)

- `plugin/src/cli/` is a plain-TypeScript installer compiled to
  `plugin/dist/cli/` (`npm run build:cli`) because Node refuses to type-strip
  files installed under `node_modules`. `bin/opencode-spotify.js` loads the
  compiled entry; `package.json` ships `src` (OpenCode server/TUI/RPC),
  `spicetify/`, `scripts/install-extension.ps1`, `bin/`, `dist/`, and
  `compat.json`.
- Global registration uses the native
  `opencode plugin add opencode-spotify@<exact-version>` command. One entry
  loads both package parts. The installer never edits project configuration and
  never adds a duplicate TUI-only entry to `cli.json`.
- `detect.ts` composes read-only inspectors for OpenCode, Spotify, Spicetify,
  bridge files/credentials and the loopback port. Missing executables are
  probed beyond PATH (LOCALAPPDATA, `spicetify -c`, Appx query).
- `plan.ts` presents every mutation, requires confirmation or `--yes`, and
  never mutates on `--dry-run`. `applyPlanIfRequested` keeps `spicetify apply`
  behind a separate consent, even when `--yes` approved the bridge files.
- Setup provides first-time and maintenance modes, including automatic
  Spicetify installation via winget (or the official script with explicit
  approval and a displayed SHA-256) and a manual path with rechecks. Updates
  pin the plugin version, never downgrade, and synchronize the owned bridge.
  Uninstall removes only the global registration and owned bridge; credentials
  require a separate confirmation.
- The bridge installer remains the single implementation. Its provisioning
  helper is compiled to `dist/scripts/provision.js`; the PowerShell script
  prefers that file and falls back to the TypeScript source only in a checkout.
- `scripts/verify-package.mjs` builds both compiled outputs, packs, audits the
  file list, installs the tarball into an isolated prefix, exercises the
  installed CLI, and provisions a bridge against a fake Spicetify config in a
  temporary APPDATA. It never touches the developer's Spotify or OpenCode.
- The release workflow is manual-only and disabled unless the repository
  variable `NPM_PUBLISH_ENABLED` is set. The first registry publication must be
  manual because npm trusted publishing requires an existing package. See
  [DISTRIBUTION.md](DISTRIBUTION.md).


- `MiniPlayer.tsx` claims the pinned `sidebar.footer` slot and renders the
  required order: connection header, Music/Lyrics/More navigation, framed
  artwork, title, artist, progress, fixed-width transport, compact volume, and a
  five-line lyric window. `ui/player-layout.ts` is a pure four-mode row planner
  (roomy/medium/tight/very-tight) that derives its budget from the terminal and
  hides decoration before controls; `resolvePlayerBudget` adds a two-row
  hysteresis so boundary oscillation cannot flap modes, and the terminal height
  settles 200 ms before the budget recomputes. `services/lyrics-window.ts`
  centers two previous/current/two upcoming lines, skips provider marker
  lines, wraps each semantic line to its own physical rows (`wrapLyricLines`)
  and distributes the fixed tier budget with the focus line whole and centered
  (`distributeLyricRows`); only an over-budget focus line falls back to a
  bounded scroll viewport. For phases that contain shaped lyrics, the
  preview uses a scene-owned blank underlay. Changing the underlay style
  forces a clear through the native diff. The previous layout stays in place
  until its lyric rectangle is cleared; a moved shaped rectangle is then
  primed before painting. The native `frame` event sequences these paints
  without terminal escapes or a renderer-wide invalidation. The footer claim means Todo expansion scrolls the
  content column
  without moving or hiding the player; exactly one footer claim exists and its
  remover runs on teardown. Controls are named, mouse-operable and report
  disabled reasons. The sidebar has no focus target or keymap layer. Buttons
  and slider presses suppress renderer autofocus for the handled pointer
  event; OpenCode retains ownership of editor, dialog and panel focus.
- `NowPlayingPanel.tsx` claims the `session.panel` slot with a compact header,
  centered artwork, immersive lyrics, fixed-width transport and pointer controls;
  `Music.tsx` falls back to the large lyric dialog when no panel is available.
- `LyricsView.tsx` is a clipped native scroll viewport of pre-wrapped physical
  rows. Grapheme segmentation, virama/pulli rejoin and `cellMeasure` (the max
  of the live renderer method, wcwidth and UTF-16 unit count) supply a width
  bound for the measured models, not a physical terminal guarantee.
  Shared `CellText` uses manual centering and native-width nodes for shaped
  single rows to limit right-edge overrun. The immersive view follows actual wrapped-row offsets,
  supports manual scrolling and Resume follow, suppresses stale async
  documents, and uses at most one bounded renderer timeline. Lyrics are
  monochrome; marker lines are not painted and active/follow targets derive
  from the same `selectLyricMoment` state.
- `Music.tsx` remains a hierarchy of SDK dialogs. Folder/page views retain stable
  URI/UID selections; newer generations invalidate pending results; search runs
  on explicit submission. Queue mutation requires a unique explicit UID.
- The TUI batches track and lyric-state transitions and checks the request
  generation and URI before accepting a lyric response. A manual refresh
  cannot carry over to a later occurrence of the same URI. The chosen source
  stays selected while its document is still offered; definitive withdrawal
  falls back to another candidate or clears the preview. Transient provider
  or transport errors can retain the last good document for the same track.
- `LyricsSettings.ts` edits validated provider/script/timing/display/motion/
  background/LRCLIB preferences under persistent storage key `lyrics-v0.4`;
  legacy accent/ambience/emphasis keys validate but are not painted. Per-track
  overrides are bounded.
- `layout.ts`, `player-layout.ts`, `transport.ts`, `primitives.tsx`, `colors.ts`,
  `playback-ui.ts` and `player-actions.ts` centralize grapheme-safe layout,
  responsive row planning, fixed transport geometry, measured text/controls,
  neutral tones, optimistic volume display and capability-aware actions.
  The bridge chooses the largest reported image candidate; the artwork service
  and `ArtworkView` then resolve references only to the fixed `https://i.scdn.co`
  image path, reject redirects, limit responses to 2 MiB and 2048 px, decode to
  at most 512 px, and retain a bounded memory-only cache. Artwork keeps its
  source aspect ratio and is never enlarged beyond the decoded texture. Once
  attached to the player, OpenTUI 0.9 `protocol="auto"` selects native
  Kitty/Sixel support when detected and falls back to colored blocks.

Artwork analysis still produces an accent and 4×3 ambient sample for diagnostics,
but V0.5.3 does not consume artwork-derived colors or draw a wash; true image
pixels are the only color. No private dynamic-color service is used. Spotify
private APIs remain capability-gated and fallible; function existence is not a
live compatibility test. Authenticated bridge ownership, the HMAC handshake,
origin pinning, command allowlist and OpenCode RPC authentication remain in
place. Seek previews update immediately and commit once on release; volume
previews update immediately, sends coalesced live updates and commits the final
value on release. See [UI_UX_DESIGN.md](UI_UX_DESIGN.md) for the detailed
interaction model and [FEATURE_MATRIX.md](FEATURE_MATRIX.md) for runtime
candidate status.
