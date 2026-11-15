import type { SpotifyState } from "../services/state.ts"
import type { BridgeCommand } from "../services/protocol.ts"
import type { ControlAction } from "./primitives.tsx"

export function playerActions(state: SpotifyState, position: number,
  run: (command: BridgeCommand, params?: Record<string, unknown>) => void | boolean | Promise<void | boolean>): ControlAction[] {
  const supported = (command: BridgeCommand) => state.connection === "connected" && !!state.capabilities?.commands.includes(command)
  const action = (id: string, label: string, command: BridgeCommand, params = {}, known = true, reason = "Spotify API/state unavailable"): ControlAction =>
    ({ id, label, disabled: !supported(command) || !known, reason: !supported(command) || !known ? reason : undefined, run: () => run(command, params) })
  const p = state.playback
  return [
    action("spotify-previous", "Prev", "previous"),
    action("spotify-toggle", p.isPlaying ? "Pause" : "Play", "toggle_play"),
    action("spotify-next", "Next", "next"),
    action("spotify-like", p.liked ? "Saved" : "Save", "set_liked", { uri: state.track?.uri, value: !p.liked },
      p.liked !== null && !!state.track?.uri.startsWith("spotify:track:"), "Current-track liking requires Spotify getHeart/setHeart and a track"),
    action("spotify-shuffle", `Shuffle ${p.shuffle ? "on" : "off"}`, "set_shuffle", { value: !p.shuffle }, p.shuffle !== null),
    action("spotify-repeat", `Repeat ${p.repeat === 2 ? "one" : p.repeat === 1 ? "all" : "off"}`, "set_repeat", { value: ((p.repeat ?? 0) + 1) % 3 }, p.repeat !== null),
    action("spotify-mute", p.muted ? "Unmute" : "Mute", "set_mute", { value: !p.muted }, p.muted !== null),
    action("spotify-volume-down", "Vol -", "set_volume", { value: Math.max(0, (p.volume ?? 0) - 0.05) }, p.volume !== null),
    action("spotify-volume-up", "Vol +", "set_volume", { value: Math.min(1, (p.volume ?? 0) + 0.05) }, p.volume !== null),
    action("spotify-seek-back", "-10s", "seek", { positionMs: Math.max(0, position - 10000) }),
    action("spotify-seek-forward", "+10s", "seek", { positionMs: Math.min(p.durationMs, position + 10000) }),
  ]
}
