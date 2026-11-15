import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"

test("artwork validation, caching and native image rendering", () => {
  const result = spawnSync("bun", ["--preload", "@opentui/solid/preload", "tests/render-artwork.tsx"], { encoding: "utf8", timeout: 60000 })
  assert.equal(result.error, undefined, "Bun is required for OpenTUI native renderer tests")
  assert.equal(result.status, 0, result.stdout + result.stderr)
})
