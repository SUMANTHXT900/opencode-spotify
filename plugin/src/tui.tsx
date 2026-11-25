import { Plugin } from "@opencode/plugin/tui"
import { batch, createSignal, createEffect, createMemo, on, Show } from "solid-js"
import { MiniPlayer } from "./components/MiniPlayer"
import { NowPlayingPanel } from "./components/NowPlayingPanel"
import { initialState, positionAt, newerSnapshot, reconciledPosition, type SpotifyState } from "./services/state"
import { playback } from "./services/validation"
import { holdCleared, mergePlayback, extrapolatePosition, SEEK_HOLD_MS, type SeekHold } from "./services/playback-sync"
import { SpotifyRpc, stateSchema } from "./rpc"
import { emptyLyrics } from "./services/lyrics"
import type { Lyrics } from "./services/lyrics"
import { musicActions } from "./components/Music"
import { defaultLyricsSettings, validateLyricsSettings, StableLyricsSelection, isAuthoritativeEmpty, isSourceWaiting, type LyricsSettings } from "./services/lyrics-source"
import type { SourceResolution } from "./services/LyricsSourceManager"

export default Plugin.define({
  id: "opencode-spotify.tui",
  setup(context) {
    const [state, setState] = createSignal<SpotifyState>(initialState())
    const [lyrics, setLyrics] = createSignal<Lyrics>(emptyLyrics())
    const [position, setPosition] = createSignal(0)
    const [sources, setSources] = createSignal<SourceResolution | null>(null)
    const [stored, updateSettings] = context.storage.store<LyricsSettings>("lyrics-v0.4", { initial: defaultLyricsSettings() })
    const settings = createMemo(() => { try { return validateLyricsSettings(stored) } catch { return defaultLyricsSettings() } })
    const selection = new StableLyricsSelection()
    const rpc = context.client.rpc(SpotifyRpc)
    let version = 0
    let active = true
    let retry: ReturnType<typeof setTimeout> | undefined
    let tick: ReturnType<typeof setInterval> | undefined
    let poll: ReturnType<typeof setInterval> | undefined
    let receivedAt = performance.now()
    let lyricGeneration = 0
    let trackOccurrence = 0
    let refreshPending: string | null = null
    // Optimistic local seek: holds the rendered position until the bridge
    // acknowledges, so pre-seek progress echoes cannot overwrite the target.
    let seekHold: SeekHold | null = null
    let lastPoll = 0
    const previewSeek = (positionMs: number) => {
      seekHold = { targetMs: Math.max(0, positionMs), startedWallMs: Date.now(), startedMonoMs: performance.now() }
      setPosition(seekHold.targetMs)
    }
    async function hydrateLyrics(explicit = false, refresh = false) {
      const uri = state().track?.uri
      if (!uri) return
      const generation = ++lyricGeneration
      const config = settings()
      try {
        const value = await rpc.getLyricsSources({ uri, lrclib: config.lrclibEnabled, contact: config.lrclibContact, refresh },
          { location: context.location ?? context.data.location.default() })
        if (!active || generation !== lyricGeneration || value.uri !== uri || uri !== state().track?.uri) return
        setSources(value)
        const next = selection.choose(uri, value.candidates, settings(), explicit || refreshPending === uri)
        if (next) {
          // Pending refresh is scoped to this track occurrence: only a
          // changed selection for the same URI consumes it.
          if (refreshPending === uri && next.id !== lyrics().id) refreshPending = null
          setLyrics((previous) => previous.id === next.id && previous.selectionNote === next.selectionNote ? previous : next)
        } else if (lyrics().uri !== uri || lyrics().status !== "ready" || isAuthoritativeEmpty(value)) {
          // Authoritative empty (resolved, zero candidates, no
          // ready/error/waiting provider) clears a stale ready document.
          // Waiting, error, and transport-failure paths below retain it.
          const loading = value.availability.some(isSourceWaiting)
          setLyrics({ ...emptyLyrics(uri), status: loading ? "loading" : "unavailable" })
        }
      } catch {
        // A transport failure never erases an already loaded document.
        if (active && generation === lyricGeneration && lyrics().status !== "ready") setLyrics({ ...emptyLyrics(uri), status: "unavailable" })
      }
    }
    const saveSettings = async (value: LyricsSettings) => {
      const valid = validateLyricsSettings(value)
      await updateSettings((draft) => { Object.assign(draft, valid) })
    }
    const refreshLyrics = async () => {
      const uri = state().track?.uri
      if (!uri) return
      const occurrence = trackOccurrence
      refreshPending = uri
      if (state().capabilities?.commands.includes("refresh_lyrics")) {
        const result = await rpc.command({ command: "refresh_lyrics", params: {} }, { location: context.location ?? context.data.location.default() })
        if (!active || occurrence !== trackOccurrence) return
        if (!result.ok) context.ui.toast.show({ message: result.error.message, variant: "error" })
      }
      // URI alone is insufficient: the user can leave A and return to A
      // while the refresh command for the first occurrence is still pending.
      if (!active || occurrence !== trackOccurrence) return
      await hydrateLyrics(true, true)
    }
    function adopt(next: SpotifyState) {
      if (!active || !newerSnapshot(state(), next)) return
      const trackSwitched = next.track?.uri !== state().track?.uri
      const epochChanged = next.epoch !== state().epoch
      if (trackSwitched || epochChanged) {
        seekHold = null
        refreshPending = null
        trackOccurrence++
        lyricGeneration++
      }
      const lyricsChanged = epochChanged || next.lyricsRevision !== state().lyricsRevision || trackSwitched
      const clockChanged = trackSwitched || epochChanged || next.playback.updatedAt !== state().playback.updatedAt ||
        next.playback.trackUri !== state().playback.trackUri
      batch(() => {
        setState(next)
        if (clockChanged) {
          const now = performance.now()
          const echo = { positionMs: next.playback.positionMs, updatedAt: next.playback.updatedAt }
          if (!seekHold || holdCleared(seekHold, echo, now)) {
            seekHold = null
            receivedAt = now
            setPosition(reconciledPosition(position(), lyrics().uri, next))
          }
        }
        if (!lyricsChanged) return
        if (next.track && lyrics().uri !== next.track.uri) {
          selection.choose(next.track.uri, [], settings())
          setLyrics(emptyLyrics(next.track.uri)); setSources(null)
        } else if (!next.track && next.connection === "connected") {
          lyricGeneration++; selection.choose(null, [], settings()); setLyrics(emptyLyrics()); setSources(null)
        }
      })
      if (lyricsChanged && next.track) void hydrateLyrics()
    }
    let unsubscribe = () => {}
    function subscribe() {
      unsubscribe()
      unsubscribe = rpc.events.on("updated", (event) => {
        if (!active || event.location.directory !== (context.location ?? context.data.location.default()).directory) return
        version++
        const result = stateSchema["~standard"].validate(event.data.state)
        if ("value" in result) adopt(result.value)
      })
    }
    subscribe()
    const sync = (attempt = 0) => {
      const requestedVersion = version
      void rpc.getState({}, { location: context.location ?? context.data.location.default() }).then((value) => {
        if (active && version === requestedVersion) adopt(value)
      }).catch(() => {
        if (!active) return
        // B10: the bridge may not be ready when the TUI first mounts
        // (Spotify/bridge startup order, credential provisioning, RPC
        // readiness). Retry with backoff before surfacing an error; the
        // server.connected resubscribe below recovers later restarts.
        // Authenticated loopback security is unchanged: retries are
        // read-only getState calls, never credential writes.
        if (attempt < 12) retry = setTimeout(() => sync(attempt + 1), attempt < 6 ? 1000 : 2000)
        else if (version === requestedVersion) setState({ ...initialState(), connection: "error", error: "Spotify service unavailable" })
      })
    }
    sync()
    const reconnect = context.data.on("server.connected", () => { subscribe(); sync() })
    // Bounded authoritative refresh: recovers missed progress events without
    // lyric-network traffic. Throttled; drops stale echoes via mergePlayback.
    async function refreshPlayback() {
      if (!active || state().connection !== "connected") return
      const now = performance.now()
      if (now - lastPoll < 1500) return
      lastPoll = now
      try {
        const result = await rpc.command({ command: "get_playback", params: {} },
          { location: context.location ?? context.data.location.default() })
        if (!active || !result.ok) return
        const incoming = playback(result.result)
        if (incoming.trackUri !== state().track?.uri) { sync(); return }
        if (seekHold) {
          if (!holdCleared(seekHold, { positionMs: incoming.positionMs, updatedAt: incoming.updatedAt }, performance.now())) return
        }
        const merged = mergePlayback(state().playback, incoming)
        if (!merged) return
        seekHold = null
        receivedAt = performance.now()
        setState({ ...state(), playback: merged })
        setPosition(reconciledPosition(position(), lyrics().uri, { ...state(), playback: merged }))
      } catch { /* the next poll recovers */ }
    }
    createEffect(() => {
      const track = state().track
      const playing = state().connection === "connected" && state().playback.isPlaying === true &&
        (state().playback.durationMs <= 0 || state().playback.durationMs > state().playback.positionMs)
      if (tick) clearInterval(tick)
      const cadence = lyrics().format === "word" ? 100 : 250
      // Slow reconcile while connected recovers events the push channel missed.
      if (poll) clearInterval(poll)
      poll = state().connection === "connected" ? setInterval(() => { void refreshPlayback() }, 2000) : undefined
      const anchor = { ...state().playback }
      tick = playing ? setInterval(() => {
        const now = performance.now()
        if (seekHold && now - seekHold.startedMonoMs < SEEK_HOLD_MS) {
          setPosition(seekHold.targetMs)
          return
        }
        if (seekHold) {
          const held = seekHold
          seekHold = null
          // Seed the extrapolation from the optimistic target instead of the
          // pre-seek anchor, then ask for an authoritative sample.
          anchor.positionMs = held.targetMs
          anchor.isPlaying = state().playback.isPlaying
          receivedAt = now
          void refreshPlayback()
        }
        if (now - receivedAt >= 10_000 && (anchor.durationMs <= 0 || position() < anchor.durationMs)) {
          void refreshPlayback()
        }
        const ms = extrapolatePosition(anchor, receivedAt, now)
        setPosition(ms)
        if (anchor.durationMs > 0 && ms >= anchor.durationMs) { clearInterval(tick); tick = undefined }
      }, cadence) : undefined
    })
    const sourcePreferences = createMemo(() => JSON.stringify([settings().provider, settings().script, settings().priority, settings().lrclibEnabled, settings().lrclibContact, settings().overrides]))
    createEffect(on(sourcePreferences, () => { void hydrateLyrics(true) }, { defer: true }))
    const props = { context, rpc, state, position, lyrics, settings, saveSettings, sources, refreshLyrics, previewSeek }
    const music = musicActions(props)
    const remove = context.ui.slot({
      // V0.5.4 adaptive positioning: single pinned footer claim. The host
      // publishes no section-height signal (sidebar slots carry sessionID
      // only), so Todo/MCP/Context expansion cannot be observed directly.
      // Dynamic content<->footer switching would remount the Solid tree on
      // every Todo toggle (focus loss, artwork reload, keymap rebind,
      // oscillation). Instead the footer stays pinned and MiniPlayer adapts
      // its budget with settle + hysteresis: roomy/medium/tight/very-tight
      // degrade art first, then gaps, then lyrics 5->3->1, keeping transport
      // and navigation reachable. State (signals, storage, rpc) lives in this
      // setup closure, so mode changes never duplicate subscriptions.
      prepend: "sidebar.footer",
      render: () => <box id="spotify-sidebar-slot" width="100%" minWidth={0} overflow="hidden" flexDirection="column">
        <MiniPlayer {...props} open={() => void music.open()} openLyrics={() => music.panel()}
          openSettings={() => void music.settings()} more={() => void music.playback()} run={music.run} />
      </box>,
    })
    const removePanel = context.ui.slot({
      append: "session.panel",
      render: (input) => <Show when={input.name === "spotify"}>
        <NowPlayingPanel {...props} run={music.run} width={input.width}
          close={input.close} toggleFullscreen={input.toggleFullscreen} presentation={input.presentation} />
      </Show>,
    })
    // Pointer-only: all Spotify operations are reachable via MiniPlayer buttons
    // (Music/Lyrics/More, transport, mute, sliders, settings) and host-native
    // dialogs (Music for Queue/Playlists/Library/Search/Refresh, More for
    // Play/Pause/Seek/Shuffle/Repeat/Volume/Mute/Like). No custom key
    // interception; host owns dialog/panel/modal focus and text entry.
    return () => { active = false; if (retry) clearTimeout(retry); if (tick) clearInterval(tick); if (poll) clearInterval(poll); music.dispose(); reconnect(); unsubscribe(); removePanel(); remove() }
  },
})
