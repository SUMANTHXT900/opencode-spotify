import { bridgeOperation, removeCredentials } from "./bridge.ts"
import { removeGlobalPlugin } from "./opencode.ts"
import { executePlan, planExitCode } from "./plan.ts"
import type { OperationContext, PlanStep } from "./types.ts"

/**
 * Remove only OpenCode Spotify's global registration and owned bridge files.
 * Spotify, Spicetify, other extensions, themes, custom apps, unrelated OpenCode
 * plugins/settings and backups are preserved. Credentials are kept unless a
 * separate confirmation authorizes their removal.
 */
export async function runUninstall(ctx: OperationContext): Promise<number> {
  const { ui, detection } = ctx
  if (!detection.windows) {
    ui.error("Uninstall is supported on Windows only. No changes were made.")
    return 1
  }
  const steps: PlanStep[] = []
  if (detection.opencode.plugin.registered) {
    const spec = detection.opencode.plugin.spec ?? "opencode-spotify"
    steps.push({
      id: "remove-global-registration",
      description: `Remove the global OpenCode registration ${spec}`,
      mutates: true,
      run: async () => {
        const result = await removeGlobalPlugin(ctx.runtime, spec)
        if (result.code !== 0) throw new Error(result.error ?? "opencode plugin remove failed")
      },
    })
  }
  if (detection.bridge.installed || detection.spicetify.bridgeRegistered) {
    if (!detection.spicetify.available) {
      ui.warn("Spicetify is not detected, so the owned extension file cannot be located safely by the installer.")
      ui.bullet("Remove `opencode-spotify-bridge.js` from the Spicetify Extensions directory and its `extensions =` entry yourself if it remains.")
    } else {
      steps.push({
        id: "remove-bridge",
        description: "Remove the owned bridge extension and its Spicetify registration (credentials and backups kept)",
        mutates: true,
        run: async () => {
          const result = await bridgeOperation(ctx.runtime, "uninstall", {
            spicetifyPath: detection.spicetify.path,
            dryRun: false,
            yes: true,
          })
          if (result.code !== 0) throw new Error(result.error ?? "Bridge uninstall failed")
        },
      })
    }
  }
  if (!steps.length) {
    ui.success("Nothing owned by OpenCode Spotify is registered. Spotify and Spicetify were not touched.")
    return 0
  }
  const outcome = await executePlan(ctx, "Uninstall plan", steps, {
    question: "Remove OpenCode Spotify's registration and owned bridge files?",
    defaultYes: false,
  })
  const code = planExitCode(outcome)
  if (code !== 0) return code

  if (ctx.options.removeCredentials) {
    let approved = ctx.options.nonInteractive && ctx.options.yes
    if (!approved) {
      if (ctx.options.nonInteractive) {
        ui.error("Credential removal requires --yes in noninteractive mode. Credentials were kept.")
        return 2
      }
      ui.section("Optional credential removal")
      ui.line("  This deletes %APPDATA%\\opencode-spotify, including the signing secret and pinned Origin.")
      ui.line("  Backups are not deleted. A reinstall generates a new secret and requires a bridge reinstall.")
      approved = await ctx.prompt.confirm("Delete the stored bridge credentials too?", { phrase: "DELETE CREDENTIALS" })
    }
    if (approved) {
      const removal = await executePlan(ctx, "Credential removal", [{
        id: "remove-credentials",
        description: "Delete the owned bridge credential directory",
        mutates: true,
        run: async () => {
          const result = await removeCredentials(ctx.runtime)
          if (result.code !== 0) throw new Error(result.error ?? "Credential removal failed")
        },
      }], { approved: true })
      if (planExitCode(removal) !== 0) return 1
    } else {
      ui.line("  Credentials were kept.")
    }
  }

  ui.section("Uninstall summary")
  ui.kv("Global registration", "removed")
  ui.kv("Owned bridge", detection.spicetify.available ? "removed / registration cleared" : "manual cleanup may be required")
  ui.kv("Credentials", ctx.options.removeCredentials ? "reviewed above" : "kept")
  ui.kv("Spotify / Spicetify", "not removed")
  ui.kv("Other extensions", "preserved")
  ui.bullet("Restart running OpenCode processes; the Spotify sidebar will no longer load.")
  ui.bullet("To reinstall later, run setup again. Existing pinned credentials may be reused if not removed.")
  return 0
}
