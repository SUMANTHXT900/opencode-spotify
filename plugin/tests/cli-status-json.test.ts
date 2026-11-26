import { after, test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { runStatus, type StatusReport } from "../src/cli/status.ts"
import {
  bunCheck,
  doctorLockPeek,
  nodeVersionCheck,
  runDoctor,
  type DoctorReport,
} from "../src/cli/doctor.ts"
import { ownershipLabel, redactSensitive } from "../src/cli/versions.ts"
import type { Detection } from "../src/cli/types.ts"
import { context, fakeDetection, fakePrompt, fakeRuntime, fakeUi } from "./cli-fixture.ts"

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

async function statusJson(configure?: (runtime: ReturnType<typeof fakeRuntime>, detection: Detection) => void) {
  const runtime = fakeRuntime()
  const ui = fakeUi()
  const ctx = context(runtime, ui, fakePrompt(), { command: "status", json: true })
  const detection = fakeDetection(runtime)
  configure?.(runtime, detection)
  ctx.detection = detection
  const code = await runStatus(ctx)
  return { runtime, ui, ctx, code, report: ui.jsonValue as StatusReport }
}

async function doctorJson(
  configure?: (runtime: ReturnType<typeof fakeRuntime>, detection: Detection) => void,
) {
  const runtime = fakeRuntime()
  const ui = fakeUi()
  const ctx = context(runtime, ui, fakePrompt(), { command: "doctor", json: true })
  const detection = fakeDetection(runtime)
  configure?.(runtime, detection)
  ctx.detection = detection
  const code = await runDoctor(ctx)
  return { runtime, ui, ctx, code, report: ui.jsonValue as DoctorReport }
}

test("status JSON keeps every legacy field and adds diagnostics additively", async () => {
  const { report, runtime, code } = await statusJson()
  assert.equal(code, 0)

  // Legacy top-level contract (schemaVersion must stay 1 for --json consumers).
  for (const key of [
    "schemaVersion", "package", "installerVersion", "platform", "windows", "versions",
    "opencode", "registration", "spotify", "spicetify", "bridge", "port", "compatibility", "sideEffects",
  ]) {
    assert.ok(key in report, `missing legacy key ${key}`)
  }
  assert.equal(report.schemaVersion, 1)
  assert.equal(report.package, "opencode-spotify")
  assert.equal(report.sideEffects, "none")

  // Legacy nested shapes.
  for (const key of ["installed", "latest", "beta"]) assert.ok(key in report.versions.plugin)
  for (const key of ["installed", "latest"]) assert.ok(key in report.versions.spicetify)
  for (const key of ["registered", "local", "spec", "source", "state"]) assert.ok(key in report.registration)
  for (const key of [
    "credentialFile", "credentialValid", "installed", "origins", "extension",
    "extensionExists", "registration", "protocol",
  ]) assert.ok(key in report.bridge)
  for (const key of ["port", "busy", "likelyOwnedByThisPlugin"]) assert.ok(key in report.port)
  for (const key of ["minimum", "opencode", "spicetify", "bridge", "plugin"]) assert.ok(key in report.compatibility)
  assert.equal(report.bridge.protocol, 2)
  assert.equal(report.registration.registered, true)

  // Additive diagnostic blocks.
  assert.equal(report.runtime.connection, "not-probed")
  assert.equal(report.runtime.playbackVerified, false)
  assert.equal(report.ownership.registration, "global")
  assert.equal(report.ownership.registrationLabel, "global package")
  assert.equal(report.port.loopback, "127.0.0.1")
  assert.equal(report.port.owner, "none")
  assert.equal(report.port.conflict, false)
  assert.equal(report.updates.plugin.status, "unknown")
  assert.equal(report.updates.spicetify.status, "unknown")
  assert.equal(report.dependencies.status, "unknown")
  assert.equal(report.conflicts.projectLocal, null)

  assert.deepEqual(runtime.calls, [], "status must never execute commands")
})

test("ownership labels are stable and port ownership never claims a foreign listener", async () => {
  assert.equal(ownershipLabel("script"), "official installer")
  assert.equal(ownershipLabel("winget"), "winget package")
  assert.equal(ownershipLabel("scoop"), "scoop package")
  assert.equal(ownershipLabel("choco"), "chocolatey package")
  assert.equal(ownershipLabel("unknown"), "unknown owner")

  const free = await statusJson()
  assert.equal(free.report.port.owner, "none")
  assert.equal(free.report.port.conflict, false)

  const own = await statusJson((_runtime, detection) => {
    detection.port = { busy: true, likelyOwnedByThisPlugin: true }
  })
  assert.equal(own.report.port.owner, "this-plugin")
  assert.equal(own.report.port.conflict, false)

  const foreign = await statusJson((_runtime, detection) => {
    detection.port = { busy: true, likelyOwnedByThisPlugin: false }
  })
  assert.equal(foreign.report.port.owner, "unknown")
  assert.equal(foreign.report.port.conflict, true)

  const unknown = await statusJson((_runtime, detection) => {
    detection.port = { busy: true, likelyOwnedByThisPlugin: null }
  })
  assert.equal(unknown.report.port.owner, "unknown")
  assert.equal(unknown.report.port.conflict, true)

  const scoop = await statusJson((_runtime, detection) => {
    detection.spicetify = { ...detection.spicetify, owner: "scoop" }
  })
  assert.equal(scoop.report.ownership.spicetify, "scoop")
  assert.equal(scoop.report.ownership.spicetifyLabel, "scoop package")
})

test("status JSON never carries credential values echoed by inspection", async () => {
  const secret = "a".repeat(64)
  const { report } = await statusJson((_runtime, detection) => {
    detection.opencode.plugin = {
      ...detection.opencode.plugin,
      detail: `secret=${secret}`,
    }
    detection.bridge = { ...detection.bridge, error: `token=${secret}` }
    detection.spicetify = { ...detection.spicetify, error: `password=${secret}` }
  })
  const serialized = JSON.stringify(report)
  assert.ok(!serialized.includes(secret), "credential value leaked into status JSON")
  assert.match(serialized, /\[redacted\]/)
  assert.equal(report.bridge.credentialValid, true)
})

test("sanitized issue report redacts secrets, e-mail addresses, and personal paths", async () => {
  const secret = "f".repeat(64)
  const { report } = await doctorJson((_runtime, detection) => {
    detection.opencode.plugin = {
      registered: false,
      version: null,
      source: null,
      local: false,
      spec: null,
      state: "unknown",
      detail: `token=${secret} at C:\\Users\\Alice\\project and mail alice@example.com`,
    }
    detection.compatibility = { ...detection.compatibility, plugin: "unknown" }
  })

  assert.equal(report.schemaVersion, 1)
  assert.equal(report.readOnly, true)
  assert.equal(report.runtime.connection, "not-probed")
  assert.equal(report.runtime.playbackVerified, false)
  assert.ok(Array.isArray(report.checks))
  assert.deepEqual(Object.keys(report.summary).sort(), ["fail", "ok", "warn"])

  assert.ok(!report.sanitizedReport.includes(secret), "secret leaked into sanitized report")
  assert.ok(!report.sanitizedReport.includes("Alice"), "user name leaked into sanitized report")
  assert.ok(!report.sanitizedReport.includes("alice@example.com"), "e-mail leaked into sanitized report")
  assert.match(report.sanitizedReport, /\[redacted/)
  assert.match(report.sanitizedReport, /<user>/)
  assert.match(report.sanitizedReport, /OpenCode Spotify diagnostics report \(sanitized\)/)
  assert.match(report.sanitizedReport, /Runtime connection not probed; playback verified: no/i)

  const serialized = JSON.stringify(report)
  assert.ok(!serialized.includes(secret), "secret leaked into doctor JSON")
  assert.ok(!serialized.includes("alice@example.com"), "e-mail leaked into doctor JSON")

  assert.equal(
    redactSensitive(`C:\\Users\\Bob\\file token=${secret}`),
    "C:\\Users\\<user>\\file token=[redacted]",
  )
})

test("dependency inspection is read-only and distinguishes missing packages from unknown state", async () => {
  const runtime = fakeRuntime()
  const manifestPath = fileURLToPath(new URL("../package.json", import.meta.url))
  const root = dirname(manifestPath)
  const names = ["@inkjs/ui", "@opencode/plugin", "@opentui/core", "@opentui/solid", "ink", "react", "solid-js", "ws"]
  const installed = new Map<string, string>()
  for (const name of names) installed.set(join(root, "node_modules", name, "package.json"), "1.0.0")
  runtime.readText = (path: string) => {
    if (path === manifestPath) {
      return JSON.stringify({ dependencies: Object.fromEntries(names.map((name) => [name, "1.0.0"])) })
    }
    const version = installed.get(path)
    return version ? JSON.stringify({ version }) : ""
  }

  const ui = fakeUi()
  const ctx = context(runtime, ui, fakePrompt(), { command: "status", json: true })
  ctx.detection = fakeDetection(runtime)
  assert.equal(await runStatus(ctx), 0)
  const healthy = ui.jsonValue as StatusReport
  assert.equal(healthy.dependencies.status, "ok")
  assert.deepEqual(healthy.dependencies.missing, [])
  assert.ok(healthy.dependencies.checks.every((check) => check.status === "ok"))
  for (const name of ["ink", "react", "@inkjs/ui"]) {
    const check = healthy.dependencies.checks.find((entry) => entry.name === name)
    assert.ok(check, `diagnostic dependency ${name} missing from the checks`)
    assert.equal(check?.declared, "1.0.0")
    assert.equal(check?.status, "ok")
  }
  assert.deepEqual(runtime.calls, [], "dependency inspection must not execute anything")

  installed.delete(join(root, "node_modules", "ws", "package.json"))
  const missingUi = fakeUi()
  const missingCtx = context(runtime, missingUi, fakePrompt(), { command: "status", json: true })
  missingCtx.detection = fakeDetection(runtime)
  assert.equal(await runStatus(missingCtx), 0)
  const missing = missingUi.jsonValue as StatusReport
  assert.equal(missing.dependencies.status, "warn")
  assert.deepEqual(missing.dependencies.missing, ["ws"])
  assert.equal(missing.dependencies.checks.find((check) => check.name === "ws")?.status, "missing")
})

test("doctor flags local/global duplicate sources and never claims playback", async () => {
  const { report, runtime } = await doctorJson((runtime, detection) => {
    const baseRun = runtime.run.bind(runtime)
    runtime.run = async (file, args, options) => {
      if (file.includes("opencode") && args.join(" ") === "plugin list") {
        return {
          code: 0,
          stdout: [
            "ID VERSION SOURCE",
            "opencode-spotify 0.6.0 npm",
            "opencode-spotify local C:\\Projects\\demo\\plugin",
          ].join("\n"),
          stderr: "",
        }
      }
      return baseRun(file, args, options)
    }
    detection.opencode = {
      ...detection.opencode,
      plugin: {
        registered: true,
        version: "0.6.0",
        source: "npm",
        local: false,
        spec: "opencode-spotify@0.6.0",
        state: "registered",
      },
    }
  })

  const duplicate = report.checks.find((check) => check.id === "duplicate-registration")
  assert.ok(duplicate, "duplicate-registration check missing")
  assert.equal(duplicate?.status, "warn")
  assert.match(duplicate?.message ?? "", /Duplicate plugin sources/i)
  assert.ok(report.checks.some((check) => check.id === "project-conflict" && check.status === "warn"))
  assert.ok(report.checks.some((check) => check.id === "port"))
  assert.ok(report.checks.some((check) => check.id === "dependencies"))
  assert.ok(report.checks.some((check) => check.id === "updates"))
  assert.equal(report.environment.port.loopback, "127.0.0.1")
  assert.equal(report.runtime.playbackVerified, false)

  for (const check of report.checks) {
    assert.doesNotMatch(check.message, /playback (?:was|is|has been) verified/i)
  }
  const guidance = report.checks.map((check) => `${check.message} ${check.fix ?? ""}`).join("\n")
  assert.doesNotMatch(guidance, /winget\s+(?:install|upgrade)/i, "diagnostics must not instruct Winget use")
  assert.match(guidance, /official installer/i)
})

test("status surfaces available updates and local/global source conflicts", async () => {
  const runtime = fakeRuntime()
  runtime.state.opencode.listVersion = "0.6.0"
  const ui = fakeUi()
  const ctx = context(
    runtime,
    ui,
    fakePrompt(),
    { command: "status", json: true },
    { plugin: { latest: "0.7.0" }, spicetify: { latest: "2.47.0" } },
  )
  ctx.detection = fakeDetection(runtime)
  assert.equal(await runStatus(ctx), 0)
  const report = ui.jsonValue as StatusReport
  assert.equal(report.updates.plugin.status, "outdated")
  assert.equal(report.updates.plugin.available, true)
  assert.equal(report.updates.spicetify.status, "outdated")
  assert.deepEqual(runtime.calls, [], "status must not apply updates")

  const local = await statusJson((_runtime, detection) => {
    detection.opencode.plugin = {
      registered: true,
      version: "local",
      source: "C:\\dev\\opencode-spotify",
      local: true,
      spec: "C:\\dev\\opencode-spotify",
      state: "registered",
    }
  })
  assert.equal(local.report.ownership.registration, "local")
  assert.equal(local.report.ownership.registrationLabel, "local development source")
  assert.equal(local.report.conflicts.globalLocalSource, true)
  assert.ok(local.report.conflicts.details.length > 0)
})

test("beta installs never warn installed-newer when the beta tag matches", async () => {
  const runtime = fakeRuntime()
  runtime.state.opencode.listVersion = "0.6.0-beta.2"
  const ui = fakeUi()
  const ctx = context(
    runtime,
    ui,
    fakePrompt(),
    { command: "status", json: true },
    { plugin: { latest: "0.5.7", latestBeta: "0.6.0-beta.2" }, spicetify: { latest: null } },
  )
  ctx.detection = fakeDetection(runtime)
  assert.equal(await runStatus(ctx), 0)
  const report = ui.jsonValue as StatusReport
  assert.equal(report.updates.plugin.status, "current")
  assert.equal(report.updates.plugin.available, false)
})

test("status text separates registration from runtime and points at the official installer", async () => {
  const runtime = fakeRuntime()
  const ui = fakeUi()
  const ctx = context(runtime, ui, fakePrompt(), { command: "status" })
  ctx.detection = fakeDetection(runtime)
  assert.equal(await runStatus(ctx), 0)
  const text = ui.lines.join("\n")
  assert.match(text, /Runtime: not probed/i)
  assert.match(text, /registration does not prove a live connection/i)
  assert.doesNotMatch(text, /playback (?:was|is|has been) verified/i)
  assert.doesNotMatch(text, /winget\s+(?:install|upgrade)/i)
})

// ---------------------------------------------------------------------------
// B33: Node.js floor, Bun note, read-only lock peek
// ---------------------------------------------------------------------------

test("doctor enforces the full Node.js 22.18.0 floor, not just the major version", () => {
  const old = nodeVersionCheck("22.17.0")
  assert.equal(old.id, "node")
  assert.equal(old.status, "fail")
  assert.match(old.message, /22\.17\.0/)
  assert.match(old.fix ?? "", /22\.18\.0/)

  const floor = nodeVersionCheck("22.18.0")
  assert.equal(floor.status, "ok")
  assert.equal(floor.fix, undefined)

  assert.equal(nodeVersionCheck("22.18.1").status, "ok")
  assert.equal(nodeVersionCheck("23.0.0").status, "ok")
  assert.equal(nodeVersionCheck("not-a-version").status, "fail")
})

test("doctor notes Bun and peeks at the installer lock without probing processes", async () => {
  const lockRoot = tempDir("doctor-lock-")
  const lockDirectory = join(lockRoot, "opencode-spotify")
  const lockPath = join(lockDirectory, "installer.lock")
  mkdirSync(lockDirectory, { recursive: true })
  writeFileSync(lockPath, JSON.stringify({
    schemaVersion: 1,
    pid: 4242,
    startedAt: 1,
    processStartTime: null,
    command: "setup",
    host: "test-host",
    nonce: "abcdefgh",
  }))

  const { report, runtime } = await doctorJson((runtime) => {
    // installerLockPath reads the runtime environment; either branch resolves
    // under this temp root on Windows or POSIX.
    runtime.env.LOCALAPPDATA = lockRoot
    runtime.env.XDG_STATE_HOME = lockRoot
  })

  const bun = report.checks.find((check) => check.id === "bun")
  assert.ok(bun, "bun presence note missing")
  assert.equal(bun?.status, "info")
  assert.match(bun?.message ?? "", /Bun/i)

  const lock = report.checks.find((check) => check.id === "installer-lock")
  assert.ok(lock, "installer lock note missing")
  assert.equal(lock?.status, "info")
  assert.match(lock?.message ?? "", /pid 4242/)
  assert.match(lock?.message ?? "", /not probed/i)
  assert.equal(report.environment.lock.status, "present")
  assert.equal(report.environment.lock.path, lockPath)
  assert.equal(report.environment.lock.pid, 4242)
  assert.equal(report.environment.lock.command, "setup")
  assert.equal(report.environment.lock.startedAt, 1)
  assert.ok(
    !runtime.calls.some((call) => /Get-Process|tasklist|taskkill/i.test(`${call.file} ${call.args.join(" ")}`)),
    "the lock peek must not probe processes",
  )

  // No lock file: the peek is absent and the check is omitted.
  const missingRoot = tempDir("doctor-lock-absent-")
  const clean = fakeRuntime()
  clean.env.LOCALAPPDATA = missingRoot
  clean.env.XDG_STATE_HOME = missingRoot
  assert.equal((await doctorLockPeek(clean)).status, "absent")
  const ui = fakeUi()
  const ctx = context(clean, ui, fakePrompt(), { command: "doctor", json: true })
  ctx.detection = fakeDetection(clean)
  await runDoctor(ctx)
  const absentReport = ui.jsonValue as DoctorReport
  assert.equal(absentReport.checks.find((check) => check.id === "installer-lock"), undefined)
})

test("bunCheck reports presence or absence without failing diagnostics", () => {
  const present = bunCheck("C:\\Program Files\\Bun\\bun.exe")
  const absent = bunCheck(undefined)
  assert.equal(present.status, "info")
  assert.match(present.message, /Bun found at/)
  assert.equal(absent.status, "info")
  assert.match(absent.message, /Bun was not found/)
})
