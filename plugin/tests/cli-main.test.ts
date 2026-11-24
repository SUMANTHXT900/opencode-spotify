import { test } from "node:test"
import assert from "node:assert/strict"
import { main } from "../src/cli/main.ts"
import { context, fakeLogger, fakePrompt, fakeRuntime, fakeUi } from "./cli-fixture.ts"

test("main prints version and help before environment detection", async () => {
  const runtime = fakeRuntime()
  const log = fakeLogger()
  const ui = fakeUi()
  assert.equal(await main(["--version"], { runtime, log, ui, prompt: fakePrompt() }), 0)
  assert.deepEqual(log.lines, ["0.6.0-beta.1"])
  assert.equal(runtime.calls.length, 0)

  const helpLog = fakeLogger()
  assert.equal(await main(["--help"], { runtime, log: helpLog, ui, prompt: fakePrompt() }), 0)
  assert.match(helpLog.lines.join("\n"), /opencode-spotify/)
  assert.match(helpLog.lines.join("\n"), /--dry-run/)
  assert.equal(runtime.calls.length, 0)
})

test("main rejects unknown commands and options with exit code 2", async () => {
  const runtime = fakeRuntime()
  const log = fakeLogger()
  assert.equal(await main(["frobnicate"], { runtime, log, ui: fakeUi(), prompt: fakePrompt() }), 2)
  assert.match(log.lines.join("\n"), /Unknown command/)
  const optionLog = fakeLogger()
  assert.equal(await main(["status", "--bogus"], { runtime, log: optionLog, ui: fakeUi(), prompt: fakePrompt() }), 2)
  assert.match(optionLog.lines.join("\n"), /Unknown option/)
})

test("main dry-run setup performs no mutations and no network", async () => {
  const runtime = fakeRuntime()
  const log = fakeLogger()
  const ui = fakeUi()
  const ctx = context(runtime, ui, fakePrompt(), { dryRun: true, offline: true, spicetify: "skip" })
  assert.ok(ctx.detection.opencode.available)
  assert.equal(await main(["setup", "--dry-run", "--offline", "--spicetify=skip"], {
    runtime, log, ui, prompt: fakePrompt(),
  }), 0)
  const commands = runtime.calls.map((call) => `${call.file} ${call.args.join(" ")}`)
  assert.ok(!commands.some((command) => command.includes("plugin add")))
  assert.ok(!commands.some((command) => command.includes("install-extension.ps1")))
  assert.ok(!commands.some((command) => command.includes("npm view")))
})
