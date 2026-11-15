// Wire protocol emitted by the maintained Spicetify extension, protocol 2 / auto-1.
// Types describe the wire; consumers must validate untrusted messages at runtime.
export type BridgeCommand =
  | "get_capabilities" | "get_playlists" | "get_playlist_tracks"
  | "get_queue" | "get_library" | "search" | "play_track"
  | "play_context" | "add_to_queue" | "remove_from_queue" | "ping"
  | "get_playback" | "refresh_lyrics" | "play" | "pause" | "toggle_play" | "next" | "previous"
  | "seek" | "set_shuffle" | "set_repeat" | "set_volume" | "set_mute" | "set_liked"

export interface BridgeRequest {
  type: "request"
  id: string
  command: BridgeCommand
  params?: Record<string, unknown>
}

export type BridgeResponse =
  | { type: "response"; id: string; ok: true; result: unknown }
  | { type: "response"; id: string; ok: false; error: { code: string; message: string } }

export interface Capabilities {
  protocol: number
  apis: Record<string, boolean>
  commands: BridgeCommand[]
  search_mode: "graphql" | null
}

export interface QueueTrack {
  type: "track" | "episode"
  uri: string
  name: string
  artists: { uri: string; name: string }[]
  artist: string
  album: string
  album_uri: string
  image: string
  duration_ms: number
  is_playable: boolean
  uid: unknown
  provider: string | null
  section?: "current" | "queued" | "next_up"
}

export interface BridgeQueue {
  current: QueueTrack | null
  queued: QueueTrack[]
  next_up: QueueTrack[]
  counts: { queued: number; next_up: number }
}

export type BridgeEvent =
  | ({ type: "capabilities" } & Capabilities)
  | { type: "track"; uri: string; title: string; artist: string; album: string }
  | { type: "lyrics"; uri: string; sync_type: string; lines: { startTimeMs: string | number | null; text: string }[] }
  | { type: "lyrics_unavailable"; uri?: string; reason: string }
  | { type: "queue_update"; queue: BridgeQueue }
