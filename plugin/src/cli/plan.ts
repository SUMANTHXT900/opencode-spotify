// Plan presentation, consent, and shared workflow dependencies.
//
// Every mutating command builds PlanSteps and routes them through
// executePlan(), which:
//   * shows the full plan before doing anything,
//   * never runs a mutating step during --dry-run,
//   * requires --yes or an explicit interactive confirmation,
//   * stops at the first failure and reports completed/remaining stages.
//
// The dependency surface keeps workflows testable with a fake Runtime/Ui/
// Prompter without weakening the production defaults, which delegate to the
// real opencode/spicetify/bridge modules.
import { addGlobalPlugin, isPathLikeSource, projectPlugins, removeGlobalPlugin } from "./opencode.ts"
import { installSpicetify, upgradeSpicetify } from "./spicetify.ts"
import { applyBridge, bridgeOperation, removeCredentials } from "./bridge.ts"
import { detectEnvironment } from "./detect.ts"
import { githubLatest, npmLatest } from "./versions.ts"
import type {
  CommandResult,
  Detection,
  Logger,
  OperationContext,
  PlanStep,
  Runtime,
  SpicetifyInfo,
  VersionInfo,
} from "./types.ts"

export interface ProjectPluginEntry {
  id: string
  version: string
  source: string
}

export interface SpicetifyInstallActionOptions {
  /** Always false in practice: executePlan owns dry-run handling. */
  dryRun: boolean
  log: Logger
}

export interface SpicetifyUpgradeActionOptions {
  dryRun: boolean
  log: Logger
}

export interface BridgeActionOptions {
  spicetifyPath: string | null
  dryRun: boolean
  yes: boolean
}

/** Every side effect a workflow can perform, except detection/registry reads. */
export interface WorkflowDeps {
  detect(runtime: Runtime): Promise<Detection>
  latestPlugin(runtime: Runtime, offline: boolean): Promise<VersionInfo>
  latestSpicetify(runtime: Runtime, offline: boolean): Promise<VersionInfo>
  addGlobalPlugin(runtime: Runtime, spec: string): Promise<CommandResult>
  removeGlobalPlugin(runtime: Runtime, spec: string): Promise<CommandResult>
  projectPlugins(runtime: Runtime): Promise<ProjectPluginEntry[]>
  installSpicetify(runtime: Runtime, info: SpicetifyInfo, options: SpicetifyInstallActionOptions): Promise<CommandResult>
  upgradeSpicetify(runtime: Runtime, info: SpicetifyInfo, options: SpicetifyUpgradeActionOptions): Promise<CommandResult>
  bridgeOperation(runtime: Runtime, operation: "install" | "repair" | "uninstall", options: BridgeActionOptions): Promise<CommandResult>
  applyBridge(runtime: Runtime, options: { spicetifyPath: string | null }): Promise<CommandResult>
  removeCredentials(runtime: Runtime): Promise<CommandResult>
}

export const defaultWorkflowDeps: WorkflowDeps = {
  detect: (runtime) => detectEnvironment(runtime),
  latestPlugin: (runtime, offline) => npmLatest(runtime, "opencode-spotify", offline),
  latestSpicetify: (runtime, offline) => githubLatest(runtime, "spicetify/cli", offline),
  addGlobalPlugin: (runtime, spec) => addGlobalPlugin(runtime, spec),
  removeGlobalPlugin: (runtime, spec) => removeGlobalPlugin(runtime, spec),
  projectPlugins: (runtime) => projectPlugins(runtime),
  installSpicetify: (runtime, info, options) =>
    installSpicetify(runtime, info, {
      dryRun: options.dryRun,
      // executePlan has already obtained the user's approval.
      approve: async () => true,
      log: options.log,
    }),
  upgradeSpicetify: (runtime, info, options) =>
    upgradeSpicetify(runtime, info, {
      dryRun: options.dryRun,
      approve: async () => true,
      log: options.log,
    }),
  bridgeOperation: (runtime, operation, options) => bridgeOperation(runtime, operation, options),
  applyBridge: (runtime, options) => applyBridge(runtime, options),
  removeCredentials: (runtime) => removeCredentials(runtime),
}

export function resolveWorkflowDeps(overrides: Partial<WorkflowDeps> = {}): WorkflowDeps {
  return { ...defaultWorkflowDeps, ...overrides }
}

/**
 * Pinned registration spec. The installer's own version is authoritative for
 * setup (an npx invocation exists by definition), and packageSpec overrides it
 * for enterprise/test pinning.
 */
export function registrationSpec(ctx: OperationContext, version?: string | null): string {
  if (ctx.options.packageSpec) return ctx.options.packageSpec
  const target = (version ?? ctx.installerVersion ?? "").trim().replace(/^v/i, "") || "0.0.0"
  return `opencode-spotify@${target}`
}

/** Version component of an npm-ish spec, used only to reject downgrades. */
export function specVersion(spec: string | null | undefined): string | null {
  if (!spec) return null
  const value = spec.trim()
  const at = value.lastIndexOf("@")
  if (at <= 0) return null
  const candidate = value.slice(at + 1).trim()
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(candidate) ? candidate : null
}

export function isSpotifyPluginId(id: string): boolean {
  const value = (id ?? "").trim().replace(/@\d+\.\d+\.\d+.*$/, "")
  if (value === "opencode-spotify") return true
  return (value.split("/").pop() ?? value) === "opencode-spotify"
}

/**
 * A project-local opencode-spotify registration. Setup/repair only warn about
 * it: project configuration is never edited, and a project entry may take
 * precedence over the global registration.
 */
export async function findProjectPluginConflict(
  runtime: Runtime,
  deps: WorkflowDeps,
): Promise<ProjectPluginEntry | undefined> {
  try {
    const entries = await deps.projectPlugins(runtime)
    return entries.find(
      (entry) =>
        isSpotifyPluginId(entry.id) &&
        (entry.version.trim().toLowerCase() === "local" || isPathLikeSource(entry.source)),
    )
  } catch {
    return undefined
  }
}

/**
 * Stop a workflow when a mutating action reported failure. CommandResult is
 * the shared child-process shape; the extra ok/success checks tolerate fakes.
 * Detail text is sanitized so a child process cannot echo a credential.
 */
export function assertActionResult(result: CommandResult | unknown, message: string): void {
  if (result === false) throw new Error(message)
  if (!result || typeof result !== "object") return
  const record = result as { code?: unknown; error?: unknown; ok?: unknown; success?: unknown }
  const failed =
    record.ok === false ||
    record.success === false ||
    (typeof record.code === "number" && record.code !== 0)
  if (!failed) return
  const detail = typeof record.error === "string" ? sanitizeMessage(record.error) : ""
  throw new Error(detail ? `${message} ${detail}` : message)
}

export function sanitizeMessage(message: string): string {
  return message
    .replace(/\b[a-f0-9]{32,}\b/gi, "[redacted]")
    .replace(/\b(secret|token|password|credential|authorization)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .slice(0, 240)
}

function describeFailure(error: unknown): string {
  if (error instanceof Error && error.message) return sanitizeMessage(error.message)
  return "The step failed."
}

export type PlanStatus = "completed" | "dry-run" | "cancelled" | "confirmation-required" | "failed"

export interface PlanOutcome {
  status: PlanStatus
  /** IDs of steps that ran successfully. */
  completed: string[]
  /** IDs of steps that were not run. */
  skipped: string[]
  failed?: string
  error?: string
}

export interface PlanConfirmation {
  /** Caller already obtained consent for this exact plan. */
  approved?: boolean
  /** Ask even when --yes was supplied (used for apply's separate consent). */
  force?: boolean
  question?: string
  defaultYes?: boolean
  phrase?: string
}

function showPlan(ctx: OperationContext, title: string, steps: PlanStep[]): void {
  ctx.ui.section(title)
  steps.forEach((step, index) => {
    ctx.ui.bullet(`${index + 1}. ${step.description}${step.mutates ? "" : " (verification only)"}`)
  })
}

/**
 * Present and execute a plan. Read-only plans do not prompt. Mutating plans
 * require --yes or an explicit confirmation; cancellation and missing consent
 * run nothing and return a non-completed status.
 */
export async function executePlan(
  ctx: OperationContext,
  title: string,
  steps: PlanStep[],
  confirmation: PlanConfirmation = {},
): Promise<PlanOutcome> {
  const { options, prompt, ui } = ctx
  showPlan(ctx, title, steps)
  if (steps.length === 0) {
    ui.status("info", "Nothing to do.")
    return { status: "completed", completed: [], skipped: [] }
  }

  if (options.dryRun) {
    for (const step of steps) ui.dryRun(step.description)
    ui.line("  Dry run: no changes were made.")
    return { status: "dry-run", completed: [], skipped: steps.map((step) => step.id) }
  }

  const mutates = steps.some((step) => step.mutates)
  const needsPrompt = mutates && !confirmation.approved && (confirmation.force || !options.yes)
  if (needsPrompt) {
    if (options.nonInteractive) {
      ui.error("Confirmation required in noninteractive mode; no changes were made.")
      return { status: "confirmation-required", completed: [], skipped: steps.map((step) => step.id) }
    }
    const approved = await prompt.confirm(confirmation.question ?? "Apply this plan?", {
      defaultYes: confirmation.defaultYes === true,
      ...(confirmation.phrase ? { phrase: confirmation.phrase } : {}),
    })
    if (!approved) {
      ui.warn("Cancelled. No steps in this plan were run. Earlier completed operations (for example a separately approved Spicetify install or upgrade) are unaffected and are not rolled back.")
      return { status: "cancelled", completed: [], skipped: steps.map((step) => step.id) }
    }
  }

  const completed: string[] = []
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index]!
    try {
      await step.run()
      completed.push(step.id)
      ui.success(step.description)
    } catch (error) {
      const message = describeFailure(error)
      const skipped = steps.slice(index + 1).map((item) => item.id)
      ui.error(`Stopped at: ${step.id} - ${step.description}`)
      ui.line(`   Reason: ${message}`)
      ui.line(`   Completed stages: ${completed.length ? completed.join(", ") : "none"}`)
      ui.line(`   Not run: ${skipped.length ? skipped.join(", ") : "none"}`)
      return {
        status: "failed",
        completed,
        skipped,
        failed: step.id,
        error: message,
      }
    }
  }
  ui.status("ok", "Plan completed.")
  return { status: "completed", completed, skipped: [] }
}

export interface ApplyOutcome {
  code: number
  applied: boolean
  pending: boolean
}

/** Map a plan outcome to a process exit code. */
export function planExitCode(outcome: PlanOutcome): number {
  switch (outcome.status) {
    case "completed": case "dry-run": return 0
    case "cancelled": return 130
    case "confirmation-required": return 2
    default: return 1
  }
}

/** Human label for detection/compatibility states. */
export function compatibilityLabel(state: string): string {
  switch (state) {
    case "ok": case "compatible": return "compatible"
    case "too-old": return "unsupported version"
    case "stale": return "needs repair"
    case "missing": return "not installed"
    default: return "unknown"
  }
}

/**
 * Present a separate apply plan after bridge preparation. This keeps the
 * Spicetify apply consent independent from the bridge file consent.
 */
export async function maybeApplyBridge(
  ctx: OperationContext,
  spicetifyPath: string | null,
  prepared: boolean,
): Promise<{ code: number; applied: boolean }> {
  if (!prepared) return { code: 0, applied: false }
  const applied = await applyPlanIfRequested(ctx, [{
    id: "apply-spicetify",
    description: "Run spicetify apply to activate the prepared bridge (may restart Spotify)",
    mutates: true,
    run: async () => {
      const result = await applyBridge(ctx.runtime, { spicetifyPath })
      if (result.code !== 0) throw new Error(result.error ?? "spicetify apply failed")
    },
  }])
  return { code: applied.code, applied: applied.applied }
}

/**
 * Apply Spicetify changes after bridge preparation. Preparation never applies
 * automatically. Interactive runs ask a separate question even when --yes was
 * supplied; noninteractive runs apply only with --apply --yes.
 */
export async function applyPlanIfRequested(
  ctx: OperationContext,
  steps: PlanStep[],
): Promise<ApplyOutcome> {
  const { options, ui } = ctx
  if (options.dryRun) {
    if (options.apply) {
      await executePlan(ctx, "Apply Spicetify changes", steps)
    } else {
      ui.dryRun("Leave Spicetify apply pending; rerun with --apply --yes to apply")
    }
    return { code: 0, applied: false, pending: true }
  }

  if (options.apply) {
    if (options.nonInteractive && !options.yes) {
      ui.warn("Apply pending: noninteractive mode requires --apply --yes.")
      return { code: 1, applied: false, pending: true }
    }
    const outcome = await executePlan(ctx, "Apply Spicetify changes", steps)
    if (outcome.status === "completed") return { code: 0, applied: true, pending: false }
    ui.warn("Apply pending. The bridge is prepared but Spicetify has not been applied.")
    return { code: 1, applied: false, pending: true }
  }

  if (options.nonInteractive) {
    ui.warn("Apply pending: rerun with --apply --yes when ready to apply Spicetify changes.")
    return { code: 0, applied: false, pending: true }
  }

  const outcome = await executePlan(ctx, "Apply Spicetify changes", steps, {
    force: true,
    question: "Apply Spicetify changes now?",
  })
  if (outcome.status === "completed") return { code: 0, applied: true, pending: false }
  if (outcome.status === "cancelled") {
    ui.warn("Apply pending. The bridge is prepared; run spicetify apply when ready.")
    return { code: 0, applied: false, pending: true }
  }
  ui.warn("Apply pending. The bridge is prepared but Spicetify has not been applied.")
  return { code: 1, applied: false, pending: true }
}
