import { imageInfo, NativeImage } from "@opentui/core"

const origin = "https://i.scdn.co"
const maxBytes = 2 * 1024 * 1024
const maxDimension = 2048
// Keep enough decoded pixels for the largest sidebar/panel cover. The previous
// 160 px cap made a 6-9 row cover visibly soft on high-DPI terminals.
const outputSize = 512
const ambientWidth = 4
const ambientHeight = 3
export type RGB = readonly [number, number, number]
export interface Artwork {
  readonly pixels: Uint8Array
  readonly width: number
  readonly height: number
  readonly accent: RGB
  readonly ambient: readonly RGB[]
}

/** Largest cell box that does not enlarge the decoded texture. */
export function fitArtworkCells(
  dataWidth: number, dataHeight: number, boxWidth: number, boxHeight: number,
  cellWidth: number, cellHeight: number,
) {
  const maxWidth = cellWidth > 0 ? Math.max(1, Math.floor(dataWidth / cellWidth)) : boxWidth
  const maxHeight = cellHeight > 0 ? Math.max(1, Math.floor(dataHeight / cellHeight)) : boxHeight
  return {
    width: Math.max(1, Math.min(boxWidth, maxWidth)),
    height: Math.max(1, Math.min(boxHeight, maxHeight)),
  }
}

export function artworkUrl(reference: string): string | null {
  const id = /^spotify:image:([a-f0-9]{40})$/i.exec(reference)?.[1]
  if (id) return origin + "/image/" + id.toLowerCase()
  if (!/^https:\/\/i\.scdn\.co\/image\/[a-f0-9]{40}$/i.test(reference)) return null
  return reference.toLowerCase()
}

async function readArtwork(url: string, signal: AbortSignal, fetcher: typeof fetch) {
  const response = await fetcher(url, { redirect: "error", credentials: "omit", signal })
  if (!response.ok || response.redirected || (response.url && response.url !== url) || !response.body ||
      Number(response.headers.get("content-length")) > maxBytes) {
    await response.body?.cancel()
    throw new Error("Artwork response refused")
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  let finished = false
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) { finished = true; break }
      size += chunk.value.byteLength
      if (size > maxBytes) throw new Error("Artwork response too large")
      chunks.push(chunk.value)
    }
  } finally {
    if (!finished) void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return bytes
}

export function decodeArtwork(bytes: Uint8Array): Artwork {
  if (!bytes.byteLength || bytes.byteLength > maxBytes) throw new Error("Artwork byte limit")
  const info = imageInfo(bytes)
  if (info.width < 1 || info.height < 1 || Math.max(info.width, info.height, info.sourceWidth, info.sourceHeight) > maxDimension ||
      !["jpeg", "png", "webp"].includes(info.format)) throw new Error("Unsupported artwork image")
  const image = NativeImage.decode(bytes)
  try {
    const scale = Math.min(1, outputSize / Math.max(image.width, image.height))
    const resized = image.resize({
      width: Math.max(1, Math.round(image.width * scale)),
      height: Math.max(1, Math.round(image.height * scale)),
      kernel: "area",
    })
    try {
      const ambientImage = resized.resize({ width: ambientWidth, height: ambientHeight, kernel: "area" })
      try {
        const data = ambientImage.raw().data
        const ambient: RGB[] = Array.from({ length: ambientWidth * ambientHeight }, (_, index) => {
          const start = index * 4
          return [data[start]!, data[start + 1]!, data[start + 2]!]
        })
        const weight = (rgb: RGB) => Math.max(...rgb) - Math.min(...rgb) + Math.max(...rgb) * 0.2
        const accent = ambient.reduce((best, rgb) => weight(rgb) > weight(best) ? rgb : best)
        return { pixels: resized.raw().data, width: resized.width, height: resized.height, ambient, accent }
      } finally { ambientImage.dispose() }
    } finally { resized.dispose() }
  } finally { image.dispose() }
}

interface Request {
  controller: AbortController
  promise: Promise<Artwork | null>
  users: number
}

export class ArtworkService {
  private readonly cache = new Map<string, Artwork>()
  private readonly pending = new Map<string, Request>()
  constructor(private readonly fetcher: typeof fetch = (...args) => fetch(...args), private readonly capacity = 16) {}

  acquire(reference: string): { result: Promise<Artwork | null>; release: () => void } {
    const ready = (value: Artwork | null) => ({ result: Promise.resolve(value), release() {} })
    const url = artworkUrl(reference)
    if (!url) return ready(null)
    const cached = this.cache.get(url)
    if (cached) {
      this.cache.delete(url)
      this.cache.set(url, cached)
      return ready(cached)
    }
    let request = this.pending.get(url)
    if (!request) {
      if (this.pending.size >= 8) return ready(null)
      const controller = new AbortController()
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(5000)])
      const promise = readArtwork(url, signal, this.fetcher).then((bytes) => {
        signal.throwIfAborted()
        const artwork = decodeArtwork(bytes)
        if (this.capacity > 0) {
          this.cache.set(url, artwork)
          while (this.cache.size > this.capacity) this.cache.delete(this.cache.keys().next().value!)
        }
        return artwork
      }).catch(() => null).finally(() => {
        if (this.pending.get(url)?.controller === controller) this.pending.delete(url)
      })
      request = { controller, promise, users: 0 }
      this.pending.set(url, request)
    }
    const active = request
    active.users++
    let released = false
    return { result: active.promise, release: () => {
      if (released) return
      released = true
      if (--active.users === 0 && this.pending.get(url) === active) {
        this.pending.delete(url)
        active.controller.abort()
      }
    } }
  }
}

export const spotifyArtwork = new ArtworkService()

