// Uninstall presentation model.
//
// This module is deliberately pure presentation code: it never touches the
// file system, the OpenCode registry, or child processes. Callers supply
// detected (or mocked) inventory data, render the returned lists, and then
// execute only what the user explicitly approved.
//
// Contract (B09 uninstall screens):
//   * three-way selection: plugin-only / complete permanent removal / back;
//   * the destructive option is never the default;
//   * complete removal shows the exact deletion and preservation lists;
//   * complete removal requires typing UNINSTALL; BACK and CANCEL stay
//     available and empty input never confirms;
//   * partial failures report what is still on the machine, including steps
//     that were skipped after an earlier failure.
import type { Detection, Prompter, Ui } from "../types.ts"

/** Exact phrase required for complete permanent removal. */
export const UNINSTALL_CONFIRMATION_PHRASE = "UNINSTALL"

/** Invalid entries accepted before the consent loop gives up safely. */
export const COMPLETE_CONSENT_ATTEMPTS = 3

export type UninstallMode = "plugin-only" | "complete"
export type UninstallMenuSelection = UninstallMode | "back" | "cancelled"
export type CompleteRemovalConsent = "confirmed" | "back" | "cancelled"

/**
 * Everything the view needs to describe a removal accurately. `present`
 * values describe ownership, not merely whether a path exists: a registered
 * plugin entry or an installed bridge is what makes a component removable.
 */
export interface UninstallInventory {
  registration: { registered: boolean; spec: string | null }
  bridge: {
    installed: boolean
    extensionPath: string | null
    registered: boolean
    /** The bridge file exists even when detection did not claim ownership. */
    filePresent?: boolean
  }
  spicetify: { available: boolean; configPath: string | null; extensionsDir: string | null }
  credentials: { present: boolean; directory: string | null }
  backups: { present: boolean; directory: string | null }
  spotify: { installed: boolean }
  opencode: { configPath: string | null }
}

export interface DeletionItem {
  id: string
  label: string
  /** Exact path or config location, not a generic description. */
  target: string
  /** The target contains the signing secret or pinned Origin. */
  sensitive?: boolean
}

export interface PreservationItem {
  id: string
  label: string
  target?: string
  reason: string
  /** The preserved data may still contain an older signing secret. */
  containsSecrets?: boolean
}

export interface UninstallScope {
  mode: UninstallMode
  destructive: boolean
  title: string
  summary: string
  deletions: DeletionItem[]
  preservations: PreservationItem[]
  /** Components that cannot be removed automatically and need a manual check. */
  manualChecks: string[]
  warnings: string[]
  /** True when at least one owned component could not be located safely. */
  incomplete: boolean
}

export interface UninstallMenuChoice {
  label: string
  value: UninstallMenuSelection
  hint?: string
}

/**
 * Option 1 is safe by design. "Complete permanent removal" must never become
 * the pre-selected choice, even when it is the only option with work to do.
 */
export const DEFAULT_UNINSTALL_MENU_INDEX = 0

export const UNINSTALL_MENU_CHOICES: readonly UninstallMenuChoice[] = [
  {
    label: "Remove OpenCode Spotify only",
    value: "plugin-only",
    hint: "Remove the global registration and owned bridge. Keep credentials, pinned Origin and backups for a reinstall.",
  },
  {
    label: "Complete permanent removal",
    value: "complete",
    hint: "Restore Spotify and permanently remove plugin, credentials, Spicetify, Marketplace, themes, extensions and exact PATH entries. Requires typing UNINSTALL.",
  },
  {
    label: "Back",
    value: "back",
    hint: "Return without changing anything.",
  },
]

/** A fresh copy so callers cannot mutate the shared catalog. */
export function uninstallMenuChoices(): UninstallMenuChoice[] {
  return UNINSTALL_MENU_CHOICES.map((choice) => ({ ...choice }))
}

/**
 * Show the three-way selection. The Prompter owns the numbering and the
 * default; passing DEFAULT_UNINSTALL_MENU_INDEX keeps Back/complete from
 * becoming accidental defaults. EOF/invalid input maps to "cancelled" so a
 * caller can exit without treating it as approval.
 */
export async function selectUninstallMode(prompt: Prompter): Promise<UninstallMenuSelection> {
  const value = await prompt.choose(
    "What should be removed?",
    uninstallMenuChoices(),
    DEFAULT_UNINSTALL_MENU_INDEX,
  )
  if (value === "plugin-only" || value === "complete" || value === "back") return value
  return "cancelled"
}

/**
 * Adapt detected state to the view model. Credential and backup directories
 * are not part of Detection, so callers pass their resolved locations (and
 * whether backups exist). Defaults stay conservative: nothing is claimed
 * present unless detection says so.
 */
export function inventoryFromDetection(
  detection: Pick<Detection, "opencode" | "spicetify" | "bridge" | "spotify">,
  overrides: {
    credentialsDirectory?: string | null
    backupsDirectory?: string | null
    backupsPresent?: boolean
  } = {},
): UninstallInventory {
  const registration = detection.opencode.plugin
  const bridge = detection.bridge
  return {
    registration: {
      registered: registration.registered || registration.state === "registered",
      spec: registration.spec,
    },
    bridge: {
      installed: bridge.installed,
      extensionPath: bridge.extensionPath,
      registered: detection.spicetify.bridgeRegistered || bridge.registration === "current" || bridge.registration === "stale",
      filePresent: bridge.extensionExists,
    },
    spicetify: {
      available: detection.spicetify.available,
      configPath: detection.spicetify.configPath,
      extensionsDir: detection.spicetify.extensionsDir,
    },
    credentials: {
      present: bridge.configExists,
      directory: overrides.credentialsDirectory ?? null,
    },
    backups: {
      present: overrides.backupsPresent === true,
      directory: overrides.backupsDirectory ?? null,
    },
    spotify: { installed: detection.spotify.installed },
    opencode: { configPath: detection.opencode.configPath },
  }
}

const CREDENTIALS_FALLBACK = "%APPDATA%\\opencode-spotify"

function registrationTarget(inventory: UninstallInventory): string {
  const spec = inventory.registration.spec ?? "opencode-spotify"
  const config = inventory.opencode.configPath ?? "the OpenCode global config"
  return `${spec} in ${config}`
}

function isDestructive(mode: UninstallMode): boolean {
  return mode === "complete"
}

/** Parent directory of a file path, without importing node:path. */
function directoryOf(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "")
  const index = Math.max(normalized.lastIndexOf("\\"), normalized.lastIndexOf("/"))
  return index > 0 ? normalized.slice(0, index) : ""
}

/** True when `child` is the same path as, or nested under, `parent`. */
function isPathInside(child: string, parent: string): boolean {
  const normalize = (value: string) => value.replace(/[\\/]+/g, "\\").replace(/\\+$/, "").toLowerCase()
  const normalizedChild = normalize(child)
  const normalizedParent = normalize(parent)
  return normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}\\`)
}

/**
 * Build the exact scope shown before consent. Both modes list every owned
 * component that will be removed and everything that stays, so a user never
 * has to infer the blast radius from a sentence.
 */
export function buildUninstallScope(mode: UninstallMode, inventory: UninstallInventory): UninstallScope {
  const deletions: DeletionItem[] = []
  const manualChecks: string[] = []
  let incomplete = false

  if (inventory.registration.registered) {
    deletions.push({
      id: "global-registration",
      label: "Global OpenCode plugin registration",
      target: registrationTarget(inventory),
    })
  }

  if (inventory.bridge.installed) {
    deletions.push({
      id: "bridge-extension",
      label: "Owned Spicetify bridge extension",
      target: inventory.bridge.extensionPath ?? "opencode-spotify-bridge.js (path not resolved)",
    })
    if (!inventory.bridge.extensionPath) {
      incomplete = true
      manualChecks.push(
        `Locate opencode-spotify-bridge.js${inventory.spicetify.extensionsDir ? ` in ${inventory.spicetify.extensionsDir}` : " in the Spicetify Extensions directory"} and delete it manually.`,
      )
    }
  }

  if (inventory.bridge.registered) {
    if (inventory.spicetify.available && inventory.spicetify.configPath) {
      deletions.push({
        id: "spicetify-extension-entry",
        label: "Spicetify extensions entry",
        target: `opencode-spotify-bridge.js in ${inventory.spicetify.configPath}`,
      })
    } else {
      incomplete = true
      manualChecks.push(
        "Spicetify was not detected. Open config-xpui.ini and remove opencode-spotify-bridge.js from the extensions line manually, then run spicetify apply.",
      )
    }
  }

  // An unowned copy can still exist after a partial install or a manual copy.
  if (inventory.bridge.filePresent === true && !inventory.bridge.installed) {
    incomplete = true
    manualChecks.push(
      `An orphaned opencode-spotify-bridge.js is still present${inventory.bridge.extensionPath ? ` at ${inventory.bridge.extensionPath}` : inventory.spicetify.extensionsDir ? ` in ${inventory.spicetify.extensionsDir}` : " in the Spicetify Extensions directory"}. Delete it manually.`,
    )
  }

  if (mode === "complete" && inventory.credentials.present) {
    deletions.push({
      id: "bridge-credentials",
      label: "Bridge credentials and pinned Origin",
      target: inventory.credentials.directory ?? CREDENTIALS_FALLBACK,
      sensitive: true,
    })
  }

  const preservations: PreservationItem[] = [
    {
      id: "spotify",
      label: "Spotify desktop app and your library",
      reason: inventory.spotify.installed
        ? "Spotify stays installed; this installer never modifies or removes it."
        : "This installer never modifies or removes Spotify.",
    },
    {
      id: "opencode",
      label: "OpenCode itself and unrelated settings",
      ...(inventory.opencode.configPath ? { target: inventory.opencode.configPath } : {}),
      reason: "Only the opencode-spotify plugin entry is removed; the config file is kept.",
    },
  ]

  if (mode === "plugin-only") {
    preservations.push(
      {
        id: "spicetify",
        label: "Spicetify CLI and its installation",
        reason: "Spicetify is shared tooling, not owned by OpenCode Spotify.",
      },
      {
        id: "other-extensions",
        label: "Spicetify config, Marketplace, themes, extensions and custom apps",
        ...(inventory.spicetify.configPath ? { target: inventory.spicetify.configPath } : {}),
        reason: "Plugin-only removal edits only the opencode-spotify-bridge.js entry; Marketplace and other content stay installed.",
      },
      {
        id: "bridge-credentials",
        label: "Bridge credentials and pinned Origin",
        ...(inventory.credentials.directory ? { target: inventory.credentials.directory } : {}),
        reason: "Kept so a reinstall can reuse the same signing secret.",
        containsSecrets: true,
      },
    )
  }

  const backupsRemovedWithCredentials =
    mode === "complete" &&
    inventory.backups.present &&
    inventory.backups.directory !== null &&
    isPathInside(inventory.backups.directory, inventory.credentials.directory ?? CREDENTIALS_FALLBACK)

  const backupsRemovedWithSpicetify =
    mode === "complete" &&
    inventory.backups.present &&
    inventory.backups.directory !== null &&
    inventory.spicetify.configPath !== null &&
    isPathInside(inventory.backups.directory, directoryOf(inventory.spicetify.configPath))

  const backupsRemoved = backupsRemovedWithCredentials || backupsRemovedWithSpicetify

  if (inventory.backups.present && !backupsRemoved) {
    preservations.push({
      id: "backups",
      label: "Installer backups",
      ...(inventory.backups.directory ? { target: inventory.backups.directory } : {}),
      reason: "Kept so you can roll back config, bridge and credential changes.",
      containsSecrets: true,
    })
  }

  if (mode === "complete") {
    preservations.push({
      id: "package-cache",
      label: "npm/npx package cache",
      reason: "Shared by other packages; it is not owned data and is not deleted automatically.",
    })
    preservations.push({
      id: "unlisted-spicetify",
      label: "Spicetify files not listed under “Deletes exactly”",
      reason: "Program, config, Marketplace, themes, extensions and backups are deleted only when ownership and Spotify restore are verified; otherwise they stay and are reported.",
    })
  }

  const warnings: string[] = []
  if (mode === "plugin-only") {
    warnings.push("Credentials and the pinned Origin stay on disk so a reinstall can reuse the signing secret.")
    warnings.push("The Spicetify installation and its config, Marketplace, themes and extensions are kept.")
  } else {
    warnings.push(
      "Irreversible for every item listed under “Deletes exactly”: the signing secret and pinned Origin cannot be recovered after removal.",
    )
    warnings.push(
      "Spicetify-owned files are removed only when ownership and Spotify restore are verified; anything not listed under “Deletes exactly” is preserved.",
    )
  }
  if (inventory.backups.present && !backupsRemoved) {
    warnings.push("Preserved backups may contain an older signing secret. Delete them manually if you do not need rollback.")
  }
  if (backupsRemovedWithCredentials) {
    warnings.push(
      `Installer backups under ${inventory.backups.directory} are inside the credential directory and will be deleted by complete removal.`,
    )
  }
  if (backupsRemovedWithSpicetify && !backupsRemovedWithCredentials) {
    warnings.push(
      `Installer backups under ${inventory.backups.directory} are inside the Spicetify config directory and will be deleted by complete removal.`,
    )
  }
  if (manualChecks.length) {
    warnings.push("Removal is incomplete until the manual checks below are cleared; nothing was removed automatically for those items.")
  }
  if (!deletions.length) {
    warnings.push("Nothing to delete: no owned components were detected in this mode.")
  }

  return {
    mode,
    destructive: isDestructive(mode),
    title: mode === "complete" ? "Complete permanent removal" : "Remove OpenCode Spotify only",
    summary: mode === "complete"
      ? "Remove every component OpenCode Spotify owns, including the signing secret and pinned Origin. This cannot be undone."
      : "Remove only the global registration and the owned bridge. Credentials, pinned Origin and backups stay on disk.",
    deletions,
    preservations,
    manualChecks,
    warnings,
    incomplete,
  }
}

/**
 * Print the scope with literal "Deletes exactly:" / "Preserves:" headings.
 * Manual checks are separate from deletions because they are not performed
 * automatically and must not be presented as guaranteed removals.
 */
export function renderUninstallScope(ui: Ui, scope: UninstallScope): void {
  ui.section(scope.title)
  ui.line(`  ${scope.summary}`)
  ui.line("")
  ui.line("  Deletes exactly:")
  if (!scope.deletions.length) {
    ui.bullet("Nothing - no owned components were detected.")
  } else {
    for (const item of scope.deletions) ui.bullet(`${item.label}: ${item.target}`)
  }
  ui.line("")
  ui.line("  Preserves:")
  for (const item of scope.preservations) {
    const where = item.target ? ` (${item.target})` : ""
    ui.bullet(`${item.label}${where} - ${item.reason}`)
  }
  if (scope.manualChecks.length) {
    ui.line("")
    ui.line("  Manual checks (not removed automatically):")
    for (const check of scope.manualChecks) ui.bullet(check)
  }
  if (scope.warnings.length) {
    ui.line("")
    for (const warning of scope.warnings) ui.warn(warning)
  }
}

function consentQuestion(): string {
  return [
    "Complete permanent removal deletes the signing secret and cannot be undone.",
    `Type ${UNINSTALL_CONFIRMATION_PHRASE} to confirm, BACK to choose another option, or CANCEL to stop without changes.`,
  ].join("\n")
}

/**
 * Typed consent for complete permanent removal.
 *
 * Only the exact phrase (trimmed, case-sensitive) confirms. BACK returns to
 * the menu, empty input, CANCEL or EOF cancel, and invalid entries re-prompt
 * up to COMPLETE_CONSENT_ATTEMPTS times before giving up safely. The
 * destructive path is therefore never reached by pressing Enter.
 */
export async function confirmCompleteRemoval(
  prompt: Prompter,
  ui: Ui,
  scope?: UninstallScope,
): Promise<CompleteRemovalConsent> {
  if (scope) renderUninstallScope(ui, scope)

  for (let attempt = 0; attempt < COMPLETE_CONSENT_ATTEMPTS; attempt++) {
    const answer = await prompt.ask(consentQuestion())
    if (answer === undefined) {
      ui.warn("Cancelled. Nothing was removed.")
      return "cancelled"
    }
    const value = answer.trim()
    if (value === UNINSTALL_CONFIRMATION_PHRASE) return "confirmed"
    if (/^back$/i.test(value)) return "back"
    if (value === "" || /^cancel$/i.test(value)) {
      ui.warn("Cancelled. Nothing was removed.")
      return "cancelled"
    }
    ui.warn(`Type ${UNINSTALL_CONFIRMATION_PHRASE} exactly (uppercase), BACK, or CANCEL.`)
  }

  ui.warn(`Too many invalid entries. Cancelled safely; nothing was removed.`)
  return "cancelled"
}

/** What "back" or "cancel" looks like without running any removal step. */
export function renderUninstallExit(ui: Ui, outcome: "back" | "cancelled"): void {
  if (outcome === "back") {
    ui.warn("Returned to the uninstall menu. Nothing was removed.")
  } else {
    ui.warn("Uninstall cancelled. Nothing was removed.")
  }
}

export type UninstallComponentStatus = "removed" | "absent" | "failed" | "skipped"

export interface UninstallComponentResult {
  id: string
  label: string
  target?: string
  status: UninstallComponentStatus
  /** Sanitized failure reason supplied by the workflow. */
  detail?: string
}

export interface UninstallResult {
  mode: UninstallMode
  components: UninstallComponentResult[]
  /** Extra items that remain on disk by design (for example backups). */
  notes?: string[]
}

/** Failed and skipped components are still on the machine; never hide them. */
export function remainingComponents(result: UninstallResult): UninstallComponentResult[] {
  return result.components.filter((component) => component.status === "failed" || component.status === "skipped")
}

const MANUAL_HINTS: Record<string, string> = {
  "global-registration":
    "Run `opencode plugin remove <spec>` manually, then verify with `opencode plugin list`.",
  "bridge-extension":
    "Delete opencode-spotify-bridge.js from the Spicetify Extensions directory.",
  "spicetify-extension-entry":
    "Remove opencode-spotify-bridge.js from the extensions line in config-xpui.ini, then run `spicetify apply`.",
  "bridge-credentials":
    `Delete the credential directory (${CREDENTIALS_FALLBACK}) manually. It contains the signing secret and pinned Origin.`,
  "spicetify-program":
    "Uninstall or delete the Spicetify program directory manually (close Spotify first), then remove its exact user PATH entries.",
  "spicetify-path":
    "Remove only the Spicetify entries from the user PATH manually (Environment Variables), then reopen the terminal.",
  "spicetify-package":
    "Remove the Spicetify package with the same package manager that installed it, then verify it is gone.",
  "spicetify-data":
    "Delete the Spicetify local data and internal backup directory manually after the program is gone.",
  "spicetify-config":
    "Delete the Spicetify config directory (including Marketplace, themes and extensions) manually after the program removal is verified.",
  "spotify-restore":
    "Restore Spotify from a Spicetify backup or reinstall Spotify manually before retrying complete removal.",
}

export function manualHintFor(componentId: string): string {
  return MANUAL_HINTS[componentId] ??
    "Remove this component manually, then rerun the uninstall command to verify."
}

/**
 * What actually stays on disk, derived from the mode and outcome. Complete
 * removal deletes Spicetify (including Marketplace and internal backups) and
 * owned credentials, so it can never claim those were preserved.
 */
function keptSummary(result: UninstallResult): string {
  if (result.mode === "plugin-only") {
    const kept = [
      "credentials and pinned Origin (for reinstall)",
      "installer backups",
      "Spicetify including Marketplace, themes and extensions",
      "Spotify",
      "OpenCode itself",
    ]
    // Name a component that the outcome proves was kept (failed/skipped).
    for (const component of remainingComponents(result)) {
      if (!kept.includes(component.label)) kept.push(component.label)
    }
    return kept.join(", ")
  }
  return "Spotify, OpenCode itself, and your personal data"
}

function describeComponent(component: UninstallComponentResult): string {
  return component.target ? `${component.label} - ${component.target}` : component.label
}

/**
 * Render the outcome honestly. A single failure means the run is explicitly
 * incomplete: removed components are listed separately from everything that
 * still remains (failed and skipped), and each remaining component gets a
 * manual cleanup step.
 */
export function renderUninstallResult(ui: Ui, result: UninstallResult): void {
  ui.section("Uninstall result")

  if (!result.components.length) {
    ui.success("Nothing to remove: no OpenCode Spotify components were found.")
    ui.bullet(`Kept: ${keptSummary(result)}.`)
    // Preservation notes matter most when nothing was removed: a retry after a
    // partial removal may deliberately keep Spicetify state and backups.
    if (result.notes?.length) {
      for (const note of result.notes) ui.bullet(note)
    }
    return
  }

  for (const component of result.components) {
    switch (component.status) {
      case "removed":
        ui.success(`Removed ${describeComponent(component)}`)
        break
      case "absent":
        ui.status("info", `Already absent: ${component.label}`)
        break
      case "failed":
        ui.error(`Could not remove ${describeComponent(component)}`)
        if (component.detail) ui.line(`   Reason: ${component.detail}`)
        break
      case "skipped":
        ui.warn(`Not attempted: ${describeComponent(component)}`)
        if (component.detail) ui.line(`   Reason: ${component.detail}`)
        break
    }
  }

  const remaining = remainingComponents(result)

  if (!remaining.length) {
    ui.success(
      result.mode === "complete"
        ? "Complete removal finished: no OpenCode Spotify components remain on this machine."
        : "OpenCode Spotify registration and owned bridge were removed.",
    )
    ui.bullet(`Kept: ${keptSummary(result)}.`)
    if (result.mode === "complete") {
      const spicetifyRemoved = result.components.some(
        (component) => component.id.startsWith("spicetify-") && (component.status === "removed" || component.status === "absent"),
      )
      if (spicetifyRemoved) {
        ui.bullet("Spicetify program/config/Marketplace/themes/extensions and internal backups were removed with complete removal.")
      }
    }
  } else {
    ui.error(`Removal is incomplete: ${remaining.length} component(s) remain on this machine.`)
    ui.kv("Removed", result.components.filter((c) => c.status === "removed" || c.status === "absent").map((c) => c.label).join(", ") || "none")
    ui.kv("Remaining", remaining.map((c) => c.label).join(", "))
    ui.section("Still present")
    for (const component of remaining) {
      const suffix = component.status === "skipped" ? " (not attempted)" : ""
      ui.status(component.status === "failed" ? "fail" : "warn", `${describeComponent(component)}${suffix}`)
    }
    ui.section("Manual cleanup")
    for (const component of remaining) {
      ui.bullet(manualHintFor(component.id))
    }
    if (result.mode === "complete" && remaining.some((c) => c.id === "bridge-credentials")) {
      ui.error("The signing secret and pinned Origin may still be on disk. Remove the credential directory before treating removal as complete.")
    }
    ui.warn("OpenCode Spotify is not fully removed. Only components marked removed above are gone.")
  }

  if (result.notes?.length) {
    ui.line("")
    for (const note of result.notes) ui.bullet(note)
  }
}
