// Deliberately small glyph set: eight narrow symbols, no box corners, no icons,
// no Nerd Font codepoints. Narrow terminals fall back to pure ASCII.
//
// The installer shell keeps bracket status markers (`[x]`, `[ ]`) for clarity
// and uses this module for the decorative rule and ellipsis.
import type { Layout } from "./layout.ts"
import type { StatusKind } from "./tokens.ts"

export interface Glyphs {
  ok: string
  warn: string
  error: string
  pending: string
  info: string
  selected: string
  rule: string
  ellipsis: string
}

export const UNICODE_GLYPHS: Glyphs = {
  ok: "\u25CF", // filled circle
  warn: "\u25B2", // triangle up
  error: "\u2715", // multiplication x
  pending: "\u25CB", // hollow circle
  info: "\u00B7", // middle dot
  selected: "\u276F", // heavy right angle quote
  rule: "\u2502", // vertical line
  ellipsis: "\u2026", // horizontal ellipsis
}

export const ASCII_GLYPHS: Glyphs = {
  ok: "*",
  warn: "!",
  error: "x",
  pending: "o",
  info: "-",
  selected: ">",
  rule: "|",
  ellipsis: "...",
}

export const ALLOWED_NON_ASCII = new Set([...Object.values(UNICODE_GLYPHS)])

export function glyphsFor(layout: Layout): Glyphs {
  return layout.ascii ? ASCII_GLYPHS : UNICODE_GLYPHS
}

export function statusGlyph(glyphs: Glyphs, kind: StatusKind): string {
  return glyphs[kind]
}
