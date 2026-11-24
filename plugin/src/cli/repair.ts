import { addGlobalPlugin, removeGlobalPlugin } from "./opencode.ts"
import { bridgeOperation } from "./bridge.ts"
import { detectEnvironment } from "./detect.ts"
import { executePlan, maybeApplyBridge, planExitCode, registrationSpec } from "./plan.ts"
import type { OperationContext, PlanStep } from "./types.ts"

/**
 * Repair only owned state: the global registration and the bridge extension.
 * It never installs Spotify/Spicetify, never upgrades either, and never edits
 * project configuration.
 */
export async function runRepair(ctx: OperationContext): Promise<number> {
  const { ui, detection } = ctx
  if (!detection.windows) {
    ui.error("Repair is supported on Windows only. No changes were made.")
    return 1
  }
  if (!detection.opencode.available) {
    ui.error("OpenCode is not available; repair cannot verify a global registration.")
    return 1
  }
  if (!detection.opencode.nativeCommands) {
    ui.error("This OpenCode version lacks native plugin management. Upgrade OpenCode first.")
    return 1
  }
  const steps: PlanStep[] = []
  if (detection.opencode.plugin.registered && detection.opencode.plugin.local) {
    const spec = detection.opencode.plugin.spec
    if (spec) {
      steps.push({
        id: "remove-local-registration",
        description: `Remove the local development registration ${spec}`,
        mutates: true,
        run: async () => {
          const result = await removeGlobalPlugin(ctx.runtime, spec)
          if (result.code !== 0) throw new Error(result.error ?? "opencode plugin remove failed")
        },
      })
    }
  }
  if (!detection.opencode.plugin.registered || detection.opencode.plugin.local) {
    const spec = registrationSpec(ctx)
    steps.push({
      id: "register-global-plugin",
      description: `Register ${spec} globally`,
      mutates: true,
      run: async () => {
        const result = await addGlobalPlugin(ctx.runtime, spec, { log: (line) => ui.line(`  ${line}`) })
        if (result.code !== 0) throw new Error(result.error ?? "opencode plugin add failed")
      },
    })
  }
  const bridgeNeedsRepair = !detection.bridge.installed || detection.bridge.registration !== "current"
  if (bridgeNeedsRepair) {
    if (!detection.spicetify.available) {
      ui.error("Spicetify is not detected; run `opencode-spotify setup` first.")
      return 1
    }
    steps.push({
      id: "repair-bridge",
      description: "Repair the owned bridge extension and registration (credentials reused unless explicitly rotated)",
      mutates: true,
      run: async () => {
        const result = await bridgeOperation(ctx.runtime, detection.bridge.credentialValid ? "repair" : "install", {
          spicetifyPath: detection.spicetify.path,
          dryRun: false,
          yes: true,
        })
        if (result.code !== 0) throw new Error(result.error ?? "Bridge repair failed")
      },
    })
  }
  if (!steps.length) {
    ui.success("No owned registration or bridge repair is needed.")
    if (detection.bridge.registration === "current") {
      ui.line("  Run `opencode-spotify doctor` for a full read-only diagnostics report.")
    }
    return 0
  }
  const outcome = await executePlan(ctx, "Repair plan", steps)
  if (outcome.status === "dry-run") return 0
  const code = planExitCode(outcome)
  if (code !== 0) return code

  const next = await detectEnvironment(ctx.runtime)
  ctx.detection = next
  if (!next.opencode.plugin.registered || next.opencode.plugin.local) {
    ui.error("Global registration could not be verified after repair.")
    return 1
  }
  if (!next.bridge.installed || next.bridge.registration !== "current") {
    ui.error("The bridge remains inconsistent after repair. Review `opencode-spotify doctor`.")
    return 1
  }
  const applied = await maybeApplyBridge(ctx, next.spicetify.path, bridgeNeedsRepair)
  if (applied.code !== 0) return applied.code
  ui.section("Repair summary")
  ui.kv("Global plugin", next.opencode.plugin.version ?? "registered")
  ui.kv("Bridge", applied.applied ? "repaired and applied" : "repaired; apply pending")
  ui.bullet("Restart running OpenCode processes after repair.")
  return 0
}
