// OpenCode CLI inspection and global plugin management for the V0.6.0 installer.
//
// Read-only helpers (inspectOpenCode, parsePluginList) never modify anything.
// The add/remove/update helpers only invoke the native `opencode plugin`
// subcommands with argv arrays (never a shell string) and return the raw
// CommandResult so callers can verify the outcome with `plugin list`.
import type { CommandResult, OpenCodeInfo, Runtime } from "./types.ts"
import { OPERATION_TIMEOUTS, sanitizeDetail } from "./runtime.ts"
import { join } from "node:path"

/** Plugin id registered in `opencode plugin list` and in package.json. */
export const PLUGIN_ID = "opencode-spotify"

export interface PluginListEntry {
  id: string
  version: string
  source: string
}

const PLACEHOLDER = new Set(["", "-", "unknown", "(unknown)", "n/a"])

function unquote(value: string): string {
  const text = value.trim()
  if (text.length >= 2) {
    const first = text[0]
    const last = text[text.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return text.slice(1, -1).trim()
  }
  return text
}

function firstNonEmptyLine(output: string | null | undefined): string | null {
  if (!output) return null
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed) return trimmed
  }
  return null
}

/** Keep both child streams in the returned result; surface a usable error on failure. */
function finalize(result: CommandResult): CommandResult {
  const merged: CommandResult = {
    code: result.code,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ...(result.timedOut ? { timedOut: true as const } : {}),
    ...(typeof result.durationMs === "number" ? { durationMs: result.durationMs } : {}),
  }
  if (result.error) merged.error = result.error
  else if (result.timedOut) {
    merged.error = `opencode timed out; registration state is unknown until re-listed`
  } else if (result.code !== 0) {
    merged.error = firstNonEmptyLine(merged.stderr) ?? firstNonEmptyLine(merged.stdout) ?? `opencode exited with code ${result.code}`
  }
  return merged
}

/** First semver token in free-form `--version` output (e.g. "opencode 1.2.3"). */
function extractVersion(output: string): string | null {
  const match = (output ?? "").match(/(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]*)?)/)
  return match ? match[1]! : null
}

function stripTableBorders(raw: string): string {
  return raw.replace(/[│┃║|]/g, " ")
}

function isNoiseLine(line: string): boolean {
  if (/^[\s\-─═━═+·.]*$/.test(line)) return true
  if (/:\s*$/.test(line)) return true
  if (/^(id|name|plugin)\s+(version|ver)\b/i.test(line)) return true
  if (/^no\s+plugins?\b/i.test(line)) return true
  if (/^\(no\s+plugins?.*\)$/i.test(line)) return true
  return false
}

/**
 * Parse `opencode plugin list` output tolerantly. Each row is
 * `ID VERSION SOURCE` where SOURCE may contain spaces; header, separator,
 * and "no plugins" lines are ignored. A row whose source wraps onto the next
 * indented line is rejoined with that continuation line.
 */
export function parsePluginList(output: string): PluginListEntry[] {
  const entries: PluginListEntry[] = []
  for (const raw of (output ?? "").split(/\r?\n/)) {
    if (!raw.trim()) continue
    const line = stripTableBorders(raw).trim().replace(/^[•*\-–—]\s+/, "").trim()
    if (!line || isNoiseLine(line)) continue
    const row = line.match(/^(\S+)\s+(\S+)(?:\s+(.+))?$/)
    if (row) {
      entries.push({ id: row[1]!, version: row[2]!, source: (row[3] ?? "").trim() })
      continue
    }
    // Wrapped continuation: an indented single-token line belongs to the
    // previous row's source (long paths/URLs the CLI wrapped for display).
    const previous = entries[entries.length - 1]
    if (previous && /^\s/.test(raw)) {
      if (!previous.source) previous.source = line
      else if (!/\s/.test(previous.source) && !/\s/.test(line)) previous.source += line
      else if (/[/\\:._\-#@?&=+]$/.test(previous.source) || /^[/\\.:#@?&=+\-]/.test(line)) previous.source += line
      else previous.source += ` ${line}`
    }
  }
  return entries
}

/** True for this plugin's id, including scoped package names and @version suffixes. */
function isPluginId(id: string): boolean {
  const value = unquote(id).replace(/@\d+\.\d+\.\d+.*$/, "")
  if (value === PLUGIN_ID) return true
  return (value.split("/").pop() ?? value) === PLUGIN_ID
}

/** True when the source looks like a filesystem path or directory. */
export function isPathLikeSource(source: string): boolean {
  const value = unquote(source)
  if (!value || PLACEHOLDER.has(value.toLowerCase())) return false
  if (/^(?:\.{1,2}[\\/]|[\\/]|[A-Za-z]:[\\/]|~[\\/]|file:)/.test(value)) return true
  return /[\\/]/.test(value) && !/:/.test(value) && !value.startsWith("@")
}

function deriveSpec(id: string, version: string, source: string): string | null {
  const clean = unquote(source)
  const usableSource = clean && !PLACEHOLDER.has(clean.toLowerCase()) &&
    (isPathLikeSource(clean) || clean.startsWith("@") || clean.includes("@") || clean.startsWith("github:") || clean.startsWith("git+") || clean.startsWith("file:"))
  if (usableSource) return clean
  const tag = (version ?? "").trim()
  if (tag && !PLACEHOLDER.has(tag.toLowerCase()) && tag.toLowerCase() !== "local") return `${id}@${tag}`
  return null
}

/**
 * Neutral working directory for global plugin queries. `opencode plugin list`
 * resolves project plugins from the cwd, so listing from the caller's project
 * directory would report a project-local checkout as registered. TEMP/TMP fall
 * back to the home directory; the first existing candidate wins.
 */
export function neutralCwd(runtime: Runtime): string {
  const candidates = [runtime.env.TEMP, runtime.env.TMP, runtime.homedir]
  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      if (runtime.exists(candidate)) return candidate
    } catch {
      // Treat existence-probe failures as "not usable" and keep looking.
    }
  }
  return runtime.homedir
}

/**
 * Run `opencode plugin list` from `cwd` (argv array, no shell) and parse the
 * rows. Returns [] when the command fails; never throws for command errors.
 *
 * B08: the native list can time out on a busy machine. Callers that need to
 * distinguish "absent" from "unknown" should use listPluginsDetailed.
 */
export async function listPlugins(runtime: Runtime, cwd?: string): Promise<PluginListEntry[]> {
  const result = await runtime.run(
    "opencode",
    ["plugin", "list"],
    cwd === undefined ? { timeoutMs: OPERATION_TIMEOUTS.pluginList } : { cwd, timeoutMs: OPERATION_TIMEOUTS.pluginList },
  )
  if (result.code !== 0) return []
  return parsePluginList(result.stdout ?? "")
}

export type PluginListOutcome = "ok" | "timeout" | "failed"

/**
 * Detailed list result (B01/B08): preserves timeout status so a failed
 * inspection is never mistaken for proof the plugin is absent.
 */
export async function listPluginsDetailed(
  runtime: Runtime,
  cwd?: string,
): Promise<{ entries: PluginListEntry[]; outcome: PluginListOutcome; detail?: string }> {
  const result = await runtime.run(
    "opencode",
    ["plugin", "list"],
    cwd === undefined ? { timeoutMs: OPERATION_TIMEOUTS.pluginList } : { cwd, timeoutMs: OPERATION_TIMEOUTS.pluginList },
  )
  if (result.code === 0) return { entries: parsePluginList(result.stdout ?? ""), outcome: "ok" }
  if (result.timedOut) return { entries: [], outcome: "timeout", detail: sanitizeDetail(result.error ?? "plugin list timed out") }
  const detail = result.error ?? result.stderr.split(/\r?\n/).find((line) => line.trim()) ?? `exit code ${result.code}`
  return { entries: [], outcome: "failed", detail: sanitizeDetail(detail).slice(0, 200) }
}

/** Registration tri-state (B08): absent vs verified-absent vs unknown. */
export type RegistrationState = "registered" | "absent" | "unknown"

/**
 * Reconcile the observed system state after a mutation reported failure or
 * timed out (B01). Never blindly retries: a timed-out `plugin add` may have
 * completed server-side, so the caller must check the list before deciding.
 *
 * Returns the observed registration state plus whether the expected spec (or
 * plugin id) is present.
 */
export async function reconcileRegistration(
  runtime: Runtime,
  expectedId: string = PLUGIN_ID,
): Promise<{ state: RegistrationState; match: PluginListEntry | undefined; outcome: PluginListOutcome; detail?: string }> {
  const listed = await listPluginsDetailed(runtime, neutralCwd(runtime))
  if (listed.outcome !== "ok") return { state: "unknown", match: undefined, outcome: listed.outcome, detail: listed.detail }
  const wanted = expectedId.trim().replace(/@\d+\.\d+\.\d+.*$/, "") || PLUGIN_ID
  const match = listed.entries.find((entry) => {
    const value = entry.id.replace(/@\d+\.\d+\.\d+.*$/, "")
    if (value === wanted) return true
    return (value.split("/").pop() ?? value) === (wanted.split("/").pop() ?? wanted)
  })
  return { state: match ? "registered" : "absent", match, outcome: "ok" }
}

/**
 * Project-aware plugin list: runs `opencode plugin list` from runtime.cwd so
 * project-configured plugins are included. Setup uses this to warn when a
 * local-path `opencode-spotify` shadows the global install (never edited
 * here). Returns [] when opencode is missing or the list fails.
 */
export async function projectPlugins(runtime: Runtime): Promise<PluginListEntry[]> {
  let bin: string | undefined
  try {
    bin = await runtime.which("opencode")
  } catch {
    bin = undefined
  }
  if (!bin) return []
  try {
    return await listPlugins(runtime, runtime.cwd)
  } catch {
    return []
  }
}

function emptyPlugin(): OpenCodeInfo["plugin"] {
  return { registered: false, version: null, source: null, local: false, spec: null, state: "absent" }
}

function unknownPlugin(): OpenCodeInfo["plugin"] {
  return { registered: false, version: null, source: null, local: false, spec: null, state: "unknown" }
}

function missing(reason: string): OpenCodeInfo {
  return {
    available: false,
    path: null,
    version: null,
    configPath: null,
    configExists: false,
    plugin: emptyPlugin(),
    nativeCommands: false,
    error: reason,
  }
}

/**
 * Inspect the OpenCode CLI without changing anything: binary location,
 * version, config path (first stdout line of `opencode debug paths config`),
 * plugin registration from `opencode plugin list`, and whether the native
 * `plugin add/remove` subcommands exist (`opencode plugin --help`). The list
 * runs from neutralCwd(runtime) so project plugins are excluded.
 */
export async function inspectOpenCode(runtime: Runtime): Promise<OpenCodeInfo> {
  let path: string | undefined
  try {
    path = await runtime.which("opencode")
  } catch {
    path = undefined
  }
  if (!path) return missing("opencode not found on PATH")

  let version: string | null = null
  try {
    const result = await runtime.run("opencode", ["--version"], { timeoutMs: OPERATION_TIMEOUTS.inspection })
    version = extractVersion(`${result.stdout ?? ""}\n${result.stderr ?? ""}`)
  } catch {
    version = null
  }

  let configPath: string | null = null
  let configExists = false
  try {
    const result = await runtime.run("opencode", ["debug", "paths", "config"], { timeoutMs: OPERATION_TIMEOUTS.inspection })
    const candidate = firstNonEmptyLine(result.stdout)
    if (candidate) {
      const clean = unquote(candidate)
      try {
        if (runtime.exists(clean) && !runtime.isFile(clean)) {
          // `debug paths config` prints the config directory in current builds.
          const json = join(clean, "opencode.json")
          const jsonc = join(clean, "opencode.jsonc")
          configPath = runtime.exists(json) ? json : runtime.exists(jsonc) ? jsonc : json
          configExists = runtime.isFile(configPath)
        } else {
          configPath = clean
          configExists = runtime.isFile(clean)
        }
      } catch {
        configPath = clean
        configExists = false
      }
    }
  } catch {
    configPath = null
    configExists = false
  }

  let plugin = emptyPlugin()
  try {
    // List from a neutral directory so project-local plugins resolved from
    // the caller's cwd are not mistaken for the global registration.
    // B08: a timeout/failed list is "unknown", never proof of "absent".
    const listed = await listPluginsDetailed(runtime, neutralCwd(runtime))
    if (listed.outcome !== "ok") {
      plugin = { ...unknownPlugin(), detail: listed.detail }
    } else {
      const match = listed.entries.find((entry) => isPluginId(entry.id))
      if (match) {
        const source = match.source.trim() ? unquote(match.source) : ""
        const local = match.version.trim().toLowerCase() === "local" || isPathLikeSource(source)
        plugin = {
          registered: true,
          version: match.version.trim() || null,
          source: source || null,
          local,
          spec: deriveSpec(match.id, match.version, source),
          state: "registered",
        }
      } else {
        plugin = { ...emptyPlugin(), state: "absent" }
      }
    }
  } catch {
    plugin = unknownPlugin()
  }

  let nativeCommands = false
  try {
    const result = await runtime.run("opencode", ["plugin", "--help"], { timeoutMs: OPERATION_TIMEOUTS.inspection })
    const help = `${result.stdout ?? ""}\n${result.stderr ?? ""}`
    nativeCommands = /\badd\b/i.test(help) && /\bremove\b/i.test(help)
  } catch {
    nativeCommands = false
  }

  return { available: true, path, version, configPath, configExists, plugin, nativeCommands }
}

function emitLines(log: (line: string) => void, output: string | null | undefined): void {
  if (!output) return
  for (const line of output.split(/\r?\n/)) {
    if (line.trim()) log(sanitizeDetail(line))
  }
}

function requireSpec(spec: string): string | null {
  const target = (spec ?? "").trim()
  if (!target || target.startsWith("-")) return null
  return target
}

/**
 * Register a global plugin via the native `opencode plugin add <spec>`.
 * Returns the raw result (never guessed); callers verify with `plugin list`.
 */
export async function addGlobalPlugin(
  runtime: Runtime,
  spec: string,
  opts?: { log?: (line: string) => void },
): Promise<CommandResult> {
  const target = requireSpec(spec)
  if (!target) return { code: 1, stdout: "", stderr: "", error: "plugin spec is required" }
  const result = await runtime.run("opencode", ["plugin", "add", target], { timeoutMs: OPERATION_TIMEOUTS.pluginMutation })
  if (opts?.log) {
    emitLines(opts.log, result.stdout)
    emitLines(opts.log, result.stderr)
  }
  return finalize(result)
}

/** Remove a global plugin via the native `opencode plugin remove <spec>`. */
export async function removeGlobalPlugin(runtime: Runtime, spec: string): Promise<CommandResult> {
  const target = requireSpec(spec)
  if (!target) return { code: 1, stdout: "", stderr: "", error: "plugin spec is required" }
  const result = await runtime.run("opencode", ["plugin", "remove", target], { timeoutMs: OPERATION_TIMEOUTS.pluginMutation })
  return finalize(result)
}

/**
 * Update a global plugin (or every plugin when no target is given) via the
 * native `opencode plugin update [target]`.
 */
export async function updateGlobalPlugin(runtime: Runtime, target?: string): Promise<CommandResult> {
  const name = (target ?? "").trim()
  const args = name ? ["plugin", "update", name] : ["plugin", "update"]
  const result = await runtime.run("opencode", args, { timeoutMs: OPERATION_TIMEOUTS.pluginMutation })
  return finalize(result)
}
