/**
 * Minimal Ink primitives. No JSX: the fixtures are authored with
 * React.createElement so they run under Node's type stripping and under any
 * React 18/19 + Ink 5/6 host without a build step.
 *
 * Visual contract:
 * - one bold title line, one accent rule per section, at most one blank line
 * - status glyph + neutral word; colour lives in the glyph, not the label
 * - selection uses marker + accent + bold, never an inverse/background fill
 * - no borders other than the leading rule; no panels-in-panels; no ASCII art
 */

import type { Glyphs } from "./glyphs.ts"
import { statusGlyph } from "./glyphs.ts"
import type { Layout } from "./layout.ts"
import { fitDisplay, padEndDisplay, truncateDisplay } from "./normalize.ts"
import type { StatusKind, Theme } from "./tokens.ts"

export interface InkRuntime {
  // Ink/React are injected because the host package may not have them yet.
  React: any
  Box: any
  Text: any
}

export interface DesignSystemOptions {
  theme: Theme
  layout: Layout
  glyphs: Glyphs
}

export interface MenuItem {
  label: string
  detail?: string
}

export interface PlanRow {
  index: string
  label: string
  detail: string
  kind: StatusKind
  status: string
}

export interface PlanOptions {
  showDetails?: boolean
}

export interface DesignSystem {
  document(children: any[]): any
  header(version: string): any
  panel(title: string, subtitle?: string): any
  blank(): any
  body(text: string, tone?: "text" | "muted" | "accent" | "error"): any
  status(kind: StatusKind, text: string): any
  hint(text: string): any
  menu(items: MenuItem[], selected: number): any
  plan(rows: PlanRow[], options?: PlanOptions): any
  tokenRow(label: string, hex: string, ratio: string, note?: string): any
  noteRow(label: string, text: string): any
}

export function createDesignSystem(ink: InkRuntime, options: DesignSystemOptions): DesignSystem {
  const h = ink.React.createElement as (...args: any[]) => any
  const Box = ink.Box
  const Text = ink.Text
  const { theme, layout, glyphs } = options
  const textProps = (color: string, bold = false): Record<string, unknown> => ({ color, bold, wrap: "truncate" })
  let blankIndex = 0

  /** Body payload width: 2-cell gutter already consumed. */
  const bodyWidth = layout.content

  const toneColor = (tone: "text" | "muted" | "accent" | "error"): string => {
    switch (tone) {
      case "muted": return theme.muted
      case "accent": return theme.accent
      case "error": return theme.error
      default: return theme.text
    }
  }

  const line = (key: string | undefined, ...content: any[]): any =>
    h(Text, { key, wrap: "truncate" }, ...content)

  const indented = (...content: any[]): any => line(undefined, "  ", ...content)

  const ruleText = (content: string, color: string, bold: boolean, key?: string): any =>
    h(Text, { key, wrap: "truncate" },
      h(Text, { color: theme.rule }, `${glyphs.rule} `),
      h(Text, { color, bold }, truncateDisplay(content, bodyWidth - 2, glyphs.ellipsis)))

  return {
    document(children: any[]) {
      return h(Box, { flexDirection: "column", width: layout.width }, ...children)
    },

    header(version: string) {
      const title = "OpenCode Spotify"
      const gap = Math.max(1, layout.width - title.length - version.length)
      return h(Box, { flexDirection: "row", width: layout.width, wrap: "truncate" },
        h(Text, { ...textProps(theme.text, true) }, title),
        h(Text, { wrap: "truncate" },
          " ".repeat(gap),
          h(Text, { color: theme.muted }, version)))
    },

    panel(title: string, subtitle?: string) {
      const rows = [ruleText(title, theme.text, true, "panel-title")]
      if (subtitle) rows.push(ruleText(subtitle, theme.muted, false, "panel-subtitle"))
      return h(Box, { key: "panel", flexDirection: "column" }, ...rows)
    },

    blank() {
      // A single space guarantees a rendered row; normalization trims it.
      blankIndex += 1
      return h(Text, { key: `blank-${blankIndex}` }, " ")
    },

    body(text: string, tone = "text") {
      return indented(h(Text, { ...textProps(toneColor(tone)) }, truncateDisplay(text, bodyWidth - 2, glyphs.ellipsis)))
    },

    status(kind: StatusKind, text: string) {
      const color = kind === "info" ? theme.muted : theme[kind]
      return indented(
        h(Text, { color, bold: kind === "error" }, `${statusGlyph(glyphs, kind)} `),
        h(Text, { ...textProps(theme.text) }, truncateDisplay(text, bodyWidth - 4, glyphs.ellipsis)),
      )
    },

    hint(text: string) {
      return indented(h(Text, { ...textProps(theme.muted) }, truncateDisplay(text, bodyWidth - 2, glyphs.ellipsis)))
    },

    menu(items: MenuItem[], selected: number) {
      const narrow = layout.breakpoint === "narrow"
      const markerWidth = 2
      const labelWidth = narrow ? Math.max(8, bodyWidth - markerWidth) : 22
      const detailWidth = narrow ? 0 : 30
      return items.map((item, index) => {
        const active = index === selected
        const label = fitDisplay(item.label, labelWidth, glyphs.ellipsis)
        const parts: any[] = [
          "  ",
          h(Text, { color: active ? theme.selected : theme.muted, bold: active }, `${active ? glyphs.selected : " "} `),
          h(Text, { ...textProps(active ? theme.selected : theme.text, active) }, label),
        ]
        if (!narrow && item.detail) {
          parts.push("  ", h(Text, { ...textProps(theme.muted) },
            truncateDisplay(item.detail, detailWidth, glyphs.ellipsis)))
        }
        return h(Text, { key: item.label, wrap: "truncate" }, ...parts)
      })
    },

    plan(rows: PlanRow[], planOptions: PlanOptions = {}) {
      const narrow = layout.breakpoint === "narrow"
      const indexWidth = 1
      const statusWidth = 9
      const showDetails = planOptions.showDetails ?? !narrow
      const detailWidth = showDetails ? 24 : 0
      const gaps = narrow ? 1 : 2
      const bodyAvail = layout.width - 2
      const reserve = indexWidth + gaps + (showDetails ? detailWidth + gaps : 0) + statusWidth
      const labelWidth = Math.max(8, Math.min(24, bodyAvail - reserve))
      return rows.map((row) => {
        const statusColor = row.kind === "info" ? theme.muted : theme[row.kind]
        const parts: any[] = [
          "  ",
          h(Text, { color: theme.muted }, padEndDisplay(row.index, indexWidth)),
          " ".repeat(gaps),
          h(Text, { ...textProps(theme.text) }, fitDisplay(row.label, labelWidth, glyphs.ellipsis)),
        ]
        if (showDetails) {
          parts.push(
            " ".repeat(gaps),
            h(Text, { ...textProps(theme.muted) }, fitDisplay(row.detail, detailWidth, glyphs.ellipsis)),
          )
        }
        parts.push(
          " ".repeat(gaps),
          h(Text, null,
            h(Text, { color: statusColor }, `${statusGlyph(glyphs, row.kind)} `),
            h(Text, { color: theme.muted }, padEndDisplay(row.status, 7))),
        )
        return h(Text, { key: row.index, wrap: "truncate" }, ...parts)
      })
    },

    tokenRow(label: string, hex: string, ratio: string, note?: string) {
      return h(Text, { key: label, wrap: "truncate" },
        "  ",
        h(Text, { color: theme.muted }, padEndDisplay(label, 11)),
        h(Text, { color: hex }, padEndDisplay(hex, 9)),
        h(Text, { color: theme.text }, ratio.padStart(6)),
        note ? h(Text, { color: theme.muted }, `  ${note}`) : null)
    },

    noteRow(label: string, text: string) {
      return h(Text, { key: label, wrap: "truncate" },
        "  ",
        h(Text, { color: theme.muted }, padEndDisplay(label, 11)),
        h(Text, { color: theme.muted }, text))
    },
  }
}
