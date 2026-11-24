import { test } from "node:test"
import assert from "node:assert/strict"
import { extrapolatePosition, holdCleared, isStaleEcho, mergePlayback, SEEK_HOLD_MS } from "../src/services/playback-sync.ts"
import { emptyPlayback } from "../src/services/state.ts"

const playing = { positionMs: 12000, durationMs: 200000, isPlaying: true as const }
const paused = { ...playing, isPlaying: false as const }

test("extrapolation advances while playing, freezes on pause, ignores duration gaps", () => {
  assert.equal(extrapolatePosition(playing, 1000, 2000), 13000)
  assert.equal(extrapolatePosition(paused, 1000, 2000), 12000)
  assert.equal(extrapolatePosition({ ...playing, durationMs: 12500 }, 1000, 2000), 12500)
  assert.equal(extrapolatePosition({ ...playing, durationMs: 0 }, 1000, 60000), 71000)
})

test("seek hold clears on matching ack or timeout, never on stale echoes", () => {
  const hold = { targetMs: 60000, startedWallMs: 5000, startedMonoMs: 1000 }
  assert.equal(holdCleared(hold, { positionMs: 59500, updatedAt: 5100 }, 1500), true)
  assert.equal(holdCleared(hold, { positionMs: 12000, updatedAt: 4900 }, 1500), false)
  assert.equal(holdCleared(hold, { positionMs: 12000, updatedAt: 4900 }, 1000 + SEEK_HOLD_MS), true)
})

test("stale echoes never move the timeline backward", () => {
  assert.equal(isStaleEcho(5000, 4900), true)
  assert.equal(isStaleEcho(5000, 5000), false)
  assert.equal(isStaleEcho(5000, 6000), false)
  const current = { ...emptyPlayback(), trackUri: "spotify:track:1234567890123456789012", positionMs: 13000, updatedAt: 5000 }
  assert.equal(mergePlayback(current, { ...current, positionMs: 12000, updatedAt: 4900 }), null)
  assert.equal(mergePlayback(current, { ...current, positionMs: 12000, updatedAt: 5000 }), null, "equal-time regression is stale")
  assert.equal(mergePlayback(current, { ...current, positionMs: 13000, updatedAt: 5000 })?.positionMs, 13000, "equal-time advance is accepted")
  const fresh = mergePlayback(current, { ...current, positionMs: 14000, updatedAt: 6000 })
  assert.equal(fresh?.positionMs, 14000)
  const switched = mergePlayback(current, { ...current, trackUri: "spotify:track:xxxxxxxxxxxxxxxxxxxxxx", positionMs: 0, updatedAt: 1000 })
  assert.equal(switched?.trackUri, "spotify:track:xxxxxxxxxxxxxxxxxxxxxx")
})

test("track changes and reconnects reset through merge", () => {
  const current = { ...emptyPlayback(), trackUri: null, positionMs: 42000, updatedAt: 1000 }
  const incoming = { ...emptyPlayback(), trackUri: "spotify:track:1234567890123456789012", positionMs: 0, updatedAt: 2000 }
  assert.equal(mergePlayback(current, incoming)?.positionMs, 0)
})
