import { execFile } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, delimiter, join } from "node:path"
import { fileURLToPath } from "node:url"
import { connect } from "node:net"
import type { CommandResult, ExecOptions, Runtime } from "./types.ts"

const limit = 256 * 1024

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
    const child = execFile(command, commandArgs, {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      timeout: options.timeoutMs ?? 15_000,
      windowsHide: true,
      windowsVerbatimArguments: batch,
      maxBuffer: limit,
      shell: false,
    }, (error, stdout, stderr) => {
      const result: CommandResult = {
        code: typeof (error as { code?: unknown } | null)?.code === "number" ? (error as { code: number }).code : error ? 1 : 0,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? ""),
      }
      if (error && !result.stderr) result.error = error.message
      resolve(result)
    })
    if (options.input !== undefined) child.stdin?.end(options.input)
    else child.stdin?.end()
  })
}

async function which(name: string): Promise<string | undefined> {
  if (process.platform === "win32") {
    const result = await capture("where.exe", [name], { timeoutMs: 8000 })
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
