// Shared CLI contracts for the V0.6.0 installer. Pure types plus small helpers:
// this module must stay importable by plain Node type-stripping (no TSX/JSX).
import type { CancelToken } from "./cancel.ts"

export type CommandName = "setup" | "status" | "update" | "repair" | "doctor" | "uninstall"

export interface CommandResult {
  code: number
  stdout: string
  stderr: string
  error?: string
  /** True when the child was killed by our timeout (not a normal nonzero exit). */
  timedOut?: boolean
  /** True when execution stopped because cancellation was requested. */
  cancelled?: boolean
  /** Wall-clock duration of the child execution in milliseconds. */
  durationMs?: number
}

export interface ExecOptions {
  cwd?: string
  timeoutMs?: number
  env?: Record<string, string>
  /** Written to stdin, then stdin is closed. */
  input?: string
  /** Cooperative cancellation shared with the operation. */
  cancel?: CancelToken
  /** How an owned child may be terminated; defaults to "tree". */
  killPolicy?: "tree" | "single" | "none"
  /** Short label used in child kill reports. */
  label?: string
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
  /** Force plain-text UI even on a TTY (also via OPENCODE_SPOTIFY_UI=plain). */
  plain?: boolean
  /** Spicetify handling for a missing CLI. `ask` is the interactive default. */
  spicetify: "ask" | "auto" | "manual" | "skip"
  /** Run `spicetify apply` after preparing the bridge (separate authorization). */
  apply: boolean
  /** Explicitly allow upgrading the Spicetify CLI when both updates are chosen. */
  allowSpicetifyUpgrade: boolean
  /** Noninteractive: explicitly accept the older Winget package when it lags upstream. */
  acceptOlderWinget: boolean
  removeCredentials: boolean
  /** Explicit complete-removal authorization (replaces env-var-only auth). */
  complete?: boolean
  /**
   * Install the Spicetify Marketplace by default. `false` (via
   * `--no-marketplace`) skips it; unset means true.
   */
  marketplace?: boolean
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

export interface OpenCodePluginInfo {
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

export interface OpenCodeInfo {
  available: boolean
  path: string | null
  version: string | null
  configPath: string | null
  configExists: boolean
  plugin: OpenCodePluginInfo
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
  /**
   * Cancellation behavior: "boundary" stops after this step, "abort" stops
   * immediately, "protected" always runs to completion once started.
   */
  interrupt?: "boundary" | "abort" | "protected"
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
  /** Cooperative cancellation for every step/child in this operation. */
  cancel: CancelToken
  versions: {
    plugin: VersionInfo
    spicetify: VersionInfo
  }
  log: Logger
  /** Structured progress/state. Optional until fixture migration lands; guards required. */
  report?: ProgressReporter
  /** Revalidates an external guard (installer lock) before each mutating step. */
  guard?: () => Promise<void>
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
  /**
   * Run a child with inherited stdio (used only for the official Spicetify
   * installer). No capture, no secret args. Optional until B05 lands.
   */
  runInteractive?(
    file: string,
    args: string[],
    options?: {
      cwd?: string
      env?: Record<string, string>
      cancel?: CancelToken
      killPolicy?: "tree" | "single" | "none"
      label?: string
    },
  ): Promise<CommandResult>
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
  /** Release/restore the terminal around an interactive child (Ink). */
  suspend?(): Promise<void>
  resume?(): Promise<void>
  close?(): Promise<void>
}

// ---- installer presentation mode (master contract, A04 §3) ----
export type UiMode = "json" | "plain" | "ink"

export interface UiIo {
  stdoutTTY: boolean
  stdinTTY: boolean
  env: NodeJS.ProcessEnv
}

// ---- installer state (master contract, A04 §3) ----
export type InstallerPhase =
  | "init" | "detect" | "plan" | "consent"
  | "execute" | "verify" | "report" | "done"
  | "cancelling"

export type StepStatus = "pending" | "running" | "ok" | "failed" | "skipped"
export type LogLevel = "info" | "success" | "warn" | "error" | "debug"

export interface PlanStepView {
  id: string
  description: string
  mutates: boolean
  status: StepStatus
  detail?: string
}

export interface InstallerPlanView {
  title: string
  steps: PlanStepView[]
}

export interface PromptChoiceView {
  label: string
  value: string
  hint?: string
}

export type PromptRequest =
  | { id: string; kind: "ask"; question: string; initial?: string }
  | { id: string; kind: "choose"; question: string; choices: PromptChoiceView[]; defaultIndex: number }
  | { id: string; kind: "confirm"; question: string; defaultYes: boolean; phrase?: string }

export interface InstallerSnapshot {
  schemaVersion: 1
  command: CommandName
  mode: UiMode
  version: string
  windows: boolean
  phase: InstallerPhase
  phaseLabel: string
  startedAt: number
  endedAt?: number
  detection?: Detection
  versions: {
    plugin: VersionInfo
    spicetify: VersionInfo
  }
  plan?: InstallerPlanView
  activity: Array<{ at: number; level: LogLevel; message: string }>
  progress?: { scope: string; message: string; percent?: number } | null
  prompt?: PromptRequest | null
  /** Cancellation state mirrored for presenters; omitted until one is requested. */
  cancel?: { phase: string; stepId?: string; forced?: boolean }
  exitCode?: number
}

export type ProgressEvent =
  | { type: "phase"; phase: InstallerPhase; label: string; at: number }
  | { type: "detection"; detection: Detection; at: number }
  | { type: "versions"; plugin: VersionInfo; spicetify: VersionInfo; at: number }
  | { type: "plan"; title: string; steps: PlanStepView[]; at: number }
  | { type: "step"; id: string; status: StepStatus; description?: string; detail?: string; at: number }
  | { type: "log"; level: LogLevel; message: string; at: number }
  | { type: "progress"; scope: string; message: string; percent?: number; at: number }
  | { type: "prompt"; request: PromptRequest | null; at: number }
  | { type: "cancel"; phase: "requested" | "finishing" | "settled"; stepId?: string; forced?: boolean; at: number }
  | { type: "result"; code: number; at: number }

export interface ProgressReporter {
  emit(event: ProgressEvent): void
  phase(phase: InstallerPhase, label?: string): void
  step(id: string, status: StepStatus, detail?: string): void
  log(level: LogLevel, message: string): void
  progress(scope: string, message: string, percent?: number): void
  prompt(request: PromptRequest | null): void
}

export interface InstallerStore {
  getSnapshot(): InstallerSnapshot
  dispatch(event: ProgressEvent): void
  subscribe(listener: () => void): () => void
}

export interface Presentation {
  mode: UiMode
  ui: Ui
  prompt: Prompter
  report: ProgressReporter
  close(): Promise<void>
}
