// Fresh-install wizard screens: install selection, pinned-official-installer
// explanation, plan preview, explicit approval, manual fallback, and result.
//
// This module is presentation and consent only. It never downloads, verifies,
// executes, registers, or applies anything itself: side effects live behind the
// injected adapters, and `installOfficial` is unreachable until the user gives
// an explicit affirmative answer. Read-only screens (selection, explanation,
// plan preview, manual instructions, result) never prompt.
//
// There is deliberately no `yes`/`assumeYes` shortcut. Unattended callers get
// `confirmation-required` rather than a silent approval, and a missing install
// adapter reports failure instead of pretending the install succeeded.
import {
  compareVersions,
  OFFICIAL_INSTALLER_BYTES,
  OFFICIAL_INSTALLER_COMMIT,
  OFFICIAL_INSTALLER_SHA256,
  REVIEWED_SPICETIFY_RELEASES,
} from "../compat.ts"
import type { PromptChoiceView, PromptRequest, Prompter, Ui } from "../types.ts"

export const MANUAL_INSTRUCTIONS_URL = "https://spicetify.app/docs/getting-started"
export const SPICETIFY_RELEASES_URL = "https://github.com/spicetify/cli/releases"

/** Short commit recorded for the pinned official installer (shared A02 pin). */
export const PINNED_INSTALLER_REVISION = OFFICIAL_INSTALLER_COMMIT.slice(0, 7)
/** Full SHA-256 recorded for that revision; verified before execution. */
export const PINNED_INSTALLER_SHA256 = OFFICIAL_INSTALLER_SHA256
export const PINNED_INSTALLER_SIZE_BYTES = OFFICIAL_INSTALLER_BYTES
export const PINNED_INSTALLER_URL =
  `https://raw.githubusercontent.com/spicetify/cli/${OFFICIAL_INSTALLER_COMMIT}/install.ps1`

/**
 * The install target is resolved at runtime (upstream latest / an explicit
 * caller target), never hard-coded here. `targetVersion` remains only for
 * callers that deliberately pin one; null means "no verified target".
 */
export interface OfficialInstallerPin {
  readonly method: "official-installer"
  readonly revision: string
  readonly sha256: string
  readonly sizeBytes: number
  readonly targetVersion: string | null
  readonly url: string
  readonly effects: readonly string[]
  readonly nots: readonly string[]
}

export const OFFICIAL_INSTALLER_BASE_EFFECTS: readonly string[] = [
  "Downloads the official Spicetify CLI release for the detected Windows architecture.",
  "Installs the CLI under %LOCALAPPDATA%\\spicetify and adds that directory to the user PATH.",
  "Replaces a script-owned Spicetify CLI with the pinned release.",
  "The pinned installer script is verified (size and SHA-256) before execution and re-checked inside PowerShell; the reviewed Marketplace block removal is verified before staging.",
]

/** True only when the resolved target has a reviewed ledger size/digest. */
export function hasReviewedInstallerDigest(target: string | null | undefined): boolean {
  if (!target || !target.trim()) return false
  const normalized = target.trim().replace(/^v(?=\d)/i, "")
  return Object.prototype.hasOwnProperty.call(REVIEWED_SPICETIFY_RELEASES, normalized)
}

/** Installed-executable verification claim, ledger-conditional (M4). */
export function installerVerificationEffect(target: string | null | undefined): string {
  return hasReviewedInstallerDigest(target)
    ? "Verifies the installed executable's size and SHA-256 against the reviewed ledger entry for that exact version, plus its Authenticode signer (exactly \"SignPath Foundation\"), the exact `spicetify -v` version, and the user PATH before reporting success."
    : "Verifies the installed executable's Authenticode signer (exactly \"SignPath Foundation\"), the exact `spicetify -v` version, and the user PATH before reporting success: Authenticode + exact version only, with no per-release size/SHA-256 pin."
}

/** Effects for a resolved target; unknown targets get the conservative claim. */
export function officialInstallerEffects(target: string | null | undefined = null): readonly string[] {
  return [...OFFICIAL_INSTALLER_BASE_EFFECTS, installerVerificationEffect(target)]
}

export const OFFICIAL_INSTALLER_EFFECTS: readonly string[] = officialInstallerEffects(null)

export const OFFICIAL_INSTALLER_NOT_EFFECTS: readonly string[] = [
  "Does not install, launch, restart, or modify Spotify Desktop.",
  "Does not run `spicetify apply`, install themes or extensions, or change Spotify state.",
  "Does not touch OpenCode configuration, the plugin registration, or the bridge extension.",
  "Does not read, create, or rotate bridge credentials.",
  "Does not require administrator rights or edit the system-wide PATH.",
  "Does not install or upgrade through winget, Scoop, or Chocolatey.",
  "Does not pre-answer the upstream installer prompts: if an existing Spicetify is detected, that prompt defaults to Yes and would run `spicetify update`; answer No so the existing copy is left in place.",
  "Move-OldSpicetifyFolder can copy and then permanently delete the legacy `~/spicetify-cli` folder (`%USERPROFILE%\\spicetify-cli`) when it exists.",
  "Does not claim a reviewed artifact size or SHA-256 unless the resolved target has a reviewed ledger entry; otherwise verification is Authenticode + exact version only.",
  "Does not execute unpinned content from the mutable main branch.",
]

export const OFFICIAL_INSTALLER: OfficialInstallerPin = {
  method: "official-installer",
  revision: PINNED_INSTALLER_REVISION,
  sha256: PINNED_INSTALLER_SHA256,
  sizeBytes: PINNED_INSTALLER_SIZE_BYTES,
  // Dynamic: the wizard resolves the target from the caller/upstream latest.
  targetVersion: null,
  url: PINNED_INSTALLER_URL,
  effects: OFFICIAL_INSTALLER_EFFECTS,
  nots: OFFICIAL_INSTALLER_NOT_EFFECTS,
}

export type InstallMethod = "official" | "manual" | "cancel"

export interface InstallWizardInput {
  installedVersion: string | null
  latestVersion: string | null
  /**
   * Backend-resolved install target. When omitted the wizard uses the detected
   * latest version; when both are null the official installer is refused.
   */
  target?: string | null
  pin?: OfficialInstallerPin
  dryRun?: boolean
  nonInteractive?: boolean
  /** Crisp default output; --verbose restores the full non-effects wall. */
  verbose?: boolean
}

/** Normalize a caller target, falling back to the resolved latest version. */
export function resolveInstallTarget(input: Pick<InstallWizardInput, "target" | "latestVersion" | "pin">): string | null {
  const explicit = input.target?.trim()
  if (explicit) return explicit.replace(/^v(?=\d)/i, "")
  const pinned = input.pin?.targetVersion?.trim()
  if (pinned) return pinned.replace(/^v(?=\d)/i, "")
  const latest = input.latestVersion?.trim()
  return latest ? latest.replace(/^v(?=\d)/i, "") : null
}

export interface InstallPlanStepView {
  id: string
  description: string
  /** True only for the step that changes the system. */
  mutates: boolean
}

export type InstallWizardStatus =
  | "installed"
  | "manual"
  | "cancelled"
  | "declined"
  | "confirmation-required"
  | "dry-run"
  | "failed"

export interface InstallWizardResult {
  status: InstallWizardStatus
  method: "official" | "manual" | null
  version: string | null
  detail?: string
}

export interface InstallRunResult {
  code: number
  version?: string | null
  detail?: string
  stderr?: string
}

export type InstallChoiceRequest = Extract<PromptRequest, { kind: "choose" }>
export type InstallConfirmRequest = Extract<PromptRequest, { kind: "confirm" }>
export type OfficialApprovalOutcome =
  | "approved"
  | "declined"
  | "confirmation-required"
  | "dry-run"
  | "unavailable"

function resolvePin(input: InstallWizardInput): OfficialInstallerPin {
  return input.pin ?? OFFICIAL_INSTALLER
}

export function formatInstallerSize(bytes: number): string {
  return `${bytes.toLocaleString("en-US")} B`
}

function displayValue(value: string | null, unknown: string): string {
  return value && value.trim() ? value.trim() : unknown
}

/** Keep adapter failures from leaking token-like text into the result screen. */
function scrubDetail(text: string): string {
  return text
    .replace(/\b[a-f0-9]{32,}\b/gi, "[redacted]")
    .replace(/\b(secret|token|password|credential|authorization)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .slice(0, 240)
}

/** Selection prompt as the shared PromptRequest contract. */
export function buildSelectionRequest(input: InstallWizardInput): InstallChoiceRequest {
  const pin = resolvePin(input)
  const target = resolveInstallTarget({ ...input, pin })
  const choices: PromptChoiceView[] = []
  if (target) {
    choices.push({
      label: `Use the pinned official installer (revision ${pin.revision}, target ${target})`,
      value: "official",
      hint: `${formatInstallerSize(pin.sizeBytes)}; script SHA-256 ${pin.sha256} verified before execution`,
    })
  }
  choices.push(
    {
      label: "Install manually using the official instructions",
      value: "manual",
      hint: target
        ? "No installer command is run; you install Spicetify yourself"
        : "No verified target version is known, so only manual installation is offered",
    },
    {
      label: "Exit without changing anything",
      value: "cancel",
    },
  )
  return {
    id: "install-method",
    kind: "choose",
    question: "How do you want to install Spicetify?",
    choices,
    defaultIndex: 0,
  }
}

/** Read-only selection context: versions, resolved target, and the alternative. */
export function renderSelectionScreen(ui: Ui, input: InstallWizardInput): void {
  const pin = resolvePin(input)
  const target = resolveInstallTarget({ ...input, pin })
  ui.section("Spicetify installation")
  ui.kv("Installed Spicetify", displayValue(input.installedVersion, "not detected"))
  ui.kv("Latest detected", displayValue(input.latestVersion, "unknown (offline or lookup failed)"))
  ui.kv("Installer target", target ?? "unknown (official installer refused)")
  ui.kv("Official installer", `revision ${pin.revision}, ${formatInstallerSize(pin.sizeBytes)}, script SHA-256 ${pin.sha256}`)
  ui.kv("Marketplace", "installed by default (skip with --no-marketplace)")
  if (!target) {
    ui.warn("No verified Spicetify target version is known; the official installer will not run. Install manually or retry when the release lookup succeeds.")
  }
  ui.line("  Spicetify installs via the pinned official installer; the Marketplace installs by default (opt out with --no-marketplace).")
  ui.line("  The official installer script is pinned and digest-checked; manual installation uses the published instructions.")
  ui.line("  Either path leaves plugin registration, bridge setup, and `spicetify apply` to later, separately approved steps.")
}

/** One numbered choice, or cancel on EOF/unexpected input. */
export async function selectInstallMethod(prompt: Prompter, input: InstallWizardInput): Promise<InstallMethod> {
  const request = buildSelectionRequest(input)
  const selected = await prompt.choose(request.question, request.choices, request.defaultIndex)
  if (selected === "official" || selected === "manual") return selected
  return "cancel"
}

/** Full explanation of the pinned installer, including what it will NOT do. */
export function renderOfficialInstallerExplanation(
  ui: Ui,
  pin: OfficialInstallerPin,
  input: Pick<InstallWizardInput, "installedVersion" | "latestVersion"> & { target?: string | null } = {
    installedVersion: null,
    latestVersion: null,
  },
  options: { verbose?: boolean } = {},
): void {
  const target = resolveInstallTarget({ ...input, pin })
  // Only the built-in pin gets the ledger-conditional claim recomputed here. A
  // caller-supplied pin (setup adds architecture scope) owns its own truthful
  // effects and must not be overridden with a broader claim.
  const effects = pin.effects === OFFICIAL_INSTALLER_EFFECTS
    ? officialInstallerEffects(target ?? pin.targetVersion)
    : pin.effects
  ui.section("Official Spicetify installer (pinned)")
  ui.kv("Source", pin.url)
  ui.kv("Revision", pin.revision)
  ui.kv("Script SHA-256", pin.sha256)
  ui.kv("Size", formatInstallerSize(pin.sizeBytes))
  ui.kv("Target version", target ?? "unknown (not verified; official install refused)")
  ui.kv("Installed Spicetify", displayValue(input.installedVersion, "not detected"))
  ui.kv("Latest detected", displayValue(input.latestVersion, "unknown (offline or lookup failed)"))
  ui.kv("Marketplace", "installed by default (skip with --no-marketplace)")
  ui.line("  Spicetify installs via the pinned official installer; the Marketplace installs by default.")
  ui.line("  What it does:")
  for (const effect of effects) ui.bullet(effect)
  // Crisp default: the full non-effects wall is --verbose only. Runtime
  // enforcement (verification, preflight, patch removal) is unchanged.
  const verbose = options.verbose === true || (input as { verbose?: boolean }).verbose === true
  ui.line("  What it does NOT do:")
  const nots = verbose ? pin.nots : pin.nots.slice(0, 3)
  for (const not of nots) ui.bullet(not)
  if (!verbose && pin.nots.length > nots.length) {
    ui.line(`  Run with --verbose to see all ${pin.nots.length} non-effects.`)
  }
  if (target && input.latestVersion && compareVersions(input.latestVersion, target) === 1) {
    ui.warn(
      `Latest detected ${input.latestVersion} is newer than the install target ${target}. ` +
      "The pinned installer script targets a reproducible release, not a latest-version channel; choose manual installation for newer releases.",
    )
  }
  if (target && input.installedVersion && compareVersions(input.installedVersion, target) === 1) {
    ui.warn(
      `Installed Spicetify ${input.installedVersion} is newer than the install target ${target}; ` +
      "the wizard will not silently downgrade it.",
    )
  }
}

/** The mutating action is isolated to the single installer step. */
export function officialInstallPlan(
  pin: OfficialInstallerPin = OFFICIAL_INSTALLER,
  target: string | null = pin.targetVersion,
): InstallPlanStepView[] {
  const subject = target ? `Spicetify ${target}` : "Spicetify (target resolved at runtime)"
  return [
    {
      id: "download-installer",
      description: `Download the installer at revision ${pin.revision} (${formatInstallerSize(pin.sizeBytes)})`,
      mutates: false,
    },
    {
      id: "verify-installer",
      description: `Verify script SHA-256 ${pin.sha256} and size ${formatInstallerSize(pin.sizeBytes)}; abort on mismatch`,
      mutates: false,
    },
    {
      id: "run-installer",
      description: `Run the verified installer with PowerShell 7 (no profile, non-elevated) to install ${subject}`,
      mutates: true,
    },
    {
      id: "verify-version",
      description: target
        ? `Verify \`spicetify -v\` reports ${target}`
        : "Verify `spicetify -v` reports the target version before proceeding",
      mutates: false,
    },
    {
      id: "stop-before-integration",
      description: "Stop before plugin registration, bridge setup, credential changes, or `spicetify apply`; each needs separate approval",
      mutates: false,
    },
  ]
}

export function renderPlanPreview(
  ui: Ui,
  steps: readonly InstallPlanStepView[] = officialInstallPlan(),
  title = "Official installer plan",
): void {
  ui.section(title)
  steps.forEach((step, index) => {
    ui.bullet(`${index + 1}. ${step.description}${step.mutates ? " (changes the system)" : " (verification only)"}`)
  })
  ui.line("  No step runs without an explicit approval.")
}

/** Approval request in the shared contract; the safe default is "no". */
export function buildApprovalRequest(
  target: string | null = null,
  pin: OfficialInstallerPin = OFFICIAL_INSTALLER,
): InstallConfirmRequest {
  const resolved = target ?? pin.targetVersion
  return {
    id: "confirm-official-installer",
    kind: "confirm",
    question: resolved
      ? `Run the pinned official installer to install Spicetify ${resolved}?`
      : "Run the pinned official installer?",
    defaultYes: false,
  }
}

/**
 * Exactly one confirmation for the only mutating action. Dry runs and
 * unattended runs never reach the prompt and never count as approval. A null
 * target is refused before any prompt: no installer runs without a version it
 * can verify afterwards.
 */
export async function approveOfficialInstall(
  prompt: Prompter,
  pin: OfficialInstallerPin,
  options: { dryRun?: boolean; nonInteractive?: boolean; target?: string | null } = {},
): Promise<OfficialApprovalOutcome> {
  if (options.dryRun) return "dry-run"
  const target = options.target ?? pin.targetVersion
  if (!target) return "unavailable"
  if (options.nonInteractive) return "confirmation-required"
  const request = buildApprovalRequest(target, pin)
  const approved = await prompt.confirm(request.question, {
    defaultYes: request.defaultYes,
    ...(request.phrase ? { phrase: request.phrase } : {}),
  })
  return approved ? "approved" : "declined"
}

/** Manual alternative: published instructions plus the pinned record to inspect. */
export function renderManualInstructions(
  ui: Ui,
  options: { pin?: OfficialInstallerPin; target?: string | null; details?: string | null } = {},
): void {
  const pin = options.pin ?? OFFICIAL_INSTALLER
  const target = options.target ?? pin.targetVersion
  ui.section("Manual Spicetify installation")
  ui.line("  No installer command was run. Install Spicetify yourself, then return to setup.")
  ui.bullet(`Official instructions: ${MANUAL_INSTRUCTIONS_URL}`)
  ui.bullet(`Release downloads: ${SPICETIFY_RELEASES_URL}`)
  ui.bullet(target ? `Target version: ${target}` : "Target version: choose a published release yourself")
  ui.bullet(`Pinned installer script to inspect before running yourself: ${pin.url}`)
  ui.bullet(`Expected script size: ${formatInstallerSize(pin.sizeBytes)}; expected script SHA-256: ${pin.sha256}`)
  ui.bullet("winget: winget install --id Spicetify.Spicetify -e")
  if (options.details) {
    for (const line of options.details.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (trimmed) ui.bullet(trimmed)
    }
  }
  ui.line("  Do not run two package managers against the same Spicetify installation.")
}

/** Post-manual instructions: recheck only after the user installs it. */
export function renderPostManualInstructions(ui: Ui): void {
  ui.section("After manual installation")
  ui.bullet("Close and reopen your terminal so PATH changes apply.")
  ui.bullet("Run `spicetify -v` to confirm the CLI is on PATH.")
  ui.bullet("Re-run setup and choose \"Recheck now\" when it waits for Spicetify.")
  ui.line("  Playback is confirmed only in the running OpenCode TUI, not by this installer.")
}

export function renderResultScreen(ui: Ui, result: InstallWizardResult): void {
  ui.section("Installation result")
  switch (result.status) {
    case "installed":
      ui.success(`Spicetify ${result.version ?? "installation"} completed with the pinned official installer.`)
      ui.bullet("Plugin registration and bridge setup continue automatically as the next setup steps.")
      ui.bullet("`spicetify apply` remains pending and is never run by the install wizard.")
      break
    case "manual":
      ui.warn("No installer command was run. Manual installation is still pending.")
      break
    case "cancelled":
      ui.warn("Cancelled. No changes were made.")
      break
    case "declined":
      ui.warn("Approval was not given. Nothing was downloaded, executed, or changed.")
      break
    case "confirmation-required":
      ui.error("Explicit approval is required. Noninteractive mode never approves silently; no changes were made.")
      break
    case "dry-run":
      ui.line("Dry run: the installer was not downloaded or executed; no changes were made.")
      break
    case "failed":
      ui.error(`Installation failed${result.detail ? `: ${result.detail}` : "."}`)
      ui.bullet("A nonzero result is never reported as success. Check `spicetify -v`, then retry or install manually.")
      break
  }
}

export function resultExitCode(status: InstallWizardStatus): number {
  switch (status) {
    case "installed":
    case "manual":
    case "dry-run":
      return 0
    case "cancelled":
    case "declined":
      return 130
    case "confirmation-required":
      return 2
    default:
      return 1
  }
}

export interface InstallWizardDeps {
  ui: Ui
  prompt: Prompter
  /** Read-only upstream lookup. Failures degrade to "unknown", never to a fake version. */
  latestVersion: () => string | null | Promise<string | null>
  installedVersion?: string | null
  /** Preselected by CLI flags; when absent the interactive selector is shown. */
  method?: InstallMethod
  dryRun?: boolean
  nonInteractive?: boolean
  verbose?: boolean
  pin?: OfficialInstallerPin
  /** The caller already rendered the selection context; skip the duplicate. */
  selectionRendered?: boolean
  /** Only invoked after explicit approval. */
  installOfficial?: (pin: OfficialInstallerPin) => InstallRunResult | Promise<InstallRunResult>
}

function finish(ui: Ui, result: InstallWizardResult): InstallWizardResult {
  renderResultScreen(ui, result)
  return result
}

/**
 * Drive the fresh-install screens. Safe operations (viewing, manual fallback,
 * dry-run) never ask for confirmation; the mutating install asks exactly once.
 */
export async function runInstallWizard(deps: InstallWizardDeps): Promise<InstallWizardResult> {
  const pin = deps.pin ?? OFFICIAL_INSTALLER
  const input: InstallWizardInput = {
    installedVersion: deps.installedVersion ?? null,
    latestVersion: null,
    pin,
    dryRun: deps.dryRun === true,
    nonInteractive: deps.nonInteractive === true,
    verbose: deps.verbose === true,
  }
  try {
    input.latestVersion = await deps.latestVersion()
  } catch {
    input.latestVersion = null
  }
  const target = resolveInstallTarget({ ...input, pin })

  if (!deps.selectionRendered) renderSelectionScreen(deps.ui, input)

  let method = deps.method
  if (!method) {
    if (deps.nonInteractive) {
      return finish(deps.ui, {
        status: "confirmation-required",
        method: null,
        version: null,
        detail: "No install method was selected.",
      })
    }
    method = await selectInstallMethod(deps.prompt, input)
  }

  if (method === "manual") {
    renderManualInstructions(deps.ui, { pin, target })
    renderPostManualInstructions(deps.ui)
    return finish(deps.ui, { status: "manual", method: "manual", version: null })
  }
  if (method === "cancel") {
    return finish(deps.ui, { status: "cancelled", method: null, version: null })
  }

  // No verified target means the official installer cannot be offered or run.
  if (!target) {
    deps.ui.error(
      "No verified Spicetify target version is known; refusing the official installer. " +
      "No files, PATH entries, or Spotify state were changed. Install manually and rerun setup.",
    )
    renderManualInstructions(deps.ui, { pin, target })
    return finish(deps.ui, {
      status: "failed",
      method: "official",
      version: null,
      detail: "No verified Spicetify target version is known; the official installer was refused.",
    })
  }

  renderOfficialInstallerExplanation(deps.ui, pin, { ...input, target }, { verbose: input.verbose === true })
  renderPlanPreview(deps.ui, officialInstallPlan(pin, target))

  const approval = await approveOfficialInstall(deps.prompt, pin, {
    dryRun: input.dryRun,
    nonInteractive: input.nonInteractive,
    target,
  })
  if (approval === "dry-run") {
    return finish(deps.ui, { status: "dry-run", method: "official", version: null })
  }
  if (approval === "unavailable") {
    return finish(deps.ui, {
      status: "failed",
      method: "official",
      version: null,
      detail: "No verified Spicetify target version is known; the official installer was refused.",
    })
  }
  if (approval === "confirmation-required") {
    return finish(deps.ui, { status: "confirmation-required", method: "official", version: null })
  }
  if (approval === "declined") {
    return finish(deps.ui, { status: "declined", method: "official", version: null })
  }

  if (!deps.installOfficial) {
    return finish(deps.ui, {
      status: "failed",
      method: "official",
      version: null,
      detail: "No install adapter was provided; refusing to report success.",
    })
  }

  let run: InstallRunResult
  try {
    run = await deps.installOfficial(pin)
  } catch (error) {
    const message = error instanceof Error ? error.message : "The installer adapter threw."
    return finish(deps.ui, {
      status: "failed",
      method: "official",
      version: null,
      detail: scrubDetail(message || "The installer adapter threw."),
    })
  }
  if (!run || typeof run.code !== "number" || run.code !== 0) {
    return finish(deps.ui, {
      status: "failed",
      method: "official",
      version: null,
      detail: scrubDetail(run?.detail ?? run?.stderr ?? "The installer adapter returned no result."),
    })
  }
  return finish(deps.ui, {
    status: "installed",
    method: "official",
    version: run.version ?? target,
  })
}
