import { compareVersions, isFloatingSpec } from "./compat.ts"
import type { AvailableUpdate } from "./versions.ts"

export interface UpdateAvailability {
  plugin: "current" | "outdated" | "unknown" | "downgrade"
  spicetify: "current" | "outdated" | "unknown" | "downgrade"
}

export interface UpdateChoice {
  plugin: boolean
  spicetify: boolean
  reason: string
}

export function updateAvailability(input: {
  pluginInstalled: string | null
  pluginLatest: string | null
  spicetifyInstalled: string | null
  spicetifyLatest: string | null
}): UpdateAvailability {
  const state = (installed: string | null, latest: string | null): UpdateAvailability["plugin"] => {
    if (!installed || !latest) return "unknown"
    const compared = compareVersions(latest, installed)
    if (compared === null) return "unknown"
    if (compared === 0) return "current"
    return compared > 0 ? "outdated" : "downgrade"
  }
  return {
    plugin: state(input.pluginInstalled, input.pluginLatest),
    spicetify: state(input.spicetifyInstalled, input.spicetifyLatest),
  }
}

/**
 * Canonical channel resolution (B23 single source of truth). npm's `latest`
 * tag may point at a prerelease: never label such a tag as stable.
 * Stable is the `latest` tag only when it is not a prerelease; beta is the
 * `beta` tag, falling back to a prerelease `latest` tag.
 */
export interface PluginChannels {
  stable: string | null
  beta: string | null
  stableMissing: boolean
}

export function resolvePluginChannels(
  latest: string | null,
  beta: string | null,
): PluginChannels {
  const stable = latest && !/-/.test(latest) ? latest : null
  const betaTag = beta ?? (latest && /-/.test(latest) ? latest : null)
  return { stable, beta: betaTag, stableMissing: !stable && !!betaTag }
}

/**
 * Channel-aware plugin update state (B23 single source of truth).
 * Distinguishes current / newer-available / older-registry-tag / unknown,
 * plus not-installed for fresh installs (which register the
 * installer/package version via registrationSpec, never the registry tag).
 * Stable installs stay on stable; beta installs see a newer beta or stable.
 * Never advertises an older registry tag as an update; never downgrades.
 */
export type PluginUpdateStatus =
  | "current"
  | "update-available"
  | "registry-older"
  | "unknown"
  | "not-installed"

export interface PluginUpdateInfo extends PluginChannels {
  status: PluginUpdateStatus
  /** Newer version to install, or null when no update applies. */
  target: string | null
}

export function describePluginUpdate(
  installed: string | null,
  latest: string | null,
  beta: string | null,
): PluginUpdateInfo {
  const channels = resolvePluginChannels(latest, beta)
  const { stable, beta: betaTag, stableMissing } = channels
  if (!installed) {
    return { ...channels, stable, beta: betaTag, stableMissing, status: "not-installed", target: null }
  }
  if (!latest && !beta) {
    return { ...channels, status: "unknown", target: null }
  }
  // Preserve existing selectPluginTarget semantics: target selection uses the
  // raw registry tags (a prerelease `latest` tag may still be a newer target
  // for older installs). Channel labels above stay sanitized for display.
  const target = selectPluginTarget(installed, latest, beta)
  if (target) {
    return { ...channels, status: "update-available", target }
  }
  // No newer target. Distinguish current from an older registry tag.
  const tags = [latest, beta].filter((value): value is string => !!value)
  if (!tags.length) {
    return { ...channels, status: "unknown", target: null }
  }
  let sawCurrent = false
  let sawOlder = false
  for (const tag of tags) {
    const compared = compareVersions(tag, installed)
    if (compared === null) {
      continue
    }
    if (compared === 0) sawCurrent = true
    else if (compared < 0) sawOlder = true
    else {
      // Newer tag exists but selectPluginTarget withheld it (for example a
      // stable install ignoring a newer beta). That install is current on
      // its own channel, not outdated and not a downgrade.
      sawCurrent = true
    }
  }
  // Installed itself unparseable: cannot compare, report unknown.
  if (compareVersions(installed, installed) === null) {
    return { ...channels, status: "unknown", target: null }
  }
  if (sawCurrent) return { ...channels, status: "current", target: null }
  if (sawOlder) return { ...channels, status: "registry-older", target: null }
  return { ...channels, status: "unknown", target: null }
}
/**
 * Known-broken prerelease (beta.2) recovery marker. beta.2 shipped an
 * extension that could not be repaired by a plain re-apply; an update or
 * repair must always re-provision the owned bridge even when it inspects as
 * "current". Exact match only: never guess at other prereleases.
 */
export const BROKEN_BRIDGE_PRERELEASE = "0.6.0-beta.2"

export function isBrokenBeta2(installed: string | null | undefined): boolean {
  return (installed ?? "").trim().toLowerCase() === BROKEN_BRIDGE_PRERELEASE
}

/**
 * Human label for the channel-aware plugin state. Installed and target are
 * shown explicitly so no workflow advertises an older tag as an update.
 */
export function describePluginVersionLine(installed: string | null, info: PluginUpdateInfo): string {
  const current = installed ?? "not installed"
  if (info.target) return `${current} -> ${info.target}`
  if (info.status === "current") return `${current} (current)`
  if (info.status === "registry-older") return `${current} (registry tag is older; kept)`
  if (info.status === "unknown") return `${current} (target unknown)`
  return current
}

/**
 * Channel-aware plugin update expressed as an AvailableUpdate (B23 single
 * source of truth for status/doctor output). A beta install that matches the
 * beta tag is "current", never a "downgrade": comparing against the stable
 * tag alone would falsely warn "installed version is newer".
 */
export function pluginAvailableUpdate(
  installed: string | null,
  latest: string | null,
  beta: string | null,
): AvailableUpdate {
  const info = describePluginUpdate(installed, latest, beta)
  switch (info.status) {
    case "update-available":
      return { installed, latest: info.target, status: "outdated", available: true }
    case "current":
      return { installed, latest: latest ?? beta ?? installed, status: "current", available: false }
    case "registry-older":
      return { installed, latest: latest ?? beta ?? null, status: "downgrade", available: false }
    default:
      return { installed, latest: latest ?? null, status: "unknown", available: false }
  }
}

export function selectPluginTarget(
  installed: string | null,
  latestStable: string | null,
  latestBeta: string | null,
): string | null {
  if (!installed) return latestStable
  const isBeta = /-/.test(installed)
  if (!isBeta) {
    return latestStable && compareVersions(latestStable, installed) === 1 ? latestStable : null
  }
  const candidates = [latestStable, latestBeta]
    .filter((value): value is string => !!value)
    .filter((value) => compareVersions(value, installed) === 1)
    .sort((a, b) => compareVersions(b, a) ?? 0)
  return candidates[0] ?? null
}

/**
 * Decide what may change. A missing latest version is never permission to
 * downgrade or reinstall, and a local development path is never replaced by a
 * registry update without an explicit global install decision.
 */
export function recommendUpdate(input: {
  availability: UpdateAvailability
  pluginSpec: string | null
  pluginLocal: boolean
  allowSpicetifyUpgrade: boolean
  pinned: boolean
}): UpdateChoice {
  if (input.pluginLocal) return { plugin: false, spicetify: false, reason: "A local development plugin is registered; use setup to switch to the global package." }
  if (input.availability.plugin === "downgrade" || input.availability.spicetify === "downgrade") {
    return { plugin: false, spicetify: false, reason: "The registry reports an older version; downgrades are never automatic." }
  }
  const plugin = input.availability.plugin === "outdated"
  const spicetify = input.allowSpicetifyUpgrade && input.availability.spicetify === "outdated"
  if (!plugin && !spicetify) {
    const reason = input.availability.plugin === "unknown"
      ? "Version information is unavailable."
      : input.pinned && !isFloatingSpec(input.pluginSpec)
        ? "The installed version is pinned and current."
        : "Everything available is current."
    return { plugin: false, spicetify: false, reason }
  }
  return {
    plugin,
    spicetify,
    reason: spicetify && plugin ? "Plugin and Spicetify updates are available." : plugin ? "A plugin update is available." : "A Spicetify update is available.",
  }
}
