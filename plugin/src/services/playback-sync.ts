import type { PlaybackState } from "./state.ts"

// Shared authoritative-clock adapter (pure, monotonic-clock based).
//
// Anchors come from the authenticated bridge: positionMs/durationMs sampled by
// the extension, updatedAt stamped at validation, receivedMonoMs stamped by the
// TUI when the snapshot arrives. Rendering extrapolates only while playing and
// never corrects against wall-clock time.

export interface ClockAnchor {
  positionMs: number
  durationMs: number
  isPlaying: boolean | null
}

// Extrapolate from the anchor. Unknown duration (<= 0) means unbounded growth,
// never a pin at zero: a missing duration must not freeze progress or lyrics.
export function extrapolatePosition(anchor: ClockAnchor, receivedMonoMs: number, nowMonoMs: number): number {
  const elapsed = anchor.isPlaying === true ? Math.max(0, nowMonoMs - receivedMonoMs) : 0
  const position = Math.max(0, anchor.positionMs + elapsed)
  return anchor.durationMs > 0 ? Math.min(anchor.durationMs, position) : position
}

export interface SeekHold { targetMs: number; startedWallMs: number; startedMonoMs: number }
export const SEEK_HOLD_MS = 2000
export const SEEK_MATCH_MS = 2500

// A local seek holds the rendered position until the authoritative snapshot
// catches up. Clear on a matching acknowledgement or after a bounded timeout;
// pre-seek progress echoes (older wall time and far from the target) are stale.
export function holdCleared(hold: SeekHold, snapshot: { positionMs: number; updatedAt: number }, nowMonoMs: number): boolean {
  if (nowMonoMs - hold.startedMonoMs >= SEEK_HOLD_MS) return true
  return snapshot.updatedAt >= hold.startedWallMs - 100 && Math.abs(snapshot.positionMs - hold.targetMs) <= SEEK_MATCH_MS
}

export function isStaleEcho(currentUpdatedAt: number, incomingUpdatedAt: number): boolean {
  return incomingUpdatedAt < currentUpdatedAt
}

// Merge a polled/authoritative playback snapshot into current state. Returns
// null when the snapshot is older than what is already held (stale echo) so
// callers never move the timeline backward on old data. Track switches are
// always accepted; the caller resets track-bound state around them.
export function mergePlayback(current: PlaybackState, incoming: PlaybackState): PlaybackState | null {
  if (incoming.trackUri !== current.trackUri) return { ...incoming }
  if (isStaleEcho(current.updatedAt, incoming.updatedAt)) return null
  if (incoming.updatedAt === current.updatedAt && incoming.positionMs < current.positionMs) return null
  return { ...incoming }
}
