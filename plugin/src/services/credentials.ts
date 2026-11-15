import { randomBytes, randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync, lstatSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export interface Configuration {
  version: 1
  secret: string
  origins: (string | null)[]
  installed: boolean
}
export const configurationPath = () => join(process.platform === "win32"
  ? process.env.APPDATA || join(homedir(), "AppData", "Roaming")
  : process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode-spotify", "bridge.json")

export function validOrigin(origin: unknown): origin is string | null {
  if (origin === null || origin === "null") return true
  if (typeof origin !== "string" || origin.length > 300) return false
  try { const url = new URL(origin); return url.protocol === "https:" && url.origin === origin } catch { return false }
}
export function loadConfiguration(path = configurationPath()): Configuration {
  if (lstatSync(path).isSymbolicLink()) throw new Error("Configuration must not be a symbolic link")
  const c = JSON.parse(readFileSync(path, "utf8"))
  if (c.version !== 1 || !/^[a-f0-9]{64}$/.test(c.secret) || !Array.isArray(c.origins) ||
      c.origins.length > 1 || !c.origins.every(validOrigin) || typeof c.installed !== "boolean") {
    throw new Error("Invalid Spotify connection configuration")
  }
  return c
}
function save(path: string, value: Configuration, exclusive = false) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = exclusive ? path : `${path}.${randomUUID()}.tmp`
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" })
  if (!exclusive) renameSync(temporary, path)
  if (process.platform !== "win32") chmodSync(path, 0o600)
}
// Called only by the approved installer, never by an ordinary plugin launch.
export function provision(path = configurationPath(), reset = false): Configuration {
  if (existsSync(path) && !reset) return loadConfiguration(path)
  const config: Configuration = { version: 1, secret: randomBytes(32).toString("hex"), origins: [], installed: false }
  save(path, config, !existsSync(path))
  return config
}
export function markInstalled(path = configurationPath(), installed = true) {
  const config = loadConfiguration(path)
  save(path, { ...config, installed })
}
// One-time authenticated runtime observation, never an unauthenticated TOFU.
export function recordOrigin(path: string, secret: string, origin: string | null) {
  if (!validOrigin(origin)) throw new Error("Unsupported desktop Origin")
  const config = loadConfiguration(path)
  if (config.secret !== secret || config.origins.length) throw new Error("Configuration changed; repair required")
  save(path, { ...config, origins: [origin] })
}
