import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { createUi, createPrompter } from "../src/cli/ui.ts"
import {
  createPlainPresentation, createUiIo, envTruthy, plainColorEnabled, selectUiMode, shouldUseInk,
} from "../src/cli/ui-mode.ts"
import type { Logger, Ui, UiIo } from "../src/cli/types.ts"

const ESC = "\u001b"

function io(overrides: Partial<UiIo> = {}): UiIo {
  return {
    stdoutTTY: true,
    stdinTTY: true,
    env: {} as NodeJS.ProcessEnv,
    ...overrides,
  }
}

function env(values: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return values as NodeJS.ProcessEnv
}

function log(): Logger & { lines: string[] } {
  const lines: string[] = []
  return { lines, out: (line) => lines.push(line), err: (line) => lines.push(line) }
}

test("selectUiMode: --json always wins, even with --plain and no TTY", () => {
  assert.equal(selectUiMode({ json: true }, io()), "json")
  assert.equal(selectUiMode({ json: true, plain: true }, io({ stdoutTTY: false, stdinTTY: false })), "json")
})

test("selectUiMode: explicit plain flags", () => {
  assert.equal(selectUiMode({ plain: true }, io()), "plain")
  assert.equal(selectUiMode({ noInk: true }, io()), "plain")
  assert.equal(selectUiMode({ plain: true, noInk: true }, io()), "plain")
})

test("selectUiMode: non-TTY streams force plain", () => {
  assert.equal(selectUiMode({}, io({ stdoutTTY: false })), "plain")
  assert.equal(selectUiMode({}, io({ stdinTTY: false })), "plain")
  assert.equal(selectUiMode({}, io({ stdoutTTY: false, stdinTTY: false })), "plain")
})

test("selectUiMode: CI, TERM=dumb and OPENCODE_SPOTIFY_UI=plain force plain", () => {
  for (const value of ["1", "true", "TRUE", "yes", "build"]) {
    assert.equal(selectUiMode({}, io({ env: env({ CI: value }) })), "plain", `CI=${value}`)
  }
  assert.equal(selectUiMode({}, io({ env: env({ TERM: "dumb" }) })), "plain")
  assert.equal(selectUiMode({}, io({ env: env({ TERM: "DUMB" }) })), "plain")
  assert.equal(selectUiMode({}, io({ env: env({ OPENCODE_SPOTIFY_UI: "plain" }) })), "plain")
  assert.equal(selectUiMode({}, io({ env: env({ OPENCODE_SPOTIFY_UI: " PLAIN " }) })), "plain")
})

test("selectUiMode: ordinary interactive terminal selects ink", () => {
  assert.equal(selectUiMode({}, io()), "ink")
  assert.equal(selectUiMode({ json: false, plain: false }, io({ env: env({ TERM: "xterm-256color", CI: "" }) })), "ink")
  // Non-truthy CI values and unrelated UI values do not disable Ink.
  for (const value of ["", "0", "false", "no"]) {
    assert.equal(selectUiMode({}, io({ env: env({ CI: value }) })), "ink", `CI=${JSON.stringify(value)}`)
  }
  assert.equal(selectUiMode({}, io({ env: env({ OPENCODE_SPOTIFY_UI: "ink" }) })), "ink")
})

test("envTruthy recognises conventional truthy values only", () => {
  for (const value of [undefined, "", "0", "false", "no", "  "]) assert.equal(envTruthy(value), false, String(value))
  for (const value of ["1", "true", "TRUE", "yes", "build"]) assert.equal(envTruthy(value), true, value)
})

test("shouldUseInk mirrors the mode matrix", () => {
  assert.equal(shouldUseInk({}, io()), true)
  assert.equal(shouldUseInk({ json: true }, io()), false)
  assert.equal(shouldUseInk({ plain: true }, io()), false)
  assert.equal(shouldUseInk({}, io({ stdoutTTY: false })), false)
  assert.equal(shouldUseInk({}, io({ env: env({ CI: "1" }) })), false)
  assert.equal(shouldUseInk({}, io({ env: env({ TERM: "dumb" }) })), false)
  assert.equal(shouldUseInk({}, io({ env: env({ OPENCODE_SPOTIFY_UI: "plain" }) })), false)
})

test("plainColorEnabled disables ANSI for no-color, NO_COLOR, non-TTY and TERM=dumb", () => {
  assert.equal(plainColorEnabled(true, io()), true)
  assert.equal(plainColorEnabled(false, io()), false)
  assert.equal(plainColorEnabled(true, io({ stdoutTTY: false })), false)
  assert.equal(plainColorEnabled(true, io({ env: env({ NO_COLOR: "1" }) })), false)
  assert.equal(plainColorEnabled(true, io({ env: env({ NO_COLOR: "anything" }) })), false)
  assert.equal(plainColorEnabled(true, io({ env: env({ NO_COLOR: "" }) })), true)
  assert.equal(plainColorEnabled(true, io({ env: env({ TERM: "dumb" }) })), false)
})

test("createUiIo captures real streams without throwing", () => {
  const captured = createUiIo(env({ TERM: "xterm" }))
  assert.equal(typeof captured.stdoutTTY, "boolean")
  assert.equal(typeof captured.stdinTTY, "boolean")
  assert.equal(captured.env.TERM, "xterm")
})

// The exact historical plain rendering. If this changes, installers and tests
// that scrape output change with it.
test("createPlainPresentation.ui preserves createUi plain output exactly", async () => {
  const script = (ui: Ui) => {
    ui.banner("1.2.3", true)
    ui.title("Title")
    ui.section("Section")
    ui.line("hello")
    ui.kv("Node", "22.10.0")
    ui.status("ok", "ok-text")
    ui.status("missing", "missing-text")
    ui.status("warn", "warn-text")
    ui.status("fail", "fail-text")
    ui.status("info", "info-text")
    ui.bullet("bullet-text")
    ui.warn("warn-text")
    ui.error("error-text")
    ui.success("success-text")
    ui.dryRun("step")
  }

  const direct = log()
  script(createUi(direct, { color: false, json: false }))

  const wrappedLog = log()
  const presentation = createPlainPresentation(wrappedLog, {
    color: false, json: false, io: io({ stdoutTTY: false }),
  })
  try {
    script(presentation.ui)
  } finally {
    await presentation.close()
  }

  assert.deepEqual(wrappedLog.lines, direct.lines)
  assert.deepEqual(wrappedLog.lines, [
    "",
    "  OpenCode Spotify",
    "  Installer v1.2.3 - Windows",
    "",
    "Title",
    "",
    "Section",
    "hello",
    `  ${"Node".padEnd(22)} 22.10.0`,
    "  [OK] ok-text",
    "  [--] missing-text",
    "  [!!] warn-text",
    "  [XX] fail-text",
    "  [..]  info-text",
    "   - bullet-text",
    "  [!!] warn-text",
    "  [XX] error-text",
    "  [OK] success-text",
    "  [dry-run] step",
  ])
})

test("plain presentation emits no ANSI under --no-color, NO_COLOR, non-TTY or TERM=dumb", async () => {
  const cases: Array<{ name: string; color: boolean; io: UiIo }> = [
    { name: "--no-color", color: false, io: io() },
    { name: "NO_COLOR", color: true, io: io({ env: env({ NO_COLOR: "1" }) }) },
    { name: "non-TTY", color: true, io: io({ stdoutTTY: false }) },
    { name: "TERM=dumb", color: true, io: io({ env: env({ TERM: "dumb" }) }) },
  ]
  for (const item of cases) {
    const logger = log()
    const presentation = createPlainPresentation(logger, { color: item.color, json: false, io: item.io })
    try {
      presentation.ui.banner("1.0.0", true)
      presentation.ui.status("ok", "colored?")
      presentation.ui.warn("careful")
      presentation.ui.error("bad")
      presentation.ui.dryRun("mutate")
      presentation.report.log("warn", "reporter")
      presentation.report.progress("npm", "fetching", 10)
    } finally {
      await presentation.close()
    }
    assert.ok(logger.lines.length > 0, item.name)
    assert.ok(!logger.lines.join("\n").includes(ESC), `${item.name} must not contain ANSI`)
  }
})

test("plain mode reports phases, steps, logs and prompts deterministically", async () => {
  const logger = log()
  const presentation = createPlainPresentation(logger, {
    color: false, json: false, io: io({ stdoutTTY: false }),
  })
  try {
    assert.equal(presentation.mode, "plain")
    presentation.report.phase("detect", "Detecting")
    presentation.report.step("register", "ok", "Plugin registered")
    presentation.report.step("verify", "failed", "missing file")
    presentation.report.log("info", "hello")
    presentation.report.log("success", "done")
    presentation.report.log("warn", "careful")
    presentation.report.log("error", "bad")
    presentation.report.log("debug", "trace")
    presentation.report.progress("npm", "Fetching", 42)
    presentation.report.progress("github", "Waiting")
    presentation.report.prompt({ id: "p1", kind: "confirm", question: "Apply?", defaultYes: false })
    presentation.report.prompt({ id: "p2", kind: "confirm", question: "Remove?", defaultYes: true, phrase: "remove" })
    presentation.report.prompt({
      id: "p3", kind: "choose", question: "Pick", defaultIndex: 1,
      choices: [{ label: "Auto", value: "auto" }, { label: "Skip", value: "skip" }],
    })
    presentation.report.emit({ type: "result", code: 0, at: 0 })
  } finally {
    await presentation.close()
  }
  assert.deepEqual(logger.lines, [
    "",
    "Detecting",
    "  [OK] register - Plugin registered",
    "  [XX] verify - missing file",
    "hello",
    "  [OK] done",
    "  [!!] careful",
    "  [XX] bad",
    "debug: trace",
    "  npm: Fetching (42%)",
    "  github: Waiting",
    "  Apply? [y/N]",
    "  Remove? (type remove to continue)",
    "  Pick 1. Auto  2. Skip [2]",
  ])
})

test("plain reporter renders cancellation phases and force escalation", async () => {
  const logger = log()
  const presentation = createPlainPresentation(logger, {
    color: false, json: false, io: io({ stdoutTTY: false }),
  })
  try {
    presentation.report.emit({ type: "cancel", phase: "requested", stepId: "remove-bridge", at: 1 })
    presentation.report.emit({ type: "cancel", phase: "finishing", stepId: "remove-bridge", forced: true, at: 2 })
    presentation.report.emit({ type: "cancel", phase: "settled", at: 3 })
  } finally {
    await presentation.close()
  }
  assert.deepEqual(logger.lines, [
    "  [!!] Cancelling - waiting for remove-bridge",
    "  press Ctrl+C again to force",
    "  [!!] Cancelling - force requested",
    "  Force requested; stopping the current step.",
    "  [!!] Cancelled.",
  ])
  assert.ok(!logger.lines.join("\n").includes(ESC))
})

test("JSON presentation is silent except for one parseable document", async () => {
  const logger = log()
  const presentation = createPlainPresentation(logger, {
    color: true, json: true, io: io({ stdoutTTY: false }),
  })
  const document = { schemaVersion: 1, command: "status", ok: true, nested: { n: 2 } }
  try {
    assert.equal(presentation.mode, "json")
    presentation.ui.banner("1.0.0", true)
    presentation.ui.title("Title")
    presentation.ui.section("Section")
    presentation.ui.line("hello")
    presentation.ui.kv("k", "v")
    presentation.ui.status("ok", "ok")
    presentation.ui.bullet("b")
    presentation.ui.warn("w")
    presentation.ui.error("e")
    presentation.ui.success("s")
    presentation.ui.dryRun("d")
    presentation.report.phase("execute", "Executing")
    presentation.report.step("s", "ok", "detail")
    presentation.report.log("info", "noise")
    presentation.report.progress("scope", "message", 50)
    presentation.report.prompt({ id: "p", kind: "ask", question: "q" })
    assert.equal(logger.lines.length, 0)

    presentation.ui.json(document)
    presentation.report.log("warn", "after-doc")
  } finally {
    await presentation.close()
  }
  assert.equal(logger.lines.length, 1)
  assert.deepEqual(JSON.parse(logger.lines[0]!), document)
  assert.ok(!logger.lines[0]!.includes(ESC))
})

test("plain Ui lifecycle is a safe no-op and close is idempotent", async () => {
  const logger = log()
  const presentation = createPlainPresentation(logger, {
    color: false, json: false, io: io({ stdoutTTY: false }),
  })
  assert.equal(typeof presentation.ui.suspend, "function")
  assert.equal(typeof presentation.ui.resume, "function")
  assert.equal(typeof presentation.ui.close, "function")
  await presentation.ui.suspend?.()
  await presentation.ui.resume?.()
  await presentation.ui.close?.()
  await presentation.close()
  await presentation.close()
  assert.deepEqual(logger.lines, [])

  // The wrapped prompter is closed too; closing again stays safe.
  presentation.prompt.close()
  presentation.prompt.close()
})

test("plain presentation files never import Ink or React", () => {
  const files = [
    fileURLToPath(new URL("../src/cli/ui-mode.ts", import.meta.url)),
    fileURLToPath(new URL("../src/cli/ui.ts", import.meta.url)),
  ]
  for (const file of files) {
    const source = readFileSync(file, "utf8")
    assert.ok(!/from\s+["'](?:ink|react|react-dom|@opentui)/i.test(source), `${file} must not import Ink/React`)
    assert.ok(!/require\(\s*["'](?:ink|react|react-dom|@opentui)/i.test(source), `${file} must not require Ink/React`)
  }
})

test("createPrompter is lazy: construct and close without holding the terminal", () => {
  const logger = log()
  const prompter = createPrompter(logger)
  // Closing before any prompt must be safe and idempotent.
  prompter.close()
  prompter.close()
})
