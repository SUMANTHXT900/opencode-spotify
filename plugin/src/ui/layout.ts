export type CellMeasure = (text: string) => number
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })
export const clusters = (value: string) => Array.from(graphemes.segment(value), (part) => part.segment)

// Keep joiners/combining marks; remove terminal escapes and directional overrides.
export function displayText(value: string) {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "")
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
      if (measure(row + word) <= columns) { row += word; continue }
      if (row) flush()
      if (measure(word) <= columns) { row = word; continue }
      for (let cluster of clusters(word)) {
        if (measure(cluster) === 0) cluster = "◌" + cluster
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
export function lyricLayout(lines: readonly { text: string }[], width: number, measure: CellMeasure, gap = 1): LyricBlock[] {
  let top = 0
  return lines.map((line, index) => {
    const rows = wrapCells(line.text || "♪", width, measure)
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
