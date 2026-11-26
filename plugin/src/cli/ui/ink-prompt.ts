// Single-flight prompt queue for the Ink shell.
//
// Pure state machine: no Ink, no readline, no process access. `ink.ts` wires
// the returned Prompter into workflows and forwards keystrokes through the
// mutation methods. Keeping the queue here makes cancellation, defaults and
// reprompting testable without a terminal.
import type { Prompter, PromptChoiceView, PromptRequest } from "../types.ts"

export interface PromptState {
  request: PromptRequest
  input: string
  selectedIndex: number
  error?: string
}

export interface PromptControllerOptions {
  /** Push the active request (or null when idle) to the store/presentation. */
  emit(request: PromptRequest | null): void
  /** Test hook; defaults to a monotonic `prompt-N` sequence. */
  nextId?: () => string
}

export type PromptSubmitResult =
  | { status: "idle" }
  | { status: "invalid"; error: string }
  | { status: "resolved"; value: string | boolean | undefined }

export interface PromptController {
  readonly prompter: Prompter
  getActive(): PromptState | null
  getQueue(): PromptRequest[]
  pendingCount(): number
  setInput(value: string): void
  append(text: string): void
  backspace(): void
  moveSelection(delta: number): void
  submit(): PromptSubmitResult
  /** Escape path: resolve the current prompt with its cancel value. */
  cancelActive(): void
  /** Shutdown path: cancel the active prompt and everything queued. */
  close(): void
  isClosed(): boolean
}

type PromptValue = string | boolean | undefined
type Resolver = (value: PromptValue) => void

const MAX_INPUT = 2048
const INPUT_CONTROL_PATTERN = /[\u0000-\u001f\u007f]/g

function clampIndex(index: number, count: number): number {
  if (count <= 0) return 0
  if (!Number.isFinite(index)) return 0
  return Math.min(count - 1, Math.max(0, Math.trunc(index)))
}

function cancelValue(request: PromptRequest): PromptValue {
  // A confirm can only resolve boolean. Ask/choose use undefined for cancel.
  return request.kind === "confirm" ? false : undefined
}

export function createPromptController(options: PromptControllerOptions): PromptController {
  let sequence = 0
  const nextId = options.nextId ?? (() => `prompt-${++sequence}`)
  const pending = new Map<string, Resolver>()
  const queue: PromptRequest[] = []
  let active: PromptState | null = null
  let closed = false

  const emit = (request: PromptRequest | null) => {
    try {
      options.emit(request)
    } catch {
      // Presentation updates must never break the workflow awaiting a prompt.
    }
  }

  const activateNext = () => {
    if (closed) {
      active = null
      emit(null)
      return
    }
    const request = queue.shift()
    if (!request) {
      active = null
      emit(null)
      return
    }
    active = {
      request,
      input: request.kind === "ask" ? request.initial ?? "" : "",
      selectedIndex: request.kind === "choose"
        ? clampIndex(request.defaultIndex, request.choices.length)
        : 0,
    }
    emit(request)
  }

  const finishActive = (value: PromptValue) => {
    const state = active
    if (!state) return
    active = null
    const resolve = pending.get(state.request.id)
    pending.delete(state.request.id)
    resolve?.(value)
    activateNext()
  }

  const enqueue = <T extends PromptValue>(request: PromptRequest): Promise<T> => {
    if (closed) return Promise.resolve(cancelValue(request) as T)
    return new Promise<T>((resolve) => {
      pending.set(request.id, (value) => resolve(value as T))
      queue.push(request)
      if (!active) activateNext()
    })
  }

  const prompter: Prompter = {
    ask(question) {
      return enqueue<string | undefined>({ id: nextId(), kind: "ask", question })
    },
    choose<T extends { label: string; value: string }>(question: string, choices: T[], defaultIndex = 0) {
      const views: PromptChoiceView[] = choices.map((choice) => ({ label: choice.label, value: choice.value }))
      return enqueue<string | undefined>({
        id: nextId(),
        kind: "choose",
        question,
        choices: views,
        defaultIndex: clampIndex(defaultIndex, views.length),
      })
    },
    confirm(question, options = {}) {
      return enqueue<boolean>({
        id: nextId(),
        kind: "confirm",
        question,
        defaultYes: options.defaultYes === true,
        ...(options.phrase ? { phrase: options.phrase } : {}),
      })
    },
    close() {
      close()
    },
  }

  function close(): void {
    if (closed) return
    closed = true
    const outstanding: PromptRequest[] = []
    if (active) outstanding.push(active.request)
    outstanding.push(...queue)
    active = null
    queue.length = 0
    for (const request of outstanding) {
      const resolve = pending.get(request.id)
      pending.delete(request.id)
      resolve?.(cancelValue(request))
    }
    emit(null)
  }

  return {
    prompter,
    getActive: () => active,
    getQueue: () => [...queue],
    pendingCount: () => queue.length + (active ? 1 : 0),
    setInput(value) {
      if (!active) return
      active.input = value.replace(INPUT_CONTROL_PATTERN, "").slice(0, MAX_INPUT)
      active.error = undefined
    },
    append(text) {
      if (!active) return
      const clean = text.replace(INPUT_CONTROL_PATTERN, "")
      if (!clean) return
      active.input = (active.input + clean).slice(0, MAX_INPUT)
      active.error = undefined
    },
    backspace() {
      if (!active) return
      active.input = Array.from(active.input).slice(0, -1).join("")
      active.error = undefined
    },
    moveSelection(delta) {
      if (!active || active.request.kind !== "choose") return
      const count = active.request.choices.length
      if (count <= 0) return
      active.selectedIndex = ((active.selectedIndex + Math.trunc(delta)) % count + count) % count
      active.input = ""
      active.error = undefined
    },
    submit(): PromptSubmitResult {
      const state = active
      if (!state) return { status: "idle" }
      const request = state.request
      state.error = undefined

      if (request.kind === "ask") {
        const value = state.input.trim()
        finishActive(value)
        return { status: "resolved", value }
      }

      if (request.kind === "choose") {
        const count = request.choices.length
        if (count <= 0) {
          finishActive(undefined)
          return { status: "resolved", value: undefined }
        }
        const typed = state.input.trim()
        let index = clampIndex(state.selectedIndex, count)
        if (typed) {
          if (!/^\d+$/.test(typed) || Number(typed) < 1 || Number(typed) > count) {
            const error = `Enter a number from 1 to ${count}.`
            state.error = error
            return { status: "invalid", error }
          }
          index = Number(typed) - 1
        }
        const value = request.choices[index]?.value
        finishActive(value)
        return { status: "resolved", value }
      }

      if (request.phrase) {
        const matched = state.input.trim() === request.phrase
        finishActive(matched)
        return { status: "resolved", value: matched }
      }

      const answer = state.input.trim()
      if (!answer) {
        finishActive(request.defaultYes)
        return { status: "resolved", value: request.defaultYes }
      }
      if (/^y(es)?$/i.test(answer)) {
        finishActive(true)
        return { status: "resolved", value: true }
      }
      if (/^n(o)?$/i.test(answer)) {
        finishActive(false)
        return { status: "resolved", value: false }
      }
      const error = `Please answer y/yes or n/no (default ${request.defaultYes ? "yes" : "no"}).`
      state.error = error
      return { status: "invalid", error }
    },
    cancelActive() {
      if (!active) return
      finishActive(cancelValue(active.request))
    },
    close,
    isClosed: () => closed,
  }
}
