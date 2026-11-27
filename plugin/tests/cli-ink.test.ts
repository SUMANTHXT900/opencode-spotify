import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type {
  Detection,
  InstallerSnapshot,
  InstallerStore,
  ProgressEvent,
  PromptRequest,
} from "../src/cli/types.ts"
import {
  MAX_ACTIVITY_ROWS,
  SPINNER_FRAMES,
  fitText,
  limitRows,
  limitViewRows,
  sanitize,
  spinnerFrame,
  statusMarker,
  toInkView,
} from "../src/cli/ui/ink-view.ts"
import { createPromptController } from "../src/cli/ui/ink-prompt.ts"
import {
  applyInkKey,
  cancelFromKey,
  createInkPresentation,
} from "../src/cli/ui/ink.ts"
import { createCancelToken } from "../src/cli/cancel.ts"
import {
  PHASE_LABELS,
  cancelLabel,
  createInstallerSnapshot,
  reduceInstaller,
} from "../src/cli/state.ts"
import { glyphsFor } from "../src/cli/ui/glyphs.ts"
import { layoutFor } from "../src/cli/ui/layout.ts"
import { displayWidth, truncateDisplay, wrapDisplay } from "../src/cli/ui/normalize.ts"
import { themeFor } from "../src/cli/ui/tokens.ts"

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
    available: true, path: null, version: "2.47.0", owner: "script",
    configPath: null, extensionsDir: null, bridgeRegistered: true,
  },
  bridge: {
    configExists: true, credentialValid: true, installed: true, origins: 1,
    extensionPath: null, extensionExists: true, registration: "current", protocol: 2,
  },
  port: { busy: false, likelyOwnedByThisPlugin: null },
  compatibility: { opencode: "ok", spicetify: "ok", bridge: "compatible", plugin: "ok" },
}

/** Mock operation adapter: reduce the A04 progress events like the real store. */
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
      return { ...snapshot, activity: [...snapshot.activity, { at: event.at, level: event.level, message: event.message }] }
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

function render(snapshot: InstallerSnapshot, width = 64, options: Parameters<typeof toInkView>[2] = {}): string {
  return toInkView(snapshot, width, options).rows.map((row) => row.text).join("\n")
}

test("toInkView uses compact rules, ASCII fallback markers and bounded rows", () => {
  const snapshot = baseSnapshot({
    detection,
    plan: {
      title: "Setup",
      steps: [
        { id: "node", description: "Check Node.js", mutates: false, status: "ok" },
        { id: "plugin", description: "Install plugin", mutates: true, status: "running" },
        { id: "bridge", description: "Register bridge", mutates: true, status: "failed", detail: "exit 1" },
        { id: "cache", description: "Clear cache", mutates: true, status: "skipped" },
      ],
    },
    progress: { scope: "install", message: "Installing plugin", percent: 40 },
    activity: [
      { at: 1, level: "info", message: "Starting setup" },
      { at: 2, level: "success", message: "Node.js found" },
      { at: 3, level: "warn", message: "Spicetify update available" },
    ],
  })
  const view = toInkView(snapshot, 40)
  const text = view.rows.map((row) => row.text).join("\n")

  assert.equal(view.width, 40)
  assert.match(text, /^OpenCode Spotify +v0\.6\.0-beta\.3$/m, "header right-aligns the version")
  assert.match(text, /^\| System$/m, "sections use one compact ASCII rule")
  assert.match(text, /^\| Plan - Setup \(1\/4\)$/m)
  assert.doesNotMatch(text, /^-{10,}$/m, "no full-width rule rows")
  assert.match(text, /\[x\] Check Node\.js/)
  assert.match(text, /\| Install plugin/, "running step uses the ASCII spinner")
  assert.match(text, /\[!\] Register bridge/)
  assert.match(text, /\[-\] Clear cache/)
  assert.match(text, /40%/)
  assert.match(text, /\[OK\] Node\.js found/)
  assert.match(text, /\[x\] OpenCode 2\.4\.1 \+ Plugin 0\.6\.0/)
  assert.match(text, /Spotify desktop \+ Spicetify 2\.47\.0/)
  assert.match(text, /Bridge current \| port free/)

  for (const row of view.rows) {
    assert.ok(displayWidth(row.text) <= 40, `row exceeds width: ${row.text}`)
    assert.doesNotMatch(row.text, /[^\x20-\x7E]/, "narrow layout is ASCII-only")
    assert.doesNotMatch(row.text, /\u001b/, "no ANSI escapes")
  }
})

test("wide layouts keep the small approved glyph set", () => {
  const snapshot = baseSnapshot({
    plan: {
      title: "Setup",
      steps: [{ id: "node", description: "Check Node.js", mutates: false, status: "ok" }],
    },
  })
  const view = toInkView(snapshot, 100)
  const text = view.rows.map((row) => row.text).join("\n")
  assert.match(text, /^\u2502 Plan - Setup \(1\/1\)$/m)
  const allowed = new Set(["\u2502", "\u00B7", "\u2026"])
  for (const row of view.rows) {
    for (const char of row.text) {
      if (char >= "\x20" && char <= "\x7e") continue
      assert.ok(allowed.has(char), `unapproved glyph ${JSON.stringify(char)} in ${row.text}`)
    }
    assert.ok(displayWidth(row.text) <= 100)
  }
})

test("toInkView truncates long text and clamps tiny widths", () => {
  const snapshot = baseSnapshot({
    plan: {
      title: "Setup",
      steps: [{ id: "long", description: "x".repeat(200), mutates: true, status: "pending" }],
    },
  })
  const narrow = toInkView(snapshot, 30)
  assert.equal(narrow.width, 30)
  assert.ok(narrow.rows.some((row) => row.text.endsWith("...")))
  for (const row of narrow.rows) assert.ok(displayWidth(row.text) <= 30)

  for (const width of [0, 1, 5, 12]) {
    const tiny = toInkView(snapshot, width)
    assert.equal(tiny.width, layoutFor(width).width, "layout clamps to the shared minimum")
    for (const row of tiny.rows) {
      assert.ok(displayWidth(row.text) <= tiny.width, `width ${width}: ${row.text}`)
    }
  }
})

test("spinner and status markers are ASCII and deterministic", () => {
  assert.deepEqual([0, 1, 2, 3, 4, -1].map((frame) => spinnerFrame(frame)), ["|", "/", "-", "\\", "|", "\\"])
  assert.deepEqual([...SPINNER_FRAMES], ["|", "/", "-", "\\"])
  assert.equal(statusMarker("pending"), "[ ]")
  assert.equal(statusMarker("running", 2), "-")
  assert.equal(statusMarker("ok"), "[x]")
  assert.equal(statusMarker("failed"), "[!]")
  assert.equal(statusMarker("skipped"), "[-]")
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7].map((frame) => spinnerFrame(frame)), ["|", "/", "-", "\\", "|", "/", "-", "\\"])
})

test("lifted design system uses Spotify green and the compact breakpoint", () => {
  assert.equal(themeFor("dark").accent, "#1DB954")
  assert.equal(themeFor("dark").selected, "#1ED760")
  assert.equal(themeFor("light").accent, "#0B7A33")
  assert.notEqual(themeFor("dark").accent, themeFor("light").accent)
  assert.equal(themeFor("dark").ok, themeFor("dark").accent, "ok keeps the brand accent")

  const narrow = layoutFor(40)
  assert.equal(narrow.breakpoint, "narrow")
  assert.equal(narrow.ascii, true)
  assert.equal(narrow.content, 38)
  const wide = layoutFor(60)
  assert.equal(wide.breakpoint, "wide")
  assert.equal(wide.ascii, false)
  assert.equal(layoutFor(1).width, 24, "tiny widths clamp to the shared minimum")
  assert.equal(layoutFor(10_000).width, 120, "huge widths clamp to the shared maximum")

  assert.equal(glyphsFor(narrow).rule, "|")
  assert.equal(glyphsFor(wide).rule, "\u2502")
  assert.equal(glyphsFor(narrow).ellipsis, "...")
  assert.equal(glyphsFor(wide).ellipsis, "\u2026")
  assert.equal(truncateDisplay("abcdef", 4, "..."), "a...")
  assert.equal(displayWidth("\u2502 Plan"), 6)
})

test("sanitize strips ANSI, control characters and newlines", () => {
  assert.equal(sanitize("\u001b[31mred\u001b[0m\tline\nnext"), "red line next")
  assert.equal(sanitize("null\u0000byte"), "null byte")
  assert.equal(fitText("abcdef", 5), "ab...")
  assert.equal(fitText("abc", 5), "abc")
  assert.equal(fitText("abcdef", 2), "..")
})

test("limitRows keeps leading context and the newest rows", () => {
  const rows = Array.from({ length: 20 }, (_, index) => ({
    kind: "detail" as const,
    tone: "default" as const,
    text: String(index),
  }))
  const limited = limitRows(rows, 10)
  assert.equal(limited.length, 10)
  assert.deepEqual(limited.slice(0, 3).map((row) => row.text), ["0", "1", "2"])
  assert.equal(limited[3]!.text, "...")
  assert.equal(limited.at(-1)!.text, "19")
  assert.equal(limitRows(rows, 3).length, 3)
  assert.deepEqual(limitRows(rows, 3).map((row) => row.text), ["17", "18", "19"])
})

test("multi-line destructive consent wraps instead of truncating", () => {
  const question = [
    "Complete permanent removal deletes the signing secret and cannot be undone.",
    "Type UNINSTALL to confirm, BACK to choose another option, or CANCEL to stop without changes.",
  ].join("\n")
  const snapshot = baseSnapshot({
    prompt: { id: "consent", kind: "ask", question },
  })

  for (const width of [120, 100, 80, 40, 24]) {
    const view = toInkView(snapshot, width)
    const text = view.rows.map((row) => row.text).join("\n")
    const flat = text.replace(/\s+/g, " ")
    assert.match(flat, /Complete permanent removal deletes the signing secret and cannot be undone\./)
    assert.match(flat, /Type UNINSTALL to confirm, BACK to choose another option, or CANCEL to stop without changes\./)
    for (const row of view.rows) {
      assert.ok(displayWidth(row.text) <= view.width, `width ${width}: ${row.text}`)
    }
  }
})

test("confirm phrase instruction stays visible after a long warning", () => {
  const question = `Warning: ${"this is irreversible and deletes the signing secret. ".repeat(6)}`
  const snapshot = baseSnapshot({
    prompt: { id: "confirm", kind: "confirm", question, defaultYes: false, phrase: "UNINSTALL" },
  })
  const text = render(snapshot, 120)
  assert.match(text, /irreversible/)
  assert.match(text, /deletes the signing secret\./)
  assert.match(text, /Type "UNINSTALL" to continue:/)
  for (const row of toInkView(snapshot, 120).rows) {
    assert.ok(displayWidth(row.text) <= 120, row.text)
  }
})

test("wrapDisplay preserves paragraphs and hard-wraps long tokens", () => {
  assert.deepEqual(wrapDisplay("one two three", 7), ["one two", "three"])
  assert.deepEqual(wrapDisplay("a\nb", 10), ["a", "b"])
  assert.deepEqual(wrapDisplay("abcdefgh", 4), ["abcd", "efgh"])
  assert.deepEqual(wrapDisplay("", 5), [""])
})

test("prompt rows show choices, transient input, errors and phrase hints", () => {
  const choose = baseSnapshot({
    prompt: {
      id: "p1",
      kind: "choose",
      question: "Mode?",
      choices: [
        { label: "Auto", value: "auto" },
        { label: "Manual", value: "manual", hint: "review each step" },
      ],
      defaultIndex: 1,
    },
  })
  const text = render(choose, 60, {
    prompt: { id: "p1", input: "2", selectedIndex: 0, error: "Enter a number from 1 to 2." },
  })
  assert.match(text, /\? Mode\?/)
  assert.match(text, /> 1\. Auto/)
  assert.match(text, / 2\. Manual - review each step/)
  assert.match(text, /> 2_/)
  assert.match(text, /! Enter a number from 1 to 2\./)
  assert.match(text, /Esc cancel \| Ctrl\+C abort/)

  const stale = render(choose, 60, { prompt: { id: "other", input: "typed", selectedIndex: 0 } })
  assert.doesNotMatch(stale, /typed/)
  assert.match(stale, /> 2\. Manual/)

  const phrase = baseSnapshot({
    prompt: { id: "p2", kind: "confirm", question: "Uninstall?", defaultYes: true, phrase: "uninstall" },
  })
  assert.match(render(phrase, 60), /Type "uninstall" to continue:/)
  assert.doesNotMatch(render(phrase, 60), /\[Y\/n\]/)
})

test("choose footer follows the highlighted selection, not the default index", () => {
  const choose = baseSnapshot({
    prompt: {
      id: "p1",
      kind: "choose",
      question: "Mode?",
      choices: [
        { label: "Auto", value: "auto" },
        { label: "Manual", value: "manual" },
      ],
      defaultIndex: 0,
    },
  })
  // Highlight moved to the second choice with no typed input: the footer must
  // offer the highlighted row, not the default.
  const text = render(choose, 60, { prompt: { id: "p1", input: "", selectedIndex: 1 } })
  assert.match(text, / 1\. Auto/)
  assert.match(text, /> 2\. Manual/)
  assert.match(text, /Enter for 2/)
})

test("System block is a compact 4-line summary", () => {
  const view = toInkView(baseSnapshot({ detection }), 72)
  const system = view.rows.filter((row) => row.kind === "detail").slice(0, 4).map((row) => row.text).join("\n")
  assert.match(system, /Windows 11 x64 \| Node 24\.12\.0/)
  assert.match(system, /OpenCode 2\.4\.1 \+ Plugin 0\.6\.0/)
  assert.match(system, /Spotify desktop \+ Spicetify 2\.47\.0/)
  assert.match(system, /Bridge current \| port free/)
})

test("System block marks an owned busy port active and a foreign one a conflict", () => {
  const owned = toInkView(baseSnapshot({
    detection: { ...detection, port: { busy: true, likelyOwnedByThisPlugin: true } },
  }), 72)
  const ownedText = owned.rows.map((row) => row.text).join("\n")
  assert.match(ownedText, /\[x\] Bridge current \(active\)/)
  assert.doesNotMatch(ownedText, /port conflict/)

  const conflict = toInkView(baseSnapshot({
    detection: { ...detection, port: { busy: true, likelyOwnedByThisPlugin: false } },
  }), 72)
  const conflictText = conflict.rows.map((row) => row.text).join("\n")
  assert.match(conflictText, /\[ \] Bridge current \| port conflict/)

  const unknown = toInkView(baseSnapshot({
    detection: { ...detection, port: { busy: true, likelyOwnedByThisPlugin: null } },
  }), 72)
  assert.match(unknown.rows.map((row) => row.text).join("\n"), /\[ \] Bridge current \| port conflict/)
})

test("progress rows carry explicit percentages with an ASCII fallback bar", () => {
  const view = toInkView(
    baseSnapshot({ progress: { scope: "install", message: "Fetching package", percent: 40 } }),
    72,
    { frame: 1 },
  )
  const row = view.rows.find((r) => r.kind === "progress")
  assert.ok(row?.progress, "explicit percentages carry ProgressBar metadata")
  assert.equal(row!.progress!.percent, 40)
  assert.equal(row!.progress!.label, "40%")
  assert.ok(row!.progress!.barWidth >= 4 && row!.progress!.barWidth <= 24)
  assert.match(row!.text, /40% Fetching package/)
  assert.match(row!.text, /\[#+-*\] 40%/)
})

test("key dispatch aborts on Ctrl+C and drives prompt input", async () => {
  const controller = createPromptController({ emit: () => {} })
  let aborted = 0
  const abort = () => { aborted += 1; controller.close() }

  const asked = controller.prompter.ask("Name? ")
  for (const chunk of ["A", "d", "a", " ", "d", "a"]) applyInkKey(controller, abort, chunk, {})
  applyInkKey(controller, abort, "", { return: true })
  assert.equal(await asked, "Ada da")
  assert.equal(aborted, 0)
  assert.equal(controller.getActive(), null)

  const escaped = controller.prompter.ask("Cancel? ")
  applyInkKey(controller, abort, "\u001b", { escape: true })
  assert.equal(await escaped, undefined)
  assert.equal(aborted, 0)

  const chosen = controller.prompter.choose(
    "Pick",
    [{ label: "A", value: "a" }, { label: "B", value: "b" }],
    0,
  )
  applyInkKey(controller, abort, "", { downArrow: true })
  applyInkKey(controller, abort, "", { return: true })
  assert.equal(await chosen, "b")

  const typing = controller.prompter.ask("Ignore control chords? ")
  applyInkKey(controller, abort, "a", { ctrl: true })
  applyInkKey(controller, abort, "b", { meta: true })
  applyInkKey(controller, abort, "ok", {})
  applyInkKey(controller, abort, "", { return: true })
  assert.equal(await typing, "ok")

  const aborting = controller.prompter.ask("Abort? ")
  applyInkKey(controller, abort, "c", { ctrl: true })
  assert.equal(aborted, 1)
  assert.equal(await aborting, undefined)
  assert.equal(controller.isClosed(), true)
})

test("mock store events drive the snapshot and view", () => {
  const store = fakeStore(baseSnapshot())
  store.dispatch({ type: "phase", phase: "consent", label: "Waiting for consent", at: 1 })
  store.dispatch({
    type: "plan",
    title: "Setup",
    steps: [
      { id: "a", description: "Check Node.js", mutates: false, status: "pending" },
      { id: "b", description: "Install plugin", mutates: true, status: "pending" },
    ],
    at: 2,
  })
  store.dispatch({ type: "step", id: "a", status: "ok", at: 3 })
  store.dispatch({ type: "step", id: "b", status: "running", at: 4 })
  store.dispatch({ type: "log", level: "info", message: "Installing", at: 5 })
  store.dispatch({ type: "progress", scope: "install", message: "Downloading", percent: 50, at: 6 })
  const text = render(store.getSnapshot(), 72)
  assert.match(text, /consent - Waiting for consent/)
  assert.match(text, /Plan - Setup \(1\/2\)/)
  assert.match(text, /\[x\] Check Node\.js/)
  assert.match(text, /\| Install plugin/)
  assert.match(text, /50%/)
  assert.equal(store.events.length, 6)
})

test("ask trims input and the queue holds one active prompt", async () => {
  const emitted: Array<PromptRequest | null> = []
  const controller = createPromptController({ emit: (request) => emitted.push(request) })
  const first = controller.prompter.ask("Name? ")
  const second = controller.prompter.ask("Second? ")

  assert.equal(controller.getActive()?.request.question, "Name? ")
  assert.equal(controller.getQueue().length, 1)
  assert.equal(controller.pendingCount(), 2)

  controller.setInput("  Ada  ")
  assert.deepEqual(controller.submit(), { status: "resolved", value: "Ada" })
  assert.equal(await first, "Ada")
  assert.equal(controller.getActive()?.request.question, "Second? ")

  controller.setInput("   ")
  assert.deepEqual(controller.submit(), { status: "resolved", value: "" })
  assert.equal(await second, "")
  assert.equal(controller.getActive(), null)
  assert.deepEqual(emitted.map((request) => request?.kind ?? null), ["ask", "ask", null])
  controller.close()
})

test("choose returns the default, accepts numbers and reprompts on invalid input", async () => {
  const controller = createPromptController({ emit: () => {} })
  const byDefault = controller.prompter.choose(
    "Pick",
    [{ label: "Auto", value: "auto" }, { label: "Manual", value: "manual" }],
    1,
  )
  assert.deepEqual(controller.submit(), { status: "resolved", value: "manual" })
  assert.equal(await byDefault, "manual")

  const byNumber = controller.prompter.choose(
    "Pick",
    [{ label: "Auto", value: "auto" }, { label: "Manual", value: "manual" }],
    0,
  )
  controller.setInput("9")
  const invalid = controller.submit()
  assert.equal(invalid.status, "invalid")
  assert.match((invalid as { error: string }).error, /1 to 2/)
  assert.ok(controller.getActive(), "invalid input keeps the prompt active")
  assert.equal(controller.getActive()?.error, "Enter a number from 1 to 2.")

  controller.setInput("1")
  assert.deepEqual(controller.submit(), { status: "resolved", value: "auto" })
  assert.equal(await byNumber, "auto")
  controller.close()
})

test("choose selection wraps and moving clears typed numbers", async () => {
  const controller = createPromptController({ emit: () => {} })
  const pending = controller.prompter.choose(
    "Pick",
    [{ label: "A", value: "a" }, { label: "B", value: "b" }, { label: "C", value: "c" }],
    0,
  )
  controller.setInput("2")
  controller.moveSelection(-1)
  assert.equal(controller.getActive()?.selectedIndex, 2)
  assert.equal(controller.getActive()?.input, "")
  assert.deepEqual(controller.submit(), { status: "resolved", value: "c" })
  assert.equal(await pending, "c")
  controller.close()
})

test("confirm honors defaultYes, y/n words and exact phrase matching", async () => {
  const controller = createPromptController({ emit: () => {} })

  const yesDefault = controller.prompter.confirm("Continue?", { defaultYes: true })
  assert.deepEqual(controller.submit(), { status: "resolved", value: true })
  assert.equal(await yesDefault, true)

  const noDefault = controller.prompter.confirm("Continue?", { defaultYes: false })
  controller.setInput("YES")
  assert.deepEqual(controller.submit(), { status: "resolved", value: true })
  assert.equal(await noDefault, true)

  const invalid = controller.prompter.confirm("Continue?", { defaultYes: false })
  controller.setInput("maybe")
  const rejected = controller.submit()
  assert.equal(rejected.status, "invalid")
  assert.match((rejected as { error: string }).error, /y\/yes or n\/no \(default no\)/)
  controller.setInput("n")
  assert.deepEqual(controller.submit(), { status: "resolved", value: false })
  assert.equal(await invalid, false)
  controller.close()
})

test("phrase confirm resolves only on an exact, trimmed match", async () => {
  const controller = createPromptController({ emit: () => {} })
  const mismatch = controller.prompter.confirm("Uninstall?", { phrase: "uninstall", defaultYes: true })
  controller.setInput(" uninstall ")
  assert.deepEqual(controller.submit(), { status: "resolved", value: true })
  assert.equal(await mismatch, true)

  const wrong = controller.prompter.confirm("Uninstall?", { phrase: "uninstall" })
  controller.setInput("uninstall!")
  assert.deepEqual(controller.submit(), { status: "resolved", value: false })
  assert.equal(await wrong, false)
  controller.close()
})

test("cancelActive resolves cancel values and advances the queue", async () => {
  const controller = createPromptController({ emit: () => {} })
  const ask = controller.prompter.ask("Name?")
  const choose = controller.prompter.choose("Pick", [{ label: "A", value: "a" }])
  controller.cancelActive()
  assert.equal(await ask, undefined)
  assert.equal(controller.getActive()?.request.kind, "choose")
  controller.cancelActive()
  assert.equal(await choose, undefined)

  const confirm = controller.prompter.confirm("Sure?", { defaultYes: true })
  controller.cancelActive()
  assert.equal(await confirm, false)
  controller.close()
})

test("close cancels active and queued prompts with kind-appropriate values", async () => {
  const emitted: Array<PromptRequest | null> = []
  const controller = createPromptController({ emit: (request) => emitted.push(request) })
  const ask = controller.prompter.ask("Name?")
  const choose = controller.prompter.choose("Pick", [{ label: "A", value: "a" }])
  const confirm = controller.prompter.confirm("Sure?", { defaultYes: true })

  controller.close()
  assert.equal(controller.isClosed(), true)
  assert.equal(controller.pendingCount(), 0)
  assert.equal(controller.getActive(), null)
  assert.equal(await ask, undefined)
  assert.equal(await choose, undefined)
  assert.equal(await confirm, false)
  assert.equal(await controller.prompter.ask("late"), undefined, "enqueue after close cancels immediately")
  assert.equal(emitted.at(-1), null)
})

test("state mirrors cancellation, clears transient state on result, and re-enters phases after done", () => {
  const initial = createInstallerSnapshot({
    command: "setup",
    mode: "ink",
    version: "0.6.0-beta.3",
    windows: true,
    startedAt: 1,
  })
  assert.equal(PHASE_LABELS.cancelling, "Cancelling")
  assert.equal(cancelLabel("requested", "remove-bridge"), "Cancelling - waiting for remove-bridge")
  assert.equal(cancelLabel("requested"), "Cancelling")
  assert.equal(cancelLabel("finishing", "remove-bridge", true), "Cancelling - force requested")
  assert.equal(cancelLabel("settled"), "Cancelled")
  assert.equal(cancelLabel("settled", undefined, true), "Cancelled (forced)")

  let state = reduceInstaller(initial, {
    type: "progress",
    scope: "apply",
    message: "Running spicetify apply.",
    percent: 40,
    at: 2,
  })
  state = reduceInstaller(state, {
    type: "prompt",
    request: { id: "p", kind: "confirm", question: "Continue?", defaultYes: false },
    at: 3,
  })
  state = reduceInstaller(state, { type: "cancel", phase: "requested", stepId: "remove-bridge", at: 4 })
  assert.equal(state.phase, "cancelling")
  assert.equal(state.phaseLabel, "Cancelling - waiting for remove-bridge")
  assert.deepEqual(state.cancel, { phase: "requested", stepId: "remove-bridge" })
  assert.equal(state.progress?.percent, 40, "cancel does not fabricate or erase a real percentage")

  const forced = reduceInstaller(state, { type: "cancel", phase: "finishing", stepId: "remove-bridge", forced: true, at: 5 })
  assert.equal(forced.cancel?.forced, true)

  const settled = reduceInstaller(forced, { type: "cancel", phase: "settled", at: 6 })
  assert.equal(settled.progress, null)
  assert.equal(settled.cancel?.phase, "settled")
  assert.ok(settled.prompt, "a settled cancellation can still wait for a user decision")

  const done = reduceInstaller(settled, { type: "result", code: 130, at: 7 })
  assert.equal(done.phase, "done")
  assert.equal(done.exitCode, 130)
  assert.equal(done.progress, null)
  assert.equal(done.prompt, null)
  assert.equal(done.cancel, undefined)

  // A later action after a done result must re-enter planning/executing.
  const replanned = reduceInstaller(done, {
    type: "plan",
    title: "Apply bridge",
    steps: [{ id: "apply", description: "Run spicetify apply", mutates: true, status: "pending" }],
    at: 8,
  })
  assert.equal(replanned.phase, "plan")
  assert.equal(replanned.exitCode, undefined)

  const executing = reduceInstaller(replanned, { type: "step", id: "apply", status: "running", at: 9 })
  assert.equal(executing.phase, "execute")
  assert.equal(executing.plan?.steps[0]?.status, "running")

  const doneThenStep = reduceInstaller(done, { type: "step", id: "late", status: "running", at: 10 })
  assert.equal(doneThenStep.phase, "execute", "a step after done is not sticky-done")
})

test("detection populates snapshot versions without inventing upstream latest", () => {
  const initial = createInstallerSnapshot({
    command: "setup",
    mode: "ink",
    version: "0.6.0-beta.3",
    windows: true,
  })
  const state = reduceInstaller(initial, { type: "detection", detection, at: 1 })
  assert.equal(state.versions.plugin.installed, "0.6.0")
  assert.equal(state.versions.spicetify.installed, "2.47.0")
  assert.equal(state.versions.plugin.latest, null)
  assert.equal(state.versions.spicetify.latest, null)
})

test("cancel rows and force hints render while a later prompt stays visible", () => {
  const snapshot = baseSnapshot({
    phase: "cancelling",
    phaseLabel: "Cancelling - waiting for remove-bridge",
    cancel: { phase: "requested", stepId: "remove-bridge" },
    prompt: { id: "after-cancel", kind: "confirm", question: "Restart Spotify now?", defaultYes: true },
  })
  const text = render(snapshot, 72)
  assert.match(text, /Cancelling - waiting for remove-bridge/)
  assert.match(text, /press Ctrl\+C again to force/)
  assert.match(text, /\? Restart Spotify now\? \[Y\/n\]/)
  assert.match(text, /Ctrl\+C abort/)

  const forced = render(baseSnapshot({
    cancel: { phase: "finishing", stepId: "remove-bridge", forced: true },
  }), 72)
  assert.match(forced, /Cancelling - force requested/)
  assert.match(forced, /Force requested/)

  const settled = render(baseSnapshot({ cancel: { phase: "settled" } }), 72)
  assert.match(settled, /^Cancelled$/m)
  assert.doesNotMatch(settled, /press Ctrl\+C again/)
})

test("activity uses a compact window and limitViewRows pins plan, prompt and hints", () => {
  assert.equal(MAX_ACTIVITY_ROWS, 14)

  const activity = Array.from({ length: 80 }, (_, index) => ({
    at: index,
    level: "info" as const,
    message: `activity line ${index}`,
  }))
  const snapshot = baseSnapshot({
    plan: {
      title: "Approval",
      steps: [{ id: "run", description: "Run the verified installer", mutates: true, status: "pending" }],
    },
    activity,
    prompt: { id: "consent", kind: "confirm", question: "Run the pinned official installer?", defaultYes: false },
  })
  const view = toInkView(snapshot, 72)
  const activityRows = view.rows.filter((row) => row.kind === "activity")
  assert.equal(activityRows.length, MAX_ACTIVITY_ROWS)
  assert.match(activityRows.at(-1)!.text, /activity line 79/)
  assert.match(view.rows.map((row) => row.text).join("\n"), /Run the verified installer/)

  const limited = limitViewRows(view.rows, 12)
  const limitedText = limited.map((row) => row.text).join("\n")
  assert.match(limitedText, /Plan - Approval/)
  assert.match(limitedText, /Run the verified installer/)
  assert.match(limitedText, /Run the pinned official installer\?/)
  assert.match(limitedText, /Enter submit \| Esc cancel \| Ctrl\+C abort/)
  assert.match(limitedText, /^\.\.\.$/m, "trimmed activity is marked")
  assert.ok(limited.filter((row) => row.kind === "activity").length < MAX_ACTIVITY_ROWS)
})

test("Ctrl+C requests cancellation and a second press forces it", () => {
  const events: ProgressEvent[] = []
  const dispatch = (event: ProgressEvent) => { events.push(event) }
  const token = createCancelToken()

  assert.equal(cancelFromKey(undefined, dispatch), "no-token")

  assert.equal(cancelFromKey(token, dispatch), "requested")
  assert.equal(token.requested, true)
  assert.equal(token.reason, "ctrl-c")
  assert.equal(token.forced, false)
  assert.equal(events.length, 0, "the token listener owns the requested event")

  token.beginFinishing("remove-bridge")
  assert.equal(cancelFromKey(token, dispatch), "forced")
  assert.equal(token.forced, true)
  assert.equal(token.phase, "finishing-current")
  assert.equal(events.length, 1)
  assert.deepEqual(events[0], {
    type: "cancel",
    phase: "finishing",
    stepId: "remove-bridge",
    forced: true,
    at: events[0]!.at,
  })

  // A third press is a no-op, not a second force event.
  assert.equal(cancelFromKey(token, dispatch), "forced")
  assert.equal(events.length, 1)
})

test("core CLI modules never import ink/react statically and the shell keeps A03 settings", () => {
  const cliRoot = fileURLToPath(new URL("../src/cli/", import.meta.url))
  const shellPath = join(cliRoot, "ui", "ink.ts")
  const files: string[] = []
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith(".ts")) files.push(full)
    }
  }
  walk(cliRoot)

  for (const file of files) {
    const source = readFileSync(file, "utf8")
    const label = file.slice(cliRoot.length)
    if (file === shellPath) {
      // The only allowed reference is the declared pin plus the split
      // specifier that is resolved at runtime; never a static import.
      assert.doesNotMatch(
        source,
        /(?:from\s*["']@inkjs\/ui["']|import\s*\(\s*["']@inkjs\/ui["']\s*\))/,
        `${label} must load @inkjs/ui dynamically`,
      )
      assert.match(source, /\["@inkjs",\s*"ui"\]\.join\("\/"\)/)
      continue
    }
    assert.doesNotMatch(source, /@inkjs\/ui/, `${label} must not depend on @inkjs/ui`)
    assert.doesNotMatch(source, /(?:from|import)\s*\(?\s*["'](?:ink|react)["']/, `${label} must not import ink/react`)
    assert.doesNotMatch(source, /require\(\s*["'](?:ink|react)["']\s*\)/, `${label} must not require ink/react`)
  }

  const shell = readFileSync(shellPath, "utf8")
  const viewSource = readFileSync(join(cliRoot, "ui", "ink-view.ts"), "utf8")
  assert.match(shell, /interactive:\s*true/)
  assert.match(shell, /exitOnCtrlC:\s*false/)
  assert.match(shell, /patchConsole:\s*false/)
  assert.match(shell, /maxFps:\s*20/)
  assert.doesNotMatch(shell, /alternateScreen/)
  assert.match(shell, /useWindowSize/)
  assert.match(shell, /isRawModeSupported/)
  assert.match(shell, /stdin\.isTTY\s*===\s*true/)
  assert.match(shell, /setRawMode\?\.\(false\)/)
  assert.match(shell, /code:\s*130/)
  assert.match(shell, /ctrlu?\+?c/i)
  assert.match(shell, /createDesignSystem/)
  assert.match(shell, /themeFor/)
  assert.match(shell, /ThemeProvider/)
  assert.match(shell, /ProgressBar/)
  assert.match(shell, /extendTheme/)
  assert.match(shell, /completedCharacter:\s*"#"/)
  assert.match(shell, /remainingCharacter:\s*"-"/)
  assert.match(shell, /limitViewRows/)
  assert.match(shell, /NO_COLOR/)
  assert.match(shell, /cancel\.request\("ctrl-c"\)/)
  assert.match(shell, /cancel\.force\(\)/)
  assert.match(shell, /Rationale for adopting only ProgressBar/)
  assert.doesNotMatch(shell, /cyan/i)
  assert.doesNotMatch(shell, /"-"\.repeat\(/)
  assert.match(viewSource, /glyphsFor/)
  assert.match(viewSource, /layoutFor/)
  assert.doesNotMatch(viewSource, /"-"\.repeat\(w\)/)
  assert.doesNotMatch(viewSource, /cyan/i)
})

test("dependency contract and factory surface are exposed", () => {
  // WP-C: runtime version constants were removed from ink.ts (ranges belong
  // in the manifest). Assert the manifest contract instead so scratch
  // candidates with exact newer pins still pass: ink trio present, exact or
  // tilde format only, never a peer/optional peer, plus the factory surface.
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
  for (const name of ["ink", "react", "@inkjs/ui"]) {
    const pin = manifest.dependencies?.[name]
    assert.match(String(pin ?? ""), /^(~?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/,
      `${name} manifest pin ${JSON.stringify(pin)} must be exact or tilde (never ^, >=, *)`)
    assert.equal(manifest.peerDependencies?.[name], undefined,
      `${name} must not be a peer (beta.2 shipped optional peers and consumer installs skipped them)`)
    assert.equal(manifest.peerDependenciesMeta?.[name], undefined,
      `${name} must not linger in peerDependenciesMeta`)
    assert.equal(manifest.optionalDependencies?.[name], undefined,
      `${name} must not be optional`)
  }
  assert.equal(typeof createInkPresentation, "function")
})
