import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync, statSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type { CommandResult, Runtime, SpicetifyInfo } from "../src/cli/types.ts";
import {
  inspectSpicetify,
  inspectSpotify,
  installSpicetify,
  upgradeSpicetify,
  applySpicetify,
  backupSpicetify,
  restoreSpotifyFromBackup,
  spicetifyManualDetails,
  managerUninstallArgs,
  SPOTIFY_STORE_QUERY,
  SPICETIFY_MANUAL_URL,
  SPICETIFY_RELEASES_PAGE,
  SPICETIFY_WINGET_ID,
} from "../src/cli/spicetify.ts";
import { createCancelToken } from "../src/cli/cancel.ts";

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

test("version and owner via fast path only (zero manager probes)", async () => {
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
    const wingetRuntime = createFakeRuntime(root, {
      env: { APPDATA: join(root, "Roaming"), LOCALAPPDATA: join(root, "Local") },
      which: async (name: string) => {
        if (name === "spicetify") return plainExe;
        if (name === "winget") return "C:\\winget.exe";
        if (name === "scoop") return "C:\\scoop.exe";
        if (name === "choco") return "C:\\choco.exe";
        return undefined;
      },
      run: (file, args) => {
        if (args[0] === "-v") return { code: 0, stdout: "2.3.0", stderr: "" };
        if (args[0] === "-c") return { code: 0, stdout: `${config}\n`, stderr: "" };
        if (args[0] === "path") return { code: 0, stdout: "", stderr: "" };
        if (file === "C:\\winget.exe" || file === "C:\\scoop.exe" || file === "C:\\choco.exe") {
          throw new Error("official-only detection must not spawn manager list probes");
        }
        return { code: 1, stdout: "", stderr: "" };
      },
    });
    const wingetInfo = await inspectSpicetify(wingetRuntime);
    // Fast path only: a plain path stays unknown even when managers exist.
    assert.equal(wingetInfo.owner, "unknown");
    assert.ok(!wingetRuntime.calls.some((call) => /winget|scoop|choco/i.test(call.file)));

    const wingetExe = "C:\\Users\\tester\\AppData\\Local\\Microsoft\\winget\\Packages\\Spicetify.Spicetify_Mock\\spicetify.exe";
    const wingetPathRuntime = createFakeRuntime(root, {
      env: { APPDATA: join(root, "Roaming"), LOCALAPPDATA: join(root, "Local") },
      which: { spicetify: wingetExe },
      run: (file, args) => {
        if (args[0] === "-v") return { code: 0, stdout: "2.3.0", stderr: "" };
        if (args[0] === "-c") return { code: 0, stdout: `${config}\n`, stderr: "" };
        return { code: 1, stdout: "", stderr: "" };
      },
    });
    const wingetPathInfo = await inspectSpicetify(wingetPathRuntime);
    assert.equal(wingetPathInfo.owner, "winget");
    assert.ok(!wingetPathRuntime.calls.some((call) => /(?:^|\\)(winget|scoop|choco)(\.exe)?$/i.test(call.file)),
      "no manager list probe is spawned (the spicetify exe path itself may live under a manager dir)");

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

test("official installer requires approval and dry-run plans without executing", async () => {
  const root = await tempRoot("spicetify-official-");
  try {
    const runtime = createFakeRuntime(root, {
      env: {},
      which: {},
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

    const offlineRuntime = createFakeRuntime(root, {
      env: {},
      which: {},
      run: () => {
        throw new Error("offline must not execute any child process");
      },
    });
    const offline = await installSpicetify(offlineRuntime, { available: false } as never, {
      dryRun: false,
      offline: true,
      approve: async () => {
        throw new Error("offline must not ask for approval");
      },
    });
    assert.equal(offline.code, 1);
    assert.match(offline.error ?? "", /offline|manual/i);
    assert.equal(offlineRuntime.calls.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("existing installs use the official installer (no E_OWNER refusal)", async () => {
  const root = await tempRoot("spicetify-manual-");
  try {
    assert.equal(SPICETIFY_WINGET_ID, "Spicetify.Spicetify");
    for (const owner of ["winget", "scoop", "choco", "script", "unknown"] as const) {
      const runtime = createFakeRuntime(root, {
        env: {},
        which: {},
        run: () => {
          throw new Error("dry-run must not execute any child process");
        },
      });
      const result = await installSpicetify(runtime, { available: true, owner, path: "C:\\sp.exe" } as never, {
        dryRun: true,
        approve: async () => {
          throw new Error("approve must not be called on dry-run");
        },
      });
      assert.equal(result.code, 0, owner);
      assert.match(result.stdout, /Would run/, owner);
      assert.doesNotMatch(result.error ?? "", /E_OWNER/, owner);
      assert.equal(runtime.calls.length, 0, owner);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("upgrade uses the official installer for every owner (no manager commands, no E_OWNER)", async () => {
  const root = await tempRoot("spicetify-upgrade-");
  try {
    const base = {
      available: true,
      configPath: "C:\\config.ini",
      extensionsDir: "C:\\Extensions",
      bridgeRegistered: false,
      version: "2.0.0",
    } as const;
    for (const owner of ["winget", "scoop", "choco", "script", "unknown"] as const) {
      const dryRuntime = createFakeRuntime(root, {
        env: {},
        which: {},
        run: () => {
          throw new Error("dry-run must not execute");
        },
      });
      const dry = await upgradeSpicetify(
        dryRuntime,
        { ...base, path: "C:\\sp.exe", owner },
        { dryRun: true, approve: async () => true },
      );
      assert.equal(dry.code, 0, owner);
      assert.match(dry.stdout, /pinned official installer/, owner);
      assert.doesNotMatch(dry.stdout, /winget upgrade|scoop update|choco upgrade/, owner);
      assert.equal(dryRuntime.calls.length, 0, owner);
    }

    const scriptRuntime = createFakeRuntime(root, { env: {}, which: {} });
    const scriptResult = await upgradeSpicetify(
      scriptRuntime,
      { ...base, path: "C:\\spicetify.exe", owner: "script" },
      { dryRun: false, approve: async () => true },
    );
    // Every owner uses the pinned official installer flow; the unverified
    // `spicetify upgrade` self-updater and manager upgrade commands are never used.
    assert.ok(!scriptRuntime.calls.some((call) => call.file === "C:\\spicetify.exe" && call.args[0] === "upgrade"),
      "script-owned upgrade must not invoke spicetify.exe upgrade");
    assert.ok(!scriptRuntime.calls.some((call) => /winget|scoop|choco/i.test(call.file)),
      "official-only upgrade must not invoke a package manager");
    assert.doesNotMatch(scriptResult.error ?? "", /E_OWNER/);

    const unknownRuntime = createFakeRuntime(root, {
      env: {},
      which: {},
      run: () => {
        throw new Error("unknown owner without approval must not execute a manager command");
      },
    });
    const unknown = await upgradeSpicetify(
      unknownRuntime,
      { ...base, path: "C:\\sp.exe", owner: "unknown" },
      { approve: async () => true },
    );
    // Unknown owners migrate through the official installer (E_APPROVAL when no
    // console/pwsh, never E_OWNER).
    assert.doesNotMatch(unknown.error ?? "", /E_OWNER/);
    assert.ok(!unknownRuntime.calls.some((call) => /winget|scoop|choco/i.test(call.file)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("managerUninstallArgs stays exported for migration cleanup", () => {
  assert.deepEqual(managerUninstallArgs("winget"), {
    binary: "winget",
    args: ["uninstall", "--id", SPICETIFY_WINGET_ID, "-e", "--accept-source-agreements", "--disable-interactivity"],
  });
  assert.deepEqual(managerUninstallArgs("scoop"), { binary: "scoop", args: ["uninstall", "spicetify-cli"] });
  assert.deepEqual(managerUninstallArgs("choco"), { binary: "choco", args: ["uninstall", "spicetify-cli", "-y"] });
  assert.equal(managerUninstallArgs("script"), null);
  assert.equal(managerUninstallArgs("unknown"), null);
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

// ---------------------------------------------------------------------------
// B26/B28: dynamic manual targets and cancellation boundaries
// ---------------------------------------------------------------------------

test("manual details are dynamic and never invent a target version", () => {
  const none = spicetifyManualDetails();
  assert.match(none, new RegExp(SPICETIFY_RELEASES_PAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(none, /Target version: v\d/);
  assert.ok(!none.includes("2.46.7"), "retired hardcoded target must not leak");
  assert.match(none, /Marketplace step .*removed from the staged script/i);

  const resolved = spicetifyManualDetails({ version: "2.49.3" }, "x64");
  assert.match(resolved, /Target version: v2\.49\.3/);
  assert.match(resolved, /spicetify-2\.49\.3-windows-x64\.zip/);
  assert.match(resolved, /Asset URL: https:\/\/github\.com\/spicetify\/cli\/releases\/download\/v2\.49\.3\//);

  const custom = spicetifyManualDetails(
    {
      tagName: "v2.49.3",
      assetName: "custom-win.zip",
      assetUrl: "https://github.com/spicetify/cli/releases/download/v2.49.3/custom-win.zip",
      digest: "sha256:abc",
    },
    "arm64",
  );
  assert.match(custom, /Target version: v2\.49\.3/);
  assert.match(custom, /custom-win\.zip/);
  assert.match(custom, /Expected digest: sha256:abc/);

  const prerelease = spicetifyManualDetails({ version: "2.50.0-beta.1" }, "x64");
  assert.doesNotMatch(prerelease, /Target version: v\d/);
  assert.match(prerelease, /releases/);
});

test("official-only upgrade cancellation never claims a manager upgrade", async () => {
  const root = await tempRoot("spicetify-cancel-manager-");
  try {
    const info: SpicetifyInfo = {
      available: true,
      path: "C:\\sp.exe",
      version: "2.0.0",
      owner: "winget",
      configPath: null,
      extensionsDir: null,
      bridgeRegistered: false,
    };

    // A dry-run upgrade for a manager-owned copy plans the official installer
    // without executing any manager child.
    const dryRuntime = createFakeRuntime(root, { env: {}, which: { winget: "C:\\winget.exe" }, run: () => { throw new Error("must not run"); } });
    const dry = await upgradeSpicetify(dryRuntime, info, { dryRun: true, approve: async () => true });
    assert.equal(dry.code, 0);
    assert.match(dry.stdout, /pinned official installer/);
    assert.equal(dryRuntime.calls.length, 0);

    // Pre-cancelled apply/backup/restore stay cancelled before start.
    const alreadyRequested = createCancelToken();
    alreadyRequested.request("sigint");
    const first = createFakeRuntime(root, { env: {}, which: { winget: "C:\\winget.exe" }, run: () => { throw new Error("must not run"); } });
    const firstResult = await applySpicetify(first, "C:\\sp.exe", true, { cancel: alreadyRequested });
    assert.equal(firstResult.code, 130);
    assert.equal(firstResult.cancelled, true);
    assert.equal(first.calls.length, 0);

    const duringApproval = createCancelToken();
    void info;
    void duringApproval;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("apply and backup are cancelled only before the start and protected afterwards", async () => {
  const root = await tempRoot("spicetify-cancel-apply-");
  try {
    const token = createCancelToken();
    let seenCancel: unknown;
    let runs = 0;
    const runtime = createFakeRuntime(root, { env: {}, which: {} });
    runtime.run = async (_file, _args, options) => {
      runs += 1;
      seenCancel = (options as { cancel?: unknown } | undefined)?.cancel;
      // A mid-flight cancellation must not change the result of an apply that
      // already started: verification/running to completion is protected.
      token.request("sigint");
      return { code: 0, stdout: "ok", stderr: "" };
    };
    const applied = await applySpicetify(runtime, "C:\\sp.exe", true, { cancel: token });
    assert.equal(applied.code, 0);
    assert.equal(runs, 1);
    assert.equal(seenCancel, token);

    const preCancelled = createCancelToken();
    preCancelled.request("sigint");
    const untouched = createFakeRuntime(root, { env: {}, which: {}, run: () => { throw new Error("must not run"); } });
    const blockedApply = await applySpicetify(untouched, "C:\\sp.exe", true, { cancel: preCancelled });
    assert.equal(blockedApply.code, 130);
    assert.equal(blockedApply.cancelled, true);
    assert.equal(untouched.calls.length, 0);
    const blockedBackup = await backupSpicetify(untouched, "C:\\sp.exe", { cancel: preCancelled });
    assert.equal(blockedBackup.code, 130);
    assert.equal(untouched.calls.length, 0);

    const backupToken = createCancelToken();
    let backupOptions: unknown;
    const backupRuntime = createFakeRuntime(root, { env: {}, which: {} });
    backupRuntime.run = async (_file, _args, options) => {
      backupOptions = options;
      return { code: 0, stdout: "backup ok", stderr: "" };
    };
    const backup = await backupSpicetify(backupRuntime, "C:\\sp.exe", { cancel: backupToken });
    assert.equal(backup.code, 0);
    assert.equal((backupOptions as { cancel?: unknown }).cancel, backupToken);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restore refuses to start after cancellation", async () => {
  const root = await tempRoot("spicetify-cancel-restore-");
  try {
    const token = createCancelToken();
    token.request("sigint");
    const runtime = createFakeRuntime(root, { env: {}, which: {}, run: () => { throw new Error("must not run"); } });
    const info: SpicetifyInfo = {
      available: true,
      path: "C:\\sp.exe",
      version: "2.0.0",
      owner: "script",
      configPath: null,
      extensionsDir: null,
      bridgeRegistered: false,
    };
    const result = await restoreSpotifyFromBackup(runtime, info, { cancel: token });
    assert.equal(result.code, 130);
    assert.equal(result.cancelled, true);
    assert.equal(runtime.calls.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
