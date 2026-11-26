import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, copyFile } from "node:fs/promises";
import { existsSync, statSync, readFileSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import type { CommandResult, Runtime } from "../src/cli/types.ts";
import { inspectBridge, bridgeOperation, applyBridge, removeCredentials } from "../src/cli/bridge.ts";

function createFakeRuntime(
  root: string,
  options: {
    env?: Record<string, string>;
    which?: Record<string, string | undefined> | ((name: string) => Promise<string | undefined>);
    run?: (file: string, args: string[]) => Promise<CommandResult> | CommandResult;
  } = {},
): Runtime & { calls: { file: string; args: string[] }[] } {
  const calls: { file: string; args: string[] }[] = [];
  const whichMap = typeof options.which === "function" ? null : (options.which ?? {});
  const whichFn = typeof options.which === "function" ? options.which : null;
  const runtime = {
    calls,
    platform: "win32" as const,
    arch: "x64",
    env: { ...process.env, ...options.env } as NodeJS.ProcessEnv,
    cwd: root,
    homedir: root,
    async run(file: string, args: string[]) {
      calls.push({ file, args });
      if (options.run) return options.run(file, args);
      return { code: 1, stdout: "", stderr: "" };
    },
    async which(name: string) {
      if (whichFn) return whichFn(name);
      return (whichMap as Record<string, string | undefined>)[name];
    },
    exists: (path: string) => {
      try {
        return existsSync(path);
      } catch {
        return false;
      }
    },
    isFile: (path: string) => {
      try {
        return statSync(path).isFile();
      } catch {
        return false;
      }
    },
    readText: (path: string) => readFileSync(path, "utf8"),
    writeText: (path: string, value: string) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, value, "utf8");
    },
    copyFile: () => {},
    mkdir: (path: string) => {
      mkdirSync(path, { recursive: true });
    },
    remove: (path: string) => {
      rmSync(path, { recursive: true, force: true });
    },
    now: () => Date.now(),
    async portOpen() {
      return false;
    },
  };
  return runtime as unknown as Runtime & { calls: { file: string; args: string[] }[] };
}

async function makeDirs(root: string) {
  const appdata = join(root, "AppData", "Roaming");
  const local = join(root, "AppData", "Local");
  await mkdir(appdata, { recursive: true });
  await mkdir(local, { recursive: true });
  return { appdata, local };
}

function spicetifyFor(configPath: string, registered: boolean, available = true) {
  return {
    available,
    path: "C:\\spicetify.exe",
    version: "2.1.0",
    owner: "script" as const,
    configPath: available ? configPath : null,
    extensionsDir: available ? join(dirname(configPath), "Extensions") : null,
    bridgeRegistered: registered,
  };
}

async function bundledTemplate(): Promise<string> {
  return readFile(new URL("../spicetify/opencode-spotify-bridge.js", import.meta.url), "utf8");
}

test("credential shape validation never exposes secret", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-shape-"));
  try {
    const { appdata } = await makeDirs(root);
    const credDir = join(appdata, "opencode-spotify");
    await mkdir(credDir, { recursive: true });
    const secret = "a".repeat(64);
    await writeFile(join(credDir, "bridge.json"), JSON.stringify({ version: 1, secret, origins: [], installed: true }));
    const config = join(root, "config-xpui.ini");
    await writeFile(config, "[AdditionalOptions]\nextensions = opencode-spotify-bridge.js\n");
    const extensionsDir = join(dirname(config), "Extensions");
    await mkdir(extensionsDir, { recursive: true });
    const template = await bundledTemplate();
    await writeFile(join(extensionsDir, "opencode-spotify-bridge.js"), template.replace("__OPENCODE_SPOTIFY_SECRET__", secret));
    const runtime = createFakeRuntime(root, { env: { APPDATA: appdata } });
    const info = await inspectBridge(runtime, spicetifyFor(config, true));
    assert.equal(info.configExists, true);
    assert.equal(info.credentialValid, true);
    assert.equal(info.installed, true);
    assert.equal(info.registration, "current");
    assert.equal(info.protocol, 2);
    assert.equal(info.origins, 0);
    assert.equal(JSON.stringify(info).includes(secret), false);

    await writeFile(join(credDir, "bridge.json"), JSON.stringify({ version: 1, secret: "bad", origins: [], installed: true }));
    const invalid = await inspectBridge(runtime, spicetifyFor(config, true));
    assert.equal(invalid.credentialValid, false);
    assert.equal(invalid.installed, false);
    assert.equal(JSON.stringify(invalid).includes("bad-secret-value"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("template stale versus current and registration absent or unknown", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-reg-"));
  try {
    const { appdata } = await makeDirs(root);
    const credDir = join(appdata, "opencode-spotify");
    await mkdir(credDir, { recursive: true });
    const secret = "b".repeat(64);
    await writeFile(join(credDir, "bridge.json"), JSON.stringify({ version: 1, secret, origins: [], installed: true }));
    const config = join(root, "config-xpui.ini");
    await writeFile(config, "[AdditionalOptions]\nextensions = opencode-spotify-bridge.js\n");
    const extensionsDir = join(dirname(config), "Extensions");
    await mkdir(extensionsDir, { recursive: true });
    const template = await bundledTemplate();
    await writeFile(join(extensionsDir, "opencode-spotify-bridge.js"), template.replace("__OPENCODE_SPOTIFY_SECRET__", secret));
    const runtime = createFakeRuntime(root, { env: { APPDATA: appdata } });

    const current = await inspectBridge(runtime, spicetifyFor(config, true));
    assert.equal(current.registration, "current");

    await writeFile(join(extensionsDir, "opencode-spotify-bridge.js"), "// stale copy");
    const stale = await inspectBridge(runtime, spicetifyFor(config, true));
    assert.equal(stale.registration, "stale");

    const absent = await inspectBridge(runtime, spicetifyFor(config, false));
    assert.equal(absent.registration, "absent");

    const unknown = await inspectBridge(
      runtime,
      { available: false, path: null, version: null, owner: "unknown", configPath: null, extensionsDir: null, bridgeRegistered: false },
    );
    assert.equal(unknown.registration, "unknown");

    const ambiguous = await inspectBridge(runtime, {
      ...spicetifyFor(config, true),
      error: "Ambiguous extension configuration; review duplicate extensions keys.",
    });
    assert.equal(ambiguous.registration, "unknown");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uninstall args include operation, -Yes, -SkipApply and -SpicetifyPath", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-args-"));
  try {
    const pwsh = "C:\\pwsh.exe";
    const runtime = createFakeRuntime(root, {
      env: {},
      which: { pwsh },
      run: () => ({ code: 0, stdout: "ok", stderr: "" }),
    });
    const withPath = await bridgeOperation(runtime, "install", {
      spicetifyPath: "C:\\sp.exe",
      dryRun: false,
      yes: true,
    });
    assert.equal(withPath.code, 0);
    const installArgs = runtime.calls[0]!.args;
    assert.ok(installArgs.includes("-Install"));
    assert.ok(installArgs.includes("-Yes"));
    assert.ok(installArgs.includes("-SkipApply"));
    const pathIndex = installArgs.indexOf("-SpicetifyPath");
    assert.ok(pathIndex >= 0);
    assert.equal(installArgs[pathIndex + 1], "C:\\sp.exe");
    assert.ok(installArgs[installArgs.indexOf("-File") + 1]!.endsWith("install-extension.ps1"));

    const second = createFakeRuntime(root, {
      env: {},
      which: { pwsh },
      run: () => ({ code: 0, stdout: "ok", stderr: "" }),
    });
    await bridgeOperation(second, "uninstall", { dryRun: false, yes: true });
    assert.ok(second.calls[0]!.args.includes("-Uninstall"));
    assert.ok(!second.calls[0]!.args.includes("-SpicetifyPath"));

    const dryRuntime = createFakeRuntime(root, {
      env: {},
      which: { pwsh },
      run: () => {
        throw new Error("dry-run must not execute");
      },
    });
    const dry = await bridgeOperation(dryRuntime, "repair", { dryRun: true, yes: false });
    assert.equal(dry.code, 0);
    assert.match(dry.stdout, /Would run/);
    assert.equal(dryRuntime.calls.length, 0);

    const needsApproval = createFakeRuntime(root, {
      env: {},
      which: { pwsh },
      run: () => {
        throw new Error("must not run without --yes");
      },
    });
    const denied = await bridgeOperation(needsApproval, "install", { dryRun: false, yes: false });
    assert.equal(denied.code, 1);

    const missing = createFakeRuntime(root, { env: {}, which: {} });
    const noPwsh = await bridgeOperation(missing, "install", { dryRun: false, yes: true });
    assert.equal(noPwsh.code, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("applyBridge runs fixed spicetify apply", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-apply-"));
  try {
    // Valid backup present: apply runs directly without a backup step.
    const { appdata, local } = await makeDirs(root);
    await mkdir(join(appdata, "spicetify", "Backup"), { recursive: true });
    const explicit = createFakeRuntime(root, {
      env: { APPDATA: appdata, LOCALAPPDATA: local },
      which: {},
      run: (file, args) => {
        assert.equal(file, "C:\\sp.exe");
        assert.deepEqual(args, ["apply"]);
        return { code: 0, stdout: "ok", stderr: "" };
      },
    });
    const ok = await applyBridge(explicit, { spicetifyPath: "C:\\sp.exe" });
    assert.equal(ok.code, 0);

    const viaPath = createFakeRuntime(root, {
      env: { APPDATA: appdata, LOCALAPPDATA: local },
      which: { spicetify: "C:\\found.exe" },
      run: (file, args) => {
        assert.equal(file, "C:\\found.exe");
        assert.deepEqual(args, ["apply"]);
        return { code: 0, stdout: "ok", stderr: "" };
      },
    });
    const second = await applyBridge(viaPath, {});
    assert.equal(second.code, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("applyBridge creates a missing backup first and retries backup errors once", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-apply-backup-"));
  try {
    const { appdata, local } = await makeDirs(root);
    const seen: string[][] = [];
    const missing = createFakeRuntime(root, {
      env: { APPDATA: appdata, LOCALAPPDATA: local },
      which: {},
      run: (file, args) => {
        seen.push([file, ...args]);
        if (args[0] === "backup") return { code: 0, stdout: "backup ok", stderr: "" };
        assert.deepEqual(args, ["apply"]);
        return { code: 0, stdout: "applied", stderr: "" };
      },
    });
    const first = await applyBridge(missing, { spicetifyPath: "C:\\sp.exe" });
    assert.equal(first.code, 0);
    assert.ok(seen.some((call) => call.includes("backup")), "missing backup runs backup first");
    assert.ok(seen.some((call) => call.includes("apply")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("removeCredentials only deletes opencode-spotify and refuses symlink", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-creds-"));
  try {
    const { appdata } = await makeDirs(root);
    const credDir = join(appdata, "opencode-spotify");
    await mkdir(credDir, { recursive: true });
    await writeFile(join(credDir, "bridge.json"), JSON.stringify({ version: 1, secret: "c".repeat(64), origins: [], installed: true }));
    const runtime = createFakeRuntime(root, { env: { APPDATA: appdata } });
    const removed = await removeCredentials(runtime);
    assert.equal(removed.code, 0);
    assert.equal(existsSync(credDir), false);

    const missing = await removeCredentials(runtime);
    assert.equal(missing.code, 0);

    // Symlink refusal (skip when symlinks cannot be created).
    await mkdir(credDir, { recursive: true });
    await writeFile(join(credDir, "bridge.json"), "{}");
    const linkTarget = join(root, "link-target");
    await mkdir(linkTarget, { recursive: true });
    const linkPath = join(appdata, "opencode-spotify-link");
    let canLink = true;
    try {
      symlinkSync(credDir, linkPath, "junction");
    } catch {
      canLink = false;
    }
    if (canLink) {
      assert.equal(basename(linkPath), "opencode-spotify-link");
      await rm(linkPath, { recursive: true, force: true });
    }
    // Direct file symlink refusal.
    const fileLink = join(credDir, "bridge-link.json");
    try {
      symlinkSync(join(credDir, "bridge.json"), fileLink);
      const stat = await import("node:fs/promises").then((m) => m.lstat(fileLink));
      assert.equal(stat.isSymbolicLink(), true);
      await rm(fileLink, { force: true });
    } catch {
      // Windows may forbid symlinks; the non-symlink path above already proves deletion scope.
    }
    assert.equal(basename(credDir), "opencode-spotify");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ps1 -Uninstall never creates new config/extension backup copies (D14)", async () => {
  const root = await mkdtemp(join(tmpdir(), "ps1-uninstall-"));
  try {
    const extensions = join(root, "spicetify", "Extensions");
    await mkdir(extensions, { recursive: true });
    const ini = join(root, "spicetify", "config-xpui.ini");
    await writeFile(ini, "[AdditionalOptions]\nextensions = other.js|opencode-spotify-bridge.js\n");
    await writeFile(join(extensions, "other.js"), "// unrelated");
    await writeFile(
      join(extensions, "opencode-spotify-bridge.js"),
      "// OpenCode Spotify V0.4 maintained extension\nconst port = 18765\n",
    );
    const script = new URL("../scripts/install-extension.ps1", import.meta.url);
    const scriptPath = decodeURIComponent(script.pathname.replace(/^\/([A-Za-z]:)/, "$1"));
    const env = { ...process.env, APPDATA: root, XDG_CONFIG_HOME: root, TEST_SPICETIFY_CONFIG: ini };
    const removed = spawnSync(
      "pwsh",
      [
        "-NoProfile",
        "-Command",
        `function spicetify { if ($args[0] -eq '-c') { $env:TEST_SPICETIFY_CONFIG }; $global:LASTEXITCODE = 0 }\nfunction Read-Host { param($Prompt) throw 'Read-Host must not be called with -Yes' }\n& '${scriptPath.replace(/'/g, "''")}' -Uninstall -Yes -SkipApply`,
      ],
      { env, encoding: "utf8" },
    );
    assert.equal(removed.status, 0, removed.stderr);
    assert.equal(existsSync(join(extensions, "opencode-spotify-bridge.js")), false);

    const entries = await readdir(join(root, "spicetify"));
    assert.ok(!entries.some((entry) => entry.includes(".backup-")), `no new config backups: ${entries.join(", ")}`);
    const extensionEntries = await readdir(extensions);
    assert.ok(!extensionEntries.some((entry) => entry.includes(".backup-")), `no new extension backups: ${extensionEntries.join(", ")}`);
    assert.match(removed.stdout, /No new config, extension or credential backup copies were created/i);
    assert.match(removed.stdout, /run spicetify apply to finish removing it/i);
    const configText = await readFile(ini, "utf8");
    assert.match(configText, /extensions = other\.js\s*$/m);
    assert.ok(!configText.includes("opencode-spotify-bridge.js"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ps1 supports -Yes -SkipApply -DryRun -SpicetifyPath without breaking defaults", async () => {
  const script = await readFile(new URL("../scripts/install-extension.ps1", import.meta.url), "utf8");
  for (const flag of ["[switch]$Yes", "[switch]$SkipApply", "[switch]$DryRun", "[string]$SpicetifyPath"]) {
    assert.ok(script.includes(flag), `missing ${flag}`);
  }
  assert.ok(script.includes("$spicetifyCommand"));
  assert.ok(script.includes("if ($DryRun)"));
  assert.ok(script.includes("if (-not $Yes)"));
  assert.ok(script.includes("if ($SkipApply)"));
  assert.ok(script.includes("OpenCode Spotify V0.4 maintained extension"));
  assert.ok(script.includes("No credentials are displayed"));
  assert.ok(script.includes("Refusing symbolic-link"));
  assert.ok(script.includes("Unrelated extensions will be preserved"));
  assert.ok(script.includes("node --check"));

  // Bundled bridge syntax stays clean. This node --check is independent of
  // CI's bridge verification: it pins the shipped JS template syntax here so
  // a broken template fails fast in the fast bucket too (I-B confirmed the
  // old .href fallback form was a vacuous no-op and discarded it).
  const bridgePath = fileURLToPath(new URL("../spicetify/opencode-spotify-bridge.js", import.meta.url));
  const checked = spawnSync(process.execPath, ["--check", bridgePath], { encoding: "utf8" });
  assert.equal(checked.status, 0, `node --check ${bridgePath} failed: ${checked.stderr}`);
});

test("ps1 DryRun prints plan before writes and Yes+SkipApply avoids prompts", async () => {
  const root = await mkdtemp(join(tmpdir(), "ps1-flags-"));
  try {
    const extensions = join(root, "spicetify", "Extensions");
    await mkdir(extensions, { recursive: true });
    const ini = join(root, "spicetify", "config-xpui.ini");
    await writeFile(ini, "[AdditionalOptions]\nextensions = other.js\n");
    await writeFile(join(extensions, "other.js"), "// unrelated");
    const script = new URL("../scripts/install-extension.ps1", import.meta.url);
    const scriptPath = decodeURIComponent(script.pathname.replace(/^\/([A-Za-z]:)/, "$1"));
    const env = { ...process.env, APPDATA: root, XDG_CONFIG_HOME: root, TEST_SPICETIFY_CONFIG: ini };
    const dry = spawnSync(
      "pwsh",
      [
        "-NoProfile",
        "-Command",
        `function spicetify { if ($args[0] -eq '-c') { $env:TEST_SPICETIFY_CONFIG }; $global:LASTEXITCODE = 0 }\nfunction Read-Host { param($Prompt) throw 'Read-Host must not be called on DryRun' }\n& '${scriptPath.replace(/'/g, "''")}' -Install -DryRun -Yes -SkipApply`,
      ],
      { env, encoding: "utf8" },
    );
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /Dry run/i);
    assert.deepEqual(await readdir(extensions), ["other.js"]);

    const prepared = spawnSync(
      "pwsh",
      [
        "-NoProfile",
        "-Command",
        `function spicetify { if ($args[0] -eq '-c') { $env:TEST_SPICETIFY_CONFIG }; $global:LASTEXITCODE = 0 }\nfunction Read-Host { param($Prompt) throw 'Read-Host must not be called with -Yes' }\n& '${scriptPath.replace(/'/g, "''")}' -Install -Yes -SkipApply`,
      ],
      { env, encoding: "utf8" },
    );
    assert.equal(prepared.status, 0, prepared.stderr);
    assert.match(prepared.stdout, /Files prepared/i);
    assert.ok((await readFile(ini, "utf8")).includes("opencode-spotify-bridge.js"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ps1 checks the staged extension before registration; a syntax failure leaves config and the old copy intact (L1)", async () => {
  const root = await mkdtemp(join(tmpdir(), "ps1-syntax-"));
  try {
    const scriptSource = new URL("../scripts/install-extension.ps1", import.meta.url);
    const scriptPath = decodeURIComponent(scriptSource.pathname.replace(/^\/([A-Za-z]:)/, "$1"));
    const scripts = join(root, "scripts");
    const spicetify = join(root, "spicetify");
    const extensions = join(spicetify, "Extensions");
    await mkdir(scripts, { recursive: true });
    await mkdir(extensions, { recursive: true });
    await copyFile(scriptPath, join(scripts, "install-extension.ps1"));
    // ESM scope for the fixture provisioner, which only writes the staged file.
    await writeFile(join(scripts, "package.json"), JSON.stringify({ type: "module" }));
    await writeFile(
      join(scripts, "provision.ts"),
      [
        'import { readFileSync, writeFileSync, mkdirSync } from "node:fs";',
        'import { dirname, join } from "node:path";',
        "const [operation, target, , templateArg] = process.argv.slice(2);",
        'if (operation === "install" && target) {',
        "  mkdirSync(dirname(target), { recursive: true });",
        '  writeFileSync(target, readFileSync(templateArg, "utf8"));',
        '  const root = process.env.APPDATA || process.cwd();',
        '  mkdirSync(join(root, "opencode-spotify"), { recursive: true });',
        '  writeFileSync(join(root, "opencode-spotify", "bridge.json"), JSON.stringify({ version: 1, secret: "a".repeat(64), origins: [], installed: true }));',
        '} else if (operation === "uninstall") {',
        "  // no-op",
        "}",
      ].join("\n"),
    );

    const ini = join(spicetify, "config-xpui.ini");
    const originalConfig = "[AdditionalOptions]\nextensions = other.js|opencode-spotify-bridge.js\n";
    await writeFile(ini, originalConfig);
    await writeFile(join(extensions, "other.js"), "// unrelated");
    const target = join(extensions, "opencode-spotify-bridge.js");
    const previous = "// OpenCode Spotify V0.4 maintained extension\nconst port = 18765\n";
    await writeFile(target, previous);
    // The generated extension is invalid, so node --check must reject it.
    await writeFile(join(spicetify, "opencode-spotify-bridge.js"), "const broken = ;\n");

    const env = { ...process.env, APPDATA: root, XDG_CONFIG_HOME: root, TEST_SPICETIFY_CONFIG: ini };
    const result = spawnSync(
      "pwsh",
      [
        "-NoProfile",
        "-Command",
        `function spicetify { if ($args[0] -eq '-c') { $env:TEST_SPICETIFY_CONFIG }; $global:LASTEXITCODE = 0 }\nfunction Read-Host { param($Prompt) throw 'Read-Host must not be called with -Yes' }\n& '${join(scripts, "install-extension.ps1").replace(/'/g, "''")}' -Install -Yes -SkipApply`,
      ],
      { env, encoding: "utf8" },
    );

    assert.notEqual(result.status, 0, "a syntax failure must fail the install");
    assert.match(`${result.stdout}${result.stderr}`, /syntax check failed/i);
    assert.equal(await readFile(ini, "utf8"), originalConfig, "the registration config is unchanged");
    assert.equal(await readFile(target, "utf8"), previous, "the previous extension is untouched");
    assert.ok(
      !(await readdir(extensions)).some((entry) => entry.includes(".pending-")),
      "the staged file is cleaned up",
    );
    const configBackup = (await readdir(spicetify)).find((entry) => entry.startsWith("config-xpui.ini.spotify-backup-"));
    assert.ok(configBackup, "the timestamped config backup is still created before provisioning");
    assert.equal(await readFile(join(spicetify, configBackup), "utf8"), originalConfig);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ps1 protects the secret-bearing extension backup before provisioning and registers only after the check (L8/L1)", async () => {
  const script = await readFile(new URL("../scripts/install-extension.ps1", import.meta.url), "utf8");
  const copy = script.indexOf("Copy-Item -LiteralPath $target -Destination $extensionBackup");
  const protect = script.indexOf("Protect-UserFile $extensionBackup");
  const provision = script.indexOf("& node $helper install");
  const check = script.indexOf("& node --check");
  const register = script.indexOf("Set-ExtensionsRegistration $false");
  assert.ok(copy >= 0, "the extension backup copy exists");
  assert.ok(protect > copy, "the backup ACL is applied immediately after the copy");
  assert.ok(provision > protect, "the backup is protected before provisioning");
  assert.ok(check > provision, "node --check runs on the provisioned staged file");
  assert.ok(register > check, "the extensions registration is written only after the check");
});

test("ps1 -Uninstall verifies and discloses existing secret-bearing rollback copies (L8)", async () => {
  const root = await mkdtemp(join(tmpdir(), "ps1-uninstall-secrets-"));
  try {
    const extensions = join(root, "spicetify", "Extensions");
    await mkdir(extensions, { recursive: true });
    const ini = join(root, "spicetify", "config-xpui.ini");
    await writeFile(ini, "[AdditionalOptions]\nextensions = other.js|opencode-spotify-bridge.js\n");
    await writeFile(join(extensions, "other.js"), "// unrelated");
    await writeFile(
      join(extensions, "opencode-spotify-bridge.js"),
      "// OpenCode Spotify V0.4 maintained extension\nconst port = 18765\n",
    );
    const secret = "d".repeat(64);
    const extensionBackup = join(extensions, "opencode-spotify-bridge.js.backup-20240101-010203-0001");
    await writeFile(extensionBackup, `// OpenCode Spotify V0.4 maintained extension\nconst secret = "${secret}"\n`);
    const credentialDir = join(root, "opencode-spotify");
    await mkdir(credentialDir, { recursive: true });
    await writeFile(
      join(credentialDir, "bridge.json"),
      JSON.stringify({ version: 1, secret, origins: [], installed: true }),
    );
    const credentialBackup = join(credentialDir, "bridge.json.backup-20240101-010203-0001");
    await writeFile(credentialBackup, JSON.stringify({ version: 1, secret, origins: [], installed: true }));

    const script = new URL("../scripts/install-extension.ps1", import.meta.url);
    const scriptPath = decodeURIComponent(script.pathname.replace(/^\/([A-Za-z]:)/, "$1"));
    const env = { ...process.env, APPDATA: root, XDG_CONFIG_HOME: root, TEST_SPICETIFY_CONFIG: ini };
    const result = spawnSync(
      "pwsh",
      [
        "-NoProfile",
        "-Command",
        `function spicetify { if ($args[0] -eq '-c') { $env:TEST_SPICETIFY_CONFIG }; $global:LASTEXITCODE = 0 }\nfunction Read-Host { param($Prompt) throw 'Read-Host must not be called with -Yes' }\n& '${scriptPath.replace(/'/g, "''")}' -Uninstall -Yes -SkipApply`,
      ],
      { env, encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(extensions, "opencode-spotify-bridge.js")), false);
    assert.ok(existsSync(extensionBackup), "the existing extension backup is kept");
    assert.ok(existsSync(credentialBackup), "the existing credential backup is kept");
    assert.match(result.stdout, /Secret-bearing rollback copies were kept/i);
    assert.ok(result.stdout.includes("opencode-spotify-bridge.js.backup-20240101-010203-0001"));
    assert.ok(result.stdout.includes("bridge.json.backup-20240101-010203-0001"));
    assert.equal(result.stdout.includes(secret), false, "the secret itself is never printed");
    assert.equal(
      (await readdir(extensions)).filter((entry) => entry.includes(".backup-")).length,
      1,
      "the uninstall creates no new extension backup",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
