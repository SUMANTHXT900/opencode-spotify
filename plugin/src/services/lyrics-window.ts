import { isInstrumentalText, type LyricMoment, type Lyrics } from "./lyrics.ts"
import { lyricLayout, cellSafety, type CellMeasure } from "../ui/layout.ts"

export type LyricWindowKind = "active" | "dim" | "status"
export interface LyricWindowRow {
  text: string
  kind: LyricWindowKind
  lineIndex: number | null
}

const empty = (): LyricWindowRow => ({ text: "", kind: "dim", lineIndex: null })

function vocal(lyrics: Lyrics, index: number) {
  const line = lyrics.lines[index]
  return line && line.text.trim() && !isInstrumentalText(line.text) ? line : undefined
}

function before(lyrics: Lyrics, index: number, count: number) {
  const values: number[] = []
  for (let cursor = index - 1; cursor >= 0 && values.length < count; cursor--) {
    if (vocal(lyrics, cursor)) values.push(cursor)
  }
  return values.reverse()
}

function after(lyrics: Lyrics, index: number, count: number) {
  const values: number[] = []
  for (let cursor = index + 1; cursor < lyrics.lines.length && values.length < count; cursor++) {
    if (vocal(lyrics, cursor)) values.push(cursor)
  }
  return values
}

function timedBefore(lyrics: Lyrics, positionMs: number, count: number) {
  const values: number[] = []
  for (let index = lyrics.lines.length - 1; index >= 0 && values.length < count; index--) {
    const line = lyrics.lines[index]!
    if (line.startMs !== null && line.startMs <= positionMs && vocal(lyrics, index)) values.push(index)
  }
  return values.reverse()
}

function timedAfter(lyrics: Lyrics, positionMs: number, count: number) {
  const values: number[] = []
  for (let index = 0; index < lyrics.lines.length && values.length < count; index++) {
    const line = lyrics.lines[index]!
    if (line.startMs !== null && line.startMs > positionMs && vocal(lyrics, index)) values.push(index)
  }
  return values
}

// Timed providers can interleave marker or untimed lines out of array order.
// Find neighbours by the same timestamps `selectLyricMoment` uses.
function prior(lyrics: Lyrics, current: number, count: number) {
  const anchor = lyrics.lines[current]?.startMs
  if (anchor === null || anchor === undefined) return before(lyrics, current, count)
  return lyrics.lines.flatMap((candidate, index) => candidate.startMs !== null && candidate.startMs < anchor &&
    vocal(lyrics, index) ? [{ index, startMs: candidate.startMs }] : [])
    .sort((a, b) => a.startMs - b.startMs).slice(-count).map((entry) => entry.index)
}

function following(lyrics: Lyrics, current: number, count: number) {
  const anchor = lyrics.lines[current]?.startMs
  if (anchor === null || anchor === undefined) return after(lyrics, current, count)
  return lyrics.lines.flatMap((candidate, index) => candidate.startMs !== null && candidate.startMs > anchor &&
    vocal(lyrics, index) ? [{ index, startMs: candidate.startMs }] : [])
    .sort((a, b) => a.startMs - b.startMs).slice(0, count).map((entry) => entry.index)
}

function status(text: string, rows: number): LyricWindowRow[] {
  const value = Array.from({ length: rows }, empty)
  if (text) value[Math.floor(rows / 2)] = { text, kind: "status", lineIndex: null }
  return value
}

/**
 * Build a fixed-size lyric window centered on the current moment. The active
 * row is always the middle row for synced content; the surrounding rows are
 * nearest vocal lines, so provider marker lines never occupy a slot.
 */
export function lyricWindow(lyrics: Lyrics, moment: LyricMoment, rows: number, positionMs: number): LyricWindowRow[] {
  const count = Math.max(1, Math.floor(rows))
  const center = Math.floor(count / 2)
  if (moment.kind === "no-track") return status("", count)
  if (moment.kind === "loading") return status("Finding lyrics…", count)
  if (moment.kind === "unavailable") return status("No lyrics. Open Lyrics.", count)
  if (moment.kind === "source-error") return status(moment.message || "Lyrics unavailable", count)

  const values = Array.from({ length: count }, empty)
  if (moment.kind === "instrumental") {
    const previous = timedBefore(lyrics, positionMs, center)
    const upcoming = timedAfter(lyrics, positionMs, count - center - 1)
    previous.forEach((index, offset) => {
      const target = center - previous.length + offset
      if (target >= 0) values[target] = { text: lyrics.lines[index]!.text, kind: "dim", lineIndex: index }
    })
    values[center] = { text: "♪ · · ·", kind: "status", lineIndex: null }
    upcoming.forEach((index, offset) => {
      const target = center + 1 + offset
      if (target < count) values[target] = { text: lyrics.lines[index]!.text, kind: "dim", lineIndex: index }
    })
    return values
  }

  if (moment.kind === "unsynced") {
    const first = lyrics.lines.findIndex((line) => line.text.trim() && !isInstrumentalText(line.text))
    if (first < 0) return status("No lyrics. Open Lyrics.", count)
    values[center] = { text: lyrics.lines[first]!.text, kind: "active", lineIndex: first }
    after(lyrics, first, count - center - 1).forEach((index, offset) => {
      values[center + 1 + offset] = { text: lyrics.lines[index]!.text, kind: "dim", lineIndex: index }
    })
    return values
  }

  const current = moment.lineIndex
  if (!vocal(lyrics, current)) {
    const next = after(lyrics, current, count - center - 1)
    values[center] = { text: "♪ · · ·", kind: "status", lineIndex: null }
    next.forEach((index, offset) => {
      values[center + 1 + offset] = { text: lyrics.lines[index]!.text, kind: "dim", lineIndex: index }
    })
    return values
  }
  const previous = prior(lyrics, current, center)
  const upcoming = following(lyrics, current, count - center - 1)
  previous.forEach((index, offset) => {
    const target = center - previous.length + offset
    if (target >= 0) values[target] = { text: lyrics.lines[index]!.text, kind: "dim", lineIndex: index }
  })
  values[center] = { text: lyrics.lines[current]!.text, kind: "active", lineIndex: current }
  upcoming.forEach((index, offset) => {
    values[center + 1 + offset] = { text: lyrics.lines[index]!.text, kind: "dim", lineIndex: index }
  })
  return values
}

// ---------------------------------------------------------------------------
// Multiline block rendering (V0.5.5). The semantic window above stays fixed at
// 5/3/1 slots with the active line centered. Each semantic line then wraps to
// its own physical rows; the block distributes a fixed physical budget across
// them so the player never bounces when wrapped heights change.
// ---------------------------------------------------------------------------

export interface WrappedLyricLine {
  text: string
  kind: LyricWindowKind
  lineIndex: number | null
  /** Physical terminal rows after grapheme-safe wrapping. Blank for empty. */
  rows: string[]
}

/**
 * Wrap every semantic slot to physical rows with the same width arithmetic
 * `CellText` uses (width minus the shaped-script reserve), so the render path
 * can never disagree with the plan. Never splits grapheme clusters; an
 * over-wide cluster degrades to the replacement path inside `wrapCells`.
 */
export function wrapLyricLines(
  rows: LyricWindowRow[],
  columns: number,
  measure: CellMeasure,
): WrappedLyricLine[] {
  const width = Math.max(1, Math.floor(columns))
  return rows.map((row) => {
    if (!row.text.trim()) return { ...row, rows: [""] }
    const blocks = lyricLayout([{ text: row.text }], width, measure, 0, cellSafety)
    const physical = blocks[0]?.rows ?? [""]
    return { ...row, rows: physical.length ? physical : [""] }
  })
}

export interface DistributedLyricLine {
  kind: LyricWindowKind
  lineIndex: number | null
  rows: string[]
  /** True when tail physical rows of a dim line were dropped for budget. */
  truncated: boolean
}

export interface DistributedLyricBlock {
  /** Visible semantic lines in order (blanks skipped, far lines dropped). */
  lines: DistributedLyricLine[]
  /** Blank rows above/below to keep the focus line vertically centered. */
  padTop: number
  padBottom: number
  /** True when even the focus line alone exceeds the budget: use a viewport. */
  activeOverflow: boolean
  /** Cumulative physical rows above the focus line in `fullLines`. */
  focusTop: number
  /** Every non-blank wrapped line in order (scroll fallback content). */
  fullLines: WrappedLyricLine[]
  /** Fixed block height; always equals the physical budget (no bounce). */
  height: number
}

/**
 * Distribute a fixed physical budget across wrapped semantic lines. The focus
 * line (active, else the status/unsynced line) is never truncated: art and
 * context lines are reduced first by the tier planner, then far dim lines are
 * dropped, then dim tail rows are cut. Only when the focus line alone exceeds
 * the budget does `activeOverflow` request the bounded scroll fallback.
 */
export function distributeLyricRows(
  wrapped: WrappedLyricLine[],
  budget: number,
): DistributedLyricBlock {
  const cap = Math.max(1, Math.floor(budget))
  const fullLines = wrapped.filter((line) => line.text.trim())
  let focus = fullLines.findIndex((line) => line.kind === "active")
  if (focus < 0) focus = fullLines.length > 0 ? Math.floor(fullLines.length / 2) : 0
  const focusTop = fullLines.slice(0, focus).reduce((sum, line) => sum + line.rows.length, 0)
  const focusLine = fullLines[focus]
  if (!focusLine) {
    return { lines: [], padTop: 0, padBottom: 0, activeOverflow: false, focusTop: 0, fullLines, height: cap }
  }
  if (focusLine.rows.length > cap) {
    return { lines: [], padTop: 0, padBottom: 0, activeOverflow: true, focusTop, fullLines, height: cap }
  }
  // Context by proximity, alternating sides to preserve visual centering.
  const order: number[] = []
  for (let distance = 1; distance < fullLines.length; distance++) {
    if (focus - distance >= 0) order.push(focus - distance)
    if (focus + distance < fullLines.length) order.push(focus + distance)
  }
  const take = new Map<number, string[]>()
  const cut = new Set<number>()
  take.set(focus, focusLine.rows)
  let remaining = cap - focusLine.rows.length
  for (const index of order) {
    if (remaining <= 0) break
    const need = fullLines[index]!.rows.length
    if (need <= 0) continue
    const give = Math.min(need, remaining)
    take.set(index, fullLines[index]!.rows.slice(0, give))
    if (give < need) cut.add(index)
    remaining -= give
  }
  const slotOrder = [...take.keys()].sort((a, b) => a - b)
  const focusAt = slotOrder.indexOf(focus)
  const lines = slotOrder.map((index) => ({
    kind: fullLines[index]!.kind,
    lineIndex: fullLines[index]!.lineIndex,
    rows: take.get(index)!,
    truncated: cut.has(index),
  }))
  const above = lines.slice(0, focusAt).reduce((sum, line) => sum + line.rows.length, 0)
  const below = lines.slice(focusAt + 1).reduce((sum, line) => sum + line.rows.length, 0)
  const used = above + focusLine.rows.length + below
  const extra = Math.max(0, cap - used)
  const padTop = Math.max(0, Math.min(extra, Math.floor((extra + (below - above)) / 2)))
  return { lines, padTop, padBottom: extra - padTop, activeOverflow: false, focusTop, fullLines, height: cap }
}
