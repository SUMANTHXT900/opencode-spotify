import { test } from "node:test"
import assert from "node:assert/strict"
import { LyricsSourceManager } from "../src/services/LyricsSourceManager.ts"
import { emptyLyrics } from "../src/services/lyrics.ts"
const track = { uri: "spotify:track:1234567890123456789012", title: "Synthetic", artist: "Test artist", album: "Tests", durationMs: 180000 }
const options = { enabled: true, contact: "https://example.test/plugin", refresh: false }
const unavailable = () => ({ ...emptyLyrics(track.uri), status: "unavailable" as const })

test("provider manager is opt-in, exact-match, bounded, cached and deduplicated", async () => {
  let calls = 0
  const manager = new LyricsSourceManager(async (url, init) => {
    calls++
    assert.equal(new URL(String(url)).origin, "https://lrclib.net")
    assert.equal(init?.redirect, "error")
    return new Response(JSON.stringify({ trackName: track.title, artistName: track.artist, albumName: track.album,
      duration: 180, syncedLyrics: "[00:01.00]A synthetic test", plainLyrics: "A synthetic test" }), { headers: { "Content-Type": "application/json" } })
  })
  assert.equal((await manager.resolve(track, unavailable(), { ...options, enabled: false })).candidates.length, 0)
  assert.equal(calls, 0)
  const [a, b] = await Promise.all([
    manager.resolve(track, unavailable(), options), manager.resolve(track, unavailable(), options),
  ])
  assert.equal(calls, 1)
  assert.equal(a.candidates.length, 2)
  assert.deepEqual(a, b)
  await manager.resolve(track, unavailable(), options)
  assert.equal(calls, 1)
  manager.dispose()
})

test("provider mismatch, redirects/oversize and rate-limit responses never become lyrics", async () => {
  for (const response of [
    () => new Response(JSON.stringify({ trackName: "Wrong song", artistName: track.artist, duration: 180, plainLyrics: "Wrong" }), { headers: { "Content-Type": "application/json" } }),
    () => new Response("x".repeat(524289), { headers: { "Content-Type": "application/json" } }),
    () => new Response("rate limited", { status: 429, headers: { "Retry-After": "120" } }),
  ]) {
    let calls = 0
    const manager = new LyricsSourceManager(async () => { calls++; return response() })
    assert.equal((await manager.resolve(track, unavailable(), options)).candidates.length, 0)
    await manager.resolve(track, unavailable(), options)
    assert.equal(calls, 1)
    manager.dispose()
  }
})
