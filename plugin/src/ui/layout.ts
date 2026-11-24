export type CellMeasure = (text: string) => number
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })
// Terminals measure Unicode cells, but the font shaper can still produce a
// wider glyph for a complex cluster than the Unicode tables predict. Reserve
// four cells for scripts where that is possible: centered text keeps at least
// two on each side, left-aligned text keeps all four on the right.
const shapedScript = /[\p{Mark}\p{Script=Tamil}\p{Script=Malayalam}\p{Script=Telugu}\p{Script=Kannada}\p{Script=Devanagari}\p{Script=Bengali}\p{Script=Gujarati}\p{Script=Gurmukhi}\p{Script=Oriya}\p{Script=Sinhala}\p{Script=Myanmar}\p{Script=Khmer}\p{Script=Thai}\p{Script=Lao}\p{Script=Tibetan}\p{Script=Arabic}\p{Script=Hebrew}\p{Extended_Pictographic}\p{Regional_Indicator}]/u
export function cellSafety(value: string): number {
  return shapedScript.test(value) ? 4 : 0
}
// Some runtimes split Indic conjuncts after a virama/pulli even though the
// terminal shapes them as one cluster. Rejoin those pieces so wrapping cannot
// break a conjunct across rows.
const virama = /[\u094d\u09cd\u0a4d\u0acd\u0b4d\u0bcd\u0c4d\u0ccd\u0d4d\u0dca\u1039\u17d2]$/u
const letterOrMark = /[\p{Letter}\p{Mark}]/u
export const clusters = (value: string) => {
  const joined: string[] = []
  for (const part of Array.from(graphemes.segment(value), (entry) => entry.segment)) {
    const previous = joined.at(-1)
    if (previous && virama.test(previous) && letterOrMark.test(part)) joined[joined.length - 1] = previous + part
    else joined.push(part)
  }
  return joined
}

// Keep joiners/combining marks; remove terminal escapes and directional overrides.
export function displayText(value: string) {
  return value.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/[\u200b\ufeff\u00ad]/g, "")
    .replace(/(^|\n)[\u200c\u200d]+/g, "$1")
    .replace(/(^|\n)(?=\p{Mark})/gu, "$1◌")
}
export function truncateCells(value: string, columns: number, measure: CellMeasure) {
  columns = Math.max(0, Math.floor(columns))
  const clean = displayText(value).replace(/\n/g, " ")
  if (measure(clean) <= columns) return clean
  if (!columns) return ""
  let result = ""
  for (const cluster of clusters(clean)) {
    if (measure(result + cluster + "…") > columns) break
    result += cluster
  }
  return result + (measure("…") <= columns ? "…" : "")
}
export function wrapCells(value: string, columns: number, measure: CellMeasure): string[] {
  columns = Math.max(1, Math.floor(columns))
  const rows: string[] = []
  for (const paragraph of displayText(value).split("\n")) {
    let row = ""
    const flush = () => { rows.push(row.trimEnd()); row = "" }
    for (const word of paragraph.match(/\S+|\s+/gu) ?? []) {
      if (/^\s+$/u.test(word)) { if (row && !row.endsWith(" ")) row += " "; continue }
      // A mark that follows a space has lost its base; protect it with a
      // visible dotted circle instead of letting it attach to the previous cell.
      const safeWord = /^\p{Mark}/u.test(word) ? "◌" + word : word
      if (measure(row + safeWord) <= columns) { row += safeWord; continue }
      if (row) flush()
      if (measure(safeWord) <= columns) { row = safeWord; continue }
      for (let cluster of clusters(safeWord)) {
        // Only combining marks need a base; a zero-width space/joiner is simply
        // invisible and must not be replaced by a dotted circle.
        if (measure(cluster) === 0) {
          if (/\p{Mark}/u.test(cluster)) cluster = "◌" + cluster
          else continue
        }
        // A two-cell grapheme cannot fit in a one-cell viewport. Never split it.
        if (measure(cluster) > columns) cluster = "�"
        if (measure(row + cluster) > columns && row) flush()
        row += cluster
      }
    }
    flush()
  }
  return rows
}
export interface LyricBlock { index: number; top: number; height: number; rows: string[] }
export function lyricLayout(lines: readonly { text: string }[], width: number, measure: CellMeasure, gap = 1,
  safety: (text: string) => number = () => 0): LyricBlock[] {
  let top = 0
  return lines.map((line, index) => {
    const text = line.text || "♪"
    const available = width - safety(text)
    // Never trade the safety margin for one forced cell at a 2-3 column
    // viewport; an empty row is safer than a shaped cluster escaping.
    const rows = available < 1 ? [""] : wrapCells(text, available, measure)
    const block = { index, top, height: rows.length + gap, rows }
    top += block.height
    return block
  })
}
export function followOffset(block: LyricBlock | undefined, viewport: number, total: number) {
  if (!block) return 0
  // Leave room above the line, but never clip its first row on a short screen.
  const inset = Math.min(Math.floor(viewport / 3), Math.max(0, viewport - block.rows.length))
  return Math.max(0, Math.min(Math.max(0, total - viewport), block.top - inset))
}
export interface VisualLyricRow { text: string; index: number; row: number; top: number; gap: boolean }
export function visibleLyricRows(blocks: LyricBlock[], top: number, height: number, overscan = 3): VisualLyricRow[] {
  const from = Math.max(0, Math.floor(top) - overscan), end = Math.ceil(top + height) + overscan
  let low = 0, high = blocks.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (blocks[mid]!.top + blocks[mid]!.height <= from) low = mid + 1
    else high = mid
  }
  const rows: VisualLyricRow[] = []
  for (let i = low; i < blocks.length && blocks[i]!.top < end; i++) {
    const block = blocks[i]!
    for (let row = Math.max(0, from - block.top); row < block.height && block.top + row < end; row++) {
      rows.push({ text: block.rows[row] ?? "", index: i, row, top: block.top + row, gap: row >= block.rows.length })
    }
  }
  return rows
}
