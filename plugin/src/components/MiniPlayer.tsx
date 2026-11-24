import { batch, createEffect, createMemo, createSignal, Index, on, onCleanup, onMount, Show } from "solid-js"
import { CliRenderEvents, TextAttributes, type BoxRenderable, type ScrollBoxRenderable } from "@opentui/core"
import type { BridgeCommand } from "../services/protocol"
import { formatTime, connectionLabel } from "../services/state"
import { selectLyricMoment } from "../services/lyrics"
import { lyricWindow, wrapLyricLines, distributeLyricRows, type LyricWindowKind } from "../services/lyrics-window"
import { describeLyricPhase } from "../ui/lyric-phase"
import { CellText, Control, cellMeasure, terminalSize, useDimensions, type ControlAction } from "../ui/primitives"
import { lyricColors } from "../ui/colors"
import { cellSafety } from "../ui/layout"
import {
  playerBudget, playerLayout, playerTimeWidth, resolvePlayerBudget, TERMINAL_SETTLE_MS, volumeGeometry, VOLUME_LABEL_WIDTH, VOLUME_MUTE_WIDTH,
} from "../ui/player-layout"
import { TRANSPORT_WIDTHS, transportActions } from "../ui/transport"
import { displayVolume, volumeAcknowledged, volumeKnown, volumePercentLabel } from "../services/playback-ui"
import { playerActions } from "../ui/player-actions"
import { ArtworkView, useArtwork } from "./ArtworkView"
import { PlaybackSlider } from "./PlaybackSlider"
import type { MusicProps } from "./Music"

export interface MiniPlayerProps extends MusicProps {
  open: () => void
  openLyrics: () => void
  openSettings: () => void
  more: () => void
  /** Test/host override; production derives the footer budget from terminal height. */
  budget?: () => number
  run: (command: BridgeCommand, params?: Record<string, unknown>) => Promise<boolean | void>
}

// V0.5.3 pinned sidebar card. Order is header, navigation, framed player card
// (artwork, title, artist, progress, transport, compact volume), then a
// five-line synchronized lyric window. The album image is the only color.
export function MiniPlayer(props: MiniPlayerProps) {
  const { context } = props
  const renderer = context.renderer
  const measure = cellMeasure(renderer)
  const dimensions = useDimensions()
  const terminal = terminalSize(renderer)
  const width = () => Math.max(1, dimensions.width() - 2)
  let root: BoxRenderable | undefined
  const [seekPreview, setSeekPreview] = createSignal<number>()
  const [volumeDrag, setVolumeDrag] = createSignal<number>()
  const [volumeDragging, setVolumeDragging] = createSignal(false)
  const [volumeOptimistic, setVolumeOptimistic] = createSignal<number>()
  let volumeTimer: ReturnType<typeof setTimeout> | undefined

  const state = props.state
  const settings = props.settings
  const playback = () => state().playback
  const hasTrack = () => !!state().track
  const connected = () => state().connection === "connected"
  const supported = (command: BridgeCommand) => connected() && !!state().capabilities?.commands.includes(command)
  const seekEnabled = () => hasTrack() && supported("seek") && playback().durationMs > 0
  const identity = createMemo(() => [state().epoch, state().connection, state().track?.uri].join("|"))
  const snapshot = createMemo(() => state().revision)
  const panelOpen = () => {
    try { return context.ui.panel?.current?.()?.name === "spotify" } catch { return false }
  }
  const palette = createMemo(() => {
    const mono = lyricColors(context.theme.text.base)
    return { background: mono.background, text: context.theme.text.base, muted: context.theme.text.muted }
  })
  const aspect = () => {
    const pixels = renderer.resolution
    return pixels ? (pixels.height / renderer.height) / (pixels.width / renderer.width) : 2
  }

  const showVolume = () => settings().showVolume && connected()
  // Adaptive footer budget with settle + hysteresis. The terminal height is
  // the only host-supported size signal (sidebar slots publish sessionID
  // only), so rapid resizes or Todo oscillation settle for TERMINAL_SETTLE_MS
  // before the budget recomputes, and resolvePlayerBudget keeps the previous
  // budget until the raw budget moves by BUDGET_HYSTERESIS rows. The explicit
  // `budget` test override bypasses both so fixtures stay deterministic.
  const [settledHeight, setSettledHeight] = createSignal(terminal().height)
  let settleTimer: ReturnType<typeof setTimeout> | undefined
  createEffect(on(() => terminal().height, (height) => {
    if (settleTimer) clearTimeout(settleTimer)
    settleTimer = setTimeout(() => setSettledHeight(height), TERMINAL_SETTLE_MS)
  }, { defer: true }))
  onCleanup(() => { if (settleTimer) clearTimeout(settleTimer) })
  const [stickyBudget, setStickyBudget] = createSignal(playerBudget(terminal().height))
  createEffect(on(settledHeight, (height) => {
    setStickyBudget((previous) => resolvePlayerBudget(height, previous))
  }))
  const plannedLayout = createMemo(() => playerLayout(props.budget?.() ?? stickyBudget(), {
    hasTrack: hasTrack(), width: width(), aspect: aspect(), artwork: settings().artwork,
    artworkSize: settings().artworkSize, showVolume: showVolume(), preview: settings().preview,
  }))
  const [layout, setLayout] = createSignal(plannedLayout())
  const artwork = useArtwork(() => state().track?.image ?? "", () => layout().art)
  const innerWidth = () => layout().innerWidth
  const timeWidth = () => playerTimeWidth(innerWidth())
  const seekWidth = () => Math.max(1, innerWidth() - 2 * timeWidth() - 2)
  const volumeSlots = () => volumeGeometry(innerWidth())
  const likeVisible = () => innerWidth() >= TRANSPORT_WIDTHS.previous + TRANSPORT_WIDTHS.toggle + TRANSPORT_WIDTHS.next + 2 + 2 * TRANSPORT_WIDTHS.like
  const compactTransport = () => innerWidth() < TRANSPORT_WIDTHS.previous + TRANSPORT_WIDTHS.toggle + TRANSPORT_WIDTHS.next + 2

  const clock = () => seekPreview() ?? props.position()
  const serverVolume = () => playback().volume
  const volumeValue = () => displayVolume(volumeDragging() ? volumeDrag() : undefined, volumeOptimistic(), serverVolume())
  const volumeEnabled = () => supported("set_volume") && volumeKnown(volumeOptimistic(), serverVolume())
  const percent = () => volumeKnown(volumeOptimistic(), serverVolume()) ? volumePercentLabel(volumeValue()) : "     —"

  const transport = createMemo(() => transportActions(state(), props.position(), props.run))
  const muteAction = (): ControlAction => {
    const action = playerActions(state(), props.position(), props.run).find((candidate) => candidate.id === "spotify-mute")!
    return { ...action, label: playback().muted ? "Unm" : "Vol", accessibleLabel: playback().muted ? "Unmute" : "Mute",
      disabled: !supported("set_mute") || playback().muted === null, reason: "Spotify mute API/state unavailable" }
  }
  const settingsAction = (): ControlAction => ({
    id: "spotify-settings", label: measure("⚙") === 1 ? "⚙" : "Cfg", accessibleLabel: "Spotify settings", run: props.openSettings,
  })
  const navigation = createMemo<ControlAction[]>(() => {
    // Narrow <13 shows only More: it must open the complete pointer menu
    // (Music.open: playback/search/queue/lyrics/settings) so gear-hidden
    // settings and Music-level actions stay reachable by mouse.
    const complete = width() < 13
    const moreAction: ControlAction = {
      id: "spotify-more", label: "More",
      accessibleLabel: complete ? "More Spotify controls (full menu)" : "More playback controls",
      run: () => { if (complete) props.open(); else props.more() },
    }
    const all: ControlAction[] = [
      { id: "spotify-music", label: "Music", run: props.open },
      { id: "spotify-lyrics", label: "Lyrics", active: panelOpen(), run: props.openLyrics },
      moreAction,
    ]
    return width() >= 21 ? all : width() >= 13 ? [all[0]!, all[2]!] : [all[2]!]
  })
  // Header fallback when nav row is hidden (width<13): same complete-menu More
  // action, reused id so pointer tests find it. Keeps total height unchanged.
  const headerMore = (): ControlAction => ({
    id: "spotify-more", label: "More",
    accessibleLabel: "More Spotify controls (full menu)",
    run: () => props.open(),
  })
  // Pointer-only: no keyboard focus, cycle or engage. Clicking a control runs
  // it directly; disabled clicks explain why via toast. Sliders never take
  // renderer focus (preventDefault on down) so the host editor keeps typing.
  const runAction = (action: ControlAction) => {
    if (action.disabled) {
      context.ui.toast.show({ message: action.reason ?? `${action.label} unavailable` })
      return
    }
    void action.run()
  }

  const clearVolumeTimer = () => { if (volumeTimer) clearTimeout(volumeTimer); volumeTimer = undefined }
  const optimisticVolume = (value: number) => {
    clearVolumeTimer()
    setVolumeOptimistic(value)
    volumeTimer = setTimeout(() => setVolumeOptimistic(undefined), 2200)
  }
  const commitVolume = (value: number) => {
    const target = Math.max(0, Math.min(1, value))
    optimisticVolume(target)
    void Promise.resolve(props.run("set_volume", { value: target })).then((result) => {
      if (result === false && volumeOptimistic() === target) {
        clearVolumeTimer(); setVolumeOptimistic(undefined)
      }
    })
  }
  createEffect(on(() => playback().volume, (server) => {
    if (!volumeDragging() && volumeAcknowledged(volumeOptimistic(), server)) {
      clearVolumeTimer(); setVolumeOptimistic(undefined)
    }
  }))
  createEffect(on(identity, () => {
    clearVolumeTimer(); setVolumeOptimistic(undefined); setVolumeDrag(undefined); setVolumeDragging(false); setSeekPreview(undefined)
    lastLyricScrollTop = -1
  }))
  onCleanup(clearVolumeTimer)

  const sync = () => { dimensions.sync() }
  onMount(() => {
    renderer.root.on("layout-changed", sync)
    onCleanup(() => {
      renderer.root.off("layout-changed", sync)
    })
  })
  const control = (action: () => ControlAction, cells?: number, active = false) => <Control renderer={renderer}
    width={Math.min(innerWidth(), cells ?? measure(action().label) + 2)}
    action={{ ...action(), run: () => runAction(action()) }}
    foreground={palette().text} muted={palette().muted} accent={palette().text}
    active={active} />
  const headerControl = (action: () => ControlAction) => <Control renderer={renderer}
    width={Math.min(width(), 5)} action={{ ...action(), run: () => runAction(action()) }}
    foreground={palette().text} muted={palette().muted} accent={palette().text} />

  const moment = createMemo(() => {
    const lyrics = props.lyrics()
    return selectLyricMoment(lyrics, props.position(), hasTrack(),
      lyrics.status === "unavailable" ? props.sources()?.availability.find((source) => source.state === "error")?.detail : undefined)
  })
  const lyricSemantic = createMemo(() => plannedLayout().lyricsRows
    ? lyricWindow(props.lyrics(), moment(), plannedLayout().lyricsRows, props.position())
    : [])
  // Multiline block (V0.5.5): each semantic line wraps to its own physical
  // rows with the same width arithmetic CellText uses, then the fixed budget
  // is distributed with the focus line kept whole and centered. The block
  // height always equals the tier budget, so wrapped-height changes never
  // bounce the player; only an over-budget focus line uses the scroll viewport.
  const lyricBlock = createMemo(() => {
    const budget = plannedLayout().lyricsRows
    if (!budget || dimensions.width() <= 2) return null
    const wrapped = wrapLyricLines(lyricSemantic(), Math.max(1, width()), measure)
    const block = distributeLyricRows(wrapped, budget)
    if (typeof process !== "undefined" && process.env.SPOTIFY_DEBUG_BLOCK === "1") {
      // eslint-disable-next-line no-console
      console.log("BLOCK w=", width(), "lines=", wrapped.map((w) => `${w.kind}:${w.rows.length}`).join(","),
        "overflow=", block.activeOverflow, "focusTop=", block.focusTop,
        "visible=", block.lines.map((l) => `${l.kind}:${l.rows.length}`).join(","))
    }
    return block
  })
  let lastLyricScrollTop = -1
  // A shaped line can occupy more terminal cells than the native diff owns.
  // Keep the old card geometry for a full-width blank frame, then present the
  // latest layout and lyric block together. Otherwise a tier/track change can
  // move the clear below or above the very rows it is meant to erase.
  const desiredPhase = createMemo(() => describeLyricPhase(lyricBlock(), width()))
  const [lyricVisible, setLyricVisible] = createSignal<ReturnType<typeof desiredPhase>>(null)
  const [lyricClearing, setLyricClearing] = createSignal(false)
  const [lyricBlankVariant, setLyricBlankVariant] = createSignal(false)
  let stagedAtFrame = -1
  const sameLyricRect = (next: NonNullable<ReturnType<typeof desiredPhase>>, plan: ReturnType<typeof plannedLayout>) => {
    const current = lyricVisible()
    return current?.width === next.width && current.height === next.height && layout().total === plan.total
  }
  function afterClear() {
    // Size callbacks can stage a clear while OpenTUI is still presenting the
    // previous frame. Only a subsequent native frame can confirm the clear.
    if (renderer.frameId <= stagedAtFrame) {
      renderer.requestRender()
      return
    }
    renderer.off(CliRenderEvents.FRAME, afterClear)
    const next = desiredPhase()
    const plan = plannedLayout()
    if (next?.hasShaped && !sameLyricRect(next, plan)) clearRect(next, plan)
    else present(next, plan)
  }
  function clearRect(phase: NonNullable<ReturnType<typeof desiredPhase>>, plan: ReturnType<typeof plannedLayout>) {
    stagedAtFrame = renderer.frameId
    renderer.on(CliRenderEvents.FRAME, afterClear)
    batch(() => {
      setLayout(plan)
      setLyricVisible(phase)
      setLyricBlankVariant((variant) => !variant)
      setLyricClearing(true)
    })
    renderer.requestRender()
  }
  function present(next: ReturnType<typeof desiredPhase>, plan: ReturnType<typeof plannedLayout>) {
    batch(() => {
      setLayout(plan)
      if (lyricVisible()?.key !== next?.key) setLyricVisible(next)
      setLyricClearing(false)
    })
  }
  onCleanup(() => renderer.off(CliRenderEvents.FRAME, afterClear))
  createEffect(on([desiredPhase, plannedLayout], ([next, plan]) => {
    if (lyricClearing()) return // FRAME callback takes the newest revision.
    const previous = lyricVisible()
    const changed = previous?.key !== next?.key || layout().total !== plan.total
    // Old shaped text needs its original cells cleared. Before introducing a
    // shaped run, clear the new rectangle too if it is not already blank.
    if (changed && previous?.hasShaped) clearRect(previous, layout())
    else if (changed && next?.hasShaped) clearRect(next, plan)
    else present(next, plan)
  }))
  createEffect(() => {
    const vis = lyricClearing() ? null : lyricVisible()
    if (!vis || vis.block.activeOverflow !== true) { lastLyricScrollTop = -1; return }
    const node = root?.findDescendantById("spotify-lyrics-scroll") as ScrollBoxRenderable | undefined
    if (!node) return
    const total = vis.block.fullLines.reduce((sum, line) => sum + line.rows.length, 0)
    const top = Math.max(0, Math.min(vis.block.focusTop, Math.max(0, total - vis.block.height)))
    if (top !== lastLyricScrollTop) {
      lastLyricScrollTop = top
      node.afterLayout(() => { node.scrollTo(top) })
    }
  })

  // Physical rows render with plain .map, never a nested <Index>: a nested
  // Index over a plain array does not propagate element updates, leaving
  // stale rows after the first layout pass.
  const physicalRows = (
    getRows: () => string[],
    getKind: () => LyricWindowKind,
    isTruncated: () => boolean,
  ) => getRows().map((rowText, rowIndex) => {
    const cut = rowIndex === getRows().length - 1 && isTruncated()
    const text = cut ? `${rowText}…` : rowText
    const kind = getKind()
    return <CellText renderer={renderer} width={width()} text={text}
      fg={kind === "active" ? palette().text : palette().muted}
      bold={kind === "active"} truncate center reserve={cellSafety(text)} />
  })

  const card = (framed: boolean) => <box id="spotify-card" width="100%" height={layout().cardHeight}
    flexShrink={0} flexDirection="column" overflow="hidden"
    {...(framed ? { border: true as const, borderStyle: "single" as const, borderColor: palette().muted, paddingX: 1 } : { paddingX: 0 })}>
    <Show when={layout().art}>
      <box id="spotify-artwork" width="100%" height={layout().artHeight} flexShrink={0}
        flexDirection="row" alignItems="center" justifyContent="center" overflow="hidden">
        <ArtworkView artwork={artwork()} width={layout().artWidth} height={layout().artHeight}
          renderer={renderer} muted={palette().muted} />
      </box>
    </Show>
    <Show when={layout().gapArt}><box height={1} flexShrink={0} /></Show>
    <Show when={layout().title}>
      {(() => { const text = state().track?.title || "Nothing playing"; return <CellText id="spotify-title" renderer={renderer}
        width={innerWidth()} text={text} fg={palette().text} bold truncate center reserve={cellSafety(text)} /> })()}
    </Show>
    <Show when={layout().artist}>
      {(() => { const text = state().track?.artist ?? ""; return <CellText id="spotify-artist" renderer={renderer}
        width={innerWidth()} text={text} fg={palette().muted} truncate center reserve={cellSafety(text)} /> })()}
    </Show>
    <Show when={layout().seek}>
      <box id="spotify-seek-row" width="100%" height={1} flexShrink={0} flexDirection="row" alignItems="center" overflow="hidden">
        <CellText id="spotify-elapsed" renderer={renderer} width={timeWidth()} text={formatTime(clock())} fg={palette().muted} truncate />
        <box width={1} />
        <PlaybackSlider id="spotify-timeline" width={seekWidth()}
          renderer={renderer} value={props.position()} max={playback().durationMs} disabled={!seekEnabled()}
          identity={identity()} snapshot={snapshot()}
          foreground={palette().text} muted={palette().muted} accent={palette().text}
          onPreview={setSeekPreview}
          onCommit={(positionMs) => {
            const target = Math.round(positionMs)
            props.previewSeek?.(target)
            return props.run("seek", { positionMs: target })
          }} />
        <box width={1} />
        <CellText id="spotify-duration" renderer={renderer} width={timeWidth()}
          text={formatTime(playback().durationMs).padStart(timeWidth())} fg={palette().muted} truncate />
      </box>
    </Show>
    <Show when={layout().gapTransport}><box height={1} flexShrink={0} /></Show>
    <Show when={layout().transport}>
      <box id="spotify-transport" width="100%" height={1} flexShrink={0} flexDirection="row" alignItems="center" overflow="hidden">
        <box flexGrow={1} flexBasis={0} flexDirection="row" justifyContent="flex-end">
          <Show when={likeVisible()}><box width={TRANSPORT_WIDTHS.like} /></Show>
        </box>
        <Show when={!compactTransport()}>
          {control(() => transport().previous, TRANSPORT_WIDTHS.previous)}
          <box width={1} />
        </Show>
        {control(() => transport().toggle, TRANSPORT_WIDTHS.toggle)}
        <Show when={!compactTransport()}>
          <box width={1} />
          {control(() => transport().next, TRANSPORT_WIDTHS.next)}
        </Show>
        <box flexGrow={1} flexBasis={0} flexDirection="row" justifyContent="flex-end">
          <Show when={likeVisible()}>{control(() => transport().like, TRANSPORT_WIDTHS.like)}</Show>
        </box>
      </box>
    </Show>
    <Show when={layout().volume}>
      <box id="spotify-volume-row" width="100%" height={1} flexShrink={0} flexDirection="row"
        justifyContent="center" alignItems="center" overflow="hidden">
        <Show when={volumeSlots().showMute}>
          {control(muteAction, VOLUME_MUTE_WIDTH)}
          <box width={1} />
        </Show>
        <PlaybackSlider id="spotify-volume" width={volumeSlots().slider}
          renderer={renderer} value={volumeValue()} max={1} disabled={!volumeEnabled()}
          identity={identity()} snapshot={snapshot()}
          foreground={palette().muted} muted={palette().muted} accent={palette().text}
          liveCommitMs={100}
          onPreview={setVolumeDrag} onDraggingChange={(dragging) => { setVolumeDragging(dragging); if (!dragging) setVolumeDrag(undefined) }}
          onCommit={commitVolume} />
        <Show when={volumeSlots().showPercent}>
          <box width={1} />
          <CellText id="spotify-volume-percent" renderer={renderer} width={VOLUME_LABEL_WIDTH} text={percent()} fg={palette().muted} truncate />
        </Show>
      </box>
    </Show>
  </box>

  return <box id="spotify-player" ref={(box) => { root = box; dimensions.ref(box) }} onSizeChange={sync}
    width="100%" height={layout().total} minWidth={0} minHeight={0} flexShrink={0}
    flexDirection="column" paddingX={1} overflow="hidden">
    <Show when={layout().header}>
      <box id="spotify-header" width="100%" height={1} flexShrink={0} flexDirection="row" alignItems="center" overflow="hidden">
        {(() => {
          const settingsW = width() >= 9 ? 5 : 0
          const moreW = !layout().nav ? 6 : 0
          const labelW = Math.max(1, width() - settingsW - moreW)
          const text = `Spotify ${connectionLabel(state())}`; return <CellText renderer={renderer}
          width={labelW} text={text} fg={palette().muted}
          reserve={cellSafety(text)} truncate /> })()}
        <Show when={width() >= 9}>{headerControl(settingsAction)}</Show>
        <Show when={!layout().nav}>
          <Control renderer={renderer} width={6}
            action={{ ...headerMore(), run: () => runAction(headerMore()) }}
            foreground={palette().text} muted={palette().muted} accent={palette().text} />
        </Show>
      </box>
    </Show>
    <Show when={layout().nav}>
      <box id="spotify-nav" width="100%" height={1} flexShrink={0} flexDirection="row" justifyContent="center" overflow="hidden">
        <Index each={navigation()}>{(action) => control(action, measure(action().label) + 2, !!action().active)}</Index>
      </box>
    </Show>

    <Show when={layout().frame}>{card(true)}</Show>
    <Show when={!layout().frame}>{card(false)}</Show>

    <Show when={layout().gapLyrics}><box height={1} flexShrink={0} /></Show>
    <Show when={lyricVisible()}>
      <box id="spotify-lyrics-block" width="100%" height={lyricVisible()!.height} flexShrink={0}
        flexDirection="column" overflow="hidden">
        {/* Keep the same blank underlay when glyphs return. If its style
          reverted on that frame, a trailing blank diff could start at the
          native end of a shaped row and erase part of the new glyph run. */}
        <box position="absolute" left={0} top={0} width="100%" height={lyricVisible()!.height}
          flexDirection="column" overflow="hidden">
          <Index each={Array.from({ length: lyricVisible()!.height })}>{() => (
            <text width={Math.min(width(), lyricVisible()!.width)} height={1} flexShrink={0} minWidth={0}
              fg={lyricBlankVariant() ? "#fffffe" : "#ffffff"}
              attributes={TextAttributes.BOLD | TextAttributes.DIM} wrapMode="none" truncate selectable={false}>
              {" ".repeat(Math.min(width(), lyricVisible()!.width))}
            </text>
          )}</Index>
        </box>
        <Show when={!lyricClearing()}>
        <Show when={!lyricVisible()!.block.activeOverflow} fallback={
          <scrollbox id="spotify-lyrics-scroll" width="100%"
            height={lyricVisible()!.height} minWidth={0} minHeight={1} flexShrink={0}
            scrollX={false} scrollY={true} contentOptions={{ flexDirection: "column" }}>
            <Index each={lyricVisible()!.block.fullLines}>{(line) => (
              <box width="100%" flexShrink={0} flexDirection="column" overflow="hidden">
                {physicalRows(() => line().rows, () => line().kind, () => false)}
              </box>
            )}</Index>
          </scrollbox>
        }>
          <Show when={lyricVisible()!.block.padTop > 0}><box height={lyricVisible()!.block.padTop} flexShrink={0} /></Show>
          <Index each={lyricVisible()!.block.lines}>{(line, order) => (
            <box id={`spotify-lyric-${order}`} width="100%" height={line().rows.length} flexShrink={0}
              flexDirection="column" overflow="hidden">
              {physicalRows(() => line().rows, () => line().kind, () => line().truncated)}
            </box>
          )}</Index>
          <Show when={lyricVisible()!.block.padBottom > 0}><box height={lyricVisible()!.block.padBottom} flexShrink={0} /></Show>
        </Show>
        </Show>
      </box>
    </Show>
  </box>
}
