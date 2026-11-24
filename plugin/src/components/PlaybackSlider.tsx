import { createEffect, createSignal, on, onCleanup, onMount } from "solid-js"
import type { BoxRenderable, CliRenderer, ColorInput } from "@opentui/core"
import { CellText } from "../ui/primitives"
import { clampSlider, sliderText, sliderValueAt } from "../ui/slider"

export interface PlaybackSliderHandle {
  cancel: () => void
}
export interface PlaybackSliderProps {
  id: string; renderer: CliRenderer; width: number; value: number; max: number
  disabled?: boolean; identity?: unknown; snapshot?: unknown
  foreground: ColorInput; muted: ColorInput; accent: ColorInput
  /** Coalesced live commits during a drag, in milliseconds. Omit for commit-on-release only (seek). */
  liveCommitMs?: number
  onPreview?: (value: number | undefined) => void
  onDraggingChange?: (dragging: boolean) => void
  onCommit: (value: number) => Promise<boolean | void> | boolean | void
  ref?: (handle: PlaybackSliderHandle) => void
}
/** A controlled terminal slider. Pointer down starts a drag; every drag event
 * refreshes the visible thumb immediately. Release commits once (seek); a
 * liveCommitMs prop additionally sends coalesced commits while dragging
 * (volume) with a mandatory final commit on release. */
export function PlaybackSlider(props: PlaybackSliderProps) {
  let track: BoxRenderable | undefined
  const [hover, setHover] = createSignal(false)
  const [dragging, setDragging] = createSignal(false)
  const [preview, updatePreview] = createSignal<number | undefined>()
  const setPreview = (value: number | undefined) => { updatePreview(value); props.onPreview?.(value) }
  let generation = 0, awaitingSnapshot = false, disposed = false
  let committedSnapshot: unknown
  let settle: ReturnType<typeof setTimeout> | undefined
  let lastLive = 0
  let previousIdentity = props.identity, previousWidth = props.width
  const cancel = () => {
    generation++
    clearTimeout(settle)
    setDragging(false)
    props.onDraggingChange?.(false)
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
      if (disposed || request !== generation || dragging()) return
      if (result === false) {
        // Dropped or rejected commit: keep the optimistic preview until the
        // next authoritative snapshot or a bounded timeout, never snap back
        // to a stale estimate. Failures surface through the run toast.
        awaitingSnapshot = false
        clearTimeout(settle)
        settle = setTimeout(() => cancel(), 1800)
        return
      }
      committedSnapshot = sentSnapshot
      awaitingSnapshot = props.snapshot !== undefined && props.snapshot === sentSnapshot
      if (!awaitingSnapshot) setPreview(undefined)
      else settle = setTimeout(() => cancel(), 1800)
    } catch {
      if (disposed || request !== generation || dragging()) return
      // Keep the optimistic preview through a transport failure; the caller
      // already surfaces the error, and the next snapshot can correct it.
      awaitingSnapshot = false
      clearTimeout(settle)
      settle = setTimeout(() => cancel(), 1800)
    }
  }
  const at = (x: number) => track ? sliderValueAt(x, track.x, track.width, props.max) : 0
  const live = (next: number) => {
    if (props.liveCommitMs === undefined || !enabled()) return
    const now = performance.now()
    if (now - lastLive >= props.liveCommitMs) { lastLive = now; void commit(next) }
  }
  const begin = (x: number) => {
    if (!enabled()) return
    generation++
    clearTimeout(settle)
    awaitingSnapshot = false
    lastLive = 0
    setDragging(true)
    props.onDraggingChange?.(true)
    setPreview(at(x))
  }
  const move = (x: number) => {
    if (!dragging() || !enabled() || !Number.isFinite(x)) return
    const next = at(x)
    setPreview(next)
    live(next)
  }
  const finish = (x: number) => {
    if (!dragging()) return
    setDragging(false)
    props.onDraggingChange?.(false)
    // A synthesized drag-end can arrive without coordinates; fall back to the
    // last visible preview instead of seeking to zero.
    const next = track && Number.isFinite(x) ? at(x) : preview()
    if (next === undefined) { setPreview(undefined); return }
    void commit(next)
  }
  const handle: PlaybackSliderHandle = {
    cancel,
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
  // If an external authoritative value changes while an optimistic preview is
  // still on screen, drop the stale preview so the thumb follows the server.
  createEffect(on(() => props.value, (value) => {
    const current = preview()
    if (!dragging() && current !== undefined && Math.abs(clampSlider(value, props.max) - current) > 1e-6) cancel()
  }))
  onMount(() => {
    const resize = () => cancel()
    props.renderer.on("resize", resize)
    onCleanup(() => props.renderer.off("resize", resize))
  })
  onCleanup(() => { disposed = true; cancel() })
  return <box id={props.id} ref={(box) => { track = box }} width={Math.max(1, props.width)} height={1} flexShrink={0}
    onMouseOver={() => setHover(true)} onMouseOut={() => setHover(false)}
    onMouseDown={(event) => {
      if (event.button !== 0) return
      event.preventDefault()
      event.stopPropagation()
      if (enabled()) begin(event.x)
    }}
    onMouseDrag={(event) => { if (dragging()) { event.stopPropagation(); move(event.x) } }}
    onMouseDragEnd={(event) => { if (dragging()) { event.stopPropagation(); finish(event.x) } }}
    onMouseUp={(event) => { if (dragging()) { event.stopPropagation(); finish(event.x) } }}>
    <CellText renderer={props.renderer} width={Math.max(1, props.width)} selectable={false}
      text={sliderText(value(), props.max, Math.max(1, props.width), hover() || dragging())}
      fg={!enabled() ? props.muted : hover() || dragging() ? props.accent : props.foreground}
      bold={hover() || dragging()} />
  </box>
}
