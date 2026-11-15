import { createEffect, createMemo, createSignal, Index, on, onCleanup, onMount, Show } from "solid-js"
import { createTimeline, getTimelineEngine, TextAttributes, type ScrollBoxRenderable, type Timeline } from "@opentui/core"
import type { MusicProps } from "./Music"
import { selectLyricMoment, validatedWordOffsets, type LyricLine } from "../services/lyrics"
import { InstrumentalIndicator } from "./InstrumentalIndicator"
import { CellText, Control, cellMeasure, terminalSize, useDimensions } from "../ui/primitives"
import { followOffset, lyricLayout, visibleLyricRows, displayText, type VisualLyricRow } from "../ui/layout"
import { lyricColors, mix, contrast } from "../ui/colors"

export function LyricsView(props: MusicProps & { settingsAction: () => void; height?: number }) {
  const { context } = props
  const dimensions = useDimensions()
  const terminal = terminalSize(context.renderer)
  const height = () => props.height ?? Math.max(1, Math.min(36, terminal().height - 8))
  let scroll: ScrollBoxRenderable | undefined
  let motion: Timeline | undefined
  let disposed = false, generation = 0
  const [follow, setFollow] = createSignal(props.settings().follow)
  const [top, setTop] = createSignal(0)
  const [viewport, setViewport] = createSignal({ width: 1, height: 1 })
  const [emphasis, setEmphasis] = createSignal(1)
  const [toolFocus, setToolFocus] = createSignal(0)
  const colors = createMemo(() => lyricColors(context.theme.text.base, context.theme.text.action.primary.base, props.settings().accent))
  const moment = createMemo(() => selectLyricMoment(props.lyrics(), props.position(), !!props.state().track, props.lyrics().status === "unavailable" ? props.sources()?.availability.find((source) => source.state === "error")?.detail : undefined))
  const active = createMemo(() => { const value = moment(); return value.kind === "ready-line" ? value.lineIndex : -1 })
  const width = () => Math.max(1, viewport().width - 3)
  const blocks = createMemo(() => lyricLayout(props.lyrics().lines, width(), cellMeasure(context.renderer)))
  const total = () => { const last = blocks().at(-1); return last ? last.top + last.height : 0 }
  const visible = createMemo(() => visibleLyricRows(blocks(), top(), viewport().height))
  const stop = () => {
    generation++
    if (motion) { motion.pause(); getTimelineEngine(context.renderer).unregister(motion); motion = undefined }
    setEmphasis(1)
  }
  const manual = () => { stop(); setFollow(false) }
  const move = (rows: number) => { manual(); scroll?.scrollBy(rows) }
  const resume = () => {
    stop(); setFollow(true)
    scroll?.scrollTo(followOffset(blocks()[active()], viewport().height, total()))
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
    const index = active(), layout = blocks(), box = viewport(), following = follow(), reduce = props.settings().reducedMotion
    if (!following || !scroll || index < 0) return
    stop()
    const ticket = generation
    const target = followOffset(layout[index], box.height, total())
    scroll.afterLayout(() => {
      if (disposed || ticket !== generation || !follow() || !scroll) return
      const current = scroll.scrollTop
      if (reduce || Math.abs(target - current) > box.height || current === target) {
        scroll.scrollTo(target); sync(); return
      }
      const value = { row: current, strength: 0 }
      motion = createTimeline({ duration: 180, frameRate: 20, autoplay: false }, context.renderer)
      motion.add(value, { row: target, strength: 1, duration: 180, ease: "outQuad", onUpdate: () => {
        if (!scroll || disposed || ticket !== generation) return
        scroll.scrollTo(Math.round(value.row)); setTop(Math.floor(scroll.scrollTop)); setEmphasis(value.strength)
      }, onComplete: () => { if (motion) { getTimelineEngine(context.renderer).unregister(motion); motion = undefined }; setEmphasis(1) } })
      motion.play()
    })
  })
  context.keymap.layer(() => ({ commands: [
    { bind: "up", run: () => move(-1) }, { bind: "down", run: () => move(1) },
    { bind: "pageup", run: () => move(-viewport().height) }, { bind: "pagedown", run: () => move(viewport().height) },
    { bind: "home", run: () => { manual(); scroll?.scrollTo(0) } },
    { bind: "end", run: () => { manual(); scroll?.scrollTo(Infinity) } },
    { bind: "f", run: resume }, { bind: "s", run: props.settingsAction },
    { bind: "r", run: () => { void props.refreshLyrics() } },
    { bind: "tab", enabled: () => height() >= 5, run: () => setToolFocus((value) => 1 - value) },
    { bind: "shift+tab", enabled: () => height() >= 5, run: () => setToolFocus((value) => 1 - value) },
    { bind: "return", enabled: () => height() >= 5, run: () => { if (toolFocus() === 0) resume(); else props.settingsAction() } },
  ] }))
  // Keep the whole active line slightly warm while reserving the full accent
  // for the currently sung word. Without this split, genuine word timings would
  // paint the same colour as the line and karaoke emphasis would be invisible.
  const activeColor = () => {
    const color = mix(colors().text, colors().active, (props.settings().strongEmphasis ? 0.35 : 0.12) * emphasis())
    return contrast(color, colors().background) >= 4.5 ? color : colors().text
  }
  const fragments = (row: VisualLyricRow, line: LyricLine) => {
    const words = validatedWordOffsets(line)
    if (!words) return null
    const raw = displayText(line.text)
    if (raw !== line.text) return null
    const boundaries = new Set(Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(raw), (part) => part.index))
    boundaries.add(raw.length)
    let at = 0
    for (let i = 0; i <= row.row; i++) {
      at = raw.indexOf(blocks()[row.index]!.rows[i]!, at)
      if (at < 0) return null
      if (i !== row.row) at += blocks()[row.index]!.rows[i]!.length
    }
    let valid = true
    let cursor = at
    const parts = words.flatMap((word) => {
      const a = Math.max(at, word.startOffset), b = Math.min(at + row.text.length, word.endOffset)
      // Boundaries originate in provider words and grapheme-safe wrapped rows.
      if (a < b && (!boundaries.has(a) || !boundaries.has(b))) valid = false
      if (a >= b) return []
      const gap = cursor < a ? [{ text: raw.substring(cursor, a), startMs: -1, endMs: -1 }] : []
      cursor = b
      return [...gap, { text: raw.substring(a, b), startMs: word.startMs, endMs: word.endMs }]
    })
    if (cursor < at + row.text.length) parts.push({ text: raw.substring(cursor, at + row.text.length), startMs: -1, endMs: -1 })
    return valid && parts.length ? parts : null
  }
  return <box id="spotify-lyrics-view" ref={dimensions.ref} onSizeChange={() => { dimensions.sync(); scroll?.afterLayout(sync) }}
    width="100%" minWidth={0} height={height()} maxHeight={height()} flexDirection="column" paddingX={1} overflow="hidden"
    backgroundColor={props.settings().background ? colors().background : undefined}>
    <Show when={height() >= 4}>
      <CellText renderer={context.renderer} width={Math.max(1, dimensions.width() - 2)} text={props.state().track?.title || "Lyrics"}
        fg={colors().text} bold truncate />
    </Show>
    <Show when={height() >= 8}>
      <CellText renderer={context.renderer} width={Math.max(1, dimensions.width() - 2)}
        text={`${props.lyrics().attribution || "Spotify"} · ${props.lyrics().format || "unavailable"} · ${props.lyrics().script || "unknown"}${props.lyrics().language ? ` (${props.lyrics().language})` : ""}`}
        fg={colors().muted} truncate />
    </Show>
    <Show when={height() >= 5}>
      <box height={1} flexShrink={0} flexDirection="row" minWidth={0} overflow="hidden">
        <Control action={{ id: "lyrics-follow", label: follow() ? "Following" : "Resume follow", run: resume }}
          renderer={context.renderer} foreground={colors().text} muted={colors().muted} accent={colors().active} focused={toolFocus() === 0} focus={() => setToolFocus(0)} />
        <Control action={{ id: "lyrics-settings", label: "Settings", run: props.settingsAction }}
          renderer={context.renderer} foreground={colors().text} muted={colors().muted} accent={colors().active} focused={toolFocus() === 1} focus={() => setToolFocus(1)} />
      </box>
    </Show>
    <scrollbox id="spotify-lyrics-scroll" ref={(value) => { scroll = value }} width="100%" minWidth={0} minHeight={1} flexGrow={1}
      scrollX={false} scrollY={true} onMouseScroll={manual} onMouseDown={manual} contentOptions={{ flexDirection: "column" }}>
      <Show when={moment().kind === "instrumental" && follow()} fallback={<Show when={props.lyrics().lines.length} fallback={
        <CellText renderer={context.renderer} width={width()} fg={colors().muted}
          text={props.lyrics().status === "loading" ? "Finding lyrics for this track…" : "No lyrics from the enabled sources. Press S for settings or R to refresh."} />
      }>
        <box height={visible()[0]?.top ?? 0} flexShrink={0} />
        <Index each={visible()}>{(row) => <text id={`lyric-row-${row().top}`} width={Math.max(1, viewport().width - 1)} height={1}
          flexShrink={0} minWidth={0} wrapMode="none" attributes={row().index === active() && props.settings().strongEmphasis ? TextAttributes.BOLD : 0}
          fg={row().index === active() ? activeColor() : row().index < active() ? colors().muted : mix(colors().muted, colors().text, 0.3)}>
          {row().gap ? "" : row().index === active() && row().row === 0 ? "› " : "  "}
          <Show when={!row().gap && fragments(row(), props.lyrics().lines[row().index]!)} fallback={row().text}>
            {(parts) => <Index each={parts()}>{(part) => <span style={{ fg: row().index === active() && props.position() >= part().startMs && props.position() < part().endMs ? colors().active : undefined }}>{part().text}</span>}</Index>}
          </Show>
        </text>}</Index>
        <box height={Math.max(0, total() - (visible().at(-1)?.top ?? -1) - 1)} flexShrink={0} />
      </Show>}>
        <Show when={props.settings().instrumental} fallback={<CellText renderer={context.renderer} width={width()} text="Music playing" fg={colors().muted} />}>
          <InstrumentalIndicator width={Math.max(1, viewport().width - 1)} height={viewport().height} playing={props.state().connection === "connected" && props.state().playback.isPlaying === true} reducedMotion={props.settings().reducedMotion} foreground={colors().text} muted={colors().muted} />
        </Show>
      </Show>
    </scrollbox>
    <Show when={height() >= 6}>
      <CellText renderer={context.renderer} width={Math.max(1, dimensions.width() - 2)}
        text={props.lyrics().selectionNote || `${follow() ? "Follow" : "Manual"} · ↑↓ scroll · F follow · S settings · R refresh · Esc close`}
        fg={colors().muted} truncate />
    </Show>
  </box>
}
