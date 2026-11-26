import { test } from "node:test"
import assert from "node:assert/strict"
import { runStatus } from "../src/cli/status.ts"
import { runDoctor } from "../src/cli/doctor.ts"
import { runSetup } from "../src/cli/setup.ts"
import { runUpdate } from "../src/cli/update.ts"
import { runRepair } from "../src/cli/repair.ts"
import { runUninstall } from "../src/cli/uninstall.ts"
import { context, fakeDetection, fakePrompt, fakeReport, fakeRuntime, fakeUi } from "./cli-fixture.ts"
import { createCancelToken } from "../src/cli/cancel.ts"

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
  runtime.state.spicetify.version = "2.46.0"
  const which = runtime.which.bind(runtime)
  runtime.which = async (name: string) => (name === "winget" ? "C:\\winget.exe" : which(name))
  const ui = fakeUi()
  const ctx = context(runtime, ui, fakePrompt(), { command: "update", yes: true, allowSpicetifyUpgrade: true })
  ctx.detection = fakeDetection(runtime)
  ctx.detection.spicetify = {
    ...ctx.detection.spicetify,
    owner: "winget",
    path: "C:\\Users\\Test\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Spicetify.Spicetify\\spicetify.exe",
  }
  ctx.versions.plugin.latest = "0.6.0-beta.1"
  ctx.versions.spicetify.latest = "2.47.0"
  assert.equal(await runUpdate(ctx, "both"), 0, ui.lines.join("\n"))
  const commands = runtime.calls.map((call) => `${call.file} ${call.args.join(" ")}`)
  const add = commands.findIndex((command) => command.includes("plugin add"))
  const upgrade = commands.findIndex((command) => command.startsWith("C:\\winget.exe upgrade"))
  assert.ok(add >= 0, "plugin update must run")
  assert.ok(upgrade >= 0, "Spicetify update must run through its owner")
  assert.ok(upgrade < add, "Spicetify step must precede the plugin update")
  // Owner-safe Spicetify route never uses the unverified self-updater.
  assert.ok(!commands.some((command) => command === "C:\\Users\\Test\\AppData\\Local\\spicetify\\spicetify.exe upgrade"),
    "combined update must not invoke spicetify.exe upgrade")
  const text = ui.lines.join("\n")
  const spicetifyStep = text.indexOf("Spicetify")
  const pluginStep = text.indexOf("plugin add")
  assert.ok(spicetifyStep >= 0 && (pluginStep < 0 || spicetifyStep < pluginStep),
    "Spicetify step must precede the plugin update")
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

test("healthy interactive repair offers a re-sync and applies on yes", async () => {
  const runtime = fakeRuntime()
  const prompt = fakePrompt({ confirms: [true, true, true] })
  const ui = fakeUi()
  const ctx = context(runtime, ui, prompt, { command: "repair" })
  ctx.detection = fakeDetection(runtime)
  assert.equal(await runRepair(ctx), 0, ui.lines.join("\n"))
  const cmds = runtime.calls.map((call) => `${call.file} ${call.args.join(" ")}`)
  assert.ok(prompt.asked.some((question) => question.includes("Re-sync the bridge")), prompt.asked.join("\n"))
  assert.ok(cmds.some((command) => command.includes("install-extension.ps1") && command.includes("-Repair")))
  assert.ok(cmds.some((command) => command.endsWith("spicetify.exe apply")))
})

test("healthy interactive repair stays read-only when the re-sync offer is declined", async () => {
  const runtime = fakeRuntime()
  const prompt = fakePrompt({ confirms: [false] })
  const ui = fakeUi()
  const ctx = context(runtime, ui, prompt, { command: "repair" })
  ctx.detection = fakeDetection(runtime)
  assert.equal(await runRepair(ctx), 0, ui.lines.join("\n"))
  assert.ok(prompt.asked.some((question) => question.includes("Re-sync the bridge")), prompt.asked.join("\n"))
  assert.equal(runtime.calls.length, 0, "declining the re-sync must not mutate")
})

test("healthy repair never prompts in non-interactive or dry-run mode", async () => {
  for (const options of [
    { command: "repair", nonInteractive: true },
    { command: "repair", dryRun: true },
  ] as const) {
    const runtime = fakeRuntime()
    const prompt = fakePrompt({ confirms: [true] })
    const ctx = context(runtime, fakeUi(), prompt, { ...options })
    ctx.detection = fakeDetection(runtime)
    assert.equal(await runRepair(ctx), 0, JSON.stringify(options))
    assert.deepEqual(prompt.asked, [], `${JSON.stringify(options)} must stay deterministic`)
    assert.equal(runtime.calls.length, 0, `${JSON.stringify(options)} must not mutate`)
  }
})

test("uninstall removes only the registration and owned bridge, keeping credentials by default", async () => {
  const runtime = fakeRuntime()
  // A real bridge.json always implies its credential directory exists.
  const realExists = runtime.exists.bind(runtime)
  runtime.exists = (path: string) =>
    path === "C:\\Users\\Test\\AppData\\Roaming\\opencode-spotify" || realExists(path)
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

test("update cancellation returns 130, never 1, and never starts the next step", async () => {
  const runtime = fakeRuntime()
  runtime.state.opencode.listVersion = "0.5.7"
  const ui = fakeUi()
  const ctx = context(runtime, ui, fakePrompt(), { command: "update", yes: true, nonInteractive: true })
  ctx.detection = fakeDetection(runtime)
  ctx.versions.plugin.latest = "0.6.0-beta.1"
  const realRun = runtime.run.bind(runtime)
  runtime.run = (async (file: string, args: string[], options?: unknown) => {
    const result = await realRun(file, args, options as never)
    // Cancel while the protected registration step is in flight.
    if (file.includes("opencode") && args[1] === "add") ctx.cancel.request("sigint")
    return result
  }) as typeof runtime.run

  assert.equal(await runUpdate(ctx), 130, ui.lines.join("\n"))
  assert.equal(ctx.cancel.phase, "partial")
  const commands = runtime.calls.map((call) => `${call.file} ${call.args.join(" ")}`)
  assert.ok(commands.some((command) => command.includes("plugin add")), "the protected step finished")
  assert.ok(!commands.some((command) => command.includes("install-extension.ps1")), "the next step never started")
})

test("a pre-cancelled update returns 130 with no calls", async () => {
  const runtime = fakeRuntime()
  runtime.state.opencode.listVersion = "0.5.7"
  const cancel = createCancelToken()
  cancel.request("sigterm")
  const ui = fakeUi()
  const ctx = context(runtime, ui, fakePrompt(), { command: "update", yes: true, nonInteractive: true }, undefined, fakeReport(), cancel)
  ctx.detection = fakeDetection(runtime)
  ctx.versions.plugin.latest = "0.6.0-beta.1"

  assert.equal(await runUpdate(ctx), 130)
  assert.equal(runtime.calls.length, 0)
  assert.equal(cancel.phase, "cancelled")
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

// ---------------------------------------------------------------------------
// Cancellation / failure precedence (H1) and truthful summaries (H3)
// ---------------------------------------------------------------------------

function freshInstallRuntime(): ReturnType<typeof fakeRuntime> {
  const runtime = fakeRuntime()
  runtime.state.opencode.listVersion = null
  runtime.state.bridge.installed = false
  runtime.state.bridge.extensionCurrent = false
  runtime.state.spicetify.registered = false
  return runtime
}

function overridePluginAdd(
  runtime: ReturnType<typeof fakeRuntime>,
  outcome: { code: number; cancelled?: boolean; error?: string; after?: () => void },
): void {
  const realRun = runtime.run.bind(runtime)
  runtime.run = (async (file: string, args: string[], options?: unknown) => {
    if (file.includes("opencode") && args[1] === "add") {
      // A code-0 override exercises the real registration mutation; a failure
      // or cancellation is returned directly so no state is "recovered".
      const result = outcome.code === 0
        ? await realRun(file, args, options as never)
        : { code: 0, stdout: "", stderr: "" }
      outcome.after?.()
      return {
        ...result,
        code: outcome.code,
        ...(outcome.cancelled ? { cancelled: true as const } : {}),
        ...(outcome.error ? { error: outcome.error } : {}),
      }
    }
    return realRun(file, args, options as never)
  }) as typeof runtime.run
}

test("setup keeps a real failure (1) when cancellation is requested concurrently", async () => {
  const runtime = freshInstallRuntime()
  const ui = fakeUi()
  const ctx = context(runtime, ui, fakePrompt(), { command: "setup", yes: true })
  ctx.detection = fakeDetection(runtime)
  overridePluginAdd(runtime, {
    code: 1,
    error: "registry unavailable",
    after: () => ctx.cancel.request("sigint"),
  })

  assert.equal(await runSetup(ctx), 1, ui.lines.join("\n"))
  assert.ok(ctx.cancel.requested, "cancellation really was requested")
})

test("setup maps a cancelled registration result to 130, not a generic failure", async () => {
  const runtime = freshInstallRuntime()
  const ui = fakeUi()
  const ctx = context(runtime, ui, fakePrompt(), { command: "setup", yes: true })
  ctx.detection = fakeDetection(runtime)
  overridePluginAdd(runtime, { code: 130, cancelled: true, error: "Cancelled by the user." })

  assert.equal(await runSetup(ctx), 130, ui.lines.join("\n"))
  assert.equal(ctx.cancel.phase, "cancelled")
  const commands = runtime.calls.map((call) => `${call.file} ${call.args.join(" ")}`)
  assert.ok(!commands.some((command) => command.includes("install-extension.ps1")), "no bridge work after cancellation")
})

test("registration-only setup does not prompt for spicetify apply and says the bridge is current", async () => {
  const runtime = fakeRuntime()
  runtime.state.opencode.listVersion = null
  const prompt = fakePrompt()
  const ui = fakeUi()
  const ctx = context(runtime, ui, prompt, { command: "setup", yes: true })
  ctx.detection = fakeDetection(runtime)

  assert.equal(await runSetup(ctx), 0, ui.lines.join("\n"))
  const commands = runtime.calls.map((call) => `${call.file} ${call.args.join(" ")}`)
  assert.ok(commands.some((command) => command.includes("plugin add")))
  assert.ok(!commands.some((command) => command.includes("spicetify apply")), "no apply when the bridge is already current")
  assert.deepEqual(prompt.asked, [], "no apply prompt for a registration-only run")
  const text = ui.lines.join("\n")
  assert.match(text, /already active; no apply needed/i)
  assert.ok(!/apply is still pending/i.test(text), text)
})

test("a cancelled setup reports which steps completed and which were skipped", async () => {
  const runtime = freshInstallRuntime()
  const ui = fakeUi()
  const ctx = context(runtime, ui, fakePrompt(), { command: "setup", yes: true })
  ctx.detection = fakeDetection(runtime)
  overridePluginAdd(runtime, { code: 0, after: () => ctx.cancel.request("sigint") })

  assert.equal(await runSetup(ctx), 130, ui.lines.join("\n"))
  const text = ui.lines.join("\n")
  assert.match(text, /Completed steps: register-global-plugin/)
  assert.match(text, /Not run: bridge-repair/)
  // A cancelled run must not claim the bridge was prepared/applied.
  assert.ok(!/Bridge: (prepared|prepared and applied)/i.test(text), text)
})

test("setup keeps confirmation-required (2) when cancellation is requested during the plan", async () => {
  const runtime = freshInstallRuntime()
  const ui = fakeUi()
  const ctx = context(runtime, ui, fakePrompt(), { command: "setup", nonInteractive: true, yes: false })
  ctx.detection = fakeDetection(runtime)
  // Use the legacy plan screen so the hook runs while the plan is announced.
  ctx.report = undefined
  const bullet = ui.bullet.bind(ui)
  ui.bullet = (line: string) => {
    bullet(line)
    if (/Register opencode-spotify/i.test(line)) ctx.cancel.request("sigint")
  }

  assert.equal(await runSetup(ctx), 2, ui.lines.join("\n"))
  assert.ok(ctx.cancel.requested)
})

test("repair maps a cancelled bridge result to 130, not a generic failure", async () => {
  const runtime = freshInstallRuntime()
  const ui = fakeUi()
  const ctx = context(runtime, ui, fakePrompt(), { command: "repair", yes: true })
  ctx.detection = fakeDetection(runtime)
  const realRun = runtime.run.bind(runtime)
  runtime.run = (async (file: string, args: string[], options?: unknown) => {
    if (file.includes("pwsh")) {
      return { code: 130, stdout: "", stderr: "", cancelled: true as const, error: "Cancelled by the user." }
    }
    return realRun(file, args, options as never)
  }) as typeof runtime.run

  assert.equal(await runRepair(ctx), 130, ui.lines.join("\n"))
  assert.equal(ctx.cancel.phase, "cancelled")
  const commands = runtime.calls.map((call) => `${call.file} ${call.args.join(" ")}`)
  assert.ok(!commands.some((command) => command.includes("spicetify apply")), "no apply after a cancelled bridge step")
})

test("a cancelled repair reports completed and skipped steps honestly", async () => {
  const runtime = freshInstallRuntime()
  const ui = fakeUi()
  const ctx = context(runtime, ui, fakePrompt(), { command: "repair", yes: true })
  ctx.detection = fakeDetection(runtime)
  overridePluginAdd(runtime, { code: 0, after: () => ctx.cancel.request("sigint") })

  assert.equal(await runRepair(ctx), 130, ui.lines.join("\n"))
  const text = ui.lines.join("\n")
  assert.match(text, /Completed steps: register-global-plugin/)
  assert.match(text, /Not run: repair-bridge/)
  assert.ok(!/Bridge: repaired and applied/i.test(text), text)
})
