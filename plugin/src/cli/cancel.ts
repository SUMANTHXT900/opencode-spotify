// Cooperative cancellation for installer operations (F0).
//
// A single CancelToken travels through an OperationContext. Signal handlers,
// the UI and plan steps only ever *request* cancellation; the token never
// touches process globals at import time and never kills anything itself.
// Owned children are terminated by ChildRegistry (./children.ts), which is
// driven from the same reason/phase state.
//
// Phase model:
//   running -> cancel-requested -> finishing-current -> cancelled | partial
// A token may settle from any state; `request()` is first-wins and the abort
// signal fires exactly once, on request (never on settle).

export type CancelReason = "ctrl-c" | "sigint" | "sigterm" | "user" | "shutdown"

export type CancelPhase =
  | "running"
  | "cancel-requested"
  | "finishing-current"
  | "cancelled"
  | "partial"

/** Raised by `throwIfCancelled()`; carried through plan execution as a sentinel. */
export class OperationCancelled extends Error {
  readonly code = "E_CANCELLED"
  readonly stepId?: string

  constructor(stepId?: string, message?: string) {
    super(message ?? (stepId ? `Operation cancelled during ${stepId}` : "Operation cancelled"))
    this.name = "OperationCancelled"
    if (stepId !== undefined) this.stepId = stepId
  }
}

/** True for OperationCancelled and for equivalent errors crossing module boundaries. */
export function isCancellation(value: unknown): value is OperationCancelled {
  if (value instanceof OperationCancelled) return true
  return typeof value === "object" && value !== null && (value as { code?: unknown }).code === "E_CANCELLED"
}

export type CancelRequestListener = (reason: CancelReason) => void

export interface CancelToken {
  readonly phase: CancelPhase
  readonly requested: boolean
  readonly reason: CancelReason | undefined
  /** Aborted exactly once, and only when cancellation is requested. */
  readonly signal: AbortSignal
  readonly forced: boolean
  /** Step being finished after cancellation was requested, when known. */
  readonly stepId: string | undefined

  /** First call wins; later calls (with any reason) are no-ops. Returns true when it transitioned. */
  request(reason?: CancelReason): boolean
  /** Mark the currently running step as allowed to finish; implies `request()` when needed. */
  beginFinishing(stepId: string): void
  /** Idempotent terminal state. Does not abort the signal. */
  settle(outcome: "cancelled" | "partial"): void
  /** Throws OperationCancelled once cancellation was requested or the token settled. */
  throwIfCancelled(stepId?: string): void
  /** Runs immediately (next call) for late subscribers. Returns an unsubscribe function. */
  onRequest(listener: CancelRequestListener): () => void
  /** Escalate: force-abort the current child/step instead of waiting for its boundary. */
  force(): void
  /**
   * Suppress child-killing while a protected step runs. Returns a release
   * function; nested holds are counted. Cancellation is still requested and
   * observed at the next boundary.
   */
  holdKill(): () => void
  /** True while at least one holdKill() is active. */
  readonly killHeld: boolean
}

class CancelTokenImpl implements CancelToken {
  private phaseValue: CancelPhase = "running"
  private requestedValue = false
  private reasonValue: CancelReason | undefined
  private forcedValue = false
  private stepValue: string | undefined
  private settledValue = false
  private killHolds = 0
  private readonly controller = new AbortController()
  private readonly listeners = new Set<CancelRequestListener>()

  get phase(): CancelPhase { return this.phaseValue }
  get requested(): boolean { return this.requestedValue }
  get reason(): CancelReason | undefined { return this.reasonValue }
  get signal(): AbortSignal { return this.controller.signal }
  get forced(): boolean { return this.forcedValue }
  get stepId(): string | undefined { return this.stepValue }
  get killHeld(): boolean { return this.killHolds > 0 }

  holdKill(): () => void {
    this.killHolds += 1
    let released = false
    return () => {
      if (released) return
      released = true
      this.killHolds = Math.max(0, this.killHolds - 1)
    }
  }

  request(reason: CancelReason = "user"): boolean {
    if (this.settledValue || this.requestedValue) return false
    this.requestedValue = true
    this.reasonValue = reason
    this.phaseValue = "cancel-requested"
    if (!this.controller.signal.aborted) {
      this.controller.abort(new OperationCancelled(this.stepValue, "cancellation requested"))
    }
    for (const listener of [...this.listeners]) {
      try { listener(reason) } catch { /* listeners must not break cancellation */ }
    }
    return true
  }

  beginFinishing(stepId: string): void {
    if (this.settledValue) return
    this.stepValue = stepId
    if (!this.requestedValue) this.request("user")
    if (!this.settledValue) this.phaseValue = "finishing-current"
  }

  settle(outcome: "cancelled" | "partial"): void {
    if (this.settledValue) return
    this.settledValue = true
    this.phaseValue = outcome
  }

  throwIfCancelled(stepId?: string): void {
    const id = stepId ?? this.stepValue
    if (this.requestedValue || this.phaseValue === "cancelled" || this.phaseValue === "partial") {
      throw new OperationCancelled(id)
    }
  }

  onRequest(listener: CancelRequestListener): () => void {
    if (this.requestedValue) {
      try { listener(this.reasonValue ?? "user") } catch { /* ignore listener failure */ }
      return () => {}
    }
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  force(): void {
    if (this.settledValue) return
    this.forcedValue = true
    if (!this.requestedValue) {
      this.request("user")
      return
    }
    if (!this.controller.signal.aborted) {
      this.controller.abort(new OperationCancelled(this.stepValue, "cancellation forced"))
    }
  }
}

/** Create a fresh token in the `running` phase. No process/global state. */
export function createCancelToken(): CancelToken {
  return new CancelTokenImpl()
}
