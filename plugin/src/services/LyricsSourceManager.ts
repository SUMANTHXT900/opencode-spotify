import { normalizeLyrics, type Lyrics } from "./lyrics.ts"
import { parseLrc, sourceWaiting, validContact } from "./lyrics-source.ts"
import { object } from "./validation.ts"

export interface LyricsTrack { uri: string; title: string; artist: string; album: string; durationMs: number }
export interface SourceResolution {
  uri: string
  candidates: Lyrics[]
  availability: { provider: "spotify" | "lrclib"; state: "ready" | "unavailable" | "disabled" | "error"; detail: string }[]
}
type Lookup = { candidates: Lyrics[]; detail: string; error: boolean }
const MAX_BYTES = 524288
const signature = (value: string) => value.normalize("NFKC").trim().toLocaleLowerCase().replace(/\s+/g, " ")

export class LyricsSourceManager {
  private fetcher: typeof fetch
  private cache = new Map<string, { expires: number; value: Lookup }>()
  private flight: { key: string; promise: Promise<Lookup> } | undefined
  private controller = new AbortController()
  private nextRequest = 0
  private refreshed = new Map<string, number>()
  constructor(fetcher: typeof fetch = fetch) { this.fetcher = fetcher }
  async resolve(track: LyricsTrack, spotify: Lyrics, options: { enabled: boolean; contact: string; refresh: boolean }): Promise<SourceResolution> {
    const candidates = spotify.uri === track.uri && spotify.status === "ready" ? [spotify] : []
    const availability: SourceResolution["availability"] = [{
      provider: "spotify", state: candidates.length ? "ready" : "unavailable",
      detail: candidates.length ? "Connected Spotify client" : spotify.status === "loading" ? sourceWaiting.spotify : "Spotify returned no lyrics",
    }]
    if (!options.enabled || !validContact(options.contact)) {
      availability.push({ provider: "lrclib", state: "disabled", detail: "Opt-in and client contact required" })
      return { uri: track.uri, candidates, availability }
    }
    if (spotify.status === "loading") {
      availability.push({ provider: "lrclib", state: "unavailable", detail: sourceWaiting.lrclib })
      return { uri: track.uri, candidates, availability }
    }
    const key = JSON.stringify(track)
    if (options.refresh && Date.now() - (this.refreshed.get(key) ?? 0) >= 10000) {
      this.cache.delete(key)
      this.refreshed.set(key, Date.now())
      if (this.refreshed.size > 12) this.refreshed.delete(this.refreshed.keys().next().value!)
    }
    let result = this.cache.get(key)?.expires! > Date.now() ? this.cache.get(key)!.value : undefined
    if (!result) {
      if (this.flight?.key === key) result = await this.flight.promise
      else if (this.flight || Date.now() < this.nextRequest) result = { candidates: [], detail: "Provider cooldown; refresh later", error: true }
      else {
        const promise = this.lookup(track, options.contact).then((value) => {
          if (this.cache.size >= 12) this.cache.delete(this.cache.keys().next().value!)
          this.cache.set(key, { expires: Date.now() + (value.candidates.length ? 15 * 60000 : 60000), value })
          return value
        }).finally(() => { if (this.flight?.key === key) this.flight = undefined })
        this.flight = { key, promise }
        result = await promise
      }
    }
    candidates.push(...result.candidates)
    availability.push({ provider: "lrclib", state: result.candidates.length ? "ready" : result.error ? "error" : "unavailable", detail: result.detail })
    return structuredClone({ uri: track.uri, candidates, availability })
  }
  private async lookup(track: LyricsTrack, contact: string): Promise<Lookup> {
    this.nextRequest = Date.now() + 500
    if (!track.title || !track.artist || track.durationMs < 1000 || track.durationMs > 3600000) {
      return { candidates: [], detail: "Exact title, artist and duration are required", error: false }
    }
    const url = new URL("https://lrclib.net/api/get")
    url.searchParams.set("track_name", track.title)
    url.searchParams.set("artist_name", track.artist)
    url.searchParams.set("album_name", track.album)
    url.searchParams.set("duration", String(track.durationMs / 1000))
    try {
      const response = await this.fetcher(url, {
        redirect: "error", signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(6000)]),
        headers: { "User-Agent": `OpenCodeSpotify/0.6.0 (${contact})`, Accept: "application/json" },
      })
      if (response.status === 429 || response.status === 503) {
        const header = response.headers.get("Retry-After") ?? ""
        const seconds = /^\d+$/.test(header) ? Number(header) : Math.max(0, (Date.parse(header) - Date.now()) / 1000)
        this.nextRequest = Date.now() + (Number.isFinite(seconds) ? Math.max(60, seconds) : 60) * 1000 + Math.random() * 1000
        await response.body?.cancel()
        return { candidates: [], detail: "Provider rate limited; respecting Retry-After", error: true }
      }
      if (!response.ok) { await response.body?.cancel(); return { candidates: [], detail: response.status === 404 ? "No exact match" : "Provider unavailable", error: response.status !== 404 } }
      if (!response.headers.get("Content-Type")?.includes("application/json") || Number(response.headers.get("Content-Length")) > MAX_BYTES) { await response.body?.cancel(); throw new Error() }
      const reader = response.body?.getReader()
      if (!reader) throw new Error()
      const chunks: Uint8Array[] = []
      let bytes = 0
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          bytes += value.byteLength
          if (bytes > MAX_BYTES) throw new Error()
          chunks.push(value)
        }
      } finally { await reader.cancel() }
      const record: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"))
      if (!object(record) || typeof record.trackName !== "string" || typeof record.artistName !== "string" ||
          signature(record.trackName) !== signature(track.title) || signature(record.artistName) !== signature(track.artist) ||
          track.album && typeof record.albumName === "string" && signature(record.albumName) !== signature(track.album) ||
          typeof record.duration !== "number" || Math.abs(record.duration * 1000 - track.durationMs) > 2000) {
        return { candidates: [], detail: "Provider match rejected (title/artist/duration)", error: false }
      }
      const candidates: Lyrics[] = []
      const synced = typeof record.syncedLyrics === "string" ? parseLrc(record.syncedLyrics, track.uri) : null
      if (synced) candidates.push(synced)
      if (typeof record.plainLyrics === "string" && record.plainLyrics.trim()) {
        const plain = normalizeLyrics({ uri: track.uri, provider: "lrclib", sync_type: "UNSYNCED",
          lines: record.plainLyrics.split(/\r?\n/).map((text) => ({ text, startTimeMs: null })) })
        if (plain) candidates.push(plain)
      }
      return { candidates, detail: candidates.length ? "LRCLIB · https://lrclib.net" : "No usable lyrics", error: false }
    } catch { return { candidates: [], detail: "Provider request failed or response was rejected", error: true } }
  }
  dispose() { this.controller.abort(); this.cache.clear() }
}
