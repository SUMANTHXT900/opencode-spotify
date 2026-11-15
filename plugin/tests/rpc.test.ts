import { test } from "node:test"
import assert from "node:assert/strict"
import { SpotifyRpc } from "../src/rpc.ts"
import { normalizeLyrics } from "../src/services/lyrics.ts"
import { initialState, newerSnapshot } from "../src/services/state.ts"

const trackUri = "spotify:track:1234567890123456789012"

test("RPC exposes typed methods and validates command inputs", () => {
  assert.equal("getPairing" in SpotifyRpc.methods, false)
  for (const name of ["play", "pause", "togglePlayback", "seek", "setRepeat", "setVolume", "setMute", "getQueue", "getPlaylists", "getLibrary", "search", "getLyrics"]) {
    assert.ok(name in SpotifyRpc.methods, name)
  }
  const invalid = SpotifyRpc.methods.seek.input["~standard"].validate({ positionMs: -5 })
  assert.ok("issues" in invalid)
  const valid = SpotifyRpc.methods.search.input["~standard"].validate({ query: "test", offset: 50, limit: 50 })
  assert.ok("value" in valid)
  assert.ok("issues" in SpotifyRpc.methods.getState.output["~standard"].validate({
    ...initialState(), playback: { ...initialState().playback, volume: Infinity },
  }))
})

test("lyrics source RPC validates requests, providers and candidate documents", () => {
  const input = SpotifyRpc.methods.getLyricsSources.input["~standard"]
  const request = { uri: trackUri, lrclib: true, contact: "https://example.test/plugin", refresh: false }
  assert.ok("value" in input.validate(request))
  assert.ok("value" in input.validate({ ...request, lrclib: false, contact: "" }))
  for (const value of [
    { ...request, uri: "spotify:album:1234567890123456789012" },
    { ...request, lrclib: "yes" },
    { ...request, refresh: 1 },
    { ...request, contact: "relative/path" },
    { ...request, contact: "a b" },
    { ...request, contact: "javascript:alert(1)" },
    { ...request, extra: true },
    null,
  ]) assert.ok("issues" in input.validate(value))

  const lyrics = normalizeLyrics({ uri: trackUri, sync_type: "LINE_SYNCED",
    lines: [{ text: "Synthetic line", startTimeMs: 0 }] })
  const output = SpotifyRpc.methods.getLyricsSources.output["~standard"]
  assert.ok("value" in output.validate({ uri: trackUri, candidates: [lyrics], availability: [
    { provider: "spotify", state: "ready", detail: "Connected Spotify client" },
    { provider: "lrclib", state: "disabled", detail: "Opt-in and client contact required" },
  ] }))
  assert.ok("issues" in output.validate({ uri: trackUri, candidates: [null], availability: [] }))
  assert.ok("issues" in output.validate({ uri: trackUri, candidates: [],
    availability: [{ provider: "other", state: "ready", detail: "" }] }))
  assert.ok("issues" in output.validate({ uri: trackUri, candidates: [],
    availability: Array.from({ length: 3 }, () => ({ provider: "spotify", state: "ready", detail: "" })) }))
})

test("refresh lyrics is an allowlisted, parameterless command", () => {
  const input = SpotifyRpc.methods.command.input["~standard"]
  assert.ok("value" in input.validate({ command: "refresh_lyrics", params: {} }))
  assert.ok("issues" in input.validate({ command: "refresh_lyrics", params: { uri: trackUri } }))
  assert.ok("issues" in input.validate({ command: "refresh_lyrics", params: { refresh: true } }))
  assert.ok("issues" in input.validate({ command: "unknown_lyrics", params: {} }))
})

test("RPC snapshot/event round trips revisions but does not carry lyric text", () => {
  const state = { ...initialState(), epoch: "test", revision: 42 }
  const value = SpotifyRpc.methods.getState.output["~standard"].validate(state)
  assert.ok("value" in value)
  const event = SpotifyRpc.events.updated.schema["~standard"].validate({ state })
  assert.ok("value" in event)
  assert.equal(JSON.stringify(event).includes('"lines"'), false)
  assert.equal(newerSnapshot(state, { ...state, revision: 41 }), false)
  assert.equal(newerSnapshot(state, { ...state, revision: 43 }), true)
  assert.equal(newerSnapshot(state, { ...state, epoch: "new-server", revision: 1 }), true)
})
