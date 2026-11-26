#!/usr/bin/env node
/**
 * compatibility-candidates.mjs — WP-E dynamic compatibility probing.
 * Never packed (package `files` only ships install-extension.ps1). No
 * dependency candidates are hardcoded: `resolve --lane --out <file>` queries
 * the npm registry once per package, picks stable versions with the pure
 * selectors below (Solid = newest stable in the renderer's peer range, never
 * Solid2; core = solid lockstep; SDK/react/types = latest stable matches),
 * and writes one candidates file reused by every later step. Any skip,
 * absence, or unreliable probe exits nonzero as UNVERIFIED. `selftest` runs
 * the offline-safe unit checks with no network and no deletes.
 */

import { execFileSync } from "node:child_process";
import {
  cpSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, realpathSync,
  readdirSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(here, "..");
const LANES = ["floor-engines", "renderer-sdk", "installer-runtimes"];
const STABLE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const isStable = (v) => typeof v === "string" && STABLE.test(v.trim());
const norm = (v) => String(v).trim();

export function cmp(a, b) {
  const x = norm(a).split(".").map(Number), y = norm(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

export function maxStable(list) {
  let best = null;
  for (const v of list ?? []) if (isStable(v) && (best === null || cmp(v, best) > 0)) best = norm(v);
  return best;
}

function atomOk(v, atom) {
  let m;
  if ((m = /^(>=|<=|>|<|=)?v?(\d+)\.(\d+)\.(\d+)$/.exec(atom))) {
    const c = cmp(v, `${m[2]}.${m[3]}.${m[4]}`), op = m[1] ?? "=";
    return op === "=" ? c === 0 : op === ">" ? c > 0 : op === "<" ? c < 0 : op === ">=" ? c >= 0 : c <= 0;
  }
  if ((m = /^(\^|~)v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(atom))) {
    const maj = +m[2], min = +(m[3] ?? 0), pat = +(m[4] ?? 0);
    const ceil = m[1] === "^"
      ? (maj > 0 ? `${maj + 1}.0.0` : `0.${min + 1}.0`)
      : (m[3] === undefined ? `${maj + 1}.0.0` : `${maj}.${min + 1}.0`);
    return cmp(v, `${maj}.${min}.${pat}`) >= 0 && cmp(v, ceil) < 0;
  }
  if ((m = /^v?(\d+)(?:\.(\d+))?$/.exec(atom))) {
    const p = norm(v).split(".").map(Number);
    return +m[1] === p[0] && (m[2] === undefined || +m[2] === p[1]);
  }
  return false;
}

/** Stable-only range match: `^ ~ >= <= > < =`, partials, space-AND, `||`-OR. */
export function satisfies(version, range) {
  if (!isStable(version)) return false;
  return String(range).split("||").some((alt) => {
    const atoms = alt.trim().split(/\s+/).filter(Boolean);
    return atoms.length > 0 && atoms.every((a) => atomOk(norm(version), a));
  });
}

export function maxSatisfying(list, range) {
  let best = null;
  for (const v of list ?? []) if (satisfies(v, range) && (best === null || cmp(v, best) > 0)) best = norm(v);
  return best;
}

function fail(message) {
  process.stderr.write(`compatibility-candidates: UNVERIFIED: ${message}\n`);
  process.exitCode = 1;
}
const note = (text) => process.stdout.write(`${text}\n`);

/** Owned-child argv only, never a shell string. One query per package per run. */
const REGISTRY = "https://registry.npmjs.org/";
const cache = new Map();
function npmBin() {
  // Only an installed npm-cli.js beside the plugin (or npm_execpath / node
  // dir) may back queries — no shell fallback, fail closed instead.
  const cands = [join(pluginRoot, "node_modules", "npm", "bin", "npm-cli.js")];
  if (typeof process.env.npm_execpath === "string" && process.env.npm_execpath.endsWith(".js")) {
    cands.push(process.env.npm_execpath);
  }
  try { cands.push(join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")); } catch { /* ignore */ }
  for (const c of cands) {
    try { if (existsSync(c)) return { file: process.execPath, pre: [c] }; } catch { /* keep looking */ }
  }
  throw new Error("no installed npm-cli.js found (plugin node_modules, npm_execpath, node dir)");
}
function runNpm(args, options = {}) {
  const { file, pre } = npmBin();
  return execFileSync(file, [...pre, ...args], {
    encoding: "utf8", timeout: 60_000, windowsHide: true, shell: false, stdio: "pipe",
    env: { ...process.env, npm_config_registry: REGISTRY, npm_config_update_notifier: "false" },
    cwd: pluginRoot, ...options,
  });
}
/** Strip ANSI/control noise, first line only, bounded length. */
const clean = (text) => String(text ?? "").replace(/\x1b\[[0-9;]*m/g, "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "").split(/\r?\n/)[0].trim().slice(0, 500);
function npmJson(args) {
  const key = args.join(" ");
  if (!cache.has(key)) cache.set(key, JSON.parse(runNpm(args)));
  return cache.get(key);
}
const versionsOf = (pkg) => {
  const v = npmJson(["view", pkg, "versions", "--json", "--no-audit"]);
  return (Array.isArray(v) ? v : [v]).map(norm);
};
const latestStable = (pkg) => maxStable(versionsOf(pkg));

async function importTs(rel) {
  return import(pathToFileURL(join(pluginRoot, rel)).href);
}

/** Read-only Spicetify stable metadata via the real resolver (never a version fallback). */
async function spicetifyMeta() {
  const release = await importTs(join("src", "cli", "spicetify-release.ts"));
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "ia32" ? "x32" : "x64";
  const r = await release.resolveSpicetifyRelease({ arch, requireWindowsAsset: true });
  if (!r.ok) throw new Error(`spicetify lookup failed (${r.code}): ${r.error.slice(0, 120)}`);
  const asset = release.spicetifyReleaseAsset(r.release, arch);
  if (!asset) throw new Error("spicetify stable has no reviewed Windows asset for this arch");
  return { version: r.release.version, tag: r.release.tag, publishedAt: r.release.publishedAt, asset: asset.name, bytes: asset.size };
}

/** Newest install.ps1 revision via GitHub metadata only (mutable script never fetched). */
async function installerPin() {
  const compat = await importTs(join("src", "cli", "compat.ts"));
  const res = await fetch("https://api.github.com/repos/spicetify/cli/commits?path=install.ps1&per_page=1",
    { headers: { Accept: "application/vnd.github+json", "User-Agent": "opencode-spotify-compat" }, redirect: "error", signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`install.ps1 revision lookup HTTP ${res.status}`);
  const newest = (await res.json())?.[0]?.sha ?? null;
  return { newest, pinned: compat.OFFICIAL_INSTALLER_COMMIT, match: newest === compat.OFFICIAL_INSTALLER_COMMIT };
}

/** Exact-version metadata: solid's declared core dep + peer ranges. No invented fallbacks. */
const exactField = (pkg, ver, field) => npmJson(["view", `${pkg}@${ver}`, field, "--json", "--no-audit"]);

/** Resolve one lane dynamically; exactly one registry query per package. */
export async function resolveLane(lane, toolchain = {}) {
  if (!LANES.includes(lane)) throw new Error(`unknown lane: ${JSON.stringify(lane)}`);
  const node = clean(toolchain.node), bun = clean(toolchain.bun);
  if (!isStable(node) || !isStable(bun)) throw new Error(`toolchain node/bun must be stable semver (got ${node}/${bun})`);
  const out = { lane, toolchain: { node, bun }, deps: {}, checks: {}, upstream: {} };
  out.upstream.spicetify = await spicetifyMeta();
  out.upstream.installer = await installerPin();
  if (!out.upstream.installer.match) throw new Error("install.ps1 drifted past the immutable pin");
  const manifest = JSON.parse(readFileSync(join(pluginRoot, "package.json"), "utf8"));
  const tildeOf = (name) => {
    const v = norm(manifest.dependencies?.[name] ?? manifest.devDependencies?.[name] ?? "");
    const base = v.startsWith("~") ? v.slice(1) : v;
    if (!isStable(base)) throw new Error(`authoritative ${name}=${v} is not exact/tilde stable; cannot derive tilde`);
    return `~${base}`;
  };
  if (lane === "floor-engines") {
    out.hostProbe = "2.3.0";
    out.upstream.hostLatest = latestStable("@opencode/cli-windows-x64");
  } else if (lane === "renderer-sdk") {
    const solid = latestStable("@opentui/solid");
    if (!solid) throw new Error("no stable @opentui/solid found");
    // Core derives from the EXACT selected solid metadata and must lockstep.
    const core = exactField("@opentui/solid", solid, "dependencies")?.["@opentui/core"];
    if (!isStable(core) || core !== solid) {
      throw new Error(`@opentui/solid@${solid} declares core ${core ?? "?"}: lockstep required, refusing`);
    }
    const peer = exactField("@opentui/solid", solid, "peerDependencies")?.["solid-js"];
    if (typeof peer !== "string" || !peer.trim()) throw new Error(`@opentui/solid@${solid} declares no solid-js peer; refusing to invent one`);
    const solidjs = maxSatisfying(versionsOf("solid-js"), peer);
    if (!solidjs) throw new Error(`no stable solid-js satisfies peer ${peer}`);
    const plugin = latestStable("@opencode/plugin");
    if (!plugin) throw new Error("no stable @opencode/plugin found");
    Object.assign(out.deps, { "@opentui/core": core, "@opentui/solid": solid, "solid-js": solidjs, "@opencode/plugin": plugin });
    out.checks = { solidPeer: peer, solidDepsCore: core };
    out.upstream.hostLatest = latestStable("@opencode/cli-windows-x64");
    for (const name of ["ink", "react", "@inkjs/ui"]) out.deps[name] = tildeOf(name);
  } else {
    // Installer/UI ecosystem only: Ink + React + types + UI from exact Ink metadata.
    const [ink, ui] = [latestStable("ink"), latestStable("@inkjs/ui")];
    if (!ink || !ui) throw new Error("no stable ink/@inkjs/ui found");
    const peers = exactField("ink", ink, "peerDependencies") ?? {};
    const reactPeer = peers.react, typesPeer = peers["@types/react"];
    if (typeof reactPeer !== "string" || !reactPeer.trim()) throw new Error(`ink@${ink} declares no react peer; refusing to invent one`);
    if (typeof typesPeer !== "string" || !typesPeer.trim()) throw new Error(`ink@${ink} declares no @types/react peer; refusing to invent one`);
    const react = maxSatisfying(versionsOf("react"), reactPeer);
    if (!react) throw new Error(`no stable react satisfies ink peer ${reactPeer}`);
    const types = maxSatisfying(versionsOf("@types/react"), typesPeer);
    if (!types) throw new Error(`no stable @types/react satisfies ink peer ${typesPeer}`);
    Object.assign(out.deps, { ink: `~${ink}`, react: `~${react}`, "@inkjs/ui": `~${ui}`, "@types/react": types });
    out.checks = { reactPeer, typesPeer };
    out.upstream.hostLatest = latestStable("@opencode/cli-windows-x64");
  }
  for (const [name, spec] of Object.entries(out.deps)) {
    const base = spec.startsWith("~") ? spec.slice(1) : spec;
    if (!isStable(base)) throw new Error(`${name}=${spec} is not stable semver`);
  }
  if (out.deps["@opentui/core"] && out.deps["@opentui/core"] !== out.deps["@opentui/solid"]) {
    throw new Error("core/solid pins must match (lockstep)");
  }
  return out;
}

// Known-good pack inputs only: never .env/.npmrc/credentials/bridge state.
const COPY_TOP = ["package.json", "package-lock.json", "README.md", "LICENSE", "compat.json", "bin", "src", "spicetify", "tests"];
const COPY_FILES = [
  "scripts/install-extension.ps1",
  "scripts/verify-package.mjs",
  "scripts/verify-package-lib.mjs",
  "scripts/check-test-accounting.mjs",
  "scripts/provision.ts",
];
const SENSITIVE = [/^\.env(\..*)?$/i, /^\.npmrc$/i, /^bridge\.json$/i, /^auth\.json$/i, /^credentials\.json$/i, /\.(pem|pfx|p12|key)$/i];

function outsideCheckout(p) {
  const real = realpathSync(p);
  const root = realpathSync(dirname(pluginRoot));
  if (real.toLowerCase() === root.toLowerCase() || real.toLowerCase().startsWith(root.toLowerCase() + sep)) {
    throw new Error("scratch must live outside the checkout");
  }
  return real;
}

function scratchInput(path) {
  const name = basename(path);
  if ([".git", "node_modules", "dist", "reference"].includes(name.toLowerCase()) ||
      SENSITIVE.some((pattern) => pattern.test(name))) return false;
  const stat = lstatSync(path);
  return stat.isFile() || stat.isDirectory();
}

/** Stage candidates into an EXCLUSIVELY created scratch dir; never delete anything. */
export function applyCandidates(candidates, { parent, scratch } = {}) {
  if (!candidates || !LANES.includes(candidates.lane)) throw new Error("apply needs resolved candidates for a known lane");
  let dir;
  if (scratch) {
    if (existsSync(scratch)) throw new Error(`refusing existing scratch path (nothing deleted): ${scratch}`);
    dir = join(outsideCheckout(dirname(resolve(scratch))), basename(scratch));
    mkdirSync(dir); // EEXIST fails closed if another process won creation.
  } else {
    if (!parent) throw new Error("apply needs --parent or --scratch");
    dir = mkdtempSync(join(outsideCheckout(resolve(parent)), `compat-${candidates.lane}-`));
  }
  outsideCheckout(dir);
  for (const name of COPY_TOP) {
    const from = join(pluginRoot, name);
    if (name === "package-lock.json" && Object.keys(candidates.deps).length > 0) continue; // fresh resolve in candidate lanes
    if (!existsSync(from)) throw new Error(`checkout missing required input ${name}`);
    if (!scratchInput(from)) throw new Error(`checkout input is not a regular file or directory: ${name}`);
    cpSync(from, join(dir, name), { recursive: true, filter: scratchInput });
  }
  for (const name of COPY_FILES) {
    const from = join(pluginRoot, name);
    if (!existsSync(from) || !scratchInput(from)) throw new Error(`checkout missing regular input ${name}`);
    cpSync(from, join(dir, name));
  }
  for (const tscfg of ["tsconfig.json", "tsconfig.cli.json", "tsconfig.provision.json"]) {
    const from = join(pluginRoot, tscfg);
    if (!existsSync(from) || !scratchInput(from)) throw new Error(`checkout missing regular input ${tscfg}`);
    cpSync(from, join(dir, tscfg));
  }
  if (Object.keys(candidates.deps).length > 0) {
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    for (const [name, spec] of Object.entries(candidates.deps)) {
      if (name === "@types/react") manifest.devDependencies[name] = spec;
      else manifest.dependencies[name] = spec;
    }
    writeFileSync(join(dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  }
  writeFileSync(join(dir, "candidates.json"), `${JSON.stringify(candidates, null, 2)}\n`);
  return dir;
}

/** Report ACTUAL installed versions; absent/unstable/out-of-bounds dep fails. */
export function installedVersions(scratch) {
  const dir = resolve(scratch);
  const candidates = JSON.parse(readFileSync(join(dir, "candidates.json"), "utf8"));
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  // Floor has no candidate deps, so the scratch manifest's own runtime deps
  // plus typescript define the mandatory set; candidate lanes add their specs.
  const required = [...new Set([
    ...Object.keys(candidates.deps ?? {}),
    ...Object.keys(manifest.dependencies ?? {}),
    "typescript",
    ...(manifest.devDependencies?.["@types/react"] ? ["@types/react"] : []),
  ])];
  const found = {};
  let bad = 0;
  for (const name of required) {
    const pkgPath = join(dir, "node_modules", ...name.split("/"), "package.json");
    if (!existsSync(pkgPath)) { note(`  installed ${name}: ABSENT`); fail(`scratch is missing mandatory dependency ${name}`); bad++; continue; }
    const version = clean(JSON.parse(readFileSync(pkgPath, "utf8")).version ?? "?");
    if (!isStable(version)) { note(`  installed ${name}: ${version} (NOT STABLE)`); fail(`${name}@${version} is not stable`); bad++; continue; }
    const spec = candidates.deps?.[name];
    const inBounds = !spec || (spec.startsWith("~") ? satisfies(version, spec) : version === spec);
    if (!inBounds) { note(`  installed ${name}: ${version} (outside candidate ${spec})`); fail(`${name}@${version} violates selected candidate ${spec}`); bad++; continue; }
    note(`  installed ${name}: ${version}`);
    found[name] = version;
  }
  const { solidPeer, reactPeer } = candidates.checks ?? {};
  if (found["solid-js"] && solidPeer && !satisfies(found["solid-js"], solidPeer)) { fail("installed solid-js violates the renderer peer range"); bad++; }
  if (found.react && reactPeer && !satisfies(found.react, reactPeer)) { fail("installed react violates the ink peer range"); bad++; }
  if (found["@opentui/core"] && found["@opentui/solid"] && found["@opentui/core"] !== found["@opentui/solid"]) {
    fail("installed core/solid are not lockstep"); bad++;
  }
  if (bad) throw new Error(`${bad} installed-dependency problem(s)`);
  return found;
}

/** Narrow isolated host binary probe: single-exe extraction only, version check only. */
export async function probeHost(version) {
  if (!isStable(version)) throw new Error(`probe-host needs a stable version (got ${version})`);
  if (process.platform !== "win32") throw new Error("probe-host is Windows-only (fail closed)");
  const tarball = clean(runNpm(["view", `@opencode/cli-windows-x64@${version}`, "dist.tarball", "--no-audit"]));
  if (!tarball.startsWith("https://registry.npmjs.org/")) throw new Error("host tarball URL is not the official registry");
  note(`  host tarball: ${tarball}`);
  const work = mkdtempSync(join(tmpdir(), "compat-host-"));
  try {
    runNpm(["pack", `@opencode/cli-windows-x64@${version}`,
      "--pack-destination", work, "--ignore-scripts", "--no-audit"],
      { cwd: work, timeout: 180_000 });
    const tgz = readdirSync(work).find((n) => n.endsWith(".tgz"));
    if (!tgz) throw new Error("host tarball download produced no .tgz");
    const dest = join(work, "pkg");
    mkdirSync(dest, { recursive: true });
    execFileSync("tar", ["-xzf", join(work, tgz), "-C", dest, "package/bin/opencode.exe"],
      { encoding: "utf8", timeout: 120_000, windowsHide: true, shell: false });
    const exe = join(dest, "package", "bin", "opencode.exe");
    if (!existsSync(exe) || statSync(exe).size === 0) throw new Error("host tarball has no usable native binary");
    // Fully isolated probe env: owned throwaway HOME/APPDATA/LOCALAPPDATA,
    // XDG and TEMP dirs; no NODE_PATH, no OpenCode overrides; offline.
    const iso = join(work, "iso");
    for (const d of ["home", "appdata", "local", "xdg", "temp"]) mkdirSync(join(iso, d), { recursive: true });
    const env = {
      ...process.env,
      HOME: join(iso, "home"), USERPROFILE: join(iso, "home"),
      APPDATA: join(iso, "appdata"), LOCALAPPDATA: join(iso, "local"),
      XDG_CONFIG_HOME: join(iso, "xdg"), XDG_CACHE_HOME: join(iso, "xdg"),
      XDG_DATA_HOME: join(iso, "xdg"), XDG_STATE_HOME: join(iso, "xdg"),
      TEMP: join(iso, "temp"), TMP: join(iso, "temp"), TMPDIR: join(iso, "temp"),
      NO_COLOR: "1", npm_config_update_notifier: "false",
    };
    delete env.NODE_PATH;
    for (const k of Object.keys(env)) if (k.startsWith("OPENCODE_") || k.startsWith("OPENCODE_SPOTIFY_")) delete env[k];
    const out = clean(execFileSync(exe, ["--standalone", "--version"],
      { encoding: "utf8", timeout: 60_000, windowsHide: true, shell: false, env, cwd: work }));
    note(`  host binary: ${out} (isolated --standalone --version only)`);
    if (out !== `opencode v${version}`) throw new Error(`host binary version mismatch (got ${JSON.stringify(out)})`);
    note("  version/discovery only: full plugin load stays UNVERIFIED; no host compat claimed.");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function report(c) {
  const lines = [
    `lane: ${c.lane}; toolchain node ${c.toolchain.node} + bun ${c.toolchain.bun}`,
    ...Object.entries(c.deps ?? {}).map(([k, v]) => `candidate ${k}: ${v}`),
    ...(!Object.keys(c.deps ?? {}).length ? ["deps: authoritative lockfile unchanged"] : []),
    `spicetify stable: ${c.upstream.spicetify.version} (${c.upstream.spicetify.tag}, ${c.upstream.spicetify.publishedAt}); windows asset ${c.upstream.spicetify.asset} (${c.upstream.spicetify.bytes} bytes)`,
    `install.ps1: newest ${c.upstream.installer.newest} ${c.upstream.installer.match ? "== pin (current)" : "DRIFT"}`,
    ...(c.upstream.hostLatest ? [`host SDK latest: ${c.upstream.hostLatest}`] : []),
    ...(c.hostProbe ? [`host probe: ${c.hostProbe} (isolated version check only)`] : []),
  ];
  for (const line of lines) note(line);
  // Helper summary env: the workflow points this at $GITHUB_STEP_SUMMARY.
  if (process.env.COMPAT_SUMMARY_FILE) {
    writeFileSync(process.env.COMPAT_SUMMARY_FILE, `${lines.map((l) => `- ${l}`).join("\n")}\n`, { flag: "a" });
  }
}

/** Offline-safe checks: mocked version selection + scratch refusal (no network, no deletes). */
export function selftest() {
  const assert = (cond, msg) => { if (!cond) throw new Error(`selftest: ${msg}`); note(`  ok: ${msg}`); };
  assert(isStable("1.9.20") && !isStable("2.0.4-alpha.1") && !isStable("01.2.3") && !isStable("1.9"), "strict stable parse (prerelease/leading-zero/partial rejected)");
  assert(maxStable(["1.9.12", "1.9.20", "2.0.4", "2.0.4-beta"]) === "2.0.4", "maxStable ignores prerelease");
  assert(maxSatisfying(["1.9.12", "1.9.20", "2.0.4"], "^1.9.12") === "1.9.20", "Solid1 peer selects 1.9.20, never Solid2");
  assert(!satisfies("2.0.4", "^1.9.12") && satisfies("1.9.20", ">=1.9.12 <2.0.0"), "range semantics (>=, <, ^)");
  assert(satisfies("8.0.1", "~8.0.0") && !satisfies("8.1.0", "~8.0.0"), "tilde bounds");
  assert(maxSatisfying(["19.2.9", "19.3.1", "20.0.0"], "^19.0.0") === "19.3.1", "ink react peer selects newest 19.x");
  const parent = mkdtempSync(join(tmpdir(), "compat-selftest-"));
  try {
    writeFileSync(join(parent, ".env"), "fixture=1");
    const taken = join(parent, "taken");
    mkdirSync(taken);
    assert(!scratchInput(join(parent, ".env")) && scratchInput(taken), "sensitive files are excluded, regular directories allowed");
    let refused = false;
    try { applyCandidates({ lane: "floor-engines", deps: {} }, { scratch: taken }); }
    catch (e) { refused = /refusing existing scratch/.test(e.message); }
    assert(refused && existsSync(taken), "existing scratch path refused without deleting");
    let nested = false;
    try { applyCandidates({ lane: "floor-engines", deps: {} }, { parent: pluginRoot }); }
    catch (e) { nested = /outside the checkout/.test(e.message); }
    assert(nested, "scratch parent inside checkout refused");
    const staged = applyCandidates({ lane: "floor-engines", deps: {} }, { parent });
    assert(COPY_FILES.every((name) => existsSync(join(staged, name))), "scratch includes the verifier, provisioning and accounting inputs");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
  note("selftest: OK");
}

const flag = (argv, name) => {
  const i = argv.indexOf(name);
  return i < 0 ? null : argv[i + 1] ?? null;
};

const [command, ...rest] = process.argv.slice(2);
try {
  if (command === "resolve") {
    const lane = flag(rest, "--lane"), out = flag(rest, "--out");
    const node = flag(rest, "--node"), bun = flag(rest, "--bun");
    if (!lane || !out || !node || !bun) throw new Error("resolve needs --lane, --out, --node and --bun (toolchain comes from the workflow)");
    const candidates = await resolveLane(lane, { node, bun });
    writeFileSync(resolve(out), `${JSON.stringify(candidates, null, 2)}\n`);
    report(candidates);
  } else if (command === "apply") {
    const file = flag(rest, "--in");
    if (!file) throw new Error("apply needs --in <candidates.json>");
    const dir = applyCandidates(JSON.parse(readFileSync(resolve(file), "utf8")),
      { parent: flag(rest, "--parent"), scratch: flag(rest, "--scratch") });
    process.stdout.write(`scratch: ${dir}\n${dir}\n`);
  } else if (command === "installed") {
    const scratch = flag(rest, "--scratch");
    if (!scratch) throw new Error("installed needs --scratch");
    installedVersions(scratch);
    note("installed: all mandatory deps present and stable");
  } else if (command === "probe-host") {
    const version = flag(rest, "--version");
    if (!version) throw new Error("probe-host needs --version");
    await probeHost(version);
  } else if (command === "report") {
    const file = flag(rest, "--in");
    if (!file) throw new Error("report needs --in <candidates.json>");
    report(JSON.parse(readFileSync(resolve(file), "utf8")));
  } else if (command === "selftest") {
    selftest();
  } else {
    process.stdout.write("usage: resolve --lane <lane> --out <file> --node <x.y.z> --bun <x.y.z> | apply --in <file> (--parent <dir>|--scratch <new-path>) | installed --scratch <dir> | probe-host --version <x.y.z> | report --in <file> | selftest\n");
    process.exitCode = 2;
  }
} catch (error) {
  fail(String(error instanceof Error ? error.message : error).slice(0, 300));
}
if (process.exitCode) process.exit(process.exitCode);
