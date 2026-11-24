import { test } from "node:test"
import assert from "node:assert/strict"
import { runStatus } from "../src/cli/status.ts"
import { runDoctor } from "../src/cli/doctor.ts"
import { runSetup } from "../src/cli/setup.ts"
import { runUpdate } from "../src/cli/update.ts"
import { runRepair } from "../src/cli/repair.ts"
import { runUninstall } from "../src/cli/uninstall.ts"
import { context, fakeDetection, fakePrompt, fakeRuntime, fakeUi } from "./cli-fixture.ts"

const mutating = (calls: Array<{ file: string; args: string[] }>) =>
  calls.filter((call) => call.file.includes("opencode") && ["add", "remove", "update"].includes(call.args[1] ?? "") ||
    call.file.includes("pwsh") || call.args.includes("apply") || call.args.includes("upgrade"))

test("status is read-only and emits a stable JSON shape", async () => {
  const runtime = fakeRuntime()
  const ui = fakeUi()
  const ctx = context(runtime, ui, fakePrompt(), { command: "status", json: true })
  assert.equal(await runStatus(ctx), 0)
  const report = ui.jsonValue as Record<string, any>
  assert.equal(report.schemaVersion, 1)
  assert.equal(report.package, "opencode-spotify")
  assert.equal(report.sideEffects, "none")
  assert.equal(report.registration.registered, true)
  assert.equal(report.bridge.protocol, 2)
  assert.deepEqual(runtime.calls, [], "status must not execute commands")
})

test("doctor is read-only and reports missing prerequisites as failures", async () => {
  const runtime = fakeRuntime()
  runtime.state.opencode.available = false
  const ui = fakeUi()
  const ctx = context(runtime, ui, fakePrompt(), { command: "doctor", json: true })
  ctx.detection = fakeDetection(runtime, {
    opencode: { ...fakeDetection(runtime).opencode, available: false },
    compatibility: { opencode: "unknown", spicetify: "ok", bridge: "compatible", plugin: "missing" },
  })
  assert.equal(await runDoctor(ctx), 1)
  const report = ui.jsonValue as Record<string, any>
  assert.equal(report.readOnly, true)
  assert.ok(report.summary.fail >= 1)
  assert.ok(report.checks.some((check: { id: string; status: string }) => check.id === "opencode" && check.status === "fail"))
  assert.ok(mutating(runtime.calls).length === 0, "doctor must not mutate")
})

test("setup stops before bridge work when prerequisites are missing or non-Windows", async () => {
  const runtime = fakeRuntime()
  const ui = fakeUi()
  const ctx = context(runtime, ui, fakePrompt(), { command: "setup", nonInteractive: true })
  ctx.detection = fakeDetection(runtime, { windows: false })
  assert.equal(await runSetup(ctx), 1)
  assert.equal(runtime.calls.length, 0)

  const noSpotify = fakeRuntime()
  const spotifyCtx = context(noSpotify, fakeUi(), fakePrompt(), { command: "setup", nonInteractive: true })
  spotifyCtx.detection = fakeDetection(noSpotify, {
    spotify: { installed: false, store: false, path: null, prefs: null, detail: "missing" },
  })
  assert.equal(await runSetup(spotifyCtx), 1)
  assert.equal(mutating(noSpotify.calls).length, 0)
})

test("missing Spicetify offers skip/dry-run without modifying anything", async () => {
  const skipped = fakeRuntime()
  const skipCtx = context(skipped, fakeUi(), fakePrompt(), { command: "setup", spicetify: "skip" })
  skipCtx.detection = fakeDetection(skipped, {
    spicetify: { available: false, path: null, version: null, owner: "unknown", configPath: null, extensionsDir: null, bridgeRegistered: false },
    bridge: { configExists: false, credentialValid: false, installed: false, origins: 0, extensionPath: null, extensionExists: false, registration: "unknown", protocol: 2 },
  })
  assert.equal(await runSetup(skipCtx), 0)
  assert.equal(mutating(skipped.calls).length, 0)

  const dry = fakeRuntime()
  const dryCtx = context(dry, fakeUi(), fakePrompt(), { command: "setup", dryRun: true, spicetify: "ask" })
  dryCtx.detection = fakeDetection(dry, {
    spicetify: { available: false, path: null, version: null, owner: "unknown", configPath: null, extensionsDir: null, bridgeRegistered: false },
  })
  assert.equal(await runSetup(dryCtx), 0)
  assert.equal(mutating(dry.calls).length, 0)
})

test("existing complete installation enters maintenance and can exit without changes", async () => {
  const runtime = fakeRuntime()
  runtime.state.opencode.listVersion = "0.6.0"
  const ui = fakeUi()
  const ctx = context(runtime, ui, fakePrompt({ choices: ["exit"] }), { command: "setup" })
  ctx.versions.plugin.latest = "0.6.0"
  ctx.versions.spicetify.latest = "2.46.7"
  assert.equal(await runSetup(ctx), 0)
  assert.equal(mutating(runtime.calls).length, 0)
})

test("noninteractive setup with missing Spicetify and no mode is refused safely", async () => {
  const runtime = fakeRuntime()
  const ui = fakeUi()
  const ctx = context(runtime, ui, fakePrompt(), { command: "setup", nonInteractive: true, spicetify: "ask" })
  ctx.detection = fakeDetection(runtime, {
    spicetify: { available: false, path: null, version: null, owner: "unknown", configPath: null, extensionsDir: null, bridgeRegistered: false },
  })
  assert.equal(await runSetup(ctx), 1)
  assert.ok(ui.lines.some((line) => line.includes("--spicetify=auto")))
  assert.equal(mutating(runtime.calls).length, 0)
})

test("fresh setup registers globally and installs the bridge only after plan approval", async () => {
  const runtime = fakeRuntime()
  runtime.state.opencode.listVersion = null
  runtime.state.bridge.installed = false
  runtime.state.bridge.extensionCurrent = false
  runtime.state.spicetify.registered = false
  const ui = fakeUi()
  const ctx = context(runtime, ui, fakePrompt({ confirms: [true, false] }), { command: "setup", yes: false })
  ctx.detection = fakeDetection(runtime)
  assert.equal(await runSetup(ctx), 0, ui.lines.join("\n") + "\n" + runtime.calls.map((call) => `${call.file} ${call.args.join(" ")}`).join("\n"))
  const commands = runtime.calls.map((call) => `${call.file} ${call.args.join(" ")}`)
  assert.ok(commands.some((command) => command.includes("plugin add opencode-spotify@0.6.0-beta.1")))
  assert.ok(commands.some((command) => command.includes("install-extension.ps1") && (command.includes("-Install") || command.includes("-Repair"))))
  assert.ok(!commands.some((command) => command.includes("spicetify apply")), "apply requires separate consent")
})

test("plugin-only update replaces a pinned registration and never touches Spicetify", async () => {
  const runtime = fakeRuntime()
  runtime.state.opencode.listVersion = "0.5.7"
  const ctx = context(runtime, fakeUi(), fakePrompt(), { command: "update", yes: true, nonInteractive: true })
  ctx.detection = fakeDetection(runtime)
  ctx.versions.plugin.latest = "0.6.0-beta.1"
  ctx.versions.spicetify.latest = "2.47.0"
  assert.equal(await runUpdate(ctx), 0)
  const commands = runtime.calls.map((call) => `${call.file} ${call.args.join(" ")}`)
  assert.ok(commands.some((command) => command.includes("plugin remove opencode-spotify@0.5.7")))
  assert.ok(commands.some((command) => command.includes("plugin add opencode-spotify@0.6.0-beta.1")))
  assert.ok(!commands.some((command) => command.includes("spicetify upgrade")))
  assert.equal(runtime.state.spicetifyUpgradeCalls, 0)
})

test("stable installs never switch to a beta automatically", async () => {
  const runtime = fakeRuntime()
  runtime.state.opencode.listVersion = "0.6.0"
  const ctx = context(runtime, fakeUi(), fakePrompt(), { command: "update", yes: true, nonInteractive: true })
  ctx.detection = fakeDetection(runtime)
  ctx.versions.plugin.latest = "0.6.0"
  ;(ctx.versions.plugin as { latestBeta?: string }).latestBeta = "0.7.0-beta.1"
  assert.equal(await runUpdate(ctx), 0)
  assert.ok(!runtime.calls.some((call) => `${call.file} ${call.args.join(" ")}`.includes("plugin add")))
})

test("beta installs move to a newer beta without touching stable logic", async () => {
  const runtime = fakeRuntime()
  runtime.state.opencode.listVersion = "0.6.0-beta.1"
  const ctx = context(runtime, fakeUi(), fakePrompt(), { command: "update", yes: true, nonInteractive: true })
  ctx.detection = fakeDetection(runtime)
  ctx.versions.plugin.latest = "0.6.0-beta.1"
  ;(ctx.versions.plugin as { latestBeta?: string }).latestBeta = "0.6.0-beta.2"
  assert.equal(await runUpdate(ctx), 0)
  const commands = runtime.calls.map((call) => `${call.file} ${call.args.join(" ")}`)
  assert.ok(commands.some((command) => command.includes("plugin add opencode-spotify@0.6.0-beta.2")))
})

test("beta installs move to stable when it outranks the beta", async () => {
  const runtime = fakeRuntime()
  runtime.state.opencode.listVersion = "0.6.0-beta.2"
  const ctx = context(runtime, fakeUi(), fakePrompt(), { command: "update", yes: true, nonInteractive: true })
  ctx.detection = fakeDetection(runtime)
  ctx.versions.plugin.latest = "0.6.0"
  ;(ctx.versions.plugin as { latestBeta?: string }).latestBeta = "0.6.0-beta.2"
  assert.equal(await runUpdate(ctx), 0)
  const commands = runtime.calls.map((call) => `${call.file} ${call.args.join(" ")}`)
  assert.ok(commands.some((command) => command.includes("plugin add opencode-spotify@0.6.0")))
})

test("update refuses downgrades and unknown registry state", async () => {
  const downgrade = fakeRuntime()
  downgrade.state.opencode.listVersion = "0.7.0"
  const downCtx = context(downgrade, fakeUi(), fakePrompt(), { command: "update", yes: true })
  downCtx.detection = fakeDetection(downgrade)
  downCtx.versions.plugin.latest = "0.6.0"
  assert.equal(await runUpdate(downCtx), 1)
  assert.equal(mutating(downgrade.calls).length, 0)

  const unknown = fakeRuntime()
  const unknownCtx = context(unknown, fakeUi(), fakePrompt(), { command: "update", yes: true, offline: true })
  unknownCtx.detection = fakeDetection(unknown)
  unknownCtx.versions.plugin.latest = null
  assert.equal(await runUpdate(unknownCtx), 1)
  assert.equal(mutating(unknown.calls).length, 0)
})

test("combined update upgrades Spicetify first, then the plugin", async () => {
  const runtime = fakeRuntime()
  runtime.state.opencode.listVersion = "0.5.7"
  const ui = fakeUi()
  const ctx = context(runtime, ui, fakePrompt(), { command: "update", yes: true, allowSpicetifyUpgrade: true })
  ctx.detection = fakeDetection(runtime)
  ctx.versions.plugin.latest = "0.6.0-beta.1"
  ctx.versions.spicetify.latest = "2.47.0"
  assert.equal(await runUpdate(ctx, "both"), 0, ui.lines.join("\n"))
  const commands = runtime.calls.map((call) => `${call.file} ${call.args.join(" ")}`)
  const upgrade = commands.findIndex((command) => command.endsWith("spicetify.exe upgrade"))
  const add = commands.findIndex((command) => command.includes("plugin add"))
  assert.ok(upgrade >= 0 && add > upgrade, "Spicetify upgrade must precede the plugin update")
  assert.equal(runtime.state.spicetifyUpgradeCalls, 1)
})

test("repair re-registers and repairs only owned components", async () => {
  const runtime = fakeRuntime()
  runtime.state.opencode.listVersion = null
  runtime.state.bridge.installed = false
  runtime.state.bridge.extensionCurrent = false
  runtime.state.spicetify.registered = false
  const ui = fakeUi()
  const ctx = context(runtime, ui, fakePrompt(), { command: "repair", yes: true })
  ctx.detection = fakeDetection(runtime)
  assert.equal(await runRepair(ctx), 0, ui.lines.join("\n") + "\n" + runtime.calls.map((call) => `${call.file} ${call.args.join(" ")}`).join("\n"))
  const commands = runtime.calls.map((call) => `${call.file} ${call.args.join(" ")}`)
  assert.ok(commands.some((command) => command.includes("plugin add opencode-spotify@0.6.0-beta.1")))
  assert.ok(commands.some((command) => command.includes("install-extension.ps1") && (command.includes("-Install") || command.includes("-Repair"))))
  assert.ok(!commands.some((command) => command.includes("spicetify upgrade")))
})

test("uninstall removes only the registration and owned bridge, keeping credentials by default", async () => {
  const runtime = fakeRuntime()
  const ui = fakeUi()
  const ctx = context(runtime, ui, fakePrompt({ confirms: [true] }), { command: "uninstall", yes: true })
  ctx.detection = fakeDetection(runtime)
  assert.equal(await runUninstall(ctx), 0, ui.lines.join("\n"))
  const commands = runtime.calls.map((call) => `${call.file} ${call.args.join(" ")}`)
  assert.ok(commands.some((command) => command.includes("plugin remove")))
  assert.ok(commands.some((command) => command.includes("install-extension.ps1") && command.includes("-Uninstall")))
  assert.ok(!commands.some((command) => command.includes("spicetify apply")))
  assert.ok(ui.lines.some((line) => line.includes("Credentials: kept")))
})

test("uninstall cancellation performs no mutation", async () => {
  const runtime = fakeRuntime()
  const ctx = context(runtime, fakeUi(), fakePrompt({ confirms: [false] }), { command: "uninstall" })
  ctx.detection = fakeDetection(runtime)
  assert.equal(await runUninstall(ctx), 130)
  assert.equal(runtime.calls.length, 0)
})

test("dry-run never executes update, repair, or uninstall mutations", async () => {
  for (const command of ["update", "repair", "uninstall"] as const) {
    const runtime = fakeRuntime()
    runtime.state.opencode.listVersion = command === "update" ? "0.5.7" : "0.6.0-beta.1"
    if (command === "repair") {
      runtime.state.opencode.listVersion = null
      runtime.state.bridge.installed = false
    }
    const ctx = context(runtime, fakeUi(), fakePrompt(), { command, dryRun: true })
    ctx.detection = fakeDetection(runtime)
    ctx.versions.plugin.latest = "0.6.0-beta.1"
    const code = command === "update" ? await runUpdate(ctx) : command === "repair" ? await runRepair(ctx) : await runUninstall(ctx)
    assert.equal(code, 0, `${command} dry-run`)
    assert.equal(mutating(runtime.calls).length, 0, `${command} dry-run must not mutate`)
  }
})

test("combined update without explicit authorization is refused before any command", async () => {
  const runtime = fakeRuntime()
  runtime.state.opencode.listVersion = "0.5.7"
  const ctx = context(runtime, fakeUi(), fakePrompt(), { command: "update", yes: true, allowSpicetifyUpgrade: false })
  ctx.detection = fakeDetection(runtime)
  ctx.versions.plugin.latest = "0.6.0"
  ctx.versions.spicetify.latest = "2.47.0"
  assert.equal(await runUpdate(ctx, "both"), 1)
  assert.equal(mutating(runtime.calls).length, 0)
})
