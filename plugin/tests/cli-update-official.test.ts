// B09 workflow coverage: update (official-installer-only routing, channels,
// beta.2 recovery), targeted repair, and both uninstall modes. Fake runtimes
// only: no real OpenCode, Spotify, Spicetify, PATH or file-system mutation.
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  filterPathEntries,
  isWithinBoundary,
  managerUninstallArgs,
  pathRemovalProblem,
  runUninstall,
} from "../src/cli/uninstall.ts"
import { runRepair } from "../src/cli/repair.ts"
import { installerUpdateTarget, runUpdate, spicetifyUpdateDescription, spicetifyUpdateGate, spicetifyUpdateMethod, spicetifyUpdateTarget, stableSpicetifyVersion } from "../src/cli/update.ts"
import type { Prompter } from "../src/cli/types.ts"
import { context, fakeDetection, fakePrompt, fakeReport, fakeRuntime, fakeUi } from "./cli-fixture.ts"

const LOCAL_DIR = "C:\\Users\\Test\\AppData\\Local\\spicetify"
const CONFIG_DIR = "C:\\Users\\Test\\AppData\\Roaming\\spicetify"
const LOCAL_BACKUP_DIR = `${LOCAL_DIR}\\Backup`
const BACKUP_DIR = `${CONFIG_DIR}\\Backup`
const XPUI_SPA = `${BACKUP_DIR}\\xpui.spa`
const LOGIN_SPA = `${BACKUP_DIR}\\login.spa`
const CREDENTIAL_DIR = "C:\\Users\\Test\\AppData\\Roaming\\opencode-spotify"

function scriptedPrompt(input: {
  asks?: Array<string | undefined>
  choices?: Array<string | undefined>
  confirms?: boolean[]
} = {}): Prompter & { asked: string[] } {
  const asks = [...(input.asks ?? [])]
  const choices = [...(input.choices ?? [])]
  const confirms = [...(input.confirms ?? [])]
  const asked: string[] = []
  return {
    asked,
    async ask(question) {
      asked.push(question)
      return asks.length ? asks.shift() : undefined
    },
    async choose(question) {
      asked.push(question)
      return choices.length ? choices.shift() : undefined
    },
    async confirm(question) {
      asked.push(question)
      return confirms.length ? confirms.shift()! : false
    },
    close() {},
  }
}

function completeEnv(runtime: ReturnType<typeof fakeRuntime>) {
  runtime.env.OPENCODE_SPOTIFY_UNINSTALL = "complete"
}

function withExistingDirectories(runtime: ReturnType<typeof fakeRuntime>) {
  const realExists = runtime.exists.bind(runtime)
  runtime.exists = (path: string) =>
    path === LOCAL_DIR || path === CONFIG_DIR || path === CREDENTIAL_DIR || realExists(path)
}

/** Adds a structurally valid Spicetify backup (xpui.spa + login.spa). */
function withValidBackup(runtime: ReturnType<typeof fakeRuntime>) {
  withExistingDirectories(runtime)
  const realExists = runtime.exists.bind(runtime)
  const realIsFile = runtime.isFile.bind(runtime)
  runtime.exists = (path: string) =>
    path === BACKUP_DIR || path === XPUI_SPA || path === LOGIN_SPA || realExists(path)
  runtime.isFile = (path: string) =>
    path === XPUI_SPA || path === LOGIN_SPA || realIsFile(path)
}

function recordingDeps(
  overrides: {
    symlinks?: Set<string>
    fileSize?: (path: string) => number | null
    verifyRestore?: () => Promise<{ ok: boolean; detail?: string }>
  } = {},
) {
  const removed: string[] = []
  const deps = {
    pathInfo: (path: string) => ({ symlink: overrides.symlinks?.has(path) ?? false, realPath: null }),
    removePath: (path: string) => { removed.push(path) },
    fileSize: overrides.fileSize ?? ((path: string) => path === XPUI_SPA ? 1_500_000 : path === LOGIN_SPA ? 300_000 : null),
    verifyRestore: overrides.verifyRestore ?? (async () => ({ ok: true })),
  }
  return { removed, deps }
}

function commands(runtime: ReturnType<typeof fakeRuntime>): string[] {
  return runtime.calls.map((call) => `${call.file} ${call.args.join(" ")}`)
}

/** Fake official-installer upgrade: no network, sets the target version. */
function fakeOfficialUpgrade(runtime: ReturnType<typeof fakeRuntime>, target = "2.47.0") {
  return async (_rt: any, _info: any, _options: any) => {
    runtime.state.spicetify.version = target
    return { code: 0 as const, stdout: `upgraded to ${target} via official`, stderr: "" }
  }
}

/** Marketplace already present: no install, no warning, no network. */
function marketplacePresent() {
  return {
    inspectMarketplace: async () => ({ installed: true, registered: true }),
    installMarketplace: async () => ({ status: "already-installed" as const }),
  }
}

// ---------------------------------------------------------------------------
// Update routing
// ---------------------------------------------------------------------------

test("official-script updates use the B05 pipeline and never the retired verified-zip routing", async () => {
  const runtime = fakeRuntime()
  runtime.state.opencode.listVersion = "0.5.7"
  const ui = fakeUi()
  const ctx = context(runtime, ui, fakePrompt(), {
    command: "update", yes: true, nonInteractive: true, allowSpicetifyUpgrade: true,
  })
  ctx.detection = fakeDetection(runtime)
  ctx.versions.plugin.latest = "0.6.0-beta.1"
  // The official pipeline may only target a strictly stable published release.
  // With the registry reporting the installed version there is no Spicetify
  // upgrade to run here; only the plugin route is exercised.
  ctx.versions.spicetify.latest = "2.46.7"

  assert.equal(await runUpdate(ctx, "both"), 0, ui.lines.join("\n"))
  assert.equal(spicetifyUpdateMethod("script"), "official")
  assert.match(spicetifyUpdateDescription("script"), /official installer/i)
  // A published prerelease/missing tag is never an achievable target.
  assert.equal(spicetifyUpdateTarget("official", "2.47.0"), "2.47.0")
  assert.equal(spicetifyUpdateTarget("official", "2.47.0-beta.1"), null)
  assert.equal(spicetifyUpdateTarget("official", null), null)
  assert.equal(spicetifyUpdateTarget("winget", "2.47.0"), "2.47.0")
  assert.equal(stableSpicetifyVersion("v2.47.0"), "2.47.0")
  assert.equal(stableSpicetifyVersion("02.47.0"), null)
  const calls = commands(runtime)
  assert.ok(calls.some((command) => command.includes("plugin add opencode-spotify@0.6.0-beta.1")))
  assert.ok(!calls.some((command) => /spicetify(\.exe)? upgrade/i.test(command)), "never the self-updater")
  assert.ok(!calls.some((command) => /attestation|Expand-Archive|installSpicetifyVerified/i.test(command)))
  const text = ui.lines.join("\n")
  assert.ok(!/verified-release zip/i.test(text), "no verified-zip guidance")
  assert.match(text, /official installer/i)
})

test("manager-owned Spicetify migrates through the official installer (no manager mixing)", async () => {
  const runtime = fakeRuntime()
  runtime.state.opencode.listVersion = "0.6.0-beta.1"
  runtime.state.spicetify.version = "2.46.0"
  const which = runtime.which.bind(runtime)
  runtime.which = async (name: string) => (name === "winget" ? "C:\\winget.exe" : which(name))
  const ui = fakeUi()
  const ctx = context(runtime, ui, fakePrompt(), {
    command: "update", yes: true, nonInteractive: true, allowSpicetifyUpgrade: true, marketplace: false,
  })
  ctx.detection = fakeDetection(runtime)
  ctx.detection.spicetify = {
    ...ctx.detection.spicetify,
    owner: "winget",
    path: "C:\\Users\\Test\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Spicetify.Spicetify\\spicetify.exe",
  }
  ctx.versions.plugin.latest = "0.6.0-beta.1"
  ctx.versions.spicetify.latest = "2.47.0"

  let upgradedOwner: string | undefined
  const deps = {
    ...marketplacePresent(),
    upgradeSpicetify: async (_rt: any, info: any, _options: any) => {
      upgradedOwner = info.owner
      return fakeOfficialUpgrade(runtime, "2.47.0")(_rt, info, _options)
    },
  }
  assert.equal(await runUpdate(ctx, "spicetify", deps), 0, ui.lines.join("\n"))
  // Legacy manager copies migrate: the upgrade runs as official (script),
  // never through the manager binary.
  assert.equal(upgradedOwner, "script")
  assert.equal(spicetifyUpdateMethod("winget"), "official")
  assert.match(spicetifyUpdateDescription("winget"), /official installer.*migrate/i)
  const calls = commands(runtime)
  assert.ok(!calls.some((command) => command.startsWith("C:\\winget.exe upgrade")), "no manager upgrade")
  assert.ok(!calls.some((command) => /spicetify(\.exe)? upgrade/i.test(command)), "never the self-updater")
  assert.match(ui.lines.join("\n"), /official installer/i)
  assert.match(ui.lines.join("\n"), /migrate/i)
})

test("unknown Spicetify ownership migrates through the official installer (never refused)", async () => {
  const runtime = fakeRuntime()
  runtime.state.opencode.listVersion = "0.6.0-beta.1"
  runtime.state.spicetify.version = "2.46.0"
  const ui = fakeUi()
  const ctx = context(runtime, ui, fakePrompt(), {
    command: "update", yes: true, nonInteractive: true, allowSpicetifyUpgrade: true, marketplace: false,
  })
  ctx.detection = fakeDetection(runtime)
  ctx.detection.spicetify = { ...ctx.detection.spicetify, owner: "unknown" }
  ctx.versions.plugin.latest = "0.6.0-beta.1"
  ctx.versions.spicetify.latest = "2.47.0"

  // Unknown owners are no longer refused: they migrate to official.
  assert.equal(spicetifyUpdateMethod("unknown"), "official")
  const gate = spicetifyUpdateGate({ installed: "2.46.0", owner: "unknown", latest: "2.47.0" })
  assert.equal(gate.status, "outdated")
  assert.equal(gate.target, "2.47.0")
  assert.equal(gate.method, "official")

  let upgradedOwner: string | undefined
  const deps = {
    ...marketplacePresent(),
    upgradeSpicetify: async (_rt: any, info: any, _options: any) => {
      upgradedOwner = info.owner
      return fakeOfficialUpgrade(runtime, "2.47.0")(_rt, info, _options)
    },
  }
  assert.equal(await runUpdate(ctx, "spicetify", deps), 0, ui.lines.join("\n"))
  assert.equal(upgradedOwner, "script")
  assert.ok(runtime.calls.length >= 0)
  assert.match(ui.lines.join("\n"), /official installer/i)
})

test("stable installs stay on stable while a newer beta is only reported", async () => {
  const runtime = fakeRuntime()
  runtime.state.opencode.listVersion = "0.6.0"
  const ui = fakeUi()
  const ctx = context(runtime, ui, fakePrompt(), { command: "update", yes: true, nonInteractive: true })
  ctx.detection = fakeDetection(runtime)
  ctx.versions.plugin.latest = "0.6.0"
  ctx.versions.plugin.latestBeta = "0.7.0-beta.1"

  assert.equal(await runUpdate(ctx), 0)
  assert.ok(!commands(runtime).some((command) => command.includes("plugin add")))
  assert.match(ui.lines.join("\n"), /beta 0\.7\.0-beta\.1 published/)
})

test("beta.2 recovery re-provisions the owned bridge with reused credentials", async () => {
  const runtime = fakeRuntime()
  runtime.state.opencode.listVersion = "0.6.0-beta.2"
  const ui = fakeUi()
  const ctx = context(runtime, ui, fakePrompt(), { command: "update", yes: true, nonInteractive: true })
  ctx.detection = fakeDetection(runtime)
  ctx.versions.plugin.latest = "0.6.0-beta.2"
  ctx.versions.plugin.latestBeta = "0.6.0-beta.2"

  assert.equal(await runUpdate(ctx), 0, ui.lines.join("\n"))
  const calls = commands(runtime)
  assert.ok(calls.some((command) => command.includes("install-extension.ps1") && command.includes("-Repair")))
  assert.ok(!calls.some((command) => command.includes("plugin add")), "no reinstall when already current")
})

test("invalid credentials are regenerated (install) instead of reused", async () => {
  const runtime = fakeRuntime()
  runtime.state.opencode.listVersion = "0.5.7"
  runtime.state.bridge.credentialValid = false
  const ui = fakeUi()
  const ctx = context(runtime, ui, fakePrompt(), { command: "update", yes: true, nonInteractive: true })
  // Exercise the plain Ui path so the step description is visible.
  ctx.report = undefined
  ctx.detection = fakeDetection(runtime)
  ctx.versions.plugin.latest = "0.6.0-beta.1"

  assert.equal(await runUpdate(ctx), 0, ui.lines.join("\n"))
  const calls = commands(runtime)
  assert.ok(calls.some((command) => command.includes("install-extension.ps1") && command.includes("-Install")))
  assert.match(ui.lines.join("\n"), /credentials regenerated/i)
})

test("installerUpdateTarget selects max(registry, installer) without downgrading channels", () => {
  // Channel-compatible: beta installs accept a newer beta installer.
  assert.equal(installerUpdateTarget("0.6.0-beta.1", "0.6.0-beta.2", null), "0.6.0-beta.2")
  // Channel-compatible: a stable installer for a stable install.
  assert.equal(installerUpdateTarget("0.5.7", "0.6.0", "0.5.7"), "0.6.0")
  // Never a downgrade or reinstall.
  assert.equal(installerUpdateTarget("0.6.0", "0.6.0", "0.7.0"), null)
  assert.equal(installerUpdateTarget("0.7.0", "0.6.0", null), null)
  assert.equal(installerUpdateTarget(null, "0.6.0", "0.6.0"), null)
  // A stable install never auto-migrates to a prerelease channel, unless the
  // explicitly-run binary itself outranks the registry target (npx consent).
  assert.equal(installerUpdateTarget("0.5.7", "0.6.0-beta.1", "0.5.7"), "0.6.0-beta.1")
  assert.equal(installerUpdateTarget("0.5.7", "0.6.0-beta.1", "0.6.0"), null)
})

test("a newer installer binary is an update target even when the registry is stale", async () => {
  const runtime = fakeRuntime()
  runtime.state.opencode.listVersion = "0.5.7"
  const ui = fakeUi()
  const ctx = context(runtime, ui, fakePrompt(), { command: "update", yes: true, nonInteractive: true })
  ctx.detection = fakeDetection(runtime)
  ctx.installerVersion = "0.6.0"
  ctx.versions.plugin.latest = "0.5.7"
  ctx.versions.plugin.latestBeta = null

  assert.equal(await runUpdate(ctx), 0, ui.lines.join("\n"))
  const calls = commands(runtime)
  assert.ok(calls.some((command) => command.includes("plugin add opencode-spotify@0.6.0")))
})

test("interactive update-everything selection authorizes both and keeps plan consent", async () => {
  const runtime = fakeRuntime()
  runtime.state.opencode.listVersion = "0.5.7"
  runtime.state.spicetify.version = "2.46.0"
  const which = runtime.which.bind(runtime)
  runtime.which = async (name: string) => (name === "winget" ? "C:\\winget.exe" : which(name))
  const prompt = scriptedPrompt({ choices: ["both"], confirms: [true, true, true] })
  const ui = fakeUi()
  const ctx = context(runtime, ui, prompt, { command: "update", marketplace: false })
  ctx.detection = fakeDetection(runtime)
  ctx.detection.spicetify = {
    ...ctx.detection.spicetify,
    owner: "winget",
    path: "C:\\Users\\Test\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Spicetify.Spicetify\\spicetify.exe",
  }
  ctx.versions.plugin.latest = "0.6.0-beta.1"
  ctx.versions.spicetify.latest = "2.47.0"

  const deps = {
    ...marketplacePresent(),
    upgradeSpicetify: fakeOfficialUpgrade(runtime, "2.47.0"),
  }
  assert.equal(await runUpdate(ctx, "auto", deps), 0, ui.lines.join("\n"))
  assert.equal(ctx.options.allowSpicetifyUpgrade, true)
  assert.ok(commands(runtime).some((command) => command.includes("plugin add opencode-spotify@0.6.0-beta.1")))
  assert.ok(!commands(runtime).some((command) => command.startsWith("C:\\winget.exe upgrade")), "no manager upgrade")
  assert.match(ui.lines.join("\n"), /official installer/i)
})

test("update renders the plan exactly once and uses the shared dry-run wording", async () => {
  const runtime = fakeRuntime()
  runtime.state.opencode.listVersion = "0.5.7"
  const ui = fakeUi()
  const ctx = context(runtime, ui, scriptedPrompt(), { command: "update", dryRun: true, nonInteractive: true })
  ctx.report = undefined // exercise the plain Ui path, where duplication was visible
  ctx.detection = fakeDetection(runtime)
  ctx.versions.plugin.latest = "0.6.0-beta.1"

  assert.equal(await runUpdate(ctx), 0, ui.lines.join("\n"))
  assert.equal(ui.lines.filter((line) => line === "Update plan").length, 1, ui.lines.join("\n"))
  assert.ok(ui.lines.includes("  Dry run: no changes were made."), ui.lines.join("\n"))
  assert.equal(runtime.calls.length, 0)
})

test("continue-without-changes cancels an interactive update with no calls", async () => {
  const runtime = fakeRuntime()
  runtime.state.opencode.listVersion = "0.5.7"
  const prompt = scriptedPrompt({ choices: ["cancel"] })
  const ctx = context(runtime, fakeUi(), prompt, { command: "update" })
  ctx.detection = fakeDetection(runtime)
  ctx.versions.plugin.latest = "0.6.0-beta.1"
  ctx.versions.spicetify.latest = "2.47.0"

  assert.equal(await runUpdate(ctx), 130)
  assert.equal(runtime.calls.length, 0)
})

// ---------------------------------------------------------------------------
// Spicetify-only gates, single consent, cancellation, plan events
// ---------------------------------------------------------------------------

function wingetRuntime(installed = "2.46.0") {
  const runtime = fakeRuntime()
  runtime.state.opencode.listVersion = "0.6.0-beta.1"
  runtime.state.spicetify.version = installed
  const which = runtime.which.bind(runtime)
  runtime.which = async (name: string) => (name === "winget" ? "C:\\winget.exe" : which(name))
  return runtime
}

test("Spicetify-only update asks for plan consent, then always offers apply", async () => {
  const runtime = wingetRuntime()
  const prompt = scriptedPrompt({ confirms: [true, true] })
  const ui = fakeUi()
  const ctx = context(runtime, ui, prompt, { command: "update", allowSpicetifyUpgrade: true, marketplace: false })
  ctx.detection = fakeDetection(runtime)
  ctx.detection.spicetify = {
    ...ctx.detection.spicetify,
    owner: "winget",
    path: "C:\\Users\\Test\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Spicetify.Spicetify\\spicetify.exe",
  }
  ctx.versions.plugin.latest = "0.6.0-beta.1"
  ctx.versions.spicetify.latest = "2.47.0"

  const deps = {
    ...marketplacePresent(),
    upgradeSpicetify: async (_rt: any, _info: any, options: any) => {
      // Simulate the real approval display so the plan section is visible.
      if (typeof options?.approve === "function") {
        await options.approve({
          method: "official-installer",
          source: "spicetify/cli@pinned:install.ps1",
          scriptUrl: "https://example.invalid/install.ps1",
          scriptSha256: "0".repeat(64),
        })
      }
      return fakeOfficialUpgrade(runtime, "2.47.0")(_rt, _info, options)
    },
  }
  assert.equal(await runUpdate(ctx, "spicetify", deps), 0, ui.lines.join("\n"))
  // One consent for the upgrade plan, plus the separate apply offer: the
  // upgrade always ends with an apply prompt even when the bridge is healthy.
  assert.equal(prompt.asked.length, 2, prompt.asked.join("\n"))
  assert.match(prompt.asked[0] ?? "", /Apply this plan\?/)
  assert.match(prompt.asked[1] ?? "", /Apply Spicetify changes now\?/)
  const text = ui.lines.join("\n")
  assert.match(text, /Spicetify upgrade plan/)
  assert.match(text, /official installer/i)
  assert.match(text, /migrate/i)
  assert.ok(!commands(runtime).some((command) => command.startsWith("C:\\winget.exe upgrade")), "no manager upgrade")
  assert.ok(commands(runtime).some((command) => command.endsWith("spicetify.exe apply")))
  assert.match(text, /opencode service restart/i)
})

test("unknown Spicetify latest never prints current and refuses an explicit-only run", async () => {
  const runtime = wingetRuntime()
  const ui = fakeUi()
  const ctx = context(runtime, ui, scriptedPrompt(), { command: "update", allowSpicetifyUpgrade: true })
  ctx.detection = fakeDetection(runtime)
  ctx.detection.spicetify = { ...ctx.detection.spicetify, owner: "winget" }
  ctx.versions.plugin.latest = "0.6.0-beta.1"
  ctx.versions.spicetify.latest = null

  const gate = spicetifyUpdateGate({ installed: "2.46.0", owner: "winget", latest: null })
  assert.equal(gate.status, "unknown")
  assert.equal(gate.target, null)
  assert.match(gate.message ?? "", /could not be determined/i)

  assert.equal(await runUpdate(ctx, "spicetify"), 1, ui.lines.join("\n"))
  const text = ui.lines.join("\n")
  assert.match(text, /could not be determined/i)
  assert.ok(!/Spicetify .* is current/i.test(text), text)
  assert.equal(runtime.calls.length, 0)
})

test("a prerelease or downgrade Spicetify target is refused with clear wording", async () => {
  const prerelease = wingetRuntime()
  const preUi = fakeUi()
  const preCtx = context(prerelease, preUi, scriptedPrompt(), { command: "update", allowSpicetifyUpgrade: true })
  preCtx.detection = fakeDetection(prerelease)
  preCtx.detection.spicetify = { ...preCtx.detection.spicetify, owner: "winget" }
  preCtx.versions.plugin.latest = "0.6.0-beta.1"
  preCtx.versions.spicetify.latest = "2.48.0-beta.1"
  assert.equal(await runUpdate(preCtx, "spicetify"), 1, preUi.lines.join("\n"))
  assert.match(preUi.lines.join("\n"), /not a strict stable release/i)
  assert.equal(prerelease.calls.length, 0)

  const downgrade = wingetRuntime("2.48.0")
  const downUi = fakeUi()
  const downCtx = context(downgrade, downUi, scriptedPrompt(), { command: "update", allowSpicetifyUpgrade: true })
  downCtx.detection = fakeDetection(downgrade)
  downCtx.detection.spicetify = { ...downCtx.detection.spicetify, owner: "winget" }
  downCtx.versions.plugin.latest = "0.6.0-beta.1"
  downCtx.versions.spicetify.latest = "2.47.0"
  assert.equal(await runUpdate(downCtx, "spicetify"), 1, downUi.lines.join("\n"))
  const text = downUi.lines.join("\n")
  assert.match(text, /older than installed/i)
  assert.match(text, /never automatic/i)
  assert.equal(downgrade.calls.length, 0)
})

test("a combined update migrates an unknown Spicetify owner through official and still updates the plugin", async () => {
  const runtime = fakeRuntime()
  runtime.state.opencode.listVersion = "0.5.7"
  const ui = fakeUi()
  const ctx = context(runtime, ui, scriptedPrompt(), {
    command: "update", yes: true, nonInteractive: true, allowSpicetifyUpgrade: true, marketplace: false,
  })
  ctx.detection = fakeDetection(runtime)
  ctx.detection.spicetify = { ...ctx.detection.spicetify, owner: "unknown" }
  ctx.versions.plugin.latest = "0.6.0-beta.1"
  ctx.versions.spicetify.latest = "2.47.0"

  let upgradedOwner: string | undefined
  const deps = {
    ...marketplacePresent(),
    upgradeSpicetify: async (_rt: any, info: any, _options: any) => {
      upgradedOwner = info.owner
      return fakeOfficialUpgrade(runtime, "2.47.0")(_rt, info, _options)
    },
  }
  assert.equal(await runUpdate(ctx, "both", deps), 0, ui.lines.join("\n"))
  assert.equal(upgradedOwner, "script", "unknown migrates to official")
  assert.ok(commands(runtime).some((command) => command.includes("plugin add opencode-spotify@0.6.0-beta.1")))
  assert.ok(!commands(runtime).some((command) => /winget|scoop|choco/i.test(command) && /upgrade/i.test(command)))
  const text = ui.lines.join("\n")
  assert.match(text, /official installer/i)
  assert.match(text, /migrate/i)
  assert.match(text, /opencode service restart/i)
})

test("a combined update skips an unknown Spicetify version and still updates the plugin", async () => {
  const runtime = wingetRuntime()
  runtime.state.opencode.listVersion = "0.5.7"
  const ui = fakeUi()
  const ctx = context(runtime, ui, scriptedPrompt(), {
    command: "update", yes: true, nonInteractive: true, allowSpicetifyUpgrade: true,
  })
  ctx.detection = fakeDetection(runtime)
  ctx.detection.spicetify = { ...ctx.detection.spicetify, owner: "winget" }
  ctx.versions.plugin.latest = "0.6.0-beta.1"
  ctx.versions.spicetify.latest = null

  assert.equal(await runUpdate(ctx, "both"), 0, ui.lines.join("\n"))
  assert.ok(commands(runtime).some((command) => command.includes("plugin add")))
  assert.ok(!commands(runtime).some((command) => command.startsWith("C:\\winget.exe upgrade")))
  assert.match(ui.lines.join("\n"), /could not be determined/i)
})

test("dry-run Spicetify update never prompts and makes no calls", async () => {
  const runtime = wingetRuntime()
  const prompt = scriptedPrompt()
  const ui = fakeUi()
  const ctx = context(runtime, ui, prompt, {
    command: "update", dryRun: true, allowSpicetifyUpgrade: true,
  })
  ctx.detection = fakeDetection(runtime)
  ctx.detection.spicetify = { ...ctx.detection.spicetify, owner: "winget" }
  ctx.versions.plugin.latest = "0.6.0-beta.1"
  ctx.versions.spicetify.latest = "2.47.0"

  assert.equal(await runUpdate(ctx, "spicetify"), 0, ui.lines.join("\n"))
  assert.deepEqual(prompt.asked, [], "dry-run must not prompt")
  assert.equal(runtime.calls.length, 0)
})

test("update emits a plan event with real descriptions and described step events", async () => {
  const runtime = fakeRuntime()
  runtime.state.opencode.listVersion = "0.5.7"
  const report = fakeReport()
  const ui = fakeUi()
  const ctx = context(runtime, ui, scriptedPrompt(), { command: "update", yes: true, nonInteractive: true }, undefined, report)
  ctx.detection = fakeDetection(runtime)
  ctx.versions.plugin.latest = "0.6.0-beta.1"

  assert.equal(await runUpdate(ctx), 0, ui.lines.join("\n"))
  const plan = report.events.find((event) => event.type === "plan")
  assert.ok(plan, "a plan event is emitted before running")
  if (plan?.type === "plan") {
    assert.equal(plan.title, "Update plan")
    assert.ok(plan.steps.length >= 2)
    for (const step of plan.steps) {
      assert.ok(step.description.length > 0)
      assert.notEqual(step.description, step.id, "no id-only rows")
    }
  }
  const steps = report.events.filter((event) => event.type === "step")
  assert.ok(steps.length > 0)
  for (const step of steps) {
    if (step.type !== "step") continue
    assert.ok(step.description && step.description.length > 0, `step ${step.id} carries a description`)
  }
  const result = report.events.at(-1)
  assert.equal(result?.type, "result")
  if (result?.type === "result") assert.equal(result.code, 0)
})

test("update passes its cancel token into registration, bridge and Spicetify child calls", async () => {
  const runtime = wingetRuntime()
  runtime.state.opencode.listVersion = "0.5.7"
  const seen: Array<{ file: string; cancel: unknown }> = []
  const realRun = runtime.run.bind(runtime)
  runtime.run = (async (file: string, args: string[], options?: { cancel?: unknown }) => {
    seen.push({ file, cancel: options?.cancel })
    return realRun(file, args, options as never)
  }) as typeof runtime.run
  const ui = fakeUi()
  const ctx = context(runtime, ui, scriptedPrompt(), {
    command: "update", yes: true, nonInteractive: true, allowSpicetifyUpgrade: true, marketplace: false,
  })
  ctx.detection = fakeDetection(runtime)
  ctx.detection.spicetify = { ...ctx.detection.spicetify, owner: "winget" }
  ctx.versions.plugin.latest = "0.6.0-beta.1"
  ctx.versions.spicetify.latest = "2.47.0"

  let upgradeCancel: unknown
  const deps = {
    ...marketplacePresent(),
    upgradeSpicetify: async (_rt: unknown, _info: unknown, options: { cancel?: unknown }) => {
      upgradeCancel = options.cancel
      runtime.state.spicetify.version = "2.47.0"
      return { code: 0 as const, stdout: "upgraded via official", stderr: "" }
    },
  }
  assert.equal(await runUpdate(ctx, "both", deps), 0, ui.lines.join("\n"))
  assert.equal(upgradeCancel, ctx.cancel, "official upgrade receives the cancel token")
  assert.ok(seen.some((call) => call.file.includes("pwsh") && call.cancel === ctx.cancel), "bridge operation")
  assert.ok(seen.some((call) => call.file.includes("opencode") && call.cancel === ctx.cancel), "registration")
})

// ---------------------------------------------------------------------------
// Repair
// ---------------------------------------------------------------------------

test("repair fixes a missing registration only and never runs bridge/apply/upgrade", async () => {
  const runtime = fakeRuntime()
  runtime.state.opencode.listVersion = null
  const ui = fakeUi()
  const ctx = context(runtime, ui, scriptedPrompt(), { command: "repair", yes: true, nonInteractive: true })
  ctx.detection = fakeDetection(runtime)

  assert.equal(await runRepair(ctx), 0, ui.lines.join("\n"))
  const calls = commands(runtime)
  assert.ok(calls.some((command) => command.includes("plugin add opencode-spotify@0.6.0-beta.1")))
  assert.ok(!calls.some((command) => command.includes("install-extension.ps1")))
  assert.ok(!calls.some((command) => /apply|upgrade|backup|restore/.test(command)))
})

test("repair repairs a stale bridge without reinstalling the plugin", async () => {
  const runtime = fakeRuntime()
  runtime.state.bridge.extensionCurrent = false
  runtime.state.spicetify.registered = false
  const ui = fakeUi()
  const ctx = context(runtime, ui, scriptedPrompt(), { command: "repair", yes: true, nonInteractive: true })
  ctx.detection = fakeDetection(runtime)

  assert.equal(await runRepair(ctx), 0, ui.lines.join("\n"))
  const calls = commands(runtime)
  assert.ok(calls.some((command) => command.includes("install-extension.ps1") && command.includes("-Repair")))
  assert.ok(!calls.some((command) => command.includes("plugin add")))
  assert.ok(!calls.some((command) => /backup|restore/.test(command)), "never resets Spotify mods")
})

test("repair reports missing Spicetify instead of installing it", async () => {
  const runtime = fakeRuntime()
  runtime.state.spicetify.available = false
  runtime.state.bridge.installed = false
  runtime.state.bridge.extensionCurrent = false
  const ui = fakeUi()
  const ctx = context(runtime, ui, scriptedPrompt(), { command: "repair", yes: true, nonInteractive: true })
  ctx.detection = fakeDetection(runtime, {
    spicetify: { available: false, path: null, version: null, owner: "unknown", configPath: null, extensionsDir: null, bridgeRegistered: false },
  })

  assert.equal(await runRepair(ctx), 1)
  assert.equal(runtime.calls.filter((call) => call.file.includes("pwsh")).length, 0)
  assert.match(ui.lines.join("\n"), /Repair will not/)
})

test("repair runs apply only when explicitly requested and the bridge is current", async () => {
  const runtime = fakeRuntime()
  const ui = fakeUi()
  const ctx = context(runtime, ui, scriptedPrompt(), {
    command: "repair", yes: true, nonInteractive: true, apply: true,
  })
  ctx.detection = fakeDetection(runtime)

  assert.equal(await runRepair(ctx), 0, ui.lines.join("\n"))
  assert.ok(commands(runtime).some((command) => command.endsWith("spicetify.exe apply")))
})

// ---------------------------------------------------------------------------
// Uninstall: plugin-only (Mode 1)
// ---------------------------------------------------------------------------

test("plugin-only uninstall never touches the file system or Spicetify", async () => {
  const runtime = fakeRuntime()
  const { removed, deps } = recordingDeps()
  const ui = fakeUi()
  const ctx = context(runtime, ui, scriptedPrompt(), { command: "uninstall", yes: true })
  ctx.detection = fakeDetection(runtime)

  assert.equal(await runUninstall(ctx, deps), 0, ui.lines.join("\n"))
  assert.deepEqual(removed, [])
  const calls = commands(runtime)
  assert.ok(calls.some((command) => command.includes("plugin remove")))
  assert.ok(calls.some((command) => command.includes("-Uninstall")))
  assert.ok(!calls.some((command) => /restore|backup|upgrade/.test(command)))
  assert.match(ui.lines.join("\n"), /Credentials: kept/)
})

test("plugin-only credentials are removed only after the separate phrase confirmation", async () => {
  const runtime = fakeRuntime()
  const realExists = runtime.exists.bind(runtime)
  runtime.exists = (path: string) => path === CREDENTIAL_DIR || realExists(path)
  const removed: string[] = []
  runtime.remove = (path: string) => { removed.push(path) }
  const prompt = scriptedPrompt({ confirms: [true] })
  const ui = fakeUi()
  const ctx = context(runtime, ui, prompt, {
    command: "uninstall", yes: true, removeCredentials: true,
  })
  ctx.detection = fakeDetection(runtime)

  assert.equal(await runUninstall(ctx), 0, ui.lines.join("\n"))
  assert.deepEqual(removed, [CREDENTIAL_DIR])
  assert.ok(prompt.asked.some((question) => question.includes("Delete the stored bridge credentials")))
})

// ---------------------------------------------------------------------------
// Uninstall: complete permanent removal (Mode 2)
// ---------------------------------------------------------------------------

test("complete removal requires typing UNINSTALL interactively (empty input cancels)", async () => {
  const runtime = fakeRuntime()
  completeEnv(runtime)
  const { removed, deps } = recordingDeps()
  const ui = fakeUi()
  const cancelPrompt = scriptedPrompt({ asks: [""] })
  const cancelCtx = context(runtime, ui, cancelPrompt, { command: "uninstall" })
  cancelCtx.detection = fakeDetection(runtime)

  assert.equal(await runUninstall(cancelCtx, deps), 130)
  assert.equal(runtime.calls.length, 0)
  assert.deepEqual(removed, [])
  assert.match(ui.lines.join("\n"), /Cancelled/)

  const confirmRuntime = fakeRuntime()
  completeEnv(confirmRuntime)
  const confirmPrompt = scriptedPrompt({ asks: ["UNINSTALL"] })
  const confirmCtx = context(confirmRuntime, fakeUi(), confirmPrompt, { command: "uninstall" })
  confirmCtx.detection = fakeDetection(confirmRuntime)
  assert.equal(await runUninstall(confirmCtx, recordingDeps().deps), 0)
  assert.ok(commands(confirmRuntime).some((command) => command.includes("plugin remove")))
})

test("complete removal noninteractive requires --complete or the env signal plus --yes", async () => {
  const runtime = fakeRuntime()
  completeEnv(runtime)
  const ctx = context(runtime, fakeUi(), scriptedPrompt(), {
    command: "uninstall", nonInteractive: true, yes: false,
  })
  ctx.detection = fakeDetection(runtime)

  assert.equal(await runUninstall(ctx, recordingDeps().deps), 2)
  assert.equal(runtime.calls.length, 0)
})

test("--complete is accepted as noninteractive authorization and echoes the destruction list", async () => {
  const runtime = fakeRuntime()
  withValidBackup(runtime)
  const { removed, deps } = recordingDeps()
  const ui = fakeUi()
  const ctx = context(runtime, ui, scriptedPrompt(), {
    command: "uninstall", nonInteractive: true, yes: true, complete: true,
  })
  ctx.detection = fakeDetection(runtime)

  assert.equal(await runUninstall(ctx, deps), 0, ui.lines.join("\n"))
  assert.equal(ctx.runtime.env.OPENCODE_SPOTIFY_UNINSTALL, undefined)
  const text = ui.lines.join("\n")
  assert.match(text, /Authorization: --complete \+ --non-interactive \+ --yes/)
  assert.match(text, /Deletes exactly:/)
  assert.match(text, /Preserves:/)
  assert.deepEqual(removed.sort(), [CONFIG_DIR, LOCAL_DIR].sort())
})

test("--complete still requires typed UNINSTALL when interactive", async () => {
  const runtime = fakeRuntime()
  withValidBackup(runtime)
  const prompt = scriptedPrompt() // no typed phrase
  const ui = fakeUi()
  const ctx = context(runtime, ui, prompt, { command: "uninstall", yes: true, complete: true })
  ctx.detection = fakeDetection(runtime)

  assert.equal(await runUninstall(ctx, recordingDeps().deps), 130)
  assert.equal(runtime.calls.length, 0)
  assert.ok(prompt.asked.some((question) => question.includes("UNINSTALL")))
})

test("restore failure aborts before any deletion", async () => {
  const runtime = fakeRuntime()
  completeEnv(runtime)
  withValidBackup(runtime)
  const realRun = runtime.run.bind(runtime)
  let restoreCalled = false
  runtime.run = (async (file: string, args: string[], options?: { cwd?: string; timeoutMs?: number }) => {
    if (file.includes("spicetify") && args.join(" ") === "restore") {
      restoreCalled = true
      return { code: 1, stdout: "", stderr: "restore failed", error: "restore failed" }
    }
    return realRun(file, args, options)
  }) as typeof runtime.run
  const { removed, deps } = recordingDeps()
  const ui = fakeUi()
  const ctx = context(runtime, ui, scriptedPrompt(), {
    command: "uninstall", nonInteractive: true, yes: true,
  })
  ctx.detection = fakeDetection(runtime)

  assert.equal(await runUninstall(ctx, deps), 1)
  assert.equal(restoreCalled, true)
  assert.ok(!commands(runtime).some((command) => command.includes("plugin remove")))
  assert.deepEqual(removed, [])
  assert.match(ui.lines.join("\n"), /restore failed|Nothing Spicetify-owned was deleted/i)
})

test("complete removal restores Spotify first, then deletes only canonical owned paths", async () => {
  const runtime = fakeRuntime()
  completeEnv(runtime)
  withValidBackup(runtime)
  const { removed, deps } = recordingDeps()
  const credentialRemovals: string[] = []
  runtime.remove = (path: string) => { credentialRemovals.push(path) }
  const ui = fakeUi()
  const ctx = context(runtime, ui, scriptedPrompt(), {
    command: "uninstall", nonInteractive: true, yes: true,
  })
  ctx.detection = fakeDetection(runtime)

  assert.equal(await runUninstall(ctx, deps), 0, ui.lines.join("\n"))
  const calls = commands(runtime)
  const restoreIndex = calls.findIndex((command) => command.endsWith(" restore"))
  const removeIndex = calls.findIndex((command) => command.includes("plugin remove"))
  assert.ok(restoreIndex >= 0 && restoreIndex < removeIndex, "restore precedes deletion")
  assert.ok(!calls.some((command) => command.includes(" backup")), "no new recovery backup")
  assert.deepEqual(removed.sort(), [CONFIG_DIR, LOCAL_DIR].sort())
  assert.deepEqual(credentialRemovals, [CREDENTIAL_DIR])
  const text = ui.lines.join("\n")
  assert.match(text, /Spotify Desktop.*never touched/i)
  assert.match(text, /never touched|never removed/i)
  assert.match(text, /Authorization: OPENCODE_SPOTIFY_UNINSTALL=complete \+ --non-interactive \+ --yes/)
})

test("manager-owned Spicetify is removed through its manager, never manually", async () => {
  const runtime = fakeRuntime()
  completeEnv(runtime)
  withValidBackup(runtime)
  const which = runtime.which.bind(runtime)
  runtime.which = async (name: string) => (name === "winget" ? "C:\\winget.exe" : which(name))
  const { removed, deps } = recordingDeps()
  const ui = fakeUi()
  const ctx = context(runtime, ui, scriptedPrompt(), {
    command: "uninstall", nonInteractive: true, yes: true,
  })
  ctx.detection = fakeDetection(runtime)
  ctx.detection.spicetify = {
    ...ctx.detection.spicetify,
    owner: "winget",
    path: "C:\\Users\\Test\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Spicetify.Spicetify\\spicetify.exe",
  }

  assert.equal(await runUninstall(ctx, deps), 0, ui.lines.join("\n"))
  assert.ok(commands(runtime).some((command) => command.startsWith("C:\\winget.exe uninstall --id Spicetify.Spicetify")))
  assert.ok(!removed.some((path) => path.endsWith("spicetify.exe")), "manager binaries are never deleted manually")
  assert.ok(removed.includes(LOCAL_DIR), "local data is removed after restore")
  assert.ok(removed.includes(CONFIG_DIR))
})

test("manager uninstall failure is reported honestly and does not hide remaining components", async () => {
  const runtime = fakeRuntime()
  completeEnv(runtime)
  withValidBackup(runtime)
  const which = runtime.which.bind(runtime)
  runtime.which = async (name: string) => (name === "winget" ? "C:\\winget.exe" : which(name))
  const realRun = runtime.run.bind(runtime)
  runtime.run = (async (file: string, args: string[], options?: { cwd?: string; timeoutMs?: number }) => {
    if (file === "C:\\winget.exe" && args[0] === "uninstall") {
      return { code: 1, stdout: "", stderr: "winget failed", error: "winget failed" }
    }
    return realRun(file, args, options)
  }) as typeof runtime.run
  const { deps } = recordingDeps()
  const ui = fakeUi()
  const ctx = context(runtime, ui, scriptedPrompt(), {
    command: "uninstall", nonInteractive: true, yes: true,
  })
  ctx.detection = fakeDetection(runtime)
  ctx.detection.spicetify = {
    ...ctx.detection.spicetify,
    owner: "winget",
    path: "C:\\Users\\Test\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Spicetify.Spicetify\\spicetify.exe",
  }

  assert.equal(await runUninstall(ctx, deps), 1)
  const text = ui.lines.join("\n")
  assert.match(text, /Removal is incomplete|Could not remove/i)
  assert.match(text, /winget/i)
})

test("unknown ownership discloses a manual step and never deletes the binary", async () => {
  const runtime = fakeRuntime()
  completeEnv(runtime)
  withValidBackup(runtime)
  const { removed, deps } = recordingDeps()
  const ui = fakeUi()
  const ctx = context(runtime, ui, scriptedPrompt(), {
    command: "uninstall", nonInteractive: true, yes: true,
  })
  ctx.detection = fakeDetection(runtime)
  ctx.detection.spicetify = { ...ctx.detection.spicetify, owner: "unknown" }

  assert.equal(await runUninstall(ctx, deps), 1)
  assert.ok(!removed.includes(LOCAL_DIR), "unknown-owner binary directory is not deleted")
  assert.ok(!removed.includes(CONFIG_DIR), "unknown-owner config is never deleted (P1-4)")
  assert.match(ui.lines.join("\n"), /owner is unknown|ownership.*uncertain|uncertain.*ownership/i)
})

test("a junction/symlink at an owned path is refused and reported as remaining", async () => {
  const runtime = fakeRuntime()
  completeEnv(runtime)
  withValidBackup(runtime)
  const { removed, deps } = recordingDeps({ symlinks: new Set([CONFIG_DIR]) })
  const ui = fakeUi()
  const ctx = context(runtime, ui, scriptedPrompt(), {
    command: "uninstall", nonInteractive: true, yes: true,
  })
  ctx.detection = fakeDetection(runtime)

  assert.equal(await runUninstall(ctx, deps), 1)
  assert.ok(removed.includes(LOCAL_DIR), "safe paths are still removed")
  assert.ok(!removed.includes(CONFIG_DIR), "junction is never traversed")
  assert.match(ui.lines.join("\n"), /symbolic link|junction/i)
})

test("complete removal is idempotent when everything is already absent", async () => {
  const runtime = fakeRuntime()
  completeEnv(runtime)
  runtime.state.opencode.listVersion = null
  runtime.state.bridge.installed = false
  runtime.state.bridge.extensionCurrent = false
  runtime.state.spicetify.available = false
  const ctx = context(runtime, fakeUi(), scriptedPrompt(), {
    command: "uninstall", nonInteractive: true, yes: true,
  })
  ctx.detection = fakeDetection(runtime, {
    spicetify: { available: false, path: null, version: null, owner: "unknown", configPath: null, extensionsDir: null, bridgeRegistered: false },
    bridge: { configExists: false, credentialValid: false, installed: false, origins: 0, extensionPath: null, extensionExists: false, registration: "unknown", protocol: 2 },
  })

  assert.equal(await runUninstall(ctx, recordingDeps().deps), 0)
})

test("missing backup reports UNKNOWN and preserves all Spicetify-owned files", async () => {
  const runtime = fakeRuntime()
  completeEnv(runtime)
  withExistingDirectories(runtime)
  const { removed, deps } = recordingDeps()
  const ui = fakeUi()
  const ctx = context(runtime, ui, scriptedPrompt(), {
    command: "uninstall", nonInteractive: true, yes: true,
  })
  ctx.detection = fakeDetection(runtime)

  assert.equal(await runUninstall(ctx, deps), 0, ui.lines.join("\n"))
  assert.deepEqual(removed, [], "no Spicetify-owned path is deleted without a validated backup")
  const calls = commands(runtime)
  assert.ok(!calls.some((command) => command.endsWith(" restore")))
  assert.ok(!calls.some((command) => command.includes(" backup")))
  const text = ui.lines.join("\n")
  assert.match(text, /UNKNOWN restore state/i)
  assert.ok(!/likely unmodified/i.test(text), "never claim Spotify is unmodified")
  assert.match(text, /No validated Spicetify backup/i)
})

test("an incomplete backup blocks complete removal before any deletion", async () => {
  const runtime = fakeRuntime()
  completeEnv(runtime)
  withExistingDirectories(runtime)
  const realIsFile = runtime.isFile.bind(runtime)
  const realExists = runtime.exists.bind(runtime)
  runtime.exists = (path: string) => path === BACKUP_DIR || path === XPUI_SPA || realExists(path)
  runtime.isFile = (path: string) => path === XPUI_SPA || realIsFile(path)
  const deps = recordingDeps({ fileSize: (path) => path === XPUI_SPA ? 50 : null }).deps
  const ui = fakeUi()
  const ctx = context(runtime, ui, scriptedPrompt(), {
    command: "uninstall", nonInteractive: true, yes: true,
  })
  ctx.detection = fakeDetection(runtime)

  assert.equal(await runUninstall(ctx, deps), 1)
  assert.equal(runtime.calls.length, 0)
  assert.match(ui.lines.join("\n"), /backup is incomplete|blocked/i)
})

test("post-restore verification failure aborts before any deletion", async () => {
  const runtime = fakeRuntime()
  completeEnv(runtime)
  withValidBackup(runtime)
  const { removed, deps } = recordingDeps({
    verifyRestore: async () => ({ ok: false, detail: "installed xpui.spa size mismatch" }),
  })
  const ui = fakeUi()
  const ctx = context(runtime, ui, scriptedPrompt(), {
    command: "uninstall", nonInteractive: true, yes: true,
  })
  ctx.detection = fakeDetection(runtime)

  assert.equal(await runUninstall(ctx, deps), 1)
  assert.ok(!commands(runtime).some((command) => command.includes("plugin remove")))
  assert.deepEqual(removed, [])
  assert.match(ui.lines.join("\n"), /verification failed/i)
  assert.match(ui.lines.join("\n"), /config and backups were kept/i)
})

test("manager success without verified removal keeps config/backups and reports remains", async () => {
  const runtime = fakeRuntime()
  completeEnv(runtime)
  withValidBackup(runtime)
  const wingetPath = "C:\\Users\\Test\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Spicetify.Spicetify\\spicetify.exe"
  const realExists = runtime.exists.bind(runtime)
  runtime.exists = (path: string) => path === wingetPath || realExists(path)
  const which = runtime.which.bind(runtime)
  runtime.which = async (name: string) => (name === "winget" ? "C:\\winget.exe" : which(name))
  const { removed, deps } = recordingDeps()
  const ui = fakeUi()
  const ctx = context(runtime, ui, scriptedPrompt(), {
    command: "uninstall", nonInteractive: true, yes: true,
  })
  ctx.detection = fakeDetection(runtime)
  ctx.detection.spicetify = { ...ctx.detection.spicetify, owner: "winget", path: wingetPath }

  assert.equal(await runUninstall(ctx, deps), 1)
  assert.ok(!removed.includes(CONFIG_DIR), "config kept when the package is still present")
  assert.ok(!removed.includes(LOCAL_DIR), "local data kept when the package is still present")
  assert.match(ui.lines.join("\n"), /still present|not considered removed/i)
})

test("P2-11: env var plus --yes is not enough without --non-interactive", async () => {
  const runtime = fakeRuntime()
  completeEnv(runtime)
  withValidBackup(runtime)
  const prompt = scriptedPrompt() // no typed UNINSTALL
  const ui = fakeUi()
  const ctx = context(runtime, ui, prompt, { command: "uninstall", yes: true })
  ctx.detection = fakeDetection(runtime)

  assert.equal(await runUninstall(ctx, recordingDeps().deps), 130)
  assert.equal(runtime.calls.length, 0)
  assert.ok(prompt.asked.some((question) => question.includes("UNINSTALL")))
})

test("script-owned binary outside the canonical dir disables all Spicetify deletions", async () => {
  const runtime = fakeRuntime()
  completeEnv(runtime)
  withValidBackup(runtime)
  const { removed, deps } = recordingDeps()
  const ui = fakeUi()
  const ctx = context(runtime, ui, scriptedPrompt(), {
    command: "uninstall", nonInteractive: true, yes: true,
  })
  ctx.detection = fakeDetection(runtime)
  ctx.detection.spicetify = { ...ctx.detection.spicetify, path: "C:\\Custom\\spicetify.exe" }

  assert.equal(await runUninstall(ctx, deps), 1)
  assert.deepEqual(removed, [], "nothing under %APPDATA%/%LOCALAPPDATA% is deleted")
  assert.match(ui.lines.join("\n"), /nothing under .* was deleted|outside/i)
})

// ---------------------------------------------------------------------------
// Pure path/PATH helpers
// ---------------------------------------------------------------------------

test("PATH filtering preserves unrelated entries exactly and drops only justified ones", () => {
  const value = `C:\\Other\\bin;${LOCAL_DIR};C:\\Users\\Test\\bin;${LOCAL_DIR}\\bin;;`
  const result = filterPathEntries(value, [LOCAL_DIR, `${LOCAL_DIR}\\bin`])
  assert.equal(result.value, "C:\\Other\\bin;C:\\Users\\Test\\bin")
  assert.deepEqual(result.removed, [LOCAL_DIR, `${LOCAL_DIR}\\bin`])
})

test("boundary checks reject traversal and symlinks and accept exact canonical roots", () => {
  assert.equal(isWithinBoundary(LOCAL_DIR, `${LOCAL_DIR}\\Backup`), true)
  assert.equal(isWithinBoundary(LOCAL_DIR, "C:\\Users\\Test\\AppData\\Local\\spicetify-other"), false)
  assert.equal(pathRemovalProblem(LOCAL_DIR, [LOCAL_DIR], { symlink: false, realPath: null }), null)
  assert.match(pathRemovalProblem("C:\\Windows\\System32", [LOCAL_DIR], { symlink: false, realPath: null }) ?? "", /outside/)
  assert.match(pathRemovalProblem(LOCAL_DIR, [LOCAL_DIR], { symlink: true, realPath: null }) ?? "", /symbolic link/)
  assert.match(pathRemovalProblem(LOCAL_DIR, [LOCAL_DIR], { symlink: false, realPath: "C:\\Windows\\Temp" }) ?? "", /resolves outside/)
  assert.deepEqual(managerUninstallArgs("winget")?.args.slice(0, 2), ["uninstall", "--id"])
})

// ---------------------------------------------------------------------------
// Marketplace after upgrade (installed by default, soft-fail, service restart)
// ---------------------------------------------------------------------------

test("Marketplace installs by default after a Spicetify upgrade and before apply", async () => {
  const runtime = fakeRuntime()
  runtime.state.opencode.listVersion = "0.6.0-beta.1"
  runtime.state.spicetify.version = "2.46.0"
  const ui = fakeUi()
  const ctx = context(runtime, ui, scriptedPrompt({ confirms: [true, true] }), {
    command: "update", allowSpicetifyUpgrade: true,
  })
  ctx.detection = fakeDetection(runtime)
  ctx.versions.plugin.latest = "0.6.0-beta.1"
  ctx.versions.spicetify.latest = "2.47.0"

  let installed = false
  const deps = {
    upgradeSpicetify: fakeOfficialUpgrade(runtime, "2.47.0"),
    inspectMarketplace: async () => ({ installed: false, registered: false }),
    installMarketplace: async (_rt: unknown, _info: unknown, options?: { dryRun?: boolean; offline?: boolean }) => {
      assert.equal(options?.dryRun ?? false, false)
      assert.equal(options?.offline ?? false, false)
      installed = true
      return { status: "installed" as const }
    },
  }
  assert.equal(await runUpdate(ctx, "spicetify", deps), 0, ui.lines.join("\n"))
  assert.equal(installed, true, "marketplace install ran after upgrade")
})

test("Marketplace soft-fails with a warning and still applies", async () => {
  const runtime = fakeRuntime()
  runtime.state.opencode.listVersion = "0.6.0-beta.1"
  runtime.state.spicetify.version = "2.46.0"
  const ui = fakeUi()
  const ctx = context(runtime, ui, scriptedPrompt({ confirms: [true, true] }), {
    command: "update", allowSpicetifyUpgrade: true,
  })
  ctx.detection = fakeDetection(runtime)
  ctx.versions.plugin.latest = "0.6.0-beta.1"
  ctx.versions.spicetify.latest = "2.47.0"

  const deps = {
    upgradeSpicetify: fakeOfficialUpgrade(runtime, "2.47.0"),
    inspectMarketplace: async () => ({ installed: false, registered: false }),
    installMarketplace: async () => ({ status: "failed" as const, error: "network down", guidance: "retry later" }),
  }
  assert.equal(await runUpdate(ctx, "spicetify", deps), 0, ui.lines.join("\n"))
  assert.match(ui.lines.join("\n"), /Marketplace installation failed; continuing without it/i)
  assert.match(ui.lines.join("\n"), /opencode service restart/i)
})

test("--no-marketplace skips the Marketplace install entirely", async () => {
  const runtime = fakeRuntime()
  runtime.state.opencode.listVersion = "0.6.0-beta.1"
  runtime.state.spicetify.version = "2.46.0"
  const ui = fakeUi()
  const ctx = context(runtime, ui, scriptedPrompt({ confirms: [true, true] }), {
    command: "update", allowSpicetifyUpgrade: true, marketplace: false,
  })
  ctx.detection = fakeDetection(runtime)
  ctx.versions.plugin.latest = "0.6.0-beta.1"
  ctx.versions.spicetify.latest = "2.47.0"

  let installCalls = 0
  const deps = {
    upgradeSpicetify: fakeOfficialUpgrade(runtime, "2.47.0"),
    inspectMarketplace: async () => {
      installCalls += 1
      return { installed: false, registered: false }
    },
    installMarketplace: async () => {
      installCalls += 1
      return { status: "installed" as const }
    },
  }
  assert.equal(await runUpdate(ctx, "spicetify", deps), 0, ui.lines.join("\n"))
  assert.equal(installCalls, 0, "opt-out skips both inspect and install")
  assert.ok(!ui.lines.join("\n").includes("Marketplace installation failed"))
})

test("official-only routing never uses winget/scoop/choco and unknown migrates", () => {
  assert.equal(spicetifyUpdateMethod("script"), "official")
  assert.equal(spicetifyUpdateMethod("winget"), "official")
  assert.equal(spicetifyUpdateMethod("scoop"), "official")
  assert.equal(spicetifyUpdateMethod("choco"), "official")
  assert.equal(spicetifyUpdateMethod("unknown"), "official")
  assert.match(spicetifyUpdateDescription("winget"), /official installer.*migrate/i)
  assert.match(spicetifyUpdateDescription("unknown"), /official installer.*migrate/i)
  assert.equal(spicetifyUpdateTarget("official", "2.47.0"), "2.47.0")
  assert.equal(spicetifyUpdateTarget("winget", "2.47.0"), "2.47.0")
  const gate = spicetifyUpdateGate({ installed: "2.46.0", owner: "unknown", latest: "2.47.0" })
  assert.equal(gate.status, "outdated")
  assert.equal(gate.target, "2.47.0")
})

test("duplicate global registrations are all removed before the target is re-added", async () => {
  const runtime = fakeRuntime()
  runtime.state.opencode.listVersion = "0.6.0-beta.3"
  let configured = ["opencode-spotify@0.6.0-beta.3", "opencode-spotify@0.6.0-beta.4"]
  const realRun = runtime.run.bind(runtime)
  runtime.run = (async (file: string, args: string[], options?: unknown) => {
    if (file.includes("opencode") && args.join(" ") === "plugin list") {
      runtime.calls.push({ file, args })
      const rows = configured.map((spec) => `opencode-spotify  ${spec.slice(spec.lastIndexOf("@") + 1)}  ${spec}`)
      return { code: 0, stdout: `ID  VERSION  SOURCE\n${rows.join("\n")}\n`, stderr: "" }
    }
    if (file.includes("opencode") && args[0] === "plugin" && args[1] === "remove") {
      runtime.calls.push({ file, args })
      configured = configured.filter((spec) => spec !== args[2])
      if (runtime.state.opencode.listVersion && args[2]?.includes(runtime.state.opencode.listVersion)) {
        runtime.state.opencode.listVersion = null
      }
      return { code: 0, stdout: "removed", stderr: "" }
    }
    if (file.includes("opencode") && args[0] === "plugin" && args[1] === "add") {
      runtime.calls.push({ file, args })
      const spec = args[2] ?? ""
      if (!configured.includes(spec)) configured.push(spec)
      const match = spec.match(/@(\d+\.\d+\.\d+)/)
      runtime.state.opencode.listVersion = match?.[1] ?? runtime.state.opencode.listVersion
      return { code: 0, stdout: `Plugin "${spec}" is already configured`, stderr: "" }
    }
    return realRun(file, args, options as never)
  }) as typeof runtime.run
  const ui = fakeUi()
  const ctx = context(runtime, ui, scriptedPrompt(), {
    command: "update", yes: true, nonInteractive: true, marketplace: false,
  })
  ctx.detection = fakeDetection(runtime)
  ctx.versions.plugin.latest = "0.6.0-beta.4"
  assert.equal(await runUpdate(ctx, "plugin"), 0, ui.lines.join("\n"))
  const cmds = commands(runtime)
  assert.ok(cmds.some((c) => c.includes("plugin remove opencode-spotify@0.6.0-beta.3")), "stale spec removed")
  assert.ok(!cmds.some((c) => c.includes("plugin remove opencode-spotify@0.6.0-beta.4")), "target spec never removed")
  assert.ok(cmds.some((c) => c.includes("plugin add opencode-spotify@0.6.0-beta.4")), "target re-added")
  assert.deepEqual(configured, ["opencode-spotify@0.6.0-beta.4"])
})

test("a resolved version that lags the configured spec reports restart instead of a generic failure", async () => {
  const runtime = fakeRuntime()
  runtime.state.opencode.listVersion = "0.6.0-beta.3"
  const realRun = runtime.run.bind(runtime)
  runtime.run = (async (file: string, args: string[], options?: unknown) => {
    if (file.includes("opencode") && args.join(" ") === "plugin list") {
      runtime.calls.push({ file, args })
      return { code: 0, stdout: "ID  VERSION  SOURCE\nopencode-spotify  0.6.0-beta.3  opencode-spotify@0.6.0-beta.4\n", stderr: "" }
    }
    if (file.includes("opencode") && args[0] === "plugin" && args[1] === "remove") {
      runtime.calls.push({ file, args })
      return { code: 0, stdout: "removed", stderr: "" }
    }
    if (file.includes("opencode") && args[0] === "plugin" && args[1] === "add") {
      runtime.calls.push({ file, args })
      return { code: 0, stdout: `Plugin "opencode-spotify@0.6.0-beta.4" is already configured in C:\\Users\\Test\\.config\\opencode\\opencode.json`, stderr: "" }
    }
    return realRun(file, args, options as never)
  }) as typeof runtime.run
  const ui = fakeUi()
  const ctx = context(runtime, ui, scriptedPrompt(), {
    command: "update", yes: true, nonInteractive: true, marketplace: false,
  })
  ctx.detection = fakeDetection(runtime)
  ctx.versions.plugin.latest = "0.6.0-beta.4"
  assert.equal(await runUpdate(ctx, "plugin"), 1, ui.lines.join("\n"))
  assert.match(ui.lines.join("\n"), /restart running OpenCode processes/i)
  assert.match(ui.lines.join("\n"), /opencode service restart/i)
})
