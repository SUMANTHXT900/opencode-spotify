// Repair-plan presentation.
//
// A pure view model for the repair plan (`buildRepairView`) plus a
// plain-text renderer (`renderRepairViewPlain`). The Ink tree and the
// plain fallback consume the same model, so neither can diverge from the
// steps that will actually run.
//
// This module deliberately has no Ink/React imports so it stays importable by
// plain Node type-stripping and by JSON-only code paths.
import type {
  InstallerPhase,
  InstallerPlanView,
  PlanStep,
  PlanStepView,
  StepStatus,
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
