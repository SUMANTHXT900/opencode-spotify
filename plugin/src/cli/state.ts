// Installer snapshot reducer and store (A04 section 3 master contract).
//
// Pure data layer: no I/O, no clock of its own, no module-level mutable state.
// `reduceInstaller` returns a new snapshot and never mutates its inputs, which
// lets a store hand React's `useSyncExternalStore` a stable reference between
// dispatches. Activity is bounded to ACTIVITY_LIMIT entries and every retained
// string is passed through sanitizeMessage so a child process cannot inject a
// credential or an opaque token into the UI or the JSON document.

import type {
  CommandName,
  Detection,
  InstallerPhase,
  InstallerSnapshot,
  InstallerStore,
  LogLevel,
  PlanStepView,
  ProgressEvent,
  StepStatus,
  UiMode,
} from "./types.ts"

/** A04: keep only the newest activity entries so a long install stays bounded. */
export const ACTIVITY_LIMIT = 200

/**
 * The exact plain-output strings executePlan used before structured events
 * existed. Keeping them here lets the legacy fallback and the plain reporter
 * share one source of truth.
 */
export const PLAN_MESSAGES = {
  nothingToDo: "Nothing to do.",
  dryRun: "  Dry run: no changes were made.",
  cancelled:
    "Cancelled. No steps in this plan were run. Earlier completed operations (for example a separately approved Spicetify install or upgrade) are unaffected and are not rolled back.",
  confirmationRequired: "Confirmation required in noninteractive mode; no changes were made.",
  completed: "Plan completed.",
} as const

/** Human labels for A04 phases; callers may override via ProgressReporter. */
export const PHASE_LABELS: Record<InstallerPhase, string> = {
  init: "Starting",
  detect: "Detecting environment",
  plan: "Plan",
  consent: "Awaiting confirmation",
  execute: "Executing",
  verify: "Verifying",
  report: "Summary",
  done: "Done",
  cancelling: "Cancelling",
}

/**
 * Redact credentials and opaque tokens, then bound the length. Shared by the
 * plan runner, the reducer, and progress forwarding.
 */
export function sanitizeMessage(message: string): string {
  return message
    .replace(/\b[a-f0-9]{32,}\b/gi, "[redacted]")
    .replace(/\b(secret|token|password|credential|authorization)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .slice(0, 240)
}

export interface InstallerSnapshotInit {
  command: CommandName
  mode: UiMode
  version: string
  windows: boolean
  startedAt?: number
  detection?: Detection
  phase?: InstallerPhase
  phaseLabel?: string
}

/**
 * Detection is the only structured source of installed versions in the event
 * contract, so mirror it into `versions`. Upstream "latest" values are not
 * invented here: nothing in `ProgressEvent` carries them yet.
 */
function versionsFromDetection(
  detection: Detection,
  previous: InstallerSnapshot["versions"],
): InstallerSnapshot["versions"] {
  return {
    // A verified absence must clear the stale installed version.
    plugin: { ...previous.plugin, installed: detection.opencode.plugin.version },
    spicetify: { ...previous.spicetify, installed: detection.spicetify.version },
  }
}

/** Detection is stored by value so workflows cannot mutate the store in place. */
function cloneDetection(detection: Detection): Detection {
  try {
    return structuredClone(detection)
  } catch {
    return JSON.parse(JSON.stringify(detection)) as Detection
  }
}

/** Build the initial snapshot. `versions` is filled from detection when supplied. */
export function createInstallerSnapshot(init: InstallerSnapshotInit): InstallerSnapshot {
  const phase = init.phase ?? "init"
  const versions: InstallerSnapshot["versions"] = {
    plugin: { installed: null, latest: null },
    spicetify: { installed: null, latest: null },
  }
  return {
    schemaVersion: 1,
    command: init.command,
    mode: init.mode,
    version: init.version,
    windows: init.windows,
    phase,
    phaseLabel: init.phaseLabel ?? PHASE_LABELS[phase],
    startedAt: init.startedAt ?? 0,
    versions: init.detection ? versionsFromDetection(init.detection, versions) : versions,
    ...(init.detection ? { detection: init.detection } : {}),
    activity: [],
  }
}

function appendActivity(
  activity: InstallerSnapshot["activity"],
  event: Extract<ProgressEvent, { type: "log" }>,
): InstallerSnapshot["activity"] {
  const entry = { at: event.at, level: event.level, message: sanitizeMessage(event.message) }
  const next = [...activity, entry]
  return next.length > ACTIVITY_LIMIT ? next.slice(next.length - ACTIVITY_LIMIT) : next
}

function sanitizeStep(step: PlanStepView): PlanStepView {
  return {
    id: step.id,
    description: sanitizeMessage(step.description),
    mutates: step.mutates,
    status: step.status,
    ...(step.detail !== undefined ? { detail: sanitizeMessage(step.detail) } : {}),
  }
}

function applyStep(
  state: InstallerSnapshot,
  event: Extract<ProgressEvent, { type: "step" }>,
): InstallerSnapshot {
  const detail = event.detail === undefined ? undefined : sanitizeMessage(event.detail)
  const description = event.description === undefined ? undefined : sanitizeMessage(event.description)
  const steps = state.plan?.steps ?? []
  const index = steps.findIndex((step) => step.id === event.id)
  const nextSteps: PlanStepView[] = index >= 0
    ? steps.map((step, current) => (current === index
        ? {
            ...step,
            status: event.status,
            ...(description !== undefined ? { description } : {}),
            ...(detail !== undefined ? { detail } : {}),
          }
        : step))
    : [
        ...steps,
        {
          id: event.id,
          description: description ?? event.id,
          mutates: false,
          status: event.status,
          ...(detail !== undefined ? { detail } : {}),
        },
      ]
  // A step after a completed run means a new plan is executing. Never keep a
  // sticky `done` phase: a second action (for example "apply now") must be
  // visible as progress again.
  return {
    ...state,
    phase: "execute",
    phaseLabel: PHASE_LABELS.execute,
    exitCode: undefined,
    endedAt: undefined,
    plan: { title: state.plan?.title ?? "", steps: nextSteps },
  }
}

/** Label for the cancellation phase; the step id is the useful detail. */
export function cancelLabel(
  phase: Extract<ProgressEvent, { type: "cancel" }>["phase"],
  stepId?: string,
  forced?: boolean,
): string {
  if (phase === "settled") return forced ? "Cancelled (forced)" : "Cancelled"
  if (forced) return "Cancelling - force requested"
  if (stepId) return `Cancelling - waiting for ${stepId}`
  return "Cancelling"
}

/** Pure reducer over the master-owned ProgressEvent contract. */
export function reduceInstaller(state: InstallerSnapshot, event: ProgressEvent): InstallerSnapshot {
  switch (event.type) {
    case "phase":
      return { ...state, phase: event.phase, phaseLabel: sanitizeMessage(event.label) }
    case "detection": {
      const detection = cloneDetection(event.detection)
      return {
        ...state,
        detection,
        versions: versionsFromDetection(detection, state.versions),
      }
    }
    case "versions":
      return {
        ...state,
        versions: {
          plugin: { ...event.plugin },
          spicetify: { ...event.spicetify },
        },
      }
    case "plan":
      // A new plan always re-enters planning, even after a prior result.
      return {
        ...state,
        phase: "plan",
        phaseLabel: PHASE_LABELS.plan,
        exitCode: undefined,
        endedAt: undefined,
        progress: null,
        cancel: undefined,
        plan: {
          title: sanitizeMessage(event.title),
          steps: event.steps.map(sanitizeStep),
        },
      }
    case "step":
      return applyStep(state, event)
    case "log":
      return { ...state, activity: appendActivity(state.activity, event) }
    case "progress": {
      const percent = typeof event.percent === "number" && Number.isFinite(event.percent)
        ? event.percent
        : undefined
      return {
        ...state,
        progress: {
          scope: sanitizeMessage(event.scope),
          message: sanitizeMessage(event.message),
          ...(percent === undefined ? {} : { percent }),
        },
      }
    }
    case "prompt":
      return { ...state, prompt: event.request }
    case "cancel": {
      const label = cancelLabel(event.phase, event.stepId, event.forced === true)
      const cancel: NonNullable<InstallerSnapshot["cancel"]> = {
        phase: event.phase,
        ...(event.stepId === undefined ? {} : { stepId: event.stepId }),
        ...(event.forced === true ? { forced: true } : {}),
      }
      // Ink and the plan runner both report the first request; collapse the
      // duplicate so subscribers see one cancellation transition.
      if (
        state.cancel?.phase === cancel.phase &&
        state.cancel?.stepId === cancel.stepId &&
        (state.cancel?.forced === true) === (cancel.forced === true) &&
        state.phase === "cancelling" &&
        state.phaseLabel === label
      ) {
        return state
      }
      return {
        ...state,
        phase: "cancelling",
        phaseLabel: label,
        cancel,
        // A settled cancellation means no owned work is progressing anymore.
        ...(event.phase === "settled" ? { progress: null } : {}),
      }
    }
    case "result":
      // The result is terminal for any transient progress/prompt state: a
      // stale prompt or bar must not survive into the summary/done screen.
      return {
        ...state,
        phase: "done",
        phaseLabel: PHASE_LABELS.done,
        endedAt: event.at,
        exitCode: event.code,
        progress: null,
        prompt: null,
        cancel: undefined,
      }
    default:
      return state
  }
}

/**
 * Store for React's useSyncExternalStore: `getSnapshot` is referentially
 * stable until a dispatch actually changes the snapshot, and listeners are
 * notified after the new value is installed.
 */
export function createInstallerStore(initial: InstallerSnapshot): InstallerStore {
  let state = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot() {
      return state
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    dispatch(event) {
      const next = reduceInstaller(state, event)
      if (next === state) return
      state = next
      // Copy first: a listener may unsubscribe (or subscribe) while notifying.
      for (const listener of [...listeners]) {
        try {
          listener()
        } catch {
          // Observers must never break an installer run.
        }
      }
    },
  }
}

/** Convenience for tests/UI: the status of one step, defaulting to pending. */
export function stepStatus(state: InstallerSnapshot, id: string): StepStatus | undefined {
  return state.plan?.steps.find((step) => step.id === id)?.status
}

/** Convenience for tests/UI: the newest activity message at a level. */
export function lastLog(state: InstallerSnapshot, level?: LogLevel): string | undefined {
  for (let index = state.activity.length - 1; index >= 0; index--) {
    const entry = state.activity[index]!
    if (!level || entry.level === level) return entry.message
  }
  return undefined
}
