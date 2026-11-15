import type { Context } from "@opencode/plugin/tui/context"
import type { Accessor } from "solid-js"
import { SpotifyRpc, type Lyrics, type BridgeQueue, type PlaylistNode, type TrackPage } from "../rpc"
import type { BridgeCommand, QueueTrack } from "../services/protocol"
import { formatTime, type SpotifyState } from "../services/state"
import type { LyricsSettings } from "../services/lyrics-source"
import type { SourceResolution } from "../services/LyricsSourceManager"
import { LyricsView } from "./LyricsView"
import { lyricsSettingsDialog } from "./LyricsSettings"
import { truncateCells } from "../ui/layout"
import { cellMeasure } from "../ui/primitives"
import { uidValid } from "../services/validation"

const spotifyClient = (client: Context["client"]) => client.rpc(SpotifyRpc)
export interface MusicProps {
  context: Context
  rpc: ReturnType<typeof spotifyClient>
  state: Accessor<SpotifyState>
  position: Accessor<number>
  lyrics: Accessor<Lyrics>
  settings: Accessor<LyricsSettings>
  saveSettings: (settings: LyricsSettings) => Promise<void>
  sources: Accessor<SourceResolution | null>
  refreshLyrics: () => Promise<void>
}

// A hierarchy of SDK-provided dialogs, not a simulated tab UI.
export function musicActions(props: MusicProps) {
  const { context, rpc, state } = props
  let disposed = false
  let generation = 0
  const supported = (command: BridgeCommand) => state().connection === "connected" && !!state().capabilities?.commands.includes(command)
  async function request<T = unknown>(command: BridgeCommand, params: Record<string, unknown> = {}): Promise<T> {
    const requested = generation
    if (["get_playlists", "get_playlist_tracks", "get_library", "search", "get_queue"].includes(command)) context.ui.toast.show({ message: "Loading Spotify…", duration: 3000 })
    const response = await rpc.command({ command, params }, { location: context.location ?? context.data.location.default() })
    if (disposed || requested !== generation) throw new Error("Music view superseded")
    if (!response.ok) throw new Error(response.error.message)
    return response.result as T
  }
  async function run(command: BridgeCommand, params: Record<string, unknown> = {}) {
    try { await request(command, params); return true }
    catch (error) { if (!disposed) context.ui.toast.show({ message: error instanceof Error ? error.message : "Spotify action failed", variant: "error" }); return false }
  }
  const select = async (title: string, rows: { title: string; value: string; description?: string; disabled?: boolean; category?: string }[], current?: string) => {
    if (disposed) return undefined
    const fit = (value: string) => truncateCells(value, Math.max(1, Math.min(60, context.renderer.width - 10)), cellMeasure(context.renderer))
    const choice = await context.ui.dialog.select({ title: fit(title),
      options: [...rows.map((row) => ({ ...row, title: fit(row.title), description: row.description ? fit(row.description) : undefined })),
        { title: "Back", value: "__back" }], current })
    return choice === "__back" ? undefined : choice
  }

  async function playback() {
    const selectedUri = state().track?.uri
    const options: [string, BridgeCommand][] = [
      ["Play", "play"], ["Pause", "pause"], ["Play / Pause", "toggle_play"],
      ["Previous track", "previous"], ["Next track", "next"],
      ["Seek to seconds…", "seek"], ["Back", "seek"], ["Forward", "seek"],
      ["Shuffle", "set_shuffle"], ["Repeat", "set_repeat"],
      ["Volume…", "set_volume"], ["Volume +5%", "set_volume"], ["Volume −5%", "set_volume"],
      ["Mute / Unmute", "set_mute"], ["Like / Unlike current track", "set_liked"],
    ]
    const choice = await select(`Now Playing · ${state().track?.title || "Not connected"}`, [
      { title: state().track?.artist || "No artist", description: state().track?.album || "", value: "metadata", disabled: true },
      { title: `${formatTime(state().playback.durationMs)} · ${state().playback.isPlaying ? "Playing" : "Paused"}`, description: state().track?.image ? "Album artwork available" : "No album artwork", value: "uri", disabled: true },
      ...options.map(([title, cmd]) => ({
      title, value: title, disabled: !supported(cmd) ||
        (title === "Volume +5%" || title === "Volume −5%") && state().playback.volume === null ||
        cmd === "set_liked" && state().playback.liked === null,
      description: cmd === "set_liked" && state().playback.liked === null ? "Spotify heart getter/setter is unavailable" : cmd === "set_repeat" ? `Mode ${state().playback.repeat ?? "unknown"}` : cmd === "set_shuffle" ? String(state().playback.shuffle ?? "unknown") : "",
    }))])
    if (!choice) return
    const cmd = options.find(([title]) => title === choice)![1]
    const p = state().playback
    if (choice === "Seek to seconds…") {
      const input = await context.ui.dialog.prompt({ title: "Seek · seconds", placeholder: "e.g. 90" })
      if (input === undefined) return
      await run("seek", { positionMs: Number(input) * 1000 })
    } else if (choice === "Back" || choice === "Forward") {
      const seconds = props.settings().seekSeconds ?? (typeof context.options.seekSeconds === "number" ? Math.min(120, Math.max(1, context.options.seekSeconds)) : 10)
      await run("seek", { positionMs: Math.min(p.durationMs, Math.max(0, props.position() + (choice === "Back" ? -1 : 1) * seconds * 1000)) })
    } else if (cmd === "set_shuffle") {
      const value = await select("Shuffle", [{ title: "Off", value: "off" }, { title: "On", value: "on" }])
      if (value) await run(cmd, { value: value === "on" })
    } else if (cmd === "set_repeat") {
      const value = await select("Repeat", ["Off", "All", "One"].map((title, value) => ({ title, value: String(value) })))
      if (value !== undefined) await run(cmd, { value: Number(value) })
    } else if (cmd === "set_volume") {
      let volume = p.volume
      if (choice === "Volume…") {
        const input = await context.ui.dialog.prompt({ title: "Volume · 0 to 100%", placeholder: "70" })
        if (input === undefined) return
        volume = Number(input) / 100
      } else if (volume !== null) volume = Math.max(0, Math.min(1, volume + (choice.includes("+") ? 0.05 : -0.05)))
      if (volume !== null) await run(cmd, { value: volume })
    } else if (cmd === "set_mute") {
      const choice = await select("Mute", [{ title: "Mute", value: "yes" }, { title: "Unmute", value: "no" }])
      if (choice) await run(cmd, { value: choice === "yes" })
    }
    else if (cmd === "set_liked" && selectedUri) await run(cmd, { uri: selectedUri, value: !p.liked })
    else await run(cmd)
  }
  async function trackActions(track: QueueTrack, removal = false) {
    const choice = await select(track.name, [
      { title: "Play now", value: "play_track", disabled: !track.is_playable || !supported("play_track") },
      { title: "Add to queue", value: "add_to_queue", disabled: !track.is_playable || !supported("add_to_queue") },
      ...(removal ? [{ title: "Remove this queued occurrence", value: "remove_from_queue", disabled: !uidValid(track.uid) || !supported("remove_from_queue") }] : []),
    ])
    if (choice) await run(choice as BridgeCommand, { uri: track.uri, ...(choice === "remove_from_queue" ? { uid: track.uid } : {}) })
  }
  async function queue() {
    let current: string | undefined
    while (!disposed) {
      const data = await request<BridgeQueue>("get_queue")
      const entries = [
        ...(data.current ? [{ item: data.current, category: "Current", removable: false }] : []),
        ...data.queued.map((item) => ({ item, category: "Queued", removable: uidValid(item.uid) && data.queued.filter((other) => other.uri === item.uri && other.uid === item.uid).length === 1 })),
        ...data.next_up.map((item) => ({ item, category: "Next up", removable: false })),
      ]
      const rows = entries.map((entry, index) => ({ title: entry.item.name, description: entry.item.artist, category: entry.category, value: `${entry.category}:${entry.item.uri}:${entry.item.uid ?? index}` }))
      const choice = await select(`Queue · ${entries.length} tracks`, [...rows, { title: "Refresh", value: "refresh" }], current)
      if (choice === undefined) return
      if (choice === "refresh") continue
      current = choice
      const entry = entries[rows.findIndex((r) => r.value === choice)]
      if (entry) await trackActions(entry.item, entry.removable)
    }
  }
  async function pages(command: "get_library" | "get_playlist_tracks" | "search", params: Record<string, unknown>, title: string) {
    let offset = 0, current: string | undefined
    while (!disposed) {
      const page = await request<TrackPage>(command, { ...params, offset, limit: 50 })
      const choice = await select(`${title} · ${offset + 1}–${offset + page.items.length} / ${page.total}`, [
        ...page.items.map((t) => ({ title: t.name, description: `${t.artist} · ${t.album} · ${formatTime(t.duration_ms)}`, value: t.uri })),
        ...(offset + page.limit < page.total ? [{ title: "Next page", value: "next" }] : []),
        ...(offset > 0 ? [{ title: "Previous page", value: "previous" }] : []),
        { title: page.items.length ? "Refresh" : "No playable results · Refresh", value: "refresh" },
      ], current)
      if (choice === undefined) return
      if (choice === "next") offset += page.limit
      else if (choice === "previous") offset = Math.max(0, offset - 50)
      else if (choice !== "refresh") {
        current = choice
        const track = page.items.find((t) => t.uri === choice)
        if (track) await trackActions(track)
      }
    }
  }
  async function folders(nodes: PlaylistNode[], title = "Playlists", selected?: string) {
    let current = selected
    while (!disposed) {
      const choice = await select(title, [
        ...nodes.map((node) => ({ title: `${node.type === "folder" ? "▸ " : ""}${node.name}`, value: node.uri, description: node.uri ? node.type : "Missing stable identifier", disabled: !node.uri })),
        { title: "Refresh rootlist", value: "refresh" },
      ], current)
      if (!choice) return
      if (choice === "refresh") { await playlists(current); return }
      current = choice
      const node = nodes.find((n) => n.uri === choice)
      if (node?.type === "folder") await folders(node.children, `${title} / ${node.name}`)
      else if (node) {
        const action = await select(node.name, [
          { title: "Browse tracks", value: "browse" },
          { title: "Play playlist", value: "play", disabled: !supported("play_context") },
        ])
        if (action === "browse") await pages("get_playlist_tracks", { uri: node.uri }, node.name)
        if (action === "play") await run("play_context", { uri: node.uri })
      }
    }
  }
  async function playlists(selected?: string) {
    const root = await request<{ items: PlaylistNode[] }>("get_playlists")
    const findParent = (nodes: PlaylistNode[]): PlaylistNode | undefined => {
      for (const node of nodes) {
        if (node.type !== "folder") continue
        if (node.children.some((child) => child.uri === selected)) return node
        const nested = findParent(node.children)
        if (nested) return nested
      }
    }
    const parent = selected ? findParent(root.items) : undefined
    await folders(parent?.children ?? root.items, parent?.name ?? "Playlists", selected)
  }
  async function search() {
    const query = await context.ui.dialog.prompt({ title: "Search Spotify tracks", placeholder: "Song or artist" })
    if (query?.trim()) await pages("search", { query: query.trim() }, `Search: ${query}`)
  }
  function lyrics() {
    context.ui.dialog.set({ size: "large" })
    context.ui.dialog.show(() => <LyricsView {...props} settingsAction={() => void settings()} />)
  }
  async function settings() { await lyricsSettingsDialog(props) }
  async function guarded(action: () => Promise<unknown> | void) {
    try { await action() } catch (error) {
      if (!disposed && !(error instanceof Error && error.message === "Music view superseded")) context.ui.toast.show({ message: error instanceof Error ? error.message : "Music request failed", variant: "error" })
    }
  }
  async function open() {
    const choice = await select(`Music · ${state().track?.title || "Not connected"}`, [
      { title: "Now Playing / Controls", value: "playback" },
      { title: "Lyrics", value: "lyrics" },
      { title: "Lyrics Settings", value: "settings" },
      { title: "Queue", value: "queue", disabled: !supported("get_queue") },
      { title: "Playlists / Folders", value: "playlists", disabled: !supported("get_playlists") },
      { title: "Liked Songs", value: "library", disabled: !supported("get_library") },
      { title: "Search", value: "search", disabled: !supported("search") },
    ])
    const actions: Record<string, () => Promise<unknown> | void> = { playback, lyrics, settings, queue, playlists, library: () => pages("get_library", {}, "Liked Songs"), search }
    if (choice && actions[choice]) await guarded(actions[choice]!)
  }
  const launch = (fn: () => Promise<unknown> | void) => { generation++; return guarded(fn) }
  return { open: () => launch(open), playback: () => launch(playback), settings: () => launch(settings), queue: () => launch(queue), search: () => launch(search), lyrics: () => { generation++; lyrics() }, run, supported, dispose: () => { disposed = true; generation++ } }
}
