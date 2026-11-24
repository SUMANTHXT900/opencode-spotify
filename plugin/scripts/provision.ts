// Local installer helper. Never outputs or accepts a secret on the command line.
import { readFileSync, writeFileSync, lstatSync } from "node:fs"
import { configurationPath, provision, markInstalled } from "../src/services/credentials.ts"

const [operation, target, reset, templateArg] = process.argv.slice(2)
try {
  const path = configurationPath()
  if (operation === "install" && target) {
    const templatePath = templateArg || new URL("../spicetify/opencode-spotify-bridge.js", import.meta.url)
    if (lstatSync(templatePath).isSymbolicLink()) throw new Error()
    const template = readFileSync(templatePath, "utf8")
    if (template.split("__OPENCODE_SPOTIFY_SECRET__").length !== 2) throw new Error()
    const config = provision(path, reset === "reset")
    writeFileSync(target, template.replace("__OPENCODE_SPOTIFY_SECRET__", config.secret), { mode: 0o600 })
    if (readFileSync(target, "utf8") !== template.replace("__OPENCODE_SPOTIFY_SECRET__", config.secret)) throw new Error()
    markInstalled(path)
  } else if (operation === "uninstall") markInstalled(path, false)
  else throw new Error()
} catch {
  console.error("Spotify extension provisioning failed. Configuration was not printed. Re-run repair; do not delete existing credentials.")
  process.exitCode = 1
}
