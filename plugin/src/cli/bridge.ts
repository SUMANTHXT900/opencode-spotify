// V0.6.0 bridge inspection and operations.
// Read-only inspection never writes and never exposes the secret.
// All child processes use argv arrays via Runtime.run (shell:false).
import { lstatSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { BRIDGE_PROTOCOL } from "./compat.ts";
import { packageRoot } from "./runtime.ts";
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
  return runtime.run(pwsh, args, { timeoutMs: 120_000 });
}

/**
 * Run `spicetify apply`. The caller must have confirmed already.
 */
export async function applyBridge(runtime: Runtime, opts: ApplyBridgeOptions): Promise<CommandResult> {
  const exe =
    opts.spicetifyPath ?? (await runtime.which("spicetify").catch(() => undefined)) ?? "spicetify";
  return runtime.run(exe, ["apply"], { timeoutMs: 60_000 });
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
