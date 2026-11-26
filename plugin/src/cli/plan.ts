// Plan presentation, consent, and shared workflow dependencies.
//
// Every mutating command builds PlanSteps and routes them through
// executePlan(), which:
//   * shows the full plan before doing anything,
//   * never runs a mutating step during --dry-run,
//   * requires --yes or an explicit interactive confirmation,
//   * stops at the first failure and reports completed/remaining stages.
//
// The dependency surface keeps workflows testable with a fake Runtime/Ui/
// Prompter without weakening the production defaults, which delegate to the
// real opencode/spicetify/bridge modules.
import { addGlobalPlugin, isPathLikeSource, projectPlugins, removeGlobalPlugin } from "./opencode.ts"
import { installSpicetify, upgradeSpicetify } from "./spicetify.ts"
import { applyBridge, bridgeOperation, removeCredentials } from "./bridge.ts"
import { isCancellation, OperationCancelled } from "./cancel.ts"
import type { CancelToken } from "./cancel.ts"
import { detectEnvironment } from "./detect.ts"
import { githubLatest, npmLatest } from "./versions.ts"
import {
  PLAN_MESSAGES,
  sanitizeMessage,
} from "./state.ts"
import type {
  CommandResult,
  Detection,
  Logger,
  LogLevel,
  OperationContext,
  PlanStep,
  ProgressEvent,
  ProgressReporter,
  Runtime,
  SpicetifyInfo,
  VersionInfo,
} from "./types.ts"

// Re-exported for existing callers (setup.ts imports sanitizeMessage from here).
export { sanitizeMessage }

export interface ProjectPluginEntry {
  id: string
  version: string
  source: string
}

export interface SpicetifyInstallActionOptions {
  /** Always false in practice: executePlan owns dry-run handling. */
  dryRun: boolean
  log: Logger
}

export interface SpicetifyUpgradeActionOptions {
  dryRun: boolean
  log: Logger
}

export interface BridgeActionOptions {
  spicetifyPath: string | null
  dryRun: boolean
  yes: boolean
}

/** Every side effect a workflow can perform, except detection/registry reads. */
export interface WorkflowDeps {
  detect(runtime: Runtime): Promise<Detection>
  latestPlugin(runtime: Runtime, offline: boolean): Promise<VersionInfo>
  latestSpicetify(runtime: Runtime, offline: boolean): Promise<VersionInfo>
  addGlobalPlugin(runtime: Runtime, spec: string): Promise<CommandResult>
  removeGlobalPlugin(runtime: Runtime, spec: string): Promise<CommandResult>
  projectPlugins(runtime: Runtime): Promise<ProjectPluginEntry[]>
  installSpicetify(runtime: Runtime, info: SpicetifyInfo, options: SpicetifyInstallActionOptions): Promise<CommandResult>
  upgradeSpicetify(runtime: Runtime, info: SpicetifyInfo, options: SpicetifyUpgradeActionOptions): Promise<CommandResult>
  bridgeOperation(runtime: Runtime, operation: "install" | "repair" | "uninstall", options: BridgeActionOptions): Promise<CommandResult>
  applyBridge(
    runtime: Runtime,
    options: { spicetifyPath: string | null; onProgress?: (line: string) => void },
  ): Promise<CommandResult>
  removeCredentials(runtime: Runtime): Promise<CommandResult>
}

export const defaultWorkflowDeps: WorkflowDeps = {
  detect: (runtime) => detectEnvironment(runtime),
  latestPlugin: (runtime, offline) => npmLatest(runtime, "opencode-spotify", offline),
  latestSpicetify: (runtime, offline) => githubLatest(runtime, "spicetify/cli", offline),
  addGlobalPlugin: (runtime, spec) => addGlobalPlugin(runtime, spec),
  removeGlobalPlugin: (runtime, spec) => removeGlobalPlugin(runtime, spec),
  projectPlugins: (runtime) => projectPlugins(runtime),
  installSpicetify: (runtime, info, options) =>
    installSpicetify(runtime, info, {
      dryRun: options.dryRun,
      // executePlan has already obtained the user's approval.
      approve: async () => true,
      log: options.log,
    }),
  upgradeSpicetify: (runtime, info, options) =>
    upgradeSpicetify(runtime, info, {
      dryRun: options.dryRun,
      approve: async () => true,
      log: options.log,
    }),
  bridgeOperation: (runtime, operation, options) => bridgeOperation(runtime, operation, options),
  applyBridge: (runtime, options) => applyBridge(runtime, options),
  removeCredentials: (runtime) => removeCredentials(runtime),
}

export function resolveWorkflowDeps(
  overrides: Partial<WorkflowDeps> = {},
  ctx?: OperationContext,
): WorkflowDeps {
  const deps = { ...defaultWorkflowDeps, ...overrides }
  if (!ctx) return deps
  // Forward opencode child stdout/stderr as debug log events (or the legacy
  // two-space Ui lines when no reporter is attached).
  return {
    ...deps,
    addGlobalPlugin: async (runtime, spec) => reportChildOutput(ctx, await deps.addGlobalPlugin(runtime, spec)),
    removeGlobalPlugin: async (runtime, spec) => reportChildOutput(ctx, await deps.removeGlobalPlugin(runtime, spec)),
  }
}

/**
 * Pinned registration spec. The installer's own version is authoritative for
 * setup (an npx invocation exists by definition), and packageSpec overrides it
 * for enterprise/test pinning.
 */
export function registrationSpec(ctx: OperationContext, version?: string | null): string {
  if (ctx.options.packageSpec) return ctx.options.packageSpec
  const target = (version ?? ctx.installerVersion ?? "").trim().replace(/^v/i, "") || "0.0.0"
  return `opencode-spotify@${target}`
}

/** Version component of an npm-ish spec, used only to reject downgrades. */
export function specVersion(spec: string | null | undefined): string | null {
  if (!spec) return null
  const value = spec.trim()
  const at = value.lastIndexOf("@")
  if (at <= 0) return null
  const candidate = value.slice(at + 1).trim()
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(candidate) ? candidate : null
}

export function isSpotifyPluginId(id: string): boolean {
  const value = (id ?? "").trim().replace(/@\d+\.\d+\.\d+.*$/, "")
  if (value === "opencode-spotify") return true
  return (value.split("/").pop() ?? value) === "opencode-spotify"
}

/**
 * A project-local opencode-spotify registration. Setup/repair only warn about
 * it: project configuration is never edited, and a project entry may take
 * precedence over the global registration.
 */
export async function findProjectPluginConflict(
  runtime: Runtime,
  deps: WorkflowDeps,
): Promise<ProjectPluginEntry | undefined> {
  try {
    const entries = await deps.projectPlugins(runtime)
    return entries.find(
      (entry) =>
        isSpotifyPluginId(entry.id) &&
        (entry.version.trim().toLowerCase() === "local" || isPathLikeSource(entry.source)),
    )
  } catch {
    return undefined
  }
}

/**
 * Stop a workflow when a mutating action reported failure. CommandResult is
 * the shared child-process shape; the extra ok/success checks tolerate fakes.
 * Detail text is sanitized so a child process cannot echo a credential.
 */
export function assertActionResult(result: CommandResult | unknown, message: string): void {
  if (result === false) throw new Error(message)
  if (!result || typeof result !== "object") return
  const record = result as { code?: unknown; error?: unknown; ok?: unknown; success?: unknown }
  const failed =
    record.ok === false ||
    record.success === false ||
    (typeof record.code === "number" && record.code !== 0)
  if (!failed) return
  const detail = typeof record.error === "string" ? sanitizeMessage(record.error) : ""
  throw new Error(detail ? `${message} ${detail}` : message)
}

function describeFailure(error: unknown): string {
  if (error instanceof Error && error.message) return sanitizeMessage(error.message)
  return "The step failed."
}

export type PlanStatus = "completed" | "dry-run" | "cancelled" | "confirmation-required" | "failed"

export interface PlanOutcome {
  status: PlanStatus
  /** IDs of steps that ran successfully. */
  completed: string[]
  /** IDs of steps that were not run. */
  skipped: string[]
  failed?: string
  error?: string
  /** Cancellation was requested and at least one step was allowed to finish. */
  partial?: boolean
  /** Cancellation stopped the run (before a step or between steps). */
  interrupted?: boolean
}

export interface PlanConfirmation {
  /** Caller already obtained consent for this exact plan. */
  approved?: boolean
  /** Ask even when --yes was supplied (used for apply's separate consent). */
  force?: boolean
  question?: string
  defaultYes?: boolean
  phrase?: string
}

export type PlanEventReporter = ProgressReporter

/**
 * The master-owned reporter, guarded for the fixture-migration window: a
 * partial fake may provide only `progress`, which must not be treated as a
 * full plan renderer. When the plan methods are absent, executePlan keeps the
 * legacy Ui path.
 */
export function planReporter(ctx: OperationContext): ProgressReporter | undefined {
  const report = ctx.report
  if (!report) return undefined
  return typeof report.emit === "function" &&
    typeof report.step === "function" &&
    typeof report.log === "function"
    ? report
    : undefined
}

function emitEvent(report: ProgressReporter, event: ProgressEvent): void {
  try {
    report.emit(event)
  } catch {
    // A broken UI/store must not abort a mutating plan.
  }
}

function emitStep(
  report: ProgressReporter,
  ctx: OperationContext,
  step: Pick<PlanStep, "id" | "description">,
  status: "pending" | "running" | "ok" | "failed" | "skipped",
  detail?: string,
): void {
  emitEvent(report, {
    type: "step",
    id: step.id,
    status,
    description: sanitizeMessage(step.description),
    ...(detail === undefined ? {} : { detail: sanitizeMessage(detail) }),
    at: ctx.runtime.now(),
  })
}

/** Cancellation lifecycle event (requested -> finishing -> settled). */
function emitCancel(
  report: ProgressReporter,
  ctx: OperationContext,
  phase: "requested" | "finishing" | "settled",
  stepId?: string,
): void {
  emitEvent(report, {
    type: "cancel",
    phase,
    ...(stepId ? { stepId } : {}),
    ...(ctx.cancel.forced ? { forced: true } : {}),
    at: ctx.runtime.now(),
  })
}

/**
 * Announce a plan exactly once before consent. With a structured reporter the
 * plan becomes a `plan` event carrying the real step descriptions (so presenters
 * never have to invent id-only rows); in the legacy path it renders through Ui.
 */
export function announcePlan(
  ctx: OperationContext,
  title: string,
  steps: PlanStep[],
  options: { render?: boolean } = {},
): void {
  const report = planReporter(ctx)
  if (report) {
    emitEvent(report, {
      type: "plan",
      title: sanitizeMessage(title),
      steps: steps.map((step) => ({
        id: step.id,
        description: sanitizeMessage(step.description),
        mutates: step.mutates,
        status: "pending" as const,
      })),
      at: ctx.runtime.now(),
    })
    return
  }
  if (options.render !== false) showPlan(ctx, title, steps)
}

function emitLog(report: ProgressReporter, level: LogLevel, message: string): void {
  try {
    report.log(level, message)
  } catch {
    // Presentation failures are non-fatal.
  }
}

function emitResult(ctx: OperationContext, report: ProgressReporter, outcome: PlanOutcome): void {
  emitEvent(report, { type: "result", code: planExitCode(outcome), at: ctx.runtime.now() })
}

/**
 * Forward a child-process progress line. With a full reporter this becomes a
 * `progress` event (bridge apply => scope "apply"); without one the legacy
 * two-space UI line is preserved exactly.
 *
 * B06: ApplyBridgeOptions.onProgress is wired through here.
 */
export function reportProgress(
  ctx: OperationContext,
  scope: string,
  line: string,
  percent?: number,
): void {
  const report = ctx.report
  if (report && typeof report.progress === "function") {
    try {
      report.progress(scope, sanitizeMessage(line), percent)
    } catch {
      // Presentation failures are non-fatal.
    }
    return
  }
  ctx.ui.line(`  ${line}`)
}

/**
 * Forward a diagnostic line. Opencode child output uses level "debug", which
 * the plain reporter only prints in verbose mode. Without a reporter the
 * legacy Ui destination for that level is used, so existing output is stable.
 */
export function reportLog(ctx: OperationContext, level: LogLevel, message: string): void {
  const report = ctx.report
  if (report && typeof report.log === "function") {
    try {
      report.log(level, sanitizeMessage(message))
    } catch {
      // Presentation failures are non-fatal.
    }
    return
  }
  switch (level) {
    case "debug": ctx.ui.line(`  ${message}`); break
    case "info": ctx.ui.line(message); break
    case "success": ctx.ui.success(message); break
    case "warn": ctx.ui.warn(message); break
    case "error": ctx.ui.error(message); break
  }
}

const CHILD_OUTPUT_LINE_LIMIT = 20

/**
 * Forward child stdout/stderr as debug log events (bounded), and return the
 * result unchanged so callers can compose it inline. Without a reporter this
 * mirrors the legacy `ui.line("  <line>")` rendering.
 */
export function reportChildOutput(ctx: OperationContext, result: CommandResult): CommandResult {
  const lines = `${result.stdout ?? ""}\n${result.stderr ?? ""}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, CHILD_OUTPUT_LINE_LIMIT)
  for (const line of lines) reportLog(ctx, "debug", line)
  return result
}

function showPlan(ctx: OperationContext, title: string, steps: PlanStep[]): void {
  ctx.ui.section(title)
  steps.forEach((step, index) => {
    ctx.ui.bullet(`${index + 1}. ${step.description}${step.mutates ? "" : " (verification only)"}`)
  })
}

/**
 * Cancellation wording for a run that was interrupted. A full cancellation
 * reuses the shared PLAN_MESSAGES text; a partial run states what happened.
 */
const PARTIAL_CANCEL_MESSAGE =
  "Cancelled. The in-flight step was allowed to finish; remaining steps were not run."

/**
 * Runtime view whose child processes inherit the operation's cancel token.
 * The real Runtime already falls back to its own token, but dependency seams
 * and fakes only see what is passed explicitly, so mutations pass this view.
 */
export function cancelAwareRuntime(runtime: Runtime, cancel?: CancelToken): Runtime {
  if (!cancel) return runtime
  const wrapped: Runtime = {
    ...runtime,
    run: (file, args, options) => runtime.run(file, args, { ...options, cancel: options?.cancel ?? cancel }),
  }
  if (runtime.runInteractive) {
    const runInteractive = runtime.runInteractive.bind(runtime)
    wrapped.runInteractive = (file, args, options) =>
      runInteractive(file, args, { ...options, cancel: options?.cancel ?? cancel })
  }
  return wrapped
}

/**
 * Shared presentation for plans that will not run a step: dry-run, a declined
 * consent, or a missing noninteractive confirmation. Emits one skipped step
 * event per step plus the stable shared wording (or the legacy Ui lines).
 */
export function planSkipOutcome(
  ctx: OperationContext,
  steps: PlanStep[],
  status: Extract<PlanStatus, "dry-run" | "cancelled" | "confirmation-required">,
): PlanOutcome {
  const report = planReporter(ctx)
  const outcome: PlanOutcome = {
    status,
    completed: [],
    skipped: steps.map((step) => step.id),
  }
  if (report) {
    for (const step of steps) {
      if (status === "dry-run") emitStep(report, ctx, step, "skipped", "dry-run")
      else emitStep(report, ctx, step, "skipped")
    }
    if (status === "dry-run") emitLog(report, "info", PLAN_MESSAGES.dryRun)
    else if (status === "cancelled") emitLog(report, "warn", PLAN_MESSAGES.cancelled)
    else emitLog(report, "error", PLAN_MESSAGES.confirmationRequired)
    emitResult(ctx, report, outcome)
  } else if (status === "dry-run") {
    for (const step of steps) ctx.ui.dryRun(step.description)
    ctx.ui.line(PLAN_MESSAGES.dryRun)
  } else if (status === "cancelled") {
    ctx.ui.warn(PLAN_MESSAGES.cancelled)
  } else {
    ctx.ui.error(PLAN_MESSAGES.confirmationRequired)
  }
  return outcome
}

export interface RunPlanHooks {
  /** Title for the `plan` event when the runner announces the plan. */
  title?: string
  /** Emit the plan event before the first step (default true). */
  announce?: boolean
}

/**
 * Run plan steps with cancellation semantics shared by every workflow:
 *
 *   * a cancellation request before a step starts skips the remaining steps and
 *     settles with exit code 130 (no further step runs, not even a protected one);
 *   * a `protected` step always finishes once started, then the run stops with
 *     `partial: true` and 130;
 *   * an `abort`/`boundary` step that throws OperationCancelled is a cancelled
 *     step (130), never a failure;
 *   * a real failure always wins over a concurrent cancellation (exit code 1).
 *
 * The plan event (with real descriptions) is emitted before the first step
 * unless the caller already announced it via `announcePlan`.
 */
export async function runPlanSteps(
  steps: PlanStep[],
  ctx: OperationContext,
  hooks: RunPlanHooks = {},
): Promise<PlanOutcome> {
  const report = planReporter(ctx)
  const cancel = ctx.cancel
  const { ui } = ctx
  const completed: string[] = []

  if (hooks.announce !== false) announcePlan(ctx, hooks.title ?? "Plan", steps)

  let requestedEmitted = false
  let finishingEmitted = false
  let runningStep: PlanStep | undefined

  const announceRequested = (): void => {
    if (requestedEmitted) return
    requestedEmitted = true
    if (report) emitCancel(report, ctx, "requested", runningStep?.id ?? cancel.stepId)
  }
  const announceFinishing = (stepId: string): void => {
    if (finishingEmitted) return
    finishingEmitted = true
    if (report) emitCancel(report, ctx, "finishing", stepId)
  }

  const unsubscribe = cancel.onRequest(() => {
    announceRequested()
    if (runningStep?.interrupt === "protected") {
      cancel.beginFinishing(runningStep.id)
      announceFinishing(runningStep.id)
    }
  })

  const stop = (remaining: PlanStep[], options: { partial: boolean }): PlanOutcome => {
    if (!cancel.requested) cancel.request("user")
    if (options.partial) cancel.settle("partial")
    else cancel.settle("cancelled")
    announceRequested()
    if (options.partial) announceFinishing(cancel.stepId ?? runningStep?.id ?? "current")
    const outcome: PlanOutcome = {
      status: "cancelled",
      completed: [...completed],
      skipped: remaining.map((step) => step.id),
      ...(options.partial ? { partial: true } : {}),
      interrupted: true,
    }
    const message = options.partial
      ? PARTIAL_CANCEL_MESSAGE
      : completed.length > 0
        ? "Cancelled. Completed steps were kept; remaining steps were not run."
        : PLAN_MESSAGES.cancelled
    if (report) {
      for (const step of remaining) emitStep(report, ctx, step, "skipped", "cancelled")
      emitLog(report, "warn", message)
      emitCancel(report, ctx, "settled", cancel.stepId)
      emitResult(ctx, report, outcome)
    } else {
      ui.warn(message)
    }
    return outcome
  }

  try {
    for (let index = 0; index < steps.length; index++) {
      const step = steps[index]!

      // Cancellation between steps: no further step starts.
      if (cancel.requested) return stop(steps.slice(index), { partial: false })

      // Revalidate the installer lock before every mutating step: a lock lost
      // mid-run must stop the operation, not mutate alongside another installer.
      if (step.mutates && ctx.guard) {
        try {
          await ctx.guard()
        } catch (error) {
          const message = describeFailure(error)
          return {
            status: "failed",
            completed: [...completed],
            skipped: steps.slice(index).map((item) => item.id),
            failed: step.id,
            error: message,
          }
        }
      }

      if (report) emitStep(report, ctx, step, "running")
      runningStep = step
      // Protected steps keep their children alive: the token still records the
      // request, but runtime kills are suppressed until the step completes.
      const releaseKill = step.interrupt === "protected" ? cancel.holdKill() : undefined
      try {
        await step.run()
      } catch (error) {
        runningStep = undefined
        if (isCancellation(error)) {
          // A cooperative abort is a cancelled step, not a failed one.
          if (!cancel.requested) cancel.request("user")
          if (report) emitStep(report, ctx, step, "skipped", "cancelled")
          return stop(steps.slice(index + 1), { partial: false })
        }
        // A real failure wins over a concurrent cancellation: exit code 1.
        const message = describeFailure(error)
        const skipped = steps.slice(index + 1).map((item) => item.id)
        const outcome: PlanOutcome = {
          status: "failed",
          completed: [...completed],
          skipped,
          failed: step.id,
          error: message,
        }
        if (report) {
          emitStep(report, ctx, step, "failed", message)
          for (const item of steps.slice(index + 1)) emitStep(report, ctx, item, "skipped")
          emitResult(ctx, report, outcome)
        } else {
          ui.error(`Stopped at: ${step.id} - ${step.description}`)
          ui.line(`   Reason: ${message}`)
          ui.line(`   Completed stages: ${completed.length ? completed.join(", ") : "none"}`)
          ui.line(`   Not run: ${skipped.length ? skipped.join(", ") : "none"}`)
        }
        return outcome
      } finally {
        releaseKill?.()
      }
      runningStep = undefined
      completed.push(step.id)
      if (report) emitStep(report, ctx, step, "ok")
      else ui.success(step.description)

      if (cancel.requested) {
        // Protected steps always run to completion; boundary/abort stop here.
        return stop(steps.slice(index + 1), { partial: step.interrupt === "protected" })
      }
    }
  } finally {
    unsubscribe()
  }

  const outcome: PlanOutcome = { status: "completed", completed, skipped: [] }
  if (report) {
    emitLog(report, "success", PLAN_MESSAGES.completed)
    emitResult(ctx, report, outcome)
  } else {
    ui.status("ok", PLAN_MESSAGES.completed)
  }
  return outcome
}

/**
 * Present and execute a plan. Read-only plans do not prompt. Mutating plans
 * require --yes or an explicit confirmation; cancellation and missing consent
 * run nothing and return a non-completed status.
 *
 * When a full `ctx.report` is present, plan output is delivered as
 * ProgressEvents instead of direct Ui writes, so a store/presentation can
 * render it (or createPlainReporter can reproduce the console text). Without
 * one, the legacy Ui path is byte-identical to V0.6.0 beta.
 */
export async function executePlan(
  ctx: OperationContext,
  title: string,
  steps: PlanStep[],
  confirmation: PlanConfirmation = {},
): Promise<PlanOutcome> {
  const { options, prompt, ui } = ctx
  const report = planReporter(ctx)
  const ids = steps.map((step) => step.id)

  // Cancelled before anything is shown or run.
  let cancelledBeforeStart = false
  try {
    ctx.cancel.throwIfCancelled()
  } catch {
    cancelledBeforeStart = true
  }
  if (cancelledBeforeStart) {
    ctx.cancel.settle("cancelled")
    const outcome: PlanOutcome = { status: "cancelled", completed: [], skipped: ids, interrupted: true }
    if (report) {
      emitCancel(report, ctx, "requested")
      emitLog(report, "warn", PLAN_MESSAGES.cancelled)
      emitCancel(report, ctx, "settled")
      emitResult(ctx, report, outcome)
    } else {
      ui.warn(PLAN_MESSAGES.cancelled)
    }
    return outcome
  }

  announcePlan(ctx, title, steps)

  if (steps.length === 0) {
    const outcome: PlanOutcome = { status: "completed", completed: [], skipped: [] }
    if (report) {
      emitLog(report, "info", PLAN_MESSAGES.nothingToDo)
      emitResult(ctx, report, outcome)
    } else {
      ui.status("info", PLAN_MESSAGES.nothingToDo)
    }
    return outcome
  }

  if (options.dryRun) return planSkipOutcome(ctx, steps, "dry-run")

  const mutates = steps.some((step) => step.mutates)
  const needsPrompt = mutates && !confirmation.approved && (confirmation.force || !options.yes)
  if (needsPrompt) {
    if (options.nonInteractive) return planSkipOutcome(ctx, steps, "confirmation-required")
    const approved = await prompt.confirm(confirmation.question ?? "Apply this plan?", {
      defaultYes: confirmation.defaultYes === true,
      ...(confirmation.phrase ? { phrase: confirmation.phrase } : {}),
    })
    if (!approved) return planSkipOutcome(ctx, steps, "cancelled")
    // Consent may have been accompanied by a cancellation request (Ctrl-C).
    // The runner then starts no step and settles with 130.
    let cancelledAfterConsent = false
    try {
      ctx.cancel.throwIfCancelled()
    } catch {
      cancelledAfterConsent = true
    }
    if (cancelledAfterConsent) return runPlanSteps(steps, ctx, { announce: false })
  }

  return runPlanSteps(steps, ctx, { title, announce: false })
}

export interface ApplyOutcome {
  code: number
  applied: boolean
  pending: boolean
}

/** Map a plan outcome to a process exit code. */
export function planExitCode(outcome: PlanOutcome): number {
  switch (outcome.status) {
    case "completed": case "dry-run": return 0
    case "cancelled": return 130
    case "confirmation-required": return 2
    default: return 1
  }
}

/** Human label for detection/compatibility states. */
export function compatibilityLabel(state: string): string {
  switch (state) {
    case "ok": case "compatible": return "compatible"
    case "too-old": return "unsupported version"
    case "stale": return "needs repair"
    case "missing": return "not installed"
    default: return "unknown"
  }
}

/**
 * Present a separate apply plan after bridge preparation. This keeps the
 * Spicetify apply consent independent from the bridge file consent.
 */
export async function maybeApplyBridge(
  ctx: OperationContext,
  spicetifyPath: string | null,
  prepared: boolean,
): Promise<{ code: number; applied: boolean }> {
  if (!prepared) return { code: 0, applied: false }
  const applied = await applyPlanIfRequested(ctx, [{
    id: "apply-spicetify",
    description: "Run spicetify apply to activate the prepared bridge (may restart Spotify)",
    mutates: true,
    // Once apply starts, finish and verify it before honouring cancellation.
    interrupt: "protected",
    run: async () => {
      const result = await applyBridge(cancelAwareRuntime(ctx.runtime, ctx.cancel), {
        spicetifyPath,
        onProgress: (line) => reportProgress(ctx, "apply", line),
      })
      if (result.cancelled === true || result.code === 130) {
        throw new OperationCancelled("apply-spicetify", result.error ?? "spicetify apply was cancelled")
      }
      if (result.code !== 0) throw new Error(result.error ?? "spicetify apply failed")
    },
  }])
  return { code: applied.code, applied: applied.applied }
}

/**
 * Apply Spicetify changes after bridge preparation. Preparation never applies
 * automatically. Interactive runs ask a separate question even when --yes was
 * supplied; noninteractive runs apply only with --apply --yes.
 */
export async function applyPlanIfRequested(
  ctx: OperationContext,
  steps: PlanStep[],
): Promise<ApplyOutcome> {
  const { options, ui } = ctx
  if (options.dryRun) {
    if (options.apply) {
      await executePlan(ctx, "Apply Spicetify changes", steps)
    } else {
      ui.dryRun("Leave Spicetify apply pending; rerun with --apply --yes to apply")
    }
    return { code: 0, applied: false, pending: true }
  }

  if (options.apply) {
    if (options.nonInteractive && !options.yes) {
      ui.warn("Apply pending: noninteractive mode requires --apply --yes.")
      return { code: 1, applied: false, pending: true }
    }
    const outcome = await executePlan(ctx, "Apply Spicetify changes", steps)
    if (outcome.status === "completed") return { code: 0, applied: true, pending: false }
    if (outcome.status === "cancelled") return cancelledApply(ctx, outcome)
    ui.warn("Apply pending. The bridge is prepared but Spicetify has not been applied.")
    return { code: 1, applied: false, pending: true }
  }

  if (options.nonInteractive) {
    ui.warn("Apply pending: rerun with --apply --yes when ready to apply Spicetify changes.")
    return { code: 0, applied: false, pending: true }
  }

  const outcome = await executePlan(ctx, "Apply Spicetify changes", steps, {
    force: true,
    question: "Apply Spicetify changes now?",
  })
  if (outcome.status === "completed") return { code: 0, applied: true, pending: false }
  if (outcome.status === "cancelled") return cancelledApply(ctx, outcome)
  ui.warn("Apply pending. The bridge is prepared but Spicetify has not been applied.")
  return { code: 1, applied: false, pending: true }
}

/**
 * A cancelled apply must never become a failure: a protected apply that already
 * finished is reported as applied, and an interrupted-before-start apply keeps
 * the pending warning while surfacing 130 (never 1) to the caller.
 */
function cancelledApply(ctx: OperationContext, outcome: PlanOutcome): ApplyOutcome {
  if (!ctx.cancel.requested) {
    // Consent was declined (not a cancellation): the bridge stays pending.
    ctx.ui.warn("Apply pending. The bridge is prepared; run spicetify apply when ready.")
    return { code: 0, applied: false, pending: true }
  }
  if (outcome.partial) {
    return { code: 130, applied: true, pending: false }
  }
  ctx.ui.warn("Apply pending. The bridge is prepared; run spicetify apply when ready.")
  return { code: 130, applied: false, pending: true }
}
