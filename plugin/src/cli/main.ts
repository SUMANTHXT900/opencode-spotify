import { parseArgs, helpText } from "./args.ts"
import { detectEnvironment } from "./detect.ts"
import { createRuntime } from "./runtime.ts"
import { createPrompter, createUi } from "./ui.ts"
import { packageVersion, githubLatest, npmLatest } from "./versions.ts"
import type { CliOptions, Logger, OperationContext, Prompter, Runtime, Ui, VersionInfo } from "./types.ts"
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
}

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

  const runtime = dependencies.runtime ?? createRuntime()
  const ui = dependencies.ui ?? createUi(log, { color: options.color, json: options.json })
  const prompt = dependencies.prompt ?? createPrompter(log)
  if (!dependencies.prompt) options.nonInteractive = options.nonInteractive || !process.stdin.isTTY
  if (options.command === "uninstall" && options.removeCredentials && options.nonInteractive && !options.yes) {
    log.err("Error: --remove-credentials requires --yes in noninteractive mode")
    return 2
  }
  try {
    ui.banner(version, runtime.platform === "win32")
    const detection = await detectEnvironment(runtime)
    const versions: { plugin: VersionInfo; spicetify: VersionInfo } = {
      plugin: { installed: detection.opencode.plugin.version, latest: null },
      spicetify: { installed: detection.spicetify.version, latest: null },
    }
    if (!options.offline) {
      const [plugin, spicetify] = await Promise.all([
        npmLatest(runtime, "opencode-spotify", options.offline),
        detection.spicetify.available
          ? githubLatest(runtime, "spicetify/cli", options.offline)
          : Promise.resolve<VersionInfo>({ installed: detection.spicetify.version, latest: null }),
      ])
      versions.plugin.latest = plugin.latest
      versions.plugin.latestBeta = plugin.latestBeta
      versions.plugin.error = plugin.error
      versions.spicetify.latest = spicetify.latest
      versions.spicetify.error = spicetify.error
    }
    const ctx: OperationContext = { options, runtime, ui, prompt, detection, installerVersion: version, versions, log }
    return await execute(options.command, ctx)
  } catch (error) {
    const message = error instanceof Error ? error.message : "Installer failed"
    // Never include credential values or full child command lines here.
    log.err(`Error: ${message}`)
    if (options.verbose && error instanceof Error && error.stack) log.err(error.stack)
    return 1
  } finally {
    prompt.close()
  }
}
