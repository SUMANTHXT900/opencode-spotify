import { join } from "node:path"
import { BRIDGE_PORT, MIN_OPENCODE, MIN_SPICETIFY, bridgeCompatibility, isAtLeast } from "./compat.ts"
import { inspectBridge } from "./bridge.ts"
import { inspectOpenCode } from "./opencode.ts"
import { inspectSpicetify, inspectSpotify } from "./spicetify.ts"
import type { Detection, Runtime } from "./types.ts"

export const BRIDGE_CONFIG_DIR = (runtime: Runtime) => join(runtime.env.APPDATA || join(runtime.homedir, "AppData", "Roaming"), "opencode-spotify")
export const BRIDGE_CONFIG_PATH = (runtime: Runtime) => join(BRIDGE_CONFIG_DIR(runtime), "bridge.json")

export function windowsVersion(runtime: Runtime): string {
  if (runtime.platform !== "win32") return "unsupported"
  const release = runtime.env.OS
  return typeof release === "string" && release ? release : "Windows"
}

/**
 * Read-only environment inspection. It must never create, modify, install,
 * apply, or print credentials.
 */
export async function detectEnvironment(runtime: Runtime): Promise<Detection> {
  const [opencode, spotify, spicetify] = await Promise.all([
    inspectOpenCode(runtime),
    inspectSpotify(runtime),
    inspectSpicetify(runtime),
  ])
  const bridge = await inspectBridge(runtime, spicetify)
  const portBusy = await runtime.portOpen("127.0.0.1", BRIDGE_PORT, 700)
  const opencodeCompat = opencode.available
    ? isAtLeast(opencode.version, MIN_OPENCODE) === true ? "ok"
      : isAtLeast(opencode.version, MIN_OPENCODE) === false ? "too-old" : "unknown"
    : "unknown"
  const spicetifyCompat = spicetify.available
    ? isAtLeast(spicetify.version, MIN_SPICETIFY) === true ? "ok"
      : isAtLeast(spicetify.version, MIN_SPICETIFY) === false ? "too-old" : "unknown"
    : "unknown"
  // B08: an unsuccessful inspection is "unknown", never proof of "absent".
  const pluginState = opencode.plugin.state ?? (opencode.plugin.registered ? "registered" : "absent")
  return {
    windows: runtime.platform === "win32",
    windowsVersion: windowsVersion(runtime),
    arch: runtime.arch,
    node: process.versions.node,
    pwsh: (await runtime.which("pwsh")) ?? null,
    opencode,
    spotify,
    spicetify,
    bridge,
    port: {
      busy: portBusy,
      likelyOwnedByThisPlugin: portBusy ? bridge.installed || opencode.plugin.registered : null,
    },
    compatibility: {
      opencode: opencodeCompat,
      spicetify: spicetifyCompat,
      bridge: bridgeCompatibility({ pluginVersion: opencode.plugin.version ?? "0.0.0", bridgeInstalled: bridge.installed, bridgeRegistration: bridge.registration }),
      plugin: pluginState === "registered" ? "ok" : pluginState === "unknown" ? "unknown" : "missing",
    },
  }
}
