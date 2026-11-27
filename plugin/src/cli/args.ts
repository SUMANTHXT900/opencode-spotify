import type { CliOptions, CommandName, ParsedArgs } from "./types.ts"

const commands: CommandName[] = ["setup", "status", "update", "repair", "doctor", "uninstall"]

export const VERSION_FALLBACK = "0.0.0"

function defaults(): CliOptions {
  return {
    command: "setup",
    dryRun: false,
    yes: false,
    json: false,
    color: true,
    offline: false,
    verbose: false,
    help: false,
    version: false,
    nonInteractive: false,
    spicetify: "ask",
    apply: false,
    allowSpicetifyUpgrade: false,
    acceptOlderWinget: false,
    removeCredentials: false,
    complete: false,
    plain: false,
    marketplace: true,
  }
}

/**
 * Parse installer arguments without touching the system. Unknown flags fail
 * closed rather than being treated as consent.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const options = defaults()
  let commandSeen = false
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!
    if (arg === "--") break
    if (!arg.startsWith("-")) {
      if (commandSeen) return { options, error: `Unexpected argument: ${arg}` }
      const normalized = arg.toLowerCase()
      if (normalized === "install") options.command = "setup"
      else if ((commands as string[]).includes(normalized)) options.command = normalized as CommandName
      else return { options, error: `Unknown command: ${arg}` }
      commandSeen = true
      continue
    }
    const equals = arg.indexOf("=")
    const flag = equals >= 0 ? arg.slice(0, equals) : arg
    const value = equals >= 0 ? arg.slice(equals + 1) : undefined
    switch (flag) {
      case "--help": case "-h": options.help = true; break
      case "--version": case "-v": options.version = true; break
      case "--dry-run": options.dryRun = true; break
      case "--yes": case "-y": options.yes = true; break
      case "--json": options.json = true; break
      case "--no-color": options.color = false; break
      case "--color": options.color = true; break
      case "--offline": options.offline = true; break
      case "--verbose": options.verbose = true; break
      case "--non-interactive": options.nonInteractive = true; break
      case "--plain": case "--no-ink": options.plain = true; break
      case "--apply": options.apply = true; break
      case "--allow-spicetify-upgrade": options.allowSpicetifyUpgrade = true; break
      case "--accept-older-winget": options.acceptOlderWinget = true; break
      case "--remove-credentials": options.removeCredentials = true; break
      case "--complete": options.complete = true; break
      case "--marketplace": options.marketplace = true; break
      case "--no-marketplace": options.marketplace = false; break
      case "--package-spec": {
        const spec = value ?? argv[++index]
        if (!spec || spec.startsWith("-")) return { options, error: "--package-spec requires a value" }
        if (!/^[@a-zA-Z0-9._:/+#~^*<>=|-]+$/.test(spec)) {
          return { options, error: "--package-spec contains unsupported characters" }
        }
        options.packageSpec = spec
        break
      }
      case "--spicetify": {
        const source = value ?? argv[++index]
        if (source !== "ask" && source !== "auto" && source !== "manual" && source !== "skip") {
          return { options, error: "--spicetify must be ask, auto, manual, or skip" }
        }
        options.spicetify = source
        break
      }
      default:
        return { options, error: `Unknown option: ${arg}` }
    }
  }
  return { options }
}

export function helpText(): string {
  return `OpenCode Spotify installer

Usage:
  opencode-spotify [command] [options]

Commands:
  setup       Install, or maintain an existing installation (default)
  status      Read-only installation summary
  update      Check for and apply compatible updates
  repair      Repair missing or damaged owned files and registration
  doctor      Read-only diagnostics with actionable guidance
  uninstall   Remove the global registration and owned bridge files

Options:
  --dry-run                 Show the plan without changing anything
  --yes                     Approve planned modifications (required when noninteractive)
  --json                    Machine-readable output where supported
  --no-color                Disable ANSI color
  --offline                 Do not query npm or GitHub
  --spicetify <mode>        ask (default), auto, manual, or skip
  --apply                   Run spicetify apply after bridge preparation (confirm separately)
  --allow-spicetify-upgrade Permit a combined Spicetify CLI update
  --no-marketplace          Skip the default Spicetify Marketplace installation
  --remove-credentials      Separately confirmed credential removal on uninstall
  --complete                Complete removal: interactive typed UNINSTALL, or --non-interactive + --yes
  --package-spec <spec>     Override the npm spec used for global registration
  --non-interactive         Never prompt; missing consent is an error
  --plain                   Force plain-text output (no Ink UI)
  --no-ink                  Alias for --plain
  -h, --help                Show this help
  -v, --version             Show the installer version

Examples:
  opencode-spotify
  opencode-spotify setup
  opencode-spotify status --json
  opencode-spotify doctor
  opencode-spotify update --dry-run
  npx opencode-spotify@0.6.0-beta.3 setup
`
}
