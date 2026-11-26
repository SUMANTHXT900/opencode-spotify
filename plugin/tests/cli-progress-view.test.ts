import { test } from "node:test"
import assert from "node:assert/strict"
import {
  createInteractiveChild,
  createProgressReporter,
  createProgressView,
  createTerminalRestoration,
  normalizePercent,
  redactSecrets,
  renderPercentBar,
  sanitizeErrorDetail,
  sanitizeLogMessage,
  stripTerminalSequences,
  RESTORE_SEQUENCE,
} from "../src/cli/ui/progress-view.ts"
import type { PlanStepView } from "../src/cli/types.ts"
import type { TerminalLike } from "../src/cli/ui/progress-view.ts"

function planSteps(): PlanStepView[] {
  return [
    { id: "preflight", description: "Check environment", mutates: false, status: "pending" },
    { id: "spicetify", description: "Install Spicetify", mutates: true, status: "pending" },
    { id: "bridge", description: "Prepare bridge", mutates: true, status: "pending" },
    { id: "apply", description: "Apply changes", mutates: true, status: "pending" },
  ]
}

function statusOf(steps: ReturnType<ReturnType<typeof createProgressView>["snapshot"]>["steps"], id: string): string | undefined {
  return steps.find((step) => step.id === id)?.status
}

interface FakeTerminal extends TerminalLike {
  events: string[]
  fire(event: string): void
  listenerCount(event: string): number
}

function fakeTerminal(): FakeTerminal {
  const listeners = new Map<string, Set<() => void>>()
  const events: string[] = []
  const terminal: FakeTerminal = {
    pid: 4321,
    events,
    on(event, listener) {
      const set = listeners.get(event) ?? new Set<() => void>()
      set.add(listener)
      listeners.set(event, set)
      events.push(`on:${event}`)
      return terminal
    },
    removeListener(event, listener) {
      listeners.get(event)?.delete(listener)
      events.push(`off:${event}`)
      return terminal
    },
    kill(pid, signal) {
      events.push(`kill:${pid}:${signal ?? "none"}`)
      return true
    },
    exit(code) {
      events.push(`exit:${code ?? "none"}`)
    },
    fire(event) {
      for (const listener of [...(listeners.get(event) ?? [])]) listener()
    },
    listenerCount(event) {
      return listeners.get(event)?.size ?? 0
    },
  }
  return terminal
}

test("progress state is derived from real plan and step events", () => {
  const view = createProgressView({ title: "Installing Spotify" })
  view.apply({ type: "plan", title: "Installing Spotify", steps: planSteps(), at: 1 })
  view.apply({ type: "step", id: "preflight", status: "running", at: 2 })
  view.apply({ type: "step", id: "preflight", status: "ok", at: 3 })
  view.apply({ type: "step", id: "spicetify", status: "running", at: 4 })
  view.apply({ type: "step", id: "spicetify", status: "failed", detail: "winget exited 5", at: 5 })
  view.apply({ type: "step", id: "bridge", status: "skipped", at: 6 })
  view.apply({ type: "step", id: "apply", status: "skipped", at: 7 })

  const snapshot = view.snapshot()
  assert.equal(snapshot.title, "Installing Spotify")
  assert.equal(statusOf(snapshot.steps, "preflight"), "completed")
  assert.equal(statusOf(snapshot.steps, "spicetify"), "failed")
  assert.equal(statusOf(snapshot.steps, "bridge"), "skipped")
  assert.equal(statusOf(snapshot.steps, "apply"), "skipped")
  assert.deepEqual(snapshot.counts, {
    total: 4, pending: 0, current: 0, completed: 1, failed: 1, skipped: 2,
  })
  assert.equal(snapshot.steps.find((step) => step.id === "spicetify")?.error, "winget exited 5")

  const rendered = view.render()
  assert.match(rendered, /Progress: Installing Spotify/)
  assert.match(rendered, /1\. Check environment/)
  assert.match(rendered, /Reason: winget exited 5/)
})

test("step events for steps not in the plan are appended, never dropped", () => {
  const view = createProgressView()
  view.apply({ type: "plan", title: "Plan", steps: planSteps(), at: 1 })
  view.apply({ type: "step", id: "extra-check", status: "running", description: "Verify bridge", at: 2 })

  const snapshot = view.snapshot()
  assert.equal(snapshot.counts.total, 5)
  assert.equal(statusOf(snapshot.steps, "extra-check"), "current")
  assert.equal(snapshot.steps.find((step) => step.id === "extra-check")?.description, "Verify bridge")
})

test("percentages come only from explicit events, never from elapsed time", () => {
  let clock = 0
  const view = createProgressView({ now: () => clock })
  view.apply({ type: "phase", phase: "execute", label: "Executing", at: 0 })
  view.apply({ type: "plan", title: "Plan", steps: planSteps(), at: 0 })
  view.apply({ type: "progress", scope: "bridge", message: "Copying extension", at: 0 })

  assert.equal(view.indeterminate, true)
  assert.doesNotMatch(view.render(), /\d+%/)
  clock += 60_000
  // A full minute passes without an operation event: no invented progress.
  assert.doesNotMatch(view.render(), /\d+%/)
  assert.equal(view.snapshot().activity?.percent, undefined)

  view.setActivity("bridge", "Copying extension", 42)
  assert.equal(view.indeterminate, false)
  assert.match(view.render(), /42%/)

  view.setActivity("bridge", "Copying extension", 0)
  assert.match(view.render(), /0%/, "an explicit zero is real progress, not missing data")
})

test("invalid percentages are ignored or clamped, never guessed", () => {
  assert.equal(normalizePercent(undefined), undefined)
  assert.equal(normalizePercent(Number.NaN), undefined)
  assert.equal(normalizePercent(Number.POSITIVE_INFINITY), undefined)
  assert.equal(normalizePercent(-4), 0)
  assert.equal(normalizePercent(140), 100)
  assert.equal(normalizePercent(33.6), 34)
  assert.equal(renderPercentBar(50, 10), "[#####-----] 50%")

  const view = createProgressView()
  view.apply({ type: "progress", scope: "s", message: "m", percent: Number.NaN, at: 1 })
  assert.equal(view.snapshot().activity?.percent, undefined)
  view.apply({ type: "progress", scope: "s", message: "m", percent: 140, at: 2 })
  assert.equal(view.snapshot().activity?.percent, 100)
})

test("spinner frames advance only when the renderer ticks", () => {
  const view = createProgressView()
  const initial = view.frame()
  assert.equal(view.frame(), initial, "reading the frame does not advance it")
  assert.equal(view.frame(), initial, "wall-clock time alone cannot animate progress")
  const next = view.tick()
  assert.notEqual(next, initial)
  const frames = new Set([initial, next])
  for (let index = 0; index < 2; index++) frames.add(view.tick())
  assert.equal(frames.size, 4, "the default spinner cycles through four frames")
})

test("error details are sanitized and terminal sequences are stripped", () => {
  assert.equal(redactSecrets("token=s3cr3t"), "token=[redacted]")
  assert.equal(redactSecrets("password: hunter2"), "password=[redacted]")
  assert.equal(redactSecrets(`hash ${"a".repeat(64)}`), "hash [redacted]")
  assert.equal(redactSecrets("//user:_authToken=abc123"), "[redacted]")
  assert.equal(stripTerminalSequences("\u001b[31mred\u001b[0m"), "red")
  assert.equal(stripTerminalSequences("\u001b]0;title\u0007text"), "text")
  assert.equal(sanitizeErrorDetail(""), "The step failed without a reason.")
  assert.equal(sanitizeErrorDetail("failed\nwith\tspaces"), "failed with spaces")
  assert.equal(sanitizeErrorDetail("secret=abc"), "secret=[redacted]")
  assert.ok(sanitizeErrorDetail("x".repeat(500)).length <= 240)

  const view = createProgressView()
  view.apply({ type: "plan", title: "Plan", steps: planSteps(), at: 1 })
  view.apply({
    type: "step",
    id: "spicetify",
    status: "failed",
    detail: "\u001b[31mtoken=s3cr3t\u001b[0m",
    at: 2,
  })
  const error = view.snapshot().steps.find((step) => step.id === "spicetify")?.error ?? ""
  assert.equal(error, "token=[redacted]")
  assert.doesNotMatch(view.render(), /s3cr3t/)
})

test("logs are retained and rendered, redacted but never truncated away", () => {
  const view = createProgressView()
  const longLine = `npm ERR! ${"detail ".repeat(60)}token=s3cr3t`
  view.apply({ type: "log", level: "info", message: "Starting install", at: 1 })
  view.apply({ type: "log", level: "error", message: `first line\nsecond ${longLine}`, at: 2 })

  const snapshot = view.snapshot()
  assert.equal(snapshot.logs.length, 2)
  assert.equal(snapshot.logs[0]?.message, "Starting install")
  assert.match(snapshot.logs[1]?.message ?? "", /first line \| second/)
  assert.match(snapshot.logs[1]?.message ?? "", /token=\[redacted\]/)
  assert.doesNotMatch(snapshot.logs[1]?.message ?? "", /s3cr3t/)
  assert.ok((snapshot.logs[1]?.message.length ?? 0) > 240, "long log lines are kept in full")

  const rendered = view.render()
  assert.match(rendered, /Logs:/)
  assert.match(rendered, /Starting install/)
  assert.match(rendered, /first line \| second/)
})

test("retry is available only for failed steps with a registered safe handler", async () => {
  const view = createProgressView()
  view.apply({ type: "plan", title: "Plan", steps: planSteps(), at: 1 })
  view.apply({ type: "step", id: "bridge", status: "failed", detail: "copy failed", at: 2 })

  assert.equal(view.canRetry("bridge"), false)
  const unsupported = await view.retry("bridge")
  assert.equal(unsupported.ok, false)
  assert.equal(unsupported.reason, "unsupported")

  const missing = await view.retry("not-a-step")
  assert.equal(missing.reason, "unknown-step")

  let calls = 0
  view.registerRetry("bridge", async () => { calls += 1 })
  assert.equal(view.canRetry("bridge"), true)
  const notFailed = await view.retry("preflight")
  assert.equal(notFailed.reason, "not-failed")

  const result = await view.retry("bridge")
  assert.deepEqual(result, {
    ok: true,
    reason: "completed",
    message: 'Step "bridge" completed on retry.',
    attempts: 1,
  })
  assert.equal(calls, 1)
  const step = view.snapshot().steps.find((entry) => entry.id === "bridge")
  assert.equal(step?.status, "completed")
  assert.equal(step?.attempts, 1)
  assert.equal(step?.error, undefined)
  assert.match(view.render(), /Retries: 1/)
})

test("a failing retry stays failed with a sanitized reason and can be retried again", async () => {
  const view = createProgressView()
  view.apply({ type: "plan", title: "Plan", steps: planSteps(), at: 1 })
  view.apply({ type: "step", id: "spicetify", status: "failed", detail: "first failure", at: 2 })
  view.registerRetry("spicetify", async () => {
    throw new Error("still broken token=s3cr3t")
  })

  const result = await view.retry("spicetify")
  assert.equal(result.ok, false)
  assert.equal(result.reason, "handler-failed")
  assert.match(result.message, /token=\[redacted\]/)
  assert.doesNotMatch(result.message, /s3cr3t/)
  const step = view.snapshot().steps.find((entry) => entry.id === "spicetify")
  assert.equal(step?.status, "failed")
  assert.equal(step?.attempts, 1)
  assert.match(step?.error ?? "", /token=\[redacted\]/)
  assert.equal(view.canRetry("spicetify"), true, "a failed retry may be attempted again")
  assert.match(view.snapshot().logs.at(-1)?.message ?? "", /Retry failed for step "spicetify"/)
})

test("concurrent retries for the same step are refused", async () => {
  const view = createProgressView()
  view.apply({ type: "plan", title: "Plan", steps: planSteps(), at: 1 })
  view.apply({ type: "step", id: "bridge", status: "failed", at: 2 })

  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  view.registerRetry("bridge", () => gate)

  const first = view.retry("bridge")
  const second = await view.retry("bridge")
  assert.equal(second.ok, false)
  assert.equal(second.reason, "in-flight")
  release()
  assert.equal((await first).ok, true)
})

test("unregistering a retry handler removes support without touching step state", () => {
  const view = createProgressView()
  view.apply({ type: "plan", title: "Plan", steps: planSteps(), at: 1 })
  view.apply({ type: "step", id: "bridge", status: "failed", at: 2 })
  const remove = view.registerRetry("bridge", async () => {})
  assert.equal(view.canRetry("bridge"), true)
  remove()
  assert.equal(view.canRetry("bridge"), false)
  assert.equal(view.snapshot().steps.find((step) => step.id === "bridge")?.status, "failed")
})

test("final summary reports real counts, failures, logs, and restart instructions", () => {
  const view = createProgressView({ command: "opencode-spotify setup" })
  view.apply({ type: "plan", title: "Plan", steps: planSteps(), at: 1 })
  view.apply({ type: "step", id: "preflight", status: "ok", at: 2 })
  view.apply({ type: "step", id: "spicetify", status: "failed", detail: "installer exited 1", at: 3 })
  view.apply({ type: "step", id: "bridge", status: "skipped", at: 4 })
  view.apply({ type: "step", id: "apply", status: "skipped", at: 5 })
  view.apply({ type: "log", level: "error", message: "installer exited 1", at: 6 })
  view.apply({ type: "result", code: 1, at: 7 })

  const summary = view.summary()
  assert.match(summary, /^Summary/m)
  assert.match(summary, /1 completed, 1 failed, 2 skipped, 0 pending, 0 running \(4 total\)/)
  assert.match(summary, /spicetify: installer exited 1/)
  assert.match(summary, /Exit code: 1/)
  assert.match(summary, /rerun `opencode-spotify setup`/)
  assert.match(summary, /Completed steps are safe to repeat/)
  assert.match(summary, /1 entry retained; no output was hidden/)
  assert.match(view.render(), /Summary/)

  const success = createProgressView()
  success.apply({ type: "plan", title: "Plan", steps: planSteps().slice(0, 2), at: 1 })
  success.apply({ type: "step", id: "preflight", status: "ok", at: 2 })
  success.apply({ type: "step", id: "spicetify", status: "ok", at: 3 })
  success.apply({ type: "result", code: 0, at: 4 })
  const successSummary = success.summary()
  assert.match(successSummary, /2 completed, 0 failed/)
  assert.match(successSummary, /relaunch OpenCode/)
  assert.match(successSummary, /`opencode-spotify status`/)
  assert.doesNotMatch(successSummary, /rerun `opencode-spotify setup`/)
})

test("summary restart guidance can be overridden for command-specific recovery", () => {
  const view = createProgressView({ command: "opencode-spotify repair" })
  view.apply({ type: "plan", title: "Plan", steps: planSteps().slice(0, 1), at: 1 })
  view.apply({ type: "step", id: "preflight", status: "failed", at: 2 })
  const summary = view.summary({ restartHint: "close Spotify, then rerun `opencode-spotify repair --yes`" })
  assert.match(summary, /close Spotify, then rerun/)
  assert.doesNotMatch(summary, /fix the issue above/)
})

test("interactive children release Ink and restore it in order, even on failure", async () => {
  const calls: string[] = []
  const child = createInteractiveChild({
    ui: {
      suspend: async () => { calls.push("ui.suspend") },
      resume: async () => { calls.push("ui.resume") },
    },
    releaseInk: () => { calls.push("releaseInk") },
    restoreInk: () => { calls.push("restoreInk") },
  })

  const value = await child.run(async () => {
    calls.push("child")
    assert.equal(child.suspended, true)
    return 42
  })
  assert.equal(value, 42)
  assert.deepEqual(calls, ["ui.suspend", "releaseInk", "child", "restoreInk", "ui.resume"])
  assert.equal(child.suspended, false)
  assert.equal(child.active, false)

  calls.length = 0
  await assert.rejects(child.run(async () => {
    calls.push("child")
    throw new Error("child exploded")
  }), /child exploded/)
  assert.deepEqual(calls, ["ui.suspend", "releaseInk", "child", "restoreInk", "ui.resume"])
  assert.equal(child.suspended, false)
})

test("interactive children refuse nesting and do not run when release fails", async () => {
  const child = createInteractiveChild()
  await child.run(async () => {
    await assert.rejects(child.run(async () => {}), /already running/)
  })

  let ran = false
  const blocked = createInteractiveChild({
    ui: { suspend: async () => { throw new Error("cannot suspend Ink") } },
  })
  await assert.rejects(blocked.run(async () => { ran = true }), /cannot suspend Ink/)
  assert.equal(ran, false)
  assert.equal(blocked.suspended, false)
})

test("restore hook failures surface after a successful child instead of being swallowed", async () => {
  const child = createInteractiveChild({
    restoreInk: () => { throw new Error("restore failed") },
  })
  await assert.rejects(child.run(async () => "done"), /restore failed/)
  assert.equal(child.suspended, false)
})

test("disposing an interactive child resumes a manually suspended terminal", async () => {
  const calls: string[] = []
  const child = createInteractiveChild({
    ui: {
      suspend: async () => { calls.push("suspend") },
      resume: async () => { calls.push("resume") },
    },
  })
  await child.suspend()
  await child.suspend()
  assert.deepEqual(calls, ["suspend"], "suspending twice releases once")
  assert.equal(child.suspended, true)
  await child.dispose()
  assert.deepEqual(calls, ["suspend", "resume"])
  await assert.rejects(child.run(async () => {}), /already closed/)
})

test("terminal restoration runs once on exit and removes its listeners", () => {
  const proc = fakeTerminal()
  const written: string[] = []
  let restores = 0
  const guard = createTerminalRestoration({
    write: (chunk) => written.push(chunk),
    restore: () => { restores += 1 },
    proc,
  })

  guard.install()
  assert.equal(guard.installed, true)
  assert.equal(proc.listenerCount("exit"), 1)
  assert.equal(proc.listenerCount("SIGINT"), 1)
  assert.equal(proc.listenerCount("SIGTERM"), 1)

  proc.fire("exit")
  proc.fire("exit")
  assert.deepEqual(written, [RESTORE_SEQUENCE])
  assert.equal(restores, 1)
  assert.equal(guard.restored, true)

  guard.dispose()
  assert.equal(guard.installed, false)
  assert.equal(proc.listenerCount("exit"), 0)
  assert.equal(proc.listenerCount("SIGINT"), 0)
})

test("signal handling restores the terminal then re-raises the same signal", () => {
  const proc = fakeTerminal()
  const written: string[] = []
  const guard = createTerminalRestoration({
    write: (chunk) => written.push(chunk),
    proc,
    signals: ["SIGINT"],
  })
  guard.install()
  proc.fire("SIGINT")

  assert.deepEqual(written, [RESTORE_SEQUENCE])
  assert.ok(proc.events.includes(`kill:${proc.pid}:SIGINT`), "default signal semantics survive")
  assert.equal(guard.installed, false)
  assert.equal(proc.listenerCount("SIGINT"), 0)
  assert.equal(proc.listenerCount("exit"), 0)
})

test("an explicit exit code can replace signal re-raising", () => {
  const proc = fakeTerminal()
  const guard = createTerminalRestoration({
    write: () => {},
    proc,
    signals: ["SIGTERM"],
    exitCodeOnSignal: 130,
  })
  guard.install()
  proc.fire("SIGTERM")
  assert.ok(proc.events.includes("exit:130"))
  assert.ok(!proc.events.some((event) => event.startsWith("kill")))
})

test("the reporter adapter stamps timestamps and never synthesizes percentages", () => {
  let clock = 100
  const view = createProgressView()
  const report = createProgressReporter(view, () => clock++)

  report.phase("execute", "Executing")
  report.step("preflight", "running")
  report.progress("bridge", "Copying")
  report.log("info", "hello")
  report.prompt(null)

  const snapshot = view.snapshot()
  assert.equal(snapshot.phase, "execute")
  assert.equal(snapshot.phaseLabel, "Executing")
  assert.equal(snapshot.steps[0]?.status, "current")
  assert.equal(snapshot.activity?.message, "Copying")
  assert.equal(snapshot.activity?.percent, undefined)
  assert.equal(snapshot.logs[0]?.message, "hello")
  assert.equal(snapshot.logs[0]?.at, 103)

  clock = 200_000
  report.progress("bridge", "Still copying")
  assert.equal(view.snapshot().activity?.percent, undefined)
  assert.doesNotMatch(view.render(), /\d+%/)
})

test("progress views are shareable: subscribers and onChange see real state", () => {
  const changes: string[] = []
  const stepped: string[] = []
  const view = createProgressView({
    onChange: (snapshot) => changes.push(snapshot.logs.length === 0 ? "no-logs" : "log"),
  })
  const unsubscribe = view.subscribe((snapshot) => {
    stepped.push(`${snapshot.counts.total}:${snapshot.logs.length}`)
  })

  view.apply({ type: "plan", title: "Plan", steps: planSteps(), at: 1 })
  view.apply({ type: "log", level: "info", message: "hello", at: 2 })
  assert.deepEqual(changes, ["no-logs", "log"])
  assert.deepEqual(stepped, ["4:0", "4:1"])

  unsubscribe()
  view.apply({ type: "log", level: "info", message: "after unsubscribe", at: 3 })
  assert.deepEqual(stepped, ["4:0", "4:1"], "unsubscribed listeners stop receiving updates")
  assert.deepEqual(changes, ["no-logs", "log", "log"])
})

test("a finished view stops the spinner and shows the summary inline", () => {
  const view = createProgressView()
  view.apply({ type: "plan", title: "Plan", steps: planSteps().slice(0, 1), at: 1 })
  view.apply({ type: "step", id: "preflight", status: "running", at: 2 })
  assert.match(view.render(), /\[-\] 1\. Check environment/)

  view.apply({ type: "step", id: "preflight", status: "ok", at: 3 })
  view.apply({ type: "result", code: 0, at: 4 })
  const rendered = view.render()
  assert.match(rendered, /\[x\] 1\. Check environment/)
  assert.match(rendered, /Summary/)
  assert.doesNotMatch(view.render(), /Working\.\.\./)
})
