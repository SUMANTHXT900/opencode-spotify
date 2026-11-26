// V0.6.0 bridge inspection and operations.
// Read-only inspection never writes and never exposes the secret.
// All child processes use argv arrays via Runtime.run (shell:false).
import { lstatSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { BRIDGE_PROTOCOL } from "./compat.ts";
import { packageRoot, OPERATION_TIMEOUTS } from "./runtime.ts";
import { spicetifyBackupCandidates } from "./spicetify.ts";
import type { BridgeInfo, CommandResult, Runtime, SpicetifyInfo } from "./types.ts";

export const BRIDGE_FILE = "opencode-spotify-bridge.js";
export const SECRET_PLACEHOLDER = "__OPENCODE_SPOTIFY_SECRET__";
const SECRET_PATTERN = /^[a-f0-9]{64}$/;

export interface BridgeOperationOptions {
  spicetifyPath?: string | null;
  dryRun: boolean;
  yes: boolean;
}

export interface ApplyBridgeOptions {
  spicetifyPath?: string | null;
  /** Optional progress sink (B24). Never receives secrets. */
  onProgress?: (line: string) => void;
}

export function bridgeConfigDir(runtime: Runtime): string {
  return join(runtime.env.APPDATA || join(runtime.homedir, "AppData", "Roaming"), "opencode-spotify");
}

export function bridgeConfigPath(runtime: Runtime): string {
  return join(bridgeConfigDir(runtime), "bridge.json");
}

function validOrigin(origin: unknown): origin is string | null {
  if (origin === null || origin === "null") return true;
  if (typeof origin !== "string" || origin.length > 300) return false;
  try {
    const url = new URL(origin);
    return url.protocol === "https:" && url.origin === origin;
  } catch {
    return false;
  }
}

function bundledTemplatePath(): string {
  return join(packageRoot(import.meta.url), "spicetify", BRIDGE_FILE);
}

/**
 * Read-only bridge inspection. Validates the credential shape without
 * exposing the secret and compares the installed extension against the
 * bundled template with the stored secret substituted in memory.
 */
export async function inspectBridge(runtime: Runtime, spicetify: SpicetifyInfo): Promise<BridgeInfo> {
  const credentialPath = bridgeConfigPath(runtime);
  let configExists = false;
  let credentialValid = false;
  let installedFlag = false;
  let origins = 0;
  let secret: string | null = null;
  try {
    configExists = runtime.exists(credentialPath) && runtime.isFile(credentialPath);
  } catch {
    configExists = false;
  }
  if (configExists) {
    try {
      const raw = runtime.readText(credentialPath);
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        const candidate = parsed as {
          version?: unknown;
          secret?: unknown;
          origins?: unknown;
          installed?: unknown;
        };
        const versionOk = candidate.version === 1;
        const secretOk = typeof candidate.secret === "string" && SECRET_PATTERN.test(candidate.secret);
        const originsOk =
          Array.isArray(candidate.origins) &&
          candidate.origins.length <= 1 &&
          candidate.origins.every((entry) => validOrigin(entry));
        const installedOk = typeof candidate.installed === "boolean";
        if (versionOk && secretOk && originsOk && installedOk) {
          credentialValid = true;
          installedFlag = candidate.installed === true;
          origins = (candidate.origins as unknown[]).length;
          secret = candidate.secret as string;
        }
      }
    } catch {
      credentialValid = false;
      secret = null;
    }
  }

  let extensionPath: string | null = null;
  if (spicetify.extensionsDir) {
    try {
      extensionPath = join(spicetify.extensionsDir, BRIDGE_FILE);
    } catch {
      extensionPath = null;
    }
  } else if (spicetify.configPath) {
    try {
      extensionPath = join(dirname(spicetify.configPath), "Extensions", BRIDGE_FILE);
    } catch {
      extensionPath = null;
    }
  }

  let extensionExists = false;
  if (extensionPath) {
    try {
      extensionExists = runtime.exists(extensionPath) && runtime.isFile(extensionPath);
    } catch {
      extensionExists = false;
    }
  }

  let registration: BridgeInfo["registration"] = "unknown";
  let error: string | undefined;
  if (spicetify.error && /ambiguous|duplicate/i.test(spicetify.error)) {
    registration = "unknown";
    error = spicetify.error.slice(0, 200);
  } else if (!spicetify.available || !spicetify.configPath) {
    registration = "unknown";
  } else if (!spicetify.bridgeRegistered) {
    registration = "absent";
  } else if (!extensionExists || !extensionPath) {
    registration = "stale";
  } else if (!credentialValid || !secret) {
    registration = "unknown";
  } else {
    try {
      const template = runtime.readText(bundledTemplatePath());
      if (template.split(SECRET_PLACEHOLDER).length !== 2) {
        registration = "unknown";
        error = "Bundled bridge template is unexpected.";
      } else {
        const expected = template.replace(SECRET_PLACEHOLDER, secret);
        const actual = runtime.readText(extensionPath);
        registration = actual === expected ? "current" : "stale";
      }
    } catch (err) {
      registration = "unknown";
      if (err instanceof Error && err.message && !SECRET_PATTERN.test(err.message)) {
        const message = err.message.slice(0, 200);
        if (!SECRET_PATTERN.test(message) && secret && !message.includes(secret)) error = message;
      }
    }
  }

  const installed = credentialValid && installedFlag && extensionExists;
  return {
    configExists,
    credentialValid,
    installed,
    origins,
    extensionPath,
    extensionExists,
    registration,
    protocol: BRIDGE_PROTOCOL,
    ...(error ? { error } : {}),
  };
}

/**
 * Prepare or remove the bridge via the approved PowerShell installer.
 * Always passes -SkipApply (apply is a separate confirmed step) and -Yes
 * once the CLI has approval. Dry-run plans without executing. Refuses when
 * pwsh is missing or when approval is absent.
 */
export async function bridgeOperation(
  runtime: Runtime,
  operation: "install" | "repair" | "uninstall",
  opts: BridgeOperationOptions,
): Promise<CommandResult> {
  const pwsh = await runtime.which("pwsh").catch(() => undefined);
  if (!pwsh) {
    return { code: 1, stdout: "", stderr: "", error: "PowerShell (pwsh) is required." };
  }
  const script = join(packageRoot(import.meta.url), "scripts", "install-extension.ps1");
  try {
    if (!runtime.exists(script)) {
      return { code: 1, stdout: "", stderr: "", error: "Bridge installer script is missing." };
    }
  } catch {
    return { code: 1, stdout: "", stderr: "", error: "Bridge installer script is missing." };
  }

  const operationSwitch = operation === "install" ? "-Install" : operation === "repair" ? "-Repair" : "-Uninstall";
  const describeSpicetify = opts.spicetifyPath ? ` -SpicetifyPath ${opts.spicetifyPath}` : "";
  const planned = `pwsh -NoProfile -NonInteractive -File ${script} ${operationSwitch} -Yes -SkipApply${describeSpicetify}`;
  if (opts.dryRun) {
    return { code: 0, stdout: `Would run: ${planned}`, stderr: "" };
  }
  if (!opts.yes) {
    return {
      code: 1,
      stdout: "",
      stderr: "",
      error: "Bridge operation requires explicit approval (--yes).",
    };
  }

  const args = ["-NoProfile", "-NonInteractive", "-File", script, operationSwitch, "-Yes", "-SkipApply"];
  if (opts.spicetifyPath) {
    args.push("-SpicetifyPath", opts.spicetifyPath);
  }
  return runtime.run(pwsh, args, { timeoutMs: OPERATION_TIMEOUTS.bridge });
}

/**
 * Run `spicetify apply`. The caller must have confirmed already.
 *
 * B09: a fresh install has no initial Spotify backup, so a bare `apply`
 * fails. When the backup directory looks missing, run `spicetify backup`
 * once first (never overwriting a valid backup), then apply. When the first
 * apply fails with a backup-related error, retry once after a backup.
 * Returns the final apply result; backup output is folded into stdout.
 *
 * B24: explicit progress reporting around the backup-first flow. When a
 * missing backup is detected, when the backup is created, when apply runs,
 * and a post-apply verification line are all reported via `onProgress`
 * (wired to UI by callers). Never claims playback was verified.
 */
export async function applyBridge(runtime: Runtime, opts: ApplyBridgeOptions): Promise<CommandResult> {
  const exe =
    opts.spicetifyPath ?? (await runtime.which("spicetify").catch(() => undefined)) ?? "spicetify";
  // Progress is informational only: a broken sink must never abort (or
  // mis-report) an apply that may already have mutated the installation.
  const progress = (line: string): void => {
    try {
      opts.onProgress?.(line);
    } catch {
      // Swallow reporter failures; the operation result is the source of truth.
    }
  };
  // Anchored backup-missing matcher: only genuine "no backup" failures from
  // `spicetify apply` trigger the retry path — never incidental mentions of
  // backup paths, files, or unrelated output.
  const isBackupMissingError = (result: CommandResult): boolean =>
    /no backup|backup.*(missing|not found|does not exist|not backed up)|need.*backup|must.*backup|backup failed|haven't backed up|have not backed up/i.test(
      `${result.stdout ?? ""}\n${result.stderr ?? ""}\n${result.error ?? ""}`,
    );
  let didBackup = false;
  const needsBackup = hasMissingBackup(runtime);
  if (needsBackup) {
    progress("Spicetify backup not found; creating a backup before apply.");
    const backup = await runtime.run(exe, ["backup"], { timeoutMs: OPERATION_TIMEOUTS.spicetifyBackup });
    if (backup.code !== 0) {
      return {
        code: backup.code,
        stdout: backup.stdout ?? "",
        stderr: backup.stderr ?? "",
        error: `Spicetify backup failed before apply: ${backup.error ?? backup.stderr.split(/\r?\n/).find((line) => line.trim()) ?? "unknown error"}`,
        ...(backup.timedOut ? { timedOut: true as const } : {}),
      };
    }
    progress("Spicetify backup created.");
    didBackup = true;
  }
  progress("Running spicetify apply.");
  const first = await runtime.run(exe, ["apply"], { timeoutMs: OPERATION_TIMEOUTS.spicetifyApply });
  if (first.code === 0) {
    progress("Spicetify apply completed (playback not verified).");
    return first;
  }
  if (!isBackupMissingError(first)) {
    return first;
  }
  // Already backed up once for this invocation: do not overwrite again.
  if (didBackup) {
    return { ...first, error: `${first.error ?? "spicetify apply failed"} (a backup was already taken; not retrying to avoid overwriting it)` };
  }
  // Backup-related failure: ensure a backup exists, then retry once.
  progress("Spicetify apply reported a missing backup; creating a backup before retry.");
  const backup = await runtime.run(exe, ["backup"], { timeoutMs: OPERATION_TIMEOUTS.spicetifyBackup });
  if (backup.code !== 0) {
    return {
      code: first.code,
      stdout: first.stdout ?? "",
      stderr: first.stderr ?? "",
      error: `${first.error ?? "spicetify apply failed"} (automatic backup also failed: ${backup.error ?? "unknown error"})`,
      ...(backup.timedOut || first.timedOut ? { timedOut: true as const } : {}),
      ...(typeof (backup.durationMs ?? first.durationMs) === "number" ? { durationMs: (backup.durationMs ?? first.durationMs) as number } : {}),
    };
  }
  progress("Spicetify backup created.");
  progress("Running spicetify apply.");
  const retried = await runtime.run(exe, ["apply"], { timeoutMs: OPERATION_TIMEOUTS.spicetifyApply });
  if (retried.code === 0) {
    progress("Spicetify apply completed (playback not verified).");
  }
  return retried;
}

/** True when every known Spicetify backup directory is absent (B09/B05). Never throws. */
function hasMissingBackup(runtime: Runtime): boolean {
  try {
    // B05: a valid backup may live in the roaming state root, not only under
    // %LOCALAPPDATA%. Probe the shared candidate list so an existing backup is
    // never overwritten by an unnecessary `spicetify backup`.
    let sawCandidate = false;
    for (const dir of spicetifyBackupCandidates(runtime)) {
      try {
        if (runtime.exists(dir)) return false;
        sawCandidate = true;
      } catch {
        continue;
      }
    }
    return sawCandidate;
  } catch {
    // Fail closed: if candidates cannot even be computed, do not force a backup.
    return false;
  }
}

/**
 * Delete only %APPDATA%/opencode-spotify. The caller must have confirmed
 * separately. Refuses symbolic links and refuses unexpected locations.
 */
export async function removeCredentials(runtime: Runtime): Promise<CommandResult> {
  const directory = bridgeConfigDir(runtime);
  if (basename(directory) !== "opencode-spotify") {
    return { code: 1, stdout: "", stderr: "", error: "Refusing to remove an unexpected location." };
  }
  let exists = false;
  try {
    exists = runtime.exists(directory);
  } catch {
    exists = false;
  }
  if (!exists) {
    return { code: 0, stdout: "Credential directory not found.", stderr: "" };
  }
  const credentialFile = join(directory, "bridge.json");
  for (const candidate of [credentialFile, directory]) {
    try {
      if (lstatSync(candidate).isSymbolicLink()) {
        return { code: 1, stdout: "", stderr: "", error: "Refusing symbolic-link credential path." };
      }
    } catch {
      // Missing paths throw; existence was checked above for the directory.
      continue;
    }
  }
  try {
    runtime.remove(directory);
  } catch (err) {
    return {
      code: 1,
      stdout: "",
      stderr: "",
      error: err instanceof Error ? err.message.slice(0, 200) : "Cannot remove credentials.",
    };
  }
  return { code: 0, stdout: `Removed ${directory}.`, stderr: "" };
}
