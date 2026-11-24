import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

// Cross-platform smoke test: the real packed-package verification lives in
// scripts/verify-package.mjs so CI failure output stays in one place. This
// wrapper only spawns it with a hard timeout and asserts success.
test("packed package verifies: pack list, isolated install, bin --version/--help", () => {
  const script = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "verify-package.mjs")
  const result = spawnSync(process.execPath, [script], {
    encoding: "utf8",
    timeout: 420_000,
    windowsHide: true,
  })
  if (result.error) throw result.error
  assert.equal(result.status, 0,
    `verify-package.mjs failed (status ${result.status}):\n${result.stdout}\n${result.stderr}`)
})
