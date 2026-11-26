import { BRIDGE_PORT, MIN_OPENCODE, MIN_SPICETIFY, compareVersions, isAtLeast } from "./compat.ts"
import { inspectInstallerLock, installerLockPath } from "./lock.ts"
import { projectPlugins } from "./opencode.ts"
import { compatibilityLabel, isSpotifyPluginId } from "./plan.ts"
import {
  availableUpdate,
  inspectDependencies,
  ownershipLabel,
  redactSensitive,
  updateLabel,
  type AvailableUpdate,
  type DependencyReport,
} from "./versions.ts"
import { buildDiagnosticsView, createSanitizedReport, formatSanitizedReport } from "./ui/diagnostics-view.ts"
import type { InstallOwner, OperationContext, Runtime } from "./types.ts"

export interface DoctorCheck {
  id: string
  status: "ok" | "warn" | "fail" | "info"
  message: string
  fix?: string
}

export interface DoctorRuntimeInfo {
  connection: "not-probed"
  playbackVerified: false
  note: string
}

export interface DoctorPortInfo {
  port: number
  loopback: string
  busy: boolean
  owner: "this-plugin" | "unknown" | "none"
  conflict: boolean
}

/** Read-only installer-lock observation. Never probes a process. */
export type DoctorLockStatus = "absent" | "present" | "unreadable"

export interface DoctorLockInfo {
  status: DoctorLockStatus
  path: string
  pid?: number
  command?: string
  startedAt?: number
  detail?: string
}

/** Node.js floor enforced by package.json engines and the CLI runtime. */
export const MIN_NODE = "22.18.0"
/** Bun floor used by the TUI (the CLI itself runs on Node.js). */
export const MIN_BUN = "1.3.14"

export interface DoctorEnvironment {
  platform: string
  windows: boolean
  windowsVersion: string
  arch: string
  node: string
  installerVersion: string
  opencode: {
    available: boolean
    path: string | null
    version: string | null
    registered: boolean
    local: boolean
    state: "registered" | "absent" | "unknown"
    nativeCommands: boolean
  }
  spotify: { installed: boolean; store: boolean; path: string | null }
  spicetify: {
    available: boolean
    version: string | null
    owner: InstallOwner
    ownerLabel: string
    configPath: string | null
  }
  bridge: {
    installed: boolean
    registration: string
    credentialValid: boolean
    protocol: number
    origins: number
  }
  port: DoctorPortInfo
  lock: DoctorLockInfo
  updates: { plugin: AvailableUpdate; spicetify: AvailableUpdate }
  dependencies: DependencyReport
}

export interface DoctorReport {
  schemaVersion: 1
  readOnly: true
  checks: DoctorCheck[]
  summary: { ok: number; warn: number; fail: number }
  environment: DoctorEnvironment
  runtime: DoctorRuntimeInfo
  /** Redacted text safe to paste into a public GitHub issue. */
  sanitizedReport: string
}

const RUNTIME_NOTE =
  "Registration is configuration, not a live connection. Playback cannot be verified until OpenCode and Spotify are running and the bridge answers; diagnostics do not open the bridge."

function doctorPort(ctx: OperationContext): DoctorPortInfo {
  const port = ctx.detection.port
  const owner: DoctorPortInfo["owner"] = port.busy
    ? port.likelyOwnedByThisPlugin === true ? "this-plugin" : "unknown"
    : "none"
  return {
    port: BRIDGE_PORT,
    loopback: "127.0.0.1",
    busy: port.busy,
    owner,
    conflict: port.busy && port.likelyOwnedByThisPlugin !== true,
  }
}

/**
 * Read-only installer-lock observation through the shared lock API. Never
 * probes a process (no PowerShell, no runtime.run, no mutation); `lock.ts`
 * owns path resolution and JSON parsing so diagnostics cannot drift from the
 * real installer contract.
 */
export async function doctorLockPeek(runtime: Runtime): Promise<DoctorLockInfo> {
  const path = installerLockPath({ env: runtime.env, home: runtime.homedir })
  let inspection: Awaited<ReturnType<typeof inspectInstallerLock>>
  try {
    inspection = await inspectInstallerLock({ lockPath: path, probeProcess: false })
  } catch {
    return { status: "unreadable", path, detail: "the lock path could not be inspected" }
  }
  if (inspection.status === "absent") return { status: "absent", path }
  if (inspection.status === "unknown") {
    return { status: "unreadable", path, detail: "the lock path could not be inspected" }
  }
  if (inspection.status === "malformed") {
    return { status: "unreadable", path, detail: "lock content is malformed" }
  }
  const content = inspection.content
  return {
    status: "present",
    path,
    ...(content ? { pid: content.pid, command: content.command, startedAt: content.startedAt } : {}),
    detail: inspection.status === "stale"
      ? `lock appears stale (${inspection.reason}); owner liveness is not probed (read-only diagnostics)`
      : "owner liveness is not probed (read-only diagnostics)",
  }
}

/**
 * Full-version Node.js comparison against the engine floor. Major-only checks
 * are not enough: 22.17.0 must fail while 22.18.0 passes.
 */
export function nodeVersionCheck(version: string): DoctorCheck {
  const compared = compareVersions(version, MIN_NODE)
  const ok = compared !== null && compared >= 0
  return {
    id: "node",
    status: ok ? "ok" : "fail",
    message: `Node.js ${version}; minimum ${MIN_NODE}`,
    ...(ok ? {} : { fix: `Install Node.js ${MIN_NODE} or newer.` }),
  }
}

/** Bun is a TUI runtime, not an installer dependency; note it without failing. */
export function bunCheck(path: string | undefined): DoctorCheck {
  return {
    id: "bun",
    status: "info",
    message: path
      ? `Bun found at ${path} (the TUI requires Bun ${MIN_BUN} or newer).`
      : `Bun was not found; the TUI requires Bun ${MIN_BUN} or newer. The installer CLI runs on Node.js ${MIN_NODE}+.`,
  }
}

export async function doctorEnvironment(ctx: OperationContext): Promise<DoctorEnvironment> {
  const d = ctx.detection
  const state = d.opencode.plugin.state ?? (d.opencode.plugin.registered ? "registered" : "absent")
  const pluginInstalled = ctx.versions.plugin.installed ?? d.opencode.plugin.version
  const lock = await doctorLockPeek(ctx.runtime)
  return {
    platform: `${process.platform} ${process.arch}`,
    windows: d.windows,
    windowsVersion: d.windowsVersion,
    arch: d.arch,
    node: process.versions.node,
    installerVersion: ctx.installerVersion,
    opencode: {
      available: d.opencode.available,
      path: d.opencode.path,
      version: d.opencode.version,
      registered: d.opencode.plugin.registered,
      local: d.opencode.plugin.local,
      state,
      nativeCommands: d.opencode.nativeCommands,
    },
    spotify: { installed: d.spotify.installed, store: d.spotify.store, path: d.spotify.path },
    spicetify: {
      available: d.spicetify.available,
      version: d.spicetify.version,
      owner: d.spicetify.owner,
      ownerLabel: ownershipLabel(d.spicetify.owner),
      configPath: d.spicetify.configPath,
    },
    bridge: {
      installed: d.bridge.installed,
      registration: d.bridge.registration,
      credentialValid: d.bridge.credentialValid,
      protocol: d.bridge.protocol,
      origins: d.bridge.origins,
    },
    port: doctorPort(ctx),
    lock,
    updates: {
      plugin: availableUpdate(pluginInstalled, ctx.versions.plugin.latest),
      spicetify: availableUpdate(d.spicetify.version, ctx.versions.spicetify.latest),
    },
    dependencies: inspectDependencies(ctx.runtime, import.meta.url),
  }
}

/**
 * Build a sanitized, copy-pasteable report for a public GitHub issue.
 *
 * Presentation/sanitization is owned by the C20 diagnostics view:
 * `buildDiagnosticsView` strips terminal/credential-shaped text,
 * `createSanitizedReport` produces the structured report, and
 * `formatSanitizedReport` renders it. The doctor JSON contract stays stable:
 * this remains a single redacted string in `sanitizedReport`.
 */
export function buildSanitizedReport(
  ctx: OperationContext,
  checks: DoctorCheck[],
  summary: DoctorReport["summary"],
): string {
  const view = buildDiagnosticsView(checks, { title: "OpenCode Spotify diagnostics" })
  const report = createSanitizedReport(view, {
    installerVersion: ctx.installerVersion,
    detection: ctx.detection,
    versions: ctx.versions,
    extraNotes: [
      `Summary: ${summary.ok} ok, ${summary.warn} warning(s), ${summary.fail} failure(s)`,
      "Runtime connection not probed; playback verified: no.",
    ],
  })
  return formatSanitizedReport(report, "text")
}

export async function doctorChecks(ctx: OperationContext): Promise<DoctorCheck[]> {
  const d = ctx.detection
  const checks: DoctorCheck[] = []
  const add = (id: string, status: DoctorCheck["status"], message: string, fix?: string) => checks.push({ id, status, message, ...(fix ? { fix } : {}) })

  add("windows", d.windows ? "ok" : "fail", d.windows ? `Windows detected (${d.windowsVersion}, ${d.arch})` : `Unsupported platform: ${process.platform}`,
    d.windows ? undefined : "V0.6.0 supports Windows only.")
  checks.push(nodeVersionCheck(process.versions.node))
  checks.push(bunCheck(await ctx.runtime.which("bun").catch(() => undefined)))
  add("pwsh", d.pwsh ? "ok" : "fail", d.pwsh ? `PowerShell Core at ${d.pwsh}` : "pwsh not found",
    d.pwsh ? undefined : "Install PowerShell 7 (pwsh) for bridge provisioning.")

  add("opencode", d.opencode.available ? "ok" : "fail",
    d.opencode.available ? `OpenCode ${d.opencode.version ?? "version unknown"} at ${d.opencode.path}` : "OpenCode not found",
    d.opencode.available ? undefined : "Install OpenCode 2.3.0 or newer.")
  if (d.opencode.available) {
    add("opencode-version", d.compatibility.opencode === "ok" ? "ok" : "warn",
      `OpenCode ${d.opencode.version ?? "version unknown"}; minimum ${MIN_OPENCODE}`,
      d.compatibility.opencode === "ok" ? undefined : `Upgrade OpenCode to ${MIN_OPENCODE} or newer.`)
    add("opencode-config", d.opencode.configPath ? "ok" : "warn",
      d.opencode.configPath ? `Global config path: ${d.opencode.configPath}` : "Global config path not reported",
      d.opencode.configPath ? undefined : "Run `opencode debug paths config` and confirm the CLI is healthy.")
    add("opencode-native", d.opencode.nativeCommands ? "ok" : "warn",
      d.opencode.nativeCommands ? "Native `opencode plugin add/remove` available" : "Native plugin commands not detected",
      d.opencode.nativeCommands ? undefined : `Upgrade OpenCode to ${MIN_OPENCODE} or newer; the installer uses native global plugin management.`)
  }

  if (d.opencode.plugin.registered) {
    add("registration", d.opencode.plugin.local ? "warn" : "ok",
      d.opencode.plugin.local
        ? `A local development plugin is registered (${d.opencode.plugin.source ?? "path unknown"}).`
        : `Global plugin registered${d.opencode.plugin.version ? ` at ${d.opencode.plugin.version}` : ""}.`,
      d.opencode.plugin.local ? "Run `opencode-spotify setup` (official installer) to register the global package; project config is never edited." : undefined)
  } else if (d.opencode.plugin.state === "unknown") {
    add("registration", "warn", "Global plugin inspection failed (timeout or command error); state is unknown, not proven absent.",
      `Rerun \`opencode-spotify doctor\`. Detail: ${redactSensitive(d.opencode.plugin.detail ?? "plugin list did not complete")}`)
  } else {
    add("registration", "warn", "OpenCode Spotify is not registered globally.",
      "Run `opencode-spotify setup` (official installer) and approve the global registration.")
  }
  let project = [] as Awaited<ReturnType<typeof projectPlugins>>
  try { project = await projectPlugins(ctx.runtime) } catch { project = [] }
  const localConflict = project.find((entry) => isSpotifyPluginId(entry.id) && /[\\/]/.test(entry.source))
  if (localConflict) {
    add("project-conflict", "warn", `This project also configures a local plugin at ${localConflict.source}.`,
      "Keep it for development or remove that project entry yourself; the installer never edits project config.")
    if (d.opencode.plugin.registered) {
      add("duplicate-registration", "warn",
        `Duplicate plugin sources: a ${d.opencode.plugin.local ? "local" : "global"} registration and a project-local plugin at ${localConflict.source} both exist; the project copy may shadow the package.`,
        "Keep only one source. Remove the project entry yourself when you want the global package; the official installer never edits project config.")
    }
  }

  add("spotify", d.spotify.installed ? "ok" : "fail",
    d.spotify.installed ? d.spotify.detail : "Spotify Desktop not detected.",
    d.spotify.installed ? undefined : "Install Spotify Desktop from the official Spotify installer, then re-run setup.")
  if (d.spotify.installed && d.spotify.store) {
    add("spotify-store", "warn", "A Microsoft Store Spotify build was detected; Spicetify may need re-applying after Spotify restarts.",
      "Prefer the official Spotify Desktop installer if apply is unreliable.")
  }

  add("spicetify", d.spicetify.available ? "ok" : "warn",
    d.spicetify.available ? `Spicetify ${d.spicetify.version ?? "version unknown"} at ${d.spicetify.path}` : "Spicetify not installed",
    d.spicetify.available ? undefined : "Run `opencode-spotify setup` (official installer) and follow the Spicetify installation step, or install it from spicetify.app and re-run setup.")
  if (d.spicetify.available) {
    add("spicetify-version", isAtLeast(d.spicetify.version, MIN_SPICETIFY) === false ? "warn" : "ok",
      `Spicetify ${d.spicetify.version ?? "version unknown"}; minimum ${MIN_SPICETIFY}`,
      isAtLeast(d.spicetify.version, MIN_SPICETIFY) === false ? `Update with the method that owns this copy (${ownershipLabel(d.spicetify.owner)}); do not mix package managers.` : undefined)
    add("spicetify-config", d.spicetify.configPath ? "ok" : "warn",
      d.spicetify.configPath ? `Config: ${d.spicetify.configPath}` : "Spicetify configuration not located",
      d.spicetify.configPath ? undefined : "Run `spicetify -c` and confirm Spotify/Spicetify are configured.")
    add("bridge-registration", d.spicetify.bridgeRegistered ? "ok" : "warn",
      d.spicetify.bridgeRegistered ? "Bridge extension is listed in Spicetify configuration." : "Bridge extension is not registered.",
      d.spicetify.bridgeRegistered ? undefined : "Run `opencode-spotify repair` (official installer).")
  }

  if (d.bridge.credentialValid) {
    add("bridge-credentials", "ok", "Credential file has a valid shape; values are not displayed.")
  } else if (d.bridge.configExists) {
    add("bridge-credentials", "fail", "Credential file exists but is invalid or unreadable.",
      "Run `opencode-spotify repair` (official installer); do not delete the file manually unless you accept losing the pairing.")
  } else {
    add("bridge-credentials", "warn", "Bridge credentials are not provisioned.",
      "Run `opencode-spotify setup` or `opencode-spotify repair` (official installer).")
  }
  add("bridge", d.compatibility.bridge === "compatible" ? "ok" : d.compatibility.bridge === "missing" ? "warn" : "warn",
    `Bridge: ${compatibilityLabel(d.compatibility.bridge)}`,
    d.compatibility.bridge === "compatible" ? undefined : "Run `opencode-spotify repair` (official installer) to synchronize the extension with this package.")

  const port = doctorPort(ctx)
  if (port.busy) {
    add("port", port.owner === "this-plugin" ? "ok" : "warn",
      port.owner === "this-plugin"
        ? `Loopback port 127.0.0.1:${BRIDGE_PORT} is in use by this plugin's bridge.`
        : `Loopback port 127.0.0.1:${BRIDGE_PORT} is in use by an unknown process${d.port.likelyOwnedByThisPlugin === null ? " (ownership could not be determined)" : ""}; it will not be terminated.`,
      port.owner === "this-plugin" ? undefined : `Identify the listener with \`Get-NetTCPConnection -LocalPort ${BRIDGE_PORT}\` before changing anything.`)
  } else {
    add("port", "ok", `Loopback port 127.0.0.1:${BRIDGE_PORT} is available.`)
  }

  const lock = await doctorLockPeek(ctx.runtime)
  if (lock.status === "present") {
    add("installer-lock", "info",
      `An installer lock is present (pid ${lock.pid ?? "unknown"}, command ${lock.command ?? "unknown"}); owner liveness is not probed.`,
      "If no installer is running, `status` and `doctor` stay safe; a later mutating command reclaims a stale lock.")
  } else if (lock.status === "unreadable") {
    add("installer-lock", "warn",
      `The installer lock at ${lock.path} could not be read: ${lock.detail ?? "unknown error"}.`,
      "Confirm no installer is running before removing a malformed lock; reclaim happens automatically otherwise.")
  }

  const deps = inspectDependencies(ctx.runtime, import.meta.url)
  if (deps.status === "ok") {
    add("dependencies", "ok", `Runtime dependencies present (${deps.checks.length} checked).`)
  } else if (deps.status === "warn") {
    add("dependencies", "warn", `Missing runtime dependencies: ${deps.missing.join(", ")}.`,
      "Reinstall the package with the official installer, then re-run setup; do not hand-copy node_modules.")
  } else {
    add("dependencies", "info", "Runtime dependency state could not be inspected; it is unknown, not proven healthy.")
  }

  const updates = {
    plugin: availableUpdate(ctx.versions.plugin.installed ?? d.opencode.plugin.version, ctx.versions.plugin.latest),
    spicetify: availableUpdate(d.spicetify.version, ctx.versions.spicetify.latest),
  }
  const outdated = updates.plugin.available || updates.spicetify.available
  const unknownUpdate = updates.plugin.status === "unknown" || updates.spicetify.status === "unknown"
  add("updates", outdated ? "info" : unknownUpdate ? "info" : "ok",
    `Updates: plugin ${updateLabel(updates.plugin)}; Spicetify ${updateLabel(updates.spicetify)}.`,
    outdated ? "Run `opencode-spotify update` (official installer) when ready; updates are never applied by diagnostics." : undefined)

  add("compatibility", d.compatibility.opencode === "ok" && d.compatibility.bridge === "compatible" ? "ok" : "warn",
    `OpenCode ${compatibilityLabel(d.compatibility.opencode)}; Spicetify ${compatibilityLabel(d.compatibility.spicetify)}; bridge ${compatibilityLabel(d.compatibility.bridge)}.`)
  add("connection", "info", RUNTIME_NOTE)
  return checks
}

export async function runDoctor(ctx: OperationContext): Promise<number> {
  const checks = await doctorChecks(ctx)
  const summary = {
    ok: checks.filter((check) => check.status === "ok").length,
    warn: checks.filter((check) => check.status === "warn").length,
    fail: checks.filter((check) => check.status === "fail").length,
  }
  const report: DoctorReport = {
    schemaVersion: 1,
    readOnly: true,
    checks,
    summary,
    environment: await doctorEnvironment(ctx),
    runtime: { connection: "not-probed", playbackVerified: false, note: RUNTIME_NOTE },
    sanitizedReport: buildSanitizedReport(ctx, checks, summary),
  }
  if (ctx.options.json) {
    ctx.ui.json(report)
    return summary.fail ? 1 : 0
  }
  ctx.ui.section("Diagnostics (read-only)")
  for (const check of checks) {
    const kind = check.status === "ok" ? "ok" : check.status === "fail" ? "fail" : check.status === "warn" ? "warn" : "info"
    ctx.ui.status(kind, check.message)
    if (check.fix) ctx.ui.line(`       Fix: ${check.fix}`)
  }
  ctx.ui.section("Summary")
  ctx.ui.line(`  ${summary.ok} ok, ${summary.warn} warning(s), ${summary.fail} failure(s)`)
  ctx.ui.line("  No changes were made. Use `opencode-spotify repair` or `opencode-spotify setup` (official installer) for fixes.")
  ctx.ui.line("  Registration is not a live connection; playback is verified only at runtime.")
  ctx.ui.line("  For a public GitHub issue, run `opencode-spotify doctor --json` and copy the sanitizedReport field.")
  return summary.fail ? 1 : 0
}
