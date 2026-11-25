import { compareVersions } from "./compat.ts"
import { inspectOpenCode, addGlobalPlugin, reconcileRegistration, removeGlobalPlugin, updateGlobalPlugin } from "./opencode.ts"
import { detectEnvironment } from "./detect.ts"
import { bridgeOperation, applyBridge } from "./bridge.ts"
import { upgradeSpicetify } from "./spicetify.ts"
import { executePlan, maybeApplyBridge, planExitCode, registrationSpec, specVersion } from "./plan.ts"
import { selectPluginTarget } from "./update-plan.ts"
import type { OperationContext, PlanStep } from "./types.ts"

function pluginSpec(ctx: OperationContext): string | null {
  if (ctx.options.packageSpec) return ctx.options.packageSpec
  return ctx.detection.opencode.plugin.spec ?? (ctx.detection.opencode.plugin.registered ? "opencode-spotify" : null)
}

function bridgeNeedsRepair(ctx: OperationContext): boolean {
  return !ctx.detection.bridge.installed || ctx.detection.bridge.registration !== "current"
}

async function verifyVersion(ctx: OperationContext, expected: string): Promise<boolean> {
  const info = await inspectOpenCode(ctx.runtime)
  ctx.detection.opencode = info
  if (!info.plugin.registered || info.plugin.local) return false
  const compared = compareVersions(info.plugin.version, expected)
  return compared !== null && compared !== -1
}

async function spicetifyUpdateStep(ctx: OperationContext): Promise<PlanStep> {
  return {
    id: "upgrade-spicetify",
    description: `Upgrade Spicetify using its ${ctx.detection.spicetify.owner} installation method`,
    mutates: true,
    run: async () => {
      const result = await upgradeSpicetify(ctx.runtime, ctx.detection.spicetify, {
        dryRun: false,
        log: { out: (line) => ctx.ui.line(`  ${line}`), err: (line) => ctx.log.err(line) },
        approve: async () => true,
      })
      if (result.code !== 0) throw new Error(result.error ?? "Spicetify upgrade failed")
    },
  }
}

async function verifySpicetify(ctx: OperationContext): Promise<void> {
  const next = await detectEnvironment(ctx.runtime)
  ctx.detection = next
  if (!next.spicetify.available) throw new Error("Spicetify is no longer detected after the upgrade")
}

/**
 * Update the plugin (optionally with a Spicetify CLI upgrade first) and its
 * owned bridge. Never downgrades. Never replaces a local development plugin.
 */
export async function runUpdate(ctx: OperationContext, choice: "auto" | "plugin" | "both" | "spicetify" = "auto"): Promise<number> {
  const { ui, detection } = ctx
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
  const latest = selectPluginTarget(installed, latestStable, latestBeta)
  if (!latest) {
    if (!latestStable && !latestBeta) {
      ui.error(`No published version could be determined${ctx.versions.plugin.error ? `: ${ctx.versions.plugin.error}` : "."}`)
      ui.warn("Use `--offline` only for diagnostics. Retry when the npm registry is reachable.")
      return 1
    }
    if (installed && latestStable && compareVersions(latestStable, installed) === -1 &&
      (!latestBeta || compareVersions(latestBeta, installed) !== 1)) {
      ui.error(`The registry reports ${latestStable}, which is older than installed ${installed}. Downgrades are never automatic.`)
      return 1
    }
    if (installed && latestBeta && compareVersions(latestBeta, installed) === -1 &&
      (!latestStable || compareVersions(latestStable, installed) !== 1)) {
      ui.error(`The registry reports ${latestBeta}, which is older than installed ${installed}. Downgrades are never automatic.`)
      return 1
    }
    ui.success(`OpenCode Spotify ${installed} is current.`)
    if (!bridgeNeedsRepair(ctx)) return 0
    ui.warn("The bridge still needs repair; continuing with the repair step.")
  }
  const pluginOutdated = latest !== null
  const spicetifyInstalled = detection.spicetify.version
  const spicetifyLatest = ctx.versions.spicetify.latest
  const spicetifyOutdated = compareVersions(spicetifyLatest, spicetifyInstalled) === 1
  let combined = choice === "both" || (choice === "auto" && ctx.options.allowSpicetifyUpgrade && pluginOutdated && spicetifyOutdated)
  if (choice === "auto" && pluginOutdated && spicetifyOutdated && !ctx.options.nonInteractive && !combined) {
    const selected = await ctx.prompt.choose("Updates are available for OpenCode Spotify and Spicetify.", [
      { label: `Update OpenCode Spotify only (${installed} -> ${latest})`, value: "plugin" },
      { label: `Update OpenCode Spotify and Spicetify (${spicetifyInstalled} -> ${spicetifyLatest})`, value: "both" },
      { label: "Cancel without changing anything", value: "cancel" },
    ])
    if (!selected || selected === "cancel") {
      ui.warn("Cancelled. Nothing was changed.")
      return 130
    }
    if (selected === "both") {
      ctx.options.allowSpicetifyUpgrade = true
      combined = true
    }
  }
  if (combined && !ctx.options.allowSpicetifyUpgrade) {
    ui.error("A combined update requires explicit --allow-spicetify-upgrade authorization.")
    return 1
  }
  if (!pluginOutdated && !(combined && spicetifyOutdated)) {
    ui.success(`OpenCode Spotify ${installed} is current${spicetifyOutdated ? `; Spicetify ${spicetifyLatest} is available (plugin-only update requested)` : ""}.`)
    if (!bridgeNeedsRepair(ctx)) return 0
    ui.warn("The bridge still needs repair; continuing with the repair step.")
  }

  if (choice === "spicetify") {
    if (!spicetifyOutdated) {
      ui.success(`Spicetify ${spicetifyInstalled ?? "unknown"} is current.`)
      if (!bridgeNeedsRepair(ctx)) return 0
      ui.warn("The bridge still needs repair; continuing with the repair step.")
    } else {
      if (!spicetifyInstalled) {
        ui.error("Spicetify is not detected; run `opencode-spotify setup` instead.")
        return 1
      }
      if (!ctx.options.allowSpicetifyUpgrade && !ctx.options.nonInteractive) {
        const confirmSpicetify = await ctx.prompt.confirm(`Upgrade Spicetify ${spicetifyInstalled} -> ${spicetifyLatest}?`, { defaultYes: false })
        if (!confirmSpicetify) {
          ui.warn("Cancelled. Nothing was changed.")
          return 130
        }
        ctx.options.allowSpicetifyUpgrade = true
      }
      if (!ctx.options.allowSpicetifyUpgrade) {
        ui.error("A Spicetify upgrade requires explicit --allow-spicetify-upgrade authorization.")
        return 1
      }
      ui.section("Spicetify upgrade (separate authorization)")
      const upgrade = await executePlan(ctx, "Upgrade Spicetify CLI", [await spicetifyUpdateStep(ctx)])
      const upgradeCode = planExitCode(upgrade)
      if (upgradeCode !== 0) return upgradeCode
      await verifySpicetify(ctx)
    }
    const bridgeWasNeeded = bridgeNeedsRepair(ctx)
    if (bridgeWasNeeded) {
      const outcome = await executePlan(ctx, "Synchronize bridge", [{
        id: "sync-bridge",
        description: "Synchronize the owned bridge extension after the Spicetify upgrade (credentials reused)",
        mutates: true,
        run: async () => {
          const result = await bridgeOperation(ctx.runtime, ctx.detection.bridge.credentialValid ? "repair" : "install", {
            spicetifyPath: ctx.detection.spicetify.path,
            dryRun: false,
            yes: true,
          })
          if (result.code !== 0) throw new Error(result.error ?? "Bridge synchronization failed")
        },
      }])
      if (planExitCode(outcome) !== 0) return 1
      const next = await detectEnvironment(ctx.runtime)
      ctx.detection = next
    }
    const applied = await maybeApplyBridge(ctx, ctx.detection.spicetify.path, bridgeWasNeeded)
    if (applied.code !== 0) return applied.code
    ui.section("Update summary")
    ui.kv("Plugin", "unchanged")
    ui.kv("Bridge", applied.applied ? "synchronized and applied" : bridgeWasNeeded ? "synchronized; apply pending" : "already current")
    ui.kv("Spicetify", ctx.detection.spicetify.version ?? "updated")
    ui.bullet("Restart running OpenCode processes if the bridge was re-applied.")
    return 0
  }

  if (combined && spicetifyOutdated) {
    if (!spicetifyInstalled) {
      ui.error("Spicetify is not detected; run `opencode-spotify setup` instead of a combined update.")
      return 1
    }
    ui.section("Spicetify upgrade (separate authorization)")
    const upgrade = await executePlan(ctx, "Upgrade Spicetify CLI", [await spicetifyUpdateStep(ctx)])
    const code = planExitCode(upgrade)
    if (code !== 0) return code
    await verifySpicetify(ctx)
  }

  const steps: PlanStep[] = []
  if (pluginOutdated) {
    const oldSpec = pluginSpec(ctx)
    const target = registrationSpec(ctx, latest)
    steps.push({
      id: "update-global-registration",
      description: `Replace the global registration ${oldSpec ?? installed} with ${target}`,
      mutates: true,
      run: async () => {
        if (oldSpec && specVersion(oldSpec)) {
          const removed = await removeGlobalPlugin(ctx.runtime, oldSpec)
          if (removed.code !== 0) throw new Error(removed.error ?? "opencode plugin remove failed")
          const added = await addGlobalPlugin(ctx.runtime, target, { log: (line) => ctx.ui.line(`  ${line}`) })
          if (added.code !== 0) {
            // A failed/timed-out add may have completed server-side: reconcile
            // before any rollback so a good new registration is never replaced.
            const reconciled = await reconcileRegistration(ctx.runtime)
            if (reconciled.state === "registered") {
              ctx.ui.warn(`Registration reported failure but is now listed; keeping it and skipping rollback. Detail: ${added.error ?? "unknown error"}`)
            } else if (reconciled.state === "unknown") {
              throw new Error(`${added.error ?? "opencode plugin add failed"} (verification also failed: ${reconciled.detail ?? "plugin list did not complete"}; state is unknown, rollback skipped)`)
            } else {
              // Verified absent only: best-effort rollback to the known-good spec.
              const rolledBack = await addGlobalPlugin(ctx.runtime, oldSpec).catch(() => undefined)
              if (!rolledBack || rolledBack.code !== 0) throw new Error(`${added.error ?? "opencode plugin add failed"} (rollback also failed: ${rolledBack?.error ?? "unknown error"})`)
              throw new Error(added.error ?? "opencode plugin add failed; the previous registration was restored")
            }
          }
        } else {
          const updated = await updateGlobalPlugin(ctx.runtime, oldSpec ?? "opencode-spotify")
          if (updated.code !== 0) throw new Error(updated.error ?? "opencode plugin update failed")
        }
      },
    })
  }
  const bridgeBefore = bridgeNeedsRepair(ctx)
  if (bridgeBefore) {
    steps.push({
      id: "sync-bridge",
      description: "Synchronize the owned bridge extension with the updated plugin (credentials reused)",
      mutates: true,
      run: async () => {
        const result = await bridgeOperation(ctx.runtime, ctx.detection.bridge.credentialValid ? "repair" : "install", {
          spicetifyPath: ctx.detection.spicetify.path,
          dryRun: false,
          yes: true,
        })
        if (result.code !== 0) throw new Error(result.error ?? "Bridge synchronization failed")
      },
    })
  }
  if (!steps.length) {
    ui.success("No supported update is available.")
    return 0
  }
  const outcome = await executePlan(ctx, "Update plan", steps)
  if (outcome.status === "dry-run") return 0
  const code = planExitCode(outcome)
  if (code !== 0) {
    if (combined && spicetifyOutdated) {
      ui.warn("Completed before this plan: Spicetify CLI upgrade. It is left in place; rerun update to continue with the plugin.")
    }
    return code
  }

  const next = await detectEnvironment(ctx.runtime)
  ctx.detection = next
  if (pluginOutdated && latest && !(await verifyVersion(ctx, latest))) {
    ui.error("The plugin registration did not verify at the requested version. Run `opencode-spotify doctor`.")
    return 1
  }
  if (!next.bridge.installed || next.bridge.registration !== "current") {
    ui.error("The bridge is not synchronized after the update. Run `opencode-spotify repair`.")
    return 1
  }
  const applied = await maybeApplyBridge(ctx, next.spicetify.path, bridgeBefore)
  if (applied.code !== 0) return applied.code
  ui.section("Update summary")
  ui.kv("Plugin", next.opencode.plugin.version ?? latest ?? "unknown")
  ui.kv("Bridge", "synchronized")
  ui.kv("Spicetify", next.spicetify.version ?? "unchanged")
  ui.bullet("Restart running OpenCode processes to load the updated plugin.")
  ui.bullet("Playback is not verified by this command.")
  return 0
}

/** Apply a prepared bridge and report pending apply consistently. */
export async function applyOnly(ctx: OperationContext): Promise<number> {
  const result = await applyBridge(ctx.runtime, { spicetifyPath: ctx.detection.spicetify.path })
  if (result.code !== 0) {
    ctx.ui.error(`spicetify apply failed${result.error ? `: ${result.error}` : "."}`)
    return 1
  }
  ctx.ui.success("Spicetify changes applied.")
  return 0
}
