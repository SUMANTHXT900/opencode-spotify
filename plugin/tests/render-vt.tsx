// V0.5.6 VT emission-bounds + V0.5.7 RED stale regression (runs under bun only).
// Renders the real MiniPlayer inside a simulated host composition against a
// REAL CliRenderer with a captured stdout stream, then parses the emitted VT
// with an independent persistent framebuffer (ConPTY UTF-16 per cluster).
//
// Why: captureCharFrame proves the frame MODEL, not what the terminal receives.
// Tamil shaping can advance real terminals differently than width tables
// predict; combined with autowrap at the screen edge plus incremental diffs, a
// row that overruns its box can land glyphs in the editor area, and a shrunken
// row that is not cleared leaves ghosts. This test proves EMISSION stays
// in-rect and OLD CELLS ARE GONE across Tamil→Tamil/Tamil→Malayalam/
// Malayalam→English/English→Tamil/Telugu→Tamil, long→short + multiline→
// single, rapid tracks, backwards seeks, no-lyrics↔lyrics and 5→3→1 — at
// 120×40, 100×40 and small (80×24) where feasible.
import assert from "node:assert/strict"
import { createCliRenderer, measureEditText } from "@opentui/core"
import { render } from "@opentui/solid"
import { createSignal } from "solid-js"
import { Writable } from "node:stream"
import { MiniPlayer } from "../src/components/MiniPlayer.tsx"
import { initialState } from "../src/services/state.ts"
import { defaultLyricsSettings } from "../src/services/lyrics-source.ts"
import { commands } from "../src/services/validation.ts"
import { normalizeLyrics, type Lyrics } from "../src/services/lyrics.ts"
import { playerBudget, playerLayout } from "../src/ui/player-layout.ts"
import type { MusicProps } from "../src/components/Music.tsx"
import type { Context } from "@opencode/plugin/tui/context"

import { cellMeasure } from "../src/ui/primitives.tsx"

// ---------------------------------------------------------------------------
// Part 1: width-model divergence, measured with the production cellMeasure
// (max of live unicode table, wcwidth table, UTF-16 units). Documents the
// exact disagreements that justify unification, then proves wrapped rows fit
// under every single table.
// ---------------------------------------------------------------------------
{
  const probe = cellMeasure({ widthMethod: "unicode" } as never)
  const unicode = (s: string) => measureEditText(s, { widthMethod: "unicode" })
  const wcwidth = (s: string) => measureEditText(s, { widthMethod: "wcwidth" })
  const C = (...cps: number[]) => String.fromCharCode(...cps);
  assert.equal(probe(C(0x0b95, 0x0bcd)), 2, "Tamil ka+virama advances 2 (tables say 1)");
  assert.equal(probe(C(0x0b95, 0x0bcd, 0x0bb7)), 3, "Tamil conjunct advances 3 (tables say 2)");
  assert.equal(probe(C(0x0d15, 0x0d4d, 0x0d36)), 3, "Malayalam conjunct advances 3 (tables say 1-2)");
  assert.equal(probe(C(0x0b95, 0x0bcd, 0x0bb7)), 3, "Tamil conjunct advances 3 (tables say 2)");
  assert.equal(probe(C(0x0d7b)), 1, "Malayalam chillu (single code point) advances 1");
  assert.equal(probe(C(0x0ba4, 0x0bae, 0x0bbf, 0x0bb4, 0x0bcd)), 5, "Tamil word advances 5 (tables say 1-2)");
  assert.equal(probe(C(0x0915, 0x094d, 0x0937)), 3, "Devanagari conjunct advances 3 (tables say 2)");
  assert.equal(probe(C(0xd83d, 0xde49, 0x200d, 0xd83d, 0xdcbb)), 5, "ZWJ emoji advances 5 (tables say 2-4)");
  const fixtures: Array<[string, string]> = [
    ["tamil-long", "தமிழ் பாடல் சோதனை வரிகள் தமிழ்மொழிபாடல் ".repeat(3)],
    ["malayalam-chillu", "அவன்പാടുന്നുകൃഷ്ണൻ ".repeat(6)],
    ["malayalam-conjunct", "ക്ഷ ".repeat(30)],
    ["telugu-long", "తెలుగు పదాలు మన పరీక్ష కోసం మాత్రమే ".repeat(3)],
    ["kannada-conjunct", "ಕ್ಷ ".repeat(30)],
    ["hindi-conjunct", "दृष्टिकोणसंयुक्ताक्षरपरीक्षण ".repeat(3)],
    ["zwj-emoji", "👩‍💻 ".repeat(8)],
    ["flags", "🇮🇳 ".repeat(10)],
    ["mixed", "తెలుగు and English కలిసి testing ".repeat(3)],
  ]
  const { wrapCells } = await import("../src/ui/layout.ts")
  for (const [name, text] of fixtures) {
    const u = unicode(text), w = wcwidth(text)
    if (u !== w || probe(text) !== Math.max(u, w)) console.log(`width-model delta ${name}: unicode=${u} wcwidth=${w} unified=${probe(text)}`)
    const rows = wrapCells(text, 24, probe)
    assert.ok(rows.length > 0, `${name} wraps`)
    for (const row of rows) {
      assert.ok(unicode(row) <= 24 && wcwidth(row) <= 24 && probe(row) <= 24, `${name} row fits all tables: ${JSON.stringify(row)}`)
      assert.ok(!row.includes("�"), `${name} no replacement char`)
    }
  }
  console.log("width-model divergence checks passed")
}

// ---------------------------------------------------------------------------
// Docs & geometry constants.
// ---------------------------------------------------------------------------
const SIDEBAR_WIDTH = 34
const uri = "spotify:track:1234567890123456789012"
const uriB = "spotify:track:AAAAAAAAAAAAAAAAAAAAAA"
const uriC = "spotify:track:BBBBBBBBBBBBBBBBBBBBBB"
const tamilDoc = (startAt: number) => normalizeLyrics({ uri, sync_type: "LINE_SYNCED", lines: [
  { text: "முந்தைய வரி ஒன்று மிகவும் நீளமானது மற்றும் பல வரிகளில் சுற்ற வேண்டும்", startTimeMs: 0 },
  { text: "അവൻപാടുന്നുകൃഷ്ണൻ".repeat(6), startTimeMs: 8000 },
  { text: "தற்போதைய வரி மிகவும் நீளமானது மற்றும் முழுமையாக இருக்க வேண்டும்", startTimeMs: 16000 },
  { text: "दृष्टिकोणसंयुक्ताक्षरपरीक्षण पंक्तियाँ यहाँ जारी रहती हैं", startTimeMs: 24000 },
  { text: "క్ష".repeat(40), startTimeMs: 32000 },
  { text: "க்ஷ மலயாளம் ക്ഷ 👩‍💻 test", startTimeMs: 40000 },
].map((line) => ({ ...line, startTimeMs: line.startTimeMs + startAt })) })!
const asciiDoc = normalizeLyrics({ uri, sync_type: "LINE_SYNCED", lines: [
  { text: "Opening line here", startTimeMs: 0 },
  { text: "Next vocal line here", startTimeMs: 8000 },
  { text: "[Instrumental]", startTimeMs: 14000 },
  { text: "Closing vocal line here", startTimeMs: 24000 },
] })!
const unavailableDoc = { uri, status: "unavailable", synced: false, lines: [], format: "unavailable" } as unknown as Lyrics
const tierLines = ["TIER LINE ZERO தமிழ்", "TIER LINE ONE ക്ഷ", "TIER LINE TWO charlie ACTIVE",
  "TIER LINE THREE க்ஷ", "TIER LINE FOUR അവൻ"]
const tierDoc = normalizeLyrics({ uri, sync_type: "LINE_SYNCED",
  lines: tierLines.map((text, index) => ({ text, startTimeMs: index * 8000 })) })!

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

// ---------------------------------------------------------------------------
// V0.5.7 independent physical widths. ConPTY advances Indic combining
// sequences, viramas, ZWJ and variation selectors per UTF-16 code unit while
// both tables count them as zero-width. Framebuffer advances every grapheme
// cluster by UTF-16 length (2 for single wide CJK), never by production
// cellMeasure. Baselines logged, never used as oracle.
// ---------------------------------------------------------------------------
function isWideCodePoint(cp: number): boolean {
  return (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x20000 && cp <= 0x3fffd)
}
function physicalClusterWidth(cluster: string): number {
  if (!cluster) return 0
  const cps = Array.from(cluster)
  if (cps.length === 1) {
    const cp = cps[0]!.codePointAt(0)!
    if (isWideCodePoint(cp)) return 2
  }
  return cluster.length
}
function physicalTextWidth(text: string): number {
  let total = 0
  for (const { segment } of graphemes.segment(text)) total += physicalClusterWidth(segment)
  return total
}
{
  const unicodeW = (s: string) => measureEditText(s, { widthMethod: "unicode" })
  const wcwidthW = (s: string) => measureEditText(s, { widthMethod: "wcwidth" })
  const C = (...cps: number[]) => String.fromCharCode(...cps)
  const cases: Array<[string, string]> = [
    ["tamil ka+virama", C(0x0b95, 0x0bcd)],
    ["tamil conjunct", C(0x0b95, 0x0bcd, 0x0bb7)],
    ["malayalam conjunct", C(0x0d15, 0x0d4d, 0x0d36)],
    ["devanagari conjunct", C(0x0915, 0x094d, 0x0937)],
    ["zwj emoji", C(0xd83d, 0xde49, 0x200d, 0xd83d, 0xdcbb)],
    ["ascii space", " "],
    ["ascii A", "A"],
  ]
  for (const [name, s] of cases) {
    const p = physicalClusterWidth(s)
    const u = unicodeW(s), w = wcwidthW(s)
    console.log(`physical probe ${name}: physical=${p} unicode=${u} wcwidth=${w} utf16=${s.length}`)
  }
  assert.equal(physicalClusterWidth(C(0x0b95, 0x0bcd)), 2)
  assert.equal(physicalClusterWidth(C(0x0b95, 0x0bcd, 0x0bb7)), 3)
  assert.equal(physicalClusterWidth(C(0x0d15, 0x0d4d, 0x0d36)), 3)
  assert.equal(physicalClusterWidth(C(0xd83d, 0xde49, 0x200d, 0xd83d, 0xdcbb)), 5)
  assert.equal(physicalClusterWidth(" "), 1)
  console.log("independent physical width probes passed")
}

// ---------------------------------------------------------------------------
// Emulation review (for Agent A + reviewers):
// - Spaces overwrite (old branch preserved stale on space, hiding ghosts).
// - Every continuation cell cleared: w>1 sets w-1 "" cells; overwriting
//   narrow over wide clears orphan "" to " "; landing inside a continuation
//   clears its wide start. Covers ConPTY per-unit advances (w=3,5).
// - Erases: ED1 clears 0..gy-1 fully + 0..gx on current; SU/SD/IL/DL respect
//   scrollTop/Bottom (DECSTBM); EL/ECH/DCH/ICH fill with " " and keep length.
// - CUP/H/V/G/d/A-D/E-F/s/u/RI/NEL/HT/BS/CR/LF handled; pendingWrap settled
//   before each cluster, overrun counted only for non-space.
// - StyledText runs: OpenTUI emits SGR (CSI ... m) around printable runs
//   (bold active vs dim, fg). Parser ignores SGR (no cursor move) and places
//   sequential printable runs at advancing gx — correct since runs share one
//   CUP row. Multiline fallback `<text>{rows.join("\n")}</text>` uses native
//   centering + fixed-width trailing fill (the overrun source); shapedSingle
//   (single-row truncate+reserve) uses manual leading + native width, no fill
//   (the shrink-ghost source when tail not cleared). Both verified via
//   physical widths, not production measure.
// - Per-frame: renderer "frame" events mark byte offsets; every frame is
//   checked for editor-exact + no overrun. Per-phase finals additionally
//   compare full lyric-region cells vs fresh-render oracle + hardcoded
//   anchors (prevents vacuous both-blank match).
// ---------------------------------------------------------------------------
type AccurateCell = { text: string }
type MeasureFn = (s: string) => number
// Single parameterized stateful VT framebuffer (Reviewer #1 dedup):
// `measure` selects the cursor oracle — physicalClusterWidth (ConPTY UTF-16)
// for RED stale checks, production cellMeasure for V0.5.6 bounds (upper bound).
// All overwrite/continuation/erase/CUP/scroll/StyledText-SGR handling is shared.
function createStatefulParser(COLS: number, ROWS: number, label: string, measure: MeasureFn) {
  let grid: AccurateCell[][] = Array.from({ length: ROWS }, () =>
    Array.from({ length: COLS }, () => ({ text: " " })))
  let gx = 0, gy = 0, saved = { x: 0, y: 0 }
  let pendingWrap = false
  let scrollTop = 0, scrollBottom = ROWS - 1
  const violations: string[] = []
  let wraps = 0
  let frames = 0
  const blankRow = () => Array.from({ length: COLS }, () => ({ text: " " }))
  const scrollGrid = () => {
    for (let r = scrollTop; r < scrollBottom; r++) grid[r] = grid[r + 1]!
    grid[scrollBottom] = blankRow()
  }
  const placeRun = (text: string) => {
    const settle = () => {
      if (!pendingWrap) return
      pendingWrap = false
      wraps++
      gx = 0
      gy++
      if (gy > scrollBottom) { gy = scrollBottom; scrollGrid() }
    }
    for (const { segment } of graphemes.segment(text)) {
      const w = measure(segment)
      if (w <= 0) { if (gx > 0) grid[gy]![gx - 1]!.text += segment; continue }
      settle()
      if (gx + w > COLS) {
        if (segment.trim() !== "") violations.push(`${label}: overrun at (${gy},${gx}) ${JSON.stringify(segment)} w=${w}`)
        wraps++; gx = 0; gy++
        if (gy > scrollBottom) { gy = scrollBottom; scrollGrid() }
        continue
      }
      if (segment.trim() !== "" && gx < COLS - SIDEBAR_WIDTH && gx + w > COLS - SIDEBAR_WIDTH) {
        violations.push(`${label}: run crosses sidebar edge at (${gy},${gx}) ${JSON.stringify(segment)}`)
      }
      if (grid[gy]![gx]!.text === "") {
        let sx = gx - 1
        while (sx >= 0 && grid[gy]![sx]!.text === "") sx--
        if (sx >= 0) {
          const st = grid[gy]![sx]!.text
          if (st !== " " && st !== "") {
            const sw = measure(st)
            if (sx + sw > gx) {
              grid[gy]![sx] = { text: " " }
              for (let k = 1; k < sw && sx + k < COLS; k++) {
                if (sx + k !== gx && grid[gy]![sx + k]!.text === "") grid[gy]![sx + k] = { text: " " }
              }
            }
          }
        }
      }
      const prev = grid[gy]![gx]!.text
      let prevW = 1
      if (prev !== " " && prev !== "") prevW = measure(prev)
      grid[gy]![gx] = { text: segment }
      for (let k = 1; k < w && gx + k < COLS; k++) grid[gy]![gx + k] = { text: "" }
      if (prevW > w) {
        for (let k = w; k < prevW && gx + k < COLS; k++) {
          if (grid[gy]![gx + k]!.text === "") grid[gy]![gx + k] = { text: " " }
        }
      }
      if (w === 1 && gx + 1 < COLS && grid[gy]![gx + 1]!.text === "") grid[gy]![gx + 1] = { text: " " }
      gx += w
      if (gx === COLS) pendingWrap = true
      else if (gx > COLS) { wraps++; gx = 0; gy++; if (gy > scrollBottom) { gy = scrollBottom; scrollGrid() } }
    }
  }
  const feed = (bytes: Uint8Array, textDecoder: TextDecoder) => {
    let i = 0
    while (i < bytes.length) {
      const byte = bytes[i]!
      if (byte === 0x1b) {
        const next = bytes[i + 1]
        if (next === 0x5b) {
          let j = i + 2
          while (j < bytes.length && !/[@-~]/.test(String.fromCharCode(bytes[j]!))) j++
          if (j >= bytes.length) break
          const params = Buffer.from(bytes.slice(i + 2, j)).toString("binary")
          const final = String.fromCharCode(bytes[j]!)
          const clean = params.replace(/^[?>!]/, "")
          const nums = clean ? clean.split(";").map((v) => (v === "" ? 0 : Number(v))) : []
          const n = (k = 0, d = 1) => (Number.isFinite(nums[k]) ? nums[k]! : d)
          switch (final) {
            case "A": gy = Math.max(scrollTop, gy - Math.max(1, n())); break
            case "B": gy = Math.min(scrollBottom, gy + Math.max(1, n())); break
            case "C": gx = Math.min(COLS - 1, gx + Math.max(1, n())); break
            case "D": gx = Math.max(0, gx - Math.max(1, n())); break
            case "E": gy = Math.min(scrollBottom, gy + Math.max(1, n())); gx = 0; pendingWrap = false; break
            case "F": gy = Math.max(scrollTop, gy - Math.max(1, n())); gx = 0; pendingWrap = false; break
            case "G": gx = Math.max(0, Math.min(COLS - 1, n() - 1)); pendingWrap = false; break
            case "d": gy = Math.max(scrollTop, Math.min(scrollBottom, n() - 1)); pendingWrap = false; break
            case "H": case "f": gy = Math.max(0, Math.min(ROWS - 1, n(0, 1) - 1)); gx = Math.max(0, Math.min(COLS - 1, n(1, 1) - 1)); pendingWrap = false; break
            case "J": {
              const mode = n(0, 0)
              if (mode === 2) grid = Array.from({ length: ROWS }, () => blankRow())
              else if (mode === 1) {
                for (let r = 0; r < gy; r++) grid[r] = blankRow()
                for (let c = 0; c <= gx && c < COLS; c++) grid[gy]![c] = { text: " " }
              } else { for (let c = gx; c < COLS; c++) grid[gy]![c] = { text: " " }; for (let r = gy + 1; r < ROWS; r++) grid[r] = blankRow() }
              break
            }
            case "K": {
              const mode = n(0, 0)
              if (mode === 2) grid[gy] = blankRow()
              else if (mode === 1) for (let c = 0; c <= gx && c < COLS; c++) grid[gy]![c] = { text: " " }
              else for (let c = gx; c < COLS; c++) grid[gy]![c] = { text: " " }
              break
            }
            case "X": for (let c = gx; c < Math.min(COLS, gx + Math.max(1, n())); c++) grid[gy]![c] = { text: " " }; break
            case "L": {
              if (gy >= scrollTop && gy <= scrollBottom) {
                for (let k = 0; k < Math.max(1, n()); k++) { grid.splice(gy, 0, blankRow()); grid.splice(scrollBottom + 1, 1) }
              } else {
                for (let k = 0; k < Math.max(1, n()); k++) { grid.splice(gy, 0, blankRow()); grid.pop() }
              }
              break
            }
            case "M": {
              if (gy >= scrollTop && gy <= scrollBottom) {
                for (let k = 0; k < Math.max(1, n()); k++) { grid.splice(gy, 1); grid.splice(scrollBottom, 0, blankRow()) }
              } else {
                for (let k = 0; k < Math.max(1, n()); k++) { grid.splice(gy, 1); grid.push(blankRow()) }
              }
              break
            }
            case "P": grid[gy]!.splice(gx, Math.max(1, n())); while (grid[gy]!.length < COLS) grid[gy]!.push({ text: " " }); break
            case "@": grid[gy]!.splice(gx, 0, ...Array.from({ length: Math.max(1, n()) }, () => ({ text: " " }))); grid[gy]!.length = COLS; break
            case "S": for (let k = 0; k < Math.max(1, n()); k++) { for (let r = scrollTop; r < scrollBottom; r++) grid[r] = grid[r + 1]!; grid[scrollBottom] = blankRow() } break
            case "T": for (let k = 0; k < Math.max(1, n()); k++) { for (let r = scrollBottom; r > scrollTop; r--) grid[r] = grid[r - 1]!; grid[scrollTop] = blankRow() } break
            case "s": saved = { x: gx, y: gy }; break
            case "u": gx = saved.x; gy = saved.y; pendingWrap = false; break
            case "r": { const top = n(0, 1), bottom = n(1, ROWS); scrollTop = Math.max(0, top - 1); scrollBottom = Math.min(ROWS - 1, bottom - 1); gx = 0; gy = scrollTop; pendingWrap = false; break }
            // SGR (m), cursor hide/show (?25h/l), sync output (?2026h/l): no cursor move.
            // ?2026 boundaries counted as frames for per-frame checks.
            case "h": case "l": case "m": break
            default: break
          }
          // Count synchronized-output frames: CSI ? 2026 h / l
          if ((final === "h" || final === "l") && clean === "2026") frames++
          i = j + 1
          continue
        }
        if (next === 0x5d || next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f) {
          let j = i + 2
          while (j < bytes.length && !(bytes[j] === 0x07 || (bytes[j] === 0x1b && bytes[j + 1] === 0x5c))) j++
          i = bytes[j] === 0x1b ? j + 2 : j + 1
          continue
        }
        if (next !== undefined && next >= 0x20 && next <= 0x2f) { i += 3; continue }
        if (next === 0x37) { saved = { x: gx, y: gy }; i += 2; continue }
        if (next === 0x38) { gx = saved.x; gy = saved.y; i += 2; continue }
        if (next === 0x45) { gx = 0; gy++; if (gy > scrollBottom) { gy = scrollBottom; scrollGrid() } i += 2; continue }
        if (next === 0x4d) { gy = Math.max(scrollTop, gy - 1); i += 2; continue }
        if (next === 0x44) { gy++; if (gy > scrollBottom) { gy = scrollBottom; scrollGrid() } i += 2; continue }
        i += 2
        continue
      }
      if (byte === 0x0d) { gx = 0; pendingWrap = false; i++; continue }
      if (byte === 0x0a) { pendingWrap = false; gy++; if (gy > scrollBottom) { gy = scrollBottom; scrollGrid() } i++; continue }
      if (byte === 0x08) { gx = Math.max(0, gx - 1); pendingWrap = false; i++; continue }
      if (byte === 0x09) { gx = Math.min(COLS - 1, (Math.floor(gx / 8) + 1) * 8); pendingWrap = false; i++; continue }
      if (byte < 0x20 || byte === 0x7f) { i++; continue }
      let j = i
      while (j < bytes.length && bytes[j]! >= 0x20 && bytes[j] !== 0x7f && bytes[j] !== 0x1b) j++
      const run = textDecoder.decode(bytes.slice(i, j), { stream: true })
      i = j
      if (run) placeRun(run)
    }
  }
  const snapshot = () => grid.map((row) => row.map((c) => ({ ...c })))
  return { feed, snapshot, get grid() { return grid }, get violations() { return violations }, get wraps() { return wraps }, get frameCount() { return frames } }
}
function createAccurateParser(COLS: number, ROWS: number, label: string) {
  return createStatefulParser(COLS, ROWS, label, physicalClusterWidth)
}
function createBoundsParser(COLS: number, ROWS: number, label: string, measure: MeasureFn) {
  return createStatefulParser(COLS, ROWS, label, measure)
}

function sidebarOf(grid: AccurateCell[][], COLS: number): string {
  const x0 = COLS - SIDEBAR_WIDTH
  return grid.map((row) => row.slice(x0).map((c) => c.text).join("")).join("\n")
}
function assertEditorExact(grid: AccurateCell[][], COLS: number, ROWS: number, label: string, phase: string) {
  const x0 = COLS - SIDEBAR_WIDTH
  for (let r = 0; r < ROWS; r++) {
    const expected = `ES ${String(r).padStart(2, "0")} sentinel`
    for (let c = 0; c < expected.length && c < x0; c++) {
      const cell = grid[r]![c]!
      assert.equal(cell.text, expected[c], `${label}/${phase}: editor cell (${r},${c}) exact, got ${JSON.stringify(cell.text)}`)
    }
    for (let c = expected.length; c < x0; c++) {
      const cell = grid[r]![c]!
      assert.equal(cell.text, " ", `${label}/${phase}: editor padding (${r},${c}) must be blank, got ${JSON.stringify(cell.text)}`)
    }
  }
}
function lyricsRowsFor(ROWS: number, budgetOverride?: number): number {
  const budget = budgetOverride ?? playerBudget(ROWS)
  // Width 32 (sidebar 34 minus padding) is roomy-capable; rows depend on budget only.
  return playerLayout(budget, { hasTrack: true, width: 32, aspect: 2, artwork: true, showVolume: true, preview: true }).lyricsRows
}
function lyricRegionRows(ROWS: number, budgetOverride?: number): number[] {
  const n = lyricsRowsFor(ROWS, budgetOverride)
  if (!n) return []
  return Array.from({ length: n }, (_, k) => ROWS - n + k)
}

// Frame-based wait: N renderer frames + byte quiescence. Fails on timeout
// (no warn+continue): a timeout means the renderer never settled, which is
// itself a regression (hung diff) and must not be masked as a pass.
async function waitStable(renderer: unknown, getLen: () => number, opts?: { frames?: number; stableMs?: number; timeout?: number; label?: string }) {
  const wantFrames = opts?.frames ?? 3
  const stableMs = opts?.stableMs ?? 200
  const timeout = opts?.timeout ?? 3200
  const r = renderer as unknown as { frameId?: number; on?: (e: string, f: () => void) => void; off?: (e: string, f: () => void) => void }
  const startFrame: number = typeof r.frameId === "number" ? r.frameId : 0
  let seen = 0
  const onFrame = () => { seen++ }
  try { r.on?.("frame", onFrame) } catch { /* frame events optional; byte quiescence still applies */ }
  const start = Date.now()
  let lastLen = getLen()
  let lastChange = Date.now()
  // Poll fast; resolve as soon as frames seen + bytes stable, else fail (no warn+continue).
  while (true) {
    await new Promise((res) => setTimeout(res, 30))
    const now = Date.now()
    const len = getLen()
    if (len !== lastLen) { lastLen = len; lastChange = now }
    let curFrame = startFrame
    try { if (typeof r.frameId === "number") curFrame = r.frameId } catch { /* ignore */ }
    const frameDelta = curFrame - startFrame
    const framesOk = Math.max(seen, frameDelta) >= wantFrames
    if (framesOk && now - lastChange >= stableMs) break
    if (now - start >= timeout) {
      try { r.off?.("frame", onFrame) } catch { /* ignore */ }
      assert.fail(`waitStable ${opts?.label ?? ""}: timed out after ${timeout}ms (framesSeen=${seen} delta=${frameDelta} bytes=${len}); renderer never settled`)
    }
  }
  try { r.off?.("frame", onFrame) } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Incremental host run with per-phase states + per-frame byte offsets.
// ---------------------------------------------------------------------------
type PhaseState = { doc: Lyrics; pos: number; trackUri: string | null; playing: boolean; budget?: number; hasTrack?: boolean }
type PhaseDef = { name: string; apply: (s: PhaseState) => PhaseState; present: string[]; absentGlobal: string[]; note: string }

// Shared host composition (single definition for incremental + fresh).
// Preserves editor sentinel exact + sidebar footer layout; ZWJ anchors kept.
// `music` is `any` to avoid coupling the test harness to RpcClient generics;
// runtime behavior (real MiniPlayer + real CliRenderer) is what is tested.
function hostFrame(music: any, ROWS: number) {
  const editorRows = Array.from({ length: ROWS }, (_, i) => `ES ${String(i).padStart(2, "0")} sentinel`)
  return <box flexDirection="row" width="100%" height="100%">
    <box flexGrow={1} flexDirection="column" minWidth={0}>
      {editorRows.map((row) => <text height={1} width="100%">{row}</text>)}
    </box>
    <box width={SIDEBAR_WIDTH} flexDirection="column" height="100%" flexShrink={0}>
      <box flexGrow={1} flexBasis={0} minHeight={0} />
      <MiniPlayer {...music} />
    </box>
  </box>
}
function musicPropsFor(opts: {
  context: Context; state: () => unknown;
  lyrics: () => Lyrics; position: () => number; budget: () => number; previewSeek?: (ms: number) => void;
  settings?: () => ReturnType<typeof defaultLyricsSettings>;
}): {
  context: Context; state: () => unknown; lyrics: () => Lyrics; position: () => number; budget: () => number;
  settings: () => unknown; sources: () => unknown; saveSettings: () => Promise<void>; refreshLyrics: () => Promise<void>;
  rpc: unknown; previewSeek?: (ms: number) => void; open: () => void; openLyrics: () => void; openSettings: () => void; more: () => void; run: () => Promise<boolean | void>;
} {
  return {
    context: opts.context, state: opts.state as never, lyrics: opts.lyrics, position: opts.position,
    settings: opts.settings ?? defaultLyricsSettings, sources: () => null, saveSettings: async () => {}, refreshLyrics: async () => {},
    rpc: {} as never, budget: opts.budget, previewSeek: opts.previewSeek ?? (() => {}),
    open() {}, openLyrics() {}, openSettings() {}, more() {}, run: async () => true,
  }
}

async function runIncremental(COLS: number, ROWS: number, label: string, initial: PhaseState, phases: PhaseDef[]) {
  const chunks: Buffer[] = []
  const sink = new Writable({
    write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk as Uint8Array)); cb() },
  }) as unknown as NodeJS.WriteStream
  ;(sink as unknown as Record<string, unknown>).columns = COLS
  ;(sink as unknown as Record<string, unknown>).rows = ROWS
  ;(sink as unknown as Record<string, unknown>).isTTY = true
  let cur: PhaseState = { ...initial, hasTrack: initial.hasTrack ?? true }
  let setDoc!: (v: Lyrics) => void
  let setPos!: (n: number) => void
  let setPlaying!: (v: boolean) => void
  let setTrackUri!: (v: string | null) => void
  let setBudget!: (n: number | undefined) => void
  let setHasTrack!: (v: boolean) => void
  function Scene() {
    const [position, updatePosition] = createSignal(cur.pos)
    const [lyrics, updateLyrics] = createSignal<Lyrics>(cur.doc)
    const [playing, updatePlaying] = createSignal(cur.playing)
    const [trackUri, updateTrackUri] = createSignal<string | null>(cur.trackUri)
    const [budgetOv, updateBudget] = createSignal<number | undefined>(cur.budget)
    const [hasTrack, updateHasTrack] = createSignal(cur.hasTrack ?? true)
    setDoc = updateLyrics; setPos = updatePosition; setPlaying = updatePlaying; setTrackUri = updateTrackUri; setBudget = updateBudget; setHasTrack = updateHasTrack
    const state = () => ({ ...initialState(), connection: "connected" as const,
      track: hasTrack() ? { uri: (trackUri() ?? uri), title: "Nallaru Po - From \"Dude\"", artist: "Abhyanakkar, Tippu", album: "Dude", image: "" } : null,
      playback: { ...initialState().playback, trackUri: hasTrack() ? (trackUri() ?? uri) : null, durationMs: 224000, isPlaying: playing(),
        liked: false, shuffle: false, repeat: 0 as const, volume: 0.45, muted: false },
      capabilities: { protocol: 2, apis: {}, commands: [...commands], search_mode: null },
    })
    const context = {
      renderer: rendererRef, theme: { text: { base: "#eef2ec", muted: "#a6afa7", action: { primary: { base: "#8fc7a0" } } } },
      keymap: { layer(_f: unknown) {} },
      ui: { toast: { show() {} }, dialog: {}, panel: { current: () => undefined } }, options: {},
      data: { location: { default: () => ({ directory: "host-fixture" }) } },
    } as unknown as Context
    const music = musicPropsFor({ context, state: state as never, lyrics, position,
      budget: () => budgetOv() ?? playerBudget(ROWS),
    })
    ;(music as unknown as { previewSeek: (ms: number) => void }).previewSeek = (ms: number) => updatePosition(ms)
    return hostFrame(music, ROWS)
  }
  let rendererRef!: { width: number; height: number }
  const renderer = await createCliRenderer({ stdout: sink, width: COLS, height: ROWS } as never)
  rendererRef = renderer as never
  const frameByteOffsets: number[] = []
  const onFrameBytes = () => { frameByteOffsets.push(Buffer.concat(chunks).length) }
  try { (renderer as unknown as { on: (e: string, f: () => void) => void }).on("frame", onFrameBytes) } catch { /* optional */ }
  await render(() => <Scene />, renderer as never)
  await waitStable(renderer, () => Buffer.concat(chunks).length, { frames: 2, stableMs: 150, timeout: 2500, label: `${label}/init` })
  const states: Array<{ name: string; offset: number; state: PhaseState }> = [{ name: "init", offset: Buffer.concat(chunks).length, state: { ...cur } }]
  console.log(`phase ${label}/init done bytes=${states[0]!.offset}`)
  for (const ph of phases) {
    if (ph.name === "rapid-tracks") {
      // Two track switches with only 80ms apart to stress incremental diff.
      const s1: PhaseState = { doc: tamilDoc(100000), pos: 101000, trackUri: uriB, playing: true, hasTrack: true }
      setTrackUri(s1.trackUri); setDoc(s1.doc); setPos(s1.pos); setPlaying(s1.playing); setBudget(s1.budget); setHasTrack(s1.hasTrack ?? true)
      cur = { ...s1 }
      await new Promise((r) => setTimeout(r, 80))
      const s2: PhaseState = { doc: asciiDoc, pos: 1000, trackUri: uriC, playing: true, hasTrack: true }
      setTrackUri(s2.trackUri); setDoc(s2.doc); setPos(s2.pos); setPlaying(s2.playing); setBudget(s2.budget); setHasTrack(s2.hasTrack ?? true)
      cur = { ...s2 }
      await waitStable(renderer, () => Buffer.concat(chunks).length, { frames: 2, stableMs: 150, timeout: 2500, label: `${label}/${ph.name}` })
    } else {
      const next = ph.apply({ ...cur })
      if (next.doc !== cur.doc) setDoc(next.doc)
      if (next.pos !== cur.pos) setPos(next.pos)
      if ((next.trackUri ?? null) !== (cur.trackUri ?? null)) setTrackUri(next.trackUri ?? null)
      if (next.playing !== cur.playing) setPlaying(next.playing)
      if (next.budget !== cur.budget) setBudget(next.budget)
      if ((next.hasTrack ?? true) !== (cur.hasTrack ?? true)) setHasTrack(next.hasTrack ?? true)
      cur = { ...next, hasTrack: next.hasTrack ?? true }
      await waitStable(renderer, () => Buffer.concat(chunks).length, { frames: 1, stableMs: 120, timeout: 1800, label: `${label}/${ph.name}` })
    }
    const off = Buffer.concat(chunks).length
    states.push({ name: ph.name, offset: off, state: { ...cur } })
    console.log(`phase ${label}/${ph.name} done bytes=${off} (${ph.note})`)
  }
  try { (renderer as unknown as { off: (e: string, f: () => void) => void }).off("frame", onFrameBytes) } catch { /* ignore */ }
  await new Promise((r) => setTimeout(r, 200))
  renderer.destroy()
  await new Promise((r) => setTimeout(r, 200))
  return { bytes: Buffer.concat(chunks), states, frameByteOffsets, measure: cellMeasure(renderer as never) }
}

async function renderFresh(COLS: number, ROWS: number, state: PhaseState): Promise<Buffer> {
  const chunks: Buffer[] = []
  const sink = new Writable({
    write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk as Uint8Array)); cb() },
  }) as unknown as NodeJS.WriteStream
  ;(sink as unknown as Record<string, unknown>).columns = COLS
  ;(sink as unknown as Record<string, unknown>).rows = ROWS
  ;(sink as unknown as Record<string, unknown>).isTTY = true
  let revealLyrics!: (visible: boolean) => void
  function Scene() {
    const [position] = createSignal(state.pos)
    const [lyrics] = createSignal<Lyrics>(state.doc)
    const [playing] = createSignal(state.playing)
    const [trackUri] = createSignal<string | null>(state.trackUri)
    const [budgetOv] = createSignal<number | undefined>(state.budget)
    const [hasTrack] = createSignal(state.hasTrack ?? true)
    const [preview, setPreview] = createSignal(false)
    revealLyrics = setPreview
    const st = () => ({ ...initialState(), connection: "connected" as const,
      track: hasTrack() ? { uri: (trackUri() ?? uri), title: "Nallaru Po - From \"Dude\"", artist: "Abhyanakkar, Tippu", album: "Dude", image: "" } : null,
      playback: { ...initialState().playback, trackUri: hasTrack() ? (trackUri() ?? uri) : null, durationMs: 224000, isPlaying: playing(),
        liked: false, shuffle: false, repeat: 0 as const, volume: 0.45, muted: false },
      capabilities: { protocol: 2, apis: {}, commands: [...commands], search_mode: null },
    })
    const context = {
      renderer: rRef, theme: { text: { base: "#eef2ec", muted: "#a6afa7" } },
      keymap: { layer(_f: unknown) {} },
      ui: { toast: { show() {} }, dialog: {}, panel: { current: () => undefined } }, options: {},
      data: { location: { default: () => ({ directory: "host-fixture" }) } },
    } as unknown as Context
    const music = musicPropsFor({ context, state: st as never, lyrics, position,
      budget: () => budgetOv() ?? playerBudget(ROWS),
      settings: () => ({ ...defaultLyricsSettings(), preview: preview() }),
    })
    return hostFrame(music, ROWS)
  }
  let rRef!: { width: number; height: number }
  const renderer = await createCliRenderer({ stdout: sink, width: COLS, height: ROWS } as never)
  rRef = renderer as never
  await render(() => <Scene />, renderer as never)
  // Mount the chrome before revealing this document so the oracle never
  // contains early narrow-width lyrics or any previous lyric document.
  await waitStable(renderer, () => Buffer.concat(chunks).length, { frames: 1, stableMs: 100, timeout: 2500, label: "pristine chrome" })
  if (state.hasTrack !== false) {
    revealLyrics(true)
    await waitStable(renderer, () => Buffer.concat(chunks).length, { frames: 1, stableMs: 120, timeout: 2500, label: "pristine lyrics" })
  }
  renderer.destroy()
  await new Promise((r) => setTimeout(r, 150))
  return Buffer.concat(chunks)
}

// V0.5.6 bounds (production measure as upper-bound oracle, intentional).
// Uses the single shared stateful parser with the production measure.
function parseBounds(raw: Buffer, COLS: number, ROWS: number, label: string, measure: MeasureFn) {
  const x0 = COLS - SIDEBAR_WIDTH
  const parser = createBoundsParser(COLS, ROWS, label, measure)
  parser.feed(new Uint8Array(raw), new TextDecoder("utf-8"))
  const grid = parser.snapshot()
  for (const v of parser.violations.slice(0, 3)) console.log("VIOLATION:", v)
  for (const v of parser.violations) assert.fail(v)
  assert.ok(raw.length > 1000, `${label}: VT non-trivial`)
  assert.equal(parser.wraps, 0, `${label}: no autowrap`)
  const sidebar = sidebarOf(grid, COLS)
  assert.ok(sidebar.trim().length > 100, `${label}: sidebar content`)
  assert.ok(sidebar.includes("Spotify"), `${label}: header`)
  assert.ok(/[^\x00-\x7f]/.test(sidebar), `${label}: Indic`)
  for (let r = 0; r < ROWS; r++) {
    const expected = `ES ${String(r).padStart(2, "0")} sentinel`
    for (let c = 0; c < expected.length && c < x0; c++) {
      const cell = grid[r]![c]!
      if (cell.text !== " " && cell.text !== "" && cell.text !== expected[c]) assert.fail(`${label}: editor (${r},${c}) got ${JSON.stringify(cell.text)}`)
    }
    for (let c = expected.length; c < x0; c++) {
      const cell = grid[r]![c]!
      if (cell.text !== " " && cell.text !== "") assert.fail(`${label}: editor leak (${r},${c}) ${JSON.stringify(cell.text)}`)
    }
  }
  console.log(`VT bounds ${label}: ${raw.length} bytes wraps=${parser.wraps} clean`)
}

// Parse incremental bytes into per-phase snapshots (persistent) + per-frame checks.
function parseIncremental(raw: Buffer, states: Array<{ name: string; offset: number }>, frameByteOffsets: number[], COLS: number, ROWS: number, label: string) {
  const parser = createAccurateParser(COLS, ROWS, label)
  const dec = new TextDecoder("utf-8")
  const bytes = new Uint8Array(raw)
  const snaps = new Map<string, AccurateCell[][]>()
  let prev = 0
  const sorted = [...states].sort((a, b) => a.offset - b.offset)
  for (const { name, offset } of sorted) {
    const slice = bytes.slice(prev, Math.min(offset, bytes.length))
    if (slice.length) parser.feed(slice, dec)
    snaps.set(name, parser.snapshot())
    prev = Math.min(offset, bytes.length)
  }
  if (prev < bytes.length) parser.feed(bytes.slice(prev), dec)
  // Per-frame: every ?2026 frame + every renderer frame offset must keep editor exact + no overrun.
  const frameParser = createAccurateParser(COLS, ROWS, `${label}-frames`)
  const fdec = new TextDecoder("utf-8")
  const allOffsets = [...new Set([...frameByteOffsets, ...sorted.map((s) => s.offset)])].sort((a, b) => a - b)
  let fprev = 0
  let frameIndex = 0
  for (const off of allOffsets) {
    const sl = bytes.slice(fprev, Math.min(off, bytes.length))
    if (sl.length) frameParser.feed(sl, fdec)
    // Exact per-frame editor check (not just per-phase): any leak in any frame fails.
    const g = frameParser.snapshot()
    try {
      assertEditorExact(g, COLS, ROWS, label, `frame-${frameIndex}`)
    } catch (e) {
      console.log(`per-frame editor leak ${label} frame ${frameIndex} offset ${off}`)
      throw e
    }
    for (const v of frameParser.violations) assert.fail(`${label} frame ${frameIndex}: ${v}`)
    assert.equal(frameParser.wraps, 0, `${label} frame ${frameIndex}: no autowrap`)
    fprev = Math.min(off, bytes.length)
    frameIndex++
  }
  console.log(`per-frame checks ${label}: ${frameIndex} frames, ${parser.frameCount} sync-frames, wraps=${parser.wraps} clean`)
  assert.ok(raw.length > 1000, `${label} accurate non-trivial`)
  assert.equal(parser.wraps, 0, `${label} accurate no autowrap`)
  for (const v of parser.violations) assert.fail(v)
  return snaps
}

function assertLyricRegionEqual(actual: AccurateCell[][], expected: AccurateCell[][], COLS: number, ROWS: number, label: string, phase: string, budget?: number) {
  const region = lyricRegionRows(ROWS, budget)
  assert.ok(region.length > 0, `${label}/${phase}: lyric region non-empty`)
  const x0 = COLS - SIDEBAR_WIDTH
  const diffs: string[] = []
  for (const r of region) {
    for (let c = x0; c < COLS; c++) {
      const a = actual[r]![c]!.text
      const e = expected[r]![c]!.text
      if (a !== e) {
        diffs.push(`r${r}c${c - x0}: actual=${JSON.stringify(a)} expected=${JSON.stringify(e)}`)
        if (diffs.length >= 12) break
      }
    }
    if (diffs.length >= 12) break
  }
  if (diffs.length) {
    const aSide = sidebarOf(actual, COLS)
    const eSide = sidebarOf(expected, COLS)
    assert.fail(`${label}/${phase}: lyric-region cells differ (${region.length} rows bottom ${region[0]}..${region.at(-1)}):\n${diffs.join("\n")}\n---actual sidebar---\n${aSide}\n---expected sidebar---\n${eSide}\n---end---`)
  }
}

// ---------------------------------------------------------------------------
// Main matrices.
// ---------------------------------------------------------------------------
const TAMIL_A = "முந்தைய"       // line0 Tamil
const MALAYALAM = "അവൻ"         // line1 Malayalam unbroken
const TAMIL_B = "தற்போதைய"      // line2 Tamil
const HINDI_SHORT = "यहाँ"      // Hindi line second half, short single-row anchor
const TELUGU = "క్షక్ష"          // Telugu 40x fragment
const MIXED_EMOJI = "👩‍💻 test" // Mixed line tail
const ASCII_OPEN = "Opening line here"
const ASCII_NEXT = "Next vocal line here"
const ASCII_CLOSING = "Closing vocal line here"
const INSTR = "♪ · · ·"
const NO_LYRICS = "No lyrics."
const NOTHING = "Nothing playing"
const SPOTIFY = "Spotify"

const mainPhases: PhaseDef[] = [
  { name: "tamil-tamil-backseek", apply: (s) => ({ ...s, doc: tamilDoc(0), pos: 500 }), present: [TAMIL_A], absentGlobal: [], note: "Tamil→Tamil backwards 17000→500" },
  { name: "tamil-malayalam", apply: (s) => ({ ...s, pos: 9000 }), present: [MALAYALAM], absentGlobal: [], note: "Tamil→Malayalam 500→9000" },
  { name: "malayalam-english", apply: (s) => ({ ...s, doc: asciiDoc, trackUri: uri, pos: 1000 }), present: [ASCII_OPEN], absentGlobal: [TAMIL_A, MALAYALAM, TELUGU], note: "Malayalam→English long-multiline→short-single doc-switch" },
  { name: "english-tamil", apply: (s) => ({ ...s, doc: tamilDoc(0), pos: 500 }), present: [TAMIL_A], absentGlobal: [ASCII_OPEN, ASCII_NEXT], note: "English→Tamil short-single→long-multiline" },
  { name: "tamil-telugu-fwd", apply: (s) => ({ ...s, pos: 33000 }), present: [TELUGU], absentGlobal: [], note: "Tamil→Telugu fwd to multiline conjunct block" },
  { name: "telugu-tamil", apply: (s) => ({ ...s, pos: 41000 }), present: [MIXED_EMOJI], absentGlobal: [], note: "Telugu→Tamil multiline→single long→short (ZWJ kept, Agent A investigating raw VT)" },
  { name: "rapid-tracks", apply: (s) => s, present: [ASCII_OPEN], absentGlobal: [TAMIL_A, TELUGU], note: "rapid tracks B→C (80ms apart)" },
  { name: "pause", apply: (s) => ({ ...s, playing: false }), present: [ASCII_OPEN], absentGlobal: [TAMIL_A], note: "pause" },
  { name: "resume", apply: (s) => ({ ...s, playing: true }), present: [ASCII_OPEN], absentGlobal: [TAMIL_A], note: "resume" },
  { name: "instrumental-gap", apply: (s) => ({ ...s, pos: 15000 }), present: [INSTR], absentGlobal: [TELUGU], note: "English→instrumental historical gap preserves context" },
  { name: "backwards-seek", apply: (s) => ({ ...s, pos: 8500 }), present: [ASCII_NEXT], absentGlobal: [TELUGU], note: "backwards 15000→8500 same doc" },
  { name: "unavailable", apply: (s) => ({ ...s, doc: unavailableDoc, pos: 1000 }), present: [NO_LYRICS], absentGlobal: [ASCII_OPEN, ASCII_NEXT, ASCII_CLOSING, INSTR, TAMIL_A], note: "lyrics→no-lyrics shrink to status" },
  { name: "back-to-tamil", apply: (s) => ({ ...s, doc: tamilDoc(0), pos: 41000 }), present: [MIXED_EMOJI], absentGlobal: [NO_LYRICS, ASCII_OPEN, INSTR], note: "no-lyrics→lyrics English-gap→Tamil (ZWJ kept)" },
  { name: "no-track-clear", apply: (s) => ({ ...s, hasTrack: false, trackUri: null, pos: 41000 }), present: ["Music"], absentGlobal: [TAMIL_A, MALAYALAM, TELUGU, MIXED_EMOJI, ASCII_OPEN, ASCII_NEXT, INSTR, NO_LYRICS], note: "no-track clear vs historical gap: blank lyric region, nav still proves render (title hidden when hasTrack false)" },
  { name: "track-restore", apply: (s) => ({ ...s, hasTrack: true, trackUri: uri, doc: tamilDoc(0), pos: 41000 }), present: [MIXED_EMOJI], absentGlobal: [], note: "track-restore blank→Tamil (ZWJ kept)" },
]

const smallPhases: PhaseDef[] = [
  { name: "malayalam-english", apply: (s) => ({ ...s, doc: asciiDoc, trackUri: uri, pos: 1000 }), present: [ASCII_OPEN], absentGlobal: [TAMIL_A, MALAYALAM], note: "small Malayalam→English shrink" },
  { name: "english-tamil", apply: (s) => ({ ...s, doc: tamilDoc(0), pos: 500 }), present: [TAMIL_A], absentGlobal: [ASCII_OPEN], note: "small English→Tamil" },
  { name: "unavailable", apply: (s) => ({ ...s, doc: unavailableDoc, pos: 1000 }), present: [NO_LYRICS], absentGlobal: [ASCII_OPEN, TAMIL_A], note: "small lyrics→no-lyrics" },
  { name: "back-to-tamil", apply: (s) => ({ ...s, doc: tamilDoc(0), pos: 41000 }), present: [MIXED_EMOJI], absentGlobal: [NO_LYRICS, ASCII_OPEN], note: "small no-lyrics→lyrics" },
]

async function checkIncrementalWithFresh(COLS: number, ROWS: number, label: string, initial: PhaseState, initialAnchor: string, phases: PhaseDef[]) {
  const inc = await runIncremental(COLS, ROWS, label, initial, phases)
  parseBounds(inc.bytes, COLS, ROWS, label, inc.measure)
  const snaps = parseIncremental(inc.bytes, inc.states.map((s) => ({ name: s.name, offset: s.offset })), inc.frameByteOffsets, COLS, ROWS, `${label}-stale`)
  // Anchor widths (independent physical vs baselines) once per geometry.
  for (const s of [TAMIL_A, MALAYALAM, TAMIL_B, TELUGU, MIXED_EMOJI, ASCII_OPEN, INSTR, NO_LYRICS, NOTHING]) {
    const u = measureEditText(s, { widthMethod: "unicode" })
    const w = measureEditText(s, { widthMethod: "wcwidth" })
    console.log(`anchor ${label} ${JSON.stringify(s.slice(0, 10))}: unicode=${u} wcwidth=${w} physical=${physicalTextWidth(s)}`)
  }
  const get = (n: string) => {
    const g = snaps.get(n)
    assert.ok(g, `${label}: missing snapshot ${n}`)
    return g!
  }
  // Collect per-phase failures to evidence every required transition in one RED run (no fail-fast hiding).
  const failures: string[] = []
  const allStates = inc.states
  for (let idx = 0; idx < allStates.length; idx++) {
    const st = allStates[idx]!
    const phaseName = st.name
    try {
      const grid = get(phaseName)
      assertEditorExact(grid, COLS, ROWS, label, phaseName)
      const side = sidebarOf(grid, COLS)
      assert.ok(side.includes(SPOTIFY), `${label}/${phaseName}: header`)
      assert.ok(side.trim().length > 50, `${label}/${phaseName}: non-trivial`)
      const def = phases.find((p) => p.name === phaseName)
      const present: string[] = phaseName === "init" ? [initialAnchor] : (def?.present ?? [])
      const absent: string[] = def?.absentGlobal ?? []
      for (const p of present) assert.ok(side.includes(p), `${label}/${phaseName}: expected CURRENT ${JSON.stringify(p)}\n${side}`)
      for (const a of absent) assert.ok(!side.includes(a), `${label}/${phaseName}: old ${JSON.stringify(a)} must be gone\n${side}`)
      const freshBytes = await renderFresh(COLS, ROWS, st.state)
      const fp = createAccurateParser(COLS, ROWS, `${label}-fresh/${phaseName}`)
      fp.feed(new Uint8Array(freshBytes), new TextDecoder("utf-8"))
      assert.equal(fp.wraps, 0, `${label}/fresh/${phaseName}: no autowrap`)
      for (const v of fp.violations) assert.fail(`${label}/fresh/${phaseName}: ${v}`)
      const freshGrid = fp.snapshot()
      const freshSide = sidebarOf(freshGrid, COLS)
      for (const p of present) assert.ok(freshSide.includes(p), `${label}/fresh/${phaseName}: oracle must contain CURRENT ${JSON.stringify(p)}\n${freshSide}`)
      assertEditorExact(freshGrid, COLS, ROWS, `${label}-fresh`, phaseName)
      assertLyricRegionEqual(grid, freshGrid, COLS, ROWS, label, phaseName, st.state.budget)
      console.log(`stale+fresh ${label}/${phaseName}: anchors ok, lyric-region ${lyricRegionRows(ROWS, st.state.budget).length} rows equal`)
    } catch (e) {
      const msg = e instanceof Error ? e.message.split("\n").slice(0, 30).join("\n") : String(e)
      failures.push(`--- ${label}/${phaseName} FAILED ---\n${msg}`)
      console.log(`stale+fresh ${label}/${phaseName}: FAILED (collected, continuing)\n${msg.split("\n").slice(0, 12).join("\n")}`)
    }
  }
  if (failures.length) {
    assert.fail(`VT stale+fresh ${label}: ${failures.length}/${allStates.length} checkpoints differ (true ghosts/under-draws, not vacuous):\n${failures.join("\n\n")}`)
  }
  console.log(`VT stale+fresh ${label}: all ${allStates.length} checkpoints lyric-region equal, ghosts none`)
}

const initialMain: PhaseState = { doc: tamilDoc(0), pos: 17000, trackUri: uri, playing: true, hasTrack: true }
const topFailures: string[] = []
async function runTop(label: string, fn: () => Promise<void>) {
  try {
    await fn()
    console.log(`TOP ${label}: ok`)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    topFailures.push(`=== ${label} FAILED ===\n${msg.split("\n").slice(0, 60).join("\n")}`)
    console.log(`TOP ${label}: FAILED (collected, continuing to preserve all evidence)`)
  }
}
await runTop("120x40", () => checkIncrementalWithFresh(120, 40, "120x40", initialMain, TAMIL_B, mainPhases));
await runTop("100x40", () => checkIncrementalWithFresh(100, 40, "100x40", initialMain, TAMIL_B, mainPhases));

// Small terminal: natural budget 14 → 3 lyric rows. Subset stresses shrink + no-lyrics at small size.
const initialSmall: PhaseState = { doc: tamilDoc(0), pos: 9000, trackUri: uri, playing: true, hasTrack: true };
await runTop("80x24-small", () => checkIncrementalWithFresh(80, 24, "80x24-small", initialSmall, MALAYALAM, smallPhases));

async function checkTierShrink(COLS: number) {
  const ROWS = 40, label = `${COLS}x40-tier-shrink`
  const tierPhases: PhaseDef[] = [
    { name: "tier-3", apply: (s) => ({ ...s, budget: 14 }), present: tierLines.slice(1, 4), absentGlobal: [tierLines[0]!, tierLines[4]!], note: "5→3 far context must clear" },
    { name: "tier-1", apply: (s) => ({ ...s, budget: 8 }), present: tierLines.slice(2, 3), absentGlobal: tierLines.filter((_, index) => index !== 2), note: "3→1 far context must clear" },
  ]
  const initialTier: PhaseState = { doc: tierDoc, pos: 17000, trackUri: uri, playing: true, hasTrack: true, budget: 26 }
  const inc = await runIncremental(COLS, ROWS, label, initialTier, tierPhases)
  parseBounds(inc.bytes, COLS, ROWS, label, inc.measure)
  const snaps = parseIncremental(inc.bytes, inc.states.map((s) => ({ name: s.name, offset: s.offset })), inc.frameByteOffsets, COLS, ROWS, `${label}-stale`)
  for (const st of inc.states) {
    const grid = snaps.get(st.name)!
    assertEditorExact(grid, COLS, ROWS, label, st.name)
    const side = sidebarOf(grid, COLS)
    const phase = tierPhases.find((item) => item.name === st.name)
    const present = phase?.present ?? tierLines
    const absent = phase?.absentGlobal ?? []
    assert.ok(side.includes(SPOTIFY), `${label}/${st.name}: header`)
    for (const p of present) assert.ok(side.includes(p), `${label}/${st.name}: expected ${JSON.stringify(p)}\n${side}`)
    for (const a of absent) assert.ok(!side.includes(a), `${label}/${st.name}: old ${JSON.stringify(a)} must be gone after 5→3→1\n${side}`)
    const freshBytes = await renderFresh(COLS, ROWS, st.state)
    const fp = createAccurateParser(COLS, ROWS, `${label}-fresh/${st.name}`)
    fp.feed(new Uint8Array(freshBytes), new TextDecoder("utf-8"))
    const freshGrid = fp.snapshot()
    assertEditorExact(freshGrid, COLS, ROWS, `${label}-fresh`, st.name)
    const freshSide = sidebarOf(freshGrid, COLS)
    for (const p of present) assert.ok(freshSide.includes(p), `${label}/fresh/${st.name}: oracle missing ${JSON.stringify(p)}`)
    assertLyricRegionEqual(grid, freshGrid, COLS, ROWS, label, st.name, st.state.budget)
    console.log(`tier ${label}/${st.name}: budget=${st.state.budget} rows equal`)
  }
  console.log(`VT 5→3→1 ${label}: equal`)
}
for (const cols of [120, 100]) await runTop(`${cols}x40-tier-shrink`, () => checkTierShrink(cols))
if (topFailures.length) {
  assert.fail(`VT RED: ${topFailures.length} geometries/phases differ (true incremental vs fresh ghosts, editor exact, no vacuity):\n${topFailures.join("\n\n")}`)
}
console.log("VT emission + stale + tier all hold (or RED above preserves true ghost evidence)")
