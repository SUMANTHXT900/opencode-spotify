// Reclaim-race child used by tests/installer-lock.test.ts.
//
// Starts against a shared, already-stale lock file, contends for the installer
// lock, holds it briefly, and releases it. An independent exclusive file
// checks that only one child enters the protected section at a time.
//
// Usage: node tests/fixtures/lock-child.ts --lock <path>
import { acquireInstallerLock } from "../../src/cli/lock.ts"
import { unlinkSync, writeFileSync } from "node:fs"

function arg(name: string): string {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] ?? "" : ""
}

const lockPath = arg("--lock")
if (!lockPath) {
  console.log(JSON.stringify({ ok: false, error: "missing --lock" }))
  process.exit(2)
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const deadline = Date.now() + 15_000
let lock: Awaited<ReturnType<typeof acquireInstallerLock>> | undefined

while (Date.now() < deadline && !lock) {
  try {
    lock = await acquireInstallerLock({
      lockPath,
      command: "reclaim-race",
      startupGraceMs: 50,
      deadOwnerGraceMs: 50,
      staleMs: 30_000,
      heartbeatMs: 0,
      // Keep the child PowerShell-free; liveness alone is enough here.
      processStartTime: async () => null,
    })
  } catch (error) {
    if ((error as { code?: string }).code !== "E_LOCK_BUSY") throw error
    await sleep(10)
  }
}

if (!lock) {
  console.log(JSON.stringify({ ok: false, error: "timed out waiting for the lock" }))
  process.exit(1)
}

const nonce = lock.nonce
const witness = `${lockPath}.witness`
try {
  await lock.assertHeld()
  // File exclusivity tests real overlap without comparing independently
  // sampled wall clocks across Windows child processes.
  writeFileSync(witness, nonce, { flag: "wx" })
  try {
    await sleep(120)
    await lock.assertHeld()
  } finally {
    unlinkSync(witness)
  }
} finally {
  await lock.release()
}
console.log(JSON.stringify({ ok: true, pid: process.pid, nonce }))
