import { test } from "node:test"
import assert from "node:assert/strict"
import { displayVolume, volumeAcknowledged, volumeKnown, volumePercentLabel } from "../src/services/playback-ui.ts"

test("display volume prioritizes drag, then optimistic, then server", () => {
  assert.equal(displayVolume(0.25, 0.5, 0.9), 0.25)
  assert.equal(displayVolume(undefined, 0.5, 0.9), 0.5)
  assert.equal(displayVolume(undefined, undefined, 0.9), 0.9)
  assert.equal(displayVolume(undefined, undefined, null), 0)
  assert.equal(displayVolume(-1, undefined, 0.5), 0)
  assert.equal(displayVolume(2, undefined, 0.5), 1)
})

test("acknowledgement only clears when the server reaches the target", () => {
  assert.equal(volumeAcknowledged(0.5, 0.505), true)
  assert.equal(volumeAcknowledged(0.5, 0.52), false)
  assert.equal(volumeAcknowledged(0.5, null), false)
  assert.equal(volumeAcknowledged(undefined, 0.5), false)
  assert.equal(volumeKnown(undefined, 0.5), true)
  assert.equal(volumeKnown(0.2, null), true)
  assert.equal(volumeKnown(undefined, null), false)
})

test("percentage labels keep a six-cell invariant", () => {
  for (const [value, expected] of [[0, "    0%"], [0.05, "    5%"], [0.5, "   50%"], [1, "  100%"], [-1, "    0%"], [2, "  100%"]] as const) {
    const label = volumePercentLabel(value)
    assert.equal(label, expected)
    assert.equal(label.length, 6)
  }
})
