// F0 owned-child registry: adopt, close tracking, idempotent kill, policy
// none, grace-timeout reporting and invalid/unregistered pid guards.
//
// Real children are short-lived `node -e` sleepers; one grace-timeout case
// uses a fake child edge so the test does not need a real unkillable process.
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn, type ChildProcess } from "node:child_process"
import { EventEmitter } from "node:events"
import { createChildRegistry, killOwnedTree } from "../src/cli/children.ts"

interface FakeChild extends EventEmitter {
  pid: number | undefined
  exitCode: number | null
  signalCode: NodeJS.Signals | null
  kill: (signal?: NodeJS.Signals) => boolean
  kills: Array<NodeJS.Signals | undefined>
}

function fakeChild(pid: number | undefined): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.pid = pid
  child.exitCode = null
  child.signalCode = null
  child.kills = []
  child.kill = (signal) => {
    child.kills.push(signal)
    return false
  }
  return child
}

async function spawnSleeper(): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["-e", "process.stdout.write('ready\\n'); setInterval(() => {}, 1000)"], {
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("child did not report ready")), 10_000)
    timer.unref?.()
    child.stdout?.once("data", () => {
      clearTimeout(timer)
      resolve()
    })
    child.once("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
  return child
}

test("adopt tracks a live child and killAll closes it once", async () => {
  const registry = createChildRegistry()
  const child = await spawnSleeper()
  const owned = registry.adopt(child, { label: "sleeper", policy: "tree" })
  try {
    assert.ok(owned.pid > 0)
    assert.equal(owned.label, "sleeper")
    assert.equal(owned.policy, "tree")
    assert.equal(registry.active, 1)

    const reports = await registry.killAll("ctrl-c", { graceMs: 5_000 })
    assert.equal(reports.length, 1)
    assert.equal(reports[0].pid, owned.pid)
    assert.equal(reports[0].label, "sleeper")
    assert.equal(reports[0].reason, "ctrl-c")
    assert.equal(reports[0].exitConfirmed, true)
    assert.equal(registry.active, 0)
    assert.equal(await registry.awaitAll(5_000), true)
    assert.equal(registry.killLog.length, 1)

    // Idempotent per pid: a second killAll neither kills nor logs again.
    const second = await registry.killAll("shutdown", { graceMs: 1_000 })
    assert.deepEqual(second, [])
    assert.equal(registry.killLog.length, 1)
  } finally {
    try { child.kill("SIGKILL") } catch { /* already gone */ }
  }
})

test("closed resolves with the exit status once the child is gone", async () => {
  const registry = createChildRegistry()
  const child = await spawnSleeper()
  const owned = registry.adopt(child, { policy: "single" })
  await registry.killAll("user", { graceMs: 5_000 })
  const report = await owned.closed
  assert.equal(report.pid, owned.pid)
  assert.equal(report.exitConfirmed, true)
  assert.equal(registry.active, 0)
})

test("policy none is never killed by killAll", async () => {
  const registry = createChildRegistry()
  const child = await spawnSleeper()
  const owned = registry.adopt(child, { label: "keep", policy: "none" })
  try {
    const reports = await registry.killAll("shutdown", { graceMs: 100 })
    assert.deepEqual(reports, [])
    assert.equal(registry.killLog.length, 0)
    assert.equal(registry.active, 1)

    child.kill("SIGKILL")
    assert.equal(await registry.awaitAll(5_000), true)
    assert.equal(registry.active, 0)
    assert.equal(registry.killLog.length, 0)
  } finally {
    try { child.kill("SIGKILL") } catch { /* already gone */ }
  }
  void owned
})

test("grace timeout reports exitConfirmed=false and keeps the child active", { timeout: 5_000 }, async () => {
  const registry = createChildRegistry()
  const child = fakeChild(2_147_483_000)
  const owned = registry.adopt(child as unknown as ChildProcess, { policy: "single" })

  // A real child holds the event loop open. This fake has no process handle,
  // and production's unref'ed grace timeout alone cannot keep Node 22 alive.
  const keepAlive = setTimeout(() => {}, 5_000)
  try {
    const report = await registry.killOwnedTree(owned.pid, 60)
    assert.ok(report)
    assert.equal(report.exitConfirmed, false)
    assert.equal(report.graceMs, 60)
    assert.equal(registry.active, 1)
    assert.equal(await registry.awaitAll(50), false)

    child.exitCode = 0
    child.emit("close", 0, null)
    assert.equal(await registry.awaitAll(2_000), true)
    assert.equal(registry.active, 0)
  } finally {
    clearTimeout(keepAlive)
  }
})

test("killOwnedTree waits for the close event", async () => {
  const registry = createChildRegistry()
  const child = fakeChild(2_147_483_001)
  registry.adopt(child as unknown as ChildProcess, { policy: "single" })

  let settled = false
  const killing = registry.killOwnedTree(2_147_483_001, 2_000).then((report) => {
    settled = true
    return report
  })
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(settled, false, "kill must not resolve before the child closes")

  child.exitCode = 0
  child.signalCode = "SIGTERM"
  child.emit("close", 0, "SIGTERM")
  const report = await killing
  assert.ok(report)
  assert.equal(report.exitConfirmed, true)
  assert.equal(report.code, 0)
  assert.equal(report.signal, "SIGTERM")
})

test("unregistered and invalid pids are ignored without throwing", async () => {
  const registry = createChildRegistry()
  assert.equal(await registry.killOwnedTree(999_999, 50), undefined)
  assert.equal(await registry.killOwnedTree(0, 50), undefined)
  assert.equal(await registry.killOwnedTree(-1, 50), undefined)
  assert.equal(await registry.killOwnedTree(1.5, 50), undefined)
  assert.equal(await killOwnedTree(registry, -42, 50), undefined)
  assert.equal(registry.killLog.length, 0)
})

test("adopting the same pid twice is rejected", () => {
  const registry = createChildRegistry()
  const child = fakeChild(2_147_483_002)
  registry.adopt(child as unknown as ChildProcess, { policy: "tree" })
  assert.throws(
    () => registry.adopt(child as unknown as ChildProcess, { policy: "tree" }),
    /already adopted/,
  )
  child.emit("close", 1, null)
})

test("a child without a pid is treated as already closed", async () => {
  const registry = createChildRegistry()
  const child = fakeChild(undefined)
  const owned = registry.adopt(child as unknown as ChildProcess, { label: "failed-spawn" })
  assert.equal(owned.pid, 0)
  assert.equal(registry.active, 0)
  const report = await owned.closed
  assert.equal(report.pid, 0)
  assert.equal(report.exitConfirmed, true)
  assert.equal(await registry.awaitAll(10), true)
})
