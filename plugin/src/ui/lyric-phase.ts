import { cellSafety } from "./layout"
import type { DistributedLyricBlock } from "../services/lyrics-window"

// V0.5.7 two-phase lyric present: exact previous owned ASCII blank clear,
// then present latest shaped text after documented FRAME. Pure helpers;
// renderer sequencing lives in MiniPlayer (lyric-only).

export interface LyricPhaseSnapshot {
  key: string
  block: DistributedLyricBlock
  hasShaped: boolean
  width: number
  height: number
}

function lyricPhaseKey(block: DistributedLyricBlock, width: number): string {
  const w = Math.max(1, Math.floor(width))
  return JSON.stringify([
    w,
    block.height,
    block.activeOverflow,
    block.padTop,
    block.padBottom,
    block.focusTop,
    block.lines.map((line) => [line.kind, line.lineIndex, line.rows, line.truncated]),
    block.fullLines.map((line) => [line.kind, line.lineIndex, line.text, line.rows]),
  ])
}

export function describeLyricPhase(
  block: DistributedLyricBlock | null,
  width: number,
): LyricPhaseSnapshot | null {
  if (!block) return null
  const w = Math.max(1, Math.floor(width))
  return {
    key: lyricPhaseKey(block, w),
    block,
    hasShaped: (block.activeOverflow ? block.fullLines : block.lines)
      .some((line) => line.rows.some((row) => cellSafety(row) > 0)),
    width: w,
    height: Math.max(1, Math.floor(block.height)),
  }
}
