// Diagnostics presentation: grouped results, actionable troubleshooting, and a
// sanitized report suitable for pasting into an issue.
//
// All functions here are pure: they return strings/objects and never write to
// the terminal. That keeps `doctor --json` free of Ink/ANSI, makes the plain
// fallback trivial, and means a render failure cannot affect diagnostics.
import { BRIDGE_PORT } from "../compat.ts"
import type { Detection, VersionInfo } from "../types.ts"
import { badge, paint, sanitizeConsoleText, wrapText } from "./repair-view.ts"

export type DiagnosticsStatus = "ok" | "warn" | "fail" | "info"

export interface DiagnosticCheckLike {
  id: string
  status: DiagnosticsStatus
  message: string
  fix?: string
}

export interface DiagnosticCheckView extends DiagnosticCheckLike {}

export interface TroubleshootingItem {
  checkId: string
  status: "warn" | "fail"
  title: string
  steps: string[]
}

export interface DiagnosticsSummary {
  ok: number
  warn: number
  fail: number
  info: number
}

export interface DiagnosticsView {
  title: string
  readOnly: true
  checks: DiagnosticCheckView[]
  summary: DiagnosticsSummary
  troubleshooting: TroubleshootingItem[]
  notes: string[]
}

export interface BuildDiagnosticsViewOptions {
  title?: string
  notes?: string[]
}

const CHECK_TITLES: Record<string, string> = {
  windows: "Platform",
  node: "Node.js",
  pwsh: "PowerShell",
  opencode: "OpenCode installation",
  "opencode-version": "OpenCode version",
  "opencode-config": "OpenCode configuration",
  "opencode-native": "OpenCode plugin commands",
  registration: "Global plugin registration",
  "project-conflict": "Project-local plugin conflict",
  "duplicate-registration": "Duplicate plugin sources",
  dependencies: "Runtime dependencies",
  updates: "Available updates",
  spotify: "Spotify Desktop",
  "spotify-store": "Microsoft Store Spotify",
  spicetify: "Spicetify",
  "spicetify-version": "Spicetify version",
  "spicetify-config": "Spicetify configuration",
  "bridge-registration": "Spicetify bridge registration",
  "bridge-credentials": "Bridge credentials",
  bridge: "Bridge compatibility",
  port: "Bridge port",
  compatibility: "Compatibility",
  connection: "Playback connectivity",
}

export function checkTitle(id: string): string {
  return CHECK_TITLES[id] ?? id
}

/** Actionable remediation for a check. Always safe: no destructive guesses. */
export function troubleshootingSteps(id: string): string[] {
  switch (id) {
    case "windows":
      return ["Run the installer on Windows 11 or a supported Windows 10 build; V0.6.0 changes files only on Windows."]
    case "node":
      return ["Install Node.js 22.18 or newer from https://nodejs.org, then reopen the terminal."]
    case "pwsh":
      return ["Install PowerShell 7 (`winget install --id Microsoft.PowerShell --exact`) and confirm `pwsh -v` works."]
    case "opencode":
      return ["Install OpenCode 2.3.0 or newer, then reopen the terminal so PATH is refreshed."]
    case "opencode-version":
      return ["Upgrade OpenCode with its official installer; the plugin needs 2.3.0 or newer."]
    case "opencode-config":
      return ["Run `opencode debug paths config` and confirm it exits successfully."]
    case "opencode-native":
      return ["Upgrade OpenCode; the installer relies on native `opencode plugin add/remove`."]
    case "registration":
      return [
        "Run `opencode-spotify repair` to reconcile the owned global registration.",
        "If inspection still fails, rerun `opencode-spotify doctor`; do not delete OpenCode configuration manually.",
      ]
    case "project-conflict":
      return ["Keep or remove the project-local plugin entry yourself; the installer never edits project configuration."]
    case "duplicate-registration":
      return [
        "Keep only one plugin source; the project copy can shadow the global package.",
        "Remove the project entry yourself when you want the global package; the installer never edits project configuration.",
      ]
    case "dependencies":
      return ["Reinstall with the official installer, then rerun `opencode-spotify doctor`; do not hand-copy node_modules."]
    case "spotify":
      return ["Install Spotify Desktop from Spotify, then rerun `opencode-spotify setup`."]
    case "spotify-store":
      return ["Restart Spotify, then rerun `opencode-spotify repair` if the bridge stops after a Store update."]
    case "spicetify":
      return ["Run `opencode-spotify setup` and choose automatic or manual Spicetify installation."]
    case "spicetify-version":
      return ["Upgrade Spicetify with the owner-specific method shown above; do not mix package managers."]
    case "spicetify-config":
      return ["Run `spicetify -c` and confirm Spotify/Spicetify are configured; then rerun `opencode-spotify repair`."]
    case "bridge-registration":
      return ["Run `opencode-spotify repair` to register the bridge extension."]
    case "bridge-credentials":
      return ["Run `opencode-spotify repair`; do not delete the credential file unless you accept re-pairing."]
    case "bridge":
      return ["Run `opencode-spotify repair` to synchronize the extension and its registration."]
    case "port":
      return [
        `Identify the listener with \`Get-NetTCPConnection -LocalPort ${BRIDGE_PORT}\`.`,
        "Close the conflicting application or leave that port alone; the installer never terminates an unknown process.",
      ]
    case "compatibility":
      return ["Run `opencode-spotify update --dry-run` to review compatible updates, then `opencode-spotify update`."]
    case "connection":
      return []
    default:
      return ["Rerun `opencode-spotify doctor --verbose`. If the problem persists, attach a sanitized report."]
  }
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

/**
 * Group raw checks (typically `doctorChecks`) into a stable, sanitized view.
 * Messages are stripped of terminal control codes and credential-shaped text
 * before they reach any renderer.
 */
export function buildDiagnosticsView(
  checks: readonly DiagnosticCheckLike[],
  options: BuildDiagnosticsViewOptions = {},
): DiagnosticsView {
  const normalized: DiagnosticCheckView[] = checks.map((check, index) => {
    const id = sanitizeConsoleText(check.id) || `check-${index + 1}`
    return {
      id,
      status: check.status,
      message: sanitizeConsoleText(check.message) || "(no detail)",
      ...(check.fix ? { fix: sanitizeConsoleText(check.fix) } : {}),
    }
  })
  const summary: DiagnosticsSummary = {
    ok: normalized.filter((check) => check.status === "ok").length,
    warn: normalized.filter((check) => check.status === "warn").length,
    fail: normalized.filter((check) => check.status === "fail").length,
    info: normalized.filter((check) => check.status === "info").length,
  }
  const troubleshooting: TroubleshootingItem[] = normalized
    .filter((check): check is DiagnosticCheckView & { status: "warn" | "fail" } =>
      check.status === "warn" || check.status === "fail")
    .map((check) => ({
      checkId: check.id,
      status: check.status,
      title: checkTitle(check.id),
      steps: dedupe([...(check.fix ? [check.fix] : []), ...troubleshootingSteps(check.id)]),
    }))
  const notes = dedupe([
    "Read-only: diagnostics did not change installed files.",
    "Bridge connectivity is verified only while Spotify and OpenCode are running.",
    ...(options.notes ?? []),
  ])
  return {
    title: options.title ?? "Diagnostics (read-only)",
    readOnly: true,
    checks: normalized,
    summary,
    troubleshooting,
    notes,
  }
}

export interface PlainDiagnosticsOptions {
  color?: boolean
  /** Include informational checks (shown by default, matching doctor). */
  verbose?: boolean
  width?: number
}

function pushWrapped(lines: string[], prefix: string, text: string, width: number): void {
  const wrapped = wrapText(text, Math.max(20, width - prefix.length))
  lines.push(`${prefix}${wrapped[0] ?? ""}`)
  for (const continuation of wrapped.slice(1)) {
    lines.push(`${" ".repeat(prefix.length)}${continuation}`)
  }
}

function statusKind(status: DiagnosticsStatus): "ok" | "warn" | "fail" | "info" {
  return status === "ok" ? "ok" : status === "fail" ? "fail" : status === "warn" ? "warn" : "info"
}

/**
 * Plain diagnostics screen with fixes and troubleshooting. No ANSI unless
 * `color: true`; callers pass `resolveColor(...)` so `--no-color`, NO_COLOR,
 * and non-TTY output all stay clean.
 */
export function renderDiagnosticsViewPlain(
  view: DiagnosticsView,
  options: PlainDiagnosticsOptions = {},
): string[] {
  const color = options.color === true
  const width = options.width ?? 100
  const verbose = options.verbose !== false
  const lines: string[] = []

  lines.push(paint(color, "bold", view.title))
  lines.push("")
  for (const check of view.checks) {
    if (!verbose && check.status === "info") continue
    pushWrapped(lines, `  ${badge(statusKind(check.status), color)} `, check.message, width)
    if (check.fix) pushWrapped(lines, "       Fix: ", check.fix, width)
  }

  if (view.troubleshooting.length) {
    lines.push("")
    lines.push(paint(color, "bold", "Troubleshooting"))
    view.troubleshooting.forEach((item, index) => {
      lines.push(`  ${index + 1}. ${item.title} (${item.checkId})`)
      for (const step of item.steps) {
        pushWrapped(lines, "     - ", step, width)
      }
    })
  }

  const { ok, warn, fail, info } = view.summary
  lines.push("")
  lines.push(paint(color, "bold", "Summary"))
  lines.push(`  ${ok} ok, ${warn} warning(s), ${fail} failure(s)${info ? `, ${info} info` : ""}`)
  lines.push("  No changes were made. Use `opencode-spotify repair` or `setup` for fixes.")
  for (const note of view.notes) {
    pushWrapped(lines, "   - ", note, width)
  }
  return lines
}

export function renderDiagnosticsViewText(
  view: DiagnosticsView,
  options: PlainDiagnosticsOptions = {},
): string {
  return renderDiagnosticsViewPlain(view, options).join("\n")
}

/** Preferred screen-renderer name for integration code. */
export const renderDiagnostics = renderDiagnosticsViewPlain

// ---- sanitized report ----

export interface SanitizeDiagnosticsOptions {
  /** Account name to remove even outside recognizable path shapes. */
  user?: string
  /** Exact home directory to replace with `<home>`. */
  home?: string
}

/**
 * Redact credentials and identifying details while keeping the report useful.
 * Idempotent for the text it produces (redaction markers do not re-trigger).
 */
export function sanitizeDiagnosticsText(
  input: string,
  options: SanitizeDiagnosticsOptions = {},
): { text: string; redactions: number } {
  let text = String(input ?? "")
  let redactions = 0
  const apply = (pattern: RegExp, replacement: string) => {
    const matches = text.match(pattern)
    if (!matches?.length) return
    redactions += matches.length
    text = text.replace(pattern, replacement)
  }

  // Terminal control codes and invisible control characters.
  text = text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
  text = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")

  // Credential-shaped assignments and headers. Bearer values are redacted
  // before the assignment pattern so `Authorization: Bearer <token>` cannot
  // leave the token behind.
  apply(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
  apply(/(--(?:token|secret|password|passwd|api-key|apikey|authorization)(?:=|\s+))(?:"[^"]*"|'[^']*'|\S+)/gi, "$1[redacted]")
  apply(/\b(secret|token|password|passwd|api[_-]?key|authorization|credential)s?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1=[redacted]")
  apply(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[redacted-jwt]")
  apply(/\b[a-f0-9]{32,}\b/gi, "[redacted]")

  // Account names in common home-directory shapes.
  if (options.home) {
    const escaped = options.home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    apply(new RegExp(escaped, "gi"), "<home>")
  }
  apply(/([A-Za-z]:[\\/]+Users[\\/]+)(?!<user>)[^\\/\s"']+/g, "$1<user>")
  apply(/(\/home\/)(?!<user>)[^/\s"']+/g, "$1<user>")
  apply(/(\/Users\/)(?!<user>)[^/\s"']+/g, "$1<user>")
  if (options.user && options.user.trim()) {
    const escaped = options.user.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    apply(new RegExp(`\\b${escaped}\\b`, "gi"), "<user>")
  }

  // Remaining identifiers that are rarely needed to reproduce an issue.
  apply(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "<email>")
  apply(/\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/g, "<private-ip>")

  // Keep reports single-line-per-field and free of trailing whitespace.
  text = text.replace(/[ \t]+/g, " ").replace(/[ \t]+$/gm, "")
  return { text, redactions }
}

export interface SanitizedEnvironment {
  platform: string
  arch: string
  node: string
  windows: boolean | null
  windowsVersion: string | null
  powershell: boolean | null
}

export interface SanitizedVersions {
  plugin: { installed: string | null; latest: string | null; error?: string }
  spicetify: { installed: string | null; latest: string | null; error?: string }
}

export interface SanitizedDiagnosticsReport {
  schemaVersion: 1
  generator: "opencode-spotify"
  generatedAt: string
  installerVersion: string
  environment: SanitizedEnvironment
  versions: SanitizedVersions
  checks: DiagnosticCheckView[]
  summary: DiagnosticsSummary
  notes: string[]
  redactions: number
}

export interface SanitizedReportOptions {
  installerVersion?: string
  detection?: Detection
  versions?: { plugin?: Partial<VersionInfo>; spicetify?: Partial<VersionInfo> }
  /** Deterministic timestamp for tests; defaults to now. */
  now?: Date | number | (() => Date | number)
  extraNotes?: string[]
}

function timestamp(now: SanitizedReportOptions["now"]): string {
  const value = typeof now === "function" ? now() : now
  if (value instanceof Date) return value.toISOString()
  if (typeof value === "number") return new Date(value).toISOString()
  return new Date().toISOString()
}

/**
 * Build a shareable diagnostics report. It deliberately contains no file
 * paths, usernames, credential values, or terminal escapes: only versions,
 * booleans, and already-sanitized check text.
 */
export function createSanitizedReport(
  view: DiagnosticsView,
  options: SanitizedReportOptions = {},
): SanitizedDiagnosticsReport {
  const detection = options.detection
  let redactions = 0
  const clean = (value: string | null | undefined): string | null => {
    if (value === null || value === undefined) return null
    const result = sanitizeDiagnosticsText(value)
    redactions += result.redactions
    return result.text
  }

  const environment: SanitizedEnvironment = {
    platform: detection?.windows ? "win32" : process.platform,
    arch: detection?.arch ?? process.arch,
    node: clean(detection?.node ?? process.versions.node) ?? "unknown",
    windows: detection ? detection.windows : null,
    windowsVersion: detection?.windows ? clean(detection.windowsVersion) : null,
    powershell: detection ? detection.pwsh !== null : null,
  }

  const checks = view.checks.map((check) => {
    const message = clean(check.message) ?? "(no detail)"
    const fix = check.fix ? clean(check.fix) : null
    return {
      id: check.id,
      status: check.status,
      message,
      ...(fix ? { fix } : {}),
    }
  })

  const versions: SanitizedVersions = {
    plugin: {
      installed: clean(options.versions?.plugin?.installed ?? detection?.opencode.plugin.version ?? null),
      latest: clean(options.versions?.plugin?.latest ?? null),
      ...(options.versions?.plugin?.error ? { error: clean(options.versions.plugin.error) ?? "unknown error" } : {}),
    },
    spicetify: {
      installed: clean(options.versions?.spicetify?.installed ?? detection?.spicetify.version ?? null),
      latest: clean(options.versions?.spicetify?.latest ?? null),
      ...(options.versions?.spicetify?.error ? { error: clean(options.versions.spicetify.error) ?? "unknown error" } : {}),
    },
  }

  const notes = dedupe([
    "This report contains no credential values; account names in paths are shown as <user>.",
    "Review before sharing; environment details are included to reproduce the issue.",
    ...view.notes,
    ...(options.extraNotes ?? []),
  ]).map((note) => clean(note) ?? note)

  return {
    schemaVersion: 1,
    generator: "opencode-spotify",
    generatedAt: timestamp(options.now),
    installerVersion: clean(options.installerVersion) ?? "unknown",
    environment,
    versions,
    checks,
    summary: view.summary,
    notes,
    redactions,
  }
}

/** Human-readable sanitized report; never contains ANSI or Ink output. */
export function renderSanitizedReportText(report: SanitizedDiagnosticsReport): string {
  const lines: string[] = []
  lines.push("OpenCode Spotify diagnostics report (sanitized)")
  lines.push(`Generated: ${report.generatedAt}`)
  lines.push(`Installer: ${report.installerVersion}`)
  lines.push(`Platform: ${report.environment.platform} ${report.environment.arch}`)
  lines.push(`Windows: ${report.environment.windows === null ? "unknown" : report.environment.windows ? `yes (${report.environment.windowsVersion ?? "version unknown"})` : "no"}`)
  lines.push(`Node.js: ${report.environment.node}`)
  lines.push(`PowerShell: ${report.environment.powershell === null ? "unknown" : report.environment.powershell ? "detected" : "not detected"}`)
  lines.push(`Plugin: ${report.versions.plugin.installed ?? "not detected"}${report.versions.plugin.latest ? ` (latest ${report.versions.plugin.latest})` : ""}`)
  lines.push(`Spicetify: ${report.versions.spicetify.installed ?? "not detected"}${report.versions.spicetify.latest ? ` (latest ${report.versions.spicetify.latest})` : ""}`)
  lines.push("")
  lines.push("Checks")
  for (const check of report.checks) {
    lines.push(`  [${check.status.toUpperCase()}] ${check.id}: ${check.message}`)
    if (check.fix) lines.push(`         Fix: ${check.fix}`)
  }
  lines.push("")
  const { ok, warn, fail, info } = report.summary
  lines.push(`Summary: ${ok} ok, ${warn} warning(s), ${fail} failure(s)${info ? `, ${info} info` : ""}`)
  lines.push("")
  lines.push("Notes")
  for (const note of report.notes) lines.push(`  - ${note}`)
  lines.push("")
  lines.push(`Redactions applied: ${report.redactions}`)
  return lines.join("\n")
}

/** Machine-readable sanitized report. JSON-only: no Ink, no ANSI. */
export function renderSanitizedReportJson(report: SanitizedDiagnosticsReport): string {
  return JSON.stringify(report, null, 2)
}

/** One entry point for `--json` vs human report output. */
export function formatSanitizedReport(
  report: SanitizedDiagnosticsReport,
  format: "text" | "json" = "text",
): string {
  return format === "json" ? renderSanitizedReportJson(report) : renderSanitizedReportText(report)
}
