import type { BridgeCommand } from "../services/protocol.ts"
import type { SpotifyState } from "../services/state.ts"
import { playerActions } from "./player-actions.ts"
import type { ControlAction } from "./primitives.tsx"

// Fixed widths keep the transport group from moving when Play/Pause labels or
// disabled states change. The like action is balanced by an equal left spacer,
// so the three transport buttons stay centered.
export const TRANSPORT_WIDTHS = { previous: 4, toggle: 9, next: 4, like: 4 } as const

export interface TransportActions {
  previous: ControlAction
  toggle: ControlAction
  next: ControlAction
  like: ControlAction
}

export function transportActions(
  state: SpotifyState,
  position: number,
  run: (command: BridgeCommand, params?: Record<string, unknown>) => void | boolean | Promise<void | boolean>,
): TransportActions {
  const actions = playerActions(state, position, run)
  const playing = state.playback.isPlaying === true
  return {
    previous: { ...actions[0]!, label: "◀◀", accessibleLabel: "Previous track" },
    toggle: {
      ...actions[1]!,
      label: playing ? "Ⅱ Pause" : "▶ Play",
      accessibleLabel: playing ? "Pause playback" : "Resume playback",
    },
    next: { ...actions[2]!, label: "▶▶", accessibleLabel: "Next track" },
    like: {
      ...actions[3]!,
      label: state.playback.liked ? "♥" : "♡",
      accessibleLabel: state.playback.liked ? "Unlike current track" : "Like current track",
    },
  }
}
