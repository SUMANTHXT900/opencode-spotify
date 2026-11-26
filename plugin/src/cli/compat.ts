export const BRIDGE_PROTOCOL = 2 as const
export const BRIDGE_HANDSHAKE = "auto-1"
export const MIN_OPENCODE = "2.3.0"
export const MIN_SPICETIFY = "2.0.0"
export const BRIDGE_PORT = 18765

/** Upstream repository used for release discovery (stable channel only). */
export const SPICETIFY_REPO = "spicetify/cli"

/** Official Spicetify installer script pin (A02 evidence, 2026-11-26). */
export const OFFICIAL_INSTALLER_URL =
  "https://raw.githubusercontent.com/spicetify/cli/f4a824fbbe07233adeab889328e6fefdc274660b/install.ps1"
export const OFFICIAL_INSTALLER_COMMIT = "f4a824fbbe07233adeab889328e6fefdc274660b"
export const OFFICIAL_INSTALLER_SHA256 = "e65d1651dc6e3eacbcb58a56f2979f75ad1af16423b114d78d411312c0a8e22e"
export const OFFICIAL_INSTALLER_BYTES = 8307

/**
 * Reviewed Marketplace-removal patch (B27 / I3). The executed script is the
 * pinned original with exactly one reviewed 19-line comment block replacing
 * lines 224-242. Both the original and patched bytes are verified before the
 * child starts; there is no fallback to the unmodified script.
 */
export const OFFICIAL_INSTALLER_PATCHED_BYTES = 8236
export const OFFICIAL_INSTALLER_PATCHED_SHA256 =
  "056da19ece34be8c3d8543d0f98ff8ba08651bd384d4dc3a8d3dc9e72a7bf172"
export const OFFICIAL_INSTALLER_MARKETPLACE_BLOCK_BYTES = 1029
export const OFFICIAL_INSTALLER_MARKETPLACE_BLOCK_SHA256 =
  "5689b770f84bfedd40b03f08d811107f0be83619e89e8452ccf114de78927d3f"
export const OFFICIAL_INSTALLER_MARKETPLACE_BLOCK_LINES = 19

/**
 * Per-release reviewed artifact evidence. This is NOT a release target: it only
 * tightens post-install verification when a specific release was actually
 * reviewed. Never use it to substitute a target or to claim "pinned" for a
 * release that has no matching digest.
 */
export const REVIEWED_SPICETIFY_RELEASES: Readonly<
  Record<string, Readonly<{ sha256: string; size: number }>>
> = {
  "2.46.7": {
    sha256: "de7db28c1dc2fd7d4c0ecdfd8f2eaa5809d677c86628c7ae290d3c11af000cf6",
    size: 11829528,
  },
}

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
