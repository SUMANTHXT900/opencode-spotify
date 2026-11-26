/**
 * D22 - Ink interaction tests.
 *
 * Scope: the interactive installer shell as a user sees it, driven through
 * `ink-testing-library` 4.0.0 with deterministic fixtures:
 *   - pinned-installer confirmation (safe default = no, explicit yes)
 *   - progress event rendering, explicit percentages, spinner frames
 *   - @inkjs/ui ProgressBar on wide color output, ASCII fallback otherwise
 *   - failed-step / error-log display, including ANSI injection attempts
 *   - destructive UNINSTALL consent: never the default, exact phrase only
 *   - narrow 40-column ASCII layout
 *   - plain-mode fallback selection and event rendering
 *
 * These frames are Ink view trees rendered in-process. They are NOT a claim
 * about live Windows terminal/ConPTY compatibility: font shaping, cursor
 * behaviour and real colour output remain outside this suite.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import * as inkRuntime from "ink"
import { createElement, useEffect, useState } from "react"
import type { ReactElement } from "react"
import { Box, Text, useInput } from "ink"
import { render } from "ink-testing-library"
import { ProgressBar, ThemeProvider, defaultTheme, extendTheme } from "@inkjs/ui"
import type {
  Detection,
  InstallerSnapshot,
  InstallerStore,
  Logger,
  ProgressEvent,
  PromptRequest,
  Ui,
} from "../src/cli/types.ts"
import { applyInkKey, createInkApp } from "../src/cli/ui/ink.ts"
import { createPromptController, type PromptController } from "../src/cli/ui/ink-prompt.ts"
import { toInkView, type InkRow } from "../src/cli/ui/ink-view.ts"
import { displayWidth } from "../src/cli/ui/normalize.ts"
import { layoutFor } from "../src/cli/ui/layout.ts"
import { runInstallWizard } from "../src/cli/ui/install-wizard.ts"
import {
  UNINSTALL_CONFIRMATION_PHRASE,
  buildUninstallScope,
  confirmCompleteRemoval,
  inventoryFromDetection,
  renderUninstallScope,
  selectUninstallMode,
  uninstallMenuChoices,
  type UninstallInventory,
} from "../src/cli/ui/uninstall-view.ts"
import { createPlainPresentation, selectUiMode } from "../src/cli/ui-mode.ts"

/* ------------------------------------------------------------------ */
/* Fixtures                                                           */
/* ------------------------------------------------------------------ */

function baseSnapshot(overrides: Partial<InstallerSnapshot> = {}): InstallerSnapshot {
  return {
    schemaVersion: 1,
    command: "setup",
    mode: "ink",
    version: "0.6.0-beta.3",
    windows: true,
    phase: "execute",
    phaseLabel: "Installing",
    startedAt: 0,
    versions: {
      plugin: { installed: "0.6.0-beta.2", latest: "0.6.0" },
      spicetify: { installed: "2.47.0", latest: null },
    },
    activity: [],
    prompt: null,
    ...overrides,
  }
}

const detection: Detection = {
  windows: true,
  windowsVersion: "Windows 11",
  arch: "x64",
  node: "24.12.0",
  pwsh: null,
  opencode: {
    available: true,
    path: null,
    version: "2.4.1",
    configPath: null,
    configExists: true,
    plugin: { registered: true, version: "0.6.0", source: "npm", local: false, spec: null },
    nativeCommands: true,
  },
  spotify: { installed: true, store: false, path: null, prefs: null, detail: "" },
  spicetify: {
    available: true,
    path: null,
    version: "2.47.0",
    owner: "script",
    configPath: "C:\\Users\\Test\\AppData\\Roaming\\spicetify\\config-xpui.ini",
    extensionsDir: "C:\\Users\\Test\\AppData\\Roaming\\spicetify\\Extensions",
    bridgeRegistered: true,
  },
  bridge: {
    configExists: true,
    credentialValid: true,
    installed: true,
    origins: 1,
    extensionPath: "C:\\Users\\Test\\AppData\\Roaming\\spicetify\\Extensions\\opencode-spotify-bridge.js",
    extensionExists: true,
    registration: "current",
    protocol: 2,
  },
  port: { busy: false, likelyOwnedByThisPlugin: null },
  compatibility: { opencode: "ok", spicetify: "ok", bridge: "compatible", plugin: "ok" },
}

/** Mirror of the store reducer, used to render real ProgressEvents. */
function applyEvent(snapshot: InstallerSnapshot, event: ProgressEvent): InstallerSnapshot {
  switch (event.type) {
    case "phase":
      return { ...snapshot, phase: event.phase, phaseLabel: event.label }
    case "detection":
      return { ...snapshot, detection: event.detection }
    case "plan":
      return {
        ...snapshot,
        plan: { title: event.title, steps: event.steps.map((step) => ({ ...step, status: "pending" as const })) },
      }
    case "step":
      if (!snapshot.plan) return snapshot
      return {
        ...snapshot,
        plan: {
          ...snapshot.plan,
          steps: snapshot.plan.steps.map((step) => step.id === event.id
            ? {
                ...step,
                status: event.status,
                ...(event.description ? { description: event.description } : {}),
                ...(event.detail ? { detail: event.detail } : {}),
              }
            : step),
        },
      }
    case "log":
      return {
        ...snapshot,
        activity: [...snapshot.activity, { at: event.at, level: event.level, message: event.message }],
      }
    case "progress":
      return { ...snapshot, progress: { scope: event.scope, message: event.message, percent: event.percent } }
    case "prompt":
      return { ...snapshot, prompt: event.request }
    case "result":
      return { ...snapshot, exitCode: event.code, endedAt: event.at }
    default:
      return snapshot
  }
}

function fakeStore(initial: InstallerSnapshot): InstallerStore & { events: ProgressEvent[] } {
  let current = initial
  const listeners = new Set<() => void>()
  const events: ProgressEvent[] = []
  return {
    events,
    getSnapshot: () => current,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    dispatch(event: ProgressEvent) {
      events.push(event)
      current = applyEvent(current, event)
      for (const listener of [...listeners]) listener()
    },
  }
}

function recordingUi(): { ui: Ui; lines: string[] } {
  const lines: string[] = []
  const add = (text: string) => { lines.push(text) }
  const ui: Ui = {
    banner: (version, windows) => add(`banner ${version} ${windows ? "windows" : "non-windows"}`),
    title: (text) => add(text),
    section: (text) => add(`== ${text} ==`),
    line: (text) => add(text),
    kv: (key, value) => add(`${key}: ${value}`),
    status: (kind, text) => add(`[${kind}] ${text}`),
    bullet: (text) => add(`- ${text}`),
    warn: (text) => add(`warn: ${text}`),
    error: (text) => add(`error: ${text}`),
    success: (text) => add(`success: ${text}`),
    json: (value) => add(JSON.stringify(value)),
    dryRun: (step) => add(`dry-run: ${step}`),
  }
  return { ui, lines }
}

const logger = (): Logger & { lines: string[] } => {
  const lines: string[] = []
  return { lines, out: (line: string) => lines.push(line), err: (line: string) => lines.push(line) }
}

/* ------------------------------------------------------------------ */
/* Ink helpers                                                        */
/* ------------------------------------------------------------------ */

const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]/g

/** Strip styling so assertions compare content, never terminal state. */
function plainFrame(frame: string | undefined): string {
  return (frame ?? "").replace(ANSI, "")
}

function currentFrame(instance: { lastFrame(): string | undefined }): string {
  return plainFrame(instance.lastFrame())
}

const settle = (ms = 40) => new Promise<void>((resolve) => { setTimeout(resolve, ms) })

function InkRows({ rows }: { rows: readonly InkRow[] }): ReactElement {
  return createElement(
    Box,
    { flexDirection: "column" },
    ...rows.map((row, index) => createElement(
      Text,
      { key: `row-${index}`, wrap: "truncate" },
      row.text.length > 0 ? row.text : " ",
    )),
  )
}

function stringRows(lines: readonly string[]): InkRow[] {
  return lines.map((text) => ({ kind: "detail", tone: "default", text }))
}

function renderRows(rows: readonly InkRow[]): ReturnType<typeof render> {
  return render(createElement(InkRows, { rows }))
}

/** Ink trims trailing spaces and renders an empty row as an empty line. */
function assertFrameRows(frame: string, rows: readonly InkRow[]): void {
  const lines = frame.split("\n")
  assert.equal(lines.length, rows.length, "Ink must not add, wrap or drop rows")
  rows.forEach((row, index) => {
    assert.equal(lines[index]!.trimEnd(), row.text.trimEnd(), `rendered row ${index} differs`)
  })
}

function assertWidth(rows: readonly InkRow[], width: number): void {
  for (const row of rows) {
    assert.ok(displayWidth(row.text) <= width, `row exceeds ${width} cells: ${JSON.stringify(row.text)}`)
  }
}

/** Prompt screen key driver: real prompt controller + real applyInkKey. */
function PromptScene(props: {
  controller: PromptController
  base: InstallerSnapshot
  width: number
  onAbort?: () => void
}): ReactElement {
  const [, setTick] = useState(0)
  useInput((input, key) => {
    applyInkKey(props.controller, () => { props.onAbort?.() }, input, key)
    setTick((value) => value + 1)
  })
  const active = props.controller.getActive()
  const prompt = active
    ? {
        id: active.request.id,
        input: active.input,
        selectedIndex: active.selectedIndex,
        ...(active.error ? { error: active.error } : {}),
      }
    : undefined
  const view = toInkView(
    { ...props.base, prompt: active ? active.request : null },
    props.width,
    prompt ? { prompt } : {},
  )
  return createElement(InkRows, { rows: view.rows })
}

function promptBase(): InstallerSnapshot {
  return baseSnapshot({
    command: "setup",
    phase: "consent",
    phaseLabel: "Waiting for consent",
    activity: [],
    prompt: null,
  })
}

/* Install confirmation                                               */
/* ------------------------------------------------------------------ */

test("install confirmation defaults to no and renders the pinned prompt", async () => {
  const controller = createPromptController({ emit: () => {} })
  const { ui, lines } = recordingUi()
  let runs = 0
  const wizard = runInstallWizard({
    ui,
    prompt: controller.prompter,
    latestVersion: () => "2.47.0",
    installedVersion: null,
    method: "official",
    installOfficial: async () => { runs += 1; return { code: 0, version: "2.47.0" } },
  })

  await settle()
  assert.equal(controller.getActive()?.request.kind, "confirm")

  const instance = render(createElement(PromptScene, {
    controller,
    base: promptBase(),
    width: 72,
  }))
  try {
    const frame = currentFrame(instance)
    assert.match(frame, /Run the pinned official installer to install Spicetify/)
    assert.match(frame, /\[y\/N\]/, "the safe default is no")
    assert.match(frame, /Enter submit \| Esc cancel \| Ctrl\+C abort/)

    instance.stdin.write("\r")
    await settle()
  } finally {
    instance.unmount()
  }

  const result = await wizard
  assert.equal(result.status, "declined")
  assert.equal(runs, 0, "Enter on the default must not run the installer")
  assert.match(lines.join("\n"), /Approval was not given/)
  assert.match(lines.join("\n"), /What it does NOT do/)
})

test("typing y and Enter approves exactly once and reports installed", async () => {
  const controller = createPromptController({ emit: () => {} })
  const { ui, lines } = recordingUi()
  let runs = 0
  const wizard = runInstallWizard({
    ui,
    prompt: controller.prompter,
    // A verified target is required before the official installer is offered.
    latestVersion: () => "2.47.0",
    installedVersion: null,
    method: "official",
    installOfficial: async () => { runs += 1; return { code: 0, version: "2.47.0" } },
  })

  await settle()
  const instance = render(createElement(PromptScene, {
    controller,
    base: promptBase(),
    width: 72,
  }))
  try {
    assert.match(currentFrame(instance), /\[y\/N\]/)
    instance.stdin.write("y")
    await settle()
    assert.match(currentFrame(instance), /> y_/, "typed approval is visible before submit")
    instance.stdin.write("\r")
    await settle()
  } finally {
    instance.unmount()
  }

  const result = await wizard
  assert.equal(result.status, "installed")
  assert.equal(result.version, "2.47.0")
  assert.equal(runs, 1, "the mutating adapter runs exactly once")
  const text = lines.join("\n")
  assert.match(text, /Installation result/)
  assert.match(text, /completed with the pinned official installer/)
})

/* ------------------------------------------------------------------ */
/* Progress and errors                                                */
/* ------------------------------------------------------------------ */

test("progress events render steps, explicit percentages and sanitized logs", () => {
  const store = fakeStore(baseSnapshot())
  let notifications = 0
  store.subscribe(() => { notifications += 1 })

  store.dispatch({ type: "phase", phase: "execute", label: "Installing", at: 1 })
  store.dispatch({
    type: "plan",
    title: "Setup",
    steps: [
      { id: "check", description: "Check Node.js", mutates: false, status: "pending" },
      { id: "install", description: "Install plugin", mutates: true, status: "pending" },
      { id: "register", description: "Register bridge", mutates: true, status: "pending" },
    ],
    at: 2,
  })
  store.dispatch({ type: "step", id: "check", status: "ok", at: 3 })
  store.dispatch({ type: "step", id: "install", status: "running", at: 4 })
  store.dispatch({ type: "progress", scope: "npm", message: "Fetching package", percent: 40, at: 5 })
  store.dispatch({ type: "log", level: "success", message: "Node.js found", at: 6 })
  store.dispatch({ type: "log", level: "warn", message: "Spicetify update available", at: 7 })

  const view = toInkView(store.getSnapshot(), 72, { frame: 1 })
  assertWidth(view.rows, 72)
  const instance = renderRows(view.rows)
  try {
    const frame = currentFrame(instance)
    assertFrameRows(frame, view.rows)
    assert.equal(notifications, 7, "every event reaches the store subscribers")
    assert.match(frame, /Plan - Setup \(1\/3\)/)
    assert.match(frame, /\[x\] Check Node\.js/)
    assert.match(frame, /\/ Install plugin/, "frame 1 is the second ASCII spinner frame")
    assert.match(frame, /\[ \] Register bridge/)
    assert.match(frame, /\/\] \[##########--------------\] 40% Fetching package/)
    assert.match(frame, /\[OK\] Node\.js found/)
    assert.match(frame, /\[!!\] Spicetify update available/)
    assert.doesNotMatch(frame, /\u001b\[/)
  } finally {
    instance.unmount()
  }

  // No percentage means no bar and no synthesized progress.
  const indeterminate = baseSnapshot({ progress: { scope: "github", message: "Waiting for release" } })
  const waiting = toInkView(indeterminate, 72, { frame: 0 }).rows.map((row) => row.text).join("\n")
  assert.match(waiting, /\[\|\] github: Waiting for release/)
  assert.doesNotMatch(waiting, /%/)

  // Same snapshot + frame renders byte-identically; a new frame advances only the spinner.
  assert.deepEqual(toInkView(store.getSnapshot(), 72, { frame: 1 }).rows, view.rows)
  const nextFrame = toInkView(store.getSnapshot(), 72, { frame: 2 }).rows.map((row) => row.text).join("\n")
  assert.match(nextFrame, /- Install plugin/)
  assert.doesNotMatch(nextFrame, /\/ Install plugin/)
})

/* ------------------------------------------------------------------ */
/* @inkjs/ui ProgressBar (wide + color only)                          */
/* ------------------------------------------------------------------ */

function renderInkApp(snapshot: InstallerSnapshot, options: { color: boolean }) {
  const store = fakeStore(snapshot)
  const controller = createPromptController({ emit: () => {} })
  const stdin = {
    isTTY: false,
    setRawMode() {},
    pause() {},
    resume() {},
  }
  const App = createInkApp(
    inkRuntime as unknown as Parameters<typeof createInkApp>[0],
    { createElement, useState, useEffect },
    {
      store,
      controller,
      color: options.color,
      theme: "dark",
      stdin: stdin as unknown as Parameters<typeof createInkApp>[2]["stdin"],
      onKey: () => {},
      inkUi: { ThemeProvider, ProgressBar, defaultTheme, extendTheme } as unknown as Parameters<typeof createInkApp>[2]["inkUi"],
    },
  )
  return render(createElement(App as unknown as () => ReactElement))
}

test("wide color output mounts the @inkjs/ui ProgressBar with ASCII characters", async () => {
  const snapshot = baseSnapshot({
    progress: { scope: "install", message: "Fetching package", percent: 40 },
  })
  const instance = renderInkApp(snapshot, { color: true })
  try {
    await settle(80)
    const frame = currentFrame(instance)
    assert.match(frame, /##########-------------- 40% Fetching package/, "the ProgressBar itself draws # and -")
    assert.match(frame, /OpenCode Spotify/)
  } finally {
    instance.unmount()
  }
})

test("color:false and narrow layouts keep the plain ASCII progress row without ANSI", async () => {
  const snapshot = baseSnapshot({
    progress: { scope: "install", message: "Fetching package", percent: 40 },
  })
  const noColor = renderInkApp(snapshot, { color: false })
  try {
    await settle(80)
    const frame = currentFrame(noColor)
    assert.match(frame, /\[##########--------------\] 40% Fetching package/)
    assert.ok(!(noColor.lastFrame() ?? "").includes("\u001b["), "color:false must not paint ANSI")
  } finally {
    noColor.unmount()
  }

  const narrowRows = toInkView(snapshot, 40, { frame: 0 }).rows
  assertWidth(narrowRows, 40)
  const progressRow = narrowRows.find((row) => row.kind === "progress")
  assert.ok(progressRow)
  assert.match(progressRow!.text, /40% Fetching package/)
  assert.ok(!progressRow!.text.includes("\u001b"))
})

test("failed steps and error logs render without leaking control sequences", () => {
  const snapshot = baseSnapshot({
    plan: {
      title: "Repair",
      steps: [
        {
          id: "bridge",
          description: "Restart bridge",
          mutates: true,
          status: "failed",
          detail: "exit 1: \u001b[31maccess denied\u001b[0m",
        },
        { id: "verify", description: "Verify bridge", mutates: false, status: "skipped" },
      ],
    },
    activity: [
      { at: 1, level: "error", message: "401 from \u001b[31m127.0.0.1\u001b[0m" },
    ],
    progress: { scope: "bridge", message: "Retrying", percent: 100 },
  })

  const view = toInkView(snapshot, 60, { frame: 0 })
  assertWidth(view.rows, 60)
  const instance = renderRows(view.rows)
  try {
    const frame = currentFrame(instance)
    assertFrameRows(frame, view.rows)
    assert.match(frame, /\[!\] Restart bridge/)
    assert.match(frame, /exit 1: access denied/)
    assert.match(frame, /\[-\] Verify bridge/)
    assert.match(frame, /\[XX\] 401 from 127\.0\.0\.1/)
    assert.match(frame, /100% Retrying/)
    assert.doesNotMatch(frame, /\u001b\[/, "sanitized detail must not carry ANSI")
    assert.doesNotMatch(frame, /\u001b/, "no escape bytes at all")
  } finally {
    instance.unmount()
  }

  // Wider than the terminal is clipped by the view model, not by Ink wrapping.
  const long = baseSnapshot({
    plan: {
      title: "Setup",
      steps: [{ id: "long", description: "x".repeat(200), mutates: true, status: "pending" }],
    },
  })
  const clipped = toInkView(long, 40).rows
  assertWidth(clipped, 40)
  assert.ok(clipped.some((row) => row.text.endsWith("...")))
})

/* ------------------------------------------------------------------ */
/* Destructive uninstall                                              */
/* ------------------------------------------------------------------ */

test("uninstall menu never defaults to complete removal", async () => {
  const choice = uninstallMenuChoices().find((entry) => entry.value === "complete")
  assert.ok(choice, "the complete-removal option exists")
  assert.match(choice!.hint ?? "", /Requires typing UNINSTALL/)

  const controller = createPromptController({ emit: () => {} })
  const selection = selectUninstallMode(controller.prompter)
  await settle()
  assert.equal(controller.getActive()?.request.kind, "choose")

  const instance = render(createElement(PromptScene, {
    controller,
    base: baseSnapshot({ command: "uninstall", phase: "consent", phaseLabel: "Choosing uninstall scope" }),
    width: 72,
  }))
  try {
    const frame = currentFrame(instance)
    assert.match(frame, /What should be removed\?/)
    assert.match(frame, /^> 1\. Remove OpenCode Spotify only$/m)
    assert.match(frame, /^  2\. Complete permanent removal$/m)
    assert.match(frame, /^  3\. Back$/m)
    assert.doesNotMatch(frame, /^> 2\./m, "the destructive scope is never preselected")

    instance.stdin.write("\u001B[B")
    await settle()
    assert.match(currentFrame(instance), /^> 2\. Complete permanent removal/m)

    instance.stdin.write("\r")
    await settle()
  } finally {
    instance.unmount()
  }

  assert.equal(await selection, "complete")
})

function uninstallInventory(): UninstallInventory {
  return inventoryFromDetection(detection, {
    credentialsDirectory: "C:\\Users\\Test\\AppData\\Roaming\\opencode-spotify",
    backupsDirectory: "C:\\Users\\Test\\AppData\\Local\\opencode-spotify\\backups",
    backupsPresent: true,
  })
}

test("complete removal lists the exact scope and requires typed UNINSTALL", async () => {
  const scope = buildUninstallScope("complete", uninstallInventory())
  assert.equal(scope.destructive, true)
  assert.equal(scope.mode, "complete")

  const { ui, lines } = recordingUi()
  renderUninstallScope(ui, scope)
  const scopeText = lines.join("\n")
  assert.match(scopeText, /Deletes exactly:/)
  assert.match(scopeText, /Bridge credentials and pinned Origin/)
  assert.match(scopeText, /Preserves:/)
  assert.match(scopeText, /Irreversible for every item listed under “Deletes exactly”/)

  const controller = createPromptController({ emit: () => {} })
  const consent = confirmCompleteRemoval(controller.prompter, ui, scope)
  await settle()
  assert.equal(controller.getActive()?.request.kind, "ask")

  const instance = render(createElement(PromptScene, {
    controller,
    base: baseSnapshot({ command: "uninstall", phase: "consent", phaseLabel: "Confirming removal" }),
    width: 72,
  }))
  try {
    const request = controller.getActive()?.request
    assert.equal(request?.kind, "ask")
    const question = request?.kind === "ask" ? request.question : ""
    assert.match(question, /Type UNINSTALL to confirm/)
    assert.match(question, /BACK to choose another option/)
    assert.match(question, /CANCEL to stop without changes/)

    const first = currentFrame(instance)
    assert.match(first, /Complete permanent removal deletes the signing secret/)
    assert.doesNotMatch(first, /\[[Yy]\/[Nn]\]/, "no generic yes/no shortcut for complete removal")

    // Wrong case is rejected and reprompts.
    instance.stdin.write("uninstall")
    await settle()
    instance.stdin.write("\r")
    await settle()
    assert.match(lines.join("\n"), /Type UNINSTALL exactly \(uppercase\)/)
    assert.equal(controller.getActive()?.request.kind, "ask", "a rejected phrase reprompts")

    instance.stdin.write(UNINSTALL_CONFIRMATION_PHRASE)
    await settle()
    assert.match(currentFrame(instance), /> UNINSTALL_/)
    instance.stdin.write("\r")
    await settle()
  } finally {
    instance.unmount()
  }

  assert.equal(await consent, "confirmed")
})

test("empty input, BACK and Escape exit complete removal without approving", async () => {
  for (const flow of [
    { input: "\r", expected: "cancelled" },
    { input: "BACK\r", expected: "back" },
    { input: "\u001B", expected: "cancelled" },
  ] as const) {
    const controller = createPromptController({ emit: () => {} })
    const { ui, lines } = recordingUi()
    const consent = confirmCompleteRemoval(controller.prompter, ui)
    await settle()

    const instance = render(createElement(PromptScene, {
      controller,
      base: baseSnapshot({ command: "uninstall", phase: "consent", phaseLabel: "Confirming removal" }),
      width: 72,
    }))
    try {
      if (flow.input.endsWith("\r")) {
        instance.stdin.write(flow.input.slice(0, -1))
        await settle()
        instance.stdin.write("\r")
      } else {
        instance.stdin.write(flow.input)
      }
      await settle()
    } finally {
      instance.unmount()
    }

    assert.equal(await consent, flow.expected)
    if (flow.expected === "cancelled") {
      assert.match(lines.join("\n"), /Cancelled\. Nothing was removed\./)
    }
  }
})

/* ------------------------------------------------------------------ */
/* Narrow layout and plain fallback                                   */
/* ------------------------------------------------------------------ */

test("40 columns renders the ASCII fallback and stays inside the bound", () => {
  const snapshot = baseSnapshot({
    detection,
    plan: {
      title: "Setup",
      steps: [
        { id: "node", description: "Check Node.js", mutates: false, status: "ok" },
        { id: "install", description: "Install plugin", mutates: true, status: "running" },
        {
          id: "long",
          description: "Verify the pinned Spicetify release digest before applying".repeat(3),
          mutates: false,
          status: "pending",
        },
      ],
    },
    progress: { scope: "install", message: "Installing plugin", percent: 40 },
  })

  assert.equal(layoutFor(40).breakpoint, "narrow")
  const narrowRows = toInkView(snapshot, 40, { frame: 0 }).rows
  assertWidth(narrowRows, 40)
  const narrowInstance = renderRows(narrowRows)
  try {
    const frame = currentFrame(narrowInstance)
    assertFrameRows(frame, narrowRows)
    assert.match(frame, /^\| System$/m)
    assert.match(frame, /^\| Plan - Setup \(1\/3\)$/m)
    assert.match(frame, /\[x\] Check Node\.js/)
    assert.doesNotMatch(frame, /[^\x20-\x7E\n]/, "narrow layout is ASCII-only")
    for (const line of frame.split("\n")) {
      assert.ok(displayWidth(line) <= 40, `narrow line exceeds 40: ${JSON.stringify(line)}`)
    }
  } finally {
    narrowInstance.unmount()
  }

  const wideRows = toInkView(snapshot, 100, { frame: 0 }).rows
  assertWidth(wideRows, 100)
  const wideInstance = renderRows(wideRows)
  try {
    const frame = currentFrame(wideInstance)
    assert.match(frame, /^\u2502 Plan - Setup \(1\/3\)$/m)
    assert.match(frame, /\u2026/, "wide layout uses the single ellipsis glyph")
    assert.doesNotMatch(frame, /[\u2500\u250C\u2510\u2514\u2518]/, "no box-drawing frame")
  } finally {
    wideInstance.unmount()
  }
})

test("plain fallback is selected off-TTY and renders the same events without ANSI", async () => {
  const tty = { stdoutTTY: true, stdinTTY: true, env: { TERM: "xterm-256color" } as NodeJS.ProcessEnv }
  assert.equal(selectUiMode({}, tty), "ink")
  assert.equal(selectUiMode({}, { ...tty, stdoutTTY: false }), "plain")
  assert.equal(selectUiMode({}, { ...tty, stdinTTY: false }), "plain")
  assert.equal(selectUiMode({ plain: true }, tty), "plain")
  assert.equal(selectUiMode({ json: true }, tty), "json")
  assert.equal(selectUiMode({}, { ...tty, env: { CI: "1" } as NodeJS.ProcessEnv }), "plain")
  assert.equal(selectUiMode({}, { ...tty, env: { TERM: "dumb" } as NodeJS.ProcessEnv }), "plain")
  assert.equal(selectUiMode({}, { ...tty, env: { OPENCODE_SPOTIFY_UI: "plain" } as NodeJS.ProcessEnv }), "plain")

  const sink = logger()
  const presentation = createPlainPresentation(sink, {
    color: false,
    json: false,
    io: { ...tty, stdoutTTY: false },
  })
  try {
    assert.equal(presentation.mode, "plain")
    presentation.report.phase("execute", "Installing")
    presentation.report.step("check", "ok", "Node.js found")
    presentation.report.step("install", "failed", "exit 1")
    presentation.report.progress("npm", "Fetching package", 40)
    presentation.report.progress("github", "Waiting for release")
    presentation.report.log("warn", "Spicetify update available")
    presentation.report.prompt({
      id: "confirm",
      kind: "confirm",
      question: "Run the pinned official installer?",
      defaultYes: false,
    })
    presentation.report.emit({ type: "result", code: 1, at: 9 })
  } finally {
    await presentation.close()
  }

  const text = sink.lines.join("\n")
  assert.match(text, /^Installing$/m)
  assert.match(text, /\[OK\] check - Node\.js found/)
  assert.match(text, /\[XX\] install - exit 1/)
  assert.match(text, /npm: Fetching package \(40%\)/)
  assert.match(text, /github: Waiting for release/)
  assert.match(text, /\[!!\] Spicetify update available/)
  assert.match(text, /Run the pinned official installer\? \[y\/N\]/)
  assert.ok(!text.includes("\u001b"), "plain fallback must not paint ANSI")
})
