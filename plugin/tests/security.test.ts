import { test } from "node:test"
import assert from "node:assert/strict"
import { once } from "node:events"
import { randomBytes } from "node:crypto"
import WebSocket, { WebSocketServer } from "ws"
import { SpicetifyServer } from "../src/services/SpicetifyServer.ts"
import { HANDSHAKE, proof, verifyProof } from "../src/services/auth.ts"
import { commands } from "../src/services/validation.ts"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { provision, markInstalled, loadConfiguration } from "../src/services/credentials.ts"

const origin = "https://observed-desktop.example"
const secret = "a".repeat(64)
const config = () => ({ version: 1 as const, secret, origins: [origin], installed: true })
const server = (handshakeMs = 5000) => new SpicetifyServer(0, { configuration: config(), handshakeMs })
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) { if (check()) return; await wait(10) }
  assert.fail("Timed out")
}
async function hello(receiver: SpicetifyServer, nonce = randomBytes(32).toString("hex")) {
  const ws = new WebSocket(`ws://127.0.0.1:${receiver.port}`, { origin })
  ws.on("open", () => ws.send(JSON.stringify({ type: "hello", protocol: 2, handshake: HANDSHAKE, role: "extension", nonce })))
  const [raw] = await once(ws, "message")
  const challenge = JSON.parse(raw.toString())
  assert.equal(verifyProof(proof(secret, "server", "extension", nonce, challenge.nonce), challenge.serverProof), true)
  return { ws, nonce, challenge }
}
async function authenticate(receiver: SpicetifyServer) {
  const connection = await hello(receiver)
  connection.ws.send(JSON.stringify({ type: "auth", protocol: 2,
    proof: proof(secret, "client", "extension", connection.nonce, connection.challenge.nonce) }))
  await once(connection.ws, "message")
  return connection.ws
}

test("Host, URL, website, missing and null Origins reject before handshake", async () => {
  const receiver = server()
  await receiver.start()
  try {
    for (const options of [{ origin: "https://evil.example" }, {}, { origin: "null" },
      { origin, headers: { Host: `localhost:${receiver.port}` } }, { origin, headers: { Host: "127.0.0.1:1" } }]) {
      const ws = new WebSocket(`ws://127.0.0.1:${receiver.port}`, options)
      await assert.rejects(once(ws, "open"), /401/)
    }
    const ws = new WebSocket(`ws://127.0.0.1:${receiver.port}/?secret=not-allowed`, { origin })
    await assert.rejects(once(ws, "open"), /401/)
  } finally { await receiver.stop() }
})

test("missing proof, malformed proof, replay and pre-auth RPC cannot authenticate", async () => {
  const receiver = server()
  await receiver.start()
  try {
    const old = await hello(receiver)
    const oldProof = proof(secret, "client", "extension", old.nonce, old.challenge.nonce)
    old.ws.terminate()
    for (const message of [
      { type: "auth", protocol: 2 },
      { type: "auth", protocol: 2, proof: "z".repeat(64) },
      { type: "auth", protocol: 2, proof: oldProof },
      { type: "request", id: "x", command: "play", params: {} },
    ]) {
      const { ws } = await hello(receiver)
      ws.send(JSON.stringify(message))
      await once(ws, "close")
      assert.notEqual(receiver.state.connection, "connected")
    }
  } finally { await receiver.stop() }
})

test("handshake expires, malformed JSON and oversized payloads close cleanly", async () => {
  const receiver = server(50)
  await receiver.start()
  try {
    const expired = await hello(receiver)
    await once(expired.ws, "close")
    const malformed = await authenticate(receiver)
    malformed.send("{")
    await once(malformed, "close")
    const oversized = await authenticate(receiver)
    oversized.send("x".repeat(4 * 1024 * 1024 + 1))
    await once(oversized, "close")
    assert.equal(receiver.state.track, null)
  } finally { await receiver.stop() }
})

test("deep objects, binary payloads and message floods are bounded", async () => {
  const receiver = server()
  await receiver.start()
  try {
    const deep = await authenticate(receiver)
    deep.send('{"x":'.repeat(26) + "null" + "}".repeat(26))
    await once(deep, "close")
    const binary = await authenticate(receiver)
    binary.send(Buffer.from("text"))
    await once(binary, "close")
    const flooded = await authenticate(receiver)
    for (let i = 0; i < 65; i++) flooded.send("{}")
    await once(flooded, "close")
  } finally { await receiver.stop() }
})

test("authenticated shared owners mirror state, lyrics, commands and survive owner restart", async () => {
  const first = server()
  await first.start()
  const second = new SpicetifyServer(first.port, { configuration: config() })
  await second.start()
  for (let i = 0; i < 10; i++) await second.start()
  try {
    const extension = await authenticate(first)
    extension.send(JSON.stringify({ type: "capabilities", protocol: 2, apis: {}, commands, search_mode: null }))
    const uri = "spotify:track:1234567890123456789012"
    extension.send(JSON.stringify({ type: "track", uri, title: "Shared", artist: "Artist", album: "Album" }))
    extension.send(JSON.stringify({ type: "lyrics", uri, sync_type: "LINE_SYNCED", lines: [{ text: "Line", startTimeMs: 100 }] }))
    await until(() => second.state.track?.title === "Shared" && second.getLyrics().lines.length === 1)
    assert.equal(second.getLyrics().synced, true)
    extension.on("message", (raw) => {
      const request = JSON.parse(raw.toString())
      extension.send(JSON.stringify({ type: "response", id: request.id, ok: true, result: { accepted: true } }))
    })
    assert.deepEqual(await second.request("play"), { accepted: true })
    await assert.rejects(second.request("shell", {}), /Unsupported/)
    await assert.rejects(second.request("set_volume", { value: Infinity }), /Invalid/)
    await first.stop()
    await until(() => second.state.connection === "disconnected")
    const restarted = await authenticate(second)
    restarted.close()
  } finally { await second.stop(); await first.stop() }
})

test("unrelated listener and a compatible listener with the wrong secret are not trusted", async () => {
  const unrelated = new WebSocketServer({ host: "127.0.0.1", port: 0 })
  await once(unrelated, "listening")
  unrelated.on("connection", (ws) => ws.close())
  const address = unrelated.address()
  const receiver = new SpicetifyServer(typeof address === "object" && address ? address.port : 0, { configuration: config() })
  await receiver.start()
  assert.match(receiver.state.error ?? "", /Local port unavailable/)
  await receiver.stop()
  await new Promise<void>((r) => unrelated.close(() => r()))
  const first = server()
  await first.start()
  const wrong = new SpicetifyServer(first.port, { configuration: { ...config(), secret: "b".repeat(64) } })
  try {
    await wrong.start()
    assert.match(wrong.state.error ?? "", /not authenticated/)
  } finally { await wrong.stop(); await first.stop() }
})

test("missing installation config never starts an unauthenticated receiver", async () => {
  const receiver = new SpicetifyServer(0, { path: "does-not-exist/bridge.json" })
  await receiver.start()
  assert.match(receiver.state.error ?? "", /configuration error/)
  await assert.rejects(receiver.request("play"), /configuration error/)
  await receiver.stop()
})

test("first authenticated desktop connection pins its observed Origin across restarts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spotify-origin-"))
  const path = join(directory, "bridge.json")
  const installed = provision(path)
  markInstalled(path)
  const receiver = new SpicetifyServer(0, { path })
  await receiver.start()
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${receiver.port}`, { origin })
    const nonce = randomBytes(32).toString("hex")
    ws.on("open", () => ws.send(JSON.stringify({ type: "hello", protocol: 2, handshake: HANDSHAKE, role: "extension", nonce })))
    const [raw] = await once(ws, "message")
    assert.deepEqual(loadConfiguration(path).origins, []) // A header alone is not evidence.
    const challenge = JSON.parse(raw.toString())
    ws.send(JSON.stringify({ type: "auth", protocol: 2, proof: proof(installed.secret, "client", "extension", nonce, challenge.nonce) }))
    await once(ws, "message")
    assert.deepEqual(loadConfiguration(path).origins, [origin])
    ws.close()
    await receiver.stop()
    await receiver.start()
    const unauthorized = new WebSocket(`ws://127.0.0.1:${receiver.port}`, { origin: "https://another.example" })
    await assert.rejects(once(unauthorized, "open"), /401/)
    assert.equal(loadConfiguration(path).secret, installed.secret)
  } finally { await receiver.stop(); await rm(directory, { recursive: true, force: true }) }
})

test("connection and outstanding-RPC limits do not allocate unbounded work", async () => {
  const receiver = server()
  await receiver.start()
  const sockets: WebSocket[] = []
  try {
    for (let i = 0; i < 12; i++) {
      const socket = new WebSocket(`ws://127.0.0.1:${receiver.port}`, { origin })
      sockets.push(socket)
      await once(socket, "open")
    }
    const extra = new WebSocket(`ws://127.0.0.1:${receiver.port}`, { origin })
    await assert.rejects(once(extra, "open"), /401/)
    for (const socket of sockets) socket.terminate()
    await wait(20)
    const extension = await authenticate(receiver)
    extension.send(JSON.stringify({ type: "capabilities", protocol: 2, apis: {}, commands, search_mode: null }))
    await until(() => !!receiver.state.capabilities)
    const pending = Array.from({ length: 32 }, () => receiver.request("play").then(() => "unexpected", () => "rejected"))
    await assert.rejects(receiver.request("play"), /Too many/)
    extension.close()
    assert.deepEqual(await Promise.all(pending), Array(32).fill("rejected"))
  } finally { sockets.forEach((s) => s.terminate()); await receiver.stop() }
})

test("missing and literal-null Origins are distinct and allowed only after authenticated observation", async () => {
  for (const observed of [null, "null"] as const) {
    const configuration = { ...config(), origins: [] as (string | null)[] }
    const receiver = new SpicetifyServer(0, { configuration })
    await receiver.start()
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${receiver.port}`, observed === null ? {} : { origin: observed })
      const nonce = randomBytes(32).toString("hex")
      ws.on("open", () => ws.send(JSON.stringify({ type: "hello", protocol: 2, handshake: HANDSHAKE, role: "extension", nonce })))
      const [raw] = await once(ws, "message")
      ws.send(JSON.stringify({ type: "auth", protocol: 2,
        proof: proof(secret, "client", "extension", nonce, JSON.parse(raw.toString()).nonce) }))
      await once(ws, "message")
      assert.deepEqual(configuration.origins, [observed])
      const different = new WebSocket(`ws://127.0.0.1:${receiver.port}`, observed === null ? { origin: "null" } : {})
      await assert.rejects(once(different, "open"), /401/)
      ws.close()
    } finally { await receiver.stop() }
  }
})
