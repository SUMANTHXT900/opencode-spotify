import { BRIDGE_PORT, BRIDGE_PROTOCOL, MIN_OPENCODE, MIN_SPICETIFY } from "./compat.ts"
import { compatibilityLabel } from "./plan.ts"
import { inspectMarketplace } from "./marketplace.ts"
import { resolvePluginChannels, pluginAvailableUpdate } from "./update-plan.ts"
import {
  availableUpdate,
  inspectDependencies,
  ownershipLabel,
  redactSensitive,
  updateLabel,
  type AvailableUpdate,
  type DependencyReport,
} from "./versions.ts"
import type { InstallOwner, OperationContext, Runtime, SpicetifyInfo } from "./types.ts"

export interface StatusRuntimeInfo {
  /** Diagnostics never open the bridge; registration is not a live connection. */
  connection: "not-probed"
  playbackVerified: false
  note: string
}

export interface StatusOwnership {
  spicetify: InstallOwner
  spicetifyLabel: string
  registration: "global" | "local" | "unregistered" | "unknown"
  registrationLabel: string
  bridge: "this-plugin" | "unknown" | "absent"
}

export interface StatusPortInfo {
  port: number
  busy: boolean
  likelyOwnedByThisPlugin: boolean | null
  /** Loopback address the bridge binds/probes. */
  loopback: string
  owner: "this-plugin" | "unknown" | "none"
  /** True when the port is unavailable and not proven to belong to this plugin. */
  conflict: boolean
}

export interface StatusConflicts {
  /** The global registration itself points at a local path/checkout. */
  globalLocalSource: boolean
  /** Project-local duplicate; status needs a command, so it is null here. */
  projectLocal: boolean | null
  /** Two sources are known to coexist; null when it cannot be determined cheaply. */
  duplicate: boolean | null
  details: string[]
}

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
  opencode: {
    available: boolean
    path: string | null
    version: string | null
    globalConfig: string | null
    nativePluginCommands: boolean
  }
  registration: {
    registered: boolean
    local: boolean
    spec: string | null
    source: string | null
    state?: "registered" | "absent" | "unknown"
    detail: string | null
  }
  spotify: { installed: boolean; store: boolean; path: string | null }
  spicetify: {
    available: boolean
    path: string | null
    version: string | null
    owner: string
    ownerLabel: string
    configPath: string | null
    error?: string
  }
  bridge: {
    credentialFile: boolean
    credentialValid: boolean
    installed: boolean
    origins: number
    extension: string | null
    extensionExists: boolean
    registration: string
    protocol: number
    error?: string
  }
  marketplace: {
    installed: boolean
    registered: boolean
  }
  port: StatusPortInfo
  compatibility: {
    minimum: { opencode: string; spicetify: string }
    opencode: string
    spicetify: string
    bridge: string
    plugin: string
  }
  runtime: StatusRuntimeInfo
  ownership: StatusOwnership
  updates: { plugin: AvailableUpdate; spicetify: AvailableUpdate }
  dependencies: DependencyReport
  conflicts: StatusConflicts
  sideEffects: "none"
}

const RUNTIME_NOTE =
  "Registration is configuration, not a live connection. Playback cannot be verified until OpenCode and Spotify are running and the bridge answers; diagnostics do not open the bridge."

function registrationKind(d: OperationContext["detection"]): StatusOwnership["registration"] {
  const state = d.opencode.plugin.state ?? (d.opencode.plugin.registered ? "registered" : "absent")
  if (state === "unknown") return "unknown"
  if (!d.opencode.plugin.registered) return "unregistered"
  return d.opencode.plugin.local ? "local" : "global"
}

function registrationLabel(kind: StatusOwnership["registration"]): string {
  switch (kind) {
    case "global": return "global package"
    case "local": return "local development source"
    case "unregistered": return "not registered"
    default: return "unknown (inspection failed)"
  }
}

function bridgeOwnership(d: OperationContext["detection"]): StatusOwnership["bridge"] {
  if (d.bridge.installed) return "this-plugin"
  if (d.bridge.configExists || d.bridge.extensionExists || d.bridge.registration !== "absent") return "unknown"
  return "absent"
}

function portInfo(d: OperationContext["detection"]): StatusPortInfo {
  const owner: StatusPortInfo["owner"] = d.port.busy
    ? d.port.likelyOwnedByThisPlugin === true ? "this-plugin" : "unknown"
    : "none"
  return {
    port: BRIDGE_PORT,
    busy: d.port.busy,
    likelyOwnedByThisPlugin: d.port.likelyOwnedByThisPlugin,
    loopback: "127.0.0.1",
    owner,
    conflict: d.port.busy && d.port.likelyOwnedByThisPlugin !== true,
  }
}

export interface MarketplaceStatus {
  installed: boolean
  registered: boolean
}

/**
 * Diagnostics view of Spicetify Marketplace state. Delegates to Agent 1's
 * canonical `inspectMarketplace` (src/cli/marketplace.ts owns the
 * installation/registration definition) and keeps only the two contract
 * fields: extra inspection fields (dir, configPath) can carry user paths, so
 * they stay out of the `--json` report. Strictly read-only: the inspection
 * itself only probes exists/isFile/readText, never runs commands, never
 * touches the network, never writes.
 */
export function readMarketplaceStatus(
  runtime: Runtime,
  spicetify?: Pick<SpicetifyInfo, "configPath"> | null,
): MarketplaceStatus {
  try {
    const inspection = inspectMarketplace(runtime, spicetify)
    return {
      installed: inspection.installed === true,
      registered: inspection.registered === true,
    }
  } catch {
    return { installed: false, registered: false }
  }
}

function statusConflicts(d: OperationContext["detection"]): StatusConflicts {
  const globalLocalSource = d.opencode.plugin.registered && d.opencode.plugin.local
  const details: string[] = []
  if (globalLocalSource) {
    details.push("The global registration resolves to a local path/checkout; the published package is not what OpenCode loads.")
  }
  return {
    globalLocalSource,
    // A project-local duplicate requires `opencode plugin list` from the
    // project directory; status is command-free, so this stays unknown.
    projectLocal: null,
    duplicate: null,
    details,
  }
}

export function statusReport(ctx: OperationContext): StatusReport {
  const d = ctx.detection
  const registration = registrationKind(d)
  const pluginInstalled = ctx.versions.plugin.installed ?? d.opencode.plugin.version
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
        ...(ctx.versions.plugin.error ? { error: redactSensitive(ctx.versions.plugin.error) } : {}),
      },
      spicetify: {
        installed: d.spicetify.version,
        latest: ctx.versions.spicetify.latest,
        ...(ctx.versions.spicetify.error ? { error: redactSensitive(ctx.versions.spicetify.error) } : {}),
      },
    },
    opencode: {
      available: d.opencode.available,
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
      detail: d.opencode.plugin.detail ? redactSensitive(d.opencode.plugin.detail) : null,
    },
    spotify: { installed: d.spotify.installed, store: d.spotify.store, path: d.spotify.path },
    spicetify: {
      available: d.spicetify.available,
      path: d.spicetify.path,
      version: d.spicetify.version,
      owner: d.spicetify.owner,
      ownerLabel: ownershipLabel(d.spicetify.owner),
      configPath: d.spicetify.configPath,
      ...(d.spicetify.error ? { error: redactSensitive(d.spicetify.error) } : {}),
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
      ...(d.bridge.error ? { error: redactSensitive(d.bridge.error) } : {}),
    },
    marketplace: readMarketplaceStatus(ctx.runtime, d.spicetify),
    port: portInfo(d),
    compatibility: {
      minimum: { opencode: MIN_OPENCODE, spicetify: MIN_SPICETIFY },
      opencode: compatibilityLabel(d.compatibility.opencode),
      spicetify: compatibilityLabel(d.compatibility.spicetify),
      bridge: compatibilityLabel(d.compatibility.bridge),
      plugin: compatibilityLabel(d.compatibility.plugin),
    },
    runtime: { connection: "not-probed", playbackVerified: false, note: RUNTIME_NOTE },
    ownership: {
      spicetify: d.spicetify.owner,
      spicetifyLabel: ownershipLabel(d.spicetify.owner),
      registration,
      registrationLabel: registrationLabel(registration),
      bridge: bridgeOwnership(d),
    },
    updates: {
      plugin: pluginAvailableUpdate(pluginInstalled, ctx.versions.plugin.latest, ctx.versions.plugin.latestBeta ?? null),
      spicetify: availableUpdate(d.spicetify.version, ctx.versions.spicetify.latest),
    },
    dependencies: inspectDependencies(ctx.runtime, import.meta.url),
    conflicts: statusConflicts(d),
    sideEffects: "none",
  }
}

/**
 * Resolve display labels for the plugin registry tags (B05). npm's `latest`
 * tag may point at a prerelease; never mislabel a beta as "Latest stable".
 * Single source of truth lives in update-plan.ts (B23); this wrapper keeps
 * existing imports working while delegating to it.
 */
export function resolveChannelLabels(
  latest: string | null,
  beta: string | null,
): { stable: string | null; beta: string | null; stableMissing: boolean } {
  return resolvePluginChannels(latest, beta)
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
    ? `${report.spicetify.version ?? "version unknown"} (${report.spicetify.ownerLabel})`
    : "not installed")
  ctx.ui.kv("Bridge", report.bridge.installed
    ? `installed; registration ${report.bridge.registration}`
    : report.bridge.credentialFile ? "configured; extension missing" : "not installed")
  ctx.ui.kv("Marketplace", report.marketplace.installed
    ? (report.marketplace.registered ? "installed; registered" : "installed; not registered")
    : "not installed")
  ctx.ui.kv("Bridge protocol", `${report.bridge.protocol}`)
  ctx.ui.kv("Credentials", report.bridge.credentialValid
    ? "valid shape (values are never displayed)"
    : report.bridge.credentialFile ? "present but invalid or unreadable" : "not provisioned")
  const portText = report.port.busy
    ? `127.0.0.1:${report.port.port} in use (${report.port.owner === "this-plugin" ? "this plugin" : "unknown owner"})`
    : `127.0.0.1:${report.port.port} available`
  ctx.ui.kv("Port", portText)
  if (report.port.conflict) {
    ctx.ui.warn(`Loopback port ${report.port.port} is unavailable and not proven to belong to this plugin; it was not touched.`)
  }
  ctx.ui.kv("Registration", report.ownership.registrationLabel)
  ctx.ui.kv("Runtime", "not probed (registration does not prove a live connection)")
  ctx.ui.kv("Plugin update", updateLabel(report.updates.plugin))
  ctx.ui.kv("Spicetify update", updateLabel(report.updates.spicetify))
  if (report.conflicts.globalLocalSource) {
    ctx.ui.warn("The global registration points at a local source; the published package may be shadowed.")
  }
  if (report.dependencies.status === "warn") {
    ctx.ui.warn(`Missing runtime dependencies: ${report.dependencies.missing.join(", ")}`)
  } else if (report.dependencies.status === "unknown") {
    ctx.ui.kv("Dependencies", "unknown (manifest could not be inspected)")
  }
  ctx.ui.status("info", report.runtime.note)
  ctx.ui.section("Compatibility")
  ctx.ui.status(report.compatibility.opencode === "compatible" ? "ok" : "warn", `OpenCode: ${report.compatibility.opencode}`)
  ctx.ui.status(report.compatibility.spicetify === "compatible" ? "ok" : "warn", `Spicetify: ${report.compatibility.spicetify}`)
  ctx.ui.status(report.compatibility.bridge === "compatible" ? "ok" : "warn", `Bridge: ${report.compatibility.bridge}`)
  if (report.versions.plugin.error) ctx.ui.warn(`Version check: ${report.versions.plugin.error}`)
  return 0
}
