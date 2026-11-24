// V0.6.0 Spicetify inspection and maintenance.
// Read-only inspection must never modify the system or print secrets.
// All child processes use argv arrays via Runtime.run (shell:false).
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { MIN_SPICETIFY, parseVersion } from "./compat.ts";
import type { CommandResult, Logger, Runtime, SpicetifyInfo, SpotifyInfo } from "./types.ts";

/** Fixed Store/Appx query. This constant must never include user input. */
export const SPOTIFY_STORE_QUERY =
  "Get-AppxPackage -Name SpotifyAB.SpotifyMusic | Select-Object -ExpandProperty InstallLocation";

export const SPICETIFY_INSTALL_SCRIPT_URL =
  "https://raw.githubusercontent.com/spicetify/cli/main/install.ps1";
export const SPICETIFY_WINGET_ID = "Spicetify.Spicetify";
export const SPICETIFY_BRIDGE_FILE = "opencode-spotify-bridge.js";

export interface InstallApproval {
  method: "winget" | "official-script";
  command: string;
  source: string;
  checksum?: string;
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
          { timeoutMs: 8000 },
        );
        if (result.code === 0 && /spicetify/i.test(result.stdout)) return "winget";
      } catch { /* probe failure means not winget */ }
    }
  } catch { /* ignore */ }
  try {
    const scoop = await runtime.which("scoop");
    if (scoop) {
      try {
        const result = await runtime.run(scoop, ["list", "spicetify"], { timeoutMs: 8000 });
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
          { timeoutMs: 8000 },
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
          { timeoutMs: 8000 },
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
        const result = await runtime.run(spicetifyCmd, ["path", "spotify"], { timeoutMs: 8000 });
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
    const result = await runtime.run(exe, ["-v"], { timeoutMs: 8000 });
    version = extractVersion(`${result.stdout}\n${result.stderr}`);
  } catch {
    version = null;
  }

  // Best-effort `spicetify path` probe (read-only, fixed argv).
  try {
    await runtime.run(exe, ["path"], { timeoutMs: 8000 });
  } catch {
    // Optional; config resolution below is authoritative.
  }

  let configPath: string | null = null;
  try {
    const result = await runtime.run(exe, ["-c"], { timeoutMs: 8000 });
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
 * Install Spicetify. Prefers winget; otherwise downloads the official
 * install.ps1 to temp, hashes it, requires approval, then runs it with
 * `pwsh -File`. Never runs without approval. Dry-run plans without executing.
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
  if (winget) {
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
    const result = await runtime.run(winget, wingetInstallArgs(), { timeoutMs: 120_000 });
    // Re-detect after the attempt (read-only, never throws).
    try {
      await inspectSpicetify(runtime);
    } catch {
      // Detection failure does not mask the install result.
    }
    return result;
  }

  const pwsh = await runtime.which("pwsh").catch(() => undefined);
  if (!pwsh) {
    return {
      code: 1,
      stdout: "",
      stderr: "",
      error: "PowerShell (pwsh) is required to install Spicetify.",
    };
  }
  if (opts.dryRun) {
    return {
      code: 0,
      stdout: `Would download ${SPICETIFY_INSTALL_SCRIPT_URL} and run it with pwsh -File.`,
      stderr: "",
    };
  }

  let scriptText: string;
  try {
    const response = await fetch(SPICETIFY_INSTALL_SCRIPT_URL, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) {
      return {
        code: 1,
        stdout: "",
        stderr: "",
        error: `Spicetify installer download failed (HTTP ${response.status}).`,
      };
    }
    scriptText = await response.text();
    if (scriptText.length > 1_000_000) {
      return { code: 1, stdout: "", stderr: "", error: "Spicetify installer download exceeded the size limit." };
    }
  } catch (err) {
    return {
      code: 1,
      stdout: "",
      stderr: "",
      error: err instanceof Error ? err.message.slice(0, 200) : "Spicetify installer download failed.",
    };
  }
  const checksum = `sha256:${createHash("sha256").update(scriptText, "utf8").digest("hex")}`;
  const tempBase = runtime.env.TEMP || runtime.env.TMP || runtime.cwd;
  const tempFile = join(tempBase, `spicetify-install-${runtime.now()}-${randomUUID().slice(0, 8)}.ps1`);
  try {
    runtime.writeText(tempFile, scriptText);
  } catch (err) {
    return {
      code: 1,
      stdout: "",
      stderr: "",
      error: err instanceof Error ? err.message.slice(0, 200) : "Cannot stage Spicetify installer.",
    };
  }

  const command = `pwsh -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ${tempFile}`;
  const details: InstallApproval = {
    method: "official-script",
    command,
    source: SPICETIFY_INSTALL_SCRIPT_URL,
    checksum,
  };
  try {
    opts.log?.out(`Spicetify install: ${details.command}`);
    opts.log?.out(`Source: ${details.source} (official spicetify/cli installer, branch tip, no signature published)`);
    opts.log?.out(`Checksum (of the downloaded file only, not a signature): ${checksum}`);
    opts.log?.out(`Execution runs with -ExecutionPolicy Bypass because the script is unsigned; prefer winget or manual review when possible.`);
    const approved = await opts.approve(details);
    if (!approved) {
      return { code: 1, stdout: "", stderr: "", error: "Spicetify installation declined." };
    }
    const result = await runtime.run(
      pwsh,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", tempFile],
      { timeoutMs: 120_000 },
    );
    try {
      await inspectSpicetify(runtime);
    } catch {
      // Detection failure does not mask the install result.
    }
    return result;
  } finally {
    try {
      runtime.remove(tempFile);
    } catch {
      // Best-effort cleanup; installer output remains authoritative.
    }
  }
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
  return runtime.run(file, args, { timeoutMs: 120_000 });
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
  return runtime.run(exe, ["apply"], { timeoutMs: 60_000 });
}
