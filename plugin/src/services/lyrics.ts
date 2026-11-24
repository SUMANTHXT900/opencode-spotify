import { object, text, trackUri } from "./validation.ts"

export interface LyricWord { text: string; startMs: number; endMs: number }
export interface LyricLine { startMs: number | null; text: string; words?: LyricWord[] }
export type LyricMoment =
  | { kind: "no-track" }
  | { kind: "loading" }
  | { kind: "ready-line"; lineIndex: number }
  | { kind: "instrumental"; phase: "intro" | "interlude" | "outro" | "unknown" }
  | { kind: "unsynced" }
  | { kind: "unavailable"; reason?: string }
  | { kind: "source-error"; message: string }
export interface Lyrics {
  uri: string | null
  status: "loading" | "ready" | "unavailable"
  synced: boolean
  lines: LyricLine[]
  id?: string
  provider?: "spotify" | "lrclib"
  attribution?: string
  language?: string | null
  script?: "latin" | "original" | "mixed" | "unknown"
  romanized?: boolean | null
  format?: "word" | "line" | "static" | "unavailable"
  selectionNote?: string | null
}

const instrumentalMarker = /^(?:\[(?:instrumental|music|break|interlude|intro|outro)(?:\s+[^\]]*)?\]|instrumental|music continues|music only|instrumental break)$/i
/** True for provider marker lines that describe a gap, not sung text. */
export function isInstrumentalText(value: string): boolean {
  return instrumentalMarker.test(value.trim())
}
// Estimated on-screen window for one vocal line. Line-timed providers supply no
// end times; genuine word end times take precedence when present.
export const GAP_INTERLUDE_MS = 6000
type TimedLyric = { index: number; time: number; vocal: boolean; wordEndMs?: number }
const timing = new WeakMap<Lyrics, { entries: TimedLyric[]; firstVocal?: TimedLyric; lastVocal?: TimedLyric }>()

function timedLyrics(lyrics: Lyrics) {
  const existing = timing.get(lyrics)
  if (existing) return existing
  const entries = lyrics.lines.flatMap((line, index) => {
    if (line.startMs === null) return []
    const value = line.text.trim()
    const words = line.words?.length ? line.words : undefined
    return [{ index, time: line.startMs, vocal: !!value && !instrumentalMarker.test(value),
      wordEndMs: words?.at(-1)?.endMs }]
  }).sort((a, b) => a.time - b.time)
  const result = { entries, firstVocal: entries.find((entry) => entry.vocal), lastVocal: entries.findLast((entry) => entry.vocal) }
  timing.set(lyrics, result)
  return result
}

function timedAt(entries: TimedLyric[], positionMs: number) {
  let low = 0, high = entries.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (entries[mid]!.time <= positionMs) low = mid + 1
    else high = mid
  }
  return entries[low - 1]
}

/** Select a presentation state without guessing when vocals end between lyric timestamps. */
export function selectLyricMoment(lyrics: Lyrics, positionMs: number, hasTrack = true, sourceError?: string | null): LyricMoment {
  if (!hasTrack) return { kind: "no-track" }
  if (sourceError) return { kind: "source-error", message: sourceError }
  if (lyrics.status === "loading") return { kind: "loading" }
  if (lyrics.status === "unavailable" || !lyrics.lines.length) return { kind: "unavailable" }
  if (!lyrics.synced) return { kind: "unsynced" }

  const { entries, firstVocal, lastVocal } = timedLyrics(lyrics)
  // A document can claim line timing from marker lines only. Fall back to the
  // readable static lines instead of reporting an eternal interlude.
  if (!firstVocal) return lyrics.lines.some((line) => line.text.trim() && !instrumentalMarker.test(line.text.trim()))
    ? { kind: "unsynced" }
    : { kind: "instrumental", phase: "unknown" }
  const latest = timedAt(entries, positionMs)
  if (!latest) {
    // Only a known first timed vocal can establish a conservative intro.
    if (firstVocal && positionMs < firstVocal.time) return { kind: "instrumental", phase: "intro" }
    return { kind: "instrumental", phase: "unknown" }
  }
  if (!latest.vocal) {
    const phase = !firstVocal || latest.time < firstVocal.time ? "intro" : lastVocal && lastVocal.time > latest.time ? "interlude" : "outro"
    return { kind: "instrumental", phase }
  }
  // A line-timed lyric carries no end time, so a vocal line is retained for a
  // documented display window after it starts; genuine word ends take
  // precedence over the heuristic when a provider supplies them. A
  // well-separated next line (or no next line at all) turns the tail of a long
  // silence into a neutral interlude/outro instead of a stuck highlight or a
  // blank gap. Short gaps keep the line with no flashing.
  const next = entries.find((entry) => entry.time > latest.time)
  const windowEnd = Math.max(latest.time, latest.wordEndMs ?? latest.time)
  if (positionMs - windowEnd > GAP_INTERLUDE_MS && (!next || positionMs < next.time)) {
    return { kind: "instrumental", phase: next ? "interlude" : "outro" }
  }
  return { kind: "ready-line", lineIndex: latest.index }
}

/** Line that follow mode should scroll to, including the next vocal after a gap. */
export function followLineIndex(lyrics: Lyrics, positionMs: number, hasTrack = true): number {
  const moment = selectLyricMoment(lyrics, positionMs, hasTrack)
  if (moment.kind === "ready-line") return moment.lineIndex
  if (!lyrics.synced) return -1
  const next = lyrics.lines.findIndex((line) => line.startMs !== null && line.startMs > positionMs &&
    !!line.text.trim() && !isInstrumentalText(line.text))
  if (next >= 0) return next
  return lyrics.lines.findLastIndex((line) => line.startMs !== null && !!line.text.trim() && !isInstrumentalText(line.text))
}

const wordBoundaries = new Intl.Segmenter(undefined, { granularity: "grapheme" })
/** Map validated provider word spans onto UTF-16 offsets in the displayed line. */
export function validatedWordOffsets(line: LyricLine): Array<LyricWord & { startOffset: number; endOffset: number }> | null {
  if (!line.words?.length) return null
  const boundaries = new Set(Array.from(wordBoundaries.segment(line.text), (part) => part.index))
  boundaries.add(line.text.length)
  let cursor = 0
  const mapped: Array<LyricWord & { startOffset: number; endOffset: number }> = []
  for (const word of line.words) {
    const target = word.text.replace(/\s/g, "")
    let startOffset = -1, endOffset = -1
    for (const char of target) {
      while (cursor < line.text.length && /\s/u.test(line.text[cursor]!)) cursor++
      const width = char.length
      if (line.text.slice(cursor, cursor + width) !== char) return null
      if (startOffset < 0) startOffset = cursor
      cursor += width
      endOffset = cursor
    }
    if (startOffset < 0 || !boundaries.has(startOffset) || !boundaries.has(endOffset)) return null
    mapped.push({ ...word, startOffset, endOffset })
  }
  if (line.text.slice(cursor).replace(/\s/g, "").length || !boundaries.has(cursor)) return null
  return mapped
}
export const emptyLyrics = (uri: string | null = null): Lyrics => ({ uri, status: uri ? "loading" : "unavailable", synced: false, lines: [], format: "unavailable" })
export function timestamp(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string" || value === "") return null
  const ms = Number(value)
  return Number.isFinite(ms) && ms >= 0 && ms <= 86_400_000 ? ms : null
}
export function lyricScript(value: string): NonNullable<Lyrics["script"]> {
  const letters = value.match(/\p{Letter}/gu) ?? []
  const latin = letters.some((letter) => /\p{Script=Latin}/u.test(letter))
  const other = letters.some((letter) => !/\p{Script=Latin}/u.test(letter))
  return latin && other ? "mixed" : latin ? "latin" : other ? "original" : "unknown"
}
export function fingerprint(value: string) {
  let hash = 2166136261
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619)
  return (hash >>> 0).toString(16)
}
export function normalizeLyrics(value: unknown): Lyrics | null {
  if (!object(value) || !trackUri(value.uri) || !Array.isArray(value.lines) || value.lines.length > 5000) return null
  if (!value.lines.every((line) => object(line) && typeof line.text === "string" && line.text.length <= 4096)) return null
  const declared = ["LINE_SYNCED", "WORD_SYNCED"].includes(value.sync_type as string)
  const lines: LyricLine[] = value.lines.map((line) => {
    const result: LyricLine = { startMs: declared ? timestamp(line.startTimeMs ?? line.startMs) : null, text: text(line.text, 4096) }
    if (declared && Array.isArray(line.words) && line.words.length <= 500) {
      const words: LyricWord[] = []
      for (const word of line.words) {
        if (!object(word) || typeof word.text !== "string" || word.text.length > 500) { words.length = 0; break }
        const startMs = timestamp(word.startMs), endMs = timestamp(word.endMs)
        if (startMs === null || endMs === null || endMs <= startMs ||
            words.length && startMs < words.at(-1)!.endMs) { words.length = 0; break }
        // Numeric strings are normalized to numbers so renderer comparisons do
        // not rely on JavaScript's implicit coercion.
        words.push({ text: text(word.text, 500), startMs, endMs })
      }
      if (words.length && validatedWordOffsets({ ...result, words })) {
        result.words = words
        result.startMs ??= words[0]!.startMs
      }
    }
    return result
  })
  const synced = declared && lines.some((line) => line.startMs !== null)
  if (synced && lines.every((line) => line.startMs !== null)) lines.sort((a, b) => a.startMs! - b.startMs!)
  const provider = value.provider === "lrclib" ? "lrclib" : "spotify"
  const format = lines.some((line) => line.words?.length) ? "word" : synced ? "line" : lines.length ? "static" : "unavailable"
  const script = lyricScript(lines.map((line) => line.text).join(" "))
  return {
    uri: value.uri, status: lines.length ? "ready" : "unavailable", synced, lines,
    provider, format, script, romanized: typeof value.romanized === "boolean" ? value.romanized : null,
    language: typeof value.language === "string" && /^[a-z]{2,3}(?:-[A-Za-z]{2,8})?$/.test(value.language) ? value.language : null,
    attribution: provider === "lrclib" ? "LRCLIB · https://lrclib.net" : "Spotify",
    id: `${provider}:${format}:${script}:${fingerprint(JSON.stringify(lines))}`,
  }
}
export function activeLine(lyrics: Lyrics, positionMs: number): number {
  return lyrics.synced ? timedAt(timedLyrics(lyrics).entries, positionMs)?.index ?? -1 : -1
}

export function validateLyricsDocument(value: unknown): Lyrics {
  if (!object(value) || !Array.isArray(value.lines)) throw new Error("Invalid lyric document")
  if (value.uri === null && !value.lines.length) return emptyLyrics()
  const normalized = normalizeLyrics({ ...value,
    sync_type: value.format === "word" ? "WORD_SYNCED" : value.synced === true ? "LINE_SYNCED" : "UNSYNCED",
    lines: value.lines.map((line) => object(line) ? { ...line, startTimeMs: line.startMs } : line),
  })
  if (!normalized) throw new Error("Invalid lyric document")
  if (!normalized.lines.length && value.status === "loading") normalized.status = "loading"
  normalized.selectionNote = typeof value.selectionNote === "string" ? text(value.selectionNote, 400) : null
  return normalized
}
