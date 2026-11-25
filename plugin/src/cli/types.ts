// Shared CLI contracts for the V0.6.0 installer. Pure types plus small helpers:
// this module must stay importable by plain Node type-stripping (no TSX/JSX).
export type CommandName = "setup" | "status" | "update" | "repair" | "doctor" | "uninstall"

export interface CommandResult {
  code: number
  stdout: string
  stderr: string
  error?: string
  /** True when the child was killed by our timeout (not a normal nonzero exit). */
  timedOut?: boolean
  /** Wall-clock duration of the child execution in milliseconds. */
  durationMs?: number
}

export interface ExecOptions {
  cwd?: string
  timeoutMs?: number
  env?: Record<string, string>
  /** Written to stdin, then stdin is closed. */
  input?: string
}

/** Safe argv-based command execution. Never use a shell string for user paths. */
export interface Exec {
  run(file: string, args: string[], options?: ExecOptions): Promise<CommandResult>
  which(name: string): Promise<string | undefined>
}

export interface CliOptions {
  command: CommandName
  dryRun: boolean
  yes: boolean
  json: boolean
  color: boolean
  offline: boolean
  verbose: boolean
  help: boolean
  version: boolean
  nonInteractive: boolean
  /** Spicetify handling for a missing CLI. `ask` is the interactive default. */
  spicetify: "ask" | "auto" | "manual" | "skip"
  /** Run `spicetify apply` after preparing the bridge (separate authorization). */
  apply: boolean
  /** Explicitly allow upgrading the Spicetify CLI when both updates are chosen. */
  allowSpicetifyUpgrade: boolean
  removeCredentials: boolean
  /** Override the package spec used for global registration (tests/enterprise pinning). */
  packageSpec?: string
}

export interface ParsedArgs {
  options: CliOptions
  error?: string
}

export interface Logger {
  out(message: string): void
  err(message: string): void
}

export interface Prompter {
  /** Returns undefined when the input is closed or cancelled. */
  ask(question: string): Promise<string | undefined>
  /** Numbered choice; returns the selected value or undefined on cancel. */
  choose<T extends { label: string; value: string }>(question: string, choices: T[], defaultIndex?: number): Promise<string | undefined>
  confirm(question: string, options?: { defaultYes?: boolean; phrase?: string }): Promise<boolean>
  close(): void
}

export type InstallOwner = "script" | "winget" | "scoop" | "choco" | "unknown"

export interface VersionInfo {
  installed: string | null
  latest: string | null
  latestBeta?: string | null
  error?: string
}

export interface OpenCodeInfo {
  available: boolean
  path: string | null
  version: string | null
  configPath: string | null
  configExists: boolean
  plugin: {
    registered: boolean
    version: string | null
    source: string | null
    local: boolean
    spec: string | null
    /** Tri-state (B08): registered / absent (verified) / unknown (list failed). */
    state?: "registered" | "absent" | "unknown"
    /** Sanitized inspection failure detail when state is unknown. */
    detail?: string
  }
  nativeCommands: boolean
  error?: string
}

export interface SpotifyInfo {
  installed: boolean
  store: boolean
  path: string | null
  prefs: string | null
  detail: string
}

export interface SpicetifyInfo {
  available: boolean
  path: string | null
  version: string | null
  owner: InstallOwner
  configPath: string | null
  extensionsDir: string | null
  bridgeRegistered: boolean
  error?: string
}

export interface BridgeInfo {
  configExists: boolean
  credentialValid: boolean
  installed: boolean
  origins: number
  extensionPath: string | null
  extensionExists: boolean
  registration: "absent" | "current" | "stale" | "unknown"
  protocol: 2
  error?: string
}

export interface PortInfo {
  busy: boolean
  likelyOwnedByThisPlugin: boolean | null
}

export interface Detection {
  windows: boolean
  windowsVersion: string
  arch: string
  node: string
  pwsh: string | null
  opencode: OpenCodeInfo
  spotify: SpotifyInfo
  spicetify: SpicetifyInfo
  bridge: BridgeInfo
  port: PortInfo
  compatibility: {
    opencode: "ok" | "too-old" | "unknown"
    spicetify: "ok" | "too-old" | "unknown"
    bridge: "compatible" | "stale" | "missing" | "unknown"
    plugin: "ok" | "missing" | "unknown"
  }
}

export interface PlanStep {
  /** Stable identifier used by dry-run output and tests. */
  id: string
  description: string
  mutates: boolean
  run: () => Promise<void>
}

export interface Plan {
  title: string
  steps: PlanStep[]
}

export interface OperationContext {
  options: CliOptions
  runtime: Runtime
  ui: Ui
  prompt: Prompter
  detection: Detection
  installerVersion: string
  versions: {
    plugin: VersionInfo
    spicetify: VersionInfo
  }
  log: Logger
}

export interface Runtime extends Exec {
  platform: NodeJS.Platform
  arch: string
  env: NodeJS.ProcessEnv
  cwd: string
  homedir: string
  exists(path: string): boolean
  isFile(path: string): boolean
  readText(path: string): string
  writeText(path: string, value: string): void
  copyFile(from: string, to: string): void
  mkdir(path: string): void
  remove(path: string): void
  now(): number
  /** A short-lived connection probe; does not modify anything. */
  portOpen(host: string, port: number, timeoutMs: number): Promise<boolean>
}

export interface Ui {
  banner(version: string, windows: boolean): void
  title(text: string): void
  section(text: string): void
  line(text: string): void
  kv(key: string, value: string): void
  status(kind: "ok" | "missing" | "warn" | "fail" | "info", text: string): void
  bullet(text: string): void
  warn(text: string): void
  error(text: string): void
  success(text: string): void
  json(value: unknown): void
  dryRun(step: string): void
}
