// B06: applyBridge progress forwarding coverage.
// Fake runtimes only: this file never touches Spotify, Spicetify, the real
// bridge credential store, or the user's configuration.
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { applyBridge } from "../src/cli/bridge.ts"
import type { CommandResult, Runtime } from "../src/cli/types.ts"

const SPICETIFY = "C:\\spicetify.exe"
const LOCALAPPDATA = "C:\\Users\\Test\\AppData\\Local"
const SECRET = "a".repeat(64)

interface FakeApplyRuntime {
  runtime: Runtime
  calls: Array<{ file: string; args: string[] }>
  timeline: string[]
}

/**
 * Minimal apply/backup fake. `backupExists` drives the B09/B24 pre-flight
 * detection; `applies` supplies one result per `apply` invocation in order.
 */
function makeRuntime(options: {
  backupExists: boolean
  /** When provided, only these exact backup directories count as present. */
  backupDirs?: string[]
  backup?: CommandResult
  applies?: CommandResult[]
}): FakeApplyRuntime {
  const calls: Array<{ file: string; args: string[] }> = []
  const timeline: string[] = []
  let applyIndex = 0
  const runtime = {
    platform: "win32" as const,
    arch: "x64",
    env: { LOCALAPPDATA } as NodeJS.ProcessEnv,
    cwd: "C:\\Projects\\demo",
    homedir: "C:\\Users\\Test",
    async run(file: string, args: string[]) {
      calls.push({ file, args: [...args] })
      timeline.push(`run:${args.join(" ")}`)
      if (args.join(" ") === "backup") {
        return options.backup ?? { code: 0, stdout: "backup ok", stderr: "" }
      }
      if (args.join(" ") === "apply") {
        return options.applies?.[applyIndex++] ?? { code: 0, stdout: "applied", stderr: "" }
      }
      return { code: 1, stdout: "", stderr: "unexpected command" }
    },
    async which(name: string) {
      return name === "spicetify" ? SPICETIFY : undefined
    },
    // hasMissingBackup probes the backup candidates with the shared detailed
    // inspector: a present directory only counts when it holds both restore
    // archives at plausible sizes.
    exists: (path: string) =>
      options.backupDirs
        ? options.backupDirs.some((dir) => dir.toLowerCase() === path.toLowerCase())
        : options.backupExists && /[\\/]Backup$/.test(path),
    isFile: () => false,
    fileSize: (path: string) => {
      const lower = path.toLowerCase()
      if (lower.endsWith("xpui.spa")) return 1_000_000
      if (lower.endsWith("login.spa")) return 100_000
      return null
    },
    listDir: (dir: string) => {
      const present = options.backupDirs
        ? options.backupDirs.some((candidate) => candidate.toLowerCase() === dir.toLowerCase())
        : options.backupExists && /[\\/]Backup$/.test(dir)
      return present ? ["xpui.spa", "login.spa"] : null
    },
    readText: () => "",
    writeText: () => {},
    copyFile: () => {},
    mkdir: () => {},
    remove: () => {},
    now: () => 0,
    async portOpen() {
      return false
    },
  }
  return { runtime: runtime as unknown as Runtime, calls, timeline }
}

test("B06 missing backup: progress preserves detection, backup, apply, verification order", async () => {
  const { runtime, calls, timeline } = makeRuntime({ backupExists: false })
  const result = await applyBridge(runtime, {
    spicetifyPath: SPICETIFY,
    onProgress: (line) => timeline.push(`progress:${line}`),
  })

  assert.equal(result.code, 0)
  // Backup-first flow is intact and each progress line precedes its command.
  assert.deepEqual(timeline, [
    "progress:Spicetify backup not found; creating a backup before apply.",
    "run:backup",
    "progress:Spicetify backup created.",
    "progress:Running spicetify apply.",
    "run:apply",
    "progress:Spicetify apply completed (playback not verified).",
  ])
  assert.deepEqual(
    calls.map((call) => call.args.join(" ")),
    ["backup", "apply"],
    "backup runs before apply",
  )
  assert.ok(calls.every((call) => call.file === SPICETIFY), "only spicetify is invoked; pwsh is untouched")
})

test("B06 existing backup: no backup step, apply and verification still reported", async () => {
  const { runtime, calls } = makeRuntime({ backupExists: true })
  const progress: string[] = []
  const result = await applyBridge(runtime, {
    spicetifyPath: SPICETIFY,
    onProgress: (line) => progress.push(line),
  })

  assert.equal(result.code, 0)
  assert.deepEqual(progress, [
    "Running spicetify apply.",
    "Spicetify apply completed (playback not verified).",
  ])
  assert.deepEqual(calls.map((call) => call.args.join(" ")), ["apply"])
})

test("B06/B05 roaming or legacy backups suppress the unnecessary backup step", async () => {
  const ROAMING = "C:\\Users\\Test\\AppData\\Roaming\\spicetify\\Backup"
  const LEGACY_LOCAL = "C:\\Users\\Test\\AppData\\Local\\Spicetify\\Backup"

  for (const [label, backupDir] of [
    ["roaming APPDATA", ROAMING],
    ["legacy LOCALAPPDATA", LEGACY_LOCAL],
  ] as const) {
    const { runtime, calls } = makeRuntime({ backupExists: false, backupDirs: [backupDir] })
    const progress: string[] = []
    const result = await applyBridge(runtime, {
      spicetifyPath: SPICETIFY,
      onProgress: (line) => progress.push(line),
    })

    assert.equal(result.code, 0, label)
    assert.deepEqual(calls.map((call) => call.args.join(" ")), ["apply"], `${label} backup is not recreated`)
    assert.deepEqual(progress, [
      "Running spicetify apply.",
      "Spicetify apply completed (playback not verified).",
    ])
  }
})

test("B06 failed backup probe fails closed instead of forcing a backup", async () => {
  const { runtime, calls } = makeRuntime({ backupExists: false })
  const throwing = {
    ...runtime,
    exists: () => {
      throw new Error("probe unavailable")
    },
  } as unknown as Runtime
  const progress: string[] = []
  const result = await applyBridge(throwing, {
    spicetifyPath: SPICETIFY,
    onProgress: (line) => progress.push(line),
  })

  assert.equal(result.code, 0)
  assert.deepEqual(calls.map((call) => call.args.join(" ")), ["apply"], "no speculative backup on probe failure")
  assert.deepEqual(progress, [
    "Running spicetify apply.",
    "Spicetify apply completed (playback not verified).",
  ])
})


test("B06 failed backup: reports detection only, never claims apply or verification", async () => {
  const { runtime, calls } = makeRuntime({
    backupExists: false,
    backup: { code: 1, stdout: "", stderr: "disk full", error: "disk full" },
  })
  const progress: string[] = []
  const result = await applyBridge(runtime, {
    spicetifyPath: SPICETIFY,
    onProgress: (line) => progress.push(line),
  })

  assert.equal(result.code, 1)
  assert.match(result.error ?? "", /backup/i)
  assert.deepEqual(progress, ["Spicetify backup not found; creating a backup before apply."])
  assert.deepEqual(calls.map((call) => call.args.join(" ")), ["backup"], "apply never runs after a failed backup")
})

test("B06 backup-related apply failure: retry reports its own lines and completion only on success", async () => {
  const { runtime, calls } = makeRuntime({
    backupExists: true,
    applies: [
      { code: 1, stdout: "", stderr: "no backup found", error: "no backup found" },
      { code: 0, stdout: "applied", stderr: "" },
    ],
  })
  const progress: string[] = []
  const result = await applyBridge(runtime, {
    spicetifyPath: SPICETIFY,
    onProgress: (line) => progress.push(line),
  })

  assert.equal(result.code, 0)
  assert.deepEqual(progress, [
    "Running spicetify apply.",
    "Spicetify apply reported a missing backup; creating a backup before retry.",
    "Spicetify backup created.",
    "Running spicetify apply.",
    "Spicetify apply completed (playback not verified).",
  ])
  assert.deepEqual(calls.map((call) => call.args.join(" ")), ["apply", "backup", "apply"])
})

test("B06 missing backup then backup-related failure: no second backup, no completion line", async () => {
  const { runtime, calls } = makeRuntime({
    backupExists: false,
    applies: [{ code: 1, stdout: "", stderr: "no backup found", error: "no backup found" }],
  })
  const progress: string[] = []
  const result = await applyBridge(runtime, {
    spicetifyPath: SPICETIFY,
    onProgress: (line) => progress.push(line),
  })

  assert.equal(result.code, 1)
  assert.match(result.error ?? "", /not retrying/i)
  assert.deepEqual(progress, [
    "Spicetify backup not found; creating a backup before apply.",
    "Spicetify backup created.",
    "Running spicetify apply.",
  ])
  assert.deepEqual(
    calls.map((call) => call.args.join(" ")),
    ["backup", "apply"],
    "an in-invocation backup is never overwritten",
  )
  assert.ok(!/apply completed/i.test(progress.join("\n")))

  // Failed retry also stays silent about success.
  const retryOnly = makeRuntime({
    backupExists: true,
    applies: [
      { code: 1, stdout: "", stderr: "no backup found", error: "no backup found" },
      { code: 1, stdout: "", stderr: "boom", error: "boom" },
    ],
  })
  const retryProgress: string[] = []
  const retryResult = await applyBridge(retryOnly.runtime, {
    spicetifyPath: SPICETIFY,
    onProgress: (line) => retryProgress.push(line),
  })
  assert.equal(retryResult.code, 1)
  assert.ok(!/apply completed/i.test(retryProgress.join("\n")), "failed retry never reports completion")
})

test("B06 non-backup apply failure: no backup step and no completion progress", async () => {
  const { runtime, calls } = makeRuntime({
    backupExists: true,
    applies: [
      { code: 1, stdout: "config backup.json preserved", stderr: "", error: "apply failed (config backup.json preserved)" },
    ],
  })
  const progress: string[] = []
  const result = await applyBridge(runtime, {
    spicetifyPath: SPICETIFY,
    onProgress: (line) => progress.push(line),
  })

  assert.equal(result.code, 1)
  assert.deepEqual(progress, ["Running spicetify apply."])
  assert.deepEqual(calls.map((call) => call.args.join(" ")), ["apply"], "incidental backup wording never triggers backup")
})

test("B06 progress is optional and a throwing sink never breaks apply", async () => {
  const proceed = makeRuntime({ backupExists: true })
  const withoutSink = await applyBridge(proceed.runtime, { spicetifyPath: SPICETIFY })
  assert.equal(withoutSink.code, 0, "apply works with no progress sink")

  const guarded = makeRuntime({ backupExists: false })
  let delivered = 0
  const result = await applyBridge(guarded.runtime, {
    spicetifyPath: SPICETIFY,
    onProgress: () => {
      delivered++
      throw new Error("sink exploded")
    },
  })
  assert.equal(result.code, 0, "a broken progress sink must not abort the mutation")
  assert.equal(delivered, 4, "every line is still offered to the sink")
  assert.deepEqual(
    guarded.calls.map((call) => call.args.join(" ")),
    ["backup", "apply"],
    "backup-first flow still completes",
  )
})

test("B06 progress never prints secrets, absolute paths, or an unverified claim", async () => {
  const { runtime } = makeRuntime({ backupExists: false })
  const progress: string[] = []
  const result = await applyBridge(runtime, {
    spicetifyPath: SPICETIFY,
    onProgress: (line) => progress.push(line),
  })
  assert.equal(result.code, 0)
  const text = progress.join("\n")
  assert.ok(!text.includes(SECRET), "credential secret never reaches progress")
  assert.ok(!/[a-f0-9]{64}/.test(text), "no 64-hex credential material in progress")
  assert.ok(!/[A-Za-z]:\\/.test(text), "no absolute paths in progress")
  assert.ok(!/playback (was|is|has been) verified/i.test(text), "never claims playback was verified")
  assert.match(text, /playback not verified/i)
})

test("B06/F5 removal is restore-only: it never routes through apply or creates a backup", () => {
  const uninstall = readFileSync(new URL("../src/cli/uninstall.ts", import.meta.url), "utf8")
  assert.ok(!/\bapplyBridge\b/.test(uninstall), "uninstall never calls applyBridge (which may create a backup)")
  assert.ok(!/\bbackupSpicetify\b/.test(uninstall), "uninstall never calls backupSpicetify")
  assert.ok(!/\["backup"\]/.test(uninstall), "uninstall never runs `spicetify backup`")
  assert.match(uninstall, /\["restore"\]/, "removal uses the protected restore step")
})

test("B06 progress sink stays a plain string closure for a future ctx.report.progress", async () => {
  // The bridge intentionally knows nothing about the UI or the store: callers
  // close over their reporter and tag each line with the "apply" command.
  const report = {
    events: [] as Array<{ command: string; line: string }>,
    progress(command: string, line: string) {
      this.events.push({ command, line })
    },
  }
  const { runtime } = makeRuntime({ backupExists: true })
  const result = await applyBridge(runtime, {
    spicetifyPath: SPICETIFY,
    onProgress: (line) => report.progress("apply", line),
  })

  assert.equal(result.code, 0)
  assert.equal(report.events.length, 2)
  assert.ok(report.events.every((event) => event.command === "apply"))
  assert.deepEqual(
    report.events.map((event) => event.line),
    ["Running spicetify apply.", "Spicetify apply completed (playback not verified)."],
  )
})
