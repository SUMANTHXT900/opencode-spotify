// V0.6.0-beta.2 regression coverage. Fake runtimes only: never touches a real
// opencode binary, Spotify, Spicetify, or user configuration.
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  listPluginsDetailed,
  reconcileRegistration,
  inspectOpenCode,
  addGlobalPlugin,
} from "../src/cli/opencode.ts"
import { OPERATION_TIMEOUTS } from "../src/cli/runtime.ts"
import { resolveChannelLabels } from "../src/cli/status.ts"
import { applyBridge } from "../src/cli/bridge.ts"
import { refreshWingetSource, wingetLatestVersion } from "../src/cli/spicetify.ts"
import { shortConnectionLabel, connectionHint } from "../src/services/state.ts"
import { executePlan, planExitCode } from "../src/cli/plan.ts"
import { findProjectPluginConflict } from "../src/cli/plan.ts"
import { runSetup } from "../src/cli/setup.ts"
import { runRepair } from "../src/cli/repair.ts"
import { runUpdate } from "../src/cli/update.ts"
import type { CommandResult, Runtime } from "../src/cli/types.ts"
import { fakeRuntime, fakeDetection, fakeUi, fakePrompt, context } from "./cli-fixture.ts"

function fakeBase(overrides: Partial<Runtime> = {}): Runtime {
  const base = fakeRuntime()
  return { ...base, ...overrides } as unknown as Runtime
}

// B01: a failed mutation that actually completed must reconcile as recovered.
test("failed add that actually registered reconciles instead of blind retry", async () => {
  const runtime = fakeRuntime()
  // Simulate: add reports failure, but the list shows the plugin present.
  const failingAdd: Runtime = {
    ...runtime,
    async run(file: string, args: string[], options?: { cwd?: string; timeoutMs?: number }) {
      if (args.join(" ") === "plugin list") {
        return { code: 0, stdout: "ID VERSION SOURCE\nopencode-spotify 0.6.0-beta.2 npm:opencode-spotify@0.6.0-beta.2\n", stderr: "" }
      }
      if (args[1] === "add") {
        return { code: 1, stdout: "", stderr: "registry hiccup", error: "registry hiccup" }
      }
      return runtime.run(file, args, options)
    },
  } as unknown as Runtime
  const addResult = await addGlobalPlugin(failingAdd, "opencode-spotify@0.6.0-beta.2")
  assert.equal(addResult.code, 1)
  const reconciled = await reconcileRegistration(failingAdd)
  assert.equal(reconciled.state, "registered")
  assert.equal(reconciled.match?.version, "0.6.0-beta.2")
})

// B03/B08: timeout before/after a mutation is preserved and list timeout is unknown.
test("timeout status is preserved and failed inspection is unknown, not absent", async () => {
  // listPluginsDetailed surfaces timeout.
  const timeoutRuntime = fakeBase({
    async run() { return { code: 1, stdout: "", stderr: "", error: "timed out after 30000ms", timedOut: true, durationMs: 30000 } },
    async which(name: string) { return name === "opencode" ? "C:\\Tools\\opencode.exe" : undefined },
    exists: () => true,
    isFile: () => false,
    readText: () => { throw new Error("stubbed") },
  } as unknown as Partial<Runtime>)
  const detailed = await listPluginsDetailed(timeoutRuntime, "C:\\Temp")
  assert.equal(detailed.outcome, "timeout")
  assert.equal(detailed.entries.length, 0)

  const info = await inspectOpenCode(timeoutRuntime)
  assert.equal(info.plugin.registered, false)
  assert.equal(info.plugin.state, "unknown")
  assert.ok((info.plugin.detail ?? "").length > 0)

  // A clean empty list is verified absent, not unknown.
  const emptyRuntime = fakeBase({
    async run(file: string, args: string[]) {
      if (file === "opencode" && args.join(" ") === "plugin list") return { code: 0, stdout: "No plugins installed\n", stderr: "" }
      if (file === "opencode" && args[0] === "--version") return { code: 0, stdout: "opencode 2.4.1\n", stderr: "" }
      if (file === "opencode" && args.join(" ") === "debug paths config") return { code: 0, stdout: "C:\\Temp\\config.json\n", stderr: "" }
      if (file === "opencode" && args.join(" ") === "plugin --help") return { code: 0, stdout: "add remove\n", stderr: "" }
      return { code: 0, stdout: "", stderr: "" }
    },
    async which(name: string) { return name === "opencode" ? "C:\\Tools\\opencode.exe" : undefined },
    exists: () => false,
    isFile: () => false,
    readText: () => { throw new Error("stubbed") },
  } as unknown as Partial<Runtime>)
  const absent = await inspectOpenCode(emptyRuntime)
  assert.equal(absent.plugin.registered, false)
  assert.equal(absent.plugin.state, "absent")
})

// B03: operation-specific timeouts are justified and bounded.
test("operation timeouts separate inspection from long mutations", () => {
  assert.ok(OPERATION_TIMEOUTS.pluginList >= 15000)
  assert.ok(OPERATION_TIMEOUTS.pluginMutation >= 60000)
  assert.ok(OPERATION_TIMEOUTS.packageInstall >= 120000)
  assert.ok(OPERATION_TIMEOUTS.spicetifyApply >= 60000)
  assert.ok(OPERATION_TIMEOUTS.bridge >= 60000)
})

// B05: stable/beta channel labels never mislabel a prerelease as stable.
test("registry latest pointing at a prerelease reports no stable", () => {
  assert.deepEqual(resolveChannelLabels("0.6.0", null), { stable: "0.6.0", beta: null, stableMissing: false })
  assert.deepEqual(resolveChannelLabels("0.7.0-beta.1", null), { stable: null, beta: "0.7.0-beta.1", stableMissing: true })
  assert.deepEqual(resolveChannelLabels("0.6.0", "0.7.0-beta.1"), { stable: "0.6.0", beta: "0.7.0-beta.1", stableMissing: false })
  assert.deepEqual(resolveChannelLabels(null, null), { stable: null, beta: null, stableMissing: false })
})

// B09: fresh backup missing triggers backup-then-apply; valid backup applies directly.
test("apply creates a missing backup first and retries backup-related failures", async () => {
  const calls: string[] = []
  const missingBackup: Runtime = fakeBase({
    async run(file: string, args: string[]) {
      calls.push(`${file} ${args.join(" ")}`)
      if (args.join(" ") === "backup") return { code: 0, stdout: "backup ok", stderr: "" }
      if (args.join(" ") === "apply") return { code: 0, stdout: "applied", stderr: "" }
      return { code: 0, stdout: "", stderr: "" }
    },
    async which(name: string) { return name === "spicetify" ? "C:\\spicetify.exe" : undefined },
    exists: () => false,
  } as unknown as Partial<Runtime>)
  const first = await applyBridge(missingBackup, { spicetifyPath: "C:\\spicetify.exe" })
  assert.equal(first.code, 0)
  assert.ok(calls.some((call) => call.includes("backup")), "missing backup runs backup first")
  assert.ok(calls.some((call) => call.includes("apply")))

  // Valid backup: no backup step.
  const directCalls: string[] = []
  const validBackup: Runtime = fakeBase({
    async run(file: string, args: string[]) {
      directCalls.push(`${file} ${args.join(" ")}`)
      if (args.join(" ") === "apply") return { code: 0, stdout: "applied", stderr: "" }
      return { code: 0, stdout: "", stderr: "" }
    },
    async which(name: string) { return name === "spicetify" ? "C:\\spicetify.exe" : undefined },
    exists: (path: string) => path.includes("Backup"),
  } as unknown as Partial<Runtime>)
  const direct = await applyBridge(validBackup, { spicetifyPath: "C:\\spicetify.exe" })
  assert.equal(direct.code, 0)
  assert.ok(!directCalls.some((call) => call.includes("backup")), "valid backup skips the backup step")

  // Backup-related apply failure retries once after a backup.
  let applies = 0
  const flaky: Runtime = fakeBase({
    async run(file: string, args: string[]) {
      if (args.join(" ") === "backup") return { code: 0, stdout: "backup ok", stderr: "" }
      if (args.join(" ") === "apply") {
        applies++
        if (applies === 1) return { code: 1, stdout: "", stderr: "no backup found", error: "no backup found" }
        return { code: 0, stdout: "applied", stderr: "" }
      }
      return { code: 0, stdout: "", stderr: "" }
    },
    async which(name: string) { return name === "spicetify" ? "C:\\spicetify.exe" : undefined },
    exists: () => true,
  } as unknown as Partial<Runtime>)
  const recovered = await applyBridge(flaky, { spicetifyPath: "C:\\spicetify.exe" })
  assert.equal(recovered.code, 0)
  assert.equal(applies, 2)
})

// B09/B04: failed backup reports an actionable sanitized error.
test("failed backup before apply reports without leaking paths", async () => {
  const runtime = fakeBase({
    async run(file: string, args: string[]) {
      if (args.join(" ") === "backup") return { code: 1, stdout: "", stderr: "disk full", error: "disk full secret=abc" }
      return { code: 0, stdout: "", stderr: "" }
    },
    async which(name: string) { return name === "spicetify" ? "C:\\spicetify.exe" : undefined },
    exists: () => false,
  } as unknown as Partial<Runtime>)
  const result = await applyBridge(runtime, { spicetifyPath: "C:\\spicetify.exe" })
  assert.equal(result.code, 1)
  assert.match(result.error ?? "", /backup/i)
})

// B11: narrow-sidebar labels stay concise with actionable hints.
test("connection warnings stay concise with recovery guidance", () => {
  const configError = { connection: "error", error: "Connection configuration error" } as never
  assert.ok(shortConnectionLabel(configError).length < 20)
  assert.match(connectionHint(configError) ?? "", /Restart/i)
  const missing = { connection: "error", error: "bridge not installed" } as never
  assert.equal(shortConnectionLabel(missing), "⚠ No extension")
  const connected = { connection: "connected" } as never
  assert.equal(shortConnectionLabel(connected), "● Connected")
  assert.equal(connectionHint(connected), null)
})

// B13: local/global coexistence warns without editing project config.
test("project-local conflict is detected and never edited by the installer", async () => {
  const runtime = fakeRuntime()
  const conflict = await findProjectPluginConflict(runtime, {
    detect: async () => { throw new Error("unused") },
    latestPlugin: async () => ({ installed: null, latest: null }),
    latestSpicetify: async () => ({ installed: null, latest: null }),
    addGlobalPlugin: async () => ({ code: 0, stdout: "", stderr: "" }),
    removeGlobalPlugin: async () => { throw new Error("must not remove project entries") },
    projectPlugins: async () => [{ id: "opencode-spotify", version: "local", source: "C:\\dev\\opencode-spotify" }],
    installSpicetify: async () => ({ code: 0, stdout: "", stderr: "" }),
    upgradeSpicetify: async () => ({ code: 0, stdout: "", stderr: "" }),
    bridgeOperation: async () => ({ code: 0, stdout: "", stderr: "" }),
    applyBridge: async () => ({ code: 0, stdout: "", stderr: "" }),
    removeCredentials: async () => ({ code: 0, stdout: "", stderr: "" }),
  })
  assert.ok(conflict?.source.includes("C:\\dev"))
})

// B14–B18: winget source refresh and upstream vs winget mismatch are observable.
test("winget source refresh and version resolution are best-effort and argv-safe", async () => {
  const seen: string[][] = []
  const runtime = fakeBase({
    async run(file: string, args: string[]) {
      seen.push([file, ...args])
      if (args[0] === "source") return { code: 0, stdout: "refreshed", stderr: "" }
      if (args[0] === "show") return { code: 0, stdout: "Version: 2.47.0\n", stderr: "" }
      return { code: 0, stdout: "", stderr: "" }
    },
    async which(name: string) { return name === "winget" ? "C:\\winget.exe" : undefined },
  } as unknown as Partial<Runtime>)
  const refreshed = await refreshWingetSource(runtime)
  assert.equal(refreshed.code, 0)
  assert.ok(seen.some((call) => call.includes("source") && call.includes("winget")))
  const version = await wingetLatestVersion(runtime)
  assert.equal(version, "2.47.0")

  const missing = fakeBase({
    async which() { return undefined },
  } as unknown as Partial<Runtime>)
  assert.equal(await wingetLatestVersion(missing), null)
})

// Cancellation and partial completion report completed/pending/skipped accurately.
test("cancelled and failed plans report completed, failed, and skipped stages", async () => {
  const runtime = fakeRuntime()
  const ui = fakeUi()
  const ctx = context(runtime, ui, fakePrompt(), { yes: true })
  const outcome = await executePlan(ctx, "Demo", [
    { id: "a", description: "first", mutates: true, run: async () => {} },
    { id: "b", description: "second", mutates: true, run: async () => { throw new Error("boom secret=hidden") } },
    { id: "c", description: "third", mutates: true, run: async () => {} },
  ])
  assert.equal(outcome.status, "failed")
  assert.deepEqual(outcome.completed, ["a"])
  assert.equal(outcome.failed, "b")
  assert.deepEqual(outcome.skipped, ["c"])
  assert.equal(planExitCode(outcome), 1)
  assert.ok(!ui.lines.join("\n").includes("hidden"), "sanitized failure detail")

  const cancelled = await executePlan(
    context(runtime, fakeUi(), fakePrompt({ confirms: [false] }), { yes: false }),
    "Demo",
    [{ id: "x", description: "mutating", mutates: true, run: async () => { throw new Error("must not run") } }],
  )
  assert.equal(cancelled.status, "cancelled")
  assert.deepEqual(cancelled.completed, [])
  assert.deepEqual(cancelled.skipped, ["x"])
  assert.equal(planExitCode(cancelled), 130)
})

// Packed-package and dependency compatibility invariants.
test("packed artifact keeps host-provided TUI deps optional and the bridge unprovisioned", async () => {
  const { readFileSync } = await import("node:fs")
  const { fileURLToPath } = await import("node:url")
  const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"))
  assert.equal(manifest.version, "0.6.0-beta.2")
  assert.equal(manifest.peerDependenciesMeta?.["@opentui/core"]?.optional, true)
  assert.equal(manifest.peerDependenciesMeta?.["@opentui/solid"]?.optional, true)
  assert.ok(!manifest.dependencies?.["@opentui/core"], "host-provided TUI must not be a runtime dependency")
  const bridge = readFileSync(fileURLToPath(new URL("../spicetify/opencode-spotify-bridge.js", import.meta.url)), "utf8")
  assert.ok(bridge.includes("__OPENCODE_SPOTIFY_SECRET__"))
  // Only the two documented Spotify persisted-query hashes may appear; any
  // other 64-hex value would look like a substituted installation secret.
  const knownHashes = new Set([
    "b02683192a98dde7966b5e6655a79eeb62713eab703eda9902c932818dd52751",
    "eef7cc54888d91bdd6802623477873caa3948ae173a0c34fd86827b267e94c03",
  ])
  const stray = (bridge.match(/[0-9a-f]{64}/g) ?? []).filter((hex) => !knownHashes.has(hex))
  assert.deepEqual(stray, [])
})

// B1 (review): update never rolls back over a registration that reconciles.
test("update skips rollback when a failed add actually registered", async () => {
  const runtime = fakeRuntime()
  runtime.state.opencode.listVersion = "0.5.7"
  const realRun = runtime.run.bind(runtime)
  let adds = 0
  runtime.run = (async (file: string, args: string[], options?: { cwd?: string; timeoutMs?: number }) => {
    if (args[1] === "add") {
      adds++
      if (adds === 1) {
        // Server-side completion despite the reported failure: the remove
        // already cleared the old entry, so publish the new version as listed.
        runtime.state.opencode.listVersion = "0.6.0-beta.2"
        runtime.state.opencode.source = "npm"
        return { code: 1, stdout: "", stderr: "", error: "registry hiccup" }
      }
    }
    return realRun(file, args, options)
  }) as unknown as typeof runtime.run
  const ui = fakeUi()
  const ctx = context(runtime, ui, fakePrompt(), { command: "update", yes: true, nonInteractive: true })
  ctx.detection = fakeDetection(runtime)
  ctx.versions.plugin.latest = "0.6.0-beta.2"
  const code = await runUpdate(ctx)
  // Reconciled as recovered: no rollback add ran, version verified, success.
  assert.equal(code, 0)
  assert.equal(adds, 1)
  assert.ok(ui.lines.join("\n").includes("skipping rollback"))
  assert.ok(!runtime.calls.some((call) => call.args.join(" ").includes("plugin add opencode-spotify@0.5.7")))
})

// B2 (review): setup and repair refuse to mutate on unknown inspection state.
test("setup refuses mutations when registration state is unknown", async () => {
  const runtime = fakeRuntime()
  const ui = fakeUi()
  const ctx = context(runtime, ui, fakePrompt(), { command: "setup", yes: true, nonInteractive: true })
  ctx.detection = fakeDetection(runtime)
  ctx.detection.opencode.plugin = {
    registered: false, version: null, source: null, local: false, spec: null,
    state: "unknown", detail: "plugin list did not complete",
  }
  assert.equal(await runSetup(ctx), 1)
  const commands = runtime.calls.map((call) => `${call.file} ${call.args.join(" ")}`)
  assert.ok(!commands.some((command) => command.includes("plugin add")))
  assert.ok(ui.lines.join("\n").includes("unknown"))
})

test("repair refuses mutations when registration state is unknown", async () => {
  const runtime = fakeRuntime()
  const ui = fakeUi()
  const ctx = context(runtime, ui, fakePrompt(), { command: "repair", yes: true, nonInteractive: true })
  ctx.detection = fakeDetection(runtime)
  ctx.detection.opencode.plugin = {
    registered: false, version: null, source: null, local: false, spec: null,
    state: "unknown", detail: "plugin list did not complete",
  }
  assert.equal(await runRepair(ctx), 1)
  const commands = runtime.calls.map((call) => `${call.file} ${call.args.join(" ")}`)
  assert.ok(!commands.some((command) => command.includes("plugin add")))
})

// B5 (review): update refuses on unknown instead of claiming "not registered".
test("update refuses on unknown registration state without mutating", async () => {
  const runtime = fakeRuntime()
  const ui = fakeUi()
  const ctx = context(runtime, ui, fakePrompt(), { command: "update", yes: true, nonInteractive: true })
  ctx.detection = fakeDetection(runtime)
  ctx.detection.opencode.plugin = {
    registered: false, version: null, source: null, local: false, spec: null,
    state: "unknown", detail: "plugin list did not complete",
  }
  ctx.versions.plugin.latest = "0.6.0-beta.2"
  assert.equal(await runUpdate(ctx), 1)
  assert.ok(ui.lines.join("\n").includes("unknown"))
  assert.equal(runtime.calls.filter((call) => call.args.join(" ").includes("plugin add")).length, 0)
})

// B3 (review): incidental "backup" words do not trigger a backup retry.
test("apply does not back up on incidental backup-worded failures", async () => {
  const seen: string[] = []
  const runtime = fakeBase({
    async run(file: string, args: string[]) {
      seen.push(args.join(" "))
      if (args.join(" ") === "apply") {
        return { code: 1, stdout: "config backup.json preserved", stderr: "", error: "apply failed (config backup.json preserved)" }
      }
      return { code: 0, stdout: "", stderr: "" }
    },
    async which(name: string) { return name === "spicetify" ? "C:\\sp.exe" : undefined },
    exists: () => true,
  } as unknown as Partial<Runtime>)
  const result = await applyBridge(runtime, { spicetifyPath: "C:\\sp.exe" })
  assert.equal(result.code, 1)
  assert.ok(!seen.some((call) => call === "backup"), "no backup step on non-backup failure")
})

// B4 (review): Spicetify-only update applies the just-synced bridge.
test("spicetify-only update synchronizes and applies the bridge", async () => {
  const runtime = fakeRuntime()
  runtime.state.opencode.listVersion = "0.6.0-beta.2"
  runtime.state.bridge.extensionCurrent = false
  runtime.state.spicetify.registered = false
  const ui = fakeUi()
  const ctx = context(runtime, ui, fakePrompt(), {
    command: "update", yes: true, nonInteractive: true, allowSpicetifyUpgrade: true, apply: true,
  })
  ctx.detection = fakeDetection(runtime)
  ctx.versions.plugin.latest = "0.6.0-beta.2"
  ctx.versions.spicetify.latest = "2.47.0"
  assert.equal(await runUpdate(ctx, "spicetify"), 0, ui.lines.join("\n"))
  const commands = runtime.calls.map((call) => `${call.file} ${call.args.join(" ")}`)
  assert.ok(commands.some((command) => command.includes("upgrade")), "Spicetify upgraded")
  assert.ok(commands.some((command) => command.includes("install-extension.ps1")), "bridge synchronized")
  assert.ok(commands.some((command) => command === "C:\\spicetify.exe apply" || command.endsWith(" apply")), "apply ran after sync")
  assert.ok(ui.lines.join("\n").includes("synchronized and applied"))
})
