// V0.6.0-beta.3 channel coverage. Fake runtimes only: never touches live
// systems, registries, or user configuration. Covers B21 (upstream discovery
// + offline skip), B23 (channel-aware comparison matrix), B24 (backup-first
// progress). B22 verified-zip flow retired in favor of the pinned official
// installer (see cli-official-installer.test.ts).
import { test } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { applyBridge } from "../src/cli/bridge.ts"
import { describePluginUpdate, resolvePluginChannels, selectPluginTarget } from "../src/cli/update-plan.ts"
import { resolveChannelLabels, runStatus } from "../src/cli/status.ts"
import { runUpdate } from "../src/cli/update.ts"
import { ensureSpicetify } from "../src/cli/setup.ts"
import { main } from "../src/cli/main.ts"
import { registrationSpec } from "../src/cli/plan.ts"
import {
  spicetifyArchToken,
  spicetifyManualDetails,
  upgradeSpicetify,
} from "../src/cli/spicetify.ts"
import type { Runtime } from "../src/cli/types.ts"
import { context, fakeDetection, fakePrompt, fakeRuntime, fakeUi } from "./cli-fixture.ts"
import type { FakeRuntime } from "./cli-fixture.ts"

function fakeBase(overrides: Partial<Runtime> = {}): Runtime {
  const base = fakeRuntime()
  return { ...base, ...overrides } as unknown as Runtime
}

// ---------------------------------------------------------------------------
// B21: fresh install discovers upstream even when Spicetify is absent; setup
// approval shows BOTH upstream and Winget candidates; offline skips queries.
// ---------------------------------------------------------------------------

test("B21 fresh install discovers upstream and manual shows pinned official guidance", async () => {
  const runtime = fakeRuntime()
  runtime.state.spicetify.available = false
  const ui = fakeUi()
  const ctx = context(runtime, ui, fakePrompt({ choices: ["manual"] }), {
    command: "setup",
    yes: false,
    nonInteractive: false,
    spicetify: "auto",
    offline: true,
  })
  ctx.detection = fakeDetection(runtime, {
    spicetify: {
      available: false,
      path: null,
      version: null,
      owner: "unknown" as const,
      configPath: null,
      extensionsDir: null,
      bridgeRegistered: false,
    },
  })
  // Simulate main.ts upstream discovery: upstream newer than any manager.
  ctx.versions.spicetify.latest = "2.47.0"
  ctx.versions.spicetify.installed = null
  // Drive the manual branch directly: offline avoids all network, shows the
  // pinned official installer docs/version/asset without downloading.
  const manualCtx = context(runtime, ui, fakePrompt(), {
    command: "setup",
    yes: false,
    nonInteractive: false,
    spicetify: "manual",
    offline: true,
  })
  manualCtx.detection = ctx.detection
  manualCtx.versions.spicetify.latest = "2.47.0"
  const outcome = await ensureSpicetify(manualCtx)
  // Manual waits for recheck; with no TTY recast it declines cleanly.
  assert.ok(outcome === "declined" || outcome === "failed", `manual exits without mutating (got ${outcome})`)
  const text = ui.lines.join("\n")
  // B26: the target is the resolved strict-stable release, never a hardcoded pin.
  assert.ok(text.includes("2.47.0"), `resolved official target displayed:\n${text}`)
  assert.ok(/official/i.test(text), `official installer guidance displayed:\n${text}`)
})


test("B21 offline mode skips registry/GitHub queries", async () => {
  const runtime = fakeRuntime()
  const ui = fakeUi()
  const log = { lines: [] as string[], out(line: string) { this.lines.push(line) }, err(line: string) { this.lines.push(line) } }
  const originalFetch = globalThis.fetch
  let fetched = 0
  ;(globalThis as { fetch?: typeof fetch }).fetch = (async () => {
    fetched++
    return new Response("{}", { status: 500 })
  }) as typeof fetch
  try {
    const code = await main(["status", "--offline", "--json"], {
      runtime,
      log,
      ui,
      prompt: fakePrompt(),
    })
    assert.equal(code, 0)
    // No npm registry queries in offline mode.
    assert.ok(!runtime.calls.some((call) => call.file === "npm" || call.args.includes("view")))
    assert.equal(fetched, 0, "offline must not query GitHub")
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("B21 main discovers upstream when Spicetify is absent (online)", async () => {
  const runtime = fakeRuntime()
  runtime.state.spicetify.available = false
  const ui = fakeUi()
  const log = { lines: [] as string[], out(line: string) { this.lines.push(line) }, err(line: string) { this.lines.push(line) } }
  const originalFetch = globalThis.fetch
  let fetchedUrls: string[] = []
  ;(globalThis as { fetch?: typeof fetch }).fetch = (async (input: unknown) => {
    fetchedUrls.push(String(input))
    return new Response(JSON.stringify({ tag_name: "v2.47.0" }), { status: 200 })
  }) as typeof fetch
  // Stub npm registry via runtime.run interception is not needed: main calls
  // npmLatest which fails closed on fake runtime (unexpected command) — the
  // assertion is only that GitHub was queried despite Spicetify absent.
  try {
    await main(["status", "--json"], { runtime, log, ui, prompt: fakePrompt() })
    assert.ok(
      fetchedUrls.some((url) => url.includes("api.github.com/repos/spicetify/cli/releases/latest")),
      `upstream queried on fresh install, got: ${fetchedUrls.join(", ")}`,
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

// ---------------------------------------------------------------------------
// B23: channel-aware matrix. latest=beta.1, beta=beta.2, installer=beta.2:
// no update advertised, no downgrade, labels correct. Plus stable/beta users.
// ---------------------------------------------------------------------------

test("B23 beta.2 with registry latest=beta.1 is current, not a downgrade", async () => {
  const info = describePluginUpdate("0.6.0-beta.2", "0.6.0-beta.1", "0.6.0-beta.2")
  assert.equal(info.status, "current")
  assert.equal(info.target, null)
  // Channel labels: prerelease latest is never stable.
  assert.equal(info.stable, null)
  assert.equal(info.beta, "0.6.0-beta.2")
  assert.equal(info.stableMissing, true)
  assert.deepEqual(resolveChannelLabels("0.6.0-beta.1", "0.6.0-beta.2"), {
    stable: null,
    beta: "0.6.0-beta.2",
    stableMissing: true,
  })

  // update.ts reports current (no downgrade error, no plugin add).
  const runtime = fakeRuntime()
  runtime.state.opencode.listVersion = "0.6.0-beta.2"
  const ui = fakeUi()
  const ctx = context(runtime, ui, fakePrompt(), { command: "update", yes: true, nonInteractive: true })
  ctx.detection = fakeDetection(runtime)
  ctx.installerVersion = "0.6.0-beta.2"
  ctx.versions.plugin.latest = "0.6.0-beta.1"
  ctx.versions.plugin.latestBeta = "0.6.0-beta.2"
  const code = await runUpdate(ctx)
  assert.equal(code, 0, ui.lines.join("\n"))
  assert.ok(!runtime.calls.some((call) => call.args.join(" ").includes("plugin add")), "no downgrade reinstall")
  assert.ok(!ui.lines.join("\n").includes("older than installed"), "no false downgrade error")
})

test("B23 stable users stay on stable; beta users see newer beta or stable", async () => {
  // Stable user with newer beta available stays current.
  const stable = describePluginUpdate("0.6.0", "0.6.0", "0.7.0-beta.1")
  assert.equal(stable.status, "current")
  assert.equal(stable.target, null)
  assert.equal(stable.stable, "0.6.0")

  // Beta user moves to stable when it outranks the beta.
  const betaToStable = describePluginUpdate("0.6.0-beta.1", "0.6.0", "0.6.0-beta.2")
  assert.equal(betaToStable.status, "update-available")
  assert.equal(betaToStable.target, "0.6.0")

  // Beta user moves to a newer beta.
  const betaToBeta = describePluginUpdate("0.6.0-beta.1", "0.6.0-beta.1", "0.6.0-beta.2")
  assert.equal(betaToBeta.status, "update-available")
  assert.equal(betaToBeta.target, "0.6.0-beta.2")

  // Older registry tag is distinguished from current/unknown.
  const older = describePluginUpdate("0.7.0", "0.6.0", null)
  assert.equal(older.status, "registry-older")
  assert.equal(older.target, null)

  // Unknown when no metadata.
  assert.equal(describePluginUpdate("0.6.0", null, null).status, "unknown")
  // Fresh installs register the installer/package version, never the tag.
  assert.equal(describePluginUpdate(null, "0.6.0-beta.1", "0.6.0-beta.2").status, "not-installed")
  const fresh = { options: { packageSpec: undefined }, installerVersion: "0.6.0-beta.2" } as never
  assert.equal(registrationSpec(fresh), "opencode-spotify@0.6.0-beta.2")

  // Existing selector semantics preserved (no fork).
  assert.equal(selectPluginTarget("0.6.0", "0.6.0", "0.7.0-beta.1"), null)
})

test("B23 status never labels a prerelease latest as stable", async () => {
  const runtime = fakeRuntime()
  const ui = fakeUi()
  const ctx = context(runtime, ui, fakePrompt(), { command: "status" })
  ctx.detection = fakeDetection(runtime)
  ctx.versions.plugin.latest = "0.7.0-beta.1"
  ctx.versions.plugin.latestBeta = undefined
  assert.equal(await (async () => {
    const { runStatus } = await import("../src/cli/status.ts")
    return runStatus(ctx)
  })(), 0)
  const text = ui.lines.join("\n")
  assert.ok(text.includes("none published (registry latest is a prerelease)"), text)
  assert.ok(!text.includes("Latest stable: 0.7.0-beta.1"), text)
})

// ---------------------------------------------------------------------------
// B24: backup-first progress reporting (never claims playback was verified).
// ---------------------------------------------------------------------------

function progressRuntime(opts: {
  backupMissing: boolean
  backupCode?: number
  applyOutcomes?: Array<{ code: number; stdout?: string; stderr?: string; error?: string }>
}): { runtime: Runtime; progress: string[] } {
  const progress: string[] = []
  let applies = 0
  const runtime = fakeBase({
    async run(file: string, args: string[]) {
      if (args.join(" ") === "backup") {
        if (opts.backupCode === 1) return { code: 1, stdout: "", stderr: "disk full", error: "disk full" }
        return { code: 0, stdout: "backup ok", stderr: "" }
      }
      if (args.join(" ") === "apply") {
        const next = opts.applyOutcomes?.[applies++] ?? { code: 0, stdout: "applied", stderr: "" }
        return { code: next.code, stdout: next.stdout ?? "", stderr: next.stderr ?? "", ...(next.error ? { error: next.error } : {}) }
      }
      return { code: 0, stdout: "", stderr: "" }
    },
    async which(name: string) {
      return name === "spicetify" ? "C:\\spicetify.exe" : undefined
    },
    exists: () => !opts.backupMissing,
  } as unknown as Partial<Runtime>)
  return { runtime, progress }
}

test("B24 missing backup reports detection, creation, apply, and verification", async () => {
  const { runtime, progress } = progressRuntime({ backupMissing: true })
  const result = await applyBridge(runtime, { spicetifyPath: "C:\\sp.exe", onProgress: (line) => progress.push(line) })
  assert.equal(result.code, 0)
  const text = progress.join("\n")
  assert.match(text, /backup not found/i)
  assert.match(text, /backup created/i)
  assert.match(text, /running spicetify apply/i)
  assert.match(text, /apply completed/i)
  assert.match(text, /playback not verified/i)
  assert.ok(!/playback (was|is|has been) verified/i.test(text), "never claim playback was verified")
})

test("B24 present backup skips backup step but still reports apply + verification", async () => {  const { runtime, progress } = progressRuntime({ backupMissing: false })
  const result = await applyBridge(runtime, { spicetifyPath: "C:\\sp.exe", onProgress: (line) => progress.push(line) })
  assert.equal(result.code, 0)
  const text = progress.join("\n")
  assert.ok(!/backup not found/i.test(text))
  assert.ok(!/backup created/i.test(text))
  assert.match(text, /running spicetify apply/i)
  assert.match(text, /playback not verified/i)
})

test("B24 failed backup reports without claiming verification", async () => {
  const { runtime, progress } = progressRuntime({ backupMissing: true, backupCode: 1 })
  const result = await applyBridge(runtime, { spicetifyPath: "C:\\sp.exe", onProgress: (line) => progress.push(line) })
  assert.equal(result.code, 1)
  assert.match(result.error ?? "", /backup/i)
  const text = progress.join("\n")
  assert.match(text, /backup not found/i)
  assert.ok(!/Spicetify apply completed/i.test(text), "no success verification on failure")
})


// ---------------------------------------------------------------------------
// B22: verified direct-binary allowlist, resolution, hashes, containment,
// and refusals. All fetch/child processes faked; no live systems.
// ---------------------------------------------------------------------------
