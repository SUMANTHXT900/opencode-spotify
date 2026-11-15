import { Rpc } from "@opencode/plugin/rpc"
import { object, text, trackUri, normalizeState, validateCommand, type TrackPage, type PlaylistNode } from "./services/validation.ts"
import type { BridgeCommand, BridgeQueue } from "./services/protocol.ts"
import { validateLyricsDocument, type Lyrics } from "./services/lyrics.ts"
import type { SourceResolution } from "./services/LyricsSourceManager.ts"
import { validContact } from "./services/lyrics-source.ts"
import type { SpotifyState } from "./services/state.ts"

// Small Standard Schema adapter gives RPC native type inference without another
// validation dependency. Wire inputs are additionally checked by the service.
function schema<T>(parse: (value: unknown) => T): {
  "~standard": { version: 1; vendor: string; types?: { input: T; output: T }; validate: (value: unknown) => { value: T } | { issues: { message: string }[] } }
} {
  return { "~standard": { version: 1 as const, vendor: "opencode-spotify", validate(value: unknown) {
    try { return { value: parse(value) } } catch { return { issues: [{ message: "Invalid Spotify RPC value" }] } }
  } } }
}
const empty = schema<Record<string, never>>((v) => { if (!object(v) || Object.keys(v).length) throw new Error(); return {} })
export const stateSchema = schema<SpotifyState>(normalizeState)
export type CommandInput = { command: BridgeCommand; params: Record<string, unknown> }
export type CommandResult = { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } }
const commandSchema = schema<CommandInput>((v) => {
  if (!object(v) || typeof v.command !== "string") throw new Error()
  return validateCommand(v.command, v.params ?? {})
})
const resultSchema = schema<CommandResult>((v) => {
  if (!object(v) || typeof v.ok !== "boolean" || !v.ok && !object(v.error)) throw new Error()
  return v as CommandResult
})
function operation<P extends Record<string, unknown>>(command: BridgeCommand) {
  return { input: schema<P>((value) => validateCommand(command, value).params as P), output: resultSchema }
}
export type { TrackPage, PlaylistNode, BridgeQueue, Lyrics }
export const SpotifyRpc = Rpc.define({
  id: "opencode-spotify",
  methods: {
    getState: { input: empty, output: stateSchema },
    command: { input: commandSchema, output: resultSchema },
    getPlayback: operation<Record<string, never>>("get_playback"),
    play: operation<Record<string, never>>("play"),
    pause: operation<Record<string, never>>("pause"),
    togglePlayback: operation<Record<string, never>>("toggle_play"),
    next: operation<Record<string, never>>("next"),
    previous: operation<Record<string, never>>("previous"),
    seek: operation<{ positionMs: number }>("seek"),
    setShuffle: operation<{ value: boolean }>("set_shuffle"),
    setRepeat: operation<{ value: 0 | 1 | 2 }>("set_repeat"),
    setVolume: operation<{ value: number }>("set_volume"),
    setMute: operation<{ value: boolean }>("set_mute"),
    setLiked: operation<{ uri: string; value: boolean }>("set_liked"),
    getQueue: operation<Record<string, never>>("get_queue"),
    getPlaylists: operation<Record<string, never>>("get_playlists"),
    getPlaylistTracks: operation<{ uri: string; offset?: number; limit?: number }>("get_playlist_tracks"),
    getLibrary: operation<{ offset?: number; limit?: number }>("get_library"),
    search: operation<{ query: string; offset?: number; limit?: number }>("search"),
    playTrack: operation<{ uri: string }>("play_track"),
    playContext: operation<{ uri: string }>("play_context"),
    addToQueue: operation<{ uri: string }>("add_to_queue"),
    removeFromQueue: operation<{ uri: string; uid: string | number }>("remove_from_queue"),
    getCapabilities: operation<Record<string, never>>("get_capabilities"),
    refreshState: operation<Record<string, never>>("get_playback"),
    getLyrics: { input: empty, output: schema<Lyrics>(validateLyricsDocument) },
    getLyricsSources: {
      input: schema<{ uri: string; lrclib: boolean; contact: string; refresh: boolean }>((v) => {
        if (!object(v) || Object.keys(v).some((key) => !["uri", "lrclib", "contact", "refresh"].includes(key)) ||
            !trackUri(v.uri) || typeof v.lrclib !== "boolean" || typeof v.refresh !== "boolean" ||
            typeof v.contact !== "string" || v.contact !== "" && !validContact(v.contact)) throw new Error()
        return v as { uri: string; lrclib: boolean; contact: string; refresh: boolean }
      }),
      output: schema<SourceResolution>((v) => {
        if (!object(v) || !trackUri(v.uri) || !Array.isArray(v.candidates) || v.candidates.length > 8 ||
            !Array.isArray(v.availability) || v.availability.length > 2) throw new Error()
        return { uri: v.uri, candidates: v.candidates.map(validateLyricsDocument), availability: v.availability.map((a) => {
          if (!object(a) || !["spotify", "lrclib"].includes(a.provider as string) ||
              !["ready", "unavailable", "disabled", "error"].includes(a.state as string)) throw new Error()
          return { provider: a.provider as "spotify" | "lrclib", state: a.state as SourceResolution["availability"][number]["state"], detail: text(a.detail, 300) }
        }) }
      }),
    },
  },
  events: { updated: { schema: schema<{ state: SpotifyState }>((v) => {
    if (!object(v)) throw new Error()
    const result = stateSchema["~standard"].validate(v.state)
    if (!("value" in result)) throw new Error()
    return { state: result.value! }
  }) } },
})
