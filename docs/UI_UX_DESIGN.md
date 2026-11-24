# V0.5.7 UI, lyrics and source design

## Reference study (read-only)

Inventoried all 16 `.agents/skills` entries in `reference/spicy-lyrics`, and read
its AGENTS/CLAUDE guidance. The most useful material is antislop/UI/human/mobile
(purpose, hierarchy, responsive reflow, contrast and real controls), animate,
animation-performance, review/improve/find-animation-opportunities (restrained,
interruptible, bounded motion), animation-vocabulary and emil-design-eng
(continuity and explicit interaction states). Prototype, apple-design and
pick-ui-library reinforce testing in context, immediate feedback and reusing native
primitives; the code/copy skills reinforce concise explanations and honest states.
No reference skill was installed or made project policy. Its setup wizard,
Python checker, advisor requirements and browser-specific commands were not run.

Studied lyric CSS, ContentBox, AnimatedArtwork, DynamicBG palette behavior,
ProcessLyrics, fetchLyrics, LyricsVirtualizer, Animator and ScrollToActiveLine/
ScrollIntoView behavior. Borrowed concepts only: a single lyric focal point,
measured surrounding context, stable document identity, separate follow/manual
states, bounded caches, stale-result suppression and a restrained active-line
transition. No AGPL code, assets, fonts, CSS, transliteration packages or hosted
services are incorporated.

## Direction

Native listening instrument, not a dashboard: song metadata is quiet, playback
controls have named targets, and the current lyric is the visual center. Use host
theme surfaces with black/white/grey hierarchy: color is reserved for true album
artwork. Space separates logical lyric lines; bold, dim, underline, focus markers
and alignment replace browser-scale typography. Keyboard actions respond
immediately. Automatic lyric movement may transition briefly; the surrounding
OpenCode layout never animates. Reduced motion is explicit.

Terminal capabilities are not browser capabilities. CSS transforms, masks,
backdrop blur, DOM font sizing, GPU compositing and requestAnimationFrame recipes
do not transfer to OpenTUI. The installed 0.9.0 native APIs provide cell
measurement, clipping, scroll viewports, resize hooks, renderer-owned timelines
and capability flags. Terminal fonts and shaping still belong to the terminal;
native buffer tests cannot certify how a particular Windows Terminal/font
rasterizes Telugu, Devanagari or emoji.

## UI architecture

| Layer | Responsibility |
|---|---|
| `src/tui.tsx` | Pinned `sidebar.footer` player slot, `session.panel` Now Playing slot, persistent `lyrics-v0.4` settings, revision-gated state, lyric hydration, adaptive playback clock and lifecycle cleanup. |
| `src/components/MiniPlayer.tsx` | Pinned monochrome music card: header, navigation, framed artwork, metadata, progress, transport, compact volume and a five-line lyric window. |
| `src/components/NowPlayingPanel.tsx` | Dedicated session surface: header with fullscreen/close buttons, true-pixel art, immersive `LyricsView`, transport and hints. Seek/volume stay in the pinned sidebar card and More so the panel keeps its lyric space. |
| `src/components/Music.tsx` | SDK dialog hierarchy for playback, queue, playlists/folders, library, search and lyrics; lyrics prefer the session panel with dialog fallback. |
| `src/components/LyricsView.tsx` | Wrapped, virtualized monochrome lyrics; bold-white active line, dim others; follow/manual scrolling; refresh/settings actions. |
| `src/components/LyricsSettings.ts` | Native provider, script, priority, display, motion, background and LRCLIB dialogs. Legacy accent/ambience/emphasis keys validate but are not painted. |
| `src/services/lyrics-window.ts` | Pure fixed-size lyric window: two previous, active, two upcoming; marker skipping and instrumental context. |
| `src/ui/layout.ts` | Grapheme-safe wrapping/truncation, complex-script right margin, lyric block layout, follow offsets and visible-row selection. |
| `src/ui/primitives.tsx` | Measured, natively truncated text with a reserved right margin, named pointer controls and terminal dimensions. |
| `src/ui/colors.ts` | Neutral theme surface/text/dim tones; album art is the only color. |
| `src/ui/player-layout.ts` | Pure responsive four-mode card plan, art caps, compact volume geometry and fixed time widths. |
| `src/ui/transport.ts` | Fixed-width transport/like actions shared by sidebar and panel. |
| `src/services/playback-ui.ts` | Drag/optimistic/server volume display and acknowledgement rules. |
| `src/ui/player-actions.ts` | Capability-aware player actions with disabled reasons. |

The compact sidebar is pinned to the host's `sidebar.footer`, not the scrolling
`sidebar.content` column. Context/MCP/Todo expansion therefore scrolls without
pushing the player below the fold. The hierarchy is connection header,
Music/Lyrics/More navigation, a framed player card (artwork, title, artist,
progress, transport, compact volume), a deliberate gap, and the five-line lyric
window. A pure `playerLayout` planner derives a footer budget from the actual
terminal height and chooses roomy/medium/tight/very-tight presentation. The
lyric block always reserves its tier budget (5/3/1 rows) so wrapped-height
changes never bounce the player; inside the reservation, `wrapLyricLines`
wraps each semantic line to physical rows and `distributeLyricRows` gives the
focus line every row it needs while dim context lines yield rows first. Only
when even the focus line alone exceeds the budget does a bounded scroll viewport
take over, keeping the full text reachable without overflowing the card.

| Mode | Artwork | Lyrics | Controls |
|---|---|---|---|
| Roomy | up to 9 rows, framed card | 5 semantic lines, wrapped | full |
| Medium | up to 9 rows, no frame | 5 or 3 semantic lines, wrapped | full |
| Tight | 3–4 rows or hidden | 3 or 1 semantic lines, wrapped | essential |
| Very tight | hidden | 1 semantic line or viewport | transport first |

Artwork is centered and aspect-preserved; it is the first block reduced, and
controls/metadata/progress survive longest. The three transport buttons occupy
fixed 4/9/4 widths and remain centered independently of the auxiliary Like
action. Volume is a short, centered secondary control capped at 12 cells, never
as prominent or as wide as the seekbar.

Positioning is intentionally single-slot: the host publishes no section-height
signal (both sidebar slots carry `sessionID` only), so Todo/MCP/Context
expansion cannot be observed directly and dynamic content↔footer switching
would remount the player on every toggle (focus loss, artwork reload, keymap
rebind, oscillation). The footer stays pinned while `resolvePlayerBudget`
absorbs sub-two-row oscillation and the terminal height settles 200 ms before
the budget recomputes. When sections collapse, the freed space belongs to the
host scroll region above the pinned card; when they expand, the card holds its
position and compacts instead of scrolling away.

V0.5.7 layout limit: OpenCode 2.3's `sidebar.content` and `sidebar.footer`
claims receive only `sessionID`. Neither exposes the height, position, or
scroll bounds of the native sections. The host assigns the unoccupied space
to its scroll region, not to the footer. The player stays prepended at the
top of the pinned footer; centering inside that claim cannot move it into the
scroll region. Moving the player into `sidebar.content` would let expanded
native sections push it below the fold. No spacers, private layout changes,
or horizontal alignment changes are used as a substitute for vertical
centering.

There is one sidebar surface, not simulated tabs. Music remains a dialog
hierarchy: Enter opens/actions, Escape goes back/closes, and every dialog includes
a bounded Back row. Queue, playlist folders, paged tracks, search and lyrics reuse
the same input model.

## Unicode measurement and clipping

All renderer text is measured with `cellMeasure`, the max of the live renderer's
`measureEditText` width, the `wcwidth` table, and the UTF-16 code-unit count,
and segmented with `Intl.Segmenter` grapheme clusters. The max is required
because the Windows terminal advances Indic combining sequences, viramas, ZWJ
and variation selectors cell-by-cell (ConPTY cursor-position probes: Tamil க்ஷ
advances 3 cells, not the 2 either table reports; Malayalam ക്ഷ advances 3,
not 1–2; ZWJ emoji advances 5, not 2–4). A row that fit under one table could
otherwise overrun its box by ~2x, push the physical cursor past the sidebar's
right edge, wrap to column 0 (the editor area), and leave stale cells the
incremental diff never repaints. Native centering adds a second, independent
overrun: its leading pad and fixed-width trailing fill are computed with the
host table, so a shaped row that fills the box still advances `M - N` extra
cells beyond the emitted fill. `CellText` therefore centers single-row shaped
text manually with `cellMeasure` and emits only leading pad + content at the
text's native width, never foreground trailing fill; the overhang is absorbed
by the reserved margin. Some runtimes also split Kannada/Tamil/Gurmukhi/
Sinhala/Myanmar/Khmer conjuncts after a virama or pulli, so the
layout rejoins those pieces before wrapping. Text is sanitized of terminal
escapes, directional overrides, zero-width spaces, BOM and soft hyphens before
display. An orphan combining mark receives a dotted circle; genuinely zero-width
non-marks are dropped rather than turned into visible circles.

Wrapping happens before rendering. Every physical row is proved to fit the
available columns, then rendered with `wrapMode="none"` and native `truncate`
inside clipped containers. This prevents OpenTUI's own wrapping from disagreeing
with lyric row accounting. A cluster wider than the whole text region is
replaced rather than split, and no emoji ZWJ sequence, combining sequence or
Indic conjunct is sliced. Truncation measures the ellipsis with the same cell
metric.

Terminal cells are measured by the max of Unicode rules, wcwidth, and the
UTF-16 code-unit count (see above), so a font shaper or terminal advance wider
than any single table cannot push a row past its box. Rows containing Indic
scripts, combining marks, Arabic/Hebrew, Thai/Lao or extended pictographs
additionally reserve four extra cells (`cellSafety`): centered text keeps at
least two on each side, left-aligned text keeps them on the right. For shaped
single-row text the rendered node is sized to its native width and carries no
foreground trailing fill, so the terminal's residual advance stays inside that
reserve instead of wrapping at the screen edge. Native text truncation, the
reserved margin, row clipping and the sidebar's own `overflow="hidden"` remain
independent containment layers. The lyric viewer derives its text width from the
actual viewport minus scrollbar, padding, safety margin and the two-cell active
marker; on viewports narrower than six columns the marker is dropped so the
prefix cannot overflow. A component-level sentinel and a host-composition fixture
both assert that no glyph reaches the editor area.

The lyric viewer virtualizes by wrapped visual row, not logical lyric index. It
renders one spacer before and after the visible window, so variable-height lines
and long unbroken words cannot desynchronize scrolling. Width changes recompute
blocks and preserve the relative visible row in manual mode. Track changes reset
scroll and follow state.

## Artwork quality and containment

The bridge considers every image candidate from the player item, album and
metadata, then chooses the largest reported source instead of accepting the
first `image_url`. The TUI decodes to at most 512 px (previously 160 px), which
is enough for the largest sidebar/panel cover on high-DPI terminals without
retaining unbounded textures. Decode, resize and cache stay memory-only.

`ArtworkView` never asks the terminal to enlarge a decoded texture. It computes
the largest cell box whose pixel dimensions fit the source (`fitArtworkCells`);
a 160 px thumbnail is shown smaller rather than stretched into a blurry 300 px
cover. Aspect ratio is preserved and the fixed cell box remains centered, so
resolution changes do not move surrounding controls.

## Follow, manual and motion

Follow mode selects the active line from genuine line timestamps using binary
search. Scroll targets use actual wrapped-row offsets with a bounded inset, so a
line is not clipped on short terminals. Up/Down, PageUp/PageDown, Home/End or
mouse wheel enter manual mode and stop pending motion; **F** or the Resume follow
control returns to the active line. During an intro/interlude the follow target
is the upcoming vocal line, not the stale previous line. Playback continuing
while manual never snaps the view back.

Motion is a single 180 ms, 20 fps renderer timeline for scroll position only. It
is cancellable and replaced by an immediate jump when reduced motion is enabled.
Lyrics are monochrome: the active vocal line is bold host-white, all other lines
are host-dim. Marker lines are not painted as bracket text. The cosmetic seekbar
flow glyph and progress-motion setting were removed; the timeline advances only
from real playback position.

## Source manager and providers

`LyricsSourceManager` resolves candidates and availability without changing the
stable bridge transport:

- **Spotify (default, existing):** the extension asks Spotify's authenticated
  color-lyrics endpoint for the current track and transports provider, language,
  sync type and line text/timing. It currently supplies line timing only.
- **LRCLIB (opt-in):** the server calls `https://lrclib.net/api/get` only after
  the user enables it and supplies a project URL or email as client contact.
  Requests carry exact title, artist, album and rounded duration; the response is
  accepted only when normalized title/artist and duration (within two seconds)
  match. Redirects are disabled. The request has a six-second timeout, 512 KiB
  response ceiling, JSON content-type check, one in-flight lookup, a 500 ms
  sequential gap, a 12-document cache and `Retry-After` backoff. Synced LRC and
  static text are separate candidates. LRCLIB attribution is displayed.
- **lrc.red (evaluated, not implemented):** its documentation requires app
  identification and visible attribution, and no implementation was added. The
  Settings dialog shows the provider as disabled with the identification/terms
  reason rather than pretending it is available.

Provider selection is deterministic and stable. Preferences rank provider,
timing versus script, genuine word format, then the existing Spotify provider.
A per-track override wins while that version is available. Selection stays
stable while the chosen document is still offered, unless the user changes
settings, explicitly refreshes, or changes tracks. If the source withdraws
the document, the player chooses an available fallback or clears the lyrics
when the resolver confirms there are none.
Availability rows explain connected/loading/unavailable/disabled/error states.
Refresh requests a new Spotify payload when the extension supports
`refresh_lyrics`; LRCLIB refresh respects its own cache/cooldown.

## Script and timing honesty

No transliteration is performed. “Romanized preferred” selects a candidate only
when the provider marks it romanized or its text is verified Latin script. A Latin
candidate without a provider romanization flag is labelled “romanization
unconfirmed”; a non-Latin fallback is labelled “original/available script.”
“Original” prefers original-script candidates and explains fallback. Mixed-script
documents are classified as mixed, never silently claimed as translated.

Partial line timing is preserved: untimed lines remain untimed while timed lines
keep order and can still drive the active line. Missing timestamps never become
zero. Word spans are accepted only when every word has finite ordered
`startMs`/`endMs`, the word texts reconstruct the line text, and no guessed
syllable timing is created. Word offsets must land on grapheme boundaries. The
maintained Spotify bridge does not emit word timings; LRCLIB synced payloads are
line-timed. The monochrome UI deliberately does not paint karaoke fills even when
genuine word timings exist; they only inform the faster word-timing clock. No
verified current provider supplies word-level timestamps, and the UI labels a
document as `word` only when such payloads actually arrive.

Lyric moment selection distinguishes no track, loading, timed vocal line,
unsynchronized text, unavailable source, source error and instrumental state.
Instrumental is shown only before a known first vocal or at explicit timed blank
or recognized instrumental-marker lines. An ordinary interval between timed
lyrics is not considered an instrumental break. No lyric end time is inferred;
an outro is reported only when an explicit timed gap follows vocals. Missing
lyrics stay unavailable, and loading never masquerades as an instrumental state.

## Artwork, color and graphics (V0.5 monochrome)

Lyrics are monochrome: the active line is bold host-text white; every other
line is host-text dim. No accent, karaoke word fill, distance fade, gradient,
glow or album tint is painted. `lyricColors` returns only the neutral surface,
text and dim tones; the removed `albumColors`/mix helpers, ambient 3×4 swatch
grid, 220 ms tint fade, `LyricCarousel` tiles and word-span fills are deleted.
Control/slider hover and press feedback reuse the host text tone, without a
separate accent color.

The true album-art image is the only color in the UI. `ArtworkView` renders it
with `<image protocol="auto">` (Kitty, then Sixel with resolution, otherwise
colored blocks); analysis fields (accent/ambient) are no longer consumed for
theming. The artwork service still accepts only the fixed
`https://i.scdn.co/image/<40-hex-id>` form (including the normalized
`spotify:image` reference), rejects redirects and other hosts, omits
credentials, and bounds a request to five seconds, 2 MiB and 2048 px. Decoded
images stay in a bounded memory cache and are not persisted. Unsupported
formats and fetch/render failures fall back to metadata text.

Detected protocol support is not proof of correct live rendering: falling back
to blocks is expected on multiplexed or unknown terminals, and the renderer
tests assert block-protocol fallback, not true-color output.
See [live checks](VERIFICATION.md).

## Pointer controls and editor focus

| Context | Input | Action |
|---|---|---|
| Sidebar | Click | Open Music/Lyrics/More/Settings, or operate transport and Like |
| Sidebar | Click or drag seek | Preview while dragging; commit once on release |
| Sidebar | Click or drag volume | Preview and send coalesced updates; finish on release |
| Lyrics | Scroll or drag scrollbar | Browse lyrics without automatic following |
| Lyrics | Click Follow or Settings | Resume follow or open settings; refresh sources from Settings |
| Panel | Click Full or Close | Change presentation or close through the host panel |

Spotify registers no keymap layers. The sidebar is not focusable and handled
pointer presses prevent OpenTUI's autofocus. Host dialogs, the panel container,
and explicit text-entry controls still use OpenCode's native focus and input
behavior. Disabled player actions expose a reason.

## Settings

Settings are persisted under `lyrics-v0.4` and validated on read and write:
provider (`auto`/Spotify/LRCLIB), script preference, timing-versus-script
priority, preview visibility, follow default, reduced motion, neutral lyric
background, artwork visibility/size, volume-row visibility, seek increment and
instrumental indicator, LRCLIB enablement/contact and per-track overrides.
Legacy accent/ambience/strong-emphasis keys still validate so stored settings
survive, but they no longer affect painting. Invalid, extra or credential-like
fields are rejected. Cancel leaves the stored settings unchanged. The dialog
shows current track availability and a disabled provider reason where applicable.

## Performance

- Playback position uses one local clock: 250 ms cadence for line/static lyrics,
  100 ms only when genuine word timings are present. It stops when paused or
  disconnected and caps extrapolation at ten seconds.
- Lyrics virtualize by visible wrapped rows with bounded overscan. Long documents
  do not mount thousands of text nodes.
- Scroll updates from the scrollbar change event; resize uses viewport/box resize
  hooks. There is no continuous polling or terminal redraw loop.
- Lyric documents and source lookups have bounded caches; stale generations are
  suppressed; refresh animations are single timelines, not frame loops.
- The bridge sends progress at most every two seconds and changed paused state
  every five seconds. No artwork or lyric body is written to logs or disk.

## Accessibility and honest states

Named controls, wide mouse targets, text labels in addition to symbols, bounded
dialog labels and explicit disabled reasons replace icon-only or silent
interactions. Native dialog and text-input accessibility is unchanged. Loading,
connected, waiting, unavailable, rate-limited and provider-error states are
distinct. Contrast is checked rather than assumed; reduced motion disables the
lyric transition. Screen-reader semantics are limited by the terminal/OpenCode
host and are not claimed beyond native text output.

## Verification gaps

Automated renderer tests cover grapheme wrapping/clipping, Tamil/Malayalam/
Telugu/Kannada/Devanagari/mixed text, combining marks, emoji/ZWJ, long unbroken
runs, widths 2–120, four responsive modes, the pinned footer under Todo
expansion, five/three/one-line lyric windows, resize, manual/follow scrolling,
track reset, mouse controls, mono active-line contrast, panel routing,
volume/seek drag semantics, complex-script right-edge sentinels and an editor
sentinel in the host-composition fixture. A live OpenCode TUI run in a 200×50
ConPTY verified the pinned footer card, true artwork fallback, five-line window
and compact volume against a real Spotify connection. The renderer still cannot
certify a specific terminal font's shaping, every Spotify CDN payload or audio
output; those remain terminal/user checks.
