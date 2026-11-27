// OpenCode CLI inspection and global plugin management for the V0.6.0 installer.
//
// Read-only helpers (inspectOpenCode, parsePluginList) never modify anything.
// The add/remove/update helpers only invoke the native `opencode plugin`
// subcommands with argv arrays (never a shell string) and return the raw
// CommandResult so callers can verify the outcome with `plugin list`.
import type { CancelToken } from "./cancel.ts"
import type { CommandResult, ExecOptions, OpenCodeInfo, OpenCodePluginInfo, Runtime } from "./types.ts"
import { OPERATION_TIMEOUTS, sanitizeDetail } from "./runtime.ts"
import { join } from "node:path"
import { compareVersions } from "./compat.ts"

/** Plugin id registered in `opencode plugin list` and in package.json. */
export const PLUGIN_ID = "opencode-spotify"

export interface PluginListEntry {
  id: string
  version: string
  source: string
}

/**
 * Coarse owner of the OpenCode executable. The categories are deliberately
 * conservative: an executable that does not match a known layout is "unknown"
 * and must never be replaced or upgraded by this installer.
 */
export type OpenCodeInstallOwner = "official-script" | "legacy-project-script" | "package-manager" | "unknown"

/** Package manager that owns an executable, when it can be identified. */
export type OpenCodePackageManager = "npm" | "pnpm" | "yarn" | "bun" | "scoop" | "choco" | "winget" | "brew"

export interface OpenCodeExecutable {
  /** Path exactly as discovered (suitable for display and argv[0]). */
  path: string
  owner: OpenCodeInstallOwner
  manager: OpenCodePackageManager | null
  /** True when the executable was resolved from PATH (or an explicit which result). */
  onPath: boolean
}

/** Read-only executable inventory used by fresh-install detection. */
export interface OpenCodeInstallInspection {
  /** Primary executable first; PATH order wins, then known install locations. */
  executables: OpenCodeExecutable[]
  /** Additional distinct executables (potential duplicate installs). */
  duplicates: OpenCodeExecutable[]
  /** True when PATH lookup failed but a known install location was found. */
  rediscovered: boolean
  /** True when the primary executable has no recognized owner. */
  unknownOwner: boolean
}

/**
 * Owner of the plugin registration row. `official` is a native
 * `opencode plugin add` registry spec, `package-manager` is a package source,
 * `legacy-project` is a local path/checkout, and `unknown` is never replaced.
 */
export type PluginRegistrationOwner = "official" | "package-manager" | "legacy-project" | "unknown"

export interface OpenCodePluginInspection extends OpenCodePluginInfo {
  owner: PluginRegistrationOwner
  /** Additional rows with the same plugin id (duplicate registrations). */
  duplicates: PluginListEntry[]
}

export interface OpenCodeInspection extends OpenCodeInfo {
  install: OpenCodeInstallInspection
  plugin: OpenCodePluginInspection
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
  if (result.cancelled) {
    // Cancellation is not a timeout and never a reason to retry: the child was
    // stopped at the caller's request and the mutation outcome is unknown.
    merged.cancelled = true
    merged.error = result.error?.trim() ? result.error : "Cancelled"
    return merged
  }
  if (result.error) merged.error = result.error
  else if (result.timedOut) {
    merged.error = `opencode timed out; registration state is unknown until re-listed`
  } else if (result.code !== 0) {
    merged.error = firstNonEmptyLine(merged.stderr) ?? firstNonEmptyLine(merged.stdout) ?? `opencode exited with code ${result.code}`
  }
  return merged
}

/** Cancellation result: child code preserved, `cancelled` flag set, never retried. */
function cancelledResult(result?: CommandResult): CommandResult {
  return {
    code: result?.code ?? 1,
    stdout: result?.stdout ?? "",
    stderr: result?.stderr ?? "",
    error: "Cancelled",
    cancelled: true,
    ...(typeof result?.durationMs === "number" ? { durationMs: result.durationMs } : {}),
  }
}

function wasCancelled(result: CommandResult, cancel?: CancelToken): boolean {
  return result.cancelled === true || cancel?.requested === true
}

/** Shared options for read-only plugin queries that participate in cancel. */
export interface PluginQueryOptions {
  cancel?: CancelToken
}

/** Read-only queries accept either the options bag or a bare token. */
type PluginQuery = PluginQueryOptions | CancelToken

function queryOptions(value?: PluginQuery): PluginQueryOptions {
  if (!value) return {}
  return typeof (value as CancelToken).request === "function" ? { cancel: value as CancelToken } : (value as PluginQueryOptions)
}

/** Shared options for native plugin mutations. */
export interface PluginMutationOptions {
  cancel?: CancelToken
  /** Override argv[0]; remove prefers the resolved binary (D15) when absent. */
  bin?: string
  log?: (line: string) => void
}

/** Mutation exec options: cancellation plus explicit tree kill, never a shell. */
function mutationOptions(cancel?: CancelToken): ExecOptions {
  return {
    timeoutMs: OPERATION_TIMEOUTS.pluginMutation,
    killPolicy: "tree",
    ...(cancel ? { cancel } : {}),
  }
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
 * Owner of a `plugin list` row. Local path/checkout rows are legacy project
 * installs; registry/package-source rows are package-manager installs; an
 * id/version-only row is the native CLI's own registration. Anything else is
 * unknown and is never replaced by the installer.
 */
export function classifyPluginRegistration(entry: PluginListEntry): PluginRegistrationOwner {
  const version = (entry.version ?? "").trim().toLowerCase()
  const source = unquote(entry.source ?? "")
  if (version === "local" || isPathLikeSource(source) || /^(?:\.{1,2}[\\/]|file:)/i.test(source)) return "legacy-project"
  if (!source || PLACEHOLDER.has(source.toLowerCase())) {
    return version && !PLACEHOLDER.has(version) ? "official" : "unknown"
  }
  if (/^(?:npm|pnpm|yarn|bun|scoop|choco|winget|brew)$/i.test(source)) return "package-manager"
  if (/^(?:npm|pnpm|yarn|bun|github|git\+|https?):/i.test(source)) return "package-manager"
  const bare = source.replace(/^[a-z+]+:/i, "").replace(/^\/\//, "")
  if (bare === PLUGIN_ID || (bare.split("/").pop() ?? bare) === PLUGIN_ID) return "official"
  if (bare.startsWith(`${PLUGIN_ID}@`) && /^\d+\.\d+\.\d+/.test(bare.slice(PLUGIN_ID.length + 1))) return "official"
  return "unknown"
}

export interface RegistrationChangeGuard {
  allowed: boolean
  reason?: string
  /** A stable -> prerelease move needs an explicit channel choice, never auto. */
  requiresExplicitChannel?: boolean
}

function isPrerelease(version: string): boolean {
  return /^\d+\.\d+\.\d+-/.test(version.trim())
}

/**
 * Guard for replacing/removing a registration. Unknown ownership, local
 * checkouts, unknown inspection state, downgrades, and automatic stable ->
 * beta moves are all refused. Callers may pass an explicit channel migration
 * flag only when the user chose that channel.
 */
export function guardRegistrationReplacement(
  plugin: OpenCodeInfo["plugin"] & { owner?: PluginRegistrationOwner },
  targetVersion?: string | null,
  options: { allowChannelMigration?: boolean } = {},
): RegistrationChangeGuard {
  if (plugin.state === "unknown") {
    return { allowed: false, reason: "registration state is unknown; refusing to overwrite it" }
  }
  if (!plugin.registered && !plugin.version) {
    return { allowed: false, reason: "plugin is not registered" }
  }
  if (plugin.local || plugin.owner === "legacy-project") {
    return { allowed: false, reason: "local development registration is never replaced" }
  }
  const owner = plugin.owner ?? classifyPluginRegistration({
    id: PLUGIN_ID,
    version: plugin.version ?? "",
    source: plugin.source ?? "",
  })
  if (owner === "unknown") {
    return { allowed: false, reason: "registration owner is unknown; refusing to overwrite it" }
  }
  if (targetVersion === undefined || targetVersion === null) return { allowed: true }
  const current = (plugin.version ?? "").trim()
  const target = targetVersion.trim()
  if (!current || !target) {
    return { allowed: false, reason: "installed and target versions are required to compare" }
  }
  const compared = compareVersions(target, current)
  if (compared === null) {
    return { allowed: false, reason: "target version is not a comparable semantic version; refusing to replace" }
  }
  if (compared === -1) {
    return { allowed: false, reason: `refusing to downgrade ${current} -> ${target}` }
  }
  if (!isPrerelease(current) && isPrerelease(target) && !options.allowChannelMigration) {
    return {
      allowed: false,
      requiresExplicitChannel: true,
      reason: `stable ${current} is not auto-migrated to prerelease ${target}`,
    }
  }
  return { allowed: true }
}

/** Version component of an `id@x.y.z` spec; null when the row is local, bare, or unversioned. */
function specVersionOf(spec: string | null | undefined): string | null {
  if (!spec) return null
  const value = spec.trim()
  const at = value.lastIndexOf("@")
  if (at <= 0) return null
  const candidate = value.slice(at + 1).trim()
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(candidate) ? candidate : null
}

/**
 * Registry specs (`opencode-spotify@x.y.z`) observed in `plugin list` that do
 * not equal the target spec. When duplicate registrations exist, `plugin list`
 * keeps reporting the stale row and a re-add of the target is a no-op
 * ("already configured"), so callers remove every stale spec before/while
 * ensuring the target. Local/path/bare rows without a versioned spec are
 * never auto-removed.
 */
export function stalePluginSpecs(entries: PluginListEntry[], targetSpec: string): string[] {
  const target = (targetSpec ?? "").trim()
  if (!target) return []
  const seen = new Set<string>()
  const stale: string[] = []
  for (const entry of entries ?? []) {
    if (!entry || !isPluginId(entry.id)) continue
    const spec = deriveSpec(entry.id, entry.version, entry.source ?? "")
    if (!spec || specVersionOf(spec) === null) continue
    if (spec === target || seen.has(spec)) continue
    seen.add(spec)
    stale.push(spec)
  }
  return stale
}

/**
 * The configured spec already equals the expected version but `plugin list`
 * still reports an older resolved version: the OpenCode service has not
 * reloaded the registration (restart required), not a missing registration.
 * Version comparison only — never used to authorize a replacement.
 */
export function registrationReloadNeeded(
  plugin: Pick<OpenCodePluginInspection, "registered" | "local" | "version" | "spec">,
  expected: string,
): boolean {
  if (!plugin || !plugin.registered || plugin.local) return false
  const want = (expected ?? "").trim()
  if (!want) return false
  const spec = (plugin.spec ?? "").trim()
  if (!spec) return false
  const specVer = specVersionOf(spec)
  if (!specVer || compareVersions(specVer, want) !== 0) return false
  const listed = (plugin.version ?? "").trim()
  return !!listed && compareVersions(listed, want) === -1
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

/** Normalize an executable path for comparison only (case-insensitive on Windows). */
function comparablePath(runtime: Runtime, value: string): string {
  const clean = unquote(value).replace(/\\/g, "/").replace(/\/+$/, "")
  return runtime.platform === "win32" ? clean.toLowerCase() : clean
}

/** True when `child` is `parent` or lives beneath it. */
function isWithin(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}/`)
}

/**
 * Classify an OpenCode executable by layout. This is intentionally read-only
 * and heuristic:
 * - official-script: the official installer's per-user `~/.opencode/bin` tree
 * - legacy-project-script: a project-local checkout/node_modules binary
 * - package-manager: npm/pnpm/yarn/bun/scoop/choco/winget/brew locations
 * - unknown: anything else; callers must never overwrite an unknown owner
 */
export function classifyOpenCodeExecutable(
  runtime: Runtime,
  executablePath: string,
): { owner: OpenCodeInstallOwner; manager: OpenCodePackageManager | null } {
  const path = comparablePath(runtime, executablePath)
  const home = comparablePath(runtime, runtime.homedir)
  const cwd = comparablePath(runtime, runtime.cwd)

  if (isWithin(`${home}/.opencode`, path)) return { owner: "official-script", manager: null }
  if (isWithin(cwd, path)) return { owner: "legacy-project-script", manager: null }

  const managerPatterns: Array<[OpenCodePackageManager, RegExp]> = [
    ["scoop", /\/scoop\/(?:apps|shims)\//],
    ["choco", /\/chocolatey\//],
    ["winget", /\/microsoft\/winget\//],
    ["bun", /\/\.bun\/bin\//],
    ["pnpm", /\/appdata\/local\/pnpm\/|\/\.pnpm\/|\/pnpm\//],
    ["yarn", /\/appdata\/local\/yarn\/|\/\.yarn\/bin\//],
    ["npm", /\/appdata\/roaming\/npm\/|\/\.npm-global\/bin\//],
    ["brew", /\/opt\/homebrew\/|\/usr\/local\/cellar\/|\/home\/linuxbrew\//],
  ]
  for (const [manager, pattern] of managerPatterns) {
    if (pattern.test(path)) return { owner: "package-manager", manager }
  }
  return { owner: "unknown", manager: null }
}

/** PATH directories from the runtime environment (never the process global). */
export function openCodePathDirectories(runtime: Runtime): string[] {
  const raw = runtime.env.PATH ?? runtime.env.Path ?? ""
  const separator = runtime.platform === "win32" ? ";" : ":"
  return raw.split(separator).map((entry) => entry.trim()).filter(Boolean)
}

/** Known install locations that may not be on the inherited PATH yet. */
export function knownOpenCodeDirectories(runtime: Runtime): string[] {
  const env = runtime.env
  const home = runtime.homedir
  const directories = [join(home, ".opencode", "bin")]
  if (env.LOCALAPPDATA) {
    directories.push(
      join(env.LOCALAPPDATA, "Microsoft", "WinGet", "Links"),
      join(env.LOCALAPPDATA, "pnpm"),
      join(env.LOCALAPPDATA, "Yarn", "bin"),
    )
  }
  if (env.APPDATA) directories.push(join(env.APPDATA, "npm"))
  directories.push(join(home, ".bun", "bin"), join(home, "scoop", "shims"), join(home, ".local", "bin"))
  if (env.ProgramData) directories.push(join(env.ProgramData, "chocolatey", "bin"))
  if (runtime.platform !== "win32") directories.push("/usr/local/bin", "/opt/homebrew/bin")
  return directories
}

function executableNames(runtime: Runtime): string[] {
  return runtime.platform === "win32"
    ? ["opencode.exe", "opencode.cmd", "opencode.bat", "opencode"]
    : ["opencode"]
}

function filePresent(runtime: Runtime, path: string): boolean {
  try {
    return runtime.exists(path) && runtime.isFile(path)
  } catch {
    return false
  }
}

/**
 * Read-only executable discovery. A fresh install often updates PATH only for
 * new processes, so a failed `which` must not be reported as "not installed":
 * known per-user and package-manager locations are probed as well. PATH order
 * is preserved; the first executable is the one OpenCode would actually use.
 */
export async function discoverOpenCodeExecutables(
  runtime: Runtime,
  options: { preferred?: string | null } = {},
): Promise<OpenCodeInstallInspection> {
  let preferred = options.preferred
  if (preferred === undefined) {
    try {
      preferred = (await runtime.which("opencode")) ?? null
    } catch {
      preferred = null
    }
  }

  const executables: OpenCodeExecutable[] = []
  const add = (path: string, onPath: boolean, trusted = false): void => {
    const key = comparablePath(runtime, path)
    if (!key) return
    const existing = executables.find((entry) => comparablePath(runtime, entry.path) === key)
    if (existing) {
      if (onPath) existing.onPath = true
      return
    }
    if (!trusted && !filePresent(runtime, path)) return
    const { owner, manager } = classifyOpenCodeExecutable(runtime, path)
    executables.push({ path, owner, manager, onPath })
  }

  // A successful `which` is authoritative even in a fake/partial runtime.
  if (preferred) add(preferred, true, true)
  for (const directory of openCodePathDirectories(runtime)) {
    for (const name of executableNames(runtime)) add(join(directory, name), true)
  }
  for (const directory of knownOpenCodeDirectories(runtime)) {
    for (const name of executableNames(runtime)) add(join(directory, name), false)
  }
  for (const name of executableNames(runtime)) add(join(runtime.cwd, "node_modules", ".bin", name), false)

  const primary = executables[0]
  return {
    executables,
    duplicates: executables.slice(1),
    rediscovered: !preferred && executables.length > 0,
    unknownOwner: primary ? primary.owner === "unknown" : false,
  }
}

/**
 * Resolve the argv[0] to use for an inspection/mutation. A PATH hit keeps the
 * short name (so Windows shim resolution still applies); a rediscovered
 * absolute path is used directly because the inherited PATH is stale.
 */
export async function resolveOpenCodeBinary(runtime: Runtime): Promise<string> {
  const install = await discoverOpenCodeExecutables(runtime)
  const primary = install.executables[0]
  return primary ? (primary.onPath ? "opencode" : primary.path) : "opencode"
}

/**
 * Run `opencode plugin list` from `cwd` (argv array, no shell) and parse the
 * rows. Returns [] when the command fails; never throws for command errors.
 *
 * B08: the native list can time out on a busy machine. Callers that need to
 * distinguish "absent" from "unknown" should use listPluginsDetailed.
 */
export async function listPlugins(runtime: Runtime, cwd?: string, bin = "opencode"): Promise<PluginListEntry[]> {
  const result = await runtime.run(
    bin,
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
  bin = "opencode",
  options: PluginQuery = {},
): Promise<{ entries: PluginListEntry[]; outcome: PluginListOutcome; detail?: string }> {
  const query = queryOptions(options)
  // Boundary check before spawning: a cancelled operation runs nothing new.
  if (query.cancel?.requested) return { entries: [], outcome: "failed", detail: "Cancelled" }
  const result = await runtime.run(
    bin,
    ["plugin", "list"],
    {
      ...(cwd === undefined ? {} : { cwd }),
      timeoutMs: OPERATION_TIMEOUTS.pluginList,
      killPolicy: "tree",
      ...(query.cancel ? { cancel: query.cancel } : {}),
    },
  )
  if (wasCancelled(result, query.cancel)) return { entries: [], outcome: "failed", detail: "Cancelled" }
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
  bin?: string,
  options: PluginQuery = {},
): Promise<{ state: RegistrationState; match: PluginListEntry | undefined; outcome: PluginListOutcome; detail?: string }> {
  const query = queryOptions(options)
  // Read-only reconciliation still honors a cancellation boundary.
  if (query.cancel?.requested) return { state: "unknown", match: undefined, outcome: "failed", detail: "Cancelled" }
  const executable = bin ?? (await resolveOpenCodeBinary(runtime))
  if (query.cancel?.requested) return { state: "unknown", match: undefined, outcome: "failed", detail: "Cancelled" }
  const listed = await listPluginsDetailed(runtime, neutralCwd(runtime), executable, query)
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

function emptyPlugin(): OpenCodePluginInspection {
  return { registered: false, version: null, source: null, local: false, spec: null, state: "absent", owner: "unknown", duplicates: [] }
}

function unknownPlugin(): OpenCodePluginInspection {
  return { registered: false, version: null, source: null, local: false, spec: null, state: "unknown", owner: "unknown", duplicates: [] }
}

function missing(reason: string, install: OpenCodeInstallInspection): OpenCodeInspection {
  return {
    available: false,
    path: null,
    version: null,
    configPath: null,
    configExists: false,
    plugin: emptyPlugin(),
    nativeCommands: false,
    error: reason,
    install,
  }
}

function expandHome(runtime: Runtime, value: string): string {
  const text = unquote(value)
  if (text === "~") return runtime.homedir
  if (/^~[\\/]/.test(text)) return join(runtime.homedir, text.slice(2))
  return text
}

/** Resolve opencode.json / opencode.jsonc inside a config directory. */
function configInDirectory(runtime: Runtime, directory: string): { path: string; exists: boolean } {
  const json = join(directory, "opencode.json")
  const jsonc = join(directory, "opencode.jsonc")
  try {
    if (runtime.exists(json)) return { path: json, exists: runtime.isFile(json) }
    if (runtime.exists(jsonc)) return { path: jsonc, exists: runtime.isFile(jsonc) }
  } catch {
    // Fall through to the conventional default.
  }
  return { path: json, exists: false }
}

/**
 * Config discovery fallback for fresh installs where `debug paths config`
 * fails or prints nothing. Only the standard user config locations are
 * probed; no file is created or read.
 */
function discoverConfigFallback(runtime: Runtime): { path: string | null; exists: boolean } {
  const candidates: string[] = []
  if (runtime.env.XDG_CONFIG_HOME) candidates.push(join(runtime.env.XDG_CONFIG_HOME, "opencode"))
  candidates.push(join(runtime.homedir, ".config", "opencode"))
  if (runtime.env.APPDATA) candidates.push(join(runtime.env.APPDATA, "opencode"))
  for (const directory of candidates) {
    try {
      if (runtime.exists(directory) && !runtime.isFile(directory)) return configInDirectory(runtime, directory)
      const direct = join(directory, "opencode.json")
      if (runtime.exists(direct)) return { path: direct, exists: runtime.isFile(direct) }
    } catch {
      // Keep probing; a failed existence check is not proof of absence.
    }
  }
  return { path: null, exists: false }
}

function resolveConfigCandidate(runtime: Runtime, raw: string): { path: string; exists: boolean } {
  const clean = expandHome(runtime, raw)
  try {
    if (runtime.exists(clean) && !runtime.isFile(clean)) {
      // `debug paths config` prints the config directory in current builds.
      return configInDirectory(runtime, clean)
    }
    return { path: clean, exists: runtime.isFile(clean) }
  } catch {
    return { path: clean, exists: false }
  }
}

/**
 * Inspect the OpenCode CLI without changing anything: binary location,
 * version, config path (first stdout line of `opencode debug paths config`,
 * with a standard-location fallback), plugin registration from
 * `opencode plugin list`, and whether the native `plugin add/remove`
 * subcommands exist (`opencode plugin --help`). The list runs from
 * neutralCwd(runtime) so project plugins are excluded.
 *
 * B08: fresh installs may not be visible to this process yet, so a failed
 * `which` falls back to known install locations. A failed `plugin list` stays
 * "unknown"; it is never reported as "absent".
 */
export async function inspectOpenCode(runtime: Runtime): Promise<OpenCodeInspection> {
  let whichPath: string | undefined
  try {
    whichPath = await runtime.which("opencode")
  } catch {
    whichPath = undefined
  }
  const install = await discoverOpenCodeExecutables(runtime, { preferred: whichPath ?? null })
  const primary = install.executables[0]
  if (!primary) return missing("opencode not found on PATH or in known install locations", install)

  const path = primary.path
  const bin = primary.onPath ? "opencode" : primary.path

  const listCwd = neutralCwd(runtime)
  // Startup lag: the four read-only probes are independent, so they run
  // concurrently instead of sequentially (four timeout budgets back to back).
  const [versionResult, configResult, listedResult, helpResult] = await Promise.all([
    runtime.run(bin, ["--version"], { timeoutMs: OPERATION_TIMEOUTS.inspection }).catch(() => null),
    runtime.run(bin, ["debug", "paths", "config"], { timeoutMs: OPERATION_TIMEOUTS.inspection }).catch(() => null),
    listPluginsDetailed(runtime, listCwd, bin).catch(
      (): { entries: PluginListEntry[]; outcome: PluginListOutcome; detail?: string } => ({
        entries: [],
        outcome: "failed",
        detail: "plugin list did not complete",
      }),
    ),
    runtime.run(bin, ["plugin", "--help"], { timeoutMs: OPERATION_TIMEOUTS.inspection }).catch(() => null),
  ])

  const version = versionResult
    ? extractVersion(`${versionResult.stdout ?? ""}\n${versionResult.stderr ?? ""}`)
    : null

  let configPath: string | null = null
  let configExists = false
  let configResolved = false
  const candidate = configResult ? firstNonEmptyLine(configResult.stdout) : null
  if (candidate) {
    const resolved = resolveConfigCandidate(runtime, candidate)
    configPath = resolved.path
    configExists = resolved.exists
    configResolved = true
  }
  if (!configResolved) {
    const fallback = discoverConfigFallback(runtime)
    configPath = fallback.path
    configExists = fallback.exists
  }

  // List from the neutral directory so project-local plugins resolved from
  // the caller's cwd are not mistaken for the global registration.
  // B08: a timeout/failed list is "unknown", never proof of "absent".
  let plugin = emptyPlugin()
  if (listedResult.outcome !== "ok") {
    plugin = { ...unknownPlugin(), detail: listedResult.detail }
  } else {
    const matches = listedResult.entries.filter((entry) => isPluginId(entry.id))
    const match = matches[0]
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
        owner: classifyPluginRegistration(match),
        duplicates: matches.slice(1),
      }
    } else {
      plugin = { ...emptyPlugin(), state: "absent" }
    }
  }

  let nativeCommands = false
  if (helpResult) {
    const help = `${helpResult.stdout ?? ""}\n${helpResult.stderr ?? ""}`
    nativeCommands = /\badd\b/i.test(help) && /\bremove\b/i.test(help)
  }

  return { available: true, path, version, configPath, configExists, plugin, nativeCommands, install }
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
 *
 * Cancellation kills the owned child tree and returns `cancelled: true` with
 * the child's code. The mutation is never retried or rolled back here: a
 * partially applied registration must be re-listed by the caller.
 */
export async function addGlobalPlugin(
  runtime: Runtime,
  spec: string,
  opts: PluginMutationOptions = {},
): Promise<CommandResult> {
  const target = requireSpec(spec)
  if (!target) return { code: 1, stdout: "", stderr: "", error: "plugin spec is required" }
  if (opts.cancel?.requested) return cancelledResult()
  const bin = opts.bin ?? "opencode"
  const result = await runtime.run(bin, ["plugin", "add", target], mutationOptions(opts.cancel))
  if (opts.log) {
    emitLines(opts.log, result.stdout)
    emitLines(opts.log, result.stderr)
  }
  return wasCancelled(result, opts.cancel) ? cancelledResult(result) : finalize(result)
}

/**
 * Remove a global plugin via the native `opencode plugin remove <spec>`.
 * D15: without an explicit binary, the resolved executable is used because a
 * freshly installed OpenCode may only exist in a known (not yet PATH) location.
 */
export async function removeGlobalPlugin(
  runtime: Runtime,
  spec: string,
  opts: PluginMutationOptions = {},
): Promise<CommandResult> {
  const target = requireSpec(spec)
  if (!target) return { code: 1, stdout: "", stderr: "", error: "plugin spec is required" }
  if (opts.cancel?.requested) return cancelledResult()
  const bin = opts.bin ?? (await resolveOpenCodeBinary(runtime))
  if (opts.cancel?.requested) return cancelledResult()
  const result = await runtime.run(bin, ["plugin", "remove", target], mutationOptions(opts.cancel))
  return wasCancelled(result, opts.cancel) ? cancelledResult(result) : finalize(result)
}

/**
 * Update a global plugin (or every plugin when no target is given) via the
 * native `opencode plugin update [target]`.
 */
export async function updateGlobalPlugin(
  runtime: Runtime,
  target?: string,
  opts: PluginMutationOptions = {},
): Promise<CommandResult> {
  const name = (target ?? "").trim()
  const args = name ? ["plugin", "update", name] : ["plugin", "update"]
  if (opts.cancel?.requested) return cancelledResult()
  const bin = opts.bin ?? "opencode"
  const result = await runtime.run(bin, args, mutationOptions(opts.cancel))
  return wasCancelled(result, opts.cancel) ? cancelledResult(result) : finalize(result)
}
