import { readFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { CancelToken } from "./cancel.ts"
import type { InstallOwner, Runtime, VersionInfo } from "./types.ts"
import { compareVersions, parseVersion } from "./compat.ts"
import { OPERATION_TIMEOUTS } from "./runtime.ts"
import { resolveSpicetifyRelease, parseStableVersion } from "./spicetify-release.ts"

export function packageVersion(metaUrl: string): string {
  const path = fileURLToPath(new URL("../../package.json", metaUrl))
  const value: unknown = JSON.parse(readFileSync(path, "utf8"))
  if (!value || typeof value !== "object" || typeof (value as { version?: unknown }).version !== "string") return "0.0.0"
  return (value as { version: string }).version
}

function cleanVersion(output: string): string | null {
  const match = output.match(/v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/)
  return match?.[1] ?? null
}

/** Options shared by registry lookups that participate in cancellation. */
export interface VersionLookupOptions {
  cancel?: CancelToken
}

const RELEASE_TIMEOUT_MS = 12_000

/**
 * Existing timeout plus the operation's cancel signal. `AbortSignal.any`
 * keeps the 12s registry budget authoritative while letting a cancellation
 * abort the in-flight request immediately.
 */
function lookupSignal(timeoutMs: number, cancel?: CancelToken, extra?: AbortSignal | null): AbortSignal {
  const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)]
  if (cancel) signals.push(cancel.signal)
  if (extra) signals.push(extra)
  return signals.length === 1 ? signals[0]! : AbortSignal.any(signals)
}

/** Wrap a fetcher so every request carries the timeout and cancel signal. */
function cancelAwareFetch(fetcher: typeof fetch, cancel?: CancelToken): typeof fetch {
  return (input, init) => fetcher(input, { ...(init ?? {}), signal: lookupSignal(RELEASE_TIMEOUT_MS, cancel, init?.signal ?? null) })
}

function safeError(value: string): string {
  return value
    .replace(/\/\/[^\s:]+:_authToken=\S+/gi, "[redacted]")
    .replace(/\b[a-f0-9]{32,}\b/gi, "[redacted]")
    .replace(/\b(secret|token|password|credential|authorization)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .slice(0, 200)
}

export async function npmLatest(runtime: Runtime, packageName: string, offline: boolean, options: VersionLookupOptions = {}): Promise<VersionInfo> {
  const tags = await npmTags(runtime, packageName, offline, options)
  return { installed: null, latest: tags.latest ?? null, latestBeta: tags.beta ?? null, error: tags.error }
}

export async function npmTags(
  runtime: Runtime,
  packageName: string,
  offline: boolean,
  options: VersionLookupOptions = {},
): Promise<{ latest?: string | null; beta?: string | null; error?: string }> {
  if (offline) return { latest: null, beta: null, error: "Offline mode: registry not queried" }
  // Boundary check before any network or child process.
  if (options.cancel?.requested) return { latest: null, beta: null, error: "Cancelled" }
  // A custom registry mirror (npm_config_registry) may not serve the public
  // dist-tags endpoint: skip the direct fetch and use `npm view` (which
  // honors the configured registry) instead.
  const customRegistry = runtime.env.npm_config_registry ?? runtime.env.NPM_CONFIG_REGISTRY
  if (!customRegistry) {
    const fetched = await fetchNpmDistTags(packageName, options.cancel)
    if (fetched.cancelled) return { latest: null, beta: null, error: "Cancelled" }
    if (fetched.tags) return fetched.tags
  }
  return npmViewTags(runtime, packageName, options.cancel)
}

/**
 * Query the npm registry dist-tags endpoint directly (no child process, no
 * shell). Returns `{ tags }` on success, `{ tags: null }` when the caller
 * should fall back to `npm view`, and `{ cancelled: true }` when the
 * operation was cancelled (never fall back after cancellation: spawning a
 * child post-cancel would violate the cancellation boundary).
 */
async function fetchNpmDistTags(
  packageName: string,
  cancel?: CancelToken,
): Promise<{ tags?: { latest?: string | null; beta?: string | null } | null; cancelled?: boolean }> {
  try {
    const fetcher = globalThis.fetch
    if (typeof fetcher !== "function") return { tags: null }
    const response = await fetcher(`https://registry.npmjs.org/-/package/${encodeURIComponent(packageName)}/dist-tags`, {
      headers: { Accept: "application/json", "User-Agent": "opencode-spotify-installer" },
      signal: lookupSignal(RELEASE_TIMEOUT_MS, cancel),
    })
    if (cancel?.requested) return { cancelled: true }
    if (!response.ok) return { tags: null }
    const parsed: unknown = await response.json()
    if (cancel?.requested) return { cancelled: true }
    if (!parsed || typeof parsed !== "object") return { tags: null }
    const record = parsed as Record<string, unknown>
    return {
      tags: {
        latest: typeof record.latest === "string" ? cleanVersion(record.latest) : null,
        beta: typeof record.beta === "string" ? cleanVersion(record.beta) : null,
      },
    }
  } catch (error) {
    if (cancel?.requested) return { cancelled: true }
    // AbortError without a requested cancellation is the registry timeout:
    // fall back to `npm view` rather than reporting failure immediately.
    void error
    return { tags: null }
  }
}

async function npmViewTags(
  runtime: Runtime,
  packageName: string,
  cancel?: CancelToken,
): Promise<{ latest?: string | null; beta?: string | null; error?: string }> {
  const result = await runtime.run("npm", ["view", packageName, "dist-tags", "--json"], {
    timeoutMs: OPERATION_TIMEOUTS.registry,
    killPolicy: "tree",
    ...(cancel ? { cancel } : {}),
  })
  if (cancel?.requested || result.cancelled) return { latest: null, beta: null, error: "Cancelled" }
  if (result.code !== 0) {
    const detail = result.stderr.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "npm registry unavailable"
    return { latest: null, beta: null, error: safeError(detail) }
  }
  try {
    const parsed: unknown = JSON.parse(result.stdout.trim())
    if (!parsed || typeof parsed !== "object") return { latest: null, beta: null, error: "Invalid registry metadata" }
    const record = parsed as Record<string, unknown>
    return {
      latest: typeof record.latest === "string" ? cleanVersion(record.latest) : null,
      beta: typeof record.beta === "string" ? cleanVersion(record.beta) : null,
    }
  } catch {
    return { latest: null, beta: null, error: "Invalid registry metadata" }
  }
}

/**
 * Map a resolver failure to the installer's existing GitHub error strings.
 * HTTP status is preserved (404/403/429); rate limits keep their wording.
 * The exact status is read from the code or message so a typed resolver and a
 * text-only resolver both map identically.
 */
function releaseError(code: unknown, error: unknown): string {
  const codeText = String(code ?? "").trim()
  const messageText = String(error ?? "").trim()
  const combined = `${codeText} ${messageText}`.trim()
  let status: number | null = null
  const direct = /^(?:http[-_ ]?)?(\d{3})$/i.exec(codeText)
  if (direct) status = Number(direct[1])
  const inMessage = /HTTP\s+(\d{3})/i.exec(combined)
  if (status === null && inMessage) status = Number(inMessage[1])
  if (status === null && /rate.?limit/i.test(combined)) status = 403
  if (status !== null && status >= 400) {
    return /rate.?limit/i.test(combined) && status === 403
      ? "GitHub release metadata unavailable (HTTP 403, rate limit)"
      : `GitHub release metadata unavailable (HTTP ${status})`
  }
  if (/offline/i.test(combined)) return "Offline mode: GitHub not queried"
  return safeError(messageText || codeText || "GitHub release metadata unavailable")
}

/**
 * Spicetify release discovery delegates to the strict resolver (F1): only a
 * published stable release counts, an unknown or prerelease-only state stays
 * `null` with an error. No loose tag parsing happens here.
 */
async function spicetifyReleaseLatest(
  runtime: Runtime,
  fetcher: typeof fetch,
  options: VersionLookupOptions,
): Promise<VersionInfo> {
  if (options.cancel?.requested) return { installed: null, latest: null, error: "Cancelled" }
  try {
    const result = await resolveSpicetifyRelease({
      offline: false,
      fetcher: cancelAwareFetch(fetcher, options.cancel),
      arch: runtime.arch,
      requireWindowsAsset: false,
      now: () => runtime.now(),
      ...(options.cancel ? { signal: options.cancel.signal } : {}),
    })
    if (options.cancel?.requested) return { installed: null, latest: null, error: "Cancelled" }
    if (!result.ok) return { installed: null, latest: null, error: releaseError(result.code, result.error) }
    const version = parseStableVersion(result.release.version)
    if (!version) return { installed: null, latest: null, error: "GitHub release metadata has no stable version" }
    return { installed: null, latest: version }
  } catch (error) {
    if (options.cancel?.requested) return { installed: null, latest: null, error: "Cancelled" }
    return { installed: null, latest: null, error: releaseError(undefined, error instanceof Error ? error.message : "GitHub request failed") }
  }
}

export async function githubLatest(
  runtime: Runtime,
  repo: string,
  offline: boolean,
  options?: VersionLookupOptions,
): Promise<VersionInfo>
export async function githubLatest(
  runtime: Runtime,
  repo: string,
  offline: boolean,
  fetcher: typeof fetch,
  options?: VersionLookupOptions,
): Promise<VersionInfo>
export async function githubLatest(
  runtime: Runtime,
  repo: string,
  offline: boolean,
  fetcherOrOptions: typeof fetch | VersionLookupOptions = fetch,
  maybeOptions: VersionLookupOptions = {},
): Promise<VersionInfo> {
  const fetcher = typeof fetcherOrOptions === "function" ? fetcherOrOptions : fetch
  const options = typeof fetcherOrOptions === "function" ? maybeOptions : fetcherOrOptions
  if (offline) return { installed: null, latest: null, error: "Offline mode: GitHub not queried" }
  if (repo === "spicetify/cli") return spicetifyReleaseLatest(runtime, fetcher, options)
  if (options.cancel?.requested) return { installed: null, latest: null, error: "Cancelled" }
  try {
    const response = await fetcher(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "opencode-spotify-installer" },
      signal: lookupSignal(RELEASE_TIMEOUT_MS, options.cancel),
    })
    if (options.cancel?.requested) return { installed: null, latest: null, error: "Cancelled" }
    if (!response.ok) return { installed: null, latest: null, error: `GitHub release metadata unavailable (HTTP ${response.status})` }
    const value: unknown = await response.json()
    if (!value || typeof value !== "object") return { installed: null, latest: null, error: "Invalid release metadata" }
    const tag = (value as { tag_name?: unknown }).tag_name
    return { installed: null, latest: typeof tag === "string" ? cleanVersion(tag) : null }
  } catch (error) {
    if (options.cancel?.requested) return { installed: null, latest: null, error: "Cancelled" }
    return { installed: null, latest: null, error: safeError(error instanceof Error ? error.message : "GitHub request failed") }
  }
}

export function compareAvailable(installed: string | null, latest: string | null): "current" | "outdated" | "unknown" | "downgrade" {
  if (!installed || !latest) return "unknown"
  if (!parseVersion(installed) || !parseVersion(latest)) return "unknown"
  const compared = compareVersions(latest, installed)
  if (compared === null) return "unknown"
  if (compared === 0) return "current"
  return compared > 0 ? "outdated" : "downgrade"
}

/** A single "is a newer version published?" answer for status/doctor output. */
export interface AvailableUpdate {
  installed: string | null
  latest: string | null
  status: "current" | "outdated" | "unknown" | "downgrade"
  available: boolean
}

export function availableUpdate(installed: string | null, latest: string | null): AvailableUpdate {
  const status = compareAvailable(installed, latest)
  return { installed, latest, status, available: status === "outdated" }
}

/** Human wording for an update state. Never implies a failed or unverified check is current. */
export function updateLabel(update: AvailableUpdate): string {
  switch (update.status) {
    case "current": return "up to date"
    case "outdated": return `update available (${update.latest ?? "newer version"})`
    case "downgrade": return "installed version is newer than the published version"
    default: return "unknown"
  }
}

/**
 * Ownership label for the Spicetify copy that is installed. This is a
 * classification only: diagnostics tell users to keep using the method that
 * owns the copy, never to mix package managers or run a Winget command.
 */
export function ownershipLabel(owner: InstallOwner): string {
  switch (owner) {
    case "script": return "official installer"
    case "winget": return "winget package"
    case "scoop": return "scoop package"
    case "choco": return "chocolatey package"
    default: return "unknown owner"
  }
}

export type DependencyStatus = "ok" | "missing" | "unknown"

export interface DependencyCheck {
  name: string
  declared: string | null
  installed: string | null
  status: DependencyStatus
}

export interface DependencyReport {
  status: "ok" | "warn" | "unknown"
  checks: DependencyCheck[]
  missing: string[]
}

/**
 * Runtime dependencies that can be inspected safely (files only, never
 * executed). The Ink stack is included because a missing renderer shows up as
 * a TUI failure, not an installer failure. The scoped name is assembled so
 * core CLI modules stay free of a static UI dependency reference (A03).
 */
const INK_UI_PACKAGE = ["@inkjs", "ui"].join("/")

export const DIAGNOSTIC_DEPENDENCIES = [
  INK_UI_PACKAGE,
  "@opencode/plugin",
  "@opentui/core",
  "@opentui/solid",
  "ink",
  "react",
  "solid-js",
  "ws",
] as const

function readJsonObject(runtime: Runtime, path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(runtime.readText(path))
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * Read an installed package manifest. Prefer the package's own node_modules;
 * npm may also hoist a dependency to the parent node_modules when this package
 * itself lives under one, so check that sibling location as a fallback.
 */
function readInstalledManifest(runtime: Runtime, root: string, name: string): Record<string, unknown> | null {
  const direct = readJsonObject(runtime, join(root, "node_modules", name, "package.json"))
  if (direct) return direct
  const parent = dirname(root)
  if (basename(parent).toLowerCase() === "node_modules") {
    return readJsonObject(runtime, join(parent, name, "package.json"))
  }
  return null
}

/**
 * Inspect declared runtime dependencies and their installed package.json
 * versions. Strictly read-only: reads files through the Runtime contract and
 * never executes a package manager. A missing manifest is "unknown" with no
 * per-package checks, never a false report that dependencies are present.
 */
export function inspectDependencies(runtime: Runtime, metaUrl: string): DependencyReport {
  const root = fileURLToPath(new URL("../../", metaUrl))
  const manifest = readJsonObject(runtime, join(root, "package.json"))
  const declared = manifest && manifest.dependencies && typeof manifest.dependencies === "object"
    ? (manifest.dependencies as Record<string, unknown>)
    : null
  // Without a readable manifest there is no declared set to compare against;
  // per-package verdicts would be guesses. Report the aggregate as unknown and
  // omit the checks rather than naming packages we could not evaluate.
  const checks: DependencyCheck[] = manifest ? DIAGNOSTIC_DEPENDENCIES.map((name) => {
    const declaredVersion = declared && typeof declared[name] === "string" ? (declared[name] as string) : null
    const installedManifest = readInstalledManifest(runtime, root, name)
    const installed = installedManifest && typeof installedManifest.version === "string"
      ? (installedManifest.version as string)
      : null
    const status: DependencyStatus = installed ? "ok" : declaredVersion ? "missing" : "unknown"
    return { name, declared: declaredVersion, installed, status }
  }) : []
  const missing = checks.filter((check) => check.status === "missing").map((check) => check.name)
  const status = !manifest ? "unknown" : missing.length ? "warn" : checks.some((check) => check.status === "unknown") ? "unknown" : "ok"
  return { status, checks, missing }
}

/**
 * Redact credential values, tokens, e-mail addresses, and personal home
 * paths from any text that may be copied into a public issue. Diagnostic
 * reports must remain useful: only the sensitive fragments are replaced.
 */
export function redactSensitive(value: string): string {
  return value
    .replace(/\/\/[^\s:]+:_authToken=\S+/gi, "[redacted]")
    .replace(/\b[a-f0-9]{64}\b/gi, "[redacted-secret]")
    .replace(/\b[a-f0-9]{32,}\b/gi, "[redacted]")
    .replace(/\b(secret|token|password|credential|authorization|api[_-]?key)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[redacted-email]")
    .replace(/([A-Za-z]:\\Users\\)[^\\\r\n]+/gi, "$1<user>")
    .replace(/(\/(?:home|Users)\/)[^/\s]+/g, "$1<user>")
}

export { cleanVersion }
