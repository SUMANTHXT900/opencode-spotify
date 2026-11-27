// Repair workflow (B09).
//
// Repair is targeted: it fixes only the owned pieces that are actually broken
// (global registration, owned bridge extension/registration, invalid
// credentials, extension/config drift and a separately requested apply).
// It never installs Spotify or Spicetify, never upgrades either, never resets
// Spotify mods, never runs backup/restore, and never removes unrelated
// extensions or project configuration. Missing prerequisites are reported with
// manual guidance instead of triggering a full reinstall.
import { addGlobalPlugin, reconcileRegistration, removeGlobalPlugin } from "./opencode.ts"
import { bridgeOperation } from "./bridge.ts"
import { OperationCancelled } from "./cancel.ts"
import { detectEnvironment } from "./detect.ts"
import { cancelAwareRuntime, executePlan, maybeApplyBridge, planExitCode, registrationSpec } from "./plan.ts"
import type { PlanOutcome } from "./plan.ts"
import { buildRepairView, renderRepairViewPlain } from "./ui/repair-view.ts"
import type { RepairView } from "./ui/repair-view.ts"
import { troubleshootingSteps } from "./ui/diagnostics-view.ts"
import type { OperationContext, PlanStep, Ui } from "./types.ts"

export type RepairIssueKind =
  | "missing-dependency"
  | "registration"
  | "bridge"
  | "credentials"
  | "extension"
  | "state"
  | "apply"

export interface RepairIssue {
  id: string
  kind: RepairIssueKind
  description: string
  /** False when repairing would require installing/upgrading something. */
  repairable: boolean
}

export interface RepairAssessment {
  issues: RepairIssue[]
  blockers: string[]
  steps: PlanStep[]
  bridgeNeedsRepair: boolean
  registrationNeedsRepair: boolean
  credentialProblem: boolean
  extensionProblem: boolean
}

function registerStep(ctx: OperationContext, description: string): PlanStep {
  const spec = registrationSpec(ctx)
  return {
    id: "register-global-plugin",
    description,
    mutates: true,
    run: async () => {
      const runtime = cancelAwareRuntime(ctx.runtime, ctx.cancel)
      const result = await addGlobalPlugin(runtime, spec, { log: (line) => ctx.ui.line(`  ${line}`) })
      // Cancellation is an outcome, not a failure: never reconcile, retry, or
      // roll back a mutation that was stopped by the user.
      if (isCancelledCommand(result)) {
        throw new OperationCancelled("register-global-plugin", "Global plugin registration was cancelled")
      }
      if (result.code === 0) return
      // B01: reconcile a failed/timed-out mutation before declaring failure.
      const reconciled = await reconcileRegistration(runtime)
      if (reconciled.state === "registered") {
        ctx.ui.warn(`Registration reported failure but is now listed; treating as recovered. Detail: ${result.error ?? "unknown"}`)
        return
      }
      if (reconciled.state === "unknown") {
        throw new Error(`${result.error ?? "opencode plugin add failed"} (verification also failed: ${reconciled.detail ?? "plugin list did not complete"})`)
      }
      throw new Error(result.timedOut
        ? `opencode plugin add timed out and the plugin is still absent; rerun repair (no blind retry was attempted). Detail: ${result.error ?? "timeout"}`
        : (result.error ?? "opencode plugin add failed"))
    },
  }
}

function removeRegistrationStep(ctx: OperationContext, spec: string, description: string): PlanStep {
  return {
    id: "remove-local-registration",
    description,
    mutates: true,
    run: async () => {
      const result = await removeGlobalPlugin(cancelAwareRuntime(ctx.runtime, ctx.cancel), spec)
      if (isCancelledCommand(result)) {
        throw new OperationCancelled("remove-local-registration", "Removing the registration was cancelled")
      }
      if (result.code !== 0) throw new Error(result.error ?? "opencode plugin remove failed")
    },
  }
}

/** True for a child that stopped because cancellation was requested. */
function isCancelledCommand(result: { cancelled?: boolean; code?: number; error?: string }): boolean {
  return result.cancelled === true || result.code === 130 || /E_CANCELLED/i.test(result.error ?? "")
}

/**
 * Truthful cancellation summary: the completed and skipped sets come straight
 * from the plan outcome, so a cancelled run never claims a step finished that
 * was not run.
 */
function reportCancelledPlan(ctx: OperationContext, outcome: PlanOutcome): void {
  const completed = outcome.completed.length ? outcome.completed.join(", ") : "none"
  const skipped = outcome.skipped.length ? outcome.skipped.join(", ") : "none"
  ctx.ui.line(`  Completed steps: ${completed}`)
  ctx.ui.line(`  Not run: ${skipped}`)
}

/**
 * Render only the repair-specific notes. The step list itself is announced
 * exactly once by executePlan (a `plan` event with a reporter, or the shared
 * plain plan screen), so the plan is never printed twice.
 */
function renderRepairNotes(ui: Ui, view: RepairView): void {
  ui.section("Repair notes")
  for (const note of view.notes) ui.bullet(note)
}

/**
 * Assess only owned state. Read-only: never mutates, never installs. The
 * returned steps are limited to the affected components.
 */
export function assessRepair(ctx: OperationContext): RepairAssessment {
  const { detection } = ctx
  const issues: RepairIssue[] = []
  const blockers: string[] = []
  const steps: PlanStep[] = []

  const plugin = detection.opencode.plugin
  const brokenVersion = plugin.registered && !plugin.local && !plugin.version
  const registrationNeedsRepair = !plugin.registered || plugin.local || brokenVersion

  if (plugin.local) {
    issues.push({ id: "local-registration", kind: "registration", description: "A local development path is registered instead of the global package", repairable: true })
    if (plugin.spec) steps.push(removeRegistrationStep(ctx, plugin.spec, `Remove the local development registration ${plugin.spec}`))
    steps.push(registerStep(ctx, `Register ${registrationSpec(ctx)} globally`))
  } else if (!plugin.registered) {
    issues.push({ id: "missing-registration", kind: "registration", description: "The global OpenCode registration is missing", repairable: true })
    steps.push(registerStep(ctx, `Register ${registrationSpec(ctx)} globally`))
  } else if (brokenVersion) {
    issues.push({ id: "broken-registration", kind: "registration", description: "The registered plugin has no usable version", repairable: true })
    steps.push(removeRegistrationStep(ctx, plugin.spec ?? "opencode-spotify", "Remove the unreadable global registration"))
    steps.push(registerStep(ctx, `Register ${registrationSpec(ctx)} globally`))
  }

  const credentialProblem = detection.bridge.configExists && !detection.bridge.credentialValid
  const extensionProblem = (detection.spicetify.bridgeRegistered && !detection.bridge.extensionExists) ||
    detection.bridge.registration === "stale"
  const bridgeNeedsRepair = !detection.bridge.installed || detection.bridge.registration !== "current" || credentialProblem || extensionProblem

  if (credentialProblem) {
    issues.push({
      id: "invalid-credentials",
      kind: "credentials",
      description: "The owned bridge credential file is invalid; it must be regenerated",
      repairable: true,
    })
  }
  if (extensionProblem) {
    issues.push({
      id: "extension-problem",
      kind: "extension",
      description: "The owned extension file or its Spicetify registration is missing or stale",
      repairable: true,
    })
  } else if (!detection.bridge.installed || detection.bridge.registration !== "current") {
    issues.push({
      id: "bridge-problem",
      kind: "bridge",
      description: "The owned bridge extension is missing, stale or unregistered",
      repairable: true,
    })
  }

  if (bridgeNeedsRepair) {
    if (!detection.spicetify.available) {
      blockers.push("Spicetify is not detected, so the owned bridge cannot be repaired automatically. Install Spicetify once with `npx opencode-spotify setup`, then rerun repair. Repair will not install it.")
      for (const step of troubleshootingSteps("spicetify")) blockers.push(step)
    } else if (!detection.pwsh) {
      blockers.push("PowerShell 7 (pwsh) is not available, so the owned bridge cannot be repaired automatically. Install PowerShell 7 and rerun repair.")
      for (const step of troubleshootingSteps("pwsh")) blockers.push(step)
    } else {
      steps.push({
        id: "repair-bridge",
        description: credentialProblem
          ? "Regenerate the invalid owned bridge credentials and re-provision the extension (valid credentials are reused otherwise)"
          : "Repair the owned bridge extension and Spicetify registration (valid credentials reused)",
        mutates: true,
        run: async () => {
          const result = await bridgeOperation(cancelAwareRuntime(ctx.runtime, ctx.cancel), detection.bridge.credentialValid ? "repair" : "install", {
            spicetifyPath: detection.spicetify.path,
            dryRun: false,
            yes: true,
          })
          if (isCancelledCommand(result)) {
            throw new OperationCancelled("repair-bridge", "Bridge repair was cancelled")
          }
          if (result.code !== 0) throw new Error(result.error ?? "Bridge repair failed")
        },
      })
    }
  }

  return {
    issues,
    blockers,
    steps,
    bridgeNeedsRepair,
    registrationNeedsRepair,
    credentialProblem,
    extensionProblem,
  }
}

/**
 * User-requested re-sync when everything already inspects as healthy:
 * re-provision the owned bridge extension, verify it, then run the separate
 * apply consent. The plan/apply flow mirrors the normal repair path so a
 * forced re-sync reports honestly and never claims work it did not do.
 */
async function runForcedResync(ctx: OperationContext): Promise<number> {
  const steps: PlanStep[] = [{
    id: "repair-bridge",
    description: "Re-sync the owned bridge extension and Spicetify registration (user-requested; valid credentials reused)",
    mutates: true,
    run: async () => {
      const result = await bridgeOperation(cancelAwareRuntime(ctx.runtime, ctx.cancel), ctx.detection.bridge.credentialValid ? "repair" : "install", {
        spicetifyPath: ctx.detection.spicetify.path,
        dryRun: false,
        yes: true,
      })
      if (isCancelledCommand(result)) {
        throw new OperationCancelled("repair-bridge", "Bridge re-sync was cancelled")
      }
      if (result.code !== 0) throw new Error(result.error ?? "Bridge re-sync failed")
    },
  }]
  const repairView = buildRepairView(steps, {
    dryRun: ctx.options.dryRun,
    nonInteractive: ctx.options.nonInteractive,
  })
  renderRepairNotes(ctx.ui, repairView)

  const outcome = await executePlan(ctx, "Repair plan", steps)
  if (outcome.status === "cancelled") {
    reportCancelledPlan(ctx, outcome)
    return 130
  }
  const code = planExitCode(outcome)
  if (code !== 0) return code

  const next = await detectEnvironment(ctx.runtime)
  ctx.detection = next
  if (!next.bridge.installed || next.bridge.registration !== "current") {
    ctx.ui.error("The bridge is not synchronized after the re-sync. Review `npx opencode-spotify doctor`.")
    return 1
  }
  const applied = await maybeApplyBridge(ctx, next.spicetify.path, true)
  if (applied.code !== 0) {
    reportCancelledApply(ctx, applied.code, applied.applied)
    return applied.code
  }
  ctx.ui.section("Repair summary")
  ctx.ui.kv("Global plugin", next.opencode.plugin.version ?? "unchanged")
  ctx.ui.kv("Bridge", applied.applied ? "re-synced and applied" : "re-synced; apply pending")
  ctx.ui.bullet("Restart running OpenCode processes after repair.")
  return 0
}

/**
 * Repair only owned state. Stops without mutating when the registration state
 * is unknown (a failed `plugin list` is not proof of absence), when OpenCode
 * cannot manage plugins, or when the affected component cannot be repaired
 * without installing another dependency.
 */
export async function runRepair(ctx: OperationContext): Promise<number> {
  const { ui, detection } = ctx
  if (!detection.windows) {
    ui.error("Repair is supported on Windows only. No changes were made.")
    return 1
  }
  if (!detection.opencode.available) {
    ui.error("OpenCode is not available; repair cannot verify a global registration.")
    ui.bullet("Install or expose the OpenCode CLI on PATH, then rerun repair. Repair never installs it.")
    return 1
  }
  if (!detection.opencode.nativeCommands) {
    ui.error("This OpenCode version lacks native plugin management. Upgrade OpenCode first; repair cannot change the registration.")
    return 1
  }
  if (detection.opencode.plugin.state === "unknown") {
    ui.error(`Global registration state is unknown (inspection failed: ${detection.opencode.plugin.detail ?? "plugin list did not complete"}). Rerun \`npx opencode-spotify doctor\`; no changes were made and no blind retry was attempted.`)
    return 1
  }

  const assessment = assessRepair(ctx)
  const { steps, blockers } = assessment
  const applyRequested = ctx.options.apply && detection.bridge.registration === "current" && detection.spicetify.available

  if (!steps.length && !applyRequested) {
    if (blockers.length) {
      const view = buildRepairView(steps, {
        dryRun: ctx.options.dryRun,
        nonInteractive: ctx.options.nonInteractive,
        blockedReason: blockers[0],
        notes: blockers.slice(1),
      })
      for (const line of renderRepairViewPlain(view)) ui.line(line)
      return 1
    }
    // Everything is healthy on disk. In interactive mode offer a forced
    // re-sync (re-provision the bridge, then apply) instead of only
    // reporting "nothing to do". Non-interactive and dry-run runs stay
    // deterministic: no prompt is asked and nothing mutates.
    if (!ctx.options.nonInteractive && !ctx.options.dryRun && ctx.detection.spicetify.available) {
      const resync = await ctx.prompt.confirm(
        "Everything looks installed on disk. Re-sync the bridge and run spicetify apply anyway? [y/N]",
        { defaultYes: false },
      )
      if (resync) return runForcedResync(ctx)
    }
    const view = buildRepairView(steps, {
      dryRun: ctx.options.dryRun,
      nonInteractive: ctx.options.nonInteractive,
    })
    for (const line of renderRepairViewPlain(view)) ui.line(line)
    if (detection.bridge.registration === "current") {
      ui.line("  Run `npx opencode-spotify doctor` for a full read-only diagnostics report.")
    }
    return 0
  }

  if (!steps.length && applyRequested) {
    // Apply-only repair (a previous apply failed or is pending). This keeps
    // the separate apply consent and never re-installs anything.
    const applied = await maybeApplyBridge(ctx, detection.spicetify.path, true)
    if (applied.code !== 0) {
      reportCancelledApply(ctx, applied.code, applied.applied)
      return applied.code
    }
    ui.section("Repair summary")
    ui.kv("Global plugin", detection.opencode.plugin.version ?? "unchanged")
    ui.kv("Bridge", applied.applied ? "applied" : "apply pending")
    return 0
  }

  // C20 repair screen: one plan source. executePlan owns the step list (a
  // `plan` event with a reporter, or the shared plain screen); only the
  // repair-specific notes/issues are rendered here so nothing is shown twice.
  const repairView = buildRepairView(steps, {
    dryRun: ctx.options.dryRun,
    nonInteractive: ctx.options.nonInteractive,
    notes: blockers,
  })
  renderRepairNotes(ui, repairView)

  const outcome = await executePlan(ctx, "Repair plan", steps)
  if (outcome.status === "dry-run") {
    for (const blocker of blockers) ui.warn(blocker)
    return 0
  }
  if (outcome.status === "cancelled") {
    reportCancelledPlan(ctx, outcome)
    return 130
  }
  // A real failure (1) or missing confirmation (2) keeps its own exit code.
  const code = planExitCode(outcome)
  if (code !== 0) return code

  const next = await detectEnvironment(ctx.runtime)
  ctx.detection = next
  if (next.opencode.plugin.state === "unknown") {
    ui.error(`Global registration state is unknown after repair (inspection failed: ${next.opencode.plugin.detail ?? "plugin list did not complete"}). Rerun doctor; no blind retry was attempted.`)
    return 1
  }
  if (assessment.registrationNeedsRepair && (!next.opencode.plugin.registered || next.opencode.plugin.local)) {
    ui.error("Global registration could not be verified after repair.")
    return 1
  }
  if (assessment.bridgeNeedsRepair && (!next.bridge.installed || next.bridge.registration !== "current")) {
    ui.error("The bridge remains inconsistent after repair. Review `npx opencode-spotify doctor`.")
    return 1
  }

  // Never hide a component that could not be repaired. Registration work may
  // still have succeeded above, so report it honestly instead of rolling back.
  if (blockers.length) {
    ui.warn("Repair completed the owned steps it could, but the following still requires manual action:")
    for (const blocker of blockers) ui.bullet(blocker)
  }

  // Only apply a bridge that was actually repaired; a blocked bridge must not
  // be "applied" from stale state.
  const bridgePrepared = assessment.bridgeNeedsRepair && blockers.length === 0
  const applied = await maybeApplyBridge(ctx, next.spicetify.path, bridgePrepared)
  if (applied.code !== 0) {
    reportCancelledApply(ctx, applied.code, applied.applied)
    return applied.code
  }
  // The summary is derived from the plan outcome, never from the intended
  // steps: a step that did not run cannot be reported as repaired.
  const bridgeRepaired = outcome.completed.includes("repair-bridge")
  const registrationRepaired = outcome.completed.includes("register-global-plugin") ||
    outcome.completed.includes("remove-local-registration")
  ui.section("Repair summary")
  ui.kv("Global plugin", registrationRepaired ? (next.opencode.plugin.version ?? "registered") : "unchanged")
  ui.kv(
    "Bridge",
    bridgeRepaired
      ? applied.applied
        ? "repaired and applied"
        : "repaired; apply pending"
      : applied.applied
        ? "applied"
        : "unchanged",
  )
  ui.bullet("Restart running OpenCode processes after repair.")
  if (assessment.credentialProblem) {
    ui.bullet("Credentials were regenerated because the previous file was invalid; reinstall the bridge if another copy exists.")
  }
  return blockers.length ? 1 : 0
}

/**
 * A cancelled apply is cancellation (130), never a generic failure. The note
 * says whether the protected apply step actually finished.
 */
function reportCancelledApply(ctx: OperationContext, code: number, applied: boolean): void {
  if (code !== 130) return
  ctx.ui.warn(
    applied
      ? "Cancelled after the apply step finished; the bridge was applied before cancellation."
      : "Cancelled before apply started; the bridge is prepared but not applied.",
  )
}
