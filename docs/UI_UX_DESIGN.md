# V0.5 UI, lyrics and source design

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
theme surfaces and one contrast-checked accent. Space separates logical lyric
lines; bold and foreground contrast replace browser-scale typography. Keyboard
actions respond immediately. Automatic lyric movement may transition briefly;
the surrounding OpenCode layout never animates. Reduced motion is explicit.

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
| `src/tui.tsx` | Slots, persistent `lyrics-v0.4` settings, revision-gated state, lyric hydration, adaptive playback clock, palette commands and lifecycle cleanup. |
| `src/components/MiniPlayer.tsx` | Responsive sidebar hierarchy, transport/seek/volume/like controls, lyric preview and Music/Lyrics/Settings navigation. |
| `src/components/Music.tsx` | SDK dialog hierarchy for playback, queue, playlists/folders, library, search and lyrics. |
| `src/components/LyricsView.tsx` | Wrapped, virtualized lyrics; active-line emphasis; follow/manual scrolling; refresh/settings actions. |
| `src/components/LyricsSettings.ts` | Native provider, script, priority, display, motion, background, accent and LRCLIB dialogs. |
| `src/ui/layout.ts` | Grapheme-safe wrapping/truncation, lyric block layout, follow offsets and visible-row selection. |
| `src/ui/primitives.tsx` | Measured text, named controls, focus handling, terminal dimensions and control-key navigation. |
| `src/ui/colors.ts` | Theme-derived neutral lyric surface and one contrast-guarded accent. |
| `src/ui/player-actions.ts` | Capability-aware player actions with disabled reasons. |

There is one sidebar surface, not simulated tabs. Music remains a dialog
hierarchy: Enter opens/actions, Escape goes back/closes, and every dialog includes
a bounded Back row. Queue, playlist folders, paged tracks, search and lyrics reuse
the same input model.

## Unicode measurement and clipping

All renderer text is measured with
`measureEditText(..., { widthMethod: "unicode" })` and segmented with
`Intl.Segmenter` grapheme clusters. Text is sanitized of terminal escapes,
directional overrides and unsafe control characters before display. A leading
combining mark receives a dotted circle so it cannot attach to a neighbouring
cell. Zero-width-only clusters are made visible rather than silently occupying no
space.

Wrapping happens before rendering. Every physical row is proved to fit the
available columns, then rendered with `wrapMode="none"` inside clipped
containers. This prevents OpenTUI's own wrapping from disagreeing with lyric
row accounting. A two-cell grapheme in a one-column viewport is replaced rather
than split, and no emoji ZWJ sequence, combining sequence or Indic cluster is
sliced. Truncation measures the ellipsis with the same cell metric.

The lyric viewer virtualizes by wrapped visual row, not logical lyric index. It
renders one spacer before and after the visible window, so variable-height lines
and long unbroken words cannot desynchronize scrolling. Width changes recompute
blocks and preserve the relative visible row in manual mode. Track changes reset
scroll and follow state.

## Follow, manual and motion

Follow mode selects the active line from genuine line timestamps using binary
search. Scroll targets use actual wrapped-row offsets with a bounded inset, so a
line is not clipped on short terminals. Up/Down, PageUp/PageDown, Home/End or
mouse wheel enter manual mode and stop pending motion; **F** or the Resume follow
control returns to the active line. Playback continuing while manual never snaps
the view back.

Motion is a single 180 ms, 20 fps renderer timeline for active-line emphasis and
scroll. It is cancellable, skips large jumps, and is replaced by an immediate jump
when reduced motion is enabled. Emphasis always settles back to the readable base
state. The active line keeps a restrained accent mix; the currently sung word can
use the full accent only when a document contains verified word timings.

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
A per-track override wins. Selection does not change while playback continues
unless the user changes settings, explicitly refreshes, or the track changes.
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
syllable timing is created. The maintained Spotify bridge does not emit word
timings; LRCLIB synced payloads are line-timed. Therefore karaoke-style word
highlighting is implemented but **no verified current provider supplies word-level
timestamps**, and the UI labels a document as `word` only when such payloads
actually arrive.

Lyric moment selection distinguishes no track, loading, timed vocal line,
unsynchronized text, unavailable source, source error and instrumental state.
Instrumental is shown only before a known first vocal or at explicit timed blank
or recognized instrumental-marker lines. An ordinary interval between timed
lyrics is not considered an instrumental break. No lyric end time is inferred;
an outro is reported only when an explicit timed gap follows vocals. Missing
lyrics stay unavailable, and loading never masquerades as an instrumental state.

## Artwork, color and graphics

Lyrics use a neutral dark or light surface derived from host foreground
luminance. One accent comes from the host primary action colour or a validated
six-digit custom accent. Contrast is checked against the lyric surface before use
(4.5:1 target); a failing accent falls back to the readable text colour.

`ArtworkView` renders the cover from the original image proportions; its placement
in the player is being integrated. The artwork service
accepts only the fixed `https://i.scdn.co/image/<40-hex-id>` form (including the
normalized `spotify:image` reference), rejects redirects and other hosts, omits
credentials, and bounds a request to five seconds, 2 MiB and 2048 px. Decoded
image and ambient color data remain in a bounded memory cache; they are not
persisted. Unsupported image formats and fetch/render failures fall back to
metadata text.

When attached, OpenTUI 0.9 image rendering uses `protocol="auto"`: detected Kitty graphics are
preferred, then Sixel, otherwise the renderer uses colored blocks. The requested
terminal cell dimensions bound output while the image retains its aspect ratio.
Detected protocol support is not proof of correct live rendering.

Artwork analysis provides an accent and a 4×3 ambient color sample. Album
colors tint the sidebar. Soft album artwork applies the sampled wash behind
the controls on RGB terminals. Transport and lyric text retain their contrast.
Reduced Motion makes palette updates immediate. See [live checks](VERIFICATION.md).

## Shortcuts and controls

| Context | Input | Action |
|---|---|---|
| Sidebar | Tab / Shift+Tab | Move through visible controls |
| Sidebar | Enter / Space | Activate focused control or explain disabled state |
| Sidebar | Left / Right | Seek −10 s / +10 s when supported |
| Slider | Drag | Update local seek/volume preview while dragging; submit one RPC on release |
| Sidebar | Escape | Leave player focus |
| Lyrics | Up / Down | Scroll one visual row; leaves follow mode |
| Lyrics | PageUp / PageDown | Scroll one viewport |
| Lyrics | Home / End | Jump to start/end; leaves follow mode |
| Lyrics | F | Resume follow |
| Lyrics | S | Open Lyrics Settings |
| Lyrics | R | Refresh Spotify lyrics and source candidates |
| Lyrics | Tab / Enter | Focus/activate Resume follow or Settings |
| Palette | Spotify commands | Music, Lyrics, Settings, Queue, Search, transport, shuffle, repeat, like and refresh |

Mouse controls mirror keyboard actions: transport, seek bar, volume, like,
navigation, lyric scroll, Resume follow and Settings. Disabled actions expose a
reason instead of failing silently. No global shortcut is overridden outside the
focused player/lyrics layer.

## Settings

Settings are persisted under `lyrics-v0.4` and validated on read and write:
provider (`auto`/Spotify/LRCLIB), script preference, timing-versus-script
priority, preview visibility, follow default, reduced motion, background surface,
custom accent, LRCLIB enablement/contact and per-track overrides. Invalid,
extra or credential-like fields are rejected. Cancel leaves the stored settings
unchanged. The dialog shows current track availability and a disabled provider
reason where applicable.

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

Named controls, wide mouse targets, visible focus markers, text labels in addition
to symbols, keyboard alternatives for every mouse action, bounded dialog labels
and explicit disabled reasons replace icon-only or silent interactions. Loading,
connected, waiting, unavailable, rate-limited and provider-error states are
distinct. Contrast is checked rather than assumed; reduced motion disables the
lyric transition. Screen-reader semantics are limited by the terminal/OpenCode
host and are not claimed beyond native text output.

## Verification gaps

Automated renderer tests cover grapheme wrapping/clipping, Telugu/Devanagari/
mixed/romanized text, combining marks, emoji/ZWJ, long unbroken runs, 24/30/40/60
columns, resize, manual/follow scrolling, track reset, mouse controls, word-span
color changes, settings Save/Cancel and short player/lyrics layouts. They cannot
certify a specific terminal font's shaping, live Spotify CDN/API behavior,
installed-client visuals or audio output. Live validation remains pending until
the approved extension update and manual checklist are completed.
