/**
 * Deliberately small glyph set: eight narrow symbols, no box corners, no
 * icons, no Nerd Font codepoints. Narrow terminals fall back to pure ASCII.
 */

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
  ok: "\u25CF", // ●
  warn: "\u25B2", // ▲
  error: "\u2715", // ✕
  pending: "\u25CB", // ○
  info: "\u00B7", // ·
  selected: "\u276F", // ❯
  rule: "\u2502", // │
  ellipsis: "\u2026", // …
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
