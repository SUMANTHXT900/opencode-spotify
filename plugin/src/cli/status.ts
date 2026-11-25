import { BRIDGE_PORT, BRIDGE_PROTOCOL, MIN_OPENCODE, MIN_SPICETIFY } from "./compat.ts"
import { compatibilityLabel } from "./plan.ts"
import type { OperationContext } from "./types.ts"

export interface StatusReport {
  schemaVersion: 1
  package: "opencode-spotify"
  installerVersion: string
  platform: string
  windows: boolean
  versions: {
    plugin: { installed: string | null; latest: string | null; beta: string | null; error?: string }
    spicetify: { installed: string | null; latest: string | null; error?: string }
  }
  opencode: { path: string | null; version: string | null; globalConfig: string | null; nativePluginCommands: boolean }
  registration: { registered: boolean; local: boolean; spec: string | null; source: string | null; state?: "registered" | "absent" | "unknown" }
  spotify: { installed: boolean; store: boolean; path: string | null }
  spicetify: { available: boolean; path: string | null; version: string | null; owner: string; configPath: string | null }
  bridge: {
    credentialFile: boolean
    credentialValid: boolean
    installed: boolean
    origins: number
    extension: string | null
    extensionExists: boolean
    registration: string
    protocol: number
  }
  port: { port: number; busy: boolean; likelyOwnedByThisPlugin: boolean | null }
  compatibility: {
    minimum: { opencode: string; spicetify: string }
    opencode: string
    spicetify: string
    bridge: string
    plugin: string
  }
  sideEffects: "none"
}

export function statusReport(ctx: OperationContext): StatusReport {
  const d = ctx.detection
  return {
    schemaVersion: 1,
    package: "opencode-spotify",
    installerVersion: ctx.installerVersion,
    platform: `${process.platform} ${process.arch}`,
    windows: d.windows,
    versions: {
      plugin: {
        installed: d.opencode.plugin.version,
        latest: ctx.versions.plugin.latest,
        beta: ctx.versions.plugin.latestBeta ?? null,
        ...(ctx.versions.plugin.error ? { error: ctx.versions.plugin.error } : {}),
      },
      spicetify: {
        installed: d.spicetify.version,
        latest: ctx.versions.spicetify.latest,
        ...(ctx.versions.spicetify.error ? { error: ctx.versions.spicetify.error } : {}),
      },
    },
    opencode: {
      path: d.opencode.path,
      version: d.opencode.version,
      globalConfig: d.opencode.configPath,
      nativePluginCommands: d.opencode.nativeCommands,
    },
    registration: {
      registered: d.opencode.plugin.registered,
      local: d.opencode.plugin.local,
      spec: d.opencode.plugin.spec,
      source: d.opencode.plugin.source,
      state: d.opencode.plugin.state ?? (d.opencode.plugin.registered ? "registered" : "absent"),
    },
    spotify: { installed: d.spotify.installed, store: d.spotify.store, path: d.spotify.path },
    spicetify: {
      available: d.spicetify.available,
      path: d.spicetify.path,
      version: d.spicetify.version,
      owner: d.spicetify.owner,
      configPath: d.spicetify.configPath,
    },
    bridge: {
      credentialFile: d.bridge.configExists,
      credentialValid: d.bridge.credentialValid,
      installed: d.bridge.installed,
      origins: d.bridge.origins,
      extension: d.bridge.extensionPath,
      extensionExists: d.bridge.extensionExists,
      registration: d.bridge.registration,
      protocol: BRIDGE_PROTOCOL,
    },
    port: { port: BRIDGE_PORT, busy: d.port.busy, likelyOwnedByThisPlugin: d.port.likelyOwnedByThisPlugin },
    compatibility: {
      minimum: { opencode: MIN_OPENCODE, spicetify: MIN_SPICETIFY },
      opencode: compatibilityLabel(d.compatibility.opencode),
      spicetify: compatibilityLabel(d.compatibility.spicetify),
      bridge: compatibilityLabel(d.compatibility.bridge),
      plugin: compatibilityLabel(d.compatibility.plugin),
    },
    sideEffects: "none",
  }
}

/**
 * Resolve display labels for the plugin registry tags (B05). npm's `latest`
 * tag may point at a prerelease; never mislabel a beta as "Latest stable".
 */
export function resolveChannelLabels(
  latest: string | null,
  beta: string | null,
): { stable: string | null; beta: string | null; stableMissing: boolean } {
  const stable = latest && !/-/.test(latest) ? latest : null
  const betaTag = beta ?? (latest && /-/.test(latest) ? latest : null)
  return { stable, beta: betaTag, stableMissing: !stable && !!betaTag }
}

export async function runStatus(ctx: OperationContext): Promise<number> {
  const report = statusReport(ctx)
  if (ctx.options.json) {
    ctx.ui.json(report)
    return 0
  }
  ctx.ui.section("Installation status")
  ctx.ui.kv("Installer", ctx.installerVersion)
  ctx.ui.kv("Platform", report.platform)
  ctx.ui.kv("OpenCode", report.opencode.version ?? "not detected")
  ctx.ui.kv("Global config", report.opencode.globalConfig ?? "unknown")
  ctx.ui.kv("Plugin", report.registration.registered
    ? `${report.versions.plugin.installed ?? "unknown"}${report.registration.local ? " (local development)" : ""}`
    : report.registration.state === "unknown"
      ? "unknown (inspection failed; rerun doctor)"
      : "not registered")
  // B05: npm's `latest` tag may point at a prerelease. Never mislabel a beta
  // as "Latest stable": report stable only when the tag is not a prerelease.
  const channels = resolveChannelLabels(report.versions.plugin.latest, report.versions.plugin.beta)
  if (channels.stable) {
    ctx.ui.kv("Latest stable", channels.stable)
  } else if (channels.stableMissing) {
    ctx.ui.kv("Latest stable", "none published (registry latest is a prerelease)")
  } else {
    ctx.ui.kv("Latest stable", report.versions.plugin.latest ?? "not published / unknown")
  }
  if (channels.beta) ctx.ui.kv("Latest beta", channels.beta)
  ctx.ui.kv("Spotify", report.spotify.installed ? (report.spotify.store ? "Store build detected" : "desktop detected") : "not detected")
  ctx.ui.kv("Spicetify", report.spicetify.available
    ? `${report.spicetify.version ?? "version unknown"} (${report.spicetify.owner})`
    : "not installed")
  ctx.ui.kv("Bridge", report.bridge.installed
    ? `installed; registration ${report.bridge.registration}`
    : report.bridge.credentialFile ? "configured; extension missing" : "not installed")
  ctx.ui.kv("Bridge protocol", `${report.bridge.protocol}`)
  ctx.ui.kv("Port", `${BRIDGE_PORT} ${report.port.busy ? "in use" : "available"}`)
  ctx.ui.section("Compatibility")
  ctx.ui.status(report.compatibility.opencode === "compatible" ? "ok" : "warn", `OpenCode: ${report.compatibility.opencode}`)
  ctx.ui.status(report.compatibility.spicetify === "compatible" ? "ok" : "warn", `Spicetify: ${report.compatibility.spicetify}`)
  ctx.ui.status(report.compatibility.bridge === "compatible" ? "ok" : "warn", `Bridge: ${report.compatibility.bridge}`)
  if (report.versions.plugin.error) ctx.ui.warn(`Version check: ${report.versions.plugin.error}`)
  return 0
}
