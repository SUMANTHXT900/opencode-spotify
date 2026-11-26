// Update workflow (B09).
//
// Update is deliberately channel-aware and ownership-aware:
//   * installed vs target versions come from update-plan.ts (single source of
//     truth); an older registry tag is never advertised as an update and no
//     workflow ever downgrades or moves a stable install onto beta;
//   * the Spicetify route is chosen from the detected owner and the achievable
//     target for that owner; a target is only considered when the published
//     version is a strict stable release;
//   * a manager-owned Spicetify (winget/scoop/choco) is updated through that
//     owner's manager only, never by installing a second copy;
//   * an unknown owner is refused for an explicitly requested Spicetify update,
//     and skipped (with a warning) when the plugin update can still proceed.
//
// The owned bridge is synchronized to the selected plugin version while
// reusing valid credentials, and the known broken beta.2 bridge is repaired
// even when it happens to inspect as current.
//
// Cancellation is cooperative: every mutation receives ctx.cancel, protected
// steps finish once started, and a cancelled run returns 130 (never 1).
import { compareVersions } from "./compat.ts"
import { inspectOpenCode, addGlobalPlugin, reconcileRegistration, removeGlobalPlugin, updateGlobalPlugin } from "./opencode.ts"
import { detectEnvironment } from "./detect.ts"
import { bridgeOperation } from "./bridge.ts"
import { upgradeSpicetify } from "./spicetify-official.ts"
import type { OfficialInstallerApproval, OfficialUpgradeOptions } from "./spicetify-official.ts"
import { OperationCancelled } from "./cancel.ts"
import {
  announcePlan,
  cancelAwareRuntime,
  maybeApplyBridge,
  planExitCode,
  planReporter,
  planSkipOutcome,
  registrationSpec,
  runPlanSteps,
  specVersion,
} from "./plan.ts"
import { describePluginUpdate, isBrokenBeta2, type UpdateAvailability } from "./update-plan.ts"
import {
  confirmUpdatePlan,
  createUpdateSummary,
  createUpdateViewModel,
  promptUpdateSelection,
  renderSpicetifyGuidance,
  renderUpdatePlan,
  renderUpdateScreen,
  renderUpdateSummary,
  spicetifyUpdateGuidance,
  toUpdatePlan,
  type UpdateViewModel,
} from "./ui/update-view.ts"
import { PLAN_MESSAGES, sanitizeMessage } from "./state.ts"
import type { InstallOwner, OperationContext, PlanStep, SpicetifyInfo } from "./types.ts"

/**
 * Forward a progress line to the structured reporter when one is attached,
 * keeping the legacy two-space Ui line otherwise (B06 contract). No percentage
 * is ever fabricated; progress stays indeterminate.
 */
function reportProgressLine(ctx: OperationContext, scope: string, line: string): void {
  const reporter = ctx.report
  if (reporter && typeof reporter.progress === "function") {
    try {
      reporter.progress(scope, line)
      return
    } catch {
      // A broken reporter must never abort the operation; use the Ui fallback.
    }
  }
  ctx.ui.line(`  ${line}`)
}

export type UpdateChoice = "auto" | "plugin" | "both" | "spicetify"

/** Owner-derived Spicetify update route. "official" is the script installer. */
export type SpicetifyUpdateMethod = "official" | "winget" | "scoop" | "choco" | "unsupported"

export function spicetifyUpdateMethod(owner: InstallOwner): SpicetifyUpdateMethod {
  switch (owner) {
    case "script": return "official"
    case "winget": return "winget"
    case "scoop": return "scoop"
    case "choco": return "choco"
    default: return "unsupported"
  }
}

const STRICT_STABLE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

/**
 * Strictly stable version (no prerelease/build suffix, no leading zeros) or
 * null. A published prerelease is never an achievable update target.
 */
export function stableSpicetifyVersion(value: string | null | undefined): string | null {
  const candidate = (value ?? "").trim().replace(/^v/i, "")
  return STRICT_STABLE.test(candidate) ? candidate : null
}

/**
 * The version an owner-safe upgrade can actually install. Only a strict stable
 * published version may be advertised; anything else yields no target rather
 * than an invented one.
 */
export function spicetifyUpdateTarget(method: SpicetifyUpdateMethod, latest: string | null): string | null {
  if (method === "unsupported") return null
  return stableSpicetifyVersion(latest)
}

export function spicetifyUpdateDescription(owner: InstallOwner): string {
  switch (spicetifyUpdateMethod(owner)) {
    case "official":
      return "Upgrade Spicetify through its official installer/update pipeline (script-owned install; no second copy)"
    case "winget":
      return "Upgrade Spicetify through Winget (Spicetify.Spicetify owner package; no second copy)"
    case "scoop":
      return "Upgrade Spicetify through Scoop (owner package; no second copy)"
    case "choco":
      return "Upgrade Spicetify through Chocolatey (owner package; no second copy)"
    default:
      return "Spicetify owner is unknown; owner-safe update is not possible"
  }
}

export type SpicetifyGateStatus =
  | "outdated"
  | "current"
  | "unknown"
  | "downgrade"
  | "not-installed"
  | "unsupported-owner"

export interface SpicetifyUpdateGate {
  status: SpicetifyGateStatus
  /** The owner-safe target that could be installed, when one exists. */
  achievable: string | null
  /** Set only when an update should run. */
  target: string | null
  installed: string | null
  owner: InstallOwner
  method: SpicetifyUpdateMethod
  /** Human wording for a state that must not be described as "current". */
  message?: string
}

/**
 * Gate a Spicetify update from the achievable target and the detected owner.
 * A missing or prerelease published version never turns into "current".
 */
export function spicetifyUpdateGate(input: {
  installed: string | null
  owner: InstallOwner
  latest: string | null | undefined
}): SpicetifyUpdateGate {
  const method = spicetifyUpdateMethod(input.owner)
  const achievable = spicetifyUpdateTarget(method, input.latest ?? null)
  const base = {
    installed: input.installed,
    owner: input.owner,
    method,
    achievable,
    target: null as string | null,
  }
  if (!input.installed) {
    return { ...base, status: "not-installed", message: "Spicetify is not detected; run `opencode-spotify setup` instead." }
  }
  if (method === "unsupported") {
    return {
      ...base,
      status: "unsupported-owner",
      message: "The Spicetify installation owner is unknown. Refusing to update it: an owner-safe update cannot be selected and a second copy would be unsafe.",
    }
  }
  if (!achievable) {
    const published = (input.latest ?? "").trim()
    return {
      ...base,
      status: "unknown",
      message: published
        ? `The published Spicetify version ${sanitizeMessage(published)} is not a strict stable release, so no owner-safe update target is available.`
        : "The latest Spicetify version could not be determined, so no owner-safe update target is available.",
    }
  }
  const compared = compareVersions(achievable, input.installed)
  if (compared === 1) return { ...base, status: "outdated", target: achievable }
  if (compared === 0) return { ...base, status: "current", message: `Spicetify ${input.installed} is current.` }
  if (compared === -1) {
    return {
      ...base,
      status: "downgrade",
      message: `The available Spicetify ${achievable} is older than installed ${input.installed}; downgrades are never automatic.`,
    }
  }
  return { ...base, status: "unknown", message: "Spicetify versions could not be compared, so no owner-safe update will run." }
}

function gateAvailability(status: SpicetifyGateStatus): UpdateAvailability["spicetify"] {
  switch (status) {
    case "outdated": return "outdated"
    case "current": return "current"
    case "downgrade": return "downgrade"
    default: return "unknown"
  }
}

function pluginSpec(ctx: OperationContext): string | null {
  if (ctx.options.packageSpec) return ctx.options.packageSpec
  return ctx.detection.opencode.plugin.spec ?? (ctx.detection.opencode.plugin.registered ? "opencode-spotify" : null)
}

function bridgeNeedsRepair(ctx: OperationContext): boolean {
  return !ctx.detection.bridge.installed || ctx.detection.bridge.registration !== "current" ||
    (ctx.detection.bridge.configExists && !ctx.detection.bridge.credentialValid)
}

async function verifyVersion(ctx: OperationContext, expected: string): Promise<boolean> {
  const info = await inspectOpenCode(ctx.runtime)
  ctx.detection.opencode = info
  if (!info.plugin.registered || info.plugin.local) return false
  const compared = compareVersions(info.plugin.version, expected)
  return compared !== null && compared !== -1
}

/**
 * One Spicetify update step. The route is chosen from the detected owner:
 * official pipeline for script installs, the owner's manager otherwise.
 * Unknown owners never reach this step (refused or skipped while planning).
 *
 * The plan screen already obtained consent, so the approval callback only
 * displays the exact route details; it never asks a second time.
 */
async function spicetifyUpdateStep(ctx: OperationContext): Promise<PlanStep> {
  return {
    id: "upgrade-spicetify",
    description: spicetifyUpdateDescription(ctx.detection.spicetify.owner),
    mutates: true,
    // A started upgrade finishes and verifies before cancellation is honoured.
    interrupt: "protected",
    run: async () => {
      const options: OfficialUpgradeOptions = {
        dryRun: false,
        offline: ctx.options.offline,
        nonInteractive: ctx.options.nonInteractive,
        interactive: !ctx.options.nonInteractive,
        cancel: ctx.cancel,
        log: { out: (line: string) => reportProgressLine(ctx, "spicetify", line), err: (line: string) => ctx.log.err(line) },
        onProgress: (line: string) => reportProgressLine(ctx, "spicetify", line),
        beforeInteractive: async () => { await ctx.ui.suspend?.() },
        afterInteractive: async () => { await ctx.ui.resume?.() },
        approve: async (details: OfficialInstallerApproval) => {
          ctx.ui.section("Spicetify upgrade plan")
          ctx.ui.kv("Method", details.method)
          ctx.ui.kv("Source", details.source)
          if (details.command) ctx.ui.kv("Command", details.command)
          if (details.scriptUrl) ctx.ui.kv("Script", details.scriptUrl)
          if (details.scriptSha256) ctx.ui.kv("SHA-256", details.scriptSha256)
          for (const warning of details.warnings ?? []) ctx.ui.warn(warning)
          // Single consent: the plan screen already obtained it. Displaying the
          // route details is not another question.
          return true
        },
      }
      const result = await upgradeSpicetify(
        cancelAwareRuntime(ctx.runtime, ctx.cancel),
        ctx.detection.spicetify,
        options,
      )
      if (result.cancelled) throw new OperationCancelled("upgrade-spicetify", "Spicetify upgrade cancelled")
      if (result.code !== 0 || result.timedOut) {
        throw new Error(result.error ?? (result.timedOut ? "Spicetify upgrade timed out; state is uncertain" : "Spicetify upgrade failed"))
      }
    },
  }
}

async function verifySpicetify(ctx: OperationContext): Promise<void> {
  const next = await detectEnvironment(ctx.runtime)
  ctx.detection = next
  if (!next.spicetify.available) throw new Error("Spicetify is no longer detected after the upgrade")
}

function updateModel(
  ctx: OperationContext,
  pluginInfo: ReturnType<typeof describePluginUpdate>,
  spicetifyStatus: ReturnType<typeof gateAvailability>,
  spicetifyTarget: string | null,
): UpdateViewModel {
  return createUpdateViewModel({
    detection: ctx.detection,
    versions: {
      ...ctx.versions,
      // The screen must report the achievable owner-safe target, not a newer
      // registry tag that no owner-safe route can install.
      spicetify: { ...ctx.versions.spicetify, latest: spicetifyTarget },
    },
    pluginUpdate: pluginInfo,
    spicetifyStatus,
    // The verified-release marker/routing was retired with the official
    // installer pipeline (B05); never present a verified-zip path here.
    verifiedSpicetifyInstall: false,
  })
}

/**
 * Show the owner-specific guidance. The C17 official-installer line still
 * mentions `spicetify upgrade`; B05 retired that self-updater, so the official
 * branch is rendered with the owner-safe pipeline description instead.
 */
function renderOwnerGuidance(ctx: OperationContext): void {
  const owner = ctx.detection.spicetify.owner
  const guidance = spicetifyUpdateGuidance(owner, { verifiedInstall: false })
  if (guidance.category === "official") {
    renderSpicetifyGuidance(ctx.ui, {
      ...guidance,
      method: spicetifyUpdateDescription(owner),
      command: null,
      lines: [
        "This installation is owned by the official Spicetify installer.",
        "Update it through the official installer pipeline only; do not also run winget, Scoop or Chocolatey against it.",
        ...guidance.lines.filter((line) => line.startsWith("Docs:")),
      ],
      warning: undefined,
    })
    return
  }
  renderSpicetifyGuidance(ctx.ui, guidance)
}

/**
 * Render the plan once, collect a single consent, then execute through the
 * shared runner. With a structured reporter the plan is delivered as a `plan`
 * event carrying the real step descriptions; without one the C17 screen renders
 * it exactly once (no duplicate plan output).
 *
 * Cancel/dry-run/confirmation wording is taken from the shared PLAN_MESSAGES
 * (via plan.ts) so update.ts and plan.ts cannot drift.
 */
async function presentAndRunPlan(ctx: OperationContext, title: string, steps: PlanStep[]): Promise<number> {
  if (ctx.cancel.requested) {
    ctx.cancel.settle("cancelled")
    ctx.ui.warn(PLAN_MESSAGES.cancelled)
    return 130
  }
  const plan = toUpdatePlan(title, steps)
  if (!planReporter(ctx)) renderUpdatePlan(ctx.ui, plan)
  announcePlan(ctx, title, steps, { render: false })
  if (!steps.length) {
    ctx.ui.status("info", PLAN_MESSAGES.nothingToDo)
    return 0
  }
  const consent = await confirmUpdatePlan(ctx.prompt, plan, {
    yes: ctx.options.yes,
    nonInteractive: ctx.options.nonInteractive,
    dryRun: ctx.options.dryRun,
  })
  if (consent === "dry-run") return planExitCode(planSkipOutcome(ctx, steps, "dry-run"))
  if (consent === "confirmation-required") return planExitCode(planSkipOutcome(ctx, steps, "confirmation-required"))
  if (consent === "declined") return planExitCode(planSkipOutcome(ctx, steps, "cancelled"))
  return planExitCode(await runPlanSteps(steps, ctx, { announce: false }))
}

function bridgeSyncStep(ctx: OperationContext, reason: string): PlanStep {
  const reuseCredentials = ctx.detection.bridge.credentialValid
  return {
    id: "sync-bridge",
    description: `${reason} (${reuseCredentials ? "credentials reused" : "missing/invalid credentials regenerated"})`,
    mutates: true,
    interrupt: "protected",
    run: async () => {
      const result = await bridgeOperation(cancelAwareRuntime(ctx.runtime, ctx.cancel), reuseCredentials ? "repair" : "install", {
        spicetifyPath: ctx.detection.spicetify.path,
        dryRun: false,
        yes: true,
      })
      if (result.cancelled) throw new OperationCancelled("sync-bridge", "Bridge synchronization cancelled")
      if (result.code !== 0) throw new Error(result.error ?? "Bridge synchronization failed")
    },
  }
}

/**
 * The running installer binary as an update target. The binary itself is a
 * newer release the user explicitly invoked (e.g. via npx): when it is
 * strictly newer than the registered plugin it is selectable as an update
 * target alongside the registry target (max wins). Channel-compatible pairs
 * (beta installs, or a stable installer for a stable install) always qualify;
 * a stable install never auto-migrates to a prerelease channel unless the
 * user explicitly ran that newer prerelease binary, in which case the
 * invocation itself is the channel choice. Never a downgrade or reinstall.
 */
export function installerUpdateTarget(
  installed: string | null,
  installerVersion: string | null | undefined,
  registryTarget: string | null,
): string | null {
  const installer = (installerVersion ?? "").trim()
  if (!installed || !installer) return null
  if (compareVersions(installer, installed) !== 1) return null
  const channelCompatible = /-/.test(installed) || !/-/.test(installer)
  if (channelCompatible) return installer
  if (!registryTarget || compareVersions(installer, registryTarget) === 1) return installer
  return null
}

/**
 * The update (optionally with an owner-safe Spicetify CLI upgrade first)
 * and its owned bridge. Never downgrades, never replaces a local development
 * plugin, and never lets an update switch channels.
 */
export async function runUpdate(ctx: OperationContext, choice: UpdateChoice = "auto"): Promise<number> {
  const { ui, detection } = ctx
  if (ctx.cancel.requested) {
    ctx.cancel.settle("cancelled")
    ui.warn(PLAN_MESSAGES.cancelled)
    return 130
  }
  if (!detection.windows) {
    ui.error("Updates are supported on Windows only. No changes were made.")
    return 1
  }
  if (detection.opencode.plugin.local) {
    ui.error("The registered plugin is a local development path. Run `opencode-spotify setup` to switch deliberately; updates never replace it.")
    return 1
  }
  const installed = detection.opencode.plugin.version
  const latestStable = ctx.versions.plugin.latest
  const latestBeta = ctx.versions.plugin.latestBeta ?? null
  if (detection.opencode.plugin.state === "unknown") {
    ui.error(`Plugin registration state is unknown (inspection failed: ${detection.opencode.plugin.detail ?? "plugin list did not complete"}). Rerun \`opencode-spotify doctor\`; no changes were made.`)
    return 1
  }
  if (!installed) {
    ui.error("The plugin is not registered globally. Run `opencode-spotify setup` first.")
    return 1
  }

  // Channel-aware comparison via the single source of truth. Never advertises
  // an older registry tag as an update; never downgrades; never labels a
  // prerelease stable. Stable stays on stable; beta sees newer beta or stable.
  // The running installer binary is itself a newer release the user invoked:
  // max(registryTarget, installerVersion) is selectable when strictly newer.
  let pluginInfo = describePluginUpdate(installed, latestStable, latestBeta)
  let latest = pluginInfo.target
  const installerTarget = installerUpdateTarget(installed, ctx.installerVersion, latest)
  if (installerTarget && (!latest || compareVersions(installerTarget, latest) === 1)) {
    latest = installerTarget
    pluginInfo = { ...pluginInfo, status: "update-available", target: latest }
  }
  if (!latest) {
    if (pluginInfo.status === "unknown" || (!latestStable && !latestBeta)) {
      ui.error(`No published version could be determined${ctx.versions.plugin.error ? `: ${ctx.versions.plugin.error}` : "."}`)
      ui.warn("Use `--offline` only for diagnostics. Retry when the npm registry is reachable.")
      return 1
    }
    if (pluginInfo.status === "registry-older") {
      const older = [latestStable, latestBeta].filter((value): value is string => !!value).join(", ")
      ui.error(`The registry reports ${older}, which is older than installed ${installed}. Downgrades are never automatic.`)
      return 1
    }
  }

  const pluginOutdated = latest !== null
  const spicetifyInstalled = detection.spicetify.version
  // Achievable target + owner. A non-stable/unavailable published version is
  // never treated as an update, and never reported as "current".
  const spicetifyGate = spicetifyUpdateGate({
    installed: spicetifyInstalled,
    owner: detection.spicetify.owner,
    latest: ctx.versions.spicetify.latest,
  })
  const spicetifyStatus = gateAvailability(spicetifyGate.status)
  const spicetifyOutdated = spicetifyGate.status === "outdated"
  const brokenBeta2 = isBrokenBeta2(installed)

  // An explicitly requested combined update always requires pre-authorization;
  // never ask for it after the Spicetify plan was already shown.
  if (choice === "both" && !ctx.options.allowSpicetifyUpgrade) {
    ui.error("A combined update requires explicit --allow-spicetify-upgrade authorization.")
    return 1
  }

  // C17 update screen: installed versions and backend channel verdicts only.
  const model = updateModel(ctx, pluginInfo, spicetifyStatus, spicetifyGate.achievable)
  renderUpdateScreen(ui, model, {
    allowSpicetifyUpgrade: ctx.options.allowSpicetifyUpgrade,
    offline: ctx.options.offline,
  })
  if (spicetifyOutdated) renderOwnerGuidance(ctx)

  // ---- explicit selection or conservative auto-selection -------------------
  let pluginSelected = choice === "both" || choice === "plugin"
  let spicetifySelected = choice === "both" || choice === "spicetify"
  if (choice === "auto") {
    const canPrompt = !ctx.options.nonInteractive && !ctx.options.dryRun
    if (pluginOutdated && spicetifyOutdated) {
      if (canPrompt) {
        const selected = await promptUpdateSelection(ui, ctx.prompt, model, {
          allowSpicetifyUpgrade: ctx.options.allowSpicetifyUpgrade,
        })
        if (selected === "cancel") {
          ui.warn("Cancelled. Nothing was changed.")
          return 130
        }
        pluginSelected = selected === "both" || selected === "plugin"
        spicetifySelected = selected === "both" || selected === "spicetify"
        // Choosing a combined/Spicetify update in the screen IS the explicit
        // interactive authorization; persist it for the plan and mutations.
        if (spicetifySelected) ctx.options.allowSpicetifyUpgrade = true
      } else {
        // Noninteractive/dry-run: --allow-spicetify-upgrade is the explicit
        // combined authorization. Without it only the plugin moves.
        pluginSelected = true
        spicetifySelected = ctx.options.allowSpicetifyUpgrade
      }
    } else if (spicetifyOutdated && !pluginOutdated) {
      // A Spicetify-only update still needs an explicit decision; never
      // upgrade a manager/CLI silently because the plugin happens to be current.
      if (!canPrompt) {
        pluginSelected = false
        spicetifySelected = ctx.options.allowSpicetifyUpgrade
      } else {
        const selected = await promptUpdateSelection(ui, ctx.prompt, model, {
          allowSpicetifyUpgrade: ctx.options.allowSpicetifyUpgrade,
        })
        if (selected === "cancel") {
          ui.warn("Cancelled. Nothing was changed.")
          return 130
        }
        pluginSelected = false
        spicetifySelected = selected === "spicetify" || selected === "both"
        if (spicetifySelected) ctx.options.allowSpicetifyUpgrade = true
      }
    } else {
      pluginSelected = pluginOutdated
      spicetifySelected = false
    }
  }

  if (ctx.cancel.requested) {
    ctx.cancel.settle("cancelled")
    ui.warn(PLAN_MESSAGES.cancelled)
    return 130
  }

  // ---- Spicetify eligibility ----------------------------------------------
  const spicetifyOnly = spicetifySelected && !pluginSelected
  if (spicetifySelected && !spicetifyOutdated) {
    if (spicetifyGate.status === "current") {
      // Only a real comparison may claim "current".
      ui.success(`Spicetify ${spicetifyInstalled ?? "unknown"} is current.`)
    } else if (spicetifyOnly) {
      // An explicitly requested Spicetify-only update cannot be honoured.
      ui.error(spicetifyGate.message ?? "A Spicetify update cannot be planned safely.")
      return 1
    } else {
      // A combined update must still update the plugin: skip Spicetify only.
      ui.warn(`Skipping the Spicetify update. ${spicetifyGate.message ?? "No owner-safe update target is available."}`)
    }
    spicetifySelected = false
  }

  if (spicetifySelected) {
    if (!spicetifyInstalled) {
      ui.error("Spicetify is not detected; run `opencode-spotify setup` instead.")
      return 1
    }
    if (spicetifyGate.method === "unsupported") {
      ui.error("The Spicetify installation owner is unknown. Refusing to update it: an owner-safe update cannot be selected and a second copy would be unsafe.")
      ui.bullet("Reinstall Spicetify once with a supported owner (Winget, Scoop, Chocolatey, or the official installer), then retry.")
      return 1
    }
    if (!ctx.options.allowSpicetifyUpgrade) {
      if (ctx.options.nonInteractive) {
        ui.error("A Spicetify update requires explicit --allow-spicetify-upgrade authorization.")
        return 1
      }
      if (ctx.options.dryRun) {
        // Dry-run never prompts: show that it would need authorization.
        ui.line("  Spicetify upgrades need a separate confirmation (or --allow-spicetify-upgrade).")
        spicetifySelected = false
      } else {
        const confirmSpicetify = await ctx.prompt.confirm(
          `Spicetify is owned by ${detection.spicetify.owner}. Update it with ${spicetifyGate.method === "official" ? "the official pipeline" : `the ${spicetifyGate.method} manager`} (${spicetifyInstalled} -> ${spicetifyGate.target})?`,
          { defaultYes: false },
        )
        if (!confirmSpicetify) {
          ui.warn("Cancelled. Nothing was changed.")
          return 130
        }
        ctx.options.allowSpicetifyUpgrade = true
      }
    }
  }

  if (pluginSelected && !pluginOutdated) pluginSelected = false

  // A combined plan must have explicit authorization even if auto-selected.
  if (pluginSelected && spicetifySelected && !ctx.options.allowSpicetifyUpgrade) {
    ui.error("A combined update requires explicit --allow-spicetify-upgrade authorization.")
    return 1
  }

  // ---- spicetify-only path -------------------------------------------------
  if (spicetifySelected && !pluginSelected) {
    ui.section("Spicetify update (separate authorization)")
    const upgradeCode = await presentAndRunPlan(ctx, "Upgrade Spicetify CLI", [await spicetifyUpdateStep(ctx)])
    if (upgradeCode !== 0) return upgradeCode
    if (ctx.options.dryRun) return 0
    await verifySpicetify(ctx)

    const bridgeWasNeeded = bridgeNeedsRepair(ctx)
    if (bridgeWasNeeded) {
      const bridgeCode = await presentAndRunPlan(ctx, "Synchronize bridge", [bridgeSyncStep(ctx, "Synchronize the owned bridge extension after the Spicetify update")])
      if (bridgeCode !== 0) return bridgeCode
      const next = await detectEnvironment(ctx.runtime)
      ctx.detection = next
    }
    // A Spicetify upgrade always ends with an apply offer, even when the
    // bridge was already healthy: the new CLI build needs an apply to take
    // effect. maybeApplyBridge keeps the separate apply consent (interactive
    // prompt, or --apply --yes noninteractively).
    const applied = await maybeApplyBridge(ctx, ctx.detection.spicetify.path, true)
    if (applied.code !== 0) return applied.code
    renderUpdateSummary(ui, createUpdateSummary({
      plugin: { installed: ctx.detection.opencode.plugin.version ?? installed, target: null, changed: false },
      spicetify: {
        version: ctx.detection.spicetify.version ?? spicetifyInstalled,
        changed: true,
        owner: ctx.detection.spicetify.owner,
      },
      bridge: {
        synchronized: bridgeWasNeeded,
        applied: applied.applied,
        pending: !applied.applied,
      },
      nextSteps: ["Restart running OpenCode processes if the bridge was re-applied.", "Playback is not verified by this command."],
    }))
    return 0
  }

  // ---- combined Spicetify upgrade first ------------------------------------
  if (spicetifySelected) {
    ui.section("Spicetify update (separate authorization)")
    const code = await presentAndRunPlan(ctx, "Upgrade Spicetify CLI", [await spicetifyUpdateStep(ctx)])
    if (code !== 0) return code
    if (ctx.options.dryRun) return 0
    await verifySpicetify(ctx)
  }

  // ---- plugin + bridge plan ------------------------------------------------
  const steps: PlanStep[] = []
  if (pluginSelected) {
    const oldSpec = pluginSpec(ctx)
    const target = registrationSpec(ctx, latest)
    steps.push({
      id: "update-global-registration",
      description: `Replace the global registration ${oldSpec ?? installed} with ${target}`,
      mutates: true,
      interrupt: "protected",
      run: async () => {
        const runtime = cancelAwareRuntime(ctx.runtime, ctx.cancel)
        if (oldSpec && specVersion(oldSpec)) {
          const removed = await removeGlobalPlugin(runtime, oldSpec)
          if (removed.cancelled) throw new OperationCancelled("update-global-registration", "Registration update cancelled")
          if (removed.code !== 0) throw new Error(removed.error ?? "opencode plugin remove failed")
          const added = await addGlobalPlugin(runtime, target, { log: (line) => ctx.ui.line(`  ${line}`) })
          if (added.code !== 0) {
            // A failed/timed-out add may have completed server-side: reconcile
            // before any rollback so a good new registration is never replaced.
            const reconciled = await reconcileRegistration(runtime)
            if (reconciled.state === "registered") {
              ctx.ui.warn(`Registration reported failure but is now listed; keeping it and skipping rollback. Detail: ${added.error ?? "unknown error"}`)
            } else if (reconciled.state === "unknown") {
              throw new Error(`${added.error ?? "opencode plugin add failed"} (verification also failed: ${reconciled.detail ?? "plugin list did not complete"}; state is unknown, rollback skipped)`)
            } else {
              // Verified absent only: best-effort rollback to the known-good spec.
              const rolledBack = await addGlobalPlugin(runtime, oldSpec).catch(() => undefined)
              if (!rolledBack || rolledBack.code !== 0) throw new Error(`${added.error ?? "opencode plugin add failed"} (rollback also failed: ${rolledBack?.error ?? "unknown error"})`)
              throw new Error(added.error ?? "opencode plugin add failed; the previous registration was restored")
            }
          }
        } else {
          const updated = await updateGlobalPlugin(runtime, oldSpec ?? "opencode-spotify")
          if (updated.cancelled) throw new OperationCancelled("update-global-registration", "Registration update cancelled")
          if (updated.code !== 0) throw new Error(updated.error ?? "opencode plugin update failed")
        }
      },
    })
  }

  // Sync the bridge when the plugin moves, when it is broken/missing, or for
  // the known broken beta.2 (which can inspect as current yet fail at runtime).
  const bridgeBefore = bridgeNeedsRepair(ctx)
  const bridgeSyncNeeded = bridgeBefore || pluginSelected || brokenBeta2
  if (bridgeSyncNeeded) {
    const reason = brokenBeta2 && !pluginSelected && !bridgeBefore
      ? "Re-provision the known-broken beta.2 owned bridge (recovery)"
      : pluginSelected
        ? "Synchronize the owned bridge to the selected plugin version"
        : "Repair the owned bridge extension and registration"
    steps.push(bridgeSyncStep(ctx, reason))
  }

  if (!steps.length) {
    ui.success("No supported update is available.")
    return 0
  }

  const code = await presentAndRunPlan(ctx, "Update plan", steps)
  if (code !== 0) {
    if (spicetifySelected) {
      ui.warn("Completed before this plan: Spicetify CLI update. It is left in place; rerun update to continue with the plugin.")
    }
    return code
  }
  if (ctx.options.dryRun) return 0

  const next = await detectEnvironment(ctx.runtime)
  ctx.detection = next
  if (pluginSelected && latest && !(await verifyVersion(ctx, latest))) {
    ui.error("The plugin registration did not verify at the requested version. Run `opencode-spotify doctor`.")
    return 1
  }
  if (bridgeSyncNeeded && (!next.bridge.installed || next.bridge.registration !== "current")) {
    ui.error("The bridge is not synchronized after the update. Run `opencode-spotify repair`.")
    return 1
  }
  const applied = await maybeApplyBridge(ctx, next.spicetify.path, bridgeSyncNeeded)
  if (applied.code !== 0) return applied.code
  renderUpdateSummary(ui, createUpdateSummary({
    plugin: {
      installed: next.opencode.plugin.version ?? installed,
      target: latest,
      changed: pluginSelected,
      verified: pluginSelected,
    },
    spicetify: {
      version: next.spicetify.version ?? spicetifyInstalled,
      changed: spicetifySelected,
      owner: next.spicetify.owner,
    },
    bridge: {
      synchronized: bridgeSyncNeeded,
      applied: applied.applied,
      pending: bridgeSyncNeeded && !applied.applied,
    },
  }))
  return 0
}

/** Apply a prepared bridge and report pending apply consistently. */
export async function applyOnly(ctx: OperationContext): Promise<number> {
  const result = await applyBridgeCompat(ctx)
  if (result.code !== 0) {
    ctx.ui.error(`spicetify apply failed${result.error ? `: ${result.error}` : "."}`)
    return 1
  }
  ctx.ui.success("Spicetify changes applied.")
  return 0
}

async function applyBridgeCompat(ctx: OperationContext) {
  const { applyBridge } = await import("./bridge.ts")
  return applyBridge(cancelAwareRuntime(ctx.runtime, ctx.cancel), {
    spicetifyPath: ctx.detection.spicetify.path,
    // B06: apply progress goes to the structured reporter when attached,
    // with the legacy two-space Ui line otherwise.
    onProgress: (line) => reportProgressLine(ctx, "apply", line),
  })
}

// Keep the imported SpicetifyInfo type referenced for API compatibility with
// callers that re-export this module's types during the B05 transition.
export type { SpicetifyInfo }
