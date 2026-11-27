// Deterministic Marketplace installer (official-only engine companion).
//
// Spicetify's official installer no longer installs Marketplace (reviewed
// patch removes the prompt/download branch). This module installs Marketplace
// deterministically right after the official flow:
//   * inspectMarketplace is read-only (zero side effects),
//   * resolveMarketplaceRelease discovers the latest Marketplace .zip from
//     GitHub with bounded timeout + size cap,
//   * installMarketplace downloads the verified zip to a private temp dir,
//     rejects traversal entries, extracts via PowerShell (no Invoke-Expression),
//     handles flat and single-nested layouts, copies to
//     %APPDATA%\\spicetify\\CustomApps\\marketplace and registers via
//     `spicetify config` commands.
// On any error the temp dir is removed and a sanitized { status: "failed" }
// is returned so callers warn without failing core setup.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SPICETIFY_MARKETPLACE_REPO } from "./compat.ts";
import { OPERATION_TIMEOUTS, sanitizeDetail } from "./runtime.ts";
import type { CancelToken } from "./cancel.ts";
import type { Runtime, SpicetifyInfo } from "./types.ts";

export const MARKETPLACE_RELEASES_URL =
  `https://api.github.com/repos/${SPICETIFY_MARKETPLACE_REPO}/releases/latest`;
export const MARKETPLACE_ASSET_PREFIX =
  `https://github.com/${SPICETIFY_MARKETPLACE_REPO}/releases/download/`;
export const MARKETPLACE_CUSTOM_APP_DIR = "marketplace";

const METADATA_TIMEOUT_MS = 12_000;
const METADATA_MAX_BYTES = 512 * 1024;
const ZIP_TIMEOUT_MS = 60_000;
const ZIP_MAX_BYTES = 64 * 1024 * 1024;

function appDataDir(runtime: Runtime): string {
  return runtime.env.APPDATA || join(runtime.homedir, "AppData", "Roaming");
}

export function marketplaceDir(runtime: Runtime): string {
  return join(appDataDir(runtime), "spicetify", "CustomApps", MARKETPLACE_CUSTOM_APP_DIR);
}

function defaultConfigPath(runtime: Runtime, spicetify?: Pick<SpicetifyInfo, "configPath"> | null): string {
  if (spicetify?.configPath) return spicetify.configPath;
  return join(appDataDir(runtime), "spicetify", "config-xpui.ini");
}

export interface MarketplaceInspection {
  installed: boolean;
  registered: boolean;
  dir: string;
  configPath: string | null;
}

/**
 * Read-only Marketplace detection. Zero side effects: only exists/isFile/
 * readText probes. Installed means index.js + manifest.json are present;
 * registered means custom_apps lists marketplace in config-xpui.ini.
 */
export function inspectMarketplace(
  runtime: Runtime,
  spicetify?: Pick<SpicetifyInfo, "configPath"> | null,
): MarketplaceInspection {
  const dir = marketplaceDir(runtime);
  const indexJs = join(dir, "index.js");
  const manifest = join(dir, "manifest.json");
  let installed = false;
  try {
    const indexOk = runtime.exists(indexJs) && runtime.isFile(indexJs);
    const manifestOk = runtime.exists(manifest) && runtime.isFile(manifest);
    installed = indexOk && manifestOk;
  } catch {
    installed = false;
  }
  const configPath = defaultConfigPath(runtime, spicetify);
  let registered = false;
  try {
    let present = false;
    try {
      present = runtime.exists(configPath);
    } catch {
      present = false;
    }
    if (present) {
      const text = runtime.readText(configPath);
      registered = hasMarketplaceRegistration(text);
    }
  } catch {
    registered = false;
  }
  return { installed, registered, dir, configPath };
}

function hasMarketplaceRegistration(configText: string): boolean {
  const lines = configText.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || /^\s*[;#]/.test(line)) continue;
    const match = line.match(/^\s*custom_apps\s*=(.*)$/i);
    if (!match) continue;
    const value = match[1] ?? "";
    const tokens = value.split(/[|,;]/).flatMap((part) => part.split(/\s+/)).map((t) => t.trim()).filter(Boolean);
    if (tokens.some((token) => token.toLowerCase() === MARKETPLACE_CUSTOM_APP_DIR.toLowerCase())) return true;
  }
  return false;
}

export interface MarketplaceRelease {
  version: string;
  tag: string;
  assetName: string;
  assetUrl: string;
  size: number | null;
  releaseId: number | null;
  publishedAt: string | null;
  fetchedAt: number;
}

export type MarketplaceResolutionErrorCode =
  | "E_OFFLINE"
  | "E_RELEASE_LOOKUP"
  | "E_RATE_LIMIT"
  | "E_RELEASE_INVALID"
  | "E_RELEASE_PRERELEASE"
  | "E_RELEASE_ASSET";

export type MarketplaceResolution =
  | { ok: true; release: MarketplaceRelease }
  | { ok: false; code: MarketplaceResolutionErrorCode; error: string; retryAfter?: number };

export interface ResolveMarketplaceOptions {
  offline?: boolean;
  fetcher?: typeof fetch;
  now?: number | (() => number);
  signal?: AbortSignal;
  cancel?: CancelToken;
}

function resolveNowValue(now: ResolveMarketplaceOptions["now"]): number {
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

function rateLimitDetails(response: Response, nowMs: number): { limited: boolean; retryAfter?: number } {
  const remaining = response.headers.get("x-ratelimit-remaining");
  const limited = response.status === 429 || remaining === "0";
  if (!limited) return { limited: false };
  const retryAfterHeader = response.headers.get("retry-after");
  if (retryAfterHeader) {
    const seconds = Number(retryAfterHeader);
    if (Number.isFinite(seconds) && seconds >= 0) return { limited: true, retryAfter: Math.ceil(seconds) };
    const at = Date.parse(retryAfterHeader);
    if (Number.isFinite(at)) return { limited: true, retryAfter: Math.max(0, Math.ceil((at - nowMs) / 1000)) };
  }
  const reset = Number(response.headers.get("x-ratelimit-reset"));
  if (Number.isFinite(reset) && reset > 0) {
    return { limited: true, retryAfter: Math.max(0, Math.ceil(reset - nowMs / 1000)) };
  }
  return { limited: true };
}

/**
 * Resolve the latest Marketplace release. Bounded timeout + size cap;
 * honors offline and cancellation; validates a .zip asset whose
 * browser_download_url starts with the Marketplace releases prefix.
 */
export async function resolveMarketplaceRelease(
  options: ResolveMarketplaceOptions = {},
): Promise<MarketplaceResolution> {
  if (options.offline) {
    return {
      ok: false,
      code: "E_OFFLINE",
      error: "Offline mode: the latest Marketplace release was not looked up; no install target exists.",
    };
  }
  if (options.cancel?.requested) {
    return { ok: false, code: "E_RELEASE_LOOKUP", error: "Cancelled before Marketplace release resolution." };
  }
  const nowMs = resolveNowValue(options.now);
  const fetcher = options.fetcher ?? fetch;
  const signals: AbortSignal[] = [AbortSignal.timeout(METADATA_TIMEOUT_MS)];
  if (options.signal) signals.push(options.signal);
  if (options.cancel) signals.push(options.cancel.signal);
  let response: Response;
  try {
    response = await fetcher(MARKETPLACE_RELEASES_URL, {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "opencode-spotify-installer",
        "Cache-Control": "no-cache",
      },
      redirect: "error",
      signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals),
    });
  } catch (error) {
    if (options.cancel?.requested) {
      return { ok: false, code: "E_RELEASE_LOOKUP", error: "Cancelled during Marketplace release resolution." };
    }
    const detail = error instanceof Error && error.message ? error.message : "release lookup failed";
    return { ok: false, code: "E_RELEASE_LOOKUP", error: `Marketplace release metadata could not be retrieved: ${detail.slice(0, 200)}` };
  }
  if (!response.ok) {
    const limit = rateLimitDetails(response, nowMs);
    if (limit.limited) {
      return {
        ok: false,
        code: "E_RATE_LIMIT",
        error: `GitHub rate limit reached (HTTP ${response.status})${limit.retryAfter !== undefined ? `; retry after ${limit.retryAfter}s` : ""}. No Marketplace target is available.`,
        ...(limit.retryAfter !== undefined ? { retryAfter: limit.retryAfter } : {}),
      };
    }
    if (response.status === 404) {
      return { ok: false, code: "E_RELEASE_LOOKUP", error: "GitHub reports no published Marketplace release (HTTP 404). No target is available." };
    }
    return { ok: false, code: "E_RELEASE_LOOKUP", error: `Marketplace release metadata unavailable (HTTP ${response.status}). No target is available.` };
  }
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > METADATA_MAX_BYTES) {
    return { ok: false, code: "E_RELEASE_INVALID", error: "Marketplace release metadata is larger than the accepted 512 KiB cap" };
  }
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    const detail = error instanceof Error && error.message ? error.message : "body read failed";
    return { ok: false, code: "E_RELEASE_LOOKUP", error: `Marketplace release metadata could not be read: ${detail.slice(0, 200)}` };
  }
  if (Buffer.byteLength(text, "utf8") > METADATA_MAX_BYTES) {
    return { ok: false, code: "E_RELEASE_INVALID", error: "Marketplace release metadata is larger than the accepted 512 KiB cap" };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return { ok: false, code: "E_RELEASE_INVALID", error: "Marketplace release metadata is not valid JSON" };
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, code: "E_RELEASE_INVALID", error: "Marketplace release metadata is not a JSON object" };
  }
  const record = payload as Record<string, unknown>;
  if (record.draft === true) {
    return { ok: false, code: "E_RELEASE_INVALID", error: "GitHub returned a draft Marketplace release; drafts are never install targets" };
  }
  if (record.prerelease === true) {
    return { ok: false, code: "E_RELEASE_PRERELEASE", error: "GitHub returned a prerelease Marketplace release; only published stable releases are install targets." };
  }
  const rawTag = typeof record.tag_name === "string" ? record.tag_name.trim() : "";
  if (!rawTag) {
    return { ok: false, code: "E_RELEASE_INVALID", error: "Marketplace release tag is missing or empty" };
  }
  const version = rawTag.replace(/^v/i, "").trim();
  if (!version || /\s/.test(version)) {
    return { ok: false, code: "E_RELEASE_INVALID", error: `Marketplace release tag ${JSON.stringify(rawTag)} is not a usable version` };
  }
  if (!Array.isArray(record.assets) || record.assets.length === 0) {
    return { ok: false, code: "E_RELEASE_ASSET", error: "Marketplace release metadata has no assets" };
  }
  let chosen: { name: string; url: string; size: number | null } | null = null;
  for (const entry of record.assets) {
    if (!entry || typeof entry !== "object") {
      return { ok: false, code: "E_RELEASE_ASSET", error: "Marketplace release metadata contains an invalid asset entry" };
    }
    const asset = entry as Record<string, unknown>;
    const name = typeof asset.name === "string" ? asset.name.trim() : "";
    if (!name) {
      return { ok: false, code: "E_RELEASE_ASSET", error: "Marketplace release metadata contains an asset without a name" };
    }
    const browser = typeof asset.browser_download_url === "string" ? asset.browser_download_url : null;
    const legacy = typeof asset.url === "string" && (asset.url as string).startsWith(MARKETPLACE_ASSET_PREFIX)
      ? (asset.url as string)
      : null;
    const download = browser ?? legacy;
    const isZip = name.toLowerCase().endsWith(".zip");
    if (isZip) {
      if (!download || !download.startsWith(MARKETPLACE_ASSET_PREFIX)) {
        return { ok: false, code: "E_RELEASE_ASSET", error: `Marketplace asset ${name} has an invalid or non-GitHub URL` };
      }
      if (!chosen) {
        const size = typeof asset.size === "number" && Number.isFinite(asset.size) && asset.size >= 0 ? asset.size : null;
        chosen = { name, url: download, size };
      }
      continue;
    }
    // Non-zip assets are ignored unless they carry a Marketplace download URL
    // outside the expected prefix (fail closed on spoofed hosts).
    if (download && !download.startsWith(MARKETPLACE_ASSET_PREFIX) && /marketplace/i.test(name)) {
      return { ok: false, code: "E_RELEASE_ASSET", error: `Marketplace asset ${name} has an invalid or non-GitHub URL` };
    }
  }
  if (!chosen) {
    return { ok: false, code: "E_RELEASE_ASSET", error: "Marketplace release has no .zip asset with a verified GitHub download URL" };
  }
  return {
    ok: true,
    release: {
      version,
      tag: rawTag,
      assetName: chosen.name,
      assetUrl: chosen.url,
      size: chosen.size,
      releaseId: typeof record.id === "number" && Number.isFinite(record.id) ? record.id : null,
      publishedAt: typeof record.published_at === "string" ? record.published_at : null,
      fetchedAt: nowMs,
    },
  };
}

export type MarketplaceInstallStatus =
  | { status: "already-installed" }
  | { status: "dry-run" }
  | { status: "skipped-offline"; guidance: string }
  | { status: "installed" }
  | { status: "failed"; error: string };

export interface MarketplaceInstallOptions {
  dryRun?: boolean;
  offline?: boolean;
  cancel?: CancelToken;
  /** Test/provisioning seams; never required in production. */
  fetcher?: typeof fetch;
  release?: MarketplaceRelease;
  zipBytes?: Uint8Array;
  pwsh?: string;
  resolveRelease?: (options: ResolveMarketplaceOptions) => Promise<MarketplaceResolution>;
  extractZip?: (zipPath: string, destDir: string) => Promise<void>;
}

function sanitizeMarketplaceError(value: unknown): string {
  const raw = value instanceof Error ? value.message : typeof value === "string" ? value : "Marketplace install failed";
  let safe = sanitizeDetail(raw);
  try {
    safe = safe.replace(/C:\\Users\\[^\\;\s"]+/gi, "C:\\Users\\<user>");
  } catch {
    // Keep the sanitized detail as-is.
  }
  return safe || "Marketplace install failed without a reason.";
}

function offlineGuidance(runtime: Runtime): string {
  const dir = marketplaceDir(runtime);
  return [
    "Offline mode: Marketplace was not installed.",
    `Manually download the latest Marketplace .zip from https://github.com/${SPICETIFY_MARKETPLACE_REPO}/releases/latest,`,
    `extract the folder containing manifest.json and index.js to ${dir},`,
    "then run `spicetify config custom_apps marketplace` and `spicetify config inject_css 1 replace_colors 1 overwrite_assets 1` followed by `spicetify apply`.",
  ].join(" ");
}

/** Minimal ZIP central-directory listing for traversal validation (no deps). */
export function listZipEntryNames(bytes: Uint8Array): string[] | null {
  try {
    if (bytes.length < 22) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const EOCD_SIG = 0x06054b50;
    const CD_SIG = 0x02014b50;
    let eocd = -1;
    const scanStart = Math.max(0, bytes.length - 66_000);
    for (let i = bytes.length - 22; i >= scanStart; i--) {
      if (view.getUint32(i, true) === EOCD_SIG) {
        eocd = i;
        break;
      }
    }
    if (eocd === -1) return listZipLocalNames(bytes);
    const count = view.getUint16(eocd + 10, true);
    let offset = view.getUint32(eocd + 16, true);
    if (count === 0) return [];
    if (offset >= bytes.length) return null;
    const names: string[] = [];
    for (let n = 0; n < count; n++) {
      if (offset + 46 > bytes.length) return null;
      if (view.getUint32(offset, true) !== CD_SIG) return null;
      const nameLen = view.getUint16(offset + 28, true);
      const extraLen = view.getUint16(offset + 30, true);
      const commentLen = view.getUint16(offset + 32, true);
      const start = offset + 46;
      const end = start + nameLen;
      if (end > bytes.length) return null;
      names.push(Buffer.from(bytes.subarray(start, end)).toString("utf8"));
      offset = end + extraLen + commentLen;
    }
    return names;
  } catch {
    return null;
  }
}

function listZipLocalNames(bytes: Uint8Array): string[] | null {
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const LOCAL_SIG = 0x04034b50;
    const names: string[] = [];
    let offset = 0;
    let guard = 0;
    while (offset + 30 <= bytes.length && guard < 10_000) {
      guard += 1;
      if (view.getUint32(offset, true) !== LOCAL_SIG) break;
      const nameLen = view.getUint16(offset + 26, true);
      const extraLen = view.getUint16(offset + 28, true);
      const compSize = view.getUint32(offset + 18, true);
      const start = offset + 30;
      const end = start + nameLen;
      if (end > bytes.length) return null;
      names.push(Buffer.from(bytes.subarray(start, end)).toString("utf8"));
      offset = end + extraLen + compSize;
      if (offset <= start) return null;
    }
    return names.length ? names : null;
  } catch {
    return null;
  }
}

function isTraversalEntry(name: string): boolean {
  const normalized = name.replace(/\\/g, "/");
  if (!normalized) return false;
  if (normalized.startsWith("/")) return true;
  if (/^[A-Za-z]:/.test(normalized)) return true;
  if (normalized.startsWith("\\\\")) return true;
  const segments = normalized.split("/");
  if (segments.includes("..")) return true;
  return false;
}

function defaultExtractScript(): string {
  return [
    "$zip=$env:SPX_MP_ZIP",
    "$dest=$env:SPX_MP_DEST",
    "if([string]::IsNullOrWhiteSpace($zip)){Write-Output 'E_ZIP_PATH'; exit 90}",
    "if([string]::IsNullOrWhiteSpace($dest)){Write-Output 'E_DEST_PATH'; exit 90}",
    "New-Item -ItemType Directory -Force -Path $dest | Out-Null",
    "Expand-Archive -LiteralPath $zip -DestinationPath $dest -Force",
    "exit 0",
  ].join("\n");
}

/**
 * Install Marketplace deterministically. Idempotent, offline-aware,
 * cancellation-aware and soft-failing: any error cleans the temp dir and
 * returns { status: "failed", error } so callers warn without failing core
 * setup. Dry-run performs zero network/disk writes.
 */
export async function installMarketplace(
  runtime: Runtime,
  spicetify: Pick<SpicetifyInfo, "path" | "configPath"> | null | undefined,
  options: MarketplaceInstallOptions = {},
): Promise<MarketplaceInstallStatus> {
  const inspected = inspectMarketplace(runtime, spicetify);
  if (inspected.installed && inspected.registered) {
    return { status: "already-installed" };
  }
  if (options.cancel?.requested) {
    return { status: "failed", error: "Cancelled by the user." };
  }
  if (options.dryRun) {
    return { status: "dry-run" };
  }
  if (options.offline) {
    return { status: "skipped-offline", guidance: offlineGuidance(runtime) };
  }

  let tempRoot: string | null = null;
  const cleanup = (): void => {
    if (!tempRoot) return;
    try {
      rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup only.
    }
    tempRoot = null;
  };

  try {
    if (options.cancel?.requested) return { status: "failed", error: "Cancelled by the user." };
    let release = options.release;
    if (!release) {
      const resolver = options.resolveRelease ?? resolveMarketplaceRelease;
      const resolved = await resolver({
        ...(options.fetcher ? { fetcher: options.fetcher } : {}),
        ...(options.cancel ? { cancel: options.cancel, signal: options.cancel.signal } : {}),
      });
      if (options.cancel?.requested) return { status: "failed", error: "Cancelled by the user." };
      if (!resolved.ok) {
        return { status: "failed", error: sanitizeMarketplaceError(`${resolved.code}: ${resolved.error}`) };
      }
      release = resolved.release;
    }
    if (!release.assetUrl.startsWith(MARKETPLACE_ASSET_PREFIX) || !release.assetName.toLowerCase().endsWith(".zip")) {
      return { status: "failed", error: sanitizeMarketplaceError("E_RELEASE_ASSET: the Marketplace asset URL is not a verified GitHub release URL.") };
    }

    let spicetifyExe = spicetify?.path ?? null;
    if (!spicetifyExe) {
      try {
        spicetifyExe = (await runtime.which("spicetify").catch(() => undefined)) ?? null;
      } catch {
        spicetifyExe = null;
      }
    }
    if (!spicetifyExe) {
      return { status: "failed", error: sanitizeMarketplaceError("E_SPICETIFY: Spicetify is not available; Marketplace registration was skipped.") };
    }

    let zipBytes = options.zipBytes;
    if (!zipBytes) {
      const fetcher = options.fetcher ?? fetch;
      const signals: AbortSignal[] = [AbortSignal.timeout(ZIP_TIMEOUT_MS)];
      if (options.cancel) signals.push(options.cancel.signal);
      let response: Response;
      try {
        response = await fetcher(release.assetUrl, {
          headers: { "User-Agent": "opencode-spotify-installer", "Cache-Control": "no-cache" },
          redirect: "error",
          signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals),
        });
      } catch (error) {
        if (options.cancel?.requested) return { status: "failed", error: "Cancelled by the user." };
        return { status: "failed", error: sanitizeMarketplaceError(error instanceof Error ? error.message : "Marketplace download failed") };
      }
      if (options.cancel?.requested) return { status: "failed", error: "Cancelled by the user." };
      if (!response.ok) {
        return { status: "failed", error: sanitizeMarketplaceError(`E_DOWNLOAD: Marketplace download failed with HTTP ${response.status}.`) };
      }
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > ZIP_MAX_BYTES) {
        return { status: "failed", error: sanitizeMarketplaceError("E_DOWNLOAD: Marketplace asset exceeds the size cap.") };
      }
      let buffer: Uint8Array;
      try {
        buffer = new Uint8Array(await response.arrayBuffer());
      } catch (error) {
        return { status: "failed", error: sanitizeMarketplaceError(error instanceof Error ? error.message : "Marketplace download could not be read") };
      }
      if (buffer.length === 0 || buffer.length > ZIP_MAX_BYTES) {
        return { status: "failed", error: sanitizeMarketplaceError("E_DOWNLOAD: Marketplace asset is empty or exceeds the size cap.") };
      }
      zipBytes = buffer;
    }
    if (options.cancel?.requested) return { status: "failed", error: "Cancelled by the user." };

    const entryNames = listZipEntryNames(zipBytes);
    if (!entryNames) {
      return { status: "failed", error: sanitizeMarketplaceError("E_ZIP: Marketplace asset is not a readable zip archive.") };
    }
    for (const name of entryNames) {
      if (isTraversalEntry(name)) {
        return { status: "failed", error: sanitizeMarketplaceError(`E_TRAVERSAL: Marketplace zip entry is unsafe: ${name.slice(0, 120)}`) };
      }
    }

    tempRoot = mkdtempSync(join(tmpdir(), "opencode-marketplace-"));
    const zipPath = join(tempRoot, "marketplace.zip");
    const extractDir = join(tempRoot, "extracted");
    try {
      writeFileSync(zipPath, zipBytes, { mode: 0o600, flag: "wx" });
    } catch (error) {
      return { status: "failed", error: sanitizeMarketplaceError(error instanceof Error ? error.message : "Could not stage the Marketplace download") };
    }
    try {
      mkdirSync(extractDir, { recursive: true });
    } catch (error) {
      return { status: "failed", error: sanitizeMarketplaceError(error instanceof Error ? error.message : "Could not create the Marketplace extract directory") };
    }
    if (options.cancel?.requested) return { status: "failed", error: "Cancelled by the user." };

    if (options.extractZip) {
      try {
        await options.extractZip(zipPath, extractDir);
      } catch (error) {
        return { status: "failed", error: sanitizeMarketplaceError(error instanceof Error ? error.message : "Marketplace extraction failed") };
      }
    } else {
      const pwsh = options.pwsh ?? (await runtime.which("pwsh").catch(() => undefined));
      if (!pwsh) {
        return { status: "failed", error: sanitizeMarketplaceError("E_PWSH: PowerShell 7 (pwsh) is required to extract Marketplace.") };
      }
      if (options.cancel?.requested) return { status: "failed", error: "Cancelled by the user." };
      let extracted: { code: number; stdout: string; stderr: string; cancelled?: boolean; error?: string };
      try {
        extracted = await runtime.run(
          pwsh,
          ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", defaultExtractScript()],
          {
            timeoutMs: OPERATION_TIMEOUTS.packageInstall,
            env: { ...runtime.env, SPX_MP_ZIP: zipPath, SPX_MP_DEST: extractDir } as Record<string, string>,
            ...(options.cancel ? { cancel: options.cancel } : {}),
          },
        );
      } catch (error) {
        return { status: "failed", error: sanitizeMarketplaceError(error instanceof Error ? error.message : "Marketplace extraction could not start") };
      }
      if (extracted.cancelled || options.cancel?.requested) return { status: "failed", error: "Cancelled by the user." };
      if (extracted.code !== 0) {
        return { status: "failed", error: sanitizeMarketplaceError(`E_EXTRACT: Marketplace extraction failed (exit ${extracted.code}).`) };
      }
    }
    if (options.cancel?.requested) return { status: "failed", error: "Cancelled by the user." };

    const hasBoth = (dir: string): boolean => {
      try {
        return existsSync(join(dir, "manifest.json")) && existsSync(join(dir, "index.js"));
      } catch {
        return false;
      }
    };
    let sourceRoot: string | null = null;
    try {
      if (hasBoth(extractDir)) {
        sourceRoot = extractDir;
      } else {
        const entries = readdirSync(extractDir);
        const dirs = entries.filter((entry) => {
          try {
            return statSync(join(extractDir, entry)).isDirectory();
          } catch {
            return false;
          }
        });
        for (const dir of dirs) {
          if (hasBoth(join(extractDir, dir))) {
            sourceRoot = join(extractDir, dir);
            break;
          }
        }
      }
    } catch (error) {
      return { status: "failed", error: sanitizeMarketplaceError(error instanceof Error ? error.message : "Marketplace layout could not be inspected") };
    }
    if (!sourceRoot) {
      return { status: "failed", error: sanitizeMarketplaceError("E_LAYOUT: Marketplace archive does not contain manifest.json and index.js.") };
    }

    const destDir = marketplaceDir(runtime);
    try {
      copyTree(sourceRoot, destDir);
    } catch (error) {
      return { status: "failed", error: sanitizeMarketplaceError(error instanceof Error ? error.message : "Marketplace copy failed") };
    }
    // Keep the node:fs import referenced for the real-FS copy path above.
    if (options.cancel?.requested) return { status: "failed", error: "Cancelled by the user." };

    const configTimeout = OPERATION_TIMEOUTS.spicetifyInspect;
    let first: { code: number; cancelled?: boolean; error?: string };
    try {
      first = await runtime.run(spicetifyExe, ["config", "custom_apps", "marketplace"], {
        timeoutMs: configTimeout,
        ...(options.cancel ? { cancel: options.cancel } : {}),
      });
    } catch (error) {
      return { status: "failed", error: sanitizeMarketplaceError(error instanceof Error ? error.message : "Marketplace registration could not start") };
    }
    if (first.cancelled || options.cancel?.requested) return { status: "failed", error: "Cancelled by the user." };
    if (first.code !== 0) {
      return { status: "failed", error: sanitizeMarketplaceError(`E_REGISTER: spicetify config custom_apps marketplace failed (exit ${first.code}).`) };
    }
    let second: { code: number; cancelled?: boolean; error?: string };
    try {
      second = await runtime.run(
        spicetifyExe,
        ["config", "inject_css", "1", "replace_colors", "1", "overwrite_assets", "1"],
        {
          timeoutMs: configTimeout,
          ...(options.cancel ? { cancel: options.cancel } : {}),
        },
      );
    } catch (error) {
      return { status: "failed", error: sanitizeMarketplaceError(error instanceof Error ? error.message : "Marketplace css registration could not start") };
    }
    if (second.cancelled || options.cancel?.requested) return { status: "failed", error: "Cancelled by the user." };
    if (second.code !== 0) {
      return { status: "failed", error: sanitizeMarketplaceError(`E_REGISTER: spicetify config inject_css failed (exit ${second.code}).`) };
    }

    return { status: "installed" };
  } finally {
    cleanup();
  }
}

function copyTree(source: string, dest: string): void {
  // Real-FS recursive copy for the staged Marketplace payload. The temp
  // source is always real; the destination is the canonical
  // %APPDATA%\spicetify\CustomApps\marketplace path.
  mkdirSync(dest, { recursive: true });
  const entries = readdirSync(source);
  for (const entry of entries) {
    const from = join(source, entry);
    const to = join(dest, entry);
    let isDir = false;
    try {
      isDir = statSync(from).isDirectory();
    } catch {
      throw new Error(`Cannot read Marketplace payload entry: ${entry}`);
    }
    if (isDir) {
      copyTree(from, to);
    } else {
      try {
        copyFileSync(from, to);
      } catch {
        throw new Error(`Cannot copy Marketplace payload entry: ${entry}`);
      }
    }
  }
}
