import { test } from "node:test"
import assert from "node:assert/strict"
import { initialState, progressBar } from "../src/services/state.ts"

test("initial state is disconnected and does not invent playback state", () => {
  assert.equal(initialState().connection, "disconnected")
  assert.equal(initialState().track, null)
  assert.equal(initialState().playback.isPlaying, null)
})

test("progress bar is bounded, including zero duration", () => {
  assert.equal(progressBar(0, 0, 8), "────────")
  assert.equal(progressBar(5, 10, 8), "━━━━────")
  assert.equal(progressBar(15, 10, 4), "━━━━")
  assert.equal(progressBar(-1, 10, 4), "────")
})
