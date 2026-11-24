// Deterministic compact-player layout. The sidebar footer is the only surface
// this plans for: its available height is derived from the terminal so host
// sections (Context, MCP, Todo) cannot push the player out of view. Keeping the
// row accounting in one pure function makes the responsive modes testable
// without a renderer.
export type PlayerMode = "roomy" | "medium" | "tight" | "very-tight"

export interface PlayerLayoutInput {
  hasTrack: boolean
  width: number
  /** Terminal cell height / width ratio used to keep square artwork square. */
  aspect: number
  artwork: boolean
  artworkSize?: "auto" | "small"
  showVolume: boolean
  preview: boolean
}

export interface PlayerLayout {
  mode: PlayerMode
  header: boolean
  nav: boolean
  frame: boolean
  art: boolean
  artHeight: number
  artWidth: number
  title: boolean
  artist: boolean
  seek: boolean
  transport: boolean
  volume: boolean
  gapArt: boolean
  gapTransport: boolean
  gapLyrics: boolean
  lyricsRows: 0 | 1 | 3 | 5
  innerWidth: number
  cardHeight: number
  total: number
}

/** Footer budget leaves host chrome and the scrollable sidebar usable. */
export function playerBudget(terminalHeight: number): number {
  if (!Number.isFinite(terminalHeight)) return 6
  const height = Math.max(1, Math.floor(terminalHeight))
  return Math.max(6, Math.min(26, height - 10))
}

/** Minimum budget delta before the player changes modes. Prevents flicker when
 * the terminal hovers on a mode boundary (e.g. 23 <-> 24 rows). Note
 * `Math.max(1, gap)` below, so even an explicit 0 still absorbs 1-row noise. */
export const BUDGET_HYSTERESIS = 2
/** Settle window for terminal-height changes before the budget recomputes. */
export const TERMINAL_SETTLE_MS = 200

/**
 * Resolve the footer budget with hysteresis. The pure `playerLayout` planner
 * stays deterministic for tests; this wrapper keeps the previous budget until
 * the raw budget moves by at least `BUDGET_HYSTERESIS` rows, so Todo/terminal
 * oscillation cannot flap the player between modes.
 */
export function resolvePlayerBudget(
  terminalHeight: number,
  previousBudget?: number,
  hysteresis = BUDGET_HYSTERESIS,
): number {
  const raw = playerBudget(terminalHeight)
  if (previousBudget === undefined || !Number.isFinite(previousBudget)) return raw
  const previous = Math.max(6, Math.min(26, Math.floor(previousBudget)))
  const gap = Math.max(0, Math.floor(hysteresis))
  if (Math.abs(raw - previous) < Math.max(1, gap)) return previous
  return raw
}

function modeFor(budget: number, width: number): PlayerMode {
  if (budget >= 24 && width >= 26) return "roomy"
  if (budget >= 16) return "medium"
  if (budget >= 10) return "tight"
  return "very-tight"
}

// Priority order is fixed and matches the requested hierarchy. Artwork is the
// first thing reduced, then decorative gaps; controls, metadata, progress and
// the lyric window survive longest.
export function playerLayout(budget: number, input: PlayerLayoutInput): PlayerLayout {
  const b = Math.max(1, Math.min(40, Math.floor(budget)))
  const width = Math.max(1, Math.floor(input.width))
  const mode = modeFor(b, width)
  const header = b >= 2
  const nav = b >= 5 && width >= 13
  const frame = mode === "roomy" && width >= 26
  const title = input.hasTrack && b >= 4
  const artist = input.hasTrack && b >= 5
  const seek = input.hasTrack && width >= 15 && b >= 6
  const transport = b >= 1
  const volume = input.showVolume && width >= 15 && b >= 12
  const lyricsRows: 0 | 1 | 3 | 5 = !input.preview || !input.hasTrack ? 0
    : mode === "roomy" ? 5
      : mode === "medium" ? (b >= 20 ? 5 : 3)
        : mode === "tight" ? (b >= 14 ? 3 : 1)
          : (b >= 8 ? 1 : 0)
  const gapLyrics = lyricsRows > 0
  const innerWidth = Math.max(1, frame ? width - 4 : width)
  const artCapBase = mode === "roomy" || mode === "medium" ? 9 : mode === "tight" ? 4 : 0
  const artCap = input.artworkSize === "small" ? Math.min(6, artCapBase) : artCapBase
  const gapTransport = mode === "roomy" && seek && transport
  const fixed = Number(header) + Number(nav) + Number(title) + Number(artist) + Number(seek) +
    Number(transport) + Number(volume) + (frame ? 2 : 0) + Number(gapLyrics) + lyricsRows

  const artMaxWidth = Math.max(1, innerWidth - 2)
  const aspect = Number.isFinite(input.aspect) && input.aspect > 0 ? input.aspect : 2
  let artHeight = 0
  let gapArt = false
  if (input.artwork && input.hasTrack && width >= 18 && artCap > 0) {
    const reservedGap = 1
    const room = b - fixed - Number(gapTransport) - reservedGap
    if (room >= 3) {
      artHeight = Math.min(artCap, room)
      if (Math.round(artHeight * aspect) > artMaxWidth) artHeight = Math.floor(artMaxWidth / aspect)
      if (artHeight >= 3) gapArt = true
      else artHeight = 0
    }
  }

  const rows = () => Number(header) + Number(nav) + Number(title) + Number(artist) + Number(seek) +
    Number(transport) + Number(volume) + (frame ? 2 : 0) + Number(gapLyrics) + lyricsRows +
    artHeight + Number(gapArt) + Number(gapTransport)

  // If the reserved gap left artwork out but there are still three free rows,
  // use them for a compact cover rather than emitting dead space.
  if (!artHeight && input.artwork && input.hasTrack && width >= 18 && artCap > 0) {
    const free = b - rows()
    if (free >= 3) {
      const candidate = Math.min(artCap, free)
      if (Math.round(candidate * aspect) <= artMaxWidth) {
        artHeight = candidate
        if (free >= artHeight + 1) gapArt = true
      }
    }
  }

  let total = rows()
  while (total > b && gapArt) { gapArt = false; total-- }
  while (total > b && artHeight > 0) { artHeight--; total-- }
  if (artHeight < 3) { artHeight = 0; gapArt = false; total = rows() }
  if (gapArt && total > b) { gapArt = false; total = rows() }

  const artWidth = artHeight > 0
    ? Math.max(1, Math.min(artMaxWidth, Math.round(artHeight * aspect)))
    : 0
  const cardHeight = (frame ? 2 : 0) + artHeight + Number(gapArt) + Number(title) + Number(artist) +
    Number(seek) + Number(transport) + Number(volume) + Number(gapTransport)

  return {
    mode, header, nav, frame, art: artHeight > 0, artHeight, artWidth,
    title, artist, seek, transport, volume, gapArt, gapTransport, gapLyrics, lyricsRows,
    innerWidth, cardHeight, total,
  }
}

// Time labels use a width that depends only on available width, never on the
// current duration, so the seek thumb cannot drift when tracks change.
export function playerTimeWidth(innerWidth: number): number {
  return innerWidth >= 20 ? 6 : Math.max(4, Math.floor((innerWidth - 4) / 2))
}
export const VOLUME_LABEL_WIDTH = 6
export const VOLUME_MUTE_WIDTH = 5
export const VOLUME_MAX_SLIDER = 12

/** Compact secondary volume geometry: short track, centered, never full width. */
export function volumeGeometry(innerWidth: number) {
  const width = Math.max(1, Math.floor(innerWidth))
  const showMute = width >= 18
  const showPercent = width >= 12
  const fixed = (showMute ? VOLUME_MUTE_WIDTH + 1 : 0) + (showPercent ? VOLUME_LABEL_WIDTH + 1 : 0)
  // Keep one spare cell so volume is never visually as wide as the seekbar.
  const slider = Math.max(2, Math.min(VOLUME_MAX_SLIDER, width - fixed - 1))
  return { showMute, showPercent, slider, width: fixed + slider }
}
