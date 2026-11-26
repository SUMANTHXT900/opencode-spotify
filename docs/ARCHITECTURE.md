# Architecture — opencode-spotify

`OpenCode TUI → authenticated OpenCode RPC → server-owned Spotify service →
authenticated loopback WebSocket → maintained Spicetify JS → Spotify Desktop`.

Package exports `.` (server), `./tui` (terminal UI), and `./rpc` (typed RPC
contract). The package ships `src/`, the maintained `spicetify/` bridge,
`scripts/install-extension.ps1`, `bin/` (launcher), compiled `dist/cli/` +
`dist/scripts/provision.js`, and `compat.json`. Node refuses to type-strip
TypeScript under `node_modules`, so the installer CLI is compiled to plain
JavaScript (`npm run build:cli`); OpenCode loads the plugin parts from `src/`
through its own runtime.

## Contents

- [Server and ownership](#server-and-ownership)
- [Bridge wire protocol 2 / auto-1](#bridge-wire-protocol-2--auto-1)
- [OpenCode RPC additions](#opencode-rpc-additions)
- [State, sync, and limits](#state-sync-and-limits)
- [TUI and layout](#tui-and-layout)
- [Unicode measurement and clipping](#unicode-measurement-and-clipping)
- [Renderer evolution (history)](#renderer-evolution-history)
- [Artwork pipeline](#artwork-pipeline)
- [Lyrics providers and script honesty](#lyrics-providers-and-script-honesty)
- [Pointer controls and focus](#pointer-controls-and-focus)
- [Security boundaries](#security-boundaries)
- [Residual risks](#residual-risks)

## Server and ownership

- `owner.ts` reference-counts one receiver per server process (a versioned symbol
  protects against incompatible hot-reload classes). Final disposal closes sockets
  and rejects requests. Separate processes mutually authenticate an observer
  connection to the existing owner, forward allowlisted requests, and mirror
  snapshots. On owner exit they contend with jitter for the fixed port.
- `SpicetifyServer.ts` extends the `ws` receiver with mutual HMAC authentication,
  exact Origin checking, message/connection/request bounds, validated state, and
  correlated request/reply timeouts. No automatic mutation retries. State is
  authoritative here, not in a TUI or shared server/TUI memory.
- State: epoch/revision, connection, metadata, playback, and lightweight
  capability/queue/lyrics revisions. Lyrics, queue, and artwork are memory-only
  side documents. Artwork cache capacity and in-flight fetch count are bounded.
  Playlist/library/search pages are fetched lazily and not broadcast.
- `rpc.ts` supplies Standard Schema typed methods, a validated command dispatcher,
  authoritative snapshots, separately hydrated lyrics/source candidates, and an
  ephemeral updated event. Existing OpenCode authentication protects RPC. No RPC
  returns credentials.
- TUI snapshots are revision-gated. RPC source subscription is renewed on OpenCode's
  `server.connected`; startup hydration retries are bounded. A single adaptive local
  timer runs only while playing (250 ms for line/static lyrics, 100 ms for genuine
  word timing), with monotonic interpolation and a bounded authoritative refresh when
  the anchor goes stale. There is no continuous state polling.
- Extension progress events are bounded to two-second snapshots; 2.5-second
  changed-local-state checks catch settings changed outside OpenCode while paused.
  Track changes reset lyrics/timeline. The original browsing/search normalization
  and private queue API are retained. Millisecond seek uses Platform.seekTo.
- `refresh_lyrics` is a backward-compatible, parameterless command. It requests a
  fresh current-track lyric payload and returns `{accepted:true}` only after the
  request is scheduled; the actual `lyrics`/`lyrics_unavailable` event is correlated
  by the current URI/request generation. Old extensions do not list the command, so
  the TUI falls back to RPC source hydration.
- `credentials.ts` and the approved installer provision persistent 256-bit
  credentials under the user's configuration directory and in the installed
  extension only. Both sides contribute nonces (handshake `auto-1`). Origin is
  pinned only after successful cryptographic authentication.
- The bridge carries an **unprovisioned placeholder secret**
  (`__OPENCODE_SPOTIFY_SECRET__`). The per-installation secret is generated at
  install time and substituted into the *installed copy only* — never into the
  package. `scripts/verify-package.mjs` fails the build if a real secret ever
  lands in the tarball.

## Bridge wire protocol 2 / auto-1

Transport: WebSocket at `ws://127.0.0.1:18765`. Maximum message size 4 MiB, no
compression. Bind address is always IPv4 `127.0.0.1`, never all interfaces. Upgrade
requires peer `127.0.0.1`, exact Host `127.0.0.1:18765`, and path `/` (no query).
Tests alone inject ephemeral ports. Hostnames, alternate ports, forwarded headers,
and DNS aliases are not trusted.

### Automatic provisioning and Origin enrollment

The explicitly approved installer generates 32 secure random bytes once. The
64-character hex string is stored in `%APPDATA%\opencode-spotify\bridge.json`
(fallback `%USERPROFILE%\AppData\Roaming`) on Windows. It is substituted into the
**installed copy** of the extension. The package contains only a placeholder. Normal
launches only read credentials; repair/update reuses them. Malformed existing config
fails closed.

Windows installer ACLs grant only the current user and SYSTEM access to the
credential directory/files and installed extension/backups. Administrators,
same-user processes, and equivalent Spotify extensions remain trusted. Backups
contain secrets and must remain private. No credential-returning RPC, prompt,
localStorage handler, or menu remains.

**No Spotify Origin is assumed.** A newly provisioned configuration has an empty
Origin list. During this one-time bootstrap only, loopback/Host-validated clients
with a syntactically exact HTTPS Origin, literal `null`, or no Origin may enter the
handshake. They cannot send commands or state. Only after a valid extension-role
HMAC proof does the receiver atomically persist that connection's exact observed
Origin, **before enabling application messages**. Failed proofs cannot pin an
Origin. This is authenticated enrollment, not unauthenticated trust-on-first-use.

After enrollment, extension upgrades with any different Origin are rejected before
the handshake. Missing Origin and literal `null` are distinct and are rejected
unless that exact form was cryptographically observed. Origin is defense-in-depth,
not process identity. An Origin change requires explicit repair/reset, never
automatic allowlist widening.

### Mutual authentication

1. Client sends `{type:"hello",protocol:2,handshake:"auto-1",role,nonce:clientNonce}`.
   Both parties generate independent 32-byte nonces using secure OS/Web Crypto RNG.
2. Server returns `{type:"challenge",protocol:2,handshake:"auto-1",nonce:serverNonce,serverProof}`.
3. Proof is hex HMAC-SHA256 with the secret's **UTF-8 hex string** as key over
   `auto-1:server:${role}:${clientNonce}:${serverNonce}`.
4. Client verifies through Web Crypto (Node peers use `timingSafeEqual`), then sends
   `{type:"auth",protocol:2,proof}` over the same transcript with `client` replacing
   `server`. The receiver verifies using `timingSafeEqual`.
5. Receiver sends `{type:"authenticated",protocol:2}`; application messages start.

Each handshake is single-use, role-separated, and has a five-second deadline. Fresh
client nonces also prevent replaying an old receiver proof to the extension. Old
protocol-2 manual-auth extensions are intentionally incompatible with auto-1. No
secret appears in URLs, normal messages, logs, or error strings. This is not
protection against a compromised OS, Spotify renderer, trusted extension,
authorized OpenCode client, or active local relay with access to both endpoints.
OpenCode RPC uses OpenCode's existing authentication; there is no separate HTTP
Spotify control endpoint.

### Shared port ownership and lifecycle

On `EADDRINUSE`, the new OpenCode process connects with an internal observer role
and the `X-OpenCode-Spotify: auto-1` header, no Origin. This exception only permits
a handshake; role-bound mutual HMAC authentication is still mandatory. Browser
WebSocket callers cannot set that header. A forged header without the key grants no
access. Observers mirror validated owner snapshots and forward only allowlisted
RPCs, with lyrics/queue documents sent only when their revisions change. Wrong-key,
incompatible, and unrelated listeners produce `Local port unavailable`; no process
is ever killed. There is one Spotify extension connection per owner and at most
eight observer processes. Same-process references share one receiver.

The owner sends WebSocket ping every 15 seconds and terminates missed-pong peers on
the next tick. Observers also enforce 45 seconds without traffic/ping. After owner
loss, observers back off with jitter and contend for the fixed port; losers
authenticate to the winner. Extension retries use exponential backoff (nominal 1–60
seconds with ±20% jitter; maximum 72 seconds). Successful authentication resets
backoff; proof mismatch starts at the long delay and emits only a generic repair
diagnostic. Disposal clears timers/listeners, closes sockets, and rejects pending
requests. Mutations are never replayed.

### Requests

`{type:"request",id,command,params}` → `{type:"response",id,ok,result}` or
`{type:"response",id,ok:false,error:{code,message}}`.

- Reads: `get_capabilities`, `get_playback`, `get_queue`, `get_playlists`,
  `get_playlist_tracks {uri,offset,limit}`, `get_library {offset,limit}`,
  `search {query,offset,limit}`, `ping`.
- Lyrics: `refresh_lyrics {}` (no parameters; current track only). It schedules a
  fresh provider request and responds `{accepted:true}`; the resulting
  `lyrics`/`lyrics_unavailable` event arrives separately and stale generations are
  suppressed. The command is absent from older extensions' capability lists.
- Playback: `play`, `pause`, `toggle_play`, `next`, `previous`,
  `seek {positionMs}`, `set_shuffle {value:boolean}`,
  `set_repeat {value:0|1|2}`, `set_volume {value:0..1}`, `set_mute {value:boolean}`.
- Track actions: `play_track {uri}`, `play_context {uri}`,
  `add_to_queue {uri}`, `remove_from_queue {uri,uid}`,
  `set_liked {uri,value:boolean}` (current URI only).
- Pagination: offset 0–1,000,000; limit 1–200; query 1–200 characters.
- Queue removal preserves numeric/string UID identity and requires a unique match
  in the extension's latest explicit queue.

Commands are allowlisted and capability-gated. The receiver times out requests after
eight seconds and rejects pending requests on disconnect. A timeout does not prove
the operation failed; **no mutation is automatically retried**. Successful responses
mean the Spicetify API call returned/accepted the operation, not that Spotify's
audio output was independently observed.

### Events and state

- `capabilities`: protocol, api flags, command list, search mode.
- `track`: URI, title, artist, album, image reference.
- `track_cleared`: clears track, timeline, and lyrics.
- `playback`: trackUri, isPlaying, positionMs, durationMs, shuffle, repeat, volume,
  muted, liked, updatedAt. Missing/unavailable getters yield null.
- `lyrics`: URI, sync_type, provider (`spotify`), optional language, and lines
  `{startTimeMs,text}`. Validated word arrays are accepted when a provider supplies
  genuine ordered spans, but the maintained Spotify endpoint currently returns line
  text/timing only. Stored in memory only; stale URI/request payloads are ignored
  and a valid document survives temporary transport loss.
- `lyrics_unavailable`: URI and reason. It does not affect playback or other features.
- `queue_update`: current, queued, next_up, counts.

Playback snapshots arrive on song/play/pause changes, after player commands, on
progress events at most once per two seconds, and on changed local snapshots at
five-second intervals. The TUI interpolates with its monotonic clock at 4 Hz for
line/static lyrics and 10 Hz only when genuine word timings exist, with a ten-second
extrapolation ceiling.

RPC state includes an owner epoch, monotonically increasing revision, and queue/
lyrics revision counters. The `updated` event represents connection, metadata,
playback, capability, and revision changes without carrying lyric documents, queue
contents, or playlists on every progress update. Lyrics are hydrated through
`getLyrics`; queue and browsing use validated request/reply RPCs.

## OpenCode RPC additions

These methods travel over OpenCode's authenticated RPC, not the bridge WebSocket:

- `getLyrics` returns the validated current lyric document, or an empty/loading
  document when none is available.
- `getLyricsSources {uri, lrclib, contact, refresh}` takes a track URI, the opt-in
  flag, the client contact string, and a refresh flag. It rejects a URI that is not
  the current track and returns at most eight candidates plus provider availability
  (`spotify`/`lrclib`; `ready`/`unavailable`/`disabled`/`error`). Output candidates
  and availability are revalidated; detail strings are bounded to 300 characters.
  This RPC never returns credentials or environment data.
- The server may contact LRCLIB only when `lrclib` is true and contact is valid. It
  sends exact title/artist/album/rounded duration and identifies the client in the
  User-Agent. Redirects are disabled; timeout is six seconds; responses are capped
  at 512 KiB and must be JSON. Title/artist must match after Unicode normalization
  and duration must agree within two seconds. Synced LRC (≤256 KiB source, ≤5,000
  lines) and plain text become separate candidates. Requests are sequential with a
  500 ms minimum gap, one in-flight lookup, a 12-entry cache, and `Retry-After`
  backoff. Provider text/lyrics remain memory-only and are not logged or persisted.

`getLyricsSources` is capability-independent: Spotify candidates come from the
existing bridge, while LRCLIB is a server-side opt-in. A provider failure is
reported as availability, not as a bridge disconnect or playback error.

## State, sync, and limits

- At most 12 accepted sockets, 30 upgrade attempts/minute, 60 messages/second/socket.
- 16 KiB handshake/client-command messages; 4 MiB server-bound frames; compression
  disabled; binary/malformed/over-depth JSON is closed.
- Receiver JSON depth ≤24, ≤100,000 values. RPC parameters allow only known scalar
  keys, bounded strings, finite numbers, valid Spotify URIs, and integer pagination.
- At most 32 pending requests and 120 requests/minute per receiver. Owner limits
  aggregate observer requests too. Each observer/extension admits at most 16
  concurrent API operations, with a bounded recent-ID duplicate cache.
- Default request timeout eight seconds; seek 0–86,400,000 ms; volume 0–1;
  query ≤200 characters; pages ≤200 tracks. Extension queue output is capped at 500
  entries per section; receiver normalization caps at 5,000.
- Root lists ≤5,000 nodes/depth 10; lyric lists ≤5,000 lines/4,096 characters each;
  optional word arrays ≤500 words/line with finite ordered millisecond spans,
  subject also to total frame/value limits.
- Displayed metadata/control characters are bounded/stripped. OpenTUI receives text
  nodes, not HTML, JavaScript, or evaluated markup. No artwork URLs are fetched or
  opened over the bridge.
- No shell, evaluation, filesystem, or arbitrary-network RPC exists. Spotify API
  destinations are hardcoded and track identifiers/URIs are validated.
- The TUI batches track and lyric-state transitions and checks the request
  generation and URI before accepting a lyric response. A manual refresh cannot
  carry over to a later occurrence of the same URI. The chosen source stays selected
  while its document is still offered; definitive withdrawal falls back to another
  candidate or clears the preview. Transient provider or transport errors can retain
  the last good document for the same track.
- `get_capabilities` gates every optional surface: `refresh_lyrics` advertisement,
  search mode, word-timing claims, and API flags. Unknown getters stay null, unknown
  commands are rejected, and old extensions fall back to RPC hydration.

## TUI and layout

| Layer | Responsibility |
|---|---|
| `src/tui.tsx` | Pinned `sidebar.footer` player slot, `session.panel` Now Playing slot, persistent `lyrics-v0.4` settings, revision-gated state, lyric hydration, adaptive playback clock, lifecycle cleanup |
| `src/components/MiniPlayer.tsx` | Pinned monochrome music card: header, navigation, framed artwork, metadata, progress, transport, compact volume, five-line lyric window |
| `src/components/NowPlayingPanel.tsx` | Dedicated session surface: header with fullscreen/close buttons, true-pixel art, immersive `LyricsView`, transport, hints |
| `src/components/Music.tsx` | SDK dialog hierarchy for playback, queue, playlists/folders, library, search, lyrics; panel-first lyrics routing with dialog fallback |
| `src/components/LyricsView.tsx` | Wrapped, virtualized monochrome lyrics; bold-white active line, dim others; follow/manual scrolling; refresh/settings actions |
| `src/components/LyricsSettings.ts` | Native provider, script, priority, display, motion, background, LRCLIB dialogs; legacy keys validate but are not painted |
| `src/services/lyrics-window.ts` | Pure fixed-size lyric window: two previous, active, two upcoming; marker skipping; instrumental context |
| `src/ui/layout.ts` | Grapheme-safe wrapping/truncation, complex-script right margin, lyric block layout, follow offsets, visible-row selection |
| `src/ui/primitives.tsx` | Measured, natively truncated text with reserved right margin; named pointer controls; terminal dimensions |
| `src/ui/colors.ts` | Neutral theme surface/text/dim tones; album art is the only color |
| `src/ui/player-layout.ts` | Pure responsive four-mode card plan, art caps, compact volume geometry, fixed time widths |
| `src/ui/transport.ts` | Fixed-width transport/like actions shared by sidebar and panel |
| `src/services/playback-ui.ts` | Drag/optimistic/server volume display and acknowledgement rules |
| `src/ui/player-actions.ts` | Capability-aware player actions with disabled reasons |

The compact sidebar is pinned to the host's `sidebar.footer`, not the scrolling
`sidebar.content` column, so Context/MCP/Todo expansion scrolls without pushing the
player below the fold. The hierarchy is connection header, Music/Lyrics/More
navigation, a framed player card (artwork, title, artist, progress, transport,
compact volume), a deliberate gap, and the five-line lyric window. A pure
`playerLayout` planner derives a footer budget from the actual terminal height and
chooses roomy/medium/tight/very-tight presentation. The lyric block always reserves
its tier budget (5/3/1 rows) so wrapped-height changes never bounce the player;
inside the reservation, `wrapLyricLines` wraps each semantic line to physical rows
and `distributeLyricRows` gives the focus line every row it needs while dim context
rows yield first. Only when even the focus line alone exceeds the budget does a
bounded scroll viewport take over.

| Mode | Artwork | Lyrics | Controls |
|---|---|---|---|
| Roomy | up to 9 rows, framed card | 5 semantic lines, wrapped | full |
| Medium | up to 9 rows, no frame | 5 or 3 semantic lines, wrapped | full |
| Tight | 3–4 rows or hidden | 3 or 1 semantic lines, wrapped | essential |
| Very tight | hidden | 1 semantic line or viewport | transport first |

Artwork is centered and aspect-preserved; it is the first block reduced, and
controls/metadata/progress survive longest. The three transport buttons occupy fixed
4/9/4 widths and remain centered independently of the auxiliary Like action. Volume
is a short, centered secondary control capped at 12 cells, never as prominent as
the seekbar.

Positioning is intentionally single-slot: the host publishes no section-height
signal (both sidebar slots carry `sessionID` only), so Todo/MCP/Context expansion
cannot be observed directly and dynamic content↔footer switching would remount the
player on every toggle (focus loss, artwork reload, keymap rebind, oscillation).
The footer stays pinned while `resolvePlayerBudget` absorbs sub-two-row oscillation
and the terminal height settles 200 ms before the budget recomputes. When sections
collapse, the freed space belongs to the host scroll region above the pinned card;
when they expand, the card holds its position and compacts instead of scrolling
away. Exactly one footer claim exists and its remover runs on teardown.

There is one sidebar surface, not simulated tabs. Music remains a dialog hierarchy:
Enter opens/actions, Escape goes back/closes, and every dialog includes a bounded
Back row. Queue, playlist folder/page views retain stable URI/UID selections; newer
generations invalidate pending results; search runs on explicit submission. Queue
mutation requires a unique explicit UID.

Direction: a native listening instrument, not a dashboard. Song metadata is quiet,
playback controls have named targets, and the current lyric is the visual center.
Host theme surfaces with black/white/grey hierarchy; space separates logical lyric
lines; bold, dim, underline, focus markers, and alignment replace browser-scale
typography. The surrounding OpenCode layout never animates; automatic lyric
movement may transition briefly, and Reduced Motion disables even that (slider
feedback is kept).

## Unicode measurement and clipping

All renderer text is measured with `cellMeasure`, the max of the live renderer's
`measureEditText` width, the `wcwidth` table, and the UTF-16 code-unit count, and
segmented with `Intl.Segmenter` grapheme clusters. The max is required because the
Windows terminal advances Indic combining sequences, viramas, ZWJ, and variation
selectors cell-by-cell (ConPTY cursor-position DSR 6n probes: Tamil க்ஷ advances 3
cells, not the 2 either table reports; Malayalam ക്ഷ advances 3, not 1–2; ZWJ emoji
advances 5, not 2–4). A row that fit under one table could otherwise overrun its box
by ~2x, push the physical cursor past the sidebar's right edge, wrap to column 0
(the editor area) via autowrap (DECAOM, never disabled upstream), and leave stale
cells the incremental diff never repaints. Native centering adds a second,
independent overrun: its leading pad and fixed-width trailing fill are computed
with the host table, so a shaped row that fills the box still advances `M - N`
extra cells beyond the emitted fill. `CellText` therefore centers single-row shaped
text manually with `cellMeasure` and emits only leading pad + content at the text's
native width, never foreground trailing fill; the overhang is absorbed by the
reserved margin. Some runtimes also split Kannada/Tamil/Gurmukhi/Sinhala/Myanmar/
Khmer conjuncts after a virama or pulli, so the layout rejoins those pieces before
wrapping. Text is sanitized of terminal escapes, directional overrides, zero-width
spaces, BOM, and soft hyphens before display. An orphan combining mark receives a
dotted circle; genuinely zero-width non-marks are dropped rather than turned into
visible circles.

Wrapping happens before rendering. Every physical row is proved to fit the
available columns, then rendered with `wrapMode="none"` and native `truncate`
inside clipped containers, so OpenTUI's own wrapping cannot disagree with lyric row
accounting. A cluster wider than the whole text region is replaced rather than
split, and no emoji ZWJ sequence, combining sequence, or Indic conjunct is sliced.
Truncation measures the ellipsis with the same cell metric.

Rows containing Indic scripts, combining marks, Arabic/Hebrew, Thai/Lao, or
extended pictographs additionally reserve four extra cells (`cellSafety`): centered
text keeps at least two on each side, left-aligned text keeps them on the right.
For shaped single-row text the rendered node is sized to its native width and
carries no foreground trailing fill, so the terminal's residual advance stays
inside that reserve instead of wrapping at the screen edge. Native text truncation,
the reserved margin, row clipping, and the sidebar's own `overflow="hidden"` remain
independent containment layers. The lyric viewer derives its text width from the
actual viewport minus scrollbar, padding, safety margin, and the two-cell active
marker; on viewports narrower than six columns the marker is dropped so the prefix
cannot overflow. A component-level sentinel and a host-composition fixture both
assert that no glyph reaches the editor area.

The lyric viewer virtualizes by wrapped visual row, not logical lyric index. It
renders one spacer before and after the visible window, so variable-height lines
and long unbroken words cannot desynchronize scrolling. Width changes recompute
blocks and preserve the relative visible row in manual mode. Track changes reset
scroll and follow state.

Known upstream findings: incremental-diff desync plus autowrap spill with no public
full-repaint API (only a resize-with-size-change forces one). These constrain the
fix to measurement + manual-centering + reserves; no raw VT commands, forced
whole-screen repaint, or arbitrary delay is used.

## Renderer evolution (history)

Superseded designs are recorded here so deleted snapshot files stay interpretable;
only the current design above is normative.

- **V0.4:** capped 22-row mini player, single selected lyric, progress string,
  retained cover metadata without a renderer. Grapheme-safe virtualized lyrics and
  responsive MiniPlayer introduced.
- **V0.5–V0.5.2:** native artwork and carousel fixtures; monochrome redesign
  (deleted `LyricCarousel`, album-derived colors, ambient wash, karaoke spans);
  Now Playing panel on `session.panel` with panel-first/dialog-fallback routing;
  pure `playerLayout` row planner with responsive gap/art caps; fixed 4/9/4
  transport; drag vs optimistic vs server volume states; virama/pulli conjunct
  rejoining; ZWSP/BOM/soft-hyphen sanitation; marker suppression.
- **V0.5.3:** player moved from scrolling `sidebar.content` to pinned
  `sidebar.footer`; four-mode card planner; five-line lyric window with fallbacks;
  compact volume geometry; artwork largest-candidate selection with 512 px decode
  ceiling and no-upscale rendering; host-composition/Todo and editor-sentinel
  fixtures; safety margin extended to Odia, Tibetan, and regional-indicator flags.
- **V0.5.4:** single pinned `sidebar.footer` claim retained after host-API research
  showed vertical centering is not implementable through the supported API (no
  section-height signal); `resolvePlayerBudget` two-row hysteresis plus 200 ms
  terminal settle; slot-placement tests (exactly one footer claim).
- **V0.5.5:** semantic window unchanged (2 prev + active + 2 upcoming); each line
  wraps to physical rows (`wrapLyricLines`) and `distributeLyricRows` centers the
  focus line whole; over-budget focus lines fall back to a bounded scroll viewport.
- **V0.5.6:** `cellMeasure` takes the max of live renderer method, wcwidth, and
  UTF-16 unit count (ConPTY probe table); `CellText` manual centering without
  foreground trailing fill; 4-cell `cellSafety` reserve; full VT emission-bounds
  harness (`test:vt`) asserting no out-of-rect writes across transitions.
- **V0.5.7:** staged space-only clear inside the previous lyric rectangle before
  swapping layouts (forces the native diff to emit blank cells for stale Indic
  glyphs); same styled underlay retained while the new lyric draws; public native
  `frame` event sequences the paints; suffix starts at its conservative scene
  offset (resume after `👩‍💻` could overwrite that glyph); sidebar made
  non-focusable with autofocus suppression on handled pointer presses; no Spotify
  keymap layers.

## Artwork pipeline

The bridge considers every image candidate from the player item, album, and
metadata, then chooses the largest reported source instead of accepting the first
`image_url`. The TUI decodes to at most 512 px — enough for the largest
sidebar/panel cover on high-DPI terminals without retaining unbounded textures.
Decode, resize, and cache stay memory-only.

`ArtworkView` never asks the terminal to enlarge a decoded texture. It computes the
largest cell box whose pixel dimensions fit the source (`fitArtworkCells`); a 160 px
thumbnail is shown smaller rather than stretched into a blurry cover. Aspect ratio
is preserved and the fixed cell box remains centered, so resolution changes do not
move surrounding controls.

The artwork service accepts only the fixed `https://i.scdn.co/image/<40-hex-id>`
form (including the normalized `spotify:image` reference), rejects redirects and
other hosts, omits credentials, and bounds a request to five seconds, 2 MiB, and
2048 px. Decoded images stay in a bounded memory-only cache and are not persisted.
Unsupported formats and fetch/render failures fall back to metadata text.

The true album-art image is the only color in the UI. `ArtworkView` renders it with
`<image protocol="auto">` (Kitty, then Sixel with resolution, otherwise colored
blocks); analysis fields (accent/ambient) are no longer consumed for theming.
Detected protocol support is not proof of correct live rendering: falling back to
blocks is expected on multiplexed or unknown terminals, and renderer tests assert
block-protocol fallback, not true-color output. Artwork analysis still produces an
accent and 4×3 ambient sample for diagnostics, but nothing derived is painted.

## Lyrics providers and script honesty

`LyricsSourceManager` resolves candidates and availability without changing the
stable bridge transport:

- **Spotify (default, existing):** the extension asks Spotify's authenticated
  color-lyrics endpoint for the current track and transports provider, language,
  sync type, and line text/timing. It currently supplies line timing only.
- **LRCLIB (opt-in):** the server calls `https://lrclib.net/api/get` only after
  the user enables it and supplies a project URL or email as client contact.
  Requests carry exact title, artist, album, and rounded duration; the response is
  accepted only when normalized title/artist and duration (within two seconds)
  match. Redirects are disabled. The request has a six-second timeout, 512 KiB
  response ceiling, JSON content-type check, one in-flight lookup, a 500 ms
  sequential gap, a 12-document cache, and `Retry-After` backoff. Synced LRC and
  static text are separate candidates. LRCLIB attribution is displayed.
- **lrc.red (evaluated, not implemented):** its documentation requires app
  identification and visible attribution, and no implementation was added. Settings
  shows the provider as disabled with the identification/terms reason rather than
  pretending it is available.

Provider selection is deterministic and stable. Preferences rank provider, timing
versus script, genuine word format, then the existing Spotify provider. A per-track
override wins while that version is available. Selection stays stable while the
chosen document is still offered, unless the user changes settings, explicitly
refreshes, or changes tracks. If the source withdraws the document, the player
chooses an available fallback or clears the lyrics when the resolver confirms there
are none. Availability rows explain connected/loading/unavailable/disabled/error
states. Refresh requests a new Spotify payload when the extension supports
`refresh_lyrics`; LRCLIB refresh respects its own cache/cooldown.

No transliteration is performed. "Romanized preferred" selects a candidate only
when the provider marks it romanized or its text is verified Latin script. A Latin
candidate without a provider romanization flag is labelled "romanization
unconfirmed"; a non-Latin fallback is labelled "original/available script."
"Original" prefers original-script candidates and explains fallback. Mixed-script
documents are classified as mixed, never silently claimed as translated.

Partial line timing is preserved: untimed lines remain untimed while timed lines
keep order and can still drive the active line. Missing timestamps never become
zero. Word spans are accepted only when every word has finite ordered
`startMs`/`endMs`, the word texts reconstruct the line text, and no guessed
syllable timing is created. Word offsets must land on grapheme boundaries. The
maintained Spotify bridge does not emit word timings; LRCLIB synced payloads are
line-timed. The monochrome UI deliberately does not paint karaoke fills even when
genuine word timings exist; they only inform the faster word-timing clock. The UI
labels a document as `word` only when such payloads actually arrive.

Lyric moment selection distinguishes no track, loading, timed vocal line,
unsynchronized text, unavailable source, source error, and instrumental state.
Instrumental is shown only before a known first vocal or at explicit timed blank or
recognized instrumental-marker lines. An ordinary interval between timed lyrics is
not considered an instrumental break. No lyric end time is inferred; an outro is
reported only when an explicit timed gap follows vocals. Missing lyrics stay
unavailable, and loading never masquerades as an instrumental state.

Follow mode selects the active line from genuine line timestamps using binary
search. Scroll targets use actual wrapped-row offsets with a bounded inset, so a
line is not clipped on short terminals. Up/Down, PageUp/PageDown, Home/End, or
mouse wheel enter manual mode and stop pending motion; **F** or the Resume follow
control returns to the active line. During an intro/interlude the follow target is
the upcoming vocal line, not the stale previous line. Playback continuing while
manual never snaps the view back.

Motion is a single 180 ms, 20 fps renderer timeline for scroll position only. It is
cancellable and replaced by an immediate jump when reduced motion is enabled.
Lyrics are monochrome: the active vocal line is bold host-white, all other lines
are host-dim. Marker lines are not painted as bracket text. The timeline advances
only from real playback position.

Settings persist under `lyrics-v0.4` and validate on read and write: provider
(`auto`/Spotify/LRCLIB), script preference, timing-versus-script priority, preview
visibility, follow default, reduced motion, neutral lyric background, artwork
visibility/size, volume-row visibility, seek increment, instrumental indicator,
LRCLIB enablement/contact, and per-track overrides. Legacy accent/ambience/
strong-emphasis keys still validate so stored settings survive, but they no longer
affect painting. Invalid, extra, or credential-like fields are rejected. Cancel
leaves stored settings unchanged. The dialog shows current track availability and a
disabled-provider reason where applicable.

## Pointer controls and focus

| Context | Input | Action |
|---|---|---|
| Sidebar | Click | Open Music/Lyrics/More/Settings, or operate transport and Like |
| Sidebar | Click or drag seek | Preview while dragging; commit once on release |
| Sidebar | Click or drag volume | Preview and send coalesced updates; finish on release |
| Lyrics | Scroll or drag scrollbar | Browse lyrics without automatic following |
| Lyrics | Click Follow or Settings | Resume follow or open settings; refresh sources from Settings |
| Panel | Click Full or Close | Change presentation or close through the host panel |

Spotify registers no keymap layers. The sidebar is not focusable and handled pointer
presses prevent OpenTUI's autofocus. Host dialogs, the panel container, and explicit
text-entry controls still use OpenCode's native focus and input behavior. Disabled
player actions expose a reason. Seek previews update immediately and commit once on
release; volume previews update immediately, send coalesced live updates, and commit
the final value on release.

Performance: one local clock (250 ms line/static, 100 ms genuine word timing),
stopped when paused or disconnected, ten-second extrapolation ceiling. Lyrics
virtualize by visible wrapped rows with bounded overscan. Scroll updates come from
the scrollbar change event; resize uses viewport/box resize hooks. No continuous
polling or terminal redraw loop. Lyric documents and source lookups have bounded
caches; stale generations are suppressed; refresh animations are single timelines,
not frame loops. The bridge sends progress at most every two seconds and changed
paused state every five seconds. No artwork or lyric body is written to logs or disk.

## Security boundaries

- Mutual HMAC proofs bind role and both peers' fresh nonces. Unauthenticated
  connections cannot access commands/state. Host/path/loopback checks occur before
  upgrade. Origin enrollment remains handshake-only until an authenticated extension
  proof pins the actual header; after pinning, exact pre-upgrade Origin rejection
  applies. Native observer connections use a separate role/header and mandatory
  authentication. Missing/null/opaque Origins remain exact distinct values, never
  standing exceptions.
- Approved setup provisions a per-installation 256-bit secret into private user
  configuration and the installed extension. Existing credentials are reused; only
  explicit reset rotates them. Package/source retain a placeholder, never a
  production secret. Nothing reads old localStorage credentials. Old manual
  credentials are no longer accepted.
- Untrusted metadata and lyrics are bounded and rendered as OpenTUI text, never
  HTML or code. Artwork references are parsed as HTTPS/Spotify image metadata. No
  generic execution, filesystem, or arbitrary-network RPC exists. The only new
  outbound destination is `https://lrclib.net/api/get`, reached only under the
  opt-in policy.
- Optional LRCLIB access is explicit opt-in and server-side only. It sends track
  title, artist, album, rounded duration, and the user-provided project URL/email;
  it never sends the bridge secret, track URI, credentials, terminal state, or
  existing lyrics. Provider responses are rejected unless title/artist normalize
  exactly and duration is within two seconds. Redirects are disabled, requests time
  out after six seconds, responses are capped at 512 KiB and must be JSON, synced
  LRC source is capped at 256 KiB / 5,000 lines, one lookup may be in flight,
  requests are sequential with a 500 ms gap, the cache holds 12 entries, and
  `Retry-After` is honored with bounded cooldown.
- `refresh_lyrics` is allowlisted, parameterless, current-track-only, and returns
  only an acceptance acknowledgement. It cannot read lyric text back over the
  response channel; lyrics still arrive as validated events. Old extensions simply
  do not advertise it.
- `getLyricsSources` validates a track URI, boolean opt-in/refresh flags, and a
  bounded HTTPS/email contact; it rechecks the current track before and after the
  async provider lookup. Output candidates and availability are revalidated and
  bounded to eight candidates/two providers.
- Optional word timings are accepted only with finite ordered numeric
  `startMs`/`endMs` values, no overlap, at most 500 words per line, and exact
  reconstruction of the line text after normalization. Numeric strings are
  normalized to numbers. Missing/guessed timing is never synthesized.
- Unicode layout uses grapheme segmentation and renderer `unicode` measurement;
  terminal escapes/directional overrides are stripped before display. Lyric rows are
  pre-wrapped and clipped, so untrusted text cannot widen or escape the UI.
- Settings are validated on read/write, reject unknown/credential-like fields, and
  bound overrides to 200 entries. Lyrics and source candidates remain memory-only.

Legacy audit lineage (preserved from V0.3–V0.4): IPv4-loopback binding, secure
random challenges, HMAC-SHA256, role-separated proofs, timing-safe verification,
pre-auth gating, authentication deadline, command allowlist, scalar validation,
request correlation, disconnect rejection, metadata/lyrics normalization, bounded
queries/pagination, exact Host/path/loopback checks, authenticated Origin
enrollment, observer ownership, and never-retried mutations.

## Residual risks

Same-user malware, administrators, equally privileged Spotify extensions,
compromised authorized OpenCode clients, and active privileged local relays are
outside the isolation guarantees. The bridge authenticates but does not encrypt
loopback traffic. Resource limits reduce abuse, not all local denial of service.
An upstream release can contain unverified extra zip entries. A correctly sized
malicious restore backup is not detected. The installer lock is per-user and is
not a security boundary against a hostile process with the same token.
