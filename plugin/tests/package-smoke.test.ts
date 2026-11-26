// Packed-verifier wrapper regressions (WP-B lightweight).
//
// The authoritative consumer gate (real `npm pack` + isolated prefix install
// + payload probes) lives in scripts/verify-package.mjs (owner A) and is too
// expensive/flaky to run per-test. This suite exercises the SAME real code
// paths via owner A's pure helper module scripts/verify-package-lib.mjs,
// without a full invocation:
//
//   - strict argument parsing: parseVerifierArgs accepts only
//     `--tarball PATH`, `--keep-dir DIR`, `--logs-dir DIR`; unknown flags,
//     `--x=y` forms, positionals, duplicates and missing values throw
//   - archive/index: indexTarball lists and reads a tiny synthetic
//     gzip/ustar fixture (valid, corrupt-checksum, unsafe-name and
//     non-gzip inputs fail closed)
//   - no-publish surface: the lib never shells out; the gate script keeps
//     its no-publish markers (asserted statically in cli-packaging)
//
// No test here packs, installs, launches a server/TUI, spawns the gate
// script, or touches Spotify, Spicetify, global npm state, or credentials.
// Belongs in test:fast (WP-C wires the manifest).
import { test } from "node:test"
import assert from "node:assert/strict"
import { gunzipSync, gzipSync } from "node:zlib"
import {
  digests,
  indexTarball,
  parseVerifierArgs,
} from "../scripts/verify-package-lib.mjs"

/** Minimal ustar writer satisfying the verifier's strict header checks. */
function ustarEntry(name: string, data: Buffer): Buffer {
  const header = Buffer.alloc(512, 0)
  header.write(name, 0, "utf8")
  header.write("0000777", 100, "utf8")
  header.write("0000000", 108, "utf8")
  header.write("0000000", 116, "utf8")
  header.write(data.length.toString(8).padStart(11, "0"), 124, "utf8")
  header.write("00000000000", 136, "utf8")
  header[156] = "0".charCodeAt(0)
  header.write("ustar", 257, "utf8")
  header.write("00", 263, "utf8")
  let checksum = 0
  for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : header[i]!
  header.write(checksum.toString(8).padStart(6, "0"), 148, "utf8")
  header[154] = 0
  header[155] = 32
  const body = Buffer.alloc(Math.ceil(data.length / 512) * 512, 0)
  data.copy(body)
  return Buffer.concat([header, body])
}

function syntheticTgz(): { bytes: Buffer; files: Record<string, string> } {
  const files: Record<string, string> = {
    "package/package.json": JSON.stringify({ name: "fixture" }),
    "package/bin/run.js": "#!/usr/bin/env node\n",
  }
  const parts = Object.entries(files).map(([name, text]) => ustarEntry(name, Buffer.from(text)))
  parts.push(Buffer.alloc(1024, 0))
  return { bytes: gzipSync(Buffer.concat(parts)), files }
}

test("strict args accept only --tarball/--keep-dir/--logs-dir and reject everything else", () => {
  assert.deepEqual(parseVerifierArgs([]), { tarball: null, keepDir: null, logsDir: null })
  assert.deepEqual(parseVerifierArgs(["--tarball", "a.tgz", "--keep-dir", "d", "--logs-dir", "l"]),
    { tarball: "a.tgz", keepDir: "d", logsDir: "l" })
  for (const argv of [
    ["--definitely-unknown-flag-xyz"],
    ["--tarball=a.tgz"],
    ["a.tgz"],
    ["--tarball", "--keep-dir"],
    ["--tarball"],
    ["--tarball", "a.tgz", "--tarball", "b.tgz"],
    ["--keep-dir", ""],
  ]) {
    assert.throws(() => parseVerifierArgs(argv), /verify-package:/,
      `must reject ${JSON.stringify(argv)} before any pack/build/install work`)
  }
})

test("indexTarball lists and reads a synthetic gzip/ustar fixture", () => {
  const { bytes, files } = syntheticTgz()
  assert.ok(gunzipSync(bytes).length > 0, "fixture is real gzip data")
  const { entries, files: indexed } = indexTarball(bytes)
  assert.equal(entries.length, Object.keys(files).length)
  for (const [name, text] of Object.entries(files)) {
    assert.ok(indexed.has(name), `index carries ${name}`)
    assert.equal(String(indexed.get(name)), text, `index round-trips ${name}`)
  }
})

test("indexTarball fails closed on corrupt or unsafe archives", () => {
  const { bytes } = syntheticTgz()
  assert.throws(() => indexTarball(Buffer.from("not gzip at all")), /not valid gzip/)
  const raw = gunzipSync(bytes)
  raw[200] ^= 0xff
  assert.throws(() => indexTarball(gzipSync(raw)), /checksum mismatch/)
  const evil = gzipSync(Buffer.concat([
    ustarEntry("../../evil.js", Buffer.from("x")),
    Buffer.alloc(1024, 0),
  ]))
  assert.throws(() => indexTarball(evil), /parent-escape/)
  const absolute = gzipSync(Buffer.concat([
    ustarEntry("/abs.js", Buffer.from("x")),
    Buffer.alloc(1024, 0),
  ]))
  assert.throws(() => indexTarball(absolute), /absolute tar entry rejected/)
  const colliding = gzipSync(Buffer.concat([
    ustarEntry("package/index.js", Buffer.from("first")),
    ustarEntry("package/INDEX.js", Buffer.from("second")),
    Buffer.alloc(1024, 0),
  ]))
  assert.throws(() => indexTarball(colliding), /duplicate tar entry/)
  assert.throws(() => indexTarball(gzipSync(Buffer.concat([
    gunzipSync(bytes), Buffer.from("unexpected trailing bytes"),
  ]))), /tar end marker/)
})

test("digests cover the exact bytes with sha256 + sha512-integrity", () => {
  const { sha256, sha512, integrity } = digests(Buffer.from("abc"))
  assert.match(sha256, /^[0-9a-f]{64}$/)
  assert.equal(integrity, `sha512-${sha512}`)
})
