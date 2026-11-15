import assert from "node:assert/strict"
import { measureEditText, getTimelineEngine, type Renderable, type ScrollBoxRenderable, type TerminalCapabilities } from "@opentui/core"
import { testRender, useRenderer } from "@opentui/solid"
import { createSignal } from "solid-js"
import { wrapCells, lyricLayout, truncateCells } from "../src/ui/layout.ts"
import { CellText } from "../src/ui/primitives.tsx"
import { MiniPlayer } from "../src/components/MiniPlayer.tsx"
import { LyricsView } from "../src/components/LyricsView.tsx"
import { normalizeLyrics } from "../src/services/lyrics.ts"
import { defaultLyricsSettings } from "../src/services/lyrics-source.ts"
import { initialState } from "../src/services/state.ts"
import { commands, normalizeQueue, normalizePage } from "../src/services/validation.ts"
import type { MusicProps } from "../src/components/Music.tsx"
import type { Context, KeymapLayer } from "@opencode/plugin/tui/context"
import { lyricColors, contrast, graphicsCapabilities } from "../src/ui/colors.ts"
import { writeFileSync } from "node:fs"
import { lyricsSettingsDialog } from "../src/components/LyricsSettings.ts"
import { musicActions } from "../src/components/Music.tsx"
import type { LyricsSettings } from "../src/services/lyrics-source.ts"

const measure = (s: string) => measureEditText(s, { widthMethod: "unicode" })
const samples = [
  "తెలుగు పదాలు మన పరీక్ష కోసం మాత్రమే రాసిన పంక్తులు ".repeat(5),
  "यह केवल परीक्षण के लिए लिखी गई पंक्ति है ".repeat(5),
  "తెలుగు and English కలిసి testing ".repeat(5),
  "mana pariksha kosam oka podavaaina pankti ".repeat(5),
  "e\u0301".repeat(60), "👩‍💻👨‍👩‍👧‍👦界".repeat(30),
  "క్ష".repeat(80), "longwordwithoutspaces".repeat(20),
  "\u0301\u0308 combining marks at the left edge", "తెలుగు \u200d mixed joins 👩‍💻",
]
for (const width of [1, 2, 24, 30, 40, 60]) {
  for (const sample of samples) {
    const rows = wrapCells(sample, width, measure)
    assert.ok(rows.length > 0)
    for (const row of rows) assert.ok(measure(row) <= width, JSON.stringify({ row, width }))
    assert.ok(measure(truncateCells(sample, width, measure)) <= width)
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
} finally { await probe.dispose() }
console.log("native cell-boundary rendering passed")

const uri = "spotify:track:1234567890123456789012"
const synthetic = normalizeLyrics({ uri, sync_type: "LINE_SYNCED", lines: Array.from({ length: 100 }, (_, index) => ({
  text: `పరీక్ష ${index} తెలుగు పదాలు and English synthetic text for wrapping`,
  startTimeMs: index * 2000,
})) })!
const calls: { command: string; params: unknown }[] = []
const layers: (() => KeymapLayer)[] = []
let setWidth!: (n: number) => void, setPosition!: (n: number) => void, setDocument!: (value: typeof synthetic) => void
let setReducedMotion!: (value: boolean) => void, setHeight!: (value: number) => void
let componentProps!: MusicProps
function harness(kind: "player" | "lyrics", contentHeight: number) {
  const renderer = useRenderer()
  const [width, updateWidth] = createSignal(24)
  const [position, updatePosition] = createSignal(100)
  const [lyrics, updateLyrics] = createSignal(synthetic)
  const [reducedMotion, updateReduced] = createSignal(true)
  const [viewHeight, updateHeight] = createSignal(contentHeight)
  setWidth = updateWidth; setPosition = updatePosition; setDocument = updateLyrics
  setReducedMotion = updateReduced; setHeight = updateHeight
  const state = { ...initialState(), connection: "connected" as const,
    track: { uri, title: "పరీక్ష శీర్షిక a long synthetic title", artist: "పరీక్ష కళాకారుడు", album: "Original synthetic tests", image: "" },
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
    context, state: () => state, lyrics, position, settings: () => ({ ...defaultLyricsSettings(), reducedMotion: reducedMotion() }),
    sources: () => null, saveSettings: async () => {}, refreshLyrics: async () => {},
    rpc: {} as MusicProps["rpc"],
  }
  componentProps = props
  const run = async (command: string, params: unknown) => { calls.push({ command, params }) }
  return <box flexDirection="row" width="100%" height="100%">
    <text width={5} height="100%" zIndex={0}>{"LLLLL\n".repeat(60)}</text>
    <box width={width()} height={viewHeight()} minWidth={0} flexShrink={0} zIndex={1}>
      {kind === "player" ? <MiniPlayer {...props} open={() => { calls.push({ command: "music", params: {} }) }}
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
for (const kind of ["player", "lyrics"] as const) {
  layers.length = 0
  const setup = await testRender(() => harness(kind, 18), { width: 80, height: 40 })
  try {
    for (const width of [24, 30, 40, 60]) {
      setWidth(width); setup.resize(width + 10, 40)
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
      assert.ok(like && like.width > 3)
      await setup.mockMouse.click(like.x + 2, like.y)
      await setup.flush()
      assert.deepEqual(calls.find((call) => call.command === "set_liked")?.params, { uri, value: true })
      const focus = layers.flatMap((factory) => factory().commands ?? []).find((command) => command.id === "spotify.focus")!
      await focus.run()
      const keyboard = layers.map((factory) => factory()).find((layer) => layer.target?.())!
      await keyboard.commands!.find((command) => command.bind === "shift+tab")!.run()
      await keyboard.commands!.find((command) => command.bind === "return")!.run()
      assert.ok(calls.some((call) => call.command === "previous"), "keyboard controls activate the selected action")
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
      const volume = setup.renderer.root.findDescendantById("spotify-volume") as Renderable
      await setup.mockMouse.drag(volume.x + 2, volume.y, volume.x + volume.width - 1, volume.y)
      await setup.flush()
      assert.deepEqual(calls.at(-1), { command: "set_volume", params: { value: 1 } })
      await keyboard.commands!.find((command) => command.bind === "home")!.run()
      assert.deepEqual(calls.at(-1), { command: "set_volume", params: { value: 0 } })
      setHeight(36); setup.resize(70, 44)
      await setup.flush()
      assert.ok((setup.renderer.root.findDescendantById("spotify-player") as Renderable).height > 22)

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
      assert.ok(requested.some((request) => request.command === "add_to_queue"))
      choices.push("playlists", "spotify:folder:test", "spotify:playlist:1234567890123456789012", "play", "__back", "__back")
      await music.open()
      assert.ok(requested.some((request) => request.command === "play_context"))
      choices.push("library", "__back")
      await music.open()
      assert.ok(requested.some((request) => request.command === "get_library"))
      music.dispose()
    } else {
      const scroll = control as ScrollBoxRenderable
      setPosition(30000)
      await setup.flush()
      assert.ok(scroll.scrollTop > 0, "follows actual wrapped row offsets")
      const keyboard = layers.at(-1)!()
      await keyboard.commands!.find((command) => command.bind === "up")!.run()
      await setup.flush()
      const manualTop = scroll.scrollTop
      const rowBefore = visibleSyntheticLine(setup.captureCharFrame())
      scroll.scrollBy(12)
      await setup.flush()
      assert.ok(visibleSyntheticLine(setup.captureCharFrame()) > rowBefore, "scroll offset refreshes virtual rows")
      const movedTop = scroll.scrollTop
      assert.ok(movedTop > manualTop)
      setPosition(60000)
      await setup.flush()
      assert.equal(scroll.scrollTop, movedTop, "manual scroll does not snap back")
      await keyboard.commands!.find((command) => command.bind === "f")!.run()
      await setup.flush()
      assert.ok(scroll.scrollTop > manualTop)
      setReducedMotion(false)
      await setup.flush()
      setPosition(62000)
      await setup.flush()
      const start = scroll.scrollTop
      getTimelineEngine(setup.renderer).update(90)
      await setup.flush()
      assert.ok(scroll.scrollTop >= start, "bounded forward animation")
      await keyboard.commands!.find((command) => command.bind === "up")!.run()
      await setup.flush()
      const stopped = scroll.scrollTop
      getTimelineEngine(setup.renderer).update(1000)
      await setup.flush()
      assert.equal(scroll.scrollTop, stopped, "manual input cancels motion")
      const changed = normalizeLyrics({ uri: "spotify:track:xxxxxxxxxxxxxxxxxxxxxx", sync_type: "LINE_SYNCED",
        lines: [{ text: "కొత్త పరీక్ష పంక్తి", startTimeMs: 0 }] })!
      setDocument(changed)
      await setup.flush()
      assert.equal(scroll.scrollTop, 0, "track changes reset scroll")
      assert.ok(setup.captureCharFrame().includes("కొత్త"))
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

// Only genuine provider word timings create individual highlight spans.
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
    const accent = lyricColors("#eef2ec", "#8fc7a0").active.toInts()
    const find = () => setup.captureSpans().lines.find((line) => line.spans.map((span) => span.text).join("").includes("Alpha beta"))
    const first = find()
    assert.ok(first, setup.captureCharFrame())
    assert.deepEqual(first.spans.find((span) => span.text.includes("Alpha"))?.fg.toInts(), accent)
    assert.notDeepEqual(first.spans.find((span) => span.text.includes("beta"))?.fg.toInts(), accent)
    setPosition(2500)
    await setup.flush()
    const second = find()
    assert.ok(second)
    assert.deepEqual(second.spans.find((span) => span.text.includes("beta"))?.fg.toInts(), accent)
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
    assert.ok((setup.renderer.root.findDescendantById("spotify-player") as Renderable).height <= 6)
  } finally { await setup.dispose() }
}

for (const base of ["#eeeeee", "#202020"]) {
  const colors = lyricColors(base, "#111111", "#ff0000")
  for (const color of [colors.text, colors.muted, colors.active]) assert.ok(contrast(color, colors.background) >= 4.5)
}
assert.equal(graphicsCapabilities(null).imageProtocol, "blocks")
if (process.env.SPOTIFY_CAPTURE_FRAMES === "1") writeFileSync("../docs/V0.5_RENDER_SNAPSHOTS.txt", snapshots.join("\n\n"))
console.log("native player/lyrics rendering, bounds, resize, mouse and command handlers passed")
