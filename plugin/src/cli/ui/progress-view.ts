// Shared progress presentation for the installer CLI.
//
// This module is the single place that turns real ProgressEvents into a
// pending / current / completed / failed / skipped view. It deliberately:
//   * never derives a percentage from elapsed time: a bar is drawn only when
//     an event carries an explicit, finite `percent`;
//   * advances spinners only when the renderer asks for the next frame, so a
//     stalled operation looks stalled instead of "progressing";
//   * keeps every log entry (redacted) and never silently drops output;
//   * sanitizes error text before it can reach the terminal;
//   * retries only steps for which the caller registered a handler, so a
//     generic "retry" can never re-run an unsafe or unknown mutation.
//
// The interactive-child and terminal-restoration helpers at the bottom keep
// Ink / raw-mode ownership honest: an interactive child gets the terminal
// back, and exits or Ctrl+C restore the cursor and attributes instead of
// leaving the user with a broken prompt.
//
// Plain Node type-stripping safe: types plus functions only, no enums.
import { sanitizeDetail } from "../runtime.ts"
import type {
  InstallerPhase,
  LogLevel,
  PlanStepView,
  ProgressEvent,
  ProgressReporter,
  StepStatus,
} from "../types.ts"

// ---- view model ----

export type ProgressStatus = "pending" | "current" | "completed" | "failed" | "skipped"

export interface ProgressStepView {
  id: string
  description: string
  mutates: boolean
  status: ProgressStatus
  detail?: string
  /** Sanitized failure reason, cleared when a retry starts. */
  error?: string
  /** Number of retry attempts performed (never counts the first run). */
  attempts: number
  /** True only when a retry handler has been registered for this step. */
  retryable: boolean
}

export interface ProgressLogEntry {
  at: number
  level: LogLevel
  message: string
}

export interface ProgressActivity {
  scope: string
  message: string
  /** Present only when an event supplied a real percentage. */
  percent?: number
}

export interface ProgressCounts {
  total: number
  pending: number
  current: number
  completed: number
  failed: number
  skipped: number
}

export interface ProgressSnapshot {
  title: string
  phase: InstallerPhase | null
  phaseLabel: string | null
  steps: ProgressStepView[]
  counts: ProgressCounts
  logs: ProgressLogEntry[]
  activity: ProgressActivity | null
  startedAt: number | null
  endedAt: number | null
  exitCode: number | null
}

export interface ProgressViewOptions {
  title?: string
  command?: string
  steps?: PlanStepView[]
  /** Timestamp source for local events only. Never used to derive a percentage. */
  now?: () => number
  /** Frames used for indeterminate work. Defaults to ASCII for safe terminals. */
  spinnerFrames?: string[]
  /** Use Unicode status glyphs instead of ASCII brackets. */
  unicode?: boolean
  /** Sanitizer for inline error text (defaults to the shared runtime sanitizer). */
  sanitize?: (message: string) => string
  /** Include accumulated logs in render(). Default true: logs are not hidden. */
  renderLogs?: boolean
  onChange?: (snapshot: ProgressSnapshot) => void
}

export interface SummaryOptions {
  command?: string
  /** Replaces the default restart guidance when provided. */
  restartHint?: string
  /** Maximum failure lines shown. All failures remain available via snapshot(). */
  maxFailures?: number
}

export interface RetryResult {
  ok: boolean
  reason:
    | "completed"
    | "unknown-step"
    | "not-failed"
    | "unsupported"
    | "in-flight"
    | "handler-failed"
  message: string
  attempts?: number
}

export interface ProgressView {
  /** Feed one real operation event into the view. */
  apply(event: ProgressEvent): ProgressSnapshot
  setPlan(title: string, steps: PlanStepView[]): void
  setActivity(scope: string, message: string, percent?: number): void
  /** Advance the indeterminate spinner and return the new frame. */
  tick(): string
  /** Current spinner frame without advancing it. */
  frame(): string
  render(): string
  summary(options?: SummaryOptions): string
  snapshot(): ProgressSnapshot
  /** True when no explicit, real percentage has been reported. */
  readonly indeterminate: boolean
  canRetry(id: string): boolean
  registerRetry(id: string, handler: () => Promise<void>): () => void
  /** Retry a failed step whose handler was explicitly registered. */
  retry(id: string): Promise<RetryResult>
  subscribe(listener: (snapshot: ProgressSnapshot) => void): () => void
}

// ---- sanitization ----

/**
 * Remove terminal control sequences so child output cannot move the cursor,
 * clear the screen, or hijack the Ink frame. Keeps newlines and tabs.
 */
export function stripTerminalSequences(value: string): string {
  return value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[@-_]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
}

/**
 * Redact secret-looking values. Patterns mirror the shared runtime sanitizer
 * but this variant does not truncate, so log messages stay complete.
 */
export function redactSecrets(value: string): string {
  return value
    .replace(/\/\/[^\s:]+:_authToken=\S+/gi, "[redacted]")
    .replace(/\b[a-f0-9]{32,}\b/gi, "[redacted]")
    .replace(/\b(secret|token|password|credential|authorization)\s*[:=]\s*\S+/gi, "$1=[redacted]")
}

/** Sanitized one-line log text: redacted, control-free, never truncated. */
export function sanitizeLogMessage(value: unknown): string {
  const text = typeof value === "string" ? value : String(value ?? "")
  return redactSecrets(stripTerminalSequences(text)).replace(/\s*\r?\n\s*/g, " | ").trim()
}

/** Sanitized inline error detail: redacted, control-free, single line, bounded. */
export function sanitizeErrorDetail(value: unknown, maxLength = 240): string {
  const text = typeof value === "string" ? value : String(value ?? "")
  // Reuse the shared runtime redaction rules (they also bound the value).
  const cleaned = sanitizeDetail(stripTerminalSequences(text)).replace(/\s+/g, " ").trim()
  if (!cleaned) return "The step failed without a reason."
  return cleaned.length > maxLength ? `${cleaned.slice(0, Math.max(1, maxLength - 3))}...` : cleaned
}

// ---- formatting helpers ----

export function normalizePercent(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined
  return Math.max(0, Math.min(100, Math.round(value)))
}

/** ASCII bar for explicit event percentages only. */
export function renderPercentBar(percent: number, width = 20): string {
  const value = normalizePercent(percent) ?? 0
  const boundedWidth = Math.max(1, Math.floor(width))
  const filled = Math.round((value / 100) * boundedWidth)
  return `[${"#".repeat(filled)}${"-".repeat(boundedWidth - filled)}] ${value}%`
}

const ASCII_FRAMES = ["-", "\\", "|", "/"]
const ASCII_GLYPHS = {
  pending: "[ ]",
  completed: "[x]",
  failed: "[!]",
  skipped: "[-]",
} as const
const UNICODE_GLYPHS = {
  pending: "\u25cb",
  completed: "\u2714",
  failed: "\u2716",
  skipped: "\u2013",
} as const

function mapStepStatus(status: StepStatus): ProgressStatus {
  switch (status) {
    case "running": return "current"
    case "ok": return "completed"
    case "failed": return "failed"
    case "skipped": return "skipped"
    default: return "pending"
  }
}

function statusGlyph(status: ProgressStatus, frame: string, unicode: boolean): string {
  if (status === "current") return unicode ? frame : `[${frame}]`
  return unicode ? UNICODE_GLYPHS[status] : ASCII_GLYPHS[status]
}

function countSteps(steps: ProgressStepView[]): ProgressCounts {
  const counts: ProgressCounts = { total: steps.length, pending: 0, current: 0, completed: 0, failed: 0, skipped: 0 }
  for (const step of steps) counts[step.status] += 1
  return counts
}

function cloneStep(step: ProgressStepView): ProgressStepView {
  return { ...step }
}

function finiteAt(at: unknown, fallback: number): number {
  return typeof at === "number" && Number.isFinite(at) ? at : fallback
}

// ---- view factory ----

export function createProgressView(options: ProgressViewOptions = {}): ProgressView {
  const now = options.now ?? Date.now
  const spinnerFrames = options.spinnerFrames && options.spinnerFrames.length > 0
    ? [...options.spinnerFrames]
    : [...ASCII_FRAMES]
  const unicode = options.unicode === true
  const renderLogs = options.renderLogs !== false
  const sanitize = options.sanitize ?? ((message: string) => sanitizeErrorDetail(message))
  const command = options.command ?? "opencode-spotify setup"

  let title = options.title ?? ""
  let phase: InstallerPhase | null = null
  let phaseLabel: string | null = null
  let steps: ProgressStepView[] = []
  let logs: ProgressLogEntry[] = []
  let activity: ProgressActivity | null = null
  let startedAt: number | null = null
  let endedAt: number | null = null
  let exitCode: number | null = null
  let frameIndex = 0

  const retries = new Map<string, () => Promise<void>>()
  const inFlight = new Set<string>()
  const listeners = new Set<(snapshot: ProgressSnapshot) => void>()

  function stepViewFrom(step: PlanStepView): ProgressStepView {
    return {
      id: step.id,
      description: step.description,
      mutates: step.mutates,
      status: mapStepStatus(step.status),
      ...(step.detail ? { detail: sanitizeErrorDetail(step.detail) } : {}),
      attempts: 0,
      retryable: retries.has(step.id),
    }
  }

  function findStep(id: string): ProgressStepView | undefined {
    return steps.find((step) => step.id === id)
  }

  function setPlan(nextTitle: string, nextSteps: PlanStepView[]): void {
    title = nextTitle || title
    steps = nextSteps.map(stepViewFrom)
  }

  function setActivity(scope: string, message: string, percent?: number): void {
    const value = normalizePercent(percent)
    activity = {
      scope: sanitizeLogMessage(scope),
      message: sanitizeLogMessage(message),
      ...(value === undefined ? {} : { percent: value }),
    }
  }

  function snapshot(): ProgressSnapshot {
    const copied = steps.map(cloneStep)
    return {
      title,
      phase,
      phaseLabel,
      steps: copied,
      counts: countSteps(copied),
      logs: logs.map((entry) => ({ ...entry })),
      activity: activity ? { ...activity } : null,
      startedAt,
      endedAt,
      exitCode,
    }
  }

  function notify(): void {
    if (!options.onChange && listeners.size === 0) return
    const current = snapshot()
    options.onChange?.(current)
    for (const listener of listeners) listener(current)
  }

  function apply(event: ProgressEvent): ProgressSnapshot {
    const at = finiteAt(event.at, now())
    if (startedAt === null) startedAt = at

    switch (event.type) {
      case "phase": {
        phase = event.phase
        phaseLabel = sanitizeLogMessage(event.label || event.phase)
        break
      }
      case "plan": {
        setPlan(event.title, event.steps)
        break
      }
      case "step": {
        const status = mapStepStatus(event.status)
        const existing = findStep(event.id)
        if (existing) {
          existing.status = status
          if (event.description) existing.description = event.description
          if (event.detail !== undefined) existing.detail = sanitizeErrorDetail(event.detail)
          if (status === "failed") {
            existing.error = sanitizeErrorDetail(
              event.detail ?? existing.detail ?? existing.error ?? "The step failed.",
            )
          } else if (status === "current") {
            existing.error = undefined
          }
        } else {
          steps.push({
            id: event.id,
            description: event.description ?? event.id,
            mutates: false,
            status,
            ...(event.detail !== undefined ? { detail: sanitizeErrorDetail(event.detail) } : {}),
            ...(status === "failed"
              ? { error: sanitizeErrorDetail(event.detail ?? "The step failed.") }
              : {}),
            attempts: 0,
            retryable: retries.has(event.id),
          })
        }
        break
      }
      case "log": {
        logs.push({
          at,
          level: event.level,
          message: sanitizeLogMessage(event.message),
        })
        break
      }
      case "progress": {
        setActivity(event.scope, event.message, event.percent)
        break
      }
      case "cancel": {
        // Cancellation has no percentage; only its phase and step are known.
        phase = "cancelling"
        phaseLabel = event.phase === "settled"
          ? (event.forced ? "Cancelled (forced)" : "Cancelled")
          : event.stepId
            ? `Cancelling - waiting for ${event.stepId}`
            : "Cancelling"
        break
      }
      case "result": {
        endedAt = at
        exitCode = Number.isInteger(event.code) ? event.code : null
        break
      }
      case "prompt":
      case "detection":
        // Presented elsewhere; progress state intentionally ignores them.
        break
    }

    notify()
    return snapshot()
  }

  function tick(): string {
    frameIndex = (frameIndex + 1) % spinnerFrames.length
    notify()
    return spinnerFrames[frameIndex]!
  }

  function frame(): string {
    return spinnerFrames[frameIndex]!
  }

  function renderStep(step: ProgressStepView, index: number): string[] {
    const lines = [`  ${statusGlyph(step.status, frame(), unicode)} ${index + 1}. ${step.description}`]
    if (step.detail && step.status !== "failed") lines.push(`       ${step.detail}`)
    if (step.status === "failed" && step.error) lines.push(`       Reason: ${step.error}`)
    if (step.attempts > 0) lines.push(`       Retries: ${step.attempts}`)
    return lines
  }

  function summaryLines(summaryOptions: SummaryOptions = {}): string[] {
    const current = snapshot()
    const counts = current.counts
    const lines: string[] = []
    lines.push("Summary")
    lines.push(
      `  Steps: ${counts.completed} completed, ${counts.failed} failed, ${counts.skipped} skipped, ` +
      `${counts.pending} pending, ${counts.current} running (${counts.total} total)`,
    )

    const failures = current.steps.filter((step) => step.status === "failed")
    if (failures.length > 0) {
      const limit = Math.max(1, summaryOptions.maxFailures ?? 3)
      lines.push("  Failed:")
      for (const failure of failures.slice(0, limit)) {
        lines.push(`    - ${failure.id}: ${failure.error ?? "The step failed."}`)
      }
      if (failures.length > limit) {
        lines.push(`    ... and ${failures.length - limit} more (retained in the progress snapshot)`)
      }
    }

    if (current.exitCode !== null) lines.push(`  Exit code: ${current.exitCode}`)

    const restartCommand = summaryOptions.command ?? command
    const retryable = failures.filter((step) => step.retryable)
    if (summaryOptions.restartHint) {
      lines.push(`  Restart: ${summaryOptions.restartHint}`)
    } else if (failures.length > 0) {
      lines.push(
        `  Restart: fix the issue above, then rerun \`${restartCommand}\`. ` +
        "Completed steps are safe to repeat; failed and skipped steps run on the next attempt.",
      )
    } else if (counts.completed > 0 || counts.skipped > 0) {
      lines.push(
        `  Restart: quit and relaunch OpenCode so it loads the updated plugin, ` +
        `then run \`${restartCommand.replace(/\s+setup$/, "")} status\` to verify.`,
      )
    } else {
      lines.push(`  Restart: rerun \`${restartCommand}\` when you are ready.`)
    }

    if (retryable.length > 0) {
      lines.push(
        `  Retry: ${retryable.map((step) => step.id).join(", ")} can be retried safely ` +
        "from the progress view or by rerunning the command.",
      )
    }

    lines.push(`  Logs: ${current.logs.length} ${current.logs.length === 1 ? "entry" : "entries"} retained; no output was hidden.`)
    return lines
  }

  function summary(summaryOptions: SummaryOptions = {}): string {
    return summaryLines(summaryOptions).join("\n")
  }

  function render(): string {
    const current = snapshot()
    const lines: string[] = [`Progress: ${current.title || "installer"}`]
    if (current.phase) lines.push(`  Phase: ${current.phaseLabel ?? current.phase}`)

    if (current.activity) {
      if (current.activity.percent !== undefined) {
        lines.push(
          `  ${renderPercentBar(current.activity.percent)} ${current.activity.scope}: ${current.activity.message}`,
        )
      } else {
        const spinner = current.endedAt === null ? `${frame()} ` : ""
        lines.push(`  ${spinner}${current.activity.scope}: ${current.activity.message}`)
      }
    }

    if (current.steps.length === 0) {
      if (current.endedAt === null) {
        lines.push(`  ${frame()} Working...`)
      } else {
        lines.push("  No steps were run.")
      }
    } else {
      current.steps.forEach((step, index) => lines.push(...renderStep(step, index)))
    }

    if (renderLogs && current.logs.length > 0) {
      lines.push("Logs:")
      for (const entry of current.logs) {
        lines.push(`  [${entry.level}] ${entry.message}`)
      }
    }

    if (current.endedAt !== null) lines.push("", ...summaryLines())
    return lines.join("\n")
  }

  function canRetry(id: string): boolean {
    const step = findStep(id)
    return !!step && step.status === "failed" && retries.has(id) && !inFlight.has(id)
  }

  function registerRetry(id: string, handler: () => Promise<void>): () => void {
    retries.set(id, handler)
    const step = findStep(id)
    if (step) step.retryable = true
    notify()
    return () => {
      retries.delete(id)
      const current = findStep(id)
      if (current) current.retryable = false
      notify()
    }
  }

  async function retry(id: string): Promise<RetryResult> {
    const step = findStep(id)
    if (!step) {
      return { ok: false, reason: "unknown-step", message: `No step named "${id}" is being tracked.` }
    }
    if (inFlight.has(id)) {
      return { ok: false, reason: "in-flight", message: `Step "${id}" is already being retried.` }
    }
    if (step.status !== "failed") {
      return {
        ok: false,
        reason: "not-failed",
        message: `Step "${id}" is ${step.status}; only failed steps can be retried.`,
      }
    }
    const handler = retries.get(id)
    if (!handler) {
      return {
        ok: false,
        reason: "unsupported",
        message: `Step "${id}" has no safe retry handler; rerun the command instead.`,
      }
    }

    inFlight.add(id)
    step.status = "current"
    step.error = undefined
    step.attempts += 1
    logs.push({
      at: now(),
      level: "info",
      message: sanitizeLogMessage(`Retrying step "${id}" (attempt ${step.attempts}).`),
    })
    notify()

    try {
      await handler()
      step.status = "completed"
      logs.push({
        at: now(),
        level: "success",
        message: sanitizeLogMessage(`Retry succeeded for step "${id}".`),
      })
      return { ok: true, reason: "completed", message: `Step "${id}" completed on retry.`, attempts: step.attempts }
    } catch (error) {
      const message = sanitize(error instanceof Error ? error.message : String(error ?? "Retry failed."))
      step.status = "failed"
      step.error = message
      logs.push({
        at: now(),
        level: "error",
        message: sanitizeLogMessage(`Retry failed for step "${id}": ${message}`),
      })
      return { ok: false, reason: "handler-failed", message, attempts: step.attempts }
    } finally {
      inFlight.delete(id)
      notify()
    }
  }

  function subscribe(listener: (snapshot: ProgressSnapshot) => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  if (options.steps && options.steps.length > 0) setPlan(options.title ?? "", options.steps)

  return {
    apply,
    setPlan,
    setActivity,
    tick,
    frame,
    render,
    summary,
    snapshot,
    get indeterminate() {
      return activity === null || activity.percent === undefined
    },
    canRetry,
    registerRetry,
    retry,
    subscribe,
  }
}

/**
 * Adapter for OperationContext.report. Events carry their own timestamps; the
 * convenience methods stamp real wall-clock time. No percentage is ever
 * synthesized here.
 */
export function createProgressReporter(
  view: ProgressView,
  clock: () => number = Date.now,
): ProgressReporter {
  return {
    emit: (event) => { view.apply(event) },
    phase: (phase, label) => {
      view.apply({ type: "phase", phase, label: label ?? phase, at: clock() })
    },
    step: (id, status, detail) => {
      view.apply({ type: "step", id, status, detail, at: clock() })
    },
    log: (level, message) => {
      view.apply({ type: "log", level, message, at: clock() })
    },
    progress: (scope, message, percent) => {
      view.apply({ type: "progress", scope, message, percent, at: clock() })
    },
    prompt: (request) => {
      view.apply({ type: "prompt", request, at: clock() })
    },
  }
}

// ---- interactive child lifecycle ----

export interface TerminalUi {
  suspend?(): Promise<void>
  resume?(): Promise<void>
}

export interface InteractiveChildOptions {
  /** The presentation's terminal hooks (Ui.suspend / Ui.resume in Ink). */
  ui?: TerminalUi
  /** Extra Ink release hook, e.g. pause rendering or hide the live frame. */
  releaseInk?: () => void | Promise<void>
  /** Counterpart of releaseInk; must be idempotent. */
  restoreInk?: () => void | Promise<void>
  onReleaseError?: (error: unknown) => void
  onRestoreError?: (error: unknown) => void
  onStateChange?: (state: "suspended" | "resumed") => void
}

export interface InteractiveChild {
  readonly active: boolean
  readonly suspended: boolean
  /** Release Ink/terminal without running a child. Idempotent. */
  suspend(): Promise<void>
  /** Restore Ink/terminal. Idempotent; reports hook failures instead of masking them. */
  resume(): Promise<void>
  /** Run one interactive child with the terminal safely released. */
  run<T>(task: () => Promise<T>): Promise<T>
  dispose(): Promise<void>
}

/**
 * Coordinates a single interactive child (for example the official Spicetify
 * installer) with Ink. The terminal is released before the child starts and
 * restored even when the child throws. Concurrent children are refused: two
 * owners of the terminal corrupt the frame.
 */
export function createInteractiveChild(options: InteractiveChildOptions = {}): InteractiveChild {
  let suspended = false
  let running = false
  let disposed = false
  let lastRestoreError: unknown

  async function suspend(): Promise<void> {
    if (disposed) throw new Error("Interactive child lifecycle is already closed.")
    if (suspended) return
    suspended = true
    try {
      await options.ui?.suspend?.()
      await options.releaseInk?.()
      options.onStateChange?.("suspended")
    } catch (error) {
      // Best effort: put back whatever was released before rethrowing.
      try { await options.restoreInk?.() } catch (restoreError) { options.onRestoreError?.(restoreError) }
      try { await options.ui?.resume?.() } catch (restoreError) { options.onRestoreError?.(restoreError) }
      suspended = false
      options.onReleaseError?.(error)
      throw error
    }
  }

  async function resume(): Promise<void> {
    if (!suspended) return
    lastRestoreError = undefined
    try {
      await options.restoreInk?.()
    } catch (error) {
      lastRestoreError = error
      options.onRestoreError?.(error)
    }
    try {
      await options.ui?.resume?.()
    } catch (error) {
      lastRestoreError ??= error
      options.onRestoreError?.(error)
    }
    suspended = false
    options.onStateChange?.("resumed")
  }

  async function run<T>(task: () => Promise<T>): Promise<T> {
    if (disposed) throw new Error("Interactive child lifecycle is already closed.")
    if (running) throw new Error("An interactive child is already running; refusing a nested child.")
    running = true
    let failed = false
    try {
      await suspend()
      return await task()
    } catch (error) {
      failed = true
      throw error
    } finally {
      try {
        await resume()
      } finally {
        running = false
      }
      if (!failed && lastRestoreError !== undefined) throw lastRestoreError
    }
  }

  async function dispose(): Promise<void> {
    if (disposed) return
    await resume()
    disposed = true
  }

  return {
    get active() { return running },
    get suspended() { return suspended },
    suspend,
    resume,
    run,
    dispose,
  }
}

// ---- terminal restoration on exit ----

/** Show the cursor and reset attributes. Ink owns alternate-screen cleanup. */
export const RESTORE_SEQUENCE = "\u001b[?25h\u001b[0m"

export interface TerminalLike {
  on(event: string, listener: () => void): unknown
  removeListener(event: string, listener: () => void): unknown
  kill(pid: number, signal?: NodeJS.Signals): unknown
  readonly pid: number
  exit?(code?: number): void
}

export interface TerminalRestorationOptions {
  /** Raw terminal writer (stdout or an injected sink in tests). */
  write: (chunk: string) => void
  /** Additional synchronous cleanup, e.g. show the cursor / leave raw mode. */
  restore?: () => void | Promise<void>
  signals?: NodeJS.Signals[]
  /** Defaults to the real process. */
  proc?: TerminalLike
  /** Re-raise by signal by default; set a code to exit instead. */
  exitCodeOnSignal?: number
  onError?: (error: unknown) => void
}

export interface TerminalRestoration {
  install(): void
  /** Remove listeners and restore once. */
  finish(): void
  /** Remove listeners without restoring (caller already restored). */
  dispose(): void
  restoreNow(): void
  readonly installed: boolean
  readonly restored: boolean
}

/**
 * Restore cursor/attributes on normal exit, SIGINT, and SIGTERM. Signal
 * handlers restore first, then re-raise the signal so the process still exits
 * with normal signal semantics. Hook failures are reported, never thrown.
 */
export function createTerminalRestoration(options: TerminalRestorationOptions): TerminalRestoration {
  const proc = options.proc ?? (process as unknown as TerminalLike)
  const signals = options.signals ?? (["SIGINT", "SIGTERM"] as NodeJS.Signals[])
  let installed = false
  let restored = false
  const handlers = new Map<string, () => void>()

  function report(error: unknown): void {
    options.onError?.(error)
  }

  function restoreNow(): void {
    if (restored) return
    restored = true
    try {
      options.write(RESTORE_SEQUENCE)
    } catch (error) {
      report(error)
    }
    try {
      const result = options.restore?.()
      if (result && typeof (result as Promise<void>).then === "function") {
        void (result as Promise<void>).catch(report)
      }
    } catch (error) {
      report(error)
    }
  }

  function removeAll(): void {
    if (!installed) return
    for (const [event, handler] of handlers) {
      try { proc.removeListener(event, handler) } catch (error) { report(error) }
    }
    handlers.clear()
    installed = false
  }

  function onSignal(signal: NodeJS.Signals): void {
    restoreNow()
    removeAll()
    try {
      if (options.exitCodeOnSignal !== undefined && proc.exit) {
        proc.exit(options.exitCodeOnSignal)
      } else {
        proc.kill(proc.pid, signal)
      }
    } catch (error) {
      report(error)
    }
  }

  function install(): void {
    if (installed || restored) return
    const exitHandler = () => restoreNow()
    handlers.set("exit", exitHandler)
    for (const signal of signals) {
      const handler = () => onSignal(signal)
      handlers.set(signal, handler)
    }
    for (const [event, handler] of handlers) {
      try { proc.on(event, handler) } catch (error) { report(error) }
    }
    installed = true
  }

  function dispose(): void {
    removeAll()
  }

  function finish(): void {
    restoreNow()
    removeAll()
  }

  return {
    install,
    finish,
    dispose,
    restoreNow,
    get installed() { return installed },
    get restored() { return restored },
  }
}
