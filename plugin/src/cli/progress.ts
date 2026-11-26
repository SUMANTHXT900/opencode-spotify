// ProgressReporter adapters for the installer (A04 section 3).
//
// * createStoreReporter feeds a store; the Ink shell renders the snapshot.
// * createNoopReporter keeps call sites uniform when nothing should render.
//
// The plain-text renderer lives in exactly one place: createPlainReporter in
// ui-mode.ts, which is what createPlainPresentation() uses in production.
// Do not add a second plain implementation here.

import type {
  InstallerStore,
  ProgressEvent,
  ProgressReporter,
} from "./types.ts"

/** Build a reporter from one event sink; all methods go through `emit`. */
export function createReporter(
  emit: (event: ProgressEvent) => void,
  clock: () => number = Date.now,
): ProgressReporter {
  return {
    emit,
    phase: (phase, label) => emit({ type: "phase", phase, label: label ?? phase, at: clock() }),
    step: (id, status, detail) => emit({ type: "step", id, status, detail, at: clock() }),
    log: (level, message) => emit({ type: "log", level, message, at: clock() }),
    progress: (scope, message, percent) => emit({ type: "progress", scope, message, percent, at: clock() }),
    prompt: (request) => emit({ type: "prompt", request, at: clock() }),
  }
}

/** Feed events into a store; subscribers drive the TUI/JSON presentation. */
export function createStoreReporter(
  store: InstallerStore,
  clock: () => number = Date.now,
): ProgressReporter {
  return createReporter((event) => {
    try {
      store.dispatch(event)
    } catch {
      // A presentation failure must never abort an installer operation.
    }
  }, clock)
}

/** Explicit "no presentation" reporter; keeps call sites uniform. */
export function createNoopReporter(): ProgressReporter {
  const noop = () => {}
  return {
    emit: noop,
    phase: noop,
    step: noop,
    log: noop,
    progress: noop,
    prompt: noop,
  }
}
