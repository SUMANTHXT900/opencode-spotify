import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"

test("approved installer preserves other extensions, deduplicates, reuses credentials, repairs and uninstalls", async () => {
  const root = await mkdtemp(join(tmpdir(), "spotify-installer-"))
  const extensions = join(root, "spicetify", "Extensions")
  await mkdir(extensions, { recursive: true })
  const ini = join(root, "spicetify", "config-xpui.ini")
  const target = join(extensions, "opencode-spotify-bridge.js")
  const config = join(root, "opencode-spotify", "bridge.json")
  const env = { ...process.env, APPDATA: root, XDG_CONFIG_HOME: root, TEST_SPICETIFY_CONFIG: ini }
  const script = resolve("scripts/install-extension.ps1").replace(/'/g, "''")
  const run = (operation: string, approve = true) => {
    const result = spawnSync("pwsh", ["-NoProfile", "-Command", `
      function spicetify { if ($args[0] -eq '-c') { $env:TEST_SPICETIFY_CONFIG }; $global:LASTEXITCODE = 0 }
      function Read-Host { param($Prompt); if ($Prompt -like 'Rotate*') { 'RESET' } else { '${approve ? "YES" : "NO"}' } }
      & '${script}' ${operation}
    `], { env, encoding: "utf8" })
    assert.equal(result.error, undefined)
    assert.equal(result.status, 0, result.stderr)
    return result.stdout + result.stderr
  }
  try {
    await writeFile(ini, "[AdditionalOptions]\nextensions = other.js|opencode-spotify-bridge.js|opencode-spotify-bridge.js\n")
    await writeFile(join(extensions, "other.js"), "// unrelated extension")
    run("-Install", false)
    assert.deepEqual(await readdir(extensions), ["other.js"])
    const output = run("-Install")
    const first = JSON.parse(await readFile(config, "utf8"))
    assert.equal(output.includes(first.secret), false)
    assert.equal((await readFile(target, "utf8")).includes(first.secret), true)
    assert.equal((await readFile(ini, "utf8")).match(/opencode-spotify-bridge\.js/g)?.length, 1)
    run("-Repair")
    assert.equal(JSON.parse(await readFile(config, "utf8")).secret, first.secret)
    run("-Repair -ResetCredentials")
    assert.notEqual(JSON.parse(await readFile(config, "utf8")).secret, first.secret)
    run("-Uninstall")
    assert.equal((await readFile(ini, "utf8")).includes("opencode-spotify"), false)
    assert.equal(await readFile(join(extensions, "other.js"), "utf8"), "// unrelated extension")
    assert.equal(JSON.parse(await readFile(config, "utf8")).installed, false)
    // Missing registration key is created without losing existing sections.
    await writeFile(ini, "[AdditionalOptions]\ncustom = keep\n")
    run("-Install")
    assert.match(await readFile(ini, "utf8"), /custom = keep/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
