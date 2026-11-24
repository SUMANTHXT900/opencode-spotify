import { createEffect, createMemo, createSignal, Index, on, onCleanup, onMount, Show } from "solid-js"
import { createTimeline, getTimelineEngine, TextAttributes, type ScrollBoxRenderable, type Timeline } from "@opentui/core"
import type { MusicProps } from "./Music"
import { followLineIndex, isInstrumentalText, selectLyricMoment } from "../services/lyrics"
import { InstrumentalIndicator } from "./InstrumentalIndicator"
import { CellText, Control, cellMeasure, terminalSize, useDimensions } from "../ui/primitives"
import { cellSafety, followOffset, lyricLayout, visibleLyricRows } from "../ui/layout"
import { lyricColors } from "../ui/colors"

// V0.5 immersive lyrics: monochrome type only. The active line is bold white;
// every other line is dim. No accent fills, karaoke word colors, warm mixes or
// distance gradients. Art, when shown, is owned by the panel, never a tint.
export function LyricsView(props: MusicProps & { settingsAction: () => void; height?: number; chrome?: "full" | "panel" }) {
  const { context } = props
  const dimensions = useDimensions()
  const terminal = terminalSize(context.renderer)
  const height = () => props.height ?? Math.max(1, Math.min(36, terminal().height - 8))
  const fullChrome = () => props.chrome !== "panel"
  let scroll: ScrollBoxRenderable | undefined
  let motion: Timeline | undefined
  let disposed = false, generation = 0
  const [follow, setFollow] = createSignal(props.settings().follow)
  const [top, setTop] = createSignal(0)
  const [viewport, setViewport] = createSignal({ width: 1, height: 1 })
  const colors = createMemo(() => lyricColors(context.theme.text.base))
  const text = () => context.theme.text.base
  const muted = () => context.theme.text.muted
  const moment = createMemo(() => selectLyricMoment(props.lyrics(), props.position(), !!props.state().track, props.lyrics().status === "unavailable" ? props.sources()?.availability.find((source) => source.state === "error")?.detail : undefined))
  const active = createMemo(() => { const value = moment(); return value.kind === "ready-line" ? value.lineIndex : -1 })
  const target = createMemo(() => followLineIndex(props.lyrics(), props.position(), !!props.state().track))
  const instrumental = () => moment().kind === "instrumental" && follow() && props.settings().instrumental
  // The two-cell active marker is dropped on very narrow viewports so the
  // prefix can never make a row wider than its clipped container.
  const gutter = () => viewport().width >= 6 ? 2 : 0
  const width = () => Math.max(1, viewport().width - 1 - gutter())
  const blocks = createMemo(() => lyricLayout(props.lyrics().lines.map((line) =>
    isInstrumentalText(line.text) ? { ...line, text: "" } : line), width(), cellMeasure(context.renderer), 1, cellSafety))
  const total = () => { const last = blocks().at(-1); return last ? last.top + last.height : 0 }
  const visible = createMemo(() => visibleLyricRows(blocks(), top(), viewport().height))
  const stop = () => {
    generation++
    if (motion) {
      motion.pause()
      if (!context.renderer.isDestroyed) getTimelineEngine(context.renderer).unregister(motion)
      motion = undefined
    }
  }
  const manual = () => { stop(); setFollow(false) }
  const resume = () => {
    stop(); setFollow(true)
    scroll?.scrollTo(followOffset(blocks()[target()], viewport().height, total()))
  }
  const sync = () => {
    if (!scroll || disposed) return
    const old = blocks().findLast((block) => block.top <= scroll!.scrollTop)
    const relative = old ? scroll.scrollTop - old.top : 0
    const next = { width: Math.max(1, scroll.viewport.width), height: Math.max(1, scroll.viewport.height) }
    if (next.width !== viewport().width || next.height !== viewport().height) {
      setViewport(next)
      if (!follow() && old) scroll.scrollTo((blocks()[old.index]?.top ?? 0) + relative)
    }
    setTop(Math.floor(scroll.scrollTop))
  }
  onMount(() => {
    // ScrollBox offsets are reported by the bar's change event; viewport only
    // emits resize. Both are needed so wrapped virtual rows track wheel/drag input.
    scroll?.verticalScrollBar.on("change", sync)
    scroll?.viewport.on("resize", sync)
    scroll?.afterLayout(sync)
  })
  onCleanup(() => {
    disposed = true; stop()
    scroll?.verticalScrollBar.off("change", sync)
    scroll?.viewport.off("resize", sync)
  })
  createEffect(on(() => props.settings().follow, (value) => { stop(); setFollow(value) }))
  createEffect(on(() => props.lyrics().uri, () => { stop(); setFollow(props.settings().follow); scroll?.scrollTo(0) }))
  createEffect(() => {
    const index = target(), layout = blocks(), box = viewport(), following = follow(), reduce = props.settings().reducedMotion
    if (!following || !scroll || index < 0) return
    stop()
    const ticket = generation
    const destination = followOffset(layout[index], box.height, total())
    scroll.afterLayout(() => {
      if (disposed || ticket !== generation || !follow() || !scroll) return
      const current = scroll.scrollTop
      if (reduce || Math.abs(destination - current) > box.height || current === destination) {
        scroll.scrollTo(destination); sync(); return
      }
      const value = { row: current }
      motion = createTimeline({ duration: 180, frameRate: 20, autoplay: false }, context.renderer)
      motion.add(value, { row: destination, duration: 180, ease: "outQuad", onUpdate: () => {
        if (!scroll || disposed || ticket !== generation) return
        scroll.scrollTo(Math.round(value.row)); setTop(Math.floor(scroll.scrollTop))
      }, onComplete: () => { if (motion) { getTimelineEngine(context.renderer).unregister(motion); motion = undefined } } })
      motion.play()
    })
  })
  // Pointer-only: follow/settings via buttons, scroll via wheel/drag.
  // No custom key interception; host owns dialog/panel/modal focus.
  return <box id="spotify-lyrics-view" ref={dimensions.ref} onSizeChange={() => { dimensions.sync(); scroll?.afterLayout(sync) }}
    width="100%" minWidth={0} height={height()} maxHeight={height()} flexDirection="column" paddingX={1} overflow="hidden"
    backgroundColor={props.settings().background ? colors().background : undefined}>
    <Show when={fullChrome() && height() >= 4}>
      {(() => { const title = props.state().track?.title || "Lyrics"; return <CellText id="spotify-lyrics-title"
        renderer={context.renderer} width={Math.max(1, dimensions.width() - 2)} text={title}
        fg={text()} bold truncate reserve={cellSafety(title)} /> })()}
    </Show>
    <Show when={fullChrome() && height() >= 8}>
      {(() => { const meta = `${props.lyrics().attribution || "Spotify"} · ${props.lyrics().format || "unavailable"} · ${props.lyrics().script || "unknown"}${props.lyrics().language ? ` (${props.lyrics().language})` : ""}`
        return <CellText id="spotify-lyrics-meta" renderer={context.renderer} width={Math.max(1, dimensions.width() - 2)}
          text={meta} fg={muted()} truncate reserve={cellSafety(meta)} /> })()}
    </Show>
    <Show when={height() >= 5}>
      <box height={1} flexShrink={0} flexDirection="row" minWidth={0} overflow="hidden">
        <Control action={{ id: "lyrics-follow", label: follow() ? "Following" : "Resume follow", run: resume }}
          renderer={context.renderer} foreground={text()} muted={muted()} accent={text()} />
        <Control action={{ id: "lyrics-settings", label: "Settings", run: props.settingsAction }}
          renderer={context.renderer} foreground={text()} muted={muted()} accent={text()} />
      </box>
    </Show>
    <scrollbox id="spotify-lyrics-scroll" ref={(value) => { scroll = value }} width="100%" minWidth={0} minHeight={1} flexGrow={1}
      scrollX={false} scrollY={true} onMouseScroll={manual} onMouseDown={(event) => {
        event.preventDefault()
        try { event.stopPropagation() } catch { /* noop */ }
        manual()
      }} contentOptions={{ flexDirection: "column" }}>
      <Show when={!instrumental()} fallback={
        <InstrumentalIndicator width={Math.max(1, viewport().width - 1)} height={viewport().height} playing={props.state().connection === "connected" && props.state().playback.isPlaying === true} reducedMotion={props.settings().reducedMotion} foreground={text()} muted={muted()} />
      }>
      <Show when={props.lyrics().lines.length} fallback={
        (() => { const notice = props.lyrics().status === "loading" ? "Finding lyrics for this track…" : "No lyrics from the enabled sources. Use Settings or refresh from Music."
          return <CellText renderer={context.renderer} width={width()} fg={muted()} text={notice}
            truncate={false} reserve={cellSafety(notice)} /> })()
      }>
        <box height={visible()[0]?.top ?? 0} flexShrink={0} />
        <Index each={visible()}>{(row) => <text id={`lyric-row-${row().top}`} width={Math.max(1, viewport().width - 1)} height={1}
          flexShrink={0} minWidth={0} wrapMode="none" truncate attributes={row().index === active() ? TextAttributes.BOLD : 0}
          fg={row().index === active() ? text() : muted()}>
          {row().gap ? "" : gutter() === 0 ? "" : row().index === active() && row().row === 0 ? "› " : "  "}{row().text}
        </text>}</Index>
        <box height={Math.max(0, total() - (visible().at(-1)?.top ?? -1) - 1)} flexShrink={0} />
      </Show>
      </Show>
    </scrollbox>
    <Show when={fullChrome() && height() >= 6}>
      {(() => { const footer = props.lyrics().selectionNote || `${follow() ? "Follow" : "Manual"} · scroll to browse · Follow/Settings buttons`
        return <CellText id="spotify-lyrics-footer" renderer={context.renderer} width={Math.max(1, dimensions.width() - 2)}
          text={footer} fg={muted()} truncate reserve={cellSafety(footer)} /> })()}
    </Show>
  </box>
}
