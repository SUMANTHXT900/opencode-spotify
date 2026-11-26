import { execFile, spawn } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, delimiter, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { connect } from "node:net"
import type { CommandResult, ExecOptions, Runtime } from "./types.ts"
import type { ChildRegistry } from "./children.ts"
import type { CancelToken } from "./cancel.ts"

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

interface RuntimeSignalContext {
  children?: ChildRegistry
  cancel?: CancelToken
}

function capture(
  file: string,
  args: string[],
  options: ExecOptions = {},
  ctx: RuntimeSignalContext = {},
): Promise<CommandResult> {
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
    const policy = options.killPolicy ?? "tree"
    const cancel = options.cancel ?? ctx.cancel
    const registry = ctx.children
    // Never spawn after a cancellation: callers would otherwise mutate state
    // (rollback/verify/re-detect) behind the user's back.
    if (cancel?.requested) {
      resolve({
        code: 130,
        stdout: "",
        stderr: "",
        cancelled: true,
        error: "Cancelled by the user.",
        durationMs: Date.now() - started,
      })
      return
    }
    let settled = false
    let killRequested = false
    let unsubscribe: (() => void) | undefined
    const killOnce = () => {
      if (killRequested || policy === "none" || cancel?.killHeld || !child.pid) return
      killRequested = true
      try {
        if (process.platform === "win32" && policy === "tree") {
          // Absolute taskkill: never resolve through the CWD.
          execFile(systemTool("taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {})
        } else {
          child.kill()
        }
      } catch { /* best effort */ }
    }
    const finish = (result: CommandResult) => {
      if (settled) return
      settled = true
      unsubscribe?.()
      resolve(result)
    }
    const child = execFile(command, commandArgs, {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      timeout: timeoutMs,
      windowsHide: true,
      windowsVerbatimArguments: batch,
      maxBuffer: limit,
      shell: false,
    }, async (error, stdout, stderr) => {
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
      const overflow = /maxBuffer|ENOBUFS/i.test(message)
      const timedOut = !!errRecord && !overflow && (killed || /timed out|ETIMEDOUT/i.test(message))
      const cancelled = !!cancel?.requested && killRequested
      // A timed-out or cancelled command may have left grandchildren behind:
      // kill the tree before resolving so nothing mutates after we report.
      if ((timedOut || cancelled) && policy === "tree" && registry && child.pid) {
        try { await registry.killOwnedTree(child.pid) } catch { /* best effort */ }
      }
      const code = typeof errRecord?.code === "number" ? errRecord.code : errRecord ? 1 : 0
      const result: CommandResult = {
        code: cancelled ? 130 : code,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? ""),
        ...(timedOut ? { timedOut: true as const } : {}),
        ...(cancelled ? { cancelled: true as const } : {}),
        durationMs,
      }
      if (cancelled) {
        result.error = "Cancelled by the user."
      } else if (errRecord && !result.stderr) {
        const raw = typeof errRecord.message === "string" && errRecord.message ? errRecord.message : `command failed with code ${code}`
        result.error = overflow
          ? `command output exceeded ${limit} bytes: ${sanitizeDetail(raw)}`
          : timedOut
            ? `timed out after ${timeoutMs}ms: ${sanitizeDetail(raw)}`
            : sanitizeDetail(raw)
      }
      finish(result)
    })
    if (child.pid && registry) {
      registry.adopt(child, { label: options.label ?? basename(file), policy })
    }
    // Register the cancel listener only after the child exists, so a late
    // onRequest cannot run before `child` is initialised.
    unsubscribe = cancel?.onRequest(killOnce)
    if (options.input !== undefined) child.stdin?.end(options.input)
    else child.stdin?.end()
  })
}

/** Absolute Windows system tool path; never resolved through the CWD. */
export function systemTool(name: string): string {
  if (process.platform !== "win32") return name
  const root = process.env.SystemRoot || process.env.windir || "C:\\Windows"
  return join(root, "System32", name)
}

/**
 * PATH-only executable resolution. `where.exe` searches the current working
 * directory first, which would let a planted `pwsh.exe`/`spicetify.exe` in a
 * cloned repo run with the installer's privileges. The resolver itself is
 * spawned by absolute path, results are filtered to directories that actually
 * appear in PATH, and the process CWD is always rejected.
 */
async function which(name: string): Promise<string | undefined> {
  if (process.platform === "win32") {
    const result = await capture(systemTool("where.exe"), [name], { timeoutMs: OPERATION_TIMEOUTS.inspection })
    const pathDirs = new Set(
      (process.env.PATH ?? "")
        .split(delimiter)
        .map((dir) => dir.trim().replace(/^"|"$/g, ""))
        .filter((dir) => dir.length > 0 && dir !== ".")
        .map((dir) => stripTrailingSep(dir).toLowerCase()),
    )
    const cwd = stripTrailingSep(process.cwd()).toLowerCase()
    const candidates = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
      .filter((candidate) => {
        if (!/^[A-Za-z]:[\\/]/.test(candidate) && !candidate.startsWith("\\\\")) return false
        const dir = stripTrailingSep(dirname(candidate)).toLowerCase()
        return dir !== cwd && pathDirs.has(dir)
      })
    const rank = (value: string) => /\.exe$/i.test(value) ? 0 : /\.cmd$/i.test(value) ? 1 : /\.bat$/i.test(value) ? 2 : /\.ps1$/i.test(value) ? 3 : 4
    const found = candidates.sort((a, b) => rank(a) - rank(b))[0]
    return result.code === 0 && found ? found : undefined
  }
  const paths = (process.env.PATH ?? "").split(delimiter)
    .map((dir) => dir.trim())
    .filter((dir) => dir.length > 0 && dir !== ".")
  for (const dir of paths) {
    const candidate = join(dir, name)
    try { if (existsSync(candidate) && statSync(candidate).isFile()) return candidate } catch { /* continue */ }
  }
  return undefined
}

function stripTrailingSep(value: string): string {
  return value.replace(/[\\/]+$/, "")
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

export function createRuntime(context: RuntimeSignalContext = {}): Runtime {
  const resolve = async (file: string): Promise<string> => {
    if (process.platform !== "win32") return file
    if (/[\\/]/.test(file) || /\.[A-Za-z0-9]+$/.test(file)) return file
    return (await which(file)) ?? file
  }
  const runInteractive: Runtime["runInteractive"] = async (file, args, options = {}) => {
    const started = Date.now()
    const target = await resolve(file)
    const policy = options.killPolicy ?? "tree"
    const cancel = options.cancel ?? context.cancel
    if (cancel?.requested) {
      return { code: 130, stdout: "", stderr: "", cancelled: true, error: "Cancelled by the user.", durationMs: Date.now() - started }
    }
    return new Promise((res) => {
      let settled = false
      let killRequested = false
      const finish = (result: CommandResult) => {
        if (settled) return
        settled = true
        unsubscribe?.()
        res(result)
      }
      const child = spawn(target, args, {
        cwd: options.cwd,
        env: options.env ? { ...process.env, ...options.env } : process.env,
        stdio: "inherit",
        windowsHide: false,
        shell: false,
      })
      let unsubscribe: (() => void) | undefined
      const killTree = () => {
        if (killRequested || policy === "none" || cancel?.killHeld || !child.pid) return
        killRequested = true
        try {
          if (process.platform === "win32" && policy === "tree") {
            execFile(systemTool("taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {})
          } else {
            child.kill()
          }
        } catch { /* best effort */ }
      }
      unsubscribe = cancel?.onRequest(killTree)
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        killTree()
      }, OPERATION_TIMEOUTS.packageInstall)
      child.on("error", (error) => {
        clearTimeout(timer)
        finish({
          code: 1,
          stdout: "",
          stderr: "",
          error: sanitizeDetail(error instanceof Error ? error.message : "interactive spawn failed"),
          timedOut,
          durationMs: Date.now() - started,
        })
      })
      child.on("close", (code) => {
        clearTimeout(timer)
        const cancelled = !!cancel?.requested && killRequested
        finish({
          code: cancelled ? 130 : (code ?? 1),
          stdout: "",
          stderr: "",
          ...(timedOut ? { timedOut: true as const } : {}),
          ...(cancelled ? { cancelled: true as const } : {}),
          ...(cancelled ? { error: "Cancelled by the user." } : {}),
          durationMs: Date.now() - started,
        })
      })
      if (child.pid && context.children) {
        context.children.adopt(child, { label: options.label ?? basename(file), policy })
      }
    })
  };
  return {
    platform: process.platform,
    arch: process.arch,
    env: process.env,
    cwd: process.cwd(),
    homedir: homedir(),
    run: async (file, args, options) => capture(await resolve(file), args, options, context),
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
    runInteractive,
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
