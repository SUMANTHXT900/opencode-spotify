import { detectEnvironment } from "./detect.ts"
import { addGlobalPlugin, projectPlugins, reconcileRegistration, removeGlobalPlugin } from "./opencode.ts"
import { installSpicetify, refreshWingetSource, wingetLatestVersion } from "./spicetify.ts"
import { bridgeOperation } from "./bridge.ts"
import { compareVersions, MIN_OPENCODE } from "./compat.ts"
import { selectPluginTarget } from "./update-plan.ts"
import { executePlan, isSpotifyPluginId, maybeApplyBridge, planExitCode } from "./plan.ts"
import { runRepair } from "./repair.ts"
import { runStatus } from "./status.ts"
import { runUpdate } from "./update.ts"
import type { Detection, OperationContext, PlanStep } from "./types.ts"

const OPENCODE_URL = "https://opencode.ai/docs"
const SPOTIFY_URL = "https://www.spotify.com/download/windows/"
const SPICETIFY_DOCS = "https://spicetify.app/docs/getting-started"

export function manualSpicetifyInstructions(ui: OperationContext["ui"]): void {
  ui.line("  Install Spicetify manually, then re-run setup:")
  ui.line(`   - Docs: ${SPICETIFY_DOCS}`)
  ui.line("   - winget: winget install --id Spicetify.Spicetify -e")
  ui.line("   - Official PowerShell installer (read before running):")
  ui.line("     iwr -useb https://raw.githubusercontent.com/spicetify/cli/main/install.ps1 | iex")
  ui.line("   - Scoop: scoop install spicetify-cli")
  ui.line("   - Chocolatey: choco install spicetify-cli")
  ui.line("  Do not run two package managers against the same Spicetify installation.")
}

function refresh(ctx: OperationContext, next: Detection): void {
  ctx.detection = next
}

async function retryPrerequisite(
  ctx: OperationContext,
  present: (detection: Detection) => boolean,
  label: string,
): Promise<boolean> {
  if (ctx.options.nonInteractive) return false
  while (true) {
    const action = await ctx.prompt.choose(`Still waiting for ${label}.`, [
      { label: "Recheck now", value: "recheck" },
      { label: "Exit setup", value: "exit" },
    ])
    if (!action || action === "exit") return false
    refresh(ctx, await detectEnvironment(ctx.runtime))
    if (present(ctx.detection)) return true
    ctx.ui.warn(`${label} was not detected.`)
  }
}

export async function ensureSpicetify(ctx: OperationContext): Promise<"ready" | "declined" | "failed"> {
  if (ctx.detection.spicetify.available) return "ready"
  const { ui, options } = ctx
  ui.section("Spicetify is required")
  ui.line("  Spicetify is the supported integration layer for Spotify Desktop.")
  let mode = options.spicetify
  if (mode === "ask") {
    if (options.nonInteractive) {
      ui.error("Spicetify is not installed. Re-run noninteractive setup with --spicetify=auto --yes, --spicetify=manual, or --spicetify=skip.")
      return "failed"
    }
    const selected = await ctx.prompt.choose("How do you want to handle Spicetify?", [
      { label: "Install Spicetify automatically with winget (pinned official package)", value: "auto" },
      { label: "I will install Spicetify manually", value: "manual" },
      { label: "Exit setup without changing anything", value: "skip" },
    ])
    if (!selected) return "declined"
    mode = selected as typeof mode
  }
  if (mode === "skip") {
    ui.line("  Exited without installing Spicetify or changing anything.")
    return "declined"
  }
  if (mode === "manual") {
    manualSpicetifyInstructions(ui)
    if (options.nonInteractive) return "failed"
    const ready = await retryPrerequisite(ctx, (detection) => detection.spicetify.available, "Spicetify")
    return ready ? "ready" : "declined"
  }

  // Automatic installation. Dry-run only reports the plan.
  // B14–B18: refresh the Winget source, resolve the trusted package version,
  // and compare with upstream so a lagging Winget feed is visible.
  if (!options.dryRun) {
    ui.line("  Refreshing Winget source metadata (best-effort, no installation)...")
    const refreshed = await refreshWingetSource(ctx.runtime)
    if (refreshed.code !== 0) {
      ui.warn(`Winget source refresh failed; continuing with cached metadata${refreshed.error ? `: ${refreshed.error}` : "."}`)
    }
  }
  const wingetVersion = await wingetLatestVersion(ctx.runtime).catch(() => null)
  const upstreamVersion = ctx.versions.spicetify.latest
  const drift = wingetVersion && upstreamVersion ? compareVersions(wingetVersion, upstreamVersion) : null
  if (drift !== null && drift !== 0) {
    ui.warn(`Version note: Winget offers Spicetify ${wingetVersion} while upstream reports ${upstreamVersion}. Proceeding with the trusted Winget package; rerun update after the feed catches up.`)
  } else if (wingetVersion) {
    ui.line(`  Trusted Spicetify version available via Winget: ${wingetVersion}.`)
  }
  const result = await installSpicetify(ctx.runtime, ctx.detection.spicetify, {
    dryRun: options.dryRun,
    log: { out: (line) => ui.line(`  ${line}`), err: (line) => ctx.log.err(line) },
    approve: async (details) => {
      ui.section("Spicetify installation plan")
      ui.kv("Method", details.method)
      ui.kv("Source", details.source)
      ui.line(`  Command: ${details.command}`)
      if (options.dryRun) return false
      if (options.nonInteractive) return options.yes
      return ctx.prompt.confirm("Install Spicetify using this method?", { defaultYes: false })
    },
  })
  if (options.dryRun) {
    ui.line(`  ${result.stdout}`)
    return "failed"
  }
  if (result.code !== 0) {
    ui.error(`Automatic Spicetify installation failed${result.error ? `: ${result.error}` : "."}`)
    manualSpicetifyInstructions(ui)
    return "failed"
  }
  refresh(ctx, await detectEnvironment(ctx.runtime))
  if (!ctx.detection.spicetify.available) {
    ui.warn("Spicetify was installed but is not visible yet. A new terminal may be required for PATH changes.")
    if (options.nonInteractive) return "failed"
    const ready = await retryPrerequisite(ctx, (detection) => detection.spicetify.available, "Spicetify")
    return ready ? "ready" : "failed"
  }
  // Verify the installed version and surface Winget-vs-upstream drift.
  const installed = ctx.detection.spicetify.version
  if (installed) {
    ui.success(`Spicetify ${installed} detected.`)
    const installedDrift = upstreamVersion ? compareVersions(installed, upstreamVersion) : null
    if (installedDrift !== null && installedDrift !== 0) {
      ui.warn(`Installed Spicetify ${installed} differs from upstream ${upstreamVersion}; the Winget feed may lag. No unsigned scripts are used; rerun update later or install manually from ${SPICETIFY_DOCS}.`)
    }
  } else {
    ui.success(`Spicetify detected.`)
  }
  return "ready"
}

function registrationStep(ctx: OperationContext, spec: string | null): PlanStep {
  const target = spec ?? (ctx.options.packageSpec ?? `opencode-spotify@${ctx.installerVersion}`)
  return {
    id: "register-global-plugin",
    description: `Register ${target} in the global OpenCode configuration (native opencode plugin add)`,
    mutates: true,
    run: async () => {
      ctx.ui.line(`  Running: opencode plugin add ${target} (up to 90s; progress shown after completion)`)
      const result = await addGlobalPlugin(ctx.runtime, target, { log: (line) => ctx.ui.line(`  ${line}`) })
      if (result.code === 0) return
      // B01: a failed or timed-out mutation may have completed server-side.
      // Reconcile the observed state before deciding success/failure.
      const reconciled = await reconcileRegistration(ctx.runtime)
      if (reconciled.state === "registered") {
        const detail = result.timedOut
          ? `the registration command timed out but ${reconciled.match?.version ?? "the plugin"} is now listed; treating as recovered`
          : `the registration command reported failure but the plugin is now listed; treating as recovered`
        ctx.ui.warn(`${detail}. Detail: ${result.error ?? "unknown error"}`)
        return
      }
      if (reconciled.state === "unknown") {
        throw new Error(`${result.error ?? "opencode plugin add failed"} (verification also failed: ${reconciled.detail ?? "plugin list did not complete"}; state is unknown, not proven absent)`)
      }
      throw new Error(result.timedOut
        ? `opencode plugin add timed out and the plugin is still absent; rerun setup to retry (no blind retry was attempted). Detail: ${result.error ?? "timeout"}`
        : (result.error ?? "opencode plugin add failed"))
    },
  }
}

function bridgeStep(ctx: OperationContext, operation: "install" | "repair"): PlanStep {
  return {
    id: `bridge-${operation}`,
    description: `${operation === "install" ? "Install" : "Repair"} the owned Spicetify bridge extension (credentials reused unless explicitly rotated)`,
    mutates: true,
    run: async () => {
      const result = await bridgeOperation(ctx.runtime, operation, {
        spicetifyPath: ctx.detection.spicetify.path,
        dryRun: false,
        yes: true,
      })
      if (result.code !== 0) throw new Error(result.error ?? `Bridge ${operation} failed`)
    },
  }
}

function printPrerequisiteSummary(ctx: OperationContext): void {
  // B06: compact, useful summary. No secrets, no verbosity, no slowness.
  const d = ctx.detection
  ctx.ui.section("Environment")
  ctx.ui.kv("Windows", d.windows ? `${d.windowsVersion} ${d.arch}` : "unsupported (no changes will be made)")
  ctx.ui.kv("Node.js", d.node)
  ctx.ui.kv("OpenCode", d.opencode.available ? `${d.opencode.version ?? "version unknown"} (${d.compatibility.opencode})` : "not found")
  ctx.ui.kv("Spotify", d.spotify.installed ? (d.spotify.store ? "Store build detected" : "desktop detected") : "not detected")
  ctx.ui.kv("Spicetify", d.spicetify.available ? `${d.spicetify.version ?? "version unknown"} (${d.spicetify.owner})` : "not installed")
  const pluginSummary = d.opencode.plugin.state === "unknown"
    ? "unknown (inspection failed)"
    : d.opencode.plugin.registered
      ? `${d.opencode.plugin.version ?? "unknown"}${d.opencode.plugin.local ? " (local)" : ""}`
      : "not registered"
  ctx.ui.kv("Plugin", pluginSummary)
  ctx.ui.kv("Bridge", d.compatibility.bridge)
  const pluginUpdate = ctx.versions.plugin.latest ?? ctx.versions.plugin.latestBeta
  if (pluginUpdate) ctx.ui.kv("Update", `plugin ${pluginUpdate} available`)
  else if (ctx.versions.spicetify.latest) ctx.ui.kv("Update", `Spicetify ${ctx.versions.spicetify.latest} available`)
}

function printFinal(ctx: OperationContext, applied: boolean): void {
  ctx.ui.section("Setup summary")
  ctx.ui.kv("Global plugin", ctx.options.packageSpec ?? `opencode-spotify@${ctx.installerVersion}`)
  ctx.ui.kv("Bridge", applied ? "prepared and applied" : "prepared; apply pending")
  ctx.ui.kv("Playback", "not verified by the installer")
  ctx.ui.line("")
  if (!applied) {
    ctx.ui.warn("Spicetify apply is still pending. Run `spicetify apply` yourself, or re-run setup with --apply.")
  }
  ctx.ui.bullet("Restart any running OpenCode process so the global plugin loads.")
  ctx.ui.bullet("Start Spotify Desktop, then open OpenCode in any project and wait for `Spotify ● Connected`.")
  ctx.ui.bullet("Connection and playback are confirmed only in the running TUI, not by file installation.")
}

async function maintenance(ctx: OperationContext): Promise<number> {
  const { ui, detection } = ctx
  ui.section("Existing installation detected")
  const plugin = ctx.versions.plugin
  const spicetify = ctx.versions.spicetify
  const pluginTarget = selectPluginTarget(detection.opencode.plugin.version, plugin.latest, plugin.latestBeta ?? null)
  const pluginOutdated = pluginTarget !== null
  const spicetifyOutdated = compareVersions(spicetify.latest, spicetify.installed) === 1
  ui.kv("OpenCode Spotify", pluginTarget
    ? `${detection.opencode.plugin.version ?? "unknown"} -> ${pluginTarget}`
    : `${detection.opencode.plugin.version ?? "unknown"} (current${plugin.latestBeta && plugin.latestBeta !== plugin.latest ? `; beta ${plugin.latestBeta} available` : ""})`)
  ui.kv("Spicetify", `${detection.spicetify.version ?? "unknown"}${spicetify.latest ? ` -> ${spicetify.latest}` : ""}`)
  ui.kv("Bridge", detection.compatibility.bridge)
  if (detection.opencode.plugin.local) {
    ui.warn("The registered plugin is a local development path. Updates never replace it without an explicit choice.")
  }
  if (!pluginOutdated && !spicetifyOutdated && detection.bridge.registration === "current") {
    ui.success("Everything detected is current.")
  }
  if (ctx.options.nonInteractive) {
    ui.line("  Noninteractive maintenance mode makes no changes. Run `opencode-spotify update` or `opencode-spotify repair` explicitly.")
    return 0
  }
  const choices: { label: string; value: string }[] = []
  if (detection.opencode.plugin.local) choices.push({ label: "Switch this global registration to the published package", value: "switch" })
  // Unified update/repair experience: adapt to actual state, keep the bridge
  // synchronized, never mix package managers, never downgrade.
  if (pluginOutdated && spicetifyOutdated) choices.push({ label: "Update both OpenCode Spotify and Spicetify", value: "both" })
  if (pluginOutdated) choices.push({ label: "Update OpenCode Spotify only", value: "plugin" })
  if (spicetifyOutdated) choices.push({ label: "Update Spicetify only", value: "spicetify" })
  if (!detection.opencode.plugin.local) choices.push({ label: "Repair existing installation", value: "repair" })
  choices.push({ label: "Continue without updating", value: "continue" })
  choices.push({ label: "Exit", value: "exit" })
  const choice = await ctx.prompt.choose("What would you like to do?", choices)
  if (!choice || choice === "exit") return 0
  if (choice === "continue") {
    await runStatus(ctx)
    ctx.ui.line("  No changes were made.")
    return 0
  }
  if (choice === "repair") return runRepair(ctx)
  if (choice === "switch") {
    const spec = detection.opencode.plugin.spec
    const steps: PlanStep[] = []
    if (spec) {
      steps.push({ id: "remove-local", description: `Remove the local development registration ${spec}`, mutates: true,
        run: async () => {
          const result = await removeGlobalPlugin(ctx.runtime, spec)
          if (result.code !== 0) throw new Error(result.error ?? "opencode plugin remove failed")
        } })
    }
    steps.push(registrationStep(ctx, null))
    if (detection.bridge.registration !== "current") steps.push(bridgeStep(ctx, "install"))
    const outcome = await executePlan(ctx, "Switch to the published package", steps)
    const code = planExitCode(outcome)
    if (code !== 0) return code
    return (await maybeApplyBridge(ctx, detection.spicetify.path, detection.bridge.registration !== "current")).code
  }
  if (choice === "both") ctx.options.allowSpicetifyUpgrade = true
  if (choice === "spicetify") ctx.options.allowSpicetifyUpgrade = true
  return runUpdate(ctx, choice === "both" ? "both" : choice === "spicetify" ? "spicetify" : "plugin")
}

/**
 * Intelligent setup. Plan cancellation runs no further steps in that plan;
 * earlier separately-approved prerequisite installs (for example Spicetify)
 * are reported, not rolled back, because external package-manager operations
 * cannot be reliably reversed.
 */
export async function runSetup(ctx: OperationContext): Promise<number> {
  const { ui } = ctx
  printPrerequisiteSummary(ctx)
  if (!ctx.detection.windows) {
    ui.error("V0.6.0 supports Windows only. No changes were made.")
    return 1
  }
  if (!ctx.detection.opencode.available) {
    ui.section("OpenCode is required")
    ui.line(`  Install OpenCode ${MIN_OPENCODE} or newer: ${OPENCODE_URL}`)
    const ready = await retryPrerequisite(ctx, (detection) => detection.opencode.available, "OpenCode")
    if (!ready) return 1
  }
  if (!ctx.detection.opencode.nativeCommands) {
    ui.error(`This OpenCode version lacks native plugin management (\`opencode plugin add\`). Requires OpenCode ${MIN_OPENCODE} or newer; no changes were made. Upgrade OpenCode first.`)
    return 1
  }
  if (!ctx.detection.spotify.installed) {
    ui.section("Spotify Desktop is required")
    ui.line(`  Install Spotify Desktop for Windows: ${SPOTIFY_URL}`)
    if (ctx.detection.spotify.store) ui.warn("A Store build was detected earlier; it may require Spicetify to be re-applied after restarts.")
    const ready = await retryPrerequisite(ctx, (detection) => detection.spotify.installed, "Spotify Desktop")
    if (!ready) return 1
  }
  if (ctx.options.dryRun) {
    ui.section("Dry-run installation plan")
    let step = 1
    if (!ctx.detection.spicetify.available) ui.line(`  ${step++}. Install Spicetify (automatic or manual, separately confirmed).`)
    ui.line(`  ${step++}. Register the published package in the global OpenCode configuration.`)
    ui.line(`  ${step++}. Install or repair the bridge extension with a per-installation credential.`)
    ui.line(`  ${step}. Leave \`spicetify apply\` pending for separate authorization.`)
    ui.line("  No files, configuration, registrations, or Spotify state were changed.")
    return 0
  }
  const spicetifyWasMissing = !ctx.detection.spicetify.available
  const spicetify = await ensureSpicetify(ctx)
  if (spicetify !== "ready") return spicetify === "declined" ? 0 : 1

  const detection = ctx.detection
  if (detection.opencode.plugin.state === "unknown") {
    ui.error(`Global registration state is unknown (inspection failed: ${detection.opencode.plugin.detail ?? "plugin list did not complete"}). Rerun \`opencode-spotify doctor\`; no changes were made and no blind retry was attempted.`)
    return 1
  }
  if (detection.opencode.plugin.registered && !detection.opencode.plugin.local) return maintenance(ctx)

  const localProject = (await projectPlugins(ctx.runtime)).find((entry) => isSpotifyPluginId(entry.id) && /[\\/]/.test(entry.source))
  if (localProject) {
    ui.warn(`This project also configures a local plugin at ${localProject.source}. The installer leaves project config untouched.`)
  }

  const steps: PlanStep[] = []
  if (detection.opencode.plugin.local) {
    const localSpec = detection.opencode.plugin.spec
    if (localSpec) {
      steps.push({ id: "remove-local", description: `Remove the existing local registration ${localSpec}`, mutates: true,
        run: async () => {
          const result = await removeGlobalPlugin(ctx.runtime, localSpec)
          if (result.code !== 0) throw new Error(result.error ?? "opencode plugin remove failed")
        } })
    }
    steps.push(registrationStep(ctx, null))
  } else if (!detection.opencode.plugin.registered) {
    steps.push(registrationStep(ctx, null))
  }
  const bridgeNeeded = !detection.bridge.installed || detection.bridge.registration !== "current"
  if (bridgeNeeded) steps.push(bridgeStep(ctx, detection.bridge.credentialValid ? "repair" : "install"))
  if (!steps.length) {
    ui.success("The installation is already complete and current.")
    printFinal(ctx, detection.bridge.registration === "current")
    return 0
  }
  const outcome = await executePlan(ctx, "Installation plan", steps)
  const code = planExitCode(outcome)
  if (code !== 0) {
    if (spicetifyWasMissing && ctx.detection.spicetify.available) {
      ui.warn("Completed before this plan: Spicetify installation. It is left in place; rerun setup to continue.")
    }
    return code
  }

  const verified = await detectEnvironment(ctx.runtime)
  refresh(ctx, verified)
  if (verified.opencode.plugin.state === "unknown") {
    ui.error(`Global registration state is unknown (inspection failed: ${verified.opencode.plugin.detail ?? "plugin list did not complete"}). Use \`opencode-spotify doctor\` for details; no blind retry was attempted.`)
    return 1
  }
  if (!verified.opencode.plugin.registered || verified.opencode.plugin.local) {
    ui.error("Global registration could not be verified. Use `opencode-spotify doctor` for details.")
    return 1
  }
  if (!verified.bridge.installed || verified.bridge.registration !== "current") {
    ui.error("The bridge could not be verified after installation. Use `opencode-spotify repair`.")
    return 1
  }
  const applied = await maybeApplyBridge(ctx, verified.spicetify.path, true)
  if (applied.code !== 0) return applied.code
  printFinal(ctx, applied.applied)
  return 0
}
