import test from "node:test"
import assert from "node:assert/strict"
import {
  ACTIVITY_LIMIT,
  createInstallerSnapshot,
  createInstallerStore,
  reduceInstaller,
  sanitizeMessage,
} from "../src/cli/state.ts"
import { createNoopReporter, createStoreReporter } from "../src/cli/progress.ts"
import { createPlainPresentation, createPlainReporter } from "../src/cli/ui-mode.ts"
import { executePlan, maybeApplyBridge, planExitCode, resolveWorkflowDeps, runPlanSteps } from "../src/cli/plan.ts"
import { createCancelToken, OperationCancelled } from "../src/cli/cancel.ts"
import { context, fakePrompt, fakeReport, fakeRuntime, fakeUi } from "./cli-fixture.ts"
import type {
  InstallerSnapshot,
  OperationContext,
  PlanStep,
  PlanStepView,
  ProgressEvent,
} from "../src/cli/types.ts"

function snapshot(): InstallerSnapshot {
  return createInstallerSnapshot({
    command: "setup",
    mode: "plain",
    version: "0.6.0-beta.3",
    windows: true,
    startedAt: 1,
  })
}

function view(id: string, description: string, mutates = true): PlanStepView {
  return { id, description, mutates, status: "pending" }
}

function withoutReport(ctx: ReturnType<typeof context>): ReturnType<typeof context> {
  return { ...ctx, report: undefined }
}

test("reduceInstaller is pure and never mutates prior state", () => {
  const base = snapshot()
  const before = structuredClone(base)
  const event: ProgressEvent = {
    type: "plan",
    title: "Demo",
    steps: [view("a", "first")],
    at: 2,
  }
  const next = reduceInstaller(base, event)
  assert.deepEqual(base, before, "input snapshot is untouched")
  assert.notEqual(next, base)
  assert.notEqual(next.plan, base.plan)
  assert.equal(next.phase, "plan")
  assert.deepEqual(next.plan?.steps.map((step) => step.status), ["pending"])
  assert.deepEqual(next, reduceInstaller(base, event), "same input yields the same output")
})

test("activity is bounded to the newest entries", () => {
  let state = snapshot()
  for (let index = 0; index < ACTIVITY_LIMIT + 5; index++) {
    state = reduceInstaller(state, { type: "log", level: "info", message: `line ${index}`, at: index })
  }
  assert.equal(state.activity.length, ACTIVITY_LIMIT)
  assert.equal(state.activity[0]?.message, "line 5")
  assert.equal(state.activity.at(-1)?.message, `line ${ACTIVITY_LIMIT + 4}`)
  assert.ok(!state.activity.some((entry) => entry.message === "line 0"))
})

test("activity and step detail are redacted through sanitizeMessage", () => {
  const secret = "a".repeat(64)
  let state = reduceInstaller(snapshot(), {
    type: "plan",
    title: `credential token=${secret}`,
    steps: [view("b", `write secret=${secret}`)],
    at: 1,
  })
  state = reduceInstaller(state, { type: "log", level: "error", message: `secret=${secret}`, at: 2 })
  state = reduceInstaller(state, {
    type: "step",
    id: "b",
    status: "failed",
    detail: `token=${secret}`,
    at: 3,
  })
  const serialized = JSON.stringify(state)
  assert.ok(!serialized.includes(secret), "no raw secret is retained")
  assert.ok(serialized.includes("[redacted]"))
  assert.equal(state.activity.at(-1)?.message, "secret=[redacted]")
  assert.equal(state.plan?.steps[0]?.detail, "token=[redacted]")
  assert.equal(sanitizeMessage(`token=${secret}`), "token=[redacted]")
})

test("store exposes a stable snapshot and notifies subscribers once per change", () => {
  const store = createInstallerStore(snapshot())
  const first = store.getSnapshot()
  assert.equal(store.getSnapshot(), first, "stable between dispatches")
  let calls = 0
  const unsubscribe = store.subscribe(() => {
    calls++
  })
  store.dispatch({ type: "log", level: "info", message: "first", at: 1 })
  assert.equal(calls, 1)
  assert.notEqual(store.getSnapshot(), first)
  const afterFirst = store.getSnapshot()

  unsubscribe()
  store.dispatch({ type: "log", level: "info", message: "second", at: 2 })
  assert.equal(calls, 1, "unsubscribed listener is not called")
  assert.notEqual(store.getSnapshot(), afterFirst)

  createStoreReporter(store, () => 9).log("warn", "third")
  assert.equal(store.getSnapshot().activity.at(-1)?.message, "third")
  assert.equal(store.getSnapshot().activity.at(-1)?.at, 9)
  assert.doesNotThrow(() => createNoopReporter().log("debug", "hidden"))
})

test("plain reporter maps events to the legacy Ui strings", () => {
  const ui = fakeUi()
  const report = createPlainReporter(ui)
  report.emit({
    type: "plan",
    title: "Demo",
    steps: [view("a", "first"), view("b", "second", false), view("c", "third")],
    at: 0,
  })
  report.step("a", "running")
  report.step("a", "ok")
  report.step("b", "failed", "boom")
  report.step("c", "skipped")
  report.log("warn", "careful")
  report.log("debug", "hidden without verbose")
  report.log("success", "Plan completed.")
  report.progress("apply", "Running spicetify apply.")
  report.emit({ type: "result", code: 1, at: 1 })

  assert.deepEqual(ui.lines, [
    "Demo",
    "1. first",
    "2. second (verification only)",
    "3. third",
    "ok: first",
    "error: Stopped at: b - second",
    "   Reason: boom",
    "   Completed stages: a",
    "   Not run: c",
    "warn: careful",
    "debug: hidden without verbose",
    "ok: Plan completed.",
    "  Running spicetify apply.",
  ])

  const dryUi = fakeUi()
  const dryReport = createPlainReporter(dryUi)
  dryReport.emit({ type: "plan", title: "Dry", steps: [view("x", "mutate")], at: 0 })
  dryReport.step("x", "skipped", "dry-run")
  dryReport.log("info", "  Dry run: no changes were made.")
  dryReport.emit({ type: "result", code: 0, at: 1 })
  assert.deepEqual(dryUi.lines, ["Dry", "1. mutate", "dry: mutate", "  Dry run: no changes were made."])
})

test("executePlan emits ordered progress events and keeps secrets out", async () => {
  const secret = "b".repeat(64)
  const report = fakeReport()
  const ui = fakeUi()
  const ctx = context(fakeRuntime(), ui, fakePrompt(), { yes: true }, undefined, report)

  const outcome = await executePlan(ctx, "Demo", [
    { id: "a", description: "first", mutates: true, run: async () => {} },
    { id: "b", description: "second", mutates: true, run: async () => { throw new Error(`secret=${secret}`) } },
    { id: "c", description: "third", mutates: true, run: async () => {} },
  ])

  assert.equal(outcome.status, "failed")
  assert.deepEqual(outcome.completed, ["a"])
  assert.deepEqual(outcome.skipped, ["c"])
  assert.equal(planExitCode(outcome), 1)

  const sequence = report.events.map((event) =>
    event.type === "step" ? `step:${event.id}:${event.status}` : event.type,
  )
  assert.deepEqual(sequence, [
    "plan",
    "step:a:running",
    "step:a:ok",
    "step:b:running",
    "step:b:failed",
    "step:c:skipped",
    "result",
  ])

  const failed = report.events.find(
    (event): event is Extract<ProgressEvent, { type: "step" }> =>
      event.type === "step" && event.status === "failed",
  )
  assert.ok(failed)
  assert.equal(failed.detail, "secret=[redacted]")
  const result = report.events.at(-1)
  assert.equal(result?.type, "result")
  if (result?.type === "result") assert.equal(result.code, 1)
  assert.ok(!JSON.stringify(report.events).includes(secret))
  assert.deepEqual(ui.lines, [], "Ui writes are delegated to the reporter")
})

test("dry-run, cancellation, and missing confirmation keep legacy exit codes", async () => {
  const ran: string[] = []
  const steps = (): PlanStep[] => [
    { id: "x", description: "mutate", mutates: true, run: async () => { ran.push("x") } },
  ]

  const dryReport = fakeReport()
  const dry = await executePlan(
    context(fakeRuntime(), fakeUi(), fakePrompt(), { dryRun: true }, undefined, dryReport),
    "Dry",
    steps(),
  )
  assert.equal(dry.status, "dry-run")
  assert.equal(planExitCode(dry), 0)
  assert.deepEqual(dry.skipped, ["x"])
  assert.ok(dryReport.events.some((event) => event.type === "step" && event.status === "skipped"))
  const dryResult = dryReport.events.at(-1)
  assert.equal(dryResult?.type, "result")
  if (dryResult?.type === "result") assert.equal(dryResult.code, 0)

  const cancelledReport = fakeReport()
  const cancelled = await executePlan(
    context(fakeRuntime(), fakeUi(), fakePrompt({ confirms: [false] }), { yes: false }, undefined, cancelledReport),
    "Cancel",
    steps(),
  )
  assert.equal(cancelled.status, "cancelled")
  assert.equal(planExitCode(cancelled), 130)
  const cancelResult = cancelledReport.events.at(-1)
  assert.equal(cancelResult?.type, "result")
  if (cancelResult?.type === "result") assert.equal(cancelResult.code, 130)

  const requiredReport = fakeReport()
  const required = await executePlan(
    context(
      fakeRuntime(),
      fakeUi(),
      fakePrompt(),
      { yes: false, nonInteractive: true },
      undefined,
      requiredReport,
    ),
    "Required",
    steps(),
  )
  assert.equal(required.status, "confirmation-required")
  assert.equal(planExitCode(required), 2)
  const requiredResult = requiredReport.events.at(-1)
  assert.equal(requiredResult?.type, "result")
  if (requiredResult?.type === "result") assert.equal(requiredResult.code, 2)
  assert.deepEqual(ran, [], "no mutating step ever ran")
})

test("cancellation before the first step runs nothing and returns 130", async () => {
  const cancel = createCancelToken()
  cancel.request("sigint")
  const report = fakeReport()
  const ran: string[] = []
  const ctx = context(fakeRuntime(), fakeUi(), fakePrompt(), { yes: true }, undefined, report, cancel)

  const outcome = await executePlan(ctx, "Cancelled", [
    { id: "a", description: "first", mutates: true, run: async () => { ran.push("a") } },
    { id: "b", description: "second", mutates: true, run: async () => { ran.push("b") } },
  ])

  assert.deepEqual(ran, [], "no step starts")
  assert.equal(outcome.status, "cancelled")
  assert.equal(planExitCode(outcome), 130)
  assert.deepEqual(outcome.skipped, ["a", "b"])
  assert.equal(outcome.interrupted, true)
  assert.equal(cancel.phase, "cancelled")
  assert.ok(!report.events.some((event) => event.type === "step" && event.status === "running"))
  assert.ok(report.events.some((event) => event.type === "cancel" && event.phase === "requested"))
  assert.ok(report.events.some((event) => event.type === "cancel" && event.phase === "settled"))
  const result = report.events.at(-1)
  assert.equal(result?.type, "result")
  if (result?.type === "result") assert.equal(result.code, 130)
})

test("cancellation between steps skips the remaining steps and returns 130", async () => {
  const cancel = createCancelToken()
  const report = fakeReport()
  const ran: string[] = []
  const ctx = context(fakeRuntime(), fakeUi(), fakePrompt(), { yes: true }, undefined, report, cancel)

  const outcome = await executePlan(ctx, "Between", [
    { id: "a", description: "first", mutates: true, run: async () => { ran.push("a"); cancel.request("sigint") } },
    { id: "b", description: "second", mutates: true, run: async () => { ran.push("b") } },
    { id: "c", description: "third", mutates: true, run: async () => { ran.push("c") } },
  ])

  assert.deepEqual(ran, ["a"], "the next step never starts")
  assert.equal(outcome.status, "cancelled")
  assert.equal(planExitCode(outcome), 130)
  assert.deepEqual(outcome.completed, ["a"])
  assert.deepEqual(outcome.skipped, ["b", "c"])
  assert.equal(outcome.partial, undefined)
  assert.equal(cancel.phase, "cancelled")
  const sequence = report.events.map((event) =>
    event.type === "step" ? `step:${event.id}:${event.status}` : event.type,
  )
  assert.ok(sequence.includes("step:a:ok"))
  assert.ok(!sequence.includes("step:b:running"))
  assert.ok(sequence.includes("step:b:skipped"))
  const result = report.events.at(-1)
  if (result?.type === "result") assert.equal(result.code, 130)
})

test("a protected step finishes before cancellation stops the plan (partial, 130)", async () => {
  const cancel = createCancelToken()
  const report = fakeReport()
  const ran: string[] = []
  const ctx = context(fakeRuntime(), fakeUi(), fakePrompt(), { yes: true }, undefined, report, cancel)

  const outcome = await executePlan(ctx, "Protected", [
    {
      id: "protected-step",
      description: "long mutation",
      mutates: true,
      interrupt: "protected",
      run: async () => {
        cancel.request("sigint")
        await Promise.resolve()
        ran.push("protected-step")
      },
    },
    { id: "next", description: "next mutation", mutates: true, run: async () => { ran.push("next") } },
  ])

  assert.deepEqual(ran, ["protected-step"], "the protected step completed; nothing else ran")
  assert.equal(outcome.status, "cancelled")
  assert.equal(planExitCode(outcome), 130)
  assert.equal(outcome.partial, true)
  assert.deepEqual(outcome.completed, ["protected-step"])
  assert.deepEqual(outcome.skipped, ["next"])
  assert.equal(cancel.phase, "partial")
  const phases = report.events.filter((event) => event.type === "cancel").map((event) => event.phase)
  assert.deepEqual(phases, ["requested", "finishing", "settled"])
  const sequence = report.events.map((event) =>
    event.type === "step" ? `step:${event.id}:${event.status}` : event.type,
  )
  assert.ok(sequence.indexOf("step:protected-step:ok") < sequence.indexOf("step:next:skipped"))
  const result = report.events.at(-1)
  if (result?.type === "result") assert.equal(result.code, 130)
})

test("an abort step that throws OperationCancelled is cancelled, not failed (130)", async () => {
  const cancel = createCancelToken()
  const report = fakeReport()
  const ctx = context(fakeRuntime(), fakeUi(), fakePrompt(), { yes: true }, undefined, report, cancel)

  const outcome = await executePlan(ctx, "Abort", [
    {
      id: "abort-step",
      description: "interruptible read",
      mutates: false,
      interrupt: "abort",
      run: async () => {
        cancel.request("sigint")
        throw new OperationCancelled("abort-step")
      },
    },
    { id: "after", description: "after", mutates: true, run: async () => { throw new Error("must not run") } },
  ])

  assert.equal(outcome.status, "cancelled", "an aborted step is not a failure")
  assert.equal(planExitCode(outcome), 130)
  assert.deepEqual(outcome.skipped, ["after"])
  const step = report.events.find(
    (event): event is Extract<ProgressEvent, { type: "step" }> =>
      event.type === "step" && event.id === "abort-step" && event.status === "skipped",
  )
  assert.ok(step)
  assert.equal(step.detail, "cancelled")
  const result = report.events.at(-1)
  if (result?.type === "result") assert.equal(result.code, 130)
})

test("a real failure wins over a concurrent cancellation (exit code 1)", async () => {
  const cancel = createCancelToken()
  const report = fakeReport()
  const ctx = context(fakeRuntime(), fakeUi(), fakePrompt(), { yes: true }, undefined, report, cancel)

  const outcome = await executePlan(ctx, "Failure", [
    {
      id: "broken",
      description: "broken step",
      mutates: true,
      run: async () => {
        cancel.request("sigint")
        throw new Error("boom")
      },
    },
  ])

  assert.equal(outcome.status, "failed")
  assert.equal(outcome.failed, "broken")
  assert.equal(outcome.error, "boom")
  assert.equal(planExitCode(outcome), 1)
  const result = report.events.at(-1)
  assert.equal(result?.type, "result")
  if (result?.type === "result") assert.equal(result.code, 1)
})

test("completed plans emit plan and described step events in order", async () => {
  const report = fakeReport()
  const ctx = context(fakeRuntime(), fakeUi(), fakePrompt(), { yes: true }, undefined, report)

  const outcome = await executePlan(ctx, "Ordered", [
    { id: "a", description: "first thing", mutates: true, run: async () => {} },
    { id: "b", description: "second thing", mutates: false, run: async () => {} },
  ])

  assert.equal(outcome.status, "completed")
  assert.equal(planExitCode(outcome), 0)
  const sequence = report.events.map((event) =>
    event.type === "step" ? `step:${event.id}:${event.status}` : event.type,
  )
  assert.deepEqual(sequence, [
    "plan",
    "step:a:running",
    "step:a:ok",
    "step:b:running",
    "step:b:ok",
    "log",
    "result",
  ])
  const plan = report.events.find((event) => event.type === "plan")
  assert.ok(plan)
  if (plan?.type === "plan") {
    assert.deepEqual(plan.steps.map((step) => step.description), ["first thing", "second thing"])
  }
  for (const event of report.events) {
    if (event.type !== "step") continue
    assert.equal(event.description, event.id === "a" ? "first thing" : "second thing")
  }
})

test("runPlanSteps is the shared runner: it announces, runs and settles once", async () => {
  const cancel = createCancelToken()
  const report = fakeReport()
  const ctx = context(fakeRuntime(), fakeUi(), fakePrompt(), { yes: true }, undefined, report, cancel)
  const ran: string[] = []

  const outcome = await runPlanSteps([
    { id: "one", description: "do one", mutates: true, run: async () => { ran.push("one") } },
  ], ctx, { title: "Shared plan" })

  assert.deepEqual(ran, ["one"])
  assert.equal(outcome.status, "completed")
  const plan = report.events[0]
  assert.equal(plan?.type, "plan")
  if (plan?.type === "plan") assert.equal(plan.title, "Shared plan")
  const step = report.events.find(
    (event): event is Extract<ProgressEvent, { type: "step" }> =>
      event.type === "step" && event.status === "ok",
  )
  assert.equal(step?.description, "do one")
})

test("a cancelled apply reports 130, never a failure, and keeps the bridge pending", async () => {
  const cancel = createCancelToken()
  cancel.request("sigint")
  const ctx = context(fakeRuntime(), fakeUi(), fakePrompt(), { apply: true, yes: true }, undefined, fakeReport(), cancel)
  const outcome = await maybeApplyBridge(
    ctx,
    "C:\\Users\\Test\\AppData\\Local\\spicetify\\spicetify.exe",
    true,
  )
  assert.equal(outcome.code, 130)
  assert.equal(outcome.applied, false)
})

test("cancellation during a protected apply still finishes and verifies it", async () => {
  const runtime = fakeRuntime()
  const cancel = createCancelToken()
  const ui = fakeUi()
  const ctx = context(runtime, ui, fakePrompt(), { apply: true, yes: true }, undefined, fakeReport(), cancel)
  const realRun = runtime.run.bind(runtime)
  runtime.run = (async (file: string, args: string[], options?: unknown) => {
    const result = await realRun(file, args, options as never)
    if (args.join(" ") === "apply") cancel.request("sigint")
    return result
  }) as typeof runtime.run

  const outcome = await maybeApplyBridge(
    ctx,
    "C:\\Users\\Test\\AppData\\Local\\spicetify\\spicetify.exe",
    true,
  )
  assert.equal(outcome.applied, true, "the protected apply completed")
  assert.equal(outcome.code, 130, "cancellation is reported as 130, not 1")
  assert.equal(cancel.phase, "partial")
})

test("plain reporter reproduces executePlan's console output byte-for-byte", async () => {
  const successSteps = (): PlanStep[] => [
    { id: "a", description: "first", mutates: true, run: async () => {} },
    { id: "b", description: "second", mutates: false, run: async () => {} },
  ]
  const legacyUi = fakeUi()
  const legacy = await executePlan(
    withoutReport(context(fakeRuntime(), legacyUi, fakePrompt(), { yes: true })),
    "Demo",
    successSteps(),
  )
  const plainUi = fakeUi()
  const plain = await executePlan(
    context(fakeRuntime(), plainUi, fakePrompt(), { yes: true }, undefined, createPlainReporter(plainUi)),
    "Demo",
    successSteps(),
  )
  assert.equal(plain.status, "completed")
  assert.equal(legacy.status, "completed")
  assert.deepEqual(plainUi.lines, legacyUi.lines)

  const failureSteps = (): PlanStep[] => [
    { id: "a", description: "first", mutates: true, run: async () => {} },
    { id: "b", description: "second", mutates: true, run: async () => { throw new Error(`token=${"c".repeat(40)}`) } },
  ]
  const legacyFailUi = fakeUi()
  await executePlan(
    withoutReport(context(fakeRuntime(), legacyFailUi, fakePrompt(), { yes: true })),
    "Demo",
    failureSteps(),
  )
  const plainFailUi = fakeUi()
  await executePlan(
    context(fakeRuntime(), plainFailUi, fakePrompt(), { yes: true }, undefined, createPlainReporter(plainFailUi)),
    "Demo",
    failureSteps(),
  )
  assert.deepEqual(plainFailUi.lines, legacyFailUi.lines)
  assert.ok(!plainFailUi.lines.join("\n").includes("c".repeat(40)))
})

test("executePlan through createPlainPresentation().report keeps legacy strings", async () => {
  const run = async (steps: PlanStep[], options: Partial<OperationContext["options"]> = { yes: true }) => {
    const lines: string[] = []
    const presentation = createPlainPresentation(
      { out: (line) => lines.push(line), err: (line) => lines.push(line) },
      { color: false, json: false, io: { stdoutTTY: false, stdinTTY: false, env: {} } },
    )
    try {
      const base = context(
        fakeRuntime(),
        fakeUi(),
        fakePrompt(),
        options,
        undefined,
        presentation.report,
      )
      const ctx: OperationContext = { ...base, ui: presentation.ui, prompt: presentation.prompt }
      const outcome = await executePlan(ctx, "Demo", steps)
      return { outcome, lines: lines.filter((line) => line !== "") }
    } finally {
      await presentation.close()
    }
  }

  const success = await run([
    { id: "a", description: "first", mutates: true, run: async () => {} },
    { id: "b", description: "second", mutates: false, run: async () => {} },
  ])
  assert.equal(success.outcome.status, "completed")
  assert.deepEqual(success.lines, [
    "Demo",
    "   - 1. first",
    "   - 2. second (verification only)",
    "  [OK] first",
    "  [OK] second",
    "  [OK] Plan completed.",
  ])

  const failure = await run([
    { id: "a", description: "first", mutates: true, run: async () => {} },
    { id: "b", description: "second", mutates: true, run: async () => { throw new Error("boom") } },
    { id: "c", description: "third", mutates: true, run: async () => {} },
  ])
  assert.equal(failure.outcome.status, "failed")
  assert.deepEqual(failure.lines, [
    "Demo",
    "   - 1. first",
    "   - 2. second",
    "   - 3. third",
    "  [OK] first",
    "  [XX] Stopped at: b - second",
    "   Reason: boom",
    "   Completed stages: a",
    "   Not run: c",
  ])
  assert.ok(!failure.lines.some((line) => line.includes("(pending)")))

  // B24 apply progress keeps the bare two-space wording (no "apply:" prefix).
  const applyLines: string[] = []
  const applyPresentation = createPlainPresentation(
    { out: (line) => applyLines.push(line), err: (line) => applyLines.push(line) },
    { color: false, json: false, io: { stdoutTTY: false, stdinTTY: false, env: {} } },
  )
  try {
    const base = context(
      fakeRuntime(),
      fakeUi(),
      fakePrompt(),
      { apply: true, yes: true },
      undefined,
      applyPresentation.report,
    )
    const ctx: OperationContext = { ...base, ui: applyPresentation.ui, prompt: applyPresentation.prompt }
    const applied = await maybeApplyBridge(
      ctx,
      "C:\\Users\\Test\\AppData\\Local\\spicetify\\spicetify.exe",
      true,
    )
    assert.equal(applied.code, 0)
  } finally {
    await applyPresentation.close()
  }
  assert.ok(applyLines.includes("  Spicetify backup not found; creating a backup before apply."))
  assert.ok(applyLines.includes("  Running spicetify apply."))
  assert.ok(!applyLines.some((line) => line.includes("apply: Running")))
})

test("bridge apply progress is forwarded as progress(apply)", async () => {
  const report = fakeReport()
  const ctx = context(fakeRuntime(), fakeUi(), fakePrompt(), { apply: true, yes: true }, undefined, report)
  const outcome = await maybeApplyBridge(
    ctx,
    "C:\\Users\\Test\\AppData\\Local\\spicetify\\spicetify.exe",
    true,
  )
  assert.equal(outcome.code, 0)
  assert.equal(outcome.applied, true)
  const progress = report.events.filter(
    (event): event is Extract<ProgressEvent, { type: "progress" }> => event.type === "progress",
  )
  assert.ok(progress.length > 0)
  assert.ok(progress.every((event) => event.scope === "apply"))
  assert.ok(progress.some((event) => event.message.includes("spicetify apply")))

  // Without a reporter the legacy two-space line is unchanged.
  const legacyUi = fakeUi()
  const legacy = withoutReport(context(fakeRuntime(), legacyUi, fakePrompt(), { apply: true, yes: true }))
  const legacyOutcome = await maybeApplyBridge(
    legacy,
    "C:\\Users\\Test\\AppData\\Local\\spicetify\\spicetify.exe",
    true,
  )
  assert.equal(legacyOutcome.code, 0)
  assert.ok(legacyUi.lines.includes("  Running spicetify apply."))
})

test("opencode child output forwards as bounded debug log events without secrets", async () => {
  const report = fakeReport()
  const ctx = context(fakeRuntime(), fakeUi(), fakePrompt(), {}, undefined, report)
  const deps = resolveWorkflowDeps({
    addGlobalPlugin: async () => ({
      code: 0,
      stdout: `added opencode-spotify\ntoken=${"d".repeat(48)}\n`,
      stderr: "",
    }),
  }, ctx)
  await deps.addGlobalPlugin(ctx.runtime, "opencode-spotify@1.0.0")
  const logs = report.events.filter(
    (event): event is Extract<ProgressEvent, { type: "log" }> => event.type === "log",
  )
  assert.equal(logs.length, 2)
  assert.ok(logs.every((event) => event.level === "debug"))
  assert.ok(logs.some((event) => event.message === "added opencode-spotify"))
  assert.ok(!JSON.stringify(logs).includes("d".repeat(48)))
})
