// F8 main-integration: installer lock behavior through main().
//
// Every filesystem test uses mkdtemp under the OS temp directory and points the
// fake runtime's LOCALAPPDATA at that directory. The real %LOCALAPPDATA% is
// never read or written here.
//
// Scope notes:
//   * "status executes zero commands" is asserted as "status executed exactly
//     the read-only detection command set": main() always runs
//     detectEnvironment() before it dispatches, so the exact detection calls
//     are captured on the same runtime and compared to the calls status added.
//   * main() has no seam for the active cancel token, so the 130 case uses the
//     process SIGINT handler that main installs: the interactive prompt emits a
//     synthetic SIGINT, the workflow then returns 130, and the lock must be
//     released. No real signal is delivered.
import { after, test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { main } from "../src/cli/main.ts"
import { detectEnvironment } from "../src/cli/detect.ts"
import {
  InstallerLockBusyError,
  InstallerLockLostError,
  acquireInstallerLock,
  installerLockPath,
  type InstallerLock,
  type InstallerLockContent,
  type InstallerLockInspection,
  type InstallerLockOptions,
} from "../src/cli/lock.ts"
import type { Prompter } from "../src/cli/types.ts"
import {
  fakeLogger,
  fakePrompt,
  fakeRuntime,
  fakeUi,
  type FakeRuntime,
} from "./cli-fixture.ts"

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

function lockOptions(path: string, extra: InstallerLockOptions = {}): InstallerLockOptions {
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
function lockContent(overrides: Partial<InstallerLockContent> = {}): InstallerLockContent {
  nonceCounter += 1
  return {
    schemaVersion: 1,
    pid: 4242,
    startedAt: 1_000_000,
    processStartTime: null,
    command: "setup",
    host: HOST,
    nonce: `nonce-${nonceCounter}-000000`,
    ...overrides,
  }
}

function readLock(path: string): InstallerLockContent {
  return JSON.parse(readFileSync(path, "utf8")) as InstallerLockContent
}

function writeLock(path: string, content: InstallerLockContent): void {
  writeFileSync(path, `${JSON.stringify(content)}\n`)
  const stamp = new Date(1_000_000)
  utimesSync(path, stamp, stamp)
}

function lockPathFor(runtime: FakeRuntime): string {
  return installerLockPath({
    platform: "win32",
    env: { LOCALAPPDATA: runtime.env.LOCALAPPDATA },
    home: runtime.homedir,
  })
}

/**
 * FakeRuntime whose LOCALAPPDATA points at an isolated temp directory and whose
 * file probes can still read the real lock file written there (needed by
 * doctor's read-only lock peek).
 */
function lockedRuntime(directory: string): FakeRuntime {
  const base = fakeRuntime()
  const path = installerLockPath({
    platform: "win32",
    env: { LOCALAPPDATA: directory },
    home: base.homedir,
  })
  const runtime: FakeRuntime = {
    ...base,
    env: { ...base.env, LOCALAPPDATA: directory },
    exists(candidate: string): boolean {
      if (candidate === path) return existsSync(path)
      return base.exists(candidate)
    },
    isFile(candidate: string): boolean {
      if (candidate === path) return existsSync(path)
      return base.isFile(candidate)
    },
    readText(candidate: string): string {
      if (candidate === path) return readFileSync(path, "utf8")
      return base.readText(candidate)
    },
  }
  return runtime
}

function commandLines(runtime: FakeRuntime): string[] {
  return [...runtime.calls, ...runtime.interactiveCalls].map((call) => `${call.file} ${call.args.join(" ")}`)
}

/**
 * Any command that would change installed state. Detection probes (version,
 * config, list, path) are intentionally excluded.
 */
function isMutatingCommand(command: string): boolean {
  if (/\bplugin\s+(add|remove|update)\b/i.test(command)) return true
  if (/\bspicetify(?:\.exe)?\s+(apply|backup|restore|update|upgrade)\b/i.test(command)) return true
  if (/-Install\b|-Repair\b|-Uninstall\b/.test(command)) return true
  if (/\b(winget|scoop|choco)\b.*\b(install|upgrade|update)\b/i.test(command)) return true
  return false
}

function mutatingCommands(runtime: FakeRuntime): string[] {
  return commandLines(runtime).filter(isMutatingCommand)
}

const READ_ONLY_INSPECTION = [
  /opencode(?:\.exe)? --version$/,
  /opencode(?:\.exe)? debug paths config$/,
  /opencode(?:\.exe)? plugin list$/,
  /opencode(?:\.exe)? plugin --help$/,
  /spicetify(?:\.exe)? -v$/i,
  /spicetify(?:\.exe)? path$/i,
  /spicetify(?:\.exe)? path spotify$/i,
  /spicetify(?:\.exe)? -c$/i,
  /pwsh(?:\.exe)? -NoProfile -NonInteractive -Command Get-AppxPackage /i,
]

function normalized(lines: string[]): string[] {
  return [...lines].sort()
}

function isReadOnlyInspection(command: string): boolean {
  return READ_ONLY_INSPECTION.some((pattern) => pattern.test(command))
}

function busyLock(path: string): InstallerLock & { releases: number } {
  const content = lockContent({ pid: 4242, nonce: "busy-owner-nonce-1" })
  // A genuine InstallerLockBusyError raised from the assertHeld() seam main
  // uses right after acquisition.
  const inspection: InstallerLockInspection = {
    path,
    status: "held",
    reason: "another installer is already running",
    content,
    pid: content.pid,
    lastHeartbeatAt: 0,
    ageMs: 0,
    heartbeatAgeMs: 0,
  }
  const error = new InstallerLockBusyError(inspection)
  const api = {
    path,
    content,
    nonce: content.nonce,
    releases: 0,
    async release() { api.releases += 1 },
    async assertHeld(): Promise<InstallerLockContent> { throw error },
    async isHeld() { return true },
  }
  return api
}

test("busy lock: mutating setup exits 1, explains the live owner, and mutates nothing", async () => {
  const runtime = fakeRuntime()
  const log = fakeLogger()
  const lock = busyLock(join(tempDir("lock-main-busy-"), "installer.lock"))

  const code = await main(
    ["setup", "--offline", "--spicetify=skip", "--yes", "--non-interactive"],
    { runtime, log, ui: fakeUi(), prompt: fakePrompt(), lock },
  )

  // main surfaces the busy error's own message; the inspection reason the fake
  // supplies ("another installer is already running") is what carries the
  // phrase, so main's busy contract is: the error is printed verbatim plus the
  // read-only guidance, and the exit code is 1.
  const stderr = log.lines.join("\n")
  assert.equal(code, 1)
  assert.match(stderr, /already running/i)
  assert.match(stderr, /Another installer/i)
  assert.match(stderr, /status.*doctor.*available/is)
  assert.deepEqual(mutatingCommands(runtime), [])
  assert.equal(lock.releases, 1, "the busy attempt must still release its handle")
})

test("a held lock keeps status and doctor read-only and leaves the owner untouched", async () => {
  const directory = tempDir("lock-main-readonly-")
  const runtime = lockedRuntime(directory)
  const path = lockPathFor(runtime)
  const held = await acquireInstallerLock(lockOptions(path, { pid: process.pid }))
  try {
    const beforeRaw = readFileSync(path, "utf8")
    const beforeMtime = statSync(path).mtimeMs
    const beforeNonce = readLock(path).nonce

    // Capture the exact read-only detection command set on this runtime, then
    // prove status added none of its own.
    const baselineStart = runtime.calls.length
    await detectEnvironment(runtime)
    const detectionCalls = normalized(commandLines(runtime).slice(baselineStart))
    assert.ok(detectionCalls.length > 0, "expected read-only detection probes")
    assert.equal(detectionCalls.every(isReadOnlyInspection), true,
      `unexpected detection command: ${JSON.stringify(detectionCalls)}`)

    const statusStart = runtime.calls.length
    const ui = fakeUi()
    const statusCode = await main(["status", "--offline", "--json"], {
      runtime, log: fakeLogger(), ui, prompt: fakePrompt(),
    })
    const statusCalls = normalized(commandLines(runtime).slice(statusStart))

    assert.equal(statusCode, 0)
    assert.deepEqual(statusCalls, detectionCalls, "status must execute zero commands beyond detection")
    assert.equal(statusCalls.every(isReadOnlyInspection), true)
    assert.deepEqual(mutatingCommands(runtime), [])
    assert.equal(ui.jsonValue !== undefined, true, "status --json must emit a document")

    assert.equal(readFileSync(path, "utf8"), beforeRaw, "the lock file must be byte-identical")
    assert.equal(statSync(path).mtimeMs, beforeMtime, "the lock file mtime must not change")
    assert.equal(readLock(path).nonce, beforeNonce)
    assert.equal(await held.isHeld(), true)

    const doctorStart = runtime.calls.length
    const doctorUi = fakeUi()
    const doctorCode = await main(["doctor", "--offline", "--json"], {
      runtime, log: fakeLogger(), ui: doctorUi, prompt: fakePrompt(),
    })
    const doctorCalls = normalized(commandLines(runtime).slice(doctorStart))

    assert.equal(doctorCode, 0, "a healthy environment reports no doctor failures")
    assert.deepEqual(mutatingCommands(runtime), [])
    assert.equal(doctorCalls.length, detectionCalls.length + 1,
      "doctor adds only the project plugin list probe")
    assert.equal(doctorCalls.every(isReadOnlyInspection), true)
    assert.equal(doctorUi.jsonValue !== undefined, true)

    const report = doctorUi.jsonValue as { environment?: { lock?: { status?: string; pid?: number } } }
    assert.equal(report.environment?.lock?.status, "present", "doctor observes the lock without probing it")

    assert.equal(readFileSync(path, "utf8"), beforeRaw)
    assert.equal(statSync(path).mtimeMs, beforeMtime)
    assert.equal(await held.isHeld(), true)
  } finally {
    await held.release()
  }
})

test("dry-run never acquires the lock for any mutating command", async () => {
  // The running installer binary is itself a selectable update target when
  // strictly newer than the registered plugin, so an offline update dry-run
  // plans (0) instead of erroring on the unknown registry.
  const cases: Array<{ argv: string[]; expected: number }> = [
    { argv: ["setup", "--dry-run", "--offline", "--spicetify=skip"], expected: 0 },
    { argv: ["update", "--dry-run", "--offline"], expected: 0 },
    { argv: ["repair", "--dry-run", "--offline"], expected: 0 },
    { argv: ["uninstall", "--dry-run", "--offline", "--yes", "--non-interactive"], expected: 0 },
  ]

  for (const item of cases) {
    const runtime = fakeRuntime()
    const ui = fakeUi()
    const touches: string[] = []
    const lock: InstallerLock = {
      path: join(tempDir("lock-main-dryrun-"), "installer.lock"),
      content: lockContent(),
      nonce: "dry-run-must-not-acquire",
      async release() { touches.push("release") },
      async assertHeld() { touches.push("assertHeld"); throw new Error("dry-run must not acquire the lock") },
      async isHeld() { touches.push("isHeld"); return false },
    }

    const code = await main(item.argv, { runtime, ui, log: fakeLogger(), prompt: fakePrompt(), lock })

    assert.equal(code, item.expected, `${item.argv.join(" ")} exit code`)
    assert.deepEqual(touches, [], `${item.argv.join(" ")} must not touch the installer lock`)
    assert.deepEqual(mutatingCommands(runtime), [], `${item.argv.join(" ")} must not mutate`)
  }
})

test("a workflow failure (1) releases the lock and the next acquire succeeds", async () => {
  const directory = tempDir("lock-main-fail-")
  const path = join(directory, "installer.lock")
  const lock = await acquireInstallerLock(lockOptions(path, { command: "setup" }))

  const runtime = fakeRuntime()
  runtime.state.opencode.available = false
  const baseWhich = runtime.which.bind(runtime)
  runtime.which = async (name: string) => (name === "opencode" ? undefined : baseWhich(name))

  const code = await main(
    ["setup", "--offline", "--spicetify=skip", "--yes", "--non-interactive"],
    { runtime, log: fakeLogger(), ui: fakeUi(), prompt: fakePrompt(), lock },
  )

  assert.equal(code, 1, "setup without OpenCode fails")
  assert.equal(existsSync(path), false, "the lock file must be gone after the failed run")
  assert.deepEqual(mutatingCommands(runtime), [])

  const next = await acquireInstallerLock(lockOptions(path, { command: "update" }))
  assert.equal(next.content.command, "update")
  assert.equal(existsSync(path), true)
  await next.release()
})

test("a workflow cancellation (130) releases the lock and the next acquire succeeds", async () => {
  const directory = tempDir("lock-main-cancel-")
  const path = join(directory, "installer.lock")
  const lock = await acquireInstallerLock(lockOptions(path, { command: "setup" }))

  const runtime = fakeRuntime()
  runtime.state.opencode.available = false
  const baseWhich = runtime.which.bind(runtime)
  runtime.which = async (name: string) => (name === "opencode" ? undefined : baseWhich(name))

  // The interactive prerequisite recheck requests cancellation through the
  // SIGINT handler main installs; runSetup then returns 130.
  const prompt: Prompter = {
    ask: async () => undefined,
    choose: async () => {
      process.emit("SIGINT")
      return "recheck"
    },
    confirm: async () => false,
    close: () => {},
  }

  const code = await main(
    ["setup", "--offline", "--spicetify=skip"],
    { runtime, log: fakeLogger(), ui: fakeUi(), prompt, lock },
  )

  assert.equal(code, 130)
  assert.equal(existsSync(path), false, "the lock file must be gone after cancellation")
  assert.deepEqual(mutatingCommands(runtime), [])

  const next = await acquireInstallerLock(lockOptions(path, { command: "repair" }))
  assert.equal(next.content.command, "repair")
  await next.release()
})

test("a lost lock stops main with 1, preserves the other owner's file, and mutates nothing", async () => {
  const directory = tempDir("lock-main-lost-")
  const path = join(directory, "installer.lock")
  const lock = await acquireInstallerLock(lockOptions(path, { command: "setup" }))

  // Another installer replaced the file after our acquire.
  const other = lockContent({ pid: 9001, command: "update", nonce: "other-owner-nonce-9" })
  writeLock(path, other)

  const runtime = fakeRuntime()
  const log = fakeLogger()
  const code = await main(
    ["setup", "--offline", "--spicetify=skip", "--yes", "--non-interactive"],
    { runtime, log, ui: fakeUi(), prompt: fakePrompt(), lock },
  )

  const stderr = log.lines.join("\n")
  assert.equal(code, 1)
  assert.match(stderr, /no longer held/i)
  assert.deepEqual(mutatingCommands(runtime), [])

  assert.equal(existsSync(path), true, "a lost owner must never delete the replacement lock")
  assert.equal(readLock(path).nonce, other.nonce)
  assert.equal(await lock.isHeld(), false)
  await assert.rejects(lock.assertHeld(), InstallerLockLostError)
})
