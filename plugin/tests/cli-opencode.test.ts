// Fake-Runtime tests for src/cli/opencode.ts. Never touches a real opencode
// binary or live config: every Runtime is stubbed in-memory.
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  addGlobalPlugin,
  inspectOpenCode,
  listPlugins,
  neutralCwd,
  parsePluginList,
  projectPlugins,
  removeGlobalPlugin,
  updateGlobalPlugin,
} from "../src/cli/opencode.ts"
import type { CommandResult, ExecOptions, Runtime } from "../src/cli/types.ts"

interface RecordedCall {
  file: string
  args: string[]
  options?: ExecOptions
}

interface FakeConfig {
  which?: Record<string, string | undefined>
  onRun?: (file: string, args: string[]) => CommandResult
  exists?: (path: string) => boolean
  isFile?: (path: string) => boolean
  env?: NodeJS.ProcessEnv
  homedir?: string
  cwd?: string
}

function ok(stdout = "", stderr = ""): CommandResult {
  return { code: 0, stdout, stderr }
}

function fail(stderr: string, stdout = ""): CommandResult {
  return { code: 1, stdout, stderr }
}

function createFakeRuntime(config: FakeConfig = {}): Runtime & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const whichMap = config.which ?? {}
  return {
    calls,
    platform: "win32",
    arch: "x64",
    env: config.env ?? {},
    cwd: config.cwd ?? "C:\\work\\repo",
    homedir: config.homedir ?? "C:\\Users\\fake",
    async run(file: string, args: string[], options?: ExecOptions): Promise<CommandResult> {
      calls.push({ file, args, options })
      if (!config.onRun) throw new Error(`unstubbed run: ${file} ${args.join(" ")}`)
      return config.onRun(file, args)
    },
    async which(name: string): Promise<string | undefined> {
      return whichMap[name]
    },
    exists: config.exists ?? (() => false),
    isFile: config.isFile ?? (() => false),
    readText: () => {
      throw new Error("readText is stubbed out")
    },
    writeText: () => {},
    copyFile: () => {},
    mkdir: () => {},
    remove: () => {},
    now: () => 0,
    async portOpen(): Promise<boolean> {
      return false
    },
  }
}

function stubRun(routes: Record<string, CommandResult>): (file: string, args: string[]) => CommandResult {
  return (file: string, args: string[]) => {
    const key = `${file} ${args.join(" ")}`
    const hit = routes[key]
    if (!hit) throw new Error(`unstubbed call: ${key}`)
    return hit
  }
}

const OPENCODE_BIN = "C:\\tools\\opencode.exe"
const withBin = { opencode: OPENCODE_BIN }

test("missing opencode reports unavailable without running anything", async () => {
  const runtime = createFakeRuntime({ which: {} })
  const info = await inspectOpenCode(runtime)
  assert.equal(info.available, false)
  assert.equal(info.path, null)
  assert.equal(info.version, null)
  assert.equal(info.configPath, null)
  assert.equal(info.configExists, false)
  assert.equal(info.plugin.registered, false)
  assert.equal(info.nativeCommands, false)
  assert.match(info.error ?? "", /not found/i)
  assert.equal(runtime.calls.length, 0)
})

test("parsePluginList handles normal rows and ignores noise", () => {
  const rows = parsePluginList(
    ["ID        VERSION  SOURCE", "------------------------------", "opencode-spotify  0.6.0  npm:opencode-spotify@0.6.0", "other-plugin      1.2.3  github:user/other", ""].join("\n"),
  )
  assert.deepEqual(rows, [
    { id: "opencode-spotify", version: "0.6.0", source: "npm:opencode-spotify@0.6.0" },
    { id: "other-plugin", version: "1.2.3", source: "github:user/other" },
  ])
})

test("parsePluginList keeps local rows and sources containing spaces", () => {
  const rows = parsePluginList("opencode-spotify  local  C:\\Users\\me\\My Plugins\\opencode-spotify\n")
  assert.deepEqual(rows, [
    { id: "opencode-spotify", version: "local", source: "C:\\Users\\me\\My Plugins\\opencode-spotify" },
  ])
})

test("parsePluginList rejoins wrapped continuation rows", () => {
  const rows = parsePluginList(
    ["ID  VERSION  SOURCE", "opencode-spotify  0.6.0", "  C:\\plugins\\opencode-spotify", "other-plugin  1.0.0  npm:other@1.0.0"].join("\n"),
  )
  assert.deepEqual(rows, [
    { id: "opencode-spotify", version: "0.6.0", source: "C:\\plugins\\opencode-spotify" },
    { id: "other-plugin", version: "1.0.0", source: "npm:other@1.0.0" },
  ])
})

test("parsePluginList rejoins a source split mid-path", () => {
  const rows = parsePluginList("opencode-spotify  0.6.0  C:\\Users\\me\\plug\n  ins\\opencode-spotify\n")
  assert.deepEqual(rows, [
    { id: "opencode-spotify", version: "0.6.0", source: "C:\\Users\\me\\plugins\\opencode-spotify" },
  ])
})

test("parsePluginList ignores empty and no-plugin output", () => {
  assert.deepEqual(parsePluginList(""), [])
  assert.deepEqual(parsePluginList("No plugins installed\n"), [])
  assert.deepEqual(parsePluginList("(no plugins installed)\n"), [])
})

test("inspectOpenCode lists global plugins from a neutral cwd", async () => {
  const temp = "C:\\Temp"
  const runtime = createFakeRuntime({
    which: withBin,
    env: { TEMP: temp },
    exists: (path) => path === temp,
    onRun: stubRun({
      "opencode --version": ok("opencode 1.2.3\n"),
      "opencode debug paths config": ok(`${temp}\\config.json\n`),
      "opencode plugin list": ok("ID  VERSION  SOURCE\nopencode-spotify  0.6.0  npm:opencode-spotify@0.6.0\n"),
      "opencode plugin --help": ok("Commands:\n  add <spec>     add a plugin\n  remove <spec>  remove a plugin\n  list           list plugins\n"),
    }),
  })
  const info = await inspectOpenCode(runtime)
  assert.equal(info.available, true)
  assert.equal(info.path, OPENCODE_BIN)
  assert.equal(info.version, "1.2.3")
  assert.equal(info.plugin.registered, true)
  assert.equal(info.plugin.version, "0.6.0")
  assert.equal(info.plugin.source, "npm:opencode-spotify@0.6.0")
  assert.equal(info.plugin.local, false)
  assert.equal(info.plugin.spec, "npm:opencode-spotify@0.6.0")
  assert.equal(info.nativeCommands, true)
  const listCall = runtime.calls.find((call) => call.args.join(" ") === "plugin list")
  assert.equal(listCall?.options?.cwd, temp)
  assert.equal(typeof listCall?.options?.timeoutMs, "number")
  // The project cwd must never leak into the global list query.
  assert.ok(!runtime.calls.some((call) => call.options?.cwd === runtime.cwd))
})

test("neutralCwd prefers TEMP, then TMP, then homedir", () => {
  const temp = "C:\\Temp"
  const tmp = "C:\\Tmp"
  const homedir = "C:\\Users\\fake"
  assert.equal(neutralCwd(createFakeRuntime({ env: { TEMP: temp }, exists: () => true, homedir })), temp)
  assert.equal(
    neutralCwd(createFakeRuntime({ env: { TEMP: temp, TMP: tmp }, exists: (p) => p === tmp, homedir })),
    tmp,
  )
  assert.equal(neutralCwd(createFakeRuntime({ env: {}, exists: () => false, homedir })), homedir)
})

test("config discovery trims trailing newlines and CRLF", async () => {
  for (const ending of ["\n", "\r\n", "\n\n"]) {
    const configPath = "C:\\Users\\fake\\config.json"
    const runtime = createFakeRuntime({
      which: withBin,
      env: {},
      homedir: "C:\\Users\\fake",
      exists: (path) => path === configPath,
      isFile: (path) => path === configPath,
      onRun: stubRun({
        "opencode --version": ok("1.2.3"),
        "opencode debug paths config": ok(`\n${configPath}${ending}`),
        "opencode plugin list": ok("No plugins installed\n"),
        "opencode plugin --help": ok("list plugins\n"),
      }),
    })
    const info = await inspectOpenCode(runtime)
    assert.equal(info.configPath, configPath)
    assert.equal(info.configExists, true)
    assert.equal(info.plugin.registered, false)
  }
})

test("config discovery resolves a directory result to opencode.json", async () => {
  const dir = "C:\\Users\\fake\\.config\\opencode"
  const file = `${dir}\\opencode.json`
  const runtime = createFakeRuntime({
    which: withBin,
    env: {},
    homedir: "C:\\Users\\fake",
    exists: (path) => path === dir || path === file,
    isFile: (path) => path === file,
    onRun: stubRun({
      "opencode --version": ok("2.4.1"),
      "opencode debug paths config": ok(`${dir}\r\n`),
      "opencode plugin list": ok("No plugins found\n"),
      "opencode plugin --help": ok("add remove\n"),
    }),
  })
  const info = await inspectOpenCode(runtime)
  assert.equal(info.configPath, file)
  assert.equal(info.configExists, true)
})

test("config discovery handles CRLF list output", async () => {
  const runtime = createFakeRuntime({
    which: withBin,
    env: {},
    homedir: "C:\\Users\\fake",
    exists: () => false,
    onRun: stubRun({
      "opencode --version": ok("1.2.3"),
      "opencode debug paths config": ok("C:\\Users\\fake\\config.json\r\n"),
      "opencode plugin list": ok("ID  VERSION  SOURCE\r\nopencode-spotify  0.6.0  npm:opencode-spotify@0.6.0\r\n"),
      "opencode plugin --help": ok("add remove\n"),
    }),
  })
  const info = await inspectOpenCode(runtime)
  assert.equal(info.configPath, "C:\\Users\\fake\\config.json")
  assert.equal(info.configExists, false)
  assert.equal(info.plugin.registered, true)
})

test("native command detection requires both add and remove", async () => {
  const helpFor = (help: string) =>
    createFakeRuntime({
      which: withBin,
      env: {},
      exists: () => false,
      onRun: stubRun({
        "opencode --version": ok("1.2.3"),
        "opencode debug paths config": ok(""),
        "opencode plugin list": ok(""),
        "opencode plugin --help": ok(help),
      }),
    })
  assert.equal((await inspectOpenCode(helpFor("add a plugin\nremove a plugin\n"))).nativeCommands, true)
  assert.equal((await inspectOpenCode(helpFor("list installed plugins\n"))).nativeCommands, false)
  assert.equal((await inspectOpenCode(helpFor("add a plugin\n"))).nativeCommands, false)
})

test("local registration captures spec from source", async () => {
  const runtime = createFakeRuntime({
    which: withBin,
    env: {},
    homedir: "C:\\Users\\fake",
    exists: () => false,
    onRun: stubRun({
      "opencode --version": ok("1.2.3"),
      "opencode debug paths config": ok(""),
      "opencode plugin list": ok("opencode-spotify  local  C:\\dev\\opencode-spotify\n"),
      "opencode plugin --help": ok("add remove\n"),
    }),
  })
  const info = await inspectOpenCode(runtime)
  assert.equal(info.plugin.registered, true)
  assert.equal(info.plugin.local, true)
  assert.equal(info.plugin.spec, "C:\\dev\\opencode-spotify")
})

test("spec falls back to id@version when the source is absent", async () => {
  const runtime = createFakeRuntime({
    which: withBin,
    env: {},
    homedir: "C:\\Users\\fake",
    exists: () => false,
    onRun: stubRun({
      "opencode --version": ok("1.2.3"),
      "opencode debug paths config": ok(""),
      "opencode plugin list": ok("opencode-spotify  0.6.0\n"),
      "opencode plugin --help": ok("add remove\n"),
    }),
  })
  const info = await inspectOpenCode(runtime)
  assert.equal(info.plugin.registered, true)
  assert.equal(info.plugin.local, false)
  assert.equal(info.plugin.spec, "opencode-spotify@0.6.0")
})

test("addGlobalPlugin uses exact argv, logs lines, and propagates failure", async () => {
  const spec = "npm:opencode-spotify@0.6.0"
  const logged: string[] = []
  const runtime = createFakeRuntime({
    onRun: (file, args) => {
      assert.equal(file, "opencode")
      assert.deepEqual(args, ["plugin", "add", spec])
      return ok(`added ${spec}\n`, "")
    },
  })
  const result = await addGlobalPlugin(runtime, spec, { log: (line) => logged.push(line) })
  assert.equal(result.code, 0)
  assert.equal(result.stdout, `added ${spec}\n`)
  assert.deepEqual(logged, [`added ${spec}`])
  assert.equal(runtime.calls[0]?.file, "opencode")
  assert.deepEqual(runtime.calls[0]?.args, ["plugin", "add", spec])
  assert.equal(typeof runtime.calls[0]?.options?.timeoutMs, "number")

  const failing = createFakeRuntime({ onRun: () => fail("registry unreachable\n") })
  const failed = await addGlobalPlugin(failing, spec)
  assert.equal(failed.code, 1)
  assert.equal(failed.stderr, "registry unreachable\n")
  assert.match(failed.error ?? "", /registry unreachable/)
})

test("removeGlobalPlugin uses exact argv and propagates failure", async () => {
  const runtime = createFakeRuntime({ onRun: () => ok("removed\n") })
  const result = await removeGlobalPlugin(runtime, "opencode-spotify")
  assert.equal(result.code, 0)
  assert.equal(result.stdout, "removed\n")
  assert.deepEqual(runtime.calls[0]?.args, ["plugin", "remove", "opencode-spotify"])
  assert.equal(typeof runtime.calls[0]?.options?.timeoutMs, "number")

  const failing = createFakeRuntime({ onRun: () => fail("not installed\n") })
  const failed = await removeGlobalPlugin(failing, "opencode-spotify")
  assert.equal(failed.code, 1)
  assert.match(failed.error ?? "", /not installed/)
})

test("updateGlobalPlugin uses exact argv with and without a target", async () => {
  const runtime = createFakeRuntime({ onRun: () => ok("updated\n") })
  await updateGlobalPlugin(runtime, "opencode-spotify")
  await updateGlobalPlugin(runtime)
  await updateGlobalPlugin(runtime, "   ")
  assert.deepEqual(
    runtime.calls.map((call) => call.args),
    [
      ["plugin", "update", "opencode-spotify"],
      ["plugin", "update"],
      ["plugin", "update"],
    ],
  )

  const failing = createFakeRuntime({ onRun: () => ({ code: 2, stdout: "partial\n", stderr: "update failed\n" }) })
  const failed = await updateGlobalPlugin(failing, "opencode-spotify")
  assert.equal(failed.code, 2)
  assert.equal(failed.stdout, "partial\n")
  assert.equal(failed.stderr, "update failed\n")
  assert.match(failed.error ?? "", /update failed/)
})

test("blank specs fail without running opencode", async () => {
  const runtime = createFakeRuntime({ onRun: () => ok("") })
  assert.equal((await addGlobalPlugin(runtime, "   ")).code, 1)
  assert.equal((await removeGlobalPlugin(runtime, "")).code, 1)
  assert.equal(runtime.calls.length, 0)
})

test("listPlugins runs from the given cwd and returns [] on failure", async () => {
  const runtime = createFakeRuntime({
    onRun: (file, args) => {
      assert.equal(file, "opencode")
      assert.deepEqual(args, ["plugin", "list"])
      return ok("opencode-spotify  0.6.0  npm:opencode-spotify@0.6.0\n")
    },
  })
  assert.deepEqual(await listPlugins(runtime, "C:\\Temp"), [
    { id: "opencode-spotify", version: "0.6.0", source: "npm:opencode-spotify@0.6.0" },
  ])
  assert.equal(runtime.calls[0]?.options?.cwd, "C:\\Temp")
  assert.equal(typeof runtime.calls[0]?.options?.timeoutMs, "number")
  const failing = createFakeRuntime({ onRun: () => fail("boom\n") })
  assert.deepEqual(await listPlugins(failing, "C:\\Temp"), [])
})

test("projectPlugins lists from runtime.cwd and global inspect stays neutral", async () => {
  const projectDir = "C:\\work\\repo"
  const neutral = "C:\\Temp"
  const routes = {
    "opencode --version": ok("1.2.3"),
    "opencode debug paths config": ok(""),
    "opencode plugin list": ok("opencode-spotify  local  C:\\dev\\opencode-spotify\n"),
    "opencode plugin --help": ok("add remove\n"),
  }
  const runtime = createFakeRuntime({
    which: withBin,
    env: { TEMP: neutral },
    cwd: projectDir,
    homedir: "C:\\Users\\fake",
    exists: (path) => path === neutral,
    onRun: stubRun(routes),
  })
  // Project-aware: sees the local-path checkout that shadows the install.
  assert.deepEqual(await projectPlugins(runtime), [
    { id: "opencode-spotify", version: "local", source: "C:\\dev\\opencode-spotify" },
  ])
  const projectCall = runtime.calls.find((call) => call.args.join(" ") === "plugin list")
  assert.equal(projectCall?.options?.cwd, projectDir)
  assert.equal(typeof projectCall?.options?.timeoutMs, "number")

  // Global inspect from the same runtime still queries the neutral cwd, so a
  // project-local checkout is not mistaken for the global registration.
  const neutralRuntime = createFakeRuntime({
    which: withBin,
    env: { TEMP: neutral },
    cwd: projectDir,
    homedir: "C:\\Users\\fake",
    exists: (path) => path === neutral,
    onRun: stubRun({
      ...routes,
      "opencode plugin list": ok("No plugins installed\n"),
    }),
  })
  const info = await inspectOpenCode(neutralRuntime)
  assert.equal(info.plugin.registered, false)
  assert.equal(info.plugin.state, "absent")
  const listCall = neutralRuntime.calls.find((call) => call.args.join(" ") === "plugin list")
  assert.equal(listCall?.options?.cwd, neutral)
})

test("projectPlugins returns [] when opencode or the list fails", async () => {
  assert.deepEqual(await projectPlugins(createFakeRuntime({ which: {} })), [])
  const failing = createFakeRuntime({
    which: withBin,
    cwd: "C:\\work\\repo",
    onRun: () => fail("boom\n"),
  })
  assert.deepEqual(await projectPlugins(failing), [])
})
