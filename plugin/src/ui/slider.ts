export function clampSlider(value: number, max: number) {
  return Number.isFinite(value) && Number.isFinite(max) && max > 0 ? Math.max(0, Math.min(max, value)) : 0
}
export function sliderValueAt(x: number, left: number, width: number, max: number) {
  if (!Number.isFinite(x) || !Number.isFinite(left) || !Number.isFinite(width) || width <= 1) return 0
  return clampSlider((x - left) / (width - 1) * max, max)
}
export function sliderText(value: number, max: number, width: number, emphasis: boolean, flowPosition?: number) {
  const size = Math.max(0, Math.floor(width))
  if (!size) return ""
  const thumb = max > 0 ? Math.round(clampSlider(value, max) / max * (size - 1)) : 0
  const flow = flowPosition === undefined || thumb < 2 ? -1 : Math.floor(flowPosition / 500) % thumb
  return Array.from({ length: size }, (_, i) => i === thumb ? (emphasis ? "●" : "•") : i < thumb ? (i === flow ? "╸" : "━") : "─").join("")
}
