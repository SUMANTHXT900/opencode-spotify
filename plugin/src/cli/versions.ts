import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import type { Runtime, VersionInfo } from "./types.ts"
import { compareVersions, parseVersion } from "./compat.ts"

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

function safeError(value: string): string {
  return value
    .replace(/\/\/[^\s:]+:_authToken=\S+/gi, "[redacted]")
    .replace(/\b[a-f0-9]{32,}\b/gi, "[redacted]")
    .replace(/\b(secret|token|password|credential|authorization)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .slice(0, 200)
}

export async function npmLatest(runtime: Runtime, packageName: string, offline: boolean): Promise<VersionInfo> {
  const tags = await npmTags(runtime, packageName, offline)
  return { installed: null, latest: tags.latest ?? null, latestBeta: tags.beta ?? null, error: tags.error }
}

export async function npmTags(runtime: Runtime, packageName: string, offline: boolean): Promise<{ latest?: string | null; beta?: string | null; error?: string }> {
  if (offline) return { latest: null, beta: null, error: "Offline mode: registry not queried" }
  const result = await runtime.run("npm", ["view", packageName, "dist-tags", "--json"], { timeoutMs: 20_000 })
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

export async function githubLatest(runtime: Runtime, repo: string, offline: boolean, fetcher: typeof fetch = fetch): Promise<VersionInfo> {
  if (offline) return { installed: null, latest: null, error: "Offline mode: GitHub not queried" }
  try {
    const response = await fetcher(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "opencode-spotify-installer" },
      signal: AbortSignal.timeout(12_000),
    })
    if (!response.ok) return { installed: null, latest: null, error: `GitHub release metadata unavailable (HTTP ${response.status})` }
    const value: unknown = await response.json()
    if (!value || typeof value !== "object") return { installed: null, latest: null, error: "Invalid release metadata" }
    const tag = (value as { tag_name?: unknown }).tag_name
    return { installed: null, latest: typeof tag === "string" ? cleanVersion(tag) : null }
  } catch (error) {
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

export { cleanVersion }
