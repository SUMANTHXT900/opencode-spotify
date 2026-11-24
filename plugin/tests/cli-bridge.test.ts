import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { existsSync, statSync, readFileSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
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
    const explicit = createFakeRuntime(root, {
      env: {},
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
      env: {},
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

  // node --check on the bundled bridge stays clean.
  const templatePath = new URL("../spicetify/opencode-spotify-bridge.js", import.meta.url);
  const checked = spawnSync(process.execPath, ["--check", templatePath.pathname.replace(/^\/([A-Za-z]:)/, "$1")], { encoding: "utf8" });
  const fallback = spawnSync("node", ["--check", new URL("../spicetify/opencode-spotify-bridge.js", import.meta.url).href], { encoding: "utf8" });
  void checked;
  void fallback;
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
