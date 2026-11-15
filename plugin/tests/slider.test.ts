import { test } from "node:test"
import assert from "node:assert/strict"
import { clampSlider, sliderText, sliderValueAt } from "../src/ui/slider.ts"

test("slider maps measured cells and clamps outside releases", () => {
  assert.equal(sliderValueAt(10, 10, 11, 100), 0)
  assert.equal(sliderValueAt(15, 10, 11, 100), 50)
  assert.equal(sliderValueAt(30, 10, 11, 100), 100)
  assert.equal(sliderValueAt(-10, 10, 11, 100), 0)
  assert.equal(sliderValueAt(10, 10, 1, 100), 0)
  assert.equal(clampSlider(NaN, 100), 0)
  assert.equal(clampSlider(10, 0), 0)
})

test("slider thumb and flow preserve width and stop when omitted", () => {
  assert.equal(sliderText(50, 100, 5, false), "━━•──")
  assert.equal(sliderText(50, 100, 5, true), "━━●──")
  assert.equal(sliderText(50, 100, 5, false, 500), "━╸•──")
  assert.equal(sliderText(100, 100, 5, false), "━━━━•")
  assert.equal(sliderText(1, 0, 0, false), "")
})
