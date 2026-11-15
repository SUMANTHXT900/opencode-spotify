import { WebSocketServer, WebSocket } from "ws"
import type { IncomingMessage } from "node:http"
import { randomBytes, randomUUID } from "node:crypto"
import { configurationPath, loadConfiguration, recordOrigin, validOrigin, type Configuration } from "./credentials.ts"
import { HANDSHAKE, nonceValid, proof, verifyProof, boundedJson } from "./auth.ts"
import { initialState, emptyPlayback, type SpotifyState } from "./state.ts"
import { capabilities, playback, object, text, image, normalizeQueue, normalizePage, normalizeRoot, normalizeState, validateCommand, SpotifyError, trackUri } from "./validation.ts"
import { emptyLyrics, normalizeLyrics, type Lyrics } from "./lyrics.ts"
import type { BridgeQueue } from "./protocol.ts"
import { LyricsSourceManager } from "./LyricsSourceManager.ts"

const MAX_MESSAGE = 4 * 1024 * 1024
export type ServerOptions = { configuration?: Configuration; path?: string; handshakeMs?: number }

export class SpicetifyServer {
  state: SpotifyState = initialState()
  private server: WebSocketServer | undefined
  private client: WebSocket | undefined
  private starting: Promise<void> | undefined
  private listeners = new Set<(state: SpotifyState) => void>()
  private config: Configuration | undefined
  private options: ServerOptions
  private observers = new Set<WebSocket>()
  private observerRevisions = new WeakMap<WebSocket, { lyrics: number; queue: number }>()
  private relay: WebSocket | undefined
  private health: ReturnType<typeof setInterval> | undefined
  private retry: ReturnType<typeof setTimeout> | undefined
  private stopped = false
  private failures = 0
  private epoch = randomUUID()
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; command: string }>()
  private lyrics: Lyrics = emptyLyrics()
  private sources = new LyricsSourceManager()
  private queue: BridgeQueue | null = null
  private commandTimes: number[] = []
  private connectionTimes: number[] = []
  private readonly requestedPort: number
  constructor(requestedPort = 18765, options: ServerOptions = {}) { this.requestedPort = requestedPort; this.options = options }
  getLyrics() { return structuredClone(this.lyrics) }
  async getLyricsSources(options: { uri: string; lrclib: boolean; contact: string; refresh: boolean }) {
    const track = this.state.track
    if (!track || track.uri !== options.uri) throw new SpotifyError("stale_track", "Track changed; reopen lyrics")
    const result = await this.sources.resolve({ ...track, durationMs: this.state.playback.durationMs }, this.getLyrics(),
      { enabled: options.lrclib, contact: options.contact, refresh: options.refresh })
    if (this.state.track?.uri !== options.uri) throw new SpotifyError("stale_track", "Track changed; reopen lyrics")
    return result
  }
  getQueue() { return structuredClone(this.queue) }
  get port() {
    const address = this.server?.address()
    return address && typeof address !== "string" ? address.port : this.requestedPort
  }
  subscribe(listener: (state: SpotifyState) => void) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private update(state: SpotifyState) {
    if (JSON.stringify(state) === JSON.stringify(this.state)) return
    this.state = { ...state, epoch: this.epoch, revision: this.state.revision + 1 }
    for (const listener of this.listeners) {
      try { listener(structuredClone(this.state)) } catch { /* One subscriber cannot block other TUIs. */ }
    }
    this.broadcast()
  }
  private broadcast() {
    for (const socket of this.observers) {
      if (socket.bufferedAmount > MAX_MESSAGE) socket.terminate()
      else if (socket.readyState === WebSocket.OPEN) {
        const last = this.observerRevisions.get(socket)
        if (last?.lyrics !== this.state.lyricsRevision) socket.send(JSON.stringify({ type: "lyrics_snapshot", lyrics: {
            ...this.lyrics, sync_type: this.lyrics.synced ? "LINE_SYNCED" : "UNSYNCED",
            lines: this.lyrics.lines.map((line) => ({ ...line, startTimeMs: line.startMs })),
        } }))
        if (last?.queue !== this.state.queueRevision) socket.send(JSON.stringify({ type: "queue_snapshot", queue: this.queue }))
        socket.send(JSON.stringify({ type: "snapshot", state: this.state }))
        this.observerRevisions.set(socket, { lyrics: this.state.lyricsRevision, queue: this.state.queueRevision })
      }
    }
  }
  start(): Promise<void> {
    if (this.starting) return this.starting
    if (this.server || this.relay) return Promise.resolve()
    this.stopped = false
    try {
      this.config = this.options.configuration ?? loadConfiguration(this.options.path ?? configurationPath())
      if (!this.config.installed) {
        this.update({ ...initialState(), connection: "error", error: "Extension not installed. Run Spotify extension repair." })
        return Promise.resolve()
      }
    } catch {
      this.update({ ...initialState(), connection: "error", error: "Connection configuration error. Run Spotify extension repair." })
      return Promise.resolve()
    }
    this.update({ ...initialState(), connection: "connecting" })
    const starting = new Promise<void>((resolve) => {
      const server = new WebSocketServer({
        host: "127.0.0.1", port: this.requestedPort, maxPayload: MAX_MESSAGE, perMessageDeflate: false,
        verifyClient: ({ req }: { req: IncomingMessage }) => {
          const now = Date.now()
          this.connectionTimes = this.connectionTimes.filter((t) => now - t < 60_000)
          if (this.connectionTimes.length >= 30) return false
          this.connectionTimes.push(now)
          const origin = req.headers.origin ?? null
          return server.clients.size < 12 && req.socket.remoteAddress === "127.0.0.1" &&
            req.headers.host === `127.0.0.1:${this.port}` && req.url === "/" &&
            (req.headers["x-opencode-spotify"] === HANDSHAKE && origin === null ||
              (this.config!.origins.length ? this.config!.origins.includes(origin) : validOrigin(origin)))
        },
      })
      this.server = server
      server.on("error", (error: NodeJS.ErrnoException) => {
        this.server = undefined
        if (error.code === "EADDRINUSE") void this.joinOwner().finally(resolve)
        else {
          this.update({ ...initialState(), connection: "error", error: `Local port unavailable (${this.requestedPort}).` })
          resolve()
        }
      })
      server.on("listening", () => {
        this.update(initialState())
        const alive = new WeakMap<WebSocket, boolean>()
        this.health = setInterval(() => {
          for (const socket of server.clients) {
            if (alive.get(socket) === false) { socket.terminate(); continue }
            alive.set(socket, false)
            socket.once("pong", () => alive.set(socket, true))
            socket.ping()
          }
        }, 15_000)
        this.health.unref()
        resolve()
      })
      server.on("connection", (socket, req) => {
        const nonce = randomBytes(32).toString("hex")
        let authenticated = false
        let role = "", clientNonce = "", challenged = false
        const expires = Date.now() + (this.options.handshakeMs ?? 5000)
        let messages = 0, windowStart = Date.now()
        let activeRequests = 0
        const seen = new Set<string>()
        const timeout = setTimeout(() => socket.terminate(), this.options.handshakeMs ?? 5000)
        socket.on("message", (data, binary) => {
          if (socket.readyState !== WebSocket.OPEN || this.stopped) return
          if (binary) { socket.close(1008, "Text required"); return }
          if ((!authenticated || role === "observer") && data.toString().length > 16384) { socket.close(1009, "Message too large"); return }
          if (Date.now() - windowStart > 1000) { messages = 0; windowStart = Date.now() }
          if (++messages > 60) { socket.close(1008, "Rate limited"); return }
          try {
            const message = boundedJson(data.toString())
            if (!authenticated) {
              if (Date.now() >= expires) { socket.close(1008, "Authentication expired"); return }
              if (!challenged && object(message) && message.type === "hello" && message.protocol === 2 &&
                  message.handshake === HANDSHAKE && ["extension", "observer"].includes(message.role as string) && nonceValid(message.nonce)) {
                role = message.role as string
                if (role === "observer" && req.headers["x-opencode-spotify"] !== HANDSHAKE ||
                    role === "extension" && req.headers["x-opencode-spotify"]) { socket.close(1008, "Invalid role"); return }
                clientNonce = message.nonce
                challenged = true
                socket.send(JSON.stringify({ type: "challenge", protocol: 2, handshake: HANDSHAKE, nonce,
                  serverProof: proof(this.config!.secret, "server", role, clientNonce, nonce) }))
                return
              }
              if (!challenged || !object(message) || message.type !== "auth" || message.protocol !== 2 ||
                  !verifyProof(proof(this.config!.secret, "client", role, clientNonce, nonce), message.proof)) {
                socket.close(1008, "Authentication failed"); return
              }
              if (role === "extension" && this.client || role === "observer" && this.observers.size >= 8) { socket.close(1008, "Already connected"); return }
              if (role === "extension" && !this.config!.origins.length) {
                const origin = req.headers.origin ?? null
                if (this.options.configuration) this.config!.origins = [origin]
                else {
                  recordOrigin(this.options.path ?? configurationPath(), this.config!.secret, origin)
                  this.config = loadConfiguration(this.options.path ?? configurationPath())
                }
              }
              clearTimeout(timeout)
              authenticated = true
              socket.send(JSON.stringify({ type: "authenticated", protocol: 2 }))
              if (role === "observer") { this.observers.add(socket); this.broadcast() }
              else {
                this.client = socket
                this.update({ ...initialState(), connection: "connected" })
              }
              return
            }
            if (role === "extension") this.receive(message)
            else {
              if (!object(message) || message.type !== "request" || typeof message.id !== "string" ||
                  message.id.length > 80 || seen.has(message.id) || activeRequests >= 16) {
                socket.close(1008, "Invalid request"); return
              }
              if (typeof message.command !== "string") { socket.close(1008, "Invalid command"); return }
              validateCommand(message.command, message.params)
              seen.add(message.id); activeRequests++
              if (seen.size > 120) seen.delete(seen.values().next().value!)
              const reply = (body: object) => {
                activeRequests--
                if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "response", id: message.id, ...body }))
              }
              void this.request(message.command, message.params).then(
                (result) => reply({ ok: true, result }),
                () => reply({ ok: false, error: { code: "bridge", message: "Spotify request failed" } }),
              )
            }
          } catch { socket.close(1008, "Invalid message") }
        })
        socket.on("error", () => {})
        socket.on("close", () => {
          clearTimeout(timeout)
          this.observers.delete(socket)
          if (this.client !== socket) return
          this.client = undefined
          this.rejectPending()
          // Keep the last valid document through a temporary transport loss.
          this.queue = null
          if (this.state.connection !== "error") this.update(initialState())
        })
      })
    }).finally(() => { this.starting = undefined })
    this.starting = starting
    return starting
  }
  private joinOwner(): Promise<void> {
    return new Promise((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${this.requestedPort}`, {
        headers: { "X-OpenCode-Spotify": HANDSHAKE }, maxPayload: MAX_MESSAGE, perMessageDeflate: false,
      })
      this.relay = socket
      const clientNonce = randomBytes(32).toString("hex")
      let verified = false, authenticated = false, adopted = false
      let lastActivity = Date.now()
      socket.on("ping", () => { lastActivity = Date.now() })
      const timer = setTimeout(() => socket.terminate(), 5000)
      const fail = () => {
        clearTimeout(timer)
        clearInterval(this.health)
        this.health = undefined
        if (this.relay === socket) this.relay = undefined
        this.rejectPending()
        if (!this.stopped) {
          this.update({ ...initialState(), connection: "error", error: `Local port unavailable (${this.requestedPort}): listener is incompatible or not authenticated.` })
          if (adopted) this.retry = setTimeout(() => { void this.start() }, Math.min(30_000, 1000 * 2 ** Math.min(this.failures++, 5)) + Math.random() * 1000)
        }
        resolve()
      }
      socket.on("open", () => socket.send(JSON.stringify({ type: "hello", protocol: 2, handshake: HANDSHAKE, role: "observer", nonce: clientNonce })))
      socket.on("message", (raw) => {
        if (this.relay !== socket || this.stopped) return
        lastActivity = Date.now()
        try {
          const message = boundedJson(raw.toString())
          if (!object(message)) throw new Error()
          if (!authenticated) {
            if (!verified && message.type === "challenge" && message.protocol === 2 && message.handshake === HANDSHAKE && nonceValid(message.nonce) &&
                verifyProof(proof(this.config!.secret, "server", "observer", clientNonce, message.nonce), message.serverProof)) {
              verified = true
              socket.send(JSON.stringify({ type: "auth", protocol: 2, proof: proof(this.config!.secret, "client", "observer", clientNonce, message.nonce) }))
              return
            }
            if (verified && message.type === "authenticated" && message.protocol === 2) { authenticated = true; return }
            throw new Error()
          }
          if (message.type === "lyrics_snapshot") {
            this.lyrics = normalizeLyrics(message.lyrics) ?? emptyLyrics()
          } else if (message.type === "queue_snapshot") {
            this.queue = message.queue === null ? null : normalizeQueue(message.queue)
          } else if (message.type === "snapshot") {
            const state = normalizeState(message.state)
            this.update(state)
            adopted = true
            clearTimeout(timer)
            if (!this.health) {
              this.health = setInterval(() => { if (Date.now() - lastActivity > 45_000) socket.terminate() }, 15_000)
              this.health.unref()
            }
            this.failures = 0
            resolve()
          } else this.receive(message)
        } catch { socket.terminate() }
      })
      socket.on("error", () => socket.terminate())
      socket.once("close", fail)
    })
  }
  private receive(message: unknown) {
    if (this.state.connection !== "connected") return
    if (!object(message)) return
    if (message.type === "track_cleared") {
      this.lyrics = emptyLyrics()
      this.update({ ...this.state, track: null, playback: emptyPlayback(), lyricsRevision: this.state.lyricsRevision + 1 })
    } else if (message.type === "track") {
      if (![message.uri, message.title, message.artist, message.album].every((v) => typeof v === "string")) return
      const uri = message.uri as string
      if (!trackUri(uri)) return
      const changed = this.state.track?.uri !== uri
      const track = { uri, title: text(message.title), artist: text(message.artist), album: text(message.album), image: image(message.image) }
      if (changed && this.lyrics.uri !== uri) this.lyrics = emptyLyrics(uri)
      this.update({ ...this.state, track, playback: changed ? emptyPlayback() : this.state.playback, lyricsRevision: this.state.lyricsRevision + (changed ? 1 : 0) })
    } else if (message.type === "capabilities") {
      if (message.protocol !== 2) {
        this.update({ ...initialState(), connection: "error", error: "Extension update required: protocol 2" })
        this.client?.close(1002, "Unsupported protocol")
        return
      }
      this.update({ ...this.state, capabilities: capabilities(message) })
    } else if (message.type === "playback") {
      const snapshot = playback(message.playback)
      if (snapshot.trackUri !== (this.state.track?.uri ?? null)) return
      this.update({ ...this.state, playback: snapshot })
    } else if (message.type === "lyrics" && message.uri === this.state.track?.uri) {
      const lyrics = normalizeLyrics(message)
      if (!lyrics) return
      if (JSON.stringify(this.lyrics) === JSON.stringify(lyrics)) return
      this.lyrics = lyrics
      this.update({ ...this.state, lyricsRevision: this.state.lyricsRevision + 1 })
    } else if (message.type === "lyrics_unavailable" && message.uri === this.state.track?.uri) {
      if (this.lyrics.uri === message.uri && this.lyrics.status === "ready") return
      this.lyrics = { ...emptyLyrics(message.uri as string), status: "unavailable" }
      this.update({ ...this.state, lyricsRevision: this.state.lyricsRevision + 1 })
    } else if (message.type === "queue_update") {
      this.queue = normalizeQueue(message.queue)
      this.update({ ...this.state, queueRevision: this.state.queueRevision + 1 })
    } else if (message.type === "response" && typeof message.id === "string") {
      const pending = this.pending.get(message.id)
      if (!pending || typeof message.ok !== "boolean") return
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (!message.ok) {
        pending.reject(new SpotifyError(object(message.error) ? text(message.error.code, 64) : "spotify_api", object(message.error) ? text(message.error.message, 300) : "Spotify API failed"))
      } else {
        try { pending.resolve(this.normalizeResult(pending.command, message.result)) }
        catch { pending.reject(new SpotifyError("protocol", "Malformed bridge response")) }
      }
    }
  }
  private normalizeResult(command: string, result: unknown): unknown {
    if (command === "get_queue") {
      const queue = normalizeQueue(result)
      this.queue = queue
      this.update({ ...this.state, queueRevision: this.state.queueRevision + 1 })
      return queue
    }
    if (["get_library", "get_playlist_tracks", "search"].includes(command)) return normalizePage(result)
    if (command === "get_playlists") {
      if (!object(result)) throw new Error()
      return { items: normalizeRoot(result.items) }
    }
    if (command === "get_playback") {
      const snapshot = playback(result)
      if (snapshot.trackUri === this.state.track?.uri) this.update({ ...this.state, playback: snapshot })
      return snapshot
    }
    if (command === "get_capabilities") {
      const value = capabilities(result)
      this.update({ ...this.state, capabilities: value })
      return value
    }
    if (!object(result) || command !== "ping" && result.accepted !== true) throw new Error()
    return { accepted: true }
  }
  async request(command: string, params: unknown = {}, timeoutMs = 8000): Promise<unknown> {
    const valid = validateCommand(command, params)
    const transport = this.client ?? this.relay
    if (!transport || this.state.connection !== "connected") throw new SpotifyError("disconnected", this.state.error ?? "Waiting for Spotify")
    if (!this.state.capabilities?.commands.includes(valid.command)) throw new SpotifyError("unsupported", "This extension does not support the selected action")
    const now = Date.now()
    this.commandTimes = this.commandTimes.filter((t) => now - t < 60_000)
    if (this.pending.size >= 32 || this.commandTimes.length >= 120) throw new SpotifyError("rate_limited", "Too many music requests; try again shortly")
    this.commandTimes.push(now)
    if (command === "set_liked" && (params as { uri: string }).uri !== this.state.track?.uri) throw new SpotifyError("stale_track", "Track changed; only current-track liking is supported")
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new SpotifyError("timeout", "Spotify response timed out; action outcome is unknown. Refresh before retrying."))
      }, Math.max(10, Math.min(timeoutMs, 60_000)))
      this.pending.set(id, { resolve, reject, timer, command })
      transport.send(JSON.stringify({ type: "request", id, ...valid }), (error) => {
        if (error && this.pending.delete(id)) { clearTimeout(timer); reject(new SpotifyError("disconnected", "Send failed")) }
      })
    })
  }
  private rejectPending() {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new SpotifyError("disconnected", "Spotify disconnected; action outcome may be unknown")) }
    this.pending.clear()
  }
  async stop() {
    this.stopped = true
    clearTimeout(this.retry)
    clearInterval(this.health)
    this.health = undefined
    this.relay?.terminate()
    this.relay = undefined
    await this.starting
    const server = this.server
    this.server = undefined
    this.rejectPending()
    this.client?.terminate()
    this.client = undefined
    this.observers.clear()
    for (const socket of server?.clients ?? []) socket.terminate()
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
    this.update(initialState())
    this.lyrics = emptyLyrics()
    this.sources.dispose()
    this.sources = new LyricsSourceManager()
    this.queue = null
    this.listeners.clear()
  }
}
