import type { BridgeCommand, BridgeQueue, Capabilities, QueueTrack } from "./protocol.ts"
import type { PlaybackState, SpotifyState } from "./state.ts"

export const commands = [
  "get_capabilities", "ping", "get_playback", "refresh_lyrics", "play", "pause", "toggle_play", "next", "previous",
  "seek", "set_shuffle", "set_repeat", "set_volume", "set_mute", "set_liked",
  "get_playlists", "get_playlist_tracks", "get_library", "get_queue", "search",
  "play_track", "play_context", "add_to_queue", "remove_from_queue",
] as const satisfies readonly BridgeCommand[]
export const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)
const textSegments = new Intl.Segmenter(undefined, { granularity: "grapheme" })
export const text = (v: unknown, max = 500) => {
  if (typeof v !== "string") return ""
  const clean = v.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "")
  if (clean.length <= max) return clean
  let result = ""
  for (const part of textSegments.segment(clean)) {
    if (result.length + part.segment.length > max) break
    result += part.segment
  }
  return result
}
export const trackUri = (v: unknown): v is string => typeof v === "string" && /^spotify:(track|episode):[A-Za-z0-9]{22}$/.test(v)
export const contextUri = (v: unknown): v is string => v === "spotify:collection:tracks" || typeof v === "string" && /^spotify:(playlist|album|artist|show):[A-Za-z0-9]{22}$/.test(v)
export const number = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max
export const uidValid = (v: unknown): v is string | number => typeof v === "string" && v.length > 0 && v.length <= 128 || typeof v === "number" && Number.isSafeInteger(v) && v >= 0
// Artwork references cross the bridge as metadata. ArtworkService authorizes network access.
export function image(v: unknown) {
  if (typeof v !== "string" || v.length > 2000 || /[\s\x00-\x1f\x7f-\x9f]/.test(v)) return ""
  if (/^spotify:image:[A-Za-z0-9]+$/.test(v)) return v
  try {
    const url = new URL(v)
    return url.protocol === "https:" && !url.username && !url.password && !url.port ? url.href : ""
  } catch { return "" }
}

export class SpotifyError extends Error {
  code: string
  constructor(code: string, message: string) { super(message); this.code = code }
}
function requireValue(valid: boolean, message = "Invalid command parameters"): asserts valid {
  if (!valid) throw new SpotifyError("invalid_input", message)
}
export function validateCommand(command: string, raw: unknown): { command: BridgeCommand; params: Record<string, unknown> } {
  requireValue(commands.includes(command as BridgeCommand), "Unsupported command")
  requireValue(object(raw))
  const p = raw
  const keys: Record<string, string[]> = {
    seek: ["positionMs"], set_shuffle: ["value"], set_repeat: ["value"], set_volume: ["value"],
    set_mute: ["value"], set_liked: ["uri", "value"], play_track: ["uri"], play_context: ["uri"],
    add_to_queue: ["uri"], remove_from_queue: ["uri", "uid"], get_playlist_tracks: ["uri", "offset", "limit"],
    get_library: ["offset", "limit"], search: ["query", "offset", "limit"],
  }
  requireValue(Object.keys(p).every((key) => (keys[command] ?? []).includes(key)))
  if (["play_track", "add_to_queue", "remove_from_queue", "set_liked"].includes(command)) requireValue(trackUri(p.uri))
  if (command === "set_liked") requireValue(typeof p.uri === "string" && p.uri.startsWith("spotify:track:"))
  if (command === "play_context") requireValue(contextUri(p.uri))
  if (command === "get_playlist_tracks") requireValue(p.uri === "spotify:collection:tracks" || typeof p.uri === "string" && /^spotify:playlist:[A-Za-z0-9]{22}$/.test(p.uri))
  if (command === "remove_from_queue") requireValue(uidValid(p.uid))
  if (command === "seek") requireValue(number(p.positionMs, 0, 86_400_000))
  if (["set_shuffle", "set_mute", "set_liked"].includes(command)) requireValue(typeof p.value === "boolean")
  if (command === "set_repeat") requireValue([0, 1, 2].includes(p.value as number))
  if (command === "set_volume") requireValue(number(p.value, 0, 1))
  if (["search", "get_playlist_tracks", "get_library"].includes(command)) {
    requireValue(p.offset === undefined || number(p.offset, 0, 1_000_000) && Number.isInteger(p.offset))
    requireValue(p.limit === undefined || number(p.limit, 1, 200) && Number.isInteger(p.limit))
  }
  if (command === "search") requireValue(typeof p.query === "string" && p.query.trim().length > 0 && p.query.length <= 200)
  return { command: command as BridgeCommand, params: p }
}

export function capabilities(v: unknown): Capabilities {
  requireValue(object(v) && v.protocol === 2, "Extension update required: protocol 2")
  requireValue(object(v.apis) && Object.values(v.apis).every((x) => typeof x === "boolean"))
  requireValue(Array.isArray(v.commands) && v.commands.length <= 100 && v.commands.every((x) => commands.includes(x)))
  return { protocol: 2, apis: v.apis as Record<string, boolean>, commands: v.commands as BridgeCommand[], search_mode: v.search_mode === "graphql" ? "graphql" : null }
}

export function playback(v: unknown): PlaybackState {
  requireValue(object(v))
  requireValue(v.trackUri === null || trackUri(v.trackUri))
  requireValue(number(v.positionMs, 0, 86_400_000) && number(v.durationMs, 0, 86_400_000))
  for (const key of ["isPlaying", "shuffle", "muted", "liked"]) requireValue(v[key] === null || typeof v[key] === "boolean")
  requireValue(v.repeat === null || [0, 1, 2].includes(v.repeat as number))
  requireValue(v.volume === null || number(v.volume, 0, 1))
  return {
    trackUri: v.trackUri as string | null, isPlaying: v.isPlaying as boolean | null,
    positionMs: Math.min(v.positionMs, v.durationMs), durationMs: v.durationMs,
    shuffle: v.shuffle as boolean | null, repeat: v.repeat as 0 | 1 | 2 | null,
    volume: v.volume as number | null, muted: v.muted as boolean | null, liked: v.liked as boolean | null,
    updatedAt: Date.now(),
  }
}

export function normalizeState(v: unknown): SpotifyState {
  requireValue(object(v) && typeof v.epoch === "string" && v.epoch.length <= 128 &&
    ["disconnected", "connecting", "connected", "error"].includes(v.connection as string))
  for (const field of ["revision", "queueRevision", "lyricsRevision"]) requireValue(Number.isSafeInteger(v[field]) && (v[field] as number) >= 0)
  requireValue(object(v.playback) && number(v.playback.updatedAt, 0, Number.MAX_SAFE_INTEGER))
  requireValue(v.error === null || typeof v.error === "string")
  requireValue(v.track === null || object(v.track) && trackUri(v.track.uri))
  const track = object(v.track) ? { uri: v.track.uri as string, title: text(v.track.title),
    artist: text(v.track.artist), album: text(v.track.album), image: image(v.track.image) } : null
  return {
    epoch: v.epoch, revision: v.revision as number, queueRevision: v.queueRevision as number,
    lyricsRevision: v.lyricsRevision as number, connection: v.connection as SpotifyState["connection"],
    track, playback: { ...playback(v.playback), updatedAt: v.playback.updatedAt },
    capabilities: v.capabilities === null ? null : capabilities(v.capabilities),
    error: v.error === null ? null : text(v.error, 300),
  }
}

export function normalizeTrack(v: unknown): QueueTrack | null {
  if (!object(v) || !trackUri(v.uri)) return null
  return {
    type: v.uri.startsWith("spotify:episode:") ? "episode" : "track", uri: v.uri,
    name: text(v.name) || "Unknown track", artist: text(v.artist) || "Unknown artist",
    artists: Array.isArray(v.artists) ? v.artists.filter(object).slice(0, 50).map((a) => ({ uri: text(a.uri), name: text(a.name) })) : [],
    album: text(v.album), album_uri: text(v.album_uri), image: image(v.image),
    duration_ms: number(v.duration_ms, 0, 86_400_000) ? v.duration_ms : 0,
    is_playable: v.is_playable === true, uid: uidValid(v.uid) ? v.uid : null, provider: text(v.provider) || null,
  }
}
export function normalizeQueue(v: unknown): BridgeQueue {
  requireValue(object(v) && Array.isArray(v.queued) && Array.isArray(v.next_up))
  const list = (rows: unknown[]) => rows.slice(0, 5000).map(normalizeTrack).filter((x): x is QueueTrack => !!x)
  const queued = list(v.queued as unknown[])
  const next_up = list(v.next_up as unknown[])
  return { current: normalizeTrack(v.current), queued, next_up, counts: { queued: queued.length, next_up: next_up.length } }
}
export interface TrackPage { items: QueueTrack[]; offset: number; limit: number; total: number }
export function normalizePage(v: unknown): TrackPage {
  requireValue(object(v) && Array.isArray(v.items) && v.items.length <= 200 && number(v.offset, 0, 1_000_000) && number(v.limit, 1, 200) && number(v.total, 0, 100_000_000))
  return { items: (v.items as unknown[]).map(normalizeTrack).filter((x): x is QueueTrack => !!x), offset: v.offset, limit: v.limit, total: v.total }
}
export interface PlaylistNode { type: "folder" | "playlist"; uri: string; name: string; children: PlaylistNode[] }
export function normalizeRoot(v: unknown, depth = 0, budget = { count: 0 }): PlaylistNode[] {
  requireValue(Array.isArray(v) && depth <= 10)
  return v.slice(0, 5000).filter(object).flatMap<PlaylistNode>((n) => {
    if (++budget.count > 5000) return []
    if (n.type === "folder") return [{ type: "folder" as const, uri: text(n.uri), name: text(n.name), children: normalizeRoot(n.children, depth + 1, budget) }]
    if (n.type === "playlist" && contextUri(n.uri)) return [{ type: "playlist" as const, uri: n.uri, name: text(n.name), children: [] }]
    return []
  })
}
