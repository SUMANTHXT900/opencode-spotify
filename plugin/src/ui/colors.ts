import { parseColor, RGBA, resolveImageRenderProtocol, type ColorInput, type TerminalCapabilities } from "@opentui/core"

// V0.5 monochrome system: lyrics and chrome use only the host theme's text
// (white) and muted (dim) tones. The only color in the UI is the true album-art
// image pixels rendered by <image>. Accent hues, album-derived palettes,
// ambient gradients and karaoke fills were removed; see docs/ARCHITECTURE.md.
export function contrast(foreground: RGBA, background: RGBA) {
  const luminance = (color: RGBA) => {
    const c = color.toInts().slice(0, 3).map((n) => n / 255).map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
    return c[0]! * 0.2126 + c[1]! * 0.7152 + c[2]! * 0.0722
  }
  const a = luminance(foreground), b = luminance(background)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}
export function lyricColors(base: ColorInput) {
  const foreground = parseColor(base)
  const dark = foreground.toInts().slice(0, 3).reduce((a, b) => a + b, 0) > 384
  const background = parseColor(dark ? "#141816" : "#f4f5f0")
  const text = parseColor(dark ? "#f0f3ee" : "#202720")
  const muted = parseColor(dark ? "#a6afa7" : "#566254")
  return { background, text, muted }
}
export function graphicsCapabilities(value: TerminalCapabilities | null, hasResolution = false) {
  return { trueColor: value?.rgb === true, kitty: value?.kitty_graphics === true, sixel: value?.sixel === true,
    imageProtocol: resolveImageRenderProtocol("auto", value, hasResolution) }
}
