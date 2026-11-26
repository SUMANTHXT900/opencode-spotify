import { test } from "node:test"
import assert from "node:assert/strict"
import {
  COMPLETE_CONSENT_ATTEMPTS,
  DEFAULT_UNINSTALL_MENU_INDEX,
  UNINSTALL_CONFIRMATION_PHRASE,
  buildUninstallScope,
  confirmCompleteRemoval,
  inventoryFromDetection,
  manualHintFor,
  remainingComponents,
  renderUninstallExit,
  renderUninstallResult,
  renderUninstallScope,
  selectUninstallMode,
  uninstallMenuChoices,
  type UninstallInventory,
  type UninstallResult,
} from "../src/cli/ui/uninstall-view.ts"
import type { Prompter } from "../src/cli/types.ts"
import { fakeDetection, fakeRuntime, fakeUi } from "./cli-fixture.ts"

function inventory(overrides: Partial<UninstallInventory> = {}): UninstallInventory {
  return {
    registration: { registered: true, spec: "opencode-spotify@0.6.0-beta.3" },
    bridge: {
      installed: true,
      extensionPath: "C:\\Users\\Test\\AppData\\Roaming\\spicetify\\Extensions\\opencode-spotify-bridge.js",
      registered: true,
    },
    spicetify: {
      available: true,
      configPath: "C:\\Users\\Test\\AppData\\Roaming\\spicetify\\config-xpui.ini",
      extensionsDir: "C:\\Users\\Test\\AppData\\Roaming\\spicetify\\Extensions",
    },
    credentials: { present: true, directory: "C:\\Users\\Test\\AppData\\Roaming\\opencode-spotify" },
    backups: { present: true, directory: "C:\\Users\\Test\\AppData\\Roaming\\spicetify\\Backups" },
    spotify: { installed: true },
    opencode: { configPath: "C:\\Users\\Test\\.config\\opencode\\opencode.json" },
    ...overrides,
  }
}

function mockPrompt(options: {
  answers?: Array<string | undefined>
  choices?: Array<string | undefined>
} = {}): Prompter & { asked: string[]; chooseDefaults: number[]; confirmCalls: number } {
  const answers = [...(options.answers ?? [])]
  const choices = [...(options.choices ?? [])]
  const asked: string[] = []
  const chooseDefaults: number[] = []
  const prompt: Prompter & { asked: string[]; chooseDefaults: number[]; confirmCalls: number } = {
    asked,
    chooseDefaults,
    confirmCalls: 0,
    async ask(question) {
      asked.push(question)
      return answers.length ? answers.shift() : undefined
    },
    async choose(question, list, defaultIndex = 0) {
      asked.push(question)
      chooseDefaults.push(defaultIndex)
      void list
      return choices.length ? choices.shift() : undefined
    },
    async confirm() {
      prompt.confirmCalls++
      throw new Error("uninstall consent must use the typed phrase, not a y/n confirm")
    },
    close() {},
  }
  return prompt
}

test("selection offers three choices and never defaults to the destructive one", () => {
  const choices = uninstallMenuChoices()
  assert.deepEqual(choices.map((choice) => choice.label), [
    "Remove OpenCode Spotify only",
    "Complete permanent removal",
    "Back",
  ])
  assert.deepEqual(choices.map((choice) => choice.value), ["plugin-only", "complete", "back"])
  assert.equal(DEFAULT_UNINSTALL_MENU_INDEX, 0)
  assert.equal(choices[DEFAULT_UNINSTALL_MENU_INDEX]?.value, "plugin-only")
  assert.ok(choices.some((choice) => choice.value === "complete" && choice.hint?.includes("UNINSTALL")))
})

test("selectUninstallMode passes the safe default and maps every outcome", async () => {
  const complete = mockPrompt({ choices: ["complete"] })
  assert.equal(await selectUninstallMode(complete), "complete")
  assert.deepEqual(complete.chooseDefaults, [0])

  assert.equal(await selectUninstallMode(mockPrompt({ choices: ["back"] })), "back")
  assert.equal(await selectUninstallMode(mockPrompt({ choices: ["plugin-only"] })), "plugin-only")

  // EOF and unexpected values must not be treated as approval.
  assert.equal(await selectUninstallMode(mockPrompt()), "cancelled")
  assert.equal(await selectUninstallMode(mockPrompt({ choices: ["something-else"] })), "cancelled")
})

test("plugin-only scope lists exactly the registration and owned bridge, and keeps credentials", () => {
  const scope = buildUninstallScope("plugin-only", inventory())

  assert.equal(scope.destructive, false)
  assert.equal(scope.title, "Remove OpenCode Spotify only")
  assert.deepEqual(scope.deletions.map((item) => item.id), [
    "global-registration",
    "bridge-extension",
    "spicetify-extension-entry",
  ])
  assert.ok(scope.deletions.some((item) => item.target.includes("opencode-spotify@0.6.0-beta.3")))
  assert.ok(scope.deletions.some((item) => item.target.endsWith("opencode-spotify-bridge.js")))
  assert.ok(!scope.deletions.some((item) => item.id === "bridge-credentials"))

  const preserved = scope.preservations.map((item) => item.id)
  for (const id of ["spotify", "spicetify", "other-extensions", "opencode", "bridge-credentials", "backups"]) {
    assert.ok(preserved.includes(id), `expected ${id} to be preserved`)
  }
  assert.ok(scope.preservations.find((item) => item.id === "bridge-credentials")?.containsSecrets)
  assert.match(
    scope.preservations.find((item) => item.id === "other-extensions")?.label ?? "",
    /Marketplace/,
    "Marketplace is named when it is preserved",
  )
  assert.ok(scope.warnings.some((warning) => warning.includes("reinstall")))
  assert.ok(scope.warnings.some((warning) => /Marketplace.*kept/.test(warning)))
})

test("complete scope adds the credential directory and preserves shared/other data", () => {
  const scope = buildUninstallScope("complete", inventory())

  assert.equal(scope.destructive, true)
  assert.equal(scope.title, "Complete permanent removal")
  assert.deepEqual(scope.deletions.map((item) => item.id), [
    "global-registration",
    "bridge-extension",
    "spicetify-extension-entry",
    "bridge-credentials",
  ])
  const credentials = scope.deletions.find((item) => item.id === "bridge-credentials")
  assert.equal(credentials?.target, "C:\\Users\\Test\\AppData\\Roaming\\opencode-spotify")
  assert.equal(credentials?.sensitive, true)

  const preserved = scope.preservations.map((item) => item.id)
  for (const id of ["spotify", "opencode", "package-cache"]) {
    assert.ok(preserved.includes(id), `expected ${id} to be preserved`)
  }
  // Complete removal deletes Spicetify (including Marketplace), backups nested
  // in the Spicetify config directory, and credentials.
  for (const id of ["backups", "bridge-credentials", "spicetify", "other-extensions"]) {
    assert.ok(!preserved.includes(id), `${id} must not be claimed as preserved`)
  }
  assert.ok(scope.warnings.some((warning) => warning.includes("Irreversible")))
  assert.ok(scope.warnings.some((warning) => /ownership and Spotify restore are verified/.test(warning)))
  assert.ok(scope.warnings.some((warning) => /inside the Spicetify config directory/.test(warning)))
})

test("backups inside the credential directory are not falsely listed as preserved", () => {
  const scope = buildUninstallScope("complete", inventory({
    credentials: { present: true, directory: "C:\\Users\\Test\\AppData\\Roaming\\opencode-spotify" },
    backups: { present: true, directory: "C:\\Users\\Test\\AppData\\Roaming\\opencode-spotify\\backups" },
  }))

  assert.ok(!scope.preservations.some((item) => item.id === "backups"))
  assert.ok(scope.warnings.some((warning) => warning.includes("inside the credential directory")))

  // Plugin-only keeps the credential directory, so nested backups stay too.
  const pluginOnly = buildUninstallScope("plugin-only", inventory({
    credentials: { present: true, directory: "C:\\Users\\Test\\AppData\\Roaming\\opencode-spotify" },
    backups: { present: true, directory: "C:\\Users\\Test\\AppData\\Roaming\\opencode-spotify\\backups" },
  }))
  assert.ok(pluginOnly.preservations.some((item) => item.id === "backups"))
})

test("absent components are not advertised as deletions", () => {  const scope = buildUninstallScope("complete", inventory({
    registration: { registered: false, spec: null },
    bridge: { installed: false, extensionPath: null, registered: false },
    credentials: { present: false, directory: null },
    backups: { present: false, directory: null },
  }))

  assert.deepEqual(scope.deletions, [])
  assert.equal(scope.incomplete, false)
  assert.ok(scope.warnings.some((warning) => warning.includes("Nothing to delete")))
})

test("an unavailable Spicetify path becomes an honest manual check, not a fake deletion", () => {
  const scope = buildUninstallScope("complete", inventory({
    spicetify: { available: false, configPath: null, extensionsDir: null },
  }))

  assert.equal(scope.incomplete, true)
  assert.ok(!scope.deletions.some((item) => item.id === "spicetify-extension-entry"))
  assert.ok(scope.manualChecks.some((check) => check.includes("config-xpui.ini")))
  assert.ok(scope.warnings.some((warning) => warning.includes("manual checks")))
})

test("scope rendering shows literal deletion and preservation lists with exact paths", () => {
  const ui = fakeUi()
  renderUninstallScope(ui, buildUninstallScope("complete", inventory()))
  const text = ui.lines.join("\n")

  assert.ok(text.includes("Deletes exactly:"))
  assert.ok(text.includes("Preserves:"))
  assert.ok(text.includes("Global OpenCode plugin registration"))
  assert.ok(text.includes("opencode-spotify@0.6.0-beta.3"))
  assert.ok(text.includes("C:\\Users\\Test\\AppData\\Roaming\\spicetify\\Extensions\\opencode-spotify-bridge.js"))
  assert.ok(text.includes("C:\\Users\\Test\\AppData\\Roaming\\opencode-spotify"))
  assert.ok(text.includes("Spotify desktop app"))
  assert.ok(!text.includes("Other Spicetify extensions"), "complete removal does not preserve Spicetify extensions")
  assert.ok(!text.includes("Spicetify CLI and its installation"), "complete removal deletes Spicetify")
  assert.ok(text.includes("npm/npx package cache"))
})

test("plugin-only rendering calls out kept credentials and names Marketplace", () => {
  const ui = fakeUi()
  renderUninstallScope(ui, buildUninstallScope("plugin-only", inventory()))
  const text = ui.lines.join("\n")
  assert.ok(text.includes("Bridge credentials and pinned Origin"))
  assert.ok(text.includes("Kept so a reinstall can reuse the same signing secret."))
  assert.match(text, /Marketplace/)
})

test("complete removal requires the exact UNINSTALL phrase", async () => {
  const ui = fakeUi()
  const prompt = mockPrompt({ answers: ["uninstall", "UNINSTALL"] })
  const consent = await confirmCompleteRemoval(prompt, ui, buildUninstallScope("complete", inventory()))

  assert.equal(consent, "confirmed")
  assert.equal(UNINSTALL_CONFIRMATION_PHRASE, "UNINSTALL")
  assert.equal(prompt.asked.length, 2)
  assert.ok(prompt.asked[0]?.includes("UNINSTALL"))
  assert.ok(prompt.asked[0]?.includes("BACK"))
  assert.ok(prompt.asked[0]?.includes("CANCEL"))
  assert.ok(ui.lines.some((line) => line.includes("Type UNINSTALL exactly")))
  assert.ok(ui.lines.some((line) => line.includes("Deletes exactly:")))
  assert.equal(prompt.confirmCalls, 0)
})

test("complete consent supports back, cancel, empty input and EOF without approving", async () => {
  assert.equal(await confirmCompleteRemoval(mockPrompt({ answers: ["BACK"] }), fakeUi()), "back")
  assert.equal(await confirmCompleteRemoval(mockPrompt({ answers: ["cancel"] }), fakeUi()), "cancelled")
  assert.equal(await confirmCompleteRemoval(mockPrompt({ answers: [""] }), fakeUi()), "cancelled")
  assert.equal(await confirmCompleteRemoval(mockPrompt(), fakeUi()), "cancelled")

  const ui = fakeUi()
  assert.equal(await confirmCompleteRemoval(mockPrompt({ answers: ["UNINSTALL "] }), ui), "confirmed")
})

test("too many invalid entries cancels safely instead of looping forever", async () => {
  const ui = fakeUi()
  const prompt = mockPrompt({ answers: Array.from({ length: COMPLETE_CONSENT_ATTEMPTS }, () => "yes") })
  const consent = await confirmCompleteRemoval(prompt, ui)

  assert.equal(consent, "cancelled")
  assert.equal(prompt.asked.length, COMPLETE_CONSENT_ATTEMPTS)
  assert.ok(ui.lines.some((line) => line.includes("Too many invalid entries")))
})

test("back and cancel exit messages claim no changes", () => {
  const back = fakeUi()
  renderUninstallExit(back, "back")
  assert.ok(back.lines.some((line) => line.includes("Returned to the uninstall menu. Nothing was removed.")))

  const cancelled = fakeUi()
  renderUninstallExit(cancelled, "cancelled")
  assert.ok(cancelled.lines.some((line) => line.includes("Uninstall cancelled. Nothing was removed.")))
})

test("partial failures list removed versus remaining components honestly", () => {
  const result: UninstallResult = {
    mode: "complete",
    components: [
      { id: "global-registration", label: "Global OpenCode plugin registration", target: "opencode-spotify@0.6.0-beta.3", status: "removed" },
      {
        id: "bridge-extension",
        label: "Owned Spicetify bridge extension",
        target: "C:\\Users\\Test\\AppData\\Roaming\\spicetify\\Extensions\\opencode-spotify-bridge.js",
        status: "failed",
        detail: "file is locked by Spotify",
      },
      {
        id: "spicetify-extension-entry",
        label: "Spicetify extensions entry",
        target: "opencode-spotify-bridge.js in C:\\Users\\Test\\AppData\\Roaming\\spicetify\\config-xpui.ini",
        status: "skipped",
      },
      {
        id: "bridge-credentials",
        label: "Bridge credentials and pinned Origin",
        target: "C:\\Users\\Test\\AppData\\Roaming\\opencode-spotify",
        status: "failed",
        detail: "access denied",
      },
    ],
  }

  const remaining = remainingComponents(result)
  assert.deepEqual(remaining.map((component) => component.id), [
    "bridge-extension",
    "spicetify-extension-entry",
    "bridge-credentials",
  ])

  const ui = fakeUi()
  renderUninstallResult(ui, result)
  const text = ui.lines.join("\n")

  assert.ok(text.includes("Removal is incomplete: 3 component(s) remain on this machine."))
  assert.ok(text.includes("Remaining: Owned Spicetify bridge extension, Spicetify extensions entry, Bridge credentials and pinned Origin"))
  assert.ok(text.includes("Still present"))
  assert.ok(text.includes("file is locked by Spotify"))
  assert.ok(text.includes("Not attempted: Spicetify extensions entry"))
  assert.ok(text.includes("(not attempted)"))
  assert.ok(text.includes("Manual cleanup"))
  assert.ok(text.includes("Delete opencode-spotify-bridge.js from the Spicetify Extensions directory."))
  assert.ok(text.includes("extensions line in config-xpui.ini"))
  assert.ok(text.includes("access denied"))
  assert.ok(text.includes("signing secret and pinned Origin may still be on disk"))
  assert.ok(text.includes("OpenCode Spotify is not fully removed"))
  assert.ok(!text.includes("Complete removal finished"))
})

test("full success reports completion without a still-present section", () => {
  const result: UninstallResult = {
    mode: "complete",
    components: [
      { id: "global-registration", label: "Global OpenCode plugin registration", status: "removed" },
      { id: "bridge-extension", label: "Owned Spicetify bridge extension", status: "removed" },
      { id: "spicetify-extension-entry", label: "Spicetify extensions entry", status: "absent" },
      { id: "bridge-credentials", label: "Bridge credentials and pinned Origin", status: "removed" },
    ],
    notes: ["Installer backups are still available for rollback."],
  }

  assert.deepEqual(remainingComponents(result), [])

  const ui = fakeUi()
  renderUninstallResult(ui, result)
  const text = ui.lines.join("\n")

  assert.ok(text.includes("Complete removal finished: no OpenCode Spotify components remain on this machine."))
  assert.ok(text.includes("Kept: Spotify, OpenCode itself, and your personal data."))
  assert.ok(!/Kept:.*Spicetify/.test(text), "complete removal must not claim Spicetify was preserved")
  assert.ok(!/Kept:.*backups/i.test(text), "complete removal must not claim backups were preserved")
  assert.ok(text.includes("Spicetify program/config/Marketplace/themes/extensions and internal backups were removed"))
  assert.ok(text.includes("Already absent: Spicetify extensions entry"))
  assert.ok(text.includes("Installer backups are still available for rollback."))
  assert.ok(!text.includes("Still present"))
  assert.ok(!text.includes("incomplete"))
})

test("plugin-only result makes the retained credentials explicit", () => {
  const ui = fakeUi()
  renderUninstallResult(ui, {
    mode: "plugin-only",
    components: [
      { id: "global-registration", label: "Global OpenCode plugin registration", status: "removed" },
      { id: "bridge-extension", label: "Owned Spicetify bridge extension", status: "removed" },
    ],
  })

  const text = ui.lines.join("\n")
  assert.ok(text.includes("registration and owned bridge were removed"))
  assert.ok(text.includes("credentials and pinned Origin (for reinstall)"))
  assert.ok(!text.includes("Complete removal finished"))
  assert.ok(!text.includes("Still present"))
})

test("empty results do not claim that components were removed", () => {
  const ui = fakeUi()
  renderUninstallResult(ui, { mode: "complete", components: [] })
  const text = ui.lines.join("\n")
  assert.ok(text.includes("Nothing to remove: no OpenCode Spotify components were found."))
  assert.ok(!text.includes("Removed "))
})

test("unknown components still receive manual guidance", () => {
  assert.ok(manualHintFor("bridge-credentials").includes("signing secret"))
  assert.ok(manualHintFor("brand-new-component").includes("manually"))
})

test("spicetify-* failures get specific manual guidance and orphan bridge files are disclosed", () => {
  const hints = {
    "spicetify-program": /program directory/i,
    "spicetify-path": /user PATH/i,
    "spicetify-package": /package manager/i,
    "spicetify-data": /local data/i,
    "spicetify-config": /Marketplace/i,
    "spotify-restore": /restore Spotify/i,
  }
  for (const [id, pattern] of Object.entries(hints)) {
    assert.match(manualHintFor(id), pattern, `${id} needs an actionable hint`)
  }

  const scope = buildUninstallScope("plugin-only", inventory({
    bridge: {
      installed: false,
      extensionPath: "C:\\Users\\Test\\AppData\\Roaming\\spicetify\\Extensions\\opencode-spotify-bridge.js",
      registered: false,
      filePresent: true,
    },
  }))
  assert.equal(scope.incomplete, true)
  assert.ok(scope.manualChecks.some((check) => /orphaned opencode-spotify-bridge\.js/.test(check)))
  assert.ok(scope.warnings.some((warning) => warning.includes("manual checks")))

  const ui = fakeUi()
  renderUninstallResult(ui, {
    mode: "complete",
    components: [
      { id: "global-registration", label: "Global OpenCode plugin registration", status: "removed" },
      { id: "spicetify-config", label: "Spicetify config, Marketplace, themes and extensions", status: "failed", detail: "access denied" },
    ],
  })
  const text = ui.lines.join("\n")
  assert.match(text, /Could not remove Spicetify config, Marketplace/)
  assert.match(text, /Delete the Spicetify config directory \(including Marketplace/)
})

test("inventoryFromDetection maps detected state and explicit credential locations", () => {
  const runtime = fakeRuntime()
  const detection = fakeDetection(runtime)
  const mapped = inventoryFromDetection(detection, {
    credentialsDirectory: "C:\\Users\\Test\\AppData\\Roaming\\opencode-spotify",
    backupsDirectory: "C:\\Users\\Test\\AppData\\Roaming\\opencode-spotify\\backups",
    backupsPresent: true,
  })

  assert.deepEqual(mapped.registration, { registered: true, spec: "opencode-spotify@0.6.0-beta.1" })
  assert.equal(mapped.bridge.installed, true)
  assert.equal(mapped.bridge.extensionPath, detection.bridge.extensionPath)
  assert.equal(mapped.bridge.registered, true)
  assert.equal(mapped.spicetify.configPath, detection.spicetify.configPath)
  assert.equal(mapped.credentials.present, true)
  assert.equal(mapped.credentials.directory, "C:\\Users\\Test\\AppData\\Roaming\\opencode-spotify")
  assert.equal(mapped.backups.present, true)
  assert.equal(mapped.opencode.configPath, detection.opencode.configPath)
})

test("inventoryFromDetection stays conservative when detection reports absence", () => {
  const runtime = fakeRuntime()
  runtime.state.opencode.listVersion = null
  runtime.state.bridge.installed = false
  runtime.state.spicetify.registered = false
  const detection = fakeDetection(runtime)
  detection.bridge.configExists = false
  detection.bridge.registration = "absent"

  const mapped = inventoryFromDetection(detection)
  assert.equal(mapped.registration.registered, false)
  assert.equal(mapped.bridge.registered, false)
  assert.equal(mapped.credentials.present, false)
  assert.equal(mapped.credentials.directory, null)
  assert.equal(mapped.backups.present, false)
})
