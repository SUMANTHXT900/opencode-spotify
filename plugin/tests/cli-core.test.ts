import { test } from "node:test"
import assert from "node:assert/strict"
import { parseArgs, helpText } from "../src/cli/args.ts"
import { BRIDGE_HANDSHAKE, BRIDGE_PORT, BRIDGE_PROTOCOL, MIN_OPENCODE, MIN_SPICETIFY, compareVersions, isAtLeast, isFloatingSpec } from "../src/cli/compat.ts"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { updateAvailability, recommendUpdate, selectPluginTarget, pluginAvailableUpdate } from "../src/cli/update-plan.ts"
import { registrationSpec } from "../src/cli/plan.ts"
import { npmLatest, githubLatest, compareAvailable } from "../src/cli/versions.ts"
import { createCancelToken } from "../src/cli/cancel.ts"
import type { Runtime } from "../src/cli/types.ts"

const originalFetch = globalThis.fetch

/** Stub the registry fetch; records requested URLs so tests prove which path ran. */
function stubFetch(handler: (url: string) => Response | Promise<Response>): { calls: string[]; restore: () => void } {
  const calls: string[] = []
  globalThis.fetch = (async (input: string | URL | Request) => {
    calls.push(String(input))
    return handler(String(input))
  }) as typeof fetch
  return { calls, restore: () => { globalThis.fetch = originalFetch } }
}

function failingFetch(message = "network unreachable"): (url: string) => Promise<Response> {
  return () => Promise.reject(new Error(message))
}

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

test("registry lookups fail closed and parse npm channel tags unchanged", async () => {
  // Force the npm-view fallback path so no live registry is queried.
  const stub = stubFetch(failingFetch())
  try {
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
  } finally {
    stub.restore()
  }
})

test("npmTags queries the registry dist-tags endpoint before spawning npm", async () => {
  let runs = 0
  const runtime = runtimeWith(async () => {
    runs += 1
    return { code: 0, stdout: '{"latest":"9.9.9"}\n', stderr: "" }
  })
  const stub = stubFetch(() => new Response(JSON.stringify({ latest: "0.7.0", beta: "0.8.0-beta.1" }), { status: 200 }))
  try {
    const version = await npmLatest(runtime, "opencode-spotify", false)
    assert.equal(version.latest, "0.7.0")
    assert.equal(version.latestBeta, "0.8.0-beta.1")
    assert.equal(runs, 0, "fetch-first must not spawn npm view")
    assert.equal(stub.calls.length, 1)
    assert.match(stub.calls[0] ?? "", /dist-tags/)
  } finally {
    stub.restore()
  }
})

test("npmTags uses npm view when a custom registry mirror is configured", async () => {
  let runs = 0
  const runtime = runtimeWith(async () => {
    runs += 1
    return { code: 0, stdout: '{"latest":"0.7.0"}\n', stderr: "" }
  })
  runtime.env.npm_config_registry = "https://mirror.example.com/"
  let fetched = 0
  const stub = stubFetch(() => {
    fetched += 1
    return new Response("{}", { status: 200 })
  })
  try {
    const version = await npmLatest(runtime, "opencode-spotify", false)
    assert.equal(version.latest, "0.7.0")
    assert.equal(runs, 1, "custom mirrors keep using npm view")
    assert.equal(fetched, 0, "the public dist-tags endpoint must not be queried for mirrors")
  } finally {
    stub.restore()
  }
})

test("a cancelled registry fetch never falls back to spawning npm", async () => {
  let runs = 0
  const runtime = runtimeWith(async () => {
    runs += 1
    return { code: 0, stdout: '{"latest":"0.7.0"}\n', stderr: "" }
  })
  const hanging = ((input: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const fail = () => reject(new DOMException("Aborted", "AbortError"))
    if (init?.signal?.aborted) fail()
    else init?.signal?.addEventListener("abort", fail, { once: true })
  })) as unknown as typeof fetch
  globalThis.fetch = hanging
  try {
    const token = createCancelToken()
    const pending = npmLatest(runtime, "opencode-spotify", false, { cancel: token })
    await Promise.resolve()
    token.request("user")
    const tags = await pending
    assert.equal(tags.latest, null)
    assert.equal(tags.error, "Cancelled")
    assert.equal(runs, 0, "no npm view fallback after cancellation")
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("beta installs report current instead of a false installed-newer warning", () => {
  // The stable tag (0.5.7) is older than the beta install, but the beta tag
  // matches: current on its channel, never "installed version is newer".
  const current = pluginAvailableUpdate("0.6.0-beta.2", "0.5.7", "0.6.0-beta.2")
  assert.equal(current.status, "current")
  assert.equal(current.available, false)
  const outdated = pluginAvailableUpdate("0.6.0", "0.7.0", null)
  assert.equal(outdated.status, "outdated")
  assert.equal(outdated.available, true)
  assert.equal(outdated.latest, "0.7.0")
  const older = pluginAvailableUpdate("0.7.0", "0.6.0", null)
  assert.equal(older.status, "downgrade")
  assert.equal(older.available, false)
})

// ---- githubLatest: strict stable Spicetify release discovery (F6) ----

function releasePayload(tag: string, extra: Record<string, unknown> = {}): string {
  const version = tag.replace(/^v/, "")
  const assetName = `spicetify-${version}-windows-x64.zip`
  const download = `https://github.com/spicetify/cli/releases/download/${tag}/${assetName}`
  return JSON.stringify({
    id: 12345,
    tag_name: tag,
    name: tag,
    prerelease: tag.includes("-"),
    draft: false,
    published_at: "2026-11-01T00:00:00Z",
    html_url: `https://github.com/spicetify/cli/releases/tag/${tag}`,
    assets: [
      {
        name: assetName,
        size: 11_829_528,
        url: download,
        browser_download_url: download,
      },
    ],
    ...extra,
  })
}

function jsonFetcher(tag: string): typeof fetch {
  return (async () => new Response(releasePayload(tag), { status: 200 })) as typeof fetch
}

test("githubLatest uses the strict stable resolver, including future versions", async () => {
  const runtime = runtimeWith(async () => ({ code: 0, stdout: "", stderr: "" }))
  const future = await githubLatest(runtime, "spicetify/cli", false, jsonFetcher("v9.9.9"))
  assert.equal(future.latest, "9.9.9", "a future stable release is not capped at the installer pin")
  assert.equal(future.error, undefined)
})

test("githubLatest keeps prerelease-only and malformed releases unknown", async () => {
  const runtime = runtimeWith(async () => ({ code: 0, stdout: "", stderr: "" }))
  const prerelease = await githubLatest(runtime, "spicetify/cli", false, jsonFetcher("v9.9.9-beta.1"))
  assert.equal(prerelease.latest, null, "a prerelease-only state is never reported as latest")
  assert.ok(prerelease.error, "unknown state carries an error, not a silent null")

  const malformed = (async () => new Response("{}", { status: 200 })) as typeof fetch
  const unknown = await githubLatest(runtime, "spicetify/cli", false, malformed)
  assert.equal(unknown.latest, null)
  assert.ok(unknown.error)
})

test("githubLatest preserves rate-limit and 404 error strings", async () => {
  const runtime = runtimeWith(async () => ({ code: 0, stdout: "", stderr: "" }))
  const rateLimited = (async () => new Response('{"message":"API rate limit exceeded"}', { status: 403 })) as typeof fetch
  const limited = await githubLatest(runtime, "spicetify/cli", false, rateLimited)
  assert.equal(limited.latest, null)
  assert.match(limited.error ?? "", /HTTP 403/)

  const notFound = (async () => new Response('{"message":"Not Found"}', { status: 404 })) as typeof fetch
  const absent = await githubLatest(runtime, "spicetify/cli", false, notFound)
  assert.equal(absent.latest, null)
  assert.match(absent.error ?? "", /HTTP 404/)

  const offline = await githubLatest(runtime, "spicetify/cli", true, jsonFetcher("v9.9.9"))
  assert.equal(offline.latest, null)
  assert.match(offline.error ?? "", /Offline/)
})

test("githubLatest accepts an options object without a fetcher and honors cancellation", async () => {
  const runtime = runtimeWith(async () => ({ code: 0, stdout: "", stderr: "" }))
  // Overload check: a plain options object is not mistaken for a fetcher.
  const offline = await githubLatest(runtime, "spicetify/cli", true, { cancel: createCancelToken() })
  assert.match(offline.error ?? "", /Offline/)

  const token = createCancelToken()
  token.request("ctrl-c")
  const cancelled = await githubLatest(runtime, "spicetify/cli", false, jsonFetcher("v9.9.9"), { cancel: token })
  assert.equal(cancelled.latest, null)
  assert.equal(cancelled.error, "Cancelled")

  let signal: AbortSignal | undefined
  let aborted = false
  const hanging = ((_input: unknown, init?: RequestInit) => {
    signal = init?.signal ?? undefined
    return new Promise<Response>((_resolve, reject) => {
      const fail = () => {
        aborted = true
        reject(new DOMException("Aborted", "AbortError"))
      }
      if (init?.signal?.aborted) fail()
      else init?.signal?.addEventListener("abort", fail, { once: true })
    })
  }) as typeof fetch
  const live = createCancelToken()
  const pending = githubLatest(runtime, "spicetify/cli", false, hanging, { cancel: live })
  await Promise.resolve()
  live.request("user")
  const stopped = await pending
  assert.equal(stopped.latest, null)
  assert.equal(stopped.error, "Cancelled")
  assert.equal(aborted, true)
  assert.equal(signal?.aborted, true)
})

test("npm lookups stop at a cancellation boundary", async () => {
  const stub = stubFetch(failingFetch())
  try {
  const token = createCancelToken()
  token.request("user")
  let ran = false
  const runtime = runtimeWith(async () => {
    ran = true
    return { code: 0, stdout: '{"latest":"0.7.0"}', stderr: "" }
  })
  const tags = await npmLatest(runtime, "opencode-spotify", false, { cancel: token })
  assert.equal(ran, false)
  assert.equal(stub.calls.length, 0, "a pre-cancelled lookup fetches and spawns nothing")
  assert.equal(tags.latest, null)
  assert.equal(tags.error, "Cancelled")

  const mid = createCancelToken()
  const midRuntime = runtimeWith(async () => {
    mid.request("sigint")
    return { code: 1, stdout: "", stderr: "killed\n" }
  })
  const stopped = await npmLatest(midRuntime, "opencode-spotify", false, { cancel: mid })
  assert.equal(stopped.latest, null)
  assert.equal(stopped.error, "Cancelled")
  } finally {
    stub.restore()
  }
})
