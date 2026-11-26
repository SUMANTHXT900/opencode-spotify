import { join } from "node:path"
import { OperationCancelled } from "./cancel.ts"
import { detectEnvironment } from "./detect.ts"
import { addGlobalPlugin, projectPlugins, reconcileRegistration, removeGlobalPlugin } from "./opencode.ts"
import { bridgeOperation } from "./bridge.ts"
import {
  compareVersions,
  isAtLeast,
  MIN_OPENCODE,
  OFFICIAL_INSTALLER_BYTES,
  OFFICIAL_INSTALLER_COMMIT,
  OFFICIAL_INSTALLER_SHA256,
  REVIEWED_SPICETIFY_RELEASES,
} from "./compat.ts"
import { installSpicetify } from "./spicetify-official.ts"
import type { OfficialInstallerDeps, OfficialInstallerOptions } from "./spicetify-official.ts"
import type { SpicetifyRelease } from "./spicetify-release.ts"
import {
  officialInstallPlan,
  renderPlanPreview,
  renderPostManualInstructions,
  renderSelectionScreen,
  runInstallWizard,
  selectInstallMethod,
} from "./ui/install-wizard.ts"
import type { InstallWizardInput, OfficialInstallerPin } from "./ui/install-wizard.ts"
import { describePluginUpdate, updateAvailability } from "./update-plan.ts"
import { cancelAwareRuntime, executePlan, isSpotifyPluginId, maybeApplyBridge, planExitCode } from "./plan.ts"
import type { PlanOutcome } from "./plan.ts"
import { runRepair } from "./repair.ts"
import { runUninstall } from "./uninstall.ts"
import { OPERATION_TIMEOUTS, sanitizeDetail } from "./runtime.ts"
import { runStatus } from "./status.ts"
import { runUpdate } from "./update.ts"
import type {
  CommandResult,
  Detection,
  OperationContext,
  PlanStep,
  Runtime,
  SpicetifyInfo,
} from "./types.ts"

const OPENCODE_URL = "https://opencode.ai/docs"
const SPOTIFY_URL = "https://www.spotify.com/download/windows/"
const SPICETIFY_DOCS = "https://spicetify.app/docs/getting-started"
/** Published release page used whenever no concrete target can be resolved. */
export const SPICETIFY_RELEASES_PAGE = "https://github.com/spicetify/cli/releases"

/** Short display form of the pinned official installer revision. */
export const SPICETIFY_INSTALL_REVISION = OFFICIAL_INSTALLER_COMMIT.slice(0, 7)
/** Commit-pinned official installer URL (never the mutable main branch). */
export const SPICETIFY_INSTALL_URL = `https://raw.githubusercontent.com/spicetify/cli/${OFFICIAL_INSTALLER_COMMIT}/install.ps1`

/**
 * A release target resolved by the caller (for example F1's release lookup).
 * Declared structurally so setup never depends on a concrete resolver module.
 */
export interface SpicetifyReleaseTarget {
  version?: string | null
  tagName?: string | null
  /** Raw tag on a resolved release (accepts an upstream release object). */
  tag?: string | null
  assetName?: string | null
  assetUrl?: string | null
  digest?: string | null
  /** Structural mirror of a resolved release's asset list (no import needed). */
  assets?: ReadonlyArray<{ name?: string | null; url?: string | null; digest?: string | null }> | null
}

const OFFICIAL_PIN_BASE_EFFECTS: readonly string[] = [
  "Downloads the resolved stable Spicetify CLI release asset for this Windows architecture.",
  "Installs the CLI under %LOCALAPPDATA%\\spicetify and adds that directory to the user PATH.",
  "Removes the Marketplace step from the staged script before it runs.",
]

/** Verification claim is conditional: a digest exists only for reviewed entries. */
const OFFICIAL_PIN_DIGEST_EFFECT =
  "Verifies the installed executable's size and SHA-256 against the reviewed x64 ledger entry, plus its Authenticode signer, exact version, and user PATH before reporting success."
const OFFICIAL_PIN_NO_DIGEST_EFFECT =
  "Verifies the installed executable with an Authenticode signature check (Valid, CN=SignPath Foundation), the exact reported version, and the user PATH before reporting success; provenance is Authenticode + exact version only, with no per-release artifact digest pin."

const OFFICIAL_PIN_NOT_EFFECTS: readonly string[] = [
  "Does not install, launch, restart, or modify Spotify Desktop.",
  "Does not run `spicetify apply`, install themes or extensions, or change Spotify state.",
  "Does not touch OpenCode configuration, the plugin registration, or the bridge extension.",
  "Does not read, create, or rotate bridge credentials.",
  "Does not require administrator rights or edit the system-wide PATH.",
  "Does not install or upgrade through winget, Scoop, or Chocolatey.",
  "The Marketplace installation step is removed from the staged script before execution, so it is never offered or executed; no Marketplace prompt is pre-answered.",
  "Runs the staged, hash-verified script under your current PowerShell execution policy with no override; if policy blocks it, setup falls back to the manual instructions.",
  "Does not execute unpinned content from the mutable main branch.",
  "Move-OldSpicetifyFolder may copy and then permanently delete `%USERPROFILE%\\spicetify-cli` (`~/spicetify-cli`) if that legacy folder exists.",
  "The upstream script stages its download at the fixed path `%TEMP%\\spicetify.zip` and extracts with -Force; a concurrent or pre-existing file at that path can collide.",
]

/** Shown while an existing install could still be detected by the upstream script. */
export const EXISTING_INSTALL_PROMPT_WARNING =
  "If an existing Spicetify installation is present, the upstream script's prompt about it defaults to Yes, which would run `spicetify update`; answer No so the existing copy is left in place."

const ARCH_SCOPE_WARNING =
  "Reviewed per-release executable digests are x64-only; on other architectures provenance is Authenticode + exact version only."

export interface SpicetifyPinOptions {
  /**
   * Host architecture token. When it is not x64, a ledger entry is never
   * claimed as an installed-digest verification.
   */
  arch?: "x64" | "arm64" | "x32" | null
}

/**
 * Wizard pin built from the resolved target. `targetVersion` is display-only;
 * unknown metadata renders the release page, never a fabricated version.
 * Verification wording follows the reviewed ledger: only a reviewed x64
 * release actually verifies the installed binary's size and SHA-256.
 */
export function spicetifyOfficialPin(
  targetVersion: string | null,
  existingInstall = false,
  options: SpicetifyPinOptions = {},
): OfficialInstallerPin {
  const reviewed = targetVersion ? REVIEWED_SPICETIFY_RELEASES[targetVersion] !== undefined : false
  const digestVerified = reviewed && (options.arch === undefined || options.arch === null || options.arch === "x64")
  const nots = [...OFFICIAL_PIN_NOT_EFFECTS]
  if (!digestVerified) nots.push(ARCH_SCOPE_WARNING)
  // The upstream existing-install prompt cannot be ruled out before preflight,
  // so callers pass this while an existing copy is still possible.
  if (existingInstall) nots.push(EXISTING_INSTALL_PROMPT_WARNING)
  return {
    method: "official-installer",
    revision: SPICETIFY_INSTALL_REVISION,
    sha256: OFFICIAL_INSTALLER_SHA256,
    sizeBytes: OFFICIAL_INSTALLER_BYTES,
    targetVersion: targetVersion ? `v${targetVersion}` : "latest stable release",
    url: SPICETIFY_INSTALL_URL,
    effects: [...OFFICIAL_PIN_BASE_EFFECTS, digestVerified ? OFFICIAL_PIN_DIGEST_EFFECT : OFFICIAL_PIN_NO_DIGEST_EFFECT],
    nots,
  }
}

/** Pin template for callers that display the installer without a resolved release. */
export const SPICETIFY_OFFICIAL_PIN: OfficialInstallerPin = spicetifyOfficialPin(null)

/**
 * Fixed, input-free PowerShell probe for the official-installer preflight.
 * Reports the shell version, language mode, elevation state and disk space.
 */
export const SPICETIFY_PREFLIGHT_QUERY = [
  "$ErrorActionPreference = 'Stop'",
  "'PSVERSION=' + $PSVersionTable.PSVersion.ToString()",
  "'LANGUAGEMODE=' + $ExecutionContext.SessionState.LanguageMode",
  "$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())",
  "'ELEVATED=' + $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
  "try { $root = [IO.Path]::GetPathRoot($env:LOCALAPPDATA); $drive = Get-PSDrive -Name $root.Substring(0, 1); 'DRIVE=' + $root.Substring(0, 1); 'FREEMB=' + [Math]::Round($drive.Free / 1MB) } catch { 'DRIVE=unknown'; 'FREEMB=unknown' }",
].join("; ")

/** A strict stable version (no prerelease/build suffix), or null. */
export function stableVersion(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim()
  return /^\d+\.\d+\.\d+$/.test(trimmed) ? trimmed : null
}

function releaseVersion(release?: SpicetifyReleaseTarget | null): string | null {
  const raw = release?.version ?? release?.tagName ?? release?.tag ?? null
  if (!raw) return null
  return stableVersion(String(raw).trim().replace(/^v/i, ""))
}

/**
 * The install/update target setup may talk about: an explicitly resolved
 * release first, then the strictly stable `latest` from the registry lookup.
 * A prerelease or missing tag yields null (never an invented version).
 */
export function resolvedSpicetifyTarget(
  latest: string | null | undefined,
  release?: SpicetifyReleaseTarget | null,
): SpicetifyReleaseTarget | null {
  const version = releaseVersion(release) ?? stableVersion(latest)
  if (!version) return null
  const assetName = release?.assetName?.trim() || null
  const assetUrl = release?.assetUrl?.trim() || null
  const digest = release?.digest?.trim() || null
  const assets = release?.assets?.length ? release.assets : null
  return {
    version,
    ...(assetName ? { assetName } : {}),
    ...(assetUrl ? { assetUrl } : {}),
    ...(digest ? { digest } : {}),
    ...(assets ? { assets } : {}),
  }
}

/**
 * Owner-aware achievable target. A script-owned copy is only updated to a
 * strictly stable release resolved by setup; manager-owned copies keep their
 * registry-resolved strict stable tag; an unknown owner has no safe target at
 * all (never an invented version).
 */
export function achievableSpicetifyTarget(
  owner: SpicetifyInfo["owner"],
  latest: string | null | undefined,
): string | null {
  if (owner === "unknown") return null
  return stableVersion(latest)
}

export function manualSpicetifyInstructions(ui: OperationContext["ui"], details?: string | null): void {
  ui.line("  Install Spicetify manually, then re-run setup:")
  ui.line(`   - Official docs: ${SPICETIFY_DOCS}`)
  ui.line(`   - Pinned official installer (revision ${SPICETIFY_INSTALL_REVISION}):`)
  ui.line(`     ${SPICETIFY_INSTALL_URL}`)
  ui.line(`     SHA-256: ${OFFICIAL_INSTALLER_SHA256} (${OFFICIAL_INSTALLER_BYTES} bytes)`)
  const extra = (details ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  for (const line of extra) ui.line(`   - ${line}`)
  if (!extra.length) {
    ui.line(`   - Target version: not resolved; choose the current stable release at ${SPICETIFY_RELEASES_PAGE}`)
  }
  ui.line("  Only the revision- and hash-pinned script is used; the mutable main-branch installer is never executed.")
}

function refresh(ctx: OperationContext, next: Detection): void {
  ctx.detection = next
}

async function retryPrerequisite(
  ctx: OperationContext,
  present: (detection: Detection) => boolean,
  label: string,
): Promise<boolean> {
  if (ctx.options.nonInteractive) return false
  while (true) {
    const action = await ctx.prompt.choose(`Still waiting for ${label}.`, [
      { label: "Recheck now", value: "recheck" },
      { label: "Exit setup", value: "exit" },
    ])
    if (!action || action === "exit" || ctx.cancel.requested) return false
    refresh(ctx, await detectEnvironment(ctx.runtime))
    if (present(ctx.detection)) return true
    ctx.ui.warn(`${label} was not detected.`)
  }
}

function localAppDataDir(runtime: Runtime): string {
  return runtime.env.LOCALAPPDATA || join(runtime.homedir, "AppData", "Local")
}

/** Display-only architecture token used to name the release asset. */
function officialArchToken(runtime: Runtime): "x64" | "arm64" | "x32" | null {
  const candidates = [
    typeof runtime.env.PROCESSOR_ARCHITECTURE === "string" ? runtime.env.PROCESSOR_ARCHITECTURE : null,
    runtime.arch,
  ]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .map((value) => value.trim().toLowerCase())
  for (const candidate of candidates) {
    if (candidate === "x64" || candidate === "amd64" || candidate === "x86_64") return "x64"
    if (candidate === "arm64" || candidate === "aarch64") return "arm64"
    if (candidate === "x32" || candidate === "ia32" || candidate === "x86" || candidate === "386") return "x32"
  }
  return null
}

/**
 * Display details for the resolved target. When the release is unknown the
 * releases page is shown and no version is claimed.
 */
function targetDetails(runtime: Runtime, target: SpicetifyReleaseTarget | null): string {
  if (!target?.version) {
    return [
      `Target version: not resolved (no stable release metadata available)`,
      `Releases: ${SPICETIFY_RELEASES_PAGE}`,
    ].join("\n")
  }
  const arch = officialArchToken(runtime)
  const wanted = arch ? `spicetify-${target.version}-windows-${arch}.zip` : null
  const listed = target.assets?.find((asset) => !!wanted && asset.name === wanted) ?? null
  const name = target.assetName ?? listed?.name?.trim() ?? wanted
  const url = target.assetUrl ?? listed?.url?.trim() ??
    (arch && name ? `https://github.com/spicetify/cli/releases/download/v${target.version}/${name}` : null)
  const digest = target.digest ?? listed?.digest?.trim() ?? null
  const lines = [`Target version: v${target.version}`]
  if (name) lines.push(`Target asset: ${name}`)
  if (url) lines.push(`Asset URL: ${url}`)
  if (digest) lines.push(`Expected digest: ${digest}`)
  if (!name || !url) lines.push(`Releases: ${SPICETIFY_RELEASES_PAGE}`)
  return lines.join("\n")
}

interface PreflightProbe {
  version: string | null
  languageMode: string
  elevated: boolean | null
  freeMb: number | null
  drive: string | null
}

type OfficialPreflight =
  | { ok: true; pwsh: string; arch: string; freeMb: number | null; drive: string | null }
  | { ok: false; reason: string }

function parsePreflightProbe(output: string): PreflightProbe {
  const values = new Map<string, string>()
  for (const line of output.split(/\r?\n/)) {
    const match = line.trim().match(/^([A-Z]+)=(.*)$/)
    if (match) values.set(match[1]!, match[2]!.trim())
  }
  const elevatedRaw = (values.get("ELEVATED") ?? "").toLowerCase()
  const elevated = elevatedRaw === "true" ? true : elevatedRaw === "false" ? false : null
  const freeRaw = values.get("FREEMB") ?? ""
  const freeMb = /^\d+(?:\.\d+)?$/.test(freeRaw) ? Number(freeRaw) : null
  return {
    version: values.get("PSVERSION") ?? null,
    languageMode: values.get("LANGUAGEMODE") ?? "",
    elevated,
    freeMb,
    drive: values.get("DRIVE") ?? null,
  }
}

/**
 * Fail-closed preflight for the official installer: Windows, known arch, no
 * existing install, PowerShell >= 5.1, not elevated, FullLanguage, and a disk
 * space note. Never mutates the system.
 */
async function preflightOfficialInstall(ctx: OperationContext): Promise<OfficialPreflight> {
  const { ui, runtime } = ctx
  if (runtime.platform !== "win32" || !ctx.detection.windows) {
    return { ok: false, reason: "The official Spicetify installer is supported on Windows only." }
  }
  const processorArch = typeof runtime.env.PROCESSOR_ARCHITECTURE === "string"
    ? runtime.env.PROCESSOR_ARCHITECTURE
    : undefined
  const arch = officialArchToken(runtime)
  if (!arch) {
    return {
      ok: false,
      reason: "Unknown CPU architecture; refusing to guess the release asset. Use --spicetify=manual.",
    }
  }
  ui.kv("Architecture", `${arch} (runtime ${runtime.arch}${processorArch ? `; PROCESSOR_ARCHITECTURE=${processorArch}` : ""})`)

  const existing = await runtime.which("spicetify").catch(() => undefined)
  if (existing) {
    return {
      ok: false,
      reason: `Spicetify is already available at ${existing}; it is reused rather than overwritten. Re-run detection or use --spicetify=manual.`,
    }
  }
  const localExe = join(localAppDataDir(runtime), "spicetify", "spicetify.exe")
  try {
    if (runtime.exists(localExe) && runtime.isFile(localExe)) {
      return {
        ok: false,
        reason: `An existing Spicetify binary was found at ${localExe}; refusing to overwrite or duplicate it. Update it manually or remove it first.`,
      }
    }
  } catch {
    return { ok: false, reason: "Could not check for an existing Spicetify installation; refusing to continue." }
  }

  const pwsh = ctx.detection.pwsh ?? await runtime.which("pwsh").catch(() => undefined)
  if (!pwsh) {
    return { ok: false, reason: "PowerShell (pwsh) was not found. Install PowerShell 7, or use --spicetify=manual." }
  }

  let probe: CommandResult
  try {
    probe = await runtime.run(
      pwsh,
      ["-NoProfile", "-NonInteractive", "-Command", SPICETIFY_PREFLIGHT_QUERY],
      { timeoutMs: OPERATION_TIMEOUTS.inspection },
    )
  } catch (error) {
    return {
      ok: false,
      reason: `PowerShell preflight failed: ${sanitizeDetail(error instanceof Error ? error.message : "unknown error")}`,
    }
  }
  if (probe.code !== 0) {
    return {
      ok: false,
      reason: `PowerShell preflight failed${probe.error ? `: ${sanitizeDetail(probe.error)}` : "."} Manual installation is recommended.`,
    }
  }
  const parsed = parsePreflightProbe(probe.stdout)
  if (!parsed.version) {
    return { ok: false, reason: "Could not determine the PowerShell version; refusing to run the official installer." }
  }
  if (isAtLeast(parsed.version, "5.1.0") !== true) {
    return {
      ok: false,
      reason: `PowerShell ${parsed.version} is older than 5.1; the official installer requires 5.1 or newer.`,
    }
  }
  if (parsed.elevated === null) {
    return { ok: false, reason: "Could not determine whether setup is elevated; refusing to run the official installer." }
  }
  if (parsed.elevated) {
    return {
      ok: false,
      reason: "Setup is running as administrator. Re-run it as your normal user; the official installer must not run elevated.",
    }
  }
  if (!parsed.languageMode) {
    return { ok: false, reason: "Could not determine the PowerShell language mode; refusing to run the official installer." }
  }
  if (parsed.languageMode.toLowerCase() !== "fulllanguage") {
    return {
      ok: false,
      reason: `PowerShell is in ${parsed.languageMode} mode. The official installer requires FullLanguage; use --spicetify=manual instead.`,
    }
  }
  ui.kv("PowerShell", `${parsed.version} (${parsed.languageMode}, not elevated)`)
  if (parsed.freeMb === null) {
    ui.line("  Disk space: could not be determined; ensure at least 100 MB is free on the %LOCALAPPDATA% drive.")
  } else if (parsed.freeMb < 100) {
    ui.warn(`Only ${parsed.freeMb} MB is free on ${parsed.drive ?? "the install drive"}; the official installer needs roughly 100 MB.`)
  } else {
    ui.line(`  Disk space: ${parsed.freeMb} MB free on ${parsed.drive ?? "the install drive"} (about 100 MB needed).`)
  }
  return { ok: true, pwsh, arch, freeMb: parsed.freeMb, drive: parsed.drive }
}

function installRunDetail(error: string | undefined): string | undefined {
  return error ? sanitizeDetail(error) : undefined
}

function isCancelledResult(result: CommandResult): boolean {
  return result.cancelled === true || result.code === 130 || /E_CANCELLED/i.test(result.error ?? "")
}

/**
 * A cancelled plan step must surface as cancellation (130), never as a generic
 * failure. Real failures intentionally keep their own message/code.
 */
function cancelledStepError(stepId: string, message: string): OperationCancelled {
  return new OperationCancelled(stepId, message)
}

/**
 * Truthful cancellation summary. It is derived only from the plan outcome, so
 * a cancelled run can never claim a step finished that was skipped.
 */
function reportCancelledPlan(ctx: OperationContext, outcome: PlanOutcome): void {
  const completed = outcome.completed.length ? outcome.completed.join(", ") : "none"
  const skipped = outcome.skipped.length ? outcome.skipped.join(", ") : "none"
  ctx.ui.line(`  Completed steps: ${completed}`)
  ctx.ui.line(`  Not run: ${skipped}`)
}

/** Test seam: lets callers substitute the installer adapter (no network). */
export interface EnsureSpicetifyDeps extends OfficialInstallerDeps {
  installOfficial?: (
    runtime: Runtime,
    info: SpicetifyInfo,
    options: OfficialInstallerOptions,
  ) => Promise<CommandResult>
}

export type EnsureSpicetifyStatus = "ready" | "declined" | "failed" | "confirmation-required" | "cancelled"

export async function ensureSpicetify(
  ctx: OperationContext,
  deps: EnsureSpicetifyDeps = {},
  release?: SpicetifyRelease | null,
): Promise<EnsureSpicetifyStatus> {
  if (ctx.detection.spicetify.available) return "ready"
  const { ui, options, runtime } = ctx
  if (ctx.cancel.requested) return "cancelled"
  const target = resolvedSpicetifyTarget(ctx.versions.spicetify.latest, release ?? null)
  // The upstream existing-install prompt cannot be ruled out before preflight,
  // so the warning must reach the single approval screen instead of being
  // dropped. Verification wording follows the reviewed digest ledger.
  const pin = spicetifyOfficialPin(target?.version ?? null, true, { arch: officialArchToken(runtime) })
  const progress = (message: string): void => {
    try {
      // Indeterminate only: no fabricated percentages.
      ctx.report?.progress("spicetify", message)
    } catch {
      // Progress presentation is best-effort; the installation result is authoritative.
    }
  }
  const manualDetails = (): string => targetDetails(runtime, target)
  const handleManual = async (): Promise<EnsureSpicetifyStatus> => {
    manualSpicetifyInstructions(ui, manualDetails())
    renderPostManualInstructions(ui)
    if (options.nonInteractive) {
      ui.error("Manual installation was requested in noninteractive mode; Spicetify is still missing.")
      return "failed"
    }
    if (ctx.cancel.requested) return "cancelled"
    const ready = await retryPrerequisite(ctx, (detection) => detection.spicetify.available, "Spicetify")
    if (ctx.cancel.requested) return "cancelled"
    return ready ? "ready" : "declined"
  }

  ui.section("Spicetify is required")
  ui.line("  Spicetify is the supported integration layer for Spotify Desktop.")
  let mode = options.spicetify
  let selectionRendered = false
  if (mode === "ask") {
    if (options.nonInteractive) {
      ui.error("Spicetify is not installed. Re-run noninteractive setup with --spicetify=manual or --spicetify=skip. (--spicetify=auto requires an interactive console and exits 2 without approval.)")
      return "failed"
    }
    const input: InstallWizardInput = {
      installedVersion: ctx.detection.spicetify.version,
      latestVersion: target?.version ?? null,
      pin,
      dryRun: options.dryRun,
      nonInteractive: false,
    }
    renderSelectionScreen(ui, input)
    selectionRendered = true
    const selected = await selectInstallMethod(ctx.prompt, input)
    if (ctx.cancel.requested) return "cancelled"
    if (selected === "cancel") {
      ui.line("  Exited without installing Spicetify or changing anything.")
      return "declined"
    }
    if (selected === "manual") return handleManual()
    mode = "auto"
  }
  if (mode === "skip") {
    ui.line("  Exited without installing Spicetify or changing anything.")
    return "declined"
  }
  if (mode === "manual") return handleManual()

  // Automatic path: official installer only, fresh installs only.
  if (options.dryRun) {
    renderPlanPreview(ui, officialInstallPlan(pin), "Official Spicetify installation plan (dry-run)")
    ui.line("  No files, PATH entries, or Spotify state were changed.")
    return "declined"
  }
  if (options.offline) {
    ui.error("Offline mode: the pinned official Spicetify installer cannot be downloaded or verified.")
    manualSpicetifyInstructions(ui, manualDetails())
    return "failed"
  }
  if (ctx.cancel.requested) return "cancelled"

  // Noninteractive official installs are never silently approved; the wizard
  // returns confirmation-required and runSetup exits 2.
  if (!options.nonInteractive) {
    progress("Running preflight checks")
    ui.section("Official Spicetify installer preflight")
    const preflight = await preflightOfficialInstall(ctx)
    if (ctx.cancel.requested) return "cancelled"
    if (!preflight.ok) {
      ui.error(preflight.reason)
      manualSpicetifyInstructions(ui, manualDetails())
      return "failed"
    }
  }

  const suspend = ui.suspend
  const resume = ui.resume
  const approvedTarget = target?.version ?? null
  const install: NonNullable<EnsureSpicetifyDeps["installOfficial"]> = deps.installOfficial ?? installSpicetify
  let installerCancelled = false
  const wizard = await runInstallWizard({
    ui,
    prompt: ctx.prompt,
    latestVersion: () => target?.version ?? null,
    installedVersion: ctx.detection.spicetify.version,
    method: "official",
    dryRun: false,
    nonInteractive: options.nonInteractive,
    pin,
    selectionRendered,
    installOfficial: async () => {
      if (ctx.cancel.requested) {
        installerCancelled = true
        return { code: 130, version: null, detail: "Cancelled by the user." }
      }
      progress("Running the official installer")
      const { installOfficial: _override, ...installerDeps } = deps
      const installerOptions: OfficialInstallerOptions = {
        ...installerDeps,
        offline: options.offline,
        nonInteractive: false,
        interactive: true,
        // The wizard already obtained the single explicit approval.
        approve: async () => true,
        log: {
          out: options.verbose ? (line: string) => ui.line(`  ${line}`) : () => {},
          err: (line: string) => ctx.log.err(line),
        },
        onProgress: (line) => {
          ui.line(`  ${line}`)
          progress(line)
        },
        cancel: ctx.cancel,
        ...(release ? { release } : {}),
        ...(suspend ? { beforeInteractive: async () => { await suspend() } } : {}),
        ...(resume ? { afterInteractive: async () => { await resume() } } : {}),
      }
      const result = await install(runtime, ctx.detection.spicetify, installerOptions)
      if (result.code === 0) {
        for (const line of result.stdout.split(/\r?\n/)) {
          const trimmed = line.trim()
          if (trimmed) ui.line(`  ${trimmed}`)
        }
      }
      if (isCancelledResult(result)) {
        installerCancelled = true
        return { code: 130, version: null, detail: "Cancelled by the user." }
      }
      return {
        code: result.code,
        version: result.code === 0 ? approvedTarget : null,
        detail: installRunDetail(result.error),
        stderr: result.stderr,
      }
    },
  })

  // A real installer failure or a required confirmation is never masked by a
  // cancellation request that raced it. Only a cancelled installer (or a
  // cancellation-typed failure detail) is classified as cancellation here.
  if (installerCancelled || /E_CANCELLED|cancelled by the user/i.test(wizard.detail ?? "")) {
    return "cancelled"
  }

  switch (wizard.status) {
    case "installed": {
      progress("Verifying the installation")
      refresh(ctx, await detectEnvironment(runtime))
      if (ctx.cancel.requested) return "cancelled"
      ui.line("  Spicetify's PATH entry applies to new terminals; reopen your terminal before running `spicetify` directly.")
      if (!ctx.detection.spicetify.available) {
        ui.warn("Spicetify was installed and the executable verified, but it is not visible in this process yet; a new terminal may be required for PATH changes.")
        const ready = await retryPrerequisite(ctx, (detection) => detection.spicetify.available, "Spicetify")
        if (ctx.cancel.requested) return "cancelled"
        return ready ? "ready" : "failed"
      }
      const installed = ctx.detection.spicetify.version
      ui.success(installed ? `Spicetify ${installed} detected.` : "Spicetify detected.")
      if (installed && approvedTarget && compareVersions(installed, approvedTarget) !== 0) {
        ui.warn(`Detected Spicetify ${installed}, which differs from the approved target ${approvedTarget}. Verify the release you intended to install.`)
      }
      progress("Spicetify installation verified")
      return "ready"
    }
    case "manual": {
      ui.bullet(`Target: ${manualDetails().replace(/\n/g, " | ")}`)
      if (options.nonInteractive) return "failed"
      const ready = await retryPrerequisite(ctx, (detection) => detection.spicetify.available, "Spicetify")
      if (ctx.cancel.requested) return "cancelled"
      return ready ? "ready" : "declined"
    }
    case "confirmation-required":
      return "confirmation-required"
    case "failed":
      manualSpicetifyInstructions(ui, manualDetails())
      return "failed"
    case "cancelled":
    case "declined":
    case "dry-run":
      // A consent prompt cancelled by the user is cancellation; a plain
      // decline stays a deliberate no-op.
      return ctx.cancel.requested ? "cancelled" : "declined"
  }
}

function registrationStep(ctx: OperationContext, spec: string | null): PlanStep {
  const target = spec ?? (ctx.options.packageSpec ?? `opencode-spotify@${ctx.installerVersion}`)
  return {
    id: "register-global-plugin",
    description: `Register ${target} in the global OpenCode configuration (native opencode plugin add)`,
    mutates: true,
    run: async () => {
      ctx.ui.line(`  Running: opencode plugin add ${target} (up to 90s; progress shown after completion)`)
      const runtime = cancelAwareRuntime(ctx.runtime, ctx.cancel)
      const result = await addGlobalPlugin(runtime, target, { log: (line) => ctx.ui.line(`  ${line}`) })
      // A cancelled mutation is not a failure: reconcile/rollback is skipped.
      if (isCancelledResult(result)) {
        throw cancelledStepError("register-global-plugin", "Global plugin registration was cancelled")
      }
      if (result.code === 0) return
      // B01: a failed or timed-out mutation may have completed server-side.
      // Reconcile the observed state before deciding success/failure.
      const reconciled = await reconcileRegistration(runtime)
      if (reconciled.state === "registered") {
        const detail = result.timedOut
          ? `the registration command timed out but ${reconciled.match?.version ?? "the plugin"} is now listed; treating as recovered`
          : `the registration command reported failure but the plugin is now listed; treating as recovered`
        ctx.ui.warn(`${detail}. Detail: ${result.error ?? "unknown error"}`)
        return
      }
      if (reconciled.state === "unknown") {
        throw new Error(`${result.error ?? "opencode plugin add failed"} (verification also failed: ${reconciled.detail ?? "plugin list did not complete"}; state is unknown, not proven absent)`)
      }
      throw new Error(result.timedOut
        ? `opencode plugin add timed out and the plugin is still absent; rerun setup to retry (no blind retry was attempted). Detail: ${result.error ?? "timeout"}`
        : (result.error ?? "opencode plugin add failed"))
    },
  }
}

function bridgeStep(ctx: OperationContext, operation: "install" | "repair"): PlanStep {
  return {
    id: `bridge-${operation}`,
    description: `${operation === "install" ? "Install" : "Repair"} the owned Spicetify bridge extension (credentials reused unless explicitly rotated)`,
    mutates: true,
    run: async () => {
      const result = await bridgeOperation(cancelAwareRuntime(ctx.runtime, ctx.cancel), operation, {
        spicetifyPath: ctx.detection.spicetify.path,
        dryRun: false,
        yes: true,
      })
      if (isCancelledResult(result)) {
        throw cancelledStepError(`bridge-${operation}`, `Bridge ${operation} was cancelled`)
      }
      if (result.code !== 0) throw new Error(result.error ?? `Bridge ${operation} failed`)
    },
  }
}

/** Plugin display that never says "unknown (current)". */
export function pluginUpdateLine(
  installed: string | null,
  info: ReturnType<typeof describePluginUpdate>,
): string {
  const current = installed ?? "unknown"
  if (info.target) return `${current} -> ${info.target}`
  switch (info.status) {
    case "current": {
      const betaNote = info.beta && info.beta !== info.stable ? `; beta ${info.beta} available` : ""
      return `${current} (current${betaNote})`
    }
    case "registry-older":
      return `${current} (registry tag is older; kept)`
    case "not-installed":
      return "not registered"
    default:
      return `${current} (latest unknown)`
  }
}

/** Spicetify display that distinguishes not-installed / latest-unknown / current. */
export function spicetifyUpdateLine(
  info: SpicetifyInfo,
  target: string | null,
  status: "current" | "outdated" | "unknown" | "downgrade",
): string {
  if (!info.available) return "not installed"
  const installed = info.version ?? "version unknown"
  if (status === "outdated" && target) return `${installed} -> ${target}`
  if (status === "current") return `${installed} (current)`
  if (status === "downgrade" && target) return `${installed} (installed is newer than ${target})`
  return `${installed} (latest unknown)`
}

function printPrerequisiteSummary(ctx: OperationContext): void {
  // B06: compact, useful summary. No secrets, no verbosity, no slowness.
  // B23: channel-aware via describePluginUpdate — never advertise an older
  // registry tag as an update; never mislabel a prerelease as stable. Fresh
  // installs register the installer/package version, so no update is shown.
  const d = ctx.detection
  ctx.ui.section("Environment")
  ctx.ui.kv("Windows", d.windows ? `${d.windowsVersion} ${d.arch}` : "unsupported (no changes will be made)")
  ctx.ui.kv("Node.js", d.node)
  ctx.ui.kv("OpenCode", d.opencode.available ? `${d.opencode.version ?? "version unknown"} (${d.compatibility.opencode})` : "not found")
  ctx.ui.kv("Spotify", d.spotify.installed ? (d.spotify.store ? "Store build detected" : "desktop detected") : "not detected")
  ctx.ui.kv("Spicetify", d.spicetify.available ? `${d.spicetify.version ?? "version unknown"} (${d.spicetify.owner})` : "not installed")
  const pluginSummary = d.opencode.plugin.state === "unknown"
    ? "unknown (inspection failed)"
    : d.opencode.plugin.registered
      ? `${d.opencode.plugin.version ?? "unknown"}${d.opencode.plugin.local ? " (local)" : ""}`
      : "not registered"
  ctx.ui.kv("Plugin", pluginSummary)
  ctx.ui.kv("Bridge", d.compatibility.bridge)
  const pluginInfo = describePluginUpdate(
    d.opencode.plugin.version,
    ctx.versions.plugin.latest,
    ctx.versions.plugin.latestBeta ?? null,
  )
  const spicetifyTarget = achievableSpicetifyTarget(d.spicetify.owner, ctx.versions.spicetify.latest)
  const spicetifyStatus = updateAvailability({
    pluginInstalled: d.opencode.plugin.version,
    pluginLatest: ctx.versions.plugin.latest,
    spicetifyInstalled: d.spicetify.version,
    spicetifyLatest: spicetifyTarget,
  }).spicetify
  if (pluginInfo.status === "update-available" && pluginInfo.target) {
    ctx.ui.kv("Update", `plugin ${pluginInfo.target} available`)
  } else if (spicetifyStatus === "outdated" && spicetifyTarget) {
    ctx.ui.kv("Update", `Spicetify ${spicetifyTarget} available`)
  }
}

/** Final bridge state; "current" means no bridge work or apply was needed. */
type FinalBridgeState = "applied" | "pending" | "current"

function printFinal(ctx: OperationContext, bridge: FinalBridgeState): void {
  ctx.ui.section("Setup summary")
  ctx.ui.kv("Global plugin", ctx.options.packageSpec ?? `opencode-spotify@${ctx.installerVersion}`)
  ctx.ui.kv(
    "Bridge",
    bridge === "applied"
      ? "prepared and applied"
      : bridge === "current"
        ? "already active; no apply needed"
        : "prepared; apply pending",
  )
  ctx.ui.kv("Playback", "not verified by the installer")
  ctx.ui.line("")
  if (bridge === "pending") {
    ctx.ui.warn("Spicetify apply is still pending. Run `spicetify apply` yourself, or re-run setup with --apply.")
  }
  ctx.ui.bullet("Restart any running OpenCode process so the global plugin loads.")
  ctx.ui.bullet("Start Spotify Desktop, then open OpenCode in any project and wait for `Spotify ● Connected`.")
  ctx.ui.bullet("Connection and playback are confirmed only in the running TUI, not by file installation.")
}

async function maintenance(ctx: OperationContext): Promise<number> {
  const { ui, detection } = ctx
  ui.section("Existing installation detected")
  const plugin = ctx.versions.plugin
  const spicetify = ctx.versions.spicetify
  // B23: single source of truth for channel-aware comparison.
  const pluginInfo = describePluginUpdate(
    detection.opencode.plugin.version,
    plugin.latest,
    plugin.latestBeta ?? null,
  )
  const pluginOutdated = pluginInfo.status === "update-available"
  // B32: only advertise an owner-safe target that actually exists and differs.
  // A script-owned copy has no achievable target when `latest` is not a strict
  // stable release; an unknown owner has no safe target at all.
  const spicetifyTarget = achievableSpicetifyTarget(detection.spicetify.owner, spicetify.latest)
  const spicetifyState = updateAvailability({
    pluginInstalled: detection.opencode.plugin.version,
    pluginLatest: plugin.latest,
    spicetifyInstalled: detection.spicetify.version,
    spicetifyLatest: spicetifyTarget,
  }).spicetify
  const spicetifyOutdated = spicetifyState === "outdated" && !!spicetifyTarget
  ui.kv("OpenCode Spotify", pluginUpdateLine(detection.opencode.plugin.version, pluginInfo))
  ui.kv("Spicetify", spicetifyUpdateLine(detection.spicetify, spicetifyTarget, spicetifyState))
  ui.kv("Bridge", detection.compatibility.bridge)
  if (detection.opencode.plugin.local) {
    ui.warn("The registered plugin is a local development path. Updates never replace it without an explicit choice.")
  }
  const everythingCurrent = pluginInfo.status === "current" &&
    spicetifyState === "current" &&
    detection.bridge.registration === "current"
  if (everythingCurrent) {
    ui.success("Everything detected is current.")
  }
  if (ctx.options.nonInteractive) {
    ui.line("  Noninteractive maintenance mode makes no changes. Run `opencode-spotify update`, `opencode-spotify repair`, or `opencode-spotify uninstall` explicitly.")
    return 0
  }
  const choices: { label: string; value: string }[] = []
  if (detection.opencode.plugin.local) choices.push({ label: "Switch this global registration to the published package", value: "switch" })
  // Unified update/repair experience: adapt to actual state, keep the bridge
  // synchronized, never mix package managers, never downgrade. "Both" is only
  // offered when both targets are genuinely achievable.
  if (pluginOutdated && spicetifyOutdated) choices.push({ label: "Update both OpenCode Spotify and Spicetify", value: "both" })
  if (pluginOutdated) choices.push({ label: "Update OpenCode Spotify only", value: "plugin" })
  if (spicetifyOutdated) choices.push({ label: "Update Spicetify only", value: "spicetify" })
  // Repair is always available (including for a local registration); uninstall
  // runs in-process with this same context, so no second installer lock is taken.
  choices.push({ label: "Repair existing installation", value: "repair" })
  choices.push({ label: "Continue without updating", value: "continue" })
  if (detection.opencode.plugin.registered) choices.push({ label: "Uninstall OpenCode Spotify", value: "uninstall" })
  choices.push({ label: "Exit", value: "exit" })
  const choice = await ctx.prompt.choose("What would you like to do?", choices)
  if (ctx.cancel.requested) return 130
  if (!choice || choice === "exit") return 0
  if (choice === "continue") {
    await runStatus(ctx)
    ctx.ui.line("  No changes were made.")
    return 0
  }
  if (choice === "uninstall") return runUninstall(ctx)
  if (choice === "repair") return runRepair(ctx)
  if (choice === "switch") {
    const spec = detection.opencode.plugin.spec
    const steps: PlanStep[] = []
    if (spec) {
      steps.push({ id: "remove-local", description: `Remove the local development registration ${spec}`, mutates: true,
        run: async () => {
          const result = await removeGlobalPlugin(cancelAwareRuntime(ctx.runtime, ctx.cancel), spec)
          if (isCancelledResult(result)) {
            throw cancelledStepError("remove-local", "Removing the local registration was cancelled")
          }
          if (result.code !== 0) throw new Error(result.error ?? "opencode plugin remove failed")
        } })
    }
    steps.push(registrationStep(ctx, null))
    if (detection.bridge.registration !== "current") steps.push(bridgeStep(ctx, "install"))
    const outcome = await executePlan(ctx, "Switch to the published package", steps)
    // A real failure or missing confirmation always wins over a concurrent
    // cancellation request; only a cancelled plan maps to 130.
    if (outcome.status === "cancelled") {
      reportCancelledPlan(ctx, outcome)
      return 130
    }
    const code = planExitCode(outcome)
    if (code !== 0) return code
    const applied = await maybeApplyBridge(ctx, detection.spicetify.path, detection.bridge.registration !== "current")
    return applied.code
  }
  if (choice === "both" || choice === "spicetify") ctx.options.allowSpicetifyUpgrade = true
  // The maintenance choice is the single consent for the selected update; the
  // update plan must not ask again. Apply keeps its separate consent.
  ctx.options.yes = true
  // runUpdate already distinguishes its own cancellation (130) from a real
  // failure (1) and a missing confirmation (2); never override its code.
  return runUpdate(ctx, choice === "both" ? "both" : choice === "spicetify" ? "spicetify" : "plugin")
}

/**
 * Intelligent setup. Plan cancellation runs no further steps in that plan;
 * earlier separately-approved prerequisite installs (for example Spicetify)
 * are reported, not rolled back, because external package-manager operations
 * cannot be reliably reversed.
 */
export async function runSetup(ctx: OperationContext, deps: EnsureSpicetifyDeps = {}): Promise<number> {
  const { ui } = ctx
  if (ctx.cancel.requested) return 130
  printPrerequisiteSummary(ctx)
  if (!ctx.detection.windows) {
    ui.error("V0.6.0 supports Windows only. No changes were made.")
    return 1
  }
  if (!ctx.detection.opencode.available) {
    ui.section("OpenCode is required")
    ui.line(`  Install OpenCode ${MIN_OPENCODE} or newer: ${OPENCODE_URL}`)
    const ready = await retryPrerequisite(ctx, (detection) => detection.opencode.available, "OpenCode")
    if (ctx.cancel.requested) return 130
    if (!ready) return 1
  }
  if (!ctx.detection.opencode.nativeCommands) {
    ui.error(`This OpenCode version lacks native plugin management (\`opencode plugin add\`). Requires OpenCode ${MIN_OPENCODE} or newer; no changes were made. Upgrade OpenCode first.`)
    return 1
  }
  if (!ctx.detection.spotify.installed) {
    ui.section("Spotify Desktop is required")
    ui.line(`  Install Spotify Desktop for Windows: ${SPOTIFY_URL}`)
    if (ctx.detection.spotify.store) ui.warn("A Store build was detected earlier; it may require Spicetify to be re-applied after restarts.")
    const ready = await retryPrerequisite(ctx, (detection) => detection.spotify.installed, "Spotify Desktop")
    if (ctx.cancel.requested) return 130
    if (!ready) return 1
  }
  if (ctx.options.dryRun) {
    ui.section("Dry-run installation plan")
    let step = 1
    if (!ctx.detection.spicetify.available) ui.line(`  ${step++}. Install Spicetify with the pinned official installer or manual instructions (separately confirmed).`)
    ui.line(`  ${step++}. Register the published package in the global OpenCode configuration.`)
    ui.line(`  ${step++}. Install or repair the bridge extension with a per-installation credential.`)
    ui.line(`  ${step}. Leave \`spicetify apply\` pending for separate authorization.`)
    ui.line("  No files, configuration, registrations, or Spotify state were changed.")
    return 0
  }
  const spicetifyWasMissing = !ctx.detection.spicetify.available
  if (ctx.cancel.requested) return 130
  const spicetify = await ensureSpicetify(ctx, deps)
  if (spicetify !== "ready") {
    if (spicetify === "cancelled") {
      // Report an already-completed prerequisite install instead of hiding it
      // behind the cancellation message.
      if (spicetifyWasMissing && ctx.detection.spicetify.available) {
        ui.warn("Completed before cancellation: Spicetify installation. It is left in place; rerun setup to continue.")
      }
      return 130
    }
    if (spicetify === "declined") return 0
    if (spicetify === "confirmation-required") return 2
    return 1
  }

  const detection = ctx.detection
  if (detection.opencode.plugin.state === "unknown") {
    ui.error(`Global registration state is unknown (inspection failed: ${detection.opencode.plugin.detail ?? "plugin list did not complete"}). Rerun \`opencode-spotify doctor\`; no changes were made and no blind retry was attempted.`)
    return 1
  }
  // Registered installs (including a local development path) enter the
  // maintenance menu so repair/uninstall stay reachable.
  if (detection.opencode.plugin.registered) return maintenance(ctx)
  if (ctx.cancel.requested) return 130

  const localProject = (await projectPlugins(ctx.runtime)).find((entry) => isSpotifyPluginId(entry.id) && /[\\/]/.test(entry.source))
  if (localProject) {
    ui.warn(`This project also configures a local plugin at ${localProject.source}. The installer leaves project config untouched.`)
  }

  const steps: PlanStep[] = []
  if (detection.opencode.plugin.local) {
    const localSpec = detection.opencode.plugin.spec
    if (localSpec) {
      steps.push({ id: "remove-local", description: `Remove the existing local registration ${localSpec}`, mutates: true,
        run: async () => {
          const result = await removeGlobalPlugin(cancelAwareRuntime(ctx.runtime, ctx.cancel), localSpec)
          if (isCancelledResult(result)) {
            throw cancelledStepError("remove-local", "Removing the local registration was cancelled")
          }
          if (result.code !== 0) throw new Error(result.error ?? "opencode plugin remove failed")
        } })
    }
    steps.push(registrationStep(ctx, null))
  } else if (!detection.opencode.plugin.registered) {
    steps.push(registrationStep(ctx, null))
  }
  const bridgeNeeded = !detection.bridge.installed || detection.bridge.registration !== "current"
  if (bridgeNeeded) steps.push(bridgeStep(ctx, detection.bridge.credentialValid ? "repair" : "install"))
  if (!steps.length) {
    ui.success("The installation is already complete and current.")
    printFinal(ctx, detection.bridge.registration === "current" ? "current" : "pending")
    return 0
  }
  if (ctx.cancel.requested) return 130
  const outcome = await executePlan(ctx, "Installation plan", steps)
  // Cancellation only wins when the plan itself was cancelled. A real failure
  // (1) or a missing confirmation (2) always keeps its own exit code.
  if (outcome.status === "cancelled") {
    reportCancelledPlan(ctx, outcome)
    return 130
  }
  const code = planExitCode(outcome)
  if (code !== 0) {
    if (spicetifyWasMissing && ctx.detection.spicetify.available) {
      ui.warn("Completed before this plan: Spicetify installation. It is left in place; rerun setup to continue.")
    }
    return code
  }

  const verified = await detectEnvironment(ctx.runtime)
  refresh(ctx, verified)
  if (verified.opencode.plugin.state === "unknown") {
    ui.error(`Global registration state is unknown (inspection failed: ${verified.opencode.plugin.detail ?? "plugin list did not complete"}). Use \`opencode-spicetify doctor\` for details; no blind retry was attempted.`)
    return 1
  }
  if (!verified.opencode.plugin.registered || verified.opencode.plugin.local) {
    ui.error("Global registration could not be verified. Use `opencode-spicetify doctor` for details.")
    return 1
  }
  if (!verified.bridge.installed || verified.bridge.registration !== "current") {
    ui.error("The bridge could not be verified after installation. Use `opencode-spicetify repair`.")
    return 1
  }
  // Check cancellation before apply starts, never between apply and verification.
  if (ctx.cancel.requested) return 130
  // Only a plan that actually prepared the bridge may ask for apply. A
  // registration-only run must never prompt for `spicetify apply`.
  const applied = await maybeApplyBridge(ctx, verified.spicetify.path, bridgeNeeded)
  if (applied.code !== 0) return applied.code
  printFinal(ctx, applied.applied ? "applied" : bridgeNeeded ? "pending" : "current")
  return 0
}
