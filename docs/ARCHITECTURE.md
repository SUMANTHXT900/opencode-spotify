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
  100 ms for genuine word timing), with monotonic interpolation and a ten-second
  ceiling. There is no continuous state polling.

## Data and lifecycle

- Extension progress events are bounded to two-second snapshots; five-second
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

## UI

- `MiniPlayer.tsx` renders a responsive hierarchy driven by terminal height and
  width: connection/title always when space permits, then artist, progress/seek,
  transport, secondary playback actions, lyric preview and navigation. Controls
  are named, focusable, mouse-operable and report disabled reasons.
- `LyricsView.tsx` is a clipped native scroll viewport of pre-wrapped physical
  rows. Grapheme segmentation and `measureEditText(..., {widthMethod:"unicode"})`
  keep terminal cells aligned. It follows actual wrapped-row offsets, supports
  manual scrolling and Resume follow, suppresses stale async documents, and uses
  at most one bounded renderer timeline. Word spans appear only for validated
  genuine timings.
- `Music.tsx` remains a hierarchy of SDK dialogs. Folder/page views retain stable
  URI/UID selections; newer generations invalidate pending results; search runs
  on explicit submission. Queue mutation requires a unique explicit UID.
- `LyricsSettings.ts` edits validated provider/script/timing/display/motion/
  background/accent/LRCLIB preferences under persistent storage key
  `lyrics-v0.4`; per-track overrides are bounded.
- `layout.ts`, `primitives.tsx`, `colors.ts` and `player-actions.ts` centralize
  grapheme-safe layout, measured text/controls, contrast-guarded colors and
  capability-aware actions. The artwork service and `ArtworkView` resolve image
  references only to the fixed
  `https://i.scdn.co` image path; redirects are rejected. Responses are limited
  to 2 MiB and 2048 px, decoded/resized in memory, and retained in a bounded
  memory-only cache. Artwork keeps its source aspect ratio. Once attached to the
  player, OpenTUI 0.9
  `protocol="auto"` selects native Kitty/Sixel support when detected and falls
  back to colored blocks; requested output dimensions constrain image sizing.

Artwork analysis supplies a color accent and 4×3 ambient sample. Color/blur-
derived native-cell wash modes are being integrated; no private dynamic-color
service is used. Spotify private APIs remain capability-gated and fallible;
function existence is not a live compatibility test. Authenticated
bridge ownership, the HMAC handshake, origin pinning, command allowlist and
OpenCode RPC authentication remain in place. Release-only slider commits send
one seek or volume RPC on mouse release; local previews update immediately. See
[UI_UX_DESIGN.md](UI_UX_DESIGN.md) for the detailed interaction model and
[FEATURE_MATRIX.md](FEATURE_MATRIX.md) for runtime candidate status.
