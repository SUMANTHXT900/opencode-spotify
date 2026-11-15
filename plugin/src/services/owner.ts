import { SpicetifyServer, type ServerOptions } from "./SpicetifyServer.ts"

// OpenCode may instantiate this plugin for more than one location. Keep one
// server per process and release it only after the last plugin instance unloads.
const key = Symbol.for("opencode-spotify.bridge-owner.v0.3")
type Owner = { server: SpicetifyServer; references: number; closing?: Promise<void> }
const registry = globalThis as typeof globalThis & { [key]?: Owner }

export async function acquireBridge(port = 18765, options: ServerOptions = {}) {
  let owner = registry[key]
  if (owner?.closing) {
    await owner.closing
    owner = registry[key]
  }
  if (!owner) {
    owner = { server: new SpicetifyServer(port, options), references: 0 }
    registry[key] = owner
  }
  owner.references++
  await owner.server.start()
  const held = owner
  let released = false
  return {
    server: held.server,
    async release() {
      if (released) return
      released = true
      if (--held.references !== 0) return
      held.closing = held.server.stop()
      await held.closing
      if (registry[key] === held) delete registry[key]
    },
  }
}
