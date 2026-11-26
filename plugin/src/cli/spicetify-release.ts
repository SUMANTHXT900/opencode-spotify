// Dynamic Spicetify release discovery (B26 / I2).
//
// The installer script itself is pinned, but the release *target* must not be.
// This module resolves the latest published stable release from GitHub and
// validates it strictly, so the mutation path never contains a static version:
//   * only stable semver tags are accepted (no prerelease/build/leading zeros),
//   * drafts and prereleases are rejected defensively,
//   * the target must satisfy the shared MIN_SPICETIFY floor,
//   * the exact Windows asset for the host architecture must exist,
//   * every asset URL must be the upstream GitHub release URL.
//
// Failure is always explicit and never substituted with a hardcoded version.
import { MIN_SPICETIFY, SPICETIFY_REPO, compareVersions } from "./compat.ts"

export interface ReleaseAsset {
  name: string
  size: number
  /** "sha256:<64 hex>" when GitHub publishes one; metadata only. */
  digest: string | null
  url: string
}

export interface SpicetifyRelease {
  /** Canonical "9.9.9" (no leading v). */
  version: string
  /** Raw tag, e.g. "v9.9.9". */
  tag: string
  releaseId: number | null
  publishedAt: string | null
  assets: ReleaseAsset[]
  source: "github"
  fetchedAt: number
}

export type ReleaseErrorCode =
  | "E_OFFLINE"
  | "E_RELEASE_LOOKUP"
  | "E_RATE_LIMIT"
  | "E_RELEASE_INVALID"
  | "E_RELEASE_PRERELEASE"
  | "E_RELEASE_ASSET"
  | "E_RELEASE_UNSUPPORTED"

export type ReleaseResolution =
  | { ok: true; release: SpicetifyRelease }
  | { ok: false; code: ReleaseErrorCode; error: string; retryAfter?: number }

export interface ResolveReleaseInput {
  offline?: boolean
  fetcher?: typeof fetch
  arch?: string | null
  requireWindowsAsset?: boolean
  /** Absolute epoch ms, or a clock function (kept for callers/tests). */
  now?: number | (() => number)
  /** Optional cooperative cancellation; combined with the 12s timeout. */
  signal?: AbortSignal
}

export const SPICETIFY_RELEASES_URL = `https://api.github.com/repos/${SPICETIFY_REPO}/releases/latest`

const RELEASE_TIMEOUT_MS = 12_000
const MAX_METADATA_BYTES = 512 * 1024
const GITHUB_ASSET_PREFIX = `https://github.com/${SPICETIFY_REPO}/releases/download/`
const STABLE_VERSION = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

/**
 * Strict stable version parser. Accepts an optional leading `v`; rejects
 * prerelease identifiers, build metadata, incomplete versions, leading zeros
 * and any surrounding text. Returns the canonical version without `v`.
 */
export function parseStableVersion(value: unknown): string | null {
  if (typeof value !== "string") return null
  const match = STABLE_VERSION.exec(value.trim())
  if (!match) return null
  return `${match[1]}.${match[2]}.${match[3]}`
}

/** Map a host architecture string to the release asset token. */
export function releaseArchToken(value: string | null | undefined): "x64" | "arm64" | "x32" | null {
  if (typeof value !== "string") return null
  const token = value.trim().toLowerCase()
  if (token === "x64" || token === "amd64" || token === "x86_64") return "x64"
  if (token === "arm64" || token === "aarch64") return "arm64"
  if (token === "x32" || token === "ia32" || token === "x86" || token === "386") return "x32"
  return null
}

export function windowsAssetName(version: string, arch: "x64" | "arm64" | "x32"): string {
  return `spicetify-${version}-windows-${arch}.zip`
}

/** The reviewed asset for a release/architecture, or null when absent. */
export function spicetifyReleaseAsset(
  release: SpicetifyRelease,
  arch: string | null | undefined,
): ReleaseAsset | null {
  const token = releaseArchToken(arch)
  if (!token) return null
  const name = windowsAssetName(release.version, token)
  return release.assets.find((asset) => asset.name === name) ?? null
}

function resolveNow(now: ResolveReleaseInput["now"]): number {
  if (typeof now === "function") {
    try {
      const value = now()
      return Number.isFinite(value) ? value : Date.now()
    } catch {
      return Date.now()
    }
  }
  return typeof now === "number" && Number.isFinite(now) ? now : Date.now()
}

function rateLimitDetails(response: Response, nowMs: number): { limited: boolean; retryAfter?: number } {
  const remaining = response.headers.get("x-ratelimit-remaining")
  const limited = response.status === 429 || remaining === "0"
  if (!limited) return { limited: false }
  const retryAfterHeader = response.headers.get("retry-after")
  if (retryAfterHeader) {
    const seconds = Number(retryAfterHeader)
    if (Number.isFinite(seconds) && seconds >= 0) return { limited: true, retryAfter: Math.ceil(seconds) }
    const at = Date.parse(retryAfterHeader)
    if (Number.isFinite(at)) return { limited: true, retryAfter: Math.max(0, Math.ceil((at - nowMs) / 1000)) }
  }
  const reset = Number(response.headers.get("x-ratelimit-reset"))
  if (Number.isFinite(reset) && reset > 0) {
    return { limited: true, retryAfter: Math.max(0, Math.ceil(reset - nowMs / 1000)) }
  }
  return { limited: true }
}

function invalid(error: string): ReleaseResolution {
  return { ok: false, code: "E_RELEASE_INVALID", error }
}

function parseAsset(value: unknown): ReleaseAsset | null {
  if (!value || typeof value !== "object") return null
  const record = value as Record<string, unknown>
  if (typeof record.name !== "string" || !record.name.trim()) return null
  // GitHub's asset API puts the API URL in `url`; the install URL is
  // `browser_download_url`. Only the latter may be used for downloads.
  const browser = typeof record.browser_download_url === "string" ? record.browser_download_url : null
  const legacy = typeof record.url === "string" && record.url.startsWith(GITHUB_ASSET_PREFIX) ? record.url : null
  const download = browser ?? legacy
  if (download === null || !download.startsWith(GITHUB_ASSET_PREFIX)) return null
  const size = typeof record.size === "number" && Number.isFinite(record.size) && record.size >= 0
    ? record.size
    : 0
  const digest = typeof record.digest === "string" && /^sha256:[0-9a-f]{64}$/i.test(record.digest)
    ? record.digest.toLowerCase()
    : null
  return { name: record.name, size, digest, url: download }
}

/**
 * Resolve the latest stable Spicetify release. Never falls back to a known
 * version: any failure is reported with its own code and no target.
 */
export async function resolveSpicetifyRelease(input: ResolveReleaseInput = {}): Promise<ReleaseResolution> {
  if (input.offline) {
    return {
      ok: false,
      code: "E_OFFLINE",
      error: "Offline mode: the latest stable Spicetify release was not looked up; no install or upgrade target exists.",
    }
  }

  const nowMs = resolveNow(input.now)
  const fetcher = input.fetcher ?? fetch
  const signals: AbortSignal[] = [AbortSignal.timeout(RELEASE_TIMEOUT_MS)]
  if (input.signal) signals.push(input.signal)

  let response: Response
  try {
    response = await fetcher(SPICETIFY_RELEASES_URL, {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "opencode-spotify-installer",
        "Cache-Control": "no-cache",
      },
      redirect: "error",
      signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals),
    })
  } catch (error) {
    const detail = error instanceof Error && error.message ? error.message : "release lookup failed"
    return {
      ok: false,
      code: "E_RELEASE_LOOKUP",
      error: `GitHub release metadata could not be retrieved: ${detail.slice(0, 200)}`,
    }
  }

  if (!response.ok) {
    const limit = rateLimitDetails(response, nowMs)
    if (limit.limited) {
      return {
        ok: false,
        code: "E_RATE_LIMIT",
        error: `GitHub rate limit reached (HTTP ${response.status})${limit.retryAfter !== undefined ? `; retry after ${limit.retryAfter}s` : ""}. No release target is available.`,
        ...(limit.retryAfter !== undefined ? { retryAfter: limit.retryAfter } : {}),
      }
    }
    if (response.status === 404) {
      return {
        ok: false,
        code: "E_RELEASE_LOOKUP",
        error: "GitHub reports no published stable release (HTTP 404). No release target is available.",
      }
    }
    return {
      ok: false,
      code: "E_RELEASE_LOOKUP",
      error: `GitHub release metadata unavailable (HTTP ${response.status}). No release target is available.`,
    }
  }

  const declared = Number(response.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > MAX_METADATA_BYTES) {
    return invalid("release metadata is larger than the accepted 512 KiB cap")
  }

  let text: string
  try {
    text = await response.text()
  } catch (error) {
    const detail = error instanceof Error && error.message ? error.message : "body read failed"
    return { ok: false, code: "E_RELEASE_LOOKUP", error: `GitHub release metadata could not be read: ${detail.slice(0, 200)}` }
  }
  if (Buffer.byteLength(text, "utf8") > MAX_METADATA_BYTES) {
    return invalid("release metadata is larger than the accepted 512 KiB cap")
  }

  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    return invalid("GitHub release metadata is not valid JSON")
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return invalid("GitHub release metadata is not a JSON object")
  }
  const record = payload as Record<string, unknown>

  if (record.draft === true) {
    return invalid("GitHub returned a draft release; drafts are never install targets")
  }
  if (record.prerelease === true) {
    return {
      ok: false,
      code: "E_RELEASE_PRERELEASE",
      error: "GitHub returned a prerelease; only published stable releases are install targets.",
    }
  }

  const version = parseStableVersion(record.tag_name)
  if (!version) {
    return invalid(`release tag ${JSON.stringify(record.tag_name ?? null)} is not a strict stable semver version`)
  }
  if (compareVersions(version, MIN_SPICETIFY) === -1) {
    return {
      ok: false,
      code: "E_RELEASE_UNSUPPORTED",
      error: `Spicetify ${version} is older than the supported minimum ${MIN_SPICETIFY}.`,
    }
  }

  if (!Array.isArray(record.assets)) {
    return invalid("release metadata has no assets array")
  }
  const assets: ReleaseAsset[] = []
  for (const entry of record.assets) {
    const asset = parseAsset(entry)
    if (!asset) {
      // Fail closed: an asset outside the upstream GitHub release URL space is
      // never acceptable, even if the expected file name happens to exist.
      return {
        ok: false,
        code: "E_RELEASE_ASSET",
        error: "release metadata contains an asset with an invalid or non-GitHub URL",
      }
    }
    assets.push(asset)
  }

  const release: SpicetifyRelease = {
    version,
    tag: typeof record.tag_name === "string" ? record.tag_name.trim() : `v${version}`,
    releaseId: typeof record.id === "number" && Number.isFinite(record.id) ? record.id : null,
    publishedAt: typeof record.published_at === "string" ? record.published_at : null,
    assets,
    source: "github",
    fetchedAt: nowMs,
  }

  if (input.requireWindowsAsset) {
    const arch = releaseArchToken(input.arch)
    if (!arch) {
      return {
        ok: false,
        code: "E_RELEASE_UNSUPPORTED",
        error: `The host architecture ${JSON.stringify(input.arch ?? null)} has no reviewed Windows release asset. Automatic installation is refused.`,
      }
    }
    const asset = spicetifyReleaseAsset(release, arch)
    if (!asset) {
      return {
        ok: false,
        code: "E_RELEASE_ASSET",
        error: `release v${version} has no ${windowsAssetName(version, arch)} asset. The install is refused before approval.`,
      }
    }
    if (!asset.url.startsWith(GITHUB_ASSET_PREFIX)) {
      return {
        ok: false,
        code: "E_RELEASE_ASSET",
        error: `the ${asset.name} asset URL is not an upstream GitHub release URL.`,
      }
    }
  }

  return { ok: true, release }
}
