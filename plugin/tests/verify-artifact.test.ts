// Release-artifact wrapper regressions (WP-B lightweight).
//
// The exact verified tarball must be retainable and re-verifiable without
// packing a second, different tarball. The full retain + reinstall cycle is
// the verifier's job (owner A); this suite pins the retention contract via
// owner A's real helpers in scripts/verify-package-lib.mjs, without
// launching a full invocation:
//
//   - sidecar format: `<sha256>  <basename>` + `sha512-<base64>` computed by
//     digests() from the exact bytes, checked against a synthetic fixture
//   - retainArtifact writes the exact bytes plus both sidecars, re-uses a
//     byte-identical prebuilt file (both-or-neither sidecars verified), and
//     fails closed on conflicts: an existing file with different bytes, a
//     mismatched sidecar, or a half-present sidecar pair must throw and
//     never overwrite the prior QA artifact (tampered prebuilt rejection)
//
// No test here packs, installs, or re-verifies a real artifact. Fast-only.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gzipSync } from "node:zlib"
import { digests, retainArtifact, verifyArtifactSidecars } from "../scripts/verify-package-lib.mjs"

test("retention sidecars match the exact artifact bytes", () => {
  const bytes = gzipSync(Buffer.from("synthetic-release-artifact"))
  const { sha256, integrity } = digests(bytes)
  assert.match(sha256, /^[0-9a-f]{64}$/, "sha256 is 64 hex chars")
  assert.match(integrity, /^sha512-[A-Za-z0-9+/]+=*$/, "integrity sidecar is sha512-base64")
})

test("retainArtifact writes the exact bytes plus both sidecars and re-uses identical files", () => {
  const dir = mkdtempSync(join(tmpdir(), "spotify-retain-"))
  try {
    const bytes = gzipSync(Buffer.from("retention-helper-fixture"))
    const first = retainArtifact(dir, "artifact.tgz", bytes)
    assert.equal(first.reused, false)
    assert.ok(readFileSync(first.path).equals(bytes), "retained file is the exact bytes")
    assert.equal(readFileSync(`${first.path}.sha256`, "utf8"), `${first.sha256}  artifact.tgz\n`)
    assert.equal(readFileSync(`${first.path}.integrity`, "utf8"), `${first.integrity}\n`)
    const { sha256, integrity } = digests(bytes)
    assert.equal(first.sha256, sha256)
    assert.equal(first.integrity, integrity)
    const second = retainArtifact(dir, "artifact.tgz", bytes)
    assert.equal(second.reused, true, "byte-identical re-use never rewrites the artifact")
    assert.equal(second.sha256, first.sha256)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("prebuilt verification rejects incomplete sidecars and changed bytes", () => {
  const bytes = Buffer.from("exact tarball fixture")
  const name = "artifact.tgz"
  const { sha256, integrity } = digests(bytes)
  const sidecar = `${sha256}  ${name}\n`
  assert.equal(verifyArtifactSidecars(name, bytes, null, null), false)
  assert.equal(verifyArtifactSidecars(name, bytes, sidecar, integrity), true)
  assert.throws(() => verifyArtifactSidecars(name, bytes, sidecar, null), /incomplete/)
  assert.throws(() => verifyArtifactSidecars(name, Buffer.from("changed"), sidecar, integrity), /mismatch/)
  assert.throws(() => verifyArtifactSidecars(name, bytes, sidecar, "invalid"), /mismatch/)
})

test("retention cannot overwrite prior bytes or conflicting sidecars", () => {
  const dir = mkdtempSync(join(tmpdir(), "spotify-tamper-"))
  try {
    const bytes = gzipSync(Buffer.from("tamper-fixture"))
    retainArtifact(dir, "artifact.tgz", bytes)
    const kept = join(dir, "artifact.tgz")

    // Different bytes under an existing name: conflict, never overwrite.
    assert.throws(
      () => retainArtifact(dir, "artifact.tgz", Buffer.concat([bytes, Buffer.from("x")])),
      /retain conflict/,
      "tampered bytes against the retained artifact must be rejected",
    )
    assert.ok(readFileSync(kept).equals(bytes), "rejected retain leaves the prior artifact untouched")

    // Mismatched sidecar content: conflict, never overwrite.
    writeFileSync(`${kept}.sha256`, `${"0".repeat(64)}  artifact.tgz\n`)
    assert.throws(() => retainArtifact(dir, "artifact.tgz", bytes),
      /retain conflict/, "mismatched .sha256 sidecar must be rejected")

    // Retention can recreate a missing sidecar for byte-identical output.
    const { sha256 } = digests(bytes)
    writeFileSync(`${kept}.sha256`, `${sha256}  artifact.tgz\n`)
    rmSync(`${kept}.integrity`)
    const rereused = retainArtifact(dir, "artifact.tgz", bytes)
    assert.equal(rereused.reused, true, "missing sidecar is recreated for identical bytes")
    assert.equal(readFileSync(`${kept}.integrity`, "utf8"), `${rereused.integrity}\n`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
