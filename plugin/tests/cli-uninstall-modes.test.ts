// D23 adversarial uninstall coverage.
//
// Focus: plugin-only vs complete removal, validated-backup restore gating
// (missing / incomplete / unknown / verification failure), honest
// partial-failure reporting, repeated-uninstall idempotency, owner-managed
// Spicetify protection (verified by the binary disappearing), unrelated PATH
// preservation, and real junction/boundary checks.
//
// Fixtures are fake runtimes plus injected file-size/backup fakes, or private
// directories under the OS temp dir. No user path is ever passed to a deletion
// primitive: the only real file-system writes are the temp fixtures.
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  filterPathEntries,
  isWithinBoundary,
  managerUninstallArgs,
  pathRemovalProblem,
  removeUserPathEntries,
  runUninstall,
} from "../src/cli/uninstall.ts"
import { SPICETIFY_WINGET_ID } from "../src/cli/spicetify.ts"
import type { CommandResult, Detection, ExecOptions } from "../src/cli/types.ts"
import { context, fakeDetection, fakePrompt, fakeReport, fakeRuntime, fakeUi } from "./cli-fixture.ts"

const LOCAL_DIR = "C:\\Users\\Test\\AppData\\Local\\spicetify"
const LOCAL_BACKUP_DIR = `${LOCAL_DIR}\\Backup`
const CONFIG_DIR = "C:\\Users\\Test\\AppData\\Roaming\\spicetify"
const CONFIG_BACKUP_DIR = `${CONFIG_DIR}\\Backup`
const CREDENTIAL_DIR = "C:\\Users\\Test\\AppData\\Roaming\\opencode-spotify"
const INSTALLED_XPUI = "C:\\Users\\Test\\AppData\\Roaming\\Spotify\\Apps\\xpui.spa"
const INSTALLED_LOGIN = "C:\\Users\\Test\\AppData\\Roaming\\Spotify\\Apps\\login.spa"
const MOD_XPUI_DIR = "C:\\Users\\Test\\AppData\\Roaming\\Spotify\\Apps\\xpui"
const MOD_LOGIN_DIR = "C:\\Users\\Test\\AppData\\Roaming\\Spotify\\Apps\\login"
const SPOTIFY_APPS_DIR = "C:\\Users\\Test\\AppData\\Roaming\\Spotify\\Apps"

type FakeRuntime = ReturnType<typeof fakeRuntime>
type SizeSpec = number | "missing" | "unreadable"

function completeRequested(runtime: FakeRuntime): void {
  runtime.env.OPENCODE_SPOTIFY_UNINSTALL = "complete"
}

/** Make only the listed paths (plus the fixture's built-in ones) exist. */
function existing(runtime: FakeRuntime, paths: string[]): void {
  const real = runtime.exists.bind(runtime)
  const added = new Set(paths)
  runtime.exists = (path: string) => added.has(path) || real(path)
}

/**
 * Install a fake Spicetify backup. The preferred root is
 * %APPDATA%\spicetify\Backup (sibling of configPath); both xpui.spa and
 * login.spa must exist and be plausible in size against the SHARED Spicetify
 * backup policy (xpui >= 1,000,000 bytes, login >= 100,000 bytes). `fileSize`
 * is injected so no real multi-megabyte files are needed.
 */
function installBackup(runtime: FakeRuntime, options: {
  directory?: string
  xpui?: SizeSpec
  login?: SizeSpec
  /** Installed Spotify xpui.spa size; "missing" simulates an unverifiable restore. */
  installedXpui?: number | "missing"
  /** Installed Spotify login.spa size; "missing" simulates an unverifiable restore. */
  installedLogin?: number | "missing"
} = {}) {
  const directory = options.directory ?? CONFIG_BACKUP_DIR
  const xpui = options.xpui ?? 5_000_000
  const login = options.login ?? 200_000
  const files = new Set<string>()
  const sizes = new Map<string, number>()
  const realExists = runtime.exists.bind(runtime)
  const realIsFile = runtime.isFile.bind(runtime)
  const realListDir = (runtime as FakeRuntime & { listDir?: (path: string) => string[] | null }).listDir?.bind(runtime)
  const norm = (value: string) => value.toLowerCase().replace(/[\\/]+$/, "")
  runtime.exists = (path: string) => {
    if (norm(path) === norm(MOD_XPUI_DIR) || norm(path) === norm(MOD_LOGIN_DIR)) return false
    if (files.has(path)) return true
    if (path === directory) return true
    return realExists(path)
  }
  runtime.isFile = (path: string) => {
    if (norm(path) === norm(MOD_XPUI_DIR) || norm(path) === norm(MOD_LOGIN_DIR)) return false
    if (files.has(path)) return true
    return realIsFile(path)
  };
  (runtime as FakeRuntime & { listDir?: (path: string) => string[] | null }).listDir = (path: string) => {
    if (norm(path) === norm(SPOTIFY_APPS_DIR)) {
      const entries: string[] = []
      if (files.has(INSTALLED_XPUI)) entries.push("xpui.spa")
      if (files.has(INSTALLED_LOGIN)) entries.push("login.spa")
      return entries
    }
    if (realListDir) {
      try {
        return realListDir(path)
      } catch {
        return null
      }
    }
    return null
  }

  const add = (path: string, spec: SizeSpec): void => {
    if (spec === "missing") return
    files.add(path)
    if (spec !== "unreadable") sizes.set(path, spec)
  }
  add(`${directory}\\xpui.spa`, xpui)
  add(`${directory}\\login.spa`, login)

  if (options.installedXpui !== "missing") {
    add(
      INSTALLED_XPUI,
      options.installedXpui ?? (typeof xpui === "number" ? xpui : 5_000_000),
    )
  }
  if (options.installedLogin !== "missing") {
    const loginSize = options.installedLogin ?? (typeof login === "number" ? login : 200_000)
    add(INSTALLED_LOGIN, loginSize)
  }

  return { directory, fileSize: (path: string) => sizes.get(path) ?? null }
}

function recordingDeps(options: {
  failRemovePath?: string
  fileSize?: (path: string) => number | null
} = {}) {
  const removed: string[] = []
  const deps = {
    pathInfo: () => ({ symlink: false, realPath: null }),
    removePath: (path: string) => {
      if (options.failRemovePath === path) throw new Error(`EACCES: cannot delete ${path}`)
      removed.push(path)
    },
    fileSize: options.fileSize ?? (() => null),
  }
  return { removed, deps }
}

function commands(runtime: FakeRuntime): string[] {
  return runtime.calls.map((call) => `${call.file} ${call.args.join(" ")}`)
}

function text(ui: ReturnType<typeof fakeUi>): string {
  return ui.lines.join("\n")
}

function detectionWith(runtime: FakeRuntime, overrides: Partial<Detection> = {}): Detection {
  return fakeDetection(runtime, overrides)
}

/** Complete removal with a validated backup needs a noninteractive yes. */
function completeContext(runtime: FakeRuntime, ui: ReturnType<typeof fakeUi>) {
  return context(runtime, ui, fakePrompt(), {
    command: "uninstall",
    yes: true,
    nonInteractive: true,
  })
}

// ---------------------------------------------------------------------------
// Plugin-only vs complete
// ---------------------------------------------------------------------------

test("plugin-only removes registration and bridge only, preserving credentials and Spicetify directories", async () => {
  const runtime = fakeRuntime()
  existing(runtime, [LOCAL_DIR, CONFIG_DIR, CONFIG_BACKUP_DIR, CREDENTIAL_DIR])
  const credentialRemovals: string[] = []
  runtime.remove = (path: string) => { credentialRemovals.push(path) }
  const { removed, deps } = recordingDeps()
  const ui = fakeUi()
  const ctx = context(runtime, ui, fakePrompt(), { command: "uninstall", yes: true, nonInteractive: true })
  ctx.detection = detectionWith(runtime)

  assert.equal(await runUninstall(ctx, deps), 0, text(ui))

  assert.deepEqual(removed, [])
  assert.deepEqual(credentialRemovals, [])
  const calls = commands(runtime)
  assert.ok(calls.some((call) => call.includes("plugin remove")))
  assert.ok(calls.some((call) => call.includes("-Uninstall")))
  assert.ok(!calls.some((call) => /\srestore\b|\sbackup\b/.test(call)), "plugin-only never restores or backs up")
  assert.match(text(ui), /Credentials: kept/)
  assert.match(text(ui), /Spotify \/ Spicetify: not removed/)
  assert.match(text(ui), /run spicetify apply to finish removing it from the running Spotify client/i)
  assert.match(text(ui), /Restart Spotify/i)
  assert.ok(!/sidebar will no longer load/i.test(text(ui)), "removal requires a restart/apply before the sidebar stops loading")
})

test("a validated backup is restored and verified before canonical Spicetify paths are deleted", async () => {
  const runtime = fakeRuntime()
  completeRequested(runtime)
  existing(runtime, [LOCAL_DIR, CONFIG_DIR, CREDENTIAL_DIR])
  const backup = installBackup(runtime)
  const credentialRemovals: string[] = []
  runtime.remove = (path: string) => { credentialRemovals.push(path) }
  const { removed, deps } = recordingDeps({ fileSize: backup.fileSize })
  const ui = fakeUi()
  const ctx = completeContext(runtime, ui)
  ctx.detection = detectionWith(runtime)

  assert.equal(await runUninstall(ctx, deps), 0, text(ui))

  const calls = commands(runtime)
  const restoreIndex = calls.findIndex((call) => call.endsWith(" restore"))
  const removeIndex = calls.findIndex((call) => call.includes("plugin remove"))
  assert.ok(restoreIndex >= 0 && restoreIndex < removeIndex, "restore precedes every deletion")
  assert.ok(!calls.some((call) => /\sbackup\b/.test(call)), "complete removal never creates a backup")
  assert.deepEqual(removed.sort(), [CONFIG_DIR, LOCAL_DIR].sort())
  assert.deepEqual(credentialRemovals, [CREDENTIAL_DIR])
  assert.match(text(ui), /validated Spicetify backup/i)
  assert.match(text(ui), /restored from the validated backup and the restore was verified/i)
})

test("a missing restoration backup restricts removal to registration, bridge and credentials", async () => {
  const runtime = fakeRuntime()
  completeRequested(runtime)
  // No backup directory and no backup files at all.
  existing(runtime, [LOCAL_DIR, CONFIG_DIR, CREDENTIAL_DIR])
  const credentialRemovals: string[] = []
  runtime.remove = (path: string) => { credentialRemovals.push(path) }
  const { removed, deps } = recordingDeps()
  const ui = fakeUi()
  const ctx = completeContext(runtime, ui)
  ctx.detection = detectionWith(runtime)

  assert.equal(await runUninstall(ctx, deps), 0, text(ui))

  const calls = commands(runtime)
  assert.ok(!calls.some((call) => call.endsWith(" restore")), "missing backup never runs restore")
  assert.ok(!calls.some((call) => /\sbackup\b/.test(call)), "missing backup never creates a recovery backup")
  assert.deepEqual(removed, [], "Spicetify program/config/backups are preserved")
  assert.deepEqual(credentialRemovals, [CREDENTIAL_DIR])
  assert.match(text(ui), /No Spicetify backup was found/i)
  assert.match(text(ui), /restore state is UNKNOWN/i)
  assert.match(text(ui), /config\/Marketplace\/themes\/extensions\/backups were preserved/i)
})

// ---------------------------------------------------------------------------
// Backup validation and restore gating
// ---------------------------------------------------------------------------

test("incomplete or unreadable backups block complete removal before any mutation", async () => {
  for (const scenario of [
    { name: "incomplete", xpui: 50_000 as SizeSpec, expected: /incomplete/i },
    { name: "unknown", xpui: "unreadable" as SizeSpec, expected: /unknown/i },
  ]) {
    const runtime = fakeRuntime()
    completeRequested(runtime)
    existing(runtime, [LOCAL_DIR, CONFIG_DIR, CREDENTIAL_DIR])
    const backup = installBackup(runtime, { xpui: scenario.xpui })
    const credentialRemovals: string[] = []
    runtime.remove = (path: string) => { credentialRemovals.push(path) }
    const { removed, deps } = recordingDeps({ fileSize: backup.fileSize })
    const ui = fakeUi()
    const ctx = completeContext(runtime, ui)
    ctx.detection = detectionWith(runtime)

    assert.equal(await runUninstall(ctx, deps), 1, `${scenario.name}: ${text(ui)}`)
    assert.equal(runtime.calls.length, 0, `${scenario.name}: nothing may run`)
    assert.deepEqual(removed, [], `${scenario.name}: no Spicetify-owned deletion`)
    assert.deepEqual(credentialRemovals, [], `${scenario.name}: credentials are kept too`)
    assert.match(text(ui), /Complete removal is blocked/i)
    assert.match(text(ui), scenario.expected)
    assert.match(text(ui), /Nothing was deleted/i)
  }
})

test("restoration failure stops before any deletion, credential removal or plugin command", async () => {
  const runtime = fakeRuntime()
  completeRequested(runtime)
  existing(runtime, [LOCAL_DIR, CONFIG_DIR, CREDENTIAL_DIR])
  const backup = installBackup(runtime)
  const realRun = runtime.run.bind(runtime)
  let restoreAttempts = 0
  runtime.run = (async (file: string, args: string[], options?: ExecOptions): Promise<CommandResult> => {
    if (file.includes("spicetify") && args.join(" ") === "restore") {
      restoreAttempts += 1
      return { code: 1, stdout: "", stderr: "restore failed", error: "restore failed" }
    }
    return realRun(file, args, options)
  }) as typeof runtime.run

  const credentialRemovals: string[] = []
  runtime.remove = (path: string) => { credentialRemovals.push(path) }
  const { removed, deps } = recordingDeps({ fileSize: backup.fileSize })
  const ui = fakeUi()
  const ctx = completeContext(runtime, ui)
  ctx.detection = detectionWith(runtime)

  assert.equal(await runUninstall(ctx, deps), 1, text(ui))
  assert.equal(restoreAttempts, 1)
  assert.ok(!commands(runtime).some((call) => call.includes("plugin remove")))
  assert.deepEqual(removed, [])
  assert.deepEqual(credentialRemovals, [])
  assert.match(text(ui), /config and backups were kept/i)
  assert.match(text(ui), /Spotify was NOT restored/i)
  assert.ok(!/Spotify was restored from the validated backup/i.test(text(ui)), "no false restore-success note")
})

test("an unverifiable restore (missing installed xpui.spa) aborts before deletion", async () => {
  const runtime = fakeRuntime()
  completeRequested(runtime)
  existing(runtime, [LOCAL_DIR, CONFIG_DIR, CREDENTIAL_DIR])
  const backup = installBackup(runtime, { installedXpui: "missing" })
  const credentialRemovals: string[] = []
  runtime.remove = (path: string) => { credentialRemovals.push(path) }
  const { removed, deps } = recordingDeps({ fileSize: backup.fileSize })
  const ui = fakeUi()
  const ctx = completeContext(runtime, ui)
  ctx.detection = detectionWith(runtime)

  assert.equal(await runUninstall(ctx, deps), 1, text(ui))
  assert.ok(!commands(runtime).some((call) => call.includes("plugin remove")))
  assert.deepEqual(removed, [])
  assert.deepEqual(credentialRemovals, [])
  assert.match(text(ui), /Restore verification failed/i)
  // Stock-state verification reports the missing spa bundle (new) or the
  // legacy installed-xpui lookup (old); either proves the restore was blocked.
  assert.match(text(ui), /could not locate Spotify's installed xpui\.spa|Missing Spotify app files|Spotify app file is missing/i)
  assert.match(text(ui), /config and backups were kept/i)
})

// ---------------------------------------------------------------------------
// Partial failure reporting
// ---------------------------------------------------------------------------

test("a credential-removal failure reports removed, failed and skipped components honestly", async () => {
  const runtime = fakeRuntime()
  completeRequested(runtime)
  existing(runtime, [LOCAL_DIR, CONFIG_DIR, CREDENTIAL_DIR])
  const backup = installBackup(runtime)
  runtime.remove = (path: string) => {
    if (path === CREDENTIAL_DIR) throw new Error("EBUSY: credential file is locked")
    throw new Error(`unexpected direct removal of ${path}`)
  }
  const { removed, deps } = recordingDeps({ fileSize: backup.fileSize })
  const ui = fakeUi()
  const ctx = completeContext(runtime, ui)
  ctx.detection = detectionWith(runtime)

  assert.equal(await runUninstall(ctx, deps), 1, text(ui))

  assert.deepEqual(removed, [], "directory steps after the failure are not attempted")
  const calls = commands(runtime)
  assert.ok(calls.some((call) => call.includes("plugin remove")), "earlier owned steps still ran")
  // The redundant install-extension.ps1 -Uninstall step is skipped when
  // restore succeeded and the full Spicetify config + credentials wipe is
  // planned; the bridge is removed via the config deletion instead.
  assert.ok(!calls.some((call) => call.includes("-Uninstall")), "redundant bridge uninstall is skipped when full wipe is planned")
  assert.match(text(ui), /Removal is incomplete/i)
  assert.match(text(ui), /Could not remove Bridge credentials and pinned Origin/i)
  assert.match(text(ui), /Not attempted: Spicetify installation/i)
  assert.match(text(ui), /EBUSY: credential file is locked/)
  assert.match(text(ui), /signing secret and pinned Origin may still be on disk/i)
  assert.match(text(ui), /OpenCode Spotify is not fully removed/i)
})

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

function memoryPaths(initial: string[]) {
  const entries = new Set(initial.map((path) => path.toLowerCase()))
  const under = (value: string, root: string) =>
    value === root || value.startsWith(root.endsWith("\\") ? root : `${root}\\`)
  return {
    entries,
    exists: (path: string) => {
      const needle = path.toLowerCase().replace(/[\\/]+$/, "")
      for (const entry of entries) if (under(entry, needle)) return true
      return false
    },
    remove: (path: string) => {
      const needle = path.toLowerCase().replace(/[\\/]+$/, "")
      for (const entry of [...entries]) if (under(entry, needle)) entries.delete(entry)
    },
  }
}

test("a second complete uninstall is a clean no-op and never re-deletes anything", async () => {
  const runtime = fakeRuntime()
  completeRequested(runtime)
  const backupFiles = new Map<string, number>([
    [`${CONFIG_BACKUP_DIR}\\xpui.spa`, 5_000_000],
    [`${CONFIG_BACKUP_DIR}\\login.spa`, 200_000],
    [INSTALLED_XPUI, 5_000_000],
    [INSTALLED_LOGIN, 200_000],
  ])
  const memory = memoryPaths([
    LOCAL_DIR,
    CONFIG_DIR,
    CONFIG_BACKUP_DIR,
    ...backupFiles.keys(),
    CREDENTIAL_DIR,
  ])
  runtime.exists = (path: string) => path.endsWith("install-extension.ps1") || memory.exists(path)
  runtime.isFile = (path: string) => backupFiles.has(path)
  runtime.remove = memory.remove
  const fileSize = (path: string) => backupFiles.get(path) ?? null

  const removed: string[] = []
  const deps = {
    pathInfo: () => ({ symlink: false, realPath: null }),
    removePath: (path: string) => { removed.push(path); memory.remove(path) },
    fileSize,
  }

  const firstUi = fakeUi()
  const first = completeContext(runtime, firstUi)
  first.detection = detectionWith(runtime)
  assert.equal(await runUninstall(first, deps), 0, text(firstUi))
  assert.deepEqual(removed.sort(), [CONFIG_DIR, LOCAL_DIR].sort())
  assert.equal(memory.exists(LOCAL_DIR), false)
  assert.equal(memory.exists(CONFIG_DIR), false)
  assert.equal(memory.exists(CREDENTIAL_DIR), false)

  const secondUi = fakeUi()
  const second = completeContext(runtime, secondUi)
  const detection = detectionWith(runtime)
  detection.opencode.plugin = {
    registered: false,
    version: null,
    source: null,
    local: false,
    spec: null,
    state: "absent",
  }
  detection.bridge = {
    ...detection.bridge,
    configExists: false,
    credentialValid: false,
    installed: false,
    extensionPath: null,
    extensionExists: false,
    registration: "absent",
  }
  detection.spicetify = {
    ...detection.spicetify,
    available: false,
    path: null,
    version: null,
    owner: "unknown",
    configPath: null,
    extensionsDir: null,
    bridgeRegistered: false,
  }
  second.detection = detection

  assert.equal(await runUninstall(second, deps), 0, text(secondUi))
  assert.equal(removed.length, 2, "the second run must not delete directories again")
  assert.match(text(secondUi), /Nothing to remove/i)
})

// ---------------------------------------------------------------------------
// D2: residual/manual-only complete removal is never "Nothing to remove"
// ---------------------------------------------------------------------------

test("complete removal with only manual checks reports failed components and exits 1", async () => {
  const runtime = fakeRuntime()
  completeRequested(runtime)
  existing(runtime, [LOCAL_DIR, CONFIG_DIR])
  // The fixture's built-in bridge.json would count as a credential artifact;
  // this scenario has no credentials at all.
  const withDir = runtime.exists.bind(runtime)
  runtime.exists = (path: string) => !path.toLowerCase().endsWith("bridge.json") && withDir(path)
  // No backup, no registration, no bridge, no credentials: no automatic step
  // can be planned, but the unmodifiable Spicetify state still remains.
  const credentialRemovals: string[] = []
  runtime.remove = (path: string) => { credentialRemovals.push(path) }
  const { removed, deps } = recordingDeps()
  const ui = fakeUi()
  const ctx = completeContext(runtime, ui)
  ctx.detection = detectionWith(runtime, {
    opencode: {
      ...fakeDetection(runtime).opencode,
      plugin: { registered: false, version: null, source: null, local: false, spec: null, state: "absent" },
    },
    bridge: {
      ...fakeDetection(runtime).bridge,
      configExists: false,
      credentialValid: false,
      installed: false,
      extensionPath: null,
      extensionExists: false,
      registration: "absent",
    },
    spicetify: {
      available: false,
      path: null,
      version: null,
      owner: "unknown",
      configPath: null,
      extensionsDir: null,
      bridgeRegistered: false,
    },
  })

  assert.equal(await runUninstall(ctx, deps), 1, text(ui))
  assert.deepEqual(removed, [])
  assert.deepEqual(credentialRemovals, [])
  assert.match(text(ui), /Removal is incomplete/i)
  assert.match(text(ui), /No validated Spicetify backup is available/i)
  assert.ok(!/Nothing to remove/i.test(text(ui)), "manual checks are remaining work, not a no-op")
})

test("residual-only residuals become failed components instead of a success", async () => {
  const runtime = fakeRuntime()
  completeRequested(runtime)
  // Bridge detected but Spicetify is unavailable and no extension path is
  // resolvable: a residual with no executable step.
  const withDir = runtime.exists.bind(runtime)
  runtime.exists = (path: string) => !path.toLowerCase().endsWith("bridge.json") && withDir(path)
  const { removed, deps } = recordingDeps()
  const ui = fakeUi()
  const ctx = completeContext(runtime, ui)
  ctx.detection = detectionWith(runtime, {
    opencode: {
      ...fakeDetection(runtime).opencode,
      plugin: { registered: false, version: null, source: null, local: false, spec: null, state: "absent" },
    },
    spicetify: {
      available: false,
      path: null,
      version: null,
      owner: "unknown",
      configPath: null,
      extensionsDir: null,
      bridgeRegistered: false,
    },
    bridge: {
      ...fakeDetection(runtime).bridge,
      configExists: false,
      credentialValid: false,
      installed: false,
      extensionPath: null,
      extensionExists: true,
      registration: "unknown",
    },
  })

  assert.equal(await runUninstall(ctx, deps), 1, text(ui))
  assert.deepEqual(removed, [])
  assert.match(text(ui), /Could not remove Owned Spicetify bridge extension/i)
  assert.ok(!/Nothing to remove/i.test(text(ui)))
})

// ---------------------------------------------------------------------------
// D3: shared backup policy + first-ready candidate, not first-existing
// ---------------------------------------------------------------------------

test("an unusable first backup candidate does not mask a later ready backup", async () => {
  const runtime = fakeRuntime()
  completeRequested(runtime)
  existing(runtime, [LOCAL_DIR, CONFIG_DIR, CREDENTIAL_DIR])
  // The preferred roaming backup exists but is truncated (below the shared
  // 1,000,000-byte xpui minimum); the legacy local backup is valid.
  const invalid = installBackup(runtime, { directory: CONFIG_BACKUP_DIR, xpui: 50_000 })
  const valid = installBackup(runtime, { directory: LOCAL_BACKUP_DIR, xpui: 5_000_000 })
  const fileSize = (path: string) => valid.fileSize(path) ?? invalid.fileSize(path)
  const { removed, deps } = recordingDeps({ fileSize })
  const ui = fakeUi()
  const ctx = completeContext(runtime, ui)
  ctx.detection = detectionWith(runtime)

  assert.equal(await runUninstall(ctx, deps), 0, text(ui))
  assert.ok(commands(runtime).some((call) => call.endsWith(" restore")), "the ready backup is restored")
  assert.deepEqual(removed.sort(), [CONFIG_DIR, LOCAL_DIR].sort())
  assert.match(text(ui), /validated Spicetify backup/i)
})

// ---------------------------------------------------------------------------
// D7/D8: orphan bridge file and credential-directory gating
// ---------------------------------------------------------------------------

test("an orphan bridge file is removed even without credentials or registration (plugin-only)", async () => {
  const runtime = fakeRuntime()
  existing(runtime, [LOCAL_DIR, CONFIG_DIR])
  const ui = fakeUi()
  const ctx = context(runtime, ui, fakePrompt(), { command: "uninstall", yes: true, nonInteractive: true })
  ctx.detection = detectionWith(runtime, {
    opencode: {
      ...fakeDetection(runtime).opencode,
      plugin: { registered: false, version: null, source: null, local: false, spec: null, state: "absent" },
    },
    bridge: {
      ...fakeDetection(runtime).bridge,
      configExists: false,
      credentialValid: false,
      installed: false,
      extensionExists: true,
      registration: "absent",
    },
    spicetify: { ...fakeDetection(runtime).spicetify, bridgeRegistered: false },
  })

  assert.equal(await runUninstall(ctx, recordingDeps().deps), 0, text(ui))
  assert.ok(commands(runtime).some((call) => call.includes("-Uninstall")), "orphan file removal runs the owned uninstaller")
  assert.match(text(ui), /Deletes exactly:/)
  assert.match(text(ui), /Owned Spicetify bridge extension/)
})

test("an orphan bridge file is deleted directly when Spicetify is unavailable", async () => {
  const runtime = fakeRuntime()
  const extension = "C:\\Users\\Test\\AppData\\Roaming\\spicetify\\Extensions\\opencode-spotify-bridge.js"
  existing(runtime, [extension])
  const { removed, deps } = recordingDeps()
  const ui = fakeUi()
  const ctx = context(runtime, ui, fakePrompt(), { command: "uninstall", yes: true, nonInteractive: true })
  ctx.detection = detectionWith(runtime, {
    opencode: {
      ...fakeDetection(runtime).opencode,
      plugin: { registered: false, version: null, source: null, local: false, spec: null, state: "absent" },
    },
    spicetify: {
      available: false,
      path: null,
      version: null,
      owner: "unknown",
      configPath: null,
      extensionsDir: null,
      bridgeRegistered: false,
    },
    bridge: {
      ...fakeDetection(runtime).bridge,
      configExists: false,
      credentialValid: false,
      installed: false,
      extensionPath: extension,
      extensionExists: true,
      registration: "unknown",
    },
  })

  assert.equal(await runUninstall(ctx, deps), 0, text(ui))
  assert.deepEqual(removed, [extension])
  assert.ok(!commands(runtime).some((call) => call.includes("-Uninstall")), "no ps1 without Spicetify")
})

test("L2: plugin-only residuals are remaining work and exit 1, never a clean success", async () => {
  const runtime = fakeRuntime()
  existing(runtime, [LOCAL_DIR, CONFIG_DIR])
  const { removed, deps } = recordingDeps()
  const ui = fakeUi()
  const ctx = context(runtime, ui, fakePrompt(), { command: "uninstall", yes: true, nonInteractive: true })
  ctx.detection = detectionWith(runtime, {
    opencode: {
      ...fakeDetection(runtime).opencode,
      plugin: { registered: false, version: null, source: null, local: false, spec: null, state: "absent" },
    },
    spicetify: {
      available: false,
      path: null,
      version: null,
      owner: "unknown",
      configPath: null,
      extensionsDir: null,
      bridgeRegistered: false,
    },
    bridge: {
      ...fakeDetection(runtime).bridge,
      configExists: false,
      credentialValid: false,
      installed: false,
      extensionPath: null,
      extensionExists: true,
      registration: "unknown",
    },
  })

  assert.equal(await runUninstall(ctx, deps), 1, text(ui))
  assert.deepEqual(removed, [])
  assert.match(text(ui), /Could not remove Owned Spicetify bridge extension/i)
  assert.match(text(ui), /could not be located safely/i)
  assert.ok(!/Nothing to remove/i.test(text(ui)))
  assert.ok(!/Nothing owned by OpenCode Spotify is registered/i.test(text(ui)))
})

test("complete removal deletes the credential directory even when bridge.json is absent", async () => {
  const runtime = fakeRuntime()
  completeRequested(runtime)
  existing(runtime, [LOCAL_DIR, CONFIG_DIR, CREDENTIAL_DIR])
  const backup = installBackup(runtime)
  const credentialRemovals: string[] = []
  runtime.remove = (path: string) => { credentialRemovals.push(path) }
  const { deps } = recordingDeps({ fileSize: backup.fileSize })
  const ui = fakeUi()
  const ctx = completeContext(runtime, ui)
  ctx.detection = detectionWith(runtime, {
    bridge: { ...fakeDetection(runtime).bridge, configExists: false, credentialValid: false },
  })

  assert.equal(await runUninstall(ctx, deps), 0, text(ui))
  assert.deepEqual(credentialRemovals, [CREDENTIAL_DIR])
})

// ---------------------------------------------------------------------------
// D11: registration removal must be verified, not assumed
// ---------------------------------------------------------------------------

test("a plugin remove that leaves the registration in place is reported as failure", async () => {
  const runtime = fakeRuntime()
  existing(runtime, [LOCAL_DIR, CONFIG_DIR])
  const realRun = runtime.run.bind(runtime)
  runtime.run = (async (file: string, args: string[], options?: ExecOptions): Promise<CommandResult> => {
    if (file.includes("opencode") && args[1] === "remove") {
      runtime.calls.push({ file, args: [...args] })
      return { code: 0, stdout: "removed", stderr: "" }
    }
    return realRun(file, args, options)
  }) as typeof runtime.run
  const ui = fakeUi()
  const ctx = context(runtime, ui, fakePrompt(), { command: "uninstall", yes: true, nonInteractive: true })
  ctx.detection = detectionWith(runtime, {
    bridge: { ...fakeDetection(runtime).bridge, configExists: false, installed: false, extensionExists: false },
    spicetify: { ...fakeDetection(runtime).spicetify, bridgeRegistered: false },
  })

  assert.equal(await runUninstall(ctx, recordingDeps().deps), 1, text(ui))
  assert.match(text(ui), /still present after removal/i)
  assert.match(text(ui), /Removal is incomplete/i)
})

// ---------------------------------------------------------------------------
// H3 (program absent): never delete the only recovery payload without a restore
// ---------------------------------------------------------------------------

test("H3: complete removal with Spicetify already absent preserves the only backup payload and runs no restore", async () => {
  // Both shared backup locations are covered: the roaming Backup inside the
  // config directory and the legacy %LOCALAPPDATA%\spicetify\Backup.
  for (const directory of [CONFIG_BACKUP_DIR, LOCAL_BACKUP_DIR]) {
    const runtime = fakeRuntime()
    completeRequested(runtime)
    existing(runtime, [LOCAL_DIR, CONFIG_DIR])
    const backup = installBackup(runtime, { directory })
    const { removed, deps } = recordingDeps({ fileSize: backup.fileSize })
    const ui = fakeUi()
    const ctx = completeContext(runtime, ui)
    ctx.detection = detectionWith(runtime, {
      bridge: {
        ...fakeDetection(runtime).bridge,
        configExists: false,
        credentialValid: false,
        installed: false,
        extensionExists: false,
        registration: "absent",
      },
      spicetify: {
        available: false,
        path: null,
        version: null,
        owner: "unknown",
        configPath: null,
        extensionsDir: null,
        bridgeRegistered: false,
      },
      opencode: {
        ...fakeDetection(runtime).opencode,
        plugin: { registered: false, version: null, source: null, local: false, spec: null, state: "absent" },
      },
    })

    assert.equal(await runUninstall(ctx, deps), 0, `${directory}: ${text(ui)}`)
    assert.ok(
      !commands(runtime).some((call) => call.endsWith(" restore")),
      `${directory}: nothing can be restored when the program is absent`,
    )
    assert.ok(
      !removed.includes(CONFIG_DIR) && !removed.includes(CONFIG_BACKUP_DIR) && !removed.includes(LOCAL_DIR),
      `${directory}: config, local data and the validated Backup are preserved without a restore`,
    )
    assert.deepEqual(removed, [], `${directory}: no Spicetify-owned directory is deleted without a restore`)
    assert.match(text(ui), /already absent/i)
    assert.match(text(ui), /no Spotify restore was run/i)
    assert.match(text(ui), /only recovery path/i)
    assert.match(text(ui), /Installer backups/)
    assert.match(text(ui), /Kept in this run: .*Spicetify and installer backups/i)
    assert.ok(!/restored from the validated backup/i.test(text(ui)), `${directory}: no restore success is claimed`)
  }
})

// ---------------------------------------------------------------------------
// D13/D5: scope and summary truthfulness
// ---------------------------------------------------------------------------

test("unknown-owner complete removal keeps Spicetify/backups preservations and promises no deletions", async () => {
  const runtime = fakeRuntime()
  completeRequested(runtime)
  existing(runtime, [LOCAL_DIR, CONFIG_DIR, CREDENTIAL_DIR])
  const backup = installBackup(runtime)
  const { deps } = recordingDeps({ fileSize: backup.fileSize })
  const ui = fakeUi()
  const ctx = context(runtime, ui, fakePrompt(), {
    command: "uninstall",
    dryRun: true,
    nonInteractive: true,
    complete: true,
  })
  ctx.detection = detectionWith(runtime, {
    spicetify: { ...fakeDetection(runtime).spicetify, owner: "unknown" },
  })

  assert.equal(await runUninstall(ctx, deps), 0, text(ui))
  assert.match(text(ui), /Spicetify CLI and its installation/)
  assert.match(text(ui), /Installer backups/)
  assert.ok(!/Spicetify config, Marketplace, themes and extensions:/.test(text(ui)), "no config deletion is promised")
  assert.match(text(ui), /owner or path is uncertain/i)
})

test("a successful complete removal states what it deleted instead of claiming everything was kept", async () => {
  const runtime = fakeRuntime()
  completeRequested(runtime)
  existing(runtime, [LOCAL_DIR, CONFIG_DIR, CREDENTIAL_DIR])
  const backup = installBackup(runtime)
  runtime.remove = () => {}
  const { deps } = recordingDeps({ fileSize: backup.fileSize })
  const ui = fakeUi()
  const ctx = completeContext(runtime, ui)
  ctx.detection = detectionWith(runtime)

  assert.equal(await runUninstall(ctx, deps), 0, text(ui))
  assert.match(text(ui), /Deleted in this run: .*Spicetify installation/i)
  assert.match(text(ui), /Deleted in this run: .*Spicetify config/i)
})

// ---------------------------------------------------------------------------
// Owner-managed protection: success must be verified by the binary disappearing
// ---------------------------------------------------------------------------

test("manager-owned Spicetify is removed only through its owner manager after the binary is verified gone", async () => {
  assert.deepEqual(managerUninstallArgs("scoop"), { binary: "scoop", args: ["uninstall", "spicetify-cli"] })
  assert.deepEqual(managerUninstallArgs("choco"), { binary: "choco", args: ["uninstall", "spicetify-cli", "-y"] })
  assert.deepEqual(managerUninstallArgs("winget"), {
    binary: "winget",
    args: ["uninstall", "--id", SPICETIFY_WINGET_ID, "-e", "--accept-source-agreements", "--disable-interactivity"],
  })

  for (const owner of ["scoop", "choco"] as const) {
    const runtime = fakeRuntime()
    completeRequested(runtime)
    const managerPath = "C:\\Users\\Test\\scoop\\apps\\spicetify\\current\\spicetify.exe"
    existing(runtime, [LOCAL_DIR, CONFIG_DIR, CREDENTIAL_DIR])
    const backup = installBackup(runtime)
    const present = new Set([managerPath])
    const backupExists = runtime.exists.bind(runtime)
    runtime.exists = (path: string) => present.has(path) || backupExists(path)

    const realWhich = runtime.which.bind(runtime)
    runtime.which = async (name: string) => (name === owner ? `C:\\Tools\\${owner}.exe` : realWhich(name))
    const realRun = runtime.run.bind(runtime)
    runtime.run = (async (file: string, args: string[], options?: ExecOptions): Promise<CommandResult> => {
      if (file === `C:\\Tools\\${owner}.exe` && args[0] === "uninstall") {
        runtime.calls.push({ file, args: [...args] })
        present.delete(managerPath)
        return { code: 0, stdout: "", stderr: "" }
      }
      return realRun(file, args, options)
    }) as typeof runtime.run
    runtime.remove = () => {}

    const { removed, deps } = recordingDeps({ fileSize: backup.fileSize })
    const ui = fakeUi()
    const ctx = completeContext(runtime, ui)
    ctx.detection = detectionWith(runtime, {
      spicetify: {
        ...fakeDetection(runtime).spicetify,
        owner,
        path: managerPath,
      },
    })

    assert.equal(await runUninstall(ctx, deps), 0, `${owner}: ${text(ui)}`)
    const expected = managerUninstallArgs(owner)!
    assert.ok(
      commands(runtime).some((call) => call === `C:\\Tools\\${owner}.exe ${expected.args.join(" ")}`),
      `${owner} must be uninstalled by its manager`,
    )
    assert.ok(!removed.some((path) => path.toLowerCase().endsWith("spicetify.exe")), "never delete a manager binary")
    assert.ok(removed.includes(LOCAL_DIR), "owned local data is removed only after the binary is verified gone")
    assert.ok(removed.includes(CONFIG_DIR))
  }
})

test("manager success with the binary still present is unverified and keeps local data and config", async () => {
  const runtime = fakeRuntime()
  completeRequested(runtime)
  const managerPath = "C:\\Users\\Test\\scoop\\apps\\spicetify\\current\\spicetify.exe"
  existing(runtime, [LOCAL_DIR, CONFIG_DIR, CREDENTIAL_DIR])
  const backup = installBackup(runtime)
  const present = new Set([managerPath])
  const backupExists = runtime.exists.bind(runtime)
  runtime.exists = (path: string) => present.has(path) || backupExists(path)

  const realWhich = runtime.which.bind(runtime)
  runtime.which = async (name: string) => (name === "scoop" ? "C:\\Tools\\scoop.exe" : realWhich(name))
  const realRun = runtime.run.bind(runtime)
  runtime.run = (async (file: string, args: string[], options?: ExecOptions): Promise<CommandResult> => {
    if (file === "C:\\Tools\\scoop.exe" && args[0] === "uninstall") {
      // Reports success but the binary remains.
      return { code: 0, stdout: "", stderr: "" }
    }
    return realRun(file, args, options)
  }) as typeof runtime.run
  const credentialRemovals: string[] = []
  runtime.remove = (path: string) => { credentialRemovals.push(path) }

  const { removed, deps } = recordingDeps({ fileSize: backup.fileSize })
  const ui = fakeUi()
  const ctx = completeContext(runtime, ui)
  ctx.detection = detectionWith(runtime, {
    spicetify: { ...fakeDetection(runtime).spicetify, owner: "scoop", path: managerPath },
  })

  assert.equal(await runUninstall(ctx, deps), 1, text(ui))
  assert.deepEqual(removed, [], "unverified program removal keeps local data and config")
  assert.deepEqual(credentialRemovals, [CREDENTIAL_DIR])
  assert.match(text(ui), /reported success, but .* is still present/i)
  assert.match(text(ui), /not considered removed/i)
  assert.match(text(ui), /Kept because the Spicetify package removal was not verified/i)
})

test("M7: a local-fallback backup deleted with local data is never reported as kept", async () => {
  const runtime = fakeRuntime()
  completeRequested(runtime)
  const managerPath = "C:\\Users\\Test\\scoop\\apps\\spicetify\\current\\spicetify.exe"
  existing(runtime, [LOCAL_DIR, CONFIG_DIR, CREDENTIAL_DIR])
  const backup = installBackup(runtime, { directory: LOCAL_BACKUP_DIR })
  const present = new Set([managerPath])
  const backupExists = runtime.exists.bind(runtime)
  runtime.exists = (path: string) => present.has(path) || backupExists(path)

  const realWhich = runtime.which.bind(runtime)
  runtime.which = async (name: string) => (name === "scoop" ? "C:\\Tools\\scoop.exe" : realWhich(name))
  const realRun = runtime.run.bind(runtime)
  runtime.run = (async (file: string, args: string[], options?: ExecOptions): Promise<CommandResult> => {
    if (file === "C:\\Tools\\scoop.exe" && args[0] === "uninstall") {
      runtime.calls.push({ file, args: [...args] })
      present.delete(managerPath)
      return { code: 0, stdout: "", stderr: "" }
    }
    return realRun(file, args, options)
  }) as typeof runtime.run
  runtime.remove = () => {}

  const { removed, deps } = recordingDeps({ fileSize: backup.fileSize })
  const ui = fakeUi()
  const ctx = completeContext(runtime, ui)
  ctx.detection = detectionWith(runtime, {
    spicetify: { ...fakeDetection(runtime).spicetify, owner: "scoop", path: managerPath },
  })

  assert.equal(await runUninstall(ctx, deps), 0, text(ui))
  assert.ok(removed.includes(LOCAL_DIR), "local data (including the legacy Backup) is deleted")
  assert.ok(removed.includes(CONFIG_DIR))
  assert.ok(!/Installer backups/.test(text(ui)), "the scope must not promise to keep a backup it deletes")
  assert.ok(!/Preserved backups/.test(text(ui)), "no preservation warning for a deleted backup")
  assert.ok(!/Kept in this run: .*backups/i.test(text(ui)), "the final summary must not claim deleted backups were kept")
  assert.match(text(ui), /Deleted in this run: .*Spicetify local data/i)
})


test("a missing owner manager is disclosed with the exact manual command and no data is deleted", async () => {
  const runtime = fakeRuntime()
  completeRequested(runtime)
  existing(runtime, [LOCAL_DIR, CONFIG_DIR, CREDENTIAL_DIR])
  const backup = installBackup(runtime)
  const realWhich = runtime.which.bind(runtime)
  runtime.which = async (name: string) => (name === "winget" ? undefined : realWhich(name))
  const credentialRemovals: string[] = []
  runtime.remove = (path: string) => { credentialRemovals.push(path) }
  const { removed, deps } = recordingDeps({ fileSize: backup.fileSize })
  const ui = fakeUi()
  const ctx = completeContext(runtime, ui)
  ctx.detection = detectionWith(runtime, {
    spicetify: {
      ...fakeDetection(runtime).spicetify,
      owner: "winget",
      path: "C:\\Users\\Test\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Spicetify.Spicetify\\spicetify.exe",
    },
  })

  assert.equal(await runUninstall(ctx, deps), 1, text(ui))
  assert.ok(!commands(runtime).some((call) => call.includes("winget uninstall")), "missing manager is never emulated")
  assert.deepEqual(removed, [], "program data/config are kept when no manager removal happened")
  assert.deepEqual(credentialRemovals, [CREDENTIAL_DIR])
  assert.match(text(ui), /was not found on PATH/i)
  assert.match(text(ui), /winget uninstall --id Spicetify\.Spicetify -e/)
})

test("unknown ownership never deletes anything under %APPDATA% Spicetify roots", async () => {
  const runtime = fakeRuntime()
  completeRequested(runtime)
  existing(runtime, [LOCAL_DIR, CONFIG_DIR, CREDENTIAL_DIR])
  const backup = installBackup(runtime)
  const credentialRemovals: string[] = []
  runtime.remove = (path: string) => { credentialRemovals.push(path) }
  const { removed, deps } = recordingDeps({ fileSize: backup.fileSize })
  const ui = fakeUi()
  const ctx = completeContext(runtime, ui)
  ctx.detection = detectionWith(runtime, {
    spicetify: { ...fakeDetection(runtime).spicetify, owner: "unknown" },
  })

  assert.equal(await runUninstall(ctx, deps), 1, text(ui))
  assert.ok(!removed.includes(LOCAL_DIR), "unknown-owner program data is not deleted")
  assert.ok(!removed.includes(CONFIG_DIR), "unknown-owner config/backups are not deleted")
  // Credentials are owned by OpenCode Spotify, not Spicetify, and complete removal keeps deleting them.
  assert.deepEqual(credentialRemovals, [CREDENTIAL_DIR])
  assert.match(text(ui), /ownership or path is uncertain/i)
  assert.match(text(ui), /nothing under .* was deleted/i)
})

// ---------------------------------------------------------------------------
// PATH preservation
// ---------------------------------------------------------------------------

test("PATH filtering removes only exact Spicetify entries and preserves unrelated segments verbatim", () => {
  const value = [
    " C:\\Tools ",
    "C:\\Users\\Test\\AppData\\Local\\spicetify-other",
    `${LOCAL_DIR}\\`,
    "C:\\Program Files\\Git\\cmd",
    `${LOCAL_DIR}\\bin`,
    LOCAL_DIR,
    "",
  ].join(";")

  const result = filterPathEntries(value, [LOCAL_DIR, `${LOCAL_DIR}\\bin`])

  assert.equal(
    result.value,
    " C:\\Tools ;C:\\Users\\Test\\AppData\\Local\\spicetify-other;C:\\Program Files\\Git\\cmd",
  )
  assert.deepEqual(result.removed, [`${LOCAL_DIR}\\`, `${LOCAL_DIR}\\bin`, LOCAL_DIR])
  assert.ok(!result.value.includes("spicetify-other\\"), "a sibling with the same prefix is not removed")
})

test("D18: %USERPROFILE%-style PATH entries are expanded for matching but unrelated entries stay byte-exact", () => {
  const env = {
    USERPROFILE: "C:\\Users\\Test",
    LOCALAPPDATA: "C:\\Users\\Test\\AppData\\Local",
  } as NodeJS.ProcessEnv
  const result = filterPathEntries(
    [
      "%USERPROFILE%\\AppData\\Local\\spicetify",
      "C:\\Keep This Exactly",
      "%LOCALAPPDATA%\\spicetify\\bin",
      "%UNKNOWN_VAR%\\kept",
    ].join(";"),
    [LOCAL_DIR, `${LOCAL_DIR}\\bin`],
    env,
  )
  assert.deepEqual(result.removed, [
    "%USERPROFILE%\\AppData\\Local\\spicetify",
    "%LOCALAPPDATA%\\spicetify\\bin",
  ])
  assert.equal(result.value, "C:\\Keep This Exactly;%UNKNOWN_VAR%\\kept")

  const noMatch = filterPathEntries("C:\\Tools;C:\\Windows", [LOCAL_DIR], env)
  assert.deepEqual(noMatch.removed, [])
  assert.equal(noMatch.value, "C:\\Tools;C:\\Windows")
})

test("D1: a trailing CRLF from GetEnvironmentVariable never corrupts the last unrelated PATH entry", async () => {
  const runtime = fakeRuntime()
  const writes: Array<{ env?: Record<string, string> }> = []
  let currentPath = `C:\\Tools;${LOCAL_DIR};C:\\Users\\Test\\Last Entry`
  runtime.which = async (name: string) => (name === "pwsh" ? "C:\\pwsh.exe" : undefined)
  runtime.run = (async (file: string, args: string[], options?: ExecOptions): Promise<CommandResult> => {
    if (!file.includes("pwsh")) return { code: 1, stdout: "", stderr: "unexpected" }
    if (args.join(" ").includes("GetEnvironmentVariable")) {
      // PowerShell writes a trailing CRLF; the last unrelated entry must stay
      // byte-exact (no trailing newline smuggled into it).
      return { code: 0, stdout: `${currentPath}\r\n`, stderr: "" }
    }
    writes.push({ env: options?.env as Record<string, string> | undefined })
    currentPath = options?.env?.OPENCODE_SPOTIFY_USER_PATH ?? currentPath
    return { code: 0, stdout: "", stderr: "" }
  }) as typeof runtime.run

  const result = await removeUserPathEntries(runtime, [LOCAL_DIR])
  assert.equal(result.code, 0)
  assert.deepEqual(result.removedPaths, [LOCAL_DIR])
  assert.equal(writes[0]?.env?.OPENCODE_SPOTIFY_USER_PATH, "C:\\Tools;C:\\Users\\Test\\Last Entry")
})

test("removeUserPathEntries writes back only the preserved PATH and discloses read/write/verification/missing-pwsh failures", async () => {
  const runtime = fakeRuntime()
  const writes: Array<{ args: string[]; env?: Record<string, string> }> = []
  let currentPath = `C:\\Tools;${LOCAL_DIR};C:\\Windows`
  let applyWrite = true
  let readFailure = false

  runtime.which = async (name: string) => (name === "pwsh" ? "C:\\pwsh.exe" : undefined)
  runtime.run = (async (file: string, args: string[], options?: ExecOptions): Promise<CommandResult> => {
    if (!file.includes("pwsh")) return { code: 1, stdout: "", stderr: "unexpected" }
    if (args.join(" ").includes("GetEnvironmentVariable")) {
      if (readFailure) return { code: 1, stdout: "", stderr: "", error: "access denied" }
      return { code: 0, stdout: currentPath, stderr: "" }
    }
    writes.push({ args: [...args], env: options?.env as Record<string, string> | undefined })
    if (applyWrite) currentPath = options?.env?.OPENCODE_SPOTIFY_USER_PATH ?? currentPath
    return { code: 0, stdout: "", stderr: "" }
  }) as typeof runtime.run

  const ok = await removeUserPathEntries(runtime, [LOCAL_DIR])
  assert.equal(ok.code, 0)
  assert.match(ok.stdout, /Removed 1 Spicetify PATH entry/)
  assert.deepEqual(ok.removedPaths, [LOCAL_DIR])
  assert.equal(writes.length, 1)
  assert.equal(writes[0]?.env?.OPENCODE_SPOTIFY_USER_PATH, "C:\\Tools;C:\\Windows")

  writes.length = 0
  currentPath = "C:\\Tools;C:\\Windows"
  const none = await removeUserPathEntries(runtime, [LOCAL_DIR])
  assert.equal(none.code, 0)
  assert.deepEqual(none.removedPaths, [])
  assert.match(none.stdout, /No exact Spicetify entries/)
  assert.equal(writes.length, 0, "nothing is written when no entry matched")

  // A write that reports success but leaves the entry behind is disclosed.
  writes.length = 0
  currentPath = `C:\\Tools;${LOCAL_DIR};C:\\Windows`
  applyWrite = false
  const unverified = await removeUserPathEntries(runtime, [LOCAL_DIR])
  assert.equal(unverified.code, 1)
  assert.match(unverified.error ?? "", /still contains 1 Spicetify entry/i)
  assert.deepEqual(unverified.removedPaths, [LOCAL_DIR])
  applyWrite = true

  writes.length = 0
  readFailure = true
  const readFailed = await removeUserPathEntries(runtime, [LOCAL_DIR])
  assert.equal(readFailed.code, 1)
  assert.equal(writes.length, 0)
  assert.match(readFailed.error ?? "", /Could not read the user PATH/)
  readFailure = false

  runtime.which = async () => undefined
  const missing = await removeUserPathEntries(runtime, [LOCAL_DIR])
  assert.equal(missing.code, 1)
  assert.match(missing.error ?? "", /pwsh.*not available/i)
})

test("L3: quoted PATH entries are matched, removed and verified without rewriting unrelated entries", async () => {
  const quoted = [
    `"${LOCAL_DIR}"`,
    "C:\\Keep This Exactly",
    `"${LOCAL_DIR}\\bin"`,
    "C:\\Program Files\\Git\\cmd",
  ].join(";")
  const filtered = filterPathEntries(quoted, [LOCAL_DIR, `${LOCAL_DIR}\\bin`])
  assert.deepEqual(filtered.removed, [`"${LOCAL_DIR}"`, `"${LOCAL_DIR}\\bin"`])
  assert.equal(filtered.value, "C:\\Keep This Exactly;C:\\Program Files\\Git\\cmd")

  const env = { LOCALAPPDATA: "C:\\Users\\Test\\AppData\\Local" } as NodeJS.ProcessEnv
  const expanded = filterPathEntries(
    [`"%LOCALAPPDATA%\\spicetify"`, "C:\\Keep"].join(";"),
    [LOCAL_DIR],
    env,
  )
  assert.deepEqual(expanded.removed, [`"%LOCALAPPDATA%\\spicetify"`])
  assert.equal(expanded.value, "C:\\Keep")

  // End-to-end: the persisted quoted entry is actually removed and re-read.
  const runtime = fakeRuntime()
  let currentPath = quoted
  const writes: string[] = []
  runtime.which = async (name: string) => (name === "pwsh" ? "C:\\pwsh.exe" : undefined)
  runtime.run = (async (file: string, args: string[], options?: ExecOptions): Promise<CommandResult> => {
    if (args.join(" ").includes("GetEnvironmentVariable")) return { code: 0, stdout: currentPath, stderr: "" }
    const next = options?.env?.OPENCODE_SPOTIFY_USER_PATH ?? currentPath
    writes.push(next)
    currentPath = next
    return { code: 0, stdout: "", stderr: "" }
  }) as typeof runtime.run

  const result = await removeUserPathEntries(runtime, [LOCAL_DIR, `${LOCAL_DIR}\\bin`])
  assert.equal(result.code, 0, result.error)
  assert.equal(writes.length, 1)
  assert.equal(writes[0], "C:\\Keep This Exactly;C:\\Program Files\\Git\\cmd")
  assert.equal(filterPathEntries(currentPath, [LOCAL_DIR, `${LOCAL_DIR}\\bin`]).removed.length, 0)
})

// ---------------------------------------------------------------------------
// D9/D16: dry-run is side-effect free and needs no destructive approval
// ---------------------------------------------------------------------------

test("D16: noninteractive complete dry-run succeeds without --yes and runs nothing", async () => {
  const runtime = fakeRuntime()
  completeRequested(runtime)
  existing(runtime, [LOCAL_DIR, CONFIG_DIR, CREDENTIAL_DIR])
  const backup = installBackup(runtime)
  const credentialRemovals: string[] = []
  runtime.remove = (path: string) => { credentialRemovals.push(path) }
  const { removed, deps } = recordingDeps({ fileSize: backup.fileSize })
  const ui = fakeUi()
  const ctx = context(runtime, ui, fakePrompt(), {
    command: "uninstall",
    dryRun: true,
    nonInteractive: true,
    yes: false,
    complete: true,
  })
  ctx.detection = detectionWith(runtime)
  // Force the legacy Ui dry-run path so each planned step is visibly rendered.
  ctx.report = undefined

  assert.equal(await runUninstall(ctx, deps), 0, text(ui))
  assert.equal(runtime.calls.length, 0, "dry-run executes no child process")
  assert.deepEqual(removed, [])
  assert.deepEqual(credentialRemovals, [])
  assert.ok(!/Uninstall result/i.test(text(ui)), "dry-run returns before the result summary")
  assert.ok(ui.lines.some((line) => line.startsWith("dry: ")))
})

test("D9: plugin-only --remove-credentials dry-run never prompts and never claims removal", async () => {
  const runtime = fakeRuntime()
  existing(runtime, [LOCAL_DIR, CONFIG_DIR, CREDENTIAL_DIR])
  const prompt = fakePrompt({ confirms: [true] })
  const credentialRemovals: string[] = []
  runtime.remove = (path: string) => { credentialRemovals.push(path) }
  const ui = fakeUi()
  const ctx = context(runtime, ui, prompt, {
    command: "uninstall",
    dryRun: true,
    yes: false,
    removeCredentials: true,
  })
  ctx.detection = detectionWith(runtime)

  assert.equal(await runUninstall(ctx, recordingDeps().deps), 0, text(ui))
  assert.ok(!prompt.asked.some((question) => question.includes("Delete the stored bridge credentials")))
  assert.deepEqual(credentialRemovals, [])
  assert.ok(!/Credentials: removed/.test(text(ui)))
})

// ---------------------------------------------------------------------------
// Cancellation boundaries (F5)
// ---------------------------------------------------------------------------

test("cancellation requested before the plan runs nothing and exits 130", async () => {
  const runtime = fakeRuntime()
  const ui = fakeUi()
  const ctx = context(runtime, ui, fakePrompt(), { command: "uninstall", yes: true, nonInteractive: true })
  ctx.detection = detectionWith(runtime)
  ctx.cancel.request("user")

  assert.equal(await runUninstall(ctx, recordingDeps().deps), 130, text(ui))
  assert.equal(runtime.calls.length, 0)
  assert.equal(ctx.cancel.phase, "cancelled")
})

test("cancellation during the protected restore finishes and verifies it, then stops before every deletion", async () => {
  const runtime = fakeRuntime()
  completeRequested(runtime)
  existing(runtime, [LOCAL_DIR, CONFIG_DIR, CREDENTIAL_DIR])
  const backup = installBackup(runtime)
  const realRun = runtime.run.bind(runtime)
  let restoreOptions: ExecOptions | undefined
  runtime.run = (async (file: string, args: string[], options?: ExecOptions): Promise<CommandResult> => {
    if (file.includes("spicetify") && args.join(" ") === "restore") {
      restoreOptions = options
      ctxForCancel.cancel.request("ctrl-c")
      return realRun(file, args, options)
    }
    return realRun(file, args, options)
  }) as typeof runtime.run
  const credentialRemovals: string[] = []
  runtime.remove = (path: string) => { credentialRemovals.push(path) }
  const { deps } = recordingDeps({ fileSize: backup.fileSize })
  const ui = fakeUi()
  const ctx = completeContext(runtime, ui)
  const ctxForCancel = ctx
  ctx.detection = detectionWith(runtime)

  assert.equal(await runUninstall(ctx, deps), 130, text(ui))
  assert.equal(restoreOptions?.cancel, undefined, "restore is never wired to a cancellation kill")
  assert.ok(commands(runtime).some((call) => call.endsWith(" restore")), "the protected restore ran to completion")
  assert.ok(!commands(runtime).some((call) => call.includes("plugin remove")), "no deletion starts after cancellation")
  assert.deepEqual(credentialRemovals, [])
  assert.equal(ctx.cancel.phase, "partial")
  assert.match(text(ui), /Spotify was restored from the validated backup and the restore was verified/i)
  assert.match(text(ui), /Cancellation was honoured/i)
})

test("cancellation during a boundary deletion stops the next step", async () => {
  const runtime = fakeRuntime()
  completeRequested(runtime)
  existing(runtime, [LOCAL_DIR, CONFIG_DIR, CREDENTIAL_DIR])
  const backup = installBackup(runtime)
  const realRun = runtime.run.bind(runtime)
  runtime.run = (async (file: string, args: string[], options?: ExecOptions): Promise<CommandResult> => {
    const result = await realRun(file, args, options)
    // The redundant bridge ps1 is skipped when the full wipe is planned, so
    // cancel during the registration boundary instead (the first mutating
    // step after the protected restore).
    if (file.includes("opencode") && args[1] === "remove") {
      ctxForCancel.cancel.request("user")
    }
    return result
  }) as typeof runtime.run
  const credentialRemovals: string[] = []
  runtime.remove = (path: string) => { credentialRemovals.push(path) }
  const { removed, deps } = recordingDeps({ fileSize: backup.fileSize })
  const ui = fakeUi()
  const ctx = completeContext(runtime, ui)
  const ctxForCancel = ctx
  ctx.detection = detectionWith(runtime)

  assert.equal(await runUninstall(ctx, deps), 130, text(ui))
  assert.deepEqual(credentialRemovals, [], "credential deletion never starts after the boundary")
  assert.deepEqual(removed, [], "no Spicetify directory deletion starts after the boundary")
  assert.equal(ctx.cancel.phase, "partial")
})

test("cancellation during a protected manager removal finishes it, then keeps local data and config", async () => {
  const runtime = fakeRuntime()
  completeRequested(runtime)
  const managerPath = "C:\\Users\\Test\\scoop\\apps\\spicetify\\current\\spicetify.exe"
  existing(runtime, [LOCAL_DIR, CONFIG_DIR, CREDENTIAL_DIR])
  const backup = installBackup(runtime)
  const present = new Set([managerPath])
  const backupExists = runtime.exists.bind(runtime)
  runtime.exists = (path: string) => present.has(path) || backupExists(path)
  const realWhich = runtime.which.bind(runtime)
  runtime.which = async (name: string) => (name === "scoop" ? "C:\\Tools\\scoop.exe" : realWhich(name))
  const realRun = runtime.run.bind(runtime)
  runtime.run = (async (file: string, args: string[], options?: ExecOptions): Promise<CommandResult> => {
    if (file === "C:\\Tools\\scoop.exe" && args[0] === "uninstall") {
      runtime.calls.push({ file, args: [...args] })
      present.delete(managerPath)
      ctxForCancel.cancel.request("shutdown")
      return { code: 0, stdout: "", stderr: "" }
    }
    return realRun(file, args, options)
  }) as typeof runtime.run
  runtime.remove = () => {}
  const { removed, deps } = recordingDeps({ fileSize: backup.fileSize })
  const ui = fakeUi()
  const ctx = completeContext(runtime, ui)
  const ctxForCancel = ctx
  ctx.detection = detectionWith(runtime, {
    spicetify: { ...fakeDetection(runtime).spicetify, owner: "scoop", path: managerPath },
  })

  assert.equal(await runUninstall(ctx, deps), 130, text(ui))
  assert.ok(commands(runtime).some((call) => call === "C:\\Tools\\scoop.exe uninstall spicetify-cli"), "manager removal completed")
  assert.deepEqual(removed, [], "local data/config deletion never starts after the protected removal")
  assert.equal(ctx.cancel.phase, "partial")
})

test("cancellation during credential removal stops later program/data/config deletions", async () => {
  const runtime = fakeRuntime()
  completeRequested(runtime)
  existing(runtime, [LOCAL_DIR, CONFIG_DIR, CREDENTIAL_DIR])
  const backup = installBackup(runtime)
  const credentialRemovals: string[] = []
  runtime.remove = (path: string) => {
    credentialRemovals.push(path)
    ctxForCancel.cancel.request("user")
  }
  const { removed, deps } = recordingDeps({ fileSize: backup.fileSize })
  const ui = fakeUi()
  const ctx = completeContext(runtime, ui)
  const ctxForCancel = ctx
  ctx.detection = detectionWith(runtime)

  assert.equal(await runUninstall(ctx, deps), 130, text(ui))
  assert.deepEqual(credentialRemovals, [CREDENTIAL_DIR], "the credential step itself completed")
  assert.deepEqual(removed, [], "Spicetify program/data/config deletion never starts")
  assert.equal(ctx.cancel.phase, "partial")
})

test("cancellation during the PATH step stops before the config deletion", async () => {
  const runtime = fakeRuntime()
  completeRequested(runtime)
  existing(runtime, [LOCAL_DIR, CONFIG_DIR, CREDENTIAL_DIR])
  const backup = installBackup(runtime)
  const realRun = runtime.run.bind(runtime)
  runtime.run = (async (file: string, args: string[], options?: ExecOptions): Promise<CommandResult> => {
    const result = await realRun(file, args, options)
    if (file.includes("pwsh") && args.join(" ").includes("GetEnvironmentVariable")) {
      ctxForCancel.cancel.request("user")
    }
    return result
  }) as typeof runtime.run
  runtime.remove = () => {}
  const { removed, deps } = recordingDeps({ fileSize: backup.fileSize })
  const ui = fakeUi()
  const ctx = completeContext(runtime, ui)
  const ctxForCancel = ctx
  ctx.detection = detectionWith(runtime)
  // PATH entries exist so the step is meaningful; the last unrelated entry
  // must still be preserved byte-for-byte.
  const realWhich = runtime.which.bind(runtime)
  runtime.which = async (name: string) => (name === "pwsh" ? "C:\\pwsh.exe" : realWhich(name))

  assert.equal(await runUninstall(ctx, deps), 130, text(ui))
  assert.ok(removed.includes(LOCAL_DIR), "the program deletion before PATH completed")
  assert.ok(!removed.includes(CONFIG_DIR), "config deletion never starts after the PATH boundary")
  assert.equal(ctx.cancel.phase, "partial")
})

// ---------------------------------------------------------------------------
// H3/H1: cancellation truthfulness (status, summary, precedence, messages)
// ---------------------------------------------------------------------------

test("H3: a step killed mid-mutation is failed/uncertain, never 'not attempted'", async () => {
  const runtime = fakeRuntime()
  existing(runtime, [LOCAL_DIR, CONFIG_DIR])
  const realRun = runtime.run.bind(runtime)
  runtime.run = (async (file: string, args: string[], options?: ExecOptions): Promise<CommandResult> => {
    if (file.includes("opencode") && args[1] === "remove") {
      runtime.calls.push({ file, args: [...args] })
      ctxForCancel.cancel.request("ctrl-c")
      return { code: 130, stdout: "", stderr: "", cancelled: true, error: "Cancelled by the user." }
    }
    return realRun(file, args, options)
  }) as typeof runtime.run
  const ui = fakeUi()
  const ctx = context(runtime, ui, fakePrompt(), { command: "uninstall", yes: true, nonInteractive: true })
  const ctxForCancel = ctx
  ctx.detection = detectionWith(runtime)

  assert.equal(await runUninstall(ctx, recordingDeps().deps), 130, text(ui))
  assert.ok(!commands(runtime).some((call) => call.includes("-Uninstall")), "no later bridge step started")
  assert.match(text(ui), /Could not remove Global OpenCode plugin registration/i)
  assert.match(text(ui), /stopped by cancellation after it had started/i)
  assert.ok(
    !/Not attempted: .*Global OpenCode plugin registration/i.test(text(ui)),
    "a started step is never reported as not attempted",
  )
  assert.match(text(ui), /had already started when cancellation stopped it/i)
  assert.equal(ctx.cancel.phase, "cancelled")
})

test("H3: an interrupted restore is reported failed and claims no Spicetify-owned deletion", async () => {
  const runtime = fakeRuntime()
  completeRequested(runtime)
  existing(runtime, [LOCAL_DIR, CONFIG_DIR, CREDENTIAL_DIR])
  const backup = installBackup(runtime)
  const realRun = runtime.run.bind(runtime)
  runtime.run = (async (file: string, args: string[], options?: ExecOptions): Promise<CommandResult> => {
    if (file.includes("spicetify") && args.join(" ") === "restore") {
      ctxForCancel.cancel.request("ctrl-c")
      return { code: 130, stdout: "", stderr: "", cancelled: true, error: "Cancelled by the user." }
    }
    return realRun(file, args, options)
  }) as typeof runtime.run
  const credentialRemovals: string[] = []
  runtime.remove = (path: string) => { credentialRemovals.push(path) }
  const { removed, deps } = recordingDeps({ fileSize: backup.fileSize })
  const ui = fakeUi()
  const ctx = completeContext(runtime, ui)
  const ctxForCancel = ctx
  ctx.detection = detectionWith(runtime)

  assert.equal(await runUninstall(ctx, deps), 130, text(ui))
  assert.ok(!commands(runtime).some((call) => call.includes("plugin remove")))
  assert.deepEqual(removed, [], "no Spicetify-owned directory is deleted")
  assert.deepEqual(credentialRemovals, [], "no credential deletion starts")
  assert.match(text(ui), /Could not remove Spotify restore \(prerequisite\)/i)
  assert.match(text(ui), /Spotify restore did not complete/i)
  assert.match(text(ui), /nothing Spicetify-owned was deleted/i)
  assert.ok(!/protected step finished/i.test(text(ui)), "an interrupted restore is never described as finished")
  assert.ok(!/Spotify was restored from the validated backup/i.test(text(ui)))
  assert.equal(ctx.cancel.phase, "cancelled")
})

test("H1: a real failure is never masked by a concurrent cancellation request", async () => {
  const runtime = fakeRuntime()
  completeRequested(runtime)
  existing(runtime, [LOCAL_DIR, CONFIG_DIR, CREDENTIAL_DIR])
  const backup = installBackup(runtime)
  const realRun = runtime.run.bind(runtime)
  runtime.run = (async (file: string, args: string[], options?: ExecOptions): Promise<CommandResult> => {
    if (file.includes("opencode") && args[1] === "remove") {
      runtime.calls.push({ file, args: [...args] })
      ctxForCancel.cancel.request("user")
      return { code: 1, stdout: "", stderr: "locked", error: "EACCES: registration is locked" }
    }
    return realRun(file, args, options)
  }) as typeof runtime.run
  const credentialRemovals: string[] = []
  runtime.remove = (path: string) => { credentialRemovals.push(path) }
  const { removed, deps } = recordingDeps({ fileSize: backup.fileSize })
  const ui = fakeUi()
  const ctx = completeContext(runtime, ui)
  const ctxForCancel = ctx
  ctx.detection = detectionWith(runtime)

  assert.equal(await runUninstall(ctx, deps), 1, text(ui))
  assert.match(text(ui), /Could not remove Global OpenCode plugin registration/i)
  assert.match(text(ui), /EACCES: registration is locked/i)
  assert.ok(!/Cancellation was honoured/i.test(text(ui)), "a failure is not reported as a cancellation")
  assert.deepEqual(removed, [], "no later deletion starts after the real failure")
  assert.deepEqual(credentialRemovals, [])
})

test("H1: cancellation after completed stages lists them instead of claiming no steps ran", async () => {
  const runtime = fakeRuntime()
  existing(runtime, [LOCAL_DIR, CONFIG_DIR])
  const realRun = runtime.run.bind(runtime)
  runtime.run = (async (file: string, args: string[], options?: ExecOptions): Promise<CommandResult> => {
    if (file.includes("pwsh") && args.join(" ").includes("-Uninstall")) {
      ctxForCancel.cancel.request("ctrl-c")
      return { code: 130, stdout: "", stderr: "", cancelled: true, error: "Cancelled by the user." }
    }
    return realRun(file, args, options)
  }) as typeof runtime.run
  const ui = fakeUi()
  const ctx = context(runtime, ui, fakePrompt(), { command: "uninstall", yes: true, nonInteractive: true })
  const ctxForCancel = ctx
  ctx.detection = detectionWith(runtime)

  assert.equal(await runUninstall(ctx, recordingDeps().deps), 130, text(ui))
  assert.match(text(ui), /Removed Global OpenCode plugin registration/i)
  assert.match(text(ui), /Completed stages were kept: Global OpenCode plugin registration/i)
  assert.match(text(ui), /Could not remove Owned Spicetify bridge extension/i)
  assert.ok(!/No steps in this plan were run/i.test(text(ui)), "completed work is never denied")
  assert.equal(ctx.cancel.phase, "partial")
})

test("M1: cancellation before the plan emits requested/settled events and runs nothing", async () => {
  const runtime = fakeRuntime()
  const report = fakeReport()
  const ui = fakeUi()
  const ctx = context(
    runtime,
    ui,
    fakePrompt(),
    { command: "uninstall", yes: true, nonInteractive: true },
    undefined,
    report,
  )
  ctx.detection = detectionWith(runtime)
  ctx.cancel.request("user")

  assert.equal(await runUninstall(ctx, recordingDeps().deps), 130, text(ui))
  assert.equal(runtime.calls.length, 0)
  assert.equal(ctx.cancel.phase, "cancelled")
  assert.ok(report.events.some((event) => event.type === "cancel" && event.phase === "requested"))
  assert.ok(report.events.some((event) => event.type === "cancel" && event.phase === "settled"))
})

test("dry-run remains side-effect free and makes no removal claims", async () => {
  const runtime = fakeRuntime()
  completeRequested(runtime)
  existing(runtime, [LOCAL_DIR, CONFIG_DIR, CREDENTIAL_DIR])
  const backup = installBackup(runtime)
  const credentialRemovals: string[] = []
  runtime.remove = (path: string) => { credentialRemovals.push(path) }
  const { removed, deps } = recordingDeps({ fileSize: backup.fileSize })
  const ui = fakeUi()
  const prompt = fakePrompt({ confirms: [true] })
  const ctx = context(runtime, ui, prompt, {
    command: "uninstall",
    dryRun: true,
    nonInteractive: true,
    yes: false,
    complete: true,
  })
  ctx.detection = detectionWith(runtime)
  ctx.report = undefined

  assert.equal(await runUninstall(ctx, deps), 0, text(ui))
  assert.equal(runtime.calls.length, 0, "dry-run executes no child process")
  assert.equal(prompt.asked.length, 0, "dry-run never prompts")
  assert.deepEqual(removed, [])
  assert.deepEqual(credentialRemovals, [])
  assert.ok(ui.lines.some((line) => line.startsWith("dry: ")))
  assert.ok(!/ok: Removed /i.test(text(ui)), "dry-run claims no removal")
  assert.ok(!/Deleted in this run/i.test(text(ui)))
  assert.ok(!/Complete removal finished/i.test(text(ui)))
})

// ---------------------------------------------------------------------------
// Real boundary / junction checks (private temp fixtures only)
// ---------------------------------------------------------------------------

function pathInfo(path: string): { symlink: boolean; realPath: string | null } {
  const stats = lstatSync(path)
  let realPath: string | null = null
  try {
    realPath = realpathSync.native(path)
  } catch {
    try { realPath = realpathSync(path) } catch { realPath = null }
  }
  return { symlink: stats.isSymbolicLink(), realPath }
}

test("boundary checks reject sibling prefixes and junction escapes on real temp fixtures", (t) => {
  const root = mkdtempSync(join(tmpdir(), "opencode-uninstall-boundary-"))
  // Resolve the fixture root through the same real-path lens the product code
  // uses: hosted runners may place TEMP behind a junction or 8.3 short-name
  // path, and the gate correctly fail-closes on such aliasing. Anchoring the
  // fixture to the resolved path keeps the test about the gate's decisions,
  // not about the runner's TEMP layout. Refusal cases below are unaffected.
  const rootReal = pathInfo(root).realPath ?? root
  const localRoot = join(rootReal, "local", "spicetify")
  const sibling = join(root, "local", "spicetify-other")
  const outside = join(root, "outside")
  const junction = join(root, "escape-junction")
  mkdirSync(localRoot, { recursive: true })
  mkdirSync(sibling, { recursive: true })
  mkdirSync(outside, { recursive: true })

  let linked = false
  try {
    try {
      symlinkSync(outside, junction, "junction")
      linked = true
    } catch (error) {
      t.diagnostic(`junction unavailable in this environment: ${String(error)}`)
    }

    assert.equal(isWithinBoundary(localRoot, join(localRoot, "Backup")), true)
    assert.equal(isWithinBoundary(localRoot, sibling), false)
    assert.equal(isWithinBoundary(localRoot, join(localRoot, "..", "spicetify-other")), false)
    assert.equal(isWithinBoundary(localRoot, `${localRoot}-other`), false)

    assert.equal(pathRemovalProblem(localRoot, [localRoot], pathInfo(localRoot)), null)
    assert.match(pathRemovalProblem(sibling, [localRoot], pathInfo(sibling)) ?? "", /outside/)
    assert.match(
      pathRemovalProblem(localRoot, [localRoot], { symlink: true, realPath: null }) ?? "",
      /symbolic link|junction/i,
    )

    if (linked) {
      const escaped = join(junction, "spicetify")
      mkdirSync(escaped, { recursive: true })
      const escapedInfo = pathInfo(escaped)
      assert.equal(escapedInfo.symlink, false, "the leaf is a real directory")
      assert.notEqual(escapedInfo.realPath, null)
      assert.match(pathRemovalProblem(escaped, [escaped], escapedInfo) ?? "", /resolves outside/i)

      const directLink = pathInfo(junction)
      assert.equal(directLink.symlink, true)
      assert.match(pathRemovalProblem(junction, [junction], directLink) ?? "", /symbolic link|junction/i)
    } else {
      t.diagnostic("junction assertions skipped because junctions could not be created")
    }
  } finally {
    try { if (linked) unlinkSync(junction) } catch { /* already gone */ }
    rmSync(root, { recursive: true, force: true })
    assert.equal(existsSync(root), false, "temp fixture cleanup is scoped to the fixture root")
  }
})
