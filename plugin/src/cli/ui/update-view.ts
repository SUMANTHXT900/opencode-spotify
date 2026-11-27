// Update screens.
//
// Presentation only: every version comparison, channel decision, downgrade
// guard, and update target is computed by the backend (`update-plan.ts`).
// This module renders the backend's verdicts, asks for a selection and plan
// consent, and prints the final summary. It never compares versions itself,
// so passing an "outdated" status with any target strings renders an update
// exactly as reported.
import type {
  Detection,
  InstallOwner,
  PlanStep,
  Prompter,
  Ui,
  VersionInfo,
} from "../types.ts"
import type { PluginUpdateInfo, PluginUpdateStatus, UpdateAvailability } from "../update-plan.ts"

// Mirrors the canonical values in spicetify.ts. Kept local so this screen
// module has no backend runtime imports; the guidance test pins the command
// and docs URL strings.
const SPICETIFY_DOCS_URL = "https://spicetify.app/docs/getting-started"
const SPICETIFY_WINGET_ID = "Spicetify.Spicetify"

// ---------------------------------------------------------------------------
// View model
// ---------------------------------------------------------------------------

export type SpicetifyUpdateStatus = UpdateAvailability["spicetify"]

export interface PluginUpdateView {
  /** Backend channel verdict; the UI never re-derives this. */
  status: PluginUpdateStatus
  installed: string | null
  /** Backend-selected install target, non-null only for update-available. */
  target: string | null
  /** Backend-reported registry latest, for context only. */
  latest: string | null
  stable: string | null
  beta: string | null
  local: boolean
  registrationState: "registered" | "absent" | "unknown"
  /** Sanitized registry error from the backend. */
  error?: string
}

export interface SpicetifyUpdateView {
  /** Backend availability verdict; the UI never re-derives this. */
  status: SpicetifyUpdateStatus
  installed: string | null
  /** Backend-reported available version, when an update applies. */
  target: string | null
  latest: string | null
  owner: InstallOwner
  /** True when installed from the verified GitHub release zip. */
  verifiedInstall: boolean
  error?: string
}

export interface BridgeUpdateView {
  installed: boolean
  registration: "absent" | "current" | "stale" | "unknown"
  credentialValid: boolean
}

export interface UpdateViewModel {
  plugin: PluginUpdateView
  spicetify: SpicetifyUpdateView
  bridge: BridgeUpdateView
}

export interface UpdateViewModelInput {
  detection: Detection
  versions: { plugin: VersionInfo; spicetify: VersionInfo }
  /** Result of describePluginUpdate(); never recomputed here. */
  pluginUpdate: PluginUpdateInfo
  /** Result of updateAvailability().spicetify; never recomputed here. */
  spicetifyStatus: SpicetifyUpdateStatus
  /** True when the verified-release marker is present. */
  verifiedSpicetifyInstall?: boolean
}

/**
 * Map backend results into the display model. Installed versions come from
 * detection; availability comes from the backend verdicts passed in.
 */
export function createUpdateViewModel(input: UpdateViewModelInput): UpdateViewModel {
  const plugin = input.detection.opencode.plugin
  const spicetify = input.detection.spicetify
  const spicetifyLatest = input.versions.spicetify.latest
  const pluginInstalled = plugin.version ?? input.versions.plugin.installed ?? null
  const spicetifyInstalled = spicetify.available ? spicetify.version : null
  // "current" is only meaningful when both sides of the comparison are known.
  // Never echo a backend "current" when nothing installed could be inspected.
  const pluginStatus = !pluginInstalled && input.pluginUpdate.status === "current"
    ? "unknown"
    : input.pluginUpdate.status
  const spicetifyStatus = !spicetifyInstalled && input.spicetifyStatus === "current"
    ? "unknown"
    : input.spicetifyStatus
  return {
    plugin: {
      status: pluginStatus,
      installed: pluginInstalled,
      target: pluginStatus === "update-available" ? input.pluginUpdate.target : null,
      latest: input.versions.plugin.latest,
      stable: input.pluginUpdate.stable,
      beta: input.pluginUpdate.beta,
      local: plugin.local,
      registrationState: plugin.state ?? (plugin.registered ? "registered" : "absent"),
      ...(input.versions.plugin.error ? { error: input.versions.plugin.error } : {}),
    },
    spicetify: {
      status: spicetifyStatus,
      installed: spicetifyInstalled,
      target: spicetifyStatus === "outdated" ? spicetifyLatest : null,
      latest: spicetifyLatest,
      owner: spicetify.owner,
      verifiedInstall: input.verifiedSpicetifyInstall === true,
      ...(input.versions.spicetify.error ? { error: input.versions.spicetify.error } : {}),
    },
    bridge: {
      installed: input.detection.bridge.installed,
      registration: input.detection.bridge.registration,
      credentialValid: input.detection.bridge.credentialValid,
    },
  }
}

// ---------------------------------------------------------------------------
// Owner-specific Spicetify guidance
// ---------------------------------------------------------------------------

export type SpicetifyOwnerCategory = "official" | "manager" | "unknown"

export function spicetifyOwnerCategory(_owner: InstallOwner): SpicetifyOwnerCategory {
  // Official-installer-only policy: every owner (including legacy manager
  // copies and unknown) migrates through the pinned official installer.
  return "official"
}

export function spicetifyOwnerLabel(owner: InstallOwner): string {
  switch (owner) {
    case "script": return "official installer"
    case "winget": return "winget"
    case "scoop": return "Scoop"
    case "choco": return "Chocolatey"
    default: return "unknown owner"
  }
}

export interface SpicetifyGuidance {
  owner: InstallOwner
  category: SpicetifyOwnerCategory
  method: string
  /** Exact update command when one can be stated safely; null otherwise. */
  command: string | null
  lines: string[]
  warning?: string
}

/**
 * Official-installer-only upgrade guidance. Every owner (including legacy
 * manager copies and unknown) migrates through the pinned official installer
 * to the latest stable release; manager commands are never shown and no
 * owner is refused.
 */
export function spicetifyUpdateGuidance(
  owner: InstallOwner,
  _options: { verifiedInstall?: boolean } = {},
): SpicetifyGuidance {
  return {
    owner,
    category: "official",
    method: "official installer (legacy copies migrate; no second copy)",
    command: null,
    lines: [
      "Spicetify installs and updates via the pinned official installer to the latest stable release.",
      "Legacy manager copies (winget/Scoop/Chocolatey) migrate to the official pipeline; no second copy is installed and managers are not mixed.",
      "The Spicetify Marketplace installs by default (skip with --no-marketplace).",
      `Docs: ${SPICETIFY_DOCS_URL}`,
    ],
  }
}

export function renderSpicetifyGuidance(ui: Ui, guidance: SpicetifyGuidance): void {
  ui.section("Spicetify update guidance")
  ui.kv("Install owner", spicetifyOwnerLabel(guidance.owner))
  ui.kv("Upgrade method", guidance.method)
  if (guidance.command) ui.kv("Command", guidance.command)
  for (const line of guidance.lines) ui.bullet(line)
  if (guidance.warning) ui.warn(guidance.warning)
}

// ---------------------------------------------------------------------------
// Availability display
// ---------------------------------------------------------------------------

export function pluginAvailabilityLine(view: PluginUpdateView): string {
  const installed = view.installed ?? "unknown"
  switch (view.status) {
    case "update-available":
      return view.target
        ? `${installed} -> ${view.target}`
        : `${installed} (update target unavailable; no install will run)`
    case "current": {
      if (!view.installed) return "not installed or version unknown (state unknown)"
      const betaNote = view.beta && view.beta !== view.installed ? `; beta ${view.beta} published` : ""
      return `${installed} (current${betaNote})`
    }
    case "registry-older":
      return `${installed} (registry reports ${view.latest ?? "an older tag"}; downgrades are never automatic)`
    case "not-installed":
      return "not registered (run `opencode-spotify setup`)"
    case "unknown":
    default:
      return `${installed} (available version unknown)`
  }
}

export function spicetifyAvailabilityLine(view: SpicetifyUpdateView): string {
  const installed = view.installed ?? "not detected"
  const owner = spicetifyOwnerLabel(view.owner)
  switch (view.status) {
    case "outdated": {
      const target = view.target ?? view.latest
      return target
        ? `${installed} -> ${target} (${owner})`
        : `${installed} (update target unknown; no automatic upgrade)`
    }
    case "current":
      return view.installed
        ? `${installed} (current; ${owner})`
        : "not detected (state unknown)"
    case "downgrade":
      return `${installed} (registry reports ${view.latest ?? "an older tag"}; downgrade disabled)`
    case "unknown":
    default:
      return view.installed ? `${installed} (available version unknown; ${owner})` : "not detected"
  }
}

export function bridgeAvailabilityLine(bridge: BridgeUpdateView): string {
  if (!bridge.installed) {
    return bridge.registration === "unknown" ? "not installed (state unknown)" : "not installed"
  }
  if (bridge.registration === "current") return "installed; registration current"
  if (bridge.registration === "stale") return "installed; registration stale (repair needed)"
  if (bridge.registration === "absent") return "installed; not registered (repair needed)"
  return "installed; registration unknown (repair recommended)"
}

export interface UpdateOverviewOptions {
  allowSpicetifyUpgrade?: boolean
  offline?: boolean
}

export function renderUpdateOverview(ui: Ui, model: UpdateViewModel, options: UpdateOverviewOptions = {}): void {
  ui.section("Update check")
  ui.kv("OpenCode Spotify", pluginAvailabilityLine(model.plugin))
  ui.kv("Spicetify", spicetifyAvailabilityLine(model.spicetify))
  ui.kv("Bridge", bridgeAvailabilityLine(model.bridge))

  if (model.plugin.local) {
    ui.warn("The registered plugin is a local development path. Updates never replace it without an explicit choice.")
  }
  if (model.plugin.status === "registry-older") {
    ui.warn(
      `The registry reports ${model.plugin.latest ?? "an older tag"}, which is older than installed ${model.plugin.installed ?? "unknown"}. Downgrades are never automatic.`,
    )
  }
  if (model.plugin.status === "update-available" && !model.plugin.target) {
    ui.warn("The backend reported an update but selected no install target; no install will run.")
  }
  if (model.plugin.error) ui.warn(`Plugin version check: ${model.plugin.error}`)
  if (model.spicetify.error) ui.warn(`Spicetify version check: ${model.spicetify.error}`)
  if (model.spicetify.status === "outdated") {
    ui.line("  Spicetify updates through the pinned official installer (legacy copies migrate; no second copy).")
    ui.line("  The Marketplace installs by default (skip with --no-marketplace).")
    if (!options.allowSpicetifyUpgrade) {
      ui.line("  Spicetify upgrades need a separate confirmation (or --allow-spicetify-upgrade).")
    }
  }
  if (options.offline) {
    ui.warn("Offline mode: registry versions were not queried; update availability is unknown.")
  }
}

// ---------------------------------------------------------------------------
// Current-version / no-update states
// ---------------------------------------------------------------------------

export interface UpdateReadiness {
  status: "blocked" | "current" | "update-available"
  code: 0 | 1
  message?: string
  /** Secondary advice, rendered as a warning. */
  hint?: string
  /** A plugin-only/no-update run must still synchronize the owned bridge. */
  bridgeRepairRequired: boolean
  /** A Spicetify-only update is available and has a known owner. */
  spicetifyUpdateAvailable: boolean
}

export type UpdateReadinessView = UpdateReadiness

function bridgeNeedsRepair(bridge: BridgeUpdateView): boolean {
  return !bridge.installed || bridge.registration !== "current"
}

/**
 * Classify the backend verdict into what the screen should say. No version
 * ordering happens here: each branch trusts the supplied status verbatim.
 */
export function updateReadiness(model: UpdateViewModel): UpdateReadinessView {
  const repair = bridgeNeedsRepair(model.bridge)
  const shared = {
    bridgeRepairRequired: repair,
    spicetifyUpdateAvailable: spicetifyUpgradable(model),
  }
  const plugin = model.plugin

  if (plugin.local) {
    return {
      status: "blocked",
      code: 1,
      message: "The registered plugin is a local development path. Run `opencode-spotify setup` to switch deliberately; updates never replace it.",
      ...shared,
    }
  }
  if (plugin.registrationState === "unknown") {
    return {
      status: "blocked",
      code: 1,
      message: "Plugin registration state is unknown (inspection failed). Rerun `opencode-spotify doctor`; no changes were made.",
      hint: "No blind retry is attempted while the registration state is unknown.",
      ...shared,
    }
  }
  if (plugin.status === "not-installed" || !plugin.installed) {
    return {
      status: "blocked",
      code: 1,
      message: "The plugin is not registered globally. Run `opencode-spotify setup` first.",
      ...shared,
    }
  }
  if (plugin.status === "registry-older") {
    return {
      status: "blocked",
      code: 1,
      message: `The registry reports ${plugin.latest ?? "an older version"}, which is older than installed ${plugin.installed}. Downgrades are never automatic.`,
      ...shared,
    }
  }
  if (plugin.status === "unknown") {
    return {
      status: "blocked",
      code: 1,
      message: `No published version could be determined${plugin.error ? `: ${plugin.error}` : "."}`,
      hint: "Use `--offline` only for diagnostics. Retry when the npm registry is reachable.",
      ...shared,
    }
  }
  if (plugin.status === "update-available" && !plugin.target) {
    return {
      status: "blocked",
      code: 1,
      message: "The backend reported an update but selected no install target. No changes were made.",
      hint: "Rerun `opencode-spotify status` or retry when registry metadata is complete.",
      ...shared,
    }
  }
  if (plugin.status === "update-available") {
    return {
      status: "update-available",
      code: 0,
      message: `OpenCode Spotify ${plugin.installed} -> ${plugin.target} is available.`,
      ...shared,
    }
  }

  const note = model.spicetify.status === "outdated" && model.spicetify.target
    ? `Spicetify ${model.spicetify.target} is available; it is not included in a plugin-only update.`
    : undefined
  return {
    status: "current",
    code: 0,
    message: `OpenCode Spotify ${plugin.installed} is current.`,
    ...(note ? { hint: note } : {}),
    ...shared,
  }
}

/**
 * Render the verdict. Returns the same readiness object so the caller can
 * branch (exit code, bridge-repair continuation) without re-deriving state.
 */
export function renderUpdateReadiness(ui: Ui, readiness: UpdateReadinessView): UpdateReadinessView {
  if (readiness.status === "blocked") {
    ui.error(readiness.message ?? "The update cannot continue.")
    if (readiness.hint) ui.warn(readiness.hint)
    return readiness
  }
  if (readiness.status === "current") {
    ui.success(readiness.message ?? "Everything is current.")
    if (readiness.hint) ui.warn(readiness.hint)
    if (readiness.bridgeRepairRequired) {
      ui.warn("The bridge still needs repair; continuing with the repair step.")
    }
    return readiness
  }
  ui.status("info", readiness.message ?? "An update is available.")
  return readiness
}

/** Overview + state verdict in one call. */
export function renderUpdateScreen(
  ui: Ui,
  model: UpdateViewModel,
  options: UpdateOverviewOptions = {},
): UpdateReadinessView {
  renderUpdateOverview(ui, model, options)
  return renderUpdateReadiness(ui, updateReadiness(model))
}

// ---------------------------------------------------------------------------
// Update selection
// ---------------------------------------------------------------------------

export type UpdateSelection = "plugin" | "both" | "spicetify" | "cancel"

export interface UpdateChoice {
  value: UpdateSelection
  label: string
}

export interface UpdateSelectionOptions {
  /** Combined/Spicetify upgrades require explicit backend authorization. */
  allowSpicetifyUpgrade?: boolean
  question?: string
}

function spicetifyUpgradable(model: UpdateViewModel): boolean {
  // Official-installer-only: every outdated copy (including unknown owners)
  // is upgradable through the pinned official installer.
  return model.spicetify.status === "outdated" &&
    !!(model.spicetify.target ?? model.spicetify.latest)
}

/**
 * Build the choices from backend statuses. "both" is offered whenever both
 * updates exist; when the caller has not pre-authorized Spicetify, the label
 * says so and selecting it is the interactive authorization the caller must
 * persist before invoking the backend. All owners upgrade through the
 * official installer (legacy copies migrate; no manager commands).
 */
export function updateSelectionChoices(
  model: UpdateViewModel,
  options: UpdateSelectionOptions = {},
): UpdateChoice[] {
  const pluginAvailable = model.plugin.status === "update-available" && !!model.plugin.target
  const spicetifyAvailable = spicetifyUpgradable(model)
  const allowed = options.allowSpicetifyUpgrade === true
  const pluginTarget = `${model.plugin.installed ?? "unknown"} -> ${model.plugin.target ?? "unknown"}`
  const spicetifyTarget = `${model.spicetify.installed ?? "unknown"} -> ${model.spicetify.target ?? model.spicetify.latest ?? "unknown"}`

  const choices: UpdateChoice[] = []
  if (pluginAvailable && spicetifyAvailable) {
    const suffix = allowed ? "" : "; combined authorization required"
    choices.push({
      value: "both",
      label: `Update OpenCode Spotify and Spicetify (${pluginTarget}; Spicetify ${spicetifyTarget} via official installer)${suffix}`,
    })
  }
  if (pluginAvailable) {
    choices.push({ value: "plugin", label: `Update OpenCode Spotify only (${pluginTarget})` })
  }
  if (spicetifyAvailable) {
    const suffix = allowed ? "" : "; separate confirmation required"
    choices.push({
      value: "spicetify",
      label: `Update Spicetify only (${spicetifyTarget}) via official installer${suffix}`,
    })
  }
  choices.push({ value: "cancel", label: "Cancel without changing anything" })
  return choices
}

function selectionQuestion(model: UpdateViewModel, choices: UpdateChoice[]): string {
  const plugin = model.plugin.status === "update-available" && !!model.plugin.target
  const spicetify = spicetifyUpgradable(model)
  if (plugin && spicetify && choices.some((choice) => choice.value === "both")) {
    return "Updates are available for OpenCode Spotify and Spicetify."
  }
  if (plugin) return `An update is available for OpenCode Spotify (${model.plugin.installed ?? "unknown"} -> ${model.plugin.target}).`
  if (spicetify) {
    return `An update is available for Spicetify (${model.spicetify.installed ?? "unknown"} -> ${model.spicetify.target ?? model.spicetify.latest ?? "unknown"}).`
  }
  return "No supported update is available."
}

export function renderUpdateSelection(
  ui: Ui,
  model: UpdateViewModel,
  options: UpdateSelectionOptions = {},
): void {
  ui.section("Update selection")
  if (model.spicetify.status === "outdated") {
    ui.kv("Spicetify owner", spicetifyOwnerLabel(model.spicetify.owner))
    ui.line("  Spicetify updates through the pinned official installer (legacy copies migrate; no second copy).")
    if (model.spicetify.verifiedInstall) {
      ui.line("  This Spicetify uses the verified-release flow; the unverified self-updater is not used.")
    }
    if (!options.allowSpicetifyUpgrade) {
      ui.line("  Spicetify upgrades need a separate confirmation (or --allow-spicetify-upgrade).")
    }
  }
}

/**
 * Show the selection screen and return the chosen action. Cancelled or closed
 * prompts normalize to "cancel"; no-update models do not prompt at all.
 */
export async function promptUpdateSelection(
  ui: Ui,
  prompt: Prompter,
  model: UpdateViewModel,
  options: UpdateSelectionOptions = {},
): Promise<UpdateSelection> {
  renderUpdateSelection(ui, model, options)
  const choices = updateSelectionChoices(model, options)
  if (!choices.some((choice) => choice.value !== "cancel")) {
    ui.success("No supported update is available; nothing will be changed.")
    return "cancel"
  }
  const selected = await prompt.choose(options.question ?? selectionQuestion(model, choices), choices)
  const match = choices.find((choice) => choice.value === selected)
  return match?.value ?? "cancel"
}

// ---------------------------------------------------------------------------
// Plan presentation and confirmation
// ---------------------------------------------------------------------------

export interface UpdatePlanStep {
  id: string
  description: string
  mutates: boolean
}

export interface UpdatePlan {
  title: string
  steps: UpdatePlanStep[]
}

/** Strip executable callbacks; the view only ever sees the plan description. */
export function toUpdatePlan(
  title: string,
  steps: Array<Pick<PlanStep, "id" | "description" | "mutates">>,
): UpdatePlan {
  return {
    title,
    steps: steps.map((step) => ({ id: step.id, description: step.description, mutates: step.mutates })),
  }
}

export function renderUpdatePlan(ui: Ui, plan: UpdatePlan): void {
  ui.section(plan.title)
  if (!plan.steps.length) {
    ui.status("info", "Nothing to do.")
    return
  }
  plan.steps.forEach((step, index) => {
    ui.bullet(`${index + 1}. ${step.description}${step.mutates ? "" : " (verification only)"}`)
  })
}

export type UpdatePlanConsent = "approved" | "declined" | "confirmation-required" | "dry-run"

export interface UpdatePlanConsentOptions {
  yes: boolean
  nonInteractive: boolean
  dryRun?: boolean
  /** Caller already obtained consent for this exact plan. */
  approved?: boolean
  /** Ask even when --yes was supplied (separate apply consent). */
  force?: boolean
  question?: string
  defaultYes?: boolean
  phrase?: string
}

/**
 * Mirror executePlan()'s consent rules: read-only plans never prompt,
 * dry-run never prompts and never mutates, --yes satisfies consent unless a
 * separate (forced) consent is required, and noninteractive never guesses.
 */
export async function confirmUpdatePlan(
  prompt: Prompter,
  plan: UpdatePlan,
  options: UpdatePlanConsentOptions,
): Promise<UpdatePlanConsent> {
  if (!plan.steps.length) return "approved"
  if (options.dryRun) return "dry-run"
  const mutates = plan.steps.some((step) => step.mutates)
  if (!mutates) return "approved"
  const needsPrompt = !options.approved && (options.force === true || !options.yes)
  if (!needsPrompt) return "approved"
  if (options.nonInteractive) return "confirmation-required"
  const approved = await prompt.confirm(options.question ?? "Apply this plan?", {
    defaultYes: options.defaultYes === true,
    ...(options.phrase ? { phrase: options.phrase } : {}),
  })
  return approved ? "approved" : "declined"
}

/** Plan screen + consent in one call, including the dry-run presentation. */
export async function presentUpdatePlan(
  ui: Ui,
  prompt: Prompter,
  plan: UpdatePlan,
  options: UpdatePlanConsentOptions,
): Promise<UpdatePlanConsent> {
  renderUpdatePlan(ui, plan)
  if (!plan.steps.length) return "approved"
  if (options.dryRun) {
    for (const step of plan.steps) ui.dryRun(step.description)
    ui.line("  Dry run: no changes were made.")
    return "dry-run"
  }
  const consent = await confirmUpdatePlan(prompt, plan, options)
  if (consent === "declined") {
    ui.warn("Cancelled. No steps in this plan were run.")
  } else if (consent === "confirmation-required") {
    ui.error("Confirmation required in noninteractive mode; no changes were made.")
  }
  return consent
}

// ---------------------------------------------------------------------------
// Final summary
// ---------------------------------------------------------------------------

export interface UpdateSummaryInput {
  plugin: {
    installed: string | null
    target: string | null
    changed: boolean
    /** Registration verified at the requested target. */
    verified?: boolean
  }
  spicetify: {
    version: string | null
    changed: boolean
    owner?: InstallOwner
  }
  bridge: {
    synchronized: boolean
    applied: boolean
    pending: boolean
  }
  warnings?: string[]
  nextSteps?: string[]
}

export interface UpdateSummary {
  plugin: string
  bridge: string
  spicetify: string
  warnings: string[]
  nextSteps: string[]
}

export function createUpdateSummary(input: UpdateSummaryInput): UpdateSummary {
  const plugin = input.plugin.changed
    ? `updated${input.plugin.target ? ` to ${input.plugin.target}` : ""}${input.plugin.verified ? " (verified)" : ""}`
    : input.plugin.installed ? `unchanged (${input.plugin.installed})` : "unchanged"

  const bridge = input.bridge.pending
    ? "prepared; apply pending"
    : input.bridge.applied
      ? "synchronized and applied"
      : input.bridge.synchronized
        ? "synchronized"
        : "already current"

  const ownerLabel = input.spicetify.owner ? spicetifyOwnerLabel(input.spicetify.owner) : null
  const spicetify = input.spicetify.changed
    ? `updated${input.spicetify.version ? ` to ${input.spicetify.version}` : ""}${ownerLabel ? ` (${ownerLabel})` : ""}`
    : input.spicetify.version
      ? `unchanged (${input.spicetify.version}${ownerLabel ? `, ${ownerLabel}` : ""})`
      : "unchanged"

  const nextSteps = [...(input.nextSteps ?? [
    input.plugin.changed
      ? "Restart running OpenCode processes to load the updated plugin (or run `opencode service restart`)."
      : "Restart running OpenCode processes if the bridge was re-applied (or run `opencode service restart`).",
    "Playback is not verified by this command.",
  ])]
  if (input.bridge.pending) {
    nextSteps.unshift("Run `spicetify apply` (or rerun update with --apply) to activate the prepared bridge.")
  }

  return {
    plugin,
    bridge,
    spicetify,
    warnings: [...(input.warnings ?? [])],
    nextSteps,
  }
}

export function renderUpdateSummary(ui: Ui, summary: UpdateSummary): void {
  ui.section("Update summary")
  ui.kv("Plugin", summary.plugin)
  ui.kv("Bridge", summary.bridge)
  ui.kv("Spicetify", summary.spicetify)
  for (const warning of summary.warnings) ui.warn(warning)
  if (summary.nextSteps.length) ui.line("")
  for (const step of summary.nextSteps) ui.bullet(step)
}
