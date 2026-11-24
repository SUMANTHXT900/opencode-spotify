import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"

// Release-artifact mode: the exact verified tarball must be retainable and
// re-verifiable without packing a second, different tarball.
test("verify-package retains and re-verifies the exact release artifact", () => {
  const script = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "verify-package.mjs")
  const keepDir = mkdtempSync(join(tmpdir(), "spotify-keep-"))
  try {
    const retained = spawnSync(process.execPath, [script, "--keep-dir", keepDir], {
      encoding: "utf8", timeout: 420_000, windowsHide: true,
    })
    if (retained.error) throw retained.error
    assert.equal(retained.status, 0,
      `verify-package --keep-dir failed (status ${retained.status}):\n${retained.stdout}\n${retained.stderr}`)
    const files = readdirSync(keepDir)
    const tgz = files.find((name) => name.endsWith(".tgz"))
    assert.ok(tgz, `expected a retained .tgz in ${keepDir}, got: ${files.join(", ")}`)
    const tarballPath = join(keepDir, tgz!)
    assert.ok(existsSync(`${tarballPath}.sha256`), "retained .sha256 sidecar exists")
    assert.ok(existsSync(`${tarballPath}.integrity`), "retained .integrity sidecar exists")
    const bytes = readFileSync(tarballPath)
    const digest = createHash("sha256").update(bytes).digest("hex")
    const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`
    const shaLine = readFileSync(`${tarballPath}.sha256`, "utf8").trim()
    assert.ok(shaLine.startsWith(digest), "retained .sha256 matches the tarball bytes")
    assert.equal(readFileSync(`${tarballPath}.integrity`, "utf8").trim(), integrity,
      "retained .integrity matches the tarball bytes")

    // Re-verify the exact retained artifact without packing again.
    const reverify = spawnSync(process.execPath, [script, "--tarball", tarballPath], {
      encoding: "utf8", timeout: 420_000, windowsHide: true,
    })
    if (reverify.error) throw reverify.error
    assert.equal(reverify.status, 0,
      `verify-package --tarball failed (status ${reverify.status}):\n${reverify.stdout}\n${reverify.stderr}`)
  } finally {
    rmSync(keepDir, { recursive: true, force: true })
  }
})
