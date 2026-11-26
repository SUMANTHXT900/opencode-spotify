// Official Spicetify installer integration (A04 §4 / B25, B26, B27, B28).
//
// The upstream install.ps1 is interactive, performs NO integrity check of the
// binary it downloads, and installs Marketplace by default. This adapter:
//   * pins one reviewed script revision by URL + SHA-256 + byte length,
//   * resolves the release target dynamically from GitHub's latest stable
//     release (never a static version, never a fallback),
//   * applies a reviewed, byte-exact Marketplace-removal patch and verifies
//     both the original and executed digests before execution,
//   * executes the patched script as a file under a held read handle so the
//     hashed bytes are the executed bytes and PowerShell execution policy is
//     respected (no Invoke-Expression, no policy override),
//   * verifies the installed executable (Authenticode signer, exact version,
//     user PATH, Marketplace untouched) before claiming success.
//
// Read-only inspection stays in spicetify.ts. This module only mutates after
// explicit approval, and never downloads or executes anything in dry-run mode.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  MIN_SPICETIFY,
  OFFICIAL_INSTALLER_BYTES,
  OFFICIAL_INSTALLER_COMMIT,
  OFFICIAL_INSTALLER_MARKETPLACE_BLOCK_BYTES,
  OFFICIAL_INSTALLER_MARKETPLACE_BLOCK_SHA256,
  OFFICIAL_INSTALLER_MARKETPLACE_BLOCK_LINES,
  OFFICIAL_INSTALLER_PATCHED_BYTES,
  OFFICIAL_INSTALLER_PATCHED_SHA256,
  OFFICIAL_INSTALLER_SHA256,
  OFFICIAL_INSTALLER_URL,
  REVIEWED_SPICETIFY_RELEASES,
  compareVersions,
} from "./compat.ts";
import { OPERATION_TIMEOUTS, sanitizeDetail, systemTool } from "./runtime.ts";
import {
  SPICETIFY_RELEASES_URL,
  parseStableVersion,
  releaseArchToken,
  resolveSpicetifyRelease,
  spicetifyReleaseAsset,
} from "./spicetify-release.ts";
import type { ReleaseResolution, SpicetifyRelease } from "./spicetify-release.ts";
import type { CancelToken } from "./cancel.ts";
import type { CommandResult, Logger, Runtime, SpicetifyInfo } from "./types.ts";

/** Pinned official installer script. The revision is immutable; the SHA-256
 *  is re-checked in Node and again inside PowerShell before execution. */
export { OFFICIAL_INSTALLER_URL };

/** Display-only documentation reference. */
export const OFFICIAL_INSTALLER_DOCS_URL = "https://spicetify.app/docs/getting-started";

/** Upstream releases page used when no verified target exists. */
export const SPICETIFY_RELEASES_PAGE = "https://github.com/spicetify/cli/releases/latest";

const OFFICIAL_TIMEOUT_MS = 300_000;
const OFFICIAL_KILL_GRACE_MS = 10_000;
const MAX_SCRIPT_BYTES = 128 * 1024;
const TEE_BUFFER_LIMIT = 8 * 1024;
const WINGET_ID = "Spicetify.Spicetify";

/** The only signer CN the reviewed releases are published under (M3). */
export const SIGNPATH_SIGNER_SIMPLE_NAME = "SignPath Foundation";

/** Emit the certificate SimpleName (exact CN) alongside the raw subject. */
const SIGNATURE_QUERY =
  "$s=Get-AuthenticodeSignature -LiteralPath $env:SPX_EXE;" +
  "$n=if($s.SignerCertificate){[string]$s.SignerCertificate.GetNameInfo(" +
  "[System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName,$false)}else{''};" +
  "[pscustomobject]@{Status=[string]$s.Status;Subject=[string]$s.SignerCertificate.Subject;SimpleName=$n}" +
  "|ConvertTo-Json -Compress";

const USER_PATH_QUERY = "[Environment]::GetEnvironmentVariable('Path','User')";

const RESTORE_USER_PATH_QUERY =
  "if($null -ne $env:SPX_USER_PATH){[Environment]::SetEnvironmentVariable('Path',$env:SPX_USER_PATH,'User')}";

const ELEVATION_QUERY =
  "[bool]((New-Object Security.Principal.WindowsPrincipal(" +
  "[Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole(" +
  "[Security.Principal.WindowsBuiltInRole]::Administrator))";

const LANGUAGE_MODE_QUERY = "$ExecutionContext.SessionState.LanguageMode";

/** The only environment values the installer child receives. Module search
 *  paths and inherited secrets are deliberately absent. */
const CHILD_ENV_WHITELIST = [
  "SystemRoot",
  "windir",
  "PATH",
  "TEMP",
  "TMP",
  "LOCALAPPDATA",
  "APPDATA",
  "USERPROFILE",
  "PROCESSOR_ARCHITECTURE",
  "ComSpec",
] as const;

const REQUIRED_CHILD_ENV = ["LOCALAPPDATA", "APPDATA", "PROCESSOR_ARCHITECTURE"] as const;

/**
 * The reviewed 19-line replacement for install.ps1 lines 224-242 (I3). It is
 * comments only: no Marketplace prompt, no Marketplace URL, no nested
 * download/evaluation. Everything outside the block is byte-identical to the
 * pinned revision.
 */
const MARKETPLACE_REPLACEMENT = [
  "#region Marketplace",
  "# Marketplace installation is disabled by the opencode-spotify adapter.",
  "# Replaces spicetify/cli@f4a824fbbe07233adeab889328e6fefdc274660b",
  "# install.ps1 lines 224-242 (LGPL-2.1).",
  "#",
  "# Upstream prompted with default Yes and then fetched and evaluated a mutable",
  "# Marketplace installer from the upstream Marketplace repository. That prompt",
  "# and its download/evaluation branch are removed here, so no Marketplace code",
  "# is present or reachable and no Marketplace URL is contacted.",
  "#",
  "# Everything outside this region is byte-identical to the pinned revision:",
  "# - the existing-install prompt and optional spicetify update branch,",
  "# - Move-OldSpicetifyFolder (legacy folder copy/delete),",
  "# - Get-Spicetify/Install-Spicetify extraction,",
  "# - Add-SpicetifyToPath (user PATH only), and",
  '# - the final "run spicetify -h" message.',
  "#",
  "# Existing %APPDATA%\\spicetify Marketplace files are neither read nor changed.",
  "#endregion Marketplace",
] as const;

export type OfficialProvenance = "reviewed-digest" | "authenticode+version" | "manager";
export type OfficialPatchState = "marketplace-removed" | "none";

export interface OfficialInstallerApproval {
  method: "official-installer" | "winget" | "scoop" | "choco";
  intent: "install" | "upgrade";
  command: string;
  source: string;
  scriptUrl: string;
  /** SHA-256 of the pinned original script (verified first). */
  scriptSha256: string;
  /** SHA-256 of the executed, Marketplace-removed variant (re-checked in PowerShell). */
  executedSha256: string;
  targetVersion: string;
  provenance: OfficialProvenance;
  resolvedAt: number;
  patch: OfficialPatchState;
  interactive: boolean;
  warnings: string[];
}

/** Everything the interactive run needs. Values are argv/env only. */
export interface OfficialInteractiveCommand {
  file: string;
  args: string[];
  timeoutMs: number;
  env: Record<string, string>;
  /** Cooperative cancellation: the runner may request exactly one kill. */
  cancel?: CancelToken;
}

export interface OfficialInteractiveOutcome {
  code: number | null;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
  cancelled?: boolean;
  pid?: number;
  /** A kill was requested/handled by the runner (never kill twice). */
  terminated?: boolean;
  /** The child's close event (confirmed death) was observed before resolving. */
  exitConfirmed?: boolean;
  /** Number of kill attempts made by the runner (0 or 1 by design). */
  killAttempts?: number;
}

export interface StagedOfficialScript {
  path: string;
  /** SHA-256 of the bytes actually written; production always supplies it. */
  sha256?: string;
  cleanup: () => void;
}

export type PatchResult =
  | { ok: true; bytes: Uint8Array; sha256: string }
  | { ok: false; code: "E_PIN_MISMATCH" | "E_PATCH_FAILED" | "E_PATCH_MISMATCH"; error: string };

export interface OfficialInstallerDeps {
  /** HTTP client for the pinned script (tests inject a fake). */
  fetcher?: typeof fetch;
  /** Executes the interactive child. Tests replace this; production inherits
   *  the console stdin so the operator answers the upstream prompts. */
  runInteractive?: (command: OfficialInteractiveCommand) => Promise<OfficialInteractiveOutcome>;
  isElevated?: (runtime: Runtime, pwsh: string) => Promise<boolean | null>;
  languageMode?: (runtime: Runtime, pwsh: string) => Promise<string | null>;
  /** Whether the process owns an interactive console for inherited stdio. */
  hasConsole?: () => boolean;
  hashFile?: (path: string) => string;
  fileSize?: (path: string) => number;
  readUserPath?: (runtime: Runtime, pwsh: string) => Promise<string | null>;
  writeUserPath?: (runtime: Runtime, pwsh: string, value: string) => Promise<boolean>;
  killTree?: (pid: number | undefined) => Promise<void>;
  stageScript?: (bytes: Uint8Array) => Promise<StagedOfficialScript>;
  /** Reviewed patch seam. Tests can force E_PATCH_FAILED; production uses the
   *  pure deterministic implementation below. */
  patchScript?: (bytes: Uint8Array) => PatchResult;
  /** Release resolution seam (fresh resolver by default). */
  resolveRelease?: (input: {
    offline?: boolean
    fetcher?: typeof fetch
    arch?: string | null
    requireWindowsAsset?: boolean
    now?: number | (() => number)
    signal?: AbortSignal
  }) => Promise<ReleaseResolution>;
  /** Post-install detection seam; defaults to a bounded local probe. */
  inspectInstalled?: (runtime: Runtime) => Promise<{ available: boolean; version: string | null } | null>;
}

export interface OfficialInstallerOptions extends OfficialInstallerDeps {
  dryRun?: boolean;
  offline?: boolean;
  /** The upstream script is interactive; noninteractive callers are refused. */
  nonInteractive?: boolean;
  /** Explicit opt-in form of `nonInteractive: false`. */
  interactive?: boolean;
  approve?: (details: OfficialInstallerApproval) => Promise<boolean>;
  log?: Logger;
  onProgress?: (line: string) => void;
  beforeInteractive?: () => Promise<void>;
  afterInteractive?: () => Promise<void>;
  timeoutMs?: number;
  /** Pre-resolved release (setup resolves once before the wizard approval). */
  release?: SpicetifyRelease;
  /** Host architecture override for asset selection (tests). */
  arch?: string | null;
  /** Cooperative cancellation for fetch and the interactive child. */
  cancel?: CancelToken;
  /** Pre-fetched pinned installer bytes (air-gapped/testing). They are still
   *  verified against the pinned length, ASCII/no-BOM rule and SHA-256, then
   *  patched and verified again before staging. */
  scriptBytes?: Uint8Array;
}

/**
 * Upgrade uses the same approval contract as install: the official flow for
 * script-owned copies and the owner's manager command for manager-owned ones.
 */
export type OfficialUpgradeOptions = OfficialInstallerOptions;

export interface OfficialVerificationResult {
  ok: boolean;
  code?: string;
  error?: string;
  version?: string | null;
  signer?: string | null;
  provenance?: OfficialProvenance;
  warnings: string[];
}

function appDataDir(runtime: Runtime): string {
  return runtime.env.APPDATA || join(runtime.homedir, "AppData", "Roaming");
}

function localAppDataDir(runtime: Runtime): string {
  return runtime.env.LOCALAPPDATA || join(runtime.homedir, "AppData", "Local");
}

/** Fixed install location written by the official script (program + binary). */
export function officialSpicetifyDir(runtime: Runtime): string {
  return join(localAppDataDir(runtime), "spicetify");
}

/** Spicetify v2.x state root (config, Backup, Extensions, Marketplace). */
export function officialSpicetifyStateDir(runtime: Runtime): string {
  return join(appDataDir(runtime), "spicetify");
}

export function officialBackupDir(runtime: Runtime): string {
  return join(officialSpicetifyStateDir(runtime), "Backup");
}

export function officialSpicetifyExe(runtime: Runtime): string {
  return join(officialSpicetifyDir(runtime), "spicetify.exe");
}

/** Directories the Marketplace script would create/modify. The v2.x state root
 *  is roaming; the legacy local candidates are monitored too so a stray
 *  Marketplace install can never be mistaken for an unchanged state. */
function marketplacePaths(runtime: Runtime): string[] {
  return [
    join(officialSpicetifyStateDir(runtime), "Marketplace"),
    join(officialSpicetifyStateDir(runtime), "Extensions", "marketplace"),
    join(officialSpicetifyDir(runtime), "Marketplace"),
  ];
}

export function snapshotMarketplace(runtime: Runtime): Record<string, boolean> {
  const snapshot: Record<string, boolean> = {};
  for (const path of marketplacePaths(runtime)) {
    try {
      snapshot[path] = runtime.exists(path);
    } catch {
      snapshot[path] = false;
    }
  }
  return snapshot;
}

function failed(code: string, detail: string): CommandResult {
  return { code: 1, stdout: "", stderr: "", error: `${code}: ${detail}` };
}

/** Every cancelled return in the official flow (M5): exit 130 + cancelled. */
function cancelledResult(detail: string): CommandResult {
  return {
    ...failed("E_CANCELLED", detail),
    code: 130,
    cancelled: true,
    error: "Cancelled by the user.",
  };
}

function manualHint(): string {
  return `Manual installation remains available: ${OFFICIAL_INSTALLER_DOCS_URL} (pinned script revision ${OFFICIAL_INSTALLER_COMMIT.slice(0, 12)}: ${OFFICIAL_INSTALLER_URL}; releases: ${SPICETIFY_RELEASES_PAGE}). Then re-run setup and choose recheck.`;
}

function lastLines(output: string, count = 12): string {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.slice(-count).map((line) => sanitizeDetail(line)).join(" | ");
}

function normalizePathEntry(value: string): string {
  return value.trim().replace(/[\\/]+$/, "").toLowerCase();
}

function isCancelled(cancel: CancelToken | undefined): boolean {
  return cancel?.requested === true;
}

/**
 * Verify the downloaded installer exactly against the A02 evidence:
 * 8307 bytes, ASCII with no BOM, SHA-256 e65d1651…e22e.
 */
export function verifyOfficialInstallerScript(bytes: Uint8Array): {
  ok: boolean;
  code?: string;
  error?: string;
  sha256: string;
} {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (bytes.length !== OFFICIAL_INSTALLER_BYTES) {
    return {
      ok: false,
      code: "E_PIN_MISMATCH",
      error: `installer script length ${bytes.length} does not match the pinned ${OFFICIAL_INSTALLER_BYTES} bytes`,
      sha256,
    };
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { ok: false, code: "E_PIN_MISMATCH", error: "installer script has a UTF-8 BOM; the pinned script is plain ASCII", sha256 };
  }
  for (const byte of bytes) {
    if (byte > 0x7f) {
      return { ok: false, code: "E_PIN_MISMATCH", error: "installer script is not plain ASCII", sha256 };
    }
  }
  if (sha256.toLowerCase() !== OFFICIAL_INSTALLER_SHA256.toLowerCase()) {
    return {
      ok: false,
      code: "E_PIN_MISMATCH",
      error: `installer script SHA-256 ${sha256} does not match the pinned ${OFFICIAL_INSTALLER_SHA256}`,
      sha256,
    };
  }
  return { ok: true, sha256 };
}

function indexOfBytes(haystack: Uint8Array, needle: string): number {
  const target = Buffer.from(needle, "ascii");
  return Buffer.from(haystack.buffer, haystack.byteOffset, haystack.byteLength).indexOf(target);
}

function countOccurrences(haystack: Uint8Array, needle: string): number {
  const target = Buffer.from(needle, "ascii");
  const buffer = Buffer.from(haystack.buffer, haystack.byteOffset, haystack.byteLength);
  let count = 0;
  let index = buffer.indexOf(target);
  while (index !== -1) {
    count += 1;
    index = buffer.indexOf(target, index + target.length);
  }
  return count;
}

function asciiText(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("ascii");
}

/**
 * Deterministic reviewed Marketplace-removal patch (I3). The original must
 * already match the pin; exactly one Marketplace region must exist; the
 * extracted block must match the reviewed original block; and the result must
 * match the reviewed patched size/digest and invariants. Any deviation aborts
 * before staging or execution. Never falls back to the unmodified script.
 */
export function patchOfficialInstallerScript(bytes: Uint8Array): PatchResult {
  const original = verifyOfficialInstallerScript(bytes);
  if (!original.ok) {
    return { ok: false, code: "E_PIN_MISMATCH", error: original.error ?? "installer script pin mismatch" };
  }

  const regionStart = indexOfBytes(bytes, "#region Marketplace");
  const regionEndMarker = indexOfBytes(bytes, "#endregion Marketplace");
  if (regionStart === -1 || regionEndMarker === -1 || regionEndMarker < regionStart) {
    return { ok: false, code: "E_PATCH_FAILED", error: "the reviewed Marketplace region markers are missing" };
  }
  if (countOccurrences(bytes, "#region Marketplace") !== 1 || countOccurrences(bytes, "#endregion Marketplace") !== 1) {
    return { ok: false, code: "E_PATCH_FAILED", error: "the Marketplace region markers are not unique" };
  }

  const blockEnd = regionEndMarker + Buffer.byteLength("#endregion Marketplace");
  const block = bytes.subarray(regionStart, blockEnd);
  const blockHash = createHash("sha256").update(block).digest("hex");
  if (block.length !== OFFICIAL_INSTALLER_MARKETPLACE_BLOCK_BYTES || blockHash !== OFFICIAL_INSTALLER_MARKETPLACE_BLOCK_SHA256) {
    return {
      ok: false,
      code: "E_PATCH_FAILED",
      error: "the extracted Marketplace region does not match the reviewed original block",
    };
  }

  const prefix = bytes.subarray(0, regionStart);
  const suffix = bytes.subarray(blockEnd);
  if (suffix.length !== 19) {
    return { ok: false, code: "E_PATCH_FAILED", error: "unexpected bytes after the Marketplace region; refusing to patch" };
  }

  const replacement = Buffer.from(MARKETPLACE_REPLACEMENT.join("\r\n"), "ascii");
  const patched = Buffer.concat([Buffer.from(prefix), replacement, Buffer.from(suffix)]);
  const patchedBytes = new Uint8Array(patched);

  if (patchedBytes.length !== OFFICIAL_INSTALLER_PATCHED_BYTES) {
    return {
      ok: false,
      code: "E_PATCH_MISMATCH",
      error: `patched script is ${patchedBytes.length} bytes; expected ${OFFICIAL_INSTALLER_PATCHED_BYTES}`,
    };
  }
  for (const byte of patchedBytes) {
    if (byte > 0x7f) {
      return { ok: false, code: "E_PATCH_MISMATCH", error: "patched script is not plain ASCII" };
    }
  }
  const patchedHash = createHash("sha256").update(patchedBytes).digest("hex");
  if (patchedHash !== OFFICIAL_INSTALLER_PATCHED_SHA256) {
    return {
      ok: false,
      code: "E_PATCH_MISMATCH",
      error: `patched script SHA-256 ${patchedHash} does not match the reviewed ${OFFICIAL_INSTALLER_PATCHED_SHA256}`,
    };
  }

  const text = asciiText(patchedBytes);
  const invariants: Array<[string, boolean]> = [
    ["no Marketplace repository URL", !text.includes("spicetify-marketplace")],
    ["no Marketplace prompt", !text.includes("Do you also want to install Spicetify Marketplace")],
    ["no Invoke-Expression", !text.includes("Invoke-Expression")],
    ["exactly one binary Invoke-WebRequest", countOccurrences(patchedBytes, "Invoke-WebRequest @Parameters") === 1],
    ["one Marketplace region", countOccurrences(patchedBytes, "#region Marketplace") === 1],
    ["one Marketplace end marker", countOccurrences(patchedBytes, "#endregion Marketplace") === 1],
    ["main end marker preserved", text.includes("#endregion Main")],
    ["download function preserved", text.includes("function Get-Spicetify")],
    ["install function preserved", text.includes("function Install-Spicetify")],
    ["PATH function preserved", text.includes("function Add-SpicetifyToPath")],
    ["legacy-folder function preserved", text.includes("function Move-OldSpicetifyFolder")],
    ["replacement line count", MARKETPLACE_REPLACEMENT.length === OFFICIAL_INSTALLER_MARKETPLACE_BLOCK_LINES],
  ];
  for (const [label, ok] of invariants) {
    if (!ok) return { ok: false, code: "E_PATCH_MISMATCH", error: `patched script failed the ${label} invariant` };
  }
  if (prefix.length !== 7259) {
    return { ok: false, code: "E_PATCH_FAILED", error: "unexpected prefix length; refusing to patch" };
  }

  return { ok: true, bytes: patchedBytes, sha256: patchedHash };
}

/**
 * Fixed wrapper (B28). `$v` is pinned in the same `-Command` scope the script
 * inherits. The staged file is opened with `FileShare.Read` and hashed from a
 * buffer that stays valid while `&` executes the file itself, so execution
 * policy/AppLocker see a script file and the executed bytes are the hashed
 * bytes. No sentinel is printed: an upstream `exit` returns to this harness,
 * so success can only come from exit codes plus post-install verification.
 */
export function buildOfficialWrapperCommand(version: string): string {
  const stable = parseStableVersion(version);
  if (!stable) {
    throw new Error(`E_NO_TARGET: ${JSON.stringify(version)} is not a strict stable semver version`);
  }
  return [
    `$v='${stable}'`,
    "$ErrorActionPreference='Stop'",
    "$__spxStream=$null",
    "try {",
    "  $__spxStream=[IO.File]::Open($env:SPX_SCRIPT,'Open','Read','Read')",
    "  $__spxBytes=New-Object byte[] $__spxStream.Length",
    "  $__spxRead=0",
    "  while($__spxRead -lt $__spxBytes.Length){",
    "    $__spxN=$__spxStream.Read($__spxBytes,$__spxRead,$__spxBytes.Length-$__spxRead)",
    "    if($__spxN -le 0){break}",
    "    $__spxRead+=$__spxN",
    "  }",
    "  if($__spxRead -ne $__spxBytes.Length){Write-Output 'E_PIN_MISMATCH'; exit 90}",
    "  $__spxHash=([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($__spxBytes)) -replace '-','').ToLowerInvariant()",
    "  if($__spxHash -ne $env:SPX_SCRIPT_SHA256){Write-Output 'E_PIN_MISMATCH'; exit 90}",
    "  $global:LASTEXITCODE=0",
    "  try { & $env:SPX_SCRIPT }",
    "  catch [System.Management.Automation.PSSecurityException] {",
    "    Write-Output ('E_POLICY_BLOCKED: ' + $_.Exception.Message)",
    "    exit 92",
    "  }",
    "  catch {",
    "    Write-Output ('E_SCRIPT_EXCEPTION: ' + $_.Exception.Message)",
    "    exit 91",
    "  }",
    "  $__spxCode = if($null -eq $LASTEXITCODE){0}else{$LASTEXITCODE}",
    "  if($__spxCode -ne 0){exit $__spxCode}",
    "  exit 0",
    "}",
    "finally {",
    "  if($__spxStream){$__spxStream.Dispose()}",
    "}",
  ].join("\n");
}

/** Display form for the approval dialog (never expanded to the full 8 KB). */
export function describeOfficialCommand(version: string): string {
  const stable = parseStableVersion(version);
  const target = stable ?? "<invalid-target>";
  return `pwsh -NoLogo -NoProfile -Command "$v='${target}'; <held-handle SHA-256 re-check>; & $env:SPX_SCRIPT; exit 90/91/92 on pin/exception/policy" (inherited console; answer upstream prompts yourself)`;
}

function targetVersionOf(target: SpicetifyRelease | string): string {
  return typeof target === "string" ? (parseStableVersion(target) ?? target) : target.version;
}

export function officialInstallerWarnings(
  intent: "install" | "upgrade",
  target: SpicetifyRelease | string,
  provenance: OfficialProvenance,
): string[] {
  const version = targetVersionOf(target);
  const reviewed = provenance === "reviewed-digest";
  return [
    "The upstream installer script performs no integrity check of the Spicetify binary it downloads; this installer pins and verifies the script itself and then verifies the installed executable.",
    "The executed script is the pinned revision with its Marketplace prompt and download/evaluation branch removed by an exact reviewed patch. No Marketplace URL is present or contacted. If an existing Spicetify is detected, the upstream prompt still appears and defaults to Yes (run `spicetify update`): answer No to continue with this pinned install.",
    "Move-OldSpicetifyFolder may copy and then permanently delete `%USERPROFILE%\\spicetify-cli` (`~/spicetify-cli`) when that legacy folder exists.",
    "The script stages its download at the fixed path `%TEMP%\\spicetify.zip` and extracts with -Force; a concurrent installer or a pre-existing file at that path can collide.",
    "The script chooses its architecture from `%PROCESSOR_ARCHITECTURE`; the approved target is the exact Windows release asset for this host.",
    "The script is executed as a file (`&`) under the current execution policy. The installer never overrides or bypasses policy; if the policy blocks the script, nothing is installed and manual instructions are shown.",
    "The script runs as the current ordinary user. Administrator elevation is refused.",
    reviewed
      ? `Expected executable for v${version}: reviewed SHA-256 and size from the version-keyed ledger, Authenticode signer CN=SignPath Foundation.`
      : `No reviewed per-release executable digest exists for v${version}; verification uses Authenticode (Valid, CN=SignPath Foundation) and the exact reported version, not an artifact digest pin.`,
    "The upstream script does not run `spicetify backup` or `spicetify apply`; both remain separate, explicit steps.",
    `Executed script SHA-256 ${OFFICIAL_INSTALLER_PATCHED_SHA256} differs from the pinned original ${OFFICIAL_INSTALLER_SHA256} only by the reviewed Marketplace block removal.`,
  ];
}

/**
 * Map runtime/env architecture to the release-asset token via an explicit
 * allowlist only. Unknown values never silently fall back to x32.
 */
export function spicetifyArchToken(runtimeArch?: string | null, processorArchEnv?: string | null): string | null {
  const candidates = [processorArchEnv, runtimeArch]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .map((value) => value.trim());
  for (const candidate of candidates) {
    const token = releaseArchToken(candidate);
    if (token) return token;
  }
  return null;
}

function defaultHasConsole(): boolean {
  return Boolean(process.stdin?.isTTY && process.stdout?.isTTY);
}

function resolveNowValue(now: number | (() => number) | undefined): number {
  if (typeof now === "function") {
    try {
      const value = now();
      return Number.isFinite(value) ? value : Date.now();
    } catch {
      return Date.now();
    }
  }
  return typeof now === "number" && Number.isFinite(now) ? now : Date.now();
}

async function defaultIsElevated(runtime: Runtime, pwsh: string): Promise<boolean | null> {
  try {
    const result = await runtime.run(
      pwsh,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", ELEVATION_QUERY],
      { timeoutMs: OPERATION_TIMEOUTS.inspection },
    );
    if (result.code !== 0) return null;
    const text = `${result.stdout}\n${result.stderr}`.toLowerCase();
    if (text.includes("true")) return true;
    if (text.includes("false")) return false;
    return null;
  } catch {
    return null;
  }
}

async function defaultLanguageMode(runtime: Runtime, pwsh: string): Promise<string | null> {
  try {
    const result = await runtime.run(
      pwsh,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", LANGUAGE_MODE_QUERY],
      { timeoutMs: OPERATION_TIMEOUTS.inspection },
    );
    if (result.code !== 0) return null;
    const line = `${result.stdout}\n${result.stderr}`
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean)
      .pop();
    return line ?? null;
  } catch {
    return null;
  }
}

async function defaultReadUserPath(runtime: Runtime, pwsh: string): Promise<string | null> {
  try {
    const result = await runtime.run(
      pwsh,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", USER_PATH_QUERY],
      { timeoutMs: OPERATION_TIMEOUTS.inspection },
    );
    if (result.code !== 0) return null;
    return result.stdout.replace(/\r?\n$/, "");
  } catch {
    return null;
  }
}

async function defaultWriteUserPath(runtime: Runtime, pwsh: string, value: string): Promise<boolean> {
  try {
    const result = await runtime.run(
      pwsh,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", RESTORE_USER_PATH_QUERY],
      {
        timeoutMs: OPERATION_TIMEOUTS.inspection,
        env: { ...runtime.env, SPX_USER_PATH: value } as Record<string, string>,
      },
    );
    return result.code === 0;
  } catch {
    return false;
  }
}

function defaultHashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function defaultFileSize(path: string): number {
  return statSync(path).size;
}

/** Absolute taskkill path (never resolved through the CWD). */
async function defaultKillTree(pid: number | undefined): Promise<void> {
  if (!pid) return;
  if (process.platform !== "win32") {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Best effort only.
    }
    return;
  }
  await new Promise<void>((resolve) => {
    let settled = false;
    let child: ReturnType<typeof spawn> | null = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    // L12: never wait forever on taskkill. Escalate to killing the helper and
    // return; the caller reports an unconfirmed exit if close never arrives.
    const timer = setTimeout(() => {
      try { child?.kill(); } catch { /* already gone */ }
      finish();
    }, OFFICIAL_KILL_GRACE_MS);
    timer.unref?.();
    try {
      child = spawn(systemTool("taskkill.exe"), ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      finish();
      return;
    }
    child.once("close", finish);
    child.once("error", finish);
  });
}

/** Stage with exclusive creation in a fresh private directory. */
async function defaultStageScript(bytes: Uint8Array): Promise<StagedOfficialScript> {
  const dir = mkdtempSync(join(tmpdir(), "opencode-spicetify-official-"));
  const path = join(dir, "install.ps1");
  writeFileSync(path, bytes, { mode: 0o600, flag: "wx" });
  const sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
  return {
    path,
    sha256,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup only.
      }
    },
  };
}

function appendBounded(current: string, chunk: string): string {
  const combined = current + chunk;
  return combined.length <= TEE_BUFFER_LIMIT ? combined : combined.slice(combined.length - TEE_BUFFER_LIMIT);
}

/**
 * Run the patched installer with inherited stdin (console prompts) and a
 * teed stdout/stderr (bounded, diagnostics only). A timeout, signal or cancel
 * request causes exactly one taskkill /T /F; the close event is the only
 * confirmed-exit signal. Stdout text is never a success criterion.
 */
export function defaultRunInteractive(command: OfficialInteractiveCommand): Promise<OfficialInteractiveOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let killed = false;
    let killAttempts = 0;
    let stdout = "";
    let stderr = "";
    let child: ReturnType<typeof spawn> | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let forceTimer: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe: (() => void) | null = null;

    const finish = (code: number | null, exitConfirmed: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      if (unsubscribe) unsubscribe();
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
      resolve({
        code,
        stdout,
        stderr,
        timedOut,
        cancelled,
        ...(child?.pid ? { pid: child.pid } : {}),
        terminated: killed,
        exitConfirmed,
        killAttempts,
      });
    };

    const requestKill = () => {
      if (killed) return;
      killed = true;
      killAttempts += 1;
      void defaultKillTree(child?.pid).finally(() => {
        // The close event is the confirmation. If it never arrives, report an
        // unconfirmed exit so the caller does not roll back under a live tree.
        // A close observed while taskkill ran is final: no late kill/timer.
        if (settled) return;
        if (!forceTimer) forceTimer = setTimeout(() => finish(null, false), OFFICIAL_KILL_GRACE_MS);
      });
    };

    const onSignal = () => {
      if (cancelled) return;
      cancelled = true;
      requestKill();
    };

    try {
      child = spawn(command.file, command.args, {
        env: command.env,
        stdio: ["inherit", "pipe", "pipe"],
        windowsHide: false,
      });
    } catch (error) {
      resolve({
        code: null,
        stdout: "",
        stderr: String(error),
        timedOut: false,
        cancelled: false,
        terminated: true,
        exitConfirmed: true,
        killAttempts: 0,
      });
      return;
    }

    child.stdout?.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      stdout = appendBounded(stdout, text);
      try { process.stdout.write(chunk); } catch { /* diagnostics only */ }
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      stderr = appendBounded(stderr, text);
      try { process.stderr.write(chunk); } catch { /* diagnostics only */ }
    });

    unsubscribe = command.cancel?.onRequest(() => {
      if (cancelled) return;
      cancelled = true;
      requestKill();
    }) ?? null;

    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);

    child.once("error", () => finish(null, true));
    child.once("close", (code) => finish(code, true));

    timer = setTimeout(() => {
      timedOut = true;
      requestKill();
    }, Math.max(1, command.timeoutMs));
  });
}

interface ParsedSignature {
  status: string;
  subject: string;
  /** Exact certificate CN (X509NameType::SimpleName); never substring-matched. */
  simpleName: string;
}

/**
 * Extract the single JSON object emitted by the signature probe. Fail closed:
 * a missing Status *or* SimpleName is a parse failure, not an empty signer.
 */
function parseSignature(output: string): ParsedSignature | null {
  for (const line of output.split(/\r?\n/).reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const value = JSON.parse(trimmed) as { Status?: unknown; Subject?: unknown; SimpleName?: unknown };
      if (typeof value.Status !== "string") return null;
      if (typeof value.SimpleName !== "string") return null;
      return {
        status: value.Status,
        subject: typeof value.Subject === "string" ? value.Subject : "",
        simpleName: value.SimpleName,
      };
    } catch {
      return null;
    }
  }
  return null;
}

export interface OfficialVerifyOptions {
  /** Required. Strict stable semver; no default and no static fallback. */
  expectedVersion: string;
  /** Optional only when the version has a reviewed ledger entry. */
  expectedSha256?: string;
  expectedSize?: number;
  marketplaceBefore?: Record<string, boolean>;
  pwsh?: string;
  hashFile?: (path: string) => string;
  fileSize?: (path: string) => number;
  readUserPath?: (runtime: Runtime, pwsh: string) => Promise<string | null>;
}

/**
 * Post-install verification. Every check must pass before success is claimed.
 * A digest is enforced only for reviewed ledger versions; otherwise
 * provenance is explicitly Authenticode + exact version.
 */
export async function verifyOfficialSpicetify(
  runtime: Runtime,
  options: OfficialVerifyOptions,
): Promise<OfficialVerificationResult> {
  const warnings: string[] = [];
  const expectedVersion = parseStableVersion(options.expectedVersion);
  if (!expectedVersion) {
    return {
      ok: false,
      code: "E_NO_TARGET",
      error: `expected version ${JSON.stringify(options.expectedVersion ?? null)} is not a strict stable semver version`,
      warnings,
    };
  }

  const ledger = REVIEWED_SPICETIFY_RELEASES[expectedVersion] ?? null;
  if ((options.expectedSha256 !== undefined || options.expectedSize !== undefined) && !ledger) {
    return {
      ok: false,
      code: "E_NO_REVIEWED_DIGEST",
      error: `v${expectedVersion} has no reviewed ledger entry; a digest pin cannot be enforced or claimed`,
      warnings,
    };
  }
  if (ledger) {
    if (options.expectedSha256 !== undefined && options.expectedSha256.toLowerCase() !== ledger.sha256.toLowerCase()) {
      return { ok: false, code: "E_NO_REVIEWED_DIGEST", error: "the supplied digest does not match the reviewed ledger", warnings };
    }
    if (options.expectedSize !== undefined && options.expectedSize !== ledger.size) {
      return { ok: false, code: "E_NO_REVIEWED_DIGEST", error: "the supplied size does not match the reviewed ledger", warnings };
    }
  }
  const provenance: OfficialProvenance = ledger ? "reviewed-digest" : "authenticode+version";
  if (!ledger) {
    warnings.push(
      `No per-release artifact SHA-256 pin exists for v${expectedVersion}; authenticity is based on Authenticode and the exact reported version.`,
    );
  }

  const exe = officialSpicetifyExe(runtime);
  if (!runtime.isFile(exe)) {
    return { ok: false, code: "E_EXE_MISSING", error: `expected executable not found at ${exe}`, provenance, warnings };
  }

  if (ledger) {
    let size: number;
    try {
      size = (options.fileSize ?? defaultFileSize)(exe);
    } catch (error) {
      return {
        ok: false,
        code: "E_EXE_SIZE",
        error: `could not read the installed executable size: ${sanitizeDetail(error instanceof Error ? error.message : "unknown error")}`,
        provenance,
        warnings,
      };
    }
    if (size !== ledger.size) {
      return {
        ok: false,
        code: "E_EXE_SIZE",
        error: `installed executable is ${size} bytes; the reviewed v${expectedVersion} size is ${ledger.size}`,
        provenance,
        warnings,
      };
    }

    let sha: string;
    try {
      sha = (options.hashFile ?? defaultHashFile)(exe).toLowerCase();
    } catch (error) {
      return {
        ok: false,
        code: "E_PIN_MISMATCH",
        error: `could not hash the installed executable: ${sanitizeDetail(error instanceof Error ? error.message : "unknown error")}`,
        provenance,
        warnings,
      };
    }
    if (sha !== ledger.sha256.toLowerCase()) {
      return {
        ok: false,
        code: "E_PIN_MISMATCH",
        error: `installed executable SHA-256 ${sha} does not match the reviewed v${expectedVersion} digest ${ledger.sha256}`,
        provenance,
        warnings,
      };
    }
  }

  const pwsh = options.pwsh ?? (await runtime.which("pwsh").catch(() => undefined));
  if (!pwsh) {
    return { ok: false, code: "E_PWSH", error: "PowerShell 7 (pwsh) is required to verify the Authenticode signature", provenance, warnings };
  }

  let signatureProbe: CommandResult;
  try {
    signatureProbe = await runtime.run(
      pwsh,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", SIGNATURE_QUERY],
      {
        timeoutMs: OPERATION_TIMEOUTS.managerProbe,
        env: { ...runtime.env, SPX_EXE: exe } as Record<string, string>,
      },
    );
  } catch (error) {
    return {
      ok: false,
      code: "E_SIGNATURE",
      error: `could not run the Authenticode probe: ${sanitizeDetail(error instanceof Error ? error.message : "unknown error")}`,
      provenance,
      warnings,
    };
  }
  const signature = parseSignature(`${signatureProbe.stdout}\n${signatureProbe.stderr}`);
  if (signatureProbe.code !== 0 || !signature) {
    return {
      ok: false,
      code: "E_SIGNATURE",
      error: `could not read the Authenticode signature${signatureProbe.error ? `: ${signatureProbe.error}` : ""}`,
      provenance,
      warnings,
    };
  }
  if (signature.status.toLowerCase() !== "valid") {
    return { ok: false, code: "E_SIGNATURE", error: `Authenticode status is ${signature.status}; expected Valid`, provenance, warnings };
  }
  if (signature.simpleName !== SIGNPATH_SIGNER_SIMPLE_NAME) {
    return {
      ok: false,
      code: "E_SIGNATURE",
      error: `unexpected Authenticode signer CN ${JSON.stringify(signature.simpleName || null)} (subject ${JSON.stringify(signature.subject || null)}); expected exactly ${JSON.stringify(SIGNPATH_SIGNER_SIMPLE_NAME)}`,
      provenance,
      warnings,
    };
  }

  let versionProbe: CommandResult;
  try {
    versionProbe = await runtime.run(exe, ["-v"], { timeoutMs: OPERATION_TIMEOUTS.spicetifyInspect });
  } catch (error) {
    return {
      ok: false,
      code: "E_VERSION",
      error: `could not run spicetify -v: ${sanitizeDetail(error instanceof Error ? error.message : "unknown error")}`,
      provenance,
      warnings,
    };
  }
  const versionText = `${versionProbe.stdout}\n${versionProbe.stderr}`;
  const versionMatch = versionText.match(/v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/);
  const observed = versionMatch?.[1] ?? null;
  if (versionProbe.code !== 0 || !observed || parseStableVersion(observed) !== expectedVersion) {
    return {
      ok: false,
      code: "E_VERSION",
      error: `spicetify -v reported ${observed ?? "no version"} (exit ${versionProbe.code}); expected ${expectedVersion}`,
      provenance,
      warnings,
    };
  }
  if (!versionProbe.stdout.includes(expectedVersion) && versionProbe.stderr.includes(expectedVersion)) {
    warnings.push(`spicetify -v reported the version on stderr (not stdout); parsed ${observed}.`);
  }
  if (versionProbe.stderr.trim()) {
    warnings.push("spicetify -v wrote diagnostics to stderr; the version was parsed from combined output.");
  }

  const readUserPath = options.readUserPath ?? defaultReadUserPath;
  let userPath: string | null;
  try {
    userPath = await readUserPath(runtime, pwsh);
  } catch {
    userPath = null;
  }
  if (userPath === null) {
    return {
      ok: false,
      code: "E_PATH",
      error: "the user PATH could not be read; PATH persistence cannot be verified",
      provenance,
      warnings,
    };
  }
  {
    const wanted = normalizePathEntry(officialSpicetifyDir(runtime));
    const entries = userPath.split(";").map(normalizePathEntry).filter(Boolean);
    if (!entries.includes(wanted)) {
      return {
        ok: false,
        code: "E_PATH",
        error: `the user PATH does not contain ${officialSpicetifyDir(runtime)}`,
        provenance,
        warnings,
      };
    }
  }

  if (options.marketplaceBefore) {
    const after = snapshotMarketplace(runtime);
    const changed = marketplacePaths(runtime).filter(
      (path) => (options.marketplaceBefore as Record<string, boolean>)[path] !== after[path],
    );
    if (changed.length) {
      return {
        ok: false,
        code: "E_MARKETPLACE_CHANGED",
        error: `Marketplace directories changed unexpectedly: ${changed.join(", ")}`,
        provenance,
        warnings,
      };
    }
  }

  return { ok: true, version: observed, signer: signature.simpleName, provenance, warnings };
}

function ensureProcessPath(runtime: Runtime, dir: string): void {
  try {
    const current = typeof runtime.env.PATH === "string" ? runtime.env.PATH : "";
    const wanted = normalizePathEntry(dir);
    if (current.split(";").map(normalizePathEntry).filter(Boolean).includes(wanted)) return;
    const trimmed = current.replace(/;+$/, "");
    runtime.env.PATH = trimmed ? `${trimmed};${dir}` : dir;
  } catch {
    // Best effort: the direct executable probe above was authoritative.
  }
}

interface RollbackSnapshot {
  processPath: string | undefined;
  userPath: string | null;
  installDirExisted: boolean;
  marketplace: Record<string, boolean>;
}

async function readUserPathSnapshot(runtime: Runtime, pwsh: string, deps: OfficialInstallerDeps): Promise<string | null> {
  try {
    return await (deps.readUserPath ?? defaultReadUserPath)(runtime, pwsh);
  } catch {
    return null;
  }
}

async function rollbackAfterInterruption(
  runtime: Runtime,
  pwsh: string,
  snapshot: RollbackSnapshot,
  deps: OfficialInstallerDeps,
  onProgress?: (line: string) => void,
): Promise<{ userPathRestored: boolean; installDirRemoved: boolean }> {
  let restored = false;
  if (snapshot.userPath !== null) {
    try {
      restored = await (deps.writeUserPath ?? defaultWriteUserPath)(runtime, pwsh, snapshot.userPath);
    } catch {
      restored = false;
    }
  }
  try {
    runtime.env.PATH = snapshot.processPath as string | undefined;
  } catch {
    // Best effort.
  }
  let removed = false;
  if (!snapshot.installDirExisted) {
    try {
      runtime.remove(officialSpicetifyDir(runtime));
      removed = true;
    } catch {
      removed = false;
    }
  }
  onProgress?.(
    `Rollback after interruption: user PATH ${restored ? "restored" : "could not be restored"}; ` +
      `${removed ? "partial install directory removed" : "install directory left in place"}.`,
  );
  return { userPathRestored: restored, installDirRemoved: removed };
}

function safeFileSize(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

/** Exact paths left on disk after a failed/interrupted run (no secrets). */
export function describeInstallRemains(runtime: Runtime): string {
  const entries: string[] = [];
  const push = (label: string, path: string) => {
    try {
      const present = runtime.exists(path) || runtime.isFile(path);
      if (!present) return;
      const size = safeFileSize(path);
      entries.push(`${label}=${path}${size !== null ? ` (${size} bytes)` : ""}`);
    } catch {
      // A failed existence probe is not itself a remaining path.
    }
  };
  push("install-dir", officialSpicetifyDir(runtime));
  push("exe", officialSpicetifyExe(runtime));
  push("backup", officialBackupDir(runtime));
  for (const path of marketplacePaths(runtime)) push("marketplace", path);
  const unique = [...new Set(entries)];
  return unique.length
    ? `Remains: ${unique.join("; ")}.`
    : "Remains: no Spicetify install, backup, or Marketplace paths detected.";
}

function minimalChildEnv(runtime: Runtime): { ok: true; env: Record<string, string> } | { ok: false; missing: string[] } {
  const missing = REQUIRED_CHILD_ENV.filter((key) => {
    const value = runtime.env[key];
    return typeof value !== "string" || value.trim().length === 0;
  });
  if (missing.length) return { ok: false, missing: [...missing] };
  const env: Record<string, string> = {};
  for (const key of CHILD_ENV_WHITELIST) {
    const value = runtime.env[key];
    if (typeof value === "string" && value.length > 0) env[key] = value;
  }
  // Never inherit a module search path; pwsh uses its own default.
  delete env.PSModulePath;
  return { ok: true, env };
}

async function fetchOfficialScript(options: OfficialInstallerOptions): Promise<{
  bytes?: Uint8Array;
  error?: string;
  cancelled?: boolean;
}> {
  const fetcher = options.fetcher ?? fetch;
  const signals: AbortSignal[] = [AbortSignal.timeout(20_000)];
  if (options.cancel) signals.push(options.cancel.signal);
  try {
    const response = await fetcher(OFFICIAL_INSTALLER_URL, {
      headers: {
        "User-Agent": "opencode-spotify-installer",
        "Cache-Control": "no-cache",
      },
      redirect: "error",
      signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals),
    });
    if (isCancelled(options.cancel)) return { cancelled: true };
    if (!response.ok) {
      return { error: `HTTP ${response.status} from the pinned installer URL` };
    }
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_SCRIPT_BYTES) {
      return { error: `installer script exceeds the ${MAX_SCRIPT_BYTES}-byte cap` };
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > MAX_SCRIPT_BYTES) {
      return { error: `installer script exceeds the ${MAX_SCRIPT_BYTES}-byte cap` };
    }
    return { bytes };
  } catch (error) {
    if (isCancelled(options.cancel)) return { cancelled: true };
    return { error: error instanceof Error ? error.message : "installer download failed" };
  }
}

async function resolveTarget(
  runtime: Runtime,
  options: OfficialInstallerOptions,
  arch: string | null,
): Promise<ReleaseResolution> {
  const resolver = options.resolveRelease ?? resolveSpicetifyRelease;
  return resolver({
    offline: false,
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
    arch,
    requireWindowsAsset: true,
    now: () => resolveNowValue(undefined),
    ...(options.cancel ? { signal: options.cancel.signal } : {}),
  });
}

/** Bounded post-install detection; never throws. */
async function probeInstalled(runtime: Runtime): Promise<{ available: boolean; version: string | null } | null> {
  try {
    const path = await runtime.which("spicetify").catch(() => undefined);
    if (!path) return { available: false, version: null };
    const result = await runtime.run(path, ["-v"], { timeoutMs: OPERATION_TIMEOUTS.spicetifyInspect });
    const match = `${result.stdout}\n${result.stderr}`.match(/v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/);
    return { available: result.code === 0, version: match?.[1] ?? null };
  } catch {
    return null;
  }
}

/** Manager-owned upgrades use only the owner's manager. Never `spicetify update`. */
async function upgradeManagerOwned(
  runtime: Runtime,
  info: SpicetifyInfo,
  options: OfficialInstallerOptions,
): Promise<CommandResult> {
  const owner = info.owner;
  if (owner !== "winget" && owner !== "scoop" && owner !== "choco") {
    return failed("E_OWNER", `Manager upgrade only applies to winget/scoop/Chocolatey installations; this copy is ${owner}.`);
  }
  const spec = owner === "winget"
    ? {
        binary: "winget",
        args: ["upgrade", "--id", WINGET_ID, "-e", "--source", "winget", "--accept-package-agreements", "--accept-source-agreements"],
        source: `winget: ${WINGET_ID}`,
        guidance: `winget upgrade --id ${WINGET_ID} -e`,
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

  if (options.dryRun) {
    return { code: 0, stdout: `Would run: ${spec.binary} ${spec.args.join(" ")}`, stderr: "" };
  }
  const file = await runtime.which(spec.binary).catch(() => undefined);
  if (!file) {
    return failed(
      "E_MANAGER",
      `${spec.binary} was not found on PATH; update this ${owner}-owned Spicetify manually (${spec.guidance}) or reinstall it with ${owner}.`,
    );
  }
  if (!options.approve) {
    return failed("E_APPROVAL", "Spicetify upgrade requires explicit approval; no approval handler was provided.");
  }
  const command = `${file} ${spec.args.join(" ")}`;
  options.log?.out(`Spicetify upgrade: ${command}`);
  options.log?.out(`Source: ${spec.source}`);
  let approved = false;
  try {
    approved = await options.approve({
      method: owner,
      intent: "upgrade",
      command,
      source: spec.source,
      scriptUrl: "",
      scriptSha256: "",
      executedSha256: "",
      targetVersion: info.version ?? "",
      // L5: the manager owns the artifact and its provenance. No Authenticode
      // check and no resolved release target were performed for this copy.
      provenance: "manager",
      resolvedAt: resolveNowValue(undefined),
      patch: "none",
      interactive: false,
      warnings: [
        "Manager-owned installation: its own upgrade command is used; the portable official installer is never overlaid.",
      ],
    });
  } catch {
    approved = false;
  }
  if (!approved) return failed("E_APPROVAL", "Spicetify upgrade declined.");
  return runtime.run(file, spec.args, {
    timeoutMs: OPERATION_TIMEOUTS.packageInstall,
    ...(options.cancel ? { cancel: options.cancel } : {}),
  });
}

async function runOfficialFlow(
  runtime: Runtime,
  info: SpicetifyInfo,
  options: OfficialInstallerOptions,
  intent: "install" | "upgrade",
): Promise<CommandResult> {
  const progress = options.onProgress ?? (() => {});
  const arch = options.arch === undefined
    ? spicetifyArchToken(runtime.arch, runtime.env.PROCESSOR_ARCHITECTURE as string | undefined)
    : spicetifyArchToken(options.arch);

  if (options.dryRun) {
    const version = options.release?.version ? `v${options.release.version}` : "latest stable (resolved at run time, never a static version)";
    return {
      code: 0,
      stdout: `Would run: pwsh -NoLogo -NoProfile -Command "$v=<resolved-target>; <held-handle SHA-256 re-check>; & $env:SPX_SCRIPT" (target ${version}; official installer ${OFFICIAL_INSTALLER_URL}, original SHA-256 ${OFFICIAL_INSTALLER_SHA256}; reviewed executed SHA-256 ${OFFICIAL_INSTALLER_PATCHED_SHA256})`,
      stderr: "",
    };
  }
  if (options.offline) {
    return failed(
      "E_OFFLINE",
      `Offline mode: the latest stable Spicetify release cannot be resolved and the pinned installer cannot be downloaded or verified. ${manualHint()}`,
    );
  }
  if (options.nonInteractive === true || options.interactive === false) {
    return failed(
      "E_NONINTERACTIVE",
      "The official installer is interactive and requires a console. Re-run interactively, or install manually with the pinned instructions.",
    );
  }

  // E27: the script reads prompt keys from the console host after flushing
  // queued input. Piped answers cannot work, so require a real console unless
  // a test runner is injected (or an explicit probe is supplied).
  const consoleAvailable = options.hasConsole
    ? options.hasConsole()
    : options.runInteractive
      ? true
      : defaultHasConsole();
  if (!consoleAvailable) {
    return failed(
      "E_NO_CONSOLE",
      "The official installer needs an interactive console for its prompts. Run setup from a normal terminal window (not a redirected/headless process), or install manually with the pinned instructions.",
    );
  }
  if (!options.approve) {
    return failed("E_APPROVAL", "The official installer requires explicit approval; no approval handler was provided.");
  }

  // Refuse before approval when the script could install somewhere or for an
  // architecture other than the one that was approved.
  const childEnv = minimalChildEnv(runtime);
  if (!childEnv.ok) {
    return failed(
      "E_ENV",
      `The installer child environment is missing ${childEnv.missing.join(", ")}; installation is refused before approval.`,
    );
  }

  const pwsh = await runtime.which("pwsh").catch(() => undefined);
  if (!pwsh) {
    return failed("E_PWSH", `PowerShell 7 (pwsh) is required to run the official installer. ${manualHint()}`);
  }

  const elevated = await (options.isElevated ?? defaultIsElevated)(runtime, pwsh);
  if (elevated !== false) {
    return failed(
      "E_ELEVATED",
      elevated === true
        ? "Refusing to run the official installer from an elevated process. Run setup as your ordinary user; the script is never run as administrator."
        : "Could not confirm that this process is running as an ordinary user; refusing rather than risk the elevated prompt path. Run setup from a normal, non-administrator terminal.",
    );
  }

  // Exact FullLanguage is required. This is a language mode, not an execution
  // policy override: the script file itself is still subject to policy.
  const language = await (options.languageMode ?? defaultLanguageMode)(runtime, pwsh);
  if (language === null) {
    return failed(
      "E_LANGUAGE_MODE",
      `PowerShell language mode could not be determined; exact FullLanguage is required. ${manualHint()}`,
    );
  }
  if (language.trim().toLowerCase() !== "fulllanguage") {
    return failed(
      "E_LANGUAGE_MODE",
      `PowerShell is in ${sanitizeDetail(language)}; exact FullLanguage is required for the official installer. ${manualHint()}`,
    );
  }

  if (isCancelled(options.cancel)) return cancelledResult("The operation was cancelled before release resolution; nothing was installed.");

  // Resolve once, immediately before approval. A pre-resolved release from the
  // wizard is used as-is so the approved target is exactly what is installed.
  let release = options.release;
  let resolutionError: ReleaseResolution | null = null;
  if (!release) {
    const resolved = await resolveTarget(runtime, options, arch);
    if (isCancelled(options.cancel)) return cancelledResult("The operation was cancelled during release resolution; nothing was installed.");
    if (!resolved.ok) {
      resolutionError = resolved;
    } else {
      release = resolved.release;
    }
  }
  if (!release) {
    const error = resolutionError && !resolutionError.ok ? resolutionError : null;
    return failed(
      error?.code ?? "E_RELEASE_LOOKUP",
      `${error?.error ?? "the latest stable Spicetify release could not be resolved"} ${manualHint()}`,
    );
  }

  const version = parseStableVersion(release.version);
  if (!version) {
    return failed("E_RELEASE_INVALID", `resolved release ${JSON.stringify(release.version)} is not a strict stable version. ${manualHint()}`);
  }
  if (compareVersions(version, MIN_SPICETIFY) === -1) {
    return failed("E_RELEASE_UNSUPPORTED", `resolved release v${version} is older than the supported minimum ${MIN_SPICETIFY}.`);
  }
  const asset = spicetifyReleaseAsset(release, arch);
  if (!asset) {
    return failed(
      "E_RELEASE_ASSET",
      `release v${version} has no Windows asset for ${arch ?? "this host"}. ${manualHint()}`,
    );
  }
  if (!/^https:\/\/github\.com\/spicetify\/cli\/releases\/download\//.test(asset.url)) {
    return failed("E_RELEASE_ASSET", `the ${asset.name} asset URL is not an upstream GitHub release URL.`);
  }

  const provenance: OfficialProvenance = REVIEWED_SPICETIFY_RELEASES[version]
    ? "reviewed-digest"
    : "authenticode+version";
  const resolvedAt = release.fetchedAt;

  const approval: OfficialInstallerApproval = {
    method: "official-installer",
    intent,
    command: describeOfficialCommand(version),
    source: `spicetify/cli@${OFFICIAL_INSTALLER_COMMIT.slice(0, 12)}:install.ps1 (pinned revision; Marketplace block removed)`,
    scriptUrl: OFFICIAL_INSTALLER_URL,
    scriptSha256: OFFICIAL_INSTALLER_SHA256,
    executedSha256: OFFICIAL_INSTALLER_PATCHED_SHA256,
    targetVersion: version,
    provenance,
    resolvedAt,
    patch: "marketplace-removed",
    interactive: true,
    warnings: officialInstallerWarnings(intent, release, provenance),
  };
  options.log?.out(`Spicetify ${intent}: ${approval.command}`);
  options.log?.out(`Source: ${approval.source}`);
  options.log?.out(`Target: v${version} (resolved from GitHub latest stable at ${new Date(resolvedAt).toISOString()}).`);
  options.log?.out(`Installer URL: ${approval.scriptUrl}`);
  options.log?.out(`Installer original SHA-256: ${approval.scriptSha256}`);
  options.log?.out(`Installer executed SHA-256: ${approval.executedSha256}`);
  for (const warning of approval.warnings) options.log?.out(`Warning: ${warning}`);

  let approved = false;
  try {
    approved = await options.approve(approval);
  } catch {
    approved = false;
  }
  if (!approved) {
    return failed("E_APPROVAL", "Spicetify installation via the official installer was declined.");
  }
  if (isCancelled(options.cancel)) return cancelledResult("The operation was cancelled after approval; nothing was installed.");

  progress(`Downloading the pinned official installer script (${OFFICIAL_INSTALLER_COMMIT.slice(0, 12)}).`);
  let bytes = options.scriptBytes;
  if (!bytes) {
    const downloaded = await fetchOfficialScript(options);
    if (downloaded.cancelled) return cancelledResult("The operation was cancelled while downloading the installer script; nothing was installed.");
    if (!downloaded.bytes) {
      return failed("E_DOWNLOAD", `${sanitizeDetail(downloaded.error ?? "installer download failed")}; refusing to run anything. ${manualHint()}`);
    }
    bytes = downloaded.bytes;
  }
  progress(`Verifying installer bytes (${OFFICIAL_INSTALLER_BYTES} bytes, ASCII, SHA-256 ${OFFICIAL_INSTALLER_SHA256}).`);
  const checked = verifyOfficialInstallerScript(bytes);
  if (!checked.ok) {
    return failed(checked.code ?? "E_PIN_MISMATCH", `${checked.error ?? "installer script pin mismatch"}; refusing to execute it. ${manualHint()}`);
  }

  progress("Applying the reviewed Marketplace-removal patch and verifying the executed digest.");
  const patched = (options.patchScript ?? patchOfficialInstallerScript)(bytes);
  if (!patched.ok) {
    return failed(patched.code, `${patched.error}; no script was staged or executed. ${manualHint()}`);
  }
  const patchedHash = createHash("sha256").update(patched.bytes).digest("hex");
  if (patchedHash !== OFFICIAL_INSTALLER_PATCHED_SHA256 || patched.sha256 !== OFFICIAL_INSTALLER_PATCHED_SHA256) {
    return failed(
      "E_PATCH_MISMATCH",
      `the patched script digest ${patchedHash} does not match the reviewed ${OFFICIAL_INSTALLER_PATCHED_SHA256}; nothing was staged. ${manualHint()}`,
    );
  }
  if (isCancelled(options.cancel)) return cancelledResult("The operation was cancelled before staging; nothing was installed.");

  const stage = options.stageScript ?? defaultStageScript;
  let staged: StagedOfficialScript;
  try {
    staged = await stage(patched.bytes);
  } catch (error) {
    return failed("E_STAGE", `could not stage the verified installer script: ${sanitizeDetail(error instanceof Error ? error.message : "unknown error")}`);
  }
  let stagedHash = staged.sha256;
  if (!stagedHash) {
    try {
      stagedHash = createHash("sha256").update(readFileSync(staged.path)).digest("hex");
    } catch (error) {
      staged.cleanup();
      return failed("E_STAGE", `could not re-hash the staged installer script: ${sanitizeDetail(error instanceof Error ? error.message : "unknown error")}`);
    }
  }
  if (stagedHash !== OFFICIAL_INSTALLER_PATCHED_SHA256) {
    staged.cleanup();
    return failed("E_PATCH_MISMATCH", "the staged bytes do not match the reviewed executed digest; nothing was executed.");
  }

  const snapshot: RollbackSnapshot = {
    processPath: typeof runtime.env.PATH === "string" ? runtime.env.PATH : undefined,
    userPath: await readUserPathSnapshot(runtime, pwsh, options),
    installDirExisted: (() => {
      try {
        return runtime.exists(officialSpicetifyDir(runtime));
      } catch {
        return true;
      }
    })(),
    marketplace: snapshotMarketplace(runtime),
  };

  const command: OfficialInteractiveCommand = {
    file: pwsh,
    args: ["-NoLogo", "-NoProfile", "-Command", buildOfficialWrapperCommand(version)],
    timeoutMs: options.timeoutMs ?? OFFICIAL_TIMEOUT_MS,
    env: {
      ...childEnv.env,
      SPX_SCRIPT: staged.path,
      // Bind the runtime re-check to the hash of the bytes actually staged and
      // verified above, not to an independently typed constant.
      SPX_SCRIPT_SHA256: stagedHash,
    },
    ...(options.cancel ? { cancel: options.cancel } : {}),
  };

  let outcome: OfficialInteractiveOutcome | null = null;
  let runError: unknown = null;
  try {
    progress("Starting the patched official installer in the console. Answer its prompts directly; this wrapper cannot pre-answer them.");
    // A cancellation that arrived during staging/approval must not spawn.
    if (options.cancel?.requested) return cancelledResult("Cancelled before the installer started.");
    if (options.beforeInteractive) await options.beforeInteractive();
    try {
      outcome = await (options.runInteractive ?? defaultRunInteractive)(command);
    } finally {
      if (options.afterInteractive) {
        try {
          await options.afterInteractive();
        } catch {
          // Resuming the UI must never mask the installer result.
        }
      }
    }
  } catch (error) {
    runError = error;
  }

  if (runError) {
    staged.cleanup();
    return failed(
      "E_SCRIPT_FAILED",
      `could not start the official installer: ${sanitizeDetail(runError instanceof Error ? runError.message : "unknown error")}. ${describeInstallRemains(runtime)}`,
    );
  }
  if (!outcome) {
    staged.cleanup();
    return failed("E_SCRIPT_FAILED", "the official installer produced no result. Success is not claimed.");
  }

  const remains = () => describeInstallRemains(runtime);
  const combined = `${outcome.stdout ?? ""}\n${outcome.stderr ?? ""}`;
  const confirmed = outcome.exitConfirmed !== false;
  const wasCancelled = outcome.cancelled === true || isCancelled(options.cancel);
  const wasTimedOut = outcome.timedOut === true && !wasCancelled;
  const interruptedDetail = (text: string): CommandResult =>
    wasCancelled ? cancelledResult(text) : failed("E_TIMEOUT", text);

  if (wasCancelled || wasTimedOut) {
    // L7: a confirmed close is final. Kill only when no close was observed and
    // the runner has not already killed the tree; one attempt at most.
    let killedNow = false;
    if (!confirmed && outcome.terminated !== true) {
      killedNow = true;
      try {
        await (options.killTree ?? defaultKillTree)(outcome.pid);
      } catch {
        // Failure to kill is reported through the unconfirmed-exit path.
      }
    }
    if (!confirmed) {
      return interruptedDetail(
        `The official installer ${wasCancelled ? "was cancelled" : "timed out"}, but its process-tree exit could not be confirmed; rollback was not attempted and the staged script was left in place. ${remains()}`,
      );
    }
    const rollback = await rollbackAfterInterruption(runtime, pwsh, snapshot, options, progress)
      .catch(() => ({ userPathRestored: false, installDirRemoved: false }));
    staged.cleanup();
    const termination = outcome.terminated === true || killedNow
      ? "its process tree was terminated (once)"
      : "its process exited on its own (no forced kill)";
    return interruptedDetail(
      `The official installer ${wasCancelled ? "was cancelled" : "timed out"}; ${termination}. ` +
        `Rollback: user PATH ${rollback.userPathRestored ? "restored" : "NOT restored"}; ` +
        `install directory ${rollback.installDirRemoved ? "removed" : "left in place"}. ${remains()}`,
    );
  }

  // Cleanup only after a confirmed exit.
  staged.cleanup();

  if (outcome.code !== 0) {
    if (outcome.code === 90 || /E_PIN_MISMATCH/i.test(combined)) {
      return failed("E_PIN_MISMATCH", "The in-PowerShell SHA-256 re-check failed; the installer script was not executed.");
    }
    if (outcome.code === 92) {
      return failed(
        "E_POLICY_BLOCKED",
        `PowerShell execution policy blocked the patched installer script; no policy override or bypass was attempted and nothing was installed. ${manualHint()}`,
      );
    }
    const tail = lastLines(combined);
    const exception = outcome.code === 91 ? "The installer script raised an exception" : `The official installer exited with code ${outcome.code ?? "unknown"}`;
    return failed(
      "E_SCRIPT_FAILED",
      `${exception}.${tail ? ` Last output: ${tail}` : ""} ${remains()}`,
    );
  }

  // Exit 0 is not success: an upstream early `exit` also returns 0. Only the
  // post-install verification below may claim success. A cancel observed here
  // stops before verification: nothing is verified or claimed after a cancel.
  if (isCancelled(options.cancel)) {
    return cancelledResult(`The operation was cancelled after the installer returned; verification did not run and success is not claimed. ${remains()}`);
  }
  progress("Installer returned; verifying executable signature, exact version, user PATH and Marketplace state.");
  const verification = await verifyOfficialSpicetify(runtime, {
    expectedVersion: version,
    marketplaceBefore: snapshot.marketplace,
    pwsh,
    ...(options.hashFile ? { hashFile: options.hashFile } : {}),
    ...(options.fileSize ? { fileSize: options.fileSize } : {}),
    ...(options.readUserPath ? { readUserPath: options.readUserPath } : {}),
  });
  if (isCancelled(options.cancel)) {
    return cancelledResult(`The operation was cancelled after the installer returned; success is not claimed. ${remains()}`);
  }
  if (!verification.ok) {
    return failed(
      verification.code ?? "E_VERIFY",
      `${verification.error ?? "post-install verification failed"}; success is not claimed. ${remains()}`,
    );
  }

  // Best-effort post-check. A newer stable release does not invalidate the
  // approved target; it is reported without retroactively calling it latest.
  let newer: string | null = null;
  try {
    const postCheck = await (options.resolveRelease ?? resolveSpicetifyRelease)({
      offline: false,
      ...(options.fetcher ? { fetcher: options.fetcher } : {}),
      arch,
      requireWindowsAsset: false,
      now: () => resolveNowValue(undefined),
      ...(options.cancel ? { signal: options.cancel.signal } : {}),
    });
    if (postCheck.ok && compareVersions(postCheck.release.version, version) === 1) {
      newer = postCheck.release.version;
    }
  } catch {
    newer = null;
  }
  if (isCancelled(options.cancel)) {
    return cancelledResult(`The operation was cancelled during the post-install release check; success is not claimed. ${remains()}`);
  }

  ensureProcessPath(runtime, officialSpicetifyDir(runtime));
  let detected: { available: boolean; version: string | null } | null = null;
  try {
    detected = await (options.inspectInstalled ?? probeInstalled)(runtime);
  } catch {
    detected = null;
  }
  for (const warning of verification.warnings) options.log?.out(`Note: ${warning}`);

  const summary = [
    `Spicetify ${verification.version ?? version} ${intent === "install" ? "installed" : "upgraded"} via the pinned official installer script (Marketplace block removed) and verified.`,
    `Release target: v${version}, resolved from GitHub latest stable at ${new Date(resolvedAt).toISOString()}.`,
    `Installer script: revision ${OFFICIAL_INSTALLER_COMMIT.slice(0, 12)}, original SHA-256 ${OFFICIAL_INSTALLER_SHA256}, executed SHA-256 ${OFFICIAL_INSTALLER_PATCHED_SHA256}.`,
    `Installed executable: ${officialSpicetifyExe(runtime)}; Authenticode Valid (${verification.signer ?? SIGNPATH_SIGNER_SIMPLE_NAME}); spicetify -v reports ${verification.version ?? version}.`,
    verification.provenance === "reviewed-digest"
      ? `Artifact provenance: SHA-256 matches the reviewed digest for v${version}.`
      : `Artifact provenance: no per-release SHA-256 pin for v${version}; authenticity is Authenticode + version only.`,
    `User PATH: ${officialSpicetifyDir(runtime)}.`,
    "Marketplace directories: unchanged.",
  ];
  if (newer) {
    summary.push(`Installed v${version}, which was the approved latest when resolved; v${newer} is now available (it is not this install).`);
  }
  if (!detected?.available) {
    summary.push("Detection after install did not resolve the CLI yet; a new terminal may be required for PATH changes.");
  }
  for (const warning of verification.warnings) summary.push(`Note: ${warning}`);
  return { code: 0, stdout: summary.join("\n"), stderr: "" };
}

/**
 * Fresh install only. Existing installs (any owner) are refused: manager-owned
 * copies must be upgraded by their manager, and an official-script copy must
 * use upgradeSpicetify. Dry-run never performs network or approval work.
 */
export async function installSpicetify(
  runtime: Runtime,
  info: SpicetifyInfo,
  options: OfficialInstallerOptions = {},
): Promise<CommandResult> {
  if (info.available) {
    if (info.owner === "winget" || info.owner === "scoop" || info.owner === "choco") {
      const guidance = info.owner === "winget"
        ? `winget upgrade --id ${WINGET_ID} -e`
        : info.owner === "scoop"
          ? "scoop update spicetify"
          : "choco upgrade spicetify -y";
      return failed(
        "E_OWNER",
        `Spicetify is already installed by ${info.owner} at ${info.path ?? "unknown path"}. It will not be overlaid; update it with its manager instead (${guidance}).`,
      );
    }
    if (info.owner === "script") {
      return failed(
        "E_OWNER",
        `Spicetify is already installed at ${info.path ?? "unknown path"}. Fresh installation only runs when Spicetify is absent; use upgrade instead.`,
      );
    }
    return failed(
      "E_OWNER",
      `Spicetify at ${info.path ?? "unknown path"} has an unknown owner. Refusing to overlay it; uninstall it deliberately or update it with the tool that installed it.`,
    );
  }
  return runOfficialFlow(runtime, info, options, "install");
}

/**
 * Owner-aware upgrade:
 *   * script-owned -> dynamic latest stable via the pinned official installer
 *     (never `spicetify update`, never a static target, never a downgrade),
 *   * winget/scoop/choco -> that manager's existing upgrade command,
 *   * unknown -> refused.
 * Dry-run and approval rules are always preserved.
 */
export async function upgradeSpicetify(
  runtime: Runtime,
  info: SpicetifyInfo,
  options: OfficialUpgradeOptions = {},
): Promise<CommandResult> {
  if (!info.available || !info.path) {
    return failed("E_OWNER", "Spicetify is not installed; run setup to install it first.");
  }
  if (info.owner === "unknown") {
    return failed(
      "E_OWNER",
      `Unknown Spicetify install owner at ${info.path}. Refusing to upgrade; use the tool that installed it or reinstall deliberately.`,
    );
  }
  if (info.owner === "winget" || info.owner === "scoop" || info.owner === "choco") {
    return upgradeManagerOwned(runtime, info, options);
  }

  const installed = parseStableVersion(info.version);
  if (!installed) {
    return failed(
      "E_VERSION_UNKNOWN",
      `Installed Spicetify version ${JSON.stringify(info.version ?? null)} cannot be parsed; refusing an upgrade that could be a downgrade.`,
    );
  }
  if (options.dryRun) {
    const target = options.release?.version ?? "latest stable (resolved at run time)";
    return {
      code: 0,
      stdout: `Would upgrade Spicetify ${installed} to ${target} via the pinned official installer (Marketplace block removed).`,
      stderr: "",
    };
  }

  let release = options.release;
  if (!release) {
    if (options.offline) {
      return failed("E_OFFLINE", `Offline mode: the latest stable Spicetify release cannot be resolved. ${manualHint()}`);
    }
    const arch = options.arch === undefined
      ? spicetifyArchToken(runtime.arch, runtime.env.PROCESSOR_ARCHITECTURE as string | undefined)
      : spicetifyArchToken(options.arch);
    const resolved = await resolveTarget(runtime, options, arch);
    if (isCancelled(options.cancel)) return cancelledResult("The operation was cancelled during release resolution.");
    if (!resolved.ok) {
      return failed(resolved.code, `${resolved.error} ${manualHint()}`);
    }
    release = resolved.release;
  }

  const target = parseStableVersion(release.version);
  if (!target) {
    return failed("E_RELEASE_INVALID", `resolved release ${JSON.stringify(release.version)} is not a strict stable version.`);
  }
  if (compareVersions(target, MIN_SPICETIFY) === -1) {
    return failed("E_RELEASE_UNSUPPORTED", `resolved release v${target} is older than the supported minimum ${MIN_SPICETIFY}.`);
  }
  const compared = compareVersions(installed, target);
  if (compared === 1) {
    return failed(
      "E_DOWNGRADE",
      `Installed Spicetify ${installed} is newer than the latest stable release v${target}; downgrades are never automatic.`,
    );
  }
  if (compared === 0) {
    return {
      code: 0,
      stdout: `Spicetify ${installed} is already at the latest stable release v${target}.`,
      stderr: "",
    };
  }

  return runOfficialFlow(runtime, info, { ...options, release }, "upgrade");
}

export { OFFICIAL_INSTALLER_DOCS_URL as OFFICIAL_DOCS_URL, SPICETIFY_RELEASES_URL };
