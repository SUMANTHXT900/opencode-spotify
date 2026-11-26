// D23 security regression coverage.
//
// Focus: credential/token redaction in every sanitizer, redaction of restore
// and credential-removal diagnostics end-to-end, destructive UNINSTALL
// enforcement (typed phrase, environment signal, --non-interactive, --yes,
// dry-run), and refusal to follow a symlinked/junction credential directory.
//
// All file-system fixtures live in a private temp root created by the test and
// removed in a finally block. No real credential directory is ever deleted.
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  OFFICIAL_INSTALLER_MARKETPLACE_BLOCK_BYTES,
  OFFICIAL_INSTALLER_PATCHED_BYTES,
  OFFICIAL_INSTALLER_PATCHED_SHA256,
  OFFICIAL_INSTALLER_SHA256,
} from "../src/cli/compat.ts"
import {
  buildOfficialWrapperCommand,
  officialInstallerWarnings,
  patchOfficialInstallerScript,
  verifyOfficialInstallerScript,
} from "../src/cli/spicetify-official.ts"
import { officialScriptBytes } from "./release-fixture.ts"
import { removeCredentials } from "../src/cli/bridge.ts"
import { sanitizeDetail } from "../src/cli/runtime.ts"
import { sanitizeMessage } from "../src/cli/state.ts"
import { sanitizeErrorDetail, sanitizeLogMessage } from "../src/cli/ui/progress-view.ts"
import {
  COMPLETE_CONSENT_ATTEMPTS,
  UNINSTALL_CONFIRMATION_PHRASE,
  confirmCompleteRemoval,
} from "../src/cli/ui/uninstall-view.ts"
import { runUninstall } from "../src/cli/uninstall.ts"
import { redactSensitive } from "../src/cli/versions.ts"
import type { CommandResult, ExecOptions, Prompter } from "../src/cli/types.ts"
import { context, fakeDetection, fakeRuntime, fakeUi } from "./cli-fixture.ts"

const LOCAL_DIR = "C:\\Users\\Test\\AppData\\Local\\spicetify"
const CONFIG_DIR = "C:\\Users\\Test\\AppData\\Roaming\\spicetify"
const CONFIG_BACKUP_DIR = `${CONFIG_DIR}\\Backup`
const CREDENTIAL_DIR = "C:\\Users\\Test\\AppData\\Roaming\\opencode-spotify"
const INSTALLED_XPUI = "C:\\Users\\Test\\AppData\\Roaming\\Spotify\\Apps\\xpui.spa"

/** 64 hex characters: the bridge signing-secret shape. */
const SECRET = "9f".repeat(32)
const NPM_TOKEN = "//registry.npmjs.org/:_authToken=npm_deadbeefdeadbeef"

type FakeRuntime = ReturnType<typeof fakeRuntime>
type SizeSpec = number | "missing" | "unreadable"

function completeRequested(runtime: FakeRuntime): void {
  runtime.env.OPENCODE_SPOTIFY_UNINSTALL = "complete"
}

function existing(runtime: FakeRuntime, paths: string[]): void {
  const real = runtime.exists.bind(runtime)
  const added = new Set(paths)
  runtime.exists = (path: string) => added.has(path) || real(path)
}

/**
 * Fake a validated Spicetify backup at %APPDATA%\spicetify\Backup with plausible
 * sizes and an installed Spotify xpui.spa of the same size so restore
 * verification passes. No real 100 KB files are created.
 */
function installBackup(runtime: FakeRuntime, options: {
  xpui?: SizeSpec
  login?: SizeSpec
  installedXpui?: number | "missing"
} = {}) {
  const directory = CONFIG_BACKUP_DIR
  // Plausible payload sizes for the current backup-size policy. Tests that
  // need an invalid payload override these probes explicitly.
  const xpui = options.xpui ?? 5_000_000
  const files = new Set<string>()
  const sizes = new Map<string, number>()
  const realExists = runtime.exists.bind(runtime)
  const realIsFile = runtime.isFile.bind(runtime)
  runtime.exists = (path: string) => files.has(path) || path === directory || realExists(path)
  runtime.isFile = (path: string) => files.has(path) || realIsFile(path)

  const add = (path: string, spec: SizeSpec): void => {
    if (spec === "missing") return
    files.add(path)
    if (spec !== "unreadable") sizes.set(path, spec)
  }
  add(`${directory}\\xpui.spa`, xpui)
  add(`${directory}\\login.spa`, options.login ?? 200_000)
  if (options.installedXpui !== "missing") {
    add(INSTALLED_XPUI, options.installedXpui ?? (typeof xpui === "number" ? xpui : 5_000_000))
  }
  return { directory, fileSize: (path: string) => sizes.get(path) ?? null }
}

function recordingDeps(options: { fileSize?: (path: string) => number | null } = {}) {
  const removed: string[] = []
  return {
    removed,
    deps: {
      pathInfo: () => ({ symlink: false, realPath: null }),
      removePath: (path: string) => { removed.push(path) },
      fileSize: options.fileSize ?? (() => null),
    },
  }
}

function commands(runtime: FakeRuntime): string[] {
  return runtime.calls.map((call) => `${call.file} ${call.args.join(" ")}`)
}

function text(ui: ReturnType<typeof fakeUi>): string {
  return ui.lines.join("\n")
}

function scriptedPrompt(input: {
  asks?: Array<string | undefined>
  choices?: Array<string | undefined>
  confirms?: boolean[]
} = {}): Prompter & { asks: string[]; asked: string[] } {
  const answers = [...(input.asks ?? [])]
  const choices = [...(input.choices ?? [])]
  const confirms = [...(input.confirms ?? [])]
  const asks: string[] = []
  return {
    asked: asks,
    asks,
    async ask(question) {
      asks.push(question)
      return answers.length ? answers.shift() : undefined
    },
    async choose(question) {
      asks.push(question)
      return choices.length ? choices.shift() : undefined
    },
    async confirm(question) {
      asks.push(question)
      return confirms.length ? confirms.shift()! : false
    },
    close() {},
  }
}

function completeContext(runtime: FakeRuntime, ui: ReturnType<typeof fakeUi>) {
  return context(runtime, ui, scriptedPrompt(), {
    command: "uninstall",
    yes: true,
    nonInteractive: true,
  })
}

// ---------------------------------------------------------------------------
// Pure sanitizers
// ---------------------------------------------------------------------------

test("every sanitizer redacts signing secrets, tokens, userinfo, e-mail and home paths", () => {
  const detail = sanitizeDetail(
    `install failed secret=${SECRET} token:abcdef1234567890 ${NPM_TOKEN}`,
  )
  assert.ok(!detail.includes(SECRET), "64-hex secret must not survive")
  assert.ok(!detail.includes("npm_deadbeefdeadbeef"), "npm auth token must not survive")
  assert.match(detail, /\[redacted\]/)
  assert.ok(sanitizeDetail("x".repeat(400)).length <= 240, "diagnostics stay bounded")

  const message = sanitizeMessage(`authorization: Bearer ${SECRET} password=hunter2`)
  assert.ok(!message.includes(SECRET))
  assert.ok(!message.includes("hunter2"))
  assert.match(message, /authorization=\[redacted\]/)
  assert.equal(sanitizeMessage("y".repeat(300)).length, 240)

  const report = redactSensitive(
    `contact user@example.com from C:\\Users\\alice\\AppData\\secret=${SECRET}`,
  )
  assert.ok(!report.includes("user@example.com"))
  assert.match(report, /\[redacted-email\]/)
  assert.ok(!report.includes("alice"))
  assert.match(report, /C:\\Users\\<user>/)
  assert.ok(!report.includes(SECRET))
  assert.match(report, /secret=\[redacted\]/)

  const log = sanitizeLogMessage(`first line\nsecret=${SECRET}\u001b[31mcolored`)
  assert.ok(!log.includes(SECRET))
  assert.ok(!log.includes("\u001b"), "terminal sequences are stripped")
  assert.match(log, / \| /)

  const error = sanitizeErrorDetail(`restore failed secret=${SECRET}`)
  assert.ok(!error.includes(SECRET))
  assert.match(error, /\[redacted\]/)
})

// ---------------------------------------------------------------------------
// Typed UNINSTALL phrase
// ---------------------------------------------------------------------------

test("complete-removal consent is case-sensitive, trims only whitespace, and BACK stays available", async () => {
  assert.equal(UNINSTALL_CONFIRMATION_PHRASE, "UNINSTALL")

  const trimmed = scriptedPrompt({ asks: ["UNINSTALL "] })
  assert.equal(await confirmCompleteRemoval(trimmed, fakeUi()), "confirmed")

  const caseSensitive = scriptedPrompt({ asks: ["uninstall", "UNINSTALL"] })
  assert.equal(await confirmCompleteRemoval(caseSensitive, fakeUi()), "confirmed")
  assert.equal(caseSensitive.asks.length, 2)

  const back = scriptedPrompt({ asks: [" BACK "] })
  assert.equal(await confirmCompleteRemoval(back, fakeUi()), "back")

  // A zero-width character is not whitespace; it must never approve.
  const zeroWidth = scriptedPrompt({
    asks: [`UNINSTALL\u200b`, `UNINSTALL\u200b`, `UNINSTALL\u200b`],
  })
  assert.equal(await confirmCompleteRemoval(zeroWidth, fakeUi()), "cancelled")
  assert.equal(zeroWidth.asks.length, COMPLETE_CONSENT_ATTEMPTS)
})

test("interactive complete removal cannot be approved with yes, lowercase or DELETE", async () => {
  const runtime = fakeRuntime()
  completeRequested(runtime)
  const prompt = scriptedPrompt({ asks: ["yes", "uninstall", "DELETE"] })
  const { removed, deps } = recordingDeps()
  const ui = fakeUi()
  const ctx = context(runtime, ui, prompt, { command: "uninstall" })
  ctx.detection = fakeDetection(runtime)

  assert.equal(await runUninstall(ctx, deps), 130, text(ui))
  assert.equal(prompt.asks.length, COMPLETE_CONSENT_ATTEMPTS)
  assert.equal(runtime.calls.length, 0, "no command may run before exact consent")
  assert.deepEqual(removed, [])
})

test("BACK from complete removal returns to the menu without deleting anything", async () => {
  const runtime = fakeRuntime()
  completeRequested(runtime)
  const prompt = scriptedPrompt({ asks: ["BACK"], choices: ["back"] })
  const { removed, deps } = recordingDeps()
  const ui = fakeUi()
  const ctx = context(runtime, ui, prompt, { command: "uninstall" })
  ctx.detection = fakeDetection(runtime)

  assert.equal(await runUninstall(ctx, deps), 130, text(ui))
  assert.equal(runtime.calls.length, 0)
  assert.deepEqual(removed, [])
  assert.match(text(ui), /Nothing was removed/)
})

// ---------------------------------------------------------------------------
// Noninteractive destructive authorization (env + --non-interactive + --yes)
// ---------------------------------------------------------------------------

test("noninteractive complete removal requires the env signal, --non-interactive and --yes together", async () => {
  // Explicit signal without --yes: refused before any mutation.
  const noYes = fakeRuntime()
  completeRequested(noYes)
  const refusedUi = fakeUi()
  const refused = context(noYes, refusedUi, scriptedPrompt(), {
    command: "uninstall",
    nonInteractive: true,
    yes: false,
  })
  refused.detection = fakeDetection(noYes)
  assert.equal(await runUninstall(refused, recordingDeps().deps), 2, text(refusedUi))
  assert.equal(noYes.calls.length, 0)

  // --yes alone never escalates to complete removal.
  const yesOnly = fakeRuntime()
  existing(yesOnly, [LOCAL_DIR, CONFIG_DIR, CONFIG_BACKUP_DIR, CREDENTIAL_DIR])
  const credentialRemovals: string[] = []
  yesOnly.remove = (path: string) => { credentialRemovals.push(path) }
  const yesUi = fakeUi()
  const yesCtx = context(yesOnly, yesUi, scriptedPrompt(), {
    command: "uninstall",
    nonInteractive: true,
    yes: true,
  })
  yesCtx.detection = fakeDetection(yesOnly)
  assert.equal(await runUninstall(yesCtx, recordingDeps().deps), 0, text(yesUi))
  assert.deepEqual(credentialRemovals, [], "--yes alone keeps credentials")
  assert.ok(!commands(yesOnly).some((call) => /\srestore\b|\sbackup\b/.test(call)))
  assert.match(text(yesUi), /Spotify \/ Spicetify: not removed/)

  // Env + --yes but no --non-interactive still requires the typed phrase.
  const noNonInteractive = fakeRuntime()
  completeRequested(noNonInteractive)
  const phraseUi = fakeUi()
  const phrase = context(noNonInteractive, phraseUi, scriptedPrompt(), {
    command: "uninstall",
    nonInteractive: false,
    yes: true,
  })
  phrase.detection = fakeDetection(noNonInteractive)
  assert.equal(await runUninstall(phrase, recordingDeps().deps), 130, text(phraseUi))
  assert.equal(noNonInteractive.calls.length, 0)

  // All three signals: complete removal proceeds with a validated backup.
  const both = fakeRuntime()
  both.env.OPENCODE_SPOTIFY_UNINSTALL = "  COMPLETE  "
  existing(both, [LOCAL_DIR, CONFIG_DIR, CREDENTIAL_DIR])
  const backup = installBackup(both)
  const bothCredentialRemovals: string[] = []
  both.remove = (path: string) => { bothCredentialRemovals.push(path) }
  const bothUi = fakeUi()
  const bothCtx = completeContext(both, bothUi)
  bothCtx.detection = fakeDetection(both)
  const bothDeps = recordingDeps({ fileSize: backup.fileSize })
  assert.equal(await runUninstall(bothCtx, bothDeps.deps), 0, text(bothUi))
  assert.match(text(bothUi), /Complete permanent removal/)
  assert.match(text(bothUi), /Authorization: OPENCODE_SPOTIFY_UNINSTALL=complete \+ --non-interactive \+ --yes/)
  assert.deepEqual(bothCredentialRemovals, [CREDENTIAL_DIR])
})

test("a complete-removal dry-run shows the plan but runs no restore, deletion or credential removal", async () => {
  const runtime = fakeRuntime()
  completeRequested(runtime)
  existing(runtime, [LOCAL_DIR, CONFIG_DIR, CREDENTIAL_DIR])
  const backup = installBackup(runtime)
  const credentialRemovals: string[] = []
  runtime.remove = (path: string) => { credentialRemovals.push(path) }
  const { removed, deps } = recordingDeps({ fileSize: backup.fileSize })
  const ui = fakeUi()
  const ctx = context(runtime, ui, scriptedPrompt(), { command: "uninstall", dryRun: true })
  // Force the legacy Ui dry-run path so every planned step is visibly rendered.
  ctx.report = undefined
  ctx.detection = fakeDetection(runtime)

  assert.equal(await runUninstall(ctx, deps), 0, text(ui))
  assert.equal(runtime.calls.length, 0, "dry-run never executes a child command")
  assert.deepEqual(removed, [])
  assert.deepEqual(credentialRemovals, [])
  assert.ok(ui.lines.some((line) => line.startsWith("dry: ")), "dry-run steps are rendered")
})

// ---------------------------------------------------------------------------
// End-to-end redaction
// ---------------------------------------------------------------------------

test("a failed Spotify restore never leaks the secret from stderr or the error detail", async () => {
  const runtime = fakeRuntime()
  completeRequested(runtime)
  existing(runtime, [LOCAL_DIR, CONFIG_DIR, CREDENTIAL_DIR])
  const backup = installBackup(runtime)
  const realRun = runtime.run.bind(runtime)
  runtime.run = (async (file: string, args: string[], options?: ExecOptions): Promise<CommandResult> => {
    if (file.includes("spicetify") && args.join(" ") === "restore") {
      return {
        code: 1,
        stdout: "",
        stderr: `restore failed secret=${SECRET}`,
        error: `restore failed secret=${SECRET}`,
      }
    }
    return realRun(file, args, options)
  }) as typeof runtime.run
  const credentialRemovals: string[] = []
  runtime.remove = (path: string) => { credentialRemovals.push(path) }
  const { removed, deps } = recordingDeps({ fileSize: backup.fileSize })
  const ui = fakeUi()
  const ctx = completeContext(runtime, ui)
  ctx.detection = fakeDetection(runtime)

  assert.equal(await runUninstall(ctx, deps), 1, text(ui))
  assert.ok(!text(ui).includes(SECRET), "restore diagnostics must be redacted")
  assert.match(text(ui), /\[redacted\]/)
  assert.match(text(ui), /config and backups were kept/i)
  assert.ok(!commands(runtime).some((call) => call.includes(SECRET)))
  assert.deepEqual(removed, [])
  assert.deepEqual(credentialRemovals, [])
})

test("a failed credential removal never prints the signing secret", async () => {
  const runtime = fakeRuntime()
  completeRequested(runtime)
  existing(runtime, [LOCAL_DIR, CONFIG_DIR, CREDENTIAL_DIR])
  const backup = installBackup(runtime)
  runtime.remove = () => { throw new Error(`EBUSY: locked credential file secret=${SECRET}`) }
  const { deps } = recordingDeps({ fileSize: backup.fileSize })
  const ui = fakeUi()
  const ctx = completeContext(runtime, ui)
  ctx.detection = fakeDetection(runtime)

  assert.equal(await runUninstall(ctx, deps), 1, text(ui))
  assert.ok(!text(ui).includes(SECRET), "credential errors must be redacted")
  assert.match(text(ui), /\[redacted\]/)
  assert.match(text(ui), /EBUSY: locked credential file/)
  assert.match(text(ui), /Removal is incomplete/i)
  assert.match(text(ui), /signing secret and pinned Origin may still be on disk/i)
  assert.ok(!commands(runtime).some((call) => call.includes(SECRET)))
})

// ---------------------------------------------------------------------------
// Symlink protection for credentials
// ---------------------------------------------------------------------------

test("credential removal refuses a junction/symlink directory and preserves its target", async () => {
  const root = mkdtempSync(join(tmpdir(), "opencode-credential-link-"))
  const outside = join(root, "outside")
  const link = join(root, "opencode-spotify")
  const marker = join(outside, "do-not-delete.txt")
  mkdirSync(outside, { recursive: true })
  writeFileSync(marker, "kept", "utf8")

  let linked = false
  try {
    try {
      symlinkSync(outside, link, "junction")
      linked = true
    } catch (error) {
      assert.fail(`this platform should support temp junctions: ${String(error)}`)
    }

    const runtime = fakeRuntime()
    runtime.env.APPDATA = root
    runtime.exists = (path: string) => existsSync(path)

    const result = await removeCredentials(runtime)
    assert.equal(result.code, 1)
    assert.match(result.error ?? "", /symbolic-link|symbolic link|junction/i)
    assert.equal(existsSync(link), true, "the link itself is untouched")
    assert.equal(existsSync(marker), true, "the link target is never followed for deletion")
  } finally {
    try { if (linked) unlinkSync(link) } catch { /* already gone */ }
    rmSync(root, { recursive: true, force: true })
    assert.equal(existsSync(root), false, "cleanup stays inside the temp fixture")
  }
})

// ---------------------------------------------------------------------------
// F1 — reviewed Marketplace patch and policy-respecting execution
// ---------------------------------------------------------------------------

function patchedInstaller(): Uint8Array {
  const result = patchOfficialInstallerScript(officialScriptBytes())
  if (!result.ok) throw new Error(`${result.code}: ${result.error}`)
  return result.bytes
}

test("the executed installer is the reviewed 8236-byte patch, never the original", () => {
  const original = officialScriptBytes()
  const originalCheck = verifyOfficialInstallerScript(original)
  assert.equal(originalCheck.ok, true, originalCheck.error)
  assert.equal(originalCheck.sha256, OFFICIAL_INSTALLER_SHA256)

  const patched = patchedInstaller()
  assert.equal(patched.byteLength, OFFICIAL_INSTALLER_PATCHED_BYTES)
  const text = Buffer.from(patched).toString("ascii")
  assert.match(text, /#region Marketplace[\s\S]*#endregion Marketplace/)
  assert.match(text, /Existing %APPDATA%\\spicetify Marketplace files are neither read nor changed\./)
  assert.ok(!text.includes("spicetify-marketplace"), "no mutable Marketplace installer URL")
  assert.ok(!text.includes("Do you also want to install Spicetify Marketplace"), "no Marketplace prompt")
  assert.ok(!text.includes("Invoke-Expression"), "no nested evaluation")
  assert.equal((text.match(/Invoke-WebRequest @Parameters/g) ?? []).length, 1, "only the binary download remains")

  // Prefix/suffix equality: every byte outside the reviewed region is untouched.
  const start = Buffer.from(original).indexOf(Buffer.from("#region Marketplace"))
  const endMarker = Buffer.from(original).indexOf(Buffer.from("#endregion Marketplace"))
  const blockEnd = endMarker + Buffer.byteLength("#endregion Marketplace")
  const block = Buffer.from(original.subarray(start, blockEnd))
  assert.equal(block.byteLength, OFFICIAL_INSTALLER_MARKETPLACE_BLOCK_BYTES)
  assert.deepEqual(Buffer.from(patched.subarray(0, start)), Buffer.from(original.subarray(0, start)))
  assert.deepEqual(Buffer.from(patched.subarray(patched.length - 19)), Buffer.from(original.subarray(original.length - 19)))
})

test("a PowerShell AST parse of the executed script has no Marketplace string and no Invoke-Expression command", (t) => {
  const probe = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"], { encoding: "utf8" })
  if (probe.error || probe.status !== 0) {
    if (process.platform === "win32") {
      assert.fail(`pwsh AST parse is a physically meaningful prerequisite on Windows and must succeed: ${String(probe.error ?? probe.stderr ?? probe.status)}`)
    }
    t.skip("pwsh is unavailable; AST parse check skipped")
    return
  }
  const dir = mkdtempSync(join(tmpdir(), "opencode-spx-ast-"))
  const path = join(dir, "install.ps1")
  writeFileSync(path, patchedInstaller(), { flag: "wx" })
  try {
    const script = [
      "$tokens=$null",
      "$errors=$null",
      "$ast=[System.Management.Automation.Language.Parser]::ParseFile($env:SPX_AST,[ref]$tokens,[ref]$errors)",
      "$strings=@($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.StringConstantExpressionAst] }, $true))",
      "$bad=@($strings | Where-Object { $_.Value -match '(?i)marketplace' })",
      "$commands=@($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] }, $true))",
      "$iex=@($commands | Where-Object { $_.GetCommandName() -eq 'Invoke-Expression' }).Count",
      "'PARSE_ERRORS=' + $errors.Count",
      "'MARKETPLACE_STRINGS=' + $bad.Count",
      "'IEX_COMMANDS=' + $iex",
    ].join("; ")
    const result = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
      env: { ...process.env, SPX_AST: path },
      encoding: "utf8",
    })
    assert.equal(result.status, 0, String(result.stderr))
    assert.match(result.stdout, /PARSE_ERRORS=0/)
    assert.match(result.stdout, /MARKETPLACE_STRINGS=0/)
    assert.match(result.stdout, /IEX_COMMANDS=0/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the wrapper executes a script file under a held handle and never bypasses or overrides policy", () => {
  const wrapper = buildOfficialWrapperCommand("9.9.9")
  assert.match(wrapper, /\[IO\.File\]::Open\(\$env:SPX_SCRIPT,'Open','Read','Read'\)/)
  assert.match(wrapper, /&\s*\$env:SPX_SCRIPT/)
  assert.doesNotMatch(wrapper, /Invoke-Expression/)
  assert.doesNotMatch(wrapper, /-ExecutionPolicy/)
  assert.doesNotMatch(wrapper, /Bypass/i)
  assert.doesNotMatch(wrapper, /Set-ExecutionPolicy/)
  assert.match(wrapper, /PSSecurityException/)
  assert.match(wrapper, /exit 92/)

  const warnings = officialInstallerWarnings("install", "9.9.9", "authenticode+version").join("\n")
  assert.match(warnings, /never overrides or bypasses policy/i)
  assert.match(warnings, /answer No/i)
  assert.doesNotMatch(warnings, /prompt declined|pre-answered/i)
  assert.doesNotMatch(warnings, /SPX_WRAPPER_COMPLETED/)
})

test("patch failure is fail-closed: no patched bytes are produced from a non-pinned script", () => {
  const tampered = officialScriptBytes()
  tampered[0] = 0x23
  const result = patchOfficialInstallerScript(tampered)
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.code, "E_PIN_MISMATCH")
    assert.equal("bytes" in result, false, "no bytes are returned on failure")
  }
})
