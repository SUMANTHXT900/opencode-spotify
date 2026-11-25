import type { Capabilities } from "./protocol.ts"

export interface SpotifyState {
  epoch: string
  revision: number
  connection: "disconnected" | "connecting" | "connected" | "error"
  track: { uri: string; title: string; artist: string; album: string; image: string } | null
  playback: PlaybackState
  capabilities: Capabilities | null
  error: string | null
  queueRevision: number
  lyricsRevision: number
}

export interface PlaybackState {
  trackUri: string | null
  isPlaying: boolean | null
  positionMs: number
  durationMs: number
  shuffle: boolean | null
  repeat: 0 | 1 | 2 | null
  volume: number | null
  muted: boolean | null
  liked: boolean | null
  updatedAt: number
}

export const emptyPlayback = (): PlaybackState => ({
  trackUri: null, isPlaying: null, positionMs: 0, durationMs: 0, shuffle: null,
  repeat: null, volume: null, muted: null, liked: null, updatedAt: 0,
})

export function initialState(): SpotifyState {
  return {
    epoch: "", revision: 0, queueRevision: 0, lyricsRevision: 0,
    connection: "disconnected", track: null, playback: emptyPlayback(),
    capabilities: null, error: null,
  }
}

export function connectionLabel(state: SpotifyState) {
  if (state.connection === "connected") return "● Connected"
  if (state.connection === "connecting") return "○ Connecting"
  if (state.connection !== "error") return "○ Waiting for Spotify"
  if (state.error?.includes("not installed")) return "⚠ Extension not installed"
  if (state.error?.includes("protocol") || state.error?.includes("update required")) return "⚠ Extension incompatible"
  if (state.error?.includes("port unavailable")) return "⚠ Local port unavailable"
  return "⚠ Connection configuration error"
}

/**
 * Concise variant for narrow sidebar layouts (B11). Same meaning as
 * connectionLabel but fits where the full sentence would truncate.
 * Recovery guidance lives in dialogs/toasts, not in the header.
 */
export function shortConnectionLabel(state: SpotifyState): string {
  if (state.connection === "connected") return "● Connected"
  if (state.connection === "connecting") return "○ Connecting"
  if (state.connection !== "error") return "○ Waiting"
  if (state.error?.includes("not installed")) return "⚠ No extension"
  if (state.error?.includes("protocol") || state.error?.includes("update required")) return "⚠ Incompatible"
  if (state.error?.includes("port unavailable")) return "⚠ Port busy"
  return "⚠ Config error"
}

/** Actionable one-line recovery hint for error states (B11). */
export function connectionHint(state: SpotifyState): string | null {
  if (state.connection !== "error") return null
  if (state.error?.includes("not installed")) return "Run opencode-spotify repair, then restart Spotify + OpenCode."
  if (state.error?.includes("protocol") || state.error?.includes("update required")) return "Update the plugin and repair the bridge."
  if (state.error?.includes("port unavailable")) return "Another process owns port 18765; it was not terminated."
  return "Restart Spotify and OpenCode; run doctor if it persists."
}

export function reconciledPosition(previous: number, retainedLyricsUri: string | null, next: SpotifyState) {
  if (next.track && next.playback.trackUri === next.track.uri) return next.playback.positionMs
  if (next.track && next.track.uri !== retainedLyricsUri || next.connection === "connected" && !next.track) return 0
  return previous
}

// `receivedAt` and `now` are monotonic timestamps in the receiving TUI process.
// Unknown duration (<= 0) never clamps: a missing duration must not pin progress
// at zero or stop the tick. Callers bound staleness separately.
export function positionAt(playback: PlaybackState, receivedAt: number, now: number): number {
  const elapsed = playback.isPlaying ? Math.max(0, now - receivedAt) : 0
  const position = Math.max(0, playback.positionMs + elapsed)
  return playback.durationMs > 0 ? Math.min(playback.durationMs, position) : position
}

export function formatTime(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
}

export function newerSnapshot(current: SpotifyState, next: SpotifyState): boolean {
  return next.epoch !== current.epoch || next.revision > current.revision
}

export function progressBar(position: number, duration: number, width: number): string {
  const size = Math.max(0, Math.floor(width))
  const fraction = duration > 0 ? Math.max(0, Math.min(1, position / duration)) : 0
  const filled = Math.floor(fraction * size)
  return "━".repeat(filled) + "─".repeat(size - filled)
}
