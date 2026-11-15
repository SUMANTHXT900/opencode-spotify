import { createEffect, createMemo, createSignal, Index, on, onCleanup, Show } from "solid-js"
import { createTimeline, getTimelineEngine, TextAttributes, type Timeline, type ColorInput } from "@opentui/core"
import type { MusicProps } from "./Music"
import { selectLyricMoment } from "../services/lyrics"
import { cellMeasure, CellText } from "../ui/primitives"
import { lyricLayout, visibleLyricRows } from "../ui/layout"
import { lyricColors, mix } from "../ui/colors"
import { InstrumentalIndicator } from "./InstrumentalIndicator"

/** A bounded physical-row viewport over a small set of logical lyric lines. */
export function LyricCarousel(props: MusicProps & { width: number; height: number; palette?: { background: ColorInput; text: ColorInput; muted: ColorInput; active: ColorInput } }) {
  const { context } = props
  const colors = createMemo(() => props.palette ?? lyricColors(context.theme.text.base, context.theme.text.action.primary.base, props.settings().accent))
  const moment = createMemo(() => selectLyricMoment(props.lyrics(), props.position(), !!props.state().track, props.lyrics().status === "unavailable" ? props.sources()?.availability.find((source) => source.state === "error")?.detail : undefined))
  const active = () => { const current = moment(); return current.kind === "ready-line" ? current.lineIndex : -1 }
  const height = () => Math.max(1, Math.floor(props.height))
  const width = () => Math.max(1, Math.floor(props.width))
  const blocks = createMemo(() => lyricLayout(props.lyrics().lines, width(), cellMeasure(context.renderer), 0))
  const target = () => {
    const block = blocks()[active()]
    if (!block) return 0
    const total = blocks().at(-1); const end = total ? total.top + total.height : 0
    const inset = Math.min(Math.floor(height() / 2), Math.max(0, height() - block.rows.length))
    return Math.max(0, Math.min(Math.max(0, end - height()), block.top - inset))
  }
  const [top, setTop] = createSignal(0)
  const [emphasis, setEmphasis] = createSignal(1)
  let motion: Timeline | undefined
  let lastPosition: number | undefined
  let positionJump = false
  createEffect(() => {
    const position = props.position()
    positionJump = lastPosition !== undefined && (position < lastPosition || position - lastPosition > 2000)
    lastPosition = position
  })
  const stop = () => { if (motion) { motion.pause(); getTimelineEngine(context.renderer).unregister(motion); motion = undefined } }
  onCleanup(stop)
  createEffect(on(() => [active(), target(), props.lyrics(), width(), height(), props.settings().reducedMotion] as const, (next, previous) => {
    const [index, destination, document, columns, viewportHeight, reduced] = next
    stop()
    const current = top()
    const block = blocks()[index]
    // Animate only an ordinary forward line change on the same document and
    // geometry. Keep the complete active block visible throughout the move.
    const sameLayout = previous && previous[2] === document && previous[3] === columns && previous[4] === viewportHeight
    const fullyVisible = block && block.rows.length <= viewportHeight && block.top >= current && block.top + block.rows.length <= current + viewportHeight
    if (!sameLayout || reduced || positionJump || !props.state().playback.isPlaying || index !== previous[0] + 1 || !fullyVisible || Math.abs(destination - current) > viewportHeight || destination === current) {
      setTop(destination); setEmphasis(1)
    } else {
      const value = { row: current, strength: 0 }
      setEmphasis(0)
      motion = createTimeline({ duration: 220, frameRate: 20, autoplay: false }, context.renderer)
      motion.add(value, { row: destination, strength: 1, duration: 220, ease: "outQuad", onUpdate: () => { setTop(Math.round(value.row)); setEmphasis(value.strength) }, onComplete: () => { stop(); setEmphasis(1) } })
      motion.play()
    }
  }))
  const rows = createMemo(() => visibleLyricRows(blocks(), top(), height(), 0).filter((row) => row.index >= active() - (height() >= 8 ? 3 : 2) && row.index <= active() + 2))
  const status = () => {
    const state = moment()
    switch (state.kind) {
      case "instrumental": return "Music playing"
      case "no-track": return "Play a track to see lyrics."
      case "loading": return "Finding lyrics…"
      case "unsynced": return "Plain lyrics · open Lyrics to read"
      case "source-error": return "Lyrics source error · open Lyrics"
      case "unavailable": return "Lyrics unavailable · open Lyrics"
      default: return ""
    }
  }
  return <box id="spotify-lyric-carousel" width={width()} height={height()} flexShrink={0} flexDirection="column" overflow="hidden">
    <Show when={moment().kind === "ready-line"} fallback={<Show when={moment().kind === "instrumental" && props.settings().instrumental} fallback={<CellText renderer={context.renderer} width={width()} text={status()} fg={colors().muted} />}>
      <InstrumentalIndicator width={width()} height={height()} playing={props.state().connection === "connected" && props.state().playback.isPlaying === true} reducedMotion={props.settings().reducedMotion} foreground={colors().text} muted={colors().muted} />
    </Show>}>
      <Index each={rows()}>{(row) => <text id={`carousel-row-${row().top}`} height={1} width={width()} flexShrink={0} wrapMode="none"
        attributes={row().index === active() && props.settings().strongEmphasis ? TextAttributes.BOLD : 0}
        fg={row().index === active() ? mix(colors().muted, colors().text, (props.settings().strongEmphasis ? 0.6 : 0.45) + (props.settings().strongEmphasis ? 0.4 : 0.35) * emphasis()) : mix(colors().muted, colors().text, Math.max(0, 0.32 - Math.abs(row().index - active()) * 0.1))}>{row().text}</text>}</Index>
    </Show>
  </box>
}
