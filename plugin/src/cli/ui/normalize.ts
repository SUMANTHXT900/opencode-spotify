// Display-width and frame normalization helpers for the Ink surfaces.
//
// Ink-testing-library returns the last rendered frame as a string. Normalize
// away only differences that cannot affect what a user sees: CRLF, trailing
// whitespace and trailing blank lines. Every other property is asserted.
import { MAX_BLANK_RUN } from "./layout.ts"

const ANSI = /\u001B\[[0-?]*[ -/]*[@-~]/g
const CONTROL = /[\u0000-\u0009\u000B-\u001F\u007F]/

export function normalizeFrame(frame: string): string {
  const text = frame.replace(ANSI, "").replace(/\r\n?/g, "\n")
  const lines = text.split("\n").map((line) => line.replace(/[ \t]+$/g, ""))
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
  return lines.join("\n")
}

export function frameLines(frame: string): string[] {
  return frame.split("\n")
}

/* ------------------------------------------------------------------ */
/* Display width                                                      */
/* ------------------------------------------------------------------ */

function isZeroWidth(codePoint: number): boolean {
  return (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x200b && codePoint <= 0x200f) ||
    codePoint === 0xfe0f
  )
}

function isWide(codePoint: number): boolean {
  return (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
      (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd))
  )
}

export function charWidth(char: string): number {
  const codePoint = char.codePointAt(0)
  if (codePoint === undefined || isZeroWidth(codePoint)) return 0
  return isWide(codePoint) ? 2 : 1
}

export function displayWidth(text: string): number {
  let width = 0
  for (const char of text) width += charWidth(char)
  return width
}

export function truncateDisplay(text: string, max: number, ellipsis: string): string {
  if (max <= 0) return ""
  if (displayWidth(text) <= max) return text
  const budget = max - displayWidth(ellipsis)
  if (budget < 1) {
    let head = ""
    for (const char of ellipsis) {
      if (displayWidth(head + char) > max) break
      head += char
    }
    return head
  }
  let head = ""
  let width = 0
  for (const char of text) {
    const next = charWidth(char)
    if (width + next > budget) break
    head += char
    width += next
  }
  return `${head}${ellipsis}`
}

export function padEndDisplay(text: string, width: number): string {
  const gap = width - displayWidth(text)
  return gap > 0 ? `${text}${" ".repeat(gap)}` : text
}

export function fitDisplay(text: string, width: number, ellipsis: string): string {
  return padEndDisplay(truncateDisplay(text, width, ellipsis), width)
}

/**
 * Wrap prose by display cells, preserving explicit newlines. Words longer than
 * a line are hard-wrapped so consent phrases and paths can never disappear.
 */
export function wrapDisplay(text: string, width: number): string[] {
  const limit = Math.max(1, Math.floor(Number.isFinite(width) ? width : 1))
  const lines: string[] = []
  for (const paragraph of text.split("\n")) {
    const line = paragraph.replace(/\r/g, "")
    if (line.length === 0) {
      lines.push("")
      continue
    }
    let current = ""
    const flush = () => {
      if (current.length > 0) {
        lines.push(current)
        current = ""
      }
    }
    for (const word of line.split(" ")) {
      if (word.length === 0) continue
      const candidate = current.length > 0 ? `${current} ${word}` : word
      if (displayWidth(candidate) <= limit) {
        current = candidate
        continue
      }
      flush()
      if (displayWidth(word) <= limit) {
        current = word
        continue
      }
      let chunk = ""
      for (const char of word) {
        const next = `${chunk}${char}`
        if (displayWidth(next) > limit && chunk.length > 0) {
          lines.push(chunk)
          chunk = char
        } else {
          chunk = next
        }
      }
      current = chunk
    }
    lines.push(current)
  }
  return lines
}

/* ------------------------------------------------------------------ */
/* Invariants                                                         */
/* ------------------------------------------------------------------ */

export interface FrameCheck {
  width: number
  ascii?: boolean
  allowedNonAscii?: ReadonlySet<string>
}

/** Returns human-readable problems; empty means the frame is acceptable. */
export function frameProblems(frame: string, check: FrameCheck): string[] {
  const problems: string[] = []
  const lines = frame.split("\n")
  let blankRun = 0

  if (frame.includes("\r")) problems.push("frame contains CR")
  if (frame.endsWith("\n")) problems.push("frame ends with a blank line")
  if (frame.startsWith("\n")) problems.push("frame starts with a blank line")

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    const where = `line ${index + 1}`
    if (CONTROL.test(line)) problems.push(`${where} contains a control character`)
    if (/[ \t]+$/.test(line)) problems.push(`${where} has trailing whitespace`)
    if (line.includes("\t")) problems.push(`${where} contains a tab`)
    const width = displayWidth(line)
    if (width > check.width) problems.push(`${where} is ${width} cells wide (limit ${check.width})`)

    if (line === "") {
      blankRun += 1
      if (blankRun > MAX_BLANK_RUN) problems.push(`${where} exceeds the blank-line cap`)
    } else {
      blankRun = 0
    }

    if (check.ascii) {
      for (const char of line) {
        const codePoint = char.codePointAt(0)!
        if (codePoint < 0x20 || codePoint > 0x7e) {
          problems.push(`${where} is not ASCII (${JSON.stringify(char)})`)
          break
        }
      }
    } else if (check.allowedNonAscii) {
      for (const char of line) {
        const codePoint = char.codePointAt(0)!
        if (codePoint >= 0x20 && codePoint <= 0x7e) continue
        if (!check.allowedNonAscii.has(char)) {
          problems.push(`${where} uses an unapproved glyph (${JSON.stringify(char)})`)
          break
        }
      }
    }
  }
  return problems
}
