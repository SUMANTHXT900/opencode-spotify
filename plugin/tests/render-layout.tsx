import assert from "node:assert/strict"
import { measureEditText, getTimelineEngine, parseColor, TextAttributes, type Renderable, type ScrollBoxRenderable, type TerminalCapabilities } from "@opentui/core"
import { testRender, useRenderer } from "@opentui/solid"
import { createSignal } from "solid-js"
import { wrapCells, lyricLayout, truncateCells, clusters, displayText, cellSafety } from "../src/ui/layout.ts"
import { CellText } from "../src/ui/primitives.tsx"
import { MiniPlayer } from "../src/components/MiniPlayer.tsx"
import { LyricsView } from "../src/components/LyricsView.tsx"
import { NowPlayingPanel } from "../src/components/NowPlayingPanel.tsx"
import { normalizeLyrics, emptyLyrics } from "../src/services/lyrics.ts"
import { defaultLyricsSettings } from "../src/services/lyrics-source.ts"
import { initialState } from "../src/services/state.ts"
import { commands, normalizeQueue, normalizePage } from "../src/services/validation.ts"
import type { MusicProps } from "../src/components/Music.tsx"
import type { Context, KeymapLayer } from "@opencode/plugin/tui/context"
import { lyricColors, contrast, graphicsCapabilities } from "../src/ui/colors.ts"
import { playerBudget, playerLayout } from "../src/ui/player-layout.ts"
import { writeFileSync } from "node:fs"
import { lyricsSettingsDialog } from "../src/components/LyricsSettings.ts"
import { musicActions } from "../src/components/Music.tsx"
import type { LyricsSettings } from "../src/services/lyrics-source.ts"

const measure = (s: string) => measureEditText(s, { widthMethod: "unicode" })
// Kannada/Tamil roomtimes split conjuncts at the virama; the layout must rejoin
// them before wrapping so a row never ends mid-conjunct.
for (const conjunct of ["ಕ್ಷ", "க்ஷ", "క్ష", "ക്ഷ", "क्ष"]) {
  assert.equal(clusters(conjunct).length, 1, `conjunct rejoined: ${conjunct}`)
  assert.equal(clusters(conjunct).join(""), conjunct)
}
for (const sample of ["ಕ್ಷ".repeat(40), "க்ஷ".repeat(40)]) {
  for (const width of [1, 2, 3, 4, 8, 24]) {
    const rows = wrapCells(sample, width, measure)
    assert.ok(rows.every((row) => measure(row) <= width))
    if (width < 4) continue // impossible clusters are intentionally replaced, not split
    const boundaries = new Set<number>([0])
    let offset = 0
    for (const cluster of clusters(sample)) { offset += cluster.length; boundaries.add(offset) }
    let cursor = 0
    for (const row of rows) {
      assert.equal(sample.indexOf(row, cursor), cursor, `row starts on a cluster boundary at ${width}`)
      assert.ok(boundaries.has(cursor), `row start is a cluster boundary at ${width}`)
      cursor += row.length
      assert.ok(boundaries.has(cursor), `row end is a cluster boundary at ${width}`)
    }
    assert.equal(cursor, sample.length)
  }
}
assert.ok(!displayText("\x1b]8;;https://example.test\x07link\x1b]8;;\x07").includes("8;;"), "OSC-8 escapes stripped")
assert.ok(!wrapCells("日本語\u200bテキスト", 3, measure).join("").includes("\u200b"), "ZWSP removed")
assert.ok(!wrapCells("日本語\u200bテキスト", 3, measure).join("").includes("◌"), "ZWSP is not a dotted circle")
assert.ok(!wrapCells("x\ufeffy\u00adz", 10, measure).join("").includes("\ufeff"), "BOM removed")
assert.ok(!wrapCells("x\ufeffy\u00adz", 10, measure).join("").includes("\u00ad"), "soft hyphen removed")
assert.ok(wrapCells("ab \u0301cd", 10, measure).join("").includes("◌́"), "orphan mark gets a base")
assert.equal(cellSafety("plain ASCII title"), 0)
for (const complex of ["தமிழ்", "മലയാളം", "క్ష", "ಕ್ಷ", "क्ष", "କମ", "ཀ", "e\u0301", "👩‍💻", "🇮🇳"]) {
  assert.equal(cellSafety(complex), 4, `shaped-script right margin: ${complex}`)
}
const samples = [
  "తెలుగు పదాలు మన పరీక్ష కోసం మాత్రమే రాసిన పంక్తులు ".repeat(5),
  "यह केवल परीक्षण के लिए लिखी गई पंक्ति है ".repeat(5),
  "తెలుగు and English కలిసి testing ".repeat(5),
  "mana pariksha kosam oka podavaaina pankti ".repeat(5),
  "e\u0301".repeat(60), "👩‍💻👨‍👩‍👧‍👦界".repeat(30),
  "క్ష".repeat(80), "longwordwithoutspaces".repeat(20),
  "\u0301\u0308 combining marks at the left edge", "తెలుగు \u200d mixed joins 👩‍💻",
  "മലയാളം ഗാനം പരീക്ഷ വരികൾ അവൻപാടുന്നു ".repeat(5),
  "தமிழ் பாடல் சோதனை வரிகள் தமிழ்மொழி ".repeat(5),
  "അവൻപാടുന്നുകൃഷ്ണൻ".repeat(12),
  "தமிழ்மொழிபாடல்வரிகள்".repeat(12),
  "दृष्टिकोणसंयुक्ताक्षरपरीक्षण ".repeat(5),
]
for (const width of [1, 2, 24, 30, 40, 60, 80, 120]) {
  for (const sample of samples) {
    const rows = wrapCells(sample, width, measure)
    assert.ok(rows.length > 0)
    for (const row of rows) assert.ok(measure(row) <= width, JSON.stringify({ row, width }))
    assert.ok(measure(truncateCells(sample, width, measure)) <= width)
  }
}
// Unbroken complex-script runs must survive wrapping cluster-intact: rows
// rejoin exactly to the original at any width that fits every cluster.
for (const sample of ["അവൻപാടുന്നുകൃഷ്ണൻ".repeat(12), "தமிழ்மொழிபாடல்வரிகள்".repeat(12), "ക്ഷ".repeat(80)]) {
  for (const width of [2, 24, 30, 40, 60, 80, 120]) {
    assert.equal(wrapCells(sample, width, measure).join(""), sample, `cluster-intact at ${width}`)
  }
}
const grouped = lyricLayout(samples.map((text, i) => ({ text, startMs: i * 1000 })), 24, measure)
assert.ok(grouped[1]!.top >= grouped[0]!.height)
assert.ok(grouped[0]!.rows.length > 1)
console.log("native cell layout passed")

let resizeWidth!: (value: number) => void
function LayoutProbe() {
  const renderer = useRenderer()
  const [width, setWidth] = createSignal(24)
  resizeWidth = setWidth
  return <box flexDirection="row" width="100%" height="100%">
    <text width={5} height="100%">{"LLLLL\n".repeat(20)}</text>
    <box width={width()} height="100%" flexShrink={0} overflow="hidden" minWidth={0} zIndex={1}>
      <CellText renderer={renderer} width={width()} text={samples[0]! + "\nEND"} />
    </box>
    <text width={5} height="100%">{"RRRRR\n".repeat(20)}</text>
  </box>
}
const probe = await testRender(() => <LayoutProbe />, { width: 80, height: 20 })
try {
  for (const width of [24, 30, 40, 60]) {
    resizeWidth(width)
    await probe.flush()
    for (const line of probe.captureCharFrame().split("\n").slice(0, 19)) {
      assert.ok(line.startsWith("LLLLL"), `left boundary: ${line}`)
      assert.ok(line.includes("RRRRR"), `right boundary: ${line}`)
    }
    assert.ok(probe.captureCharFrame().includes("END"), "last wrapped row is not lost")
  }
  for (const width of [80, 120]) {
    resizeWidth(width)
    await probe.flush()
    assert.ok(probe.captureCharFrame().includes("END"), `last wrapped row survives at ${width}`)
  }
} finally { await probe.dispose() }
console.log("native cell-boundary rendering passed")

// Right-edge sentinel: complex-script lines never leak past their box.
{
  const complex = [
    "മലയാളം ഗാനം പരീക്ഷ " + "അവൻപാടുന്നുകൃഷ്ണൻ".repeat(4),
    "தமிழ் பாடல் சோதனை " + "தமிழ்மொழிபாடல்வரிகள்".repeat(4),
    "పరీక్ష శీర్షిక " + "క్ష".repeat(40),
  ].join("\n")
  let setSentinelWidth!: (n: number) => void
  function Sentinel() {
    const renderer = useRenderer()
    const [width, updateWidth] = createSignal(24)
    setSentinelWidth = updateWidth
    return <box flexDirection="row" width="100%" height="100%">
      <text width={5} height="100%">{"LLLLL\n".repeat(20)}</text>
      <box width={width()} height="100%" flexShrink={0} overflow="hidden" minWidth={0}>
        <CellText renderer={renderer} width={width()} text={complex} />
      </box>
      <text width={5} height="100%">{"RRRRR\n".repeat(20)}</text>
    </box>
  }
  const setup = await testRender(() => Sentinel(), { width: 130, height: 20 })
  try {
    for (const width of [24, 30, 40, 60, 80, 120]) {
      setSentinelWidth(width)
      setup.resize(width + 10, 20)
      await setup.flush()
      for (const line of setup.captureCharFrame().split("\n").slice(0, 12)) {
        assert.ok(line.startsWith("LLLLL"), `left boundary: ${line}`)
        const marker = line.indexOf("RRRRR")
        assert.ok(marker > 0, `right boundary: ${line}`)
        const content = line.slice(5, marker)
        assert.ok(measure(content.trimEnd()) <= width, `no right-edge leak at ${width}: ${line}`)
        assert.ok(!content.includes("�"), `no impossible cluster at ${width}`)
      }
    }
  } finally { await setup.dispose() }
  console.log("complex-script right-edge sentinel passed")
}

const uri = "spotify:track:1234567890123456789012"
const synthetic = normalizeLyrics({ uri, sync_type: "LINE_SYNCED", lines: Array.from({ length: 100 }, (_, index) => ({
  text: `పరీక్ష ${index} తెలుగు పదాలు and English synthetic text for wrapping`,
  startTimeMs: index * 2000,
})) })!
const calls: { command: string; params: unknown }[] = []
const layers: (() => KeymapLayer)[] = []
let setWidth!: (n: number) => void, setPosition!: (n: number) => void, setDocument!: (value: typeof synthetic) => void
let setReducedMotion!: (value: boolean) => void, setHeight!: (value: number) => void
let setPlayback!: (update: (playback: ReturnType<typeof initialState>["playback"]) => ReturnType<typeof initialState>["playback"]) => void
let failVolume = false
let componentProps!: MusicProps
function harness(kind: "player" | "lyrics", contentHeight: number) {
  const renderer = useRenderer()
  const [width, updateWidth] = createSignal(24)
  const [position, updatePosition] = createSignal(100)
  const [lyrics, updateLyrics] = createSignal(synthetic)
  const [reducedMotion, updateReduced] = createSignal(true)
  const [viewHeight, updateHeight] = createSignal(contentHeight)
  const [playback, updatePlayback] = createSignal({ ...initialState().playback, trackUri: uri, durationMs: 200000, isPlaying: true, liked: false, shuffle: false, repeat: 0 as const, volume: 0.5, muted: false })
  setWidth = updateWidth; setPosition = updatePosition; setDocument = updateLyrics
  setReducedMotion = updateReduced; setHeight = updateHeight; setPlayback = updatePlayback
  const state = () => ({ ...initialState(), connection: "connected" as const,
    track: { uri, title: "పరీక్ష శీర్షిక a long synthetic title", artist: "పరీక్ష కళాకారుడు", album: "Original synthetic tests", image: "" },
    playback: playback(),
    capabilities: { protocol: 2, apis: {}, commands: [...commands], search_mode: null },
  })
  const context = {
    renderer, theme: { text: { base: "#eef2ec", muted: "#a6afa7", action: { primary: { base: "#8fc7a0" } } } },
    keymap: { layer: (factory: () => KeymapLayer) => layers.push(factory) },
    ui: { toast: { show() {} }, dialog: { clear() {} } }, options: {},
    data: { location: { default: () => ({ directory: "synthetic-test" }) } },
  } as unknown as Context
  const props = {
    context, state, lyrics, position, settings: () => ({ ...defaultLyricsSettings(), reducedMotion: reducedMotion() }),
    sources: () => null, saveSettings: async () => {}, refreshLyrics: async () => {},
    previewSeek: (positionMs: number) => updatePosition(positionMs),
    rpc: {} as MusicProps["rpc"],
  }
  componentProps = props
  const run = async (command: string, params: unknown) => {
    calls.push({ command, params })
    return failVolume && command === "set_volume" ? false : undefined
  }
  return <box flexDirection="row" width="100%" height="100%">
    <text width={5} height="100%" zIndex={0}>{"LLLLL\n".repeat(60)}</text>
    <box width={width()} height={viewHeight()} minWidth={0} flexShrink={0} zIndex={1}>
      {kind === "player" ? <MiniPlayer {...props} budget={() => viewHeight()} open={() => { calls.push({ command: "music", params: {} }) }}
        openLyrics={() => { calls.push({ command: "lyrics", params: {} }) }} openSettings={() => { calls.push({ command: "settings", params: {} }) }}
        more={() => { calls.push({ command: "more", params: {} }) }} run={run} /> : <LyricsView {...props} height={viewHeight()} settingsAction={() => { calls.push({ command: "settings", params: {} }) }} />}
    </box>
    <text width={5} height="100%" zIndex={0}>{"RRRRR\n".repeat(60)}</text>
  </box>
}
const snapshots: string[] = []
function visibleSyntheticLine(frame: string) {
  const match = frame.match(/పరీక్ష (\d+)/)
  return match ? Number(match[1]) : -1
}
function boundaries(frame: string, count: number) {
  for (const line of frame.split("\n").slice(0, count)) {
    assert.ok(line.startsWith("LLLLL"), `left-edge leak: ${line}`)
    assert.ok(line.includes("RRRRR"), `right-edge leak: ${line}`)
  }
}
const layoutOf = (setup: Awaited<ReturnType<typeof testRender>>, id: string) => {
  const node = setup.renderer.root.findDescendantById(id) as Renderable | undefined
  assert.ok(node, `${id} mounted`)
  return node
}

// V0.5.3 hierarchy, five-line window, framed roomy card, fixed transport and
// stable layout across playback/lyric state.
{
  layers.length = 0
  const setup = await testRender(() => harness("player", 26), { width: 130, height: 40 })
  try {
    for (const width of [24, 30, 40, 60, 80, 120]) {
      setWidth(width); setup.resize(width + 10, 40)
      setPosition(100)
      await setup.flush()
      const card = layoutOf(setup, "spotify-card")
      const artwork = layoutOf(setup, "spotify-artwork")
      const title = layoutOf(setup, "spotify-title")
      const artist = layoutOf(setup, "spotify-artist")
      const seek = layoutOf(setup, "spotify-seek-row")
      const transport = layoutOf(setup, "spotify-transport")
      const volume = layoutOf(setup, "spotify-volume-row")
      const lyrics = layoutOf(setup, "spotify-lyrics-block")
      assert.ok(layoutOf(setup, "spotify-header").y < layoutOf(setup, "spotify-nav").y, "header before nav")
      assert.ok(layoutOf(setup, "spotify-nav").y < card.y, "nav before card")
      assert.ok(card.y <= artwork.y && artwork.y + artwork.height <= card.y + card.height, "art inside card")
      assert.ok(artwork.y < title.y && title.y < artist.y && artist.y < seek.y && seek.y < transport.y &&
        transport.y < volume.y && volume.y < lyrics.y, `required card hierarchy at ${width}`)
      const previous = layoutOf(setup, "spotify-previous")
      const toggle = layoutOf(setup, "spotify-toggle")
      const next = layoutOf(setup, "spotify-next")
      assert.deepEqual([previous.width, toggle.width, next.width], [4, 9, 4], "fixed transport widths")
      assert.equal(previous.x + 5, toggle.x, "previous/play spacing")
      assert.equal(toggle.x + 10, next.x, "play/next spacing")
      const groupCenter = (previous.x + next.x + next.width) / 2
      assert.ok(Math.abs(groupCenter - (transport.x + transport.width / 2)) <= 1,
        `three-button group centered independently of Like at ${width}`)
      const cover = layoutOf(setup, "spotify-cover")
      assert.ok(Math.abs((cover.x + cover.width / 2) - (artwork.x + artwork.width / 2)) <= 1, "artwork centered")
      assert.ok(artwork.height <= 9, `sidebar art cap at ${width}`)
      assert.ok(transport.y - (artwork.y + artwork.height) >= 4, "artwork has breathing room before transport")
      assert.equal(lyrics.height, 5, "lyric block reserves five rows at roomy height")
      assert.ok(setup.renderer.root.findDescendantById("spotify-lyric-0"), "first visible semantic line mounted")
      // The active line is never truncated: every wrapped row is present, bold,
      // and the block keeps its reserved height (no bounce). Scoped to block
      // rows so the bold truncated title cannot contaminate the check.
      const blockTop = lyrics.y
      const lyricSpans = setup.captureSpans().lines
        .filter((_, index) => index >= blockTop && index < blockTop + lyrics.height)
        .flatMap((line) => line.spans)
        .filter((span) => (span.attributes & TextAttributes.BOLD) !== 0 && span.text.trim() !== "")
      assert.ok(lyricSpans.length > 0, "active lyric renders bold rows")
      const activeJoined = lyricSpans.map((span) => span.text).join("").replace(/\s+/g, "")
      const activeSource = synthetic.lines[0]!.text.replace(/\s+/g, "").slice(0, 20)
      assert.ok(activeJoined.includes(activeSource), `active line fully readable without ellipsis at ${width}: ${JSON.stringify(activeJoined.slice(0, 40))}`)
      assert.ok(!lyricSpans.some((span) => span.text.includes("…")), "no ellipsis on active rows")
      const player = layoutOf(setup, "spotify-player")
      const playerFrame = setup.captureCharFrame().split("\n").slice(player.y, player.y + player.height)
      for (const line of playerFrame) {
        assert.ok(line.startsWith("LLLLL"), `player left sentinel at ${width}: ${line}`)
        const marker = line.indexOf("RRRRR")
        assert.ok(marker > 5, `player right sentinel at ${width}: ${line}`)
        assert.ok(measure(line.slice(5, marker).trimEnd()) <= width, `player content width at ${width}: ${line}`)
        assert.ok(!line.includes("�"), `no broken shaped cluster at ${width}`)
      }
      const centerRows = setup.captureSpans().lines
        .map((line, index) => ({ line, index: index - player.y }))
        .filter(({ line, index }) => index >= lyrics.y - player.y && index < lyrics.y - player.y + lyrics.height &&
          line.spans.some((span) => (span.attributes & TextAttributes.BOLD) !== 0 && span.text.trim() !== ""))
      assert.ok(centerRows.length > 0, "active rows resolve in the frame")
      for (const { line, index } of centerRows) {
        const raw = playerFrame[index]
        assert.ok(raw, `active row ${index} inside the player frame`)
        const content = raw!.slice(5, raw!.indexOf("RRRRR"))
        assert.ok(measure(content.trim()) <= width - 2, `active row keeps a safety margin at ${width}`)
        assert.ok(!content.includes("�"), `no broken shaped cluster at ${width}`)
      }
      const percent = layoutOf(setup, "spotify-volume-percent")
      const elapsed = layoutOf(setup, "spotify-elapsed")
      const duration = layoutOf(setup, "spotify-duration")
      assert.equal(percent.width, 6, "volume label width invariant")
      assert.equal(elapsed.width, duration.width, "time labels share invariant width")
      assert.ok(volume.width <= card.width, "compact volume stays inside the card")
      const blockIds = ["spotify-title", "spotify-artist", "spotify-seek-row", "spotify-transport", "spotify-volume-row", "spotify-lyrics-block"]
      const metrics = () => [layoutOf(setup, "spotify-player").height, layoutOf(setup, "spotify-card").height,
        layoutOf(setup, "spotify-lyrics-block").height, layoutOf(setup, "spotify-artwork").height,
        blockIds.map((id) => layoutOf(setup, id).y).join(","),
        layoutOf(setup, "spotify-toggle").x, layoutOf(setup, "spotify-toggle").width].join("|")
      const baseline = metrics()
      setPlayback((value) => ({ ...value, isPlaying: false, volume: 1 }))
      await setup.flush()
      assert.equal(metrics(), baseline, "pause and 100% volume do not move the card or lyric window")
      setDocument(emptyLyrics(uri))
      await setup.flush()
      assert.equal(layoutOf(setup, "spotify-lyrics-block").height, 5, "missing lyrics keep five reserved rows")
      assert.equal(layoutOf(setup, "spotify-player").height, Number(baseline.split("|")[0]), "missing lyrics do not resize the player")
      setDocument(synthetic)
      setPlayback((value) => ({ ...value, isPlaying: true, volume: 0.5 }))
      setPosition(5000)
      await setup.flush()
      snapshots.push(`player / ${width}x26\n${setup.captureCharFrame().split("\n").slice(0, layoutOf(setup, "spotify-player").height).join("\n")}`)
    }
    // Short heights degrade decoration before essentials: [budget, art, volume, lyrics].
    for (const [height, expectArt, expectVolume, lyrics] of
      [[6, false, false, 0], [8, false, false, 1], [10, false, false, 1], [14, true, true, 3], [18, true, true, 3], [26, true, true, 5]] as const) {
      layers.length = 0
      const short = await testRender(() => harness("player", height), { width: 34, height: 40 })
      try {
        setWidth(24)
        await short.flush()
        snapshots.push(`player / 24x${height}\n${short.captureCharFrame().split("\n").slice(0, Math.max(height, 8)).join("\n")}`)
        assert.ok(layoutOf(short, "spotify-player").height <= height)
        assert.ok(layoutOf(short, "spotify-toggle"), `transport survives ${height}-row layout`)
        assert.equal(!!short.renderer.root.findDescendantById("spotify-artwork"), expectArt, `art visibility at ${height}`)
        assert.equal(!!short.renderer.root.findDescendantById("spotify-volume-row"), expectVolume, `volume visibility at ${height}`)
        const block = short.renderer.root.findDescendantById("spotify-lyrics-block")
        assert.equal(block ? (block as Renderable).height : 0, lyrics, `lyric rows at ${height}`)
        if (expectArt) assert.ok(layoutOf(short, "spotify-transport").y - (layoutOf(short, "spotify-artwork").y + layoutOf(short, "spotify-artwork").height) >= 3)
      } finally { await short.dispose() }
    }
    for (const [width, budget] of [[13, 8], [16, 10], [20, 12]] as const) {
      layers.length = 0
      const narrow = await testRender(() => harness("player", budget), { width: width + 10, height: 40 })
      try {
        setWidth(width)
        await narrow.flush()
        const player = layoutOf(narrow, "spotify-player")
        assert.ok(player.height <= budget, `narrow player fits ${width}x${budget}`)
        assert.ok(layoutOf(narrow, "spotify-toggle"), `narrow transport survives ${width}`)
        for (const line of narrow.captureCharFrame().split("\n").slice(0, player.height)) {
          assert.ok(line.startsWith("LLLLL"), `narrow left sentinel ${width}: ${line}`)
          const marker = line.indexOf("RRRRR")
          assert.ok(marker > 5, `narrow right sentinel ${width}: ${line}`)
          assert.ok(measure(line.slice(5, marker).trimEnd()) <= width, `narrow content width ${width}: ${line}`)
        }
      } finally { await narrow.dispose() }
    }
  } finally { await setup.dispose() }
}

// Host composition: the player lives in the pinned sidebar footer, so a tall
// Todo list scrolls without moving it. The editor sentinel proves complex
// glyphs stay inside the sidebar cells.
{
  const tamil = normalizeLyrics({ uri, sync_type: "LINE_SYNCED", lines: [
    { text: "முந்தைய வரி ஒன்று", startTimeMs: 0 },
    { text: "முந்தைய வரி இரண்டு", startTimeMs: 2000 },
    { text: "தற்போதைய வரி மிகவும் நீளமானது மற்றும் முழுமையாக இருக்க வேண்டும்", startTimeMs: 4000 },
    { text: "அடுத்த வரி ஒன்று", startTimeMs: 6000 },
    { text: "அடுத்த வரி இரண்டு", startTimeMs: 8000 },
  ] })!
  function hostHarness(todo: number, terminalHeight: number, sidebarWidth = 34, playerWidth = 24) {
    const renderer = useRenderer()
    const state = { ...initialState(), connection: "connected" as const,
      track: { uri, title: "மிக நீளமான தமிழ் பாடல் தலைப்பு", artist: "தமிழ் கலைஞர்", album: "A", image: "" },
      playback: { ...initialState().playback, trackUri: uri, durationMs: 200000, isPlaying: true, liked: false,
        shuffle: false, repeat: 0 as const, volume: 0.5, muted: false },
      capabilities: { protocol: 2, apis: {}, commands: [...commands], search_mode: null },
    }
    const context = {
      renderer, theme: { text: { base: "#eef2ec", muted: "#a6afa7" } }, keymap: { layer() {} },
      ui: { toast: { show() {} }, dialog: {}, panel: { current: () => undefined } }, options: {},
      data: { location: { default: () => ({ directory: "host-fixture" }) } },
    } as unknown as Context
    const music = {
      context, state: () => state, lyrics: () => tamil, position: () => 4200,
      settings: () => defaultLyricsSettings(), sources: () => null, saveSettings: async () => {}, refreshLyrics: async () => {},
      rpc: {} as MusicProps["rpc"], open() {}, openLyrics() {}, openSettings() {}, more() {}, run: async () => true,
    }
    const playerHeight = playerLayout(playerBudget(terminalHeight), {
      hasTrack: true, width: playerWidth - 2, aspect: 2, artwork: true, showVolume: true, preview: true,
    }).total
    return <box flexDirection="row" width="100%" height="100%">
      <box id="host-sidebar" width={sidebarWidth} height={terminalHeight} flexDirection="column" overflow="hidden">
        <box height={1}><text>Sidebar</text></box>
        <box id="host-scroll" flexGrow={1} flexBasis={0} minHeight={0} overflow="hidden" flexDirection="column">
          <box height={4} flexShrink={0}><text>Context / MCP</text></box>
          <box height={todo} flexShrink={0}><text>{"Todo item\n".repeat(todo)}</text></box>
        </box>
        <box id="host-footer" flexShrink={0} paddingTop={1} gap={1}>
          <box id="host-player-row" flexDirection="row" width="100%" height={playerHeight}>
            <text width={5} height={playerHeight}>{"LLLLL\n".repeat(40)}</text>
            <box width={playerWidth} minWidth={0} flexShrink={0}>
              <MiniPlayer {...music} budget={() => playerBudget(terminalHeight)} />
            </box>
            <text width={5} height={playerHeight}>{"RRRRR\n".repeat(40)}</text>
          </box>
          <text height={1}>D:\project</text>
        </box>
      </box>
      <box id="host-editor" flexGrow={1}>
        <text>{"EDITOR SENTINEL text that must not be overwritten\n".repeat(40)}</text>
      </box>
    </box>
  }
  for (const terminalHeight of [40, 24]) {
    const small = await testRender(() => hostHarness(2, terminalHeight), { width: 120, height: terminalHeight })
    const large = await testRender(() => hostHarness(18, terminalHeight), { width: 120, height: terminalHeight })
    try {
      await small.flush(); await large.flush()
      const playerSmall = layoutOf(small, "spotify-player")
      const playerLarge = layoutOf(large, "spotify-player")
      assert.equal(playerLarge.screenY, playerSmall.screenY, `Todo growth does not move the footer player at ${terminalHeight}`)
      assert.equal(playerLarge.height, playerSmall.height, "Todo growth does not resize the player")
      assert.ok(playerSmall.screenY + playerSmall.height <= terminalHeight - 1,
        "player is pinned above the footer location")
      assert.ok(playerSmall.screenY + playerSmall.height >= terminalHeight - 3,
        "player remains in the pinned footer region")
      assert.ok(playerSmall.screenX >= 0 && playerSmall.screenX + playerSmall.width <= 34, "player stays inside the sidebar")
      assert.ok(playerLarge.screenX >= 0 && playerLarge.screenX + playerLarge.width <= 34, "expanded Todo keeps the player inside the sidebar")
      for (const setup of [small, large]) {
        const player = layoutOf(setup, "spotify-player")
        assert.ok(layoutOf(setup, "spotify-toggle"), "essential transport remains visible")
        const frame = setup.captureCharFrame().split("\n").slice(player.screenY, player.screenY + player.height)
        assert.ok(frame.length === player.height, "player rows are in the terminal frame")
        for (const line of frame) {
          assert.ok(line.startsWith("LLLLL"), `player line left sentinel: ${line}`)
          const marker = line.indexOf("RRRRR")
          assert.ok(marker > 5, `player line right sentinel: ${line}`)
          assert.ok(line.slice(marker + 5).startsWith("EDITOR"), `editor region untouched: ${line}`)
        }
      }
      if (terminalHeight === 24) {
        assert.ok(playerSmall.height <= 14, "short terminal uses the tight footer budget")
        assert.ok(small.renderer.root.findDescendantById("spotify-volume-row"), "compact volume remains reachable")
      }
      if (terminalHeight === 40) {
        snapshots.push(`host footer / Todo 2\n${small.captureCharFrame()}`)
        snapshots.push(`host footer / Todo 18\n${large.captureCharFrame()}`)
      }
    } finally { await small.dispose(); await large.dispose() }
  }
  {
    const setup = await testRender(() => hostHarness(2, 50, 46, 36), { width: 140, height: 50 })
    try {
      await setup.flush()
      const nav = layoutOf(setup, "spotify-nav")
      const card = layoutOf(setup, "spotify-card")
      const volume = layoutOf(setup, "spotify-volume-row")
      assert.ok(nav.y < card.y, "framed card starts below navigation")
      assert.ok(volume.y < card.y + card.height, "volume stays inside the framed card")
      const frame = setup.captureCharFrame().split("\n")
      assert.ok(frame[nav.y]?.includes("Music"), "navigation row is separate")
      assert.ok(frame[card.y]?.includes("┌"), "card top border is separate from navigation")
      assert.ok(frame[card.y + card.height - 1]?.includes("└"), "card bottom border is separate from volume")
    } finally { await setup.dispose() }
  }
}

for (const kind of ["player", "lyrics"] as const) {
  layers.length = 0
  const setup = await testRender(() => harness(kind, 18), { width: 80, height: 40 })
  try {
    for (const width of [24, 30, 40, 60, 80, 120]) {
      setWidth(width); setup.resize(width + 10, 40)
      setPosition(100)
      await setup.flush()
      const frame = setup.captureCharFrame()
      boundaries(frame, 18)
      snapshots.push(`${kind} / ${width} columns\n${frame.split("\n").slice(0, 18).join("\n")}`)
    }
    const control = setup.renderer.root.findDescendantById(kind === "player" ? "spotify-toggle" : "spotify-lyrics-scroll") as Renderable
    assert.ok(control, `${kind} mounted`)
    for (let i = 1; i <= 20; i++) setPosition(i * 100)
    await setup.flush()
    assert.equal(setup.renderer.root.findDescendantById(control.id), control, "playback does not remount controls/document")
    if (kind === "player") {
      const like = setup.renderer.root.findDescendantById("spotify-like") as Renderable
      assert.ok(like && like.width > 3, "like control mounted with a clickable width")
      await setup.mockMouse.click(like.x + 2, like.y)
      await setup.flush()
      assert.deepEqual(calls.find((call) => call.command === "set_liked")?.params, { uri, value: true })
      // Pointer-only: no custom key interception, no focus capture.
      assert.equal(layers.length, 0, "pointer-only: MiniPlayer registers no keymap layers")
      const playerRoot = setup.renderer.root.findDescendantById("spotify-player") as Renderable
      assert.ok(playerRoot && !playerRoot.focusable, "player root is not focusable")
      for (const id of ["spotify-toggle", "spotify-previous", "spotify-next", "spotify-mute",
        "spotify-music", "spotify-lyrics", "spotify-settings", "spotify-more"]) {
        const button = setup.renderer.root.findDescendantById(id) as Renderable
        assert.ok(button, id)
        await setup.mockMouse.click(button.x + 2, button.y)
        await setup.flush()
      }
      for (const command of ["toggle_play", "previous", "next", "set_mute", "music", "lyrics", "settings", "more"]) {
        assert.ok(calls.some((call) => call.command === command), command)
      }
      const muteButton = setup.renderer.root.findDescendantById("spotify-mute") as Renderable
      await setup.mockMouse.click(muteButton.x + 2, muteButton.y)
      await setup.flush()
      const muteCount = calls.filter((call) => call.command === "set_mute").length
      await setup.mockMouse.click(muteButton.x + 2, muteButton.y)
      await setup.flush()
      assert.equal(calls.filter((call) => call.command === "set_mute").length, muteCount + 1, "pointer mute activates the real action")
      const seek = setup.renderer.root.findDescendantById("spotify-timeline") as Renderable
      const seekRow = () => setup.captureCharFrame().split("\n")[seek.y]!
      await setup.mockMouse.moveTo(0, seek.y)
      await setup.flush()
      assert.ok(seekRow().includes("•"), seekRow())
      await setup.mockMouse.moveTo(seek.x + 2, seek.y)
      await setup.flush()
      assert.ok(seekRow().includes("●"), seekRow())
      const base = calls.length
      await setup.mockMouse.drag(seek.x + 2, seek.y, seek.x + seek.width + 2, seek.y + 1)
      await setup.flush()
      assert.deepEqual(calls.slice(base), [{ command: "seek", params: { positionMs: 200000 } }])
      // Seek drag: per-event thumb preview, no RPC until release, one commit.
      {
        const start = calls.length
        const before = setup.captureCharFrame().split("\n")[seek.y]!
        await setup.mockMouse.pressDown(seek.x + 2, seek.y)
        await setup.flush()
        await setup.mockMouse.emitMouseEvent("drag", seek.x + Math.floor(seek.width / 2), seek.y)
        await setup.flush()
        assert.ok(!calls.slice(start).some((call) => call.command === "seek"), "no seek RPC while dragging")
        const mid = setup.captureCharFrame().split("\n")[seek.y]!
        // Pointer-only emphasis is hover/dragging (no focus ring): dragging
        // shows ● and the thumb/time preview moves before release.
        assert.ok(mid.includes("●"), "drag shows emphasis")
        assert.notEqual(mid, before, "thumb tracks the drag before release")
        await setup.mockMouse.release(seek.x + Math.floor(seek.width / 2), seek.y)
        await setup.flush()
        const seeks = calls.slice(start).filter((call) => call.command === "seek")
        assert.equal(seeks.length, 1, "exactly one seek on release")
      }
      // Cancelled drag without keys: a width change (resize) clears the preview
      // and the release commits nothing (seek is release-only).
      {
        const start = calls.length
        await setup.mockMouse.pressDown(seek.x + 2, seek.y)
        await setup.flush()
        await setup.mockMouse.emitMouseEvent("drag", seek.x + Math.floor(seek.width / 2), seek.y)
        await setup.flush()
        setWidth(30); setup.resize(40, 40)
        await setup.flush()
        await setup.mockMouse.release(seek.x + Math.floor(seek.width / 2), seek.y)
        await setup.flush()
        assert.ok(!calls.slice(start).some((call) => call.command === "seek"), "resize-cancelled seek drag commits nothing")
        setWidth(24); setup.resize(34, 40)
        await setup.flush()
      }
      // Click seeks directly (no keyboard nudges; pointer-only).
      {
        const start = calls.length
        await setup.mockMouse.click(seek.x + Math.floor(seek.width / 2), seek.y)
        await setup.flush()
        const clicked = calls.slice(start).filter((call) => call.command === "seek")
        assert.equal(clicked.length, 1, "click seeks directly")
        const middle = (clicked[0]!.params as { positionMs: number }).positionMs
        assert.ok(middle > 0 && middle < 200000, "click lands mid-track")
      }
      // Volume drag: live coalesced commits while moving, final commit on release.
      const volume = setup.renderer.root.findDescendantById("spotify-volume") as Renderable
      {
        const start = calls.length
        await setup.mockMouse.pressDown(volume.x + 2, volume.y)
        await setup.flush()
        await setup.mockMouse.emitMouseEvent("drag", volume.x + Math.floor(volume.width / 2), volume.y)
        await setup.flush()
        const live = calls.slice(start).filter((call) => call.command === "set_volume")
        assert.ok(live.length >= 1, "volume follows the drag with live commits")
        assert.ok(live.every((call) => (call.params as { value: number }).value > 0 && (call.params as { value: number }).value < 1), "live volume stays within the drag range")
        await setup.mockMouse.release(volume.x + Math.floor(volume.width / 2), volume.y)
        await setup.flush()
        const all = calls.slice(start).filter((call) => call.command === "set_volume")
        assert.ok(all.length >= live.length, "release commits the final volume")
        const last = all.at(-1)!.params as { value: number }
        assert.ok(last.value > 0 && last.value < 1, "final volume matches the release point")
      }
      // Release at the bar end clamps to the endpoint; release outside does too.
      await setup.mockMouse.drag(volume.x + 2, volume.y, volume.x + volume.width - 1, volume.y)
      await setup.flush()
      assert.deepEqual(calls.at(-1), { command: "set_volume", params: { value: 1 } })
      await setup.mockMouse.drag(volume.x + 2, volume.y, volume.x + volume.width + 2, volume.y)
      await setup.flush()
      assert.deepEqual(calls.at(-1), { command: "set_volume", params: { value: 1 } })
      await setup.flush()
      assert.deepEqual(calls.at(-1), { command: "set_volume", params: { value: 1 } })
      // Pointer clamp: clicking the very start lands at the minimum.
      await setup.mockMouse.click(volume.x, volume.y)
      await setup.flush()
      assert.deepEqual(calls.at(-1), { command: "set_volume", params: { value: 0 } })
      // Mono timeline: static fill + thumb advancing on real time, no flow glyph.
      assert.ok(!seekRow().includes("╸"), "no decorative seekbar animation")
      const seekContent = seekRow().replace("LLLLL", "").replace("RRRRR", "").trim()
      assert.ok(/^[\d: •●━─]+$/.test(seekContent), `seek row stays monochrome type: ${seekRow()}`)
      // Spacing: transport sits on its own row strictly below the artwork block.
      const rows = setup.captureCharFrame().split("\n")
      const coverRow = rows.findIndex((row) => row.includes("No cover"))
      const transportRow = rows.findIndex((row) => row.includes("Pause"))
      assert.ok(coverRow >= 0 && transportRow > coverRow, "transport keeps distance from artwork")
      setHeight(36); setup.resize(70, 44)
      await setup.flush()
      assert.ok((setup.renderer.root.findDescendantById("spotify-player") as Renderable).height > 12,
        "restrained sidebar shows full chrome without a tall lyric block")

      const choices: (string | undefined)[] = ["script", "original", "reducedMotion", "save"]
      const saved: LyricsSettings[] = []
      const dialog = componentProps.context.ui.dialog
      dialog.select = async (options) => {
        const value = choices.shift()
        return options.options.find((row) => row.value === value && !row.disabled)?.value
      }
      componentProps.saveSettings = async (value) => { saved.push(value) }
      await lyricsSettingsDialog(componentProps)
      assert.equal(saved[0]?.script, "original")
      assert.equal(saved[0]?.reducedMotion, false, "toggle changes the fixture's enabled reduced-motion setting")
      choices.push("script", "original", undefined)
      await lyricsSettingsDialog(componentProps)
      assert.equal(saved.length, 1, "Cancel does not save")

      const requested: { command: string; params: Record<string, unknown> }[] = []
      const queue = normalizeQueue({ current: null, queued: [{ uri, name: "Synthetic", artist: "Artist", uid: 7, is_playable: true }], next_up: [] })
      componentProps.rpc = { command: async (input: { command: string; params: Record<string, unknown> }) => {
        requested.push(input)
        return { ok: true, result: input.command === "get_queue" ? queue : input.command === "search" || input.command === "get_library"
          ? normalizePage({ items: queue.queued, offset: input.params.offset, limit: 50, total: 100 })
          : input.command === "get_playlists" ? { items: [{ type: "folder", name: "పరీక్ష folder", uri: "spotify:folder:test", children: [
            { type: "playlist", uri: "spotify:playlist:1234567890123456789012", name: "Playlist", children: [] },
          ] }] } : { accepted: true } }
      } } as MusicProps["rpc"]
      const music = musicActions(componentProps)
      choices.push("queue", `Queued:${uri}:7`, "remove_from_queue", "__back")
      await music.open()
      assert.deepEqual(requested.find((request) => request.command === "remove_from_queue")?.params, { uri, uid: 7 })
      dialog.prompt = async () => "Synthetic query"
      choices.push(uri, "add_to_queue", "next", "__back")
      await music.search()
      // The acted-on page is reloaded so its reflected state stays current.
      assert.deepEqual(requested.filter((request) => request.command === "search").map((request) => request.params.offset), [0, 0, 50])
      assert.ok(requested.some((request) => request.command === "add_to_queue"), "search queue action")
      choices.push("playlists", "spotify:folder:test", "spotify:playlist:1234567890123456789012", "play", "__back", "__back")
      await music.open()
      assert.ok(requested.some((request) => request.command === "play_context"), "playlist context playback")
      choices.push("library", "__back")
      await music.open()
      assert.ok(requested.some((request) => request.command === "get_library"), "library fetch")
      // Manual get_playback (removed spotify.refresh palette) stays reachable
      // via pointer: More → Refresh playback dialog action.
      choices.push("Refresh playback")
      await music.playback()
      assert.ok(requested.some((request) => request.command === "get_playback"), "More → Refresh playback preserves manual get_playback")
      // More button itself is pointer-operable (harness stub proves click path).
      const moreButton = setup.renderer.root.findDescendantById("spotify-more") as Renderable
      assert.ok(moreButton, "More button mounted for dialog route")
      await setup.mockMouse.click(moreButton.x + 2, moreButton.y)
      await setup.flush()
      assert.ok(calls.some((call) => call.command === "more"), "More click opens playback dialog route")
      music.dispose()
    } else {
      const scroll = control as ScrollBoxRenderable
      assert.equal(layers.length, 0, "pointer-only: LyricsView registers no keymap layers")
      setPosition(30000)
      await setup.flush()
      assert.ok(scroll.scrollTop > 0, "follows actual wrapped row offsets")
      // Pointer wheel scroll switches to manual; virtual rows refresh.
      await setup.mockMouse.scroll(scroll.x + 2, scroll.y + 2, "up")
      await setup.flush()
      const manualTop = scroll.scrollTop
      const rowBefore = visibleSyntheticLine(setup.captureCharFrame())
      scroll.scrollBy(12)
      await setup.flush()
      assert.ok(visibleSyntheticLine(setup.captureCharFrame()) > rowBefore, "scroll offset refreshes virtual rows")
      const movedTop = scroll.scrollTop
      assert.ok(movedTop > manualTop, "wheel scroll offset refreshes virtual rows")
      setPosition(60000)
      await setup.flush()
      assert.equal(scroll.scrollTop, movedTop, "manual scroll does not snap back")
      const followButton = setup.renderer.root.findDescendantById("lyrics-follow") as Renderable
      assert.ok(followButton, "follow button mounted")
      await setup.mockMouse.click(followButton.x + 2, followButton.y)
      await setup.flush()
      assert.ok(scroll.scrollTop > manualTop, "resume follow moves past the manual offset")
      setReducedMotion(false)
      await setup.flush()
      setPosition(62000)
      await setup.flush()
      const start = scroll.scrollTop
      getTimelineEngine(setup.renderer).update(90)
      await setup.flush()
      assert.ok(scroll.scrollTop >= start, "bounded forward animation")
      await setup.mockMouse.scroll(scroll.x + 2, scroll.y + 2, "up")
      await setup.flush()
      const stopped = scroll.scrollTop
      getTimelineEngine(setup.renderer).update(1000)
      await setup.flush()
      assert.equal(scroll.scrollTop, stopped, "manual input cancels motion")
      const changed = normalizeLyrics({ uri: "spotify:track:xxxxxxxxxxxxxxxxxxxxxx", sync_type: "LINE_SYNCED",
        lines: [{ text: "కొత్త పరీక్ష పంక్తి", startTimeMs: 0 }] })!
      setDocument(changed); setPosition(500)
      await setup.flush()
      assert.equal(scroll.scrollTop, 0, "track changes reset scroll")
      assert.ok(setup.captureCharFrame().includes("కొత్త"), "changed track renders")
      const unbroken = normalizeLyrics({ uri, sync_type: "LINE_SYNCED", lines: [
        { text: "క్ష".repeat(400) + "👩‍💻".repeat(40), startTimeMs: 0 },
      ] })!
      setDocument(unbroken); setPosition(0)
      await setup.flush()
      const unbrokenFrame = setup.captureCharFrame()
      boundaries(unbrokenFrame, 18)
      assert.ok(unbrokenFrame.includes("క్ష"), "long unbroken grapheme runs render without splitting")
    }
    setup.resize(34, 10); setWidth(24); setHeight(7)
    await setup.flush()
    boundaries(setup.captureCharFrame(), 9)
  } finally { await setup.dispose() }
}

// Monochrome lyrics: genuine word timings never create accent fills. The whole
// active line shares one white foreground and bold; other lines stay dim.
{
  layers.length = 0
  const wordLyrics = normalizeLyrics({ uri, sync_type: "WORD_SYNCED", lines: [{
    text: "Alpha beta", startTimeMs: 1000, words: [
      { text: "Alpha ", startMs: 1000, endMs: 2000 },
      { text: "beta", startMs: 2000, endMs: 3000 },
    ],
  }] })!
  const setup = await testRender(() => harness("lyrics", 18), { width: 80, height: 40 })
  try {
    setWidth(40); setHeight(12); setDocument(wordLyrics); setPosition(1500)
    setup.resize(50, 40)
    await setup.flush()
    const white = parseColor("#eef2ec").toInts()
    const singleForeground = () => {
      const line = setup.captureSpans().lines.find((l) => l.spans.map((span) => span.text).join("").includes("Alpha beta"))
      assert.ok(line, setup.captureCharFrame())
      const lyricSpans = line.spans.filter((span) => !/^(LLLLL|RRRRR|\s*)$/.test(span.text))
      assert.equal(lyricSpans.length, 1, "sung and upcoming words stay one unbroken run")
      assert.deepEqual(lyricSpans[0]!.fg.toInts(), white)
      assert.ok(lyricSpans.some((span) => (span.attributes & TextAttributes.BOLD) !== 0), "active line is bold white")
    }
    singleForeground()
    setPosition(2500)
    await setup.flush()
    singleForeground()
  } finally { await setup.dispose() }
}

// A short player keeps transport and navigation visible without overflowing.
{
  layers.length = 0
  const setup = await testRender(() => harness("player", 6), { width: 40, height: 10 })
  try {
    setWidth(24)
    await setup.flush()
    const frame = setup.captureCharFrame()
    boundaries(frame, 6)
    assert.ok(frame.includes("పరీక్ష"), "title remains visible")
    assert.ok(frame.includes("Pause"), "transport remains accessible")
    assert.ok(frame.includes("Music"), "navigation remains accessible\n" + frame + "\nheight=" + setup.renderer.root.findDescendantById("spotify-player")?.height)
    assert.equal(frame.includes("Shuffle"), false, "secondary controls stay hidden when short")
    assert.ok((setup.renderer.root.findDescendantById("spotify-player") as Renderable).height <= 6, "short player fits")
  } finally { await setup.dispose() }
}

// Actual LyricsView path with complex scripts, interludes and marker lines.
{
  layers.length = 0
  const complex = normalizeLyrics({ uri, sync_type: "LINE_SYNCED", lines: [
    { text: "കന്നഡ ಕನ್ನಡ ಕ್ಷ మലയാളം " + "ಕ್ಷ".repeat(20), startTimeMs: 0 },
    { text: "തമിഴ് മലയാളം " + "தமிழ்மொழிபாடல்வரிகள்".repeat(5), startTimeMs: 8000 },
    { text: "മലയാളം ഗാനം " + "അവൻപാടുന്നുകൃഷ്ണൻ".repeat(5), startTimeMs: 14000 },
    { text: "[Instrumental]", startTimeMs: 19000 },
    { text: "വീണ്ടും പാടുന്നു", startTimeMs: 24000 },
  ] })!
  const setup = await testRender(() => harness("lyrics", 18), { width: 80, height: 40 })
  try {
    for (const width of [2, 3, 4, 5, 8, 12, 16, 23, 24, 30, 40, 60, 80, 120]) {
      setWidth(width); setDocument(complex); setPosition(1000)
      setup.resize(width + 10, 40)
      await setup.flush()
      const frame = setup.captureCharFrame()
      boundaries(frame, 18)
      for (const line of frame.split("\n").slice(0, 18)) {
        const marker = line.indexOf("RRRRR")
        if (marker > 5) assert.ok(measure(line.slice(5, marker).trimEnd()) <= width, `complex lyric width at ${width}: ${line}`)
      }
      assert.ok(!frame.includes("[Instrumental]"), "marker text is never painted")
    }
    setWidth(40); setPosition(20000)
    await setup.flush()
    const interlude = setup.captureCharFrame()
    assert.ok(interlude.includes("●") || interlude.includes("○"), "interlude shows a neutral music indicator")
    assert.ok(!/unavailable/i.test(interlude), "interlude is not reported unavailable")
    assert.ok(!interlude.includes("തമിഴ്"), "interlude hides stale lyric rows")
    setPosition(24500)
    await setup.flush()
    assert.ok(setup.captureCharFrame().includes("വീണ്ടും"), "next vocal restores after the interlude")
    // Short gap keeps the previous line; marker rows do not leak bracket text.
    const shortGap = normalizeLyrics({ uri, sync_type: "LINE_SYNCED", lines: [
      { text: "Short gap line", startTimeMs: 0 }, { text: "Next line", startTimeMs: 4000 },
    ] })!
    setDocument(shortGap); setPosition(3500)
    await setup.flush()
    assert.ok(setup.captureCharFrame().includes("Short gap line"), "short gap retains the line")
    // Tiny viewport still clips inside the panel.
    setWidth(4); setDocument(complex); setPosition(1000); setup.resize(14, 12)
    await setup.flush()
    for (const line of setup.captureCharFrame().split("\n")) {
      if (!line.trim()) continue
      assert.ok(line.startsWith("LLLLL") || line.includes("RRRRR"), `tiny viewport boundary: ${line}`)
    }
  } finally { await setup.dispose() }
}

// Five-line lyric window keeps five reserved rows across states and marks gaps.
{
  layers.length = 0
  const setup = await testRender(() => harness("player", 26), { width: 80, height: 40 })
  try {
    setWidth(30)
    const gapDoc = normalizeLyrics({ uri, sync_type: "LINE_SYNCED", lines: [
      { text: "Opening line", startTimeMs: 0 }, { text: "Next vocal", startTimeMs: 19000 },
    ] })!
    for (const [doc, position, expected] of [
      [synthetic, 4000, "పరీక్ష"],
      [{ ...emptyLyrics(uri), status: "unavailable" as const }, 100, "No lyrics"],
      [gapDoc, 15000, "♪ · · ·"],
    ] as const) {
      setDocument(doc); setPosition(position)
      await setup.flush()
      const block = layoutOf(setup, "spotify-lyrics-block")
      assert.equal(block.height, 5, "lyric block always reserves five rows (no bounce)")
      assert.ok(setup.captureCharFrame().includes(expected), `lyric state ${expected}`)
    }
    setDocument(synthetic); setPosition(4000)
    await setup.flush()
    // The active semantic line wraps to several rows; all of them render bold
    // with no ellipsis, and the block keeps its reserved height.
    assert.equal(layoutOf(setup, "spotify-lyrics-block").height, 5)
    const blockTop = layoutOf(setup, "spotify-lyrics-block").y
    const inBlock = (index: number) => index >= blockTop && index < blockTop + 5
    const boldRows = setup.captureSpans().lines
      .filter((_, index) => inBlock(index))
      .flatMap((line) => line.spans)
      .filter((span) => (span.attributes & TextAttributes.BOLD) !== 0 && span.text.trim() !== "")
    assert.ok(boldRows.length > 1, "wrapped active line spans several bold rows")
    const activeJoined = boldRows.map((span) => span.text).join("").replace(/\s+/g, "")
    assert.ok(activeJoined.includes(synthetic.lines[2]!.text.replace(/\s+/g, "").slice(0, 24)),
      "active line fully readable without ellipsis")
    assert.ok(!boldRows.some((span) => span.text.includes("…")), "no ellipsis on active rows")
    // Normal-to-constrained transition in place: 20 -> 19 keeps one player,
    // keeps transport, degrades lyrics 5 -> 3 without remounting the tree.
    // (Runs before the inner harnesses below rebind the shared setters.)
    {
      setWidth(30); setHeight(20); setDocument(synthetic); setPosition(4000)
      await setup.flush()
      // Two-phase lyric present (clear then shaped) needs FRAME events.
      try { (setup.renderer as unknown as { emit: (e: string) => void }).emit("frame") } catch { /* noop */ }
      await setup.flush()
      try { (setup.renderer as unknown as { emit: (e: string) => void }).emit("frame") } catch { /* noop */ }
      await setup.flush()
      assert.equal(layoutOf(setup, "spotify-lyrics-block").height, 5, "medium budget shows five rows")
      const before = setup.renderer.root.findDescendantById("spotify-player")
      setHeight(19)
      await setup.flush()
      // Intentional bounded clear: first public FRAME presents the ASCII clear
      // (max prev/next geometry) before the final shaped 3-row present.
      // Interim must stay plugin-owned: same player node, inside sentinels,
      // no broken clusters, no editor overwrite.
      try { (setup.renderer as unknown as { emit: (e: string) => void }).emit("frame") } catch { /* noop */ }
      await setup.flush()
      {
        const interim = layoutOf(setup, "spotify-lyrics-block")
        // Bounded clear keeps max(prev,next) so it never exceeds the sidebar.
        assert.ok(interim.height === 5 || interim.height === 3, `interim clear stays bounded: ${interim.height}`)
        assert.equal(setup.renderer.root.findDescendantById("spotify-player"), before, "interim clear does not remount player")
        const player = layoutOf(setup, "spotify-player")
        const frame = setup.captureCharFrame().split("\n").slice(player.y, player.y + player.height)
        for (const line of frame) {
          assert.ok(line.startsWith("LLLLL"), `interim left sentinel: ${line}`)
          assert.ok(line.includes("RRRRR"), `interim right sentinel: ${line}`)
          assert.ok(!line.includes("�"), `interim no broken cluster: ${line}`)
          const content = line.slice(5, line.indexOf("RRRRR"))
          assert.ok(measure(content.trimEnd()) <= 30, `interim content width: ${line}`)
        }
      }
      try { (setup.renderer as unknown as { emit: (e: string) => void }).emit("frame") } catch { /* noop */ }
      await setup.flush()
      try { (setup.renderer as unknown as { emit: (e: string) => void }).emit("frame") } catch { /* noop */ }
      await setup.flush()
      assert.equal(layoutOf(setup, "spotify-lyrics-block").height, 3, "one-row shrink degrades lyrics first (final shaped present)")
      assert.ok(setup.renderer.root.findDescendantById("spotify-toggle"), "transport survives the transition")
      assert.ok(setup.renderer.root.findDescendantById("spotify-volume-row"), "compact volume survives")
      assert.equal(setup.renderer.root.findDescendantById("spotify-player"), before, "no player remount on transition")
      assert.ok(setup.renderer.root.findDescendantById("spotify-lyric-0"), "first visible semantic survives")
      const shrunkTop = layoutOf(setup, "spotify-lyrics-block").y
      const shrunkBold = setup.captureSpans().lines
        .filter((_, index) => index >= shrunkTop && index < shrunkTop + 3)
        .flatMap((line) => line.spans)
        .filter((span) => (span.attributes & TextAttributes.BOLD) !== 0 && span.text.trim() !== "")
      assert.ok(shrunkBold.length > 0, "active stays readable after the shrink")
      assert.ok(!shrunkBold.some((span) => span.text.includes("…")), "shrink never cuts the active line")
      setHeight(26)
      await setup.flush()
      assert.equal(layoutOf(setup, "spotify-lyrics-block").height, 5, "budget restore returns five rows")
      // Wrapped heights differ per window, but the reserved block never moves.
      setPosition(8000)
      await setup.flush()
      assert.equal(layoutOf(setup, "spotify-lyrics-block").height, 5, "lyric change does not bounce the block")
      assert.equal(layoutOf(setup, "spotify-player").height,
        layoutOf(setup, "spotify-header").height + layoutOf(setup, "spotify-nav").height +
        layoutOf(setup, "spotify-card").height + 1 + 5, "player total stays row-exact")
    }
    // Tighter budgets degrade the window rather than the player (separate
    // harnesses; shared setters rebind on each testRender).
    for (const [budget, rows] of [[18, 3], [8, 1]] as const) {
      layers.length = 0
      const tight = await testRender(() => harness("player", budget), { width: 40, height: 40 })
      try {
        setWidth(30); setDocument(synthetic); setPosition(4000)
        await tight.flush()
        assert.equal(layoutOf(tight, "spotify-lyrics-block").height, rows, `${budget}-row window`)
      } finally { await tight.dispose() }
    }
  } finally { await setup.dispose() }
}

// Sidebar lyric block wraps long Indic lines across physical rows with the
// active line whole and centered; nothing escapes the sidebar rectangle.
{
  layers.length = 0
  const indic = normalizeLyrics({ uri, sync_type: "LINE_SYNCED", lines: [
    { text: "முந்தைய வரி ஒன்று மிகவும் நீளமானது மற்றும் பல வரிகளில் சுற்ற வேண்டும்", startTimeMs: 0 },
    { text: "മലയാളം ഗാനം പരീക്ഷ വരികൾ അവൻപാടുന്നുകൃഷ്ണൻ തുടരുന്നു", startTimeMs: 8000 },
    { text: "தற்போதைய வரி மிகவும் நீளமானது மற்றும் முழுமையாக இருக்க வேண்டும்", startTimeMs: 16000 },
    { text: "दृष्टिकोणसंयुक्ताक्षरपरीक्षण पंक्तियाँ यहाँ जारी रहती हैं", startTimeMs: 24000 },
    { text: "తెలుగు పదాలు మన పరీక్ష కోసం మాత్రమే రాసిన పంక్తులు", startTimeMs: 32000 },
  ] })!
  const setup = await testRender(() => harness("player", 26), { width: 80, height: 40 })
  try {
    for (const width of [24, 30, 40]) {
      setWidth(width); setDocument(indic); setPosition(17000)
      await setup.flush()
      const block = layoutOf(setup, "spotify-lyrics-block")
      assert.equal(block.height, 5, `Indic block reserves five rows at ${width}`)
      const player = layoutOf(setup, "spotify-player")
      const frame = setup.captureCharFrame().split("\n").slice(player.y, player.y + player.height)
      for (const line of frame.slice(block.y - player.y, block.y - player.y + 5)) {
        assert.ok(line.startsWith("LLLLL"), `Indic left sentinel at ${width}: ${line}`)
        assert.ok(line.includes("RRRRR"), `Indic right sentinel at ${width}: ${line}`)
        const content = line.slice(5, line.indexOf("RRRRR"))
        assert.ok(measure(content) <= width, `Indic row fits at ${width}: ${line}`)
        assert.ok(!content.includes("�"), `no broken cluster at ${width}`)
        if (/[\u0900-\u0DFF\u200d\u0301]/.test(content.trim())) {
          assert.ok(content.length - content.trimStart().length >= 1 && content.length - content.trimEnd().length >= 1,
            `shaped row keeps side margins at ${width}: ${line}`)
        }
      }
      const bold = setup.captureSpans().lines
        .filter((_, index) => index >= block.y && index < block.y + 5)
        .flatMap((line) => line.spans)
        .filter((span) => (span.attributes & TextAttributes.BOLD) !== 0 && span.text.trim() !== "")
      assert.ok(bold.length > 1, `wrapped active spans several rows at ${width}`)
      assert.ok(!bold.some((span) => span.text.includes("…")), `no ellipsis on Indic active at ${width}`)
      const joined = bold.map((span) => span.text).join("").replace(/\s+/g, "")
      assert.ok(joined.includes("தற்போதையவரிமிகவும்".replace(/\s+/g, "").slice(0, 12)),
        `Tamil active fully readable at ${width}`)
    }
  } finally { await setup.dispose() }
}

// An over-budget active line uses a bounded viewport scrolled to the focus:
// the full active text stays reachable, the frame never overflows.
{
  layers.length = 0
  const setup = await testRender(() => harness("player", 14), { width: 34, height: 40 })
  try {
    setWidth(24)
    const longTamil = "தற்போதைய வரி மிகவும் நீளமானது மற்றும் முழுமையாக இருக்க வேண்டும் ".repeat(2).trim()
    setDocument(normalizeLyrics({ uri, sync_type: "LINE_SYNCED", lines: [
      { text: "Short intro", startTimeMs: 0 },
      { text: longTamil, startTimeMs: 8000 },
      { text: "Short outro", startTimeMs: 60000 },
    ] })!)
    setPosition(9000)
    await setup.flush()
    await setup.flush()
    const block = layoutOf(setup, "spotify-lyrics-block")
    assert.equal(block.height, 3, "viewport is bounded to three rows")
    const scroll = setup.renderer.root.findDescendantById("spotify-lyrics-scroll") as ScrollBoxRenderable
    assert.ok(scroll, "scroll fallback mounted")
    assert.equal(scroll.scrollTop, 1, "viewport scrolled past the one-row intro to the active line")
    for (const line of setup.captureCharFrame().split("\n").slice(0, 14)) {
      assert.ok(line.startsWith("LLLLL") || !line.trim(), `viewport frame stays inside at ${JSON.stringify(line)}`)
      assert.ok(!line.includes("�"), "no broken cluster in viewport")
    }
    assert.ok(setup.captureCharFrame().includes("தற்போ"), "active text starts visible in viewport")
    setDocument(normalizeLyrics({ uri, sync_type: "LINE_SYNCED", lines: [
      { text: "Short one", startTimeMs: 0 }, { text: "Short two", startTimeMs: 8000 },
    ] })!)
    setPosition(100)
    await setup.flush()
    assert.equal(setup.renderer.root.findDescendantById("spotify-lyrics-scroll"), undefined,
      "short document leaves the viewport fallback")
  } finally { await setup.dispose() }
}

// Dedicated session panel: mono transport, art slot, responsive art, pointer-only.
{
  layers.length = 0
  let closed = 0, fullscreen = 0
  const panelCalls: { command: string; params: unknown }[] = []
  function panelHarness(panelWidth: number, doc = synthetic) {
    const renderer = useRenderer()
    const [position] = createSignal(3000)
    const state = { ...initialState(), connection: "connected" as const,
      track: { uri, title: "Panel title here", artist: "Panel artist", album: "Panel album", image: "" },
      playback: { ...initialState().playback, trackUri: uri, durationMs: 200000, isPlaying: true, liked: false, shuffle: false, repeat: 0 as const, volume: 0.5, muted: false },
      capabilities: { protocol: 2, apis: {}, commands: [...commands], search_mode: null },
    }
    const context = {
      renderer, theme: { text: { base: "#eef2ec", muted: "#a6afa7", action: { primary: { base: "#8fc7a0" } } } },
      keymap: { layer: (factory: () => KeymapLayer) => layers.push(factory) },
      ui: { toast: { show() {} }, dialog: { clear() {} } }, options: {},
      data: { location: { default: () => ({ directory: "synthetic-test" }) } },
    } as unknown as Context
    const props = {
      context, state: () => state, lyrics: () => doc, position,
      settings: () => defaultLyricsSettings(), sources: () => null,
      saveSettings: async () => {}, refreshLyrics: async () => {}, rpc: {} as MusicProps["rpc"],
      width: panelWidth, close: () => { closed++ }, toggleFullscreen: () => { fullscreen++ },
      presentation: "panel" as const,
      run: async (command: string, params: unknown) => { panelCalls.push({ command, params }); return true },
    }
    return <NowPlayingPanel {...props} />
  }
  for (const panelWidth of [80, 120]) {
    closed = 0; fullscreen = 0; panelCalls.length = 0
    const setup = await testRender(() => panelHarness(panelWidth), { width: panelWidth + 10, height: 40 })
    try {
      await setup.flush()
      const frame = setup.captureCharFrame()
      if (panelWidth === 80) snapshots.push(`panel / 80 columns\n${frame.split("\n").slice(0, 36).join("\n")}`)
      assert.ok(frame.includes("Panel title here"), "panel header shows the track")
      assert.ok(frame.includes("Close"), "panel offers close")
      assert.ok(frame.includes("Full"), "panel offers fullscreen toggle")
      for (const id of ["spotify-previous", "spotify-toggle", "spotify-next", "spotify-close-panel", "spotify-fullscreen", "spotify-cover"]) {
        assert.ok(setup.renderer.root.findDescendantById(id), `${id} mounted at ${panelWidth}`)
      }
      const prev = setup.renderer.root.findDescendantById("spotify-previous") as Renderable
      const toggle = setup.renderer.root.findDescendantById("spotify-toggle") as Renderable
      const next = setup.renderer.root.findDescendantById("spotify-next") as Renderable
      assert.deepEqual([prev.width, toggle.width, next.width], [4, 9, 4], "panel transport widths are fixed")
      const panelNodes = ["spotify-panel-header", "spotify-panel-artwork", "spotify-lyrics-view", "spotify-panel-transport", "spotify-panel-hints"]
        .map((id) => setup.renderer.root.findDescendantById(id) as Renderable)
      for (let i = 1; i < panelNodes.length; i++) assert.ok(panelNodes[i]!.y >= panelNodes[i - 1]!.y + panelNodes[i - 1]!.height,
        `panel order at ${panelWidth}`)
      const cover = setup.renderer.root.findDescendantById("spotify-cover") as Renderable
      const art = setup.renderer.root.findDescendantById("spotify-panel-artwork") as Renderable
      assert.ok(Math.abs((cover.x + cover.width / 2) - (art.x + art.width / 2)) <= 1, "panel art is centered")
      await setup.mockMouse.click(prev.x + 2, prev.y)
      await setup.flush()
      assert.ok(panelCalls.some((call) => call.command === "previous"), "panel transport runs")
      assert.equal(layers.length, 0, "pointer-only: panel registers no keymap layers")
      const closeButton = setup.renderer.root.findDescendantById("spotify-close-panel") as Renderable
      const fullButton = setup.renderer.root.findDescendantById("spotify-fullscreen") as Renderable
      await setup.mockMouse.click(toggle.x + 2, toggle.y)
      await setup.flush()
      assert.ok(panelCalls.some((call) => call.command === "toggle_play"), "panel toggle runs via pointer")
      await setup.mockMouse.click(fullButton.x + 2, fullButton.y)
      await setup.flush()
      await setup.mockMouse.click(closeButton.x + 2, closeButton.y)
      await setup.flush()
      assert.equal(fullscreen, 1, "fullscreen button toggles")
      assert.equal(closed, 1, "close button closes the panel")
      const white = parseColor("#eef2ec").toInts().join(",")
      const dim = parseColor("#a6afa7").toInts().join(",")
      const lyricLines = setup.captureSpans().lines.filter((line) => line.spans.map((span) => span.text).join("").includes("పరీక్ష"))
      assert.ok(lyricLines.length > 0, "panel lyric rows render synthetic lines")
      for (const line of lyricLines) {
        // The scrollbox scrollbar thumb shares terminal rows with lyric text;
        // it is host chrome, not lyric color.
        const paints = new Set(line.spans.filter((span) => span.text.trim() !== "" && span.text !== "█").map((span) => span.fg.toInts().join(",")))
        assert.ok(paints.size === 1 && (paints.has(white) || paints.has(dim)), "one monochrome foreground per lyric line")
      }
      assert.ok(lyricLines.some((line) => line.spans.some((span) => (span.attributes & TextAttributes.BOLD) !== 0)), "active line is bold")
    } finally { await setup.dispose() }
  }
  {
    const setup = await testRender(() => panelHarness(24), { width: 26, height: 24 })
    try {
      await setup.flush()
      assert.equal(setup.renderer.root.findDescendantById("spotify-cover"), undefined, "narrow panel hides art but keeps transport")
      assert.ok(setup.renderer.root.findDescendantById("spotify-toggle"), "narrow panel keeps transport")
      for (const line of setup.captureCharFrame().split("\n")) {
        assert.ok(measure(line.trimEnd()) <= 26, `narrow panel clips to its width: ${line}`)
      }
      snapshots.push(`panel / 24 columns\n${setup.captureCharFrame().split("\n").slice(0, 16).join("\n")}`)
    } finally { await setup.dispose() }
  }
  {
    const setup = await testRender(() => panelHarness(40), { width: 42, height: 14 })
    try {
      await setup.flush()
      assert.ok(setup.renderer.root.findDescendantById("spotify-toggle"), "short panel keeps transport")
      assert.ok(setup.renderer.root.findDescendantById("spotify-lyrics-view"), "short panel keeps lyrics")
      for (const line of setup.captureCharFrame().split("\n")) assert.ok(measure(line.trimEnd()) <= 42, "short panel stays within bounds")
    } finally { await setup.dispose() }
  }
  {
    const setup = await testRender(() => panelHarness(24), { width: 26, height: 9 })
    try {
      await setup.flush()
      assert.ok(setup.renderer.root.findDescendantById("spotify-panel-header"), "tiny panel keeps header")
      assert.ok(setup.renderer.root.findDescendantById("spotify-panel-transport"), "tiny panel keeps transport")
      assert.equal(setup.renderer.root.findDescendantById("spotify-panel-hints"), undefined, "tiny panel drops hints")
      for (const line of setup.captureCharFrame().split("\n")) assert.ok(measure(line.trimEnd()) <= 26, "tiny panel stays within bounds")
    } finally { await setup.dispose() }
  }
  {
    const complexPanel = normalizeLyrics({ uri, sync_type: "LINE_SYNCED", lines: [
      { text: "தமிழ் மலயாளம் " + "தமிழ்மொழிபாடல்வரிகள்".repeat(6), startTimeMs: 0 },
      { text: "മലയാളം ഗാനം " + "അവൻപാടുന്നുകൃഷ്ണൻ".repeat(6), startTimeMs: 8000 },
    ] })!
    const setup = await testRender(() => panelHarness(80, complexPanel), { width: 90, height: 40 })
    try {
      await setup.flush()
      for (const line of setup.captureCharFrame().split("\n")) {
        assert.ok(measure(line.trimEnd()) <= 90, `complex panel line within bounds: ${line}`)
        assert.ok(!line.includes("�"), "complex panel has no broken cluster")
      }
    } finally { await setup.dispose() }
  }
}

// Lyrics route prefers the session panel and falls back to the large dialog.
{
  layers.length = 0
  let opened: string | null = null, dialogShown = false
  const ui = componentProps.context.ui as unknown as Record<string, unknown>
  ui.panel = { open: (name: string) => { opened = name; return true } }
  ui.dialog = { ...(ui.dialog as object), set() {}, show: () => { dialogShown = true } }
  const music = musicActions(componentProps)
  music.lyrics()
  assert.equal(opened, "spotify")
  assert.equal(dialogShown, false)
  ui.panel = { open: () => false }
  music.lyrics()
  assert.equal(dialogShown, true)
  music.dispose()
}

// Volume/seek pointer behavior: instant preview, coalesced live volume, stale
// poll isolation, latest-wins commits and click/drag paths (pointer-only).
{
  layers.length = 0
  calls.length = 0
  failVolume = false
  const setup = await testRender(() => harness("player", 18), { width: 40, height: 40 })
  try {
    setWidth(30); setup.resize(40, 40)
    await setup.flush()
    assert.equal(layers.length, 0, "pointer-only: no keymap layers during slider interaction")
    const volume = layoutOf(setup, "spotify-volume")
    const percent = () => {
      const row = setup.captureCharFrame().split("\n")[volume.y] ?? ""
      const match = row.match(/(\d+)%/)
      return match ? Number(match[1]) : -1
    }
    const volumeCalls = () => calls.filter((call) => call.command === "set_volume")
    // Click seeks instantly, no drag history required.
    await setup.mockMouse.click(volume.x + Math.floor(volume.width / 2), volume.y)
    await setup.flush()
    assert.ok(volumeCalls().length >= 1, "volume click commits")
    assert.ok(Math.abs(((volumeCalls().at(-1)!.params as { value: number }).value) - 0.5) <= 0.06, "click lands mid-range")
    assert.ok(percent() >= 44 && percent() <= 56, `instant click preview: ${percent()}%`)
    // Rapid successive clicks keep the last target and never snap back.
    await setup.mockMouse.click(volume.x + 2, volume.y)
    await setup.mockMouse.click(volume.x + volume.width - 2, volume.y)
    await setup.flush()
    assert.ok((volumeCalls().at(-1)!.params as { value: number }).value > 0.8, "latest volume target wins")
    assert.ok(percent() > 80, `latest volume preview: ${percent()}%`)
    // Drag: live commits while moving, preview follows every event, stale poll ignored.
    const start = calls.length
    await setup.mockMouse.pressDown(volume.x + 1, volume.y)
    await setup.flush()
    for (const offset of [2, 6, 10, 13]) {
      await setup.mockMouse.emitMouseEvent("drag", volume.x + offset, volume.y)
      await setup.flush()
    }
    const live = calls.slice(start).filter((call) => call.command === "set_volume")
    assert.ok(live.length >= 1, "volume commits during drag")
    assert.ok(live.length <= 3, "volume drag is coalesced")
    const dragged = percent()
    assert.ok(dragged > 70, `drag preview follows pointer: ${dragged}%`)
    setPlayback((value) => ({ ...value, volume: 0.9, updatedAt: value.updatedAt + 1 }))
    await setup.flush()
    assert.equal(percent(), dragged, "stale external poll cannot move an active drag")
    await setup.mockMouse.release(volume.x + 13, volume.y)
    await setup.flush()
    const final = (volumeCalls().at(-1)!.params as { value: number }).value
    assert.ok(final > 0.65, "release commits the dragged target")
    setPlayback((value) => ({ ...value, volume: final, updatedAt: value.updatedAt + 1 }))
    await setup.flush()
    assert.ok(percent() >= 65, "acknowledgement keeps the committed target")
    setPlayback((value) => ({ ...value, volume: 0.9, updatedAt: value.updatedAt + 1 }))
    await setup.flush()
    assert.ok(percent() >= 88, "external volume updates when not dragging")
    // Failure path still leaves a usable, non-crashing UI.
    failVolume = true
    await setup.mockMouse.click(volume.x + 2, volume.y)
    await setup.flush()
    assert.ok(percent() >= 88, "failed volume command falls back to the server value")
    failVolume = false
    assert.ok(setup.renderer.root.findDescendantById("spotify-volume"), "volume survives a failed command")
    // Seek drag: immediate thumb/time preview, stale poll isolation, one commit.
    const seek = layoutOf(setup, "spotify-timeline")
    const seekRow = () => setup.captureCharFrame().split("\n")[seek.y]!
    const seekStart = calls.length
    await setup.mockMouse.pressDown(seek.x + 2, seek.y)
    await setup.flush()
    await setup.mockMouse.emitMouseEvent("drag", seek.x + Math.floor(seek.width / 2), seek.y)
    await setup.flush()
    const draggedThumb = seekRow().indexOf("●")
    setPosition(1000)
    await setup.flush()
    assert.equal(seekRow().indexOf("●"), draggedThumb, "stale progress cannot move an active seek drag")
    assert.ok(!calls.slice(seekStart).some((call) => call.command === "seek"), "no seek RPC before release")
    await setup.mockMouse.release(seek.x + Math.floor(seek.width / 2), seek.y)
    await setup.flush()
    const seeks = calls.slice(seekStart).filter((call) => call.command === "seek")
    assert.equal(seeks.length, 1, "one seek commit on release")
    assert.ok((seeks[0]!.params as { positionMs: number }).positionMs > 20000, "seek target is mid-track")
  } finally { await setup.dispose() }
}

// Narrow <13 More fallback opens the complete pointer menu (Music.open:
// playback/search/queue/lyrics/settings); gear-hidden settings stays reachable.
{
  layers.length = 0
  calls.length = 0
  const setup = await testRender(() => harness("player", 18), { width: 40, height: 40 })
  try {
    await setup.flush()
    assert.equal(layers.length, 0, "narrow suite: no keymap layers")
    // Wide: Music + More both visible; More opens playback subset.
    setWidth(24); setup.resize(34, 40)
    await setup.flush()
    assert.ok(setup.renderer.root.findDescendantById("spotify-music"), "wide shows Music")
    assert.ok(setup.renderer.root.findDescendantById("spotify-more"), "wide shows More")
    {
      const base = calls.length
      const more = setup.renderer.root.findDescendantById("spotify-more") as Renderable
      await setup.mockMouse.click(more.x + 2, more.y)
      await setup.flush()
      assert.ok(calls.slice(base).some((c) => c.command === "more"), "wide More opens playback subset")
      assert.ok(!calls.slice(base).some((c) => c.command === "music"), "wide More does not open complete menu")
    }
    // Narrow <13: only More visible; it must open the complete menu.
    setWidth(12); setup.resize(22, 40)
    await setup.flush()
    assert.ok(!setup.renderer.root.findDescendantById("spotify-music"), "narrow hides Music")
    assert.ok(!setup.renderer.root.findDescendantById("spotify-lyrics"), "narrow hides Lyrics")
    assert.ok(setup.renderer.root.findDescendantById("spotify-more"), "narrow keeps More")
    {
      const base = calls.length
      const more = setup.renderer.root.findDescendantById("spotify-more") as Renderable
      await setup.mockMouse.click(more.x + 2, more.y)
      await setup.flush()
      assert.ok(calls.slice(base).some((c) => c.command === "music"), "narrow More opens complete menu")
    }
    // Gear hidden at <9 still reachable via complete menu contents.
    setWidth(8); setup.resize(18, 40)
    await setup.flush()
    assert.ok(!setup.renderer.root.findDescendantById("spotify-settings"), "gear hidden when narrow")
    assert.ok(setup.renderer.root.findDescendantById("spotify-more"), "More survives gear-hidden width")
    {
      const base = calls.length
      const more = setup.renderer.root.findDescendantById("spotify-more") as Renderable
      await setup.mockMouse.click(more.x + 2, more.y)
      await setup.flush()
      assert.ok(calls.slice(base).some((c) => c.command === "music"), "gear-hidden More still opens complete menu")
    }
    // Complete menu (Music.open) must contain playback/search/queue/lyrics/settings.
    {
      const seen: string[] = []
      const dlg = componentProps.context.ui.dialog as unknown as { select: (o: { options: { title: string; value: string }[] }) => Promise<string | undefined> }
      const prevSelect = dlg.select
      dlg.select = async (opts) => { for (const o of opts.options) seen.push(o.title); return undefined }
      const music = musicActions(componentProps)
      await music.open()
      dlg.select = prevSelect
      music.dispose()
      // Titles are truncated to renderer width (fit), so match prefixes.
      for (const need of ["Now Pla", "Queue", "Search", "Lyrics", "Refresh"]) {
        assert.ok(seen.some((t) => t.includes(need)), `complete menu has ${need}: ${seen.join("|")}`)
      }
    }
  } finally { await setup.dispose() }
}

// Core 0.9.0 outside release + no cross-activation (real renderer, public mock API only).
// Press slider, drag outside onto another control, release outside: slider commits
// once (clamped), the outside control does NOT activate (drop is ignored, up goes to capture).
{
  layers.length = 0
  calls.length = 0
  const setup = await testRender(() => harness("player", 18), { width: 40, height: 40 })
  try {
    setWidth(30); setup.resize(40, 40)
    await setup.flush()
    const seek = layoutOf(setup, "spotify-timeline")
    const toggle = layoutOf(setup, "spotify-toggle") as Renderable
    const baseToggle = calls.filter((c) => c.command === "toggle_play").length
    const start = calls.length
    await setup.mockMouse.pressDown(seek.x + 2, seek.y)
    await setup.flush()
    // Drag outside the slider, onto the toggle row (outside capture target).
    await setup.mockMouse.emitMouseEvent("drag", toggle.x + 2, toggle.y)
    await setup.flush()
    await setup.mockMouse.release(toggle.x + 2, toggle.y)
    await setup.flush()
    const seeks = calls.slice(start).filter((c) => c.command === "seek")
    assert.equal(seeks.length, 1, "outside release commits exactly once")
    assert.equal(calls.filter((c) => c.command === "toggle_play").length, baseToggle, "outside release does not cross-activate toggle")
    // Volume outside release clamps to endpoint, still single commit path.
    const volume = layoutOf(setup, "spotify-volume") as Renderable
    const vStart = calls.length
    await setup.mockMouse.pressDown(volume.x + 2, volume.y)
    await setup.flush()
    await setup.mockMouse.emitMouseEvent("drag", volume.x + volume.width + 5, volume.y)
    await setup.flush()
    await setup.mockMouse.release(volume.x + volume.width + 5, volume.y)
    await setup.flush()
    const vols = calls.slice(vStart).filter((c) => c.command === "set_volume")
    assert.ok(vols.length >= 1, "volume outside release commits")
    assert.deepEqual(vols.at(-1)!.params, { value: 1 }, "outside release clamps to endpoint")
  } finally { await setup.dispose() }
}

// Disabled controls must not go silent: caller toast explains why, no RPC.
{
  layers.length = 0
  calls.length = 0
  const toasts: string[] = []
  const setup = await testRender(() => harness("player", 18), { width: 40, height: 40 })
  try {
    setWidth(30); setup.resize(40, 40)
    await setup.flush()
    const ctx = componentProps.context as unknown as { ui: { toast: { show: (o: { message: string }) => void } } }
    const prevShow = ctx.ui.toast.show
    ctx.ui.toast.show = (o) => { toasts.push(o.message) }
    // Disable mute by clearing its state (mute API/state unavailable).
    setPlayback((v) => ({ ...v, muted: null }))
    await setup.flush()
    const mute = setup.renderer.root.findDescendantById("spotify-mute") as Renderable
    assert.ok(mute, "mute mounted when disabled")
    const base = calls.length
    await setup.mockMouse.click(mute.x + 2, mute.y)
    await setup.flush()
    assert.equal(calls.length, base, "disabled click sends no RPC")
    assert.ok(toasts.some((m) => /mute|unavailable|Spotify/i.test(m)), `disabled click toasts reason: ${toasts.join("|")}`)
    ctx.ui.toast.show = prevShow
    // Restore for later suites.
    setPlayback((v) => ({ ...v, muted: false }))
    await setup.flush()
  } finally { await setup.dispose() }
}

// Genuine renderer editor focus+typing regression (pointer-only):
// an <input> editor keeps focus and typing across MiniPlayer clicks,
// slider drags, track/lyric updates, resize and a repeat mount. No custom
// key interception; buttons/sliders use preventDefault so the host editor
// is never stolen.
{
  layers.length = 0
  calls.length = 0
  let editorSetPosition!: (n: number) => void
  let editorSetDocument!: (value: typeof synthetic) => void
  function editorHarness() {
    const renderer = useRenderer()
    const [position, updatePosition] = createSignal(100)
    const [lyricsDoc, updateLyrics] = createSignal(synthetic)
    editorSetPosition = updatePosition; editorSetDocument = updateLyrics
    const [playback] = createSignal({ ...initialState().playback, trackUri: uri, durationMs: 200000, isPlaying: true, liked: false, shuffle: false, repeat: 0 as const, volume: 0.5, muted: false })
    const state = () => ({ ...initialState(), connection: "connected" as const,
      track: { uri, title: "Editor focus track", artist: "Artist", album: "Album", image: "" },
      playback: playback(), capabilities: { protocol: 2, apis: {}, commands: [...commands], search_mode: null },
    })
    const context = {
      renderer, theme: { text: { base: "#eef2ec", muted: "#a6afa7" } },
      keymap: { layer: (factory: () => KeymapLayer) => layers.push(factory) },
      ui: { toast: { show() {} }, dialog: { clear() {} } }, options: {},
      data: { location: { default: () => ({ directory: "synthetic-test" }) } },
    } as unknown as Context
    const props = {
      context, state, lyrics: () => lyricsDoc(), position,
      settings: () => defaultLyricsSettings(), sources: () => null,
      saveSettings: async () => {}, refreshLyrics: async () => {},
      previewSeek: (ms: number) => updatePosition(ms),
      rpc: {} as MusicProps["rpc"],
    }
    const run = async (command: string, params: unknown) => { calls.push({ command, params }); return true }
    return <box flexDirection="row" width="100%" height="100%">
      <box width={40} height="100%" flexDirection="column">
        <input id="editor" width={30} value="" placeholder="type here" />
        <box height={1}><text>EDITOR SENTINEL</text></box>
      </box>
      <box width={30} height={20}>
        <MiniPlayer {...props} budget={() => 18} open={() => { calls.push({ command: "music", params: {} }) }}
          openLyrics={() => { calls.push({ command: "lyrics", params: {} }) }} openSettings={() => { calls.push({ command: "settings", params: {} }) }}
          more={() => { calls.push({ command: "more", params: {} }) }} run={run} />
      </box>
    </box>
  }
  const runEditorSuite = async () => {
    const setup = await testRender(() => editorHarness(), { width: 80, height: 30 })
    try {
      await setup.flush()
      assert.equal(layers.length, 0, "editor suite: no keymap layers")
      const editor = setup.renderer.root.findDescendantById("editor") as unknown as { focus: () => void; value: string }
      assert.ok(editor, "editor mounted")
      editor.focus()
      await setup.flush()
      assert.equal(setup.renderer.currentFocusedEditor as unknown, editor as unknown, "editor holds renderer focus")
      await setup.mockInput.typeText("hi")
      await setup.flush()
      assert.ok((editor.value ?? "").includes("hi"), `typing works before pointer: ${JSON.stringify(editor.value)}`)
      const toggle = setup.renderer.root.findDescendantById("spotify-toggle") as Renderable
      await setup.mockMouse.click(toggle.x + 2, toggle.y)
      await setup.flush()
      assert.equal(setup.renderer.currentFocusedEditor as unknown, editor as unknown, "click does not steal editor focus")
      assert.ok(calls.some((c) => c.command === "toggle_play"), "click still runs")
      await setup.mockInput.typeText("-after-click")
      await setup.flush()
      assert.ok((editor.value ?? "").includes("after-click"), "typing works after click")
      const seek = setup.renderer.root.findDescendantById("spotify-timeline") as Renderable
      await setup.mockMouse.pressDown(seek.x + 2, seek.y)
      await setup.flush()
      await setup.mockMouse.emitMouseEvent("drag", seek.x + Math.floor(seek.width / 2), seek.y)
      await setup.flush()
      assert.equal(setup.renderer.currentFocusedEditor as unknown, editor as unknown, "drag does not steal editor focus")
      await setup.mockMouse.release(seek.x + Math.floor(seek.width / 2), seek.y)
      await setup.flush()
      assert.ok(calls.some((c) => c.command === "seek"), "drag release seeks")
      await setup.mockInput.typeText("-after-drag")
      await setup.flush()
      assert.ok((editor.value ?? "").includes("after-drag"), "typing works after drag")
      editorSetPosition(5000)
      editorSetDocument(synthetic)
      await setup.flush()
      assert.equal(setup.renderer.currentFocusedEditor as unknown, editor as unknown, "track/lyric update keeps editor focus")
      await setup.mockInput.typeText("-after-track")
      await setup.flush()
      assert.ok((editor.value ?? "").includes("after-track"), "typing works after track update")
      setup.resize(70, 25)
      await setup.flush()
      assert.equal(setup.renderer.currentFocusedEditor as unknown, editor as unknown, "resize keeps editor focus")
      await setup.mockInput.typeText("-after-resize")
      await setup.flush()
      assert.ok((editor.value ?? "").includes("after-resize"), "typing works after resize")
    } finally { await setup.dispose() }
  }
  await runEditorSuite()
  calls.length = 0; layers.length = 0
  await runEditorSuite()
  console.log("editor focus+typing regression passed (click/drag/track/resize/repeat mount)")
}

// Layout matrix 120x40 and 100x40 + smaller with expanded native sections:
// pinned footer, same placement, editor region untouched.
{
  layers.length = 0
  function matrixHarness(todo: number, terminalHeight: number, sidebarWidth = 34, playerWidth = 24) {
    const renderer = useRenderer()
    const state = { ...initialState(), connection: "connected" as const,
      track: { uri, title: "Matrix title", artist: "Matrix artist", album: "A", image: "" },
      playback: { ...initialState().playback, trackUri: uri, durationMs: 200000, isPlaying: true, liked: false,
        shuffle: false, repeat: 0 as const, volume: 0.5, muted: false },
      capabilities: { protocol: 2, apis: {}, commands: [...commands], search_mode: null },
    }
    const context = {
      renderer, theme: { text: { base: "#eef2ec", muted: "#a6afa7" } }, keymap: { layer() {} },
      ui: { toast: { show() {} }, dialog: {}, panel: { current: () => undefined } }, options: {},
      data: { location: { default: () => ({ directory: "host-fixture" }) } },
    } as unknown as Context
    const music = {
      context, state: () => state, lyrics: () => synthetic, position: () => 4200,
      settings: () => defaultLyricsSettings(), sources: () => null, saveSettings: async () => {}, refreshLyrics: async () => {},
      rpc: {} as MusicProps["rpc"], open() {}, openLyrics() {}, openSettings() {}, more() {}, run: async () => true,
    }
    const playerHeight = playerLayout(playerBudget(terminalHeight), {
      hasTrack: true, width: playerWidth - 2, aspect: 2, artwork: true, showVolume: true, preview: true,
    }).total
    return <box flexDirection="row" width="100%" height="100%">
      <box id="host-sidebar" width={sidebarWidth} height={terminalHeight} flexDirection="column" overflow="hidden">
        <box height={1}><text>Sidebar</text></box>
        <box id="host-scroll" flexGrow={1} flexBasis={0} minHeight={0} overflow="hidden" flexDirection="column">
          <box height={4} flexShrink={0}><text>Context / MCP expanded</text></box>
          <box height={todo} flexShrink={0}><text>{"Todo item expanded\n".repeat(todo)}</text></box>
        </box>
        <box id="host-footer" flexShrink={0} paddingTop={1} gap={1}>
          <box id="host-player-row" flexDirection="row" width="100%" height={playerHeight}>
            <text width={5} height={playerHeight}>{"LLLLL\n".repeat(40)}</text>
            <box width={playerWidth} minWidth={0} flexShrink={0}>
              <MiniPlayer {...music} budget={() => playerBudget(terminalHeight)} />
            </box>
            <text width={5} height={playerHeight}>{"RRRRR\n".repeat(40)}</text>
          </box>
          <text height={1}>D:\project</text>
        </box>
      </box>
      <box id="host-editor" flexGrow={1}>
        <text>{"EDITOR\n".repeat(40)}</text>
      </box>
    </box>
  }
  for (const [termWidth, termHeight] of [[120, 40], [100, 40], [80, 30], [60, 24]] as const) {
    const small = await testRender(() => matrixHarness(2, termHeight), { width: termWidth, height: termHeight })
    const large = await testRender(() => matrixHarness(18, termHeight), { width: termWidth, height: termHeight })
    try {
      await small.flush(); await large.flush()
      const playerSmall = layoutOf(small, "spotify-player")
      const playerLarge = layoutOf(large, "spotify-player")
      assert.equal(playerLarge.screenY, playerSmall.screenY, `Todo growth does not move footer at ${termWidth}x${termHeight}`)
      assert.equal(playerLarge.height, playerSmall.height, `Todo growth does not resize player at ${termWidth}x${termHeight}`)
      assert.ok(playerSmall.screenY + playerSmall.height <= termHeight - 1, `player pinned above footer at ${termWidth}x${termHeight}`)
      assert.ok(playerSmall.screenX >= 0 && playerSmall.screenX + playerSmall.width <= 34, `player stays in sidebar at ${termWidth}x${termHeight}`)
      for (const setup of [small, large]) {
        const player = layoutOf(setup, "spotify-player")
        assert.ok(layoutOf(setup, "spotify-toggle"), `transport survives at ${termWidth}x${termHeight}`)
        const frame = setup.captureCharFrame().split("\n").slice(player.screenY, player.screenY + player.height)
        for (const line of frame) {
          assert.ok(line.startsWith("LLLLL"), `matrix left sentinel ${termWidth}x${termHeight}: ${line}`)
          const marker = line.indexOf("RRRRR")
          assert.ok(marker > 5, `matrix right sentinel ${termWidth}x${termHeight}: ${line}`)
          const after = line.slice(marker + 5)
          assert.ok(after.startsWith("EDITOR") || after.trim() === "", `editor untouched at ${termWidth}x${termHeight}: ${line}`)
        }
      }
      if (termWidth === 120 && termHeight === 40) snapshots.push(`matrix / 120x40 Todo 18\n${large.captureCharFrame()}`)
      if (termWidth === 100 && termHeight === 40) snapshots.push(`matrix / 100x40 Todo 18\n${large.captureCharFrame()}`)
    } finally { await small.dispose(); await large.dispose() }
  }
  console.log("layout matrix 120x40/100x40+smaller passed")
}

for (const base of ["#eeeeee", "#202020"]) {
  const colors = lyricColors(base)
  for (const color of [colors.text, colors.muted]) assert.ok(contrast(color, colors.background) >= 4.5)
}
assert.equal(graphicsCapabilities(null).imageProtocol, "blocks")
if (process.env.SPOTIFY_CAPTURE_FRAMES === "1") writeFileSync("../docs/V0.5.5_RENDER_SNAPSHOTS.txt", snapshots.join("\n\n"))
console.log("native player/lyrics rendering, bounds, resize, mouse and command handlers passed")
