import { BRIDGE_PORT, MIN_OPENCODE, MIN_SPICETIFY, isAtLeast } from "./compat.ts"
import { projectPlugins } from "./opencode.ts"
import { compatibilityLabel, isSpotifyPluginId } from "./plan.ts"
import type { OperationContext } from "./types.ts"

export interface DoctorCheck {
  id: string
  status: "ok" | "warn" | "fail" | "info"
  message: string
  fix?: string
}

export interface DoctorReport {
  schemaVersion: 1
  readOnly: true
  checks: DoctorCheck[]
  summary: { ok: number; warn: number; fail: number }
}

export async function doctorChecks(ctx: OperationContext): Promise<DoctorCheck[]> {
  const d = ctx.detection
  const checks: DoctorCheck[] = []
  const add = (id: string, status: DoctorCheck["status"], message: string, fix?: string) => checks.push({ id, status, message, ...(fix ? { fix } : {}) })

  add("windows", d.windows ? "ok" : "fail", d.windows ? `Windows detected (${d.windowsVersion}, ${d.arch})` : `Unsupported platform: ${process.platform}`,
    d.windows ? undefined : "V0.6.0 supports Windows only.")
  add("node", Number(process.versions.node.split(".")[0]) >= 22 ? "ok" : "fail", `Node.js ${process.versions.node}`,
    Number(process.versions.node.split(".")[0]) >= 22 ? undefined : "Install Node.js 22.18 or newer.")
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
      d.opencode.plugin.local ? "Run `opencode-spotify setup` to register the global package; project config is never edited." : undefined)
  } else {
    add("registration", "warn", "OpenCode Spotify is not registered globally.",
      "Run `opencode-spotify setup` and approve the global registration.")
  }
  let project = [] as Awaited<ReturnType<typeof projectPlugins>>
  try { project = await projectPlugins(ctx.runtime) } catch { project = [] }
  const localConflict = project.find((entry) => isSpotifyPluginId(entry.id) && /[\\/]/.test(entry.source))
  if (localConflict) {
    add("project-conflict", "warn", `This project also configures a local plugin at ${localConflict.source}.`,
      "Keep it for development or remove that project entry yourself; the installer never edits project config.")
  }

  add("spotify", d.spotify.installed ? "ok" : "fail",
    d.spotify.installed ? d.spotify.detail : "Spotify Desktop not detected.",
    d.spotify.installed ? undefined : "Install Spotify Desktop from Spotify, then re-run setup.")
  if (d.spotify.installed && d.spotify.store) {
    add("spotify-store", "warn", "A Microsoft Store Spotify build was detected; Spicetify may need re-applying after Spotify restarts.",
      "Prefer the normal Spotify Desktop installer if apply is unreliable.")
  }

  add("spicetify", d.spicetify.available ? "ok" : "warn",
    d.spicetify.available ? `Spicetify ${d.spicetify.version ?? "version unknown"} at ${d.spicetify.path}` : "Spicetify not installed",
    d.spicetify.available ? undefined : "Run `opencode-spotify setup` and choose automatic or manual Spicetify installation.")
  if (d.spicetify.available) {
    add("spicetify-version", isAtLeast(d.spicetify.version, MIN_SPICETIFY) === false ? "warn" : "ok",
      `Spicetify ${d.spicetify.version ?? "version unknown"}; minimum ${MIN_SPICETIFY}`,
      isAtLeast(d.spicetify.version, MIN_SPICETIFY) === false ? `Upgrade with the owner-specific method (${d.spicetify.owner}); do not mix package managers.` : undefined)
    add("spicetify-config", d.spicetify.configPath ? "ok" : "warn",
      d.spicetify.configPath ? `Config: ${d.spicetify.configPath}` : "Spicetify configuration not located",
      d.spicetify.configPath ? undefined : "Run `spicetify -c` and confirm Spotify/Spicetify are configured.")
    add("bridge-registration", d.spicetify.bridgeRegistered ? "ok" : "warn",
      d.spicetify.bridgeRegistered ? "Bridge extension is listed in Spicetify configuration." : "Bridge extension is not registered.",
      d.spicetify.bridgeRegistered ? undefined : "Run `opencode-spotify repair`.")
  }

  if (d.bridge.credentialValid) {
    add("bridge-credentials", "ok", "Credential file has a valid shape; values are not displayed.")
  } else if (d.bridge.configExists) {
    add("bridge-credentials", "fail", "Credential file exists but is invalid or unreadable.",
      "Run `opencode-spotify repair`; do not delete the file manually unless you accept losing the pairing.")
  } else {
    add("bridge-credentials", "warn", "Bridge credentials are not provisioned.",
      "Run `opencode-spotify setup` or `repair`.")
  }
  add("bridge", d.compatibility.bridge === "compatible" ? "ok" : d.compatibility.bridge === "missing" ? "warn" : "warn",
    `Bridge: ${compatibilityLabel(d.compatibility.bridge)}`,
    d.compatibility.bridge === "compatible" ? undefined : "Run `opencode-spotify repair` to synchronize the extension with this package.")

  if (d.port.busy) {
    add("port", d.port.likelyOwnedByThisPlugin ? "ok" : "warn",
      d.port.likelyOwnedByThisPlugin
        ? `Port ${BRIDGE_PORT} is in use by the installed Spotify bridge owner.`
        : `Port ${BRIDGE_PORT} is in use by an unknown process; it will not be terminated.`,
      d.port.likelyOwnedByThisPlugin ? undefined : `Identify the listener with \`Get-NetTCPConnection -LocalPort ${BRIDGE_PORT}\` before changing anything.`)
  } else {
    add("port", "ok", `Port ${BRIDGE_PORT} is available.`)
  }

  add("compatibility", d.compatibility.opencode === "ok" && d.compatibility.bridge === "compatible" ? "ok" : "warn",
    `OpenCode ${compatibilityLabel(d.compatibility.opencode)}; Spicetify ${compatibilityLabel(d.compatibility.spicetify)}; bridge ${compatibilityLabel(d.compatibility.bridge)}.`)
  add("connection", "info", "Playback connectivity is verified only after Spotify and OpenCode are running; diagnostics do not open the bridge.")
  return checks
}

export async function runDoctor(ctx: OperationContext): Promise<number> {
  const checks = await doctorChecks(ctx)
  const summary = {
    ok: checks.filter((check) => check.status === "ok").length,
    warn: checks.filter((check) => check.status === "warn").length,
    fail: checks.filter((check) => check.status === "fail").length,
  }
  const report: DoctorReport = { schemaVersion: 1, readOnly: true, checks, summary }
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
  ctx.ui.line("  No changes were made. Use `opencode-spotify repair` or `setup` for fixes.")
  return summary.fail ? 1 : 0
}
