// Presentation-mode selection and the non-Ink (plain/JSON) presentation.
//
// This module is deliberately free of Ink/react imports: the plain fallback
// must stay importable by plain Node type-stripping and must never pull the
// TUI stack into a headless install. The Ink presentation lives elsewhere.
import { createPrompter, createUi } from "./ui.ts"
import { sanitizeDetail } from "./runtime.ts"
import type {
  Logger, Presentation, ProgressEvent, ProgressReporter, PromptRequest, StepStatus, Ui, UiIo, UiMode,
} from "./types.ts"

/** Options that influence mode selection. `CliOptions` satisfies this. */
export interface UiModeOptions {
  json?: boolean
  /** Force plain text even on an interactive TTY (`--plain`). */
  plain?: boolean
  /** Alias for `--no-ink`; parsed into `plain` today, kept for callers. */
  noInk?: boolean
}

/** True when `CI` carries a conventional truthy value. */
export function envTruthy(value: string | undefined): boolean {
  if (value === undefined) return false
  const normalized = value.trim().toLowerCase()
  return normalized !== "" && normalized !== "0" && normalized !== "false" && normalized !== "no"
}

function envString(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase()
}

/**
 * Capture the real process IO once, at the edge. Pure helpers below take the
 * captured value so tests never need to mutate `process`.
 */
export function createUiIo(env: NodeJS.ProcessEnv = process.env): UiIo {
  return {
    stdoutTTY: !!process.stdout.isTTY,
    stdinTTY: !!process.stdin.isTTY,
    env,
  }
}

/**
 * Select the installer presentation mode.
 *
 * Precedence (A04 §5):
 *   1. `--json` always wins: machine output must never be mixed with TUI/UI text.
 *   2. plain when explicitly requested (`--plain`/`--no-ink`), when either
 *      stream is not a TTY, under CI, when `TERM=dumb`, or when the operator
 *      set `OPENCODE_SPOTIFY_UI=plain`.
 *   3. otherwise Ink.
 */
export function selectUiMode(options: UiModeOptions, io: UiIo): UiMode {
  if (options.json) return "json"
  if (options.plain || options.noInk) return "plain"
  if (!io.stdoutTTY || !io.stdinTTY) return "plain"
  if (envTruthy(io.env.CI)) return "plain"
  if (envString(io.env.TERM) === "dumb") return "plain"
  if (envString(io.env.OPENCODE_SPOTIFY_UI) === "plain") return "plain"
  return "ink"
}

/** Convenience predicate for main: Ink is safe only when selection says so. */
export function shouldUseInk(options: UiModeOptions, io: UiIo = createUiIo()): boolean {
  return selectUiMode(options, io) === "ink"
}

/**
 * Whether the plain fallback may paint ANSI. `--no-color`, `NO_COLOR`, a
 * non-TTY stdout, and `TERM=dumb` all force no ANSI; explicit color must still
 * be requested by the caller. This is intentionally separate from mode
 * selection: color never decides Ink vs plain.
 */
export function plainColorEnabled(requested: boolean, io: UiIo): boolean {
  if (!requested) return false
  if (!io.stdoutTTY) return false
  if ((io.env.NO_COLOR ?? "") !== "") return false
  if (envString(io.env.TERM) === "dumb") return false
  return true
}

const STEP_KIND: Record<StepStatus, Parameters<Ui["status"]>[0]> = {
  pending: "info",
  running: "info",
  ok: "ok",
  failed: "fail",
  skipped: "missing",
}

function stepText(event: Extract<ProgressEvent, { type: "step" }>): string {
  const subject = event.description ?? event.id
  return event.detail ? `${subject} - ${event.detail}` : subject
}

function promptText(request: PromptRequest): string {
  switch (request.kind) {
    case "ask":
      return request.question
    case "choose": {
      const choices = request.choices.map((choice, index) => `${index + 1}. ${choice.label}`).join("  ")
      return `${request.question} ${choices} [${request.defaultIndex + 1}]`
    }
    case "confirm":
      if (request.phrase) return `${request.question} (type ${request.phrase} to continue)`
      return `${request.question} [${request.defaultYes ? "Y/n" : "y/N"}]`
  }
}

/**
 * Plain-mode progress reporter (canonical plain renderer).
 *
 * In plain mode it renders deterministic, uncolored-when-required lines
 * through the Ui so activity, plan steps and prompts share one output stream.
 * In JSON mode it stays completely silent: the single JSON document is written
 * by `ui.json`, and progress text must never corrupt it.
 *
 * Wording is the pre-event installer output (B24):
 *   * numbered plan bullets with the "(verification only)" marker,
 *   * success lines and the four-line failure summary,
 *   * dry-run lines and the unchanged two-space bridge progress line,
 *   * no step ids or "(pending)"/"(running)" noise on ordinary steps.
 */
export function createPlainReporter(ui: Ui, silent = false): ProgressReporter {
  const write = (line: string) => { if (!silent) ui.line(line) }
  let order: string[] = []
  const descriptions = new Map<string, string>()
  const completed: string[] = []
  let hasPlan = false

  const emit = (event: ProgressEvent) => {
    if (silent) return
    switch (event.type) {
      case "phase":
        ui.section(event.label)
        break
      case "plan":
        hasPlan = true
        order = event.steps.map((step) => step.id)
        descriptions.clear()
        completed.length = 0
        ui.section(event.title)
        event.steps.forEach((step, index) => {
          descriptions.set(step.id, step.description)
          ui.bullet(`${index + 1}. ${step.description}${step.mutates ? "" : " (verification only)"}`)
        })
        break
      case "step": {
        // Without a plan (non-executePlan callers) keep the generic
        // status-line rendering; with a plan use the installer's historical
        // wording, which never prints "(pending)"/"(running)".
        if (!hasPlan) {
          ui.status(STEP_KIND[event.status], stepText(event))
          break
        }
        const description = descriptions.get(event.id) ?? event.description ?? event.id
        if (event.status === "running" || event.status === "pending") break
        if (event.status === "ok") {
          if (!completed.includes(event.id)) completed.push(event.id)
          ui.success(description)
          break
        }
        if (event.status === "failed") {
          const index = order.indexOf(event.id)
          const notRun = index >= 0 ? order.slice(index + 1) : []
          const reason = sanitizeDetail(event.detail ?? "The step failed.")
          ui.error(`Stopped at: ${event.id} - ${description}`)
          ui.line(`   Reason: ${reason}`)
          ui.line(`   Completed stages: ${completed.length ? completed.join(", ") : "none"}`)
          ui.line(`   Not run: ${notRun.length ? notRun.join(", ") : "none"}`)
          break
        }
        if (event.status === "skipped" && event.detail === "dry-run") ui.dryRun(description)
        break
      }
      case "log":
        switch (event.level) {
          case "success": ui.success(event.message); break
          case "warn": ui.warn(event.message); break
          case "error": ui.error(event.message); break
          case "debug": write(`debug: ${event.message}`); break
          default: write(event.message); break
        }
        break
      case "progress": {
        // B24 wording: executePlan forwards the bare bridge line (scope
        // "apply"), rendered exactly as before with two leading spaces.
        // Other scopes keep the explicit "scope: message" form.
        const percent = event.percent === undefined ? "" : ` (${event.percent}%)`
        write(event.scope === "apply"
          ? `  ${event.message}${percent}`
          : `  ${event.scope}: ${event.message}${percent}`)
        break
      }
      case "prompt":
        if (event.request) write(`  ${promptText(event.request)}`)
        break
      case "cancel": {
        // B32: the plain renderer states exactly what cancellation is waiting
        // for and how to escalate, matching the Ink view.
        if (event.phase === "settled") {
          ui.warn(event.forced ? "Cancelled (forced)." : "Cancelled.")
          break
        }
        const waiting = event.forced
          ? "Cancelling - force requested"
          : event.stepId ? `Cancelling - waiting for ${event.stepId}` : "Cancelling"
        ui.warn(waiting)
        if (event.forced) ui.line("  Force requested; stopping the current step.")
        else ui.line("  press Ctrl+C again to force")
        break
      }
      case "detection":
      case "result":
        break
    }
  }
  return {
    emit,
    phase: (phase, label) => emit({ type: "phase", phase, label: label ?? phase, at: Date.now() }),
    step: (id, status, detail) => emit({ type: "step", id, status, detail, at: Date.now() }),
    log: (level, message) => emit({ type: "log", level, message, at: Date.now() }),
    progress: (scope, message, percent) => emit({ type: "progress", scope, message, percent, at: Date.now() }),
    prompt: (request) => emit({ type: "prompt", request, at: Date.now() }),
  }
}

export interface PlainPresentationOptions {
  /** Explicit color request (`--color` is the default). */
  color: boolean
  /** JSON mode: UI is silent and `ui.json` writes the one document. */
  json: boolean
  /** Injectable IO for tests; defaults to the real process. */
  io?: UiIo
}

/**
 * Build the plain/JSON presentation. `createUi` keeps its exact historical
 * output; the presentation only adds a prompter, a progress reporter and a
 * coordinated close. `suspend`/`resume`/`close` are no-ops because a plain
 * terminal has no alternate screen to release.
 */
export function createPlainPresentation(
  log: Logger,
  options: PlainPresentationOptions,
): Presentation {
  const io = options.io ?? createUiIo()
  const ui = createUi(log, { color: plainColorEnabled(options.color, io), json: options.json })
  const prompt = createPrompter(log)
  const report = createPlainReporter(ui, options.json)
  let closed = false
  return {
    mode: options.json ? "json" : "plain",
    ui,
    prompt,
    report,
    async close() {
      if (closed) return
      closed = true
      try { prompt.close() } catch { /* already closed */ }
      try { await ui.close?.() } catch { /* never fail shutdown on UI cleanup */ }
    },
  }
}
