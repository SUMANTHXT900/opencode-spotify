import { normalizeLyrics, type Lyrics } from "./lyrics.ts"
import { object, trackUri } from "./validation.ts"

export interface LyricsSettings {
  provider: "auto" | "spotify" | "lrclib"
  script: "romanized" | "original" | "auto"
  priority: "timing" | "script"
  preview: boolean
  follow: boolean
  reducedMotion: boolean
  background: boolean
  accent: string
  ambience: "theme" | "album" | "artwork"
  artwork: boolean
  artworkSize: "auto" | "small"
  progressMotion: boolean
  showVolume: boolean
  seekSeconds: number | null
  instrumental: boolean
  strongEmphasis: boolean
  lrclibEnabled: boolean
  lrclibContact: string
  overrides: Record<string, string>
}
export const defaultLyricsSettings = (): LyricsSettings => ({
  provider: "auto", script: "romanized", priority: "timing", preview: true, follow: true,
  reducedMotion: false, background: true, accent: "", lrclibEnabled: false, lrclibContact: "", overrides: {},
  ambience: "album", artwork: true, artworkSize: "auto", progressMotion: true, showVolume: true,
  seekSeconds: null, instrumental: true, strongEmphasis: true,
})
export function validContact(value: string) {
  if (value.length > 200 || /[\s\x00-\x1f\x7f()]/.test(value)) return false
  if (/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(value)) return true
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password && !url.hash } catch { return false }
}
export function validateLyricsSettings(value: unknown): LyricsSettings {
  const defaults = defaultLyricsSettings()
  if (!object(value) || Object.keys(value).some((key) => !(key in defaults)) ||
      !["auto", "spotify", "lrclib"].includes(value.provider as string) ||
      !["romanized", "original", "auto"].includes(value.script as string) ||
      !["timing", "script"].includes(value.priority as string)) throw new Error("Invalid lyrics settings")
  for (const key of ["preview", "follow", "reducedMotion", "background", "lrclibEnabled"]) if (typeof value[key] !== "boolean") throw new Error("Invalid display setting")
  if (typeof value.accent !== "string" || value.accent !== "" && !/^#[a-f0-9]{6}$/i.test(value.accent) ||
      typeof value.lrclibContact !== "string" || value.lrclibContact !== "" && !validContact(value.lrclibContact) ||
      !object(value.overrides) || Object.keys(value.overrides).length > 200 ||
      !Object.entries(value.overrides).every(([uri, id]) => trackUri(uri) && typeof id === "string" && id.length <= 160)) throw new Error("Invalid source setting")
  const settings = { ...defaults, ...value, overrides: { ...value.overrides } } as LyricsSettings
  for (const key of ["artwork", "progressMotion", "showVolume", "instrumental", "strongEmphasis"] as const) {
    if (typeof settings[key] !== "boolean") throw new Error("Invalid player setting")
  }
  if (!["theme", "album", "artwork"].includes(settings.ambience) || !["auto", "small"].includes(settings.artworkSize) ||
      settings.seekSeconds !== null && (!Number.isInteger(settings.seekSeconds) || settings.seekSeconds < 1 || settings.seekSeconds > 120)) {
    throw new Error("Invalid appearance or playback setting")
  }
  return settings
}
export function selectLyrics(candidates: Lyrics[], settings: LyricsSettings): Lyrics | null {
  const available = candidates.filter((candidate) => candidate.status === "ready")
  const override = available.find((candidate) => candidate.id && candidate.id === settings.overrides[candidate.uri ?? ""])
  const scriptScore = (candidate: Lyrics) => settings.script === "auto" ? 0 : settings.script === "original"
    ? candidate.script === "original" ? 2 : candidate.script === "mixed" ? 1 : 0
    : candidate.romanized === true ? 3 : candidate.script === "latin" ? 2 : 0
  const rank = (candidate: Lyrics) => [
    settings.provider !== "auto" && settings.provider === candidate.provider ? 1 : 0,
    ...(settings.priority === "timing" ? [candidate.synced ? 1 : 0, scriptScore(candidate)] : [scriptScore(candidate), candidate.synced ? 1 : 0]),
    candidate.format === "word" ? 1 : 0, candidate.provider === "spotify" ? 1 : 0,
  ]
  const selected = override ?? [...available].sort((a, b) => {
    const left = rank(a), right = rank(b)
    for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return right[i]! - left[i]!
    return (a.id ?? "").localeCompare(b.id ?? "")
  })[0]
  if (!selected) return null
  const notes: string[] = []
  if (settings.provider !== "auto" && selected.provider !== settings.provider) notes.push("Preferred provider unavailable; using fallback")
  if (settings.script === "romanized" && selected.romanized !== true) notes.push(selected.script === "latin" ? "Latin script; romanization unconfirmed" : "Romanized version unavailable; using original/available script")
  if (settings.script === "original" && selected.script !== "original") notes.push("Original-script version unavailable")
  return { ...selected, selectionNote: notes.join(" · ") || null }
}
export class StableLyricsSelection {
  private current: Lyrics | null = null
  private uri: string | null = null
  choose(uri: string | null, candidates: Lyrics[], settings: LyricsSettings, explicit = false) {
    if (uri !== this.uri) { this.uri = uri; this.current = null }
    if (explicit || !this.current) this.current = selectLyrics(candidates.filter((c) => c.uri === uri), settings)
    return this.current
  }
}
export function parseLrc(value: string, uri: string): Lyrics | null {
  if (value.length > 262144) return null
  const lines: { text: string; startTimeMs: number }[] = []
  const offset = Number(value.match(/^\[offset:([+-]?\d+)\]/mi)?.[1] ?? 0)
  for (const raw of value.split(/\r?\n/).slice(0, 5000)) {
    const tags = [...raw.matchAll(/\[(\d{1,3}):([0-5]\d)(?:\.(\d{1,3}))?\]/g)]
    const text = raw.replace(/\[(\d{1,3}):([0-5]\d)(?:\.\d{1,3})?\]/g, "").trim()
    for (const tag of tags) {
      const time = Number(tag[1]) * 60000 + Number(tag[2]) * 1000 + Number((tag[3] ?? "").padEnd(3, "0"))
      lines.push({ text, startTimeMs: Math.max(0, time + offset) })
      if (lines.length > 5000) return null
    }
  }
  return lines.length ? normalizeLyrics({ uri, provider: "lrclib", sync_type: "LINE_SYNCED", lines }) : null
}
