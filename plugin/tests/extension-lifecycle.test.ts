import { test } from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import vm from "node:vm"
import { webcrypto } from "node:crypto"
import { proof } from "../src/services/auth.ts"

const secret = "c".repeat(64)
const turn = () => new Promise((r) => setImmediate(r))
async function fixture() {
  const code = (await readFile(new URL("../spicetify/opencode-spotify-bridge.js", import.meta.url), "utf8"))
    .replace("__OPENCODE_SPOTIFY_SECRET__", secret)
  const sockets: any[] = [], sent: any[] = []
  const timers = new Map<number, { callback: () => void; delay: number }>()
  const intervals = new Set<number>()
  const listeners = new Map<string, Set<unknown>>()
  let sequence = 0, plays = 0
  let completePlay: () => void = () => {}
  const Player = {
    data: {}, play: () => { plays++; return new Promise<void>((r) => { completePlay = r }) },
    addEventListener: (name: string, listener: unknown) => {
      if (!listeners.has(name)) listeners.set(name, new Set())
      listeners.get(name)!.add(listener)
    },
    removeEventListener: (name: string, listener: unknown) => listeners.get(name)?.delete(listener),
  }
  class Socket {
    static OPEN = 1
    readyState = 1
    bufferedAmount = 0
    onopen: any; onclose: any; onmessage: any
    constructor() { sockets.push(this) }
    send(raw: string) { sent.push({ socket: this, ...JSON.parse(raw) }) }
    close() { this.readyState = 3; this.onclose?.() }
  }
  const window: any = { Spicetify: { Player, CosmosAsync: {} }, addEventListener() {}, removeEventListener() {} }
  const context = vm.createContext({
    window, Spicetify: window.Spicetify, WebSocket: Socket, crypto: webcrypto, TextEncoder, Uint8Array,
    performance, console: { warn() {}, info() {} },
    setTimeout: (callback: () => void, delay: number) => { const id = ++sequence; timers.set(id, { callback, delay }); return id },
    clearTimeout: (id: number) => timers.delete(id),
    setInterval: () => { const id = ++sequence; intervals.add(id); return id },
    clearInterval: (id: number) => intervals.delete(id),
  })
  const run = () => vm.runInContext(code, context)
  const authenticate = async (socket: any) => {
    socket.onopen()
    const hello = sent.findLast((m) => m.socket === socket && m.type === "hello")
    const nonce = "d".repeat(64)
    socket.onmessage({ data: JSON.stringify({ type: "challenge", protocol: 2, handshake: "auto-1", nonce,
      serverProof: proof(secret, "server", "extension", hello.nonce, nonce) }) })
    for (let i = 0; i < 100 && !sent.some((m) => m.socket === socket && m.type === "auth"); i++) {
      await new Promise((r) => setTimeout(r, 2))
    }
    assert.ok(sent.some((m) => m.socket === socket && m.type === "auth"))
    socket.onmessage({ data: JSON.stringify({ type: "authenticated", protocol: 2 }) })
    await turn()
    return hello
  }
  run()
  return { run, authenticate, window, sockets, sent, timers, intervals, listeners, plays: () => plays, complete: () => completePlay() }
}

test("extension starts before receiver, backs off with jitter, reconnects and disposes timers/listeners", async () => {
  const f = await fixture()
  let previous: any
  for (let i = 0; i < 9; i++) {
    previous = f.sockets.at(-1)
    previous.close()
    const retry = [...f.timers.entries()].at(-1)!
    assert.ok(retry[1].delay >= 800 && retry[1].delay <= 72000)
    f.timers.delete(retry[0])
    retry[1].callback()
  }
  await f.authenticate(f.sockets.at(-1))
  assert.equal(f.intervals.size, 1)
  f.run() // Extension reload disposes the previous instance.
  assert.equal(f.intervals.size, 0)
  for (const listeners of f.listeners.values()) assert.equal(listeners.size, 1)
  f.window.OpenCodeSpotifyDispose()
  assert.equal(f.timers.size, 0)
  for (const listeners of f.listeners.values()) assert.equal(listeners.size, 0)
})

test("old receiver proofs fail on a new connection and pre-auth RPC never runs", async () => {
  const f = await fixture()
  const first = f.sockets[0]
  const old = await f.authenticate(first)
  first.close()
  const retry = [...f.timers.entries()].at(-1)!
  f.timers.delete(retry[0]); retry[1].callback()
  const next = f.sockets.at(-1)
  next.onopen()
  next.onmessage({ data: JSON.stringify({ type: "request", id: "attack", command: "play", params: {} }) })
  const nonce = "d".repeat(64)
  next.onmessage({ data: JSON.stringify({ type: "challenge", protocol: 2, handshake: "auto-1", nonce,
    serverProof: proof(secret, "server", "extension", old.nonce, nonce) }) })
  for (let i = 0; i < 30 && next.readyState === 1; i++) await new Promise((r) => setTimeout(r, 2))
  assert.equal(next.readyState, 3)
  assert.equal(f.plays(), 0)
  assert.equal(f.sent.some((m) => m.socket === next && m.type === "auth"), false)
  f.window.OpenCodeSpotifyDispose()
})

test("disconnect suppresses stale async command responses", async () => {
  const f = await fixture()
  const first = f.sockets[0]
  await f.authenticate(first)
  first.onmessage({ data: JSON.stringify({ type: "request", id: "old", command: "play", params: {} }) })
  await turn()
  assert.equal(f.plays(), 1)
  first.close()
  const retry = [...f.timers.entries()].at(-1)!
  f.timers.delete(retry[0]); retry[1].callback()
  await f.authenticate(f.sockets.at(-1))
  f.complete()
  await turn()
  assert.equal(f.sent.some((m) => m.type === "response" && m.id === "old"), false)
  f.window.OpenCodeSpotifyDispose()
  f.sockets.at(-1).onmessage({ data: JSON.stringify({ type: "request", id: "late", command: "play", params: {} }) })
  await turn()
  assert.equal(f.plays(), 1)
})
