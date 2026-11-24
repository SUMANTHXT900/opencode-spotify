import { compareVersions, isFloatingSpec } from "./compat.ts"

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
 * Select the plugin update target honoring release channels.
 * Stable installs never auto-switch to a prerelease. Prerelease installs
 * consider both the stable and beta tags and take the highest version that
 * is newer than what is installed. Returns null when nothing newer exists.
 */
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
