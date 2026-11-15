import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { provision, loadConfiguration, recordOrigin } from "../src/services/credentials.ts"

test("provisioning is installation-specific, persistent, explicit-reset only and fail-closed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spotify-credentials-"))
  try {
    const path = join(directory, "bridge.json")
    assert.throws(() => loadConfiguration(path))
    const first = provision(path)
    assert.match(first.secret, /^[a-f0-9]{64}$/)
    assert.deepEqual(provision(path), first)
    recordOrigin(path, first.secret, "https://runtime.example")
    assert.deepEqual(loadConfiguration(path).origins, ["https://runtime.example"])
    assert.equal(provision(path).secret, first.secret)
    assert.notEqual(provision(join(directory, "other.json")).secret, first.secret)
    assert.notEqual(provision(path, true).secret, first.secret)
    await writeFile(path, "{}")
    assert.throws(() => provision(path))
    assert.equal(await readFile(path, "utf8"), "{}")
  } finally { await rm(directory, { recursive: true, force: true }) }
})
