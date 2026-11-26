import { test } from "node:test"
import assert from "node:assert/strict"
import {
  createMenuState,
  dashboardRows,
  isExistingInstall,
  menuItems,
  menuKeyFromInk,
  reduceMenu,
  renderDashboard,
  renderMainMenuScreen,
  renderMenu,
  selectedItem,
  withFacts,
  type DashboardFacts,
  type InstallState,
  type MenuAction,
  type MenuState,
} from "../src/cli/ui/menu.ts"

function baseFacts(overrides: Partial<DashboardFacts> = {}): DashboardFacts {
  return {
    installerVersion: "0.6.0-beta.3",
    windows: true,
    windowsVersion: "Windows 11",
    arch: "x64",
    node: "22.18.0",
    installState: "fresh",
    opencode: { available: true, version: "2.4.1" },
    spotify: { installed: true, version: null, store: false },
    spicetify: { installed: null, latest: "2.47.0", updateAvailable: false },
    plugin: { installed: null, latest: "0.6.0-beta.3", updateAvailable: false },
    ...overrides,
  }
}

function existingFacts(options: {
  pluginUpdate?: boolean
  spicetifyUpdate?: boolean
  installState?: InstallState
} = {}): DashboardFacts {
  const pluginUpdate = options.pluginUpdate === true
  const spicetifyUpdate = options.spicetifyUpdate === true
  return baseFacts({
    installState: options.installState ?? "installed",
    plugin: {
      installed: "0.6.0-beta.1",
      latest: "0.6.0-beta.3",
      updateAvailable: pluginUpdate,
      registered: true,
    },
    spicetify: {
      installed: "2.46.7",
      latest: "2.47.0",
      updateAvailable: spicetifyUpdate,
    },
  })
}

function actions(facts: DashboardFacts): MenuAction[] {
  return menuItems(facts).map((item) => item.action)
}

function row(facts: DashboardFacts, component: string) {
  const found = dashboardRows(facts).find((entry) => entry.component === component)
  if (!found) throw new Error(`missing dashboard row: ${component}`)
  return found
}

function lineLength(line: string): number {
  return [...line].length
}

function assertBounded(lines: string[], width: number): void {
  for (const line of lines) {
    assert.ok(lineLength(line) <= width, `line exceeds ${width}: ${JSON.stringify(line)}`)
    assert.ok(!line.includes("\n"), "each rendered line must be a single line")
  }
}

const FRESH_ACTIONS: MenuAction[] = ["install:auto", "install:manual", "status", "exit"]
const CURRENT_ACTIONS: MenuAction[] = ["repair", "status", "uninstall", "exit"]

test("dashboard shows installer, platform, Node, and every component", () => {
  const facts = baseFacts()
  assert.deepEqual(
    dashboardRows(facts).map((entry) => entry.component),
    ["Installer", "OpenCode", "Spotify", "Spicetify", "Plugin"],
  )
  assert.equal(row(facts, "Installer").installed, "0.6.0-beta.3")
  assert.equal(row(facts, "OpenCode").installed, "2.4.1")
  assert.equal(row(facts, "OpenCode").status, "ready")
  assert.equal(row(facts, "Spotify").installed, "installed")
  assert.equal(row(facts, "Spotify").status, "ready")
  assert.equal(row(facts, "Spicetify").installed, "—")
  assert.equal(row(facts, "Spicetify").latest, "2.47.0")
  assert.equal(row(facts, "Spicetify").status, "not installed")
  assert.equal(row(facts, "Plugin").installed, "—")
  assert.equal(row(facts, "Plugin").latest, "0.6.0-beta.3")
  assert.equal(row(facts, "Plugin").status, "not installed")

  const screen = renderDashboard(facts).join("\n")
  assert.match(screen, /OpenCode Spotify · installer 0\.6\.0-beta\.3/)
  assert.match(screen, /Windows 11 · x64 · Node 22\.18\.0/)
  assert.match(screen, /Component\s+Installed\s+Latest\s+Status/)
})

test("dashboard reflects absent components and non-Windows hosts", () => {
  const facts = baseFacts({
    windows: false,
    windowsVersion: "unsupported",
    arch: "arm64",
    opencode: { available: false, version: null },
    spotify: { installed: false, version: null },
  })
  assert.equal(row(facts, "OpenCode").installed, "—")
  assert.equal(row(facts, "OpenCode").status, "not detected")
  assert.equal(row(facts, "Spotify").installed, "—")
  assert.equal(row(facts, "Spotify").status, "not detected")
  assert.match(renderDashboard(facts).join("\n"), /Unsupported OS · arm64 · Node 22\.18\.0/)

  const store = baseFacts({ spotify: { installed: true, store: true } })
  assert.equal(row(store, "Spotify").status, "store build")
})

test("dashboard update availability comes from backend flags, not version comparison", () => {
  // Installed equals latest, yet the backend says an update applies.
  const flagged = baseFacts({
    installState: "installed",
    plugin: { installed: "0.6.0-beta.3", latest: "0.6.0-beta.3", updateAvailable: true },
    spicetify: { installed: "2.46.7", latest: "2.46.7", updateAvailable: false },
  })
  assert.equal(row(flagged, "Plugin").status, "update available")
  assert.equal(row(flagged, "Spicetify").status, "up to date")

  // Installed is newer than latest, but the backend did not flag an update:
  // the UI must not infer a downgrade or an update on its own.
  const notFlagged = baseFacts({
    installState: "installed",
    plugin: { installed: "9.9.9", latest: "1.0.0", updateAvailable: false },
  })
  assert.equal(row(notFlagged, "Plugin").status, "up to date")

  const unknownLatest = baseFacts({
    installState: "installed",
    plugin: { installed: "0.6.0-beta.1", latest: null, updateAvailable: false },
  })
  assert.equal(row(unknownLatest, "Plugin").status, "latest unknown")

  const local = existingFacts()
  const localNote = {
    ...local,
    plugin: { ...local.plugin, note: "local development" },
  }
  assert.equal(row(localNote, "Plugin").status, "up to date (local development)")

  const registered = baseFacts({
    installState: "partial",
    plugin: { installed: null, latest: null, updateAvailable: false, registered: true },
  })
  assert.equal(row(registered, "Plugin").status, "registered")
})

test("fresh install menu offers only applicable install actions", () => {
  const facts = baseFacts()
  assert.equal(isExistingInstall(facts), false)
  assert.deepEqual(actions(facts), FRESH_ACTIONS)
  assert.deepEqual(
    menuItems(facts).map((item) => item.label),
    ["Install automatically", "Install manually", "Status + diagnostics", "Exit"],
  )
  assert.ok(!actions(facts).includes("uninstall"))
  assert.ok(!actions(facts).includes("repair"))
  assert.ok(!actions(facts).some((action) => action.startsWith("update:")))
})

test("fresh install ignores contradictory backend update flags", () => {
  const contradictory = baseFacts({
    plugin: { installed: "0.6.0-beta.1", latest: "0.6.0-beta.3", updateAvailable: true },
    spicetify: { installed: "2.46.7", latest: "2.47.0", updateAvailable: true },
  })
  assert.equal(contradictory.installState, "fresh")
  assert.deepEqual(actions(contradictory), FRESH_ACTIONS)
})

test("existing install with both updates offers all update choices", () => {
  const facts = existingFacts({ pluginUpdate: true, spicetifyUpdate: true })
  assert.equal(isExistingInstall(facts), true)
  assert.deepEqual(actions(facts), [
    "update:all",
    "update:plugin",
    "update:spicetify",
    "repair",
    "status",
    "uninstall",
    "exit",
  ])
  assert.deepEqual(
    menuItems(facts).map((item) => item.label),
    [
      "Update everything",
      "Update plugin only",
      "Update Spicetify only",
      "Repair",
      "Status + diagnostics",
      "Uninstall",
      "Exit",
    ],
  )
  assert.equal(selectedItem(createMenuState(facts))?.action, "update:all")
})

test("single pending update is offered only by its specific action", () => {
  const pluginOnly = existingFacts({ pluginUpdate: true })
  assert.deepEqual(actions(pluginOnly), ["update:plugin", ...CURRENT_ACTIONS])
  assert.ok(!actions(pluginOnly).includes("update:all"))
  assert.ok(!actions(pluginOnly).includes("update:spicetify"))

  const spicetifyOnly = existingFacts({ spicetifyUpdate: true })
  assert.deepEqual(actions(spicetifyOnly), ["update:spicetify", ...CURRENT_ACTIONS])
  assert.ok(!actions(spicetifyOnly).includes("update:all"))
  assert.ok(!actions(spicetifyOnly).includes("update:plugin"))
})

test("current and partial installs omit every update action", () => {
  assert.deepEqual(actions(existingFacts()), CURRENT_ACTIONS)
  assert.deepEqual(actions(existingFacts({ installState: "partial" })), CURRENT_ACTIONS)
  for (const facts of [existingFacts(), existingFacts({ installState: "partial" })]) {
    assert.ok(!actions(facts).some((action) => action.startsWith("update:")))
    assert.ok(!actions(facts).some((action) => action.startsWith("install:")))
  }
})

test("update matrix never presents an inapplicable action", () => {
  for (const pluginUpdate of [false, true]) {
    for (const spicetifyUpdate of [false, true]) {
      const facts = existingFacts({ pluginUpdate, spicetifyUpdate })
      const ids = actions(facts)
      assert.equal(ids.includes("update:all"), pluginUpdate && spicetifyUpdate)
      assert.equal(ids.includes("update:plugin"), pluginUpdate)
      assert.equal(ids.includes("update:spicetify"), spicetifyUpdate)
      assert.equal(new Set(ids).size, ids.length, "menu actions must be unique")
      for (const core of CURRENT_ACTIONS) assert.ok(ids.includes(core))
      for (const install of ["install:auto", "install:manual"] as const) {
        assert.ok(!ids.includes(install))
      }
    }
  }
})

test("arrow navigation wraps and Home/End jump to the edges", () => {
  const initial = createMenuState(existingFacts({ pluginUpdate: true, spicetifyUpdate: true }))
  const count = initial.items.length
  assert.equal(count, 7)

  const down = reduceMenu(initial, "down")
  assert.equal(down.state.selected, 1)
  assert.deepEqual(down.outcome, { type: "none" })
  assert.equal(initial.selected, 0, "reducer must not mutate the previous state")

  assert.equal(reduceMenu(initial, "up").state.selected, count - 1, "up wraps to the last item")
  assert.equal(
    reduceMenu({ ...initial, selected: count - 1 }, "down").state.selected,
    0,
    "down wraps to the first item",
  )
  assert.equal(reduceMenu({ ...initial, selected: 3 }, "home").state.selected, 0)
  assert.equal(reduceMenu(initial, "end").state.selected, count - 1)
  assert.equal(selectedItem({ ...initial, selected: count - 1 })?.action, "exit")
})

test("Enter confirms the selected action without mutating state", () => {
  const state = createMenuState(existingFacts({ pluginUpdate: true, spicetifyUpdate: true }))
  const atSpicetify = reduceMenu(reduceMenu(state, "down").state, "down").state
  assert.equal(selectedItem(atSpicetify)?.action, "update:spicetify")

  const transition = reduceMenu(atSpicetify, "enter")
  assert.equal(transition.outcome.type, "selected")
  if (transition.outcome.type === "selected") {
    assert.equal(transition.outcome.action, "update:spicetify")
    assert.equal(transition.outcome.item.label, "Update Spicetify only")
  }
  assert.equal(transition.state.selected, atSpicetify.selected)
  assert.equal(atSpicetify.selected, 2)
})

test("End + Enter chooses Exit", () => {
  const state = createMenuState(existingFacts())
  const transition = reduceMenu(reduceMenu(state, "end").state, "enter")
  assert.equal(transition.outcome.type, "selected")
  if (transition.outcome.type === "selected") assert.equal(transition.outcome.action, "exit")
})

test("Escape backs out and Ctrl+C cancels", () => {
  const state = createMenuState(existingFacts())
  assert.deepEqual(reduceMenu(state, "back").outcome, { type: "back" })
  assert.deepEqual(reduceMenu(state, "cancel").outcome, { type: "cancel" })
  assert.deepEqual(reduceMenu(state, "ignore").outcome, { type: "none" })
})

test("Ink key events map to the shell-neutral vocabulary", () => {
  assert.equal(menuKeyFromInk("", { upArrow: true }), "up")
  assert.equal(menuKeyFromInk("", { downArrow: true }), "down")
  assert.equal(menuKeyFromInk("\r", { return: true }), "enter")
  assert.equal(menuKeyFromInk("", { escape: true }), "back")
  assert.equal(menuKeyFromInk("c", { ctrl: true }), "cancel")
  assert.equal(menuKeyFromInk("C", { ctrl: true }), "cancel")
  assert.equal(menuKeyFromInk("\u0003"), "cancel")
  assert.equal(menuKeyFromInk("\u001b"), "back")
  assert.equal(menuKeyFromInk("x"), "ignore")
  assert.equal(menuKeyFromInk("", { leftArrow: true }), "ignore")

  const state = createMenuState(existingFacts())
  assert.deepEqual(
    reduceMenu(state, menuKeyFromInk("c", { ctrl: true })).outcome,
    { type: "cancel" },
  )
})

test("withFacts preserves an applicable selection and falls back safely", () => {
  let state = createMenuState(existingFacts({ pluginUpdate: true, spicetifyUpdate: true }))
  state = reduceMenu(state, "down").state
  assert.equal(selectedItem(state)?.action, "update:plugin")

  const sameShape = withFacts(state, existingFacts({ pluginUpdate: true, spicetifyUpdate: true }))
  assert.equal(selectedItem(sameShape)?.action, "update:plugin")
  assert.equal(sameShape.selected, 1)

  const removed = withFacts(state, existingFacts())
  assert.equal(removed.selected, 0)
  assert.equal(selectedItem(removed)?.action, "repair")

  const onExit = reduceMenu(state, "end").state
  const stillExisting = withFacts(onExit, existingFacts())
  assert.equal(selectedItem(stillExisting)?.action, "exit")
})

test("menu renders bounded, with a contextual hint and key legend", () => {
  const state = createMenuState(existingFacts())
  const lines = renderMenu(state)
  assert.ok(lines.some((line) => line.includes("> Repair")))
  assert.ok(lines.some((line) => line.includes("Restore missing or damaged")))
  assert.ok(lines.some((line) => line.includes("Enter select")))

  const withoutHints = renderMenu(state, { showHints: false })
  assert.ok(!withoutHints.some((line) => line.includes("Enter select")))
  assert.ok(!withoutHints.some((line) => line.includes("Restore missing or damaged")))
})

test("full inline screen is compact and never exceeds the requested width", () => {
  const state = createMenuState(existingFacts({ pluginUpdate: true, spicetifyUpdate: true }))
  const screen = renderMainMenuScreen(state)
  assert.ok(screen.length <= 24, `default screen should stay inline (got ${screen.length} lines)`)
  const text = screen.join("\n")
  assert.match(text, /installer 0\.6\.0-beta\.3/)
  assert.match(text, /Main menu/)
  assert.match(text, /> Update everything/)
  assert.ok(!text.includes("\u001b["), "plain rendering must not leak ANSI")

  for (const width of [24, 40, 55, 72, 100]) {
    assertBounded(renderMainMenuScreen(state, { width }), width)
  }
  assert.equal(renderMainMenuScreen(state, { maxRows: 6 }).length, 6)
  assert.equal(renderMainMenuScreen(state, { maxRows: 0 }).length, 0)
})

test("narrow dashboards collapse to a compact key/value block", () => {
  const facts = existingFacts({ pluginUpdate: true })
  const wide = renderDashboard(facts, { width: 72 }).join("\n")
  assert.match(wide, /Component\s+Installed\s+Latest\s+Status/)

  const narrowLines = renderDashboard(facts, { width: 40 })
  const narrow = narrowLines.join("\n")
  assert.ok(!narrow.includes("Component"), "table header is dropped when it cannot fit")
  for (const component of ["Installer", "OpenCode", "Spotify", "Spicetify", "Plugin"]) {
    assert.ok(narrow.includes(component), `compact view keeps ${component}`)
  }
  assert.match(narrow, /·/)
  assertBounded(narrowLines, 40)
})

test("ANSI styling is opt-in", () => {
  const facts = baseFacts()
  assert.ok(!renderDashboard(facts).join("\n").includes("\u001b["))
  assert.match(renderDashboard(facts, { color: true }).join("\n"), /\u001b\[/)
  assert.ok(!renderMenu(createMenuState(facts)).join("\n").includes("\u001b["))
  assert.match(renderMenu(createMenuState(facts), { color: true }).join("\n"), /\u001b\[/)
})

test("selection stays valid through repeated navigation", () => {
  const state = createMenuState(existingFacts({ pluginUpdate: true, spicetifyUpdate: true }))
  let current: MenuState = state
  for (let index = 0; index < 25; index++) {
    current = reduceMenu(current, index % 2 === 0 ? "down" : "up").state
    assert.ok(current.selected >= 0 && current.selected < current.items.length)
    assert.ok(selectedItem(current) !== null)
  }
})
