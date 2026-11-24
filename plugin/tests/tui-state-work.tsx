// Production TUI state regression worker (bun only; run via tests/tui-state.test.ts).
//
// Drives the REAL plugin setup() from src/tui.tsx with a deferred fake
// Spotify RPC and the real MiniPlayer render path. No network, no
// credentials, no Spotify.
//
// Pins, against the occurrence counter + batched adoption in tui.tsx:
//  1. Stale hydrate A->B->A: deferred sources for older occurrences never
//     clobber the current occurrence's lyrics.
//  2. Refresh crossing a track occurrence (gear pointer -> settings dialog
//     "refresh"): no cache-busting refresh:true sources call lands on the
//     new track, and the departed occurrence's pending flag is dropped.
//  3. Batched adoption hydrates lyrics even when a stale seek echo is
//     ignored for the clock.
import assert from "node:assert/strict"
import { testRender, useRenderer } from "@opentui/solid"
import type { Renderable } from "@opentui/core"
import tuiPlugin from "../src/tui.tsx"
import { formatTime, initialState, type SpotifyState } from "../src/services/state.ts"
import { normalizeLyrics, type Lyrics } from "../src/services/lyrics.ts"
import type { SourceResolution } from "../src/services/LyricsSourceManager.ts"
import type { Context, SlotClaim } from "@opencode/plugin/tui/context"

const A = "spotify:track:AAAAAAAAAAAAAAAAAAAAAA"
const B = "spotify:track:BBBBBBBBBBBBBBBBBBBBBB"
const DIRECTORY = "tui-state-test"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const docAOld = normalizeLyrics({ uri: A, sync_type: "LINE_SYNCED",
  lines: [{ text: "alpha old lyric line", startTimeMs: 1000 }] })!
const docANew = normalizeLyrics({ uri: A, sync_type: "LINE_SYNCED",
  lines: [{ text: "alpha NEW lyric line", startTimeMs: 1000 }] })!
const docANew2 = normalizeLyrics({ uri: A, sync_type: "LINE_SYNCED",
  lines: [{ text: "alpha newest lyric line", startTimeMs: 1000 }] })!
const docB = normalizeLyrics({ uri: B, sync_type: "LINE_SYNCED",
  lines: [{ text: "beta lyric line", startTimeMs: 1000 }] })!
const docA3 = normalizeLyrics({ uri: A, sync_type: "LINE_SYNCED",
  lines: [{ text: "alpha third lyric line", startTimeMs: 1000 }] })!

let revision = 0
function trackState(uri: string, lyricsRevision: number, playback: Record<string, number | boolean | null | string> = {}): SpotifyState {
  const base = initialState()
  return {
    ...base,
    epoch: "tui-state-epoch",
    revision: ++revision,
    lyricsRevision,
    connection: "connected",
    track: { uri, title: `title ${uri.slice(-4)}`, artist: "artist", album: "album", image: "" },
    playback: { ...base.playback, trackUri: uri, isPlaying: true, positionMs: 5000, durationMs: 200000,
      shuffle: false, repeat: 0 as const, volume: 0.5, muted: false, liked: false, updatedAt: Date.now(), ...playback },
    capabilities: { protocol: 2 as const, apis: {}, commands: ["get_playback", "refresh_lyrics", "seek", "toggle_play", "play", "pause", "next", "previous"] as never, search_mode: null },
    error: null,
  }
}

const resolution = (uri: string, docs: Lyrics[]): SourceResolution => ({
  uri,
  candidates: docs,
  availability: [{ provider: "spotify", state: "ready", detail: "Connected Spotify client" }],
})

// ---------------------------------------------------------------------------
// Deferred fake Spotify RPC + fake host. Only signals the production setup
// subscribes to; every async boundary is test-controlled.
// ---------------------------------------------------------------------------
const sourcesCalls: { uri: string; refresh: boolean }[] = []
const sourcesQueue: ReturnType<typeof deferred<SourceResolution>>[] = []
const commandCalls: { command: string; params: unknown }[] = []
let refreshCmd: ReturnType<typeof deferred<{ ok: boolean; result: unknown }>> | undefined
let currentUri: string | null = null
let updatedHandler: ((event: unknown) => void) | undefined

const fakeRpc = {
  getState: async () => initialState(),
  getLyricsSources: async (params: { uri: string; lrclib: boolean; contact: string; refresh: boolean }) => {
    sourcesCalls.push({ uri: params.uri, refresh: params.refresh })
    const next = sourcesQueue.shift()
    assert.ok(next, `unexpected getLyricsSources call for ${params.uri}`)
    return next!.promise
  },
  command: async (input: { command: string; params?: unknown }) => {
    commandCalls.push({ command: input.command, params: input.params })
    if (input.command === "refresh_lyrics") {
      assert.ok(refreshCmd, "refresh_lyrics command without an armed deferred")
      return refreshCmd!.promise
    }
    if (input.command === "get_playback") {
      return { ok: true as const, result: { trackUri: currentUri, positionMs: 6000, durationMs: 200000,
        isPlaying: true, shuffle: false, repeat: 0, volume: 0.5, muted: false, liked: false, updatedAt: Date.now() } }
    }
    return { ok: true as const, result: { accepted: true } }
  },
  events: { on: (_event: string, handler: (event: unknown) => void) => {
    updatedHandler = handler
    return () => { updatedHandler = undefined }
  } },
}

const emit = (state: SpotifyState) => {
  currentUri = state.track?.uri ?? null
  assert.ok(updatedHandler, "updated handler not subscribed")
  updatedHandler!({ location: { directory: DIRECTORY }, data: { state } })
}

const slotClaims: SlotClaim[] = []
const dialogQueue: (string | undefined)[] = []
const storedSettings = { provider: "auto" as const, script: "romanized" as const, priority: "timing" as const,
  preview: true, follow: true, reducedMotion: true, background: true, accent: "", lrclibEnabled: false,
  lrclibContact: "", overrides: {}, ambience: "album" as const, artwork: false, artworkSize: "auto" as const,
  progressMotion: true, showVolume: true, seekSeconds: null, instrumental: true, strongEmphasis: true }

function makeContext(renderer: unknown): Context {
  return {
    options: {},
    location: { directory: DIRECTORY },
    app: { version: "tui-state-test", channel: "test" },
    renderer,
    client: { rpc: (_definition: unknown) => fakeRpc },
    data: {
      on: () => () => {},
      location: { default: () => ({ directory: DIRECTORY }) },
    },
    attention: { notify: async () => ({ ok: true, notification: false, sound: false }) },
    theme: { text: { base: "#eef2ec", muted: "#a6afa7", action: { primary: { base: "#8fc7a0" } } } },
    themeMode: "dark",
    markdown: { registerCodeBlockRenderer: () => () => {} },
    keymap: { layer: () => {} },
    storage: { store: () => [storedSettings, async (mutate: (draft: typeof storedSettings) => void) => { mutate(storedSettings) }] },
    ui: {
      dialog: {
        show: () => {},
        set: () => {},
        clear: () => {},
        alert: async () => {},
        confirm: async () => undefined,
        prompt: async () => undefined,
        select: async () => dialogQueue.shift(),
      },
      toast: { show: () => {} },
      format: { path: (value: string) => value },
      router: { register: () => () => {}, navigate: () => {}, current: () => ({ type: "home" as const }) },
      panel: { open: () => false, close: () => {}, current: () => undefined },
      tabs: { enabled: () => false, list: () => [], open: () => false, focus: () => false, move: () => false, close: () => false },
      model: { current: () => undefined, variant: { list: () => [], set: () => false } },
      slot: (claim: SlotClaim) => { slotClaims.push(claim); return () => {} },
    },
  } as unknown as Context
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
async function until(condition: () => boolean, label: string) {
  const deadline = Date.now() + 5000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await sleep(5)
  }
}

let booted = false
let stopPlugin: (() => void) | undefined
function Harness() {
  const renderer = useRenderer()
  if (!booted) {
    booted = true
    stopPlugin = tuiPlugin.setup(makeContext(renderer)) as unknown as () => void
  }
  const footer = slotClaims.find((claim) => "prepend" in claim &&
    (claim as { prepend?: unknown }).prepend === "sidebar.footer")
  assert.ok(footer && "render" in footer, "footer slot claimed by production setup")
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const footerNode = (footer.render as any)({ sessionID: "s" }) as any
  return <box width="100%" height="100%">{footerNode}</box>
}

const setup = await testRender(() => <Harness />, { width: 60, height: 40 })
const frame = () => setup.captureCharFrame()
const has = (text: string) => frame().includes(text)
try {
  await setup.flush()
  await sleep(20)
  await setup.flush()
  assert.equal(sourcesCalls.length, 0, "no hydration before the first track")

  // --- 1. Stale hydrate A->B->A ---------------------------------------------
  const dA1 = deferred<SourceResolution>()
  const dB1 = deferred<SourceResolution>()
  const dA2 = deferred<SourceResolution>()
  sourcesQueue.push(dA1, dB1, dA2)
  emit(trackState(A, 1))
  await until(() => sourcesCalls.length === 1, "hydrate A occurrence 1")
  emit(trackState(B, 1))
  await until(() => sourcesCalls.length === 2, "hydrate B occurrence")
  emit(trackState(A, 2))
  await until(() => sourcesCalls.length === 3, "hydrate A occurrence 2")
  dB1.resolve(resolution(B, [docB]))
  await sleep(20)
  await setup.flush()
  dA1.resolve(resolution(A, [docAOld]))
  await sleep(20)
  await setup.flush()
  assert.ok(!has("alpha old lyric line"), "stale A occurrence 1 doc never renders")
  assert.ok(!has("beta lyric line"), "stale B doc never renders on A")
  dA2.resolve(resolution(A, [docANew]))
  await sleep(20)
  await setup.flush()
  assert.ok(has("alpha NEW lyric line"), "current occurrence doc renders")
  assert.ok(!has("alpha old lyric line"), "superseded occurrence doc stays out")
  console.log("stale hydrate A->B->A pinned")

  // --- 2. Refresh crossing a track occurrence (gear pointer) ------------------
  const gear = setup.renderer.root.findDescendantById("spotify-settings") as Renderable | undefined
  assert.ok(gear, "settings gear mounted")
  dialogQueue.push("refresh", undefined)
  refreshCmd = deferred<{ ok: boolean; result: unknown }>()
  await setup.mockMouse.click(gear.x + 2, gear.y)
  await until(() => commandCalls.some((call) => call.command === "refresh_lyrics"), "refresh command sent")
  const dB2 = deferred<SourceResolution>()
  sourcesQueue.push(dB2)
  emit(trackState(B, 1))
  await until(() => sourcesCalls.length === 4, "normal hydrate for the new occurrence")
  dB2.resolve(resolution(B, [docB]))
  await sleep(20)
  await setup.flush()
  assert.ok(has("beta lyric line"), "B lyrics render while the old refresh is pending")
  // Return to the same URI before the old refresh completes. A URI-only
  // guard would incorrectly issue a second source request for this visit.
  const dA3 = deferred<SourceResolution>()
  sourcesQueue.push(dA3)
  emit(trackState(A, 3))
  await until(() => sourcesCalls.length === 5, "hydrate on return to A")
  dA3.resolve(resolution(A, [docANew2]))
  await sleep(20)
  await setup.flush()
  assert.ok(has("alpha newest lyric line"), "return to A selects the fresh doc")
  refreshCmd.resolve({ ok: true, result: { accepted: true } })
  await new Promise<void>((resolve) => setImmediate(resolve))
  await setup.flush()
  assert.equal(sourcesCalls.length, 5, "refresh from the previous visit must not hydrate the current A")
  assert.ok(sourcesCalls.every((call) => !call.refresh), "no cache-busting refresh after A→B→A")
  console.log("refresh occurrence guard pinned")

  // --- 3. Stale seek echo still hydrates lyrics -------------------------------
  const seek = setup.renderer.root.findDescendantById("spotify-timeline") as Renderable | undefined
  assert.ok(seek && seek.width > 4, "seek slider mounted")
  await setup.mockMouse.click(seek.x + Math.floor(seek.width / 2), seek.y)
  await until(() => commandCalls.some((call) => call.command === "seek"), "seek committed")
  const target = (commandCalls.find((call) => call.command === "seek")!.params as { positionMs: number }).positionMs
  assert.ok(target > 10000, `seek target is mid-track, got ${target}`)
  const dA4 = deferred<SourceResolution>()
  sourcesQueue.push(dA4)
  emit(trackState(A, 4, { positionMs: 1000, updatedAt: 1 }))
  await until(() => sourcesCalls.length === 6, "echo-proof hydrate started")
  dA4.resolve(resolution(A, [docA3]))
  await sleep(20)
  await setup.flush()
  assert.ok(has("alpha third lyric line"), "lyrics hydrate even though the stale echo is ignored")
  assert.ok(has(formatTime(target)), "position holds the seek target, not the stale echo")
  console.log("echo-proof lyrics hydration pinned")
} finally {
  stopPlugin?.()
  await setup.dispose()
}
console.log("TUI state occurrence regression passed")
