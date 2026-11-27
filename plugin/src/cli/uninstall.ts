// Uninstall workflow (B09, spec §11).
//
// Two explicit modes:
//   * plugin-only (default): remove the global registration, the owned bridge
//     extension and its Spicetify registration, and (only when separately
//     confirmed) the owned credentials. Spicetify, Spotify, other extensions,
//     OpenCode, project/repo configuration and shared caches are preserved.
//   * complete permanent removal: the same, plus the owned credentials and an
//     owner-compatible removal of Spicetify itself (program, validated
//     spicetify-owned directories, exact justified PATH entries, config,
//     Marketplace, themes and extensions). Spotify is restored BEFORE any
//     Spicetify deletion; if the restore fails or is uncertain, nothing is
//     deleted. No new recovery backup is ever created.
//
// Safety invariants:
//   * complete removal requires the typed phrase UNINSTALL interactively, or
//     --complete / OPENCODE_SPOTIFY_UNINSTALL=complete plus --non-interactive
//     and --yes noninteractively;
//   * destructive selection is never the default; cancel/back never mutates;
//   * manager-owned binaries are removed only through their owner manager;
//     unknown ownership is disclosed with manual steps instead of deletion;
//   * directory removals are limited to canonical spicetify-owned paths and
//     refuse symlinks/junctions or paths that resolve outside those roots;
//   * unrelated PATH entries, Spotify data and OpenCode data are preserved;
//   * when the Spicetify program is already absent no restore can run, so the
//     validated backup payload (the only recovery path) is preserved instead
//     of being deleted with config/local data;
//   * partial failures are reported honestly and retries are idempotent.
//
// F5 adds cooperative cancellation: restore-spotify and owner-manager package
// removals are "protected" (they finish and verify, then the workflow stops
// before the next deletion); registration/credential/directory/PATH steps are
// boundary-checked. Children are never killed mid-restore/apply/backup.
import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs"
import { basename, dirname, join, win32 } from "node:path"
import { OperationCancelled, isCancellation } from "./cancel.ts"
import { BRIDGE_FILE, bridgeConfigDir, bridgeConfigPath, bridgeOperation, removeCredentials } from "./bridge.ts"
import { reconcileRegistration, removeGlobalPlugin, resolveOpenCodeBinary } from "./opencode.ts"
import { executePlan, planReporter } from "./plan.ts"
import { OPERATION_TIMEOUTS, sanitizeDetail } from "./runtime.ts"
import {
  SPICETIFY_BACKUP_SIZE_RANGE,
  SPICETIFY_WINGET_ID,
  captureSpotifyAppFiles,
  inspectBackupStateDetailed,
  spicetifyBackupCandidates,
  spotifyInstallDir,
  verifySpotifyRestoreApplied,
  type SpotifyAppSnapshot,
} from "./spicetify.ts"
import { PLAN_MESSAGES } from "./state.ts"
import {
  buildUninstallScope,
  confirmCompleteRemoval,
  inventoryFromDetection,
  remainingComponents,
  renderUninstallExit,
  renderUninstallResult,
  renderUninstallScope,
  selectUninstallMode,
  type UninstallComponentResult,
  type UninstallComponentStatus,
  type UninstallInventory,
  type UninstallMode,
  type UninstallScope,
} from "./ui/uninstall-view.ts"
import type {
  CommandResult,
  Detection,
  OperationContext,
  PlanStep,
  Runtime,
  SpicetifyInfo,
} from "./types.ts"

export interface RestoreVerification {
  ok: boolean
  detail?: string
}

export interface RestoreVerificationInput {
  runtime: Runtime
  detection: Detection
  layout: SpicetifyLayout
  /** Size of the validated backup xpui.spa, used to compare the restored file. */
  backupXpuiSize: number
  /** Size of the validated backup login.spa when known. */
  backupLoginSize?: number | null
  fileSize: (path: string) => number | null
  /** Spotify app-bundle snapshot taken immediately before `spicetify restore`. */
  before?: SpotifyAppSnapshot
}

export interface UninstallDeps {
  /** Symlink/junction inspection. Defaults to lstat + realpath on disk. */
  pathInfo?: (path: string) => { symlink: boolean; realPath: string | null }
  /** Removal primitive. Defaults to runtime.remove (recursive, force). */
  removePath?: (path: string) => void
  /** File size probe used to validate backups and verify a restore. */
  fileSize?: (path: string) => number | null
  /** Spotify app-file snapshot used for post-restore verification. */
  captureApps?: (runtime: Runtime, spicetify: SpicetifyInfo) => SpotifyAppSnapshot
  /** Post-restore verification; defaults to the shared Spotify app-file check. */
  verifyRestore?: (input: RestoreVerificationInput) => Promise<RestoreVerification>
}

function defaultPathInfo(path: string): { symlink: boolean; realPath: string | null } {
  try {
    const stats = lstatSync(path)
    let realPath: string | null = null
    try {
      realPath = realpathSync.native(path)
    } catch {
      try {
        realPath = realpathSync(path)
      } catch {
        realPath = null
      }
    }
    return { symlink: stats.isSymbolicLink(), realPath }
  } catch {
    // Missing paths (and fake runtimes) are not symlinks; callers check
    // runtime.exists before removing.
    return { symlink: false, realPath: null }
  }
}

function defaultFileSize(path: string): number | null {
  try {
    const stats = statSync(path)
    return stats.isFile() ? stats.size : null
  } catch {
    return null
  }
}

function resolveDeps(runtime: Runtime, deps: UninstallDeps = {}): Required<UninstallDeps> {
  return {
    pathInfo: deps.pathInfo ?? defaultPathInfo,
    removePath: deps.removePath ?? ((path: string) => runtime.remove(path)),
    fileSize: deps.fileSize ?? defaultFileSize,
    captureApps: deps.captureApps ?? ((runtime, spicetify) => captureSpotifyAppFiles(runtime, spicetify)),
    verifyRestore: deps.verifyRestore ?? defaultVerifyRestore,
  }
}

// ---------------------------------------------------------------------------
// Boundary-safe path handling
// ---------------------------------------------------------------------------

/** Canonical comparison form: resolved, no trailing separator, lower-case. */
export function canonicalPath(path: string): string {
  const resolved = win32.resolve(path.trim())
  const trimmed = resolved.replace(/[\\/]+$/, "")
  return (trimmed || resolved).toLowerCase()
}

/** True when `target` is `base` or nested under it (no traversal). */
export function isWithinBoundary(base: string, target: string): boolean {
  const b = canonicalPath(base)
  const t = canonicalPath(target)
  return t === b || t.startsWith(`${b}\\`)
}

/**
 * Validate a removal target against the canonical roots the caller computed.
 * Returns null when safe, otherwise a refusal reason. Never reads arbitrary
 * config-provided paths: callers pass only canonical roots.
 */
export function pathRemovalProblem(
  target: string,
  allowedRoots: string[],
  info: { symlink: boolean; realPath: string | null },
): string | null {
  const canonicalTarget = canonicalPath(target)
  const roots = allowedRoots.map(canonicalPath)
  if (!roots.includes(canonicalTarget)) {
    return "refusing a path outside the Spicetify-owned locations"
  }
  if (info.symlink) return "refusing a symbolic link or junction"
  if (info.realPath) {
    const real = canonicalPath(info.realPath)
    if (!roots.includes(real)) return "refusing a path that resolves outside the Spicetify-owned locations"
  }
  return null
}

export interface SpicetifyLayout {
  localBase: string
  roamingBase: string
  /** Canonical program/local-data root (%LOCALAPPDATA%\spicetify). */
  localDir: string
  /** Canonical config/Marketplace/themes/extensions root (%APPDATA%\spicetify). */
  configDir: string
  /** Preferred backup root: sibling of Spicetify's config directory. */
  configBackupDir: string
  /** Legacy fallback backup root inside the local install dir. */
  localBackupDir: string
  /** Backup root selected for this run (existing preferred/fallback, else preferred). */
  backupDir: string
  /** Exact PATH entries the official installer may have added. */
  pathEntries: string[]
  programDir: string | null
}

export function spicetifyLayout(runtime: Runtime, info: SpicetifyInfo): SpicetifyLayout {
  const localBase = runtime.env.LOCALAPPDATA || join(runtime.homedir, "AppData", "Local")
  const roamingBase = runtime.env.APPDATA || join(runtime.homedir, "AppData", "Roaming")
  const localDir = join(localBase, "spicetify")
  const configDir = join(roamingBase, "spicetify")
  // Spicetify's documented backup location is a sibling of the active config
  // directory, not under %LOCALAPPDATA%. Keep the local dir only as a fallback
  // for older/manual layouts.
  const configBackupDir = join(info.configPath ? dirname(info.configPath) : configDir, "Backup")
  const localBackupDir = join(localDir, "Backup")
  const backupDir = runtime.exists(configBackupDir)
    ? configBackupDir
    : runtime.exists(localBackupDir) ? localBackupDir : configBackupDir
  return {
    localBase,
    roamingBase,
    localDir,
    configDir,
    configBackupDir,
    localBackupDir,
    backupDir,
    pathEntries: [localDir, join(localDir, "bin")],
    programDir: info.path ? dirname(info.path) : null,
  }
}

function removeOwnedDirectory(
  ctx: OperationContext,
  deps: Required<UninstallDeps>,
  path: string,
  allowedRoots: string[],
  label: string,
): void {
  if (!ctx.runtime.exists(path)) return
  const problem = pathRemovalProblem(path, allowedRoots, deps.pathInfo(path))
  if (problem) throw new Error(`${label}: ${problem}. Nothing at this path was deleted.`)
  deps.removePath(path)
}

/**
 * Remove one exact owned bridge file when Spicetify cannot be invoked (for
 * example a leftover Extensions directory without a usable CLI). Only the
 * exact `opencode-spotify-bridge.js` leaf inside the detected Extensions
 * directory is ever deleted; symlinks/junctions are refused.
 */
function removeOwnedBridgeFile(
  ctx: OperationContext,
  deps: Required<UninstallDeps>,
  extensionPath: string,
): void {
  if (basename(extensionPath).toLowerCase() !== BRIDGE_FILE.toLowerCase()) {
    throw new Error("Refusing to delete an unexpected bridge filename.")
  }
  if (!ctx.runtime.exists(extensionPath)) return
  const problem = pathRemovalProblem(extensionPath, [extensionPath], deps.pathInfo(extensionPath))
  if (problem) throw new Error(`Owned bridge extension: ${problem}. Nothing at this path was deleted.`)
  deps.removePath(extensionPath)
}

/**
 * Expand %NAME%-style environment references for MATCHING only. The original
 * spelling of every preserved PATH segment is never rewritten.
 */
export function expandPathEnv(value: string, env: NodeJS.ProcessEnv = {}): string {
  return value.replace(/%([^%]+)%/g, (match, rawName) => {
    const name = String(rawName).trim()
    if (!name) return match
    const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase())
    const resolved = key ? env[key] : undefined
    return resolved && resolved.length ? resolved : match
  })
}

/**
 * Remove only exact, previously justified PATH entries. Every other entry is
 * preserved byte-for-byte (order and spelling) and empty segments are dropped.
 * %USERPROFILE%/%LOCALAPPDATA% style segments are expanded for comparison so a
 * literal entry matches the canonical Spicetify locations.
 */
/**
 * Strip one pair of balanced surrounding quotes from a PATH segment. Windows
 * persists quoted entries such as `"C:\...\spicetify"`; they must match the
 * same canonical path as the unquoted form while keeping their spelling when
 * preserved.
 */
export function unquotePathSegment(segment: string): string {
  const trimmed = segment.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1)
    }
  }
  return trimmed
}

export function filterPathEntries(
  value: string,
  remove: string[],
  env: NodeJS.ProcessEnv = {},
): { value: string; removed: string[] } {
  const canonical = (segment: string) => canonicalPath(expandPathEnv(unquotePathSegment(segment), env))
  const drop = new Set(remove.map(canonical))
  const kept: string[] = []
  const removed: string[] = []
  for (const segment of (value ?? "").split(";")) {
    if (!segment.trim()) continue
    if (drop.has(canonical(segment))) {
      removed.push(segment)
      continue
    }
    kept.push(segment)
  }
  return { value: kept.join(";"), removed }
}

export interface PathRemovalResult extends CommandResult {
  /** Exact PATH segments that were removed (empty when none matched). */
  removedPaths?: string[]
}

const READ_USER_PATH =
  "[Environment]::GetEnvironmentVariable('Path', 'User')"
const WRITE_USER_PATH =
  "[Environment]::SetEnvironmentVariable('Path', $env:OPENCODE_SPOTIFY_USER_PATH, 'User')"

/**
 * Remove exact Spicetify entries from the persisted user PATH. Unrelated
 * entries are never rewritten. Returns an error (never throws) so an uninstall
 * can disclose a remaining PATH entry instead of claiming success.
 *
 * D1: PowerShell's stdout ends with CRLF; the trailing newline must be
 * stripped before splitting, otherwise the last unrelated entry stops matching
 * (and is silently rewritten as part of the new value).
 */
export async function removeUserPathEntries(runtime: Runtime, remove: string[]): Promise<PathRemovalResult> {
  const pwsh = await runtime.which("pwsh").catch(() => undefined)
  if (!pwsh) {
    return { code: 1, stdout: "", stderr: "", error: "PowerShell (pwsh) is not available; the user PATH was not changed." }
  }
  const read = await runtime.run(pwsh, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", READ_USER_PATH], {
    timeoutMs: OPERATION_TIMEOUTS.inspection,
  })
  if (read.code !== 0) {
    return {
      code: 1,
      stdout: "",
      stderr: "",
      ...(read.cancelled ? { cancelled: true as const } : {}),
      error: read.cancelled
        ? "Reading the user PATH was stopped by cancellation; no PATH entry was changed."
        : `Could not read the user PATH: ${sanitizeDetail(read.error ?? read.stderr ?? "unknown error")}`,
    }
  }
  const current = (read.stdout ?? "").replace(/[\r\n]+$/, "")
  const filtered = filterPathEntries(current, remove, runtime.env)
  if (!filtered.removed.length) {
    return {
      code: 0,
      stdout: "No exact Spicetify entries were present in the user PATH; every other entry was left unchanged.",
      stderr: "",
      removedPaths: [],
    }
  }
  const write = await runtime.run(pwsh, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WRITE_USER_PATH], {
    timeoutMs: OPERATION_TIMEOUTS.inspection,
    env: { ...runtime.env, OPENCODE_SPOTIFY_USER_PATH: filtered.value } as Record<string, string>,
  })
  if (write.code !== 0) {
    return {
      code: 1,
      stdout: "",
      stderr: "",
      ...(write.cancelled ? { cancelled: true as const } : {}),
      error: write.cancelled
        ? "Updating the user PATH was stopped by cancellation after the write started; verify the PATH entries before retrying."
        : `Could not update the user PATH: ${sanitizeDetail(write.error ?? write.stderr ?? "unknown error")}`,
    }
  }
  // L3: a successful write is not proof the entries are gone (quoted/duplicated
  // forms can survive). Re-read the persisted value and verify it.
  const verify = await runtime.run(pwsh, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", READ_USER_PATH], {
    timeoutMs: OPERATION_TIMEOUTS.inspection,
  })
  if (verify.code !== 0) {
    return {
      code: 1,
      stdout: "",
      stderr: "",
      removedPaths: filtered.removed,
      ...(verify.cancelled ? { cancelled: true as const } : {}),
      error: verify.cancelled
        ? "Verifying the updated user PATH was stopped by cancellation; verify the PATH entries manually."
        : `The user PATH was updated, but it could not be re-read to verify the change: ${sanitizeDetail(verify.error ?? verify.stderr ?? "unknown error")}`,
    }
  }
  const after = filterPathEntries((verify.stdout ?? "").replace(/[\r\n]+$/, ""), remove, runtime.env)
  if (after.removed.length) {
    return {
      code: 1,
      stdout: "",
      stderr: "",
      removedPaths: filtered.removed,
      error: `The user PATH still contains ${after.removed.length} Spicetify entry(ies) after the update; verify the user PATH manually.`,
    }
  }
  return {
    code: 0,
    stdout: `Removed ${filtered.removed.length} Spicetify PATH entry(ies).`,
    stderr: "",
    removedPaths: filtered.removed,
  }
}

// ---------------------------------------------------------------------------
// Spicetify ownership helpers
// ---------------------------------------------------------------------------

export function managerUninstallArgs(owner: SpicetifyInfo["owner"]): { binary: string; args: string[] } | null {
  if (owner === "winget") {
    return {
      binary: "winget",
      // D19: unattended manager removal never stops on a source agreement and
      // never asks interactive questions.
      args: ["uninstall", "--id", SPICETIFY_WINGET_ID, "-e", "--accept-source-agreements", "--disable-interactivity"],
    }
  }
  if (owner === "scoop") return { binary: "scoop", args: ["uninstall", "spicetify-cli"] }
  if (owner === "choco") return { binary: "choco", args: ["uninstall", "spicetify-cli", "-y"] }
  return null
}

export type BackupState = "valid" | "missing" | "incomplete" | "unknown"

export interface BackupAssessment {
  state: BackupState
  directory: string
  xpuiSize?: number
  loginSize?: number
  problems: string[]
}

function safeExists(runtime: Runtime, path: string): boolean {
  try {
    return runtime.exists(path) && runtime.isFile(path)
  } catch {
    return false
  }
}

function safeDirectoryExists(runtime: Runtime, path: string): boolean {
  try {
    return runtime.exists(path)
  } catch {
    return false
  }
}

/** Optional directory listing probe (fake runtimes may provide one). */
function listDirectory(runtime: Runtime, path: string): string[] | null {
  const probe = runtime as Runtime & { listDir?: (path: string) => string[] | null }
  if (typeof probe.listDir === "function") {
    try {
      return probe.listDir(path)
    } catch {
      return null
    }
  }
  try {
    return readdirSync(path)
  } catch {
    return null
  }
}

/**
 * D3: a restore is trusted only when the shared Spicetify backup inspector
 * says "ready" for one of the shared candidate directories. The local size
 * constants are gone: the range policy lives in spicetify.ts. Every candidate
 * is inspected, so an unusable first directory no longer masks a later valid
 * backup.
 *
 * The inspector normally refuses when Spicetify is unavailable; complete
 * removal must still validate the payload after a prior run removed only the
 * program, so a synthetic probe anchored at each candidate is used. That keeps
 * the D10 retry path (program absent, config/backups left) honest.
 */
export async function assessBackup(
  runtime: Runtime,
  layout: SpicetifyLayout,
  deps: Pick<Required<UninstallDeps>, "fileSize">,
  spicetify: SpicetifyInfo,
): Promise<BackupAssessment> {
  const candidates = spicetifyBackupCandidates(runtime, spicetify)
  let firstProblem: BackupAssessment | null = null
  for (const directory of candidates) {
    if (!safeDirectoryExists(runtime, directory)) continue
    const probe: SpicetifyInfo = {
      ...spicetify,
      available: true,
      path: spicetify.path ?? layout.programDir ?? join(layout.localDir, "spicetify.exe"),
      configPath: join(dirname(directory), "config-xpui.ini"),
    }
    const inspection = await inspectBackupStateDetailed(runtime, probe, { fileSize: deps.fileSize })
    if (
      inspection.state === "ready" &&
      inspection.backupDir &&
      canonicalPath(inspection.backupDir) === canonicalPath(directory)
    ) {
      const xpui = inspection.files.find((file) => file.name === "xpui.spa")
      const login = inspection.files.find((file) => file.name === "login.spa")
      return {
        state: "valid",
        directory: inspection.backupDir,
        xpuiSize: xpui?.size ?? undefined,
        loginSize: login?.size ?? undefined,
        problems: [],
      }
    }
    if (!firstProblem) {
      const files = inspection.files
      const allExist = files.length > 0 && files.every((file) => file.exists)
      const unreadable = files.some((file) => file.exists && file.size === null)
      const outOfRange = files.some((file) => file.exists && file.size !== null && !file.plausible)
      const state: BackupState = allExist ? (unreadable ? "unknown" : outOfRange ? "incomplete" : "unknown") : "unknown"
      firstProblem = {
        state,
        directory,
        xpuiSize: files.find((file) => file.name === "xpui.spa")?.size ?? undefined,
        loginSize: files.find((file) => file.name === "login.spa")?.size ?? undefined,
        problems: [
          inspection.error ??
            `Backup directory ${directory} could not be validated against the shared Spicetify backup policy.`,
        ],
      }
    }
  }
  if (firstProblem) return firstProblem
  return {
    state: "missing",
    directory: layout.configBackupDir,
    problems: ["No Spicetify backup directory was found in any known Spicetify state location."],
  }
}

/**
 * D6: post-restore verification checks the stock restored state. The restore
 * is trusted only when the backup is still valid, the installed xpui.spa and
 * login.spa exist at the validated backup sizes within
 * SPICETIFY_BACKUP_SIZE_RANGE, and the extracted mod dirs (Apps\xpui,
 * Apps\login) are gone. An already-stock rerun stays verified even when no
 * file changed. The installed spas are looked up through `spotifyInstallDir`
 * (never through `spotify.path`) and compared with the validated backup size.
 */
async function defaultVerifyRestore(input: RestoreVerificationInput): Promise<RestoreVerification> {
  const spicetify = input.detection.spicetify
  // D3: re-validate with the same first-ready-candidate policy used before the
  // restore; the shared inspector alone stops at the first existing directory.
  const assessment = await assessBackup(input.runtime, input.layout, { fileSize: input.fileSize }, spicetify)
  if (assessment.state !== "valid") {
    return { ok: false, detail: `the Spicetify backup is no longer valid (${assessment.state})` }
  }
  const expectedXpui = assessment.xpuiSize ?? input.backupXpuiSize
  const expectedLogin = assessment.loginSize ?? input.backupLoginSize ?? null
  const installDir = spotifyInstallDir(input.runtime, spicetify)
  if (!installDir) {
    return {
      ok: false,
      detail: "could not locate Spotify's installed xpui.spa to verify the restore; Spicetify config and backups were kept",
    }
  }
  const installedXpui = join(installDir, "Apps", "xpui.spa")
  const installedLogin = join(installDir, "Apps", "login.spa")
  const checkInstalledSizes = (): RestoreVerification | null => {
    const xpuiSize = input.fileSize(installedXpui)
    if (xpuiSize === null) {
      return {
        ok: false,
        detail: `could not locate Spotify's installed xpui.spa to verify the restore (${installedXpui}); Spicetify config and backups were kept`,
      }
    }
    const xpuiRange = SPICETIFY_BACKUP_SIZE_RANGE["xpui.spa"]
    if (xpuiSize < xpuiRange.min || xpuiSize > xpuiRange.max || xpuiSize !== expectedXpui) {
      return {
        ok: false,
        detail: `installed xpui.spa (${xpuiSize} bytes) does not match the backup (${expectedXpui} bytes); Spicetify config and backups were kept`,
      }
    }
    if (expectedLogin !== null && expectedLogin !== undefined) {
      const loginSize = input.fileSize(installedLogin)
      if (loginSize === null) {
        return {
          ok: false,
          detail: `could not locate Spotify's installed login.spa to verify the restore (${installedLogin}); Spicetify config and backups were kept`,
        }
      }
      const loginRange = SPICETIFY_BACKUP_SIZE_RANGE["login.spa"]
      if (loginSize < loginRange.min || loginSize > loginRange.max || loginSize !== expectedLogin) {
        return {
          ok: false,
          detail: `installed login.spa (${loginSize} bytes) does not match the backup (${expectedLogin} bytes); Spicetify config and backups were kept`,
        }
      }
    }
    return null
  }
  const checkModDirsGone = (after: SpotifyAppSnapshot): RestoreVerification | null => {
    const lingering = (after.modDirs ?? []).filter((dir) => dir.exists)
    if (lingering.length) {
      return {
        ok: false,
        detail: `extracted Spotify app directories still present after restore (${lingering.map((dir) => dir.path).join(", ")}); Spicetify config and backups were kept`,
      }
    }
    return null
  }
  if (input.before) {
    const rawAfter = captureSpotifyAppFiles(input.runtime, spicetify)
    const after = withInstalledSizes(rawAfter, input.fileSize)
    const verified = verifySpotifyRestoreApplied(input.before, after, {
      xpuiSize: expectedXpui,
      loginSize: expectedLogin,
    })
    if (!verified.ok) {
      const probeUnavailable =
        input.before.files.every((file) => !file.exists) && (input.before.modDirs ?? []).every((dir) => !dir.exists)
      if (probeUnavailable) {
        const installed = checkInstalledSizes()
        if (installed) return installed
        const modCheck = checkModDirsGone(after)
        if (modCheck) return modCheck
        return { ok: true }
      }
      return {
        ok: false,
        detail: `${verified.error ?? "the restored Spotify files could not be verified"}; Spicetify config and backups were kept`,
      }
    }
    const installed = checkInstalledSizes()
    if (installed) return installed
    const modCheck = checkModDirsGone(after)
    if (modCheck) return modCheck
    return { ok: true }
  }
  const after = withInstalledSizes(captureSpotifyAppFiles(input.runtime, spicetify), input.fileSize)
  const modCheck = checkModDirsGone(after)
  if (modCheck) return modCheck
  const installed = checkInstalledSizes()
  if (installed) return installed
  return { ok: true }
}

function withInstalledSizes(
  snapshot: SpotifyAppSnapshot,
  fileSize: (path: string) => number | null,
): SpotifyAppSnapshot {
  if (!snapshot.files.length) return snapshot
  let touched = false
  const files = snapshot.files.map((file) => {
    if (file.size !== null) return file
    let probed: number | null = null
    try {
      probed = fileSize(file.path)
    } catch {
      probed = null
    }
    if (probed === null) return file
    touched = true
    return { ...file, size: probed }
  })
  if (!touched) return snapshot
  return { ...snapshot, files, ok: files.every((file) => file.exists) }
}

export type ManagerRemovalStatus = "removed" | "unverified" | "failed" | "unsupported"

export interface ManagerRemovalResult {
  status: ManagerRemovalStatus
  command?: string
  detail?: string
  /** The owner-manager child was stopped by cancellation (not a real failure). */
  cancelled?: boolean
}

/**
 * Remove a manager-owned Spicetify through its owner only, then verify the
 * binary is actually gone. A timeout is never reported as termination: the
 * package manager may still be running, so the result is "failed" with the
 * exact remains and manual/retry guidance.
 */
export async function removeSpicetifyPackage(
  runtime: Runtime,
  info: SpicetifyInfo,
  timeoutMs: number = OPERATION_TIMEOUTS.packageInstall,
): Promise<ManagerRemovalResult> {
  const manager = managerUninstallArgs(info.owner)
  if (!manager) {
    return { status: "unsupported", detail: `No owner-safe uninstall command exists for ${info.owner}.` }
  }
  const command = `${manager.binary} ${manager.args.join(" ")}`
  const binary = await runtime.which(manager.binary).catch(() => undefined)
  if (!binary) {
    return {
      status: "failed",
      command,
      detail: `${manager.binary} was not found on PATH; run \`${command}\` manually or use the owner's uninstaller, then rerun uninstall.`,
    }
  }
  const result = await runtime.run(binary, manager.args, { timeoutMs })
  if (result.cancelled) {
    return {
      status: "failed",
      command,
      cancelled: true,
      detail: `${command} was stopped by cancellation after it had started; the package removal did not complete, so the Spicetify package and its state are unverified. Nothing else was deleted.`,
    }
  }
  if (result.timedOut) {
    return {
      status: "failed",
      command,
      detail: `${command} timed out; the package manager may still be running and termination is NOT claimed. Verify it exited, then rerun uninstall.`,
    }
  }
  if (result.code !== 0) {
    return {
      status: "failed",
      command,
      detail: `${command} failed: ${sanitizeDetail(result.error ?? result.stderr ?? "unknown error")}`,
    }
  }
  const stillPresent = info.path ? runtime.exists(info.path) : false
  if (stillPresent) {
    return {
      status: "unverified",
      command,
      detail: `${command} reported success, but ${info.path} is still present. The package is not considered removed; config and backups were kept.`,
    }
  }
  return { status: "removed", command }
}

// ---------------------------------------------------------------------------
// Detection normalization (D7, D8)
// ---------------------------------------------------------------------------

/**
 * D7: an orphan extension file counts as installed even when there are no
 * credentials and no registration. D8: the credential directory itself, not
 * only bridge.json, is what makes credentials present (an interrupted run can
 * leave secret-bearing `bridge.json.backup-*` copies behind).
 */
function effectiveDetection(ctx: OperationContext): Detection {
  const detection = ctx.detection
  const credentialsDirectory = bridgeConfigDir(ctx.runtime)
  const credentialsPresent = safeDirectoryExists(ctx.runtime, credentialsDirectory) ||
    safeExists(ctx.runtime, bridgeConfigPath(ctx.runtime)) ||
    credentialBackupFiles(ctx.runtime).length > 0
  const extensionPresent = detection.bridge.installed || detection.bridge.extensionExists
  if (credentialsPresent === detection.bridge.configExists && extensionPresent === detection.bridge.installed) {
    return detection
  }
  return {
    ...detection,
    bridge: {
      ...detection.bridge,
      installed: extensionPresent,
      configExists: credentialsPresent,
    },
  }
}

/** Secret-bearing credential backups left by an older interrupted reset. */
function credentialBackupFiles(runtime: Runtime): string[] {
  const directory = bridgeConfigDir(runtime)
  const entries = listDirectory(runtime, directory)
  if (!entries) return []
  return entries
    .filter((entry) => /^bridge\.json\.backup-/i.test(entry))
    .map((entry) => join(directory, entry))
}

function inventoryFor(ctx: OperationContext, layout: SpicetifyLayout, detection: Detection): UninstallInventory {
  return inventoryFromDetection(detection, {
    credentialsDirectory: bridgeConfigDir(ctx.runtime),
    backupsDirectory: layout.backupDir,
    backupsPresent: safeDirectoryExists(ctx.runtime, layout.configBackupDir) ||
      safeDirectoryExists(ctx.runtime, layout.localBackupDir),
  })
}

// ---------------------------------------------------------------------------
// Deletion planning (single source of truth for scope + execution)
// ---------------------------------------------------------------------------

interface SpicetifyDeletionPlan {
  /** A validated backup exists, so Spicetify-owned deletion is permitted. */
  canDelete: boolean
  scriptInside: boolean
  managerOwned: boolean
  /** The Spicetify binary is already gone (nothing left to remove/restore). */
  programAbsent: boolean
  /** The program directory/package removal step will be planned. */
  programDeletion: boolean
  /** A canonical config deletion step will be planned. */
  configDeletion: boolean
  /** A manager-owned canonical local-data deletion step will be planned. */
  localDataDeletion: boolean
  /** The planned steps delete the directory that holds the backup payload. */
  backupsDeletion: boolean
  /** `spicetify restore` must run before any deletion. */
  restoreNeeded: boolean
}

function spicetifyDeletionPlan(
  ctx: OperationContext,
  layout: SpicetifyLayout,
  backup: BackupAssessment,
): SpicetifyDeletionPlan {
  const info = ctx.detection.spicetify
  const canDelete = backup.state === "valid"
  const scriptInside = info.owner === "script" && !!info.path && isWithinBoundary(layout.localDir, info.path)
  const managerOwned = info.owner === "winget" || info.owner === "scoop" || info.owner === "choco"
  const programAbsent = !info.available || !info.path
  // D10: when the program is already gone, config/local-data cleanup is a
  // retry of leftovers. It is still gated on a validated backup.
  const canonicalLeftovers = programAbsent && canDelete
  const programDeletion = canDelete && !programAbsent && (scriptInside || managerOwned)
  const restoreNeeded = canDelete && !programAbsent
  let configDeletion = canDelete && (scriptInside || managerOwned || canonicalLeftovers) &&
    safeDirectoryExists(ctx.runtime, layout.configDir)
  let localDataDeletion = canDelete && (scriptInside || managerOwned || canonicalLeftovers) &&
    safeDirectoryExists(ctx.runtime, layout.localDir) &&
    (programAbsent || (managerOwned && !!info.path && !isWithinBoundary(layout.localDir, info.path)))

  // H3: when the program is already absent no restore can run, so the
  // validated backup is the ONLY recovery payload. Preserve every
  // Spicetify-owned directory instead of deleting config/local data (Backup
  // lives inside one of them; no new backup is created).
  const backupInConfig = isWithinBoundary(layout.configDir, backup.directory)
  const backupInLocal = isWithinBoundary(layout.localDir, backup.directory)
  if (canDelete && !restoreNeeded) {
    configDeletion = false
    localDataDeletion = false
  }

  // M7: the flag must reflect every planned deletion that removes the payload,
  // including a legacy local-fallback Backup under %LOCALAPPDATA%\spicetify.
  const backupsDeletion = canDelete &&
    ((configDeletion && backupInConfig) || (localDataDeletion && backupInLocal))
  return {
    canDelete,
    scriptInside,
    managerOwned,
    programAbsent,
    programDeletion,
    configDeletion,
    localDataDeletion,
    backupsDeletion,
    restoreNeeded,
  }
}

/**
 * Extend C19's presentation scope with the Spicetify-owned deletions and the
 * manual checks that complete removal introduces. The returned object is a
 * copy; the view module remains the single renderer.
 *
 * D13: "Spicetify/other extensions preserved" and "backups deleted" are only
 * asserted when the matching step is actually planned.
 */
function completeScope(
  base: UninstallScope,
  ctx: OperationContext,
  layout: SpicetifyLayout,
  backup: BackupAssessment,
  spicetifyPresent: boolean,
): UninstallScope {
  const info = ctx.detection.spicetify
  const plan = spicetifyDeletionPlan(ctx, layout, backup)

  const scope: UninstallScope = {
    ...base,
    deletions: base.deletions.map((item) => ({ ...item })),
    preservations: base.preservations
      .filter((item) => {
        if (item.id === "spicetify" || item.id === "other-extensions") {
          return !(plan.programDeletion || plan.configDeletion || plan.localDataDeletion)
        }
        return true
      })
      .map((item) => ({ ...item })),
    manualChecks: [...base.manualChecks],
    warnings: [...base.warnings],
  }

  if (plan.backupsDeletion) {
    scope.preservations = scope.preservations.filter((item) => item.id !== "backups")
    scope.warnings = scope.warnings.filter((warning) => !warning.startsWith("Preserved backups"))
  } else if (safeDirectoryExists(ctx.runtime, layout.configBackupDir) || safeDirectoryExists(ctx.runtime, layout.localBackupDir)) {
    // D13: the view may assume complete removal always deletes the Spicetify
    // config directory (and therefore the backup payload inside it). When no
    // such step is planned, state the preservation explicitly.
    if (!scope.preservations.some((item) => item.id === "backups")) {
      scope.preservations.push({
        id: "backups",
        label: "Installer backups",
        target: backup.directory,
        reason: plan.restoreNeeded
          ? "No Spicetify-owned deletion is planned, so the backup payload stays available for rollback."
          : "No Spotify restore is run when Spicetify is already absent, so the only recovery payload is preserved.",
        containsSecrets: true,
      })
    }
  }

  const deletesSpicetify = plan.programDeletion || plan.configDeletion || plan.localDataDeletion
  if (!deletesSpicetify) {
    // D13: no deletion is planned, so the tooling that would otherwise be
    // removed is preserved and must say so.
    if (!scope.preservations.some((item) => item.id === "spicetify")) {
      scope.preservations.push({
        id: "spicetify",
        label: "Spicetify CLI and its installation",
        reason: plan.programAbsent
          ? "Spicetify is already absent, and no Spotify restore can run; its config/local data and the only validated backup are preserved."
          : "No validated, owner-safe Spicetify deletion is planned; it is shared tooling, not owned by OpenCode Spotify.",
      })
    }
    if (!scope.preservations.some((item) => item.id === "other-extensions") && info.available) {
      scope.preservations.push({
        id: "other-extensions",
        label: "Other Spicetify extensions, themes and custom apps",
        reason: "Only the opencode-spotify-bridge.js entry is touched.",
      })
    }
  }

  if (plan.canDelete) {
    if (!plan.programAbsent) {
      if (plan.scriptInside) {
        scope.deletions.push({
          id: "spicetify-program",
          label: "Spicetify program, local data and internal backups",
          target: layout.localDir,
        })
        scope.deletions.push({
          id: "spicetify-path",
          label: "Exact Spicetify entries in the user PATH",
          target: layout.pathEntries.join("; "),
        })
      } else if (plan.managerOwned) {
        scope.deletions.push({
          id: "spicetify-package",
          label: `Spicetify package owned by ${info.owner}`,
          target: info.path ?? `${info.owner} package`,
        })
      } else {
        scope.manualChecks.push(
          `The Spicetify installation owner or path is uncertain (${info.path ?? "path unresolved"}). Nothing under ${layout.localDir} or ${layout.configDir} is deleted automatically; remove it with the tool that installed it.`,
        )
      }
    }
    if (!plan.scriptInside && plan.managerOwned && plan.localDataDeletion) {
      scope.deletions.push({
        id: "spicetify-data",
        label: "Spicetify local data and internal backups",
        target: layout.localDir,
      })
    }
    if (!plan.scriptInside && !plan.managerOwned && plan.programAbsent && plan.localDataDeletion) {
      scope.deletions.push({
        id: "spicetify-data",
        label: "Spicetify local data leftovers",
        target: layout.localDir,
      })
    }
  } else if (spicetifyPresent) {
    scope.manualChecks.push(
      "No validated Spicetify backup is available. Spicetify's program, config, Marketplace, themes, extensions and backups are preserved; restore Spotify manually before retrying complete removal.",
    )
  }

  if (plan.configDeletion) {
    scope.deletions.push({
      id: "spicetify-config",
      label: "Spicetify config, Marketplace, themes and extensions (deleted only after the program removal is verified)",
      target: layout.configDir,
    })
  }
  if (info.configPath && !isWithinBoundary(layout.configDir, info.configPath)) {
    scope.manualChecks.push(
      `Spicetify's configured config file is outside ${layout.configDir} (${info.configPath}). It is not deleted automatically; remove it manually if it belongs to Spicetify.`,
    )
  }
  if (!plan.configDeletion && plan.canDelete && !plan.programAbsent && !plan.scriptInside && !plan.managerOwned) {
    scope.preservations.push({
      id: "spicetify-manual",
      label: "Spicetify installation and config",
      reason: "Ownership or install path could not be verified, so this is left for manual removal.",
    })
  }

  if (!scope.preservations.some((item) => item.id === "spotify-data")) {
    scope.preservations.push({
      id: "spotify-data",
      label: "Spotify Desktop, account data, downloads and playlists",
      reason: "Spotify is never uninstalled and its data is never touched by this workflow.",
    })
  }
  if (!scope.preservations.some((item) => item.id === "opencode-data")) {
    scope.preservations.push({
      id: "opencode-data",
      label: "OpenCode CLI, settings, history and project/repo registration",
      reason: "Only the global opencode-spotify plugin entry is removed; the CLI and project configuration are kept.",
    })
  }

  if (backup.state === "valid") {
    scope.warnings.push(
      plan.restoreNeeded
        ? `A validated Spicetify backup (xpui.spa ${backup.xpuiSize ?? "?"} bytes, login.spa ${backup.loginSize ?? "?"} bytes) is restored and verified before any Spicetify-owned deletion. No new backup is created.`
        : `A validated Spicetify backup (xpui.spa ${backup.xpuiSize ?? "?"} bytes, login.spa ${backup.loginSize ?? "?"} bytes) is present, but Spicetify is already absent, so NO Spotify restore will be run. The backup payload is preserved as the only recovery path and Spotify's restore state stays unverified. No new backup is created.`,
    )
  } else if (backup.state === "missing") {
    scope.warnings.push(
      "UNKNOWN restore state: no Spicetify backup was found. Spotify must NOT be assumed unmodified. Complete removal will remove only OpenCode Spotify's registration, bridge and credentials; all Spicetify-owned files including config and backups are preserved.",
    )
  } else {
    scope.warnings.push(
      `The Spicetify backup is ${backup.state}: ${backup.problems.join(" ") || "it could not be validated"}. Complete removal is blocked; Spicetify config and backups are preserved.`,
    )
  }

  scope.incomplete = scope.incomplete || scope.manualChecks.length > 0
  return scope
}

function isEnvCompleteRequested(runtime: Runtime): boolean {
  const value = (runtime.env.OPENCODE_SPOTIFY_UNINSTALL ?? "").trim().toLowerCase()
  return value === "complete" || value === "all" || value === "everything"
}

/**
 * Explicit complete-removal intent. `--complete` is the first-class flag;
 * OPENCODE_SPOTIFY_UNINSTALL=complete (aliases all/everything) remains the
 * supported script/back-compat form. Both still require typed UNINSTALL
 * interactively, or --non-interactive + --yes.
 */
export function isCompleteRequested(ctx: OperationContext): boolean {
  return ctx.options.complete === true || isEnvCompleteRequested(ctx.runtime)
}

// ---------------------------------------------------------------------------
// Cancellation-aware plan execution
// ---------------------------------------------------------------------------

interface RunOutcome {
  status: "completed" | "failed" | "cancelled" | "confirmation-required"
  completed: string[]
  skipped: string[]
  /** A step that failed for a real reason. Exit code 1, never masked by cancel. */
  failed?: string
  error?: string
  /**
   * A step that had already started when a genuine cancellation stopped it.
   * Its mutation may be partial, so it is reported as failed/uncertain (the
   * run still exits 130 because no real failure occurred).
   */
  uncertain?: string
  uncertainDetail?: string
}

interface TrackedStep {
  step: PlanStep
  component: UninstallComponentResult
}

/**
 * Cancellation result contract: a child stopped by our own token returns
 * `cancelled: true` with code 130. Steps map exactly that shape to
 * OperationCancelled, so a real nonzero exit (even under a concurrent
 * cancellation request) stays a failure. Exit code 130 alone is never treated
 * as proof of cancellation.
 */
function cancellationFromResult(result: CommandResult, stepId: string, detail: string): OperationCancelled | null {
  return result.cancelled === true ? new OperationCancelled(stepId, detail) : null
}

/**
 * A cancelled child result is cancellation (130 + uncertain step); any other
 * nonzero exit is a real failure (1). The two are never conflated.
 */
function assertBridgeUninstallResult(result: CommandResult): void {
  const cancelled = cancellationFromResult(
    result,
    "remove-bridge",
    "The owned bridge removal was stopped by cancellation after it had started; the bridge may be partially removed, so verify it before retrying.",
  )
  if (cancelled) throw cancelled
  if (result.code !== 0) throw new Error(sanitizeDetail(result.error ?? "Bridge uninstall failed"))
}

function assertCredentialsRemoved(result: CommandResult): void {
  const cancelled = cancellationFromResult(
    result,
    "remove-credentials",
    "The credential removal was stopped by cancellation after it had started; the signing secret and pinned Origin may still be on disk, so verify before retrying.",
  )
  if (cancelled) throw cancelled
  if (result.code !== 0) throw new Error(sanitizeDetail(result.error ?? "Credential removal failed"))
}

function cancelledStepDetail(stepId: string, label: string): string {
  if (stepId === "restore-spotify") {
    return `${label} was stopped by cancellation after it had started: the Spotify restore did not complete, and nothing Spicetify-owned was deleted. Re-run complete removal to restore Spotify from the validated backup.`
  }
  return `${label} was stopped by cancellation after it had started; the step may be partially applied, so verify this component before retrying.`
}

function cancellationEvent(
  ctx: OperationContext,
  phase: "requested" | "finishing" | "settled",
  stepId?: string,
): void {
  const report = planReporter(ctx)
  if (!report) return
  try {
    report.emit({
      type: "cancel",
      phase,
      ...(stepId ? { stepId } : {}),
      ...(ctx.cancel.forced ? { forced: true } : {}),
      at: ctx.runtime.now(),
    })
  } catch {
    // Presentation only: a broken reporter must not abort cancellation.
  }
}

function presentPlan(ctx: OperationContext, title: string, steps: PlanStep[]): void {
  const report = planReporter(ctx)
  if (report) {
    try {
      report.emit({
        type: "plan",
        title: sanitizeDetail(title),
        steps: steps.map((step) => ({
          id: step.id,
          description: sanitizeDetail(step.description),
          mutates: step.mutates,
          status: "pending" as const,
        })),
        at: ctx.runtime.now(),
      })
      return
    } catch {
      // Fall through to the plain UI path.
    }
  }
  ctx.ui.section(title)
  steps.forEach((step, index) => {
    ctx.ui.bullet(`${index + 1}. ${step.description}${step.mutates ? "" : " (verification only)"}`)
  })
}

/**
 * Execute a plan with cooperative cancellation. This mirrors executePlan's
 * consent semantics (dry-run is handled by the caller through executePlan) and
 * adds Step.interrupt policies:
 *   * "protected" steps are never interrupted; a cancellation requested during
 *     one is marked as finishing and takes effect before the next step;
 *   * boundary steps stop before the next step once cancellation is requested;
 *   * a step that had already started when cancellation stopped it is reported
 *     as failed/uncertain (never "not attempted") and still exits 130;
 *   * a real failure is never reclassified as a cancellation;
 *   * requested/finishing/settled cancel events are emitted once each;
 *   * no child is killed here (restore/apply/backup are never terminated).
 */
async function runTrackedPlan(
  ctx: OperationContext,
  title: string,
  steps: PlanStep[],
  confirmation: { question?: string; defaultYes?: boolean; approved?: boolean } = {},
): Promise<RunOutcome> {
  const { options, prompt, ui } = ctx
  const report = planReporter(ctx)
  const ids = steps.map((step) => step.id)
  presentPlan(ctx, title, steps)

  // A cancellation requested before this plan started runs nothing, not even a
  // protected step, and is announced with the request/settled events.
  if (ctx.cancel.requested) {
    cancellationEvent(ctx, "requested")
    return { status: "cancelled", completed: [], skipped: ids }
  }

  const mutates = steps.some((step) => step.mutates)
  if (mutates && !confirmation.approved && !options.yes) {
    if (options.nonInteractive) {
      ui.error(PLAN_MESSAGES.confirmationRequired)
      return { status: "confirmation-required", completed: [], skipped: ids }
    }
    const approved = await prompt.confirm(confirmation.question ?? "Apply this plan?", {
      defaultYes: confirmation.defaultYes === true,
    })
    if (!approved) {
      ui.warn(PLAN_MESSAGES.cancelled)
      return { status: "cancelled", completed: [], skipped: ids }
    }
    // Consent may be accompanied by a cancellation request (Ctrl-C).
    if (ctx.cancel.requested) {
      cancellationEvent(ctx, "requested")
      return { status: "cancelled", completed: [], skipped: ids }
    }
  }

  const completed: string[] = []
  let runningStep: PlanStep | undefined
  let requestedEmitted = false
  let finishingEmitted = false

  const announceRequested = (): void => {
    if (requestedEmitted) return
    requestedEmitted = true
    cancellationEvent(ctx, "requested", runningStep?.id ?? ctx.cancel.stepId)
  }
  const announceFinishing = (stepId: string): void => {
    if (finishingEmitted) return
    finishingEmitted = true
    cancellationEvent(ctx, "finishing", stepId)
  }
  const unsubscribe = ctx.cancel.onRequest(() => {
    announceRequested()
    if (runningStep?.interrupt === "protected") {
      ctx.cancel.beginFinishing(runningStep.id)
      announceFinishing(runningStep.id)
    }
  })

  const stop = (
    remaining: PlanStep[],
    uncertain?: { step: string; detail: string },
  ): RunOutcome => {
    announceRequested()
    return {
      status: "cancelled",
      completed: [...completed],
      skipped: remaining.map((step) => step.id),
      ...(uncertain ? { uncertain: uncertain.step, uncertainDetail: uncertain.detail } : {}),
    }
  }

  try {
    for (let index = 0; index < steps.length; index++) {
      const step = steps[index]!
      // Cancellation between steps: no further step starts.
      if (ctx.cancel.requested) return stop(steps.slice(index))
      // Revalidate the installer lock before each mutation (mirrors plan.ts).
      if (step.mutates && ctx.guard) {
        try {
          await ctx.guard()
        } catch (error) {
          const message = sanitizeDetail(error instanceof Error && error.message ? error.message : "the installer lock is no longer held.")
          return { status: "failed", completed, skipped: steps.slice(index).map((item) => item.id), failed: step.id, error: message }
        }
      }
      runningStep = step
      if (report) {
        try { report.step(step.id, "running") } catch { /* presentation only */ }
      }
      // Protected children must finish: suppress runtime cancellation kills.
      const releaseKill = step.interrupt === "protected" ? ctx.cancel.holdKill() : undefined
      try {
        await step.run()
      } catch (error) {
        const message = sanitizeDetail(error instanceof Error && error.message ? error.message : "The step failed.")
        if (isCancellation(error)) {
          // The step had already started: its mutation may be partial, so it is
          // reported as failed/uncertain, never as "not attempted". A genuine
          // cancellation still exits 130 (status "cancelled").
          if (!ctx.cancel.requested) ctx.cancel.request("user")
          if (report) {
            try { report.step(step.id, "failed", message) } catch { /* presentation only */ }
          } else {
            ui.error(`Stopped at: ${step.id} - ${step.description}`)
            ui.line(`   Reason: ${message}`)
            ui.line(`   Completed stages: ${completed.length ? completed.join(", ") : "none"}`)
          }
          runningStep = undefined
          return stop(steps.slice(index + 1), {
            step: step.id,
            detail: message || cancelledStepDetail(step.id, step.description),
          })
        }
        // A real failure always wins over a concurrent cancellation request.
        runningStep = undefined
        const skipped = steps.slice(index + 1).map((item) => item.id)
        if (report) {
          try { report.step(step.id, "failed", message) } catch { /* presentation only */ }
        } else {
          ui.error(`Stopped at: ${step.id} - ${step.description}`)
          ui.line(`   Reason: ${message}`)
          ui.line(`   Completed stages: ${completed.length ? completed.join(", ") : "none"}`)
          ui.line(`   Not run: ${skipped.length ? skipped.join(", ") : "none"}`)
        }
        return { status: "failed", completed, skipped, failed: step.id, error: message }
      } finally {
        releaseKill?.()
      }
      completed.push(step.id)
      runningStep = undefined
      if (report) {
        try { report.step(step.id, "ok") } catch { /* presentation only */ }
      } else {
        ui.success(step.description)
      }
      if (ctx.cancel.requested) {
        return stop(steps.slice(index + 1))
      }
    }
  } finally {
    unsubscribe()
  }
  return { status: "completed", completed: [...completed], skipped: [] }
}

function settleCancellation(ctx: OperationContext, completed: number): void {
  const requested = ctx.cancel.requested
  ctx.cancel.settle(completed > 0 ? "partial" : "cancelled")
  // Emitted after the phase change so listeners see a settled token.
  if (requested) cancellationEvent(ctx, "settled", ctx.cancel.stepId)
}

function stageLabel(tracked: TrackedStep[], stepId: string): string {
  return tracked.find((entry) => entry.step.id === stepId)?.component.label ?? stepId
}

/**
 * H1: a cancellation message must name the stages that really completed. It
 * must never reuse the "no steps were run" wording when work was kept.
 */
function cancellationNotice(tracked: TrackedStep[], outcome: RunOutcome): string | undefined {
  if (outcome.status !== "cancelled") return undefined
  const completedStages = outcome.completed.map((id) => stageLabel(tracked, id))
  const prefix = completedStages.length
    ? `Cancellation was honoured. Completed stages were kept: ${completedStages.join(", ")}.`
    : "Cancellation was honoured before any stage completed."
  const uncertainStage = outcome.uncertain ? stageLabel(tracked, outcome.uncertain) : undefined
  const suffix = uncertainStage
    ? ` ${uncertainStage} had already started when cancellation stopped it; verify it before retrying.`
    : " No further stages were started."
  return `${prefix}${suffix}`
}

function skippedDetail(outcome: RunOutcome): string | undefined {
  if (outcome.status === "cancelled") return "Not attempted because the operation was cancelled."
  if (outcome.failed) return `Not attempted after ${outcome.failed} failed.`
  return undefined
}

/**
 * Shared outcome builder: one place decides removed/failed/skipped/absent so
 * both modes and the residual-only path report the same truth.
 */
function buildComponents(
  tracked: TrackedStep[],
  residuals: Map<string, string>,
  outcome: RunOutcome,
  labels: Record<string, { label: string; target?: string }>,
  hints: Map<string, UninstallComponentStatus> = new Map(),
): UninstallComponentResult[] {
  const components: UninstallComponentResult[] = tracked.map(({ step, component }) => {
    if (step.id === "restore-spotify") {
      if (outcome.completed.includes(step.id)) return { ...component, status: "removed" }
      if (outcome.failed === step.id) {
        return { ...component, status: "failed", ...(outcome.error ? { detail: outcome.error } : {}) }
      }
      if (outcome.uncertain === step.id) {
        return {
          ...component,
          status: "failed",
          detail: outcome.uncertainDetail ?? cancelledStepDetail(step.id, component.label),
        }
      }
      const detail = skippedDetail(outcome)
      return { ...component, status: "skipped", ...(detail ? { detail } : {}) }
    }
    const residual = residuals.get(component.id)
    if (residual) return { ...component, status: "failed", detail: residual }
    if (outcome.completed.includes(step.id)) {
      return { ...component, status: hints.get(component.id) === "absent" ? "absent" : "removed" }
    }
    if (outcome.failed === step.id) {
      return { ...component, status: "failed", ...(outcome.error ? { detail: outcome.error } : {}) }
    }
    // H3: only a step that never started is "skipped / Not attempted". A step
    // stopped by cancellation after it started keeps its own uncertain detail.
    if (outcome.uncertain === step.id) {
      return {
        ...component,
        status: "failed",
        detail: outcome.uncertainDetail ?? cancelledStepDetail(step.id, component.label),
      }
    }
    const detail = skippedDetail(outcome)
    return { ...component, status: "skipped", ...(detail ? { detail } : {}) }
  })
  for (const [id, detail] of residuals) {
    if (components.some((component) => component.id === id)) continue
    const descriptor = labels[id] ?? { label: id }
    components.push({ id, ...descriptor, status: "failed", detail })
  }
  return components
}

/** D2: manual checks are remaining work, not decorations. */
function manualCheckComponents(checks: string[]): UninstallComponentResult[] {
  return checks.map((check, index) => ({
    id: `manual-check-${index + 1}`,
    label: check,
    status: "failed" as const,
  }))
}

// ---------------------------------------------------------------------------
// Plugin-only mode
// ---------------------------------------------------------------------------

function componentStatusLabel(
  components: UninstallComponentResult[],
  id: string,
  absent: string,
): string {
  const component = components.find((item) => item.id === id)
  if (!component) return absent
  switch (component.status) {
    case "removed": return "removed"
    case "absent": return absent
    case "failed": return "failed (see result)"
    case "skipped": return "not attempted"
  }
}

async function removeRegistrationVerified(ctx: OperationContext): Promise<void> {
  const spec = ctx.detection.opencode.plugin.spec ?? "opencode-spotify"
  const result = await removeGlobalPlugin(ctx.runtime, spec)
  const cancelled = cancellationFromResult(
    result,
    "remove-global-registration",
    "The global registration removal was stopped by cancellation after it had started; verify it with `opencode plugin list` before retrying (a partial remove is possible).",
  )
  if (cancelled) throw cancelled
  if (result.code !== 0) {
    throw new Error(sanitizeDetail(result.error ?? "opencode plugin remove failed"))
  }
  // D11: a successful exit is not proof the row is gone. Reconcile and refuse
  // to claim removal when the registration is still listed or unverifiable.
  const binary = await resolveOpenCodeBinary(ctx.runtime).catch(() => "opencode")
  const reconciled = await reconcileRegistration(ctx.runtime, spec, binary)
  if (reconciled.state === "registered") {
    throw new Error(`The global registration ${spec} is still present after removal; the removal was not verified.`)
  }
  if (reconciled.state !== "absent") {
    throw new Error(
      `Could not verify that the global registration ${spec} was removed (${reconciled.detail ?? reconciled.outcome}); treat it as still present.`,
    )
  }
}

async function runPluginOnly(ctx: OperationContext, deps: Required<UninstallDeps>): Promise<number> {
  const { ui } = ctx
  const detection = effectiveDetection(ctx)
  const layout = spicetifyLayout(ctx.runtime, detection.spicetify)
  const scope = buildUninstallScope("plugin-only", inventoryFor(ctx, layout, detection))
  renderUninstallScope(ui, scope)

  const tracked: TrackedStep[] = []
  const residuals = new Map<string, string>()
  const hints = new Map<string, UninstallComponentStatus>()
  const labels = {
    "global-registration": { label: "Global OpenCode plugin registration" },
    "bridge-extension": { label: "Owned Spicetify bridge extension" },
    "bridge-credentials": { label: "Bridge credentials and pinned Origin" },
  }

  if (detection.opencode.plugin.registered) {
    tracked.push({
      step: {
        id: "remove-global-registration",
        description: "Remove the global OpenCode registration and verify it is gone",
        mutates: true,
        interrupt: "boundary",
        run: async () => { await removeRegistrationVerified(ctx) },
      },
      component: {
        id: "global-registration",
        label: "Global OpenCode plugin registration",
        target: detection.opencode.plugin.spec ?? "opencode-spotify",
        status: "skipped",
      },
    })
  }

  const bridgePresent = detection.bridge.installed ||
    detection.bridge.extensionExists ||
    detection.spicetify.bridgeRegistered
  if (bridgePresent) {
    if (detection.spicetify.available) {
      tracked.push({
        step: {
          id: "remove-bridge",
          description: "Remove the owned bridge extension and its Spicetify registration (credentials and backups kept)",
          mutates: true,
          interrupt: "boundary",
          run: async () => {
            const result = await bridgeOperation(ctx.runtime, "uninstall", {
              spicetifyPath: detection.spicetify.path,
              dryRun: false,
              yes: true,
            })
            assertBridgeUninstallResult(result)
          },
        },
        component: {
          id: "bridge-extension",
          label: "Owned Spicetify bridge extension",
          target: detection.bridge.extensionPath ?? BRIDGE_FILE,
          status: "skipped",
        },
      })
    } else if (detection.bridge.extensionPath) {
      tracked.push({
        step: {
          id: "remove-bridge-file",
          description: "Delete the owned bridge extension file (Spicetify is unavailable; no registration edit is possible)",
          mutates: true,
          interrupt: "boundary",
          run: async () => {
            removeOwnedBridgeFile(ctx, deps, detection.bridge.extensionPath!)
          },
        },
        component: {
          id: "bridge-extension",
          label: "Owned Spicetify bridge extension",
          target: detection.bridge.extensionPath,
          status: "skipped",
        },
      })
    } else {
      residuals.set("bridge-extension", "Spicetify was not detected, so the owned extension could not be located safely.")
    }
  }

  let outcome: RunOutcome | null = null
  if (tracked.length) {
    if (ctx.options.dryRun) {
      await executePlan(ctx, "Uninstall plan", tracked.map((item) => item.step), { approved: true })
      return 0
    }
    outcome = await runTrackedPlan(ctx, "Uninstall plan", tracked.map((item) => item.step), {
      question: "Remove OpenCode Spotify's registration and owned bridge files?",
      defaultYes: false,
    })
    if (outcome.status === "confirmation-required") return 2
    if (outcome.status === "cancelled") {
      settleCancellation(ctx, outcome.completed.length)
      const components = buildComponents(tracked, residuals, outcome, labels, hints)
      renderUninstallResult(ui, { mode: "plugin-only", components })
      if (ctx.cancel.requested) {
        const notice = cancellationNotice(tracked, outcome)
        if (notice) ui.warn(notice)
      }
      return 130
    }
    if (outcome.status === "failed") {
      const components = buildComponents(tracked, residuals, outcome, labels, hints)
      renderUninstallResult(ui, { mode: "plugin-only", components })
      return 1
    }
  }

  const components: UninstallComponentResult[] = buildComponents(
    tracked,
    residuals,
    outcome ?? { status: "completed", completed: [], skipped: [] },
    labels,
    hints,
  )

  // D8: credentials are identified by the directory (or secret-bearing
  // backups), not only bridge.json. D9/D16: dry-run never prompts.
  const credentialsPresent = detection.bridge.configExists
  let credentialStatus: "removed" | "kept" | "absent" = credentialsPresent ? "kept" : "absent"

  if (ctx.options.removeCredentials) {
    if (!credentialsPresent) {
      credentialStatus = "absent"
    } else if (ctx.options.dryRun) {
      ui.dryRun("Delete the owned bridge credential directory (signing secret and pinned Origin)")
      return 0
    } else {
      let approved = ctx.options.nonInteractive && ctx.options.yes
      if (!approved) {
        if (ctx.options.nonInteractive) {
          ui.error("Credential removal requires --yes in noninteractive mode. Credentials were kept.")
          return 2
        }
        ui.section("Optional credential removal")
        ui.line("  This deletes %APPDATA%\\opencode-spotify, including the signing secret and pinned Origin.")
        ui.line("  Backups are not deleted. A reinstall generates a new secret and requires a bridge reinstall.")
        approved = await ctx.prompt.confirm("Delete the stored bridge credentials too?", { phrase: "DELETE CREDENTIALS" })
      }
      if (approved) {
        const removal = await runTrackedPlan(ctx, "Credential removal", [{
          id: "remove-credentials",
          description: "Delete the owned bridge credential directory",
          mutates: true,
          interrupt: "boundary",
          run: async () => {
            const result = await removeCredentials(ctx.runtime)
            assertCredentialsRemoved(result)
            const leftovers = credentialBackupFiles(ctx.runtime)
            if (leftovers.length) {
              throw new Error("Secret-bearing credential backups are still present in the credential directory.")
            }
          },
        }], { approved: true })
        if (removal.status === "cancelled") {
          settleCancellation(ctx, removal.completed.length)
          const credentialsRemoved = removal.completed.includes("remove-credentials")
          const credentialsUncertain = removal.uncertain === "remove-credentials"
          credentialStatus = credentialsRemoved ? "removed" : "kept"
          renderUninstallResult(ui, {
            mode: "plugin-only",
            components: [
              ...components,
              {
                id: "bridge-credentials",
                label: "Bridge credentials and pinned Origin",
                target: bridgeConfigDir(ctx.runtime),
                status: credentialsRemoved ? "removed" : "failed",
                ...(credentialsRemoved
                  ? {}
                  : {
                      detail: credentialsUncertain
                        ? removal.uncertainDetail ?? cancelledStepDetail("remove-credentials", "The credential removal")
                        : "Not attempted because the operation was cancelled before this step started.",
                    }),
              },
            ],
          })
          if (ctx.cancel.requested) {
            ui.warn(
              credentialsRemoved
                ? "Cancellation was honoured. Completed stages were kept: Bridge credentials and pinned Origin."
                : "Cancellation was honoured before the credential removal completed.",
            )
          }
          return 130
        }
        if (removal.status === "failed") {
          renderUninstallResult(ui, {
            mode: "plugin-only",
            components: [
              ...components,
              {
                id: "bridge-credentials",
                label: "Bridge credentials and pinned Origin",
                target: bridgeConfigDir(ctx.runtime),
                status: "failed",
                ...(removal.error ? { detail: removal.error } : {}),
              },
            ],
          })
          return 1
        }
        credentialStatus = "removed"
      } else {
        ui.line("  Credentials were kept.")
        credentialStatus = "kept"
      }
    }
  }

  if (!tracked.length && !ctx.options.removeCredentials && !credentialsPresent && !residuals.size) {
    ui.success("Nothing owned by OpenCode Spotify is registered. Spotify and Spicetify were not touched.")
    return 0
  }

  // L2: residuals are real remaining work, never a clean success.
  if (residuals.size) {
    renderUninstallResult(ui, { mode: "plugin-only", components })
  }

  // D9/D12: derive the summary from the outcome and require a Spotify
  // restart/apply for the prepared removal to take effect.
  ui.section("Uninstall summary")
  ui.kv("Global registration", componentStatusLabel(components, "global-registration", "not registered"))
  ui.kv("Owned bridge", componentStatusLabel(components, "bridge-extension", "not present"))
  ui.kv(
    "Credentials",
    credentialStatus === "removed"
      ? "removed"
      : credentialStatus === "absent" ? "not present" : "kept",
  )
  ui.kv("Spotify / Spicetify", "not removed")
  ui.kv("Other extensions", "preserved")
  if (residuals.size) {
    for (const detail of residuals.values()) ui.warn(detail)
  }
  ui.bullet("Restart running OpenCode processes so the plugin is unloaded.")
  const bridgeTouched = components.some((component) => component.id === "bridge-extension") || detection.bridge.extensionExists
  if (bridgeTouched) {
    if (detection.spicetify.available) {
      ui.bullet("Bridge removed from files/configuration; run spicetify apply to finish removing it from the running Spotify client.")
      ui.bullet("Restart Spotify after applying; until then the running client may keep the old extension active.")
      if (!ctx.options.dryRun) {
        const spicetifyPath = detection.spicetify.path ?? "spicetify"
        if (ctx.options.nonInteractive) {
          if (ctx.options.apply) {
            const applied = await ctx.runtime.run(spicetifyPath, ["apply"], {
              timeoutMs: OPERATION_TIMEOUTS.spicetifyApply,
            })
            if (applied.code === 0) {
              ui.bullet("Ran spicetify apply to finish removing the bridge from Spotify.")
            } else {
              ui.warn(`spicetify apply did not complete: ${sanitizeDetail(applied.error ?? applied.stderr ?? "unknown error")}. Run spicetify apply manually, then restart Spotify.`)
            }
          }
        } else {
          let approved = false
          try {
            approved = await ctx.prompt.confirm("Run spicetify apply now to finish removing the bridge from Spotify?", {
              defaultYes: false,
            })
          } catch {
            approved = false
          }
          if (approved) {
            const applied = await ctx.runtime.run(spicetifyPath, ["apply"], {
              timeoutMs: OPERATION_TIMEOUTS.spicetifyApply,
            })
            if (applied.code === 0) {
              ui.bullet("Ran spicetify apply to finish removing the bridge from Spotify.")
            } else {
              ui.warn(`spicetify apply did not complete: ${sanitizeDetail(applied.error ?? applied.stderr ?? "unknown error")}. Run spicetify apply manually, then restart Spotify.`)
            }
          }
        }
      }
    } else {
      ui.bullet("Spicetify was not detected, so no registration entry was edited. If Spicetify is installed later, make sure opencode-spotify-bridge.js is not listed in its extensions.")
    }
  }
  ui.bullet("To reinstall later, run setup again. Existing pinned credentials may be reused if not removed.")
  return residuals.size ? 1 : 0
}

// ---------------------------------------------------------------------------
// Complete permanent removal
// ---------------------------------------------------------------------------

async function runComplete(
  ctx: OperationContext,
  deps: Required<UninstallDeps>,
  diagnosticScope: UninstallScope,
  backup: BackupAssessment,
): Promise<number> {
  const { ui } = ctx
  const detection = effectiveDetection(ctx)
  const layout = spicetifyLayout(ctx.runtime, detection.spicetify)
  const info = detection.spicetify
  const plan = spicetifyDeletionPlan(ctx, layout, backup)
  const tracked: TrackedStep[] = []
  const residuals = new Map<string, string>()
  const hints = new Map<string, UninstallComponentStatus>()
  let programVerified = plan.programAbsent

  const track = (step: PlanStep, component: Omit<UninstallComponentResult, "status">) => {
    tracked.push({ step, component: { ...component, status: "skipped" } })
  }

  const labels: Record<string, { label: string; target?: string }> = {
    "global-registration": {
      label: "Global OpenCode plugin registration",
      target: detection.opencode.plugin.spec ?? "opencode-spotify",
    },
    "bridge-extension": {
      label: "Owned Spicetify bridge extension",
      target: detection.bridge.extensionPath ?? BRIDGE_FILE,
    },
    "bridge-credentials": {
      label: "Bridge credentials and pinned Origin",
      target: bridgeConfigDir(ctx.runtime),
    },
    "spicetify-program": { label: "Spicetify installation", target: info.path ?? layout.localDir },
    "spicetify-package": {
      label: `Spicetify package owned by ${info.owner}`,
      target: info.path ?? `${info.owner} package`,
    },
    "spicetify-data": { label: "Spicetify local data and internal backups", target: layout.localDir },
    "spicetify-path": {
      label: "Exact Spicetify entries in the user PATH",
      target: layout.pathEntries.join("; "),
    },
    "spicetify-config": {
      label: "Spicetify config, Marketplace, themes and extensions",
      target: layout.configDir,
    },
  }

  // 1. Restore Spotify before any Spicetify-owned deletion. A missing or
  // incomplete backup never reaches this step; it restricts the plan instead.
  // D6: verify with the shared app-file snapshot, never spotify.path/Apps.
  if (plan.restoreNeeded) {
    const before = deps.captureApps(ctx.runtime, info)
    track({
      id: "restore-spotify",
      description: "Restore Spotify from Spicetify's validated backup and verify it before deletion (no new backup is created)",
      mutates: true,
      interrupt: "protected",
      run: async () => {
        const result = await ctx.runtime.run(info.path ?? "spicetify", ["restore"], {
          timeoutMs: OPERATION_TIMEOUTS.spicetifyApply,
        })
        const cancelled = cancellationFromResult(
          result,
          "restore-spotify",
          "The Spotify restore was stopped by cancellation after it had started: the Spotify restore did not complete, and nothing Spicetify-owned was deleted. Re-run complete removal to restore Spotify from the validated backup.",
        )
        if (cancelled) throw cancelled
        if (result.code !== 0 || result.timedOut) {
          const detail = sanitizeDetail(result.error ?? result.stderr ?? "spicetify restore failed")
          throw new Error(
            `Spotify restore failed: Spotify was NOT restored, and nothing Spicetify-owned was deleted; Spicetify config and backups were kept. Restore detail: ${detail}`,
          )
        }
        const verification = await deps.verifyRestore({
          runtime: ctx.runtime,
          detection,
          layout,
          backupXpuiSize: backup.xpuiSize ?? 0,
          backupLoginSize: backup.loginSize ?? null,
          fileSize: deps.fileSize,
          before,
        })
        if (!verification.ok) {
          throw new Error(
            `Restore verification failed: Spotify was NOT restored, and nothing Spicetify-owned was deleted; Spicetify config and backups were kept. ${verification.detail ?? "The restored Spotify files could not be verified."}`,
          )
        }
      },
    }, {
      id: "spotify-restore",
      label: "Spotify restore (prerequisite)",
    })
  } else if (backup.state === "valid" && plan.programAbsent) {
    ui.warn("Spicetify is already absent, so no Spotify restore could be run; Spotify's restore state is unverified and the validated backup payload is preserved.")
  } else if (backup.state === "missing" && (safeDirectoryExists(ctx.runtime, layout.localDir) || safeDirectoryExists(ctx.runtime, layout.configDir) || info.available)) {
    ui.warn("No Spicetify backup was found: Spotify's restore state is UNKNOWN. Spicetify program, config, Marketplace, themes, extensions and backups will be preserved.")
  } else if (backup.state !== "valid" && (safeDirectoryExists(ctx.runtime, layout.localDir) || safeDirectoryExists(ctx.runtime, layout.configDir) || info.available)) {
    // Incomplete/unknown is blocked by the caller; keep a defensive note.
    ui.warn(`Spicetify backup is ${backup.state}; Spicetify-owned files will be preserved.`)
  }

  // 2. Mode-1 owned state.
  if (detection.opencode.plugin.registered) {
    track({
      id: "remove-global-registration",
      description: "Remove the global OpenCode registration and verify it is gone",
      mutates: true,
      interrupt: "boundary",
      run: async () => { await removeRegistrationVerified(ctx) },
    }, {
      id: "global-registration",
      label: labels["global-registration"]!.label,
      target: labels["global-registration"]!.target,
    })
  }

  const bridgePresent = detection.bridge.installed ||
    detection.bridge.extensionExists ||
    info.bridgeRegistered
  // When restore succeeded (planned) and the full Spicetify config plus
  // credentials wipe is planned, the bridge file and its registration live
  // inside the config directory being deleted, so the redundant
  // install-extension.ps1 -Uninstall PowerShell step is skipped. The bridge
  // removal is then covered by the spicetify-config deletion below.
  const fullWipePlanned = plan.configDeletion && detection.bridge.configExists
  const skipBridgeUninstall = plan.restoreNeeded && fullWipePlanned
  if (bridgePresent && !skipBridgeUninstall) {
    if (info.available) {
      track({
        id: "remove-bridge",
        description: "Remove the owned bridge extension and its Spicetify registration",
        mutates: true,
        interrupt: "boundary",
        run: async () => {
          const result = await bridgeOperation(ctx.runtime, "uninstall", {
            spicetifyPath: info.path,
            dryRun: false,
            yes: true,
          })
          assertBridgeUninstallResult(result)
        },
      }, {
        id: "bridge-extension",
        label: labels["bridge-extension"]!.label,
        target: detection.bridge.extensionPath ?? BRIDGE_FILE,
      })
    } else if (detection.bridge.extensionPath) {
      track({
        id: "remove-bridge-file",
        description: "Delete the owned bridge extension file (Spicetify is unavailable, so no registration edit is possible)",
        mutates: true,
        interrupt: "boundary",
        run: async () => {
          removeOwnedBridgeFile(ctx, deps, detection.bridge.extensionPath!)
        },
      }, {
        id: "bridge-extension",
        label: labels["bridge-extension"]!.label,
        target: detection.bridge.extensionPath,
      })
    } else {
      residuals.set("bridge-extension", "Spicetify was not detected, so the owned extension could not be located safely.")
    }
  }

  // 3. Owned credentials (complete removal is the explicit confirmation).
  if (detection.bridge.configExists) {
    track({
      id: "remove-credentials",
      description: "Delete the owned bridge credentials and pinned Origin (irreversible)",
      mutates: true,
      interrupt: "boundary",
      run: async () => {
        const result = await removeCredentials(ctx.runtime)
        assertCredentialsRemoved(result)
        const leftovers = credentialBackupFiles(ctx.runtime)
        if (leftovers.length) {
          throw new Error("Secret-bearing credential backups are still present in the credential directory.")
        }
      },
    }, {
      id: "bridge-credentials",
      label: labels["bridge-credentials"]!.label,
      target: labels["bridge-credentials"]!.target,
    })
  }

  // 4. Spicetify program: only with a validated, successfully restored backup.
  const localDataStep = () => track({
    id: "remove-spicetify-data",
    description: `Delete Spicetify local data and internal backups at ${layout.localDir} (only after the package removal is verified)`,
    mutates: true,
    interrupt: "boundary",
    run: async () => {
      if (!programVerified) {
        residuals.set("spicetify-data", "Kept because the Spicetify package removal was not verified.")
        return
      }
      removeOwnedDirectory(ctx, deps, layout.localDir, [layout.localDir], "Spicetify local data directory")
    },
  }, {
    id: "spicetify-data",
    label: labels["spicetify-data"]!.label,
    target: layout.localDir,
  })

  if (plan.programDeletion) {
    if (plan.scriptInside) {
      track({
        id: "remove-spicetify-program",
        description: `Delete the Spicetify program directory ${layout.localDir} (validated spicetify-owned path; no backups are created)`,
        mutates: true,
        interrupt: "boundary",
        run: async () => {
          removeOwnedDirectory(ctx, deps, layout.localDir, [layout.localDir], "Spicetify program directory")
          programVerified = true
        },
      }, {
        id: "spicetify-program",
        label: labels["spicetify-program"]!.label,
        target: layout.localDir,
      })
    } else if (plan.managerOwned) {
      track({
        id: "remove-spicetify-package",
        description: `Remove the ${info.owner}-owned Spicetify package through ${info.owner}, then verify it is gone (never deleted manually)`,
        mutates: true,
        // D10/cancellation: the owner manager may already be mutating; finish
        // it and verify rather than interrupting mid-removal.
        interrupt: "protected",
        run: async () => {
          const result = await removeSpicetifyPackage(ctx.runtime, info)
          if (result.cancelled) {
            throw new OperationCancelled(
              "remove-spicetify-package",
              result.detail ??
                "The Spicetify package removal was stopped by cancellation after it had started; the package and its state are unverified, so nothing else was deleted.",
            )
          }
          if (result.status === "removed") {
            programVerified = true
            return
          }
          residuals.set(
            "spicetify-package",
            result.detail ?? `${info.owner} reported ${result.status}; the package is not considered removed.`,
          )
        },
      }, {
        id: "spicetify-package",
        label: labels["spicetify-package"]!.label,
        target: info.path ?? `${info.owner} package`,
      })
    }
  } else if (plan.canDelete && !plan.programAbsent && info.available) {
    residuals.set(
      "spicetify-program",
      `Spicetify ownership or path is uncertain at ${info.path ?? "an unresolved path"}; nothing under ${layout.localDir} or ${layout.configDir} was deleted. Remove it with the tool that installed it, then rerun uninstall.`,
    )
  }

  if (plan.localDataDeletion && !plan.scriptInside) {
    localDataStep()
  }

  if (plan.scriptInside) {
    track({
      id: "remove-spicetify-path",
      description: `Remove the exact Spicetify entries from the user PATH (${layout.pathEntries.join(", ")}), preserving every other entry`,
      mutates: true,
      interrupt: "boundary",
      run: async () => {
        const result = await removeUserPathEntries(ctx.runtime, layout.pathEntries)
        const cancelled = cancellationFromResult(
          result,
          "remove-spicetify-path",
          result.error ??
            "The user PATH update was stopped by cancellation after it had started; verify the PATH entries before retrying.",
        )
        if (cancelled) throw cancelled
        if (result.code !== 0) {
          residuals.set("spicetify-path", sanitizeDetail(result.error ?? "could not update the user PATH"))
          return
        }
        if (!result.removedPaths?.length) {
          hints.set("spicetify-path", "absent")
        }
      },
    }, {
      id: "spicetify-path",
      label: labels["spicetify-path"]!.label,
      target: labels["spicetify-path"]!.target,
    })
  }

  // 5. Config, Marketplace, themes and extensions. Deleted only after a
  // validated restore AND a verified program removal; otherwise kept with
  // manual guidance. Never delete Backup unless the restore succeeded above.
  if (plan.configDeletion) {
    track({
      id: "remove-spicetify-config",
      description: `Delete Spicetify config, Marketplace, themes and extensions at ${layout.configDir} (only after the program removal is verified)`,
      mutates: true,
      interrupt: "boundary",
      run: async () => {
        if (!programVerified) {
          residuals.set(
            "spicetify-config",
            "Kept because the Spicetify program removal was not verified. Restore/remove Spicetify manually, then rerun uninstall.",
          )
          return
        }
        removeOwnedDirectory(ctx, deps, layout.configDir, [layout.configDir], "Spicetify config directory")
      },
    }, {
      id: "spicetify-config",
      label: labels["spicetify-config"]!.label,
      target: layout.configDir,
    })
  }

  // D2/D9: dry-run stops before any summary and before residual reporting.
  if (!tracked.length) {
    if (ctx.options.dryRun) return 0
    const remainingManual = diagnosticScope.manualChecks
    if (!residuals.size && !remainingManual.length) {
      renderUninstallResult(ui, { mode: "complete", components: [] })
      return 0
    }
    const components = buildComponents([], residuals, { status: "completed", completed: [], skipped: [] }, labels)
    components.push(...manualCheckComponents(remainingManual))
    renderUninstallResult(ui, {
      mode: "complete",
      components,
      notes: [
        "No automatic removal step was planned, but work remains. Clear the manual checks above before treating removal as complete.",
        "Spotify Desktop, its account data, downloads and playlists were never touched.",
      ],
    })
    return 1
  }

  if (ctx.options.dryRun) {
    await executePlan(ctx, "Complete removal plan", tracked.map((item) => item.step), { approved: true })
    return 0
  }

  const outcome = await runTrackedPlan(ctx, "Complete removal plan", tracked.map((item) => item.step), {
    approved: true,
  })

  const components = buildComponents(tracked, residuals, outcome, labels, hints)
  const visible = components.filter((component) => component.id !== "spotify-restore" || component.status === "failed")
  const restoreCompleted = outcome.completed.includes("restore-spotify")
  const restoreFailed = outcome.failed === "restore-spotify"
  const restoreInterrupted = outcome.uncertain === "restore-spotify"
  const deletedAny = visible.some((component) => component.status === "removed")

  // D4: restore statements come from the actual outcome, never from the
  // presence of a validated backup.
  const notes: string[] = []
  if (restoreCompleted) {
    notes.push(
      deletedAny
        ? "Spotify was restored from the validated backup and the restore was verified before Spicetify-owned data was deleted."
        : "Spotify was restored from the validated backup and the restore was verified.",
    )
  } else if (restoreFailed) {
    notes.push(
      "Spotify was NOT restored, and nothing Spicetify-owned was deleted. Spicetify config and backups were kept; resolve the restore error, then retry complete removal.",
    )
  } else if (restoreInterrupted) {
    notes.push(
      "Spotify restore did not complete because cancellation stopped it after it started: Spotify was NOT verified as restored, and nothing Spicetify-owned was deleted. The validated backup was kept; rerun complete removal to restore Spotify.",
    )
  } else if (plan.restoreNeeded) {
    notes.push(
      "Spotify was NOT restored (the restore step did not complete), so no Spicetify-owned data is claimed as safely deletable.",
    )
  } else if (backup.state === "valid" && plan.programAbsent) {
    notes.push(
      "Spicetify was already absent, so no Spotify restore was run and Spotify's restore state is unverified, not 'unmodified'. The validated backup payload is preserved (deleting it without a restore would remove the only recovery path).",
    )
  } else if (backup.state === "missing") {
    notes.push(
      "No Spicetify backup was found: the Spotify restore state is UNKNOWN, not 'unmodified'. Spicetify program/config/Marketplace/themes/extensions/backups were preserved. Restore Spotify manually, then rerun complete removal.",
    )
  } else {
    notes.push(
      `Spicetify backup is ${backup.state}: ${backup.problems.join(" ") || "unvalidated"}. Spicetify config and backups were preserved.`,
    )
  }

  // D5: state exactly what this run deleted and what it kept.
  const removedLabels = visible.filter((component) => component.status === "removed").map((component) => component.label)
  notes.push(
    removedLabels.length
      ? `Deleted in this run: ${removedLabels.join(", ")}.`
      : "Nothing was deleted in this run.",
  )
  const kept: string[] = []
  if (!plan.programDeletion && !plan.localDataDeletion) kept.push("the Spicetify program and local data")
  if (!plan.configDeletion) kept.push("Spicetify config, Marketplace, themes and extensions")
  if (!plan.backupsDeletion) kept.push("Spicetify and installer backups")
  if (kept.length) notes.push(`Kept in this run: ${kept.join(", ")}.`)
  notes.push("Spotify Desktop, its account data, downloads and playlists were never touched.")
  notes.push("OpenCode CLI, settings, history and project/repo registration were preserved.")
  notes.push("No new recovery backup was created.")
  if (outcome.status === "cancelled") {
    const notice = cancellationNotice(tracked, outcome)
    if (notice) notes.push(notice)
  }
  if (remainingComponents({ mode: "complete", components: visible }).length) {
    notes.push("Rerun `npx opencode-spotify uninstall` to retry the remaining items. If the plugin/bridge is still needed, run `npx opencode-spotify repair`.")
  }
  for (const check of diagnosticScope.manualChecks) notes.push(check)

  renderUninstallResult(ui, { mode: "complete", components: visible, notes })

  if (outcome.status === "cancelled") {
    settleCancellation(ctx, outcome.completed.length)
    return 130
  }
  if (outcome.status === "failed" || restoreFailed) return 1
  return remainingComponents({ mode: "complete", components: visible }).length ? 1 : 0
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Remove owned state. Defaults to plugin-only; complete removal is only
 * selected explicitly (menu, --complete, or OPENCODE_SPOTIFY_UNINSTALL=complete)
 * and, when interactive, requires typing UNINSTALL.
 */
export async function runUninstall(ctx: OperationContext, deps: UninstallDeps = {}): Promise<number> {
  const { ui, detection } = ctx
  if (!detection.windows) {
    ui.error("Uninstall is supported on Windows only. No changes were made.")
    return 1
  }
  const resolved = resolveDeps(ctx.runtime, deps)
  const flagComplete = ctx.options.complete === true
  const envComplete = isEnvCompleteRequested(ctx.runtime)
  const completeRequested = flagComplete || envComplete
  let mode: UninstallMode = completeRequested ? "complete" : "plugin-only"

  // Destructive mode is never a default. With --yes, plugin-only is the
  // documented default; complete removal still needs --complete or the
  // documented env signal.
  if (!ctx.options.dryRun && !completeRequested && !ctx.options.yes && !ctx.options.nonInteractive) {
    const selected = await selectUninstallMode(ctx.prompt)
    if (selected === "back" || selected === "cancelled") {
      renderUninstallExit(ui, selected)
      return 130
    }
    mode = selected
  }

  // P2-11: noninteractive complete removal needs all three explicit signals.
  // D16: a dry-run changes nothing, so it never needs --yes.
  if (mode === "complete" && ctx.options.nonInteractive && !ctx.options.dryRun) {
    if (!completeRequested || !ctx.options.yes || !ctx.options.nonInteractive) {
      ui.error(
        "Complete permanent removal requires explicit noninteractive authorization: pass --complete (or set OPENCODE_SPOTIFY_UNINSTALL=complete; aliases all/everything), plus --non-interactive AND --yes. No changes were made.",
      )
      return 2
    }
  }
  const completeAuthorization = flagComplete
    ? "--complete + --non-interactive + --yes"
    : envComplete
      ? "OPENCODE_SPOTIFY_UNINSTALL=complete + --non-interactive + --yes"
      : "typed UNINSTALL"

  const layout = spicetifyLayout(ctx.runtime, detection.spicetify)
  const spicetifyPresent = detection.spicetify.available ||
    ctx.runtime.exists(layout.localDir) || ctx.runtime.exists(layout.configDir) ||
    detection.bridge.installed || detection.bridge.extensionExists

  if (mode === "plugin-only") return runPluginOnly(ctx, resolved)

  const backup = await assessBackup(ctx.runtime, layout, resolved, detection.spicetify)

  if (spicetifyPresent && (backup.state === "incomplete" || backup.state === "unknown") && !ctx.options.dryRun) {
    ui.error(`Complete removal is blocked: the Spicetify backup is ${backup.state} (${backup.problems.join(" ") || "could not be validated"}). Nothing was deleted; Spicetify config and backups were kept.`)
    ui.bullet("Restore Spotify manually with Spicetify's backup, verify xpui.spa and login.spa, then rerun complete removal. Spotify itself is never removed.")
    return 1
  }

  // Complete removal: show the exact scope and require the typed phrase.
  const scope = completeScope(
    buildUninstallScope("complete", inventoryFor(ctx, layout, effectiveDetection(ctx))),
    ctx,
    layout,
    backup,
    spicetifyPresent,
  )
  if (ctx.options.dryRun) {
    renderUninstallScope(ui, scope)
    return runComplete(ctx, resolved, scope, backup)
  }
  if (ctx.options.nonInteractive) {
    // Echo the exact deletion and preservation lists before executing, for
    // both the --complete flag and the env-var authorization path.
    renderUninstallScope(ui, scope)
    ui.kv("Authorization", completeAuthorization)
    return runComplete(ctx, resolved, scope, backup)
  }

  for (;;) {
    const consent = await confirmCompleteRemoval(ctx.prompt, ui, scope)
    if (consent === "confirmed") return runComplete(ctx, resolved, scope, backup)
    if (consent === "back") {
      const selected = await selectUninstallMode(ctx.prompt)
      if (selected === "plugin-only") return runPluginOnly(ctx, resolved)
      if (selected === "complete") continue
      renderUninstallExit(ui, selected)
      return 130
    }
    return 130
  }
}
