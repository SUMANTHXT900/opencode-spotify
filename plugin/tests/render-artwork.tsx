import assert from "node:assert/strict"
import { deflateSync } from "node:zlib"
import { testRender } from "@opentui/solid"
import { useRenderer } from "@opentui/solid"
import { ArtworkView } from "../src/components/ArtworkView"
import { ArtworkService, artworkUrl, decodeArtwork, type Artwork } from "../src/services/artwork"

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff
  for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)) }
  return (crc ^ 0xffffffff) >>> 0
}
function chunk(type: string, data: Uint8Array) {
  const name = Buffer.from(type), out = Buffer.alloc(data.length + 12)
  out.writeUInt32BE(data.length, 0); name.copy(out, 4); Buffer.from(data).copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}
function png(width: number, height: number) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6
  const scan = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * (width * 4 + 1) + 1 + x * 4
    scan[i] = 240; scan[i + 1] = 25; scan[i + 2] = 40; scan[i + 3] = 255
  }
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(scan)), chunk("IEND", Buffer.alloc(0))])
}
const id = (n: number) => n.toString(16).padStart(40, "0")
const ref = (n: number) => `spotify:image:${id(n)}`
const bytes = png(4, 4)
assert.equal(artworkUrl(ref(1)), `https://i.scdn.co/image/${id(1)}`)
for (const invalid of [`https://i.scdn.co.evil/image/${id(1)}`, `https://i.scdn.co/image/${id(1)}?x=1`, `http://i.scdn.co/image/${id(1)}`, `https://i.scdn.co/other/${id(1)}`, "spotify:image:abc"]) assert.equal(artworkUrl(invalid), null)
assert.throws(() => decodeArtwork(new Uint8Array([1, 2, 3])))
assert.throws(() => decodeArtwork(png(2049, 1)))
const decoded = decodeArtwork(bytes)
assert.equal(decoded.width, 4); assert.equal(decoded.height, 4)
assert.ok(decoded.accent[0] > 200 && decoded.accent[1] < 60)
let calls = 0
const fetcher: typeof fetch = async (_input, init) => {
  calls++; assert.equal(init?.redirect, "error"); assert.equal(init?.credentials, "omit")
  return new Response(bytes, { headers: { "content-type": "image/png" } })
}
const cache = new ArtworkService(fetcher, 2)
const first = cache.acquire(ref(1)), duplicate = cache.acquire(ref(1))
assert.strictEqual(await first.result, await duplicate.result); assert.equal(calls, 1)
await cache.acquire(ref(2)).result; await cache.acquire(ref(1)).result; await cache.acquire(ref(3)).result
assert.equal(calls, 3)
await cache.acquire(ref(2)).result; assert.equal(calls, 4, "least recently used artwork is evicted")
const rejected = async (response: Response) => {
  const service = new ArtworkService(async () => response)
  assert.equal(await service.acquire(ref(5)).result, null)
}
await rejected(new Response(bytes, { status: 302, headers: { location: "https://evil.invalid" } }))
await rejected(new Response(bytes, { headers: { "content-length": String(2 * 1024 * 1024 + 1) } }))
await rejected(new Response(new Uint8Array(2 * 1024 * 1024 + 1)))
await rejected(new Response(new Uint8Array([1, 2, 3])))
let aborted = false
const pending = new ArtworkService((_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")) })))
const old = pending.acquire(ref(6)); old.release(); assert.equal(await old.result, null); assert.ok(aborted)

function Probe() {
  const renderer = useRenderer()
  return <ArtworkView artwork={{ kind: "ready", data: decoded as Artwork }} width={8} height={4} renderer={renderer} muted="#888888" />
}
const setup = await testRender(Probe, { width: 16, height: 8 })
try {
  await setup.flush()
  const frame = setup.captureSpans()
  const spans = frame.lines.flatMap((line) => line.spans)
  assert.ok(spans.some((span) => { const [r, g, b] = span.fg.toInts(); return r > 150 && g < 100 && b < 100 }), JSON.stringify(frame))
} finally { await setup.dispose() }
console.log("artwork service and native colored image rendering passed")
