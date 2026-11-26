// Regression: protected steps keep child-killing suppressed for their duration
// (before holdKill, the inherited token taskkilled restore/apply/manager children).
import test from "node:test"
import assert from "node:assert/strict"
import { createCancelToken } from "../src/cli/cancel.ts"
import { runPlanSteps } from "../src/cli/plan.ts"
import { context, fakePrompt, fakeRuntime, fakeUi } from "./cli-fixture.ts"
import type { PlanStep } from "../src/cli/types.ts"

test("protected step holds child-killing for its duration", async () => {
  const cancel = createCancelToken()
  const ctx = context(fakeRuntime(), fakeUi(), fakePrompt(), { command: "update", yes: true }, undefined, undefined, cancel)
  let heldDuring = false
  const step: PlanStep = {
    id: "protected-apply",
    description: "protected apply",
    mutates: true,
    interrupt: "protected",
    run: async () => {
      heldDuring = cancel.killHeld
      // A cancel arriving mid-step must not release the hold.
      cancel.request("sigint")
      assert.equal(cancel.killHeld, true, "hold remains active while the step runs")
    },
  }
  const outcome = await runPlanSteps([step], ctx, { announce: false })
  assert.equal(heldDuring, true, "the protected step ran with child-killing suppressed")
  assert.equal(outcome.status, "cancelled")
  assert.equal(outcome.partial, true)
  assert.deepEqual(outcome.completed, ["protected-apply"])
  assert.equal(cancel.killHeld, false, "hold released after the step")
})
