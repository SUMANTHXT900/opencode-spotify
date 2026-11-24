import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync, statSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type { CommandResult, Runtime } from "../src/cli/types.ts";
import {
  inspectSpicetify,
  inspectSpotify,
  installSpicetify,
  upgradeSpicetify,
  applySpicetify,
  SPOTIFY_STORE_QUERY,
  SPICETIFY_INSTALL_SCRIPT_URL,
} from "../src/cli/spicetify.ts";

interface FakeOptions {
  env?: Record<string, string>;
  which?: Record<string, string | undefined> | ((name: string) => Promise<string | undefined>);
  run?: (file: string, args: string[]) => Promise<CommandResult> | CommandResult;
}

function createFakeRuntime(root: string, options: FakeOptions = {}): Runtime & {
  calls: { file: string; args: string[] }[];
} {
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
    async run(file: string, args: string[], runOptions?: { timeoutMs?: number }) {
      void runOptions;
      calls.push({ file, args });
      if (options.run) return options.run(file, args);
      return { code: 1, stdout: "", stderr: "" };
    },
    async which(name: string) {
      if (whichFn) return whichFn(name);
      const value = (whichMap as Record<string, string | undefined>)[name];
      return value;
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
  } satisfies Runtime & { calls: unknown };
  return runtime as unknown as Runtime & { calls: { file: string; args: string[] }[] };
}

async function tempRoot(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

test("absent spicetify is reported without touching the system", async () => {
  const root = await tempRoot("spicetify-absent-");
  try {
    const appdata = join(root, "AppData", "Roaming");
    const local = join(root, "AppData", "Local");
    const runtime = createFakeRuntime(root, {
      env: { APPDATA: appdata, LOCALAPPDATA: local },
      which: {},
    });
    const info = await inspectSpicetify(runtime);
    assert.equal(info.available, false);
    assert.equal(info.path, null);
    assert.equal(info.version, null);
    assert.equal(info.owner, "unknown");
    assert.equal(info.configPath, null);
    assert.equal(info.extensionsDir, null);
    assert.equal(info.bridgeRegistered, false);
    assert.equal(runtime.calls.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("detects spicetify via LOCALAPPDATA and parses config with other extensions", async () => {
  const root = await tempRoot("spicetify-local-");
  try {
    const appdata = join(root, "AppData", "Roaming");
    const local = join(root, "AppData", "Local");
    await mkdir(join(local, "spicetify"), { recursive: true });
    const exe = join(local, "spicetify", "spicetify.exe");
    await writeFile(exe, "binary");
    const configDir = join(root, "spicetify-config");
    await mkdir(configDir, { recursive: true });
    const config = join(configDir, "config-xpui.ini");
    await writeFile(config, "[AdditionalOptions]\ncustom = keep\nextensions = other.js|opencode-spotify-bridge.js\n");
    const runtime = createFakeRuntime(root, {
      env: { APPDATA: appdata, LOCALAPPDATA: local },
      which: {},
      run: (file, args) => {
        if (file === exe && args[0] === "-v") return { code: 0, stdout: "spicetify 2.1.0\n", stderr: "" };
        if (file === exe && args[0] === "-c") return { code: 0, stdout: `ignored\n${config}\n`, stderr: "" };
        if (file === exe && args[0] === "path") return { code: 0, stdout: "", stderr: "" };
        return { code: 1, stdout: "", stderr: "" };
      },
    });
    const info = await inspectSpicetify(runtime);
    assert.equal(info.available, true);
    assert.equal(info.path, exe);
    assert.equal(info.version, "2.1.0");
    assert.equal(info.owner, "script");
    assert.equal(info.configPath, config);
    assert.equal(info.extensionsDir, join(dirname(config), "Extensions"));
    assert.equal(info.bridgeRegistered, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("duplicate extensions keys are treated as unknown", async () => {
  const root = await tempRoot("spicetify-dup-");
  try {
    const appdata = join(root, "AppData", "Roaming");
    const local = join(root, "AppData", "Local");
    await mkdir(join(local, "spicetify"), { recursive: true });
    const exe = join(local, "spicetify", "spicetify.exe");
    await writeFile(exe, "binary");
    const config = join(root, "config-xpui.ini");
    await writeFile(config, "[AdditionalOptions]\nextensions = a.js\nextensions = b.js\n");
    const runtime = createFakeRuntime(root, {
      env: { APPDATA: appdata, LOCALAPPDATA: local },
      which: {},
      run: (file, args) => {
        if (args[0] === "-v") return { code: 0, stdout: "2.0.0", stderr: "" };
        if (args[0] === "-c") return { code: 0, stdout: `${config}\n`, stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const info = await inspectSpicetify(runtime);
    assert.equal(info.bridgeRegistered, false);
    assert.match(info.error ?? "", /Ambiguous/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("version and owner via scoop path and winget probe", async () => {
  const root = await tempRoot("spicetify-owner-");
  try {
    const config = join(root, "config-xpui.ini");
    await writeFile(config, "[AdditionalOptions]\nextensions = opencode-spotify-bridge.js\n");
    const scoopExe = "C:\\Users\\tester\\scoop\\apps\\spicetify\\current\\spicetify.exe";
    const scoopRuntime = createFakeRuntime(root, {
      env: { APPDATA: join(root, "Roaming"), LOCALAPPDATA: join(root, "Local") },
      which: { spicetify: scoopExe },
      run: (file, args) => {
        if (args[0] === "-v") return { code: 0, stdout: "v2.2.0", stderr: "" };
        if (args[0] === "-c") return { code: 0, stdout: `${config}\n`, stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const scoopInfo = await inspectSpicetify(scoopRuntime);
    assert.equal(scoopInfo.version, "2.2.0");
    assert.equal(scoopInfo.owner, "scoop");

    const plainExe = "C:\\tools\\spicetify.exe";
    let wingetQueried = false;
    const wingetRuntime = createFakeRuntime(root, {
      env: { APPDATA: join(root, "Roaming"), LOCALAPPDATA: join(root, "Local") },
      which: async (name: string) => {
        if (name === "spicetify") return plainExe;
        if (name === "winget") return "C:\\winget.exe";
        return undefined;
      },
      run: (file, args) => {
        if (args[0] === "-v") return { code: 0, stdout: "2.3.0", stderr: "" };
        if (args[0] === "-c") return { code: 0, stdout: `${config}\n`, stderr: "" };
        if (args[0] === "path") return { code: 0, stdout: "", stderr: "" };
        if (file === "C:\\winget.exe") {
          wingetQueried = true;
          return { code: 0, stdout: "Spicetify.Spicetify 2.3.0", stderr: "" };
        }
        return { code: 1, stdout: "", stderr: "" };
      },
    });
    const wingetInfo = await inspectSpicetify(wingetRuntime);
    assert.equal(wingetInfo.owner, "winget");
    assert.equal(wingetQueried, true);

    const unknownRuntime = createFakeRuntime(root, {
      env: { APPDATA: join(root, "Roaming"), LOCALAPPDATA: join(root, "Local") },
      which: { spicetify: plainExe },
      run: (file, args) => {
        if (args[0] === "-v") return { code: 0, stdout: "2.3.0", stderr: "" };
        if (args[0] === "-c") return { code: 0, stdout: `${config}\n`, stderr: "" };
        return { code: 1, stdout: "", stderr: "" };
      },
    });
    const unknownInfo = await inspectSpicetify(unknownRuntime);
    assert.equal(unknownInfo.owner, "unknown");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("detects desktop Spotify via APPDATA prefs", async () => {
  const root = await tempRoot("spotify-desktop-");
  try {
    const appdata = join(root, "AppData", "Roaming");
    await mkdir(join(appdata, "Spotify"), { recursive: true });
    await writeFile(join(appdata, "Spotify", "prefs"), "prefs");
    await writeFile(join(appdata, "Spotify", "Spotify.exe"), "binary");
    const runtime = createFakeRuntime(root, {
      env: { APPDATA: appdata },
      which: {},
    });
    const info = await inspectSpotify(runtime);
    assert.equal(info.installed, true);
    assert.equal(info.store, false);
    assert.ok(info.path?.endsWith("Spotify.exe"));
    assert.ok(info.prefs?.endsWith("prefs"));
    assert.match(info.detail, /desktop/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("detects Store Spotify via fixed pwsh command", async () => {
  const root = await tempRoot("spotify-store-");
  try {
    const appdata = join(root, "AppData", "Roaming");
    await mkdir(appdata, { recursive: true });
    let seenCommand: string | null = null;
    const runtime = createFakeRuntime(root, {
      env: { APPDATA: appdata },
      which: { pwsh: "C:\\pwsh.exe" },
      run: (file, args) => {
        assert.equal(file, "C:\\pwsh.exe");
        assert.deepEqual(args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
        seenCommand = args[3]!;
        return { code: 0, stdout: "C:\\Program Files\\WindowsApps\\SpotifyAB.SpotifyMusic_1.0\n", stderr: "" };
      },
    });
    const info = await inspectSpotify(runtime);
    assert.equal(info.installed, true);
    assert.equal(info.store, true);
    assert.equal(info.path, "C:\\Program Files\\WindowsApps\\SpotifyAB.SpotifyMusic_1.0");
    assert.equal(seenCommand, SPOTIFY_STORE_QUERY);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("winget install requires approval and dry-run plans without executing", async () => {
  const root = await tempRoot("spicetify-winget-");
  try {
    const runtime = createFakeRuntime(root, {
      env: {},
      which: { winget: "C:\\winget.exe" },
      run: () => ({ code: 0, stdout: "ok", stderr: "" }),
    });
    const info = { available: false } as never;
    const dry = await installSpicetify(runtime, info, {
      dryRun: true,
      approve: async () => {
        throw new Error("approve must not be called on dry-run");
      },
    });
    assert.equal(dry.code, 0);
    assert.match(dry.stdout, /Would run/);
    assert.equal(runtime.calls.length, 0);

    let approvedDetails: { method: string; command: string; source: string } | null = null as { method: string; command: string; source: string } | null;
    const approvedRuntime = createFakeRuntime(root, {
      env: {},
      which: { winget: "C:\\winget.exe", spicetify: undefined },
      run: (file, args) => {
        assert.equal(file, "C:\\winget.exe");
        assert.deepEqual(args, [
          "install",
          "--id",
          "Spicetify.Spicetify",
          "-e",
          "--source",
          "winget",
          "--accept-package-agreements",
          "--accept-source-agreements",
        ]);
        return { code: 0, stdout: "installed", stderr: "" };
      },
    });
    const approved = await installSpicetify(approvedRuntime, info, {
      dryRun: false,
      approve: async (details) => {
        approvedDetails = details;
        return true;
      },
    });
    assert.equal(approved.code, 0);
    assert.equal(approvedDetails?.method, "winget");
    assert.match(approvedDetails?.command ?? "", /winget install/);

    const refusedRuntime = createFakeRuntime(root, {
      env: {},
      which: { winget: "C:\\winget.exe" },
      run: () => {
        throw new Error("must not execute without approval");
      },
    });
    const refused = await installSpicetify(refusedRuntime, info, {
      dryRun: false,
      approve: async () => false,
    });
    assert.equal(refused.code, 1);
    assert.equal(refusedRuntime.calls.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("script install downloads, hashes, approves, runs pwsh -File and cleans temp", async () => {
  const root = await tempRoot("spicetify-script-");
  const originalFetch = globalThis.fetch;
  try {
    const tempDir = join(root, "temp");
    await mkdir(tempDir, { recursive: true });
    let fetchCalls = 0;
    const scriptBody = "Write-Host 'spicetify installer'";
    // @ts-expect-error test double
    globalThis.fetch = async (url: string) => {
      fetchCalls++;
      assert.equal(url, SPICETIFY_INSTALL_SCRIPT_URL);
      return { ok: true, status: 200, text: async () => scriptBody };
    };
    const pwshPath = "C:\\pwsh.exe";
    let executed: { file: string; args: string[] } | null = null;
    const runtime = createFakeRuntime(root, {
      env: { TEMP: tempDir, TMP: tempDir, APPDATA: join(root, "Roaming"), LOCALAPPDATA: join(root, "Local") },
      which: { pwsh: pwshPath },
      run: (file, args) => {
        if (file === pwshPath && args.includes("-File")) {
          executed = { file, args };
          const tempFile = args[args.indexOf("-File") + 1]!;
          assert.ok(existsSync(tempFile));
          assert.equal(readFileSync(tempFile, "utf8"), scriptBody);
          return { code: 0, stdout: "installed", stderr: "" };
        }
        return { code: 1, stdout: "", stderr: "" };
      },
    });
    let details: { method: string; command: string; source: string; checksum?: string } | null = null as { method: string; command: string; source: string; checksum?: string } | null;
    const result = await installSpicetify(runtime, { available: false } as never, {
      dryRun: false,
      approve: async (value) => {
        details = value;
        return true;
      },
    });
    assert.equal(result.code, 0);
    assert.equal(fetchCalls, 1);
    assert.equal(details?.method, "official-script");
    assert.equal(details?.source, SPICETIFY_INSTALL_SCRIPT_URL);
    assert.match(details?.checksum ?? "", /^sha256:[a-f0-9]{64}$/);
    assert.match(details?.command ?? "", /-File/);
    assert.ok(executed);
    const usedTemp = (executed as unknown as { args: string[] }).args[
      (executed as unknown as { args: string[] }).args.indexOf("-File") + 1
    ]!;
    assert.equal(existsSync(usedTemp), false);

    // Refusal cleans temp and never executes.
    let secondTemp: string | null = null;
    const refuseRuntime = createFakeRuntime(root, {
      env: { TEMP: tempDir, TMP: tempDir, APPDATA: join(root, "Roaming"), LOCALAPPDATA: join(root, "Local") },
      which: { pwsh: pwshPath },
      run: (file, args) => {
        if (args.includes("-File")) {
          secondTemp = args[args.indexOf("-File") + 1]!;
          throw new Error("must not execute after refusal");
        }
        return { code: 1, stdout: "", stderr: "" };
      },
    });
    const refused = await installSpicetify(refuseRuntime, { available: false } as never, {
      dryRun: false,
      approve: async () => false,
    });
    assert.equal(refused.code, 1);
    if (secondTemp) assert.equal(existsSync(secondTemp), false);

    // Dry-run never downloads.
    fetchCalls = 0;
    const dryRuntime = createFakeRuntime(root, {
      env: { TEMP: tempDir, APPDATA: join(root, "Roaming"), LOCALAPPDATA: join(root, "Local") },
      which: { pwsh: pwshPath },
      run: () => {
        throw new Error("dry-run must not execute");
      },
    });
    const dry = await installSpicetify(dryRuntime, { available: false } as never, {
      dryRun: true,
      approve: async () => {
        throw new Error("dry-run must not ask for approval");
      },
    });
    assert.equal(dry.code, 0);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("upgrade uses owner commands with approval and refuses unknown", async () => {
  const root = await tempRoot("spicetify-upgrade-");
  try {
    const base = {
      available: true,
      configPath: "C:\\config.ini",
      extensionsDir: "C:\\Extensions",
      bridgeRegistered: false,
      version: "2.0.0",
    } as const;
    const scriptRuntime = createFakeRuntime(root, { env: {}, which: {} });
    const scriptResult = await upgradeSpicetify(
      scriptRuntime,
      { ...base, path: "C:\\spicetify.exe", owner: "script" },
      { dryRun: false, approve: async () => true },
    );
    assert.equal(scriptResult.code, 1); // no mocked run handler
    assert.deepEqual(scriptRuntime.calls[0], { file: "C:\\spicetify.exe", args: ["upgrade"] });

    const wingetRuntime = createFakeRuntime(root, {
      env: {},
      which: { winget: "C:\\winget.exe" },
      run: () => ({ code: 0, stdout: "", stderr: "" }),
    });
    await upgradeSpicetify(
      wingetRuntime,
      { ...base, path: "C:\\sp.exe", owner: "winget" },
      { approve: async () => true },
    );
    assert.deepEqual(wingetRuntime.calls[0]?.args, [
      "upgrade",
      "--id",
      "Spicetify.Spicetify",
      "-e",
      "--source",
      "winget",
      "--accept-package-agreements",
      "--accept-source-agreements",
    ]);

    const scoopRuntime = createFakeRuntime(root, {
      env: {},
      which: { scoop: "C:\\scoop.exe" },
      run: () => ({ code: 0, stdout: "", stderr: "" }),
    });
    await upgradeSpicetify(scoopRuntime, { ...base, path: "C:\\sp.exe", owner: "scoop" }, { approve: async () => true });
    assert.deepEqual(scoopRuntime.calls[0]?.args, ["update", "spicetify"]);

    const chocoRuntime = createFakeRuntime(root, {
      env: {},
      which: { choco: "C:\\choco.exe" },
      run: () => ({ code: 0, stdout: "", stderr: "" }),
    });
    await upgradeSpicetify(chocoRuntime, { ...base, path: "C:\\sp.exe", owner: "choco" }, { approve: async () => true });
    assert.deepEqual(chocoRuntime.calls[0]?.args, ["upgrade", "spicetify", "-y"]);

    const unknownRuntime = createFakeRuntime(root, {
      env: {},
      which: {},
      run: () => {
        throw new Error("unknown owner must not execute");
      },
    });
    const unknown = await upgradeSpicetify(
      unknownRuntime,
      { ...base, path: "C:\\sp.exe", owner: "unknown" },
      { approve: async () => true },
    );
    assert.equal(unknown.code, 1);

    const dryRuntime = createFakeRuntime(root, {
      env: {},
      which: { winget: "C:\\winget.exe" },
      run: () => {
        throw new Error("dry-run must not execute");
      },
    });
    const dry = await upgradeSpicetify(
      dryRuntime,
      { ...base, path: "C:\\sp.exe", owner: "winget" },
      { dryRun: true, approve: async () => true },
    );
    assert.equal(dry.code, 0);
    assert.equal(dryRuntime.calls.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("applySpicetify only runs after approval", async () => {
  const root = await tempRoot("spicetify-apply-");
  try {
    const deniedRuntime = createFakeRuntime(root, {
      env: {},
      which: { spicetify: "C:\\sp.exe" },
      run: () => {
        throw new Error("must not run without approval");
      },
    });
    const denied = await applySpicetify(deniedRuntime, "C:\\sp.exe", false);
    assert.equal(denied.code, 1);
    assert.equal(deniedRuntime.calls.length, 0);

    const explicitRuntime = createFakeRuntime(root, { env: {}, which: {} });
    (explicitRuntime as { calls: { file: string; args: string[] }[] }).calls.length = 0;
    const withHandler = createFakeRuntime(root, {
      env: {},
      which: {},
      run: (file, args) => {
        assert.equal(file, "C:\\sp.exe");
        assert.deepEqual(args, ["apply"]);
        return { code: 0, stdout: "ok", stderr: "" };
      },
    });
    const ok = await applySpicetify(withHandler, "C:\\sp.exe", true);
    assert.equal(ok.code, 0);
    void explicitRuntime;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
