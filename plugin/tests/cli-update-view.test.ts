import { test } from "node:test"
import assert from "node:assert/strict"
import {
  bridgeAvailabilityLine,
  confirmUpdatePlan,
  createUpdateSummary,
  createUpdateViewModel,
  pluginAvailabilityLine,
  presentUpdatePlan,
  promptUpdateSelection,
  renderSpicetifyGuidance,
  renderUpdateOverview,
  renderUpdatePlan,
  renderUpdateScreen,
  renderUpdateSummary,
  spicetifyAvailabilityLine,
  spicetifyOwnerCategory,
  spicetifyOwnerLabel,
  spicetifyUpdateGuidance,
  toUpdatePlan,
  updateReadiness,
  updateSelectionChoices,
} from "../src/cli/ui/update-view.ts"
import type {
  BridgeUpdateView,
  PluginUpdateView,
  SpicetifyUpdateView,
  UpdatePlan,
  UpdateViewModel,
} from "../src/cli/ui/update-view.ts"
// Canonical Spicetify values, mirrored by the view's display constants.
const SPICETIFY_MANUAL_URL = "https://spicetify.app/docs/getting-started"
const SPICETIFY_WINGET_ID = "Spicetify.Spicetify"
import { fakeDetection, fakePrompt, fakeRuntime, fakeUi } from "./cli-fixture.ts"
import type { Prompter } from "../src/cli/types.ts"

function model(overrides: {
  plugin?: Partial<PluginUpdateView>
  spicetify?: Partial<SpicetifyUpdateView>
  bridge?: Partial<BridgeUpdateView>
} = {}): UpdateViewModel {
  return {
    plugin: {
      status: "update-available",
      installed: "0.5.7",
      target: "0.6.0",
      latest: "0.6.0",
      stable: "0.6.0",
      beta: null,
      local: false,
      registrationState: "registered",
      ...overrides.plugin,
    },
    spicetify: {
      status: "outdated",
      installed: "2.46.7",
      target: "2.47.0",
      latest: "2.47.0",
      owner: "winget",
      verifiedInstall: false,
      ...overrides.spicetify,
    },
    bridge: {
      installed: true,
      registration: "current",
      credentialValid: true,
      ...overrides.bridge,
    },
  }
}

const plan: UpdatePlan = {
  title: "Update plan",
  steps: [
    { id: "update-registration", description: "Replace the global registration with the update target", mutates: true },
    { id: "verify-registration", description: "Verify the registration at the requested version", mutates: false },
  ],
}

// ---------------------------------------------------------------------------
// Backend mapping and installed-vs-available display
// ---------------------------------------------------------------------------

test("view model takes installed versions from detection and availability from backend verdicts", () => {
  const runtime = fakeRuntime()
  const base = fakeDetection(runtime)
  const detection = fakeDetection(runtime, {
    spicetify: { ...base.spicetify, owner: "winget" },
  })
  const view = createUpdateViewModel({
    detection,
    versions: {
      plugin: { installed: "0.6.0-beta.1", latest: "0.6.0", latestBeta: "0.6.0-beta.2" },
      spicetify: { installed: "2.46.7", latest: "2.47.0" },
    },
    pluginUpdate: {
      status: "update-available",
      target: "0.6.0",
      stable: "0.6.0",
      beta: "0.6.0-beta.2",
      stableMissing: false,
    },
    spicetifyStatus: "outdated",
  })

  assert.equal(view.plugin.installed, "0.6.0-beta.1")
  assert.equal(view.plugin.target, "0.6.0")
  assert.equal(view.plugin.status, "update-available")
  assert.equal(view.spicetify.installed, "2.46.7")
  assert.equal(view.spicetify.target, "2.47.0")
  assert.equal(view.spicetify.owner, "winget")
  assert.equal(view.bridge.registration, "current")

  // target is populated from the backend status, not by re-reading versions.
  const current = createUpdateViewModel({
    detection,
    versions: {
      plugin: { installed: "0.6.0-beta.1", latest: "0.6.0" },
      spicetify: { installed: "2.46.7", latest: "2.47.0" },
    },
    pluginUpdate: { status: "current", target: null, stable: "0.6.0", beta: null, stableMissing: false },
    spicetifyStatus: "current",
  })
  assert.equal(current.plugin.target, null)
  assert.equal(current.spicetify.target, null)
})

test("unknown states are never rendered as current", () => {
  const unknown = model({
    plugin: { status: "current", target: null, installed: null, latest: null },
    spicetify: { status: "current", target: null, installed: null, latest: null },
  })
  assert.match(pluginAvailabilityLine(unknown.plugin), /state unknown/)
  assert.doesNotMatch(pluginAvailabilityLine(unknown.plugin), /\(current/)
  assert.match(spicetifyAvailabilityLine(unknown.spicetify), /state unknown/)
  assert.doesNotMatch(spicetifyAvailabilityLine(unknown.spicetify), /\(current/)

  const unknownSpicetify = model({
    plugin: { status: "current", target: null, installed: "0.6.0" },
    spicetify: { status: "unknown", target: null, installed: "2.46.7", latest: null },
  })
  assert.match(spicetifyAvailabilityLine(unknownSpicetify.spicetify), /available version unknown/)
  assert.doesNotMatch(spicetifyAvailabilityLine(unknownSpicetify.spicetify), /\(current/)

  // A backend "current" verdict with no installed version to compare is
  // normalized to unknown instead of claiming currency.
  const runtime = fakeRuntime()
  const base = fakeDetection(runtime)
  const detection = {
    ...base,
    opencode: {
      ...base.opencode,
      plugin: { ...base.opencode.plugin, version: null, registered: false },
    },
    spicetify: { ...base.spicetify, available: false, version: null },
  }
  const view = createUpdateViewModel({
    detection,
    versions: {
      plugin: { installed: null, latest: "0.7.0" },
      spicetify: { installed: null, latest: "2.48.0" },
    },
    pluginUpdate: { status: "current", target: null, stable: "0.7.0", beta: null, stableMissing: false },
    spicetifyStatus: "current",
  })
  assert.equal(view.plugin.status, "unknown")
  assert.equal(view.spicetify.status, "unknown")
  assert.equal(view.spicetify.target, null)
})

test("Spicetify availability uses the backend's dynamic target and copes with an unknown one", () => {
  assert.equal(
    spicetifyAvailabilityLine(model({ spicetify: { target: "2.48.0", latest: "2.48.0" } }).spicetify),
    "2.46.7 -> 2.48.0 (winget)",
  )
  const missing = model({ spicetify: { status: "outdated", target: null, latest: null } }).spicetify
  assert.equal(spicetifyAvailabilityLine(missing), "2.46.7 (update target unknown; no automatic upgrade)")
})

test("availability lines show installed versus available and keep current/unknown distinct", () => {
  assert.equal(pluginAvailabilityLine(model().plugin), "0.5.7 -> 0.6.0")
  assert.equal(
    pluginAvailabilityLine(model({ plugin: { status: "current", target: null, installed: "0.6.0", beta: "0.7.0-beta.1" } }).plugin),
    "0.6.0 (current; beta 0.7.0-beta.1 published)",
  )
  assert.match(
    pluginAvailabilityLine(model({ plugin: { status: "registry-older", target: null, installed: "0.7.0", latest: "0.6.0" } }).plugin),
    /0\.7\.0 \(registry reports 0\.6\.0; downgrades are never automatic\)/,
  )
  assert.match(
    pluginAvailabilityLine(model({ plugin: { status: "not-installed", target: null, installed: null } }).plugin),
    /not registered/,
  )
  assert.equal(
    pluginAvailabilityLine(model({ plugin: { status: "unknown", target: null, installed: "0.6.0", latest: null } }).plugin),
    "0.6.0 (available version unknown)",
  )

  assert.equal(
    spicetifyAvailabilityLine(model({ spicetify: { owner: "winget" } }).spicetify),
    "2.46.7 -> 2.47.0 (winget)",
  )
  assert.equal(
    spicetifyAvailabilityLine(model({ spicetify: { status: "current", target: null, owner: "script" } }).spicetify),
    "2.46.7 (current; official installer)",
  )
  assert.match(
    spicetifyAvailabilityLine(model({ spicetify: { status: "downgrade", target: null, latest: "2.40.0" } }).spicetify),
    /downgrade disabled/,
  )
  assert.equal(
    spicetifyAvailabilityLine(model({ spicetify: { status: "unknown", target: null, installed: null } }).spicetify),
    "not detected",
  )

  assert.equal(bridgeAvailabilityLine({ installed: true, registration: "current", credentialValid: true }), "installed; registration current")
  assert.match(bridgeAvailabilityLine({ installed: true, registration: "stale", credentialValid: true }), /repair needed/)
  assert.match(bridgeAvailabilityLine({ installed: false, registration: "absent", credentialValid: false }), /not installed/)
})

test("overview renders the availability table with local, registry-older, and offline notes", () => {
  const ui = fakeUi()
  renderUpdateOverview(ui, model(), { allowSpicetifyUpgrade: true })
  assert.ok(ui.lines.includes("Update check"))
  assert.ok(ui.lines.includes("OpenCode Spotify: 0.5.7 -> 0.6.0"))
  assert.ok(ui.lines.includes("Spicetify: 2.46.7 -> 2.47.0 (winget)"))
  assert.ok(ui.lines.includes("Bridge: installed; registration current"))

  const offline = fakeUi()
  renderUpdateOverview(offline, model({ plugin: { status: "unknown", target: null, latest: null, error: "Offline mode: registry not queried" } }), {
    offline: true,
  })
  assert.ok(offline.lines.some((line) => line.includes("Offline mode: registry versions were not queried")))
  assert.ok(offline.lines.some((line) => line.includes("Plugin version check: Offline mode: registry not queried")))

  const older = fakeUi()
  renderUpdateOverview(older, model({ plugin: { status: "registry-older", target: null, installed: "0.7.0", latest: "0.6.0" } }))
  assert.ok(older.lines.some((line) => line.includes("Downgrades are never automatic")))

  const local = fakeUi()
  renderUpdateOverview(local, model({ plugin: { local: true } }))
  assert.ok(local.lines.some((line) => line.includes("local development path")))
})

// ---------------------------------------------------------------------------
// Trusting backend verdicts (no comparison logic in the UI)
// ---------------------------------------------------------------------------

test("the view trusts backend verdicts even when version strings look contradictory", () => {
  // Backend says current; a higher-looking registry tag must not be re-compared.
  const current = model({
    plugin: { status: "current", target: null, installed: "0.5.0", latest: "9.9.9" },
    spicetify: { status: "outdated", installed: "9.0.0", target: "1.0.0", latest: "1.0.0" },
  })
  assert.match(pluginAvailabilityLine(current.plugin), /0\.5\.0 \(current\)/)
  assert.equal(updateReadiness(current).status, "current")
  assert.match(updateReadiness(current).message ?? "", /0\.5\.0 is current/)
  assert.equal(spicetifyAvailabilityLine(current.spicetify), "9.0.0 -> 1.0.0 (winget)")

  // Backend says update-available; a lower-looking target is still the target.
  const forced = model({ plugin: { status: "update-available", installed: "9.0.0", target: "1.0.0", latest: "1.0.0" } })
  assert.equal(pluginAvailabilityLine(forced.plugin), "9.0.0 -> 1.0.0")
  assert.equal(updateReadiness(forced).status, "update-available")
})

// ---------------------------------------------------------------------------
// Current-version / no-update states
// ---------------------------------------------------------------------------

test("readiness blocks unsafe states with actionable messages", () => {
  const local = updateReadiness(model({ plugin: { local: true } }))
  assert.equal(local.status, "blocked")
  assert.equal(local.code, 1)
  assert.match(local.message ?? "", /local development path/)

  const unknownRegistration = updateReadiness(model({ plugin: { registrationState: "unknown" } }))
  assert.equal(unknownRegistration.status, "blocked")
  assert.match(unknownRegistration.message ?? "", /registration state is unknown/)

  const notInstalled = updateReadiness(model({ plugin: { status: "not-installed", installed: null, target: null } }))
  assert.equal(notInstalled.status, "blocked")
  assert.match(notInstalled.message ?? "", /not registered globally/)

  const older = updateReadiness(model({ plugin: { status: "registry-older", installed: "0.7.0", latest: "0.6.0", target: null } }))
  assert.equal(older.status, "blocked")
  assert.match(older.message ?? "", /Downgrades are never automatic/)

  const unknown = updateReadiness(model({ plugin: { status: "unknown", target: null, error: "registry unavailable" } }))
  assert.equal(unknown.status, "blocked")
  assert.match(unknown.message ?? "", /No published version could be determined: registry unavailable/)
  assert.match(unknown.hint ?? "", /npm registry/)

  const missingTarget = updateReadiness(model({ plugin: { status: "update-available", target: null } }))
  assert.equal(missingTarget.status, "blocked")
  assert.match(missingTarget.message ?? "", /selected no install target/)
})

test("readiness reports current, update-available, and required bridge repair", () => {
  const current = updateReadiness(model({ plugin: { status: "current", target: null, installed: "0.6.0" }, spicetify: { status: "current", target: null } }))
  assert.equal(current.status, "current")
  assert.equal(current.code, 0)
  assert.equal(current.message, "OpenCode Spotify 0.6.0 is current.")
  assert.equal(current.bridgeRepairRequired, false)
  assert.equal(current.spicetifyUpdateAvailable, false)

  const pluginOnly = updateReadiness(model({ plugin: { status: "current", target: null, installed: "0.6.0" } }))
  assert.match(pluginOnly.hint ?? "", /Spicetify 2\.47\.0 is available/)
  assert.equal(pluginOnly.spicetifyUpdateAvailable, true)

  const unknownOwnerOnly = updateReadiness(model({
    plugin: { status: "current", target: null, installed: "0.6.0" },
    spicetify: { status: "outdated", owner: "unknown" },
  }))
  assert.equal(unknownOwnerOnly.spicetifyUpdateAvailable, false, "unknown owners are never auto-upgraded")

  const staleBridge = updateReadiness(model({ plugin: { status: "current", target: null }, bridge: { installed: true, registration: "stale" } }))
  assert.equal(staleBridge.status, "current")
  assert.equal(staleBridge.bridgeRepairRequired, true)

  const available = updateReadiness(model())
  assert.equal(available.status, "update-available")
  assert.equal(available.message, "OpenCode Spotify 0.5.7 -> 0.6.0 is available.")
})

test("update screen renders success, warning, and error states", () => {
  const available = fakeUi()
  const availableReadiness = renderUpdateScreen(available, model(), { allowSpicetifyUpgrade: true })
  assert.equal(availableReadiness.status, "update-available")
  assert.ok(available.lines.some((line) => line.includes("0.5.7 -> 0.6.0")))
  assert.ok(available.lines.some((line) => line.startsWith("info: OpenCode Spotify 0.5.7 -> 0.6.0 is available.")))

  const current = fakeUi()
  const currentReadiness = renderUpdateScreen(current, model({
    plugin: { status: "current", target: null, installed: "0.6.0" },
    spicetify: { status: "current", target: null },
    bridge: { installed: true, registration: "stale" },
  }))
  assert.equal(currentReadiness.bridgeRepairRequired, true)
  assert.ok(current.lines.includes("ok: OpenCode Spotify 0.6.0 is current."))
  assert.ok(current.lines.some((line) => line.includes("bridge still needs repair")))

  const blocked = fakeUi()
  assert.equal(renderUpdateScreen(blocked, model({ plugin: { local: true } })).code, 1)
  assert.ok(blocked.lines.some((line) => line.startsWith("error: ")))
})

// ---------------------------------------------------------------------------
// Update selection
// ---------------------------------------------------------------------------

test("selection exposes valid choices and labels authorization plus the Spicetify owner", () => {
  let choices = updateSelectionChoices(model(), { allowSpicetifyUpgrade: false })
  assert.deepEqual(choices.map((choice) => choice.value), ["both", "plugin", "spicetify", "cancel"])
  assert.match(choices[0]!.label, /Update OpenCode Spotify and Spicetify/)
  assert.match(choices[0]!.label, /combined authorization required/)
  assert.match(choices[1]!.label, /Update OpenCode Spotify only \(0\.5\.7 -> 0\.6\.0\)/)
  assert.match(choices[2]!.label, /via winget; separate confirmation required/)

  choices = updateSelectionChoices(model(), { allowSpicetifyUpgrade: true })
  assert.deepEqual(choices.map((choice) => choice.value), ["both", "plugin", "spicetify", "cancel"])
  assert.match(choices[0]!.label, /Spicetify 2\.46\.7 -> 2\.47\.0 via winget/)
  assert.doesNotMatch(choices[0]!.label, /authorization required/)
  assert.doesNotMatch(choices[2]!.label, /separate confirmation required/)

  const unknownOwner = model({ spicetify: { owner: "unknown" } })
  assert.deepEqual(
    updateSelectionChoices(unknownOwner, { allowSpicetifyUpgrade: true }).map((choice) => choice.value),
    ["plugin", "cancel"],
  )

  const onlySpicetify = model({ plugin: { status: "current", target: null } })
  assert.deepEqual(
    updateSelectionChoices(onlySpicetify, { allowSpicetifyUpgrade: true }).map((choice) => choice.value),
    ["spicetify", "cancel"],
  )
})

test("selection prompts with backend data and normalizes cancellation", async () => {
  const ui = fakeUi()
  const prompt = fakePrompt({ choices: ["both"] })
  const selected = await promptUpdateSelection(ui, prompt, model(), { allowSpicetifyUpgrade: true })
  assert.equal(selected, "both")
  assert.equal(prompt.asked.length, 1)
  assert.match(prompt.asked[0]!, /Updates are available for OpenCode Spotify and Spicetify/)
  assert.ok(ui.lines.includes("Spicetify owner: winget"))

  const cancelled = await promptUpdateSelection(fakeUi(), fakePrompt({ choices: [undefined] }), model(), { allowSpicetifyUpgrade: true })
  assert.equal(cancelled, "cancel")

  const currentModel = model({
    plugin: { status: "current", target: null, installed: "0.6.0" },
    spicetify: { status: "current", target: null },
  })
  const quietPrompt = fakePrompt()
  const noUpdateUi = fakeUi()
  assert.equal(await promptUpdateSelection(noUpdateUi, quietPrompt, currentModel), "cancel")
  assert.equal(quietPrompt.asked.length, 0, "no-update state must not prompt")
  assert.ok(noUpdateUi.lines.some((line) => line.includes("No supported update is available")))
})

// ---------------------------------------------------------------------------
// Plan confirmation
// ---------------------------------------------------------------------------

test("plan view strips callbacks and renders verification-only steps", () => {
  const steps = [
    { id: "update-registration", description: "Replace the global registration", mutates: true, run: async () => {} },
    { id: "verify-registration", description: "Verify the registration", mutates: false, run: async () => {} },
  ]
  const view = toUpdatePlan("Update plan", steps)
  assert.deepEqual(view.steps[0], { id: "update-registration", description: "Replace the global registration", mutates: true })
  assert.equal("run" in view.steps[0]!, false)

  const ui = fakeUi()
  renderUpdatePlan(ui, view)
  assert.ok(ui.lines.includes("Update plan"))
  assert.ok(ui.lines.includes("1. Replace the global registration"))
  assert.ok(ui.lines.includes("2. Verify the registration (verification only)"))

  const empty = fakeUi()
  renderUpdatePlan(empty, { title: "Update plan", steps: [] })
  assert.ok(empty.lines.includes("info: Nothing to do."))
})

test("plan consent mirrors executePlan safety rules", async () => {
  const readOnly: UpdatePlan = { title: "Verify", steps: [{ id: "check", description: "Check", mutates: false }] }
  const readOnlyPrompt = fakePrompt()
  assert.equal(
    await confirmUpdatePlan(readOnlyPrompt, readOnly, { yes: false, nonInteractive: false }),
    "approved",
  )
  assert.equal(readOnlyPrompt.asked.length, 0)

  const dryPrompt = fakePrompt()
  assert.equal(
    await confirmUpdatePlan(dryPrompt, plan, { yes: false, nonInteractive: false, dryRun: true }),
    "dry-run",
  )
  assert.equal(dryPrompt.asked.length, 0)

  const autoPrompt = fakePrompt()
  assert.equal(
    await confirmUpdatePlan(autoPrompt, plan, { yes: true, nonInteractive: true }),
    "approved",
  )
  assert.equal(autoPrompt.asked.length, 0, "--yes supplies consent")

  const nonInteractivePrompt = fakePrompt()
  assert.equal(
    await confirmUpdatePlan(nonInteractivePrompt, plan, { yes: false, nonInteractive: true }),
    "confirmation-required",
  )
  assert.equal(nonInteractivePrompt.asked.length, 0, "noninteractive must never guess")

  const alreadyApproved = fakePrompt()
  assert.equal(
    await confirmUpdatePlan(alreadyApproved, plan, { yes: false, nonInteractive: false, approved: true, force: true }),
    "approved",
  )
  assert.equal(alreadyApproved.asked.length, 0)

  const declined = fakePrompt({ confirms: [false] })
  assert.equal(await confirmUpdatePlan(declined, plan, { yes: false, nonInteractive: false }), "declined")
  assert.equal(declined.asked.length, 1)

  const forced = fakePrompt({ confirms: [true] })
  assert.equal(
    await confirmUpdatePlan(forced, plan, { yes: true, nonInteractive: false, force: true }),
    "approved",
  )
  assert.equal(forced.asked.length, 1, "forced consent asks even with --yes")
})

test("plan confirmation forwards question options and presentUpdatePlan reports outcomes", async () => {
  const seen: Array<{ question: string; options?: Parameters<Prompter["confirm"]>[1] }> = []
  const prompt: Prompter = {
    async ask() { return "" },
    async choose() { return undefined },
    async confirm(question, options) {
      seen.push({ question, options })
      return true
    },
    close() {},
  }
  assert.equal(
    await confirmUpdatePlan(prompt, plan, {
      yes: false,
      nonInteractive: false,
      question: "Apply the update?",
      defaultYes: true,
      phrase: "APPLY",
    }),
    "approved",
  )
  assert.equal(seen[0]!.question, "Apply the update?")
  assert.equal(seen[0]!.options?.defaultYes, true)
  assert.equal(seen[0]!.options?.phrase, "APPLY")

  const dryUi = fakeUi()
  assert.equal(
    await presentUpdatePlan(dryUi, fakePrompt(), plan, { yes: false, nonInteractive: false, dryRun: true }),
    "dry-run",
  )
  assert.ok(dryUi.lines.some((line) => line.startsWith("dry: ")))
  assert.ok(dryUi.lines.includes("  Dry run: no changes were made."))

  const declinedUi = fakeUi()
  assert.equal(
    await presentUpdatePlan(declinedUi, fakePrompt({ confirms: [false] }), plan, { yes: false, nonInteractive: false }),
    "declined",
  )
  assert.ok(declinedUi.lines.some((line) => line.includes("Cancelled. No steps in this plan were run.")))

  const blockedUi = fakeUi()
  assert.equal(
    await presentUpdatePlan(blockedUi, fakePrompt(), plan, { yes: false, nonInteractive: true }),
    "confirmation-required",
  )
  assert.ok(blockedUi.lines.some((line) => line.startsWith("error: Confirmation required")))
})

// ---------------------------------------------------------------------------
// Owner-specific Spicetify guidance
// ---------------------------------------------------------------------------

test("Spicetify guidance adapts to official, manager, and unknown owners", () => {
  const official = spicetifyUpdateGuidance("script")
  assert.equal(official.category, "official")
  assert.equal(official.command, "spicetify-cli upgrade")
  assert.ok(official.lines.some((line) => line.includes(SPICETIFY_MANUAL_URL)))
  assert.ok(official.lines.some((line) => line.includes("do not also run winget, Scoop, or Chocolatey")))

  const verified = spicetifyUpdateGuidance("script", { verifiedInstall: true })
  assert.equal(verified.category, "official")
  assert.equal(verified.command, null)
  assert.match(verified.warning ?? "", /verified flow/)
  assert.ok(verified.lines.some((line) => line.includes("unverified `spicetify-cli upgrade` self-updater is refused")))

  const winget = spicetifyUpdateGuidance("winget")
  assert.equal(winget.category, "manager")
  assert.ok(winget.command?.includes(`winget upgrade --id ${SPICETIFY_WINGET_ID} -e`))
  assert.ok(winget.lines.some((line) => line.includes("Only winget should update it")))

  const scoop = spicetifyUpdateGuidance("scoop")
  assert.equal(scoop.command, "scoop update spicetify-cli")
  assert.equal(scoop.category, "manager")

  const choco = spicetifyUpdateGuidance("choco")
  assert.equal(choco.command, "choco upgrade spicetify-cli -y")
  assert.equal(choco.category, "manager")

  const unknown = spicetifyUpdateGuidance("unknown")
  assert.equal(unknown.category, "unknown")
  assert.equal(unknown.command, null)
  assert.match(unknown.warning ?? "", /could not be determined/)
  assert.ok(unknown.lines.some((line) => line.includes("Never run two package managers")))
})

test("owner labels and guidance rendering are stable", () => {
  assert.equal(spicetifyOwnerCategory("script"), "official")
  assert.equal(spicetifyOwnerCategory("winget"), "manager")
  assert.equal(spicetifyOwnerCategory("scoop"), "manager")
  assert.equal(spicetifyOwnerCategory("choco"), "manager")
  assert.equal(spicetifyOwnerCategory("unknown"), "unknown")
  assert.equal(spicetifyOwnerLabel("script"), "official installer")
  assert.equal(spicetifyOwnerLabel("winget"), "winget")
  assert.equal(spicetifyOwnerLabel("scoop"), "Scoop")
  assert.equal(spicetifyOwnerLabel("choco"), "Chocolatey")
  assert.equal(spicetifyOwnerLabel("unknown"), "unknown owner")

  const ui = fakeUi()
  renderSpicetifyGuidance(ui, spicetifyUpdateGuidance("scoop"))
  assert.ok(ui.lines.includes("Spicetify update guidance"))
  assert.ok(ui.lines.includes("Install owner: Scoop"))
  assert.ok(ui.lines.includes("Upgrade method: Scoop (spicetify-cli)"))
  assert.ok(ui.lines.includes("Command: scoop update spicetify-cli"))
})

// ---------------------------------------------------------------------------
// Final summary
// ---------------------------------------------------------------------------

test("summary distinguishes updated, unchanged, applied, and pending outcomes", () => {
  const updated = createUpdateSummary({
    plugin: { installed: "0.6.0", target: "0.6.0", changed: true, verified: true },
    spicetify: { version: "2.47.0", changed: true, owner: "winget" },
    bridge: { synchronized: true, applied: true, pending: false },
  })
  assert.equal(updated.plugin, "updated to 0.6.0 (verified)")
  assert.equal(updated.bridge, "synchronized and applied")
  assert.equal(updated.spicetify, "updated to 2.47.0 (winget)")
  assert.ok(updated.nextSteps.some((line) => line.includes("load the updated plugin")))
  assert.ok(updated.nextSteps.some((line) => line.includes("Playback is not verified")))

  const pending = createUpdateSummary({
    plugin: { installed: "0.6.0", target: "0.6.0", changed: true },
    spicetify: { version: "2.46.7", changed: false, owner: "script" },
    bridge: { synchronized: true, applied: false, pending: true },
    warnings: ["Restart Spotify after applying."],
  })
  assert.equal(pending.bridge, "prepared; apply pending")
  assert.equal(pending.spicetify, "unchanged (2.46.7, official installer)")
  assert.equal(pending.warnings[0], "Restart Spotify after applying.")
  assert.match(pending.nextSteps[0]!, /spicetify apply/)

  const unchanged = createUpdateSummary({
    plugin: { installed: "0.6.0", target: null, changed: false },
    spicetify: { version: "2.47.0", changed: false, owner: "winget" },
    bridge: { synchronized: false, applied: false, pending: false },
  })
  assert.equal(unchanged.plugin, "unchanged (0.6.0)")
  assert.equal(unchanged.bridge, "already current")
  assert.equal(unchanged.spicetify, "unchanged (2.47.0, winget)")
  assert.ok(unchanged.nextSteps.some((line) => line.includes("if the bridge was re-applied")))
})

test("summary renders keys, warnings, and next steps", () => {
  const ui = fakeUi()
  renderUpdateSummary(ui, createUpdateSummary({
    plugin: { installed: "0.6.0", target: "0.6.0", changed: true, verified: true },
    spicetify: { version: "2.47.0", changed: true, owner: "winget" },
    bridge: { synchronized: true, applied: false, pending: true },
    warnings: ["Spicetify was upgraded separately."],
  }))
  assert.ok(ui.lines.includes("Update summary"))
  assert.ok(ui.lines.includes("Plugin: updated to 0.6.0 (verified)"))
  assert.ok(ui.lines.includes("Bridge: prepared; apply pending"))
  assert.ok(ui.lines.includes("Spicetify: updated to 2.47.0 (winget)"))
  assert.ok(ui.lines.includes("warn: Spicetify was upgraded separately."))
  assert.ok(ui.lines.some((line) => line.includes("spicetify apply")))
})
