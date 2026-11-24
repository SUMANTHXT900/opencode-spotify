#!/usr/bin/env node
/**
 * V0.6.0 packed-package verification.
 *
 * Builds a real tarball with `npm pack` (no publish), asserts the packed file
 * list is exactly what distribution intends, installs the tarball into an
 * isolated temp prefix with `--ignore-scripts`, and runs the installed CLI's
 * side-effect-free `--version` / `--help` from an unrelated working directory.
 *
 * Safety properties (also enforced by CI):
 * - Never references the registry package name: the tarball is addressed by
 *   absolute local file path only (`npm install <abs path to .tgz>`).
 * - Never touches global npm state (no `-g`), Spotify, Spicetify, or any
 *   OpenCode configuration. `--version` / `--help` exit before environment
 *   detection runs (see src/cli/main.ts).
 * - All temp state is removed, even on failure.
 *
 * Run from the package directory: `node scripts/verify-package.mjs`
 * or via `npm run verify:package`.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(here, "..");

const failures = [];
function check(condition, message) {
  if (!condition) failures.push(message);
  else process.stdout.write(`  ok: ${message}\n`);
}

function run(file, args, options) {
  return execFileSync(file, args, {
    cwd: pluginRoot,
    encoding: "utf8",
    timeout: 180_000,
    windowsHide: true,
    // .cmd shims (npm.cmd) need a shell on Windows; argv array keeps it safe.
    shell: process.platform === "win32",
    ...options,
  });
}

// `npm` is a .cmd shim on Windows, which execFileSync cannot resolve without
// a shell. CI runs this script on windows-2025, so pick the real executable.
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";

/**
 * Minimal tar listing without external dependencies. npm tarballs are gzipped
 * ustar archives; entry names live in the 512-byte header (name 0:100, prefix
 * 345:500 for ustar) with octal size at 124:136.
 */
function listTarballEntries(tgzPath) {
  const raw = gunzipSync(readFileSync(tgzPath));
  const entries = [];
  let offset = 0;
  while (offset + 512 <= raw.length) {
    const header = raw.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/s, "");
    const fullName = prefix ? `${prefix}/${name}` : name;
    const sizeText = header.subarray(124, 136).toString("utf8").replace(/\0.*$/s, "").trim();
    const size = sizeText ? Number.parseInt(sizeText, 8) : 0;
    const typeFlag = String.fromCharCode(header[156]);
    entries.push({ name: fullName.replace(/\\/g, "/"), size: Number.isNaN(size) ? 0 : size, type: typeFlag });
    offset += 512 + Math.ceil((Number.isNaN(size) ? 0 : size) / 512) * 512;
  }
  return entries;
}

/** Extract a single file's text from the gzipped tarball (pure JS). */
function readTarballFile(tgzPath, wanted) {
  const raw = gunzipSync(readFileSync(tgzPath));
  let offset = 0;
  while (offset + 512 <= raw.length) {
    const header = raw.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/s, "");
    const fullName = (prefix ? `${prefix}/${name}` : name).replace(/\\/g, "/");
    const sizeText = header.subarray(124, 136).toString("utf8").replace(/\0.*$/s, "").trim();
    const size = sizeText ? Number.parseInt(sizeText, 8) : 0;
    const dataStart = offset + 512;
    if (fullName === wanted) return raw.subarray(dataStart, dataStart + size).toString("utf8");
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return null;
}

function main() {
  process.stdout.write("verify-package: packing opencode-spotify (no publish)\n");
  const manifest = JSON.parse(readFileSync(join(pluginRoot, "package.json"), "utf8"));
  process.stdout.write("verify-package: building compiled CLI\n");
  run("npm", ["run", "build:cli"]);

  check(manifest.name === "opencode-spotify", `package name is opencode-spotify (got ${manifest.name})`);
  check(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(manifest.version ?? ""),
    `package version is semver (got ${manifest.version})`);
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

  const packDir = mkdtempSync(join(tmpdir(), "spotify-pack-"));
  const installPrefix = mkdtempSync(join(tmpdir(), "spotify-install-"));
  const probeCwd = mkdtempSync(join(tmpdir(), "spotify-probe-"));
  let tarballPath = null;
  try {
    const packed = JSON.parse(run(NPM, ["pack", "--json", "--pack-destination", packDir, "--ignore-scripts"]));
    const filename = packed?.[0]?.filename;
    check(typeof filename === "string" && filename.endsWith(".tgz"),
      `npm pack produced a tarball (${filename ?? "none"})`);
    if (!filename) return 1;
    tarballPath = join(packDir, filename);
    check(existsSync(tarballPath), `tarball exists at ${tarballPath}`);
    const digest = createHash("sha256").update(readFileSync(tarballPath)).digest("hex");
    process.stdout.write(`  tarball: ${filename} (sha256 ${digest.slice(0, 16)}…)\n`);

    // Never resolve the published name: from here on only the local file path.
    check(!tarballPath.includes("node_modules"), "tarball path is a local pack, not a registry resolution");

    const entries = listTarballEntries(tarballPath).filter((entry) => entry.type !== "5");
    const names = entries.map((entry) => entry.name.replace(/^package\//, ""));
    const has = (suffix) => names.some((name) => name === suffix);

    for (const required of [
      "package.json",
      "README.md",
      "LICENSE",
      "src/index.ts",
      "src/tui.tsx",
      "src/rpc.ts",
      "dist/cli/main.js",
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
    // src/services/credentials.ts, and /(\.|^)key$/i would match words like
    // "monkey". Source files such as src/services/credentials.ts must pass.
    const forbidden = [
      /(^|\/)tests?(\/|$)/, // packed tests or fixtures
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
        : `tarball leaks sensitive/stray paths: ${violations.join("; ")}`);

    const packedManifest = JSON.parse(readTarballFile(tarballPath, "package/package.json") ?? "{}");
    check(packedManifest.name === "opencode-spotify", "packed package.json keeps the name");
    check(packedManifest.version === manifest.version, `packed version matches checkout (${manifest.version})`);
    const compat = JSON.parse(readTarballFile(tarballPath, "package/compat.json") ?? "{}");
    check(compat.minimum?.node === (manifest.engines?.node ?? "").replace(/^>=\s*/, ""),
      `compat.json Node minimum matches engines (${compat.minimum?.node} vs ${manifest.engines?.node})`);
    check(compat.bridge?.protocol === 2 && compat.bridge?.handshake === "auto-1" && compat.bridge?.port === 18765,
      "compat.json pins bridge protocol 2 / auto-1 / port 18765");
    const packedBin = (packedManifest.bin?.["opencode-spotify"] ?? "").replace(/^\.\//, "");
    check(packedBin === binTarget, `packed bin target matches (${packedBin || "missing"})`);
    const binSource = readTarballFile(tarballPath, `package/${binTarget}`);
    check(typeof binSource === "string" && binSource.startsWith("#!/usr/bin/env node"),
      "packed bin entry has a node shebang");
    const compiledMain = readTarballFile(tarballPath, "package/dist/cli/main.js") ?? "";
    check(compiledMain.includes("./setup.js") && !compiledMain.includes("./setup.ts"),
      "compiled CLI imports emitted .js modules (no node_modules type stripping)");
    const compiledProvision = readTarballFile(tarballPath, "package/dist/scripts/provision.js") ?? "";
    check(compiledProvision.includes("../src/services/credentials.js") && !compiledProvision.includes("../src/services/credentials.ts"),
      "compiled provisioner imports emitted .js credentials (no node_modules type stripping)");

    const packedExports = packedManifest.exports ?? {};
    for (const [key, value] of Object.entries(packedExports)) {
      const target = String(value).replace(/^\.\//, "");
      check(has(target), `packed export ${key} resolves to tarball file ${target}`);
    }

    const bridge = readTarballFile(tarballPath, "package/spicetify/opencode-spotify-bridge.js") ?? "";
    check(bridge.includes("__OPENCODE_SPOTIFY_SECRET__"),
      "packed bridge keeps the unprovisioned placeholder secret (no real credential)");
    // The bridge legitimately ships two Spotify persisted-query sha256 hashes;
    // anything else 64-hex would look like a substituted installation secret.
    const knownHashes = new Set([
      "b02683192a98dde7966b5e6655a79eeb62713eab703eda9902c932818dd52751",
      "eef7cc54888d91bdd6802623477873caa3948ae173a0c34fd86827b267e94c03",
    ]);
    const straySecrets = (bridge.match(/[0-9a-f]{64}/g) ?? []).filter((hex) => !knownHashes.has(hex));
    check(straySecrets.length === 0,
      straySecrets.length === 0
        ? "packed bridge carries no substituted 64-hex secret"
        : `packed bridge carries unexpected 64-hex values: ${straySecrets.join(", ")}`);

    process.stdout.write("verify-package: installing tarball into an isolated prefix\n");
    execFileSync(NPM, ["install", "--prefix", installPrefix, "--ignore-scripts",
      "--no-audit", "--no-fund", tarballPath], {
      cwd: pluginRoot, encoding: "utf8", timeout: 240_000, windowsHide: true,
      shell: process.platform === "win32",
      env: { ...process.env, npm_config_update_notifier: "false" },
    });
    const installedBin = join(installPrefix, "node_modules", "opencode-spotify",
      binTarget.split("/").join(sep));
    check(existsSync(installedBin), `installed tree contains ${binTarget}`);

    const versionOut = execFileSync(process.execPath, [installedBin, "--version"], {
      cwd: probeCwd, encoding: "utf8", timeout: 60_000, windowsHide: true,
    }).trim();
    check(versionOut === manifest.version,
      `installed bin --version reports ${manifest.version} (got ${JSON.stringify(versionOut)})`);

    const helpOut = execFileSync(process.execPath, [installedBin, "--help"], {
      cwd: probeCwd, encoding: "utf8", timeout: 60_000, windowsHide: true,
    });
    check(/Usage:/.test(helpOut) && /opencode-spotify/.test(helpOut),
      "installed bin --help prints usage from an unrelated cwd");

    // Packed provisioning smoke: exercise the installed PS1 helper and the
    // compiled provisioner against a fake Spicetify config in a temp APPDATA.
    // This never touches the developer's Spotify, Spicetify, or OpenCode.
    if (process.platform === "win32") {
      const smoke = mkdtempSync(join(tmpdir(), "spotify-provision-"));
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
        const env = { ...process.env, APPDATA: appData, TEST_SPICETIFY_CONFIG: config };
        const output = execFileSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", installedScript,
          "-Install", "-Yes", "-SkipApply", "-SpicetifyPath", fake], {
          cwd: probeCwd, encoding: "utf8", timeout: 120_000, windowsHide: true, env,
        });
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
        check(!output.includes(secret), "packed installer output does not print the secret");
        check(!output.includes("ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING"),
          "packed provisioner runs without node_modules type stripping");
      } finally {
        try { rmSync(smoke, { recursive: true, force: true }); } catch { /* best effort */ }
      }
    } else {
      process.stdout.write("  skip: packed provisioning smoke requires Windows\n");
    }
  } catch (error) {
    failures.push(error instanceof Error ? `exception: ${error.message}` : `exception: ${String(error)}`);
  } finally {
    for (const dir of [packDir, installPrefix, probeCwd]) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
    process.stdout.write("verify-package: temp pack/install/probe dirs removed\n");
  }

  if (failures.length) {
    process.stderr.write(`verify-package: FAILED (${failures.length})\n`);
    for (const failure of failures) process.stderr.write(`  missing: ${failure}\n`);
    return 1;
  }
  process.stdout.write("verify-package: PASSED\n");
  return 0;
}

process.exit(main());
