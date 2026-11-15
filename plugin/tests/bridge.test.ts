import { test } from "node:test"
import assert from "node:assert/strict"
import { once } from "node:events"
import WebSocket from "ws"
import { randomBytes } from "node:crypto"
import { proof, HANDSHAKE } from "../src/services/auth.ts"
import { SpicetifyServer } from "../src/services/SpicetifyServer.ts"
import { commands } from "../src/services/validation.ts"
import { acquireBridge } from "../src/services/owner.ts"
const credential = "a".repeat(64)
const configuration = { version: 1 as const, secret: credential, origins: ["https://xpui.app.spotify.com"], installed: true }
const createServer = (port = 0) => new SpicetifyServer(port, { configuration })

const track = { type: "track", uri: "spotify:track:1234567890123456789012", title: "First", artist: "Artist", album: "Album" }
const capabilities = { type: "capabilities", protocol: 2, apis: { playlists: true, library: true, queue: true, queue_mutation: false, play: true, search: true }, commands, search_mode: "graphql" }
async function connect(server: SpicetifyServer, secret = credential) {
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}`, { origin: "https://xpui.app.spotify.com" })
  const clientNonce = randomBytes(32).toString("hex")
  socket.on("open", () => socket.send(JSON.stringify({ type: "hello", protocol: 2, handshake: HANDSHAKE, role: "extension", nonce: clientNonce })))
  const [raw] = await once(socket, "message")
  const challenge = JSON.parse(raw.toString())
  socket.send(JSON.stringify({ type: "auth", protocol: 2, proof: proof(secret, "client", "extension", clientNonce, challenge.nonce) }))
  if (secret === credential) await once(socket, "message")
  return socket
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 2000
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for state")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test("receives validated events, propagates updates, cleans up and reconnects", async () => {
  const server = createServer()
  await server.start()
  const states: string[] = []
  const unsubscribe = server.subscribe((state) => states.push(state.connection))
  try {
    const client = await connect(server)
    await until(() => server.state.connection === "connected")
    client.send(JSON.stringify({ type: "track", title: 42 }))
    client.send(JSON.stringify({ type: "unknown" }))
    client.send(JSON.stringify(capabilities))
    client.send(JSON.stringify(track))
    await until(() => server.state.track?.title === "First")
    assert.equal(server.state.capabilities?.protocol, 2)
    assert.equal(server.state.playback.isPlaying, null)
    client.send(JSON.stringify({ ...track, title: "Second" }))
    await until(() => server.state.track?.title === "Second")
    client.close()
    await until(() => server.state.connection === "disconnected")
    assert.equal(server.state.track, null)
    unsubscribe()
    const count = states.length
    const second = await connect(server)
    await until(() => server.state.connection === "connected")
    assert.equal(states.length, count)
    second.close()
  } finally {
    await server.stop()
  }
})

test("start is idempotent and reports port conflicts without terminating another owner", async () => {
  const first = createServer()
  await first.start()
  await first.start()
  const second = createServer(first.port)
  try {
    await second.start()
    assert.equal(second.state.connection, "disconnected")
    assert.equal(first.state.connection, "disconnected")
  } finally {
    await second.stop()
    await first.stop()
  }
})

test("rejects unsupported protocol and does not retain track", async () => {
  const server = createServer()
  await server.start()
  try {
    const client = await connect(server)
    client.send(JSON.stringify({ ...capabilities, protocol: 9 }))
    await until(() => server.state.connection === "error")
    assert.match(server.state.error ?? "", /protocol/i)
    assert.equal(server.state.track, null)
    client.close()
  } finally {
    await server.stop()
  }
})

test("authenticated requests correlate success, failures, timeout and disconnect cleanup", async () => {
  const server = createServer()
  await server.start()
  try {
    const client = await connect(server)
    client.send(JSON.stringify(capabilities))
    await until(() => !!server.state.capabilities)
    client.on("message", (raw) => {
      const request = JSON.parse(raw.toString())
      if (request.command === "play") client.send(JSON.stringify({ type: "response", id: request.id, ok: true, result: { accepted: true } }))
      if (request.command === "pause") client.send(JSON.stringify({ type: "response", id: request.id, ok: false, error: { code: "spotify_api", message: "Failed" } }))
    })
    assert.deepEqual(await server.request("play"), { accepted: true })
    await assert.rejects(server.request("pause"), /Failed/)
    await assert.rejects(server.request("next", {}, 15), /timed out/)
    const pending = server.request("previous")
    client.close()
    await assert.rejects(pending, /disconnected/)
  } finally { await server.stop() }
})

test("bad credentials never authenticate or accept track data", async () => {
  const server = createServer()
  await server.start()
  try {
    const client = await connect(server, "wrong")
    await once(client, "close")
    assert.notEqual(server.state.connection, "connected")
    assert.equal(server.state.track, null)
  } finally { await server.stop() }
})

test("lyrics follow the current URI only and clear after track change", async () => {
  const server = createServer()
  await server.start()
  try {
    const client = await connect(server)
    client.send(JSON.stringify(track))
    client.send(JSON.stringify({ type: "lyrics", uri: track.uri, sync_type: "LINE_SYNCED", lines: [{ text: "fixture", startTimeMs: "100" }] }))
    await until(() => server.getLyrics().status === "ready")
    const sources = await server.getLyricsSources({ uri: track.uri, lrclib: false, contact: "", refresh: false })
    assert.equal(sources.uri, track.uri)
    assert.equal(sources.candidates[0]?.provider, "spotify")
    assert.equal(sources.availability.find((item) => item.provider === "spotify")?.state, "ready")
    assert.equal(sources.availability.find((item) => item.provider === "lrclib")?.state, "disabled")
    const second = { ...track, uri: "spotify:track:xxxxxxxxxxxxxxxxxxxxxx" }
    client.send(JSON.stringify(second))
    client.send(JSON.stringify({ type: "lyrics", uri: track.uri, lines: [{ text: "stale", startTimeMs: 0 }] }))
    await until(() => server.state.track?.uri === second.uri)
    assert.equal(server.getLyrics().lines.length, 0)
    assert.equal(server.getLyrics().uri, second.uri)
    await assert.rejects(server.getLyricsSources({ uri: track.uri, lrclib: false, contact: "", refresh: false }), /Track changed/)
    client.close()
    await until(() => server.state.connection === "disconnected")
    assert.equal(server.getLyrics().uri, second.uri) // Transport loss does not destroy the valid document.
  } finally { await server.stop() }
})

test("out-of-order search replies stay associated with their requests", async () => {
  const server = createServer()
  await server.start()
  try {
    const client = await connect(server)
    client.send(JSON.stringify(capabilities))
    await until(() => !!server.state.capabilities)
    const requests: any[] = []
    client.on("message", (raw) => { requests.push(JSON.parse(raw.toString())) })
    const first = server.request("search", { query: "first", offset: 0, limit: 50 })
    const second = server.request("search", { query: "second", offset: 50, limit: 50 })
    await until(() => requests.length === 2)
    for (const req of [...requests].reverse()) client.send(JSON.stringify({ type: "response", id: req.id, ok: true, result: { items: [], offset: req.params.offset, limit: 50, total: 100 } }))
    assert.equal((await second as { offset: number }).offset, 50)
    assert.equal((await first as { offset: number }).offset, 0)
    client.close()
  } finally { await server.stop() }
})

test("reference-counted setup shares one server, with idempotent disposal and reload", async () => {
  const first = await acquireBridge(0, { configuration })
  const second = await acquireBridge(0, { configuration })
  assert.equal(first.server, second.server)
  const port = first.server.port
  await first.release()
  await first.release()
  assert.equal(second.server.port, port)
  await second.release()
  const reloaded = await acquireBridge(0, { configuration })
  assert.notEqual(reloaded.server, first.server)
  await reloaded.release()
})

test("rejects untrusted browser Origins before the handshake", async () => {
  const server = createServer()
  await server.start()
  try {
    const client = new WebSocket(`ws://127.0.0.1:${server.port}`, { origin: "https://untrusted.example" })
    await assert.rejects(once(client, "open"), /401/)
    assert.notEqual(server.state.connection, "connected")
  } finally { await server.stop() }
})
