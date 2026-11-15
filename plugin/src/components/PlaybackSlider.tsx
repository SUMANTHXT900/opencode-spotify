import { createEffect, createSignal, onCleanup, onMount } from "solid-js"
import type { BoxRenderable, CliRenderer, ColorInput } from "@opentui/core"
import { CellText } from "../ui/primitives"
import { clampSlider, sliderText, sliderValueAt } from "../ui/slider"

export interface PlaybackSliderHandle {
  adjust: (delta: number) => void
  start: () => void
  end: () => void
  cancel: () => void
}
export interface PlaybackSliderProps {
  id: string; renderer: CliRenderer; width: number; value: number; max: number
  disabled?: boolean; focused?: boolean; identity?: unknown; snapshot?: unknown
  playing?: boolean; visible?: boolean; reducedMotion?: boolean
  foreground: ColorInput; muted: ColorInput; accent: ColorInput
  onFocus?: () => void
  onPreview?: (value: number | undefined) => void
  onCommit: (value: number) => Promise<boolean | void> | boolean | void
  ref?: (handle: PlaybackSliderHandle) => void
}
/** A controlled terminal slider. The renderer captures native drags until release. */
export function PlaybackSlider(props: PlaybackSliderProps) {
  let track: BoxRenderable | undefined
  const [hover, setHover] = createSignal(false)
  const [dragging, setDragging] = createSignal(false)
  const [preview, updatePreview] = createSignal<number | undefined>()
  const setPreview = (value: number | undefined) => { updatePreview(value); props.onPreview?.(value) }
  let generation = 0, awaitingSnapshot = false, disposed = false
  let committedSnapshot: unknown
  let settle: ReturnType<typeof setTimeout> | undefined
  let previousIdentity = props.identity, previousWidth = props.width
  const cancel = () => {
    generation++
    clearTimeout(settle)
    setDragging(false)
    setPreview(undefined)
    awaitingSnapshot = false
  }
  const enabled = () => !props.disabled && Number.isFinite(props.max) && props.max > 0
  const value = () => clampSlider(preview() ?? props.value, props.max)
  const commit = async (next: number) => {
    if (!enabled()) return
    const target = clampSlider(next, props.max), request = ++generation
    const sentSnapshot = props.snapshot
    clearTimeout(settle)
    setPreview(target); awaitingSnapshot = false
    try {
      const result = await props.onCommit(target)
      if (disposed || request !== generation) return
      if (result === false) { setPreview(undefined); return }
      committedSnapshot = sentSnapshot
      awaitingSnapshot = props.snapshot !== undefined && props.snapshot === sentSnapshot
      if (!awaitingSnapshot) setPreview(undefined)
      else settle = setTimeout(() => cancel(), 1800)
    } catch { if (!disposed && request === generation) setPreview(undefined) }
  }
  const at = (x: number) => track ? sliderValueAt(x, track.x, track.width, props.max) : 0
  const handle: PlaybackSliderHandle = {
    adjust: (delta) => { if (enabled()) void commit(value() + delta) },
    start: () => { if (enabled()) void commit(0) }, end: () => { if (enabled()) void commit(props.max) }, cancel,
  }
  props.ref?.(handle)
  createEffect(() => {
    const identity = props.identity, width = props.width, disabled = props.disabled
    if (identity !== previousIdentity || width !== previousWidth || disabled) cancel()
    previousIdentity = identity; previousWidth = width
  })
  createEffect(() => {
    const snapshot = props.snapshot
    if (awaitingSnapshot && snapshot !== committedSnapshot) cancel()
  })
  onMount(() => {
    const resize = () => cancel()
    props.renderer.on("resize", resize)
    onCleanup(() => props.renderer.off("resize", resize))
  })
  onCleanup(() => { disposed = true; cancel() })
  return <box id={props.id} ref={(box) => { track = box }} width={Math.max(1, props.width)} height={1} flexShrink={0}
    onMouseOver={() => setHover(true)} onMouseOut={() => setHover(false)}
    onMouseDown={(event) => {
      if (!enabled() || event.button !== 0) return
      event.stopPropagation()
      clearTimeout(settle)
      awaitingSnapshot = false
      generation++
      props.onFocus?.()
      setDragging(true)
      setPreview(at(event.x))
    }}
    onMouseDrag={(event) => { if (dragging()) { event.stopPropagation(); setPreview(at(event.x)) } }}
    onMouseDragEnd={(event) => { if (dragging()) { event.stopPropagation(); setDragging(false); void commit(at(event.x)) } }}
    onMouseUp={(event) => { if (dragging()) { event.stopPropagation(); setDragging(false); void commit(at(event.x)) } }}>
    <CellText renderer={props.renderer} width={Math.max(1, props.width)} selectable={false}
      text={sliderText(value(), props.max, Math.max(1, props.width), !!props.focused || hover() || dragging(),
        props.playing && props.visible !== false && !props.reducedMotion && !dragging() && value() < props.max ? value() : undefined)}
      fg={!enabled() ? props.muted : props.focused || hover() || dragging() ? props.accent : props.foreground}
      bold={!!props.focused || hover() || dragging()} />
  </box>
}
