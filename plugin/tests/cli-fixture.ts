import type {
  CommandResult, Detection, Logger, OperationContext, Prompter, Runtime, Ui, VersionInfo,
} from "../src/cli/types.ts"

export interface FakeState {
  opencode: { available: boolean; version: string; listVersion: string | null; source: string; local: boolean; native: boolean }
  spicetify: { available: boolean; version: string; registered: boolean }
  bridge: { installed: boolean; credentialValid: boolean; extensionCurrent: boolean }
  spotify: { installed: boolean; store: boolean }
  spicetifyUpgradeCalls: number
}

export interface FakeRuntime extends Runtime {
  state: FakeState
  calls: Array<{ file: string; args: string[] }>
}

const secret = "a".repeat(64)
const template = "// OpenCode Spotify V0.4 maintained extension\nconst secret = '__OPENCODE_SPOTIFY_SECRET__'\n"

export function fakeRuntime(overrides: Partial<FakeState> = {}): FakeRuntime {
  const state: FakeState = {
    opencode: { available: true, version: "2.4.1", listVersion: "0.6.0-beta.1", source: "npm", local: false, native: true },
    spicetify: { available: true, version: "2.46.7", registered: true },
    bridge: { installed: true, credentialValid: true, extensionCurrent: true },
    spotify: { installed: true, store: false },
    spicetifyUpgradeCalls: 0,
    ...overrides,
  }
  const calls: FakeRuntime["calls"] = []
  const appData = "C:\\Users\\Test\\AppData\\Roaming"
  const config = "C:\\Users\\Test\\.config\\opencode\\opencode.json"
  const spicetifyConfig = `${appData}\\spicetify\\config-xpui.ini`
  const extension = `${appData}\\spicetify\\Extensions\\opencode-spotify-bridge.js`
  const credential = `${appData}\\opencode-spotify\\bridge.json`
  const runtime: FakeRuntime = {
    state,
    calls,
    platform: "win32",
    arch: "x64",
    env: { APPDATA: appData, TEMP: "C:\\Temp" },
    cwd: "C:\\Projects\\demo",
    homedir: "C:\\Users\\Test",
    async run(file, args) {
      calls.push({ file, args: [...args] })
      const joined = args.join(" ")
      if (file.includes("opencode")) {
        if (joined === "--version") return ok(state.opencode.version)
        if (joined === "debug paths config") return ok(config)
        if (joined === "plugin --help") return ok(state.opencode.native ? "add remove" : "list")
        if (joined === "plugin list") {
          return ok(state.opencode.listVersion
            ? `ID VERSION SOURCE\nopencode-spotify ${state.opencode.listVersion} ${state.opencode.source}`
            : "No plugins found")
        }
        if (args[1] === "add") {
          const spec = args[2] ?? ""
          const match = spec.match(/@(\d+\.\d+\.\d+)/)
          state.opencode.listVersion = match?.[1] ?? "0.6.0-beta.1"
          state.opencode.source = "npm"
          state.opencode.local = false
          return ok("added")
        }
        if (args[1] === "remove") { state.opencode.listVersion = null; return ok("removed") }
        if (args[1] === "update") { return ok("updated") }
        return ok("")
      }
      if (file.includes("spicetify")) {
        if (joined === "-v") return ok(`v${state.spicetify.version}`)
        if (joined === "-c") return ok(spicetifyConfig)
        if (joined === "path spotify") return ok("C:\\Users\\Test\\AppData\\Roaming\\Spotify")
        if (joined === "apply") return ok("applied")
        if (joined === "upgrade") { state.spicetifyUpgradeCalls++; state.spicetify.version = "2.47.0"; return ok("upgraded") }
        return ok("")
      }
      if (file.includes("pwsh")) {
        const script = args.join(" ")
        if (script.includes("-Uninstall")) {
          state.bridge.installed = false
          state.spicetify.registered = false
        } else if (script.includes("-Install") || script.includes("-Repair")) {
          state.bridge.installed = true
          state.bridge.extensionCurrent = true
          state.spicetify.registered = true
        }
        return ok("bridge operation complete")
      }
      if (file.includes("winget") || file.includes("scoop") || file.includes("choco")) return ok("")
      return { code: 1, stdout: "", stderr: "unexpected command" }
    },
    async which(name) {
      if (name === "opencode") return "C:\\Tools\\opencode.exe"
      if (name === "spicetify") return state.spicetify.available ? "C:\\Users\\Test\\AppData\\Local\\spicetify\\spicetify.exe" : undefined
      if (name === "pwsh") return "C:\\Program Files\\PowerShell\\7\\pwsh.exe"
      return undefined
    },
    exists(path) {
      return path === config || path === spicetifyConfig || path === extension || path === credential ||
        path.endsWith("install-extension.ps1") ||
        (path.includes("Spotify") && state.spotify.installed) || path === "C:\\Temp"
    },
    isFile(path) {
      return path === config || path === spicetifyConfig || path === extension || path === credential
    },
    readText(path) {
      if (path === credential) return JSON.stringify({ version: 1, secret, origins: [], installed: state.bridge.installed })
      if (path === spicetifyConfig) return `[AdditionalOptions]\nextensions = ${state.spicetify.registered ? "opencode-spotify-bridge.js" : ""}\n`
      if (path === extension) return state.bridge.extensionCurrent ? template.replace("__OPENCODE_SPOTIFY_SECRET__", secret) : "// stale bridge"
      if (path.endsWith("opencode-spotify-bridge.js")) return template
      return ""
    },
    writeText() {}, copyFile() {}, mkdir() {}, remove() {},
    now: () => 0,
    async portOpen() { return false },
  }
  return runtime
}

function ok(stdout: string): CommandResult { return { code: 0, stdout, stderr: "" } }

export function fakeDetection(runtime: FakeRuntime, overrides: Partial<Detection> = {}): Detection {
  const registered = runtime.state.opencode.listVersion !== null
  return {
    windows: true,
    windowsVersion: "Windows 11",
    arch: "x64",
    node: process.versions.node,
    pwsh: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
    opencode: {
      available: runtime.state.opencode.available,
      path: "C:\\Tools\\opencode.exe",
      version: runtime.state.opencode.version,
      configPath: "C:\\Users\\Test\\.config\\opencode\\opencode.json",
      configExists: true,
      plugin: registered
        ? { registered: true, version: runtime.state.opencode.listVersion, source: runtime.state.opencode.source, local: runtime.state.opencode.local, spec: `opencode-spotify@${runtime.state.opencode.listVersion}` }
        : { registered: false, version: null, source: null, local: false, spec: null },
      nativeCommands: runtime.state.opencode.native,
    },
    spotify: { installed: runtime.state.spotify.installed, store: runtime.state.spotify.store, path: null, prefs: null, detail: "" },
    spicetify: {
      available: runtime.state.spicetify.available,
      path: "C:\\Users\\Test\\AppData\\Local\\spicetify\\spicetify.exe",
      version: runtime.state.spicetify.version,
      owner: "script",
      configPath: "C:\\Users\\Test\\AppData\\Roaming\\spicetify\\config-xpui.ini",
      extensionsDir: "C:\\Users\\Test\\AppData\\Roaming\\spicetify\\Extensions",
      bridgeRegistered: runtime.state.spicetify.registered,
    },
    bridge: {
      configExists: true, credentialValid: runtime.state.bridge.credentialValid, installed: runtime.state.bridge.installed,
      origins: 0, extensionPath: "C:\\Users\\Test\\AppData\\Roaming\\spicetify\\Extensions\\opencode-spotify-bridge.js",
      extensionExists: runtime.state.bridge.installed, registration: runtime.state.bridge.extensionCurrent ? "current" : "stale",
      protocol: 2,
    },
    port: { busy: false, likelyOwnedByThisPlugin: null },
    compatibility: {
      opencode: "ok", spicetify: "ok",
      bridge: runtime.state.bridge.extensionCurrent ? "compatible" : "stale",
      plugin: registered ? "ok" : "missing",
    },
    ...overrides,
  }
}

export function fakeUi(): Ui & { lines: string[]; jsonValue: unknown } {
  const lines: string[] = []
  const api = {
    lines,
    jsonValue: undefined as unknown,
    banner() {}, title() {}, section: (text: string) => lines.push(text), line: (text: string) => lines.push(text),
    kv: (key: string, value: string) => lines.push(`${key}: ${value}`),
    status: (kind: string, text: string) => lines.push(`${kind}: ${text}`), bullet: (text: string) => lines.push(text),
    warn: (text: string) => lines.push(`warn: ${text}`), error: (text: string) => lines.push(`error: ${text}`),
    success: (text: string) => lines.push(`ok: ${text}`),
    json(value: unknown) { api.jsonValue = value },
    dryRun: (text: string) => lines.push(`dry: ${text}`),
  }
  return api as Ui & { lines: string[]; jsonValue: unknown }
}

export function fakePrompt(answers: { choices?: Array<string | undefined>; confirms?: boolean[] } = {}): Prompter & { asked: string[] } {
  const asked: string[] = []
  const choices = [...(answers.choices ?? [])]
  const confirms = [...(answers.confirms ?? [])]
  return {
    asked,
    async ask(question) { asked.push(question); return "" },
    async choose(question) { asked.push(question); return choices.shift() },
    async confirm(question) { asked.push(question); return confirms.length ? confirms.shift()! : false },
    close() {},
  }
}

export function fakeLogger(): Logger & { lines: string[] } {
  const lines: string[] = []
  return { lines, out: (line) => lines.push(line), err: (line) => lines.push(line) }
}

export function context(
  runtime: FakeRuntime,
  ui = fakeUi(),
  prompt = fakePrompt(),
  options: Partial<OperationContext["options"]> = {},
  versions?: { plugin?: Partial<VersionInfo>; spicetify?: Partial<VersionInfo> },
): OperationContext {
  const log = fakeLogger()
  const baseOptions: OperationContext["options"] = {
    command: "setup", dryRun: false, yes: false, json: false, color: false, offline: false, verbose: false,
    help: false, version: false, nonInteractive: false, spicetify: "ask", apply: false,
    allowSpicetifyUpgrade: false, removeCredentials: false, ...options,
  }
  return {
    options: baseOptions,
    runtime,
    ui,
    prompt,
    detection: fakeDetection(runtime),
    installerVersion: "0.6.0-beta.1",
    versions: {
      plugin: { installed: runtime.state.opencode.listVersion, latest: null, ...versions?.plugin },
      spicetify: { installed: runtime.state.spicetify.version, latest: null, ...versions?.spicetify },
    },
    log,
  }
}
