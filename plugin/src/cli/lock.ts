// Installer mutual exclusion + stale-lock recovery (F0/I6).
//
// The lock lives in a per-user state directory:
//   Windows: %LOCALAPPDATA%\opencode-spotify\installer.lock
//   POSIX:   $XDG_STATE_HOME/opencode-spotify/installer.lock (or ~/.local/state)
//
// Creation is single-step and atomic on Windows: `open(..., "wx")`, one
// `writeSync`, `fsync`, `close`. Temp-file + rename is deliberately NOT used
// because rename replaces an existing lock file on Windows and would silently
// steal the lock from a live installer.
//
// Staleness rules (I6):
//   - malformed content            -> held during startup grace, then stale
//                                     (reclaimable)
//   - owner host mismatch          -> stale
//   - startup grace                -> held, even when liveness is unknown
//   - owner pid gone (ESRCH)       -> stale after deadOwnerGraceMs
//   - owner alive + matching start -> NEVER stale (heartbeat age is irrelevant)
//   - owner alive + start mismatch -> stale (pid reuse)
//   - unverifiable owner           -> stale only after heartbeat staleMs
//   - permission errors (EPERM)    -> never stale
//
// Reclaiming is serialized with `installer.lock.reclaim` (also `wx`). The
// current lock is re-read and its nonce compared immediately before unlink,
// so two installers cannot both decide to delete/replace the same lock.

import { execFile } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeSync,
} from "node:fs"
import { homedir, hostname } from "node:os"
import { dirname, join, posix, win32 } from "node:path"

export const INSTALLER_LOCK_SCHEMA_VERSION = 1 as const
export const INSTALLER_LOCK_FILE = "installer.lock"
export const INSTALLER_LOCK_DIR = "opencode-spotify"

export interface InstallerLockContent {
  schemaVersion: 1
  pid: number
  /** Epoch milliseconds when the lock file was created. */
  startedAt: number
  /** Owner process start time (epoch ms), or null when it could not be probed. */
  processStartTime: number | null
  /** Installer command name only (never argv, never secrets). */
  command: string
  host: string
  nonce: string
}

export type InstallerLockStatus = "absent" | "held" | "stale" | "malformed" | "unknown"

export interface InstallerLockInspection {
  path: string
  status: InstallerLockStatus
  reason: string
  content?: InstallerLockContent
  pid?: number
  /** Last heartbeat is the lock file mtime; heartbeat uses utimes(). */
  lastHeartbeatAt?: number
  ageMs?: number
  heartbeatAgeMs?: number
}

export type StartTimeProbe = (pid: number) => number | null | Promise<number | null>

export interface InstallerLockOptions {
  lockPath?: string
  /** Installer command name written to the lock (no argv). */
  command?: string
  heartbeatMs?: number
  staleMs?: number
  startupGraceMs?: number
  deadOwnerGraceMs?: number
  startTimeToleranceMs?: number
  /** inspect(): when true, probe pid liveness/start time (can spawn pwsh). Default false. */
  probeProcess?: boolean
  now?: () => number
  pid?: number
  host?: string
  isProcessAlive?: (pid: number) => boolean
  processStartTime?: StartTimeProbe
  sleep?: (ms: number) => Promise<void>
  randomNonce?: () => string
  /** Set false in short-lived embeddings/tests that must not hold the process open. */
  registerExitHook?: boolean
}

export const INSTALLER_LOCK_DEFAULTS = {
  heartbeatMs: 30_000,
  staleMs: 5 * 60_000,
  startupGraceMs: 10_000,
  deadOwnerGraceMs: 5_000,
  startTimeToleranceMs: 2_000,
} as const

export class InstallerLockBusyError extends Error {
  readonly code = "E_LOCK_BUSY"
  readonly inspection: InstallerLockInspection

  constructor(inspection: InstallerLockInspection) {
    const owner = inspection.content?.pid
    super(owner
      ? `Another installer (pid ${owner}) holds the installer lock: ${inspection.reason}`
      : `Another installer holds the installer lock: ${inspection.reason}`)
    this.name = "InstallerLockBusyError"
    this.inspection = inspection
  }
}

export class InstallerLockLostError extends Error {
  readonly code = "E_LOCK_LOST"
  readonly path: string

  constructor(path: string, message = "The installer lock is no longer held by this process") {
    super(message)
    this.name = "InstallerLockLostError"
    this.path = path
  }
}

export interface InstallerLock {
  readonly path: string
  readonly content: InstallerLockContent
  readonly nonce: string
  /** Idempotent, nonce-checked. Throws InstallerLockLostError on ownership mismatch. */
  release(): Promise<void>
  /** Throws InstallerLockLostError unless the on-disk nonce still matches. */
  assertHeld(): Promise<InstallerLockContent>
  isHeld(): Promise<boolean>
}

export interface InstallerLockPathInput {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  home?: string
}

/** Pure path resolution; never touches the filesystem. */
export function installerLockPath(input: InstallerLockPathInput = {}): string {
  const platform = input.platform ?? process.platform
  const env = input.env ?? process.env
  const home = input.home ?? homedir()
  if (platform === "win32") {
    const base = (env.LOCALAPPDATA ?? "").trim() || win32.join(home, "AppData", "Local")
    return win32.join(base, INSTALLER_LOCK_DIR, INSTALLER_LOCK_FILE)
  }
  const base = (env.XDG_STATE_HOME ?? "").trim() || posix.join(home, ".local", "state")
  return posix.join(base, INSTALLER_LOCK_DIR, INSTALLER_LOCK_FILE)
}

/** Alias kept for callers that prefer the explicit name. */
export const defaultInstallerLockPath = installerLockPath

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT"
}

/**
 * Windows can report EPERM/EBUSY while another installer is unlinking the
 * lock (or an AV scanner has it open). These are retried, never treated as a
 * stale-owner verdict.
 */
function isTransientFsError(error: unknown): boolean {
  const code = typeof error === "object" && error !== null ? (error as NodeJS.ErrnoException).code : undefined
  return code === "EPERM" || code === "EACCES" || code === "EBUSY" || code === "ENOTEMPTY"
}

function isPermissionError(error: unknown): boolean {
  const code = typeof error === "object" && error !== null ? (error as NodeJS.ErrnoException).code : undefined
  if (code === "EPERM" || code === "EACCES") return true
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : ""
  return /access (is )?denied|permission denied|unauthorizedaccess/i.test(message)
}

/**
 * `process.kill(pid, 0)` liveness probe. EPERM means "alive but not ours";
 * other errors are rethrown so callers can classify them as unverifiable.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (isPermissionError(error)) return true
    if (typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ESRCH") return false
    throw error
  }
}

function execFileText(file: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string; error?: Error }> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
      resolve({
        code: error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : null) : 0,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? ""),
        ...(error ? { error } : {}),
      })
    })
  })
}

/**
 * Absolute PowerShell candidates. Never PATH-resolved: the start-time probe runs
 * on every mutating command, and Windows searches the CWD first.
 */
function systemShells(): string[] {
  const root = process.env.SystemRoot || process.env.windir || "C:\\Windows"
  const programFiles = process.env.ProgramFiles || "C:\\Program Files"
  const candidates = [
    join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    join(programFiles, "PowerShell", "7", "pwsh.exe"),
    join(programFiles, "PowerShell", "6", "pwsh.exe"),
  ]
  return candidates.filter((candidate) => {
    try { return existsSync(candidate) } catch { return false }
  })
}

/**
 * Read the owner process start time via `Get-Process`. The pid is validated as
 * a positive integer before it is interpolated into the command. Returns null
 * when the probe is unavailable (non-Windows, no PowerShell, no such process).
 */
export async function probeProcessStartTime(pid: number, options: { timeoutMs?: number } = {}): Promise<number | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null
  if (process.platform !== "win32") return null
  const timeoutMs = options.timeoutMs ?? 5_000
  const script = `([DateTimeOffset](Get-Process -Id ${pid} -ErrorAction Stop).StartTime).ToUnixTimeMilliseconds()`
  let lastError: Error | undefined
  for (const shell of systemShells()) {
    const result = await execFileText(shell, ["-NoProfile", "-NonInteractive", "-Command", script], timeoutMs)
    if (result.code === 0) {
      const match = result.stdout.match(/(\d{12,})/)
      if (match) {
        const value = Number(match[1])
        if (Number.isFinite(value) && value > 0) return value
      }
      return null
    }
    const combined = `${result.stdout}\n${result.stderr}\n${result.error?.message ?? ""}`
    if (/access (is )?denied|permission denied|unauthorizedaccess/i.test(combined)) {
      const denied = Object.assign(new Error("access denied while probing process start time"), { code: "EPERM" })
      throw denied
    }
    lastError = result.error
    if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") continue
  }
  void lastError
  return null
}

function parseContent(raw: string): InstallerLockContent | undefined {
  let value: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined
    value = parsed as Record<string, unknown>
  } catch {
    return undefined
  }
  if (value.schemaVersion !== INSTALLER_LOCK_SCHEMA_VERSION) return undefined
  if (typeof value.pid !== "number" || !Number.isInteger(value.pid) || value.pid <= 0) return undefined
  if (typeof value.startedAt !== "number" || !Number.isFinite(value.startedAt)) return undefined
  if (!(value.processStartTime === null || (typeof value.processStartTime === "number" && Number.isFinite(value.processStartTime)))) return undefined
  if (typeof value.command !== "string" || value.command.length === 0) return undefined
  if (typeof value.host !== "string" || value.host.length === 0) return undefined
  if (typeof value.nonce !== "string" || value.nonce.length < 8) return undefined
  return {
    schemaVersion: INSTALLER_LOCK_SCHEMA_VERSION,
    pid: value.pid,
    startedAt: value.startedAt,
    processStartTime: value.processStartTime as number | null,
    command: value.command,
    host: value.host,
    nonce: value.nonce,
  }
}

interface LockFileRead {
  raw: string
  mtimeMs: number
  content?: InstallerLockContent
}

/** Read-only; returns undefined only for ENOENT. */
function readLockFile(path: string): LockFileRead | undefined {
  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch (error) {
    if (isNotFound(error)) return undefined
    throw error
  }
  let mtimeMs: number
  try {
    mtimeMs = statSync(path).mtimeMs
  } catch (error) {
    if (isNotFound(error)) return undefined
    throw error
  }
  return { raw, mtimeMs, content: parseContent(raw) }
}

function tokenFor(read: LockFileRead): string {
  if (read.content) return `nonce:${read.content.nonce}`
  return `raw:${createHash("sha256").update(read.raw).digest("hex")}`
}

/**
 * Reclaim-guard content. The guard is short-lived serialization around stale
 * deletion; it records a nonce so recovery can compare-and-unlink the exact
 * file it inspected, and a start time so a reused pid is not mistaken for a
 * live guard holder (H5).
 */
interface ReclaimGuardContent {
  pid: number
  at: number
  nonce: string
  processStartTime: number | null
}

interface ReclaimGuardRead {
  raw: string
  mtimeMs: number
  content?: ReclaimGuardContent
}

function parseGuardContent(raw: string): ReclaimGuardContent | undefined {
  let value: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined
    value = parsed as Record<string, unknown>
  } catch {
    return undefined
  }
  if (typeof value.pid !== "number" || !Number.isInteger(value.pid) || value.pid <= 0) return undefined
  if (typeof value.at !== "number" || !Number.isFinite(value.at)) return undefined
  if (typeof value.nonce !== "string" || value.nonce.length < 8) return undefined
  const start = value.processStartTime
  if (!(start === null || start === undefined || (typeof start === "number" && Number.isFinite(start)))) return undefined
  return {
    pid: value.pid,
    at: value.at,
    nonce: value.nonce,
    processStartTime: typeof start === "number" ? start : null,
  }
}

function readGuardFile(path: string): ReclaimGuardRead | undefined {
  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch (error) {
    if (isNotFound(error)) return undefined
    throw error
  }
  let mtimeMs: number
  try {
    mtimeMs = statSync(path).mtimeMs
  } catch (error) {
    if (isNotFound(error)) return undefined
    throw error
  }
  return { raw, mtimeMs, content: parseGuardContent(raw) }
}

/** Nonce for a parseable guard, raw hash for old/malformed guards. */
function guardToken(read: ReclaimGuardRead): string {
  if (read.content) return `nonce:${read.content.nonce}`
  return `raw:${createHash("sha256").update(read.raw).digest("hex")}`
}

type ResolvedOptions = ReturnType<typeof optionDefaults>

async function readLockFileWithRetry(path: string, opts: ResolvedOptions, attempts = 5): Promise<LockFileRead | undefined> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return readLockFile(path)
    } catch (error) {
      if (!isTransientFsError(error) || attempt === attempts - 1) throw error
      await opts.sleep(10)
    }
  }
  return undefined
}

async function unlinkWithRetry(path: string, opts: ResolvedOptions, attempts = 6): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      unlinkSync(path)
      return
    } catch (error) {
      if (isNotFound(error)) return
      if (!isTransientFsError(error) || attempt === attempts - 1) throw error
      await opts.sleep(15)
    }
  }
}

function optionDefaults(options: InstallerLockOptions) {
  return {
    lockPath: options.lockPath ?? installerLockPath(),
    command: options.command ?? "unknown",
    heartbeatMs: options.heartbeatMs ?? INSTALLER_LOCK_DEFAULTS.heartbeatMs,
    staleMs: options.staleMs ?? INSTALLER_LOCK_DEFAULTS.staleMs,
    startupGraceMs: options.startupGraceMs ?? INSTALLER_LOCK_DEFAULTS.startupGraceMs,
    deadOwnerGraceMs: options.deadOwnerGraceMs ?? INSTALLER_LOCK_DEFAULTS.deadOwnerGraceMs,
    startTimeToleranceMs: options.startTimeToleranceMs ?? INSTALLER_LOCK_DEFAULTS.startTimeToleranceMs,
    now: options.now ?? Date.now,
    pid: options.pid ?? process.pid,
    host: options.host ?? hostname(),
    isProcessAlive: options.isProcessAlive ?? isProcessAlive,
    processStartTime: options.processStartTime ?? probeProcessStartTime,
    sleep: options.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms) })),
    randomNonce: options.randomNonce ?? (() => randomBytes(16).toString("hex")),
    // The exit hook must not unlink a lock while owned children may still be
    // mutating. Normal completion releases via main's finally; hard crashes are
    // recovered by stale-lock rules instead.
    registerExitHook: options.registerExitHook ?? false,
  }
}

/**
 * Read-only lock inspection. Never creates directories and never removes
 * anything. `probeProcess` defaults to false, so a plain inspect only reads
 * content/heartbeat age and cannot block on PowerShell.
 */
export async function inspectInstallerLock(options: InstallerLockOptions = {}): Promise<InstallerLockInspection> {
  const opts = optionDefaults(options)
  let read: LockFileRead | undefined
  try {
    read = readLockFile(opts.lockPath)
  } catch (error) {
    if (isTransientFsError(error)) {
      return {
        path: opts.lockPath,
        status: "unknown",
        reason: "lock file is temporarily unreadable (another installer is updating it)",
      }
    }
    throw error
  }
  if (!read) return { path: opts.lockPath, status: "absent", reason: "no lock file" }
  const heartbeatAgeMs = Math.max(0, opts.now() - read.mtimeMs)
  if (!read.content) {
    // A just-created lock is legitimately empty between `wx` create and the
    // first write; treat that window as held, not reclaimable.
    if (heartbeatAgeMs < opts.startupGraceMs) {
      return {
        path: opts.lockPath,
        status: "held",
        reason: "lock is initializing (created moments ago)",
        lastHeartbeatAt: read.mtimeMs,
        heartbeatAgeMs,
      }
    }
    return {
      path: opts.lockPath,
      status: "malformed",
      reason: "lock content is malformed",
      lastHeartbeatAt: read.mtimeMs,
      heartbeatAgeMs,
    }
  }
  const content = read.content
  const ageMs = Math.max(0, opts.now() - content.startedAt)
  const base = {
    path: opts.lockPath,
    content,
    pid: content.pid,
    lastHeartbeatAt: read.mtimeMs,
    ageMs,
    heartbeatAgeMs,
  }
  const held = (reason: string): InstallerLockInspection => ({ ...base, status: "held", reason })
  const stale = (reason: string): InstallerLockInspection => ({ ...base, status: "stale", reason })

  if (content.host !== opts.host) return stale("lock belongs to another host")
  if (ageMs < opts.startupGraceMs) return held("startup grace period")

  if (options.probeProcess !== true) {
    return heartbeatAgeMs > opts.staleMs ? stale("heartbeat expired") : held("owner unverified; heartbeat is fresh")
  }

  let alive: boolean | "unknown"
  try {
    alive = opts.isProcessAlive(content.pid)
  } catch (error) {
    if (isPermissionError(error)) return held("process liveness is permission-protected; not reclaiming")
    alive = "unknown"
  }

  if (alive === false) {
    if (ageMs < opts.deadOwnerGraceMs) return held("owner exited within the dead-owner grace period")
    return stale("owner process is not running")
  }
  if (alive === "unknown") {
    return heartbeatAgeMs > opts.staleMs ? stale("owner unverifiable and heartbeat expired") : held("owner unverifiable; heartbeat is fresh")
  }

  let startTime: number | null
  try {
    startTime = await opts.processStartTime(content.pid)
  } catch (error) {
    if (isPermissionError(error)) return held("process start time is permission-protected; not reclaiming")
    startTime = null
  }

  if (content.processStartTime !== null && typeof startTime === "number") {
    if (Math.abs(startTime - content.processStartTime) > opts.startTimeToleranceMs) {
      return stale("pid was reused by a different process")
    }
    return held("owner is alive and its start time matches")
  }

  return heartbeatAgeMs > opts.staleMs ? stale("owner unverifiable and heartbeat expired") : held("owner alive; start time unverifiable, heartbeat is fresh")
}

interface LockHandleState {
  path: string
  nonce: string
}

const activeLocks = new Set<LockHandleState>()
let exitHookInstalled = false

function installExitHook(): void {
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.once("exit", () => {
    for (const state of [...activeLocks]) {
      try {
        const read = readLockFile(state.path)
        if (read?.content?.nonce === state.nonce) unlinkSync(state.path)
      } catch { /* best effort on shutdown */ }
    }
  })
}

function createLockHandle(
  path: string,
  content: InstallerLockContent,
  opts: ReturnType<typeof optionDefaults>,
): InstallerLock {
  const state: LockHandleState = { path, nonce: content.nonce }
  let released = false
  let heartbeat: ReturnType<typeof setInterval> | undefined

  const stopHeartbeat = () => {
    if (heartbeat !== undefined) {
      clearInterval(heartbeat)
      heartbeat = undefined
    }
  }

  activeLocks.add(state)
  if (opts.registerExitHook) installExitHook()

  if (opts.heartbeatMs > 0) {
    heartbeat = setInterval(() => {
      if (released) return
      try {
        const read = readLockFile(path)
        if (!read?.content || read.content.nonce !== content.nonce) {
          stopHeartbeat()
          return
        }
        const stamp = new Date(opts.now())
        utimesSync(path, stamp, stamp)
      } catch { /* a transient failure must not crash the installer */ }
    }, opts.heartbeatMs)
    heartbeat.unref?.()
  }

  const lock: InstallerLock = {
    path,
    content,
    nonce: content.nonce,
    async release(): Promise<void> {
      if (released) return
      released = true
      stopHeartbeat()
      activeLocks.delete(state)
      const read = await readLockFileWithRetry(path, opts)
      if (!read) return
      if (!read.content) throw new InstallerLockLostError(path, "lock content is no longer valid")
      if (read.content.nonce !== content.nonce) throw new InstallerLockLostError(path)
      await unlinkWithRetry(path, opts)
    },
    async assertHeld(): Promise<InstallerLockContent> {
      const read = await readLockFileWithRetry(path, opts)
      if (!read) throw new InstallerLockLostError(path, "lock file is missing")
      if (!read.content) throw new InstallerLockLostError(path, "lock content is no longer valid")
      if (read.content.nonce !== content.nonce) throw new InstallerLockLostError(path)
      return read.content
    },
    async isHeld(): Promise<boolean> {
      try {
        const read = readLockFile(path)
        return read?.content?.nonce === content.nonce
      } catch {
        return false
      }
    },
  }
  return lock
}

function tryCreate(path: string, content: InstallerLockContent): boolean {
  let fd: number
  try {
    fd = openSync(path, "wx")
  } catch (error) {
    if (typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "EEXIST") return false
    throw error
  }
  try {
    writeSync(fd, `${JSON.stringify(content)}\n`)
    fsyncSync(fd)
  } catch (error) {
    try { closeSync(fd) } catch { /* ignore */ }
    try { unlinkSync(path) } catch { /* ignore */ }
    throw error
  }
  closeSync(fd)
  return true
}

type ReclaimGuardClaim =
  | { acquired: true; nonce: string }
  | { acquired: false; reason: string }

type GuardVerdict =
  | { state: "stale"; reason: string }
  | { state: "held"; reason: string }

/**
 * Classify an existing reclaim guard. A guard is recoverable when it is older
 * than `staleMs` (the holder died or hung) or when its recorded pid is gone or
 * has been reused. A fresh guard whose owner is alive, or cannot be disproved,
 * is never broken.
 */
async function inspectReclaimGuard(read: ReclaimGuardRead, opts: ReturnType<typeof optionDefaults>): Promise<GuardVerdict> {
  const mtimeAgeMs = Math.max(0, opts.now() - read.mtimeMs)
  const recordedAgeMs = read.content ? Math.max(0, opts.now() - read.content.at) : mtimeAgeMs
  if (mtimeAgeMs > opts.staleMs || recordedAgeMs > opts.staleMs) {
    return { state: "stale", reason: "reclaim guard is older than staleMs" }
  }
  if (!read.content) return { state: "held", reason: "reclaim guard content is unreadable" }
  const content = read.content

  let alive: boolean | "unknown"
  try {
    alive = opts.isProcessAlive(content.pid)
  } catch (error) {
    if (isPermissionError(error)) return { state: "held", reason: "reclaim guard owner is permission-protected; not reclaiming" }
    alive = "unknown"
  }
  if (alive === false) return { state: "stale", reason: "reclaim guard owner process is not running" }
  if (alive === "unknown") return { state: "held", reason: "reclaim guard owner is unverifiable; the guard is fresh" }

  if (content.processStartTime !== null) {
    let startTime: number | null
    try {
      startTime = await opts.processStartTime(content.pid)
    } catch (error) {
      if (isPermissionError(error)) return { state: "held", reason: "reclaim guard owner start time is permission-protected; not reclaiming" }
      startTime = null
    }
    if (typeof startTime === "number" && Math.abs(startTime - content.processStartTime) > opts.startTimeToleranceMs) {
      return { state: "stale", reason: "reclaim guard pid was reused by a different process" }
    }
  }
  return { state: "held", reason: "reclaim guard is held by a live process" }
}

/**
 * Claim the reclaim guard (`installer.lock.reclaim`) with `wx`. Returns the
 * claim only for the single winner. When another guard exists, it is inspected
 * once: a dead/expired guard is compare-and-unlinked and creation retried once;
 * otherwise the distinct blocking reason is returned (H5). `sleep` is injected
 * so tests can avoid waiting.
 */
async function acquireReclaimGuard(
  guardPath: string,
  pid: number,
  opts: ReturnType<typeof optionDefaults>,
): Promise<ReclaimGuardClaim> {
  const content: ReclaimGuardContent = {
    pid,
    at: opts.now(),
    nonce: opts.randomNonce(),
    processStartTime: await probeStartTime(opts, pid),
  }

  const create = (): ReclaimGuardClaim | undefined => {
    let fd: number
    try {
      fd = openSync(guardPath, "wx")
    } catch (error) {
      if (typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "EEXIST") return undefined
      throw error
    }
    try {
      writeSync(fd, `${JSON.stringify(content)}\n`)
      fsyncSync(fd)
    } catch (error) {
      try { closeSync(fd) } catch { /* ignore */ }
      try { unlinkSync(guardPath) } catch { /* ignore */ }
      throw error
    }
    closeSync(fd)
    return { acquired: true, nonce: content.nonce }
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const claim = create()
    if (claim) return claim
    await opts.sleep(25)
  }

  let read: ReclaimGuardRead | undefined
  try {
    read = readGuardFile(guardPath)
  } catch (error) {
    if (isTransientFsError(error)) return { acquired: false, reason: "reclaim guard is temporarily unreadable" }
    throw error
  }
  if (!read) {
    return create() ?? { acquired: false, reason: "reclaim guard was created by another process" }
  }

  const verdict = await inspectReclaimGuard(read, opts)
  if (verdict.state !== "stale") return { acquired: false, reason: verdict.reason }

  // Compare the exact guard we judged stale immediately before unlinking; a
  // replacement guard must never be deleted by this recovery attempt.
  let current: ReclaimGuardRead | undefined
  try {
    current = readGuardFile(guardPath)
  } catch (error) {
    if (isTransientFsError(error)) return { acquired: false, reason: "reclaim guard changed while it was being recovered" }
    throw error
  }
  if (!current || guardToken(current) !== guardToken(read)) {
    return create() ?? { acquired: false, reason: "reclaim guard changed while it was being recovered" }
  }
  try {
    await unlinkWithRetry(guardPath, opts)
  } catch {
    return { acquired: false, reason: "reclaim guard could not be removed after it was found stale" }
  }
  return create() ?? { acquired: false, reason: "reclaim guard was replaced after recovery" }
}

/** Release the guard only while it still carries this claim's nonce. */
async function releaseReclaimGuard(
  guardPath: string,
  nonce: string,
  opts: ReturnType<typeof optionDefaults>,
): Promise<void> {
  try {
    const read = readGuardFile(guardPath)
    if (!read || read.content?.nonce !== nonce) return
  } catch {
    return
  }
  try {
    await unlinkWithRetry(guardPath, opts)
  } catch { /* already gone or transient */ }
}

type ReclaimResult = { reclaimed: true } | { reclaimed: false; reason?: string }

/**
 * Delete a stale lock while holding the reclaim guard. Re-reads the file and
 * compares the exact nonce (or the raw hash for malformed files) before
 * unlinking. A blocked guard returns its distinct reason so the caller can
 * report why the stale lock was not reclaimed.
 */
async function reclaimStaleLock(
  expectedToken: string,
  opts: ReturnType<typeof optionDefaults>,
): Promise<ReclaimResult> {
  const guardPath = `${opts.lockPath}.reclaim`
  const guard = await acquireReclaimGuard(guardPath, opts.pid, opts)
  if (!guard.acquired) return { reclaimed: false, reason: guard.reason }
  try {
    const read = await readLockFileWithRetry(opts.lockPath, opts)
    if (!read) return { reclaimed: true }
    if (tokenFor(read) !== expectedToken) return { reclaimed: false }
    await unlinkWithRetry(opts.lockPath, opts)
    return { reclaimed: true }
  } finally {
    await releaseReclaimGuard(guardPath, guard.nonce, opts)
  }
}

async function probeStartTime(opts: ReturnType<typeof optionDefaults>, pid: number): Promise<number | null> {
  try {
    const value = await opts.processStartTime(pid)
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null
  } catch {
    // A failed probe degrades to "unverifiable", never blocks acquisition.
    return null
  }
}

/**
 * Acquire the installer lock or throw InstallerLockBusyError. Stale locks are
 * reclaimed through the guard; a live owner is never preempted.
 */
export async function acquireInstallerLock(options: InstallerLockOptions = {}): Promise<InstallerLock> {
  const opts = optionDefaults(options)
  mkdirSync(dirname(opts.lockPath), { recursive: true })
  const content: InstallerLockContent = {
    schemaVersion: INSTALLER_LOCK_SCHEMA_VERSION,
    pid: opts.pid,
    startedAt: opts.now(),
    processStartTime: await probeStartTime(opts, opts.pid),
    command: opts.command.slice(0, 64),
    host: opts.host,
    nonce: opts.randomNonce(),
  }

  let lastInspection: InstallerLockInspection | undefined
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      if (tryCreate(opts.lockPath, content)) {
        return createLockHandle(opts.lockPath, content, opts)
      }
    } catch (error) {
      if (!isTransientFsError(error)) throw error
      await opts.sleep(15)
      continue
    }
    const inspection = await inspectInstallerLock({ ...options, lockPath: opts.lockPath, probeProcess: true })
    lastInspection = inspection
    if (inspection.status === "absent" || inspection.status === "unknown") {
      await opts.sleep(15)
      continue
    }
    if (inspection.status === "stale" || inspection.status === "malformed") {
      // Re-read before reclaiming, but only to confirm the file is still the
      // exact owner that was judged stale. Never derive the token from a newer
      // owner: a live lock created between inspect and read must be preserved.
      const read = await readLockFileWithRetry(opts.lockPath, opts)
      if (!read) continue
      let expected: string
      if (inspection.content) {
        if (!read.content || read.content.nonce !== inspection.content.nonce) continue
        expected = `nonce:${inspection.content.nonce}`
      } else {
        if (read.content) continue
        expected = tokenFor(read)
      }
      const reclaimed = await reclaimStaleLock(expected, opts)
      if (reclaimed.reclaimed) continue
      throw new InstallerLockBusyError(
        reclaimed.reason
          ? { ...inspection, reason: `stale lock reclaim is blocked: ${reclaimed.reason}` }
          : inspection,
      )
    }
    throw new InstallerLockBusyError(inspection)
  }

  throw new InstallerLockBusyError(
    lastInspection ?? { path: opts.lockPath, status: "held", reason: "lock could not be acquired after multiple attempts" },
  )
}

export interface WithInstallerLockOptions<T> {
  /** Lock acquisition options (path, heartbeat, seams, ...). */
  lock?: InstallerLockOptions
  /** Installer command name written into the lock content. */
  command?: string
  /** Optional final ownership check before mutating anything. */
  revalidate?: (lock: InstallerLock) => void | Promise<void>
  run: (lock: InstallerLock) => T | Promise<T>
}

/**
 * Acquire, optionally revalidate, run, and always release. When `run` throws,
 * the original error is preserved even if release also fails.
 */
export async function withInstallerLock<T>(options: WithInstallerLockOptions<T>): Promise<T> {
  const lock = await acquireInstallerLock({
    ...(options.lock ?? {}),
    ...(options.command ? { command: options.command } : {}),
  })
  let failed = false
  try {
    if (options.revalidate) await options.revalidate(lock)
    return await options.run(lock)
  } catch (error) {
    failed = true
    throw error
  } finally {
    try {
      await lock.release()
    } catch (error) {
      if (!failed) throw error
    }
  }
}

export async function assertInstallerLockHeld(lock: InstallerLock): Promise<InstallerLockContent> {
  return lock.assertHeld()
}

// Short aliases for call sites that already namespace the import.
export const inspect = inspectInstallerLock
export const acquire = acquireInstallerLock
