import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"

test("Windows native OpenTUI layout and rendering regression suite (Bun FFI)", () => {
  const result = spawnSync("bun", ["--preload", "@opentui/solid/preload", "tests/render-layout.tsx"], {
    encoding: "utf8", timeout: 60000,
  })
  assert.equal(result.error, undefined, "Bun is required for OpenTUI native renderer tests on Node <26.4")
  assert.equal(result.status, 0, result.stdout + result.stderr)
})
