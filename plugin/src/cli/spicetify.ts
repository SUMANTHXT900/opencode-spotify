// V0.6.0 Spicetify inspection and maintenance.
// Read-only inspection must never modify the system or print secrets.
// All child processes use argv arrays via Runtime.run (shell:false).
import { readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  MIN_SPICETIFY,
  OFFICIAL_INSTALLER_COMMIT,
  OFFICIAL_INSTALLER_SHA256,
  parseVersion,
} from "./compat.ts";
import { OPERATION_TIMEOUTS, sanitizeDetail } from "./runtime.ts";
import type { CancelToken } from "./cancel.ts";
import type { CommandResult, Logger, Runtime, SpicetifyInfo, SpotifyInfo } from "./types.ts";

/** Fixed Store/Appx query. This constant must never include user input. */
export const SPOTIFY_STORE_QUERY =
  "Get-AppxPackage -Name SpotifyAB.SpotifyMusic | Select-Object -ExpandProperty InstallLocation";

export const SPICETIFY_WINGET_ID = "Spicetify.Spicetify";
export const SPICETIFY_BRIDGE_FILE = "opencode-spotify-bridge.js";

/** Official manual installation reference (display only; never executed automatically). */
export const SPICETIFY_MANUAL_URL = "https://spicetify.app/docs/getting-started";
/** Published release page used when no concrete target is resolved. */
export const SPICETIFY_RELEASES_PAGE = "https://github.com/spicetify/cli/releases";

/** Strict stable version (no prerelease/build suffix), or null. */
function strictStableVersion(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim().replace(/^v/i, "");
  return /^\d+\.\d+\.\d+$/.test(trimmed) ? trimmed : null;
}

/** Cancellation never kills an in-flight child here; it only prevents a start. */
function cancelledResult(scope: string): CommandResult {
  return {
    code: 130,
    stdout: "",
    stderr: "",
    cancelled: true,
    error: `Cancelled by the user before ${scope}; nothing was started.`,
  };
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
  // Manager ownership requires the manager's own directory layout. A plain
  // substring test would misclassify any profile such as C:\Users\scoop\... .
  const joined = `\\${spicetifyExe.toLowerCase().split(/[\\/]+/).filter(Boolean).join("\\")}\\`;
  if (joined.includes("\\scoop\\apps\\") || joined.includes("\\scoop\\shims\\")) return "scoop";
  if (joined.includes("\\chocolatey\\bin\\") || joined.includes("\\chocolatey\\lib\\")) return "choco";
  if (joined.includes("\\microsoft\\winget\\packages\\") ||
    joined.includes("\\microsoft\\winget\\links\\") ||
    joined.includes("\\winget\\links\\")) return "winget";
  // A script-owned copy must sit in the canonical %LOCALAPPDATA%\spicetify
  // directory. Other local paths (e.g. %LOCALAPPDATA%\Programs\spicetify)
  // are not ours to upgrade or delete. Checked before the slow manager
  // probes so a canonical script install never pays for winget/scoop/choco.
  const canonicalScriptDir = stripTrailingSep(localAppDataDir(runtime)).toLowerCase() + "\\spicetify";
  try {
    if (stripTrailingSep(dirname(spicetifyExe)).toLowerCase() === canonicalScriptDir) return "script";
  } catch { /* unparseable path stays unknown */ }
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
        const result = await runtime.run(scoop, ["list", "spicetify-cli"], { timeoutMs: OPERATION_TIMEOUTS.spicetifyInspect });
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
          ["list", "spicetify-cli", "--local-only"],
          { timeoutMs: OPERATION_TIMEOUTS.spicetifyInspect },
        );
        if (result.code === 0 && /spicetify/i.test(result.stdout)) return "choco";
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  // Keep MIN_SPICETIFY referenced so version policy stays shared.
  void MIN_SPICETIFY;
  return "unknown";
}

function stripTrailingSep(value: string): string {
  return value.replace(/[\\/]+$/, "");
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
    const path = exeExists ? desktopExe : prefs;
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

export interface ManagerUpgradeApproval {
  method: "winget" | "scoop" | "choco";
  command: string;
  source: string;
}

export interface ManagerUpgradeOptions {
  dryRun?: boolean;
  approve?: (details: ManagerUpgradeApproval) => Promise<boolean>;
  log?: Logger;
  /** Cooperative cancellation: checked before approval and before the child starts. */
  cancel?: CancelToken;
}

/**
 * Owner-specific upgrade for manager installs. The official installer adapter
 * dispatches here for winget/scoop/choco; those copies are never overlaid by
 * the portable installer, and `spicetify update` is never invoked.
 * Script-owned upgrades go through the official installer instead.
 */
export async function upgradeSpicetifyWithManager(
  runtime: Runtime,
  info: SpicetifyInfo,
  opts: ManagerUpgradeOptions,
): Promise<CommandResult> {
  if (!info.available || !info.path) {
    return { code: 1, stdout: "", stderr: "", error: "Spicetify is not installed." };
  }
  const owner = info.owner;
  if (owner !== "winget" && owner !== "scoop" && owner !== "choco") {
    return {
      code: 1,
      stdout: "",
      stderr: "",
      error: `Manager upgrade only applies to winget/scoop/Chocolatey installations; this copy is ${owner === "script" ? "owned by the official installer" : `owned by ${owner}`}.`,
    };
  }

  const spec = owner === "winget"
    ? {
        binary: "winget",
        args: wingetUpgradeArgs(),
        source: `winget: ${SPICETIFY_WINGET_ID}`,
        guidance: `winget upgrade --id ${SPICETIFY_WINGET_ID} -e`,
      }
    : owner === "scoop"
      ? {
          binary: "scoop",
          args: ["update", "spicetify-cli"],
          source: "scoop: spicetify-cli",
          guidance: "scoop update spicetify-cli",
        }
      : {
          binary: "choco",
          args: ["upgrade", "spicetify-cli", "-y"],
          source: "chocolatey: spicetify-cli",
          guidance: "choco upgrade spicetify-cli -y",
        };

  const command = `${spec.binary} ${spec.args.join(" ")}`;
  if (opts.cancel?.requested) return cancelledResult("the Spicetify upgrade");
  if (opts.dryRun) {
    return { code: 0, stdout: `Would run: ${command}`, stderr: "" };
  }
  const file = await runtime.which(spec.binary).catch(() => undefined);
  if (!file) {
    return {
      code: 1,
      stdout: "",
      stderr: "",
      error: `${spec.binary} was not found on PATH; update this ${owner}-owned Spicetify manually (${spec.guidance}) or reinstall it with ${owner}.`,
    };
  }
  if (!opts.approve) {
    return {
      code: 1,
      stdout: "",
      stderr: "",
      error: "Spicetify upgrade requires explicit approval; no approval handler was provided.",
    };
  }
  if (opts.cancel?.requested) return cancelledResult("the Spicetify upgrade");
  const resolvedCommand = `${file} ${spec.args.join(" ")}`;
  opts.log?.out(`Spicetify upgrade: ${resolvedCommand}`);
  opts.log?.out(`Source: ${spec.source}`);
  let approved = false;
  try {
    approved = await opts.approve({ method: owner, command: resolvedCommand, source: spec.source });
  } catch {
    approved = false;
  }
  if (!approved) {
    return { code: 1, stdout: "", stderr: "", error: "Spicetify upgrade declined." };
  }
  // Approval input can take time; re-check before the mutation starts.
  if (opts.cancel?.requested) return cancelledResult("the Spicetify upgrade");
  return runtime.run(file, spec.args, {
    timeoutMs: OPERATION_TIMEOUTS.packageInstall,
    ...(opts.cancel ? { cancel: opts.cancel } : {}),
  });
}

/**
 * Run `spicetify apply`. The caller must have obtained approval already;
 * this function never prompts and never runs without `approved === true`.
 *
 * Cancellation is checked before the child starts only. Once apply runs it is
 * protected: it is never interrupted between start and verification, because a
 * half-applied Spotify cannot be reliably rolled back.
 */
export async function applySpicetify(
  runtime: Runtime,
  path: string | null | undefined,
  approved: boolean,
  options: { cancel?: CancelToken } = {},
): Promise<CommandResult> {
  if (!approved) {
    return {
      code: 1,
      stdout: "",
      stderr: "",
      error: "Spicetify apply requires explicit approval.",
    };
  }
  if (options.cancel?.requested) return cancelledResult("spicetify apply");
  const exe = path ?? (await runtime.which("spicetify").catch(() => undefined)) ?? "spicetify";
  return runtime.run(exe, ["apply"], {
    timeoutMs: OPERATION_TIMEOUTS.spicetifyApply,
    ...(options.cancel ? { cancel: options.cancel } : {}),
  });
}

/**
 * B09/E26: Spicetify v2.x keeps its state (config, Backup, Themes, Extensions,
 * Marketplace and CustomApps) under `%APPDATA%\\spicetify`, not
 * `%LOCALAPPDATA%`. The local directory only holds the program binary.
 *
 * Restore is safe only when the backup directory exists AND contains
 * `xpui.spa` plus `login.spa` at plausible sizes. Directory existence alone is
 * never enough: an empty or truncated backup must block `spicetify restore`.
 */
export const SPICETIFY_BACKUP_FILES = ["xpui.spa", "login.spa"] as const;

/** Broad, release-independent size bounds that reject empty/truncated copies. */
export const SPICETIFY_BACKUP_SIZE_RANGE: Record<
  (typeof SPICETIFY_BACKUP_FILES)[number],
  { min: number; max: number }
> = {
  "xpui.spa": { min: 1_000_000, max: 128 * 1024 * 1024 },
  "login.spa": { min: 100_000, max: 64 * 1024 * 1024 },
};

export interface BackupFileProbe {
  name: (typeof SPICETIFY_BACKUP_FILES)[number];
  path: string;
  exists: boolean;
  size: number | null;
  plausible: boolean;
}

export interface SpicetifyBackupInspection {
  state: "ready" | "missing" | "unknown";
  backupDir: string | null;
  files: BackupFileProbe[];
  error?: string;
}

export interface BackupProbeDeps {
  /** File size probe; return null when it cannot be determined. */
  fileSize?: (path: string) => number | null;
  /** Directory listing; return null when it cannot be read. */
  listDir?: (path: string) => string[] | null;
}

/** Optional test/runtime hooks. Production Runtime does not implement these. */
interface BackupRuntimeProbes {
  fileSize?: (path: string) => number | null;
  listDir?: (path: string) => string[] | null;
}

function defaultBackupFileSize(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

function defaultListDir(path: string): string[] | null {
  try {
    return readdirSync(path);
  } catch {
    return null;
  }
}

export function spicetifyStateDir(
  runtime: Runtime,
  spicetify?: Pick<SpicetifyInfo, "configPath"> | null,
): string {
  if (spicetify?.configPath) {
    try {
      return dirname(spicetify.configPath);
    } catch {
      // Fall through to the documented roaming default.
    }
  }
  return join(appDataDir(runtime), "spicetify");
}

/** Ordered candidates: configured state root, roaming default, then legacy local roots. */
export function spicetifyBackupCandidates(
  runtime: Runtime,
  spicetify?: Pick<SpicetifyInfo, "configPath"> | null,
): string[] {
  const candidates = [
    join(spicetifyStateDir(runtime, spicetify), "Backup"),
    join(appDataDir(runtime), "spicetify", "Backup"),
    join(localAppDataDir(runtime), "spicetify", "Backup"),
    join(localAppDataDir(runtime), "Spicetify", "Backup"),
  ];
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = candidate.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Detailed, fail-closed backup inspection. Returns "ready" only for a
 * non-empty backup directory with both restore archives at plausible sizes.
 * An existing but empty/invalid directory is "unknown" (not "missing") so a
 * caller can never silently skip restore and delete a still-modded Spotify.
 */
export async function inspectBackupStateDetailed(
  runtime: Runtime,
  spicetify: SpicetifyInfo,
  deps: BackupProbeDeps = {},
): Promise<SpicetifyBackupInspection> {
  const probes = runtime as Runtime & BackupRuntimeProbes;
  const fileSize = deps.fileSize ?? probes.fileSize ?? defaultBackupFileSize;
  const listDir = deps.listDir ?? probes.listDir ?? defaultListDir;
  try {
    if (!spicetify.available || !spicetify.path) {
      return { state: "unknown", backupDir: null, files: [], error: "Spicetify is unavailable; backup state cannot be verified." };
    }
    // L11: scan every candidate. The first *ready* backup wins; an existing
    // but invalid candidate is remembered (state "unknown") but must not stop
    // the scan, because a later candidate may hold the usable backup.
    let invalid: SpicetifyBackupInspection | null = null;
    for (const dir of spicetifyBackupCandidates(runtime, spicetify)) {
      let exists = false;
      try {
        exists = runtime.exists(dir);
      } catch {
        continue;
      }
      if (!exists) continue;

      const entries = listDir(dir);
      const files: BackupFileProbe[] = SPICETIFY_BACKUP_FILES.map((name) => {
        const path = join(dir, name);
        let fileExists: boolean;
        if (entries) {
          fileExists = entries.some((entry) => entry.toLowerCase() === name);
        } else {
          try {
            fileExists = runtime.exists(path);
          } catch {
            fileExists = false;
          }
        }
        const size = fileExists ? fileSize(path) : null;
        const range = SPICETIFY_BACKUP_SIZE_RANGE[name];
        return {
          name,
          path,
          exists: fileExists,
          size,
          plausible: size !== null && size >= range.min && size <= range.max,
        };
      });

      const nonEmpty = entries ? entries.length > 0 : files.some((file) => file.exists);
      if (nonEmpty && files.every((file) => file.exists && file.plausible)) {
        return { state: "ready", backupDir: dir, files };
      }
      if (!invalid) {
        const problems = files
          .filter((file) => !file.exists || !file.plausible)
          .map((file) => (file.exists
            ? `${file.name} is ${file.size ?? "an unknown size"} bytes (expected ${SPICETIFY_BACKUP_SIZE_RANGE[file.name].min}-${SPICETIFY_BACKUP_SIZE_RANGE[file.name].max})`
            : `${file.name} is missing`))
          .join("; ");
        invalid = {
          state: "unknown",
          backupDir: dir,
          files,
          error: `Backup directory ${dir} ${nonEmpty ? "is untrustworthy" : "is empty"}${problems ? `: ${problems}` : ""}.`,
        };
      }
    }
    if (invalid) return invalid;
    return { state: "missing", backupDir: null, files: [], error: "No Spicetify backup directory was found." };
  } catch (error) {
    return {
      state: "unknown",
      backupDir: null,
      files: [],
      error: sanitizeDetail(error instanceof Error ? error.message : "backup inspection failed"),
    };
  }
}

/**
 * Tri-state compatibility wrapper. "ready" now requires a verifiable backup
 * payload, not merely directory existence.
 */
export async function inspectBackupState(
  runtime: Runtime,
  spicetify: SpicetifyInfo,
  deps: BackupProbeDeps = {},
): Promise<"ready" | "missing" | "unknown"> {
  return (await inspectBackupStateDetailed(runtime, spicetify, deps)).state;
}

// ---------------------------------------------------------------------------
// Spotify application files (restore pre/post verification, E26 P0-2).
// ---------------------------------------------------------------------------

export interface SpotifyAppFileInfo {
  path: string;
  exists: boolean;
  size: number | null;
  mtimeMs: number | null;
}

export interface SpotifyModDirInfo {
  path: string;
  exists: boolean;
}

export interface SpotifyAppSnapshot {
  ok: boolean;
  appsDir: string | null;
  files: SpotifyAppFileInfo[];
  modDirs: SpotifyModDirInfo[];
  error?: string;
}

export interface SpotifyAppProbeDeps {
  fileInfo?: (path: string) => { size: number; mtimeMs: number } | null;
  /** Directory-existence probe for the extracted mod dirs. Return null when unknown. */
  dirExists?: (path: string) => boolean | null;
  /** Directory listing probe used to detect extracted mod dirs. Return null when unreadable. */
  listDir?: (path: string) => string[] | null;
}

export interface ExpectedBackupSizes {
  xpuiSize?: number | null;
  loginSize?: number | null;
}

const SPOTIFY_SPA_FILES = [
  { id: "xpui", file: "xpui.spa" },
  { id: "login", file: "login.spa" },
] as const;

const SPOTIFY_MOD_DIR_IDS = ["xpui", "login"] as const;

function defaultAppFileInfo(path: string): { size: number; mtimeMs: number } | null {
  try {
    const stat = statSync(path);
    return { size: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}

/** Spotify install directory from config (`spotify_path`) or the roaming default. */
export function spotifyInstallDir(runtime: Runtime, spicetify: SpicetifyInfo): string | null {
  try {
    if (spicetify.configPath && runtime.exists(spicetify.configPath)) {
      const text = runtime.readText(spicetify.configPath);
      const match = text.match(/^\s*spotify_path\s*=\s*(.+?)\s*$/mi);
      if (match?.[1]) {
        let raw = match[1].trim();
        if (raw.length >= 2) {
          const first = raw[0];
          const last = raw[raw.length - 1];
          if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
            raw = raw.slice(1, -1).trim();
          }
        }
        if (raw) return raw;
      }
    }
  } catch {
    // Fall back to the documented roaming default.
  }
  return join(appDataDir(runtime), "Spotify");
}

export function spotifyAppsDir(runtime: Runtime, spicetify: SpicetifyInfo): string | null {
  const installDir = spotifyInstallDir(runtime, spicetify);
  return installDir ? join(installDir, "Apps") : null;
}

/** Snapshot the stock Spotify app bundles (xpui.spa/login.spa) plus extracted mod dirs. */
export function captureSpotifyAppFiles(
  runtime: Runtime,
  spicetify: SpicetifyInfo,
  deps: SpotifyAppProbeDeps = {},
): SpotifyAppSnapshot {
  const appsDir = spotifyAppsDir(runtime, spicetify);
  if (!appsDir) {
    return { ok: false, appsDir: null, files: [], modDirs: [], error: "The Spotify apps directory could not be resolved." };
  }
  const fileInfo = deps.fileInfo ?? defaultAppFileInfo;
  const files: SpotifyAppFileInfo[] = SPOTIFY_SPA_FILES.map((probe) => {
    const path = join(appsDir, probe.file);
    const info = fileInfo(path);
    let exists = info !== null;
    if (!exists) {
      try {
        exists = runtime.isFile(path);
      } catch {
        exists = false;
      }
    }
    return { path, exists, size: info?.size ?? null, mtimeMs: info?.mtimeMs ?? null };
  });
  const modDirs: SpotifyModDirInfo[] = SPOTIFY_MOD_DIR_IDS.map((id) => {
    const path = join(appsDir, id);
    return { path, exists: checkModDirExists(runtime, path, deps) };
  });
  const ok = files.every((file) => file.exists);
  return {
    ok,
    appsDir,
    files,
    modDirs,
    ...(ok ? {} : { error: `Missing Spotify app files under ${appsDir}: ${files.filter((file) => !file.exists).map((file) => file.path).join(", ")}` }),
  };
}

function checkModDirExists(
  runtime: Runtime,
  dirPath: string,
  deps: Pick<SpotifyAppProbeDeps, "dirExists" | "listDir"> & { listDir?: (path: string) => string[] | null },
): boolean {
  if (deps.dirExists) {
    try {
      const probed = deps.dirExists(dirPath);
      if (probed !== null) return probed;
    } catch {
      // Fall through to the runtime probes.
    }
  }
  const runtimeListDir = (runtime as Runtime & { listDir?: (path: string) => string[] | null }).listDir;
  const listProbes: Array<(path: string) => string[] | null> = [];
  if (deps.listDir) listProbes.push(deps.listDir);
  if (typeof runtimeListDir === "function") listProbes.push(runtimeListDir);
  listProbes.push(defaultListDir);
  const appsDir = dirPath.replace(/[\\/][^\\/]+$/, "");
  for (const listProbe of listProbes) {
    try {
      const entries = listProbe(appsDir);
      if (entries) {
        const base = dirPath.split(/[\\/]/).filter(Boolean).pop()?.toLowerCase() ?? "";
        return entries.some((entry) => entry.toLowerCase() === base);
      }
    } catch {
      continue;
    }
  }
  try {
    if (!runtime.exists(dirPath)) return false;
    try {
      if (runtime.isFile(dirPath)) return false;
    } catch {
      // isFile unavailable; exists alone is the best signal.
    }
    return true;
  } catch {
    return false;
  }
}

function spaRangeFor(name: string): { min: number; max: number } | null {
  const key = name.toLowerCase();
  if (key.endsWith("xpui.spa")) return SPICETIFY_BACKUP_SIZE_RANGE["xpui.spa"];
  if (key.endsWith("login.spa")) return SPICETIFY_BACKUP_SIZE_RANGE["login.spa"];
  return null;
}

function expectedSizeFor(path: string, expected?: ExpectedBackupSizes): number | null | undefined {
  if (!expected) return undefined;
  const lower = path.toLowerCase();
  if (lower.endsWith("xpui.spa")) return expected.xpuiSize ?? undefined;
  if (lower.endsWith("login.spa")) return expected.loginSize ?? undefined;
  return undefined;
}

/**
 * A restore completed only when the stock state holds: xpui.spa and login.spa
 * exist at plausible sizes (within SPICETIFY_BACKUP_SIZE_RANGE, and matching
 * the validated backup when expected sizes are supplied) and the extracted
 * mod dirs (Apps\xpui, Apps\login) no longer exist. An already-stock rerun
 * with no file change is still ok (idempotent): only a non-stock `after`
 * state fails.
 */
export function verifySpotifyRestoreApplied(
  before: SpotifyAppSnapshot,
  after: SpotifyAppSnapshot,
  expected?: ExpectedBackupSizes,
): { ok: boolean; changed: string[]; error?: string } {
  if (!after.appsDir || !after.files.length) {
    return { ok: false, changed: [], error: after.error ?? "Spotify app files are missing after restore." };
  }
  for (const file of after.files) {
    if (!file.exists) {
      return { ok: false, changed: [], error: after.error ?? `Spotify app file is missing after restore: ${file.path}.` };
    }
    if (file.size !== null) {
      const range = spaRangeFor(file.path);
      if (range && (file.size < range.min || file.size > range.max)) {
        return {
          ok: false,
          changed: [],
          error: `Restored ${file.path} is ${file.size} bytes (expected ${range.min}-${range.max}); restore cannot be verified.`,
        };
      }
      const wanted = expectedSizeFor(file.path, expected);
      if (wanted !== undefined && wanted !== null && file.size !== wanted) {
        return {
          ok: false,
          changed: [],
          error: `Restored ${file.path} is ${file.size} bytes but the validated backup is ${wanted} bytes; restore cannot be verified.`,
        };
      }
    }
  }
  const lingering = (after.modDirs ?? []).filter((dir) => dir.exists);
  if (lingering.length) {
    return {
      ok: false,
      changed: [],
      error: `Extracted Spotify app directories still present after restore: ${lingering.map((dir) => dir.path).join(", ")}.`,
    };
  }
  const changed: string[] = [];
  for (const file of after.files) {
    const prior = before.files.find((candidate) => candidate.path.toLowerCase() === file.path.toLowerCase());
    if (!prior || !prior.exists) {
      changed.push(file.path);
    } else if (prior.size !== file.size || prior.mtimeMs !== file.mtimeMs) {
      changed.push(file.path);
    }
  }
  for (const dir of after.modDirs ?? []) {
    const prior = (before.modDirs ?? []).find((candidate) => candidate.path.toLowerCase() === dir.path.toLowerCase());
    if (prior?.exists && !dir.exists) changed.push(dir.path);
  }
  return { ok: true, changed };
}

export interface SpotifyRestoreOptions extends BackupProbeDeps, SpotifyAppProbeDeps {
  timeoutMs?: number;
  /** Checked before restore starts; verification afterwards is protected. */
  cancel?: CancelToken;
}

/**
 * Restore Spotify from the verified Spicetify backup. This is the B09
 * integration point: it refuses to run `spicetify restore` unless the backup
 * payload is trustworthy, snapshots the stock bundles before the command, and
 * verifies the stock restored state afterwards (xpui.spa/login.spa present at
 * the validated backup sizes within SPICETIFY_BACKUP_SIZE_RANGE and the
 * extracted mod dirs gone). An already-stock rerun stays verified.
 */
export async function restoreSpotifyFromBackup(
  runtime: Runtime,
  spicetify: SpicetifyInfo,
  options: SpotifyRestoreOptions = {},
): Promise<CommandResult> {
  if (!spicetify.available || !spicetify.path) {
    return { code: 1, stdout: "", stderr: "", error: "E_RESTORE_UNAVAILABLE: Spicetify is not installed; Spotify cannot be restored." };
  }
  if (options.cancel?.requested) {
    return {
      code: 130,
      stdout: "",
      stderr: "",
      cancelled: true,
      error: "E_CANCELLED: cancelled before spicetify restore; nothing was started.",
    };
  }
  const backup = await inspectBackupStateDetailed(runtime, spicetify, options);
  if (backup.state !== "ready") {
    return {
      code: 1,
      stdout: "",
      stderr: "",
      error: `E_RESTORE_BACKUP_${backup.state.toUpperCase()}: ${backup.error ?? "the Spicetify backup is not trustworthy"}; refusing to run spicetify restore.`,
    };
  }
  // Last stop before the mutation. After this point restore is protected and
  // must run to verification; no cancellation check happens in between.
  if (options.cancel?.requested) {
    return {
      code: 130,
      stdout: "",
      stderr: "",
      cancelled: true,
      error: "E_CANCELLED: cancelled before spicetify restore; nothing was started.",
    };
  }
  const before = captureSpotifyAppFiles(runtime, spicetify, options);
  const result = await runtime.run(spicetify.path, ["restore"], {
    timeoutMs: options.timeoutMs ?? OPERATION_TIMEOUTS.spicetifyBackup,
    ...(options.cancel ? { cancel: options.cancel } : {}),
  });
  if (result.code !== 0 || result.timedOut) {
    return {
      ...result,
      error: `E_RESTORE_FAILED: spicetify restore ${result.timedOut ? "timed out" : `exited with code ${result.code}`}${result.error ? `: ${sanitizeDetail(result.error)}` : "."}`,
    };
  }
  const rawAfter = captureSpotifyAppFiles(runtime, spicetify, options);
  const backupXpui = backup.files.find((file) => file.name === "xpui.spa");
  const backupLogin = backup.files.find((file) => file.name === "login.spa");
  const expected: ExpectedBackupSizes = { xpuiSize: backupXpui?.size ?? null, loginSize: backupLogin?.size ?? null };
  const after = withBackupSizes(rawAfter, expected, resolveRestoreFileSize(runtime, options));
  const verified = verifySpotifyRestoreApplied(before, after, expected);
  if (!verified.ok) {
    return {
      code: 1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      error: `E_RESTORE_UNVERIFIED: ${verified.error ?? "Spotify app files did not change"}. Nothing Spicetify-owned may be deleted.`,
    };
  }
  const sizeNote = verified.changed.length
    ? `${verified.changed.length} app file(s) changed`
    : "already-stock install verified";
  return {
    code: 0,
    stdout: `Spotify restored from ${backup.backupDir ?? "the Spicetify backup"}; ${sizeNote}.`,
    stderr: result.stderr ?? "",
  };
}

function resolveRestoreFileSize(
  runtime: Runtime,
  options: SpotifyRestoreOptions,
): (path: string) => number | null {
  try {
    if (options.fileSize) return options.fileSize;
    const probed = (runtime as Runtime & { fileSize?: (path: string) => number | null }).fileSize;
    if (typeof probed === "function") return probed;
  } catch {
    // Fall through to statSync.
  }
  return defaultBackupFileSize;
}

function withBackupSizes(
  after: SpotifyAppSnapshot,
  expected: ExpectedBackupSizes,
  fileSize: (path: string) => number | null,
): SpotifyAppSnapshot {
  if (!after.files.length) return after;
  let touched = false;
  const files = after.files.map((file) => {
    if (file.size !== null) return file;
    let probed: number | null = null;
    try {
      probed = fileSize(file.path);
    } catch {
      probed = null;
    }
    if (probed === null) return file;
    touched = true;
    return { ...file, size: probed };
  });
  if (!touched) return after;
  return {
    ...after,
    files,
    ok: files.every((file) => file.exists),
  };
}

/**
 * Run `spicetify backup` once for a fresh installation (B09). The caller must
 * have approved the surrounding plan; this function never prompts.
 * Cancellation is checked before the command starts only.
 */
export async function backupSpicetify(
  runtime: Runtime,
  path: string | null | undefined,
  options: { cancel?: CancelToken } = {},
): Promise<CommandResult> {
  if (options.cancel?.requested) return cancelledResult("spicetify backup");
  const exe = path ?? (await runtime.which("spicetify").catch(() => undefined)) ?? "spicetify";
  return runtime.run(exe, ["backup"], {
    timeoutMs: OPERATION_TIMEOUTS.spicetifyBackup,
    ...(options.cancel ? { cancel: options.cancel } : {}),
  });
}

/**
 * Manual-install details for display only (never executed). Rewritten for the
 * pinned official installer: the old winget-first / direct-release-zip
 * guidance is gone. The first argument is accepted as a version string or a
 * structural release object for compatibility with callers that still hold
 * resolved metadata. Only a resolved strict-stable version is ever printed;
 * when the release is unknown the releases page is shown instead.
 */
export interface SpicetifyManualDetailsInput {
  version?: string | null;
  tagName?: string | null;
  /** Raw tag on a resolved release object. */
  tag?: string | null;
  assetName?: string | null;
  assetUrl?: string | null;
  digest?: string | null;
  expectedSha256?: string | null;
}

export function spicetifyManualDetails(
  release?: SpicetifyManualDetailsInput | string | null,
  arch?: string | null,
): string {
  const details: SpicetifyManualDetailsInput =
    typeof release === "string" ? { version: release } : (release ?? {});
  const version = strictStableVersion(details.version) ??
    strictStableVersion(details.tagName) ??
    strictStableVersion(details.tag);
  const scriptUrl = `https://raw.githubusercontent.com/spicetify/cli/${OFFICIAL_INSTALLER_COMMIT}/install.ps1`;
  const lines = [
    `Docs: ${SPICETIFY_MANUAL_URL}`,
    `Official installer (pinned revision ${OFFICIAL_INSTALLER_COMMIT.slice(0, 12)}): ${scriptUrl}`,
    `Pinned installer SHA-256: ${OFFICIAL_INSTALLER_SHA256}`,
  ];
  if (version) {
    lines.push(`Target version: v${version}`);
    const assetName = details.assetName?.trim() || (arch ? `spicetify-${version}-windows-${arch}.zip` : null);
    if (assetName) lines.push(`Target asset: ${assetName}`);
    const assetUrl = details.assetUrl?.trim() ||
      (arch && assetName ? `https://github.com/spicetify/cli/releases/download/v${version}/${assetName}` : null);
    if (assetUrl) lines.push(`Asset URL: ${assetUrl}`);
    const digest = details.digest?.trim() || details.expectedSha256?.trim();
    if (digest) lines.push(`Expected digest: ${digest}`);
  } else {
    lines.push(`Target version: not resolved; choose the current stable release at ${SPICETIFY_RELEASES_PAGE}`);
  }
  if (arch) lines.push(`Detected architecture: ${arch}`);
  lines.push("Verify a downloaded installer before use: Get-FileHash .\\install.ps1 -Algorithm SHA256");
  lines.push("Run it as your ordinary user (never elevated); the script installs the resolved stable release.");
  lines.push(`Alternatives: winget install --id ${SPICETIFY_WINGET_ID} -e | scoop install spicetify-cli | choco install spicetify-cli`);
  lines.push("The Marketplace step and `spicetify update` are never auto-executed by this installer: the Marketplace step is removed from the staged script before it runs.");
  return lines.join("\n");
}

// Transitional compatibility surface: the official installer adapter now owns
// fresh installs and script-owned upgrades. Import directly from
// ./spicetify-official.ts in new code.
export { installSpicetify, upgradeSpicetify, spicetifyArchToken } from "./spicetify-official.ts";
export type { OfficialInstallerApproval, OfficialInstallerOptions } from "./spicetify-official.ts";
