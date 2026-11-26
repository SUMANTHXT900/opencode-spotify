// F0 installer lock: path resolution, atomic creation, content shape, busy
// detection, nonce-checked release, heartbeat, stale/PID-reuse rules,
// read-only inspect, release on failure, and a real multi-process reclaim race.
//
// Every filesystem test uses mkdtemp under the OS temp directory; the real
// %LOCALAPPDATA% is never read or written here.
import { after, test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs"
import { hostname, tmpdir } from "node:os"
import { dirname, join, posix, win32 } from "node:path"
import { fileURLToPath } from "node:url"
import {
  InstallerLockBusyError,
  InstallerLockLostError,
  acquireInstallerLock,
  inspectInstallerLock,
  installerLockPath,
  withInstallerLock,
  type InstallerLockContent,
  type InstallerLockOptions,
} from "../src/cli/lock.ts"
import { systemTool } from "../src/cli/runtime.ts"

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const HOST = "test-host"
const temporary: string[] = []

after(() => {
  for (const directory of temporary) {
    try { rmSync(directory, { recursive: true, force: true }) } catch { /* best effort */ }
  }
})

function tempDir(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  temporary.push(directory)
  return directory
}

function lockPathIn(prefix: string): string {
  return join(tempDir(prefix), "installer.lock")
}

function options(path: string, extra: InstallerLockOptions = {}): InstallerLockOptions {
  return {
    lockPath: path,
    command: "setup",
    host: HOST,
    heartbeatMs: 0,
    registerExitHook: false,
    processStartTime: async () => null,
    ...extra,
  }
}

let nonceCounter = 0
function content(overrides: Partial<InstallerLockContent> = {}): InstallerLockContent {
  nonceCounter += 1
  return {
    schemaVersion: 1,
    pid: 4242,
    startedAt: 1_000_000,
    processStartTime: 500_000,
    command: "setup",
    host: HOST,
    nonce: `nonce-${nonceCounter}-00000000`,
    ...overrides,
  }
}

function writeLock(path: string, value: InstallerLockContent | string, mtimeMs = Date.now()): void {
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value))
  utimesSync(path, new Date(mtimeMs), new Date(mtimeMs))
}

function readContent(path: string): InstallerLockContent {
  return JSON.parse(readFileSync(path, "utf8")) as InstallerLockContent
}

interface GuardContent {
  pid: number
  at: number
  nonce: string
  processStartTime: number | null
}

function writeGuard(path: string, value: GuardContent, mtimeMs: number): void {
  writeFileSync(path, JSON.stringify(value))
  utimesSync(path, new Date(mtimeMs), new Date(mtimeMs))
}

test("installerLockPath resolves the per-user state directory", () => {
  assert.equal(
    installerLockPath({ platform: "win32", env: { LOCALAPPDATA: "C:\\Local" }, home: "C:\\Users\\Test" }),
    win32.join("C:\\Local", "opencode-spotify", "installer.lock"),
  )
  assert.equal(
    installerLockPath({ platform: "win32", env: {}, home: "C:\\Users\\Test" }),
    win32.join("C:\\Users\\Test", "AppData", "Local", "opencode-spotify", "installer.lock"),
  )
  assert.equal(
    installerLockPath({ platform: "linux", env: { XDG_STATE_HOME: "/state" }, home: "/home/test" }),
    posix.join("/state", "opencode-spotify", "installer.lock"),
  )
  assert.equal(
    installerLockPath({ platform: "linux", env: {}, home: "/home/test" }),
    posix.join("/home/test", ".local", "state", "opencode-spotify", "installer.lock"),
  )
})

test("acquire writes schema-v1 content with no argv and creates the directory", async () => {
  const path = join(tempDir("lock-create-"), "nested", "installer.lock")
  const NOW = 1_700_000_000_000
  const lock = await acquireInstallerLock(options(path, {
    command: "update",
    pid: 4242,
    now: () => NOW,
    processStartTime: async (pid) => {
      assert.equal(pid, 4242)
      return NOW + 123
    },
  }))
  assert.equal(existsSync(path), true)
  const stored = readContent(path)
  assert.deepEqual(stored, {
    schemaVersion: 1,
    pid: 4242,
    startedAt: NOW,
    processStartTime: NOW + 123,
    command: "update",
    host: HOST,
    nonce: lock.nonce,
  })
  assert.ok(lock.nonce.length >= 8)
  assert.equal(stored.command.includes(" "), false)
  await lock.release()
  assert.equal(existsSync(path), false)
  await lock.release() // idempotent
  await assert.rejects(lock.assertHeld(), InstallerLockLostError)
  assert.equal(await lock.isHeld(), false)
})

test("a second acquire against a live owner throws InstallerLockBusyError", async () => {
  const path = lockPathIn("lock-busy-")
  const NOW = 2_000_000
  const first = await acquireInstallerLock(options(path, {
    pid: 1111,
    now: () => NOW,
    isProcessAlive: () => true,
    processStartTime: async () => 500,
  }))
  try {
    await assert.rejects(
      acquireInstallerLock(options(path, {
        pid: 2222,
        now: () => NOW,
        startupGraceMs: 0,
        isProcessAlive: () => true,
        processStartTime: async () => 500,
      })),
      (error: unknown) => error instanceof InstallerLockBusyError
        && error.inspection.status === "held"
        && error.inspection.content?.pid === 1111,
    )
    assert.equal(existsSync(path), true)
    assert.equal(readContent(path).pid, 1111)
  } finally {
    await first.release()
  }
})

test("assertHeld and release are nonce-checked", async () => {
  const path = lockPathIn("lock-nonce-")
  const NOW = 3_000_000
  const lock = await acquireInstallerLock(options(path, { pid: 3333, now: () => NOW }))
  writeLock(path, content({ pid: 9999, startedAt: NOW, nonce: "different-nonce-0000" }), NOW)

  await assert.rejects(lock.assertHeld(), InstallerLockLostError)
  assert.equal(await lock.isHeld(), false)
  await assert.rejects(lock.release(), InstallerLockLostError)
  assert.equal(existsSync(path), true, "a nonce mismatch must not unlink the other owner's lock")
  unlinkSync(path)
})

test("heartbeat refreshes the lock file mtime", async () => {
  const path = lockPathIn("lock-heartbeat-")
  const lock = await acquireInstallerLock(options(path, {
    heartbeatMs: 25,
    registerExitHook: false,
  }))
  try {
    const before = statSync(path).mtimeMs
    await new Promise((resolve) => setTimeout(resolve, 90))
    const after = statSync(path).mtimeMs
    assert.ok(after > before, `expected heartbeat mtime to advance: ${before} -> ${after}`)
  } finally {
    await lock.release()
  }
})

test("a dead owner becomes stale after deadOwnerGraceMs and is reclaimed", async () => {
  const path = lockPathIn("lock-dead-owner-")
  const NOW = 4_000_000
  writeLock(path, content({
    pid: 777_777,
    startedAt: NOW - 60_000,
    processStartTime: 1234,
    nonce: "dead-owner-nonce-01",
  }), NOW - 60_000)

  const inspection = await inspectInstallerLock(options(path, {
    now: () => NOW,
    probeProcess: true,
    startupGraceMs: 0,
    deadOwnerGraceMs: 5_000,
    isProcessAlive: () => false,
  }))
  assert.equal(inspection.status, "stale")
  assert.match(inspection.reason, /not running/)

  const lock = await acquireInstallerLock(options(path, {
    pid: 8888,
    now: () => NOW,
    startupGraceMs: 0,
    deadOwnerGraceMs: 5_000,
    isProcessAlive: () => false,
  }))
  assert.equal(lock.content.pid, 8888)
  assert.equal(readContent(path).pid, 8888)
  await lock.release()
})

test("a dead owner inside the grace window is held", async () => {
  const path = lockPathIn("lock-dead-grace-")
  const NOW = 5_000_000
  writeLock(path, content({ pid: 777_778, startedAt: NOW - 1_000, nonce: "dead-grace-nonce-01" }), NOW - 1_000)
  const inspection = await inspectInstallerLock(options(path, {
    now: () => NOW,
    probeProcess: true,
    startupGraceMs: 0,
    deadOwnerGraceMs: 5_000,
    isProcessAlive: () => false,
  }))
  assert.equal(inspection.status, "held")
  assert.match(inspection.reason, /grace/)
})

test("a reused pid with a different start time is stale", async () => {
  const path = lockPathIn("lock-pid-reuse-")
  const NOW = 6_000_000
  writeLock(path, content({
    pid: 5555,
    startedAt: NOW - 60_000,
    processStartTime: 1_000,
    nonce: "pid-reuse-nonce-01",
  }), NOW - 60_000)

  const inspection = await inspectInstallerLock(options(path, {
    now: () => NOW,
    probeProcess: true,
    startupGraceMs: 0,
    isProcessAlive: () => true,
    processStartTime: async () => 9_999_999,
  }))
  assert.equal(inspection.status, "stale")
  assert.match(inspection.reason, /reused/)

  const lock = await acquireInstallerLock(options(path, {
    pid: 6666,
    now: () => NOW,
    startupGraceMs: 0,
    isProcessAlive: () => true,
    processStartTime: async () => 9_999_999,
  }))
  assert.equal(lock.content.pid, 6666)
  await lock.release()
})

test("a live owner with a matching start time is never stale, even with an old heartbeat", async () => {
  const path = lockPathIn("lock-live-match-")
  const NOW = 7_000_000
  const processStartTime = 1_234_567
  writeLock(path, content({
    pid: 4444,
    startedAt: NOW - 600_000,
    processStartTime,
    nonce: "live-match-nonce-01",
  }), NOW - 600_000)

  const inspection = await inspectInstallerLock(options(path, {
    now: () => NOW,
    probeProcess: true,
    startupGraceMs: 0,
    staleMs: 1_000,
    deadOwnerGraceMs: 0,
    startTimeToleranceMs: 2_000,
    isProcessAlive: () => true,
    processStartTime: async () => processStartTime + 500,
  }))
  assert.equal(inspection.status, "held")
  assert.match(inspection.reason, /start time matches/)
})

test("an unverifiable live owner falls back to the heartbeat staleMs", async () => {
  const path = lockPathIn("lock-heartbeat-fallback-")
  const NOW = 8_000_000
  writeLock(path, content({
    pid: 4445,
    startedAt: NOW - 60_000,
    processStartTime: null,
    nonce: "fallback-nonce-0001",
  }), NOW - 60_000)

  const inspection = await inspectInstallerLock(options(path, {
    now: () => NOW,
    probeProcess: true,
    startupGraceMs: 0,
    staleMs: 30_000,
    deadOwnerGraceMs: 0,
    isProcessAlive: () => true,
    processStartTime: async () => null,
  }))
  assert.equal(inspection.status, "stale")
  assert.match(inspection.reason, /heartbeat/)

  // Without probeProcess, inspect stays read-only and uses the same fallback.
  const unprobed = await inspectInstallerLock(options(path, { now: () => NOW, startupGraceMs: 0, staleMs: 30_000 }))
  assert.equal(unprobed.status, "stale")
})

test("malformed content is stale and can be reclaimed", async () => {
  const path = lockPathIn("lock-malformed-")
  const NOW = 9_000_000
  writeLock(path, "this is not json", NOW - 60_000)

  const inspection = await inspectInstallerLock(options(path, { now: () => NOW, probeProcess: true }))
  assert.equal(inspection.status, "malformed")
  assert.equal(inspection.content, undefined)

  const lock = await acquireInstallerLock(options(path, { pid: 7777, now: () => NOW }))
  assert.equal(lock.content.pid, 7777)
  assert.equal(readContent(path).pid, 7777)
  await lock.release()
})

test("a lock from another host is stale", async () => {
  const path = lockPathIn("lock-host-")
  const NOW = 10_000_000
  writeLock(path, content({ host: "other-host", startedAt: NOW - 30_000, nonce: "other-host-nonce-01" }), NOW - 30_000)
  const inspection = await inspectInstallerLock(options(path, { now: () => NOW, probeProcess: true }))
  assert.equal(inspection.status, "stale")
  assert.match(inspection.reason, /host/)
})

test("the startup grace protects a brand-new dead-looking lock", async () => {
  const path = lockPathIn("lock-startup-grace-")
  const NOW = 11_000_000
  writeLock(path, content({ pid: 999_999, startedAt: NOW - 500, nonce: "startup-grace-nonce" }), NOW - 500)
  const inspection = await inspectInstallerLock(options(path, {
    now: () => NOW,
    probeProcess: true,
    startupGraceMs: 10_000,
    isProcessAlive: () => false,
  }))
  assert.equal(inspection.status, "held")
  assert.match(inspection.reason, /startup grace/)
})

test("permission errors are never treated as stale", async () => {
  const path = lockPathIn("lock-permission-")
  const NOW = 12_000_000
  writeLock(path, content({ pid: 4321, startedAt: NOW - 600_000, nonce: "permission-nonce-01" }), NOW - 600_000)

  const livenessDenied = await inspectInstallerLock(options(path, {
    now: () => NOW,
    probeProcess: true,
    startupGraceMs: 0,
    staleMs: 1,
    isProcessAlive: () => { throw Object.assign(new Error("denied"), { code: "EPERM" }) },
  }))
  assert.equal(livenessDenied.status, "held")
  assert.match(livenessDenied.reason, /permission/)

  const startDenied = await inspectInstallerLock(options(path, {
    now: () => NOW,
    probeProcess: true,
    startupGraceMs: 0,
    staleMs: 1,
    isProcessAlive: () => true,
    processStartTime: async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }) },
  }))
  assert.equal(startDenied.status, "held")
  assert.match(startDenied.reason, /permission/)
})

test("inspect is read-only and never creates directories", async () => {
  const directory = join(tempDir("lock-inspect-"), "missing", "nested")
  const path = join(directory, "installer.lock")
  const inspection = await inspectInstallerLock({ lockPath: path, probeProcess: true })
  assert.equal(inspection.status, "absent")
  assert.equal(existsSync(directory), false)
})

test("withInstallerLock releases the lock when the run fails with 130", async () => {
  const path = lockPathIn("lock-release-failure-")
  const failure = Object.assign(new Error("interrupted"), { code: 130 })
  await assert.rejects(
    withInstallerLock({
      lock: options(path, { pid: 1357 }),
      command: "setup",
      run: async () => { throw failure },
    }),
    (error: unknown) => error === failure && (error as { code?: number }).code === 130,
  )
  assert.equal(existsSync(path), false)
})

test("withInstallerLock releases the lock after revalidate fails", async () => {
  const path = lockPathIn("lock-revalidate-")
  await assert.rejects(
    withInstallerLock({
      lock: options(path, { pid: 2468 }),
      command: "update",
      revalidate: () => { throw new Error("revalidation failed") },
      run: async () => "unreachable",
    }),
    /revalidation failed/,
  )
  assert.equal(existsSync(path), false)
})

test("withInstallerLock returns the run result and releases", async () => {
  const path = lockPathIn("lock-success-")
  const result = await withInstallerLock({
    lock: options(path, { pid: 1122 }),
    command: "repair",
    revalidate: async (lock) => { await lock.assertHeld() },
    run: async (lock) => lock.content.pid,
  })
  assert.equal(result, 1122)
  assert.equal(existsSync(path), false)
})

test("a dead reclaim guard is recovered and the stale lock is reclaimed", async () => {
  const path = lockPathIn("lock-guard-dead-")
  const guardPath = `${path}.reclaim`
  const NOW = 20_000_000
  writeLock(path, content({
    pid: 777_001,
    startedAt: NOW - 60_000,
    processStartTime: 1234,
    nonce: "dead-guard-lock-01",
  }), NOW - 60_000)
  writeGuard(guardPath, {
    pid: 777_002,
    at: NOW - 1_000,
    nonce: "dead-guard-nonce-1",
    processStartTime: 999,
  }, NOW - 1_000)

  // A process died while holding the guard: without recovery every future
  // reclaim of this stale lock would fail forever.
  const lock = await acquireInstallerLock(options(path, {
    pid: 8888,
    now: () => NOW,
    startupGraceMs: 0,
    deadOwnerGraceMs: 0,
    sleep: async () => {},
    isProcessAlive: () => false,
    processStartTime: async () => null,
  }))
  try {
    assert.equal(lock.content.pid, 8888)
    assert.equal(readContent(path).pid, 8888)
    assert.equal(existsSync(guardPath), false, "the dead guard must be removed")
  } finally {
    await lock.release()
  }
})

test("an expired reclaim guard is recovered even while its pid is alive", async () => {
  const path = lockPathIn("lock-guard-expired-")
  const guardPath = `${path}.reclaim`
  const NOW = 21_000_000
  writeLock(path, content({
    pid: 777_011,
    startedAt: NOW - 60_000,
    processStartTime: 1234,
    nonce: "expired-guard-lock",
  }), NOW - 60_000)
  writeGuard(guardPath, {
    pid: 777_012,
    at: NOW - 400_000,
    nonce: "expired-guard-nonce",
    processStartTime: 555,
  }, NOW - 400_000)

  const lock = await acquireInstallerLock(options(path, {
    pid: 8888,
    now: () => NOW,
    staleMs: 300_000,
    startupGraceMs: 0,
    deadOwnerGraceMs: 0,
    sleep: async () => {},
    isProcessAlive: (pid) => pid === 777_012,
    processStartTime: async () => 555,
  }))
  try {
    assert.equal(readContent(path).pid, 8888)
    assert.equal(existsSync(guardPath), false, "an expired guard must not block reclaim forever")
  } finally {
    await lock.release()
  }
})

test("a live reclaim guard blocks reclaim with a distinct reason and preserves the stale lock", async () => {
  const path = lockPathIn("lock-guard-live-")
  const guardPath = `${path}.reclaim`
  const NOW = 22_000_000
  writeLock(path, content({
    pid: 777_021,
    startedAt: NOW - 60_000,
    processStartTime: 1234,
    nonce: "live-guard-lock-01",
  }), NOW - 60_000)
  writeGuard(guardPath, {
    pid: 777_022,
    at: NOW - 1_000,
    nonce: "live-guard-nonce-1",
    processStartTime: 555,
  }, NOW - 1_000)

  await assert.rejects(
    acquireInstallerLock(options(path, {
      pid: 8888,
      now: () => NOW,
      startupGraceMs: 0,
      deadOwnerGraceMs: 0,
      sleep: async () => {},
      isProcessAlive: (pid) => pid === 777_022,
      processStartTime: async () => 555,
    })),
    (error: unknown) => error instanceof InstallerLockBusyError
      && /reclaim guard is held by a live process/.test(error.inspection.reason),
  )
  assert.equal(existsSync(path), true, "a blocked guard must not remove the stale lock")
  assert.equal(readContent(path).pid, 777_021)
  assert.equal(existsSync(guardPath), true, "a live guard must not be broken")
})

test("a fresh reclaim guard with an unverifiable owner blocks instead of being broken", async () => {
  const path = lockPathIn("lock-guard-fresh-")
  const guardPath = `${path}.reclaim`
  const NOW = 23_000_000
  writeLock(path, content({
    pid: 777_031,
    startedAt: NOW - 60_000,
    processStartTime: 1234,
    nonce: "fresh-guard-lock-01",
  }), NOW - 60_000)
  writeGuard(guardPath, {
    pid: 777_032,
    at: NOW - 1_000,
    nonce: "fresh-guard-nonce-1",
    processStartTime: null,
  }, NOW - 1_000)

  await assert.rejects(
    acquireInstallerLock(options(path, {
      pid: 8888,
      now: () => NOW,
      startupGraceMs: 0,
      deadOwnerGraceMs: 0,
      sleep: async () => {},
      isProcessAlive: (pid) => {
        if (pid === 777_032) throw new Error("liveness probe unavailable")
        return false
      },
      processStartTime: async () => null,
    })),
    (error: unknown) => error instanceof InstallerLockBusyError
      && /reclaim guard owner is unverifiable/.test(error.inspection.reason),
  )
  assert.equal(existsSync(path), true)
  assert.equal(existsSync(guardPath), true, "a fresh guard must survive an inconclusive probe")
})

test("windows child termination uses the absolute system taskkill path (M6)", () => {
  const source = readFileSync(join(pluginRoot, "src", "cli", "children.ts"), "utf8")
  assert.match(source, /import \{ systemTool \} from "\.\/runtime\.ts"/)
  assert.match(source, /spawn\(systemTool\("taskkill\.exe"\)/)
  assert.doesNotMatch(source, /spawn\(\s*["']taskkill["']/, "taskkill must never be PATH-resolved")
  if (process.platform === "win32") {
    assert.match(systemTool("taskkill.exe"), /^[A-Za-z]:\\/)
  }
})

test("eight processes reclaim one stale lock without overlapping ownership", async (context) => {
  context.diagnostic("spawning 8 lock-child processes against one stale lock")
  const directory = tempDir("lock-reclaim-race-")
  const path = join(directory, "installer.lock")

  const dead = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore", windowsHide: true })
  const deadPid = dead.pid ?? 0
  await new Promise<void>((resolve) => {
    dead.once("exit", () => resolve())
    dead.once("error", () => resolve())
  })
  assert.ok(deadPid > 0)

  writeLock(path, content({
    pid: deadPid,
    startedAt: Date.now() - 60_000,
    processStartTime: null,
    host: hostname(),
    nonce: "race-dead-nonce-01",
  }), Date.now() - 60_000)

  const fixture = join(pluginRoot, "tests", "fixtures", "lock-child.ts")
  const runs = await Promise.all(Array.from({ length: 8 }, () => runChild(fixture, path)))
  for (const run of runs) {
    assert.equal(run.code, 0, `child failed: ${run.stderr || run.stdout}`)
  }

  const results = runs.map((run) => {
    const line = run.stdout.split(/\r?\n/).filter((entry) => entry.trim().startsWith("{")).at(-1)
    assert.ok(line, `child produced no JSON: ${run.stdout} / ${run.stderr}`)
    return JSON.parse(line) as { ok: boolean; pid: number; nonce: string }
  })
  assert.equal(results.every((entry) => entry.ok), true)
  assert.equal(new Set(results.map((entry) => entry.nonce)).size, results.length)

  assert.equal(existsSync(`${path}.witness`), false, "every child left the protected section")
  assert.equal(existsSync(path), false, "every holder released the lock")
})

interface ChildResult { code: number | null; stdout: string; stderr: string }

function runChild(fixture: string, path: string): Promise<ChildResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [fixture, "--lock", path], {
      cwd: pluginRoot,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    })
    let stdout = ""
    let stderr = ""
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL") } catch { /* already gone */ }
    }, 25_000)
    timer.unref?.()
    child.stdout?.on("data", (chunk) => { stdout += String(chunk) })
    child.stderr?.on("data", (chunk) => { stderr += String(chunk) })
    child.once("error", (error) => {
      clearTimeout(timer)
      resolve({ code: null, stdout, stderr: `${stderr}${error.message}` })
    })
    child.once("close", (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}
