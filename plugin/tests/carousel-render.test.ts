import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
test("carousel renders wrapped lyrics and instrumental state", () => {
  const result = spawnSync("bun", ["--preload", "@opentui/solid/preload", "tests/render-carousel.tsx"], { encoding: "utf8", timeout: 60000 })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stdout + result.stderr)
})
