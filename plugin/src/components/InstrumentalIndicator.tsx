import { createEffect, createSignal, Index, onCleanup } from "solid-js"
import type { ColorInput } from "@opentui/core"

/** A quiet, centered indicator for a known instrumental passage. */
export function InstrumentalIndicator(props: { width: number; height: number; playing: boolean; reducedMotion: boolean; foreground: ColorInput; muted: ColorInput }) {
  const [phase, setPhase] = createSignal(0)
  createEffect(() => {
    if (!props.playing || props.reducedMotion) return
    const timer = setInterval(() => setPhase((value) => (value + 1) % 3), 350)
    onCleanup(() => clearInterval(timer))
  })
  return <box width={Math.max(1, props.width)} height={Math.max(1, props.height)} flexDirection="column" justifyContent="center" alignItems="center" overflow="hidden">
    <text height={1}><Index each={[0, 1, 2]}>{(dot) => <span style={{ fg: props.reducedMotion || phase() === dot() ? props.foreground : props.muted }}>{dot() ? "  ●" : "●"}</span>}</Index></text>
  </box>
}
