import { execFile } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, delimiter, join } from "node:path"
import { fileURLToPath } from "node:url"
import { connect } from "node:net"
import type { CommandResult, ExecOptions, Runtime } from "./types.ts"

const limit = 256 * 1024

/**
 * Operation-specific timeouts (B03). Inspection stays bounded so a hung
 * native command never blocks setup; mutations allow time for package
 * managers and Spicetify to finish. All values in milliseconds.
 */
export const OPERATION_TIMEOUTS = {
  /** `opencode --version`, `debug paths`, `plugin --help`, `which` probes. */
  inspection: 15_000,
  /** `opencode plugin list` (global + project). Generous: B08 showed slow
   * native list calls being mistaken for "plugin absent". */
  pluginList: 30_000,
  /** `opencode plugin add/remove/update` (npm resolution + config write). */
  pluginMutation: 90_000,
  /** `spicetify -v/-c/path`, `spicetify path`, Store probes. */
  spicetifyInspect: 10_000,
  /** `winget list/show` owner probes. */
  managerProbe: 15_000,
  /** `winget install/upgrade`, `scoop/choco` operations. */
  packageInstall: 300_000,
  /** `spicetify backup` (first-time backup can take a while). */
  spicetifyBackup: 120_000,
  /** `spicetify apply` (may restart Spotify). */
  spicetifyApply: 120_000,
  /** Bridge provisioner (`install-extension.ps1` via pwsh). */
  bridge: 180_000,
  /** Registry / GitHub version lookups. */
  registry: 20_000,
} as const

/** Redact secret-looking tokens from command diagnostics (B04). Never logs values. */
export function sanitizeDetail(value: string): string {
  return value
    .replace(/\/\/[^\s:]+:_authToken=\S+/gi, "[redacted]")
    .replace(/\b[a-f0-9]{32,}\b/gi, "[redacted]")
    .replace(/\b(secret|token|password|credential|authorization)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .slice(0, 240)
}

function quoteCmd(value: string): string {
  // cmd.exe expands % inside quotes; CLI/plugin args are validated to exclude
  // shell metacharacters, and file paths are quoted. Double embedded quotes.
  return `"${value.replace(/"/g, '""')}"`
}

function isBatchFile(file: string): boolean {
  return /\.(?:cmd|bat)$/i.test(file)
}

function capture(file: string, args: string[], options: ExecOptions = {}): Promise<CommandResult> {
  return new Promise((resolve) => {
    const started = Date.now()
    let command = file
    let commandArgs = args
    const batch = process.platform === "win32" && isBatchFile(file)
    if (batch) {
      command = process.env.ComSpec || "cmd.exe"
      // /d disables AutoRun; /s keeps the outer quote handling predictable.
      // cmd /s /c requires an extra outer pair around the whole command.
      const cmdline = `${quoteCmd(file)} ${args.map(quoteCmd).join(" ")}`
      commandArgs = ["/d", "/s", "/c", `"${cmdline}"`]
    }
    const timeoutMs = options.timeoutMs ?? 15_000
    const child = execFile(command, commandArgs, {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      timeout: timeoutMs,
      windowsHide: true,
      windowsVerbatimArguments: batch,
      maxBuffer: limit,
      shell: false,
    }, (error, stdout, stderr) => {
      const durationMs = Date.now() - started
      const errRecord = (error ?? null) as unknown as {
        code?: unknown
        killed?: unknown
        signal?: unknown
        message?: unknown
      } | null
      // B03: distinguish timeout / executable errors from normal nonzero exits.
      // Node reports a timeout as killed === true (SIGTERM by default); ENOENT
      // means the executable itself is missing. Neither is a normal exit code.
      const killed = errRecord?.killed === true
      const message = typeof errRecord?.message === "string" ? errRecord.message : ""
      const timedOut = !!errRecord && (killed || /timed out|ETIMEDOUT/i.test(message))
      const code = typeof errRecord?.code === "number" ? errRecord.code : errRecord ? 1 : 0
      const result: CommandResult = {
        code,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? ""),
        ...(timedOut ? { timedOut: true as const } : {}),
        durationMs,
      }
      if (errRecord && !result.stderr) {
        const raw = typeof errRecord.message === "string" && errRecord.message ? errRecord.message : `command failed with code ${code}`
        result.error = timedOut
          ? `timed out after ${timeoutMs}ms: ${sanitizeDetail(raw)}`
          : sanitizeDetail(raw)
      }
      resolve(result)
    })
    if (options.input !== undefined) child.stdin?.end(options.input)
    else child.stdin?.end()
  })
}

async function which(name: string): Promise<string | undefined> {
  if (process.platform === "win32") {
    const result = await capture("where.exe", [name], { timeoutMs: OPERATION_TIMEOUTS.inspection })
    const candidates = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    const rank = (value: string) => /\.exe$/i.test(value) ? 0 : /\.cmd$/i.test(value) ? 1 : /\.bat$/i.test(value) ? 2 : /\.ps1$/i.test(value) ? 3 : 4
    const found = candidates.sort((a, b) => rank(a) - rank(b))[0]
    return result.code === 0 && found ? found : undefined
  }
  const paths = (process.env.PATH ?? "").split(delimiter).filter(Boolean)
  for (const dir of paths) {
    const candidate = join(dir, name)
    try { if (existsSync(candidate) && statSync(candidate).isFile()) return candidate } catch { /* continue */ }
  }
  return undefined
}

function portOpen(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port })
    let settled = false
    const finish = (open: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(open)
    }
    socket.setTimeout(timeoutMs)
    socket.once("connect", () => finish(true))
    socket.once("timeout", () => finish(false))
    socket.once("error", () => finish(false))
  })
}

export function createRuntime(): Runtime {
  const resolve = async (file: string): Promise<string> => {
    if (process.platform !== "win32") return file
    if (/[\\/]/.test(file) || /\.[A-Za-z0-9]+$/.test(file)) return file
    return (await which(file)) ?? file
  }
  return {
    platform: process.platform,
    arch: process.arch,
    env: process.env,
    cwd: process.cwd(),
    homedir: homedir(),
    run: async (file, args, options) => capture(await resolve(file), args, options),
    which,
    exists: (path) => existsSync(path),
    isFile: (path) => { try { return statSync(path).isFile() } catch { return false } },
    readText: (path) => readFileSync(path, "utf8"),
    writeText: (path, value) => writeFileSync(path, value, "utf8"),
    copyFile: (from, to) => copyFileSync(from, to),
    mkdir: (path) => { mkdirSync(path, { recursive: true }) },
    remove: (path) => { rmSync(path, { recursive: true, force: true }) },
    now: () => Date.now(),
    portOpen,
  }
}

/** Package root is two levels above src/cli; useful for bundled assets. */
export function packageRoot(metaUrl: string): string {
  return fileURLToPath(new URL("../../", metaUrl))
}

export function displayPath(path: string | null | undefined): string {
  if (!path) return "not found"
  return basename(path) === path ? path : path
}
