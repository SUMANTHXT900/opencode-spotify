import { parseColor, RGBA, resolveImageRenderProtocol, type ColorInput, type TerminalCapabilities } from "@opentui/core"
import type { RGB } from "../services/artwork"

export function contrast(foreground: RGBA, background: RGBA) {
  const luminance = (color: RGBA) => {
    const c = color.toInts().slice(0, 3).map((n) => n / 255).map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
    return c[0]! * 0.2126 + c[1]! * 0.7152 + c[2]! * 0.0722
  }
  const a = luminance(foreground), b = luminance(background)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}
export function mix(a: ColorInput, b: ColorInput, amount: number) {
  const x = parseColor(a).toInts(), y = parseColor(b).toInts()
  return RGBA.fromInts(...[0, 1, 2].map((i) => Math.round(x[i]! + (y[i]! - x[i]!) * Math.max(0, Math.min(1, amount)))) as [number, number, number])
}
export function lyricColors(base: ColorInput, accent: ColorInput, custom = "") {
  const foreground = parseColor(base)
  const dark = foreground.toInts().slice(0, 3).reduce((a, b) => a + b, 0) > 384
  const background = parseColor(dark ? "#141816" : "#f4f5f0")
  const text = parseColor(dark ? "#f0f3ee" : "#202720")
  const muted = parseColor(dark ? "#a6afa7" : "#566254")
  let active = parseColor(custom || accent)
  if (contrast(active, background) < 4.5) active = text
  return { background, text, muted, active }
}
export function albumColors(base: ColorInput, themeAccent: ColorInput, art: RGB, custom: string) {
  const neutral = lyricColors(base, themeAccent, custom)
  const hue = RGBA.fromInts(...art)
  const background = mix(neutral.background, hue, 0.12)
  let active = custom ? parseColor(custom) : hue
  for (const fraction of [0.25, 0.5, 0.75, 1]) {
    if (contrast(active, background) >= 5) break
    active = mix(active, neutral.text, fraction)
  }
  const muted = mix(neutral.muted, neutral.text, 0.15)
  return { background, text: neutral.text, muted, active }
}
export function graphicsCapabilities(value: TerminalCapabilities | null, hasResolution = false) {
  return { trueColor: value?.rgb === true, kitty: value?.kitty_graphics === true, sixel: value?.sixel === true,
    imageProtocol: resolveImageRenderProtocol("auto", value, hasResolution) }
}
