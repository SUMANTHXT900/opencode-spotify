#!/usr/bin/env node
// The packaged CLI is compiled to plain JavaScript under dist/ because Node
// refuses TypeScript type-stripping for files installed under node_modules.
// `npm run build:cli` produces it; the published tarball always includes it.
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"

const compiled = new URL("../dist/cli/main.js", import.meta.url)
if (!existsSync(fileURLToPath(compiled))) {
  process.stderr.write("OpenCode Spotify: compiled CLI is missing. Run `npm run build:cli` before packaging.\n")
  process.exitCode = 1
} else {
  const { main } = await import(compiled.href)
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code })
    .catch((error) => {
      const raw = error instanceof Error ? error.message : "Installer failed"
      const message = raw
        .replace(/\b[a-f0-9]{32,}\b/gi, "[redacted]")
        .replace(/\b(secret|token|password|credential|authorization)\s*[:=]\s*\S+/gi, "$1=[redacted]")
        .slice(0, 400)
      process.stderr.write(`Error: ${message}\n`)
      process.exitCode = 1
    })
}
