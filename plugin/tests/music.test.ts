import { test } from "node:test"
import assert from "node:assert/strict"
import { activeLine, normalizeLyrics, timestamp } from "../src/services/lyrics.ts"
import { emptyPlayback, positionAt } from "../src/services/state.ts"
import { normalizeQueue, normalizePage, normalizeRoot, validateCommand, image, text } from "../src/services/validation.ts"

const uri = "spotify:track:1234567890123456789012"
test("metadata remains bounded text and artwork references are parsed but never fetched", () => {
  assert.equal(text("<script>alert(1)</script>"), "<script>alert(1)</script>")
  assert.equal(text("\x1b[31mTitle\n"), "[31mTitle")
  assert.equal(text("x".repeat(1000)).length, 500)
  for (const value of ["javascript:alert(1)", "file:///etc/passwd", "http://example.com/a", "https://user:pass@example.com/a", "https://exa\nmple.com/a"]) assert.equal(image(value), "")
  assert.equal(image("https://i.scdn.co/image/example"), "https://i.scdn.co/image/example")
  assert.equal(image("spotify:image:actual"), "spotify:image:actual")
})
test("playback parameters validate booleans, seek milliseconds, modes and volume limits", () => {
  for (const cmd of ["play", "pause", "toggle_play", "next", "previous"]) assert.equal(validateCommand(cmd, {}).command, cmd)
  for (const value of [0, 1, 2]) assert.equal(validateCommand("set_repeat", { value }).params.value, value)
  for (const [cmd, params] of [
    ["seek", { positionMs: -1 }], ["seek", { positionMs: NaN }], ["seek", { positionMs: Infinity }],
    ["set_repeat", { value: 3 }], ["set_volume", { value: 1.1 }], ["set_volume", { value: -1 }],
    ["set_mute", { value: 1 }], ["set_shuffle", { value: "true" }], ["play", { surprise: true }],
    ["remove_from_queue", { uri }], ["set_liked", { uri: "wrong", value: true }],
  ] as const) assert.throws(() => validateCommand(cmd, params))
  assert.equal(validateCommand("set_volume", { value: 0.7 }).params.value, 0.7)
  assert.equal(validateCommand("set_mute", { value: true }).params.value, true)
  assert.equal(validateCommand("set_liked", { uri, value: false }).params.value, false)
})

test("progress uses a monotonic clock, stops on pause and caps drift", () => {
  const playing = { ...emptyPlayback(), positionMs: 1000, durationMs: 50000, isPlaying: true }
  assert.equal(positionAt(playing, 100, 1100), 2000)
  assert.equal(positionAt({ ...playing, isPlaying: false }, 100, 1100), 1000)
  // No extrapolation ceiling here: duration bounds growth, and the TUI triggers
  // a bounded authoritative refresh when the anchor itself goes stale.
  assert.equal(positionAt(playing, 100, 50000), 50000)
  assert.equal(positionAt({ ...playing, durationMs: 1500 }, 100, 5000), 1500)
  assert.equal(positionAt({ ...playing, durationMs: 0 }, 100, 50000), 50900)
})

test("lyric timestamps, ordering, seeks, unsynced and unavailable content", () => {
  for (const value of [true, null, "", "NaN", -1, 90_000_000]) assert.equal(timestamp(value), null)
  assert.equal(timestamp("1000"), 1000)
  const lyrics = normalizeLyrics({ uri, sync_type: "LINE_SYNCED", lines: [
    { startTimeMs: "2000", text: "second" }, { startTimeMs: 1000, text: "first" },
  ] })!
  assert.equal(activeLine(lyrics, 0), -1)
  assert.equal(activeLine(lyrics, 2500), 1)
  assert.equal(activeLine(lyrics, 1000), 0)
  assert.equal(activeLine({ ...lyrics, synced: false }, 3000), -1)
  assert.equal(normalizeLyrics({ uri, lines: [] })?.status, "unavailable")
  assert.equal(normalizeLyrics({ uri, lines: [{ text: 42 }] }), null)
})

test("queue preserves duplicate occurrences and scalar uid types", () => {
  const item = { uri, name: "Track", is_playable: true }
  const queue = normalizeQueue({ current: item, queued: [{ ...item, uid: 1 }, { ...item, uid: "1" }], next_up: [] })
  assert.equal(queue.queued.length, 2)
  assert.equal(queue.queued[0]!.uid, 1)
  assert.equal(queue.queued[1]!.uid, "1")
  assert.throws(() => normalizeQueue({ queued: "bad", next_up: [] }))
})

test("rootlist folders and paging retain stable URIs and offsets", () => {
  const root = normalizeRoot([{ type: "folder", uri: "spotify:folder:a", name: "Folder", children: [
    { type: "playlist", uri: "spotify:playlist:1234567890123456789012", name: "Playlist" },
  ] }])
  assert.equal(root[0]!.children[0]!.type, "playlist")
  for (const cmd of ["search", "get_library", "get_playlist_tracks"]) {
    const params = { offset: 50, limit: 50, ...(cmd === "search" ? { query: "test" } : cmd === "get_playlist_tracks" ? { uri: "spotify:playlist:1234567890123456789012" } : {}) }
    assert.equal(validateCommand(cmd, params).params.offset, 50)
  }
  const page = normalizePage({ items: [{ uri }], offset: 50, limit: 50, total: 101 })
  assert.equal(page.offset + page.limit, 100)
  assert.equal(page.items[0]!.uri, uri)
})
