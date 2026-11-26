/**
 * Compact responsive layout for the Ink surfaces.
 *
 * - 40 columns: single column, ASCII-only glyphs, details dropped.
 * - 60+ columns: the same geometry, Unicode status glyphs, detail columns.
 * - Content never exceeds `width`; there are no full box frames, side panels
 *   or ASCII art. A single leading rule is the only border.
 */

export const BREAKPOINT = 60
export const MIN_WIDTH = 24
export const MAX_WIDTH = 120
export const SNAPSHOT_WIDTHS = { narrow: 40, wide: 100 } as const

/** Spacing scale. Blank runs are capped at one line to keep panels compact. */
export const SPACING = { inline: 1, gutter: 2, block: 1 } as const
export const MAX_BLANK_RUN = 1

export type Breakpoint = "narrow" | "wide"

export interface Layout {
  width: number
  /** Width available to a body line after the 2-cell gutter. */
  content: number
  breakpoint: Breakpoint
  /** Narrow layouts use the ASCII glyph set. */
  ascii: boolean
  gutter: number
}

export function layoutFor(width: number): Layout {
  if (!Number.isFinite(width)) throw new Error(`width must be finite, got ${width}`)
  const clamped = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.floor(width)))
  const narrow = clamped < BREAKPOINT
  return {
    width: clamped,
    content: clamped - SPACING.gutter,
    breakpoint: narrow ? "narrow" : "wide",
    ascii: narrow,
    gutter: SPACING.gutter,
  }
}
