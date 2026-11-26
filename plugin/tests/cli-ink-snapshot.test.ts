/**
 * C14 — Ink design-system contract and normalized view snapshots.
 *
 * Scope:
 * - token/contrast/typography invariants and the narrow-terminal ASCII fallback
 * - 14 deterministic frames: prompt/plan/error at 40 and 100 columns, plus a
 *   token report per theme, in dark and light themes
 *
 * The renderer half needs `ink` + `react` + `ink-testing-library` (pinned by the
 * master package). Those dependencies are physically meaningful prerequisites:
 * when absent the live-render checks fail closed rather than skipping — a
 * missing renderer must never look like a passing suite. Stored frames are
 * still validated statically.
 *
 * These snapshots are Ink view trees, not a Windows terminal certification:
 * font shaping, ConPTY cursor behaviour and real colour rendering stay covered
 * by the existing OpenTUI/ConPTY verification work.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { ALLOWED_NON_ASCII, ASCII_GLYPHS, UNICODE_GLYPHS, glyphsFor } from "./fixtures/ink/glyphs.ts"
import { BREAKPOINT, SNAPSHOT_WIDTHS, layoutFor } from "./fixtures/ink/layout.ts"
import {
  displayWidth,
  frameProblems,
  normalizeFrame,
  truncateDisplay,
} from "./fixtures/ink/normalize.ts"
import { createScene, SCENE_CASES } from "./fixtures/ink/scenes.ts"
import type { SceneCase } from "./fixtures/ink/scenes.ts"
import type { InkRuntime } from "./fixtures/ink/components.ts"
import { loadInkHarness, renderRawFrame, renderToString } from "./fixtures/ink/runtime.ts"
import {
  ASSUMED_BACKGROUND,
  CONTRAST_CRITICAL,
  DECORATIVE_TOKENS,
  FORBIDDEN_TOKEN,
  THEMES,
  contrastRatio,
  themeModes,
} from "./fixtures/ink/tokens.ts"

const SNAPSHOT_ROOT = fileURLToPath(new URL("./fixtures/ink/snapshots/", import.meta.url))
const COMPONENT_SOURCE = fileURLToPath(new URL("./fixtures/ink/components.ts", import.meta.url))

function snapshotPath(scene: SceneCase): string {
  return join(SNAPSHOT_ROOT, scene.file)
}

function readSnapshot(scene: SceneCase): string {
  return readFileSync(snapshotPath(scene), "utf8")
}

/* ------------------------------------------------------------------ */
/* Tokens                                                             */
/* ------------------------------------------------------------------ */

test("themes expose only neutral chrome plus the Spotify-green accent", () => {
  for (const mode of themeModes()) {
    const theme = THEMES[mode]
    assert.equal(theme.mode, mode)
    for (const [key, value] of Object.entries(theme)) {
      assert.doesNotMatch(key, FORBIDDEN_TOKEN, `${mode}.${key} must not introduce a background token`)
      if (key === "mode") continue
      assert.match(value as string, /^#[0-9A-F]{6}$/i, `${mode}.${key} must be a 6-digit hex color`)
    }
    assert.equal(theme.accent, theme.ok, "ok status uses the brand accent")
    for (const key of CONTRAST_CRITICAL) {
      const ratio = contrastRatio(theme[key], ASSUMED_BACKGROUND[mode])
      assert.ok(ratio >= 4.5, `${mode}.${key} is ${ratio.toFixed(2)}:1 (needs AA 4.5:1)`)
    }
    for (const key of DECORATIVE_TOKENS) {
      const ratio = contrastRatio(theme[key], ASSUMED_BACKGROUND[mode])
      assert.ok(ratio >= 1.2 && ratio < 3, `${mode}.${key} should be a subtle rule (got ${ratio.toFixed(2)}:1)`)
    }
  }
  assert.equal(THEMES.dark.accent, "#1DB954", "dark mode uses Spotify green")
  assert.equal(THEMES.light.accent, "#0B7A33", "light mode uses an AA-safe darker Spotify green")
  assert.notEqual(THEMES.dark.accent, THEMES.light.accent)
})

function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
}

test("the design system never paints a background or relies on inverse video", () => {
  const source = codeOnly(readFileSync(COMPONENT_SOURCE, "utf8"))
  assert.doesNotMatch(source, /backgroundColor|bgColor|background\s*:/i)
  assert.doesNotMatch(source, /\binverse\s*[:=]/i)
  const tokenSource = codeOnly(readFileSync(fileURLToPath(new URL("./fixtures/ink/tokens.ts", import.meta.url)), "utf8"))
  assert.doesNotMatch(tokenSource, /^\s*(background|bg)\s*:/im)
})

/* ------------------------------------------------------------------ */
/* Glyphs and layout                                                  */
/* ------------------------------------------------------------------ */

test("glyph set stays small and contains no box-drawing frame", () => {
  assert.ok(ALLOWED_NON_ASCII.size <= 8, "keep the Unicode budget at eight glyphs")
  const forbidden = ["\u2500", "\u250C", "\u2510", "\u2514", "\u2518", "\u256D", "\u256E", "\u256F", "\u2570"]
  for (const glyph of forbidden) assert.ok(!ALLOWED_NON_ASCII.has(glyph), `box glyph ${glyph} is not allowed`)
  for (const glyph of Object.values(UNICODE_GLYPHS)) {
    assert.equal(displayWidth(glyph), 1, `glyph ${glyph} must occupy one cell`)
  }
  assert.ok(Object.values(ASCII_GLYPHS).every((glyph) => /^[\x20-\x7E]+$/.test(glyph)))
})

test("40 columns selects the ASCII fallback and 100 columns stays compact", () => {
  const narrow = layoutFor(SNAPSHOT_WIDTHS.narrow)
  assert.equal(narrow.breakpoint, "narrow")
  assert.equal(narrow.ascii, true)
  assert.equal(narrow.content, 38)
  assert.equal(glyphsFor(narrow), ASCII_GLYPHS)

  const wide = layoutFor(SNAPSHOT_WIDTHS.wide)
  assert.equal(wide.breakpoint, "wide")
  assert.equal(wide.ascii, false)
  assert.equal(wide.content, 98)
  assert.equal(glyphsFor(wide), UNICODE_GLYPHS)

  assert.equal(layoutFor(BREAKPOINT - 1).breakpoint, "narrow")
  assert.equal(layoutFor(BREAKPOINT).breakpoint, "wide")
  assert.equal(layoutFor(1).width, 24, "clamps tiny widths")
  assert.equal(layoutFor(10_000).width, 120, "clamps huge widths")
})

test("normalization removes only invisible differences", () => {
  assert.equal(normalizeFrame("a\r\nb  \r\n\r\n"), "a\nb")
  assert.equal(normalizeFrame("\u001B[32mgreen\u001B[0m"), "green")
  assert.equal(truncateDisplay("abcdef", 4, "…"), "abc…")
  assert.equal(truncateDisplay("abc", 4, "…"), "abc")
})

/* ------------------------------------------------------------------ */
/* Stored snapshots (always runnable)                                  */
/* ------------------------------------------------------------------ */

test("scene manifest covers prompt, plan and error at both widths in both themes", () => {
  assert.equal(SCENE_CASES.length, 14)
  for (const mode of themeModes()) {
    for (const id of ["prompt", "plan", "error"] as const) {
      for (const [breakpoint, width] of [["narrow", SNAPSHOT_WIDTHS.narrow], ["wide", SNAPSHOT_WIDTHS.wide]] as const) {
        assert.ok(
          SCENE_CASES.some((scene) => scene.mode === mode && scene.id === id && scene.width === width && scene.breakpoint === breakpoint),
          `missing ${mode}/${id}/${breakpoint}`,
        )
      }
    }
  }
  assert.equal(SCENE_CASES.filter((scene) => scene.id === "tokens").length, 2)
  assert.equal(new Set(SCENE_CASES.map((scene) => scene.file)).size, SCENE_CASES.length, "snapshot paths are unique")
})

for (const scene of SCENE_CASES) {
  test(`snapshot ${scene.file} is normalized, width-safe and compact`, () => {
    const raw = readSnapshot(scene)
    assert.ok(raw.endsWith("\n"), `${scene.file} should end with a newline`)
    assert.ok(!raw.includes("\r"), `${scene.file} must stay LF-only`)
    const frame = normalizeFrame(raw)
    assert.equal(`${frame}\n`, raw, `${scene.file} must not need normalization (trailing spaces/tabs/blank runs)`)
    const layout = layoutFor(scene.width)
    const problems = frameProblems(frame, {
      width: layout.width,
      ascii: scene.breakpoint === "narrow",
      allowedNonAscii: scene.breakpoint === "wide" ? ALLOWED_NON_ASCII : undefined,
    })
    assert.deepEqual(problems, [], `${scene.file} invariants`)

    if (scene.breakpoint === "narrow") {
      const glyphs = glyphsFor(layout)
      assert.ok(frame.includes(glyphs.rule), `${scene.file} should use the ASCII rule`)
      assert.ok(!frame.includes("│"), `${scene.file} must not leak Unicode rules into ASCII mode`)
    } else {
      assert.ok(!frame.includes("\u2500"), `${scene.file} must not draw horizontal box frames`)
    }
  })
}

/* ------------------------------------------------------------------ */
/* Styling intent (no renderer required)                               */
/* ------------------------------------------------------------------ */

interface FakeNode {
  type: unknown
  props: Record<string, any>
  children: any[]
}

function fakeInk(): InkRuntime {
  const createElement = (type: unknown, props: any, ...children: any[]): FakeNode =>
    ({ type, props: props ?? {}, children })
  return { React: { createElement }, Box: "Box", Text: "Text" }
}

function directText(children: any[]): string {
  let text = ""
  for (const child of children) {
    if (typeof child === "string" || typeof child === "number") text += String(child)
  }
  return text
}

function collectTextNodes(node: any, output: FakeNode[] = []): FakeNode[] {
  if (node === null || node === undefined) return output
  if (Array.isArray(node)) {
    for (const child of node) collectTextNodes(child, output)
    return output
  }
  if (typeof node !== "object") return output
  if (node.type === "Text") output.push(node as FakeNode)
  for (const child of (node as FakeNode).children) collectTextNodes(child, output)
  return output
}

test("status, selection and rule tokens are wired to the right spans", () => {
  const ink = fakeInk()
  const scene = (id: "prompt" | "plan" | "error", width: number, mode: "dark" | "light" = "dark"): FakeNode[] => {
    const value = SCENE_CASES.find((entry) => entry.id === id && entry.width === width && entry.mode === mode)
    assert.ok(value, `missing scene ${mode}/${id}/${width}`)
    return collectTextNodes(createScene(value, ink))
  }

  const dark = THEMES.dark
  const prompt = scene("prompt", SNAPSHOT_WIDTHS.wide)
  const selectedMarker = prompt.find((node) => directText(node.children).trim() === "❯")
  assert.ok(selectedMarker, "selected marker span exists")
  assert.equal(selectedMarker!.props.color, dark.selected)
  assert.equal(selectedMarker!.props.bold, true)

  const selectedLabel = prompt.find((node) => directText(node.children).trim() === "Local desktop app")
  assert.ok(selectedLabel, "selected label span exists")
  assert.equal(selectedLabel!.props.color, dark.selected)
  assert.equal(selectedLabel!.props.bold, true)

  const plan = scene("plan", SNAPSHOT_WIDTHS.wide)
  assert.equal(plan.find((node) => directText(node.children).trim() === "●")!.props.color, dark.ok)
  assert.equal(plan.find((node) => directText(node.children).trim() === "▲")!.props.color, dark.warn)
  assert.equal(plan.find((node) => directText(node.children).trim() === "○")!.props.color, dark.pending)

  const error = scene("error", SNAPSHOT_WIDTHS.wide)
  assert.equal(error.find((node) => directText(node.children).trim() === "✕")!.props.color, dark.error)

  const rule = scene("error", SNAPSHOT_WIDTHS.narrow).find((node) => directText(node.children).trim() === "|")
  assert.equal(rule!.props.color, THEMES.dark.rule)

  const lightPrompt = scene("prompt", SNAPSHOT_WIDTHS.wide, "light")
  const lightMarker = lightPrompt.find((node) => directText(node.children).trim() === "❯")
  assert.equal(lightMarker!.props.color, THEMES.light.selected)
  assert.notEqual(THEMES.light.selected, THEMES.dark.selected)

  for (const node of [...prompt, ...plan, ...error, ...lightPrompt]) {
    assert.equal(node.props.backgroundColor, undefined)
    assert.equal(node.props.bgColor, undefined)
    assert.equal(node.props.inverse, undefined)
  }
})

/* ------------------------------------------------------------------ */
/* Live Ink rendering (skipped only when Ink is absent)                */
/* ------------------------------------------------------------------ */

test("Ink renders every stored frame byte-for-byte", async () => {
  const loaded = await loadInkHarness()
  assert.ok(loaded.ok,
    `Ink dependencies are a physically meaningful prerequisite and must be installed: ${loaded.ok ? "" : loaded.reason}`)
  const harness = loaded.harness
  try {
    for (const scene of SCENE_CASES) {
      const raw = renderRawFrame(harness, createScene(scene, harness.ink))
      const frame = normalizeFrame(raw)
      assert.equal(frame, raw, `${scene.file}: rendered frame needed normalization`)
      assert.ok(!raw.includes("\u001B"), `${scene.file}: ANSI escapes must not enter snapshots`)
      assert.equal(frame, normalizeFrame(readSnapshot(scene)), `${scene.file}: rendered frame differs from snapshot`)
      assert.equal(
        renderToString(harness, createScene(scene, harness.ink)),
        frame,
        `${scene.file}: renderToString is not repeatable`,
      )
    }
  } finally {
    harness.cleanup()
  }
})

test("Ink scenes show the selected row, statuses and ASCII fallback", async () => {
  const loaded = await loadInkHarness()
  assert.ok(loaded.ok,
    `Ink dependencies are a physically meaningful prerequisite and must be installed: ${loaded.ok ? "" : loaded.reason}`)
  const harness = loaded.harness
  try {
    const byId = (id: string, width: number, mode: "dark" | "light" = "dark"): string => {
      const scene = SCENE_CASES.find((value) => value.id === id && value.width === width && value.mode === mode)
      assert.ok(scene, `missing scene ${mode}/${id}/${width}`)
      return renderToString(harness, createScene(scene, harness.ink))
    }

    const promptNarrow = byId("prompt", SNAPSHOT_WIDTHS.narrow)
    const promptWide = byId("prompt", SNAPSHOT_WIDTHS.wide)
    assert.equal(promptNarrow.split("\n").filter((line) => line.includes(">")).length, 1, "one selected row in ASCII")
    assert.equal(promptWide.split("\n").filter((line) => line.includes("❯")).length, 1, "one selected row in Unicode")
    assert.match(promptWide, /❯ Local desktop app/)
    assert.match(promptNarrow, /^ {2}> Local desktop app$/m)

    const plan = byId("plan", SNAPSHOT_WIDTHS.wide)
    assert.match(plan, /● ready/)
    assert.match(plan, /▲ review/)
    assert.match(plan, /○ pending/)

    const error = byId("error", SNAPSHOT_WIDTHS.wide)
    assert.match(error, /✕ 401 from 127\.0\.0\.1:43871/)
    assert.match(error, /▲ restart Spotify/)

    const errorNarrow = byId("error", SNAPSHOT_WIDTHS.narrow)
    assert.match(errorNarrow, /^ {2}x 401 /m)
    assert.doesNotMatch(errorNarrow, /[^\x00-\x7F]/, "narrow error view is ASCII-only")

    assert.notEqual(byId("tokens", SNAPSHOT_WIDTHS.wide, "dark"), byId("tokens", SNAPSHOT_WIDTHS.wide, "light"))
  } finally {
    harness.cleanup()
  }
})
