import { test } from "node:test"
import assert from "node:assert/strict"
import { normalizeLyrics, emptyLyrics, activeLine, selectLyricMoment, validatedWordOffsets, followLineIndex, isInstrumentalText } from "../src/services/lyrics.ts"
import { defaultLyricsSettings, validateLyricsSettings, selectLyrics, parseLrc, StableLyricsSelection, isAuthoritativeEmpty, isSourceWaiting } from "../src/services/lyrics-source.ts"
import { LyricsSourceManager } from "../src/services/LyricsSourceManager.ts"
import { initialState, reconciledPosition } from "../src/services/state.ts"
const uri = "spotify:track:1234567890123456789012"
const candidate = (provider: string, sync: string, text: string, time: unknown = 1000) =>
  normalizeLyrics({ uri, provider, sync_type: sync, lines: [{ text, startTimeMs: time }] })!

test("partial timing survives; null is never zero; real word timings are preserved", () => {
  const lyrics = normalizeLyrics({ uri, sync_type: "LINE_SYNCED", lines: [
    { text: "Opening test", startTimeMs: null }, { text: "Timed test", startTimeMs: 1000 },
    { text: "Another test", startTimeMs: 3000 },
  ] })!
  assert.equal(lyrics.synced, true)
  assert.equal(activeLine(lyrics, 0), -1)
  assert.equal(activeLine(lyrics, 1500), 1)
  assert.equal(activeLine(lyrics, 3500), 2)
  assert.equal(activeLine(lyrics, 1200), 1)
  const word = normalizeLyrics({ uri, sync_type: "WORD_SYNCED", lines: [
    { text: "Test words", startTimeMs: 100, words: [
      { text: "Test ", startMs: 100, endMs: 500 }, { text: "words", startMs: 500, endMs: 900 },
    ] },
  ] })!
  assert.equal(word.format, "word")
  assert.equal(word.lines[0]!.words?.[1]!.startMs, 500)
  assert.deepEqual(validatedWordOffsets(word.lines[0]!)?.map(({ startOffset, endOffset }) => [startOffset, endOffset]), [[0, 4], [5, 10]])
  for (const words of [
    [{ text: "Test ", startMs: 100, endMs: 500 }, { text: "words", startMs: 400, endMs: 900 }],
    [{ text: "Test words", startMs: 100, endMs: 100 }],
    [{ text: "Different text", startMs: 100, endMs: 900 }],
  ]) {
    const malformed = normalizeLyrics({ uri, sync_type: "WORD_SYNCED", lines: [
      { text: "Test words", startTimeMs: 100, words },
    ] })!
    assert.equal(malformed.lines[0]!.words, undefined)
    assert.equal(malformed.format, "line", "unverified word spans are dropped rather than guessed")
  }
  const primitive = normalizeLyrics({ uri, sync_type: "WORD_SYNCED", lines: [
    { text: "Test words", startTimeMs: 100, words: [null, { text: "Test words", startMs: 100, endMs: 900 }] },
  ] })!
  assert.equal(primitive.lines[0]!.words, undefined)
  assert.equal(primitive.format, "line")
  const numericStrings = normalizeLyrics({ uri, sync_type: "WORD_SYNCED", lines: [
    { text: "Test words", startTimeMs: "100", words: [
      { text: "Test ", startMs: "100", endMs: "500" }, { text: "words", startMs: "500", endMs: "900" },
    ] },
  ] })!
  assert.deepEqual(numericStrings.lines[0]!.words?.map(({ startMs, endMs }) => [startMs, endMs]), [[100, 500], [500, 900]])
  assert.equal(numericStrings.lines[0]!.startMs, 100)
  assert.equal(validatedWordOffsets({ text: "क्ष", startMs: 0, words: [{ text: "क्", startMs: 0, endMs: 100 }, { text: "ष", startMs: 100, endMs: 200 }] }), null,
    "word offsets cannot land inside a conjunct cluster")
})

test("long vocal gaps become interlude/outro; short gaps keep the line", () => {
  const lyrics = normalizeLyrics({ uri, sync_type: "LINE_SYNCED", lines: [
    { text: "Opens", startTimeMs: 0 }, { text: "Second", startTimeMs: 8000 },
    { text: "Returns", startTimeMs: 19000 },
  ] })!
  // A line starting at zero is active immediately, never unavailable.
  assert.deepEqual(selectLyricMoment(lyrics, 0), { kind: "ready-line", lineIndex: 0 })
  // Short gap after a line: the line is retained naturally.
  assert.deepEqual(selectLyricMoment(lyrics, 9000), { kind: "ready-line", lineIndex: 1 })
  // Long 8s-19s silence: line, then neutral interlude, then the next vocal.
  assert.deepEqual(selectLyricMoment(lyrics, 13000), { kind: "ready-line", lineIndex: 1 })
  assert.deepEqual(selectLyricMoment(lyrics, 15000), { kind: "instrumental", phase: "interlude" })
  assert.deepEqual(selectLyricMoment(lyrics, 19500), { kind: "ready-line", lineIndex: 2 })
  // After the final line: retained briefly, then outro until track end.
  assert.deepEqual(selectLyricMoment(lyrics, 20000), { kind: "ready-line", lineIndex: 2 })
  assert.deepEqual(selectLyricMoment(lyrics, 40000), { kind: "instrumental", phase: "outro" })
  // Genuine word ends take precedence over the heuristic window.
  const words = normalizeLyrics({ uri, sync_type: "WORD_SYNCED", lines: [{
    text: "Sung line", startTimeMs: 0, words: [
      { text: "Sung ", startMs: 0, endMs: 1000 }, { text: "line", startMs: 1000, endMs: 2000 },
    ] },
  ] })!
  assert.deepEqual(selectLyricMoment(words, 3000), { kind: "ready-line", lineIndex: 0 })
  assert.deepEqual(selectLyricMoment(words, 9000), { kind: "instrumental", phase: "outro" })
})

test("lyric moments distinguish loading, intro, explicit gaps, vocals, outro and unavailable", () => {
  const lyrics = normalizeLyrics({ uri, sync_type: "LINE_SYNCED", lines: [
    { text: "", startTimeMs: 0 }, { text: "First line", startTimeMs: 2000 },
    { text: "[Instrumental]", startTimeMs: 5000 }, { text: "Last line", startTimeMs: 9000 },
    { text: "", startTimeMs: 12000 },
  ] })!
  assert.deepEqual(selectLyricMoment({ ...lyrics, status: "loading" }, 1000), { kind: "loading" })
  assert.deepEqual(selectLyricMoment(lyrics, 1000), { kind: "instrumental", phase: "intro" })
  assert.deepEqual(selectLyricMoment(lyrics, 3000), { kind: "ready-line", lineIndex: 1 })
  assert.deepEqual(selectLyricMoment(lyrics, 6000), { kind: "instrumental", phase: "interlude" })
  assert.deepEqual(selectLyricMoment(lyrics, 10000), { kind: "ready-line", lineIndex: 3 })
  assert.deepEqual(selectLyricMoment(lyrics, 13000), { kind: "instrumental", phase: "outro" })
  assert.deepEqual(selectLyricMoment(lyrics, 0, false), { kind: "no-track" })
  assert.deepEqual(selectLyricMoment({ ...lyrics, status: "unavailable", lines: [] }, 0), { kind: "unavailable" })
  assert.deepEqual(selectLyricMoment(lyrics, 0, true, "offline"), { kind: "source-error", message: "offline" })
})

test("timed marker-only documents fall back to readable unsynced lines", () => {
  const timed = normalizeLyrics({ uri, sync_type: "LINE_SYNCED", lines: [
    { text: "[Instrumental]", startTimeMs: 0 }, { text: "Readable static line", startTimeMs: null },
  ] })!
  assert.equal(timed.synced, true)
  assert.deepEqual(selectLyricMoment(timed, 1000), { kind: "unsynced" })
})

test("follow target includes the next vocal after an interlude", () => {
  const lyrics = normalizeLyrics({ uri, sync_type: "LINE_SYNCED", lines: [
    { text: "Opening", startTimeMs: 0 }, { text: "[Instrumental]", startTimeMs: 8000 },
    { text: "Next vocal", startTimeMs: 19000 },
  ] })!
  assert.equal(isInstrumentalText("[Instrumental]"), true)
  assert.equal(isInstrumentalText("Instrumental"), true)
  assert.equal(isInstrumentalText("Not a marker"), false)
  assert.equal(followLineIndex(lyrics, 2000), 0)
  assert.equal(followLineIndex(lyrics, 15000), 2, "follow targets the upcoming vocal, not the stale line")
  assert.equal(followLineIndex({ ...lyrics, status: "unavailable", lines: [] }, 15000), -1)
})

test("source ranking is deterministic and script/timing tradeoffs are explicit", () => {
  const original = candidate("spotify", "LINE_SYNCED", "పరీక్ష పదాలు")
  const latin = candidate("lrclib", "UNSYNCED", "pariksha padalu", null)
  const settings = defaultLyricsSettings()
  assert.equal(settings.script, "romanized")
  assert.equal(selectLyrics([latin, original], settings)?.provider, "spotify")
  const selected = selectLyrics([original, latin], { ...settings, priority: "script" })!
  assert.equal(selected.provider, "lrclib")
  assert.match(selected.selectionNote ?? "", /unconfirmed/i)
  assert.equal(selectLyrics([original], { ...settings, priority: "script" })?.id, original.id)
})

test("selection stays stable until explicit source/settings change or track change", () => {
  const session = new StableLyricsSelection()
  const a = candidate("spotify", "UNSYNCED", "Synthetic source A", null)
  const b = candidate("lrclib", "LINE_SYNCED", "Synthetic source B")
  assert.equal(session.choose(uri, [a], defaultLyricsSettings())?.id, a.id)
  assert.equal(session.choose(uri, [a, b], defaultLyricsSettings())?.id, a.id)
  assert.equal(session.choose(uri, [a, b], { ...defaultLyricsSettings(), overrides: { [uri]: b.id! } }, true)?.id, b.id)
  session.choose("spotify:track:xxxxxxxxxxxxxxxxxxxxxx", [], defaultLyricsSettings())
  assert.equal(session.choose(uri, [a, b], defaultLyricsSettings())?.id, b.id)
})

test("withdrawn selection falls back while still-available selection stays sticky", () => {
  const session = new StableLyricsSelection()
  const a = candidate("spotify", "UNSYNCED", "Synthetic source A", null)
  const b = candidate("lrclib", "LINE_SYNCED", "Synthetic source B")
  assert.equal(session.choose(uri, [a], defaultLyricsSettings())?.id, a.id)
  assert.equal(session.choose(uri, [a, b], defaultLyricsSettings())?.id, a.id, "sticky while still offered")
  assert.equal(session.choose(uri, [b], defaultLyricsSettings())?.id, b.id, "withdrawn document is replaced")
  // A document with the same fingerprint under a different URI does not
  // count as still available.
  const otherUri = "spotify:track:AAAAAAAAAAAAAAAAAAAAAA"
  const sameTextElsewhere = normalizeLyrics({ uri: otherUri, provider: "lrclib", sync_type: "LINE_SYNCED",
    lines: [{ text: "Synthetic source B", startTimeMs: 1000 }] })!
  assert.equal(sameTextElsewhere.id, b.id)
  assert.equal(session.choose(uri, [sameTextElsewhere], defaultLyricsSettings()), null, "other-track document is not a match")
})

test("withdrawn override falls back to the remaining candidate", () => {
  const session = new StableLyricsSelection()
  const a = candidate("spotify", "UNSYNCED", "Synthetic source A", null)
  const b = candidate("lrclib", "LINE_SYNCED", "Synthetic source B")
  const overridden = { ...defaultLyricsSettings(), overrides: { [uri]: a.id! } }
  assert.equal(session.choose(uri, [a, b], overridden)?.id, a.id)
  assert.equal(session.choose(uri, [b], overridden)?.id, b.id, "withdrawn override falls back")
})

test("authoritative empty is distinguished from transient resolver errors", async () => {
  const track = { uri, title: "Synthetic", artist: "Test artist", album: "Tests", durationMs: 180000 }
  const options = { enabled: true, contact: "https://example.test/plugin", refresh: false }
  const missing = () => ({ ...emptyLyrics(uri), status: "unavailable" as const })
  const loading = () => ({ ...emptyLyrics(uri), status: "loading" as const })
  // 404 is an authoritative negative through the real resolver.
  const notFound = new LyricsSourceManager(async () => new Response("not found", { status: 404 }))
  const authoritative = await notFound.resolve(track, missing(), options)
  assert.equal(authoritative.candidates.length, 0)
  assert.equal(isAuthoritativeEmpty(authoritative), true)
  // A waiting Spotify document is not authoritative, even with no candidates.
  const waiting = await notFound.resolve(track, loading(), options)
  assert.equal(waiting.candidates.length, 0)
  assert.deepEqual(waiting.availability.filter(isSourceWaiting).map((entry) => entry.provider), ["spotify", "lrclib"])
  assert.equal(isAuthoritativeEmpty(waiting), false)
  notFound.dispose()
  // A thrown fetch is a transient error through the real resolver.
  const failing = new LyricsSourceManager(async () => { throw new Error("boom") })
  const transient = await failing.resolve(track, missing(), options)
  assert.equal(transient.candidates.length, 0)
  assert.equal(isAuthoritativeEmpty(transient), false, "error state retains the loaded document")
  failing.dispose()
  // Defensive shapes never authorize clearing.
  assert.equal(isAuthoritativeEmpty({ candidates: [], availability: [] }), false)
  const readyEntry = { provider: "spotify", state: "ready", detail: "x" }
  assert.equal(isAuthoritativeEmpty({ candidates: [missing()], availability: [readyEntry] }), false)
})

test("LRC parses genuine timestamps, repeated timestamps and static alternatives without inventing word timing", () => {
  const result = parseLrc("[00:01.25][00:03.50]Test line\n[00:07.000]Next test\n[ar:metadata]", uri)
  assert.deepEqual(result?.lines.map((l) => l.startMs), [1250, 3500, 7000])
  assert.equal(result?.format, "line")
  assert.equal(parseLrc("plain only", uri), null)
})

test("settings validate persistence shape without accepting credentials or unlimited overrides", () => {
  const settings = { ...defaultLyricsSettings(), provider: "lrclib" as const, reducedMotion: true, overrides: { [uri]: "lrclib:example" } }
  assert.deepEqual(validateLyricsSettings(JSON.parse(JSON.stringify(settings))), settings)
  const legacy = {
    provider: "lrclib", script: "original", priority: "script", preview: true, follow: false,
    reducedMotion: true, background: false, accent: "#112233", lrclibEnabled: true,
    lrclibContact: "https://example.com", overrides: { [uri]: "lrclib:example" },
  }
  assert.deepEqual(validateLyricsSettings(legacy), { ...defaultLyricsSettings(), ...legacy })
  assert.throws(() => validateLyricsSettings({ ...settings, secret: "not allowed" }))
  assert.throws(() => validateLyricsSettings({ ...settings, accent: "javascript:bad" }))
  assert.throws(() => validateLyricsSettings({ ...settings, seekSeconds: 0 }))
})

test("clock reconciliation freezes through disconnect and accepts verified pause/seek snapshots", () => {
  assert.equal(reconciledPosition(42000, uri, initialState()), 42000)
  const track = { uri, title: "Test", artist: "Artist", album: "", image: "" }
  assert.equal(reconciledPosition(42000, uri, { ...initialState(), connection: "connected", track }), 42000)
  const next = { ...initialState(), connection: "connected" as const, track,
    playback: { ...initialState().playback, trackUri: uri, positionMs: 1000, isPlaying: false } }
  assert.equal(reconciledPosition(42000, uri, next), 1000)
})
