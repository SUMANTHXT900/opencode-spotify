import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"

// Replay captured native output across transitions into one persistent
// terminal model. Check editor isolation and compare the lyric region with
// a clean rendering of each current state.
test("VT transitions clear old sidebar lyrics and preserve editor cells", () => {
  const result = spawnSync("bun", ["--preload", "@opentui/solid/preload", "tests/render-vt.tsx"], {
    encoding: "utf8", timeout: 120000,
  })
  assert.equal(result.error, undefined, "Bun is required for OpenTUI native renderer tests on Node <26.4")
  assert.equal(result.status, 0, result.stdout + result.stderr)
})
