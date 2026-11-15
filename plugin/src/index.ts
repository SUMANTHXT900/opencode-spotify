import { Plugin } from "@opencode/plugin"
import { SpotifyRpc } from "./rpc"
import { acquireBridge } from "./services/owner"
import { SpotifyError } from "./services/validation"

export default Plugin.define({
  id: "opencode-spotify",
  async setup(context) {
    const bridge = await acquireBridge()
    const execute = async (command: string, params: unknown) => {
      try { return { ok: true as const, result: await bridge.server.request(command, params) } }
      catch (error) { return { ok: false as const, error: { code: error instanceof SpotifyError ? error.code : "spotify_api", message: error instanceof SpotifyError ? error.message : "Spotify request failed" } } }
    }
    try {
      const registration = await context.rpc.register(SpotifyRpc, {
        getState: async () => structuredClone(bridge.server.state),
        getLyrics: async () => bridge.server.getLyrics(),
        getLyricsSources: async (options) => bridge.server.getLyricsSources(options),
        command: async ({ command, params }) => execute(command, params),
        getPlayback: async (p) => execute("get_playback", p),
        play: async (p) => execute("play", p),
        pause: async (p) => execute("pause", p),
        togglePlayback: async (p) => execute("toggle_play", p),
        next: async (p) => execute("next", p),
        previous: async (p) => execute("previous", p),
        seek: async (p) => execute("seek", p),
        setShuffle: async (p) => execute("set_shuffle", p),
        setRepeat: async (p) => execute("set_repeat", p),
        setVolume: async (p) => execute("set_volume", p),
        setMute: async (p) => execute("set_mute", p),
        setLiked: async (p) => execute("set_liked", p),
        getQueue: async (p) => execute("get_queue", p),
        getPlaylists: async (p) => execute("get_playlists", p),
        getPlaylistTracks: async (p) => execute("get_playlist_tracks", p),
        getLibrary: async (p) => execute("get_library", p),
        search: async (p) => execute("search", p),
        playTrack: async (p) => execute("play_track", p),
        playContext: async (p) => execute("play_context", p),
        addToQueue: async (p) => execute("add_to_queue", p),
        removeFromQueue: async (p) => execute("remove_from_queue", p),
        getCapabilities: async (p) => execute("get_capabilities", p),
        refreshState: async (p) => execute("get_playback", p),
      })
      const unsubscribe = bridge.server.subscribe((state) => {
        void registration.events.emit("updated", { state }).catch(() => {})
      })
      return async () => {
        unsubscribe()
        await registration.dispose()
        await bridge.release()
      }
    } catch (error) {
      await bridge.release()
      throw error
    }
  },
})
