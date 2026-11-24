import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js"
import type { BoxRenderable } from "@opentui/core"
import { CellText, Control, cellMeasure, terminalSize, useDimensions } from "../ui/primitives"
import { cellSafety } from "../ui/layout"
import { TRANSPORT_WIDTHS, transportActions } from "../ui/transport"
import type { BridgeCommand } from "../services/protocol"
import { ArtworkView, useArtwork } from "./ArtworkView"
import { LyricsView } from "./LyricsView"
import { lyricsSettingsDialog } from "./LyricsSettings"
import type { MusicProps } from "./Music"

export interface NowPlayingPanelProps extends MusicProps {
  width: number
  close: () => void
  toggleFullscreen: () => void
  presentation: "panel" | "fullscreen"
  run: (command: BridgeCommand, params?: Record<string, unknown>) => Promise<boolean | void>
}

// V0.5 dedicated session surface: true album-art pixels (the only color),
// monochrome transport, and immersive lyrics. Falls back to the large dialog
// when the host has no session.panel slot.
export function NowPlayingPanel(props: NowPlayingPanelProps) {
  const { context } = props
  const renderer = context.renderer
  const measure = cellMeasure(renderer)
  const dimensions = useDimensions()
  const terminal = terminalSize(renderer)
  let root: BoxRenderable | undefined
  const [slotHeight, setSlotHeight] = createSignal<number>()
  const width = () => Math.max(1, Math.floor(props.width) || dimensions.width() || 40)
  const innerWidth = () => Math.max(1, width() - 2)
  // Respect a short host slot instead of forcing eight rows over it. The panel
  // degrades from hints to transport to lyrics, never painting outside.
  const height = () => Math.max(1, Math.min(terminal().height - 4, slotHeight() ?? terminal().height - 4))
  const sync = () => {
    dimensions.sync()
    const parent = root?.parent
    if (parent && Number.isFinite(parent.height) && parent.height > 0) setSlotHeight(parent.height)
  }
  onMount(sync)
  onMount(() => {
    renderer.on("resize", sync)
    onCleanup(() => renderer.off("resize", sync))
  })
  const text = () => context.theme.text.base
  const muted = () => context.theme.text.muted
  const hasTrack = () => !!props.state().track
  const gap = () => height() >= 16 ? 1 : 0
  const showTransport = () => height() >= 4
  const showHints = () => height() >= 6
  const showLyrics = () => height() >= 2
  const chrome = () => 1 + Number(showTransport()) + Number(showHints()) + Number(showTransport() && gap() > 0)
  const minLyrics = () => showLyrics() ? Math.max(1, Math.min(5, height() - chrome())) : 0
  const artHeight = () => {
    if (!hasTrack() || !props.settings().artwork || innerWidth() < 28) return 0
    const artMax = Math.min(props.settings().artworkSize === "small" ? 6 : 10,
      Math.max(4, Math.floor((innerWidth() - 8) / 4)))
    const room = height() - chrome() - 2 * gap() - minLyrics()
    return room >= 4 ? Math.min(artMax, room) : 0
  }
  const artWidth = () => {
    const pixels = renderer.resolution
    const aspect = pixels ? (pixels.height / renderer.height) / (pixels.width / renderer.width) : 2
    return Math.max(1, Math.min(innerWidth(), Math.round(artHeight() * aspect)))
  }
  const lyricsHeight = () => showLyrics()
    ? Math.max(1, height() - chrome() - (artHeight() > 0 ? artHeight() + 2 * gap() : 0))
    : 0
  const artwork = useArtwork(() => props.state().track?.image ?? "", () => artHeight() > 0)
  const actions = createMemo(() => transportActions(props.state(), props.position(), props.run))
  const likeVisible = () => innerWidth() >= TRANSPORT_WIDTHS.previous + TRANSPORT_WIDTHS.toggle + TRANSPORT_WIDTHS.next + 2 + 2 * TRANSPORT_WIDTHS.like
  const compactTransport = () => innerWidth() < TRANSPORT_WIDTHS.previous + TRANSPORT_WIDTHS.toggle + TRANSPORT_WIDTHS.next + 2
  // Pointer-only: transport buttons run directly; disabled explains via toast.
  // Panel/modal focus stays with the host (close/fullscreen via buttons).
  const runTransport = (action: ReturnType<typeof transportActions>["previous"]) => {
    if (action.disabled) { context.ui.toast.show({ message: action.reason ?? `${action.label} unavailable` }); return }
    void action.run()
  }
  const control = (action: () => ReturnType<typeof transportActions>["previous"], cells: number) => <Control renderer={renderer}
    width={Math.min(innerWidth(), cells)} action={{ ...action(), run: () => runTransport(action()) }}
    foreground={text()} muted={muted()} accent={text()} />
  const settings = () => { void lyricsSettingsDialog(props) }

  return <box id="spotify-now-playing" ref={(box) => { root = box; dimensions.ref(box) }} onSizeChange={sync}
    width="100%" height={height()} maxHeight="100%"
    minWidth={0} flexDirection="column" paddingX={1} overflow="hidden">
    <box id="spotify-panel-header" height={1} flexShrink={0} flexDirection="row" minWidth={0} width="100%" overflow="hidden">
      {(() => { const title = hasTrack() ? `${props.state().track!.title} — ${props.state().track!.artist}` : "Spotify · nothing playing"
        return <CellText id="spotify-panel-title" renderer={renderer} width={Math.max(1, innerWidth() - 13)}
          text={title} fg={text()} bold truncate reserve={cellSafety(title)} /> })()}
      <Control action={{ id: "spotify-fullscreen", label: props.presentation === "fullscreen" ? "Exit" : "Full",
        accessibleLabel: props.presentation === "fullscreen" ? "Exit fullscreen" : "Fullscreen", run: props.toggleFullscreen }}
        renderer={renderer} foreground={text()} muted={muted()} accent={text()} width={6} />
      <Control action={{ id: "spotify-close-panel", label: "Close", run: props.close }}
        renderer={renderer} foreground={text()} muted={muted()} accent={text()} width={7} />
    </box>
    <Show when={artHeight() > 0}>
      <box height={gap()} flexShrink={0} />
      <box id="spotify-panel-artwork" width="100%" height={artHeight()} flexShrink={0}
        flexDirection="row" alignItems="center" justifyContent="center">
        <ArtworkView artwork={artwork()} width={artWidth()} height={artHeight()} renderer={renderer} muted={muted()} />
      </box>
      <box height={gap()} flexShrink={0} />
    </Show>
    <Show when={showLyrics()}>
      <LyricsView {...props} chrome="panel" height={lyricsHeight()} settingsAction={settings} />
    </Show>
    <Show when={showTransport()}>
      <box height={gap()} flexShrink={0} />
      <box id="spotify-panel-transport" height={1} flexShrink={0} flexDirection="row" alignItems="center" width="100%">
        <box flexGrow={1} flexBasis={0} flexDirection="row" justifyContent="flex-end">
          <Show when={likeVisible()}><box width={TRANSPORT_WIDTHS.like} /></Show>
        </box>
        <Show when={!compactTransport()}>
          {control(() => actions().previous, TRANSPORT_WIDTHS.previous)}
          <box width={1} />
        </Show>
        {control(() => actions().toggle, TRANSPORT_WIDTHS.toggle)}
        <Show when={!compactTransport()}>
          <box width={1} />
          {control(() => actions().next, TRANSPORT_WIDTHS.next)}
        </Show>
        <box flexGrow={1} flexBasis={0} flexDirection="row" justifyContent="flex-end">
          <Show when={likeVisible()}>{control(() => actions().like, TRANSPORT_WIDTHS.like)}</Show>
        </box>
      </box>
    </Show>
    <Show when={showHints()}>
      <CellText id="spotify-panel-hints" renderer={renderer} width={innerWidth()} fg={muted()}
        text="Scroll to browse · Follow/Settings buttons · Full/Close buttons" truncate />
    </Show>
  </box>
}
