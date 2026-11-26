import { parseArgs, helpText } from "./args.ts"
import { detectEnvironment } from "./detect.ts"
import { createRuntime } from "./runtime.ts"
import { createPrompter, createUi } from "./ui.ts"
import { createPlainPresentation, createUiIo, shouldUseInk } from "./ui-mode.ts"
import { packageVersion, githubLatest, npmLatest } from "./versions.ts"
import { createCancelToken } from "./cancel.ts"
import { createChildRegistry } from "./children.ts"
import {
  InstallerLockBusyError,
  InstallerLockLostError,
  acquireInstallerLock,
} from "./lock.ts"
import type { InstallerLock } from "./lock.ts"
import type {
  CliOptions,
  InstallerSnapshot,
  Logger,
  OperationContext,
  Presentation,
  Prompter,
  Runtime,
  Ui,
  VersionInfo,
} from "./types.ts"
import { runSetup } from "./setup.ts"
import { runStatus } from "./status.ts"
import { runUpdate } from "./update.ts"
import { runRepair } from "./repair.ts"
import { runDoctor } from "./doctor.ts"
import { runUninstall } from "./uninstall.ts"

export interface MainDependencies {
  runtime?: Runtime
  log?: Logger
  ui?: Ui
  prompt?: Prompter
  /** Test seam; production acquires the user-scoped installer lock. */
  lock?: InstallerLock
}

const MUTATING_COMMANDS: ReadonlySet<CliOptions["command"]> = new Set(["setup", "update", "repair", "uninstall"])
const JSON_COMMANDS: ReadonlySet<CliOptions["command"]> = new Set(["status", "doctor"])

function loggerFor(dependencies: MainDependencies): Logger {
  return dependencies.log ?? {
    out: (message) => process.stdout.write(`${message}\n`),
    err: (message) => process.stderr.write(`${message}\n`),
  }
}

async function execute(command: CliOptions["command"], ctx: OperationContext): Promise<number> {
  switch (command) {
    case "setup": return runSetup(ctx)
    case "status": return runStatus(ctx)
    case "update": return runUpdate(ctx)
    case "repair": return runRepair(ctx)
    case "doctor": return runDoctor(ctx)
    case "uninstall": return runUninstall(ctx)
  }
}

/** Restore the terminal on abnormal exit (raw mode off, cursor shown). */
function restoreTerminal(stream: NodeJS.WriteStream = process.stdout, json = false): void {
  try {
    const stdin = process.stdin
    if (stdin.isTTY && typeof stdin.setRawMode === "function") stdin.setRawMode(false)
  } catch { /* already restored */ }
  // Never write escapes into piped/JSON output: they corrupt the document.
  if (json || !stream.isTTY) return
  try {
    stream.write("\u001b[0m\u001b[?25h")
  } catch { /* best effort */ }
}

export async function main(argv: string[], dependencies: MainDependencies = {}): Promise<number> {
  const version = packageVersion(import.meta.url)
  const parsed = parseArgs(argv)
  const log = loggerFor(dependencies)
  if (parsed.error) {
    log.err(`Error: ${parsed.error}`)
    log.err("Run opencode-spotify --help for usage.")
    return 2
  }
  const options = parsed.options
  if (options.version) {
    log.out(version)
    return 0
  }
  if (options.help) {
    log.out(helpText())
    return 0
  }
  // JSON is a single machine-readable document. Mutating commands have no JSON
  // contract, and muting their output would hide errors while still mutating.
  if (options.json && !JSON_COMMANDS.has(options.command)) {
    log.err(`Error: --json is supported for ${[...JSON_COMMANDS].join(" and ")} only; ${options.command} has no JSON document.`)
    return 2
  }

  const cancel = createCancelToken()
  const children = createChildRegistry()
  const runtime = dependencies.runtime ?? createRuntime({ children, cancel })
  // Presentation selection: JSON/plain never touch Ink. TTY interactive tries
  // Ink via dynamic import, falling back to plain on any failure.
  let presentation: Presentation | undefined
  let ui: Ui
  let prompt: Prompter
  let inkStore: import("./types.ts").InstallerStore | undefined
  if (dependencies.ui ?? dependencies.prompt) {
    ui = dependencies.ui ?? createUi(log, { color: options.color, json: options.json })
    prompt = dependencies.prompt ?? createPrompter(log)
  } else if (shouldUseInk(options, createUiIo())) {
    try {
      const inkModule = await import("./ui/ink.ts")
      const { createInstallerStore, createInstallerSnapshot } = await import("./state.ts")
      const store = createInstallerStore(createInstallerSnapshot({
        command: options.command,
        mode: "ink",
        version,
        windows: runtime.platform === "win32",
        startedAt: runtime.now(),
      }))
      inkStore = store
      presentation = await inkModule.createInkPresentation(store, { color: options.color ?? true, cancel })
      ui = presentation.ui
      prompt = presentation.prompt
    } catch (error) {
      if (options.verbose) log.err(`Ink UI unavailable; using plain output: ${error instanceof Error ? error.message : "unknown error"}`)
      presentation = createPlainPresentation(log, { color: options.color, json: options.json })
      ui = presentation.ui
      prompt = presentation.prompt
    }
  } else {
    presentation = createPlainPresentation(log, { color: options.color, json: options.json })
    ui = presentation.ui
    prompt = presentation.prompt
  }
  // JSON mode is noninteractive by definition: a prompt must never write into
  // the single machine-readable document.
  if (!dependencies.prompt) options.nonInteractive = options.nonInteractive || options.json || !process.stdin.isTTY
  if (options.command === "uninstall" && options.removeCredentials && options.nonInteractive && !options.yes && !options.dryRun) {
    log.err("Error: --remove-credentials requires --yes in noninteractive mode")
    return 2
  }

  // Cooperative signal handling: the first signal requests cancellation and
  // lets a protected step finish; a second signal (or deadline) forces exit.
  let forceTimer: ReturnType<typeof setTimeout> | undefined
  const forceExit = async () => {
    cancel.force()
    try { await children.killAll("shutdown", { graceMs: 2_000 }) } catch { /* best effort */ }
    restoreTerminal(process.stdout, options.json)
    process.exit(130)
  }
  const onSignal = (signal: NodeJS.Signals) => {
    if (!cancel.requested) {
      cancel.request(signal === "SIGTERM" ? "sigterm" : "sigint")
      forceTimer = setTimeout(() => { void forceExit() }, 10_000)
      forceTimer.unref?.()
      return
    }
    void forceExit()
  }
  const sigint = () => onSignal("SIGINT")
  const sigterm = () => onSignal("SIGTERM")
  const onExit = () => restoreTerminal(process.stdout, options.json)
  // `on` (not `once`): a second signal must reach the force branch.
  process.on("SIGINT", sigint)
  process.on("SIGTERM", sigterm)
  process.once("exit", onExit)

  let lock: InstallerLock | undefined
  try {
    ui.banner(version, runtime.platform === "win32")
    const detection = await detectEnvironment(runtime)
    const versions: { plugin: VersionInfo; spicetify: VersionInfo } = {
      plugin: { installed: detection.opencode.plugin.version, latest: null },
      spicetify: { installed: detection.spicetify.version, latest: null },
    }
    if (!options.offline) {
      // B21: always discover upstream Spicetify metadata in online mode, even
      // on fresh installs where Spicetify is absent. Offline mode skips all
      // registry/GitHub queries. Installed stays from detection so unknown
      // metadata (latest null + error) is distinct from a real match.
      const [plugin, spicetify] = await Promise.all([
        npmLatest(runtime, "opencode-spotify", options.offline, { cancel }),
        githubLatest(runtime, "spicetify/cli", options.offline, { cancel }),
      ])
      versions.plugin.latest = plugin.latest
      versions.plugin.latestBeta = plugin.latestBeta
      versions.plugin.error = plugin.error
      versions.spicetify.latest = spicetify.latest
      versions.spicetify.error = spicetify.error
    }
    if (inkStore) {
      inkStore.dispatch({ type: "detection", detection, at: runtime.now() })
      inkStore.dispatch({ type: "versions", plugin: versions.plugin, spicetify: versions.spicetify, at: runtime.now() })
      inkStore.dispatch({ type: "phase", phase: "detect", label: "Detected", at: runtime.now() })
    }
    // Snapshot detection AFTER the registry queries but BEFORE any mutation;
    // re-detect again once the lock is held (another installer may have run).
    let ctx: OperationContext = {
      options, runtime, ui, prompt, detection, installerVersion: version, versions, log,
      report: presentation?.report, cancel,
    }
    const run = async () => {
      if (cancel.requested) return 130
      const code = await execute(options.command, ctx)
      if (inkStore) {
        inkStore.dispatch({ type: "result", code, at: runtime.now() })
      }
      return code
    }
    const mutating = MUTATING_COMMANDS.has(options.command) && !options.dryRun
    let code: number
    if (mutating) {
      lock = dependencies.lock ?? await acquireInstallerLock({ command: options.command })
      await lock.assertHeld()
      const heldLock = lock
      const fresh = await detectEnvironment(runtime)
      ctx = {
        ...ctx,
        detection: fresh,
        ...(heldLock ? { guard: async () => { await heldLock.assertHeld() } } : {}),
      }
      if (inkStore) {
        inkStore.dispatch({ type: "detection", detection: fresh, at: runtime.now() })
        inkStore.dispatch({ type: "versions", plugin: ctx.versions.plugin, spicetify: ctx.versions.spicetify, at: runtime.now() })
      }
      code = await run()
    } else {
      code = await run()
    }
    // Refresh the Done screen: workflows replace ctx.detection after mutating.
    if (inkStore) {
      try {
        const finalDetection = await detectEnvironment(runtime)
        inkStore.dispatch({ type: "detection", detection: finalDetection, at: runtime.now() })
      } catch { /* best effort; the pre-run state stays visible */ }
    }
    // A real failure/confirmation-required code always wins over cancellation.
    if (code !== 0) return code
    if (cancel.requested) return 130
    const inkCode = (presentation as unknown as { exitCode?: () => number | undefined } | undefined)?.exitCode?.()
    return inkCode ?? code
  } catch (error) {
    if (error instanceof InstallerLockBusyError) {
      log.err(`Error: ${error.message}`)
      log.err("`status` and `doctor` remain available while another operation runs.")
      return 1
    }
    if (error instanceof InstallerLockLostError) {
      log.err(`Error: ${error.message}`)
      return 1
    }
    const message = error instanceof Error ? error.message : "Installer failed"
    // Never include credential values or full child command lines here.
    log.err(`Error: ${sanitize(message)}`)
    if (options.verbose && error instanceof Error && error.stack) log.err(error.stack)
    return 1
  } finally {
    if (forceTimer) clearTimeout(forceTimer)
    process.removeListener("SIGINT", sigint)
    process.removeListener("SIGTERM", sigterm)
    process.removeListener("exit", onExit)
    prompt.close()
    let childrenSettled = true
    try { childrenSettled = await children.awaitAll(5_000) } catch { /* best effort */ }
    try { await presentation?.close() } catch { /* plain close is a no-op */ }
    // Never release the lock while an owned mutation may still be running:
    // leave it for stale reclaim instead of allowing a second installer in.
    if (childrenSettled) {
      try { await lock?.release() } catch { /* stale lock is reclaimed later */ }
    } else {
      log.err("Warning: an owned child process did not exit; the installer lock was left in place.")
    }
    restoreTerminal(process.stdout, options.json)
  }
}

/** Local redaction for unexpected top-level errors. */
function sanitize(message: string): string {
  return message
    .replace(/\b[a-f0-9]{32,}\b/gi, "[redacted]")
    .replace(/\b(secret|token|password|credential|authorization)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .slice(0, 400)
}
