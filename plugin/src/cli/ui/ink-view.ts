// Pure, Ink-free view model for the interactive installer shell (A03 section 4).
//
// This module must never import ink or react. `ink.ts` owns the only dynamic
// import so core workflows, plain mode and tests can load this file under plain
// Node type-stripping without the TUI stack being installed. Output is ASCII
// only: no box-drawing borders, no braille spinners.
import type { Detection, InstallerSnapshot, PromptRequest, StepStatus } from "../types.ts"
import { glyphsFor, type Glyphs } from "./glyphs.ts"
import { layoutFor, type Layout } from "./layout.ts"
import { truncateDisplay, wrapDisplay } from "./normalize.ts"

export type InkTone = "default" | "dim" | "bold" | "ok" | "warn" | "error" | "accent"

export type InkRowKind =
  | "header"
  | "meta"
  | "rule"
  | "section"
  | "step"
  | "detail"
  | "activity"
  | "progress"
  | "prompt"
  | "hint"

/** Structured metadata for a progress row so Ink can mount a real ProgressBar. */
export interface InkProgressMeta {
  percent: number
  /** Rendered as "NN%". */
  label: string
  message: string
  spinner: string
  /** Fixed cell width of the bar, shared with the ASCII fallback. */
  barWidth: number
}

export interface InkRow {
  kind: InkRowKind
  tone: InkTone
  /** Already sanitized, width-fitted and free of ANSI/control characters. */
  text: string
  /** Present only for progress rows that carry a real, explicit percentage. */
  progress?: InkProgressMeta
}

export interface InkChoiceView {
  index: number
  label: string
  hint?: string
  selected: boolean
}

/** Transient prompt state owned by the input shell, never persisted to the store. */
export interface InkPromptState {
  /** Mismatched ids are ignored, so a stale render cannot show the wrong prompt. */
  id?: string
  input?: string
  selectedIndex?: number
  error?: string
}

export interface InkViewOptions {
  prompt?: InkPromptState
  /** Advances the ASCII spinner. Deterministic for tests. */
  frame?: number
}

export interface InkView {
  width: number
  rows: InkRow[]
}

/** ASCII spinner frames required by A03 (no braille). */
export const SPINNER_FRAMES = ["|", "/", "-", "\\"] as const

/**
 * B25: the approval/safety section (source URL, revision, SHA-256, size,
 * effects and non-effects) is written as activity entries before the prompt.
 * Keep enough of the window that it can never be truncated before the prompt.
 */
export const MAX_ACTIVITY_ROWS = 40

/** ASCII markers only. `[x]` for done, never a Unicode check mark. */
export function spinnerFrame(frame = 0): string {
  const index = ((Math.trunc(frame) % SPINNER_FRAMES.length) + SPINNER_FRAMES.length) % SPINNER_FRAMES.length
  return SPINNER_FRAMES[index]!
}

export function statusMarker(status: StepStatus, frame = 0): string {
  switch (status) {
    case "pending": return "[ ]"
    case "running": return spinnerFrame(frame)
    case "ok": return "[x]"
    case "failed": return "[!]"
    case "skipped": return "[-]"
  }
}

function statusTone(status: StepStatus): InkTone {
  switch (status) {
    case "pending": return "dim"
    case "running": return "accent"
    case "ok": return "ok"
    case "failed": return "error"
    case "skipped": return "dim"
  }
}

function levelMarker(level: "info" | "success" | "warn" | "error" | "debug"): string {
  switch (level) {
    case "success": return "[OK]"
    case "warn": return "[!!]"
    case "error": return "[XX]"
    case "debug": return "[--]"
    default: return "[..]"
  }
}

function levelTone(level: "info" | "success" | "warn" | "error" | "debug"): InkTone {
  switch (level) {
    case "success": return "ok"
    case "warn": return "warn"
    case "error": return "error"
    case "debug": return "dim"
    default: return "default"
  }
}

const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g
const CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g

/** Strip ANSI escapes and control characters so target output cannot inject. */
export function sanitize(text: string): string {
  return text
    .replace(ANSI_PATTERN, "")
    .replace(/\r\n?/g, " ")
    .replace(/\n/g, " ")
    .replace(/\t/g, " ")
    .replace(CONTROL_PATTERN, " ")
}

/** Truncate by code point with an ASCII ellipsis; never exceed `width`. */
export function fitText(text: string, width: number): string {
  const limit = Math.max(0, Math.floor(Number.isFinite(width) ? width : 0))
  const chars = Array.from(text)
  if (chars.length <= limit) return text
  if (limit <= 3) return ".".repeat(limit)
  return `${chars.slice(0, limit - 3).join("")}...`
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/** Width/clamp + glyph-aware truncation used by the live view. */
function fitFor(text: string, width: number, glyphs: Glyphs): string {
  return truncateDisplay(text, width, glyphs.ellipsis)
}

function safePercent(percent: number): number {
  if (!Number.isFinite(percent)) return 0
  return clamp(percent, 0, 100)
}

/** Keep a bounded inline region: a few leading context rows, then the newest. */
export function limitRows(rows: InkRow[], maxRows: number): InkRow[] {
  const limit = Math.max(1, Math.floor(Number.isFinite(maxRows) ? maxRows : 1))
  if (rows.length <= limit) return rows.slice()
  if (limit <= 6) return rows.slice(-limit)
  return [
    ...rows.slice(0, 3),
    { kind: "detail", tone: "dim", text: "..." },
    ...rows.slice(-(limit - 4)),
  ]
}

/**
 * Bound only the activity block, so the plan, prompt, cancel hints and result
 * rows are always pinned. Approval/safety content lives in activity, which is
 * why the window is generous; the oldest entries get an ellipsis marker.
 */
export function limitViewRows(rows: InkRow[], maxRows: number): InkRow[] {
  const limit = Math.max(1, Math.floor(Number.isFinite(maxRows) ? maxRows : 1))
  if (rows.length <= limit) return rows.slice()
  const activity = rows.filter((row) => row.kind === "activity")
  if (activity.length === 0) return limitRows(rows, limit)
  const first = rows.findIndex((row) => row.kind === "activity")
  let last = first
  for (let index = first; index < rows.length; index++) {
    if (rows[index]!.kind === "activity") last = index
  }
  const budget = Math.max(1, limit - (rows.length - activity.length))
  let kept = activity
  if (activity.length > budget) {
    kept = budget <= 3
      ? activity.slice(-budget)
      : [activity[0]!, { kind: "detail", tone: "dim", text: "..." }, ...activity.slice(-(budget - 2))]
  }
  return [...rows.slice(0, first), ...kept, ...rows.slice(last + 1)]
}

function promptInput(request: PromptRequest, state: InkPromptState | undefined): string {
  if (state?.input !== undefined) return state.input
  return request.kind === "ask" ? request.initial ?? "" : ""
}

function promptSelection(
  request: PromptRequest,
  state: InkPromptState | undefined,
): number {
  if (request.kind !== "choose") return 0
  const count = request.choices.length
  const fallback = count > 0 ? clamp(request.defaultIndex, 0, count - 1) : 0
  if (state?.selectedIndex === undefined || count <= 0) return fallback
  return clamp(state.selectedIndex, 0, count - 1)
}

/**
 * Rows for the active prompt. Kept separate from `toInkView` so the shell can
 * render transient input state without dispatching keystrokes into the store.
 */
export function toPromptRows(
  request: PromptRequest,
  width: number,
  state: InkPromptState = {},
): InkRow[] {
  const layout = layoutFor(width)
  const glyphs = glyphsFor(layout)
  const limit = layout.width
  const rows: InkRow[] = []
  const add = (tone: InkTone, text: string) => {
    rows.push({ kind: "prompt", tone, text: fitFor(sanitize(text), limit, glyphs) })
  }
  // Prompt prose must never be cut off: destructive consent includes the exact
  // phrase instruction on a later line. Wrap by display width instead of
  // truncating, preserving explicit newlines as paragraph breaks.
  const addWrapped = (text: string, prefix: string, tone: InkTone) => {
    const continuation = " ".repeat(prefix.length)
    text.split("\n").forEach((paragraph, paragraphIndex) => {
      const chunks = wrapDisplay(sanitize(paragraph), Math.max(1, limit - prefix.length))
      if (chunks.length === 0) chunks.push("")
      chunks.forEach((chunk, index) => {
        const lead = index === 0 && paragraphIndex === 0 ? prefix : continuation
        add(tone, `${lead}${chunk}`)
      })
    })
  }
  const input = promptInput(request, state)
  const selection = promptSelection(request, state)

  switch (request.kind) {
    case "ask":
      addWrapped(request.question, "? ", "accent")
      add("default", `> ${input}_`)
      break
    case "choose": {
      addWrapped(request.question, "? ", "accent")
      request.choices.forEach((choice, index) => {
        const hint = choice.hint ? ` - ${choice.hint}` : ""
        add(index === selection ? "accent" : "default", `${index === selection ? ">" : " "} ${index + 1}. ${choice.label}${hint}`)
      })
      const fallback = request.choices.length > 0
        ? ` (Enter for ${clamp(request.defaultIndex, 0, request.choices.length - 1) + 1})`
        : ""
      add("default", `> ${input}_${input.length ? "" : fallback}`)
      break
    }
    case "confirm":
      if (request.phrase) {
        addWrapped(request.question, "? ", "accent")
        addWrapped(`Type "${request.phrase}" to continue:`, "  ", "default")
        add("default", `> ${input}_`)
      } else {
        addWrapped(`${request.question} ${request.defaultYes ? "[Y/n]" : "[y/N]"}`, "? ", "accent")
        add("default", `> ${input}_`)
      }
      break
  }

  if (state.error) addWrapped(`! ${state.error}`, "", "error")
  return rows
}

function detectionRows(detection: Detection): Array<{ tone: InkTone; text: string }> {
  const rows: Array<{ tone: InkTone; text: string }> = []
  const add = (ok: boolean, text: string) => rows.push({ tone: ok ? "ok" : "warn", text: `${ok ? "[x]" : "[ ]"} ${text}` })

  add(true, `${detection.windows ? detection.windowsVersion : "Unsupported OS"} | ${detection.arch} | Node ${detection.node}`)
  add(
    detection.opencode.available,
    detection.opencode.available
      ? `OpenCode ${detection.opencode.version ?? "version unknown"}`
      : "OpenCode not found",
  )
  const plugin = detection.opencode.plugin
  add(
    plugin.registered,
    plugin.registered
      ? `Plugin ${plugin.version ?? "version unknown"}${plugin.local ? " (local)" : ""}`
      : "Plugin not registered",
  )
  add(
    detection.spotify.installed,
    detection.spotify.installed
      ? `Spotify${detection.spotify.store ? " (Store)" : ""}`
      : "Spotify not installed",
  )
  add(
    detection.spicetify.available,
    detection.spicetify.available
      ? `Spicetify ${detection.spicetify.version ?? "version unknown"}`
      : "Spicetify not installed",
  )
  add(
    detection.bridge.installed && detection.bridge.credentialValid,
    `Bridge ${detection.bridge.registration}${detection.bridge.credentialValid ? "" : " | credential missing"}`,
  )
  add(!detection.port.busy, detection.port.busy ? "Bridge port busy" : "Bridge port free")
  return rows
}

/**
 * Pure snapshot -> inline rows. Width is a hard bound for every row, so a
 * resize cannot produce a line wider than the terminal. `options.prompt`
 * carries transient typing state; `options.frame` drives the ASCII spinner.
 */
export function toInkView(
  snapshot: InstallerSnapshot,
  width: number,
  options: InkViewOptions = {},
): InkView {
  const layout = layoutFor(width)
  const glyphs = glyphsFor(layout)
  const w = layout.width
  const frame = options.frame ?? 0
  const rows: InkRow[] = []
  const add = (kind: InkRowKind, tone: InkTone, text: string) => {
    rows.push({ kind, tone, text: fitFor(sanitize(text), w, glyphs) })
  }
  const addSection = (title: string) => add("section", "bold", `${glyphs.rule} ${title}`)
  const separator = layout.ascii ? " | " : " \u00B7 "

  const title = "OpenCode Spotify"
  const version = `v${snapshot.version}`
  const gap = Math.max(1, w - Array.from(title).length - Array.from(version).length)
  add("header", "bold", `${title}${" ".repeat(gap)}${version}`)
  add(
    "meta",
    "dim",
    [snapshot.command, snapshot.windows ? "Windows" : "Non-Windows", `${snapshot.phase} - ${snapshot.phaseLabel}`].join(separator),
  )

  if (snapshot.detection) {
    addSection("System")
    for (const row of detectionRows(snapshot.detection)) add("detail", row.tone, row.text)
  }

  if (snapshot.plan) {
    const done = snapshot.plan.steps.filter((step) => step.status === "ok").length
    addSection(`Plan - ${snapshot.plan.title} (${done}/${snapshot.plan.steps.length})`)
    for (const step of snapshot.plan.steps) {
      const marker = statusMarker(step.status, frame)
      add("step", statusTone(step.status), `  ${marker} ${step.description}`)
      if (step.detail) add("detail", statusTone(step.status), `      ${step.detail}`)
    }
  }

  if (snapshot.progress) {
    const progress = snapshot.progress
    if (typeof progress.percent === "number") {
      const percent = safePercent(progress.percent)
      const barWidth = Math.max(4, Math.min(24, w - 30))
      const filled = Math.round((percent / 100) * barWidth)
      const bar = `${"#".repeat(filled)}${"-".repeat(barWidth - filled)}`
      const spinner = spinnerFrame(frame)
      rows.push({
        kind: "progress",
        tone: "accent",
        text: fitFor(sanitize(`[${spinner}] [${bar}] ${percent}% ${progress.message}`), w, glyphs),
        progress: {
          percent,
          label: `${percent}%`,
          message: sanitize(progress.message),
          spinner,
          barWidth,
        },
      })
    } else {
      add("progress", "accent", `[${spinnerFrame(frame)}] ${progress.scope}: ${progress.message}`)
    }
  }

  const recent = snapshot.activity.slice(-MAX_ACTIVITY_ROWS)
  if (recent.length > 0) {
    addSection("Activity")
    for (const entry of recent) {
      add("activity", levelTone(entry.level), `${levelMarker(entry.level)} ${entry.message}`)
    }
  }

  if (snapshot.cancel) {
    const cancel = snapshot.cancel
    const label = cancel.phase === "settled"
      ? (cancel.forced ? "Cancelled (forced)" : "Cancelled")
      : cancel.forced
        ? "Cancelling - force requested"
        : cancel.stepId
          ? `Cancelling - waiting for ${cancel.stepId}`
          : "Cancelling"
    add("progress", "warn", label)
    if (cancel.phase !== "settled") add("hint", "dim", "press Ctrl+C again to force")
  }

  const prompt = snapshot.prompt
  if (prompt) {
    const state = options.prompt && (!options.prompt.id || options.prompt.id === prompt.id)
      ? options.prompt
      : undefined
    for (const row of toPromptRows(prompt, w, state)) rows.push(row)
  }

  if (snapshot.exitCode !== undefined) {
    add("hint", "dim", `Exit ${snapshot.exitCode}`)
  } else if (prompt) {
    add("hint", "dim", "Enter submit | Esc cancel | Ctrl+C abort")
  } else if (snapshot.cancel) {
    add("hint", "dim", snapshot.cancel.forced ? "Force requested" : "Ctrl+C again forces")
  } else {
    add("hint", "dim", "Ctrl+C abort")
  }

  return { width: w, rows }
}
