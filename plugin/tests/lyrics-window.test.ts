import { test } from "node:test"
import assert from "node:assert/strict"
import { lyricWindow, wrapLyricLines, distributeLyricRows } from "../src/services/lyrics-window.ts"
import { clusters } from "../src/ui/layout.ts"
import type { Lyrics } from "../src/services/lyrics.ts"

// Node has no OpenTUI native FFI, so structure tests use a codepoint measure.
// Real cell-measure script tests live in the bun renderer suite.
const measure = (s: string) => [...s].length

const uri = "spotify:track:1234567890123456789012"
function lyrics(lines: string[], startTimes: Array<number | null>, synced = true): Lyrics {
  return {
    uri, status: "ready", synced, lines: lines.map((text, index) => ({ text, startMs: startTimes[index] ?? null })),
  }
}

test("five-line window centers the active line with two previous and two upcoming", () => {
  const value = lyrics(["zero", "one", "two", "three", "four", "five", "six"], [0, 1000, 2000, 3000, 4000, 5000, 6000])
  const rows = lyricWindow(value, { kind: "ready-line", lineIndex: 3 }, 5, 3000)
  assert.deepEqual(rows.map((row) => row.text), ["one", "two", "three", "four", "five"])
  assert.deepEqual(rows.map((row) => row.kind), ["dim", "dim", "active", "dim", "dim"])
  assert.equal(rows[2]!.lineIndex, 3)
})

test("three-line and one-line fallbacks preserve the middle active row", () => {
  const value = lyrics(["a", "b", "c"], [0, 1000, 2000])
  const three = lyricWindow(value, { kind: "ready-line", lineIndex: 1 }, 3, 1000)
  assert.deepEqual(three.map((row) => row.text), ["a", "b", "c"])
  assert.equal(three[1]!.kind, "active")
  const one = lyricWindow(value, { kind: "ready-line", lineIndex: 2 }, 1, 2000)
  assert.deepEqual(one.map((row) => row.text), ["c"])
  assert.equal(one[0]!.kind, "active")
})

test("marker lines never occupy a lyric slot", () => {
  const value = lyrics(["zero", "one", "[Instrumental]", "three", "four"], [0, 1000, 2000, 3000, 4000])
  const rows = lyricWindow(value, { kind: "ready-line", lineIndex: 3 }, 5, 3000)
  assert.deepEqual(rows.map((row) => row.text), ["zero", "one", "three", "four", ""])
  assert.ok(rows.every((row) => !row.text.includes("[")))
})

test("interludes keep surrounding context with the indicator in the active slot", () => {
  const value = lyrics(["intro", "verse", "[Instrumental]", "chorus", "outro"], [0, 8000, 14000, 19000, 25000])
  const rows = lyricWindow(value, { kind: "instrumental", phase: "interlude" }, 5, 15000)
  assert.deepEqual(rows.map((row) => row.text), ["intro", "verse", "♪ · · ·", "chorus", "outro"])
  assert.equal(rows[2]!.kind, "status")
  const intro = lyricWindow(lyrics(["intro", "verse"], [5000, 8000]),
    { kind: "instrumental", phase: "intro" }, 5, 2000)
  assert.deepEqual(intro.map((row) => row.text), ["", "", "♪ · · ·", "intro", "verse"])
  const outro = lyricWindow(value, { kind: "instrumental", phase: "outro" }, 5, 30000)
  assert.deepEqual(outro.map((row) => row.text), ["chorus", "outro", "♪ · · ·", "", ""])
})

test("unsynced windows scan past marker lines", () => {
  const value = lyrics(["first", "[Instrumental]", "[Music]", "second", "third"], [null, null, null, null, null], false)
  const rows = lyricWindow(value, { kind: "unsynced" }, 5, 0)
  assert.deepEqual(rows.map((row) => row.text), ["", "", "first", "second", "third"])
})

test("timed neighbours use timestamp order, not source array order", () => {
  const value = lyrics(["later", "earlier", "current", "next"], [4000, 1000, 2000, 3000])
  const rows = lyricWindow(value, { kind: "ready-line", lineIndex: 2 }, 3, 2000)
  assert.deepEqual(rows.map((row) => row.text), ["earlier", "current", "next"])
})

test("unsynced, loading, unavailable and source errors keep stable window sizes", () => {
  const unsynced = lyrics(["first", "second", "third"], [null, null, null], false)
  const rows = lyricWindow(unsynced, { kind: "unsynced" }, 5, 0)
  assert.equal(rows.length, 5)
  assert.equal(rows[2]!.text, "first")
  assert.equal(rows[2]!.kind, "active")
  const loading = lyricWindow(lyrics([], []), { kind: "loading" }, 5, 0)
  assert.equal(loading.length, 5)
  assert.equal(loading[2]!.text, "Finding lyrics…")
  const unavailable = lyricWindow(lyrics([], []), { kind: "unavailable" }, 3, 0)
  assert.equal(unavailable.length, 3)
  assert.equal(unavailable[1]!.text, "No lyrics. Open Lyrics.")
  const failed = lyricWindow(lyrics([], []), { kind: "source-error", message: "LRCLIB unavailable" }, 1, 0)
  assert.deepEqual(failed.map((row) => row.text), ["LRCLIB unavailable"])
  assert.equal(lyricWindow(lyrics([], []), { kind: "no-track" }, 5, 0).length, 5)
})

test("multiline wrap splits long lines and never breaks grapheme clusters", () => {
  const cases: Array<[string, string]> = [
    ["long-ascii", "current line ".repeat(12).trim()],
    ["no-spaces", "abcdefghij".repeat(12)],
    ["combining", "é".repeat(40)],
  ]
  for (const [name, text] of cases) {
    for (const columns of [10, 16, 24]) {
      const [wrapped] = wrapLyricLines([{ text, kind: "active", lineIndex: 0 }], columns, measure)
      assert.ok(wrapped, `${name} wraps at ${columns}`)
      assert.ok(wrapped!.rows.length > 1, `${name} spans several rows at ${columns}`)
      for (const row of wrapped!.rows) {
        assert.ok(measure(row) <= columns, `${name} row fits at ${columns}: ${JSON.stringify(row)}`)
        assert.ok(!row.includes("�"), `${name} has no replacement at ${columns}`)
      }
      const boundaries = new Set<number>([0])
      let offset = 0
      for (const cluster of clusters(text)) { offset += cluster.length; boundaries.add(offset) }
      let cursor = 0
      for (const row of wrapped!.rows) {
        assert.ok(boundaries.has(cursor), `${name} row starts on a cluster boundary at ${columns}`)
        cursor += row.length
        assert.ok(boundaries.has(cursor), `${name} row ends on a cluster boundary at ${columns}`)
        // Rows are end-trimmed by the wrapper; the break whitespace is restored
        // by advancing past it when present.
        while (cursor < text.length && /\s/.test(text[cursor]!)) cursor++
      }
      assert.equal(cursor, text.length, `${name} rejoins exactly at ${columns}`)
    }
  }
})

test("distribute keeps the active line whole and centered in a fixed block", () => {
  const semantic = [
    { text: "prev two", kind: "dim" as const, lineIndex: 0 },
    { text: "prev one", kind: "dim" as const, lineIndex: 1 },
    { text: "current line ".repeat(4).trim(), kind: "active" as const, lineIndex: 2 },
    { text: "next one", kind: "dim" as const, lineIndex: 3 },
    { text: "next two", kind: "dim" as const, lineIndex: 4 },
  ]
  const wrapped = wrapLyricLines(semantic, 24, measure)
  const activeRows = wrapped[2]!.rows.length
  assert.ok(activeRows > 1, "fixture active wraps to several rows")
  const block = distributeLyricRows(wrapped, 5)
  assert.equal(block.activeOverflow, false)
  assert.equal(block.height, 5, "block height always equals the budget (no bounce)")
  const activePos = block.fullLines.findIndex((line) => line.kind === "active")
  assert.equal(block.focusTop, block.fullLines.slice(0, activePos).reduce((sum, line) => sum + line.rows.length, 0),
    "focusTop equals the physical rows above the focus line")
  const active = block.lines.find((line) => line.kind === "active")!
  assert.ok(active, "active survives distribution")
  assert.deepEqual(active.rows, wrapped[2]!.rows, "active is never truncated")
  assert.ok(!active.truncated, "active is never marked truncated")
  const above = block.lines.slice(0, block.lines.findIndex((line) => line.kind === "active"))
    .reduce((sum, line) => sum + line.rows.length, 0)
  const below = block.lines.slice(block.lines.findIndex((line) => line.kind === "active") + 1)
    .reduce((sum, line) => sum + line.rows.length, 0)
  assert.ok(Math.abs((above + block.padTop) - (below + block.padBottom)) <= 1, "active stays vertically centered")
  assert.equal(block.padTop + block.padBottom + block.lines.reduce((sum, line) => sum + line.rows.length, 0), 5)
  for (const line of block.lines) {
    assert.ok(!line.truncated || line.kind === "dim", "only dim lines may be truncated")
    for (const row of line.rows) assert.ok(measure(row) <= 24, "distributed rows fit")
  }
})

test("distribution degrades far context before the active line, then overflows", () => {
  const semantic = [
    { text: "prev two ".repeat(10).trim(), kind: "dim" as const, lineIndex: 0 },
    { text: "prev one ".repeat(10).trim(), kind: "dim" as const, lineIndex: 1 },
    { text: "current ".repeat(10).trim(), kind: "active" as const, lineIndex: 2 },
    { text: "next one ".repeat(10).trim(), kind: "dim" as const, lineIndex: 3 },
    { text: "next two ".repeat(10).trim(), kind: "dim" as const, lineIndex: 4 },
  ]
  const wrapped = wrapLyricLines(semantic, 24, measure)
  assert.ok(wrapped[2]!.rows.length > 1, "fixture active wraps to several rows")
  const tight = distributeLyricRows(wrapped, 5)
  assert.equal(tight.activeOverflow, false)
  assert.equal(tight.height, 5)
  const active = tight.lines.find((line) => line.kind === "active")!
  assert.deepEqual(active.rows, wrapped[2]!.rows, "active whole even when tight")
  assert.ok(tight.lines.some((line) => line.kind === "dim" && (line.truncated || line.rows.length < 4)) ||
    tight.lines.length < 5, "context yields rows before the active line does")
  // A single-row budget with a multi-row active line requests the viewport.
  const tiny = distributeLyricRows(wrapLyricLines(semantic, 24, measure).map((line, index) =>
    index === 2 ? { ...line, rows: [...line.rows, ...line.rows, ...line.rows] } : line), 1)
  assert.equal(tiny.activeOverflow, true, "active alone exceeding budget requests the viewport")
  assert.equal(tiny.height, 1)
  assert.ok(tiny.focusTop >= 0, "fallback knows the active offset")
  assert.deepEqual(tiny.fullLines.map((line) => line.text),
    semantic.map((line) => line.text), "fallback keeps every semantic line")
})

test("blank padding slots never consume budget rows", () => {
  const semantic = [
    { text: "", kind: "dim" as const, lineIndex: null },
    { text: "", kind: "dim" as const, lineIndex: null },
    { text: "only vocal", kind: "active" as const, lineIndex: 0 },
    { text: "", kind: "dim" as const, lineIndex: null },
    { text: "", kind: "dim" as const, lineIndex: null },
  ]
  const block = distributeLyricRows(wrapLyricLines(semantic, 24, measure), 5)
  assert.equal(block.lines.length, 1, "only the vocal line is visible")
  assert.equal(block.padTop + block.padBottom, 4, "freed rows balance around the vocal")
})
