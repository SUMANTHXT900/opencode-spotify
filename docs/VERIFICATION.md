# OpenCode Spotify verification

## V0.6.0 distribution verification

Branch `feat/v0.6.0-distribution`, uncommitted. Player behavior is unchanged
from V0.5.7; the new work is installer/distribution only.

| Command from `plugin/` | Result |
|---|---|
| `npm run typecheck` | Passed |
| `npm test` | 161 passed, 0 failed, 0 skipped |
| `npm run test:render` | Passed |
| `npm run test:vt` | Passed |
| `npm run test:artwork` | Passed |
| `node --check spicetify/opencode-spotify-bridge.js` | Passed |
| `npm run build:cli` | Passed (compiled CLI and provisioner) |
| `npm run verify:package` | Passed: pack list, metadata, placeholder secret, isolated install, installed `--version`/`--help`, and packed bridge provisioning against a fake Spicetify config in a temporary APPDATA |
| `npm audit --audit-level=high` | Exit 0; 26 moderate findings remain, no high/critical. CI reports them and fails on high/critical. |
| `actionlint` | Passed for `ci.yml` and the manual `release.yml` |

V0.6.0 tests cover CLI parsing, semantic versions, registry/offline failures,
global registration/de-registration argv, local-development conflicts, Windows
detection fixtures (including Spicetify outside PATH, Store Spotify, duplicate
extension keys), first-time setup/cancellation, missing prerequisites,
maintenance mode, plugin-only and combined updates, downgrade refusal,
repair, uninstall scope, credential separation, dry-run purity, and packed
package assembly. No test installs Spicetify, applies Spicetify, modifies the
developer's Spotify/OpenCode configuration, or publishes to npm.

The packed-package verifier is the strongest packaging evidence: it installs
the real tarball into an isolated prefix and exercises the compiled CLI and
compiled bridge provisioner. It does not prove physical npm-registry install,
PATH changes after a real Spicetify install, Windows reboot persistence, real
Spotify playback, or terminal font behavior.

## V0.5.7 rendering and focus investigation

- V0.5.6 addressed overflow but not stale cells inside the sidebar. In a
  captured OpenTUI stream replayed with the measured Windows cursor advances,
  old Telugu glyphs remained after a Tamil track replaced them. The old test
  checked bounds and did not compare each transition's final framebuffer. A
  separate headless probe confirmed that the renderer omits unchanged spaces
  in cells it believes are already blank.
- The preview now stages a space-only clear inside the previous lyric
  rectangle before swapping the layout. The clear changes the style of the
  blank cells to force the normal scene diff to emit them; the same styled
  underlay stays in place when the new lyric draws so a trailing diff does not
  erase its physical overhang. The public native `frame` event and frame ID
  distinguish the clear from a frame already in progress. A separate VT
  trace showed that resuming after `👩‍💻` at the native width could overwrite
  that glyph; the suffix now begins at its conservative scene offset. No
  raw VT commands, forced whole-screen repaint, or arbitrary delay is used.
  A shaped transition can show a blank frame while it waits for presentation.
- The sidebar used to focus its root explicitly on pointer actions, and
  OpenTUI could also focus it automatically on primary button down. Its
  scoped keymap then took editing keys. The player is now non-focusable,
  handled button/slider presses prevent autofocus, and Spotify no longer
  installs command or keyboard layers. Dialogs and text fields still use
  native OpenCode input. At narrow widths, More opens the complete menu.
- The installed OpenCode 2.3 sidebar slot props contain `sessionID` only.
  The player remains at the top of the pinned footer; this is not vertical
  centering. See the [CLI plugin slot reference](https://opencode.ai/docs/build/plugins/cli)
  and the installed `@opencode/plugin/dist/tui/context.d.ts` contract.

### V0.5.7 automated results

| Command from `plugin/` | Result |
|---|---|
| `npm run typecheck` | Passed |
| `npm test` | 94 passed, 0 failed, 0 skipped |
| `npm run test:render` | Passed: editor typing and focus, pointer actions and outside release, responsive layout with native-section fixtures |
| `npm run test:vt` | Passed: persistent VT replay at 120×40, 100×40 and 80×24; editor sentinels intact, no autowrap, incremental lyric cells match a clean render |
| `npm run test:artwork` | Passed |
| `node --check spicetify/opencode-spotify-bridge.js` | Passed |
| `npm pack --dry-run` | Passed for `opencode-spotify@0.5.7` |
| `npm audit` | Exit 1: unchanged 26 moderate findings; no high or critical findings, no reported fix for the underlying glob/minimatch advisories |

Windows CI prints the full audit report and uses `--audit-level=high` so
high and critical findings fail the job. This threshold does not suppress
moderate advisories; the known moderate baseline remains open for review
when the affected upstream dependencies can be updated.

VT fixtures cover same-script and cross-script updates, long/short and
multiline/single-line transitions, 5→3→1, rapid track changes, seeks, and
lyrics being lost and restored. The clean-render comparison starts with no
lyric history after the host geometry settles; positive lyric anchors prevent
two blank frames from matching. VT replay models the measured Windows widths;
it is not evidence of physical font rendering, actual dialog focus restoration,
or actual terminal resizing. The staged clear applies to the sidebar preview,
not the immersive lyric viewport.

The bridge generation test and the production TUI with deferred fake RPC
exercise A→B→A, including late refreshes and stale seek echoes. The native
input fixture verifies typing across background activity, pointer actions,
resize and repeated mounts. Two independent Muse reviews examined rendering
and state, and host layout and input; blocking findings were corrected and
the related tests rerun. No agent performed live QA.

## V0.5.6 automated and renderer verification (historical)

| Command from `plugin/` | Result |
|---|---|
| `npm run typecheck` | Passed |
| `npm test` | 83 passed, 0 failed, 0 skipped |
| `npm run test:render` | Passed (multiline lyric block, wrapped active, 20→19 transition, host composition, Todo, panel, mouse, keyboard) |
| `npm run test:vt` | Passed (width-model divergence, VT emission bounds at 120×40 and 100×40 across transitions, pause/resume, seek, track switch, ASCII/Indic, instrumental, resize-free) |
| `npm run test:artwork` | Passed (largest-source, 512 px ceiling, no-upscale, cache, native image) |
| `node --check spicetify/opencode-spotify-bridge.js` | Passed |
| `npm pack --dry-run` | Passed. The pack includes source, bridge and installer. |
| `npm audit` | Exit 1. 26 moderate transitive findings, 0 high or critical. No fix reported for the affected glob/minimatch chains. |

Bun is required for the native OpenTUI renderer tests. The automated checks exercise
HMAC, Origin validation, owner/observer behavior, correlation, queue, library,
playlists, search, sources and installer provisioning. The V0.5 checks add cover
decode and native image rendering, URL validation and network limits, caching, lyric moment
selection, word offsets, visible slider focus, outside drag release and one RPC
per mutation. Native fixtures cover 24, 30, 40, 60, 80 and 120 columns, narrow
(26-column) and short (6-row) layouts, a dedicated session-panel fixture (80/120
columns plus narrow-panel art hiding, Esc close, T fullscreen, panel-first routing
with dialog fallback), monochrome lyric assertions (one foreground per line, bold
active, no karaoke splits), and mixed Telugu/English, Devanagari, long words,
combining marks and emoji. The V0.5 snapshots are regenerated from the mono UI;
the legacy carousel fixture was removed with the carousel.

V0.5.1 adds: an authoritative-clock adapter (`playback-sync`: extrapolation,
seek-hold, stale-echo rejection, merge) with unit tests; bridge seek re-sample
until fresh progress plus a stale-echo regression test; debounced track-clear
and same-URI songchange; 2.5 s bridge snapshot cadence; TUI optimistic seek
hold, 2 s playback reconcile and stale-anchor refresh; live volume commits
(~100 ms coalesced) with release-only seek; per-event drag previews, click and
keyboard seeks, cancel paths; interlude/outro gap states with a documented 6 s
display-window heuristic preferring genuine word ends; Tamil/Malayalam/chillu
cluster-intact wrap tests plus a right-edge cell sentinel at all widths;
mono seek-row and transport/art spacing assertions; and removal of the
decorative seekbar flow glyph, side-mounted flank controls and the duplicated
focus header label.

V0.5.2 adds: the required sidebar order (header, navigation, artwork, title,
artist, progress, transport, volume, lyric preview) with a pure `playerLayout`
planner and responsive gap/art caps; fixed 4/9/4 transport widths centered with
a balanced like slot; independent hit targets and hover/focus/active mono states;
an `identity` memo so stale volume samples cannot clear an active drag; separate
drag vs. optimistic vs. server volume state with acknowledgement/timeout and
latest-wins coalesced commits; a `PlaybackSlider` drag guard and failure/recovery
hold; 6-cell time/percent invariants; conjunct-aware virama/pulli rejoining;
ZWSP/BOM/soft-hyphen sanitation; marker-line suppression; moment-derived active
and follow targets during interludes; panel chrome compaction and panel order;
and renderer tests for order, spacing, short-height fallbacks, stale polling,
rapid/click/drag/cancel volume, seek isolation, complex-script panel overflow and
failure recovery.

V0.5.3 adds: the player moved from the scrolling `sidebar.content` slot to the
pinned `sidebar.footer` slot; a pure four-mode planner (roomy/medium/tight/very
tight) with a terminal-derived budget; artwork capped at 9 sidebar rows and
hidden before controls; a framed roomy card with a deliberate gap before lyrics;
compact secondary volume (maximum 12 cells, centered); a five-line synchronized
lyric window with two previous/current/two upcoming rows, three/one-line
fallbacks and marker skipping; balanced fixed-width transport independent of the
Like action; native text truncation plus a four-cell safety reserve (at least
two on each side when centered) for shaped scripts; an artwork-source pipeline
(largest candidate, 512 px
decode, no texture enlargement); and tests for host composition under Todo
growth, five-line active-row centering, component-level player sentinels at 13–
120 columns, editor-region isolation, art caps/no-upscale and bridge candidate
selection. The safety margin now covers Odia, Tibetan and regional-indicator
flags; timed marker-only documents fall back to unsynced text; unsynced windows
scan past marker lines; timed neighbours use timestamp order; and 2–3 column
complex text is blanked rather than forced into a zero-margin row.

[Renderer character frames](V0.5.3_RENDER_SNAPSHOTS.txt) use synthetic data.
The V0.5.2 frames remain as the before-change reference.

Historical screen captures are kept locally rather than checked in because
they can contain live session content. The live capture reconstructed a 200×50 ConPTY screen
(the sidebar footer crop) from the terminal's SGR colors; album art uses the
terminal's colored-block fallback because ConPTY did not negotiate Kitty/Sixel.
The replay applies complete OpenTUI synchronized-output blocks (`CSI ?2026`) so
an in-flight repaint cannot be mistaken for a layout overlap. Minor glyph shapes
depend on the reconstruction fonts, not on the plugin's cell layout.
Color and emphasis assertions use the renderer's span output. To regenerate the
character frames in PowerShell:

```powershell
$env:SPOTIFY_CAPTURE_FRAMES = '1'
bun --preload @opentui/solid/preload tests/render-layout.tsx
Remove-Item Env:SPOTIFY_CAPTURE_FRAMES
```

## Live checks

### V0.5.3 live OpenCode TUI run

A real OpenCode 2.3.2 TUI session was launched in a 200 × 50 Windows ConPTY with
an ignored local `opencode.jsonc` (`plugins: ["./plugin"]`). No installer,
`spicetify apply`, credential read or model request was performed. The running
Spotify client was already authenticated through the existing bridge.

Observed in the live screen:

| Feature | Observed |
|---|---|
| Placement | The player rendered in the pinned sidebar footer, below the conversation scroll area and above the host footer location. |
| Hierarchy | `Spotify ● Connected`, Music/Lyrics/More, framed card, track and artist, progress, transport, compact volume, then five lyric rows. |
| Artwork | The live true-color cover fallback drew as colored cells at approximately 8–9 rows, not full-sidebar height. |
| Progress | The progress row appeared above transport. |
| Volume | The volume control was shorter than the seekbar and on its own row. |
| Lyrics | Five lines with the current lyric centered and the previous/upcoming lines dimmed. |
| Todo isolation | Clicked the live Todo header in the current session: it expanded to nine items, then collapsed to `Todo (9 remaining)`. The player card, transport, volume and five lyric rows stayed at the same screen position and remained fully visible. The synthetic fixture independently opens Todo heights 2 and 18 and asserts the same invariant. |
| Containment | The fixture places Tamil lyrics in the player and an `EDITOR` sentinel in the adjacent editor region; every player row keeps its left/right sentinel and leaves the editor region intact at 24–120 columns. |

The live song's lyric payload was English/romanized, so it did not exercise
Tamil shaping on the real terminal in this run. Tamil, Malayalam, Telugu,
Kannada and Devanagari containment is covered by the native host-composition and
component fixtures. Terminal font shaping, Kitty/Sixel output, audio
responsiveness and every possible Spotify CDN payload still require the user's
terminal/audio check.

### Earlier V0.5 live observations

OpenCode 2.3.0 and the running Spotify Desktop client were tested with the
existing installed bridge and the V0.5 project copy. Authentication succeeded and
a second standalone OpenCode process mirrored the active track and position.

| Feature | Observed |
|---|---|
| Album cover | The actual Spotify cover downloaded and drew as colored blocks inside the OpenCode sidebar. |
| Play/pause and progress | The sidebar play button started playback and the same control paused it. Playback-clock motion appeared while playing. |
| Seek | Hover changed the thumb and dragging changed the authoritative Spotify position. |
| Volume | Dragging changed the authoritative Spotify volume. |
| Lyrics | Current and adjacent timed lyrics rendered and updated after live seeks. |
| Settings | The gear opened Spotify Settings inside OpenCode. |
| Integration | Sidebar and MCP/conversation content shared the host layout. |

> The earlier observations predate the footer card, five-line window and V0.5.3
> containment work. They are retained as history; the V0.5.3 live run above is
> the current placement/visual evidence.

## V0.5.7 user live QA — Windows Terminal

Run these checks in the Windows Terminal profile and font that showed the
overlapping lyrics. The automated VT playback is a model, not a physical
Windows Terminal rendering test.

1. Play a Tamil track with long wrapped lyrics, then a Malayalam track. Watch
   several same-track line changes. Seek backward and forward; rapidly change
   tracks and include an English track and one with unavailable lyrics. After
   each transition, look for old glyphs on the same row and in rows the new
   lyric no longer occupies. The editor and host footer should not change.
2. Type a draft in the OpenCode editor while lyrics advance and tracks change.
   Click Play/Pause, Previous/Next, Like, seek, and volume with the mouse; then
   type again without refocusing the editor. Verify no keystrokes disappear.
3. Open Music, Lyrics, More, and Settings with the mouse, exercise their
   actions, then close or go back. Type in the editor again. Search text entry
   and native OpenCode dialog behavior should still work.
4. Repeat at 120×40, 100×40, and a shorter height; expand/collapse Context,
   MCP, and Todo as available. Check that the pinned player stays above the
   host footer, controls remain usable, and neither player nor lyrics overlap
   native sections. The player is not vertically centered.
5. If anything remains visible after a transition, note the before/after track,
   timestamp, action, dimensions, terminal version, and font. Include a pair
   of screenshots without credentials or unrelated editor content.

## Historical manual checks (before V0.5.7)

1. **Done live:** opened a wide session, expanded the nine-item Todo list and
   collapsed it again. The footer card, transport, volume and lyric window stayed
   in place. **Still user-side:** resize
   through roughly 120/80/60/40/24 columns and tall/short heights; confirm the
   roomy → medium → tight → very-tight transitions reduce art and lyrics before
   controls on the user's terminal/font.
2. Open the Now Playing panel from the palette; check art, transport, immersive
   lyrics, T fullscreen and Esc close. Repeat on a narrow terminal: art hides,
   transport stays.
3. Seek, pause, resume and change tracks on a playing song: the five-line window
   must keep the current line centered, progress must follow within ~2 s with no
   stuck highlight, no blank gap and no jump backward. Repeat while paused for
   volume/seek edits from the Spotify app.
4. Play a track with a long mid-song instrumental gap and one with Tamil or
   Malayalam lyrics: expect the neutral ♪ · · · indicator (frozen while
   paused), then the next vocal line, with no overflow past the right edge.
5. Drag the seek bar: the thumb and time must track every move with one commit
   on release; drag volume: audible steps while moving with a final commit;
   press Esc mid-drag: nothing further is sent. Confirm the seek row has no
   shimmer glyph.
6. Check Next and Previous and retest Like/Unlike on a track with a known initial
   saved state. Test an unavailable action to check its feedback.
7. In Spotify Settings, confirm no album-color or progress-animation controls
   remain; check Reduced Motion, cover on/off and neutral background.
8. Run on a terminal with confirmed Kitty or Sixel support and check the reported
   protocol and the drawn image. Resize with Todo/MCP entries present.
9. See the existing protocol and security audit for installation and trust checks.
   The installer inspection is `pwsh -NoProfile -File scripts/install-extension.ps1`.
   The `-Install` option requests replacement approval before offering to apply.


## Implementation inventory

- Added `ArtworkView`, `ArtworkService`, `PlaybackSlider`, `slider.ts`,
  `LyricCarousel` and `InstrumentalIndicator`. Added native artwork and
  carousel fixtures, test runners, slider assertions and captured frames.
- Updated `MiniPlayer`, `LyricsView`, `LyricsSettings`, `Music`, shared player
  actions/primitives/colors, lyric normalization/settings, metadata-validation
  comments and the TUI playback clock. Updated existing lyric and renderer
  tests, both READMEs, package metadata and the architecture, design, feature,
  verification and roadmap docs.
- The V0.4 mini player capped its height at 22 rows, selected one lyric,
  drew a progress string and retained cover metadata without a renderer. V0.5
  measures host space, prioritizes controls and navigation, animates a virtual
  wrapped-row carousel and uses OpenTUI image and pointer support.
- Spicy Lyrics research drew on the antislop and antislop-ui guidance,
  animation-performance, animation review/opportunity guidance and its public
  layout, lyric emphasis and artwork behavior. The native OpenTUI code is original.
- Sub-agents used GPT-6 Luna for reference and lyric-state work, and GPT-6.1 Terra
  for the lyric renderer and slider/artwork renderer checks. The lead integrated
  the player, settings, artwork loader and verification.
- V0.5 monochrome redesign (uncommitted): deleted `LyricCarousel` (plus its
  fixtures), `albumColors`/mix tinting and the ambient swatch grid; rewrote
  `MiniPlayer` as a restrained status with a static two-line preview; rewrote
  `LyricsView` in monochrome (bold-white active, dim others, no karaoke
  spans); added `NowPlayingPanel` on the `session.panel` slot with
  panel-first/dialog-fallback routing in `Music`, `spotify.panel` palette
  command and Music-menu entry; removed accent/ambience/emphasis rows from
  `LyricsSettings` (schema keys retained for stored-config compatibility).
  Renderer fixtures now assert one foreground per lyric line, bold active
  state, panel Esc/T behavior and 80/120-column plus narrow layouts.
- V0.5.2 UI/UX polish (uncommitted): added `ui/player-layout.ts` (pure row
  planning, art caps, gap slots), `ui/transport.ts` (fixed 4/9/4 widths),
  `services/playback-ui.ts` (drag/optimistic/server volume, ack and label
  invariants) and their tests. Reordered the sidebar and panel, removed
  side-mounted transport and the progress-flow glyph, added nav active
  underlining, standardized 6-cell time/percentage widths, compacted panel
  chrome, fixed zero-width/virama conjunct wrapping, marker suppression,
  moment-derived follow targets, and test coverage for volume/seek/stale
  polling, order/spacing, jitter, preview stability, complex-script lyrics and
  panel overflow. Package version was 0.5.2.
- V0.5.3 responsive/containment milestone (uncommitted): moved the player to
  `sidebar.footer`; rewrote `player-layout` as a four-mode card planner with a
  terminal-derived budget; added `lyrics-window.ts` for the five-line view;
  added compact volume geometry; added native truncation + shaped-script right
  margins; raised artwork decode to 512 px with largest-candidate selection and
  no-upscale rendering; added host-composition/Todo, player-sentinel,
  five-line, transport-balance and artwork regression tests; and ran a real
  OpenCode 2.3.2 TUI at 200 × 50. Package version is 0.5.3.
- V0.5.4 adaptive positioning (uncommitted, Muse Spark 1.3 Contributor only):
  kept the single pinned `sidebar.footer` claim after host-API research showed
  both sidebar slots publish `sessionID` only, so Todo/MCP/Context expansion is
  not observable and dynamic content↔footer switching would remount on every
  toggle. Added `resolvePlayerBudget` (two-row hysteresis) plus a 200 ms
  terminal settle before the budget recomputes; pure `playerLayout` stays
  deterministic. Added `slot-placement` tests (exactly one footer claim, single
  subscription, timer/state lifecycle), hysteresis/mode-stability unit tests,
  and an in-place 20→19 render transition test proving one player, surviving
  transport/volume, and 5→3 lyric degradation without remount. Package version
  is 0.5.4. No live TUI QA was performed by the agent; manual verification is
  the user's responsibility.
- V0.5.5 multiline lyrics + positioning record (uncommitted, Muse Spark 1.3
  Contributor only): semantic lyric window is unchanged (2 prev + active + 2
  upcoming, marker skipping, instrumental/unsynced handling); each semantic
  line now wraps to physical rows (`wrapLyricLines`, same width arithmetic as
  `CellText`) and `distributeLyricRows` gives the focus line every row it
  needs, yields dim context rows first, centers with balanced padding, and
  keeps the block height fixed at the tier budget so wrapped-height changes
  never bounce the player. An over-budget focus line falls back to a bounded
  scroll viewport; blank padding slots never consume rows. Added Indic/ZWJ/
  no-space wrap tests, distribution/centering/overflow unit tests, sidebar
  Indic render tests with sentinel + right-margin + no-`�` assertions, a
  single-row viewport test, and V0.5.5 character frames. Positioning: four
  Muse-only agents plus host `.d.ts` reads confirmed vertical centering is not
  implementable through the supported API (no section-height signal; footer
  flex centers only within its own content height), so the single pinned footer
  with hysteresis budgets is retained and documented as the closest safe
  alternative. Package version is 0.5.5. No live TUI QA was performed by the
  agent; manual verification is the user's responsibility.
- V0.5.6 native Unicode rendering fix (uncommitted, Muse Spark 1.3 Contributor
  only). Root cause, proven by ConPTY cursor-position (DSR 6n) probes on Windows:
  the terminal advances Indic combining sequences, viramas, ZWJ and variation
  selectors cell-by-cell (effectively UTF-16 code units) while both the Unicode
  and wcwidth tables count them as zero-width. Measured examples (unicode /
  wcwidth / ConPTY advance): Tamil க்ஷ 2/2/3, Malayalam ക്ഷ 1/2/3, Devanagari क्ष
  2/2/3, ZWJ emoji 2/4/5. Two independent mechanisms push glyphs past the
  sidebar's right edge: (a) a wrapped/truncated row that fits under either table
  can still overrun its box under the terminal's advance, and (b) native
  centering computes its leading pad and fixed-width trailing fill with the host
  width table, so the same shaped row starts too far right and emits `W - N`
  fill cells after content that already advances `M` cells — a row that fills
  the box overruns by `M - N` even when the content alone would fit. The
  physical cursor then crosses the sidebar edge; autowrap (DECAOM, never
  disabled upstream — see opentui#1187) drops it at column 0 of the next line
  (the editor area), and the incremental diff treats those cells as clean
  forever. Upstream findings: opentui#1187 (diff desync + autowrap spill, ?7l
  fix never merged) and opencode#61245 ("Windows Terminal drawing characters at
  a different width than OpenCode measures"); installed 0.9.1-era fixes do not
  cover this; no public full repaint API exists (only resize-with-size-change
  forces one). Fix: `cellMeasure` now takes the max of the live renderer method,
  wcwidth, and the UTF-16 unit count, so every wrapped/truncated row fits under
  all three models. For single-row shaped text (`truncate` plus the
  `cellSafety` reserve — the lyric/title path), `CellText` also centers
  manually with `cellMeasure` and emits only leading pad + content with the row
  foreground, sized to the text's native width: no foreground fixed-width
  trailing fill, so the terminal's `M - N` overhang lands in the reserved
  margin inside the sidebar instead of past its edge. The 4-cell `cellSafety`
  reserve remains for residual font-shaping overhang; ASCII keeps the
  pre-V0.5.6 fixed-width native path. New `tests/render-vt.tsx` +
  `tests/vt-emission.test.ts` (`npm run test:vt`): width-model divergence
  checks plus a full VT emission-bounds harness (real CliRenderer, captured
  stdout, parsed CUP/printable stream) asserting no out-of-rect writes across
  lyric transitions, pause/resume, seeks, track switches, ASCII/Indic swaps and
  instrumental gaps — at 120×40 and 100×40 — plus positive assertions that the
  stream is non-trivial, no autowrap was needed, and the sidebar rendered
  header and Indic lyric content. The parser advances each grapheme by the
  production `cellMeasure` (the max, i.e. an upper bound on the terminal
  advance pinned by the probe table), so a row that would overrun under any
  measured model is caught. Manual control experiments (run ad hoc during
  V0.5.6; not part of the shipped test): with unicode-only measurement the
  harness fails with a real terminal overrun at the screen's last column; with
  max() measurement but the pre-V0.5.6 native centering/fill path it still
  fails at column 119. Both variants pass with the final fix. Package version
  is 0.5.6. No live TUI QA was performed by the
  agent; manual verification is the user's responsibility.
