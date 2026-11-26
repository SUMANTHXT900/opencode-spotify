import { test } from "node:test"
import assert from "node:assert/strict"
import {
  ensureSpicetify,
  resolvedSpicetifyTarget,
  runSetup,
  SPICETIFY_INSTALL_REVISION,
  spicetifyOfficialPin,
  stableVersion,
  EXISTING_INSTALL_PROMPT_WARNING,
  type EnsureSpicetifyDeps,
} from "../src/cli/setup.ts"
import { OFFICIAL_INSTALLER_BYTES, OFFICIAL_INSTALLER_SHA256 } from "../src/cli/compat.ts"
import type { OfficialInstallerApproval, OfficialInstallerOptions } from "../src/cli/spicetify-official.ts"
import type { SpicetifyRelease } from "../src/cli/spicetify-release.ts"
import { createCancelToken, type CancelToken } from "../src/cli/cancel.ts"
import { buildApprovalRequest } from "../src/cli/ui/install-wizard.ts"
import type { CommandResult, Detection } from "../src/cli/types.ts"
import { context, fakeDetection, fakePrompt, fakeReport, fakeRuntime, fakeUi } from "./cli-fixture.ts"
import type { FakeRuntime } from "./cli-fixture.ts"

// Dynamic target used by every test. It is deliberately NOT the retired
// hardcoded 2.46.7 target: setup must print whatever the release lookup found.
const TEST_LATEST = "2.49.3"
const RETIRED_TARGET = "2.46.7"

const DEFAULT_PREFLIGHT = [
  "PSVERSION=7.4.2",
  "LANGUAGEMODE=FullLanguage",
  "ELEVATED=False",
  "DRIVE=C:",
  "FREEMB=20480",
].join("\n")

function missingDetection(runtime: FakeRuntime): Detection {
  return fakeDetection(runtime, {
    spicetify: {
      available: false,
      path: null,
      version: null,
      owner: "unknown",
      configPath: null,
      extensionsDir: null,
      bridgeRegistered: false,
    },
  })
}

function officialRuntime(options: { available?: boolean; preflight?: string } = {}): FakeRuntime {
  const runtime = fakeRuntime()
  runtime.state.spicetify.available = options.available ?? false
  const baseRun = runtime.run.bind(runtime)
  runtime.run = async (file, args, execOptions) => {
    if (file.toLowerCase().includes("pwsh") && args.join(" ").includes("PSVERSION=")) {
      return { code: 0, stdout: options.preflight ?? DEFAULT_PREFLIGHT, stderr: "" }
    }
    return baseRun(file, args, execOptions)
  }
  return runtime
}

function wizardUi() {
  const ui = fakeUi()
  const hooks: string[] = []
  ui.suspend = async () => { hooks.push("suspend") }
  ui.resume = async () => { hooks.push("resume") }
  return { ui, hooks }
}

interface Capture {
  options?: OfficialInstallerOptions & { cancel?: CancelToken }
}

/** Injected installer adapter: no network, no child process, no verify pin. */
function fakeInstaller(
  runtime: FakeRuntime,
  captures: Capture[],
  outcome: {
    code?: number
    stdout?: string
    error?: string
    installedVersion?: string | null
    beforeReturn?: () => void
  } = {},
): EnsureSpicetifyDeps {
  return {
    installOfficial: async (_runtime, _info, options) => {
      captures.push({ options })
      outcome.beforeReturn?.()
      if (outcome.installedVersion !== undefined) {
        runtime.state.spicetify.available = true
        if (outcome.installedVersion !== null) runtime.state.spicetify.version = outcome.installedVersion
      }
      const result: CommandResult = {
        code: outcome.code ?? 0,
        stdout: outcome.stdout ?? "",
        stderr: "",
        ...(outcome.error ? { error: outcome.error } : {}),
      }
      return result
    },
  }
}

function setupContext(
  runtime: FakeRuntime,
  options: {
    spicetify?: "ask" | "auto" | "manual" | "skip"
    dryRun?: boolean
    nonInteractive?: boolean
    yes?: boolean
    verbose?: boolean
    confirms?: boolean[]
    choices?: Array<string | undefined>
    latest?: string | null
  } = {},
  cancel?: CancelToken,
  report = fakeReport(),
) {
  const { ui, hooks } = wizardUi()
  const prompt = fakePrompt({ confirms: options.confirms ?? [true], choices: options.choices })
  const ctx = context(
    runtime,
    ui,
    prompt,
    {
      command: "setup",
      spicetify: options.spicetify ?? "auto",
      dryRun: options.dryRun ?? false,
      nonInteractive: options.nonInteractive ?? false,
      yes: options.yes ?? false,
      verbose: options.verbose ?? false,
    },
    { spicetify: { latest: options.latest === undefined ? TEST_LATEST : options.latest } },
    report,
    cancel ?? createCancelToken(),
  )
  ctx.detection = missingDetection(runtime)
  return { ctx, ui, prompt, hooks, report }
}

test("official install succeeds through the wizard with a single approval and no fabricated percentages", async () => {
  const runtime = officialRuntime()
  const { ctx, ui, prompt, hooks, report } = setupContext(runtime, { verbose: true })
  const captures: Capture[] = []
  const deps = fakeInstaller(runtime, captures, { installedVersion: TEST_LATEST, stdout: "installed" })
  assert.equal(await ensureSpicetify(ctx, deps), "ready", ui.lines.join("\n"))
  const text = ui.lines.join("\n")

  assert.match(text, new RegExp(SPICETIFY_INSTALL_REVISION))
  assert.match(text, new RegExp(OFFICIAL_INSTALLER_SHA256))
  assert.match(text, new RegExp(TEST_LATEST.replace(/\./g, "\\.")))
  assert.match(text, /Marketplace/i)
  assert.match(text, /removed from the staged script/i)
  assert.match(text, /execution policy/i)
  assert.match(text, /PATH/)
  assert.ok(!text.includes(RETIRED_TARGET), `retired hardcoded target leaked:\n${text}`)
  assert.doesNotMatch(text, /\b\d{1,3}\s*%/, `fabricated percentage leaked:\n${text}`)

  // Exactly one consent: the wizard approval. The installer adapter is
  // pre-approved and never asks again.
  assert.equal(prompt.asked.filter((line) => /Run the pinned official installer/i.test(line)).length, 1)
  assert.equal(captures.length, 1)
  const options = captures[0]!.options!
  assert.equal(options.cancel, ctx.cancel)
  assert.equal(options.release, undefined)
  assert.equal(await options.approve!({} as OfficialInstallerApproval), true)

  const progress = report.events.filter((event) => event.type === "progress")
  assert.ok(progress.length > 0, "indeterminate progress lines expected")
  for (const event of progress) {
    if (event.type === "progress") assert.equal(event.percent, undefined, "percentages are never fabricated")
  }
  assert.ok(!runtime.calls.some((call) => call.file.toLowerCase().includes("winget")), "no winget manager call")
  assert.equal(ctx.detection.spicetify.available, true)
})

test("noninteractive official install requires confirmation and runSetup exits 2", async () => {
  const runtime = officialRuntime()
  const { ctx, ui } = setupContext(runtime, { spicetify: "auto", nonInteractive: true, yes: true })
  const deps = fakeInstaller(runtime, [], { error: "must not run" })
  assert.equal(await ensureSpicetify(ctx, deps), "confirmation-required")
  assert.match(ui.lines.join("\n"), /Explicit approval is required/i)
  assert.equal(runtime.state.spicetify.available, false)

  const setupRuntime = officialRuntime()
  const setup = setupContext(setupRuntime, { spicetify: "auto", nonInteractive: true, yes: true })
  assert.equal(await runSetup(setup.ctx, fakeInstaller(setupRuntime, [], { error: "must not run" })), 2)
  assert.equal(setupRuntime.state.spicetify.available, false)
})

test("an installer failure is reported honestly with manual fallback, without success", async () => {
  const runtime = officialRuntime()
  const { ctx, ui, hooks } = setupContext(runtime)
  const captures: Capture[] = []
  const deps = fakeInstaller(runtime, captures, {
    code: 1,
    error: "E_PIN_MISMATCH: installer script SHA-256 does not match the pinned digest",
  })
  assert.equal(await ensureSpicetify(ctx, deps), "failed")
  const text = ui.lines.join("\n")
  assert.match(text, /E_PIN_MISMATCH|does not match the pinned/i)
  assert.match(text, /Install Spicetify manually/i)
  assert.match(text, /mutable main-branch installer is never executed/i)
  assert.deepEqual(hooks, [])
  assert.equal(runtime.state.spicetify.available, false)
})

test("declining the single approval installs nothing", async () => {
  const runtime = officialRuntime()
  const { ctx, ui, hooks } = setupContext(runtime, { confirms: [false] })
  const captures: Capture[] = []
  const deps = fakeInstaller(runtime, captures, { installedVersion: TEST_LATEST })
  assert.equal(await ensureSpicetify(ctx, deps), "declined")
  assert.match(ui.lines.join("\n"), /Approval was not given|Canceled/i)
  assert.equal(captures.length, 0)
  assert.deepEqual(hooks, [])
  assert.equal(runtime.state.spicetify.available, false)
})

test("installer failure or timeout never claims success", async () => {
  const runtime = officialRuntime()
  const { ctx, ui } = setupContext(runtime)
  const deps = fakeInstaller(runtime, [], { code: 1, error: "The official installer timed out; state is uncertain" })
  assert.equal(await ensureSpicetify(ctx, deps), "failed")
  assert.match(ui.lines.join("\n"), /timed out/i)
  assert.equal(runtime.state.spicetify.available, false)
})

test("manual mode shows the resolved dynamic target and release asset", async () => {
  const runtime = officialRuntime()
  const { ctx, ui, prompt } = setupContext(runtime, { spicetify: "manual", choices: ["recheck"] })
  const baseChoose = prompt.choose.bind(prompt)
  prompt.choose = async (question, choices, defaultIndex) => {
    runtime.state.spicetify.available = true
    runtime.state.spicetify.version = TEST_LATEST
    return baseChoose(question, choices, defaultIndex)
  }
  assert.equal(await ensureSpicetify(ctx), "ready")
  const text = ui.lines.join("\n")
  assert.match(text, /spicetify\.app/)
  assert.match(text, new RegExp(`v?${TEST_LATEST.replace(/\./g, "\\.")}`))
  assert.match(text, /revision f4a824f/i)
  assert.match(text, new RegExp(`spicetify-${TEST_LATEST.replace(/\./g, "\\.")}-windows-(x64|arm64|x32)\\.zip`))
  assert.match(text, /install\.ps1/)
  assert.match(text, /Recheck now|Re-run setup/i)
  assert.ok(!text.includes(RETIRED_TARGET), `retired hardcoded target leaked:\n${text}`)
})

test("manual mode with unknown metadata points at the releases page and invents no version", async () => {
  const runtime = officialRuntime()
  const { ctx, ui, prompt } = setupContext(runtime, { spicetify: "manual", nonInteractive: true, latest: null })
  assert.equal(await ensureSpicetify(ctx), "failed")
  const text = ui.lines.join("\n")
  assert.match(text, /https:\/\/github\.com\/spicetify\/cli\/releases/)
  assert.doesNotMatch(text, /Target version: v\d/)
  assert.ok(!text.includes(RETIRED_TARGET), `retired hardcoded target leaked:\n${text}`)
  assert.deepEqual(prompt.asked, [])
})

test("manual mode prefers an explicitly resolved release object and forwards it to the installer", async () => {
  const runtime = officialRuntime()
  const { ctx, ui } = setupContext(runtime, { spicetify: "manual", nonInteractive: true })
  const digest = `sha256:${"b".repeat(64)}`
  const assetName = `spicetify-${TEST_LATEST}-windows-x64.zip`
  const assetUrl = `https://github.com/spicetify/cli/releases/download/v${TEST_LATEST}/${assetName}`
  const release: SpicetifyRelease = {
    version: TEST_LATEST,
    tag: `v${TEST_LATEST}`,
    releaseId: 1,
    publishedAt: null,
    assets: [{ name: assetName, size: 1_000, digest, url: assetUrl }],
    source: "github",
    fetchedAt: 0,
  }
  assert.equal(await ensureSpicetify(ctx, {}, release), "failed")
  const text = ui.lines.join("\n")
  assert.match(text, new RegExp(assetName.replace(/\./g, "\\.")))
  assert.match(text, new RegExp(assetUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
  assert.ok(text.includes(digest), `resolved digest shown:\n${text}`)
})

test("a resolved release is forwarded to the installer and drives the target", async () => {
  const runtime = officialRuntime()
  const { ctx, ui } = setupContext(runtime, { spicetify: "auto" })
  const assetName = `spicetify-${TEST_LATEST}-windows-x64.zip`
  const release: SpicetifyRelease = {
    version: TEST_LATEST,
    tag: `v${TEST_LATEST}`,
    releaseId: 7,
    publishedAt: null,
    assets: [{
      name: assetName,
      size: 1_000,
      digest: `sha256:${"c".repeat(64)}`,
      url: `https://github.com/spicetify/cli/releases/download/v${TEST_LATEST}/${assetName}`,
    }],
    source: "github",
    fetchedAt: 0,
  }
  const captures: Capture[] = []
  const deps = fakeInstaller(runtime, captures, { installedVersion: TEST_LATEST })
  assert.equal(await ensureSpicetify(ctx, deps, release), "ready", ui.lines.join("\n"))
  assert.equal(captures.length, 1)
  assert.equal(captures[0]!.options!.release, release)
  assert.match(ui.lines.join("\n"), new RegExp(TEST_LATEST.replace(/\./g, "\\.")))
})

test("a successful install warns when the installed version differs from the approved target", async () => {
  const runtime = officialRuntime()
  const { ctx, ui } = setupContext(runtime)
  const deps = fakeInstaller(runtime, [], { installedVersion: "2.50.0" })
  assert.equal(await ensureSpicetify(ctx, deps), "ready")
  assert.match(ui.lines.join("\n"), /differs from the approved target 2\.49\.3/i)
})

test("an already available Spicetify is reused without any install work", async () => {
  const runtime = fakeRuntime()
  const { ctx, ui, prompt } = setupContext(runtime, { spicetify: "auto" })
  ctx.detection = fakeDetection(runtime)
  const captures: Capture[] = []
  assert.equal(await ensureSpicetify(ctx, fakeInstaller(runtime, captures)), "ready")
  assert.deepEqual(runtime.calls, [])
  assert.deepEqual(ui.lines, [])
  assert.deepEqual(prompt.asked, [])
  assert.equal(captures.length, 0)
})

test("dry-run prints the official plan without adapter, preflight, or mutation", async () => {
  const runtime = officialRuntime()
  const { ctx, ui } = setupContext(runtime, { spicetify: "auto", dryRun: true })
  const captures: Capture[] = []
  const deps = fakeInstaller(runtime, captures, { error: "dry-run must not execute" })
  assert.equal(await ensureSpicetify(ctx, deps), "declined")
  const text = ui.lines.join("\n")
  assert.match(text, /dry-run/i)
  assert.match(text, /No files, PATH entries, or Spotify state were changed/i)
  assert.equal(captures.length, 0)
  assert.deepEqual(runtime.calls, [])
})

test("preflight refuses elevated, constrained, and too-old PowerShell before approval", async () => {
  const cases = [
    { label: "elevated", preflight: DEFAULT_PREFLIGHT.replace("ELEVATED=False", "ELEVATED=True"), pattern: /administrator/i },
    {
      label: "constrained",
      preflight: DEFAULT_PREFLIGHT.replace("LANGUAGEMODE=FullLanguage", "LANGUAGEMODE=ConstrainedLanguage"),
      pattern: /ConstrainedLanguage/,
    },
    { label: "old", preflight: DEFAULT_PREFLIGHT.replace("PSVERSION=7.4.2", "PSVERSION=5.0.0"), pattern: /older than 5\.1/i },
  ]
  for (const entry of cases) {
    const runtime = officialRuntime({ preflight: entry.preflight })
    const { ctx, ui, prompt } = setupContext(runtime)
    const captures: Capture[] = []
    const deps = fakeInstaller(runtime, captures, { error: "preflight failure must not execute" })
    assert.equal(await ensureSpicetify(ctx, deps), "failed", entry.label)
    assert.match(ui.lines.join("\n"), entry.pattern, entry.label)
    assert.equal(captures.length, 0, entry.label)
    assert.equal(prompt.asked.some((line) => /Run the pinned official installer/i.test(line)), false, entry.label)
  }
})

test("noninteractive ask and skip fail closed without installing", async () => {
  const askRuntime = officialRuntime()
  const ask = setupContext(askRuntime, { spicetify: "ask", nonInteractive: true })
  assert.equal(await ensureSpicetify(ask.ctx, fakeInstaller(askRuntime, [])), "failed")
  const askText = ask.ui.lines.join("\n")
  assert.match(askText, /--spicetify=auto/)
  assert.match(askText, /--spicetify=manual/)
  assert.match(askText, /--spicetify=skip/)
  assert.deepEqual(askRuntime.calls, [])

  const skipRuntime = officialRuntime()
  const skip = setupContext(skipRuntime, { spicetify: "skip", nonInteractive: true })
  assert.equal(await ensureSpicetify(skip.ctx, fakeInstaller(skipRuntime, [])), "declined")
  assert.deepEqual(skipRuntime.calls, [])
})

test("interactive ask uses the wizard and routes manual without installing", async () => {
  const runtime = officialRuntime()
  const { ctx, ui, prompt } = setupContext(runtime, { spicetify: "ask", choices: ["manual", "recheck"] })
  const baseChoose = prompt.choose.bind(prompt)
  prompt.choose = async (question, choices, defaultIndex) => {
    if (/Still waiting for Spicetify/i.test(question)) {
      runtime.state.spicetify.available = true
      runtime.state.spicetify.version = TEST_LATEST
    }
    return baseChoose(question, choices, defaultIndex)
  }
  const captures: Capture[] = []
  assert.equal(await ensureSpicetify(ctx, fakeInstaller(runtime, captures)), "ready")
  const text = ui.lines.join("\n")
  assert.match(text, /How do you want to install Spicetify|Spicetify installation/i)
  assert.match(text, /spicetify\.app/)
  assert.equal(captures.length, 0)
})

test("interactive ask selection can cancel without installing", async () => {
  const runtime = officialRuntime()
  const { ctx, ui, prompt } = setupContext(runtime, { spicetify: "ask", choices: ["cancel"] })
  const captures: Capture[] = []
  assert.equal(await ensureSpicetify(ctx, fakeInstaller(runtime, captures)), "declined")
  assert.match(ui.lines.join("\n"), /without installing Spicetify or changing anything/i)
  assert.equal(captures.length, 0)
  assert.deepEqual(prompt.asked, ["How do you want to install Spicetify?"])
})

test("cancellation returns cancelled and runSetup exits 130 without starting anything", async () => {
  const runtime = officialRuntime()
  const token = createCancelToken()
  token.request("sigint")
  const { ctx, ui } = setupContext(runtime, {}, token)
  const captures: Capture[] = []
  assert.equal(await ensureSpicetify(ctx, fakeInstaller(runtime, captures)), "cancelled")
  assert.equal(captures.length, 0)
  assert.equal(await runSetup(ctx), 130)
  assert.ok(!ui.lines.join("\n").includes("Spicetify is required"), "nothing was announced after cancellation")
})

test("cancellation during the installer maps to cancelled in ensureSpicetify and 130 in runSetup", async () => {
  const runtime = officialRuntime()
  runtime.state.opencode.listVersion = null
  const token = createCancelToken()
  const { ctx } = setupContext(runtime, {}, token)
  const deps = fakeInstaller(runtime, [], { code: 130, error: "Cancelled by the user.", beforeReturn: () => token.request("user") })
  assert.equal(await ensureSpicetify(ctx, deps), "cancelled")

  const setupRuntime = officialRuntime()
  setupRuntime.state.opencode.listVersion = null
  const setupToken = createCancelToken()
  const setup = setupContext(setupRuntime, {}, setupToken)
  const cancelDeps = fakeInstaller(setupRuntime, [], { code: 130, error: "Cancelled by the user.", beforeReturn: () => setupToken.request("user") })
  assert.equal(await runSetup(setup.ctx, cancelDeps), 130)
})

test("a real installer failure is not masked by a concurrent cancellation request", async () => {
  const runtime = officialRuntime()
  const token = createCancelToken()
  const { ctx, ui } = setupContext(runtime, {}, token)
  const deps = fakeInstaller(runtime, [], {
    code: 1,
    error: "E_INSTALL_FAILED: the installer failed",
    beforeReturn: () => token.request("sigint"),
  })
  assert.equal(await ensureSpicetify(ctx, deps), "failed", ui.lines.join("\n"))
  assert.match(ui.lines.join("\n"), /E_INSTALL_FAILED|installer failed/i)

  const setupRuntime = officialRuntime()
  setupRuntime.state.opencode.listVersion = null
  const setupToken = createCancelToken()
  const setup = setupContext(setupRuntime, {}, setupToken)
  const setupDeps = fakeInstaller(setupRuntime, [], {
    code: 1,
    error: "E_INSTALL_FAILED: the installer failed",
    beforeReturn: () => setupToken.request("sigint"),
  })
  assert.equal(await runSetup(setup.ctx, setupDeps), 1)
})

test("confirmation-required is never turned into 130 by a concurrent cancellation", async () => {
  const runtime = officialRuntime()
  const token = createCancelToken()
  const { ctx, ui } = setupContext(runtime, { nonInteractive: true, yes: true }, token)
  const section = ui.section.bind(ui)
  ui.section = (title: string) => {
    section(title)
    if (/Official Spicetify installer \(pinned\)/i.test(title)) token.request("sigint")
  }
  const deps = fakeInstaller(runtime, [], { error: "must not run" })
  assert.equal(await ensureSpicetify(ctx, deps), "confirmation-required", ui.lines.join("\n"))
  assert.ok(token.requested)

  const setupRuntime = officialRuntime()
  setupRuntime.state.opencode.listVersion = null
  const setupToken = createCancelToken()
  const setup = setupContext(setupRuntime, { nonInteractive: true, yes: true }, setupToken)
  const setupSection = setup.ui.section.bind(setup.ui)
  setup.ui.section = (title: string) => {
    setupSection(title)
    if (/Official Spicetify installer \(pinned\)/i.test(title)) setupToken.request("sigint")
  }
  assert.equal(await runSetup(setup.ctx, fakeInstaller(setupRuntime, [], { error: "must not run" })), 2)
})

// ---------------------------------------------------------------------------
// Maintenance menu (B32)
// ---------------------------------------------------------------------------

interface MenuCapture {
  labels: string[][]
  questions: string[]
}

function menuContext(
  runtime: FakeRuntime,
  choice: string | undefined,
  options: {
    pluginInstalled?: string | null
    pluginLatest?: string | null
    spicetifyInstalled?: string
    spicetifyLatest?: string | null
    local?: boolean
    spicetifyAvailable?: boolean
    yes?: boolean
    confirms?: boolean[]
  } = {},
) {
  const ui = fakeUi()
  const prompt = fakePrompt({ confirms: options.confirms ?? [true] })
  const capture: MenuCapture = { labels: [], questions: [] }
  prompt.choose = async (question, choices) => {
    capture.questions.push(question)
    capture.labels.push(choices.map((entry) => entry.label))
    return choice
  }
  if (options.spicetifyAvailable !== undefined) runtime.state.spicetify.available = options.spicetifyAvailable
  runtime.state.spicetify.version = options.spicetifyInstalled ?? runtime.state.spicetify.version
  runtime.state.opencode.local = options.local ?? false
  runtime.state.opencode.listVersion = options.pluginInstalled === undefined
    ? runtime.state.opencode.listVersion
    : options.pluginInstalled
  const ctx = context(
    runtime,
    ui,
    prompt,
    { command: "setup", yes: options.yes ?? false },
    {
      plugin: { installed: options.pluginInstalled ?? null, latest: options.pluginLatest === undefined ? null : options.pluginLatest },
      spicetify: { latest: options.spicetifyLatest === undefined ? null : options.spicetifyLatest },
    },
  )
  ctx.detection = fakeDetection(runtime)
  return { ctx, ui, prompt, capture }
}

function offered(capture: MenuCapture): string[] {
  return capture.labels[0] ?? []
}

test("maintenance offers repair and uninstall and hides inapplicable updates when everything is current", async () => {
  const runtime = fakeRuntime()
  const { ctx, ui, capture } = menuContext(runtime, "exit", {
    pluginInstalled: "0.6.0",
    pluginLatest: "0.6.0",
    spicetifyInstalled: "2.46.7",
    spicetifyLatest: "2.46.7",
  })
  assert.equal(await runSetup(ctx), 0, ui.lines.join("\n"))
  const labels = offered(capture)
  assert.ok(labels.includes("Repair installation"), labels.join("\n"))
  assert.ok(labels.includes("Uninstall"), labels.join("\n"))
  assert.ok(!labels.some((label) => /^Update /.test(label)), `no inapplicable updates:\n${labels.join("\n")}`)
  assert.match(ui.lines.join("\n"), /Everything detected is current/i)
  assert.ok(!ui.lines.join("\n").includes("unknown (current)"), "never renders unknown (current)")
})

test("maintenance offers a single update entry and hides per-target clutter", async () => {
  const runtime = fakeRuntime()
  const { ctx, capture } = menuContext(runtime, "exit", {
    pluginInstalled: "0.6.0",
    pluginLatest: "0.6.1",
    spicetifyInstalled: "2.46.7",
    spicetifyLatest: "2.46.7",
  })
  assert.equal(await runSetup(ctx), 0)
  const labels = offered(capture)
  assert.ok(labels.some((label) => label.startsWith("Update to latest")), labels.join("\n"))
  assert.ok(!labels.includes("Update both OpenCode Spotify and Spicetify"), labels.join("\n"))
  assert.ok(!labels.includes("Update OpenCode Spotify only"), labels.join("\n"))
  assert.ok(!labels.includes("Update Spicetify only"), labels.join("\n"))
  assert.ok(labels.includes("Repair installation"))
  assert.ok(labels.includes("Uninstall"))
})

test("maintenance offers the single update entry for Spicetify-only updates", async () => {
  const runtime = fakeRuntime()
  const { ctx, capture } = menuContext(runtime, "exit", {
    pluginInstalled: "0.6.0",
    pluginLatest: "0.6.0",
    spicetifyInstalled: "2.46.7",
    spicetifyLatest: "2.47.0",
  })
  assert.equal(await runSetup(ctx), 0)
  const labels = offered(capture)
  assert.ok(labels.some((label) => label.startsWith("Update to latest")), labels.join("\n"))
  assert.ok(!labels.includes("Update both OpenCode Spotify and Spicetify"), labels.join("\n"))
  assert.ok(!labels.includes("Update OpenCode Spotify only"), labels.join("\n"))
  assert.ok(!labels.includes("Update Spicetify only"), labels.join("\n"))
})

test("maintenance hides Spicetify updates when latest is a prerelease or unknown", async () => {
  for (const latest of ["2.47.0-beta.2", null]) {
    const runtime = fakeRuntime()
    const { ctx, ui, capture } = menuContext(runtime, "exit", {
      pluginInstalled: "0.6.0",
      pluginLatest: "0.6.0",
      spicetifyInstalled: "2.46.7",
      spicetifyLatest: latest,
    })
    assert.equal(await runSetup(ctx), 0)
    const labels = offered(capture)
    assert.ok(!labels.some((label) => label.startsWith("Update to latest")), `${latest}: ${labels.join("\n")}`)
    assert.ok(!labels.includes("Update both OpenCode Spotify and Spicetify"), `${latest}: ${labels.join("\n")}`)
    assert.ok(labels.includes("Repair installation"))
    assert.ok(labels.includes("Uninstall"))
    const text = ui.lines.join("\n")
    assert.ok(!text.includes("unknown (current)"), text)
    assert.match(text, /latest unknown/i)
  }
})

test("maintenance offers repair and uninstall for a local registration too", async () => {
  const runtime = fakeRuntime()
  runtime.state.opencode.listVersion = "local"
  const { ctx, capture } = menuContext(runtime, "exit", {
    pluginInstalled: "local",
    pluginLatest: "0.6.1",
    local: true,
  })
  assert.equal(await runSetup(ctx), 0)
  const labels = offered(capture)
  assert.ok(labels.includes("Switch this global registration to the published package"), labels.join("\n"))
  assert.ok(labels.includes("Repair installation"), labels.join("\n"))
  assert.ok(labels.includes("Uninstall"), labels.join("\n"))
})

test("maintenance uninstall runs in-process with the same context (no second lock)", async () => {
  const runtime = fakeRuntime()
  const { ctx, ui } = menuContext(runtime, "uninstall", {
    pluginInstalled: "0.6.0",
    pluginLatest: "0.6.0",
    yes: true,
    confirms: [true],
  })
  assert.equal(await runSetup(ctx), 0, ui.lines.join("\n"))
  const commands = runtime.calls.map((call) => `${call.file} ${call.args.join(" ")}`)
  assert.ok(commands.some((command) => command.includes("plugin remove")), commands.join("\n"))
})

test("maintenance update uses the menu choice as the single consent", async () => {
  const runtime = fakeRuntime()
  const { ctx, prompt, capture } = menuContext(runtime, "update", {
    pluginInstalled: "0.6.0",
    pluginLatest: "0.6.1",
  })
  // No extra plan confirmation is queued; the choice itself approves the update.
  const code = await runSetup(ctx)
  assert.ok(code === 0 || code === 1, `update ran (got ${code})`)
  assert.equal(capture.questions.length, 1)
  assert.match(capture.questions[0]!, /What would you like to do\?/i)
  // The menu choice is the only *update* consent; Spicetify apply keeps its
  // documented separate consent and must not ask about a plan again.
  assert.deepEqual(prompt.asked.filter((question) => /plan/i.test(question)), [])
})

test("pinned installer constants match the A02 evidence and approval defaults to no", () => {
  assert.equal(SPICETIFY_INSTALL_REVISION, "f4a824f")
  assert.equal(OFFICIAL_INSTALLER_BYTES, 8307)
  assert.equal(OFFICIAL_INSTALLER_SHA256, "e65d1651dc6e3eacbcb58a56f2979f75ad1af16423b114d78d411312c0a8e22e")
  assert.equal(buildApprovalRequest().defaultYes, false)
})

test("the existing-install prompt warning is scoped to an existing install", () => {
  const fresh = spicetifyOfficialPin(TEST_LATEST, false)
  const existing = spicetifyOfficialPin(TEST_LATEST, true)
  assert.ok(!fresh.nots.includes(EXISTING_INSTALL_PROMPT_WARNING))
  assert.ok(existing.nots.includes(EXISTING_INSTALL_PROMPT_WARNING))
  assert.equal(fresh.targetVersion, `v${TEST_LATEST}`)
  assert.equal(spicetifyOfficialPin(null).targetVersion, "latest stable release")
  assert.equal(resolvedSpicetifyTarget(null, null), null)
  assert.equal(stableVersion("2.47.0-beta.1"), null)
  assert.equal(stableVersion("2.47.0"), "2.47.0")
})

// ---------------------------------------------------------------------------
// Installer evidence wording and material warnings (E1-M4)
// ---------------------------------------------------------------------------

test("digest verification is claimed only for reviewed x64 releases", () => {
  const reviewed = spicetifyOfficialPin("2.46.7", false, { arch: "x64" })
  assert.ok(
    reviewed.effects.some((line) => /size and SHA-256 against the reviewed x64 ledger/.test(line)),
    reviewed.effects.join("\n"),
  )
  assert.ok(!reviewed.effects.some((line) => /Authenticode \+ exact version only/.test(line)))

  const unreviewed = spicetifyOfficialPin(TEST_LATEST, false, { arch: "x64" })
  assert.ok(unreviewed.effects.some((line) => /Authenticode \+ exact version only/.test(line)), unreviewed.effects.join("\n"))
  assert.ok(!unreviewed.effects.some((line) => /size and SHA-256/.test(line)), "no digest claim without a ledger entry")
  assert.ok(unreviewed.nots.some((line) => /x64-only/.test(line)))

  // Ledger evidence is x64-only even when the version itself was reviewed.
  const arm64 = spicetifyOfficialPin("2.46.7", false, { arch: "arm64" })
  assert.ok(arm64.effects.some((line) => /Authenticode \+ exact version only/.test(line)))
  assert.ok(arm64.nots.some((line) => /x64-only/.test(line)))
})

test("material installer warnings reach the single approval screen with --verbose", async () => {
  const runtime = officialRuntime()
  const { ctx, ui, prompt } = setupContext(runtime, { verbose: true })
  const captures: Capture[] = []
  const deps = fakeInstaller(runtime, captures, { installedVersion: TEST_LATEST })
  assert.equal(await ensureSpicetify(ctx, deps), "ready", ui.lines.join("\n"))
  const text = ui.lines.join("\n")

  assert.match(text, /permanently delete `%USERPROFILE%\\spicetify-cli`/, text)
  assert.match(text, /%TEMP%\\spicetify\.zip/, text)
  assert.match(text, /x64-only/, text)
  assert.match(text, /execution policy/, text)
  assert.match(text, /Marketplace/i, text)
  assert.match(text, /removed from the staged script/i, text)
  // The patch removes the Marketplace branch: never instruct an answer for it.
  assert.doesNotMatch(text, /Marketplace[^.]*answer No/i, text)
  // A missing Spicetify means no existing-install prompt is possible: the
  // warning is scoped to detected installs (see the pin unit test below).
  assert.ok(!text.includes(EXISTING_INSTALL_PROMPT_WARNING), `unexpected existing-install warning:\n${text}`)
  // Single consent is preserved.
  assert.equal(prompt.asked.filter((line) => /Run the pinned official installer/i.test(line)).length, 1)
  assert.equal(captures.length, 1)
})

test("the default approval screen is crisp; the full wall needs --verbose", async () => {
  const runtime = officialRuntime()
  const { ctx, ui } = setupContext(runtime)
  const deps = fakeInstaller(runtime, [], { installedVersion: TEST_LATEST })
  assert.equal(await ensureSpicetify(ctx, deps), "ready", ui.lines.join("\n"))
  const text = ui.lines.join("\n")
  assert.match(text, /Run with --verbose to see all \d+ non-effects\./)
  assert.match(text, /Marketplace/i, "the core effect stays visible")
  assert.ok(!text.includes("permanently delete `%USERPROFILE%\\spicetify-cli`"), `full wall leaked:\n${text}`)
  assert.ok(!text.includes("%TEMP%\\spicetify.zip"), `full wall leaked:\n${text}`)
})

// ---------------------------------------------------------------------------
// Maintenance cancellation/failure precedence (H1)
// ---------------------------------------------------------------------------

test("maintenance switch keeps a real failure (1) when cancellation is requested", async () => {
  const runtime = fakeRuntime()
  runtime.state.opencode.listVersion = "local"
  const { ctx, ui } = menuContext(runtime, "switch", {
    pluginInstalled: "local",
    local: true,
    yes: true,
  })
  const realRun = runtime.run.bind(runtime)
  runtime.run = (async (file: string, args: string[], options?: unknown) => {
    if (file.includes("opencode") && args[1] === "add") {
      ctx.cancel.request("sigint")
      return { code: 1, stdout: "", stderr: "", error: "registry unavailable" }
    }
    return realRun(file, args, options as never)
  }) as typeof runtime.run

  assert.equal(await runSetup(ctx), 1, ui.lines.join("\n"))
  assert.ok(ctx.cancel.requested, "cancellation really was requested")
})

test("maintenance update keeps a real failure (1) when cancellation is requested", async () => {
  const runtime = fakeRuntime()
  const { ctx, ui } = menuContext(runtime, "update", {
    pluginInstalled: "0.6.0",
    pluginLatest: "0.6.1",
    yes: true,
  })
  const realRun = runtime.run.bind(runtime)
  runtime.run = (async (file: string, args: string[], options?: unknown) => {
    if (file.includes("opencode") && args[1] === "add") {
      ctx.cancel.request("sigint")
      return { code: 1, stdout: "", stderr: "", error: "registry unavailable" }
    }
    return realRun(file, args, options as never)
  }) as typeof runtime.run

  assert.equal(await runSetup(ctx), 1, ui.lines.join("\n"))
})
