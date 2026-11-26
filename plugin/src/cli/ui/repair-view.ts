// Repair-plan presentation and render-safe fallback.
//
// Two independent pieces live here:
//
//   1. A pure view model for the repair plan (`buildRepairView`) plus a
//      plain-text renderer (`renderRepairViewPlain`). The Ink tree and the
//      plain fallback consume the same model, so neither can diverge from the
//      steps that will actually run.
//   2. `runWithPresentationFallback`, which owns the "UI failed, keep going"
//      contract:
//        * Ink initialization failure falls back to plain text BEFORE `run`
//          is called, so no mutation can have happened yet.
//        * A render failure during `run` swaps the UI sink and continues the
//          SAME operation. `run` is never re-entered and no step is replayed.
//        * Rendering errors are swallowed after the swap: a broken terminal
//          must never turn a successful repair into a failed one, and must
//          never trigger a destructive retry.
//
// This module deliberately has no Ink/React imports so it stays importable by
// plain Node type-stripping and by JSON-only code paths.
import type {
  InstallerPhase,
  InstallerPlanView,
  PlanStep,
  PlanStepView,
  Presentation,
  ProgressReporter,
  Prompter,
  StepStatus,
  Ui,
  UiIo,
  UiMode,
} from "../types.ts"
import { plainColorEnabled, selectUiMode } from "../ui-mode.ts"

const ansi = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  red: "\u001b[31m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  cyan: "\u001b[36m",
} as const

export type PaintToken = keyof typeof ansi

/** Same palette as `createUi`; kept local so views stay renderer-agnostic. */
export function paint(color: boolean, token: PaintToken, text: string): string {
  return color ? `${ansi[token]}${text}${ansi.reset}` : text
}

export type BadgeKind = "ok" | "missing" | "warn" | "fail" | "info"

export function badge(kind: BadgeKind, color = false): string {
  switch (kind) {
    case "ok": return paint(color, "green", "[OK]")
    case "missing": return paint(color, "dim", "[--]")
    case "warn": return paint(color, "yellow", "[!!]")
    case "fail": return paint(color, "red", "[XX]")
    default: return paint(color, "cyan", "[..]")
  }
}

/** Badge for a plan step status, using the same vocabulary as diagnostics. */
export function stepBadge(status: StepStatus, color = false): string {
  switch (status) {
    case "ok": return badge("ok", color)
    case "failed": return badge("fail", color)
    case "skipped": return badge("missing", color)
    case "running": return badge("info", color)
    default: return badge("info", color)
  }
}

/**
 * Strip terminal control sequences and credential-shaped values from text
 * that may come from a child process. Keeps the message on one line so a
 * misbehaving child cannot forge extra UI rows.
 */
export function sanitizeConsoleText(message: string): string {
  return message
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/(--(?:token|secret|password|passwd|api-key|apikey|authorization)(?:=|\s+))(?:"[^"]*"|'[^']*'|\S+)/gi, "$1[redacted]")
    .replace(/\b[a-f0-9]{32,}\b/gi, "[redacted]")
    .replace(/\b(secret|token|password|credential|authorization)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240)
}

// ---- presentation mode (non-TTY / NO_COLOR / --plain) ----

export type ViewIo = UiIo

/**
 * Resolve the presentation mode through the shared A04 selector so the repair
 * screen, JSON output, and main agree on TTY/CI/`--plain` precedence.
 * Non-TTY always gets plain text; JSON is never upgraded to Ink.
 */
export function resolveUiMode(
  io: UiIo,
  options: { json?: boolean; plain?: boolean } = {},
): UiMode {
  return selectUiMode(options, io)
}

/**
 * Resolve color for plain output through the shared selector: `--no-color`/
 * `color: false` wins, then non-TTY stdout, NO_COLOR, and TERM=dumb.
 */
export function resolveColor(io: UiIo, requested = true): boolean {
  return plainColorEnabled(requested, io)
}

// ---- repair view model ----

export interface RepairView {
  title: string
  phase: InstallerPhase
  dryRun: boolean
  nonInteractive: boolean
  /** Present when the command refuses to build a plan (missing prerequisite). */
  blockedReason?: string
  steps: PlanStepView[]
  notes: string[]
}

export interface BuildRepairViewOptions {
  title?: string
  phase?: InstallerPhase
  dryRun?: boolean
  nonInteractive?: boolean
  blockedReason?: string
  /** Extra trailing notes; defaults are always included. */
  notes?: string[]
  /** Statuses observed so far, keyed by step id. */
  statuses?: Record<string, StepStatus>
  /** Per-step detail lines (sanitized by the caller), keyed by step id. */
  details?: Record<string, string>
}

/**
 * Build the repair plan view. Steps keep their real IDs and `mutates` flags so
 * dry-run/JSON/Ink/plain all describe exactly what would run.
 */
export function buildRepairView(steps: PlanStep[], options: BuildRepairViewOptions = {}): RepairView {
  const statuses = options.statuses ?? {}
  const dryRun = options.dryRun === true
  const notes: string[] = [
    "Repair only changes owned state: the global registration and the bridge extension.",
    "Project configuration and unrelated plugins are never edited.",
  ]
  if (steps.length) notes.push("Restart running OpenCode processes after repair.")
  if (dryRun) notes.push("Dry run: no changes will be made.")
  if (options.blockedReason) notes.push("No changes were made.")
  if (options.nonInteractive) notes.push("Noninteractive mode: missing consent cancels the plan without changes.")
  for (const extra of options.notes ?? []) {
    if (!notes.includes(extra)) notes.push(extra)
  }
  return {
    title: options.title ?? "Repair plan",
    phase: options.phase ?? "plan",
    dryRun,
    nonInteractive: options.nonInteractive === true,
    ...(options.blockedReason ? { blockedReason: options.blockedReason } : {}),
    steps: steps.map((step) => ({
      id: step.id,
      description: step.description,
      mutates: step.mutates,
      status: statuses[step.id] ?? "pending",
      ...(options.details?.[step.id] ? { detail: options.details[step.id] } : {}),
    })),
    notes: [...new Set(notes)],
  }
}

export interface PlainRenderOptions {
  color?: boolean
  width?: number
  /** Append the stable step id, useful in bug reports. Defaults to true. */
  showIds?: boolean
}

export function wrapText(text: string, width: number): string[] {
  if (width <= 0 || text.length <= width) return [text]
  const words = text.split(" ")
  const lines: string[] = []
  let line = ""
  for (const word of words) {
    if (!line) {
      line = word
    } else if (line.length + 1 + word.length <= width) {
      line += ` ${word}`
    } else {
      lines.push(line)
      line = word
    }
  }
  if (line) lines.push(line)
  return lines.length ? lines : [""]
}

function pushWrapped(lines: string[], prefix: string, text: string, width: number): void {
  const available = Math.max(20, width - prefix.length)
  const wrapped = wrapText(text, available)
  lines.push(`${prefix}${wrapped[0] ?? ""}`)
  for (const continuation of wrapped.slice(1)) {
    lines.push(`${" ".repeat(prefix.length)}${continuation}`)
  }
}

/**
 * Plain-text repair screen. No ANSI unless `color: true`, so non-TTY output,
 * NO_COLOR, and redirected logs stay clean. Long lines are wrapped to `width`
 * (default 100) so a narrow console does not lose the end of a step.
 */
export function renderRepairViewPlain(view: RepairView, options: PlainRenderOptions = {}): string[] {
  const color = options.color === true
  const width = options.width ?? 100
  const showIds = options.showIds !== false
  const lines: string[] = []

  lines.push(paint(color, "bold", view.title))
  const mode = view.dryRun ? "dry run - no changes" : "apply"
  lines.push(paint(color, "dim", `Phase: ${view.phase} - ${mode}`))
  lines.push("")

  if (view.blockedReason) {
    pushWrapped(lines, `  ${badge("fail", color)} `, `Blocked: ${view.blockedReason}`, width)
    lines.push("")
  }

  lines.push(paint(color, "bold", "Plan"))
  if (!view.steps.length) {
    const message = view.blockedReason ? "No steps will run." : "No owned registration or bridge repair is needed."
    lines.push(`  ${badge(view.blockedReason ? "fail" : "ok", color)} ${message}`)
  } else {
    view.steps.forEach((step, index) => {
      const suffix = step.mutates ? "" : " (verification only)"
      const id = showIds ? ` [${step.id}]` : ""
      const prefix = `  ${stepBadge(step.status, color)} ${index + 1}. `
      pushWrapped(lines, prefix, `${step.description}${suffix}${id}`, width)
      if (step.detail) {
        pushWrapped(lines, "       ", step.detail, width)
      }
    })
  }

  lines.push("")
  lines.push(paint(color, "bold", "Notes"))
  for (const note of view.notes) {
    pushWrapped(lines, "   - ", note, width)
  }
  return lines
}

/** Single-string convenience for callers that own the logger. */
export function renderRepairViewText(view: RepairView, options: PlainRenderOptions = {}): string {
  return renderRepairViewPlain(view, options).join("\n")
}

/** Preferred screen-renderer name for integration code. */
export const renderRepairPlan = renderRepairViewPlain

/** Alias matching the shared `InstallerPlanView` vocabulary. */
export type RepairPlanView = RepairView

/** Project the repair view into the structured installer snapshot plan. */
export function toInstallerPlanView(view: RepairView): InstallerPlanView {
  return { title: view.title, steps: view.steps.map((step) => ({ ...step })) }
}

// ---- render-safe presentation fallback ----

export interface PresentationFallbackInfo {
  reason: string
  origin: "init" | "render"
  mode: UiMode
}

export interface PresentationControl {
  mode(): UiMode
  isPlain(): boolean
  /** Number of fallbacks performed (0 or 1 in practice). */
  fallbacks(): number
  /** Switch to plain output now. Safe to call repeatedly. */
  fallback(reason: string, origin?: "init" | "render"): Presentation
  /** Run render-only code; a throw switches to plain and is not rethrown. */
  render(action: () => void): void
}

export interface PresentationFallbackOptions<T> {
  /** Rich presentation (Ink). May throw during initialization. */
  startInk(): Presentation | Promise<Presentation>
  /** Plain presentation. Must be constructible without a terminal renderer. */
  startPlain(): Presentation
  /**
   * The operation. Invoked exactly once. All mutations belong here; the
   * fallback machinery never calls this twice and never replays a step.
   */
  run(presentation: Presentation, control: PresentationControl): Promise<T>
  onFallback?(info: PresentationFallbackInfo): void
}

export interface PresentationFallbackResult<T> {
  result: T
  mode: UiMode
  fellBack: boolean
  fallbacks: number
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "unknown error"
  return sanitizeConsoleText(message) || "unknown error"
}

function noopPresentation(): Presentation {
  const ui: Ui = {
    banner() {}, title() {}, section() {}, line() {}, kv() {}, status() {}, bullet() {},
    warn() {}, error() {}, success() {}, json() {}, dryRun() {},
    async suspend() {}, async resume() {}, async close() {},
  }
  const prompt: Prompter = {
    async ask() { return undefined },
    async choose() { return undefined },
    async confirm() { return false },
    close() {},
  }
  const report: ProgressReporter = {
    emit() {}, phase() {}, step() {}, log() {}, progress() {}, prompt() {},
  }
  return { mode: "plain", ui, prompt, report, async close() {} }
}

/**
 * Run one operation behind a presentation that can degrade to plain text
 * without touching operation state.
 *
 * Guarantees, in order:
 *   1. `startInk` is attempted before `run`; if it throws, `startPlain` is used
 *      and `run` starts once in plain mode. No mutation exists yet.
 *   2. `run` is called exactly once. Render errors never re-enter it.
 *   3. UI/report/prompt calls that throw are retried once against the plain
 *      presentation, so the current step still reports its result.
 *   4. Every presentation that was opened is closed, including after failure.
 */
export async function runWithPresentationFallback<T>(
  options: PresentationFallbackOptions<T>,
): Promise<PresentationFallbackResult<T>> {
  let ink: Presentation | null = null
  let active: Presentation
  let fallbacks = 0
  let closed = false

  function notify(reason: string, origin: "init" | "render", mode: UiMode): void {
    if (!options.onFallback) return
    try {
      options.onFallback({ reason, origin, mode })
    } catch {
      // A reporting callback must not break the operation it describes.
    }
  }

  function switchToPlain(origin: "init" | "render", reason: string): Presentation {
    if (fallbacks > 0) return active
    let next: Presentation
    try {
      next = options.startPlain()
    } catch {
      next = noopPresentation()
    }
    active = next
    fallbacks += 1
    notify(describeError(reason), origin, active.mode)
    return next
  }

  try {
    ink = await options.startInk()
    active = ink
  } catch (error) {
    try {
      active = options.startPlain()
    } catch {
      active = noopPresentation()
    }
    fallbacks = 1
    notify(describeError(error), "init", active.mode)
  }

  const uiSyncNames = [
    "banner", "title", "section", "line", "kv", "status", "bullet", "warn", "error", "success", "json", "dryRun",
  ] as const
  type UiSyncName = typeof uiSyncNames[number]

  function uiSync(name: UiSyncName, args: unknown[]): void {
    try {
      ;(active.ui[name] as (...values: unknown[]) => void)(...args)
    } catch (error) {
      if (active.mode === "plain" && fallbacks > 0) return
      const next = switchToPlain("render", describeError(error))
      try {
        ;(next.ui[name] as (...values: unknown[]) => void)(...args)
      } catch {
        // The terminal is unusable; keep the operation alive.
      }
    }
  }

  async function uiAsync(name: "suspend" | "resume" | "close"): Promise<void> {
    const call = async (target: Presentation) => {
      const method = target.ui[name] as (() => Promise<void>) | undefined
      if (method) await method.call(target.ui)
    }
    try {
      await call(active)
    } catch (error) {
      if (active.mode === "plain" && fallbacks > 0) return
      const next = switchToPlain("render", describeError(error))
      try {
        await call(next)
      } catch {
        // Nothing useful left to restore; do not fail the operation.
      }
    }
  }

  const guardedUi: Ui = {
    banner: ((...args: Parameters<Ui["banner"]>) => uiSync("banner", args)) as Ui["banner"],
    title: ((...args: Parameters<Ui["title"]>) => uiSync("title", args)) as Ui["title"],
    section: ((...args: Parameters<Ui["section"]>) => uiSync("section", args)) as Ui["section"],
    line: ((...args: Parameters<Ui["line"]>) => uiSync("line", args)) as Ui["line"],
    kv: ((...args: Parameters<Ui["kv"]>) => uiSync("kv", args)) as Ui["kv"],
    status: ((...args: Parameters<Ui["status"]>) => uiSync("status", args)) as Ui["status"],
    bullet: ((...args: Parameters<Ui["bullet"]>) => uiSync("bullet", args)) as Ui["bullet"],
    warn: ((...args: Parameters<Ui["warn"]>) => uiSync("warn", args)) as Ui["warn"],
    error: ((...args: Parameters<Ui["error"]>) => uiSync("error", args)) as Ui["error"],
    success: ((...args: Parameters<Ui["success"]>) => uiSync("success", args)) as Ui["success"],
    json: ((...args: Parameters<Ui["json"]>) => uiSync("json", args)) as Ui["json"],
    dryRun: ((...args: Parameters<Ui["dryRun"]>) => uiSync("dryRun", args)) as Ui["dryRun"],
    suspend: () => uiAsync("suspend"),
    resume: () => uiAsync("resume"),
    close: () => uiAsync("close"),
  }

  const guardedPrompt: Prompter = {
    async ask(question) {
      try {
        return await active.prompt.ask(question)
      } catch (error) {
        if (active.mode === "plain" && fallbacks > 0) return undefined
        try {
          return await switchToPlain("render", describeError(error)).prompt.ask(question)
        } catch {
          return undefined
        }
      }
    },
    async choose(question, choices, defaultIndex = 0) {
      try {
        return await active.prompt.choose(question, choices, defaultIndex)
      } catch (error) {
        if (active.mode === "plain" && fallbacks > 0) return undefined
        try {
          return await switchToPlain("render", describeError(error)).prompt.choose(question, choices, defaultIndex)
        } catch {
          return undefined
        }
      }
    },
    async confirm(question, promptOptions = {}) {
      try {
        return await active.prompt.confirm(question, promptOptions)
      } catch (error) {
        if (active.mode === "plain" && fallbacks > 0) return false
        try {
          return await switchToPlain("render", describeError(error)).prompt.confirm(question, promptOptions)
        } catch {
          return false
        }
      }
    },
    close() {
      try { active.prompt.close() } catch { /* already closed */ }
    },
  }

  function reportCall(name: keyof ProgressReporter, args: unknown[]): void {
    try {
      ;(active.report[name] as (...values: unknown[]) => void)(...args)
    } catch (error) {
      if (active.mode === "plain" && fallbacks > 0) return
      const next = switchToPlain("render", describeError(error))
      try {
        ;(next.report[name] as (...values: unknown[]) => void)(...args)
      } catch {
        // Structured progress is best-effort once the terminal is gone.
      }
    }
  }

  const guardedReport: ProgressReporter = {
    emit: ((...args: Parameters<ProgressReporter["emit"]>) => reportCall("emit", args)) as ProgressReporter["emit"],
    phase: ((...args: Parameters<ProgressReporter["phase"]>) => reportCall("phase", args)) as ProgressReporter["phase"],
    step: ((...args: Parameters<ProgressReporter["step"]>) => reportCall("step", args)) as ProgressReporter["step"],
    log: ((...args: Parameters<ProgressReporter["log"]>) => reportCall("log", args)) as ProgressReporter["log"],
    progress: ((...args: Parameters<ProgressReporter["progress"]>) => reportCall("progress", args)) as ProgressReporter["progress"],
    prompt: ((...args: Parameters<ProgressReporter["prompt"]>) => reportCall("prompt", args)) as ProgressReporter["prompt"],
  }

  async function closeAll(): Promise<void> {
    if (closed) return
    closed = true
    const targets = [...new Set([active, ...(ink ? [ink] : [])])]
    for (const target of targets) {
      try {
        await target.close()
      } catch {
        // Closing a dead renderer must stay best-effort.
      }
    }
  }

  const control: PresentationControl = {
    mode: () => active.mode,
    isPlain: () => active.mode === "plain",
    fallbacks: () => fallbacks,
    fallback: (reason, origin = "render") => switchToPlain(origin, reason),
    render: (action) => {
      try {
        action()
      } catch (error) {
        if (active.mode === "plain" && fallbacks > 0) return
        switchToPlain("render", describeError(error))
      }
    },
  }

  const guardedPresentation: Presentation = {
    get mode() { return active.mode },
    ui: guardedUi,
    prompt: guardedPrompt,
    report: guardedReport,
    async close() { await closeAll() },
  }

  try {
    const result = await options.run(guardedPresentation, control)
    return { result, mode: active.mode, fellBack: fallbacks > 0, fallbacks }
  } finally {
    await closeAll()
  }
}
