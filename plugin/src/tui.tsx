import { Plugin } from "@opencode/plugin/tui"
import { createSignal, createEffect, createMemo, on } from "solid-js"
import { MiniPlayer } from "./components/MiniPlayer"
import { initialState, positionAt, newerSnapshot, reconciledPosition, type SpotifyState } from "./services/state"
import { SpotifyRpc, stateSchema } from "./rpc"
import { emptyLyrics } from "./services/lyrics"
import type { Lyrics } from "./services/lyrics"
import { musicActions } from "./components/Music"
import { defaultLyricsSettings, validateLyricsSettings, StableLyricsSelection, type LyricsSettings } from "./services/lyrics-source"
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
    let receivedAt = performance.now()
    let lyricGeneration = 0
    let refreshPending: string | null = null
    async function hydrateLyrics(explicit = false, refresh = false) {
      const uri = state().track?.uri
      if (!uri) return
      const generation = ++lyricGeneration
      const config = settings()
      try {
        const value = await rpc.getLyricsSources({ uri, lrclib: config.lrclibEnabled, contact: config.lrclibContact, refresh },
          { location: context.location ?? context.data.location.default() })
        if (!active || generation !== lyricGeneration || value.uri !== state().track?.uri) return
        setSources(value)
        const next = selection.choose(uri, value.candidates, settings(), explicit || refreshPending === uri)
        if (next) {
          if (next.id !== lyrics().id) refreshPending = null
          setLyrics((previous) => previous.id === next.id && previous.selectionNote === next.selectionNote ? previous : next)
        } else if (lyrics().uri !== uri || lyrics().status !== "ready") {
          const loading = value.availability.some((provider) => provider.detail === "Waiting for Spotify lyrics")
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
      refreshPending = uri
      if (state().capabilities?.commands.includes("refresh_lyrics")) {
        const result = await rpc.command({ command: "refresh_lyrics", params: {} }, { location: context.location ?? context.data.location.default() })
        if (!result.ok) context.ui.toast.show({ message: result.error.message, variant: "error" })
      }
      await hydrateLyrics(true, true)
    }
    function adopt(next: SpotifyState) {
      if (!active || !newerSnapshot(state(), next)) return
      const lyricsChanged = next.epoch !== state().epoch || next.lyricsRevision !== state().lyricsRevision || next.track?.uri !== state().track?.uri
      const clockChanged = next.epoch !== state().epoch || next.playback.updatedAt !== state().playback.updatedAt ||
        next.playback.trackUri !== state().playback.trackUri
      if (clockChanged) receivedAt = performance.now()
      setState(next)
      if (clockChanged) setPosition(reconciledPosition(position(), lyrics().uri, next))
      if (lyricsChanged) {
        if (next.track && lyrics().uri !== next.track.uri) {
          selection.choose(next.track.uri, [], settings())
          setLyrics(emptyLyrics(next.track.uri)); setSources(null)
        } else if (!next.track && next.connection === "connected") {
          lyricGeneration++; selection.choose(null, [], settings()); setLyrics(emptyLyrics()); setSources(null)
        }
        if (next.track) void hydrateLyrics()
      }
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
        if (attempt < 9) retry = setTimeout(() => sync(attempt + 1), 1000)
        else if (version === requestedVersion) setState({ ...initialState(), connection: "error", error: "Spotify service unavailable" })
      })
    }
    sync()
    const reconnect = context.data.on("server.connected", () => { subscribe(); sync() })
    createEffect(() => {
      const playback = state().playback
      const playing = state().connection === "connected" && playback.isPlaying && playback.durationMs > playback.positionMs
      if (tick) clearInterval(tick)
      const cadence = lyrics().format === "word" ? 100 : 250
      tick = playing ? setInterval(() => {
        const now = performance.now()
        const ms = positionAt(playback, receivedAt, now)
        setPosition(ms)
        if (ms >= playback.durationMs || now - receivedAt >= 10_000) { clearInterval(tick); tick = undefined }
      }, cadence) : undefined
    })
    const sourcePreferences = createMemo(() => JSON.stringify([settings().provider, settings().script, settings().priority, settings().lrclibEnabled, settings().lrclibContact, settings().overrides]))
    createEffect(on(sourcePreferences, () => { void hydrateLyrics(true) }, { defer: true }))
    const props = { context, rpc, state, position, lyrics, settings, saveSettings, sources, refreshLyrics }
    const music = musicActions(props)
    const remove = context.ui.slot({
      append: "sidebar.content",
      render: () => <MiniPlayer {...props} open={() => void music.open()} openLyrics={() => music.lyrics()}
        openSettings={() => void music.settings()} more={() => void music.playback()} run={music.run} />,
    })
    context.keymap.layer(() => ({
      mode: "global",
      commands: [{
        id: "spotify.music",
        title: "Open Music",
        group: "Spotify",
        palette: true,
        run: music.open,
      },
      { id: "spotify.lyrics", title: "Spotify: Open Lyrics", palette: true, run: music.lyrics },
      { id: "spotify.lyrics.settings", title: "Spotify: Lyrics Settings", palette: true, run: music.settings },
      { id: "spotify.queue", title: "Spotify: Open Queue", palette: true, enabled: () => music.supported("get_queue"), run: music.queue },
      { id: "spotify.search", title: "Spotify: Search", palette: true, enabled: () => music.supported("search"), run: music.search },
      { id: "spotify.refresh", title: "Spotify: Refresh state", palette: true, run: async () => { await music.run("get_playback") } },
      ...(["toggle_play", "next", "previous"] as const).map((command) => ({
        id: `spotify.${command}`, title: `Spotify: ${command.replace("_", " ")}`, palette: true as const,
        enabled: () => music.supported(command), run: async () => { await music.run(command) },
      })),
      { id: "spotify.shuffle", title: "Spotify: Toggle Shuffle", palette: true, enabled: () => music.supported("set_shuffle") && state().playback.shuffle !== null, run: async () => { await music.run("set_shuffle", { value: !state().playback.shuffle }) } },
      { id: "spotify.repeat", title: "Spotify: Cycle Repeat", palette: true, enabled: () => music.supported("set_repeat") && state().playback.repeat !== null, run: async () => { await music.run("set_repeat", { value: (state().playback.repeat! + 1) % 3 }) } },
      { id: "spotify.like", title: "Spotify: Like / Unlike current track", palette: true,
        enabled: () => music.supported("set_liked") && state().playback.liked !== null && !!state().track?.uri.startsWith("spotify:track:"),
        run: async () => { await music.run("set_liked", { uri: state().track?.uri, value: !state().playback.liked }) } },
      ],
    }))
    return () => { active = false; if (retry) clearTimeout(retry); if (tick) clearInterval(tick); music.dispose(); reconnect(); unsubscribe(); remove() }
  },
})
