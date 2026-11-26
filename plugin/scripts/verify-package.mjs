#!/usr/bin/env node
/**
 * V0.6.0 packed-package verification (WP-A).
 *
 * Flow: build the compiled CLI + provisioner ONCE into an isolated scratch
 * stage (output layout equivalent to `npm run build:cli`), assemble a pack
 * staging tree, `npm pack` once (no publish), install the tarball into a
 * fresh isolated prefix, and run the installed CLI payload there.
 *
 * Resolution/caching note (steering change, Nov 2026): a scratch experiment on
 * the identical existing tarball showed warm default 25.62/23.67s vs warm
 * prefer-offline 26.37/23.70s, and a single cold sample 54.83s vs 46.98s
 * (uncertain, resolution ~7-8s warm, unpack ~13-17s). The offline delta is
 * within noise, so this verifier keeps npm's NORMAL cache
 * revalidation/resolution default — no permanent --prefer-offline flag. The
 * install stays fresh (empty prefix per run) and isolated, with numeric npm
 * timing recorded per stage. No new verifier option was added for this.
 *
 * Safety properties (also enforced by CI):
 * - Never references the registry package name: the tarball is addressed by
 *   absolute local file path only (`npm install <abs path to .tgz>`).
 * - Never touches global npm state (no `-g`), Spotify, Spicetify, or any
 *   OpenCode configuration. `--version` / `--help` exit before environment
 *   detection runs.
 * - Prebuilt mode (`--tarball PATH`) is trusted-input only: it performs zero
 *   build/pack/write to the input file, but it still installs and executes
 *   the supplied bytes (installed CLI, server/TUI loads, provisioner smoke).
 *   Use it only for artifacts already trusted (e.g. a retained candidate plus
 *   its sidecars); it does not provenance-bind packed sources to this checkout.
 * - No checkout `dist` contamination: the checkout `dist/` is never written;
 *   compilation targets the scratch stage only.
 * - No shell string interpolation for untrusted values/paths: every child
 *   process uses execFileSync argv arrays with shell:false. npm runs as
 *   `node <npm-cli.js> ...` so the npm.cmd shim never needs a shell.
 * - Fail closed outside Windows / missing tools: non-win32 or absent
 *   node/npm-cli/tsc/bun/pwsh is UNVERIFIED (exit 1), never a silent skip.
 * - Diagnostics are sanitized (secret counts, never values).
 * - The tarball is decompressed exactly once into a validated ustar index;
 *   all later reads come from that index.
 * - One scratch root holds build/stage/install/probe state and is removed
 *   with a real reported status, even on failure.
 *
 * Run from the package directory: `node scripts/verify-package.mjs
 * [--tarball PATH] [--keep-dir DIR] [--logs-dir DIR]` or via
 * `npm run verify:package`.
 *
 * Retention semantics (no overwrite of prior QA artifacts):
 * - The retained file is the exact verified byte snapshot (SHA-256 + SHA-512
 *   independently digested after verification passes).
 * - If <keep-dir>/<basename> already exists and is byte-identical, it is
 *   re-used (sidecars verified/created, the .tgz never rewritten).
 * - If it exists with different bytes, verification fails closed with a
 *   conflict and the prior artifact is never overwritten.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync,
  statSync, readdirSync, realpathSync, cpSync, copyFileSync, appendFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  parseVerifierArgs, indexTarball, digests, retainArtifact, sanitizeMessage, verifyArtifactSidecars,
} from "./verify-package-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(here, "..");

const failures = [];
function check(condition, message) {
  if (!condition) failures.push(message);
  else process.stdout.write(`  ok: ${message}\n`);
}
function note(text) {
  process.stdout.write(`${text}\n`);
}

// All child processes use argv arrays with shell:false — never a shell string,
// so untrusted paths/values cannot interpolate into a command line.
function run(file, args, options = {}) {
  try {
    return execFileSync(file, args, {
      cwd: pluginRoot,
      encoding: "utf8",
      stdio: "pipe",
      timeout: 180_000,
      windowsHide: true,
      shell: false,
      ...options,
    });
  } catch (error) {
    const status = Number.isInteger(error.status) ? `exit ${error.status}` : "launch or timeout";
    throw new Error(`${basename(file)} subprocess failed (${status})`);
  }
}

function findNpmCli() {
  const candidates = [
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    join(pluginRoot, "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  if (process.platform === "win32") {
    candidates.push("C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js");
  }
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch { /* keep looking */ }
  }
  return null;
}
const NPM_CLI = findNpmCli();

// `npm pack` + isolated `npm install --prefix` consumer gate (no publish).
function runNpm(args, options = {}) {
  if (!NPM_CLI) throw new Error("npm CLI not found (node installation is missing npm-cli.js)");
  return run(process.execPath, [NPM_CLI, ...args], options);
}

function coreSemver(version) {
  const stripped = String(version ?? "").trim().replace(/^[~^>=<\s]+/, "");
  const match = stripped.match(/^(\d+)\.(\d+)\.(\d+)(.*)$/);
  if (!match) throw new Error(`verify-package: not semver core: ${JSON.stringify(String(version).slice(0, 32))}`);
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function tildeBase(range) {
  return typeof range === "string" && range.startsWith("~") ? range.slice(1) : range;
}
function isExactSemver(version) {
  return typeof version === "string" && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version);
}
function isTildeOrExactPolicy(range) {
  // Bounded tilde-patch policy: `~X.Y.Z` or exact `X.Y.Z` (exact tolerated in
  // the current tree during iteration). Anything wider (^, >=, *) is rejected.
  return typeof range === "string" && /^(~)?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(range);
}

/** Compare full semver triples (major, minor, patch); prereleases ignored. */
function compareTriple(left, right) {
  const parse = (value) => String(value).split(/[.+-]/).slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

function listFilesRecursive(root) {
  const out = [];
  let entries = [];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === "ENOENT") return out;
    throw error;
  }
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(full));
    else out.push(full);
  }
  return out.sort();
}

/**
 * Fully isolated probe environment for ALL runtime probes: HOME, USERPROFILE,
 * APPDATA, LOCALAPPDATA and XDG config/cache/data/state point under the
 * scratch probe root; NODE_PATH and OpenCode config overrides are removed so
 * the developer's OpenCode/registry state can never satisfy or pollute a
 * probe. Returns { env, roots } where roots lists every dir that must stay
 * write-free unless a probe explicitly owns it.
 */
function isolatedProbeEnv(probeCwd, tag) {
  const base = join(probeCwd, `iso-${tag}`);
  const roots = {
    home: join(base, "home"),
    appdata: join(base, "appdata"),
    localappdata: join(base, "localappdata"),
    config: join(base, "config"),
    cache: join(base, "cache"),
    data: join(base, "data"),
    state: join(base, "state"),
  };
  for (const dir of Object.values(roots)) mkdirSync(dir, { recursive: true });
  const env = {};
  const windowsEnv = new Set(["PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT",
    "PROCESSOR_ARCHITECTURE", "PROCESSOR_ARCHITEW6432", "SYSTEMDRIVE"]);
  for (const [key, value] of Object.entries(process.env)) {
    if (windowsEnv.has(key.toUpperCase())) env[key] = value;
  }
  env.HOME = roots.home;
  env.USERPROFILE = roots.home;
  env.APPDATA = roots.appdata;
  env.LOCALAPPDATA = roots.localappdata;
  env.XDG_CONFIG_HOME = roots.config;
  env.XDG_CACHE_HOME = roots.cache;
  env.XDG_DATA_HOME = roots.data;
  env.XDG_STATE_HOME = roots.state;
  env.TMP = base;
  env.TEMP = base;
  env.NO_COLOR = "1";
  env.npm_config_update_notifier = "false";
  return { env, roots };
}

function assertNoWrites(label, roots, extraOwned = []) {
  const owned = new Set(extraOwned.map((p) => p.split(sep).join("/")));
  const stray = [];
  for (const dir of Object.values(roots)) {
    for (const file of listFilesRecursive(dir)) {
      const norm = file.split(sep).join("/");
      if (![...owned].some((prefix) => norm === prefix || norm.startsWith(`${prefix}/`))) {
        stray.push(norm);
      }
    }
  }
  check(stray.length === 0,
    stray.length === 0
      ? `${label} left no unexpected writes in isolated config/home dirs`
      : `${label} wrote ${stray.length} unexpected file(s)`);
}

/** Validate prebuilt sidecars: both or neither; mismatch fails before npm. */
function validatePrebuiltSidecars(tgzPath, bytes) {
  const shaPath = `${tgzPath}.sha256`;
  const intPath = `${tgzPath}.integrity`;
  const readSidecar = (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  };
  const verified = verifyArtifactSidecars(basename(tgzPath), bytes, readSidecar(shaPath), readSidecar(intPath));
  note(verified ? "  prebuilt sidecars: both present and matching" :
    "  prebuilt sidecars: none (standalone file; release approval is separate)");
}

function main() {
  let cli;
  try {
    cli = parseVerifierArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${sanitizeMessage(error.message)}\n`);
    return 2;
  }
  const tarballArg = cli.tarball;
  const keepDir = cli.keepDir;
  const logsDirOpt = cli.logsDir;

  const stages = {};
  function timed(name, fn) {
    const start = Date.now();
    try {
      return fn();
    } finally {
      stages[name] = Date.now() - start;
      note(`  stage ${name}: ${stages[name]}ms`);
    }
  }

  // Fail closed outside Windows / missing tools (never a silent skip).
  if (process.platform !== "win32") {
    process.stderr.write("verify-package: UNVERIFIED: this verifier is Windows-only (fail closed)\n");
    return 1;
  }
  if (!NPM_CLI) {
    process.stderr.write("verify-package: UNVERIFIED: npm CLI not found beside node\n");
    return 1;
  }
  const toolFailures = [];
  for (const [label, file, args] of [
    ["node", process.execPath, ["--version"]],
    ["npm", process.execPath, [NPM_CLI, "--version"]],
    ["bun", "bun", ["--version"]],
  ]) {
    try {
      run(file, args, { timeout: 60_000 });
    } catch {
      toolFailures.push(`UNVERIFIED: required tool missing or broken: ${label}`);
    }
  }
  try {
    run("pwsh", ["-NoProfile", "-NonInteractive", "-Command", "1"], { timeout: 60_000 });
  } catch {
    toolFailures.push("UNVERIFIED: pwsh is required for the packed provisioning smoke");
  }
  if (!tarballArg) {
    const tsc = join(pluginRoot, "node_modules", "typescript", "bin", "tsc");
    if (!existsSync(tsc)) toolFailures.push("UNVERIFIED: typescript devDependency is missing (npm ci required)");
  }
  if (toolFailures.length) {
    for (const failure of toolFailures) process.stderr.write(`verify-package: ${failure}\n`);
    return 1;
  }

  note("verify-package: packing opencode-spotify (no publish)");
  const manifest = JSON.parse(readFileSync(join(pluginRoot, "package.json"), "utf8"));
  const compat = JSON.parse(readFileSync(join(pluginRoot, "compat.json"), "utf8"));

  // Single scratch root for build/stage/install/probe; retained artifacts live
  // outside it in --keep-dir and survive cleanup.
  const scratchRoot = mkdtempSync(join(tmpdir(), "spotify-verify-"));
  const stageDir = join(scratchRoot, "stage");
  const stageDist = join(stageDir, "dist");
  const packOutDir = join(scratchRoot, "pack-out");
  const installPrefix = join(scratchRoot, "install");
  const probeCwd = join(scratchRoot, "probe");
  const scratchLogs = join(scratchRoot, "logs");
  const logsDir = logsDirOpt ? resolve(pluginRoot, logsDirOpt) : scratchLogs;
  const installLogs = join(scratchLogs, "npm-install");
  const npmTimings = {};
  let tarballPath = null;
  let tarballBytes = null;
  let installTarballPath = null;
  try {
    for (const dir of [stageDir, packOutDir, installPrefix, probeCwd, installLogs]) {
      mkdirSync(dir, { recursive: true });
    }
    if (tarballArg) {
      timed("prebuilt-resolve", () => {
        // Prebuilt mode: zero build/pack/write to the input — read-only.
        // Snapshot the bytes first; sidecars (both-or-neither) are validated
        // against the snapshot before anything else runs.
        tarballPath = resolve(pluginRoot, tarballArg);
        check(existsSync(tarballPath), `prebuilt tarball exists at ${tarballPath}`);
        if (!existsSync(tarballPath)) throw new Error(`prebuilt tarball missing: ${tarballPath}`);
        const st = statSync(tarballPath);
        check(st.isFile(), "prebuilt tarball is a file (nothing written to the input)");
        tarballBytes = readFileSync(tarballPath);
        validatePrebuiltSidecars(tarballPath, tarballBytes);
      });
    } else {
      timed("stage-assemble", () => {
        // Assemble the pack staging tree from an allowlist; never copy
        // node_modules/tests/checkout dist into the pack input.
        copyFileSync(join(pluginRoot, "package.json"), join(stageDir, "package.json"));
        for (const top of ["README.md", "LICENSE", "compat.json"]) {
          copyFileSync(join(pluginRoot, top), join(stageDir, top));
        }
        cpSync(join(pluginRoot, "bin"), join(stageDir, "bin"), { recursive: true });
        cpSync(join(pluginRoot, "src"), join(stageDir, "src"), { recursive: true });
        cpSync(join(pluginRoot, "spicetify"), join(stageDir, "spicetify"), { recursive: true });
        mkdirSync(join(stageDir, "scripts"), { recursive: true });
        copyFileSync(
          join(pluginRoot, "scripts", "install-extension.ps1"),
          join(stageDir, "scripts", "install-extension.ps1"),
        );
      });

      // Compile into the stage with the same projects as build:cli. Check the
      // emitted files in the actual archive below.
      const tsc = join(pluginRoot, "node_modules", "typescript", "bin", "tsc");
      for (const [label, config] of [["compile-cli", "tsconfig.cli.json"], ["compile-provision", "tsconfig.provision.json"]]) {
        timed(label, () => run(process.execPath, [tsc, "-p", config, "--outDir", stageDist], { timeout: 240_000 }));
      }

      timed("pack", () => {
        // npm pack once from the staging tree (pack-destination outside it).
        const packed = JSON.parse(runNpm(["pack", "--json", "--pack-destination", packOutDir,
          "--ignore-scripts", "--logs-dir", scratchLogs],
          { cwd: stageDir, timeout: 240_000 }));
        const filename = packed?.[0]?.filename;
        check(typeof filename === "string" && filename.endsWith(".tgz"),
          `npm pack produced a tarball (${filename ?? "none"})`);
        if (!filename) throw new Error("npm pack produced no tarball");
        tarballPath = join(packOutDir, filename);
        check(existsSync(tarballPath), `tarball exists at ${tarballPath}`);
      });
    }

    const index = timed("index", () => {
      // Snapshot the exact bytes before analysis; every later read (index,
      // digests, install, retain) comes from this snapshot. The install uses
      // a locked scratch copy, never the caller's input path.
      if (!tarballBytes) tarballBytes = readFileSync(tarballPath);
      const lockedDir = join(scratchRoot, "locked");
      mkdirSync(lockedDir, { recursive: true });
      installTarballPath = join(lockedDir, basename(tarballPath));
      writeFileSync(installTarballPath, tarballBytes);
      const reread = readFileSync(installTarballPath);
      if (reread.length !== tarballBytes.length || !reread.equals(tarballBytes)) {
        throw new Error("locked scratch copy failed read-back verification");
      }
      note(`  locked install copy: ${installTarballPath} (${reread.length} bytes)`);
      return indexTarball(tarballBytes);
    });
    const digest = digests(tarballBytes);
    const size = tarballBytes.length;
    note(`  tarball: ${tarballPath} (${size} bytes)`);
    note(`  sha256: ${digest.sha256}`);
    note(`  integrity: ${digest.integrity}`);

    // Never resolve the published name: from here on only the local file path.
    check(!tarballPath.includes("node_modules"), "tarball path is a local pack, not a registry resolution");
    const tarFile = (name) => {
      const data = index.files.get(name);
      return typeof data === "undefined" ? null : data.toString("utf8");
    };

    const entries = index.entries.filter((entry) => entry.type !== "5");
    const names = entries.map((entry) => entry.name.replace(/^package\//, ""));
    const has = (suffix) => names.some((name) => name === suffix);

    timed("manifest", () => {
      check(manifest.name === "opencode-spotify", `package name is opencode-spotify (got ${manifest.name})`);
      check(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-((0|[1-9]\d*|[0-9]*[a-zA-Z-][0-9A-Za-z-]*)(\.(0|[1-9]\d*|[0-9]*[a-zA-Z-][0-9A-Za-z-]*))*))?$/.test(manifest.version ?? ""),
        `package version is strict semver, no build metadata (got ${manifest.version})`);
      check(manifest.license === "MIT", `package license is MIT (got ${manifest.license})`);
      check(typeof manifest.bin?.["opencode-spotify"] === "string",
        "package bin.opencode-spotify entry exists");
      check(manifest.exports?.["."] && manifest.exports?.["./tui"] && manifest.exports?.["./rpc"],
        "package exports cover ., ./tui and ./rpc");
      check(Array.isArray(manifest.files) && manifest.files.includes("bin") &&
        manifest.files.includes("src") && manifest.files.includes("spicetify") &&
        manifest.files.includes("scripts/install-extension.ps1"),
        `package files include bin/src/spicetify/installer (got ${JSON.stringify(manifest.files)})`);

      const binTarget = manifest.bin?.["opencode-spotify"]?.replace(/^\.\//, "");
      check(typeof binTarget === "string" && existsSync(join(pluginRoot, binTarget)),
        `bin target ${binTarget ?? "(missing)"} exists in the checkout`);

      for (const required of [
        "package.json",
        "README.md",
        "LICENSE",
        "src/index.ts",
        "src/tui.tsx",
        "src/rpc.ts",
        "dist/cli/main.js",
        "dist/cli/args.js",
        "dist/cli/ui/ink.js",
        "dist/cli/ui/ink-view.js",
        "dist/cli/cancel.js",
        "dist/cli/children.js",
        "dist/cli/lock.js",
        "dist/cli/spicetify-release.js",
        "dist/cli/spicetify-official.js",
        "dist/cli/state.js",
        "dist/cli/progress.js",
        "dist/cli/ui-mode.js",
        "dist/scripts/provision.js",
        "dist/src/services/credentials.js",
        "compat.json",
        "bin/opencode-spotify.js",
        "spicetify/opencode-spotify-bridge.js",
        "scripts/install-extension.ps1",
      ]) {
        check(has(required), `tarball includes ${required}`);
      }

      // Exact generated-sensitive names only. Broad substrings are banned here:
      // e.g. /credential/i would false-positive on the legitimate source file
      // src/services/credentials.ts. Source files such as
      // src/services/credentials.ts must pass.
      const forbidden = [
        /(^|\/)tests?(\/|$)/, // packed tests or fixtures
        /(^|\/)[^/]*\.(test|spec)\.[jt]sx?$/i, // collocated test/spec files under src/dist/bin
        /(^|\/)fixtures?(\/|$)/i, // fixture directories
        /__tests__/, // alternate test dirs
        /(^|\/)node_modules(\/|$)/, // dependencies are resolved at install
        /(^|\/)\.git(\/|$)/, // version control metadata
        /(^|\/)\.env(\..*)?$/i, // environment files (.env, .env.local, ...)
        /(^|\/)bridge\.json$/i, // generated per-installation credential store
        /(^|\/)(credentials|auth)\.json$/i, // generated credential stores
        /(^|\/)\.npmrc$/i, // registry auth tokens
        /(^|\/)[^/]*\.(pem|pfx|p12|key)$/i, // private keys / certificates
        /(^|\/)(private-key|id_rsa[^/]*)$/i, // private-key files
        /(^|\/)package-lock\.json$/, // lockfile is not shipped
        /live-bridge-smoke/, // live smoke fixture, never packed
        /(^|\/)reference(\/|$)/i, // unshipped research (includes AGPL material)
        /(^|\/)[^/]*captures?[^/]*$/i, // live captures / screenshots
        /\.png$/i, // images are docs artifacts, not package content
      ];
      const violations = [];
      for (const entry of names) {
        for (const pattern of forbidden) {
          if (pattern.test(entry)) { violations.push(`${entry} (vs ${pattern})`); break; }
        }
      }
      check(violations.length === 0,
        violations.length === 0
          ? "tarball excludes tests/node_modules/.env/bridge.json/credentials/captures"
          : `tarball leaks sensitive/stray paths: ${sanitizeMessage(violations.slice(0, 4).join("; "))} (${violations.length} total)`);

      const packedManifest = JSON.parse(tarFile("package/package.json") ?? "{}");
      check(packedManifest.name === "opencode-spotify", "packed package.json keeps the name");
      check(packedManifest.version === manifest.version, `packed version matches checkout (${manifest.version})`);
      check(!Object.hasOwn(packedManifest, "publishConfig"), "packed manifest has no publish configuration override");
      const lifecycleHooks = ["preinstall", "install", "postinstall", "prepublish",
        "prepublishOnly", "prepack", "prepare", "postpack", "publish", "postpublish"];
      check(lifecycleHooks.every((hook) => !Object.hasOwn(packedManifest.scripts ?? {}, hook)),
        "packed manifest has no install or publication lifecycle hooks");
      const allowed = /^(?:package\.json|compat\.json|LICENSE|README\.md|bin\/opencode-spotify\.js|scripts\/install-extension\.ps1|spicetify\/opencode-spotify-bridge\.js|src\/.+\.tsx?|dist\/(?:cli|scripts|src)\/.+\.js)$/;
      check(names.every((name) => allowed.test(name)), "tarball contains only expected package paths and file types");
      const packedCompat = JSON.parse(tarFile("package/compat.json") ?? "{}");
      check(packedCompat.minimum?.node === (manifest.engines?.node ?? "").replace(/^>=\s*/, ""),
        `compat.json Node minimum matches engines (${packedCompat.minimum?.node} vs ${manifest.engines?.node})`);
      check(packedCompat.bridge?.protocol === 2 && packedCompat.bridge?.handshake === "auto-1" && packedCompat.bridge?.port === 18765,
        "compat.json pins bridge protocol 2 / auto-1 / port 18765");
      // P6: verification Node meets compat minimum (full triple incl. patch).
      check(compareTriple(process.versions.node, String(packedCompat.minimum?.node ?? "0")) >= 0,
        `verification Node ${process.versions.node} meets compat minimum ${packedCompat.minimum?.node} (patch floor compared)`);
      const packedBin = (packedManifest.bin?.["opencode-spotify"] ?? "").replace(/^\.\//, "");
      const binTargetNow = manifest.bin?.["opencode-spotify"]?.replace(/^\.\//, "");
      check(packedBin === binTargetNow, `packed bin target matches (${packedBin || "missing"})`);
      const binSource = tarFile(`package/${binTargetNow}`);
      check(typeof binSource === "string" && binSource.startsWith("#!/usr/bin/env node"),
        "packed bin entry has a node shebang");
      const compiledInk = tarFile("package/dist/cli/ui/ink.js") ?? "";
      check(compiledInk.includes('["in", "k"].join') && compiledInk.includes('["re", "act"].join'),
        "compiled Ink shell ships and keeps ink/react runtime-resolved");
      check(compiledInk.includes('["@inkjs", "ui"].join'),
        "compiled Ink shell loads @inkjs/ui through a dynamic specifier");
      const compiledMain = tarFile("package/dist/cli/main.js") ?? "";
      check(compiledMain.includes("./setup.js") && !compiledMain.includes("./setup.ts"),
        "compiled CLI imports emitted .js modules (no node_modules type stripping)");
      check(compiledMain.includes("./args.js") && !compiledMain.includes("./args.ts"),
        "compiled CLI imports emitted args.js (no TypeScript specifier)");
      const compiledProvision = tarFile("package/dist/scripts/provision.js") ?? "";
      check(compiledProvision.includes("../src/services/credentials.js") && !compiledProvision.includes("../src/services/credentials.ts"),
        "compiled provisioner imports emitted .js credentials (no node_modules type stripping)");

      // Transferred from cli-packaging.test.ts (deduped there): every emitted
      // JS file is plain JS with no TypeScript specifiers, and the listed
      // emitted modules are present and nonempty — including ui/ink-view.js.
      const emittedNames = names.filter((n) => n.startsWith("dist/") && n.endsWith(".js"));
      check(emittedNames.length > 15, `emitted compiled tree is complete (${emittedNames.length} js files)`);
      for (const required of [
        "dist/cli/main.js", "dist/cli/args.js", "dist/cli/ui/ink.js", "dist/cli/ui/ink-view.js",
        "dist/cli/ui-mode.js", "dist/cli/cancel.js", "dist/cli/children.js", "dist/cli/lock.js",
        "dist/cli/spicetify-release.js", "dist/cli/spicetify-official.js", "dist/cli/state.js",
        "dist/cli/progress.js", "dist/scripts/provision.js", "dist/src/services/credentials.js",
      ]) {
        const data = index.files.get(`package/${required}`);
        check(data instanceof Buffer && data.length > 0, `emitted module nonempty: ${required}`);
      }
      const tsSpecifier = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'][^"']*\.(?:ts|tsx)["']/;
      const tsOffenders = [];
      for (const name of emittedNames) {
        const text = tarFile(`package/${name}`) ?? "";
        if (tsSpecifier.test(text)) tsOffenders.push(name);
      }
      check(tsOffenders.length === 0,
        tsOffenders.length === 0
          ? "all emitted JS is free of .ts/.tsx specifiers"
          : `emitted JS keeps TypeScript specifiers: ${tsOffenders.slice(0, 5).join(", ")} (${tsOffenders.length} total)`);
      check(!/from\s+["'](?:ink|react)["']/.test(compiledInk) &&
        !/require\(\s*["'](?:ink|react)["']\s*\)/.test(compiledInk),
        "no eager Ink/React import in the compiled shell (plain fallback stays loadable)");

      const packedExports = packedManifest.exports ?? {};
      for (const [key, value] of Object.entries(packedExports)) {
        const target = String(value).replace(/^\.\//, "");
        check(has(target), `packed export ${key} resolves to tarball file ${target}`);
      }

      const bridge = tarFile("package/spicetify/opencode-spotify-bridge.js") ?? "";
      check(bridge.includes("__OPENCODE_SPOTIFY_SECRET__"),
        "packed bridge keeps the unprovisioned placeholder secret (no real credential)");
      // Review any changed Spotify persisted-query hash separately. Trusting
      // all checkout values would miss a credential in the source template.
      const queryHashes = new Set([
        "b02683192a98dde7966b5e6655a79eeb62713eab703eda9902c932818dd52751",
        "eef7cc54888d91bdd6802623477873caa3948ae173a0c34fd86827b267e94c03",
      ]);
      const packedHex = bridge.match(/[0-9a-f]{64}/gi) ?? [];
      const foreignHex = packedHex.filter((hex) => !queryHashes.has(hex)).length;
      check(foreignHex === 0,
        foreignHex === 0
          ? "packed bridge carries no unexpected 64-hex values"
          : `packed bridge carries ${foreignHex} unexpected 64-hex value(s); inspect the unprovisioned template privately`);

      // Runtime dependency policy: exact hard deps for the server/TUI core,
      // bounded tilde-patch for the Ink stack (exact tolerated during
      // iteration), ^8 retained for ws. Declaration equality packed==checkout
      // holds for the exact set; the tilde set asserts manifest format plus
      // reviewed-lock consistency (WP-C removed the duplicate
      // INK_DEPENDENCIES/INK_UI_DEPENDENCIES from ink.ts; ranges belong in
      // the manifest, so there is nothing left to equate declarations with).
      const checkoutLockEarly = JSON.parse(readFileSync(join(pluginRoot, "package-lock.json"), "utf8"));
      for (const dep of ["@opentui/core", "@opentui/solid", "solid-js", "@opencode/plugin"]) {
        check(typeof packedManifest.dependencies?.[dep] === "string",
          `packed dependencies include ${dep} (got ${packedManifest.dependencies?.[dep] ?? "missing"})`);
        check(packedManifest.peerDependencies?.[dep] === undefined,
          `packed tree does not peer ${dep} (got ${packedManifest.peerDependencies?.[dep] ?? "absent"})`);
        check(packedManifest.peerDependenciesMeta?.[dep] === undefined,
          `packed tree has no optional-peer fiction for ${dep}`);
        check(packedManifest.optionalDependencies?.[dep] === undefined,
          `packed tree does not make ${dep} optional`);
        check(packedManifest.dependencies?.[dep] === manifest.dependencies?.[dep],
          `packed ${dep} matches checkout (${packedManifest.dependencies?.[dep]} vs ${manifest.dependencies?.[dep]})`);
        check(isExactSemver(packedManifest.dependencies?.[dep]),
          `packed ${dep} pin is exact`);
      }
      check(packedManifest.dependencies?.["@opentui/core"] === packedManifest.dependencies?.["@opentui/solid"],
        `core/solid pins match (${packedManifest.dependencies?.["@opentui/core"]} vs ${packedManifest.dependencies?.["@opentui/solid"]})`);
      for (const dep of ["ink", "react", "@inkjs/ui"]) {
        check(typeof packedManifest.dependencies?.[dep] === "string",
          `packed dependencies include ${dep} (got ${packedManifest.dependencies?.[dep] ?? "missing"})`);
        check(packedManifest.peerDependencies?.[dep] === undefined,
          `packed tree does not peer ${dep} (got ${packedManifest.peerDependencies?.[dep] ?? "absent"})`);
        check(packedManifest.peerDependenciesMeta?.[dep] === undefined,
          `packed tree has no optional-peer fiction for ${dep}`);
        check(packedManifest.optionalDependencies?.[dep] === undefined,
          `packed tree does not make ${dep} optional`);
        // Policy satisfaction (not byte equality): the packed pin's base must
        // equal the checkout range's base, so a prebuilt tarball packed while
        // the tree carried exact pins still satisfies a migrated `~` checkout
        // (and vice versa during iteration).
        check(tildeBase(packedManifest.dependencies?.[dep]) === tildeBase(manifest.dependencies?.[dep]),
          `packed ${dep} satisfies checkout policy (${packedManifest.dependencies?.[dep]} vs ${manifest.dependencies?.[dep]})`);
        check(isTildeOrExactPolicy(manifest.dependencies?.[dep]),
          `checkout ${dep} follows the tilde-patch policy (got ${manifest.dependencies?.[dep]})`);
        // Reviewed-lock consistency (no hard-coded versions): same major.minor
        // as the lock resolution, lock patch at or above the manifest floor.
        const locked = checkoutLockEarly.packages?.[`node_modules/${dep}`]?.version;
        check(typeof locked === "string" && locked.length > 0,
          `checkout ${dep} has a reviewed lockfile resolution (got ${locked ?? "missing"})`);
        if (typeof locked === "string") {
          const floor = coreSemver(manifest.dependencies?.[dep]);
          const resolved = coreSemver(locked);
          check(floor.major === resolved.major && floor.minor === resolved.minor,
            `checkout ${dep} stays within its minor under ~ policy (${manifest.dependencies?.[dep]} vs lock ${locked})`);
          check(resolved.patch >= floor.patch,
            `checkout ${dep} lock patch is not below the manifest floor (${manifest.dependencies?.[dep]} vs lock ${locked})`);
        }
      }
      check(packedManifest.dependencies?.ws === manifest.dependencies?.ws && /^\^8\./.test(packedManifest.dependencies?.ws ?? ""),
        `ws stays ^8 (${packedManifest.dependencies?.ws} vs ${manifest.dependencies?.ws})`);

      const checkoutLock = JSON.parse(readFileSync(join(pluginRoot, "package-lock.json"), "utf8"));
      check(checkoutLock.packages?.[""]?.version === manifest.version,
        `lockfile root version matches manifest (${checkoutLock.packages?.[""]?.version} vs ${manifest.version})`);
      check(manifest.private !== true, "package is publishable (private is not true)");
      check(manifest.repository?.directory === "plugin", "repository.directory stays plugin");
    });
    if (failures.length) throw new Error("archive validation failed; consumer install was not attempted");

    timed("install", () => {
      // Fresh isolated consumer install with npm's normal cache
      // revalidation/resolution default (see header note on --prefer-offline).
      // npm pack + isolated --prefix install consumer gate (no publish).
      note("verify-package: installing tarball into an isolated prefix");
      try {
        runNpm(["install", "--prefix", installPrefix, "--ignore-scripts", "--timing",
          "--omit=dev", "--no-audit", "--no-fund", "--logs-dir", installLogs, installTarballPath], {
          cwd: installPrefix, timeout: 240_000,
          env: { ...process.env, npm_config_update_notifier: "false" },
        });
      } finally {
        // npm debug logs and timing metadata can include paths and settings.
        // Keep only known numeric timers and delete the original files.
        const timingFile = readdirSync(installLogs).find((name) => name.endsWith("-timing.json"));
        if (timingFile) {
          try {
            const { timers } = JSON.parse(readFileSync(join(installLogs, timingFile), "utf8"));
            for (const key of ["idealTree", "reify:unpack", "reify", "command:install", "npm"]) {
              if (Number.isFinite(timers?.[key])) npmTimings[key] = timers[key];
            }
          } catch {
            note("  npm timing data unavailable");
          }
        }
        for (const [key, ms] of Object.entries(npmTimings)) note(`  npm ${key}: ${ms}ms`);
      }
    });

    const binTarget = manifest.bin?.["opencode-spotify"]?.replace(/^\.\//, "");
    const installedPkgDir = join(installPrefix, "node_modules", "opencode-spotify");
    const installedBin = join(installedPkgDir, ...binTarget.split("/"));

    timed("installed-cli", () => {
      check(existsSync(installedBin), `installed tree contains ${binTarget}`);

      // ALL early probes run fully isolated (HOME/USERPROFILE/APPDATA/
      // LOCALAPPDATA/XDG_*, no NODE_PATH, no OpenCode overrides).
      const early = isolatedProbeEnv(probeCwd, "early");
      const earlyEnv = early.env;
      const beforeEarly = listFilesRecursive(probeCwd).join("\n");

      const versionOut = run(process.execPath, [installedBin, "--version"], {
        cwd: probeCwd, encoding: "utf8", timeout: 60_000, windowsHide: true, env: earlyEnv,
      }).trim();
      check(versionOut === manifest.version,
        `installed bin --version reports ${manifest.version} (got ${JSON.stringify(versionOut)})`);

      const helpOut = run(process.execPath, [installedBin, "--help"], {
        cwd: probeCwd, encoding: "utf8", timeout: 60_000, windowsHide: true, env: earlyEnv,
      });
      check(/Usage:/.test(helpOut) && /opencode-spotify/.test(helpOut),
        "installed bin --help prints usage from an unrelated cwd");
      check(/--plain/.test(helpOut) && /--no-ink/.test(helpOut) && /-v, --version/.test(helpOut),
        "installed --help documents --plain, --no-ink and -v flags");
      assertNoWrites("installed --version/--help", early.roots);
      check(listFilesRecursive(probeCwd).join("\n") === beforeEarly,
        "installed --version/--help write no cwd/home/config state");
    });
    if (failures.length) throw new Error("installed CLI checks failed; consumer probes were not attempted");

    timed("consumer-gate", () => {
      // consumer-TUI gate: the packed tree must work in a plain consumer
      // install with no access to this repo's node_modules. Loader verdict
      // (on-disk SDK/host code): the host does NOT inject @opentui/* or
      // solid-js into TUI module scope. Bare specifiers resolve
      // importer-relative from the plugin's own node_modules, so missing
      // runtime deps kill the TUI while the server (which never imports
      // OpenTUI) keeps loading.
      //
      // Fail-closed: every consumer check below runs in a child process with
      // cwd outside the repo and NODE_PATH removed, so repo devDependencies
      // can never satisfy the plugin's own imports. Supplying the TUI runtime
      // via a mock is forbidden as proof: resolution must succeed from the
      // installed tree itself.
      note("verify-package: consumer-TUI gate (isolated prefix, no dev node_modules)");
      note("  note: @opentui/core declares engines node>=26.4.0, so npm prints an EBADENGINE warning on Node 22/24 (engine-strict defaults false; the install succeeds). The TUI executes under the host Bun, so this is install-metadata friction only.");
      const installedModules = join(installPrefix, "node_modules");
      const hasInstalled = (name) => existsSync(join(installedModules, ...name.split("/"))) ||
        existsSync(join(installedPkgDir, "node_modules", ...name.split("/")));
      for (const dep of ["ink", "react", "@inkjs/ui", "@opentui/core", "@opentui/solid", "solid-js", "ws", "@opencode/plugin"]) {
        check(hasInstalled(dep), `consumer install (--omit=dev) carries runtime dependency ${dep}`);
      }
      // typescript is a legitimate transitive of @opentui/core -> bun-ffi-structs.
      for (const dep of ["ink-testing-library", "@types/react"]) {
        check(!hasInstalled(dep), `consumer install (--omit=dev) excludes dev-only ${dep}`);
      }
      const consumerIso = isolatedProbeEnv(probeCwd, "consumer");
      const consumerEnv = consumerIso.env;
      delete consumerEnv.NODE_PATH;
      const runConsumer = (file, args, options = {}) => run(file, args, {
        cwd: probeCwd, encoding: "utf8", timeout: 180_000, windowsHide: true, env: consumerEnv, ...options,
      });

      // Installed Ink shell never statically imports ink; plain fallback works.
      const installedInkSource = readFileSync(join(installedPkgDir, "dist", "cli", "ui", "ink.js"), "utf8");
      check(/\["in",\s*"k"\]\.join/.test(installedInkSource) &&
        !/from\s+["']ink["']/.test(installedInkSource),
        "installed Ink shell never statically imports ink (plain fallback stays loadable)");
      try {
        const plainProbe = [
          `const mode = await import(process.argv[1]);`,
          `const io = { stdoutTTY: true, stdinTTY: true, env: {} };`,
          `if (mode.selectUiMode({ plain: true }, io) !== "plain") throw new Error("plain flag");`,
          `if (mode.selectUiMode({ json: true }, io) !== "json") throw new Error("json flag");`,
          `if (mode.selectUiMode({}, { ...io, stdoutTTY: false }) !== "plain") throw new Error("non-tty");`,
          `console.log("plain fallback selected");`,
        ].join("");
        const plainOut = runConsumer(process.execPath,
          ["--input-type=module", "-e", plainProbe,
            pathToFileURL(join(installedPkgDir, "dist", "cli", "ui-mode.js")).href]);
        check(plainOut.includes("plain fallback selected"),
          "installed plain/json mode selection works without loading Ink");
      } catch (error) {
        failures.push(`installed plain fallback failed: ${sanitizeMessage(error instanceof Error ? error.message : String(error)).slice(0, 200)}`);
      }

      // Statically enumerate every bare runtime import the packed code needs,
      // including side-effect-only `import "x"` / `export ... from "x"` forms.
      // The trailing quote stays outside the alternation so dynamic
      // `import(IDENTIFIER)` (no string literal) can never match; the export
      // arm is single-line so it cannot span statements. Packed src/dist/bin
      // are scanned with comments stripped (prose such as `from "unknown"` in
      // a comment must not phantom-require); node/bun builtins and @types are
      // skipped, relative imports travel with the pack.
      const SPECIFIER_PATTERN = /(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+|export\s+[^"'\n]*?from\s+)["']([^"'./][^"']*)["']/g;
      const stripComments = (text) => text
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/(^|[^\S:])\/\/[^\n]*/g, "$1 ");
      const listPackedSources = (dir, out = []) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name);
          if (entry.isDirectory()) { if (entry.name !== "node_modules") listPackedSources(full, out); }
          else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) out.push(full);
        }
        return out;
      };
      const needed = new Set();
      for (const sub of ["src", "dist", "bin"]) {
        const dir = join(installedPkgDir, sub);
        if (!existsSync(dir)) continue;
        for (const file of listPackedSources(dir)) {
          const text = stripComments(readFileSync(file, "utf8"));
          let match;
          SPECIFIER_PATTERN.lastIndex = 0;
          while ((match = SPECIFIER_PATTERN.exec(text))) {
            const spec = match[1];
            if (spec.startsWith("node:") || spec.startsWith("bun:") || spec.startsWith("@types/")) continue;
            needed.add(spec);
          }
        }
      }
      const neededSpecs = [...needed].sort();
      check(neededSpecs.length > 0,
        `enumerated packed runtime imports (${neededSpecs.slice(0, 20).join(", ") || "none"}${neededSpecs.length > 20 ? `, +${neededSpecs.length - 20} more` : ""})`);
      // The gate is vacuous unless the packed code really imports the TUI
      // runtime. (@opentui/solid ships the JSX transform runtime rather than a
      // bare import; it is pinned by the manifest above and exercised by the
      // Bun render smoke below.)
      for (const dep of ["@opentui/core", "solid-js"]) {
        check(neededSpecs.some((spec) => spec === dep || spec.startsWith(`${dep}/`)),
          `packed code actually imports ${dep} (gate would be vacuous otherwise)`);
      }

      // Every needed specifier must resolve from the installed tree itself.
      // ESM resolution (import.meta.resolve) is the faithful semantic: the host
      // loads these as ESM, and CJS require.resolve cannot even resolve
      // "@opencode/plugin" (its exports map has no CJS main). The -e probe
      // resolves relative to cwd, so it runs with cwd inside the installed
      // tree — still outside the repo, still with NODE_PATH removed.
      // Per-specifier try/catch keeps one unresolvable spec from hiding the
      // rest; failures print as `failed <spec>` and fail their check below.
      const resolveProbe = "const specs=JSON.parse(process.argv[1]);" +
        "for (const spec of specs) { try { console.log(`resolved ${spec} -> ${import.meta.resolve(spec)}`); }" +
        " catch (e) { console.log(`failed ${spec}`); } }";
      let resolvedOut = "";
      try {
        resolvedOut = timed("bare-import-resolution", () => runConsumer(process.execPath,
          ["--input-type=module", "-e", resolveProbe, JSON.stringify(neededSpecs)],
          { cwd: installedPkgDir }));
      } catch (error) {
        failures.push(`consumer resolution failed from the installed tree: ${sanitizeMessage(error instanceof Error ? error.message : String(error)).slice(0, 200)}`);
      }
      const isolatedPrefix = `${realpathSync(installPrefix).toLowerCase()}${sep}`;
      for (const spec of neededSpecs) {
        check(resolvedOut.includes(`resolved ${spec}`),
          `consumer install resolves ${spec} (no dev node_modules, no mocks)`);
      }
      // Containment: every ESM-resolved file must live under the isolated
      // prefix — a resolution escaping to the repo, global cache, or Bun's
      // install cache would prove the consumer tree is incomplete.
      const resolvedTargets = [...resolvedOut.matchAll(/resolved \S+ -> (\S+)/g)].map((m) => m[1]);
      const escaped = resolvedTargets.filter((url) => {
        if (!url.startsWith("file:")) return true;
        try {
          const p = realpathSync(fileURLToPath(url)).toLowerCase();
          return !p.startsWith(isolatedPrefix);
        } catch {
          return true;
        }
      });
      check(resolvedTargets.length === neededSpecs.length,
        `resolution probe answered every specifier (${resolvedTargets.length}/${neededSpecs.length})`);
      check(escaped.length === 0,
        escaped.length === 0
          ? "all ESM-resolved files are contained in the isolated prefix"
          : `${escaped.length} ESM resolution(s) escaped the isolated prefix`);

      // Actually load the packed server entry in plain Node. Packed sources use
      // extensionless relative imports (host-resolvable); plain Node needs a
      // host-faithful extension fill-in (.ts/.tsx/index) applied to relative
      // specifiers only — bare package specifiers resolve normally from the
      // installed tree. Helper files live in the probe dir (outside the repo)
      // and are invoked by basename, the one invocation shape proven reliable
      // for file entries on Windows.
      const hooksSource = [
        `import { statSync } from "node:fs";`,
        `import { fileURLToPath, pathToFileURL } from "node:url";`,
        `import path from "node:path";`,
        `const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };`,
        `export async function resolve(specifier, context, next) {`,
        `  let original;`,
        `  try { return await next(specifier, context); } catch (err) { original = err; }`,
        `  const relative = specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("file:");`,
        `  if (!relative) throw original;`,
        `  let base;`,
        `  if (specifier.startsWith("file:")) { base = fileURLToPath(specifier); }`,
        `  else {`,
        `    if (!context.parentURL || !context.parentURL.startsWith("file:")) throw original;`,
        `    base = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier);`,
        `  }`,
        `  const candidates = [base, base + ".ts", base + ".tsx", path.join(base, "index.ts"), path.join(base, "index.tsx")];`,
        `  for (const candidate of candidates) {`,
        `    if (isFile(candidate)) return { url: pathToFileURL(candidate).href, shortCircuit: true };`,
        `  }`,
        `  throw original;`,
        `}`,
        ``,
      ].join("\n");
      // Plain-Node loads must not target files under any node_modules segment:
      // Node refuses type-stripping there
      // (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING) while the host
      // (Bun/opencode) strips anywhere. Copy the installed package verbatim
      // beside node_modules — its bare imports still resolve upward into the
      // same isolated node_modules, so isolation is unchanged.
      const consumerPkgDir = join(installPrefix, "consumer-pkg");
      cpSync(installedPkgDir, consumerPkgDir, { recursive: true });
      check(existsSync(join(consumerPkgDir, "src", "index.ts")) &&
        existsSync(join(consumerPkgDir, "src", "tui.tsx")),
        "consumer package copy carries the packed server and TUI entries");
      const hooksPath = join(probeCwd, "consumer-resolve-hooks.mjs");
      const registerPath = join(probeCwd, "consumer-register-hooks.mjs");
      const installedIndexUrl = pathToFileURL(join(consumerPkgDir, "src", "index.ts")).href;
      const installedStateUrl = pathToFileURL(join(consumerPkgDir, "src", "services", "state.ts")).href;
      writeFileSync(hooksPath, hooksSource);
      writeFileSync(registerPath,
        `import { register } from "node:module";\nregister(${JSON.stringify(pathToFileURL(hooksPath).href)});\n`);
      writeFileSync(join(probeCwd, "consumer-load-server.mjs"),
        `const mod = await import(${JSON.stringify(installedIndexUrl)});\n` +
        `if (!mod || mod.default == null) throw new Error("packed server entry has no default export");\n` +
        `if (mod.default.id !== "opencode-spotify") throw new Error("packed server entry id mismatch");\n` +
        `if (typeof mod.default.setup !== "function") throw new Error("packed server entry has no setup");\n` +
        `console.log("consumer server entry loaded");\n`);
      writeFileSync(join(probeCwd, "consumer-helper-smoke.mjs"),
        `import assert from "node:assert/strict";\n` +
        `const mod = await import(${JSON.stringify(installedStateUrl)});\n` +
        `assert.ok(mod.connectionLabel(mod.initialState()).includes("Waiting for Spotify"));\n` +
        `const errState = { ...mod.initialState(), connection: "error", error: "spicetify not installed" };\n` +
        `assert.ok(mod.shortConnectionLabel(errState).includes("No extension"));\n` +
        `console.log("consumer helper smoke passed");\n`);
      try {
        const serverOut = timed("server-load", () => runConsumer(process.execPath,
          ["--no-warnings", "--import", pathToFileURL(registerPath).href, "consumer-load-server.mjs"]));
        check(serverOut.includes("consumer server entry loaded"),
          "packed server entry loads in plain Node from the installed tree (id opencode-spotify, setup fn)");
      } catch (error) {
        failures.push(`UNVERIFIED: packed server entry did not load in plain Node (mandatory physical QA before release): ${sanitizeMessage(error instanceof Error ? error.message : String(error)).slice(0, 200)}`);
      }
      try {
        const helperOut = runConsumer(process.execPath, ["consumer-helper-smoke.mjs"], { timeout: 60_000 });
        check(helperOut.includes("consumer helper smoke passed"),
          "installed pure helper executes (connection-label logic from installed files)");
      } catch (error) {
        failures.push(`UNVERIFIED: installed helper smoke did not run (mandatory physical QA before release): ${sanitizeMessage(error instanceof Error ? error.message : String(error)).slice(0, 200)}`);
      }
      assertNoWrites("server/helper smokes", consumerIso.roots);
    });
    if (failures.length) throw new Error("consumer-gate checks failed; TUI smoke was not attempted");

    timed("tui-smoke", () => {
      const consumerPkgDir = join(installPrefix, "consumer-pkg");
      const tuiIso = isolatedProbeEnv(probeCwd, "tui");
      const consumerEnv = tuiIso.env;
      delete consumerEnv.NODE_PATH;
      const runConsumer = (file, args, options = {}) => run(file, args, {
        cwd: probeCwd, encoding: "utf8", timeout: 240_000, windowsHide: true, env: consumerEnv, ...options,
      });
      // Load the packed TUI entry the host-compatible way and run a meaningful
      // render smoke from the installed tree. tsx/type-stripping will not run
      // under plain node for .tsx, so this uses the same Bun +
      // @opentui/solid/preload harness the repo's render fixtures use — pointed
      // at the INSTALLED package files, never the repo.
      //
      // Single-copy isolation: EVERYTHING the fixture touches (the @opentui/solid
      // harness, its preload plugin, solid-js, @opentui/core and the plugin
      // files) is imported by ABSOLUTE installed-tree path from the isolated
      // prefix. Bare imports inside the installed files resolve importer-relative
      // upward from the isolated prefix, which contains only the packed
      // tarball's real dependencies. The static enumeration above shows packed
      // code imports only bare specifiers, so no fixture path can leak.
      let bunAvailable = true;
      try {
        runConsumer("bun", ["--version"], { timeout: 60_000 });
      } catch {
        bunAvailable = false;
        failures.push("UNVERIFIED: bun is not on PATH, so the packed TUI entry could not be loaded and the render smoke did not run (mandatory physical QA on a Bun host before release)");
      }
      if (bunAvailable) {
        const isolatedPosix = installPrefix.split(sep).join("/");
        const consumerPosix = consumerPkgDir.split(sep).join("/");
        const harnessEntry = `${isolatedPosix}/node_modules/@opentui/solid/index.bun.js`;
        check(existsSync(join(installPrefix, "node_modules", "@opentui", "solid", "index.bun.js")),
          "isolated tree carries the @opentui/solid harness used for the TUI smoke");
        const fixturePath = join(probeCwd, "consumer-tui-smoke.tsx");
        // Custom preload: same solid transform the repo fixtures get from
        // @opentui/solid/preload, but its injected JSX-runtime import
        // (moduleName "@opentui/solid") is rewritten into the ISOLATED tree.
        // Without this, the injected bare import resolves from the fixture's
        // location (probe dir: no node_modules above it) and falls through to
        // Bun's global install cache — whose @opentui/solid copy has no
        // solid-js sibling — instead of the consumer's own node_modules.
        const preloadPath = join(probeCwd, "consumer-solid-preload.mjs");
        writeFileSync(preloadPath, [
          `import { ensureSolidTransformPlugin } from ${JSON.stringify(`${isolatedPosix}/node_modules/@opentui/solid/scripts/solid-plugin.js`)};`,
          `const isolated = ${JSON.stringify(`${isolatedPosix}/node_modules`)};`,
          `ensureSolidTransformPlugin({`,
          `  moduleName: "@opentui/solid",`,
          `  resolvePath: (specifier) => {`,
          `    if (specifier === "@opentui/solid") return isolated + "/@opentui/solid/index.bun.js";`,
          `    if (specifier === "@opentui/solid/jsx-runtime") return isolated + "/@opentui/solid/jsx-runtime.js";`,
          `    if (specifier === "@opentui/solid/jsx-dev-runtime") return isolated + "/@opentui/solid/jsx-dev-runtime.js";`,
          `    return specifier;`,
          `  },`,
          `});`,
          ``,
        ].join("\n"));
        writeFileSync(fixturePath, [
          `import assert from "node:assert/strict";`,
          `import { testRender, useRenderer } from "${harnessEntry}";`,
          `import { MiniPlayer } from "${consumerPosix}/src/components/MiniPlayer.tsx";`,
          `import { initialState } from "${consumerPosix}/src/services/state.ts";`,
          `import { emptyLyrics } from "${consumerPosix}/src/services/lyrics.ts";`,
          `import { defaultLyricsSettings } from "${consumerPosix}/src/services/lyrics-source.ts";`,
          `import { commands } from "${consumerPosix}/src/services/validation.ts";`,
          ``,
          `const uri = "spotify:track:1234567890123456789012";`,
          `function Harness() {`,
          `  const renderer = useRenderer();`,
          `  const state = () => ({`,
          `    ...initialState(),`,
          `    connection: "connected",`,
          `    track: { uri, title: "Installed Title", artist: "Installed Artist", album: "A", image: "" },`,
          `    playback: { ...initialState().playback, trackUri: uri, durationMs: 200000, isPlaying: true },`,
          `    capabilities: { protocol: 2, apis: {}, commands: [...commands], search_mode: null },`,
          `  });`,
          `  const context = {`,
          `    renderer, theme: { text: { base: "#eef2ec", muted: "#a6afa7" } },`,
          `    keymap: { layer() {} }, ui: { toast: { show() {} }, dialog: { clear() {} } }, options: {},`,
          `    data: { location: { default: () => ({ directory: "consumer-smoke" }) } },`,
          `  } as any;`,
          `  return (`,
          `    <box width="100%" height="100%">`,
          `      <MiniPlayer`,
          `        context={context} state={state} lyrics={() => emptyLyrics(uri)} position={() => 100}`,
          `        settings={() => defaultLyricsSettings()} sources={() => null} saveSettings={async () => {}}`,
          `        refreshLyrics={async () => {}} rpc={{} as never}`,
          `        budget={() => 18} open={() => {}} openLyrics={() => {}} openSettings={() => {}} more={() => {}}`,
          `        run={async () => true}`,
          `      />`,
          `    </box>`,
          `  );`,
          `}`,
          `const tui = await import("${consumerPosix}/src/tui.tsx");`,
          `assert.ok(tui && tui.default != null, "packed TUI entry has a default export");`,
          `assert.equal(tui.default.id, "opencode-spotify.tui", "packed TUI entry keeps its plugin id");`,
          `assert.equal(typeof tui.default.setup, "function", "packed TUI entry exposes setup");`,
          `console.log("consumer TUI entry loaded");`,
          `const setup = await testRender(() => <Harness />, { width: 40, height: 24 });`,
          `try {`,
          `  await setup.flush();`,
          `  const frame = setup.captureCharFrame();`,
          `  assert.ok(frame.includes("Installed Title"), "installed MiniPlayer renders the track title\\n" + frame);`,
          `  assert.ok(frame.includes("Installed Artist"), "installed MiniPlayer renders the track artist\\n" + frame);`,
          `  assert.ok(frame.includes("Music"), "installed MiniPlayer renders navigation\\n" + frame);`,
          `  console.log("consumer TUI render smoke passed");`,
          `} finally {`,
          `  await setup.dispose();`,
          `}`,
          ``,
        ].join("\n"));
        try {
          const bunOut = run("bun", ["--preload", preloadPath.split(sep).join("/"),
            fixturePath.split(sep).join("/")], {
            cwd: probeCwd, encoding: "utf8", timeout: 240_000, windowsHide: true, env: consumerEnv,
          });
          check(bunOut.includes("consumer TUI entry loaded"),
            "packed TUI entry loads under the host Bun toolchain from the installed tree (id opencode-spotify.tui, setup fn)");
          check(bunOut.includes("consumer TUI render smoke passed"),
            "installed MiniPlayer renders (title + artist + nav) with no dev node_modules");
          // Bun's own bytecode pile cache under XDG_CACHE_HOME/bun is
          // toolchain-owned (like npm's cache), not plugin state — exclude it.
          assertNoWrites("packed TUI render smoke", tuiIso.roots, [join(tuiIso.roots.cache, "bun")]);
        } catch (error) {
          failures.push(`UNVERIFIED: packed TUI load/render smoke failed (mandatory physical QA on a Bun host before release): ${sanitizeMessage(error instanceof Error ? error.message : String(error)).slice(0, 200)}`);
        }
      }
    });
    if (failures.length) throw new Error("prior gate checks failed; provisioning smoke was not attempted");

    timed("provision-smoke", () => {
      // Packed provisioning smoke: exercise the installed PS1 helper and the
      // compiled provisioner against a fake Spicetify config in a temp APPDATA.
      // This never touches the developer's Spotify, Spicetify, or OpenCode.
      // Both stdout AND stderr are captured and proven secret-free; neither
      // stream is printed (counts only, never values).
      const smoke = join(scratchRoot, "provision");
      mkdirSync(smoke, { recursive: true });
      try {
        const appData = join(smoke, "AppData", "Roaming");
        const spicetifyDir = join(appData, "spicetify");
        const extensionsDir = join(spicetifyDir, "Extensions");
        mkdirSync(extensionsDir, { recursive: true });
        const config = join(spicetifyDir, "config-xpui.ini");
        writeFileSync(config, "[AdditionalOptions]\nextensions = other.js\n");
        writeFileSync(join(extensionsDir, "other.js"), "// unrelated extension\n");
        const fake = join(smoke, "fake-spicetify.cmd");
        writeFileSync(fake, `@echo off\r\nif "%1"=="-c" echo ${config}\r\nexit /b 0\r\n`);
        const installedScript = join(installPrefix, "node_modules", "opencode-spotify", "scripts", "install-extension.ps1");
        const provIso = isolatedProbeEnv(probeCwd, "provision");
        const env = {
          ...provIso.env, APPDATA: appData, LOCALAPPDATA: join(smoke, "AppData", "Local"),
          TEST_SPICETIFY_CONFIG: config,
        };
        mkdirSync(env.LOCALAPPDATA, { recursive: true });
        const proc = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", installedScript,
          "-Install", "-Yes", "-SkipApply", "-SpicetifyPath", fake], {
          cwd: probeCwd, encoding: "utf8", timeout: 120_000, windowsHide: true, env, shell: false,
        });
        const combined = `${proc.stdout ?? ""}\n${proc.stderr ?? ""}`;
        check(proc.status === 0, `packed provisioner exits 0 (got ${proc.status})`);
        const bridgePath = join(extensionsDir, "opencode-spotify-bridge.js");
        check(existsSync(bridgePath), "packed bridge installer created the extension in the isolated prefix");
        const credentialPath = join(appData, "opencode-spotify", "bridge.json");
        check(existsSync(credentialPath), "packed bridge installer created credentials in the isolated prefix");
        const configText = readFileSync(config, "utf8");
        check(/extensions\s*=.*other\.js/.test(configText) && /extensions\s*=.*opencode-spotify-bridge\.js/.test(configText),
          "packed installer preserves the unrelated extension and registers the bridge");
        const secret = JSON.parse(readFileSync(credentialPath, "utf8")).secret;
        check(typeof secret === "string" && /^[a-f0-9]{64}$/.test(secret), "packed installer generated a valid secret shape");
        check(readFileSync(bridgePath, "utf8").includes(secret), "packed extension received the generated secret");
        check(!combined.includes(secret), "packed installer output does not print the secret");
        check(!/ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING/.test(combined),
          "packed provisioner runs without node_modules type stripping");
        const hexHits = (combined.match(/[0-9a-f]{64}/g) ?? []).length;
        check(hexHits === 0,
          hexHits === 0
            ? "combined provisioning stdout+stderr carry no 64-hex secret (0 hits)"
            : `combined provisioning output carries ${hexHits} 64-hex hit(s) (counts only, values redacted)`);
        assertNoWrites("provisioning smoke isolation dirs", provIso.roots,
          // pwsh's NonInteractive startup-profile cache under the redirected
          // home is shell-toolchain-owned, not plugin state — exclude it.
          [join(provIso.roots.home, "AppData", "Local", "Microsoft", "PowerShell")]);
      } catch (error) {
        failures.push(`UNVERIFIED: packed provisioning smoke failed: ${sanitizeMessage(error instanceof Error ? error.message : String(error)).slice(0, 200)}`);
      }
    });

    if (!failures.length && keepDir && tarballPath && tarballBytes) {
      timed("retain", () => {
        const resolvedKeepDir = resolve(pluginRoot, keepDir);
        const base = basename(tarballPath);
        const record = retainArtifact(resolvedKeepDir, base, tarballBytes);
        note(`verify-package: retained exact verified tarball at ${record.path}${record.reused ? " (byte-identical re-use)" : ""}`);
        note(`verify-package: retained sha256 ${record.sha256}`);
        note(`verify-package: retained integrity ${record.integrity}`);
      });
    }
  } catch (error) {
    failures.push(error instanceof Error ? `exception: ${sanitizeMessage(error.message)}` : `exception: ${sanitizeMessage(String(error))}`);
  } finally {
    try {
      timed("cleanup", () => rmSync(scratchRoot, { recursive: true, force: true, maxRetries: 3 }));
      note("verify-package: scratch root removed");
    } catch (error) {
      failures.push(`cleanup: scratch root removal failed: ${sanitizeMessage(error.message)}`);
    }

    // Emit only summary data outside the scratch root.
    try {
      const report = {
        version: manifest.version,
        mode: tarballArg ? "prebuilt-trusted-only" : "build",
        tarball: tarballPath && basename(tarballPath),
        sha256: tarballBytes ? createHash("sha256").update(tarballBytes).digest("hex") : null,
        stages,
        npm: npmTimings,
        failures: failures.length,
      };
      const summary = [
        `### verify-package ${manifest.version}`,
        ``,
        `- mode: \`${report.mode}\``,
        `- sha256: \`${report.sha256 ?? "(none)"}\``,
        ...Object.entries(stages).map(([name, ms]) => `- stage ${name}: ${ms}ms`),
        ...Object.entries(npmTimings).map(([name, ms]) => `- npm ${name}: ${ms}ms`),
        `- failures: ${failures.length}`,
        ``,
      ].join("\n");
      if (logsDirOpt) {
        mkdirSync(logsDir, { recursive: true });
        writeFileSync(join(logsDir, "verify-stages.json"), `${JSON.stringify(report, null, 2)}\n`);
        writeFileSync(join(logsDir, "verify-summary.md"), summary);
      }
      const stepSummary = process.env.GITHUB_STEP_SUMMARY;
      if (stepSummary) {
        try {
          appendFileSync(stepSummary, `${summary}\n`);
        } catch { /* summary is best-effort */ }
      }
    } catch { /* timing report never fails the gate */ }
  }

  if (failures.length) {
    process.stderr.write(`verify-package: FAILED (${failures.length})\n`);
    for (const failure of failures) process.stderr.write(`  missing: ${sanitizeMessage(failure).slice(0, 300)}\n`);
    return 1;
  }
  process.stdout.write("verify-package: PASSED\n");
  return 0;
}

process.exitCode = main();
