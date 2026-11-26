/**
 * Ink loading is deliberately dynamic and non-literal so this fixture tree
 * type-checks and runs in a checkout that has not installed Ink yet (C13 owns
 * the dependency wiring). When Ink is present the snapshot suite exercises the
 * real renderer; when it is absent the suite reports a skip, never a false pass.
 */

import type { InkRuntime } from "./components.ts"
import { normalizeFrame } from "./normalize.ts"

const REACT_MODULE: string = "react"
const INK_MODULE: string = "ink"
const INK_TESTING_MODULE: string = "ink-testing-library"

export interface InkRenderInstance {
  lastFrame(): string | undefined
  unmount(): void
  cleanup?(): void
}

export interface InkHarness {
  ink: InkRuntime
  render(tree: any): InkRenderInstance
  cleanup(): void
}

export type HarnessResult =
  | { ok: true; harness: InkHarness }
  | { ok: false; reason: string }

export async function loadInkHarness(): Promise<HarnessResult> {
  try {
    const reactModule: any = await import(REACT_MODULE)
    const inkModule: any = await import(INK_MODULE)
    const testingModule: any = await import(INK_TESTING_MODULE)
    const React = reactModule.default ?? reactModule
    if (typeof React?.createElement !== "function") return { ok: false, reason: "react has no createElement" }
    if (!inkModule.Box || !inkModule.Text) return { ok: false, reason: "ink has no Box/Text exports" }
    if (typeof testingModule.render !== "function") return { ok: false, reason: "ink-testing-library has no render export" }
    return {
      ok: true,
      harness: {
        ink: { React, Box: inkModule.Box, Text: inkModule.Text },
        render: testingModule.render,
        cleanup: typeof testingModule.cleanup === "function" ? testingModule.cleanup : () => {},
      },
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { ok: false, reason }
  }
}

/**
 * Ink 5/6 expose `render` but not `renderToString`; ink-testing-library's
 * `lastFrame()` is the same render-to-string contract. Keep the name explicit
 * so call sites read as snapshots rather than live terminal sessions.
 */
export function renderRawFrame(harness: InkHarness, tree: any): string {
  const instance = harness.render(tree)
  try {
    return instance.lastFrame() ?? ""
  } finally {
    instance.unmount()
  }
}

export function renderToString(harness: InkHarness, tree: any): string {
  return normalizeFrame(renderRawFrame(harness, tree))
}
