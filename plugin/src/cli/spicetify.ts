// V0.6.0 Spicetify inspection and maintenance.
// Read-only inspection must never modify the system or print secrets.
// All child processes use argv arrays via Runtime.run (shell:false).
import { dirname, join } from "node:path";
import { MIN_SPICETIFY, parseVersion } from "./compat.ts";
import { OPERATION_TIMEOUTS } from "./runtime.ts";
import type { CommandResult, Logger, Runtime, SpicetifyInfo, SpotifyInfo } from "./types.ts";

/** Fixed Store/Appx query. This constant must never include user input. */
export const SPOTIFY_STORE_QUERY =
  "Get-AppxPackage -Name SpotifyAB.SpotifyMusic | Select-Object -ExpandProperty InstallLocation";

export const SPICETIFY_WINGET_ID = "Spicetify.Spicetify";
export const SPICETIFY_BRIDGE_FILE = "opencode-spotify-bridge.js";

/** Official manual installation reference (display only; never executed automatically). */
export const SPICETIFY_MANUAL_URL = "https://spicetify.app/docs/getting-started";

export interface InstallApproval {
  method: "winget";
  command: string;
  source: string;
}

export interface InstallOptions {
  dryRun: boolean;
  approve: (details: InstallApproval) => Promise<boolean>;
  log?: Logger;
}

export interface UpgradeApproval {
  method: string;
  command: string;
  source: string;
}

export interface UpgradeOptions {
  approve: (details: UpgradeApproval) => Promise<boolean>;
  dryRun?: boolean;
  log?: Logger;
}

function lastNonEmptyLine(output: string): string | null {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1]! : null;
}

function extractVersion(output: string): string | null {
  const match = output.match(/v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/);
  if (!match) return null;
  const candidate = match[1]!;
  // Validate with shared semver parsing; fall back to raw candidate.
  return parseVersion(candidate) ? candidate : candidate;
}

function appDataDir(runtime: Runtime): string {
  return runtime.env.APPDATA || join(runtime.homedir, "AppData", "Roaming");
}

function localAppDataDir(runtime: Runtime): string {
  return runtime.env.LOCALAPPDATA || join(runtime.homedir, "AppData", "Local");
}

function parseBridgeRegistration(text: string): boolean | "ambiguous" {
  const lines = text.split(/\r?\n/);
  let section = "";
  const values: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    const sectionMatch = trimmed.match(/^\[(.+?)\]\s*$/);
    if (sectionMatch) {
      section = sectionMatch[1]!.trim().toLowerCase();
      continue;
    }
    if (/^\s*[;#]/.test(line)) continue;
    const match = line.match(/^\s*extensions\s*=(.*)$/i);
    if (match) {
      if (section !== "additionaloptions") continue;
      values.push(match[1] ?? "");
    }
  }
  if (values.length > 1) return "ambiguous";
  if (values.length === 0) return false;
  const names = values[0]!.split("|").map((part) => part.trim()).filter(Boolean);
  return names.includes(SPICETIFY_BRIDGE_FILE);
}

async function detectOwner(runtime: Runtime, spicetifyExe: string): Promise<SpicetifyInfo["owner"]> {
  const lower = spicetifyExe.toLowerCase();
  if (lower.includes("scoop")) return "scoop";
  if (lower.includes("chocolatey") || lower.includes("choco")) return "choco";
  if (lower.includes("winget")) return "winget";
  // Bounded manager probes. All argv arrays, no shell strings.
  try {
    const winget = await runtime.which("winget");
    if (winget) {
      try {
        const result = await runtime.run(
          winget,
          ["list", "--id", SPICETIFY_WINGET_ID, "-e"],
          { timeoutMs: OPERATION_TIMEOUTS.spicetifyInspect },
        );
        if (result.code === 0 && /spicetify/i.test(result.stdout)) return "winget";
      } catch { /* probe failure means not winget */ }
    }
  } catch { /* ignore */ }
  try {
    const scoop = await runtime.which("scoop");
    if (scoop) {
      try {
        const result = await runtime.run(scoop, ["list", "spicetify"], { timeoutMs: OPERATION_TIMEOUTS.spicetifyInspect });
        if (result.code === 0 && /spicetify/i.test(result.stdout)) return "scoop";
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  try {
    const choco = await runtime.which("choco");
    if (choco) {
      try {
        const result = await runtime.run(
          choco,
          ["list", "spicetify", "--local-only"],
          { timeoutMs: OPERATION_TIMEOUTS.spicetifyInspect },
        );
        if (result.code === 0 && /spicetify/i.test(result.stdout)) return "choco";
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  const localLower = localAppDataDir(runtime).toLowerCase();
  if (lower.startsWith(localLower) && lower.includes("spicetify")) return "script";
  // Keep MIN_SPICETIFY referenced so version policy stays shared.
  void MIN_SPICETIFY;
  return "unknown";
}

/**
 * Read-only Spotify detection. Never modifies the system.
 */
export async function inspectSpotify(runtime: Runtime): Promise<SpotifyInfo> {
  const appData = appDataDir(runtime);
  const prefs = join(appData, "Spotify", "prefs");
  const desktopExe = join(appData, "Spotify", "Spotify.exe");
  let prefsExists = false;
  let exeExists = false;
  try {
    prefsExists = runtime.exists(prefs) && runtime.isFile(prefs);
  } catch {
    prefsExists = false;
  }
  try {
    exeExists = runtime.exists(desktopExe) && runtime.isFile(desktopExe);
  } catch {
    exeExists = false;
  }
  if (prefsExists || exeExists) {
    const path = exeExists ? desktopExe : desktopExe;
    return {
      installed: true,
      store: false,
      path,
      prefs: prefsExists ? prefs : null,
      detail: `Spotify desktop detected at ${path}.`,
    };
  }

  // Store/Appx detection via a FIXED pwsh command (no user input).
  let storePath: string | null = null;
  try {
    const pwsh = await runtime.which("pwsh");
    if (pwsh) {
      try {
        const result = await runtime.run(
          pwsh,
          ["-NoProfile", "-NonInteractive", "-Command", SPOTIFY_STORE_QUERY],
          { timeoutMs: OPERATION_TIMEOUTS.spicetifyInspect },
        );
        if (result.code === 0) {
          const location = result.stdout
            .split(/\r?\n/)
            .map((line) => line.trim())
            .find(Boolean);
          if (location) storePath = location;
        }
      } catch {
        storePath = null;
      }
    }
  } catch {
    storePath = null;
  }
  if (!storePath) {
    // Static WindowsApps fallback (no glob, no shell).
    const windowsApps = join("C:\\", "Program Files", "WindowsApps");
    try {
      if (runtime.exists(windowsApps)) {
        // Cannot enumerate via Runtime; leave store detection to pwsh above.
        storePath = null;
      }
    } catch {
      storePath = null;
    }
  }
  if (storePath) {
    return {
      installed: true,
      store: true,
      path: storePath,
      prefs: null,
      detail: `Spotify Store installation detected at ${storePath}.`,
    };
  }

  // Optional `spicetify path spotify` when Spicetify is present.
  try {
    const spicetifyCmd = await runtime.which("spicetify");
    if (spicetifyCmd) {
      try {
        const result = await runtime.run(spicetifyCmd, ["path", "spotify"], { timeoutMs: OPERATION_TIMEOUTS.spicetifyInspect });
        if (result.code === 0) {
          const reported = lastNonEmptyLine(result.stdout);
          if (reported) {
            return {
              installed: true,
              store: false,
              path: reported,
              prefs: null,
              detail: `Spotify path reported by Spicetify at ${reported}.`,
            };
          }
        }
      } catch {
        // Optional probe only.
      }
    }
  } catch {
    // Optional probe only.
  }

  return {
    installed: false,
    store: false,
    path: null,
    prefs: null,
    detail: "Spotify not found. Install Spotify desktop for Windows first.",
  };
}

/**
 * Read-only Spicetify inspection. Never modifies the system.
 */
export async function inspectSpicetify(runtime: Runtime): Promise<SpicetifyInfo> {
  let exe: string | null = null;
  try {
    const fromPath = await runtime.which("spicetify");
    if (fromPath) exe = fromPath;
  } catch {
    exe = null;
  }
  if (!exe) {
    const local = localAppDataDir(runtime);
    for (const candidate of [join(local, "spicetify", "spicetify.exe"), join(local, "spicetify", "spicetify")]) {
      try {
        if (runtime.exists(candidate) && runtime.isFile(candidate)) {
          exe = candidate;
          break;
        }
      } catch {
        continue;
      }
    }
  }
  if (!exe) {
    return {
      available: false,
      path: null,
      version: null,
      owner: "unknown",
      configPath: null,
      extensionsDir: null,
      bridgeRegistered: false,
    };
  }

  let version: string | null = null;
  try {
    const result = await runtime.run(exe, ["-v"], { timeoutMs: OPERATION_TIMEOUTS.spicetifyInspect });
    version = extractVersion(`${result.stdout}\n${result.stderr}`);
  } catch {
    version = null;
  }

  // Best-effort `spicetify path` probe (read-only, fixed argv).
  try {
    await runtime.run(exe, ["path"], { timeoutMs: OPERATION_TIMEOUTS.spicetifyInspect });
  } catch {
    // Optional; config resolution below is authoritative.
  }

  let configPath: string | null = null;
  try {
    const result = await runtime.run(exe, ["-c"], { timeoutMs: OPERATION_TIMEOUTS.spicetifyInspect });
    if (result.code === 0) {
      const last = lastNonEmptyLine(result.stdout);
      if (last) configPath = last;
    }
  } catch {
    configPath = null;
  }

  let extensionsDir: string | null = null;
  if (configPath) {
    try {
      extensionsDir = join(dirname(configPath), "Extensions");
    } catch {
      extensionsDir = null;
    }
  }

  const owner = await detectOwner(runtime, exe);

  let bridgeRegistered = false;
  let error: string | undefined;
  if (configPath) {
    try {
      if (!runtime.exists(configPath)) {
        bridgeRegistered = false;
      } else {
        const text = runtime.readText(configPath);
        const parsed = parseBridgeRegistration(text);
        if (parsed === "ambiguous") {
          error = "Ambiguous extension configuration; review duplicate extensions keys.";
        } else {
          bridgeRegistered = parsed;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Cannot read Spicetify configuration.";
      error = message.slice(0, 200);
    }
  }

  return {
    available: true,
    path: exe,
    version,
    owner,
    configPath,
    extensionsDir,
    bridgeRegistered,
    ...(error ? { error } : {}),
  };
}

function wingetInstallArgs(): string[] {
  return [
    "install",
    "--id",
    SPICETIFY_WINGET_ID,
    "-e",
    "--source",
    "winget",
    "--accept-package-agreements",
    "--accept-source-agreements",
  ];
}

function wingetUpgradeArgs(): string[] {
  return [
    "upgrade",
    "--id",
    SPICETIFY_WINGET_ID,
    "-e",
    "--source",
    "winget",
    "--accept-package-agreements",
    "--accept-source-agreements",
  ];
}

/**
 * Install Spicetify via winget only. A checksum of a mutable branch-tip
 * script cannot authenticate it, so the unsigned upstream installer is never
 * downloaded or executed automatically: without winget the caller is directed
 * to the official manual instructions. Never runs without approval. Dry-run
 * plans without executing.
 */
export async function installSpicetify(
  runtime: Runtime,
  info: SpicetifyInfo,
  opts: InstallOptions,
): Promise<CommandResult> {
  if (info.available) {
    return { code: 0, stdout: "Spicetify is already installed.", stderr: "" };
  }

  const winget = await runtime.which("winget").catch(() => undefined);
  if (!winget) {
    return {
      code: 1,
      stdout: "",
      stderr: "",
      error: `Automatic installation requires winget (${SPICETIFY_WINGET_ID}). Install Spicetify manually from ${SPICETIFY_MANUAL_URL}, then re-run setup and choose recheck.`,
    };
  }
  const command = `winget install --id ${SPICETIFY_WINGET_ID} -e --source winget --accept-package-agreements --accept-source-agreements`;
  if (opts.dryRun) {
    return { code: 0, stdout: `Would run: ${command}`, stderr: "" };
  }
  const details: InstallApproval = {
    method: "winget",
    command,
    source: `winget (pinned source): ${SPICETIFY_WINGET_ID}`,
  };
  opts.log?.out(`Spicetify install: ${details.command}`);
  opts.log?.out(`Source: ${details.source}`);
  const approved = await opts.approve(details);
  if (!approved) {
    return { code: 1, stdout: "", stderr: "", error: "Spicetify installation declined." };
  }
  const result = await runtime.run(winget, wingetInstallArgs(), { timeoutMs: OPERATION_TIMEOUTS.packageInstall });
  // Re-detect after the attempt (read-only, never throws).
  try {
    await inspectSpicetify(runtime);
  } catch {
    // Detection failure does not mask the install result.
  }
  return result;
}

/**
 * Upgrade Spicetify using the owner-specific command. Never downgrades;
 * unknown owners are refused. Approval is always required.
 */
export async function upgradeSpicetify(
  runtime: Runtime,
  info: SpicetifyInfo,
  opts: UpgradeOptions,
): Promise<CommandResult> {
  if (!info.available || !info.path) {
    return { code: 1, stdout: "", stderr: "", error: "Spicetify is not installed." };
  }
  if (info.owner === "unknown") {
    return {
      code: 1,
      stdout: "",
      stderr: "",
      error: "Unknown Spicetify install owner; refusing to upgrade.",
    };
  }

  let file: string;
  let args: string[];
  let source: string;
  if (info.owner === "winget") {
    file = (await runtime.which("winget").catch(() => undefined)) ?? "winget";
    args = wingetUpgradeArgs();
    source = `winget: ${SPICETIFY_WINGET_ID}`;
  } else if (info.owner === "scoop") {
    file = (await runtime.which("scoop").catch(() => undefined)) ?? "scoop";
    args = ["update", "spicetify"];
    source = "scoop: spicetify";
  } else if (info.owner === "choco") {
    file = (await runtime.which("choco").catch(() => undefined)) ?? "choco";
    args = ["upgrade", "spicetify", "-y"];
    source = "chocolatey: spicetify";
  } else {
    file = info.path;
    args = ["upgrade"];
    source = "spicetify: upgrade";
  }
  const command = `${file} ${args.join(" ")}`;
  if (opts.dryRun) {
    return { code: 0, stdout: `Would run: ${command}`, stderr: "" };
  }
  const details: UpgradeApproval = { method: info.owner, command, source };
  opts.log?.out(`Spicetify upgrade: ${command}`);
  opts.log?.out(`Source: ${source}`);
  const approved = await opts.approve(details);
  if (!approved) {
    return { code: 1, stdout: "", stderr: "", error: "Spicetify upgrade declined." };
  }
  return runtime.run(file, args, { timeoutMs: OPERATION_TIMEOUTS.packageInstall });
}

/**
 * Run `spicetify apply`. The caller must have obtained approval already;
 * this function never prompts and never runs without `approved === true`.
 */
export async function applySpicetify(
  runtime: Runtime,
  path: string | null | undefined,
  approved: boolean,
): Promise<CommandResult> {
  if (!approved) {
    return {
      code: 1,
      stdout: "",
      stderr: "",
      error: "Spicetify apply requires explicit approval.",
    };
  }
  const exe = path ?? (await runtime.which("spicetify").catch(() => undefined)) ?? "spicetify";
  return runtime.run(exe, ["apply"], { timeoutMs: OPERATION_TIMEOUTS.spicetifyApply });
}

/**
 * Best-effort backup-state detection (B09). `spicetify apply` on a fresh
 * install fails when no initial Spotify backup exists; overwriting a valid
 * backup is wasteful. We probe the well-known backup locations without
 * modifying anything (`%LOCALAPPDATA%/spicetify|Spicetify/Backup`).
 *
 * Returns "ready" when a backup directory exists, "missing" when neither
 * candidate exists, and "unknown" when it cannot be determined. Note: the
 * Runtime contract exposes existence only, so an empty/partial/stale backup
 * still reports "ready" here — the apply path compensates by retrying once
 * on backup-related apply errors (see bridge.ts applyBridge). Never throws.
 */
export async function inspectBackupState(
  runtime: Runtime,
  spicetify: SpicetifyInfo,
): Promise<"ready" | "missing" | "unknown"> {
  try {
    if (!spicetify.available || !spicetify.path) return "unknown";
    const localBase = runtime.env.LOCALAPPDATA || join(runtime.homedir, "AppData", "Local");
    const candidates = [
      join(localBase, "spicetify", "Backup"),
      join(localBase, "Spicetify", "Backup"),
    ];
    for (const dir of candidates) {
      try {
        if (!runtime.exists(dir)) continue;
        return "ready";
      } catch {
        continue;
      }
    }
    return "missing";
  } catch {
    return "unknown";
  }
}

/**
 * Run `spicetify backup` once for a fresh installation (B09). The caller must
 * have approved the surrounding plan; this function never prompts.
 */
export async function backupSpicetify(
  runtime: Runtime,
  path: string | null | undefined,
): Promise<CommandResult> {
  const exe = path ?? (await runtime.which("spicetify").catch(() => undefined)) ?? "spicetify";
  return runtime.run(exe, ["backup"], { timeoutMs: OPERATION_TIMEOUTS.spicetifyBackup });
}

/**
 * Refresh the Winget source before resolving the trusted package version
 * (B14–B18). Best-effort and read-only in spirit: `winget source update`
 * only refreshes metadata, never installs anything. Failures are returned,
 * never thrown, so the caller can continue with a stale source + warning.
 */
export async function refreshWingetSource(runtime: Runtime): Promise<CommandResult> {
  const winget = await runtime.which("winget").catch(() => undefined);
  if (!winget) {
    return { code: 1, stdout: "", stderr: "", error: "winget not found on PATH" };
  }
  return runtime.run(winget, ["source", "update", "--name", "winget"], {
    timeoutMs: OPERATION_TIMEOUTS.managerProbe,
  });
}

/**
 * Resolve the latest available Winget version for the pinned trusted package
 * id (B14–B18). Anchors to the `Version:` line of `winget show` output so
 * unrelated version tokens (source/app wrapper text) are not misread.
 * Returns null when it cannot be determined.
 */
export async function wingetLatestVersion(runtime: Runtime): Promise<string | null> {
  try {
    const winget = await runtime.which("winget").catch(() => undefined);
    if (!winget) return null;
    const result = await runtime.run(
      winget,
      ["show", "--id", SPICETIFY_WINGET_ID, "-e", "--source", "winget"],
      { timeoutMs: OPERATION_TIMEOUTS.managerProbe },
    );
    if (result.code !== 0) return null;
    const text = `${result.stdout}\n${result.stderr}`;
    const anchored = text.match(/^\s*Version\s*:\s*v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\s*$/im);
    if (anchored?.[1]) return anchored[1];
    return null;
  } catch {
    return null;
  }
}
