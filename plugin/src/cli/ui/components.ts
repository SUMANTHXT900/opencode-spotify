// Minimal Ink primitives for the installer surfaces (lifted from C14).
//
// Visual contract:
// - one bold title line, one accent rule per section, at most one blank line
// - status glyph + neutral word; colour lives in the glyph, not the label
// - selection uses marker + accent, never an inverse/background fill
// - no borders other than the leading rule; no panels-in-panels; no ASCII art
//
// React.createElement is injected so this module never imports ink/react and
// the CLI build does not need JSX or a .tsx file.
import type { Glyphs } from "./glyphs.ts"
import { statusGlyph } from "./glyphs.ts"
import type { Layout } from "./layout.ts"
import { fitDisplay, padEndDisplay, truncateDisplay } from "./normalize.ts"
import type { StatusKind, Theme } from "./tokens.ts"

export interface InkRuntime {
  React: {
    createElement(type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]): unknown
  }
  Box: unknown
  Text: unknown
}

export interface DesignSystemOptions {
  theme: Theme
  layout: Layout
  glyphs: Glyphs
  /** `--no-color`: keep the geometry but omit ANSI styling. Defaults to true. */
  color?: boolean
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
  document(children: unknown[]): unknown
  header(version: string): unknown
  panel(title: string, subtitle?: string): unknown
  blank(): unknown
  body(text: string, tone?: "text" | "muted" | "accent" | "error"): unknown
  status(kind: StatusKind, text: string): unknown
  hint(text: string): unknown
  menu(items: MenuItem[], selected: number): unknown[]
  plan(rows: PlanRow[], options?: PlanOptions): unknown[]
  tokenRow(label: string, hex: string, ratio: string, note?: string): unknown
  noteRow(label: string, text: string): unknown
}

export function createDesignSystem(ink: InkRuntime, options: DesignSystemOptions): DesignSystem {
  const h = ink.React.createElement
  const Box = ink.Box
  const Text = ink.Text
  const { theme, layout, glyphs } = options
  const paint = options.color !== false
  const colorProp = (color: string): Record<string, unknown> => (paint ? { color } : {})
  const textProps = (color: string, bold = false): Record<string, unknown> => ({
    ...colorProp(color),
    ...(paint && bold ? { bold: true } : {}),
    wrap: "truncate",
  })
  let blankIndex = 0

  /** Body payload width: the 2-cell gutter has already been consumed. */
  const bodyWidth = layout.content

  const toneColor = (tone: "text" | "muted" | "accent" | "error"): string => {
    switch (tone) {
      case "muted": return theme.muted
      case "accent": return theme.accent
      case "error": return theme.error
      default: return theme.text
    }
  }

  const line = (key: string | undefined, ...content: unknown[]): unknown =>
    h(Text, { key, wrap: "truncate" }, ...content)

  const indented = (...content: unknown[]): unknown => line(undefined, "  ", ...content)

  const ruleText = (content: string, color: string, bold: boolean, key?: string): unknown =>
    h(Text, { key, wrap: "truncate" },
      h(Text, colorProp(theme.rule), `${glyphs.rule} `),
      h(Text, textProps(color, bold), truncateDisplay(content, bodyWidth - 2, glyphs.ellipsis)))

  return {
    document(children: unknown[]): unknown {
      return h(Box, { flexDirection: "column", width: layout.width }, ...children)
    },

    header(version: string): unknown {
      const title = "OpenCode Spotify"
      const gap = Math.max(1, layout.width - title.length - version.length)
      return h(Box, { flexDirection: "row", width: layout.width, wrap: "truncate" },
        h(Text, textProps(theme.text, true), title),
        h(Text, { wrap: "truncate" },
          " ".repeat(gap),
          h(Text, colorProp(theme.muted), version)))
    },

    panel(title: string, subtitle?: string): unknown {
      const rows = [ruleText(title, theme.text, true, "panel-title")]
      if (subtitle) rows.push(ruleText(subtitle, theme.muted, false, "panel-subtitle"))
      return h(Box, { key: "panel", flexDirection: "column" }, ...rows)
    },

    blank(): unknown {
      // A single space guarantees a rendered row; normalization trims it.
      blankIndex += 1
      return h(Text, { key: `blank-${blankIndex}` }, " ")
    },

    body(text: string, tone = "text"): unknown {
      return indented(h(Text, textProps(toneColor(tone)), truncateDisplay(text, bodyWidth - 2, glyphs.ellipsis)))
    },

    status(kind: StatusKind, text: string): unknown {
      const color = kind === "info" ? theme.muted : theme[kind]
      return indented(
        h(Text, { ...colorProp(color), ...(paint && kind === "error" ? { bold: true } : {}) },
          `${statusGlyph(glyphs, kind)} `),
        h(Text, textProps(theme.text), truncateDisplay(text, bodyWidth - 4, glyphs.ellipsis)))
    },

    hint(text: string): unknown {
      return indented(h(Text, textProps(theme.muted), truncateDisplay(text, bodyWidth - 2, glyphs.ellipsis)))
    },

    menu(items: MenuItem[], selected: number): unknown[] {
      const narrow = layout.breakpoint === "narrow"
      const markerWidth = 2
      const labelWidth = narrow ? Math.max(8, bodyWidth - markerWidth) : 22
      const detailWidth = narrow ? 0 : 30
      return items.map((item, index) => {
        const active = index === selected
        const label = fitDisplay(item.label, labelWidth, glyphs.ellipsis)
        const parts: unknown[] = [
          "  ",
          h(Text, textProps(active ? theme.selected : theme.muted, active), `${active ? glyphs.selected : " "} `),
          h(Text, textProps(active ? theme.selected : theme.text, active), label),
        ]
        if (!narrow && item.detail) {
          parts.push("  ", h(Text, textProps(theme.muted),
            truncateDisplay(item.detail, detailWidth, glyphs.ellipsis)))
        }
        return h(Text, { key: item.label, wrap: "truncate" }, ...parts)
      })
    },

    plan(rows: PlanRow[], planOptions: PlanOptions = {}): unknown[] {
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
        const parts: unknown[] = [
          "  ",
          h(Text, colorProp(theme.muted), padEndDisplay(row.index, indexWidth)),
          " ".repeat(gaps),
          h(Text, textProps(theme.text), fitDisplay(row.label, labelWidth, glyphs.ellipsis)),
        ]
        if (showDetails) {
          parts.push(
            " ".repeat(gaps),
            h(Text, textProps(theme.muted), fitDisplay(row.detail, detailWidth, glyphs.ellipsis)),
          )
        }
        parts.push(
          " ".repeat(gaps),
          h(Text, null,
            h(Text, colorProp(statusColor), `${statusGlyph(glyphs, row.kind)} `),
            h(Text, colorProp(theme.muted), padEndDisplay(row.status, 7))))
        return h(Text, { key: row.index, wrap: "truncate" }, ...parts)
      })
    },

    tokenRow(label: string, hex: string, ratio: string, note?: string): unknown {
      return h(Text, { key: label, wrap: "truncate" },
        "  ",
        h(Text, colorProp(theme.muted), padEndDisplay(label, 11)),
        h(Text, colorProp(hex), padEndDisplay(hex, 9)),
        h(Text, colorProp(theme.text), ratio.padStart(6)),
        note ? h(Text, colorProp(theme.muted), `  ${note}`) : null)
    },

    noteRow(label: string, text: string): unknown {
      return h(Text, { key: label, wrap: "truncate" },
        "  ",
        h(Text, colorProp(theme.muted), padEndDisplay(label, 11)),
        h(Text, colorProp(theme.muted), text))
    },
  }
}
