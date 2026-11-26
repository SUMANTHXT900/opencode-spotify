// Owned-child tracking and bounded termination (F0).
//
// Every child spawned by the installer should be adopted here so a cancelled
// operations can close it deterministically:
//   - Windows trees are terminated with `taskkill /PID <pid> /T /F` only for
//     pids this registry adopted. Never by image name, never a negative pid.
//   - POSIX children get SIGTERM, then SIGKILL after the grace period.
//   - `killAll` is idempotent per pid and records one CloseReport per attempt.
// Children are never spawned detached from this module.

import { spawn, type ChildProcess } from "node:child_process"
import type { CancelReason } from "./cancel.ts"
import { systemTool } from "./runtime.ts"

export type KillPolicy = "tree" | "single" | "none"

export type KillAction = "none" | "taskkill" | "sigterm" | "sigkill" | "timeout"

export interface CloseReport {
  pid: number
  label?: string
  policy: KillPolicy
  /** Human-readable cancellation reason ("ctrl-c", "shutdown", ...). */
  reason: string
  /** True only when the child's `close` event was observed inside the grace budget. */
  exitConfirmed: boolean
  graceMs: number
  at: number
  code?: number | null
  signal?: NodeJS.Signals | null
  action: KillAction
}

export interface AdoptOptions {
  label?: string
  /** Defaults to "tree": kill the whole descendant tree. */
  policy?: KillPolicy
}

export interface OwnedChild {
  /** 0 when the child never obtained a pid (spawn failure); never negative. */
  pid: number
  label?: string
  policy: KillPolicy
  /** Resolves when the child closed (or failed to spawn), never on a kill timeout. */
  closed: Promise<CloseReport>
}

export interface KillAllOptions {
  /** Defaults to 5s. */
  graceMs?: number
}

export interface ChildRegistry {
  adopt(child: ChildProcess, options?: AdoptOptions): OwnedChild
  /** Number of adopted children that have not closed yet. */
  readonly active: number
  /** One report per kill attempt, in attempt order. */
  readonly killLog: CloseReport[]
  /** Idempotent per pid. Skips `policy: "none"` children entirely. */
  killAll(reason?: CancelReason | string, options?: KillAllOptions): Promise<CloseReport[]>
  /** True when every adopted child closed before the timeout; false on timeout. */
  awaitAll(timeoutMs: number): Promise<boolean>
  /** Kill one registered child's tree. Unregistered/invalid pids are ignored. */
  killOwnedTree(pid: number, graceMs?: number): Promise<CloseReport | undefined>
}

const DEFAULT_GRACE_MS = 5_000
const TASKKILL_SLACK_MS = 2_000

interface Entry {
  child: ChildProcess
  pid: number
  label?: string
  policy: KillPolicy
  closed: Promise<CloseReport>
  resolve: (report: CloseReport) => void
  exit?: { code: number | null; signal: NodeJS.Signals | null }
  final?: CloseReport
  kill?: Promise<CloseReport>
}

function safeKill(child: ChildProcess, signal: NodeJS.Signals): boolean {
  try {
    if (child.exitCode !== null || child.signalCode !== null) return false
    return child.kill(signal)
  } catch {
    return false
  }
}

function isPositivePid(pid: number): boolean {
  return Number.isInteger(pid) && pid > 0
}

/** Run taskkill without a shell and without detached descendants. */
function runTaskkill(pid: number, tree: boolean, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    if (!isPositivePid(pid)) {
      resolve(null)
      return
    }
    const args = ["/PID", String(pid), "/T", "/F"]
    let child: ChildProcess
    try {
      // Absolute System32 path: never resolve taskkill.exe through PATH or the
      // current working directory (M6).
      child = spawn(systemTool("taskkill.exe"), tree ? args : ["/PID", String(pid), "/F"], {
        windowsHide: true,
        shell: false,
        stdio: ["ignore", "ignore", "ignore"],
      })
    } catch {
      resolve(null)
      return
    }
    let settled = false
    const finish = (code: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(code)
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* already gone */ }
      finish(null)
    }, Math.max(1, timeoutMs))
    timer.unref?.()
    child.once("error", () => finish(null))
    child.once("close", (code) => finish(code))
  })
}

function waitClose(entry: Entry, timeoutMs: number): Promise<boolean> {
  if (entry.final) return Promise.resolve(true)
  if (timeoutMs <= 0) return Promise.resolve(false)
  return new Promise((resolve) => {
    let settled = false
    const finish = (closed: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(closed)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    timer.unref?.()
    entry.closed.then(() => finish(true), () => finish(true))
  })
}

function raceWithTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T | false> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: T | false) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    timer.unref?.()
    work.then((value) => finish(value), () => finish(false))
  })
}

function makeReport(entry: Entry, reason: string, graceMs: number, action: KillAction, exitConfirmed: boolean): CloseReport {
  return {
    pid: entry.pid,
    ...(entry.label ? { label: entry.label } : {}),
    policy: entry.policy,
    reason,
    exitConfirmed,
    graceMs,
    at: Date.now(),
    ...(entry.exit ? { code: entry.exit.code, signal: entry.exit.signal } : {}),
    action,
  }
}

class ChildRegistryImpl implements ChildRegistry {
  private readonly entries = new Map<number, Entry>()
  private readonly reports: CloseReport[] = []

  get active(): number { return this.entries.size }
  get killLog(): CloseReport[] { return this.reports }

  adopt(child: ChildProcess, options: AdoptOptions = {}): OwnedChild {
    const policy = options.policy ?? "tree"
    const pid = typeof child.pid === "number" && child.pid > 0 ? child.pid : 0
    if (pid > 0 && this.entries.has(pid)) {
      throw new Error(`child pid ${pid} is already adopted`)
    }
    let resolveClosed!: (report: CloseReport) => void
    const closed = new Promise<CloseReport>((resolve) => { resolveClosed = resolve })
    const entry: Entry = {
      child,
      pid,
      label: options.label,
      policy,
      closed,
      resolve: resolveClosed,
    }
    if (pid === 0) {
      // Spawn failed before a pid existed; nothing to kill, already "closed".
      const report: CloseReport = {
        pid: 0,
        ...(entry.label ? { label: entry.label } : {}),
        policy,
        reason: "spawn-failed",
        exitConfirmed: true,
        graceMs: 0,
        at: Date.now(),
        action: "none",
      }
      entry.final = report
      entry.resolve(report)
      return { pid: 0, ...(entry.label ? { label: entry.label } : {}), policy, closed }
    }

    this.entries.set(pid, entry)
    const finalize = () => {
      if (entry.final) return
      const report: CloseReport = {
        pid,
        ...(entry.label ? { label: entry.label } : {}),
        policy,
        reason: "closed",
        exitConfirmed: true,
        graceMs: 0,
        at: Date.now(),
        ...(entry.exit ? { code: entry.exit.code, signal: entry.exit.signal } : {}),
        action: "none",
      }
      entry.final = report
      this.entries.delete(pid)
      entry.resolve(report)
    }
    child.once("close", (code, signal) => {
      entry.exit = { code: code ?? null, signal: signal ?? null }
      finalize()
    })
    child.once("error", () => {
      finalize()
    })
    return { pid, ...(entry.label ? { label: entry.label } : {}), policy, closed }
  }

  async killAll(reason: CancelReason | string = "shutdown", options: KillAllOptions = {}): Promise<CloseReport[]> {
    const graceMs = options.graceMs ?? DEFAULT_GRACE_MS
    const text = String(reason)
    const attempts: Promise<CloseReport>[] = []
    for (const entry of [...this.entries.values()]) {
      if (entry.policy === "none") continue
      if (entry.kill) continue
      attempts.push(this.killEntry(entry, text, graceMs, entry.policy))
    }
    return Promise.all(attempts)
  }

  async awaitAll(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + Math.max(0, timeoutMs)
    while (this.entries.size > 0) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) return false
      const pending = [...this.entries.values()].map((entry) => entry.closed)
      const closed = await raceWithTimeout(Promise.all(pending).then(() => true), remaining)
      if (!closed) return false
    }
    return true
  }

  async killOwnedTree(pid: number, graceMs = DEFAULT_GRACE_MS): Promise<CloseReport | undefined> {
    if (!isPositivePid(pid)) return undefined
    const entry = this.entries.get(pid)
    if (!entry) return undefined
    if (entry.kill) return entry.kill
    return this.killEntry(entry, "tree", graceMs, "tree")
  }

  private killEntry(entry: Entry, reason: string, graceMs: number, actionPolicy: KillPolicy): Promise<CloseReport> {
    if (entry.kill) return entry.kill
    const attempt = (async () => {
      const report = await this.terminate(entry, reason, graceMs, actionPolicy)
      this.reports.push(report)
      return report
    })()
    entry.kill = attempt
    return attempt
  }

  private async terminate(entry: Entry, reason: string, graceMs: number, actionPolicy: KillPolicy): Promise<CloseReport> {
    if (entry.final) return entry.final
    // policy "none" never reaches here; treat defensively.
    if (entry.policy === "none" && actionPolicy !== "tree") return makeReport(entry, reason, graceMs, "none", entry.exit !== undefined)

    if (process.platform === "win32" && actionPolicy === "tree") {
      await runTaskkill(entry.pid, true, graceMs + TASKKILL_SLACK_MS)
      if (await waitClose(entry, graceMs)) return makeReport(entry, reason, graceMs, "taskkill", true)
      return makeReport(entry, reason, graceMs, "timeout", false)
    }

    const termSent = safeKill(entry.child, "SIGTERM")
    if (termSent && await waitClose(entry, graceMs)) {
      return makeReport(entry, reason, graceMs, "sigterm", true)
    }

    safeKill(entry.child, "SIGKILL")
    if (await waitClose(entry, graceMs)) {
      return makeReport(entry, reason, graceMs, "sigkill", true)
    }

    if (process.platform === "win32") {
      // Last resort for a single pid (never by image name).
      await runTaskkill(entry.pid, false, graceMs + TASKKILL_SLACK_MS)
      if (await waitClose(entry, graceMs)) return makeReport(entry, reason, graceMs, "taskkill", true)
    }
    return makeReport(entry, reason, graceMs, "timeout", false)
  }
}

export function createChildRegistry(): ChildRegistry {
  return new ChildRegistryImpl()
}

/** Module-level convenience for callers that keep a single registry. */
export function killOwnedTree(registry: ChildRegistry, pid: number, graceMs = DEFAULT_GRACE_MS): Promise<CloseReport | undefined> {
  return registry.killOwnedTree(pid, graceMs)
}
