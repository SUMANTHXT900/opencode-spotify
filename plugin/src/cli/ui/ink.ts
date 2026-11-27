// Ink presentation shell (A03 section 4 / A04 section 3).
//
// This is the only CLI module allowed to touch ink/react/@inkjs-ui, and it does
// so with runtime dynamic imports so plain-mode installs, headless runs and
// tests can import the rest of `src/cli` without the TUI stack installed. The
// installer always runs under plain Node; OpenTUI is never initialized here.
import type { CancelToken } from "../cancel.ts"
import type {
  InstallerSnapshot,
  InstallerStore,
  LogLevel,
  Presentation,
  ProgressEvent,
  ProgressReporter,
  PromptRequest,
  Ui,
} from "../types.ts"
import {
  limitViewRows,
  toInkView,
  type InkPromptState,
  type InkRow,
  type InkTone,
} from "./ink-view.ts"
import { createDesignSystem } from "./components.ts"
import { glyphsFor } from "./glyphs.ts"
import { layoutFor } from "./layout.ts"
import { createPromptController, type PromptController } from "./ink-prompt.ts"
import { themeFor, type Theme, type ThemeMode } from "./tokens.ts"
import { truncateDisplay } from "./normalize.ts"

// Version ranges for the Ink/React stack live in the master-owned
// package.json (WP-C). This module never duplicates them: remediation
// messages below point at reinstalling the package's dependencies instead
// of naming versions that would drift from the manifest.

// Built at runtime so TypeScript does not statically resolve these optional
// peer modules. That keeps `tsc -p tsconfig.cli.json` green before the master
// adds the dependencies, and keeps ink/react out of every non-UI import graph.
const INK_SPECIFIER = ["in", "k"].join("")
const REACT_SPECIFIER = ["re", "act"].join("")
// @inkjs/ui is only needed for the wide, color-enabled progress bar. It is
// still loaded dynamically (below) so plain mode and tests never pull it in.
const INK_UI_SPECIFIER = ["@inkjs", "ui"].join("/")

export interface InkKey {
  return?: boolean
  escape?: boolean
  ctrl?: boolean
  meta?: boolean
  backspace?: boolean
  delete?: boolean
  upArrow?: boolean
  downArrow?: boolean
  [key: string]: unknown
}

interface InkInstance {
  unmount(): void
  waitUntilExit?(): Promise<void>
}

interface InkComponent {
  (props: Record<string, unknown>): unknown
}

interface InkRuntime {
  render(element: unknown, options?: Record<string, unknown>): InkInstance
  Box: unknown
  Text: unknown
  useInput(handler: (input: string, key: InkKey) => void, options?: { isActive?: boolean }): void
  useWindowSize?(): { columns?: number; rows?: number }
  useStdin?(): { isRawModeSupported?: boolean }
}

interface ReactRuntime {
  createElement(type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]): unknown
  useState<T>(initial: T | (() => T)): [T, (value: T | ((previous: T) => T)) => void]
  useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void
}

/**
 * Validated @inkjs/ui surface. Only ProgressBar and the theme helpers are used:
 * Select/ConfirmInput/TextInput/Spinner/StatusMessage/Alert would regress the
 * ASCII, no-color, one-row and phrase-consent behavior of this shell.
 */
export interface InkUiRuntime {
  ThemeProvider: InkComponent
  ProgressBar: InkComponent
  defaultTheme: unknown
  extendTheme(originalTheme: unknown, nextTheme: unknown): unknown
}

/** Structural view of process.stdin; `setRawMode` only exists on a TTY. */
export type InkStdin = NodeJS.ReadStream & {
  setRawMode?(mode: boolean): void
}

export interface InkPresentationOptions {
  /** ANSI styling switch; the layout itself is ASCII-safe. */
  color: boolean
  /** Terminal palette. Defaults to the dark Spotify-green tokens. */
  theme?: ThemeMode
  stdin?: InkStdin
  stdout?: NodeJS.WriteStream
  stderr?: NodeJS.WriteStream
  /** Operation cancellation; Ctrl+C requests it instead of unmounting. */
  cancel?: CancelToken
  /** Environment seam for NO_COLOR handling; defaults to process.env. */
  env?: NodeJS.ProcessEnv
}

export interface InkPresentation extends Presentation {
  /**
   * 130 only for the legacy no-token Ctrl+C path. With an injected CancelToken
   * the operation's settled state (and main) own the exit code.
   */
  exitCode(): number | undefined
}

function toneColor(tone: InkTone, theme: Theme): string | undefined {
  switch (tone) {
    case "dim": return theme.muted
    case "ok": return theme.ok
    case "warn": return theme.warn
    case "error": return theme.error
    case "accent": return theme.accent
    default: return theme.text
  }
}

const STATUS_LEVELS: Record<Parameters<Ui["status"]>[0], LogLevel> = {
  ok: "success",
  missing: "debug",
  warn: "warn",
  fail: "error",
  info: "info",
}

function unwrapModule(module: unknown): Record<string, unknown> {
  if (!module || typeof module !== "object") return {}
  const record = module as Record<string, unknown>
  const fallback = record.default
  // React is CJS: its namespace default is module.exports. Ink is ESM with
  // named exports, so its namespace is used directly.
  if (fallback && typeof fallback === "object") return fallback as Record<string, unknown>
  return record
}

/** Structural validation of the dynamically loaded @inkjs/ui module. */
function validateInkUi(module: unknown): InkUiRuntime | undefined {
  if (!module || typeof module !== "object") return undefined
  const record = module as Record<string, unknown>
  if (
    typeof record.ThemeProvider !== "function" ||
    typeof record.ProgressBar !== "function" ||
    typeof record.extendTheme !== "function" ||
    !record.defaultTheme
  ) {
    return undefined
  }
  return {
    ThemeProvider: record.ThemeProvider as InkComponent,
    ProgressBar: record.ProgressBar as InkComponent,
    defaultTheme: record.defaultTheme,
    extendTheme: record.extendTheme as InkUiRuntime["extendTheme"],
  }
}

interface LoadedRuntime {
  ink: InkRuntime
  react: ReactRuntime
  /** undefined when @inkjs/ui is missing or broken: the ASCII row is used. */
  inkUi?: InkUiRuntime
}

async function loadRuntime(): Promise<LoadedRuntime> {
  let inkModule: unknown
  let reactModule: unknown
  let uiModule: unknown
  try {
    ;[inkModule, reactModule] = await Promise.all([import(INK_SPECIFIER), import(REACT_SPECIFIER)])
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(
      `Ink UI dependencies are unavailable (${detail}). ` +
      `Install the package's dependencies to use the interactive installer.`,
    )
  }
  try {
    uiModule = await import(INK_UI_SPECIFIER)
  } catch {
    // ProgressBar is an enhancement, not a requirement for a usable shell.
    uiModule = undefined
  }

  const ink = unwrapModule(inkModule) as unknown as InkRuntime
  const react = unwrapModule(reactModule) as unknown as ReactRuntime
  if (
    typeof ink.render !== "function" ||
    !ink.Box ||
    !ink.Text ||
    typeof ink.useInput !== "function"
  ) {
    throw new Error(
      `Ink is missing render/Box/Text/useInput. ` +
      `Reinstall the package with compatible dependencies.`,
    )
  }
  if (
    typeof react.createElement !== "function" ||
    typeof react.useState !== "function" ||
    typeof react.useEffect !== "function"
  ) {
    throw new Error(
      `React is missing createElement/useState/useEffect. ` +
      `Reinstall the package with compatible dependencies.`,
    )
  }
  const inkUi = uiModule === undefined ? undefined : validateInkUi(unwrapModule(uiModule))
  return inkUi ? { ink, react, inkUi } : { ink, react }
}

/** Reporters pushed into the store; the shell renders the resulting snapshot. */
function createStoreReporter(store: InstallerStore): ProgressReporter {
  const emit = (event: ProgressEvent) => {
    try {
      store.dispatch(event)
    } catch {
      // A presentation failure must never abort an installer operation.
    }
  }
  return {
    emit,
    phase: (phase, label) => emit({ type: "phase", phase, label: label ?? phase, at: Date.now() }),
    step: (id, status, detail) => emit({ type: "step", id, status, detail, at: Date.now() }),
    log: (level, message) => emit({ type: "log", level, message, at: Date.now() }),
    progress: (scope, message, percent) => emit({ type: "progress", scope, message, percent, at: Date.now() }),
    prompt: (request) => emit({ type: "prompt", request, at: Date.now() }),
  }
}

export interface InkAppDependencies {
  store: InstallerStore
  controller: PromptController
  color: boolean
  theme: ThemeMode
  stdin: InkStdin
  onKey(input: string, key: InkKey): void
  /** Validated @inkjs/ui runtime; absent keeps the ASCII progress row. */
  inkUi?: InkUiRuntime
}

/**
 * Root component. React.createElement is used deliberately: the CLI build
 * excludes .tsx (tsconfig.cli.json), so no JSX pragma is required here.
 *
 * Rationale for adopting only ProgressBar from @inkjs/ui: Select/ConfirmInput/
 * TextInput/Spinner/StatusMessage/Alert would regress ASCII output, no-color
 * mode, the single-row prompt, key hints and phrase consent.
 */
export function createInkApp(
  ink: InkRuntime,
  react: ReactRuntime,
  deps: InkAppDependencies,
): InkComponent {
  const { Text, Box } = ink
  const { createElement, useEffect, useState } = react
  const useWindowSize = typeof ink.useWindowSize === "function"
    ? ink.useWindowSize
    : () => ({ columns: 80, rows: 24 })
  const useStdin = typeof ink.useStdin === "function"
    ? ink.useStdin
    : () => ({ isRawModeSupported: false })

  const staticTheme = themeFor(deps.theme)
  const progressTheme = deps.inkUi
    ? deps.inkUi.extendTheme(deps.inkUi.defaultTheme, {
        components: {
          ProgressBar: {
            styles: {
              container: () => ({ flexGrow: 1, minWidth: 0 }),
              completed: () => ({ color: staticTheme.accent }),
              remaining: () => ({ dimColor: true }),
            },
            config: () => ({ completedCharacter: "#", remainingCharacter: "-" }),
          },
        },
      })
    : undefined

  function InkApp(): unknown {
    const snapshotState = useState<InstallerSnapshot>(() => deps.store.getSnapshot())
    const snapshot = snapshotState[0]
    const setSnapshot = snapshotState[1]
    const [, setTick] = useState(0)

    useEffect(() => {
      const unsubscribe = deps.store.subscribe(() => setSnapshot(deps.store.getSnapshot()))
      return () => { unsubscribe() }
    }, [])

    const size = useWindowSize()
    const stdinState = useStdin()
    // Both guards are required: Ink's useInput sets raw mode, which throws on
    // non-TTY stdin or when the stream cannot enter raw mode. With isActive
    // false Ink skips raw mode entirely.
    const isRawModeSupported = stdinState?.isRawModeSupported === true
    const rawMode = isRawModeSupported && deps.stdin.isTTY === true

    const columns = typeof size?.columns === "number" && Number.isFinite(size.columns) ? size.columns : 80
    const layout = layoutFor(columns - 2)
    const glyphs = glyphsFor(layout)
    const theme = staticTheme
    const terminalRows = typeof size?.rows === "number" && Number.isFinite(size.rows) ? size.rows : 24
    // Compact inline region: keep the prompt/plan pinned without reserving a
    // full-screen budget on small terminals.
    const height = Math.max(10, terminalRows - 2)
    const active = deps.controller.getActive()
    const promptState: InkPromptState | undefined = active
      ? {
          id: active.request.id,
          input: active.input,
          selectedIndex: active.selectedIndex,
          ...(active.error ? { error: active.error } : {}),
        }
      : undefined
    const view = toInkView(snapshot, layout.width, {
      frame: Math.floor(Date.now() / 140),
      ...(promptState ? { prompt: promptState } : {}),
    })
    const sceneRows = view.rows.filter((row) => row.kind !== "header" && row.kind !== "meta")
    const rows = limitViewRows(sceneRows, height)
    const running = snapshot.progress !== null && snapshot.progress !== undefined
      || (snapshot.plan?.steps.some((step) => step.status === "running") ?? false)

    useEffect(() => {
      if (!running) return
      const timer = setInterval(() => setTick((value) => value + 1), 140)
      return () => clearInterval(timer)
    }, [running])

    ink.useInput((input, key) => {
      deps.onKey(input, key)
      setTick((value) => value + 1)
    }, { isActive: rawMode })

    const separator = layout.ascii ? " | " : " \u00B7 "
    const meta = [
      snapshot.command,
      snapshot.windows ? "Windows" : "Non-Windows",
      `${snapshot.phase} - ${snapshot.phaseLabel}`,
    ].join(separator)
    const ds = createDesignSystem(
      { React: { createElement }, Box: ink.Box, Text: ink.Text },
      { theme, layout, glyphs, color: deps.color },
    )

    const renderRow = (row: InkRow, index: number): unknown => {
      const key = `row-${index}`
      const progress = row.progress
      if (row.kind === "progress" && progress && deps.inkUi && deps.color && !layout.ascii) {
        // Native @inkjs/ui ProgressBar, only for wide color-enabled output.
        // ASCII completed/remaining characters are themed so the bar still
        // reads as text and never relies on color alone.
        const labelWidth = Math.max(
          8,
          layout.width - progress.barWidth - progress.spinner.length - 4,
        )
        return createElement(Box, { key, flexDirection: "row", width: layout.width },
          createElement(Text, { color: theme.accent }, `[${progress.spinner}] `),
          createElement(Box, { width: progress.barWidth },
            createElement(deps.inkUi.ProgressBar, { value: progress.percent })),
          createElement(Text, { wrap: "truncate" },
            ` ${truncateDisplay(`${progress.label} ${progress.message}`, labelWidth, glyphs.ellipsis)}`))
      }
      if (row.kind === "section") {
        const split = row.text.indexOf(" ")
        const marker = split > 0 ? row.text.slice(0, split) : row.text
        const rest = split > 0 ? row.text.slice(split) : ""
        return createElement(Text, { key, wrap: "truncate" },
          createElement(Text, deps.color ? { color: theme.rule } : {}, marker),
          createElement(Text, deps.color ? { color: theme.text, bold: true } : {}, rest))
      }
      const props: Record<string, unknown> = { key, wrap: "truncate" }
      if (deps.color) {
        const color = toneColor(row.tone, theme)
        if (color) props.color = color
        if (row.tone === "bold") props.bold = true
      }
      return createElement(Text, props, row.text.length > 0 ? row.text : " ")
    }

    const elements: unknown[] = [ds.header(`v${snapshot.version}`), ds.blank(), ds.panel(snapshot.phaseLabel, meta)]
    if (rows.length > 0) elements.push(ds.blank())
    rows.forEach((row, index) => elements.push(renderRow(row, index)))
    const document = ds.document(elements)
    return deps.inkUi && progressTheme
      ? createElement(deps.inkUi.ThemeProvider, { theme: progressTheme }, document)
      : document
  }

  return InkApp
}

/**
 * Ctrl+C translation: the first press requests cooperative cancellation, the
 * second forces it. Returning `"no-token"` is the only legacy path (standalone
 * callers that did not inject a token).
 */
export function cancelFromKey(
  cancel: CancelToken | undefined,
  dispatch: (event: ProgressEvent) => void,
): "requested" | "forced" | "no-token" {
  if (!cancel) return "no-token"
  if (!cancel.requested) {
    cancel.request("ctrl-c")
    return "requested"
  }
  if (!cancel.forced) {
    cancel.force()
    dispatch({
      type: "cancel",
      phase: "finishing",
      ...(cancel.stepId ? { stepId: cancel.stepId } : {}),
      forced: true,
      at: Date.now(),
    })
  }
  return "forced"
}

/**
 * Translate one Ink key event into prompt-controller mutations. Pure enough to
 * test without a TTY: `abort` is the only side effect outside the controller.
 */
export function applyInkKey(
  controller: PromptController,
  abort: () => void,
  input: string,
  key: InkKey,
): void {
  if ((key.ctrl === true && input.toLowerCase() === "c") || input === "\u0003") {
    abort()
    return
  }
  const active = controller.getActive()
  if (!active) return

  if (key.escape === true || input === "\u001b") {
    controller.cancelActive()
    return
  }
  if (key.return === true || input === "\r" || input === "\n") {
    controller.submit()
    return
  }
  if (key.backspace === true || key.delete === true) {
    controller.backspace()
    return
  }
  if (active.request.kind === "choose" && key.upArrow === true) {
    controller.moveSelection(-1)
    return
  }
  if (active.request.kind === "choose" && key.downArrow === true) {
    controller.moveSelection(1)
    return
  }
  if (key.ctrl === true || key.meta === true) return
  if (input) controller.append(input)
}

/**
 * Build the Ink presentation. The store is the single source of truth; UI
 * calls and prompt requests become events, and mounted components re-render
 * from `getSnapshot()`.
 */
export async function createInkPresentation(
  store: InstallerStore,
  options: InkPresentationOptions,
): Promise<InkPresentation> {
  const { ink, react, inkUi } = await loadRuntime()
  const stdin = options.stdin ?? process.stdin
  const stdout = options.stdout ?? process.stdout
  const stderr = options.stderr ?? process.stderr
  // NO_COLOR is honored independently of the caller's --no-color handling.
  const env = options.env ?? process.env
  const color = options.color && (env.NO_COLOR ?? "") === ""
  const cancel = options.cancel

  let instance: InkInstance | null = null
  let closed = false
  let aborted = false
  let exitCode: number | undefined

  const dispatchQuietly = (event: ProgressEvent) => {
    try {
      store.dispatch(event)
    } catch {
      // Never fail an operation because a render target went away.
    }
  }

  const controller = createPromptController({
    emit: (request: PromptRequest | null) => {
      dispatchQuietly({ type: "prompt", request, at: Date.now() })
    },
  })

  const report = createStoreReporter(store)

  // Mirror the first cancellation request into the view even when no plan
  // step is running (for example during detection or preflight).
  const stopCancelListener = cancel?.onRequest(() => {
    dispatchQuietly({
      type: "cancel",
      phase: "requested",
      ...(cancel.stepId ? { stepId: cancel.stepId } : {}),
      at: Date.now(),
    })
  })

  function mount(): void {
    if (closed || instance) return
    const App = createInkApp(ink, react, {
      store,
      controller,
      color,
      theme: options.theme ?? "dark",
      stdin,
      onKey: (input, key) => applyInkKey(controller, abort, input, key),
      ...(inkUi ? { inkUi } : {}),
    })
    instance = ink.render(react.createElement(App), {
      stdout,
      stdin,
      stderr,
      // Required shell settings (A03/A04): inline rendering only, Ctrl+C is
      // handled above, and application console calls must not fight the view.
      interactive: true,
      exitOnCtrlC: false,
      patchConsole: false,
      maxFps: 20,
    })
  }

  function abort(): void {
    if (closed) return
    // Ctrl+C cooperates with the operation instead of unmounting the UI. The
    // view stays mounted until main's final teardown calls close().
    const state = cancelFromKey(cancel, dispatchQuietly)
    if (state === "requested") {
      // Resolve the active prompt so the awaiting workflow can observe the
      // cancellation instead of deadlocking behind an unsettled input.
      controller.cancelActive()
      return
    }
    if (state === "forced") {
      controller.close()
      exitCode = 130
      void close()
      return
    }
    // Standalone callers without a token keep the legacy immediate abort;
    // main always injects the operation token.
    if (aborted) return
    aborted = true
    exitCode = 130
    dispatchQuietly({ type: "result", code: 130, at: Date.now() })
    controller.close()
    void close()
  }

  async function close(): Promise<void> {
    if (closed) return
    closed = true
    try { stopCancelListener?.() } catch { /* token already settled */ }
    controller.close()
    if (instance) {
      const current = instance
      instance = null
      // One frame flush (~60ms at maxFps 20) so React/Ink commits the final
      // Done frame before unmount instead of freezing on the pre-run snapshot.
      try { await new Promise((resolve) => setTimeout(resolve, 60)) } catch { /* timer unavailable */ }
      try { current.unmount() } catch { /* already unmounted */ }
    }
    try { stdin.pause?.() } catch { /* stream already gone */ }
  }

  async function suspend(): Promise<void> {
    if (closed) return
    if (instance) {
      const current = instance
      instance = null
      try { current.unmount() } catch { /* already unmounted */ }
    }
    // The official Spicetify installer inherits stdio and needs the terminal
    // back in cooked mode before it draws anything.
    try { stdin.setRawMode?.(false) } catch { /* not a TTY */ }
    try { stdin.pause?.() } catch { /* stream already paused */ }
  }

  async function resume(): Promise<void> {
    if (closed) return
    try { stdin.resume?.() } catch { /* stream already gone */ }
    mount()
  }

  const ui: Ui = {
    banner(version, windows) {
      report.log("info", `OpenCode Spotify installer v${version} (${windows ? "Windows" : "Non-Windows"})`)
    },
    title(text) {
      report.log("info", text)
    },
    section(text) {
      report.log("info", `-- ${text} --`)
    },
    line(text) {
      report.log("info", text)
    },
    kv(key, value) {
      report.log("info", `${key}: ${value}`)
    },
    status(kind, text) {
      report.log(STATUS_LEVELS[kind], text)
    },
    bullet(text) {
      report.log("info", `- ${text}`)
    },
    warn(text) {
      report.log("warn", text)
    },
    error(text) {
      report.log("error", text)
    },
    success(text) {
      report.log("success", text)
    },
    json(value) {
      report.log("info", JSON.stringify(value, null, 2) ?? String(value))
    },
    dryRun(step) {
      report.log("info", `[dry-run] ${step}`)
    },
    suspend,
    resume,
    close,
  }

  const presentation: InkPresentation = {
    mode: "ink",
    ui,
    prompt: controller.prompter,
    report,
    close,
    exitCode: () => exitCode,
  }

  mount()
  return presentation
}
