import { createEffect, createMemo, createSignal, Index, on, onCleanup, onMount, Show } from "solid-js"
import { RGBA, type BoxRenderable, type TerminalCapabilities } from "@opentui/core"
import type { BridgeCommand } from "../services/protocol"
import { formatTime, connectionLabel } from "../services/state"
import { CellText, Control, cellMeasure, terminalSize, useDimensions, type ControlAction } from "../ui/primitives"
import { albumColors, lyricColors, mix } from "../ui/colors"
import { playerActions } from "../ui/player-actions"
import { ArtworkView, useArtwork } from "./ArtworkView"
import { LyricCarousel } from "./LyricCarousel"
import { PlaybackSlider, type PlaybackSliderHandle } from "./PlaybackSlider"
import type { MusicProps } from "./Music"

export interface MiniPlayerProps extends MusicProps {
  open: () => void
  openLyrics: () => void
  openSettings: () => void
  more: () => void
  run: (command: BridgeCommand, params?: Record<string, unknown>) => Promise<boolean | void>
}

export function MiniPlayer(props: MiniPlayerProps) {
  const { context } = props
  const renderer = context.renderer
  const measure = cellMeasure(renderer)
  const dimensions = useDimensions()
  const terminal = terminalSize(renderer)
  const width = () => Math.max(1, dimensions.width() - 2)
  const [top, setTop] = createSignal(0)
  const [allocated, setAllocated] = createSignal<number>()
  let root: BoxRenderable | undefined
  let seek: PlaybackSliderHandle | undefined, volume: PlaybackSliderHandle | undefined
  const [focused, setFocused] = createSignal(false)
  const [selected, select] = createSignal("spotify-toggle")
  const [busy, setBusy] = createSignal<string | null>(null)
  const [seekPreview, setSeekPreview] = createSignal<number>()
  const [volumePreview, setVolumePreview] = createSignal<number>()
  const [caps, setCaps] = createSignal(renderer.capabilities)
  const state = props.state
  const settings = props.settings
  const playback = () => state().playback
  const hasTrack = () => !!state().track
  const connected = () => state().connection === "connected"
  const supported = (command: BridgeCommand) => connected() && !!state().capabilities?.commands.includes(command)
  const seekEnabled = () => hasTrack() && supported("seek") && playback().durationMs > 0
  const volumeEnabled = () => supported("set_volume") && playback().volume !== null
  const identity = () => [state().epoch, state().connection, state().track?.uri].join("|")
  const snapshot = () => state().revision

  const artRows = () => settings().artworkSize === "small" ? 4 : Math.min(10, Math.max(4, Math.floor((width() - 8) / 4)))
  const lyricRows = () => !settings().preview || !hasTrack() ? 0 : props.lyrics().synced ? (width() >= 38 ? 11 : 8) : 2
  const preferred = () => Math.min(Math.max(1, terminal().height - top()), 3 + (hasTrack() ? 3 : 0) +
    (settings().showVolume && connected() ? 1 : 0) + (settings().artwork && hasTrack() ? artRows() : 0) + lyricRows())
  const rows = () => Math.min(preferred(), allocated() ?? preferred())
  const showHeader = () => rows() >= 3
  const showMeta = () => rows() >= 4
  const showArtist = () => showMeta() && hasTrack() && rows() >= 7
  const showSeek = () => hasTrack() && width() >= 14 && rows() >= 5
  const showVolume = () => settings().showVolume && connected() && width() >= 14 && rows() >= 8
  const showNavigation = () => rows() >= 2
  const remaining = () => Math.max(0, rows() - 1 - Number(showHeader()) - Number(showMeta()) - Number(showArtist())
    - Number(showSeek()) - Number(showVolume()) - Number(showNavigation()))
  const coverHeight = () => settings().artwork && hasTrack() && width() >= 12 && remaining() >= 3
    ? Math.min(artRows(), remaining() - (lyricRows() > 0 && remaining() > 4 ? Math.min(5, Math.floor(remaining() / 2)) : 0)) : 0
  const coverWidth = () => {
    terminal(); caps()
    const pixels = renderer.resolution
    const aspect = pixels ? (pixels.height / renderer.height) / (pixels.width / renderer.width) : 2
    return Math.max(1, Math.min(width() - (flank() ? 10 : 0), Math.round(coverHeight() * aspect)))
  }
  const previewHeight = () => Math.min(lyricRows(), Math.max(0, remaining() - coverHeight()))
  const flank = () => coverHeight() > 0 && width() >= 27

  const artwork = useArtwork(() => state().track?.image ?? "", () => coverHeight() > 0 ||
    hasTrack() && rows() >= 7 && settings().ambience !== "theme" && caps()?.rgb === true)
  const artworkData = createMemo(() => {
    const cover = artwork()
    return cover.kind === "ready" ? cover.data : undefined
  })
  const themePalette = () => ({
    ...lyricColors(context.theme.text.base, context.theme.text.action.primary.base, settings().accent),
    text: context.theme.text.base, muted: context.theme.text.muted,
    active: settings().accent || context.theme.text.action.primary.base,
  })
  const desiredPalette = createMemo(() => {
    const art = artworkData()
    return art && settings().ambience !== "theme" && caps()?.rgb === true
      ? albumColors(context.theme.text.base, context.theme.text.action.primary.base, art.accent, settings().accent) : undefined
  })
  const palette = () => desiredPalette() ?? themePalette()
  const [tint, setTint] = createSignal(0)
  createEffect(on(() => [desiredPalette(), settings().reducedMotion] as const, ([colors, reduced]) => {
    if (!colors || reduced) { setTint(colors ? 1 : 0); return }
    setTint(0)
    const start = performance.now()
    const interval = setInterval(() => {
      const fraction = Math.min(1, (performance.now() - start) / 220)
      setTint(fraction)
      if (fraction === 1) clearInterval(interval)
    }, 44)
    onCleanup(() => clearInterval(interval))
  }))
  const swatches = createMemo(() => {
    const colors = desiredPalette()
    const artworkColors = artworkData()?.ambient
    if (!colors || !artworkColors) return []
    const background = mix(themePalette().background, colors.background, tint())
    return artworkColors.map((color) => settings().ambience === "artwork"
      ? mix(background, RGBA.fromInts(...color), tint() * 0.12) : background)
  })

  const actions = createMemo(() => playerActions(state(), 0, props.run))
  const named = (action: ControlAction, label: string, accessibleLabel: string) => ({ ...action, label, accessibleLabel })
  const prev = () => named(actions()[0]!, "◀◀", "Previous track")
  const play = () => named(actions()[1]!, playback().isPlaying ? "Ⅱ Pause" : "▶ Play", playback().isPlaying ? "Pause playback" : "Resume playback")
  const next = () => named(actions()[2]!, "▶▶", "Next track")
  const like = () => named(actions()[3]!, playback().liked ? "♥" : "♡", playback().liked ? "Unlike current track" : "Like current track")
  const mute = () => named(actions()[6]!, playback().muted ? "Vol×" : "Vol", playback().muted ? "Unmute" : "Mute")
  const settingsAction = (): ControlAction => ({
    id: "spotify-settings", label: measure("⚙") === 1 ? "⚙" : "Cfg", accessibleLabel: "Spotify settings", run: props.openSettings,
  })
  const navigation: ControlAction[] = [
    { id: "spotify-music", label: "Music", run: props.open },
    { id: "spotify-lyrics", label: "Lyrics", run: props.openLyrics },
    { id: "spotify-more", label: "More", accessibleLabel: "More playback controls", run: props.more },
  ]
  const shownNav = () => width() >= 21 ? navigation : width() >= 13 ? [navigation[0]!, navigation[2]!] : [navigation[2]!]
  const visible = createMemo<ControlAction[]>(() => [
    ...(showHeader() && width() >= 9 ? [settingsAction()] : []),
    ...(width() >= 17 ? [prev(), play(), next()] : [play()]),
    ...(width() >= 21 ? [like()] : []),
    ...(showSeek() ? [{ id: "spotify-timeline", label: "Seek", disabled: !seekEnabled(), run: () => {} }] : []),
    ...(showVolume() ? [mute(), { id: "spotify-volume", label: "Volume", disabled: !volumeEnabled(), run: () => {} }] : []),
    ...(showNavigation() ? shownNav() : []),
  ])
  const focusAction = () => visible().find((action) => action.id === selected()) ?? play()
  const engage = (id: string) => { root?.focus(); setFocused(true); select(id) }
  const closeFocus = () => { seek?.cancel(); volume?.cancel(); root?.blur(); setFocused(false) }
  const cycle = (delta: number) => {
    const controls = visible()
    const index = controls.findIndex((action) => action.id === focusAction().id)
    select(controls[(index + controls.length + delta) % controls.length]!.id)
  }
  const invoke = async (id: string, action: () => boolean | void | Promise<boolean | void>) => {
    if (busy()) return false
    setBusy(id)
    try { return await action() } finally { setBusy(null) }
  }
  const activate = () => {
    const action = focusAction()
    if (action.disabled) {
      context.ui.toast.show({ message: action.reason ?? `${action.label} unavailable` })
      return
    }
    void invoke(action.id, action.run)
  }
  const slider = () => focusAction().id === "spotify-timeline" ? seek : focusAction().id === "spotify-volume" ? volume : undefined
  const step = () => focusAction().id === "spotify-volume" ? 0.05 : 1000 * (settings().seekSeconds ??
    (typeof context.options.seekSeconds === "number" && Number.isFinite(context.options.seekSeconds)
      ? Math.min(120, Math.max(1, context.options.seekSeconds)) : 10))
  context.keymap.layer(() => ({
    target: () => root,
    commands: [
      { bind: "tab", run: () => cycle(1) }, { bind: "shift+tab", run: () => cycle(-1) },
      { bind: "return", run: activate }, { bind: "space", run: activate },
      { bind: "left", enabled: () => !!slider(), run: () => slider()?.adjust(-step()) },
      { bind: "right", enabled: () => !!slider(), run: () => slider()?.adjust(step()) },
      { bind: "home", enabled: () => !!slider(), run: () => slider()?.start() },
      { bind: "end", enabled: () => !!slider(), run: () => slider()?.end() },
      { bind: "escape", run: closeFocus },
    ],
  }))
  context.keymap.layer(() => ({ mode: "global", commands: [
    { id: "spotify.focus", title: "Spotify: Focus player controls", palette: true, run: () => engage("spotify-toggle") },
  ] }))
  const sync = () => {
    dimensions.sync()
    if (!root) return
    setTop(Math.max(0, root.y))
    if (root.height > 0) setAllocated(root.height)
  }
  onMount(() => {
    const focus = () => setFocused(true)
    const blur = () => setFocused(false)
    const updateCaps = (value: TerminalCapabilities) => setCaps(value)
    root?.on("focused", focus); root?.on("blurred", blur); renderer.root.on("layout-changed", sync)
    renderer.on("capabilities", updateCaps)
    onCleanup(() => {
      root?.off("focused", focus); root?.off("blurred", blur); renderer.root.off("layout-changed", sync)
      renderer.off("capabilities", updateCaps)
    })
  })
  const isFocused = (id: string) => focused() && focusAction().id === id
  const control = (action: () => ControlAction, cells?: number) => <Control renderer={renderer}
    width={Math.min(width(), cells ?? measure(action().label) + 2)}
    action={{ ...action(), run: () => action().disabled ? undefined : invoke(action().id, action().run).then(() => {}) }}
    foreground={palette().text} muted={palette().muted} accent={palette().active}
    busy={busy() === action().id} focused={isFocused(action().id)} focus={() => engage(action().id)} />
  const elapsed = () => formatTime(seekPreview() ?? props.position())
  const end = () => formatTime(playback().durationMs)
  const timeCells = () => Math.min(Math.max(4, measure(end())), Math.max(4, Math.floor((width() - 3) / 2)))
  const seekWidth = () => Math.max(1, width() - 2 * timeCells() - 2)
  const playMotion = () => connected() && playback().isPlaying === true && settings().progressMotion
  return <box id="spotify-player" ref={(box) => { root = box; dimensions.ref(box) }} onSizeChange={sync}
    width="100%" height={preferred()} maxHeight="100%" minWidth={0} minHeight={0} flexShrink={1}
    flexDirection="column" paddingX={1} overflow="hidden" focusable>
    <Show when={swatches().length > 0}>
      <box position="absolute" zIndex={-1} left={0} right={0} top={0} bottom={0} flexDirection="column">
        <Index each={[0, 1, 2]}>{(row) => <box flexDirection="row" flexGrow={1}>
          <Index each={[0, 1, 2, 3]}>{(col) => <box flexGrow={1} backgroundColor={swatches()[row() * 4 + col()]} />}</Index>
        </box>}</Index>
      </box>
    </Show>
    <Show when={showHeader()}><box flexDirection="row" alignItems="center" height={1} flexShrink={0}>
      <CellText renderer={renderer} width={Math.max(1, width() - (width() >= 9 ? 5 : 0))}
        text={focused() ? focusAction().accessibleLabel ?? focusAction().label : `Spotify ${connectionLabel(state())}`}
        fg={palette().muted} truncate />
      <Show when={width() >= 9}>{control(settingsAction, 5)}</Show>
    </box></Show>
    <Show when={coverHeight() > 0}>
      <box width="100%" height={coverHeight()} flexDirection="row" alignItems="center" justifyContent="center" flexShrink={0}>
        <Show when={flank()}>{control(prev, 5)}</Show>
        <ArtworkView artwork={artwork()} width={coverWidth()} height={coverHeight()} renderer={renderer} muted={palette().muted} />
        <Show when={flank()}>{control(next, 5)}</Show>
      </box>
    </Show>
    <box width="100%" flexDirection="row" height={1} justifyContent="center" flexShrink={0}>
      <Show when={!flank() && width() >= 17}>{control(prev, 4)}</Show>
      {control(play, 9)}
      <Show when={!flank() && width() >= 17}>{control(next, 4)}</Show>
      <Show when={width() >= 21}>{control(like, 4)}</Show>
    </box>
    <Show when={showMeta()}>
      <CellText renderer={renderer} width={width()} text={state().track?.title || (connected() ? "Nothing playing" : "Open Spotify to begin")}
        fg={palette().text} bold truncate center />
    </Show>
    <Show when={showArtist()}><CellText renderer={renderer} width={width()} text={state().track?.artist ?? ""}
      fg={palette().muted} truncate center /></Show>
    <Show when={showSeek()}>
      <box width="100%" flexDirection="row" height={1} flexShrink={0}>
        <CellText renderer={renderer} width={timeCells() + 1} text={elapsed()} fg={palette().muted} truncate />
        <PlaybackSlider id="spotify-timeline" ref={(handle) => { seek = handle }} width={seekWidth()}
          renderer={renderer} value={props.position()} max={playback().durationMs} disabled={!seekEnabled()}
          identity={identity()} snapshot={snapshot()} focused={isFocused("spotify-timeline")}
          foreground={palette().text} muted={palette().muted} accent={palette().active}
          playing={playMotion()} reducedMotion={settings().reducedMotion} onPreview={setSeekPreview}
          onFocus={() => engage("spotify-timeline")}
          onCommit={(positionMs) => invoke("spotify-timeline", () => props.run("seek", { positionMs: Math.round(positionMs) }))} />
        <CellText renderer={renderer} width={timeCells() + 1} text={` ${end()}`} fg={palette().muted} truncate />
      </box>
    </Show>
    <Show when={showVolume()}>
      <box width="100%" flexDirection="row" height={1} flexShrink={0}>
        {control(mute, 6)}
        <PlaybackSlider id="spotify-volume" ref={(handle) => { volume = handle }} width={Math.max(1, width() - 11)}
          renderer={renderer} value={playback().volume ?? 0} max={1} disabled={!volumeEnabled()}
          identity={identity()} snapshot={snapshot()} focused={isFocused("spotify-volume")}
          foreground={palette().text} muted={palette().muted} accent={palette().active} onPreview={setVolumePreview}
          onFocus={() => engage("spotify-volume")} onCommit={(value) => invoke("spotify-volume", () => props.run("set_volume", { value }))} />
        <CellText renderer={renderer} width={5} text={playback().volume === null ? "  —" : ` ${Math.round(100 * (volumePreview() ?? playback().volume!))}%`}
          fg={palette().muted} truncate />
      </box>
    </Show>
    <Show when={showNavigation()}><box flexDirection="row" height={1} width="100%" justifyContent="center" flexShrink={0}>
      <Index each={shownNav()}>{(action) => control(action)}</Index>
    </box></Show>
    <Show when={previewHeight() > 0}><LyricCarousel {...props} width={width()} height={previewHeight()} palette={desiredPalette()} /></Show>
  </box>
}

