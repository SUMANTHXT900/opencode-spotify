export const BRIDGE_PROTOCOL = 2 as const
export const BRIDGE_HANDSHAKE = "auto-1"
export const MIN_OPENCODE = "2.3.0"
export const MIN_SPICETIFY = "2.0.0"
export const BRIDGE_PORT = 18765

export function parseVersion(value: string | null | undefined): [number, number, number] | null {
  if (!value) return null
  const match = value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/i)
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function parseSemver(value: string | null | undefined): { numbers: [number, number, number]; prerelease: string[] } | null {
  if (!value) return null
  const match = value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/i)
  if (!match) return null
  return {
    numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split(".") : [],
  }
}

export function compareVersions(left: string | null | undefined, right: string | null | undefined): number | null {
  const a = parseSemver(left)
  const b = parseSemver(right)
  if (!a || !b) return null
  for (let index = 0; index < 3; index++) {
    if (a.numbers[index]! !== b.numbers[index]!) return a.numbers[index]! > b.numbers[index]! ? 1 : -1
  }
  // Semver: a release outranks its prereleases; identifiers compare
  // numerically when both are numeric, otherwise lexically.
  if (!a.prerelease.length && !b.prerelease.length) return 0
  if (!a.prerelease.length) return 1
  if (!b.prerelease.length) return -1
  const length = Math.max(a.prerelease.length, b.prerelease.length)
  for (let index = 0; index < length; index++) {
    const x = a.prerelease[index]
    const y = b.prerelease[index]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const nx = /^\d+$/.test(x) ? Number(x) : null
    const ny = /^\d+$/.test(y) ? Number(y) : null
    if (nx !== null && ny !== null) {
      if (nx !== ny) return nx > ny ? 1 : -1
    } else if (x !== y) {
      return x > y ? 1 : -1
    }
  }
  return 0
}

export function isAtLeast(version: string | null | undefined, minimum: string): boolean | null {
  const result = compareVersions(version, minimum)
  return result === null ? null : result >= 0
}

/** True when a configured spec can move on its own (range, tag, or branch). */
export function isFloatingSpec(spec: string | null | undefined): boolean {
  if (!spec) return false
  const value = spec.trim()
  if (value.startsWith("./") || value.startsWith("../") || value.startsWith("/") || value.startsWith("file:") || /^[A-Za-z]:[\\/]/.test(value)) return false
  if (value.startsWith("github:") && !value.includes("#")) return false
  const at = value.lastIndexOf("@")
  if (at > 0) {
    const tag = value.slice(at + 1)
    return !/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(tag)
  }
  return false
}

export function bridgeCompatibility(input: {
  pluginVersion: string
  bridgeInstalled: boolean
  bridgeRegistration: "absent" | "current" | "stale" | "unknown"
}): "compatible" | "stale" | "missing" | "unknown" {
  if (!input.bridgeInstalled) return "missing"
  if (input.bridgeRegistration === "current") return "compatible"
  if (input.bridgeRegistration === "stale") return "stale"
  return "unknown"
}
