// Official Spicetify installer coverage (B25/B26/B27/B28).
//
// Every installer child, download, resolver, hash and PATH read is injected:
// no real install, network call, PATH write, or file-system mutation happens
// except for two deliberately tiny pwsh probes that prove the inherited-stdio
// runner and the policy-block exit mapping. No test asserts a static install
// target; the reviewed 2.46.7 ledger entry is used only for digest tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OFFICIAL_INSTALLER_BYTES,
  OFFICIAL_INSTALLER_MARKETPLACE_BLOCK_BYTES,
  OFFICIAL_INSTALLER_PATCHED_BYTES,
  OFFICIAL_INSTALLER_PATCHED_SHA256,
  OFFICIAL_INSTALLER_SHA256,
  REVIEWED_SPICETIFY_RELEASES,
} from "../src/cli/compat.ts";
import {
  buildOfficialWrapperCommand,
  defaultRunInteractive,
  describeOfficialCommand,
  installSpicetify,
  officialInstallerWarnings,
  officialSpicetifyDir,
  patchOfficialInstallerScript,
  upgradeSpicetify,
  verifyOfficialInstallerScript,
  verifyOfficialSpicetify,
} from "../src/cli/spicetify-official.ts";
import type {
  OfficialInstallerApproval,
  OfficialInstallerOptions,
  OfficialInteractiveCommand,
} from "../src/cli/spicetify-official.ts";
import { createCancelToken } from "../src/cli/cancel.ts";
import {
  SPICETIFY_BACKUP_SIZE_RANGE,
  inspectBackupStateDetailed,
  spicetifyBackupCandidates,
} from "../src/cli/spicetify.ts";
import type { SpicetifyInfo } from "../src/cli/types.ts";
import { fakeRuntime } from "./cli-fixture.ts";
import type { FakeRuntime } from "./cli-fixture.ts";
import {
  FUTURE_VERSION,
  NEWER_VERSION,
  futureRelease,
  officialScriptBytes,
} from "./release-fixture.ts";

const LOCAL_DIR = "C:\\Users\\Test\\AppData\\Local\\spicetify";
const EXE = `${LOCAL_DIR}\\spicetify.exe`;

function missingSpicetify(version: string | null = null): SpicetifyInfo {
  return {
    available: false,
    path: null,
    version,
    owner: "unknown",
    configPath: null,
    extensionsDir: null,
    bridgeRegistered: false,
  };
}

function installedSpicetify(version: string | null, owner: SpicetifyInfo["owner"] = "script"): SpicetifyInfo {
  return {
    available: true,
    path: EXE,
    version,
    owner,
    configPath: "C:\\Users\\Test\\AppData\\Roaming\\spicetify\\config-xpui.ini",
    extensionsDir: "C:\\Users\\Test\\AppData\\Roaming\\spicetify\\Extensions",
    bridgeRegistered: false,
  };
}

function patchedBytes(): Uint8Array {
  const result = patchOfficialInstallerScript(officialScriptBytes());
  if (!result.ok) throw new Error(`${result.code}: ${result.error}`);
  return result.bytes;
}

/** Deterministic runtime with the official installer's required child env. */
function officialRuntime(version = FUTURE_VERSION): FakeRuntime {
  const runtime = fakeRuntime();
  runtime.state.spicetify.available = false;
  runtime.state.spicetify.version = version;
  runtime.env.LOCALAPPDATA = "C:\\Users\\Test\\AppData\\Local";
  runtime.env.APPDATA = "C:\\Users\\Test\\AppData\\Roaming";
  runtime.env.PROCESSOR_ARCHITECTURE = "AMD64";
  runtime.env.SystemRoot = "C:\\Windows";
  runtime.env.windir = "C:\\Windows";
  runtime.env.PATH = "C:\\Windows\\System32;C:\\Program Files\\PowerShell\\7";
  runtime.env.TEMP = "C:\\Temp";
  runtime.env.USERPROFILE = "C:\\Users\\Test";
  runtime.env.ComSpec = "C:\\Windows\\System32\\cmd.exe";
  const baseRun = runtime.run.bind(runtime);
  runtime.run = (async (file, args, execOptions) => {
    const joined = args.join(" ");
    if (file.toLowerCase().includes("pwsh") && joined.includes("Get-AuthenticodeSignature")) {
      return {
        code: 0,
        stdout: JSON.stringify({
          Status: "Valid",
          Subject: "CN=SignPath Foundation, O=SignPath Foundation, C=US",
          SimpleName: "SignPath Foundation",
        }),
        stderr: "",
      };
    }
    return baseRun(file, args, execOptions);
  }) as typeof runtime.run;
  return runtime;
}

/** The executable exists as a file, but not where the current PATH sees it. */
function executableOnly(runtime: FakeRuntime, options: { exists?: boolean } = {}): FakeRuntime {
  const baseIsFile = runtime.isFile.bind(runtime);
  const baseExists = runtime.exists.bind(runtime);
  runtime.isFile = (path) => path.toLowerCase() === EXE.toLowerCase() || baseIsFile(path);
  runtime.exists = (path) => path.toLowerCase() === EXE.toLowerCase() ? options.exists === true : baseExists(path);
  return runtime;
}

interface Harness {
  deps: OfficialInstallerOptions;
  approvals: OfficialInstallerApproval[];
  stage: { cleaned: number; calls: number; bytes: Uint8Array | null };
  userPath: { reads: number; writes: string[] };
  kill: { pids: Array<number | undefined> };
  interactive: { commands: OfficialInteractiveCommand[]; ran: boolean };
}

function harness(runtime: FakeRuntime, overrides: Partial<OfficialInstallerOptions> = {}): Harness {
  const approvals: OfficialInstallerApproval[] = [];
  const stage = { cleaned: 0, calls: 0, bytes: null as Uint8Array | null };
  const userPath = { reads: 0, writes: [] as string[] };
  const kill = { pids: [] as Array<number | undefined> };
  const interactive = { commands: [] as OfficialInteractiveCommand[], ran: false };
  const ledger = REVIEWED_SPICETIFY_RELEASES["2.46.7"]!;
  const deps: OfficialInstallerOptions = {
    scriptBytes: officialScriptBytes(),
    approve: async (details) => { approvals.push(details); return true; },
    isElevated: async () => false,
    languageMode: async () => "FullLanguage",
    hasConsole: () => true,
    readUserPath: async () => { userPath.reads += 1; return LOCAL_DIR; },
    writeUserPath: async (_runtime, _pwsh, value) => { userPath.writes.push(value); return true; },
    hashFile: () => ledger.sha256,
    fileSize: () => ledger.size,
    resolveRelease: async () => ({ ok: true, release: futureRelease() }),
    stageScript: async (bytes) => {
      stage.calls += 1;
      stage.bytes = Uint8Array.from(bytes);
      return {
        path: "C:\\Temp\\install.ps1",
        sha256: OFFICIAL_INSTALLER_PATCHED_SHA256,
        cleanup: () => { stage.cleaned += 1; },
      };
    },
    runInteractive: async (command) => {
      interactive.ran = true;
      interactive.commands.push(command);
      return { code: 0, stdout: "", stderr: "" };
    },
    killTree: async (pid) => { kill.pids.push(pid); },
    ...overrides,
  };
  return { deps, approvals, stage, userPath, kill, interactive };
}

function avoided(name: string): never {
  throw new Error(`${name} must not run`);
}

// ---------------------------------------------------------------------------
// Original pin + reviewed Marketplace patch
// ---------------------------------------------------------------------------

test("the embedded fixture is exactly the A02-pinned installer script", () => {
  const bytes = officialScriptBytes();
  assert.equal(bytes.byteLength, OFFICIAL_INSTALLER_BYTES);
  const checked = verifyOfficialInstallerScript(bytes);
  assert.equal(checked.ok, true, checked.error);
  assert.equal(checked.sha256, OFFICIAL_INSTALLER_SHA256);
});

test("the reviewed patch produces exactly 8236 bytes / 056da19e… and only the Marketplace block differs", () => {
  const original = officialScriptBytes();
  const result = patchOfficialInstallerScript(original);
  assert.equal(result.ok, true, result.ok ? "" : result.error);
  if (!result.ok) return;

  assert.equal(result.bytes.byteLength, OFFICIAL_INSTALLER_PATCHED_BYTES);
  assert.equal(result.sha256, OFFICIAL_INSTALLER_PATCHED_SHA256);

  const start = Buffer.from(original).indexOf(Buffer.from("#region Marketplace"));
  const endMarker = Buffer.from(original).indexOf(Buffer.from("#endregion Marketplace"));
  const block = Buffer.from(original.subarray(start, endMarker + Buffer.byteLength("#endregion Marketplace")));
  assert.equal(block.length, OFFICIAL_INSTALLER_MARKETPLACE_BLOCK_BYTES);

  const patched = Buffer.from(result.bytes);
  assert.deepEqual(patched.subarray(0, start), Buffer.from(original.subarray(0, start)), "prefix is byte-identical");
  assert.deepEqual(patched.subarray(patched.length - 19), Buffer.from(original.subarray(original.length - 19)), "suffix is byte-identical");

  const text = patched.toString("ascii");
  assert.equal(patched.length, 8236);
  assert.ok(!text.includes("spicetify-marketplace"), "no Marketplace repository URL");
  assert.ok(!text.includes("Do you also want to install Spicetify Marketplace"), "no Marketplace prompt");
  assert.ok(!text.includes("Invoke-Expression"), "no Invoke-Expression");
  assert.equal((text.match(/Invoke-WebRequest @Parameters/g) ?? []).length, 1, "only the binary download remains");
  assert.equal((text.match(/#region Marketplace/g) ?? []).length, 1);
  // The 19-line comment block replaced the 19-line executable region; the
  // original's three LF-only lines are outside this region and stay untouched.
  assert.equal(text.split(/\r\n|\n/).length - 1, 243, "line count is unchanged");
  for (const byte of result.bytes) assert.ok(byte <= 0x7f, "patched script stays ASCII");
});

test("patch refuses any non-pinned original before it looks at structure", () => {
  const tampered = officialScriptBytes();
  tampered[0] = 0x23;
  const pin = patchOfficialInstallerScript(tampered);
  assert.equal(pin.ok, false);
  if (!pin.ok) assert.equal(pin.code, "E_PIN_MISMATCH");

  // Even a byte that only duplicates a region marker changes the pinned hash,
  // so the function fails at the pin before any structural decision.
  const duplicate = officialScriptBytes();
  const text = Buffer.from(duplicate).toString("ascii").replace("#region Functions", "#region Marketplace");
  const dup = patchOfficialInstallerScript(new Uint8Array(Buffer.from(text, "ascii")));
  assert.equal(dup.ok, false);
  if (!dup.ok) assert.equal(dup.code, "E_PIN_MISMATCH");
});

// ---------------------------------------------------------------------------
// Wrapper / approval text (policy-respecting execution, no sentinel)
// ---------------------------------------------------------------------------

test("the wrapper executes the script file with a held read handle and maps policy/pin/exception exits", () => {
  const wrapper = buildOfficialWrapperCommand(FUTURE_VERSION);
  assert.match(wrapper, new RegExp(`\\$v='${FUTURE_VERSION.replace(/\./g, "\\.")}'`));
  assert.match(wrapper, /\[IO\.File\]::Open\(\$env:SPX_SCRIPT,'Open','Read','Read'\)/);
  assert.match(wrapper, /& \$env:SPX_SCRIPT/);
  assert.doesNotMatch(wrapper, /Invoke-Expression/);
  assert.doesNotMatch(wrapper, /SPX_WRAPPER_COMPLETED/);
  assert.match(wrapper, /exit 90/);
  assert.match(wrapper, /exit 91/);
  assert.match(wrapper, /exit 92/);
  assert.match(wrapper, /PSSecurityException/);
  assert.match(wrapper, /ComputeHash/);

  assert.match(describeOfficialCommand(FUTURE_VERSION), /held-handle SHA-256 re-check/);
  assert.match(describeOfficialCommand(FUTURE_VERSION), /answer upstream prompts yourself/);
  assert.doesNotMatch(describeOfficialCommand(FUTURE_VERSION), /sentinel/i);
});

test("release targets with injection characters never reach the wrapper", () => {
  for (const value of [
    "9.9.9'; Write-Output pwned; '",
    "9.9.9; Remove-Item -Recurse C:\\",
    "9.9.9-rc.1",
    "v9.9.9+build",
    "",
  ]) {
    assert.throws(() => buildOfficialWrapperCommand(value), /E_NO_TARGET/);
  }
});

test("warnings disclose the reviewed patch, the remaining default-Yes prompt, and digest availability honestly", () => {
  const noDigest = officialInstallerWarnings("install", futureRelease(), "authenticode+version").join("\n");
  assert.match(noDigest, /Marketplace prompt and download\/evaluation branch removed/i);
  assert.match(noDigest, /No Marketplace URL/);
  assert.match(noDigest, /answer No/i);
  assert.match(noDigest, /defaults to Yes/);
  assert.match(noDigest, /No reviewed per-release executable digest exists for v9\.9\.9/);
  assert.match(noDigest, /execution policy/i);
  assert.doesNotMatch(noDigest, /declined automatically|pre-answered/i);

  const reviewed = officialInstallerWarnings("install", futureRelease({ version: "2.46.7" }), "reviewed-digest").join("\n");
  assert.match(reviewed, /reviewed SHA-256 and size/);
  assert.match(reviewed, /v2\.46\.7/);
});

// ---------------------------------------------------------------------------
// Successful install: resolved target, staged patched bytes, minimal env
// ---------------------------------------------------------------------------

test("a successful install resolves latest stable once, executes the patched bytes, and verifies provenance", async () => {
  const runtime = executableOnly(officialRuntime(FUTURE_VERSION), { exists: false });
  const h = harness(runtime);
  const result = await installSpicetify(runtime, missingSpicetify(), h.deps);

  assert.equal(result.code, 0, result.error ?? result.stderr);
  assert.match(result.stdout, /installed via the pinned official installer script \(Marketplace block removed\) and verified/);
  assert.match(result.stdout, /Release target: v9\.9\.9/);
  assert.match(result.stdout, /Executed SHA-256|executed SHA-256/);
  assert.match(result.stdout, /Artifact provenance: no per-release SHA-256 pin for v9\.9\.9/);
  assert.match(result.stdout, /Marketplace directories: unchanged/);
  assert.match(result.stdout, /new terminal may be required/);
  assert.doesNotMatch(result.stdout, /2\.46\.7/);

  assert.equal(h.approvals.length, 1);
  const approval = h.approvals[0]!;
  assert.equal(approval.targetVersion, FUTURE_VERSION);
  assert.equal(approval.scriptSha256, OFFICIAL_INSTALLER_SHA256);
  assert.equal(approval.executedSha256, OFFICIAL_INSTALLER_PATCHED_SHA256);
  assert.equal(approval.patch, "marketplace-removed");
  assert.equal(approval.provenance, "authenticode+version");
  assert.match(approval.source, /Marketplace block removed/);

  assert.equal(h.interactive.ran, true);
  assert.equal(h.interactive.commands.length, 1);
  const command = h.interactive.commands[0]!;
  assert.equal("input" in command, false);
  assert.equal(command.env.SPX_SCRIPT, "C:\\Temp\\install.ps1");
  assert.equal(command.env.SPX_SCRIPT_SHA256, OFFICIAL_INSTALLER_PATCHED_SHA256);
  assert.equal(command.env.PSModulePath, undefined);
  assert.equal(command.env.LOCALAPPDATA, "C:\\Users\\Test\\AppData\\Local");
  assert.equal(command.env.PROCESSOR_ARCHITECTURE, "AMD64");
  assert.ok(!command.args.join(" ").includes("Invoke-Expression"));

  // The staged bytes are the patched variant, never the original.
  assert.equal(h.stage.calls, 1);
  assert.ok(h.stage.bytes);
  assert.equal(h.stage.bytes!.byteLength, OFFICIAL_INSTALLER_PATCHED_BYTES);
  assert.notDeepEqual(h.stage.bytes, officialScriptBytes());
  assert.equal(h.stage.cleaned, 1);
  assert.deepEqual(h.kill.pids, []);
  // Once for the rollback snapshot, once during post-install verification.
  assert.equal(h.userPath.reads, 2);
});

test("the child receives a minimal environment and missing install-critical values are refused before approval", async () => {
  const runtime = executableOnly(officialRuntime(), { exists: false });
  runtime.env.PSModulePath = "C:\\Evil\\Modules";
  const h = harness(runtime);
  const result = await installSpicetify(runtime, missingSpicetify(), h.deps);
  assert.equal(result.code, 0, result.error);
  assert.equal(h.interactive.commands[0]!.env.PSModulePath, undefined);

  for (const key of ["LOCALAPPDATA", "APPDATA", "PROCESSOR_ARCHITECTURE"] as const) {
    const broken = officialRuntime();
    delete broken.env[key];
    let approved = 0;
    let resolved = 0;
    const b = harness(broken, {
      approve: async () => { approved += 1; return true; },
      resolveRelease: async () => { resolved += 1; return { ok: true, release: futureRelease() }; },
      runInteractive: async () => avoided("execution"),
    });
    const outcome = await installSpicetify(broken, missingSpicetify(), b.deps);
    assert.equal(outcome.code, 1, key);
    assert.match(outcome.error ?? "", /^E_ENV:/, key);
    assert.equal(approved, 0, key);
    assert.equal(resolved, 0, key);
  }
});

test("dry-run performs no resolution, download, approval or execution", async () => {
  const runtime = officialRuntime();
  let resolved = 0;
  const h = harness(runtime, {
    dryRun: true,
    resolveRelease: async () => { resolved += 1; return { ok: true, release: futureRelease() }; },
    fetcher: async () => avoided("download"),
    approve: async () => avoided("approval"),
    runInteractive: async () => avoided("execution"),
  });
  const result = await installSpicetify(runtime, missingSpicetify(), h.deps);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /resolved at run time, never a static version/);
  assert.equal(resolved, 0);
});

// ---------------------------------------------------------------------------
// Resolution failures: no target, no fallback, nothing executed
// ---------------------------------------------------------------------------

test("resolution failures surface their own code and never fall back to a static version", async () => {
  const cases: Array<{ code: string; result: unknown }> = [
    { code: "E_RATE_LIMIT", result: { ok: false, code: "E_RATE_LIMIT", error: "rate limited", retryAfter: 60 } },
    { code: "E_RELEASE_LOOKUP", result: { ok: false, code: "E_RELEASE_LOOKUP", error: "no stable release (HTTP 404)" } },
    { code: "E_RELEASE_PRERELEASE", result: { ok: false, code: "E_RELEASE_PRERELEASE", error: "prerelease" } },
  ];
  for (const entry of cases) {
    const runtime = officialRuntime();
    let approved = 0;
    const h = harness(runtime, {
      resolveRelease: async () => entry.result as never,
      approve: async () => { approved += 1; return true; },
      fetcher: async () => avoided("download"),
      runInteractive: async () => avoided("execution"),
    });
    const result = await installSpicetify(runtime, missingSpicetify(), h.deps);
    assert.equal(result.code, 1, entry.code);
    assert.match(result.error ?? "", new RegExp(`^${entry.code}:`), entry.code);
    assert.equal(approved, 0, entry.code);
    assert.equal(h.stage.calls, 0, entry.code);
    assert.doesNotMatch(result.error ?? "", /2\.46\.7/);
  }

  const offline = officialRuntime();
  let resolved = 0;
  const offlineHarness = harness(offline, {
    offline: true,
    resolveRelease: async () => { resolved += 1; return { ok: true, release: futureRelease() }; },
    runInteractive: async () => avoided("execution"),
  });
  const offlineResult = await installSpicetify(offline, missingSpicetify(), offlineHarness.deps);
  assert.match(offlineResult.error ?? "", /^E_OFFLINE:/);
  assert.equal(resolved, 0);
});

test("a resolved release with a missing/invalid asset or non-stable version is refused", async () => {
  const runtime = officialRuntime();
  const noAsset = harness(runtime, {
    resolveRelease: async () => ({ ok: true, release: { ...futureRelease(), assets: [] } }),
    runInteractive: async () => avoided("execution"),
  });
  const result = await installSpicetify(runtime, missingSpicetify(), noAsset.deps);
  assert.match(result.error ?? "", /^E_RELEASE_ASSET:/);

  const badVersion = harness(officialRuntime(), {
    resolveRelease: async () => ({ ok: true, release: { ...futureRelease(), version: "9.9.9-rc.1" } }),
    runInteractive: async () => avoided("execution"),
  });
  const bad = await installSpicetify(officialRuntime(), missingSpicetify(), badVersion.deps);
  assert.match(bad.error ?? "", /^E_RELEASE_INVALID:/);
});

test("offline and missing approval/console/elevation/language fail before a child starts", async () => {
  const cases: Array<{ label: string; deps: Partial<OfficialInstallerOptions>; pattern: RegExp }> = [
    { label: "approval missing", deps: { approve: undefined }, pattern: /^E_APPROVAL:/ },
    { label: "no console", deps: { hasConsole: () => false }, pattern: /^E_NO_CONSOLE:/ },
    { label: "elevated", deps: { isElevated: async () => true }, pattern: /^E_ELEVATED:/ },
    { label: "elevation unknown", deps: { isElevated: async () => null }, pattern: /^E_ELEVATED:/ },
    { label: "restricted language", deps: { languageMode: async () => "ConstrainedLanguage" }, pattern: /^E_LANGUAGE_MODE:/ },
    { label: "noninteractive", deps: { nonInteractive: true }, pattern: /^E_NONINTERACTIVE:/ },
  ];
  for (const entry of cases) {
    const runtime = officialRuntime();
    const h = harness(runtime, { ...entry.deps, runInteractive: async () => avoided(entry.label) });
    const result = await installSpicetify(runtime, missingSpicetify(), h.deps);
    assert.equal(result.code, 1, entry.label);
    assert.match(result.error ?? "", entry.pattern, entry.label);
    assert.equal(h.interactive.ran, false, entry.label);
  }

  const noPwsh = officialRuntime();
  noPwsh.which = async (name) => name === "pwsh" ? undefined : "C:\\Tools\\spicetify.exe";
  const result = await installSpicetify(noPwsh, missingSpicetify(), harness(noPwsh).deps);
  assert.match(result.error ?? "", /^E_PWSH:/);
});

// ---------------------------------------------------------------------------
// Exit-code mapping, no sentinel, verification decides success
// ---------------------------------------------------------------------------

test("exit code 0 is never success by itself; verification decides and no sentinel is required", async () => {
  const runtime = executableOnly(officialRuntime(), { exists: false });
  const success = harness(runtime);
  const result = await installSpicetify(runtime, missingSpicetify(), success.deps);
  assert.equal(result.code, 0, result.error);
  assert.doesNotMatch(result.error ?? "", /E_ABORTED/);

  const missingExe = await installSpicetify(
    officialRuntime(),
    missingSpicetify(),
    harness(officialRuntime()).deps,
  );
  assert.equal(missingExe.code, 1);
  assert.match(missingExe.error ?? "", /^E_EXE_MISSING:/);
  assert.match(missingExe.error ?? "", /success is not claimed/);
});

test("90/91/92/other exits map to pin, script-exception, policy-block and generic failures", async () => {
  const pin = await installSpicetify(
    officialRuntime(),
    missingSpicetify(),
    harness(officialRuntime(), { runInteractive: async () => ({ code: 90, stdout: "E_PIN_MISMATCH", stderr: "" }) }).deps,
  );
  assert.match(pin.error ?? "", /^E_PIN_MISMATCH:/);

  const exception = await installSpicetify(
    officialRuntime(),
    missingSpicetify(),
    harness(officialRuntime(), { runInteractive: async () => ({ code: 91, stdout: "E_SCRIPT_EXCEPTION: boom", stderr: "" }) }).deps,
  );
  assert.match(exception.error ?? "", /^E_SCRIPT_FAILED:/);
  assert.match(exception.error ?? "", /raised an exception/);

  const policy = await installSpicetify(
    officialRuntime(),
    missingSpicetify(),
    harness(officialRuntime(), { runInteractive: async () => ({ code: 92, stdout: "E_POLICY_BLOCKED: blocked", stderr: "" }) }).deps,
  );
  assert.match(policy.error ?? "", /^E_POLICY_BLOCKED:/);
  assert.match(policy.error ?? "", /no policy override or bypass/i);
  assert.match(policy.error ?? "", /Manual installation remains available/);

  const failed = await installSpicetify(
    officialRuntime(),
    missingSpicetify(),
    harness(officialRuntime(), { runInteractive: async () => ({ code: 3, stdout: "boom\nsecond line", stderr: "" }) }).deps,
  );
  assert.match(failed.error ?? "", /^E_SCRIPT_FAILED:/);
  assert.match(failed.error ?? "", /exited with code 3/);
  assert.match(failed.error ?? "", /second line/);
});

// ---------------------------------------------------------------------------
// Patch/pin/stage fail-closed
// ---------------------------------------------------------------------------

test("patch and stage failures abort before staging or execution and never fall back to the original", async () => {
  const patchFail = harness(officialRuntime(), {
    patchScript: () => ({ ok: false, code: "E_PATCH_FAILED", error: "reviewed block mismatch" }),
    stageScript: async () => avoided("staging"),
    runInteractive: async () => avoided("execution"),
  });
  const patched = await installSpicetify(officialRuntime(), missingSpicetify(), patchFail.deps);
  assert.match(patched.error ?? "", /^E_PATCH_FAILED:/);
  assert.equal(patchFail.stage.calls, 0);
  assert.equal(patchFail.interactive.ran, false);

  const wrongDigest = harness(officialRuntime(), {
    patchScript: () => ({ ok: true, bytes: patchedBytes(), sha256: "0".repeat(64) }),
    stageScript: async () => avoided("staging"),
    runInteractive: async () => avoided("execution"),
  });
  const digest = await installSpicetify(officialRuntime(), missingSpicetify(), wrongDigest.deps);
  assert.match(digest.error ?? "", /^E_PATCH_MISMATCH:/);
  assert.equal(wrongDigest.stage.calls, 0);

  const tampered = officialScriptBytes();
  tampered[0] = 0x23;
  const pinFail = harness(officialRuntime(), {
    scriptBytes: tampered,
    stageScript: async () => avoided("staging"),
    runInteractive: async () => avoided("execution"),
  });
  const pin = await installSpicetify(officialRuntime(), missingSpicetify(), pinFail.deps);
  assert.match(pin.error ?? "", /^E_PIN_MISMATCH:/);
  assert.equal(pinFail.stage.calls, 0);

  const stageMismatch = harness(officialRuntime(), {
    stageScript: async () => ({
      path: "C:\\Temp\\install.ps1",
      sha256: "0".repeat(64),
      cleanup: () => {},
    }),
    runInteractive: async () => avoided("execution"),
  });
  const staged = await installSpicetify(officialRuntime(), missingSpicetify(), stageMismatch.deps);
  assert.match(staged.error ?? "", /^E_PATCH_MISMATCH:/);
  assert.equal(stageMismatch.interactive.ran, false);
});

test("cancellation exits 130, kills at most once, and never claims success", async () => {
  // A confirmed close is final: no kill follows it, rollback may run.
  const runtime = officialRuntime();
  const h = harness(runtime, {
    readUserPath: async () => "C:\\Users\\Test\\AppData\\Local\\spicetify-old",
    runInteractive: async () => ({ code: null, cancelled: true, pid: 4242, exitConfirmed: true }),
  });
  const removed: string[] = [];
  runtime.remove = (path) => { removed.push(path); };
  const progress: string[] = [];
  const result = await installSpicetify(runtime, missingSpicetify(), { ...h.deps, onProgress: (line) => progress.push(line) });
  assert.equal(result.code, 130);
  assert.equal(result.cancelled, true);
  assert.equal(result.error, "Cancelled by the user.");
  assert.deepEqual(h.kill.pids, [], "no kill after a confirmed close");
  assert.deepEqual(h.userPath.writes, ["C:\\Users\\Test\\AppData\\Local\\spicetify-old"]);
  assert.deepEqual(removed, [officialSpicetifyDir(runtime)]);
  assert.equal(h.stage.cleaned, 1);
  assert.match(progress.join("\n"), /Rollback after interruption/);

  // An unconfirmed close gets exactly one kill, no rollback, and the staged
  // script is left in place (it may still be executable by a live tree).
  const unconfirmed = harness(officialRuntime(), {
    runInteractive: async () => ({ code: null, cancelled: true, pid: 4343, exitConfirmed: false }),
  });
  const unconfirmedResult = await installSpicetify(officialRuntime(), missingSpicetify(), unconfirmed.deps);
  assert.equal(unconfirmedResult.code, 130);
  assert.equal(unconfirmedResult.cancelled, true);
  assert.equal(unconfirmedResult.error, "Cancelled by the user.");
  assert.deepEqual(unconfirmed.kill.pids, [4343], "exactly one kill attempt");
  assert.deepEqual(unconfirmed.userPath.writes, []);
  assert.equal(unconfirmed.stage.cleaned, 0, "staged script is not deleted under a possibly live tree");

  // A runner that already confirmed termination is never killed again.
  const alreadyTerminated = harness(officialRuntime(), {
    runInteractive: async () => ({ code: null, cancelled: true, pid: 4444, terminated: true, exitConfirmed: false }),
  });
  const alreadyResult = await installSpicetify(officialRuntime(), missingSpicetify(), alreadyTerminated.deps);
  assert.equal(alreadyResult.code, 130);
  assert.deepEqual(alreadyTerminated.kill.pids, [], "one kill only, owned by the runner");

  // A late cancel mid-verification still exits 130 and never claims success.
  const late = createCancelToken();
  const lateRuntime = executableOnly(officialRuntime(), { exists: false });
  let pathReads = 0;
  const lateHarness = harness(lateRuntime, {
    cancel: late,
    readUserPath: async () => {
      pathReads += 1;
      if (pathReads === 2) late.request("ctrl-c");
      return LOCAL_DIR;
    },
  });
  const lateResult = await installSpicetify(lateRuntime, missingSpicetify(), lateHarness.deps);
  assert.equal(lateResult.code, 130);
  assert.equal(lateResult.cancelled, true);
  assert.equal(lateResult.error, "Cancelled by the user.");
  assert.doesNotMatch(lateResult.stdout ?? "", /installed via/);
});

test("every official-flow cancellation point returns 130 with cancelled:true and the canonical error", async () => {
  const assertCancelled = (result: { code: number; cancelled?: boolean; error?: string }, label: string) => {
    assert.equal(result.code, 130, label);
    assert.equal(result.cancelled, true, label);
    assert.equal(result.error, "Cancelled by the user.", label);
  };

  // 1. Before resolution.
  const early = createCancelToken();
  early.request("ctrl-c");
  const earlyRuntime = officialRuntime();
  const earlyResult = await installSpicetify(earlyRuntime, missingSpicetify(), {
    ...harness(earlyRuntime, { cancel: early, resolveRelease: async () => avoided("resolution") }).deps,
  });
  assertCancelled(earlyResult, "before resolution");

  // 2. During the installer download.
  const downloadToken = createCancelToken();
  const downloadRuntime = officialRuntime();
  const download = harness(downloadRuntime, {
    scriptBytes: undefined,
    cancel: downloadToken,
    fetcher: (async () => {
      downloadToken.request("ctrl-c");
      // The body is never read: the cancel check runs before it is consumed.
      return new Response("cancelled", { status: 200 });
    }) as typeof fetch,
    runInteractive: async () => avoided("execution"),
  });
  assertCancelled(await installSpicetify(downloadRuntime, missingSpicetify(), download.deps), "during download");
  assert.equal(download.interactive.ran, false);

  // 3. Immediately after approval (before staging).
  const approvalToken = createCancelToken();
  const approvalRuntime = officialRuntime();
  const afterApproval = harness(approvalRuntime, {
    cancel: approvalToken,
    approve: async () => { approvalToken.request("ctrl-c"); return true; },
    runInteractive: async () => avoided("execution"),
  });
  assertCancelled(await installSpicetify(approvalRuntime, missingSpicetify(), afterApproval.deps), "after approval");
  assert.equal(afterApproval.stage.calls, 0);

  // 4. Before staging (patch completed, staging not started).
  const stageToken = createCancelToken();
  const stageRuntime = officialRuntime();
  const beforeStage = harness(stageRuntime, {
    cancel: stageToken,
    patchScript: (bytes) => {
      stageToken.request("ctrl-c");
      return patchOfficialInstallerScript(bytes);
    },
    runInteractive: async () => avoided("execution"),
  });
  assertCancelled(await installSpicetify(stageRuntime, missingSpicetify(), beforeStage.deps), "before staging");
  assert.equal(beforeStage.stage.calls, 0);

  // 5. While the interactive child runs (runner reports the cancel).
  const interactiveRuntime = officialRuntime();
  const interactive = harness(interactiveRuntime, {
    runInteractive: async () => ({ code: null, cancelled: true, pid: 4545, exitConfirmed: true }),
  });
  assertCancelled(await installSpicetify(interactiveRuntime, missingSpicetify(), interactive.deps), "interactive");

  // 6. Mid-verification (cancel arrives while the PATH probe runs).
  const verifyToken = createCancelToken();
  const verifyRuntime = executableOnly(officialRuntime(), { exists: false });
  let reads = 0;
  const verifying = harness(verifyRuntime, {
    cancel: verifyToken,
    readUserPath: async () => {
      reads += 1;
      if (reads === 2) verifyToken.request("ctrl-c");
      return LOCAL_DIR;
    },
  });
  const verifyResult = await installSpicetify(verifyRuntime, missingSpicetify(), verifying.deps);
  assertCancelled(verifyResult, "during verification");
  assert.doesNotMatch(verifyResult.stdout ?? "", /installed via/);
});

// ---------------------------------------------------------------------------
// Marketplace state and unrelated customizations
// ---------------------------------------------------------------------------

test("pre-existing Marketplace directories are preserved and treated as untouched", async () => {
  const runtime = executableOnly(officialRuntime(), { exists: false });
  const baseExists = runtime.exists.bind(runtime);
  const baseIsFile = runtime.isFile.bind(runtime);
  const marketplace = new Set([
    "C:\\Users\\Test\\AppData\\Roaming\\spicetify\\Marketplace",
    "C:\\Users\\Test\\AppData\\Roaming\\spicetify\\Extensions\\marketplace",
    "C:\\Users\\Test\\AppData\\Local\\spicetify\\Marketplace",
  ]);
  runtime.exists = (path) => marketplace.has(path) || baseExists(path);
  runtime.isFile = (path) => marketplace.has(path) ? false : baseIsFile(path);
  const removed: string[] = [];
  runtime.remove = (path) => { removed.push(path); };

  const h = harness(runtime);
  const result = await installSpicetify(runtime, missingSpicetify(), h.deps);
  assert.equal(result.code, 0, result.error);
  assert.match(result.stdout, /Marketplace directories: unchanged/);
  assert.deepEqual(removed, []);
});

test("a Marketplace change after the run warns but never fails verification", async () => {
  const runtime = executableOnly(officialRuntime(), { exists: false });
  const baseExists = runtime.exists.bind(runtime);
  let marketplace = false;
  runtime.exists = (path) => path.includes("Marketplace") ? marketplace : baseExists(path);
  const h = harness(runtime, {
    runInteractive: async () => {
      marketplace = true;
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  const result = await installSpicetify(runtime, missingSpicetify(), h.deps);
  // Official-only engine: Marketplace is installed deterministically by
  // marketplace.ts right after, so a change is a warning, never E_MARKETPLACE_CHANGED.
  assert.equal(result.code, 0, result.error);
  assert.doesNotMatch(result.error ?? "", /E_MARKETPLACE_CHANGED/);
});

// ---------------------------------------------------------------------------
// Backup inspector (L11): first ready candidate, not first existing
// ---------------------------------------------------------------------------

test("backup inspection scans every candidate and returns the first ready one", async () => {
  const runtime = officialRuntime();
  const spicetify = installedSpicetify(FUTURE_VERSION);
  const candidates = spicetifyBackupCandidates(runtime, spicetify);
  assert.ok(candidates.length >= 2);
  const invalidDir = candidates[0]!;
  const readyDir = candidates[1]!;
  assert.notEqual(invalidDir.toLowerCase(), readyDir.toLowerCase());

  const realExists = runtime.exists.bind(runtime);
  const sizes = new Map<string, number>([
    // Existing but truncated payload: the first candidate must not win.
    [join(invalidDir, "xpui.spa"), 1],
    [join(invalidDir, "login.spa"), 1],
    [join(readyDir, "xpui.spa"), SPICETIFY_BACKUP_SIZE_RANGE["xpui.spa"].min + 4_000_000],
    [join(readyDir, "login.spa"), SPICETIFY_BACKUP_SIZE_RANGE["login.spa"].min + 100_000],
  ]);
  const deps = {
    fileSize: (path: string) => sizes.get(path) ?? null,
    listDir: (path: string) =>
      path.toLowerCase() === invalidDir.toLowerCase() || path.toLowerCase() === readyDir.toLowerCase()
        ? ["xpui.spa", "login.spa"]
        : null,
  };

  runtime.exists = (path) => path === invalidDir || path === readyDir || realExists(path);
  const ready = await inspectBackupStateDetailed(runtime, spicetify, deps);
  assert.equal(ready.state, "ready");
  assert.equal(ready.backupDir, readyDir);
  assert.ok(ready.files.every((file) => file.exists && file.plausible));

  // Only the invalid candidate exists: the state stays "unknown" for that
  // existing directory, never "missing" (a failed probe must not look absent).
  runtime.exists = (path) => path === invalidDir || realExists(path);
  const unknown = await inspectBackupStateDetailed(runtime, spicetify, deps);
  assert.equal(unknown.state, "unknown");
  assert.equal(unknown.backupDir, invalidDir);
  assert.match(unknown.error ?? "", /untrustworthy/);

  // No candidate exists: missing.
  runtime.exists = () => false;
  const missing = await inspectBackupStateDetailed(runtime, spicetify, deps);
  assert.equal(missing.state, "missing");
  assert.equal(missing.backupDir, null);
});

test("the executed patch leaves unrelated installer customizations byte-identical", () => {
  const original = Buffer.from(officialScriptBytes()).toString("ascii");
  const patched = Buffer.from(patchedBytes()).toString("ascii");
  for (const anchor of [
    "function Move-OldSpicetifyFolder",
    "function Get-Spicetify",
    "function Add-SpicetifyToPath",
    "function Install-Spicetify",
    "Move-OldSpicetifyFolder\r\nInstall-Spicetify",
    "$installedSpicetify update",
    "Expand-Archive -Path $archivePath",
  ]) {
    assert.equal(patched.includes(anchor), original.includes(anchor), anchor);
    assert.equal(patched.includes(anchor), true, anchor);
  }
});

// ---------------------------------------------------------------------------
// Newer-mid-run and upgrade decisions
// ---------------------------------------------------------------------------

test("a newer stable appearing mid-run is reported but the approved target is what was installed", async () => {
  const runtime = executableOnly(officialRuntime(), { exists: false });
  let resolved = 0;
  const h = harness(runtime, {
    resolveRelease: async () => {
      const version = resolved === 0 ? FUTURE_VERSION : NEWER_VERSION;
      resolved += 1;
      return { ok: true, release: futureRelease({ version }) };
    },
  });
  const result = await installSpicetify(runtime, missingSpicetify(), h.deps);
  assert.equal(result.code, 0, result.error);
  assert.match(result.stdout, /Release target: v9\.9\.9/);
  assert.match(result.stdout, /spicetify -v reports 9\.9\.9/);
  assert.match(result.stdout, new RegExp(`v${NEWER_VERSION.replace(/\./g, "\\.")} is now available`));
  assert.doesNotMatch(result.stdout, /Release target: v9\.10\.0/);
  assert.equal(resolved, 2, "one resolution before approval and one best-effort post-check");
});

test("post-check failures never invalidate a verified install", async () => {
  const runtime = executableOnly(officialRuntime(), { exists: false });
  let count = 0;
  const h = harness(runtime, {
    resolveRelease: async () => {
      count += 1;
      return count === 1
        ? { ok: true, release: futureRelease() }
        : { ok: false, code: "E_RATE_LIMIT", error: "rate limited" };
    },
  });
  const result = await installSpicetify(runtime, missingSpicetify(), h.deps);
  assert.equal(result.code, 0, result.error);
  assert.doesNotMatch(result.stdout, /is now available/);
});

test("official-only upgrades migrate unknown versions, refuse downgrades, no-op on equality, and use the dynamic target", async () => {
  // Unknown installed versions migrate through the official installer instead
  // of refusing with E_VERSION_UNKNOWN (no downgrade comparison is possible).
  const migrating = await upgradeSpicetify(officialRuntime(), installedSpicetify("nightly"), {
    dryRun: true,
    approve: async () => true,
    resolveRelease: async () => ({ ok: true, release: futureRelease() }),
    runInteractive: async () => avoided("execution"),
  });
  assert.equal(migrating.code, 0, migrating.error);
  assert.match(migrating.stdout, /pinned official installer/);
  assert.doesNotMatch(migrating.error ?? "", /E_VERSION_UNKNOWN/);

  const downgrade = await upgradeSpicetify(
    officialRuntime(),
    installedSpicetify("10.0.0"),
    {
      approve: async () => avoided("approval"),
      resolveRelease: async () => ({ ok: true, release: futureRelease() }),
    },
  );
  assert.match(downgrade.error ?? "", /^E_DOWNGRADE:/);
  assert.match(downgrade.error ?? "", /never automatic/);

  const equal = await upgradeSpicetify(
    officialRuntime(),
    installedSpicetify(FUTURE_VERSION),
    {
      approve: async () => avoided("approval"),
      runInteractive: async () => avoided("execution"),
      resolveRelease: async () => ({ ok: true, release: futureRelease() }),
    },
  );
  assert.equal(equal.code, 0);
  assert.match(equal.stdout, /already at the latest stable release v9\.9\.9/);

  const runtime = executableOnly(officialRuntime(), { exists: false });
  const h = harness(runtime, {
    resolveRelease: async () => ({ ok: true, release: futureRelease() }),
  });
  const upgraded = await upgradeSpicetify(runtime, installedSpicetify("2.46.0"), h.deps);
  assert.equal(upgraded.code, 0, upgraded.error);
  assert.equal(h.interactive.ran, true);
  assert.equal(h.approvals[0]!.targetVersion, FUTURE_VERSION);
  assert.ok(!runtime.calls.some((call) => /spicetify(\.exe)? upgrade/i.test(call.args.join(" "))));
});

test("manager-owned upgrades use the official installer with best-effort migration (no manager upgrade)", async () => {
  for (const owner of ["winget", "scoop", "choco", "unknown"] as const) {
    const runtime = executableOnly(officialRuntime(), { exists: false });
    const h = harness(runtime, {
      resolveRelease: async () => ({ ok: true, release: futureRelease() }),
    });
    const baseWhich = runtime.which.bind(runtime);
    runtime.which = (async (name: string) => {
      if (name === "winget" || name === "scoop" || name === "choco") return undefined;
      return baseWhich(name);
    }) as typeof runtime.which;
    const result = await upgradeSpicetify(runtime, installedSpicetify("2.46.0", owner), h.deps);
    assert.equal(result.code, 0, `${owner}: ${result.error ?? ""}`);
    assert.match(result.stdout, /pinned official installer( script)? \(Marketplace block removed\)/, owner);
    assert.equal(h.approvals.length, 1, owner);
    assert.equal(h.approvals[0]!.method, "official-installer", owner);
    assert.equal(h.approvals[0]!.targetVersion, FUTURE_VERSION, owner);
    assert.equal(h.approvals[0]!.provenance, "authenticode+version", owner);
    assert.equal(h.approvals[0]!.patch, "marketplace-removed", owner);
    assert.doesNotMatch(h.approvals[0]!.command, /winget upgrade|scoop update|choco upgrade/, owner);
    const commands = runtime.calls.map((call) => `${call.file} ${call.args.join(" ")}`);
    assert.ok(!commands.some((command) => /winget(\.exe)? upgrade/i.test(command)), owner);
    assert.ok(!commands.some((command) => /scoop(\.exe)? update/i.test(command)), owner);
    assert.ok(!commands.some((command) => /choco(\.exe)? upgrade/i.test(command)), owner);
    assert.ok(!commands.some((command) => /spicetify(\.exe)? update/i.test(command)), owner);
  }

  // Stale shim cleanup: a winget-owned copy with a manager present triggers a
  // best-effort manager uninstall and prepends the official dir on PATH.
  const shimRuntime = executableOnly(officialRuntime(), { exists: false });
  shimRuntime.env.PATH = "C:\\Other\\bin";
  const shimHarness = harness(shimRuntime, {
    resolveRelease: async () => ({ ok: true, release: futureRelease() }),
  });
  const shimBaseWhich = shimRuntime.which.bind(shimRuntime);
  shimRuntime.which = (async (name: string) => {
    if (name === "winget") return "C:\\winget.exe";
    return shimBaseWhich(name);
  }) as typeof shimRuntime.which;
  const shimBaseRun = shimRuntime.run.bind(shimRuntime);
  const managerCalls: string[] = [];
  shimRuntime.run = (async (file: string, args: string[], options?: never) => {
    if (file === "C:\\winget.exe") {
      managerCalls.push(`${file} ${args.join(" ")}`);
      return { code: 0, stdout: "", stderr: "" };
    }
    return shimBaseRun(file, args, options);
  }) as typeof shimRuntime.run;
  const shimmed = await upgradeSpicetify(shimRuntime, installedSpicetify("2.46.0", "winget"), shimHarness.deps);
  assert.equal(shimmed.code, 0, shimmed.error);
  assert.ok(managerCalls.some((command) => command.includes("uninstall")), "shadowing manager copy is cleaned best-effort");
  assert.match(shimRuntime.env.PATH ?? "", /C:\\Users\\Test\\AppData\\Local\\spicetify/i, "official dir wins on PATH");

  // Manager absent: same upgrade still succeeds via the official installer.
  const absentRuntime = executableOnly(officialRuntime(), { exists: false });
  const absentHarness = harness(absentRuntime, {
    resolveRelease: async () => ({ ok: true, release: futureRelease() }),
  });
  const absentBaseWhich = absentRuntime.which.bind(absentRuntime);
  absentRuntime.which = (async (name: string) => {
    if (name === "winget" || name === "scoop" || name === "choco") return undefined;
    return absentBaseWhich(name);
  }) as typeof absentRuntime.which;
  const absent = await upgradeSpicetify(absentRuntime, installedSpicetify("2.46.0", "scoop"), absentHarness.deps);
  assert.equal(absent.code, 0, absent.error);
});

test("upgrade resolution failure refuses with no fallback target", async () => {
  const result = await upgradeSpicetify(officialRuntime(), installedSpicetify("2.46.0"), {
    approve: async () => avoided("approval"),
    resolveRelease: async () => ({ ok: false, code: "E_RELEASE_LOOKUP", error: "no stable release" }),
  });
  assert.equal(result.code, 1);
  assert.match(result.error ?? "", /^E_RELEASE_LOOKUP:/);
  assert.doesNotMatch(result.error ?? "", /2\.46\.7/);
});

// ---------------------------------------------------------------------------
// Verification: ledger-tightened vs Authenticode+version
// ---------------------------------------------------------------------------

test("verifyOfficialSpicetify enforces the reviewed ledger only for its own version and never claims pinned without it", async () => {
  const ledger = REVIEWED_SPICETIFY_RELEASES["2.46.7"]!;
  const reviewedRuntime = executableOnly(officialRuntime("2.46.7"));
  reviewedRuntime.state.spicetify.version = "2.46.7";
  const reviewed = await verifyOfficialSpicetify(reviewedRuntime, {
    expectedVersion: "2.46.7",
    hashFile: () => ledger.sha256,
    fileSize: () => ledger.size,
    readUserPath: async () => LOCAL_DIR,
  });
  assert.equal(reviewed.ok, true, reviewed.error);
  assert.equal(reviewed.provenance, "reviewed-digest");

  const mismatchRuntime = executableOnly(officialRuntime("2.46.7"));
  mismatchRuntime.state.spicetify.version = "2.46.7";
  const mismatch = await verifyOfficialSpicetify(mismatchRuntime, {
    expectedVersion: "2.46.7",
    hashFile: () => "0".repeat(64),
    fileSize: () => ledger.size,
    readUserPath: async () => LOCAL_DIR,
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.code, "E_PIN_MISMATCH");
  assert.equal(mismatch.provenance, "reviewed-digest");

  const unreviewedRuntime = executableOnly(officialRuntime(FUTURE_VERSION));
  unreviewedRuntime.state.spicetify.version = FUTURE_VERSION;
  const unreviewed = await verifyOfficialSpicetify(unreviewedRuntime, {
    expectedVersion: FUTURE_VERSION,
    fileSize: () => 1,
    hashFile: () => "f".repeat(64),
    readUserPath: async () => LOCAL_DIR,
  });
  assert.equal(unreviewed.ok, true, unreviewed.error);
  assert.equal(unreviewed.provenance, "authenticode+version");
  assert.match(unreviewed.warnings.join("\n"), /No per-release artifact SHA-256 pin/);

  const unsupportedDigest = await verifyOfficialSpicetify(unreviewedRuntime, {
    expectedVersion: FUTURE_VERSION,
    expectedSha256: "a".repeat(64),
    readUserPath: async () => LOCAL_DIR,
  });
  assert.equal(unsupportedDigest.ok, false);
  assert.equal(unsupportedDigest.code, "E_NO_REVIEWED_DIGEST");
});

test("verification rejects a bad signer, a version mismatch and a missing executable (Marketplace never fails)", async () => {
  const withSignature = async (payload: unknown, code = 0) => {
    const runtime = executableOnly(officialRuntime(FUTURE_VERSION));
    runtime.state.spicetify.version = FUTURE_VERSION;
    const baseRun = runtime.run.bind(runtime);
    runtime.run = (async (file, args, options) => {
      if (file.toLowerCase().includes("pwsh") && args.join(" ").includes("Get-AuthenticodeSignature")) {
        return { code, stdout: typeof payload === "string" ? payload : JSON.stringify(payload), stderr: "" };
      }
      return baseRun(file, args, options);
    }) as typeof runtime.run;
    return verifyOfficialSpicetify(runtime, { expectedVersion: FUTURE_VERSION, readUserPath: async () => LOCAL_DIR });
  };

  // Wrong exact CN.
  const wrongCn = await withSignature({
    Status: "Valid",
    Subject: "CN=Someone Else",
    SimpleName: "Someone Else",
  });
  assert.equal(wrongCn.code, "E_SIGNATURE");

  // M3: a substring CN in another RDN never passes. The old
  // /CN=SignPath Foundation/ contains-check would have accepted this subject.
  const substringCn = await withSignature({
    Status: "Valid",
    Subject: "CN=Evil, OU=CN=SignPath Foundation",
    SimpleName: "Evil",
  });
  assert.equal(substringCn.code, "E_SIGNATURE");
  assert.match(substringCn.error ?? "", /expected exactly/);

  // Fail closed when the probe cannot be parsed (no SimpleName field).
  const unparsable = await withSignature({ Status: "Valid", Subject: "CN=SignPath Foundation, O=SignPath Foundation" });
  assert.equal(unparsable.code, "E_SIGNATURE");
  assert.match(unparsable.error ?? "", /could not read the Authenticode signature/);

  // A non-Valid status is rejected even with the exact CN.
  const invalidStatus = await withSignature({
    Status: "NotSigned",
    Subject: "",
    SimpleName: "SignPath Foundation",
  });
  assert.equal(invalidStatus.code, "E_SIGNATURE");
  assert.match(invalidStatus.error ?? "", /expected Valid/);

  // The exact CN is accepted.
  const exact = await withSignature({
    Status: "Valid",
    Subject: "CN=SignPath Foundation, O=SignPath Foundation, C=US",
    SimpleName: "SignPath Foundation",
  });
  assert.equal(exact.ok, true, exact.error);
  assert.equal(exact.signer, "SignPath Foundation");

  const versionRuntime = executableOnly(officialRuntime("9.9.8"));
  versionRuntime.state.spicetify.version = "9.9.8";
  const version = await verifyOfficialSpicetify(versionRuntime, { expectedVersion: FUTURE_VERSION, readUserPath: async () => LOCAL_DIR });
  assert.equal(version.code, "E_VERSION");

  const missing = await verifyOfficialSpicetify(officialRuntime(), { expectedVersion: FUTURE_VERSION, readUserPath: async () => LOCAL_DIR });
  assert.equal(missing.code, "E_EXE_MISSING");

  const marketplaceRuntime = executableOnly(officialRuntime(FUTURE_VERSION));
  marketplaceRuntime.state.spicetify.version = FUTURE_VERSION;
  const baseExists = marketplaceRuntime.exists.bind(marketplaceRuntime);
  marketplaceRuntime.exists = (path) => path.includes("Marketplace") ? true : baseExists(path);
  const changed = await verifyOfficialSpicetify(marketplaceRuntime, {
    expectedVersion: FUTURE_VERSION,
    marketplaceBefore: {
      "C:\\Users\\Test\\AppData\\Roaming\\spicetify\\Marketplace": false,
      "C:\\Users\\Test\\AppData\\Roaming\\spicetify\\Extensions\\marketplace": false,
      "C:\\Users\\Test\\AppData\\Local\\spicetify\\Marketplace": false,
    },
    readUserPath: async () => LOCAL_DIR,
  });
  assert.equal(changed.ok, true, changed.error);
  assert.match(changed.warnings.join("\n"), /Marketplace state changed/);
});

// ---------------------------------------------------------------------------
// Real short-lived children (no installer, no network)
// ---------------------------------------------------------------------------

test("defaultRunInteractive runs a real child, captures diagnostics, and needs no sentinel", async () => {
  const outcome = await defaultRunInteractive({
    file: "pwsh",
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "Write-Output 'stdio-ok'; exit 0"],
    timeoutMs: 15_000,
    env: { ...process.env } as Record<string, string>,
  });
  assert.equal(outcome.code, 0);
  assert.equal(outcome.exitConfirmed, true);
  assert.equal(outcome.terminated, false);
  assert.equal(outcome.killAttempts, 0);
  assert.match(outcome.stdout ?? "", /stdio-ok/);
  assert.doesNotMatch(outcome.stdout ?? "", /SPX_WRAPPER_COMPLETED/);
});

test("defaultRunInteractive kills a real sleeping child once and waits for close", async () => {
  const started = Date.now();
  const outcome = await defaultRunInteractive({
    file: "pwsh",
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 30"],
    timeoutMs: 400,
    env: { ...process.env } as Record<string, string>,
  });
  assert.equal(outcome.timedOut, true);
  assert.equal(outcome.terminated, true);
  assert.equal(outcome.killAttempts, 1);
  assert.equal(outcome.exitConfirmed, true);
  assert.ok(Date.now() - started < 20_000, "the kill wait must be bounded");
});

test("a policy-blocked script file exits 92 (skipped when host policy overrides -ExecutionPolicy Restricted)", async (t) => {
  // A harmless payload: if the host policy unexpectedly permits execution, the
  // only effect is one diagnostic line. The real installer is never run here.
  const probeScript = Buffer.from("# policy probe\r\nWrite-Output 'policy-probe-ran'\r\n", "ascii");
  const probeHash = createHash("sha256").update(probeScript).digest("hex");
  const dir = mkdtempSync(join(tmpdir(), "opencode-spicetify-policy-"));
  const path = join(dir, "install.ps1");
  writeFileSync(path, probeScript, { flag: "wx" });
  try {
    const env: Record<string, string> = {};
    for (const key of ["SystemRoot", "windir", "PATH", "TEMP", "TMP", "LOCALAPPDATA", "APPDATA", "USERPROFILE", "PROCESSOR_ARCHITECTURE", "ComSpec"]) {
      const value = process.env[key];
      if (value) env[key] = value;
    }
    env.SPX_SCRIPT = path;
    env.SPX_SCRIPT_SHA256 = probeHash;
    const outcome = await defaultRunInteractive({
      file: "pwsh",
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Restricted", "-Command", buildOfficialWrapperCommand(FUTURE_VERSION)],
      timeoutMs: 20_000,
      env,
    });
    if (outcome.code === 0) {
      t.skip("host Group Policy overrides -ExecutionPolicy Restricted; policy-block mapping not observable here");
      return;
    }
    assert.equal(outcome.code, 92, outcome.stdout ?? outcome.stderr);
    assert.match(outcome.stdout ?? "", /E_POLICY_BLOCKED/);
    assert.equal(outcome.exitConfirmed, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
