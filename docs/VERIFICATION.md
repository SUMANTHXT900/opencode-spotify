# V0.5 verification

## Automated and renderer verification

| Command from `plugin/` | Result |
|---|---|
| `npm run typecheck` | Passed |
| `npm test` | 51 passed, 0 failed, 0 skipped |
| `node --check spicetify/opencode-spotify-bridge.js` | Passed |
| `npm pack --dry-run` | Passed. The pack includes source, bridge and installer. |
| `npm audit` | Exit 1. 26 moderate transitive findings, 0 high or critical. No fix reported for the affected glob/minimatch chains. |

Bun is required for the native OpenTUI renderer tests. The automated checks exercise
HMAC, Origin validation, owner/observer behavior, correlation, queue, library,
playlists, search, sources and installer provisioning. The V0.5 checks add cover
decode and colored cells, URL validation and network limits, caching, lyric moment
selection, word offsets, visible slider focus, outside drag release and one RPC
per mutation. Native fixtures cover 24, 30, 40 and 60 columns, a six-row allocation,
an allocation above 22 rows, and mixed Telugu/English, Devanagari, long words,
combining marks and emoji. The carousel fixture checks lyric context, instrumental
frames, reduced motion and the return to vocals.

[Renderer character frames](V0.5_RENDER_SNAPSHOTS.txt) use synthetic data.
Color and emphasis assertions use the renderer's span output. To regenerate the
character frames in PowerShell:

```powershell
$env:SPOTIFY_CAPTURE_FRAMES = '1'
bun --preload @opentui/solid/preload tests/render-layout.tsx
Remove-Item Env:SPOTIFY_CAPTURE_FRAMES
```

## Live checks

OpenCode 2.3.0 and the running Spotify Desktop client were tested with the existing
installed bridge and the V0.5 project copy. Authentication succeeded and a second
standalone OpenCode process mirrored the active track and position.

| Feature | Observed |
|---|---|
| Album cover | The actual current Spotify cover downloaded, decoded to 160 × 160 and drew as colored blocks inside the OpenCode sidebar. |
| Play/pause and progress | The sidebar play button started playback and the same control paused it. Playback-clock motion appeared while playing. |
| Seek | Hover changed the thumb and dragging changed the authoritative Spotify position. |
| Volume | Dragging changed the authoritative Spotify volume. |
| Lyrics | Current and adjacent timed lyrics rendered and updated after live seeks. |
| Settings | The gear opened Spotify Settings inside OpenCode. |
| Palette | The OpenCode sidebar rendered an album-tinted background. |
| Integration | Sidebar and MCP/conversation content shared the host layout, with navigation visible on the 24-row follow-up launch. |

Next/Previous and Like/Unlike have automated and native renderer coverage. Their
live mutations, the optional spatial artwork wash, live Telugu text shaping,
continuous instrumental-to-vocal motion and Kitty/Sixel output are pending.
Paused instrumental behavior, Unicode boundaries and motion transitions are
covered by synthetic native renderer fixtures. Rendering depends on terminal
graphics capabilities and font support.

Installed bridge and credentials were used as-is. The test did not run the installer
or restart Spotify. The two local verification processes used a synthetic OpenCode
session without a model request.

## Manual steps for remaining live coverage

1. Open a session and show its sidebar if the terminal starts with it hidden.
2. Check Next and Previous and retest Like/Unlike on a track with a known initial
   saved state. Test an unavailable action to check its feedback.
3. Play a track with explicit timed instrumental entries and another with Telugu
   lyrics. Observe the carousel, the dots, the return to vocals and wrapping.
4. In Spotify Settings, select Soft album artwork in an RGB terminal. Check
   Reduced Motion, then switch back to the preferred appearance.
5. Run on a terminal with confirmed Kitty or Sixel support and check the reported
   protocol and the drawn image. Resize with Todo/MCP entries present.
6. See the existing protocol and security audit for installation and trust checks.
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
