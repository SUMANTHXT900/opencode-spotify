// Initial dashboard + adaptive main menu for the interactive installer shell.
//
// This module is deliberately pure and dependency-free:
//   - no filesystem, network, child processes, or Ink imports
//   - no version comparison; callers pass display-ready facts, including
//     `updateAvailable`, which the backend has already decided
//   - bounded inline output (never a full-screen takeover)
//
// The Ink shell (C13) owns input wiring and screen layout. It can use the
// keyboard reducer plus the plain text lines below, or render its own
// components from `dashboardRows()`:
//
//   const state = createMenuState(facts)
//   useInput((input, key) => {
//     const next = reduceMenu(state, menuKeyFromInk(input, key))
//     if (next.outcome.type === "selected") dispatch(next.outcome.action)
//     ...
//   })

export type MenuAction =
  | "install:auto"
  | "install:manual"
  | "update:all"
  | "update:plugin"
  | "update:spicetify"
  | "repair"
  | "status"
  | "uninstall"
  | "exit"

/** `partial` is an existing-but-incomplete install: maintenance actions apply. */
export type InstallState = "fresh" | "installed" | "partial"

export interface ComponentVersionView {
  installed: string | null
  latest: string | null
  /** Decided by the backend. The menu never compares version strings. */
  updateAvailable: boolean
  /** Optional backend note, for example "local development" or "pinned". */
  note?: string
}

/**
 * Display-ready snapshot for the dashboard. Every value is already resolved by
 * the backend; the UI only formats it. Version display values may be null when
 * a component is absent or unknown.
 */
export interface DashboardFacts {
  installerVersion: string
  windows: boolean
  windowsVersion: string
  arch: string
  node: string
  installState: InstallState
  opencode: { available: boolean; version: string | null }
  spotify: { installed: boolean; version?: string | null; store?: boolean }
  spicetify: ComponentVersionView
  plugin: ComponentVersionView & { registered?: boolean; local?: boolean }
}

export interface DashboardRow {
  component: string
  installed: string
  latest: string
  status: string
}

export interface MenuItem {
  action: MenuAction
  label: string
  hint: string
}

export interface MenuState {
  facts: DashboardFacts
  items: MenuItem[]
  selected: number
}

export type MenuKey =
  | "up"
  | "down"
  | "home"
  | "end"
  | "enter"
  | "back"
  | "cancel"
  | "ignore"

export type MenuOutcome =
  | { type: "none" }
  | { type: "selected"; action: MenuAction; item: MenuItem }
  | { type: "back" }
  | { type: "cancel" }

export interface MenuTransition {
  state: MenuState
  outcome: MenuOutcome
}

export interface RenderOptions {
  /** Hard character bound for every rendered line. Defaults to 72. */
  width?: number
  /** Emit ANSI styling. Off by default so callers can style in Ink. */
  color?: boolean
  /** Include the one-line key legend. Defaults to true. */
  showHints?: boolean
  /** Optional bound on total lines for caller-owned inline regions. */
  maxRows?: number
}

const ANSI = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  cyan: "\u001b[36m",
}

const DEFAULT_WIDTH = 72
const TABLE_MIN_WIDTH = 56
const COMPONENT_WIDTH = 11
const INSTALLED_WIDTH = 13
const LATEST_WIDTH = 13

const LEGEND = "↑/↓ move · Enter select · Esc back · Ctrl+C cancel"

function paint(color: boolean, code: string, text: string): string {
  return color ? `${code}${text}${ANSI.reset}` : text
}

/** Truncate by code point so no line can exceed the requested bound. */
function fit(text: string, width: number): string {
  const chars = [...text]
  if (chars.length <= width) return text
  if (width <= 0) return ""
  if (width === 1) return "…"
  return `${chars.slice(0, width - 1).join("")}…`
}

function boundedWidth(options: RenderOptions): number {
  return Math.max(24, options.width ?? DEFAULT_WIDTH)
}

export function isExistingInstall(facts: DashboardFacts): boolean {
  return facts.installState !== "fresh"
}

export function selectedItem(state: MenuState): MenuItem | null {
  return state.items[state.selected] ?? null
}

/**
 * Build the adaptively applicable menu. Inapplicable actions are omitted, never
 * rendered disabled:
 *   - fresh install: install / manual install / status / exit
 *   - existing install: updates only for outdated components, plus repair,
 *     status, uninstall, and exit
 *
 * "Update everything" appears only when both update targets are pending; a
 * single pending update is offered by its specific entry so no redundant or
 * misleading choice is shown.
 */
export function menuItems(facts: DashboardFacts): MenuItem[] {
  if (!isExistingInstall(facts)) {
    return [
      {
        action: "install:auto",
        label: "Install automatically",
        hint: "Install the plugin and bridge with recommended defaults",
      },
      {
        action: "install:manual",
        label: "Install manually",
        hint: "Review each install step before it runs",
      },
      {
        action: "status",
        label: "Status + diagnostics",
        hint: "Read-only environment and compatibility report",
      },
      {
        action: "exit",
        label: "Exit",
        hint: "Leave without changing anything",
      },
    ]
  }

  const items: MenuItem[] = []
  const pluginUpdate = facts.plugin.updateAvailable
  const spicetifyUpdate = facts.spicetify.updateAvailable
  if (pluginUpdate && spicetifyUpdate) {
    items.push({
      action: "update:all",
      label: "Update everything",
      hint: "Update the plugin and Spicetify together",
    })
  }
  if (pluginUpdate) {
    items.push({
      action: "update:plugin",
      label: "Update plugin only",
      hint: "Update the OpenCode plugin and leave Spicetify alone",
    })
  }
  if (spicetifyUpdate) {
    items.push({
      action: "update:spicetify",
      label: "Update Spicetify only",
      hint: "Update the Spicetify CLI and leave the plugin alone",
    })
  }
  items.push(
    {
      action: "repair",
      label: "Repair",
      hint: "Restore missing or damaged owned files and registration",
    },
    {
      action: "status",
      label: "Status + diagnostics",
      hint: "Read-only environment and compatibility report",
    },
    {
      action: "uninstall",
      label: "Uninstall",
      hint: "Remove the registration and owned bridge files",
    },
    {
      action: "exit",
      label: "Exit",
      hint: "Leave without changing anything",
    },
  )
  return items
}

export function createMenuState(facts: DashboardFacts): MenuState {
  return { facts, items: menuItems(facts), selected: 0 }
}

/**
 * Replace dashboard facts after a refresh, keeping the selected action when it
 * is still applicable and falling back to the first entry otherwise.
 */
export function withFacts(state: MenuState, facts: DashboardFacts): MenuState {
  const items = menuItems(facts)
  const previous = selectedItem(state)?.action
  const index = previous ? items.findIndex((item) => item.action === previous) : -1
  return { facts, items, selected: index >= 0 ? index : 0 }
}

function updateStatus(view: ComponentVersionView): string {
  if (view.installed === null) return "not installed"
  if (view.updateAvailable) return "update available"
  if (view.latest === null) return "latest unknown"
  return view.note ? `up to date (${view.note})` : "up to date"
}

/** Structured dashboard rows, also usable directly by an Ink renderer. */
export function dashboardRows(facts: DashboardFacts): DashboardRow[] {
  const opencode = facts.opencode.available
    ? facts.opencode.version ?? "detected (unknown version)"
    : "—"
  const spotify = facts.spotify.installed
    ? facts.spotify.version ?? "installed"
    : "—"
  const plugin = facts.plugin.installed
    ?? (facts.plugin.registered ? "registered (unknown version)" : "—")
  const pluginStatus = facts.plugin.installed === null && facts.plugin.registered === true
    ? (facts.plugin.updateAvailable ? "update available" : "registered")
    : updateStatus(facts.plugin)
  return [
    { component: "Installer", installed: facts.installerVersion, latest: "—", status: "—" },
    {
      component: "OpenCode",
      installed: opencode,
      latest: "—",
      status: facts.opencode.available ? "ready" : "not detected",
    },
    {
      component: "Spotify",
      installed: spotify,
      latest: "—",
      status: facts.spotify.installed ? (facts.spotify.store ? "store build" : "ready") : "not detected",
    },
    {
      component: "Spicetify",
      installed: facts.spicetify.installed ?? "—",
      latest: facts.spicetify.latest ?? "—",
      status: updateStatus(facts.spicetify),
    },
    {
      component: "Plugin",
      installed: plugin,
      latest: facts.plugin.latest ?? "—",
      status: pluginStatus,
    },
  ]
}

function environmentLine(facts: DashboardFacts): string {
  const os = facts.windows ? facts.windowsVersion || "Windows" : "Unsupported OS"
  return `${os} · ${facts.arch} · Node ${facts.node}`
}

function tableRow(row: DashboardRow): string {
  return `${row.component.padEnd(COMPONENT_WIDTH)}  ${row.installed.padEnd(INSTALLED_WIDTH)}  ${row.latest.padEnd(LATEST_WIDTH)}  ${row.status}`
}

function compactRow(row: DashboardRow): string {
  const parts = [row.installed]
  if (row.latest !== "—") parts.push(`latest ${row.latest}`)
  if (row.status !== "—") parts.push(row.status)
  return `${row.component.padEnd(COMPONENT_WIDTH)} ${parts.join(" · ")}`
}

/** Bounded dashboard block: header, environment, and version/update table. */
export function renderDashboard(facts: DashboardFacts, options: RenderOptions = {}): string[] {
  const width = boundedWidth(options)
  const color = options.color === true
  const lines: string[] = [
    paint(color, ANSI.bold, fit(`OpenCode Spotify · installer ${facts.installerVersion}`, width)),
    paint(color, ANSI.dim, fit(environmentLine(facts), width)),
    "",
  ]

  if (width >= TABLE_MIN_WIDTH) {
    lines.push(fit(
      `${"Component".padEnd(COMPONENT_WIDTH)}  ${"Installed".padEnd(INSTALLED_WIDTH)}  ${"Latest".padEnd(LATEST_WIDTH)}  Status`,
      width,
    ))
    for (const row of dashboardRows(facts)) lines.push(fit(tableRow(row), width))
  } else {
    for (const row of dashboardRows(facts)) {
      lines.push(paint(color, ANSI.dim, fit(compactRow(row), width)))
    }
  }
  return lines
}

/** Bounded menu block with the selected entry's hint on one footer line. */
export function renderMenu(state: MenuState, options: RenderOptions = {}): string[] {
  const width = boundedWidth(options)
  const color = options.color === true
  const items = state.items
  if (!items.length) return []

  const lines = [paint(color, ANSI.bold, fit("Main menu", width))]
  items.forEach((item, index) => {
    const isSelected = index === state.selected
    const content = fit(`${isSelected ? ">" : " "} ${item.label}`, width)
    lines.push(isSelected ? paint(color, ANSI.cyan, content) : content)
  })
  if (options.showHints !== false) {
    const hint = selectedItem(state)?.hint
    if (hint) {
      lines.push("")
      lines.push(paint(color, ANSI.dim, fit(hint, width)))
    }
    lines.push(paint(color, ANSI.dim, fit(LEGEND, width)))
  }
  return lines
}

/** Full inline screen: dashboard, blank separator, menu, and legend. */
export function renderMainMenuScreen(state: MenuState, options: RenderOptions = {}): string[] {
  const lines = [
    ...renderDashboard(state.facts, options),
    "",
    ...renderMenu(state, options),
  ]
  return typeof options.maxRows === "number"
    ? lines.slice(0, Math.max(0, options.maxRows))
    : lines
}

/**
 * Pure keyboard reducer. Navigation wraps; Enter reports the chosen action
 * without mutating state; Escape reports `back` and Ctrl+C reports `cancel` so
 * the shell can unwind safely.
 */
export function reduceMenu(state: MenuState, key: MenuKey): MenuTransition {
  const count = state.items.length
  if (!count) return { state, outcome: { type: "none" } }
  switch (key) {
    case "up":
      return { state: { ...state, selected: (state.selected - 1 + count) % count }, outcome: { type: "none" } }
    case "down":
      return { state: { ...state, selected: (state.selected + 1) % count }, outcome: { type: "none" } }
    case "home":
      return { state: { ...state, selected: 0 }, outcome: { type: "none" } }
    case "end":
      return { state: { ...state, selected: count - 1 }, outcome: { type: "none" } }
    case "enter": {
      const item = state.items[state.selected]
      if (!item) return { state, outcome: { type: "none" } }
      return { state, outcome: { type: "selected", action: item.action, item } }
    }
    case "back":
      return { state, outcome: { type: "back" } }
    case "cancel":
      return { state, outcome: { type: "cancel" } }
    default:
      return { state, outcome: { type: "none" } }
  }
}

export interface InkKeyLike {
  upArrow?: boolean
  downArrow?: boolean
  leftArrow?: boolean
  rightArrow?: boolean
  return?: boolean
  escape?: boolean
  ctrl?: boolean
  tab?: boolean
  shift?: boolean
  meta?: boolean
}

/**
 * Translate an Ink `useInput(input, key)` event into the shell-neutral key
 * vocabulary. Unknown input maps to `ignore`, which `reduceMenu` leaves inert.
 */
export function menuKeyFromInk(input: string, key: InkKeyLike = {}): MenuKey {
  if ((key.ctrl === true && input.toLowerCase() === "c") || input === "\u0003") return "cancel"
  if (key.upArrow === true) return "up"
  if (key.downArrow === true) return "down"
  if (key.return === true || input === "\r" || input === "\n") return "enter"
  if (key.escape === true || input === "\u001b") return "back"
  return "ignore"
}
