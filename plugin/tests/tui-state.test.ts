import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"

// TUI state regression (V0.5.7): the real src/tui.tsx setup with a deferred
// fake Spotify RPC in a Bun worker. Pins stale-hydrate A->B->A, the refresh
// occurrence guard (no cache-bust on the new track) and lyrics hydration
// when a stale seek echo is ignored for the clock.
test("TUI state pins occurrence-scoped hydration (real setup, fake RPC)", () => {
  const result = spawnSync("bun", ["--preload", "@opentui/solid/preload", "tests/tui-state-work.tsx"], {
    encoding: "utf8", timeout: 120000,
  })
  assert.equal(result.error, undefined, "Bun is required for OpenTUI native renderer tests on Node <26.4")
  assert.equal(result.status, 0, result.stdout + result.stderr)
})
