/**
 * C14 design tokens for the Ink surfaces.
 *
 * Rules enforced by tests/cli-ink-snapshot.test.ts:
 * - Spotify green is the only accent hue; everything else is neutral chrome.
 * - No background token exists. The terminal background is never painted, so
 *   both palettes are readable on their assumed backgrounds and the user's
 *   terminal stays in charge of the canvas.
 * - Text-bearing tokens meet WCAG AA (>= 4.5:1) against the assumed
 *   background. `rule` is decorative only.
 */

export type ThemeMode = "dark" | "light"

export type StatusKind = "ok" | "warn" | "error" | "pending" | "info"

export interface Theme {
  mode: ThemeMode
  /** Brand/Spotify green. Focus rings and selected rows use `selected`. */
  accent: string
  /** Selected menu row. Slightly brighter than `accent` on dark. */
  selected: string
  text: string
  muted: string
  /** Decorative leading rule only; never used for text. */
  rule: string
  ok: string
  warn: string
  error: string
  pending: string
}

/**
 * Backgrounds used only for contrast maths, not for painting. A terminal user
 * may run any background; the palettes are chosen to stay legible on the two
 * common poles and the UI never fills cells.
 */
export const ASSUMED_BACKGROUND: Record<ThemeMode, string> = {
  dark: "#0E1116",
  light: "#F7F8F4",
}

export const THEMES: Record<ThemeMode, Theme> = {
  dark: {
    mode: "dark",
    accent: "#1DB954",
    selected: "#1ED760",
    text: "#E6EDF3",
    muted: "#9AA4AE",
    rule: "#30363D",
    ok: "#1DB954",
    warn: "#E3B341",
    error: "#F85149",
    pending: "#8B949E",
  },
  light: {
    mode: "light",
    accent: "#0B7A33",
    selected: "#0B7A33",
    text: "#1F2328",
    muted: "#5A6355",
    rule: "#D0D7DE",
    ok: "#0B7A33",
    warn: "#7A4E00",
    error: "#B42318",
    pending: "#5B6570",
  },
}

/** Tokens that carry text or iconography and must clear AA contrast. */
export type ThemeColorKey = Exclude<keyof Theme, "mode">

export const CONTRAST_CRITICAL: ReadonlyArray<ThemeColorKey> = [
  "accent",
  "selected",
  "text",
  "muted",
  "ok",
  "warn",
  "error",
  "pending",
]

export const DECORATIVE_TOKENS: ReadonlyArray<ThemeColorKey> = ["rule"]

/** The design system must never grow a background token. */
export const FORBIDDEN_TOKEN = /background|bg/i

export function themeFor(mode: ThemeMode): Theme {
  return THEMES[mode]
}

export function themeModes(): ThemeMode[] {
  return ["dark", "light"]
}

function channels(hex: string): [number, number, number] {
  const value = hex.trim().replace(/^#/, "")
  if (!/^[0-9a-fA-F]{6}$/.test(value)) throw new Error(`invalid hex color: ${hex}`)
  return [
    Number.parseInt(value.slice(0, 2), 16) / 255,
    Number.parseInt(value.slice(2, 4), 16) / 255,
    Number.parseInt(value.slice(4, 6), 16) / 255,
  ]
}

export function relativeLuminance(hex: string): number {
  const linear = channels(hex).map((value) =>
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
  )
  return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722
}

export function contrastRatio(foreground: string, background: string): number {
  const a = relativeLuminance(foreground)
  const b = relativeLuminance(background)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

export function contrastLabel(foreground: string, background: string): string {
  return `${contrastRatio(foreground, background).toFixed(2)}:1`
}
