// F8 state-sync: the InstallerSnapshot reducer reflects versions, terminal
// results, cancellation and detection refreshes without sticky phases.
//
// Pure reducer/store tests only: no child processes, no filesystem, no clock.
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  PHASE_LABELS,
  cancelLabel,
  createInstallerSnapshot,
  createInstallerStore,
  reduceInstaller,
} from "../src/cli/state.ts"
import { fakeDetection, fakeRuntime } from "./cli-fixture.ts"
import type { InstallerSnapshot, VersionInfo } from "../src/cli/types.ts"

function snapshot(): InstallerSnapshot {
  return createInstallerSnapshot({
    command: "setup",
    mode: "plain",
    version: "0.6.0-beta.3",
    windows: true,
    startedAt: 100,
  })
}

const EMPTY_VERSIONS = {
  plugin: { installed: null, latest: null },
  spicetify: { installed: null, latest: null },
}

test("a versions event populates snapshot.versions", () => {
  const start = snapshot()
  assert.deepEqual(start.versions, EMPTY_VERSIONS, "a fresh snapshot invents no versions")

  const plugin: VersionInfo = {
    installed: "0.6.0-beta.1",
    latest: "0.6.0",
    latestBeta: "0.7.0-beta.1",
  }
  const spicetify: VersionInfo = { installed: "2.46.7", latest: "2.47.0" }
  const next = reduceInstaller(start, { type: "versions", plugin, spicetify, at: 1 })

  assert.notEqual(next, start, "the reducer returns a new snapshot")
  assert.deepEqual(next.versions, { plugin, spicetify })
  assert.deepEqual(start.versions, EMPTY_VERSIONS, "the input snapshot is never mutated")

  const store = createInstallerStore(start)
  store.dispatch({ type: "versions", plugin, spicetify, at: 1 })
  assert.deepEqual(store.getSnapshot().versions, { plugin, spicetify })
})

test("a result clears progress and prompt, and a later step or plan is not sticky done", () => {
  const store = createInstallerStore(snapshot())

  store.dispatch({ type: "progress", scope: "apply", message: "Applying Spicetify changes", percent: 42, at: 1 })
  store.dispatch({
    type: "prompt",
    request: { id: "apply-consent", kind: "confirm", question: "Apply now?", defaultYes: false },
    at: 2,
  })
  let state = store.getSnapshot()
  assert.equal(state.progress?.percent, 42)
  assert.equal(state.progress?.scope, "apply")
  assert.ok(state.prompt, "the prompt is visible before the result")

  store.dispatch({ type: "result", code: 0, at: 3 })
  state = store.getSnapshot()
  assert.equal(state.phase, "done")
  assert.equal(state.phaseLabel, PHASE_LABELS.done)
  assert.equal(state.exitCode, 0)
  assert.equal(state.endedAt, 3)
  assert.equal(state.progress, null, "a stale bar must not survive into the summary")
  assert.equal(state.prompt, null, "a stale prompt must not survive into the summary")
  assert.equal(state.cancel, undefined)

  // A step after a completed run means a new action is executing again.
  store.dispatch({
    type: "step",
    id: "bridge-install",
    status: "running",
    description: "Install the bridge extension",
    at: 4,
  })
  state = store.getSnapshot()
  assert.equal(state.phase, "execute")
  assert.equal(state.phaseLabel, PHASE_LABELS.execute)
  assert.equal(state.exitCode, undefined, "the prior exit code is cleared")
  assert.equal(state.endedAt, undefined)
  assert.equal(state.plan?.steps.find((step) => step.id === "bridge-install")?.status, "running")

  // A second result then a whole new plan also re-enters planning.
  store.dispatch({ type: "result", code: 1, at: 5 })
  assert.equal(store.getSnapshot().phase, "done")
  store.dispatch({
    type: "plan",
    title: "Second plan",
    steps: [{ id: "register-global-plugin", description: "Register the package", mutates: true, status: "pending" }],
    at: 6,
  })
  state = store.getSnapshot()
  assert.equal(state.phase, "plan")
  assert.equal(state.phaseLabel, PHASE_LABELS.plan)
  assert.equal(state.exitCode, undefined)
  assert.equal(state.endedAt, undefined)
  assert.equal(state.progress, null)
  assert.equal(state.plan?.title, "Second plan")
  assert.deepEqual(state.plan?.steps.map((step) => step.id), ["register-global-plugin"])
})

test("a cancel event sets the cancelling label, collapses duplicates, and clears progress when settled", () => {
  const store = createInstallerStore(snapshot())
  store.dispatch({ type: "progress", scope: "apply", message: "Applying", percent: 10, at: 1 })

  store.dispatch({ type: "cancel", phase: "requested", stepId: "apply-bridge", at: 2 })
  let state = store.getSnapshot()
  assert.equal(state.phase, "cancelling")
  assert.equal(state.phaseLabel, cancelLabel("requested", "apply-bridge"))
  assert.match(state.phaseLabel, /apply-bridge/)
  assert.deepEqual(state.cancel, { phase: "requested", stepId: "apply-bridge" })
  assert.equal(state.progress?.percent, 10, "an in-flight bar stays visible while finishing")

  // The Ink UI and the plan runner both report the first request: one state.
  store.dispatch({ type: "cancel", phase: "requested", stepId: "apply-bridge", at: 2 })
  assert.equal(store.getSnapshot(), state, "a duplicate cancel must not create a new snapshot")

  store.dispatch({ type: "cancel", phase: "settled", forced: true, at: 3 })
  state = store.getSnapshot()
  assert.equal(state.cancel?.phase, "settled")
  assert.equal(state.cancel?.forced, true)
  assert.equal(state.phaseLabel, cancelLabel("settled", undefined, true))
  assert.match(state.phaseLabel, /forced/i)
  assert.equal(state.progress, null, "a settled cancellation has no owned work progressing")
})

test("a detection refresh replaces detection and installed versions, keeping upstream latest", () => {
  const runtime = fakeRuntime()
  const first = fakeDetection(runtime)
  assert.equal(first.opencode.plugin.version, "0.6.0-beta.1")
  assert.equal(first.spicetify.version, "2.46.7")

  const store = createInstallerStore(createInstallerSnapshot({
    command: "setup",
    mode: "plain",
    version: "0.6.0-beta.3",
    windows: true,
    startedAt: 100,
    detection: first,
  }))
  store.dispatch({
    type: "versions",
    plugin: { installed: "0.6.0-beta.1", latest: "0.6.0" },
    spicetify: { installed: "2.46.7", latest: "2.47.0" },
    at: 1,
  })
  let state = store.getSnapshot()
  assert.deepEqual(state.detection, first)
  assert.equal(state.versions.plugin.installed, "0.6.0-beta.1")
  assert.equal(state.versions.spicetify.installed, "2.46.7")

  // The installer re-detects after acquiring the lock; installed versions move
  // to the refreshed values while registry "latest" metadata is preserved.
  runtime.state.opencode.listVersion = "0.6.0"
  runtime.state.spicetify.version = "2.47.0"
  const second = fakeDetection(runtime)
  store.dispatch({ type: "detection", detection: second, at: 2 })

  state = store.getSnapshot()
  assert.deepEqual(state.detection, second, "the newest detection replaces the snapshot copy")
  assert.equal(state.versions.plugin.installed, "0.6.0")
  assert.equal(state.versions.spicetify.installed, "2.47.0")
  assert.equal(state.versions.plugin.latest, "0.6.0", "versions.latest is not overwritten by detection")
  assert.equal(state.versions.spicetify.latest, "2.47.0")
})
