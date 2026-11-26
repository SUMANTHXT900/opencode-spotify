// F0 cancellation contract: phases, first-wins reasons, abort signal, settle,
// force escalation and OperationCancelled propagation.
//
// Pure unit tests; no child processes and no process-global signal handlers.
import { test } from "node:test"
import assert from "node:assert/strict"
import { createCancelToken, isCancellation, OperationCancelled } from "../src/cli/cancel.ts"

test("token starts running with an unaborted signal", () => {
  const token = createCancelToken()
  assert.equal(token.phase, "running")
  assert.equal(token.requested, false)
  assert.equal(token.reason, undefined)
  assert.equal(token.forced, false)
  assert.equal(token.stepId, undefined)
  assert.equal(token.signal.aborted, false)
})

test("request is first-wins and aborts the signal exactly once", () => {
  const token = createCancelToken()
  const seen: string[] = []
  const unsubscribe = token.onRequest((reason) => seen.push(reason))

  assert.equal(token.request("ctrl-c"), true)
  assert.equal(token.phase, "cancel-requested")
  assert.equal(token.requested, true)
  assert.equal(token.reason, "ctrl-c")
  assert.equal(token.signal.aborted, true)
  assert.deepEqual(seen, ["ctrl-c"])

  // A second request (different reason) must not rewrite state or notify again.
  assert.equal(token.request("sigterm"), false)
  assert.equal(token.reason, "ctrl-c")
  assert.equal(token.phase, "cancel-requested")
  assert.deepEqual(seen, ["ctrl-c"])

  unsubscribe()
  assert.equal(token.request("user"), false)
  assert.deepEqual(seen, ["ctrl-c"])
})

test("request defaults to reason user", () => {
  const token = createCancelToken()
  token.request()
  assert.equal(token.reason, "user")
})

test("late onRequest subscribers are notified immediately and once", () => {
  const token = createCancelToken()
  token.request("shutdown")
  const seen: string[] = []
  const unsubscribe = token.onRequest((reason) => seen.push(reason))
  assert.deepEqual(seen, ["shutdown"])
  unsubscribe()
  assert.deepEqual(seen, ["shutdown"])
})

test("unsubscribe before request suppresses the listener", () => {
  const token = createCancelToken()
  const seen: string[] = []
  token.onRequest((reason) => seen.push(reason))()
  token.request("sigint")
  assert.deepEqual(seen, [])
})

test("beginFinishing records the step and throwIfCancelled carries it", () => {
  const token = createCancelToken()
  token.request("ctrl-c")
  token.beginFinishing("remove-extension")
  assert.equal(token.phase, "finishing-current")
  assert.equal(token.stepId, "remove-extension")

  assert.throws(
    () => token.throwIfCancelled(),
    (error: unknown) => isCancellation(error)
      && error instanceof OperationCancelled
      && error.code === "E_CANCELLED"
      && error.stepId === "remove-extension",
  )

  assert.throws(
    () => token.throwIfCancelled("verify"),
    (error: unknown) => error instanceof OperationCancelled && error.stepId === "verify",
  )
})

test("beginFinishing requests cancellation when none was requested", () => {
  const token = createCancelToken()
  token.beginFinishing("bridge")
  assert.equal(token.requested, true)
  assert.equal(token.reason, "user")
  assert.equal(token.signal.aborted, true)
  assert.equal(token.phase, "finishing-current")
})

test("throwIfCancelled is a no-op while running", () => {
  const token = createCancelToken()
  assert.doesNotThrow(() => token.throwIfCancelled())
  assert.doesNotThrow(() => token.throwIfCancelled("step-a"))
})

test("settle is idempotent and does not abort the signal by itself", () => {
  const token = createCancelToken()
  token.settle("cancelled")
  assert.equal(token.phase, "cancelled")
  assert.equal(token.requested, false)
  assert.equal(token.signal.aborted, false)
  token.settle("partial")
  assert.equal(token.phase, "cancelled")
  assert.equal(token.request("ctrl-c"), false)
  assert.equal(token.signal.aborted, false)
})

test("settle partial records a partial outcome", () => {
  const token = createCancelToken()
  token.request("sigterm")
  token.settle("partial")
  assert.equal(token.phase, "partial")
  assert.equal(token.requested, true)
  assert.equal(token.signal.aborted, true)
  assert.throws(() => token.throwIfCancelled(), isCancellation)
})

test("force escalates an existing request without changing its reason", () => {
  const token = createCancelToken()
  token.request("ctrl-c")
  token.force()
  assert.equal(token.forced, true)
  assert.equal(token.reason, "ctrl-c")
  assert.equal(token.phase, "cancel-requested")
  assert.equal(token.signal.aborted, true)
})

test("force on a running token requests user cancellation", () => {
  const token = createCancelToken()
  token.force()
  assert.equal(token.forced, true)
  assert.equal(token.requested, true)
  assert.equal(token.reason, "user")
  assert.equal(token.phase, "cancel-requested")
  assert.equal(token.signal.aborted, true)
})

test("force after settle is a no-op", () => {
  const token = createCancelToken()
  token.settle("cancelled")
  token.force()
  assert.equal(token.forced, false)
  assert.equal(token.signal.aborted, false)
})

test("OperationCancelled shape and cross-boundary detection", () => {
  const withStep = new OperationCancelled("apply")
  assert.equal(withStep.name, "OperationCancelled")
  assert.equal(withStep.code, "E_CANCELLED")
  assert.equal(withStep.stepId, "apply")
  assert.match(withStep.message, /apply/)
  assert.equal(isCancellation(withStep), true)

  const bare = new OperationCancelled()
  assert.equal(bare.stepId, undefined)
  assert.match(bare.message, /cancelled/i)

  assert.equal(isCancellation({ code: "E_CANCELLED" }), true)
  assert.equal(isCancellation(new Error("nope")), false)
  assert.equal(isCancellation(null), false)
})
