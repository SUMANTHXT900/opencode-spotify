import { test } from "node:test"
import assert from "node:assert/strict"
import { parseArgs, helpText } from "../src/cli/args.ts"
import { BRIDGE_HANDSHAKE, BRIDGE_PORT, BRIDGE_PROTOCOL, MIN_OPENCODE, MIN_SPICETIFY, compareVersions, isAtLeast, isFloatingSpec } from "../src/cli/compat.ts"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { updateAvailability, recommendUpdate, selectPluginTarget } from "../src/cli/update-plan.ts"
import { registrationSpec } from "../src/cli/plan.ts"
import { npmLatest, githubLatest, compareAvailable } from "../src/cli/versions.ts"
import type { Runtime } from "../src/cli/types.ts"

function runtimeWith(run: Runtime["run"]): Runtime {
  return {
    platform: "win32", arch: "x64", env: {}, cwd: "C:\\work", homedir: "C:\\Users\\test",
    run, which: async () => undefined,
    exists: () => false, isFile: () => false, readText: () => "", writeText: () => {},
    copyFile: () => {}, mkdir: () => {}, remove: () => {}, now: () => 0,
    portOpen: async () => false,
  }
}

test("CLI parsing accepts commands and safe flags, rejects unknown input", () => {
  assert.equal(parseArgs([]).options.command, "setup", "no arguments defaults to setup")
  assert.equal(parseArgs(["install"]).options.command, "setup", "install aliases setup")
  assert.equal(parseArgs(["status", "--json"]).options.command, "status")
  assert.equal(parseArgs(["update", "--dry-run", "--offline"]).options.dryRun, true)
  assert.equal(parseArgs(["setup", "--spicetify=auto"]).options.spicetify, "auto")
  assert.equal(parseArgs(["setup", "--spicetify", "manual"]).options.spicetify, "manual")
  assert.equal(parseArgs(["setup", "--spicetify=robot"]).error, "--spicetify must be ask, auto, manual, or skip")
  assert.equal(parseArgs(["--nope"]).error, "Unknown option: --nope")
  assert.equal(parseArgs(["status", "extra"]).error, "Unexpected argument: extra")
  assert.equal(parseArgs(["--package-spec"]).error, "--package-spec requires a value")
  assert.equal(parseArgs(["--package-spec", "--dry-run"]).error, "--package-spec requires a value")
  assert.equal(parseArgs(["--package-spec", "opencode-spotify@0.6.0"]).options.packageSpec, "opencode-spotify@0.6.0")
  assert.equal(parseArgs(["--package-spec", "evil & calc"]).error, "--package-spec contains unsupported characters")
  assert.match(helpText(), /--dry-run/)
  assert.match(helpText(), /opencode-spotify status --json/)
})

test("semantic version comparison is strict and rejects malformed input", () => {
  assert.equal(compareVersions("0.6.0", "0.5.7"), 1)
  assert.equal(compareVersions("v0.6.0", "0.6.0"), 0)
  assert.equal(compareVersions("2.46.7", "2.47.0"), -1)
  assert.equal(compareVersions("0.6.0-beta.1", "0.6.0"), -1)
  assert.equal(compareVersions("0.6.0-beta.2", "0.6.0-beta.1"), 1)
  assert.equal(compareVersions("0.6.0-beta.1", "0.6.0-beta.1"), 0)
  assert.equal(compareVersions("not-a-version", "1.0.0"), null)
  assert.equal(isAtLeast("2.4.1", "2.3.0"), true)
  assert.equal(isAtLeast("2.2.9", "2.3.0"), false)
  assert.equal(isAtLeast(null, "2.3.0"), null)
  assert.equal(isFloatingSpec("opencode-spotify@^0.6.0"), true)
  assert.equal(isFloatingSpec("opencode-spotify@0.6.0"), false)
  assert.equal(isFloatingSpec("./plugin"), false)
})

test("update planning never downgrades and never replaces a local development registration", () => {
  const availability = updateAvailability({
    pluginInstalled: "0.6.0", pluginLatest: "0.7.0",
    spicetifyInstalled: "2.46.7", spicetifyLatest: "2.47.0",
  })
  assert.deepEqual(availability, { plugin: "outdated", spicetify: "outdated" })
  assert.deepEqual(recommendUpdate({ availability, pluginSpec: "opencode-spotify@0.6.0", pluginLocal: false, allowSpicetifyUpgrade: false, pinned: true }),
    { plugin: true, spicetify: false, reason: "A plugin update is available." })
  assert.deepEqual(recommendUpdate({ availability, pluginSpec: "opencode-spotify@0.6.0", pluginLocal: false, allowSpicetifyUpgrade: true, pinned: true }),
    { plugin: true, spicetify: true, reason: "Plugin and Spicetify updates are available." })
  const downgrade = updateAvailability({ pluginInstalled: "0.7.0", pluginLatest: "0.6.0", spicetifyInstalled: null, spicetifyLatest: null })
  assert.deepEqual(recommendUpdate({ availability: downgrade, pluginSpec: "opencode-spotify@0.7.0", pluginLocal: false, allowSpicetifyUpgrade: true, pinned: true }),
    { plugin: false, spicetify: false, reason: "The registry reports an older version; downgrades are never automatic." })
  assert.deepEqual(recommendUpdate({ availability: { plugin: "current", spicetify: "current" }, pluginSpec: "opencode-spotify@0.6.0", pluginLocal: true, allowSpicetifyUpgrade: true, pinned: true }),
    { plugin: false, spicetify: false, reason: "A local development plugin is registered; use setup to switch to the global package." })
  assert.equal(compareAvailable("0.6.0", "0.6.0"), "current")
  assert.equal(compareAvailable(null, "0.6.0"), "unknown")
})

test("beta channel selection keeps stable users on stable and moves beta users forward", () => {
  assert.equal(selectPluginTarget("0.6.0", "0.6.0", "0.7.0-beta.1"), null)
  assert.equal(selectPluginTarget("0.6.0-beta.1", "0.6.0", "0.6.0-beta.2"), "0.6.0")
  assert.equal(selectPluginTarget("0.6.0-beta.1", null, "0.6.0-beta.2"), "0.6.0-beta.2")
  assert.equal(selectPluginTarget("0.6.0-beta.2", "0.6.0", "0.6.0-beta.1"), "0.6.0")
  assert.equal(selectPluginTarget("0.7.0-beta.2", "0.6.0", "0.7.0-beta.1"), null)
  assert.equal(selectPluginTarget("0.6.0", "0.6.0", null), null)
  assert.equal(selectPluginTarget(null, "0.6.0-beta.1", "0.6.0-beta.1"), "0.6.0-beta.1")
})

test("prerelease registration uses the exact installer version", () => {
  const beta = { options: { packageSpec: undefined }, installerVersion: "0.6.0-beta.1" } as never
  assert.equal(registrationSpec(beta), "opencode-spotify@0.6.0-beta.1")
  const pinned = { options: { packageSpec: "opencode-spotify@0.5.7" }, installerVersion: "0.6.0-beta.1" } as never
  assert.equal(registrationSpec(pinned), "opencode-spotify@0.5.7")
})

test("shipped compatibility metadata matches the enforced constants", () => {
  const path = fileURLToPath(new URL("../compat.json", import.meta.url))
  const metadata = JSON.parse(readFileSync(path, "utf8")) as {
    bridge: { protocol: number; handshake: string; port: number }
    minimum: { opencode: string; spicetify: string }
  }
  assert.equal(metadata.bridge.protocol, BRIDGE_PROTOCOL)
  assert.equal(metadata.bridge.handshake, BRIDGE_HANDSHAKE)
  assert.equal(metadata.bridge.port, BRIDGE_PORT)
  assert.equal(metadata.minimum.opencode, MIN_OPENCODE)
  assert.equal(metadata.minimum.spicetify, MIN_SPICETIFY)
})

test("registry lookups fail closed and parse stable output", async () => {
  const good = runtimeWith(async () => ({ code: 0, stdout: '{"latest":"0.7.0","beta":"0.8.0-beta.1"}\n', stderr: "" }))
  const version = await npmLatest(good, "opencode-spotify", false)
  assert.equal(version.latest, "0.7.0")
  assert.equal(version.latestBeta, "0.8.0-beta.1")
  const missing = runtimeWith(async () => ({ code: 1, stdout: "", stderr: "E404 Not Found" }))
  const missingVersion = await npmLatest(missing, "opencode-spotify", false)
  assert.equal(missingVersion.latest, null)
  assert.match(missingVersion.error ?? "", /E404/)
  const offline = await npmLatest(good, "opencode-spotify", true)
  assert.equal(offline.latest, null)
  assert.match(offline.error ?? "", /Offline/)
  const fetcher = (async () => new Response(JSON.stringify({ tag_name: "v2.47.0" }), { status: 200 })) as typeof fetch
  assert.equal((await githubLatest(good, "spicetify/cli", false, fetcher)).latest, "2.47.0")
  const denied = (async () => new Response("{}", { status: 403 })) as typeof fetch
  assert.match((await githubLatest(good, "spicetify/cli", false, denied)).error ?? "", /HTTP 403/)
})
