// Pure volume display/acknowledgement helpers. The visible volume is always
// drag preview first, then an optimistic committed value, then the server
// sample; a stale poll can never move the thumb backward while dragging.
export const VOLUME_ACK_EPSILON = 0.01

export function clampVolume(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0
}

export function displayVolume(
  drag: number | undefined,
  optimistic: number | undefined,
  server: number | null | undefined,
): number {
  if (drag !== undefined) return clampVolume(drag)
  if (optimistic !== undefined) return clampVolume(optimistic)
  return clampVolume(server ?? 0)
}

export function volumeKnown(optimistic: number | undefined, server: number | null | undefined): boolean {
  return optimistic !== undefined || server !== null && server !== undefined
}

export function volumeAcknowledged(optimistic: number | undefined, server: number | null | undefined): boolean {
  return optimistic !== undefined && server !== null && server !== undefined &&
    Math.abs(clampVolume(server) - clampVolume(optimistic)) <= VOLUME_ACK_EPSILON
}

export function volumePercentLabel(volume: number): string {
  return `${Math.round(clampVolume(volume) * 100)}%`.padStart(6)
}
