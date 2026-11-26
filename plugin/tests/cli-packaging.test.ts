// Packaging + runtime compatibility gates (V0.6.0-beta.3, WP-B lightweight).
//
// Fast, local counterpart to scripts/verify-package.mjs. The authoritative
// consumer gate (packed tarball -> isolated prefix -> real payload probes)
// lives in the verifier; this file keeps the same invariants checkable in
// milliseconds so a regression cannot reach that gate unnoticed:
//
//   - beta.3 distribution metadata (name/version/exports/files/bin/engines)
//   - the Ink/React/@inkjs/ui stack follows a bounded tilde policy
//     (~7.1.1 means >=7.1.1 <7.2.0): mature UI deps float on patches only,
//     never minors. This fast suite is intentionally stricter than the packed
//     verifier (which tolerates an exact pin during iteration): `test:fast`
//     requires `~`, so a temporary exact pin fails here before it can drift.
//     Version ranges belong in the manifest (WP-C owns
//     manifest/lock/ink.ts and removed the duplicate INK_DEPENDENCIES
//     constants); this file asserts pin FORMAT plus reviewed lock
//     consistency, never hard-coded versions, so isolated candidates use
//     the same policy without editing this file
//   - the coordinated SDK/renderer/Solid set stays exact but versions are
//     read from the manifest/lock (never hard-coded)
//   - every bare runtime import in the shipped source is a production dep
//   - installer startup with injected mocks never reaches a real executable
//     and the plain fallback remains independent of Ink/React
//
// Expensive duplicated coverage (tsc CLI/PS builds, compiled CLI startup,
// Node server load, Bun TUI smoke) was removed here on purpose: those exact
// assertions now live in the packed verifier (owner A). This suite asserts
// the verifier still owns them via lightweight static markers only.
//
// No test here runs `npm publish`, touches global npm state, Spotify,
// Spicetify or the developer's OpenCode configuration.
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  existsSync, readFileSync, readdirSync,
} from "node:fs"
import { builtinModules } from "node:module"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { main } from "../src/cli/main.ts"
import { createPlainPresentation } from "../src/cli/ui-mode.ts"
import { fakeLogger, fakePrompt, fakeRuntime, fakeUi } from "./cli-fixture.ts"

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const manifestPath = join(pluginRoot, "package.json")
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, any>
const compat = JSON.parse(readFileSync(join(pluginRoot, "compat.json"), "utf8")) as Record<string, any>
const lock = JSON.parse(readFileSync(join(pluginRoot, "package-lock.json"), "utf8")) as Record<string, any>

const EXPECTED_VERSION = manifest.version

/** Strip a leading ~, ^, >=, =, whitespace prefix; return core semver. */
function coreSemver(version: string): { major: number; minor: number; patch: number; rest: string } {
  const stripped = String(version).trim().replace(/^[~^>=<\s]+/, "")
  const match = stripped.match(/^(\d+)\.(\d+)\.(\d+)(.*)$/)
  assert.ok(match, `not semver core: ${JSON.stringify(version)}`)
  return {
    major: Number(match![1]),
    minor: Number(match![2]),
    patch: Number(match![3]),
    rest: match![4] ?? "",
  }
}

/**
 * Bounded patch policy: the manifest range must use "~", and its
 * core must be lock-consistent: same major.minor as the reviewed lockfile
 * resolution, with the lock patch >= the manifest floor (the lock is the
 * reviewed resolution, so it may float above the floor but never below it
 * or across minors). Temporary candidates use this same policy.
 */
function assertTildeFormatAndLock(name: string): void {
  const pin = manifest.dependencies?.[name]
  assert.match(String(pin ?? ""), /^~\d+\.\d+\.\d+$/,
    `${name} must use a stable, patch-only tilde range`)
  const locked = lock.packages?.[`node_modules/${name}`]?.version
  assert.ok(typeof locked === "string" && locked.length > 0,
    `${name} must have a reviewed lockfile resolution (got ${JSON.stringify(locked)})`)
  const floor = coreSemver(pin)
  const resolved = coreSemver(locked)
  assert.equal(floor.major, resolved.major, `${name} major must match the reviewed lock (${pin} vs ${locked})`)
  assert.equal(floor.minor, resolved.minor,
    `${name} minor must match the reviewed lock: bounded ~ policy never crosses minors (${pin} vs ${locked})`)
  assert.ok(resolved.patch >= floor.patch,
    `${name} lock patch must not sit below the manifest floor (${pin} vs ${locked})`)
}

/** Exact coordinated pin: no range prefix, full semver, matches the lock. */
function assertExactCoordinated(name: string): void {
  const pin = manifest.dependencies?.[name]
  assert.match(String(pin ?? ""), /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/,
    `${name} pin must be exact (got ${JSON.stringify(pin)})`)
  const locked = lock.packages?.[`node_modules/${name}`]?.version
  assert.equal(pin, locked, `${name} exact runtime pin must match the lockfile`)
}

function listSources(directory: string, suffix = /\.(?:ts|tsx|js|mjs|cjs)$/): string[] {
  if (!existsSync(directory)) return []
  const files: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "tests") continue
      files.push(...listSources(full, suffix))
    } else if (suffix.test(entry.name)) {
      files.push(full)
    }
  }
  return files
}

function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^\S:])\/\/[^\n]*/g, "$1 ")
}

/** Package root of a bare specifier: `@scope/name` or `name`. */
function packageRoot(specifier: string): string {
  const parts = specifier.split("/")
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!
}

function bareSpecifiers(text: string): string[] {
  const pattern = /(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)["']([^"']+)["']/g
  const found: string[] = []
  let match: RegExpExecArray | null
  while ((match = pattern.exec(stripComments(text)))) {
    const specifier = match[1]!
    if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("file:")) continue
    if (specifier.startsWith("node:") || specifier.startsWith("bun:") || specifier.startsWith("@types/")) continue
    found.push(specifier)
  }
  return found
}

const BUILTINS = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)])

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

test("distribution metadata is coherent across manifest, compat and lockfile", () => {
  assert.equal(manifest.name, "opencode-spotify")
  assert.match(EXPECTED_VERSION, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
  assert.equal(manifest.license, "MIT")
  assert.equal(manifest.type, "module")
  assert.equal(manifest.engines?.node, ">=22.18.0", "Node engine floor is the supported beta.3 line")
  assert.equal(manifest.engines?.bun, ">=1.3.14", "the TUI runtime floor is the OpenTUI Bun line")
  assert.equal(manifest.private, undefined, "the package must stay publishable (release gates decide when)")

  assert.equal(compat.package, "opencode-spotify")
  assert.equal(compat.minimum?.node, manifest.engines.node.replace(/^>=\s*/, ""),
    "compat.json Node minimum must match engines.node")
  assert.deepEqual(compat.bridge, { protocol: 2, handshake: "auto-1", port: 18765 })
  assert.ok(Array.isArray(compat.platforms) && compat.platforms.includes("win32"),
    "compat.json declares the supported platform")

  const lockRoot = lock.packages?.[""]
  assert.ok(lockRoot, "package-lock has a root package entry")
  assert.equal(lockRoot.name, manifest.name)
  assert.equal(lockRoot.version, manifest.version, "lockfile version matches package.json")
  assert.deepEqual(lockRoot.dependencies, manifest.dependencies)
  assert.deepEqual(lockRoot.devDependencies, manifest.devDependencies)
  assert.deepEqual(lockRoot.bin, { "opencode-spotify": "bin/opencode-spotify.js" })

  assert.deepEqual(manifest.exports, {
    ".": "./src/index.ts",
    "./tui": "./src/tui.tsx",
    "./rpc": "./src/rpc.ts",
  })
  for (const [key, target] of Object.entries(manifest.exports as Record<string, string>)) {
    assert.ok(existsSync(join(pluginRoot, target.replace(/^\.\//, ""))),
      `exports[${JSON.stringify(key)}] -> ${target} exists in the checkout`)
  }

  for (const required of ["src", "spicetify", "scripts/install-extension.ps1", "bin", "dist", "compat.json"]) {
    assert.ok(manifest.files.includes(required), `package files include ${required}`)
  }

  const binTarget = manifest.bin?.["opencode-spotify"]
  assert.equal(binTarget, "./bin/opencode-spotify.js")
  const binSource = readFileSync(join(pluginRoot, "bin", "opencode-spotify.js"), "utf8")
  assert.ok(binSource.startsWith("#!/usr/bin/env node"), "bin entry keeps a Node shebang")
  assert.ok(binSource.includes("../dist/cli/main.js"),
    "bin entry executes the compiled CLI, never TypeScript sources")
})

// ---------------------------------------------------------------------------
// beta.2 regression: hard deps; tilde for mature Ink trio, exact for SDK set
// ---------------------------------------------------------------------------

test("Ink trio follows bounded tilde policy; SDK/renderer/Solid stay exact (beta.2 regression)", () => {
  // Mature Ink stack: patch-float only. Ranges belong in the manifest
  // (WP-C owns manifest/lock/ink.ts); format + reviewed-lock consistency
  // are asserted here with no hard-coded versions and no constant imports.
  for (const name of ["ink", "react", "@inkjs/ui"]) {
    assertTildeFormatAndLock(name)
    assert.equal(manifest.peerDependencies?.[name], undefined,
      `${name} must not be a peer (beta.2 shipped optional peers and consumer installs skipped them)`)
    assert.equal(manifest.peerDependenciesMeta?.[name], undefined,
      `${name} must not linger in peerDependenciesMeta (the optional-peer fiction)`)
    assert.equal(manifest.optionalDependencies?.[name], undefined,
      `${name} must not be optional: the CLI/TUI cannot run without it`)
  }

  // Coordinated SDK/renderer/Solid set: exact pins, but versions are read
  // from the manifest+lock (never hard-coded here) so isolated candidates
  // pass after a coordinated bump without editing this file.
  for (const name of ["@opentui/core", "@opentui/solid", "solid-js"]) {
    assertExactCoordinated(name)
    assert.equal(manifest.peerDependencies?.[name], undefined,
      `${name} must not be a peer`)
    assert.equal(manifest.peerDependenciesMeta?.[name], undefined,
      `${name} must not linger in peerDependenciesMeta`)
    assert.equal(manifest.optionalDependencies?.[name], undefined,
      `${name} must not be optional`)
  }
  assert.equal(manifest.devDependencies?.ink, undefined,
    "ink must not be dev-only: the compiled CLI imports it dynamically at runtime")
  assert.equal(manifest.devDependencies?.react, undefined,
    "react must not be dev-only: the compiled CLI imports it dynamically at runtime")
})

test("every bare runtime import in shipped code is a production dependency", () => {
  // Only shipped runtime payloads: `files` ships src/, bin/ and the compiled
  // dist/ (covered by the same source tree). scripts/verify-package.mjs is a
  // developer tool and is deliberately not packed.
  const sources = [
    ...listSources(join(pluginRoot, "src")),
    ...listSources(join(pluginRoot, "bin")),
  ]
  assert.ok(sources.length > 10, "source scan found the shipped tree")
  const imports = new Map<string, Set<string>>()
  for (const file of sources) {
    for (const specifier of bareSpecifiers(readFileSync(file, "utf8"))) {
      if (BUILTINS.has(specifier)) continue
      const root = packageRoot(specifier)
      if (!imports.has(root)) imports.set(root, new Set())
      imports.get(root)!.add(relative(pluginRoot, file))
    }
  }
  assert.ok(imports.size > 0, "source scan found external imports")
  for (const [root, files] of [...imports].sort(([a], [b]) => a.localeCompare(b))) {
    assert.equal(typeof manifest.dependencies?.[root], "string",
      `${root} is imported by ${[...files].join(", ")} but is not a production dependency`)
  }

  // The gate must not be vacuous: the TUI graph really is imported by the
  // shipped source, and the Ink stack is really a dependency.
  for (const dependency of ["@opentui/core", "solid-js", "@opencode/plugin", "ws"]) {
    assert.ok(imports.has(dependency), `shipped source imports ${dependency}`)
  }
  for (const dependency of ["@opentui/solid", "ink", "react"]) {
    assert.equal(typeof manifest.dependencies[dependency], "string", `${dependency} ships as a hard dependency`)
  }
  assert.ok(!imports.has("ink-testing-library"), "test-only helpers never leak into shipped code")
  assert.ok(!imports.has("typescript"), "the TypeScript compiler is not a runtime import")
})

// ---------------------------------------------------------------------------
// Installer startup with mocks + plain fallback (no real executables)
// ---------------------------------------------------------------------------

test("installer startup with injected mocks never touches a real executable", async () => {
  const runtime = fakeRuntime()
  const log = fakeLogger()
  const ui = fakeUi()
  const prompt = fakePrompt()

  assert.equal(await main(["--version"], { runtime, log, ui, prompt }), 0)
  assert.deepEqual(log.lines, [EXPECTED_VERSION], "--version prints exactly the package version")
  assert.equal(runtime.calls.length, 0, "--version returns before environment detection")

  const helpLog = fakeLogger()
  assert.equal(await main(["--help"], { runtime, log: helpLog, ui, prompt: fakePrompt() }), 0)
  assert.match(helpLog.lines.join("\n"), /Usage:/)
  assert.match(helpLog.lines.join("\n"), /--plain/)
  assert.equal(runtime.calls.length, 0, "--help returns before environment detection")

  const setupRuntime = fakeRuntime()
  const setupUi = fakeUi()
  const code = await main([
    "setup", "--dry-run", "--offline", "--spicetify=skip", "--plain", "--yes", "--non-interactive",
  ], { runtime: setupRuntime, log: fakeLogger(), ui: setupUi, prompt: fakePrompt() })
  assert.equal(code, 0, `mocked dry-run setup failed:\n${setupUi.lines.join("\n")}`)
  const commands = setupRuntime.calls.map((call) => `${call.file} ${call.args.join(" ")}`)
  assert.ok(!commands.some((command) => /(?:^|\s)npm(?:\s|$)/.test(command)),
    `dry-run must not invoke npm: ${commands.join(" | ")}`)
  assert.ok(!commands.some((command) => command.includes("plugin add")),
    "dry-run must not register the plugin")
  assert.ok(!commands.some((command) => command.includes("install-extension.ps1")),
    "dry-run must not run the bridge installer")
})

test("plain fallback runs without Ink/React and emits no ANSI when color is off", async () => {
  const lines: string[] = []
  const log = { out: (line: string) => lines.push(line), err: (line: string) => lines.push(line) }
  const presentation = createPlainPresentation(log, {
    color: false,
    json: false,
    io: { stdoutTTY: false, stdinTTY: false, env: {} as NodeJS.ProcessEnv },
  })
  try {
    assert.equal(presentation.mode, "plain")
    presentation.ui.banner(EXPECTED_VERSION, true)
    presentation.report.phase("execute", "Executing")
    presentation.report.step("register", "ok", "Plugin registered")
    presentation.report.log("warn", "Careful")
  } finally {
    await presentation.close()
  }
  const output = lines.join("\n")
  assert.match(output, /OpenCode Spotify/)
  assert.match(output, /Plugin registered/)
  assert.ok(!output.includes("\u001b"), "plain output must not contain ANSI escapes")

  // End-to-end: no injected UI means main selects the plain presentation
  // because this test process has no TTY. A fake runtime keeps it side-effect
  // free while still exercising the real mode-selection branch.
  const runtime = fakeRuntime()
  const statusLog = fakeLogger()
  assert.equal(await main(["status", "--offline", "--plain"], { runtime, log: statusLog }), 0)
  const statusOutput = statusLog.lines.join("\n")
  assert.ok(statusOutput.length > 0, "plain status produced output")
  assert.ok(!statusOutput.includes("\u001b"), "plain status contains no ANSI escapes")
})

// ---------------------------------------------------------------------------
// Gate preservation: verify-package.mjs stays a no-publish consumer gate
// ---------------------------------------------------------------------------

test("verify-package.mjs preserves its isolated, no-publish consumer gate", () => {
  const source = readFileSync(join(pluginRoot, "scripts", "verify-package.mjs"), "utf8")
  for (const marker of [
    "npm pack",
    "--ignore-scripts",
    "--omit=dev",
    "--prefix",
    "NODE_PATH",
    "rmSync",
    "installed-cli",
    "consumer-gate",
    "tui-smoke",
    "provision-smoke",
  ]) {
    assert.ok(source.includes(marker), `verify-package keeps the "${marker}" gate`)
  }
  assert.doesNotMatch(source, /\bnpm\s+publish\b/, "verify-package never publishes")
  assert.doesNotMatch(source, /\snpm\s+-g\s/, "verify-package never writes global npm state")
  for (const marker of ["-SkipApply", "-SpicetifyPath", "TEST_SPICETIFY_CONFIG"]) {
    assert.ok(source.includes(marker), `provisioning smoke stays isolated via "${marker}"`)
  }
  assert.match(source, /rmSync\(/, "temporary state is removed")
})
