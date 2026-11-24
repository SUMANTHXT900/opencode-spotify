import { test } from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import vm from "node:vm"
import { webcrypto } from "node:crypto"
import { proof } from "../src/services/auth.ts"

test("bundled extension executes Player operations and emits correlated snapshots/errors", async () => {
  const code = await readFile(new URL("../spicetify/opencode-spotify-bridge.js", import.meta.url), "utf8")
  const uri = "spotify:track:1234567890123456789012"
  const sent: Record<string, any>[] = []
  const listeners: Record<string, () => void> = {}
  let ws: any
  const credential = "a".repeat(64)
  let playing = false, position = 1000, volume = 0.5, shuffle = false, repeat = 0, muted = false, liked = false
  let queued = [{ uri, name: "First occurrence", uid: 1 }, { uri, name: "Second occurrence", uid: 2 }]
  let removed: unknown
  let lyricCalls = 0
  const lyricResponse = { lyrics: { syncType: "LINE_SYNCED", language: "en", lines: [
    { startTimeMs: "1500", words: "Synthetic lyric" },
  ] } }
  const pendingLyrics: Array<(value: typeof lyricResponse) => void> = []
  let holdLyrics = false
  const cosmos = { get: async () => {
    lyricCalls++
    return holdLyrics ? await new Promise<typeof lyricResponse>((resolve) => pendingLyrics.push(resolve)) : lyricResponse
  } }
  const waitFor = async (predicate: () => boolean) => {
    for (let i = 0; !predicate() && i < 100; i++) await new Promise((resolve) => setImmediate(resolve))
    assert.ok(predicate())
  }
  const player = {
    data: { item: { uri, metadata: { title: "Test", artist_name: "Artist", album_title: "Album",
      image_url: "spotify:image:small", image_xlarge_url: "spotify:image:actual" },
      images: [{ url: "spotify:image:actual", width: 300 }, { url: "spotify:image:large", width: 640 }] } },
    isPlaying: () => playing, getProgress: () => position, getDuration: () => 180000,
    getVolume: () => volume, getShuffle: () => shuffle, getRepeat: () => repeat, getMute: () => muted, getHeart: () => liked,
    play: () => { playing = true }, pause: () => { playing = false }, togglePlay: () => { playing = !playing },
    next: () => { position = 0 }, back: () => { position = 0 },
    setVolume: (v: number) => { volume = v }, setShuffle: (v: boolean) => { shuffle = v },
    setRepeat: (v: number) => { repeat = v }, setMute: (v: boolean) => { muted = v }, setHeart: (v: boolean) => { liked = v },
    addEventListener: (name: string, fn: () => void) => { listeners[name] = fn }, removeEventListener() {},
    origin: { _queue: { getQueue: async () => ({ queued, nextUp: [], current: null }) } },
  }
  class Socket {
    static OPEN = 1
    readyState = 1
    onmessage: any
    constructor() { ws = this }
    send(raw: string) { sent.push(JSON.parse(raw)) }
    close() {}
  }
  const context = vm.createContext({
    Spicetify: {
      Player: player, Platform: { PlayerAPI: { seekTo: async (ms: number) => { position = ms } } }, CosmosAsync: cosmos,
      addToQueue: async () => {}, removeFromQueue: async (items: unknown) => { removed = items },
    },
    window: { Spicetify: { Player: player, CosmosAsync: cosmos }, addEventListener() {} },
    localStorage: { getItem: () => credential, setItem() {} },
    WebSocket: Socket, crypto: webcrypto, TextEncoder, Uint8Array,
    performance, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, console: { info() {}, warn() {} },
  })
  vm.runInContext(code.replace("__OPENCODE_SPOTIFY_SECRET__", credential), context)
  ws.onopen()
  ws.onmessage({ data: JSON.stringify({ type: "authenticated", protocol: 2 }) })
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(sent.map((m) => m.type), ["hello"]) // No application data before authentication.
  const nonce = "b".repeat(64)
  ws.onmessage({ data: JSON.stringify({ type: "challenge", protocol: 2, handshake: "auto-1", nonce,
    serverProof: proof(credential, "server", "extension", sent[0]!.nonce, nonce) }) })
  for (let i = 0; !sent.some((m) => m.type === "auth") && i < 100; i++) await new Promise((r) => setTimeout(r, 2))
  assert.equal(sent.some((m) => m.type === "auth"), true)
  await ws.onmessage({ data: JSON.stringify({ type: "authenticated", protocol: 2 }) })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(sent.find((m) => m.type === "track")?.image, "spotify:image:large", "largest source wins")
  await waitFor(() => sent.some((message) => message.type === "lyrics"))
  assert.equal(lyricCalls, 1)
  assert.deepEqual(sent.find((message) => message.type === "lyrics")?.lines, [{ startTimeMs: "1500", text: "Synthetic lyric" }])
  assert.equal(sent.find((message) => message.type === "lyrics")?.provider, "spotify")
  const request = async (command: string, params = {}) => {
    const id = `test-${sent.length}`
    await ws.onmessage({ data: JSON.stringify({ type: "request", id, command, params }) })
    await new Promise((resolve) => setImmediate(resolve))
    return sent.find((m) => m.type === "response" && m.id === id)!
  }
  for (const command of ["play", "pause", "toggle_play", "next", "previous"]) assert.equal((await request(command)).ok, true)
  assert.equal((await request("seek", { positionMs: 1 })).ok, true)
  assert.equal(position, 1) // 1 ms, not 100% through ambiguous Player.seek
  assert.equal((await request("seek", { positionMs: -1 })).ok, false)
  for (const [command, value] of [["set_volume", 0.7], ["set_repeat", 2], ["set_shuffle", true], ["set_mute", true], ["set_liked", true]] as const) {
    assert.equal((await request(command, { value, ...(command === "set_liked" ? { uri } : {}) })).ok, true)
  }
  assert.equal((await request("set_liked", { uri: "spotify:track:xxxxxxxxxxxxxxxxxxxxxx", value: false })).ok, false)
  assert.equal(liked, true)
  assert.equal((await request("set_volume", { value: 1.5 })).ok, false)
  assert.equal((await request("shell", {})).ok, false)
  assert.equal((await request("play", { unexpected: "no" })).ok, false)
  assert.equal((await request("search", { query: "x".repeat(201) })).ok, false)
  assert.equal((await request("get_library", { offset: "0" })).ok, false)
  const state = await request("get_playback")
  assert.equal(state.result.volume, 0.7)
  assert.equal(state.result.repeat, 2)
  assert.equal(state.result.shuffle, true)
  assert.equal(state.result.muted, true)
  assert.equal((await request("remove_from_queue", { uri, uid: 2 })).ok, true)
  assert.equal(JSON.stringify(removed), JSON.stringify([{ uri, uid: 2 }]))
  assert.equal((await request("remove_from_queue", { uri, uid: 3 })).ok, false)
  queued = [{ uri, name: "Ambiguous", uid: 1 }, { uri, name: "Ambiguous", uid: 1 }]
  assert.equal((await request("remove_from_queue", { uri, uid: 1 })).ok, false)
  const lyricMessages = sent.filter((message) => message.type === "lyrics").length
  const refreshed = await request("refresh_lyrics")
  assert.deepEqual(refreshed, { type: "response", id: refreshed.id, ok: true, result: { accepted: true } })
  await waitFor(() => sent.filter((message) => message.type === "lyrics").length > lyricMessages)
  assert.equal(lyricCalls, 2)
  const item = player.data.item
  player.data.item = null as unknown as typeof player.data.item
  const missing = await request("refresh_lyrics")
  assert.equal(missing.ok, false)
  assert.equal(missing.error.code, "invalid_uri")
  player.data.item = item
  assert.deepEqual(Object.keys(listeners).sort(), ["onplaypause", "onprogress", "songchange"])

  // The original A request must not win after A → B → A, even though its
  // URI matches the final track again. B's late request must not emit either.
  holdLyrics = true
  const start = sent.length
  const other = "spotify:track:AAAAAAAAAAAAAAAAAAAAAA"
  assert.equal((await request("refresh_lyrics")).ok, true)
  player.data.item = { ...item, uri: other }
  listeners.songchange!()
  player.data.item = item
  listeners.songchange!()
  assert.equal(pendingLyrics.length, 2)
  assert.deepEqual(sent.slice(start).filter((m) => m.type === "track").map((m) => m.uri), [other, uri])
  for (const [i, resolve] of pendingLyrics.entries()) {
    resolve({ lyrics: { ...lyricResponse.lyrics, lines: [{ startTimeMs: "1500", words: `Stale request ${i}` }] } })
  }
  await new Promise((resolve) => setImmediate(resolve))
  const transitions = sent.slice(start).filter((m) => m.type === "lyrics" || m.type === "lyrics_unavailable")
  assert.deepEqual(transitions.map((m) => [m.uri, m.lines?.[0]?.text]), [[uri, "Synthetic lyric"]])
})

test("seek waits for fresh progress instead of emitting a stale echo", async () => {
  const code = await readFile(new URL("../spicetify/opencode-spotify-bridge.js", import.meta.url), "utf8")
  const uri = "spotify:track:1234567890123456789012"
  const sent: Record<string, any>[] = []
  let ws: any
  const credential = "a".repeat(64)
  // getProgress lags two reads behind each seek target.
  let reported = 1000, reads = 0
  const player: any = {
    data: { item: { uri, metadata: { title: "Test" } } },
    isPlaying: () => true, getProgress: () => (reads++ < 2 ? 1000 : reported), getDuration: () => 180000,
    addEventListener() {}, removeEventListener() {},
    origin: { _queue: { getQueue: async () => ({ queued: [], nextUp: [], current: null }) } },
  }
  class Socket {
    static OPEN = 1
    readyState = 1
    onmessage: any
    constructor() { ws = this }
    send(raw: string) { sent.push(JSON.parse(raw)) }
    close() {}
  }
  const context = vm.createContext({
    Spicetify: { Player: player, Platform: { PlayerAPI: { seekTo: async (ms: number) => { reported = ms; reads = 0 } } },
      CosmosAsync: { get: async () => ({}) } },
    window: { Spicetify: { Player: player, CosmosAsync: {} }, addEventListener() {} },
    localStorage: { getItem: () => credential, setItem() {} },
    WebSocket: Socket, crypto: webcrypto, TextEncoder, Uint8Array,
    performance, setTimeout, clearTimeout, setInterval, clearInterval, console: { info() {}, warn() {} },
  })
  try {
    vm.runInContext(code.replace("__OPENCODE_SPOTIFY_SECRET__", credential), context)
    ws.onopen()
    ws.onmessage({ data: JSON.stringify({ type: "authenticated", protocol: 2 }) })
    const nonce = "b".repeat(64)
    ws.onmessage({ data: JSON.stringify({ type: "challenge", protocol: 2, handshake: "auto-1", nonce,
      serverProof: proof(credential, "server", "extension", sent[0]!.nonce, nonce) }) })
    for (let i = 0; !sent.some((m) => m.type === "auth") && i < 200; i++) await new Promise((r) => setTimeout(r, 2))
    assert.ok(sent.some((m) => m.type === "auth"))
    await ws.onmessage({ data: JSON.stringify({ type: "authenticated", protocol: 2 }) })
    await new Promise((resolve) => setImmediate(resolve))
    const before = sent.filter((m) => m.type === "playback").length
    const id = "seek-lag-test"
    await ws.onmessage({ data: JSON.stringify({ type: "request", id, command: "seek", params: { positionMs: 60000 } }) })
    let response: Record<string, any> | undefined
    for (let i = 0; i < 200 && !response; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      response = sent.find((m) => m.type === "response" && m.id === id)
    }
    assert.equal(response!.ok, true)
    // The forced snapshot carries the post-seek anchor, not the stale 1000 ms echo.
    const snapshots = sent.filter((m) => m.type === "playback").slice(before)
    assert.ok(snapshots.length >= 1)
    assert.ok(snapshots.every((m) => Math.abs(m.playback.positionMs - 60000) <= 1500),
      JSON.stringify(snapshots.map((m) => m.playback.positionMs)))
  } finally {
    vm.runInContext("window.OpenCodeSpotifyDispose()", context)
  }
})
