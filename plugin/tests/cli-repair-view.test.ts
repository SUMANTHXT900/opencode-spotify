import { test } from "node:test"
import assert from "node:assert/strict"
import type { PlanStep, Presentation } from "../src/cli/types.ts"
import { runRepair } from "../src/cli/repair.ts"
import {
  badge,
  buildRepairView,
  renderRepairPlan,
  renderRepairViewPlain,
  resolveColor,
  resolveUiMode,
  runWithPresentationFallback,
  toInstallerPlanView,
} from "../src/cli/ui/repair-view.ts"
import {
  buildDiagnosticsView,
  createSanitizedReport,
  formatSanitizedReport,
  renderDiagnosticsViewPlain,
  renderSanitizedReportJson,
  renderSanitizedReportText,
  sanitizeDiagnosticsText,
} from "../src/cli/ui/diagnostics-view.ts"
import {
  context,
  fakeDetection,
  fakeLogger,
  fakePresentation,
  fakePrompt,
  fakeReport,
  fakeRuntime,
  fakeUi,
} from "./cli-fixture.ts"

const noAnsi = (text: string) => !/\u001b\[/.test(text)

// main.ts pulls in the whole installer graph. Load it lazily so a genuine
// import regression fails closed with its message instead of silently passing
// (a broken main import must never look like skipped coverage).
const mainImport = await import("../src/cli/main.ts").then(
  (module) => ({ module }),
  (error: unknown) => ({ error: error instanceof Error ? error : new Error(String(error)) }),
)

function mainOrFail(): typeof import("../src/cli/main.ts")["main"] {
  if ("error" in mainImport) {
    assert.fail(`main.ts is a physically meaningful prerequisite and must import cleanly: ${mainImport.error.message}`)
  }
  return mainImport.module.main
}

function step(id: string, description: string, mutates = true): PlanStep {
  return { id, description, mutates, run: async () => {} }
}

test("repair view renders a plain plan with statuses, ids, and no ANSI", () => {
  const view = buildRepairView(
    [
      step("remove-local-registration", "Remove the local development registration opencode-spotify@0.6.0"),
      step("register-global-plugin", "Register opencode-spotify@0.6.0 globally"),
      step("verify-registration", "Verify the global registration", false),
    ],
    { statuses: { "remove-local-registration": "ok", "register-global-plugin": "failed" } },
  )
  assert.equal(view.title, "Repair plan")
  assert.equal(view.phase, "plan")
  assert.equal(view.steps.length, 3)
  assert.equal(view.steps[0]!.status, "ok")
  assert.equal(view.steps[2]!.mutates, false)

  const text = renderRepairViewPlain(view, { color: false }).join("\n")
  assert.match(text, /Repair plan/)
  assert.match(text, /Phase: plan - apply/)
  assert.match(text, /\[OK\] 1\. Remove the local development registration/)
  assert.match(text, /\[XX\] 2\. Register opencode-spotify@0\.6\.0 globally \[register-global-plugin\]/)
  assert.match(text, /\(verification only\)/)
  assert.match(text, /Repair only changes owned state/)
  assert.match(text, /Project configuration and unrelated plugins are never edited/)
  assert.match(text, /Restart running OpenCode processes/)
  assert.ok(noAnsi(text), "plain repair output must not contain ANSI escapes")
  assert.deepEqual(toInstallerPlanView(view), { title: "Repair plan", steps: view.steps })
  assert.deepEqual(renderRepairPlan(view), renderRepairViewPlain(view))
})

test("repair dry-run and blocked views explain that nothing changed", () => {
  const dry = buildRepairView([step("repair-bridge", "Repair the owned bridge extension")], {
    dryRun: true,
    nonInteractive: true,
  })
  const dryText = renderRepairViewPlain(dry).join("\n")
  assert.match(dryText, /dry run - no changes/)
  assert.match(dryText, /Dry run: no changes will be made\./)
  assert.match(dryText, /Noninteractive mode/)

  const blocked = buildRepairView([], { blockedReason: "OpenCode is not available; repair cannot verify a global registration." })
  const blockedText = renderRepairViewPlain(blocked).join("\n")
  assert.match(blockedText, /\[XX\] Blocked: OpenCode is not available/)
  assert.match(blockedText, /No steps will run\./)
  assert.match(blockedText, /No changes were made\./)
})

test("repair view wraps long lines and colors only when requested", () => {
  const view = buildRepairView([step("repair-bridge", "Repair the owned bridge extension and registration")], {
    notes: ["This note is deliberately long so that the plain renderer has to wrap it across several lines without dropping any words from the end of the sentence."],
  })
  const wide = renderRepairViewPlain(view, { color: false, width: 60, showIds: false })
  for (const line of wide) {
    assert.ok(line.length <= 60, `line exceeds width: ${line}`)
  }
  assert.match(wide.join("\n"), /without\s+dropping\s+any words/)
  assert.ok(noAnsi(wide.join("\n")))

  const colored = renderRepairViewPlain(view, { color: true }).join("\n")
  assert.ok(!noAnsi(colored), "color: true should emit ANSI")
  assert.match(colored, /\u001b\[1m/)
  assert.equal(badge("fail", false), "[XX]")
})

test("UI mode and color resolution honor --json/--plain/non-TTY/NO_COLOR", () => {
  const tty = { stdoutTTY: true, stdinTTY: true, env: {} as NodeJS.ProcessEnv }
  const piped = { stdoutTTY: false, stdinTTY: false, env: {} as NodeJS.ProcessEnv }

  assert.equal(resolveUiMode({ ...tty, env: {} }, { json: true }), "json")
  assert.equal(resolveUiMode({ ...tty, env: {} }, { plain: true }), "plain")
  assert.equal(resolveUiMode({ ...tty, env: {} }), "ink")
  assert.equal(resolveUiMode(piped), "plain")
  assert.equal(resolveUiMode({ ...tty, stdinTTY: false, env: {} }), "plain")
  assert.equal(resolveUiMode({ ...tty, env: { OPENCODE_SPOTIFY_UI: "plain" } }), "plain")
  assert.equal(resolveUiMode({ ...tty, env: { CI: "1" } }), "plain")
  assert.equal(resolveUiMode({ ...tty, env: { TERM: "dumb" } }), "plain")

  assert.equal(resolveColor(tty, true), true)
  assert.equal(resolveColor(piped, true), false)
  assert.equal(resolveColor(tty, false), false)
  assert.equal(resolveColor({ ...tty, env: { NO_COLOR: "1" } }), false)
  assert.equal(resolveColor({ ...tty, env: { NO_COLOR: "" } }), true)
  assert.equal(resolveColor({ ...tty, env: { NO_COLOR: "1", FORCE_COLOR: "1" } }), false)
  assert.equal(resolveColor({ ...tty, env: { TERM: "dumb" } }), false)
  assert.equal(resolveColor({ stdoutTTY: false, stdinTTY: true, env: { FORCE_COLOR: "1" } }), false)
})

test("Ink initialization failure falls back to plain before the operation starts", async () => {
  const plainUi = fakeUi()
  const plain = fakePresentation("plain", { ui: plainUi })
  let operations = 0
  let mutations = 0
  const fallbacks: string[] = []

  const result = await runWithPresentationFallback({
    startInk: () => { throw new Error("Ink init failed: no raw mode") },
    startPlain: () => plain,
    onFallback: (info) => fallbacks.push(`${info.origin}:${info.reason}`),
    run: async (presentation, control) => {
      operations += 1
      assert.equal(control.mode(), "plain")
      assert.equal(control.isPlain(), true)
      presentation.ui.line("plain fallback active")
      mutations += 1
      return 7
    },
  })

  assert.equal(result.result, 7)
  assert.equal(result.mode, "plain")
  assert.equal(result.fellBack, true)
  assert.equal(result.fallbacks, 1)
  assert.equal(operations, 1, "operation must run exactly once")
  assert.equal(mutations, 1, "fallback must not replay the mutation")
  assert.deepEqual(fallbacks, ["init:Ink init failed: no raw mode"])
  assert.ok(plainUi.lines.includes("plain fallback active"))
  assert.equal(plain.closes, 1)
})

test("a render failure mid-operation swaps the sink without replaying the step", async () => {
  const inkUi = fakeUi()
  inkUi.line = () => { throw new Error("renderer crashed") }
  const ink = fakePresentation("ink", { ui: inkUi })
  const plainUi = fakeUi()
  const plain = fakePresentation("plain", { ui: plainUi })
  const fallbacks: Array<{ origin: string; mode: string }> = []
  let operations = 0
  let mutations = 0

  const result = await runWithPresentationFallback({
    startInk: () => ink,
    startPlain: () => plain,
    onFallback: (info) => fallbacks.push({ origin: info.origin, mode: info.mode }),
    run: async (presentation) => {
      operations += 1
      presentation.ui.line("before the crash") // throws, triggers fallback, retried on plain
      mutations += 1
      presentation.ui.line("after the swap") // plain from here on
      presentation.report.step("repair-bridge", "ok")
      return "done"
    },
  })

  assert.equal(result.result, "done")
  assert.equal(result.mode, "plain")
  assert.equal(result.fellBack, true)
  assert.equal(operations, 1, "run must never be re-entered")
  assert.equal(mutations, 1, "destructive work must never be repeated")
  assert.deepEqual(fallbacks, [{ origin: "render", mode: "plain" }])
  assert.ok(plainUi.lines.includes("before the crash"), "failed render is retried once on plain")
  assert.ok(plainUi.lines.includes("after the swap"))
  assert.equal(ink.closes, 1)
  assert.equal(plain.closes, 1)
})

test("report and prompt failures also degrade without failing the operation", async () => {
  const inkReport = fakeReport()
  inkReport.step = () => { throw new Error("step render failed") }
  const inkPrompt = fakePrompt()
  inkPrompt.confirm = async () => { throw new Error("prompt render failed") }
  const ink = fakePresentation("ink", { report: inkReport, prompt: inkPrompt })
  const plainReport = fakeReport()
  const plainPrompt = fakePrompt({ confirms: [true] })
  const plain = fakePresentation("plain", { report: plainReport, prompt: plainPrompt })

  const result = await runWithPresentationFallback({
    startInk: () => ink,
    startPlain: () => plain,
    run: async (presentation) => {
      presentation.report.step("x", "running") // throws, fallback, re-emitted to plain
      const approved = await presentation.prompt.confirm("Continue?")
      return approved
    },
  })

  assert.equal(result.result, true)
  assert.equal(result.mode, "plain")
  assert.ok(plainReport.events.some((event) => event.type === "step" && event.id === "x"))
})

test("a render failure inside control.render is swallowed after falling back", async () => {
  const plain = fakePresentation("plain")
  const result = await runWithPresentationFallback({
    startInk: () => fakePresentation("ink"),
    startPlain: () => plain,
    run: async (_presentation: Presentation, control) => {
      control.render(() => { throw new Error("custom render failed") })
      assert.equal(control.mode(), "plain")
      return "still alive"
    },
  })
  assert.equal(result.result, "still alive")
  assert.equal(result.fellBack, true)
})

test("diagnostics view groups checks, explains fixes, and lists troubleshooting", () => {
  const view = buildDiagnosticsView([
    { id: "windows", status: "ok", message: "Windows detected (Windows 11, x64)" },
    { id: "node", status: "fail", message: "Node.js 20.0.0", fix: "Install Node.js 22.18 or newer." },
    { id: "bridge-credentials", status: "fail", message: "Credential file exists but is invalid or unreadable.", fix: "Run `opencode-spotify repair`; do not delete the file manually." },
    { id: "port", status: "warn", message: "Port 18765 is in use by an unknown process; it will not be terminated." },
    { id: "connection", status: "info", message: "Playback connectivity is verified only after Spotify and OpenCode are running." },
  ])

  assert.deepEqual(view.summary, { ok: 1, warn: 1, fail: 2, info: 1 })
  assert.equal(view.readOnly, true)
  assert.equal(view.troubleshooting.length, 3)
  assert.ok(!view.troubleshooting.some((item) => item.checkId === "connection"), "info checks are not troubleshooting")
  const port = view.troubleshooting.find((item) => item.checkId === "port")!
  assert.ok(port.steps.some((line) => line.includes("Get-NetTCPConnection -LocalPort 18765")))
  assert.ok(!port.steps.some((line) => /kill|terminate the process/i.test(line)))

  const text = renderDiagnosticsViewPlain(view, { color: false }).join("\n")
  assert.match(text, /Diagnostics \(read-only\)/)
  assert.match(text, /\[XX\] Credential file exists but is invalid or unreadable\./)
  assert.match(text, /Fix: Run `opencode-spotify repair`/)
  assert.match(text, /Troubleshooting/)
  assert.match(text, /1 ok, 1 warning\(s\), 2 failure\(s\), 1 info/)
  assert.match(text, /No changes were made\. Use `opencode-spotify repair` or `setup` for fixes\./)
  assert.ok(noAnsi(text))
})

test("non-TTY/NO_COLOR diagnostics output stays free of escape codes", () => {
  const view = buildDiagnosticsView([{ id: "node", status: "fail", message: "Node.js 20", fix: "Install Node.js 22.18 or newer." }])
  const color = resolveColor({ stdoutTTY: true, stdinTTY: true, env: { NO_COLOR: "1" } })
  const text = renderDiagnosticsViewPlain(view, { color }).join("\n")
  assert.equal(color, false)
  assert.ok(noAnsi(text))
  assert.match(renderDiagnosticsViewPlain(view, { color: true }).join("\n"), /\u001b\[/)
})

test("sanitized diagnostics report redacts credentials and account paths", () => {
  const runtime = fakeRuntime()
  const view = buildDiagnosticsView([
    {
      id: "bridge-credentials",
      status: "fail",
      message: "Credential file exists but is invalid at C:\\Users\\Alice\\AppData\\Roaming\\opencode-spotify\\bridge.json",
      fix: "Authorization: Bearer abc123",
    },
    {
      id: "port",
      status: "warn",
      message: "Port 18765 in use; secret=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    },
  ])
  const report = createSanitizedReport(view, {
    installerVersion: "0.6.0-beta.3",
    detection: fakeDetection(runtime),
    versions: { plugin: { installed: "0.6.0-beta.3", latest: "0.6.0" }, spicetify: { installed: "2.46.7", latest: null } },
    now: 0,
  })

  const text = renderSanitizedReportText(report)
  const json = renderSanitizedReportJson(report)
  assert.ok(noAnsi(text))
  assert.ok(noAnsi(json))
  assert.doesNotMatch(text, /Alice/)
  assert.doesNotMatch(json, /Alice/)
  assert.doesNotMatch(text, /abc123/)
  assert.doesNotMatch(json, /deadbeef/)
  assert.match(text, /C:\\Users\\<user>\\AppData/)
  assert.match(text, /\[redacted\]/)
  assert.match(text, /Redactions applied: [1-9]/)
  assert.ok(report.redactions > 0)

  const parsed = JSON.parse(json) as Record<string, unknown>
  assert.equal(parsed.schemaVersion, 1)
  assert.equal(parsed.generator, "opencode-spotify")
  assert.equal((parsed.environment as Record<string, unknown>).windows, true)
  assert.ok(Array.isArray(parsed.checks))
  assert.doesNotMatch(json, /\u001b|\bfunction\b/)
  assert.equal(formatSanitizedReport(report, "json"), json)
  assert.equal(formatSanitizedReport(report), text)
})

test("sanitizer is idempotent and strips ANSI/control sequences", () => {
  const once = sanitizeDiagnosticsText("token=abc\u001b[31m C:\\Users\\Bob\\x 192.168.1.20 bob@example.com")
  const twice = sanitizeDiagnosticsText(once.text)
  assert.equal(twice.text, once.text)
  assert.ok(noAnsi(once.text))
  assert.doesNotMatch(once.text, /Bob|bob@example\.com|192\.168\.1\.20|abc/)
  assert.match(once.text, /<user>/)
  assert.match(once.text, /<private-ip>/)
  assert.match(once.text, /<email>/)
})

test("--version and --help still print plain text without touching the system", async () => {
  const main = mainOrFail()
  const runtime = fakeRuntime()
  const versionLog = fakeLogger()
  const versionUi = fakeUi()
  assert.equal(await main(["--version"], { runtime, log: versionLog, ui: versionUi, prompt: fakePrompt() }), 0)
  assert.equal(versionLog.lines.length, 1)
  assert.ok(noAnsi(versionLog.lines.join("\n")))
  assert.equal(runtime.calls.length, 0)

  const helpLog = fakeLogger()
  assert.equal(await main(["--help"], { runtime, log: helpLog, ui: fakeUi(), prompt: fakePrompt() }), 0)
  const help = helpLog.lines.join("\n")
  assert.match(help, /--dry-run/)
  assert.match(help, /--json/)
  assert.match(help, /--plain/)
  assert.ok(noAnsi(help))
  assert.equal(runtime.calls.length, 0)
})

test("doctor --json emits parseable JSON with no Ink or ANSI, even on a fake UI", async () => {
  const main = mainOrFail()
  const runtime = fakeRuntime()
  const ui = fakeUi()
  const log = fakeLogger()
  const code = await main(["doctor", "--json", "--offline"], {
    runtime, log, ui, prompt: fakePrompt(),
  })
  assert.equal(code, 0)
  assert.equal(log.lines.length, 0, "JSON mode must not write Ink/plain noise to the logger")
  assert.ok(ui.jsonValue, "doctor --json must call ui.json")
  const json = JSON.stringify(ui.jsonValue)
  assert.ok(noAnsi(json))
  assert.doesNotMatch(json, /ink|react/i)
  const parsed = JSON.parse(json) as Record<string, unknown>
  assert.equal(parsed.schemaVersion, 1)
  assert.equal(parsed.readOnly, true)
})

test("repair --dry-run preserves the plan and performs no mutation", async () => {
  const main = mainOrFail()
  const runtime = fakeRuntime()
  runtime.state.bridge.extensionCurrent = false
  runtime.state.spicetify.registered = false
  const ui = fakeUi()
  const log = fakeLogger()
  assert.equal(await main(["repair", "--dry-run", "--offline"], {
    runtime, log, ui, prompt: fakePrompt(),
  }), 0)
  assert.ok(ui.lines.some((line) => line.startsWith("dry:")), ui.lines.join("\n"))
  const commands = runtime.calls.map((call) => `${call.file} ${call.args.join(" ")}`)
  assert.ok(!commands.some((command) => /-Install|-Repair|-Uninstall|spicetify apply/.test(command)), commands.join("\n"))
})

test("fixture exposes a fake reporter, runInteractive, and presentations", async () => {
  const report = fakeReport()
  report.phase("detect", "Detect")
  report.step("register-global-plugin", "running")
  report.log("info", "checking")
  report.progress("bridge", "preparing", 50)
  report.prompt(null)
  assert.deepEqual(report.events.map((event) => event.type), ["phase", "step", "log", "progress", "prompt"])
  assert.deepEqual(report.events.map((event) => event.at), [0, 1, 2, 3, 4])

  const runtime = fakeRuntime()
  const interactive = await runtime.runInteractive!("pwsh", ["-File", "install-extension.ps1", "-Install"], { cwd: "C:\\Temp" })
  assert.equal(interactive.code, 0)
  assert.equal(runtime.interactiveCalls.length, 1)
  assert.deepEqual(runtime.interactiveCalls[0]!.args, ["-File", "install-extension.ps1", "-Install"])
  assert.equal(runtime.interactiveCalls[0]!.options?.cwd, "C:\\Temp")
  assert.ok(runtime.calls.some((call) => call.file === "pwsh"))

  const ctx = context(runtime)
  assert.ok(ctx.report)
  ctx.report!.log("info", "via context")
  assert.ok(((ctx.report as unknown as { events: unknown[] }).events).length >= 1)

  const presentation = fakePresentation("ink")
  assert.equal(presentation.mode, "ink")
  await presentation.close()
  assert.equal(presentation.closes, 1)
})

// ---------------------------------------------------------------------------
// Single repair plan source (M2)
// ---------------------------------------------------------------------------

function repairPlanRuntime() {
  const runtime = fakeRuntime()
  runtime.state.opencode.listVersion = null
  runtime.state.bridge.installed = false
  runtime.state.bridge.extensionCurrent = false
  runtime.state.spicetify.registered = false
  return runtime
}

test("repair announces its step list once through the reporter and renders only notes", async () => {
  const runtime = repairPlanRuntime()
  const ui = fakeUi()
  const report = fakeReport()
  const ctx = context(runtime, ui, fakePrompt(), { command: "repair", yes: true }, undefined, report)
  ctx.detection = fakeDetection(runtime)

  assert.equal(await runRepair(ctx), 0, ui.lines.join("\n"))
  const plans = report.events.filter(
    (event) => event.type === "plan" && event.title === "Repair plan",
  )
  assert.equal(plans.length, 1, "exactly one structured repair plan event")
  const plan = plans[0] as { type: "plan"; steps: Array<{ id: string; description: string }> }
  assert.deepEqual(plan.steps.map((step) => step.id), ["register-global-plugin", "repair-bridge"])

  // The UI must not repeat the step list the reporter already owns.
  for (const step of plan.steps) {
    assert.ok(
      !ui.lines.some((line) => line.includes(step.description)),
      `UI repeated the plan step: ${step.description}\n${ui.lines.join("\n")}`,
    )
  }
  assert.ok(ui.lines.some((line) => /Repair only changes owned state/.test(line)), "notes still render")
})

test("repair without a reporter shows the numbered plan list exactly once", async () => {
  const runtime = repairPlanRuntime()
  const ui = fakeUi()
  const ctx = context(runtime, ui, fakePrompt(), { command: "repair", yes: true })
  ctx.detection = fakeDetection(runtime)
  ctx.report = undefined

  assert.equal(await runRepair(ctx), 0, ui.lines.join("\n"))
  const repairSteps = ui.lines.filter((line) =>
    /^\s*(?:\[[A-Z.]{2}\]\s*)?\d+\.\s+(Register opencode-spotify|Repair the owned bridge)/.test(line),
  )
  assert.equal(repairSteps.length, 2, `the repair plan list must appear once:\n${ui.lines.join("\n")}`)
  assert.ok(repairSteps.some((line) => /Register opencode-spotify/.test(line)))
  assert.ok(repairSteps.some((line) => /Repair the owned bridge/.test(line)))
})
