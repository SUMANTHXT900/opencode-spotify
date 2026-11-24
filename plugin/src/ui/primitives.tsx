import { createMemo, createSignal, onCleanup, Show } from "solid-js"
import { measureEditText, TextAttributes, type BoxRenderable, type CliRenderer, type ColorInput } from "@opentui/core"
import { clusters, wrapCells, truncateCells } from "./layout"

export function useDimensions() {
  let box: BoxRenderable | undefined
  const [width, setWidth] = createSignal(1)
  const [height, setHeight] = createSignal(1)
  const sync = () => {
    if (box) { setWidth(Math.max(1, box.width)); setHeight(Math.max(1, box.height)) }
  }
  return { width, height, ref: (value: BoxRenderable) => { box = value; sync() }, sync }
}
export function terminalSize(renderer: CliRenderer) {
  const [size, setSize] = createSignal({ width: renderer.width, height: renderer.height })
  const resize = (width: number, height: number) => setSize({ width, height })
  renderer.on("resize", resize)
  onCleanup(() => renderer.off("resize", resize))
  return size
}
export type WidthMethod = "unicode" | "wcwidth" | "unicode-wide"
/**
 * Terminal-cell measurement unified across width models. The host terminal may
 * honor a different width table than the renderer's negotiated method (Tamil
 * conjuncts, chillu, ZWJ sequences and flags disagree between models), and a
 * row that fits under one model can overrun the box under the other — pushing
 * the physical cursor past the sidebar edge, where autowrap drops it at
 * column 0 of the next line (the editor area) and the incremental diff then
 * treats those cells as clean forever. Measuring with the wider of the live
 * method and wcwidth keeps every wrapped/truncated row inside its box under
 * both models; residual font-shaping overhang is absorbed by cellSafety.
 * Proven by ConPTY cursor-position (DSR 6n) probes on Windows (see
 * docs/VERIFICATION.md V0.5.6 table): the terminal advances Indic combining
 * sequences, viramas, ZWJ and variation selectors cell-by-cell (effectively
 * per UTF-16 code unit) while both tables count them as zero-width, so the
 * UTF-16 unit count is also folded into the max below.
 */
export const cellMeasure = (renderer: CliRenderer) => {
  const live = (): WidthMethod => {
    try { return (renderer.widthMethod as WidthMethod | undefined) ?? "unicode" } catch { return "unicode" }
  }
  const other = (): WidthMethod => (live() === "wcwidth" ? "unicode" : "wcwidth")
  return (value: string) => {
    if (!value) return 0
    let width = 0
    try { width = measureEditText(value, { widthMethod: live() }) } catch { /* fall through */ }
    try {
      const alt = measureEditText(value, { widthMethod: other() })
      if (Number.isFinite(alt) && alt > width) width = alt
    } catch { /* renderer method stands */ }
    // ConPTY/Windows Terminal advance combining marks, viramas and joiners as
    // full cells (UTF-16 units); neither table counts them.
    if (value.length > width) width = value.length
    return width
  }
}
export function CellText(props: {
  text: string; width: number; renderer: CliRenderer; fg?: ColorInput; bold?: boolean; underline?: boolean
  truncate?: boolean; center?: boolean; id?: string; selectable?: boolean
  /** Right-hand cells kept empty for shaped scripts that may overhang. */
  reserve?: number
}) {
  const columns = () => Math.max(0, Math.floor(props.width) - Math.max(0, Math.floor(props.reserve ?? 0)))
  const measureMax = cellMeasure(props.renderer)
  const rows = createMemo(() => columns() < 1 ? [""] : props.truncate
    ? [truncateCells(props.text, columns(), measureMax)]
    : wrapCells(props.text, columns(), measureMax))
  const attributes = () => (props.bold ? TextAttributes.BOLD : 0) | (props.underline ? TextAttributes.UNDERLINE : 0)
  // Shaped single-row path (V0.5.6): native centering + fixed-width trailing
  // fill are measured with the host width table, but ConPTY advances combining
  // marks/viramas/ZWJ per UTF-16 unit — so leading padding computed natively
  // starts the row too far right, and trailing fill (W - N cells) overruns the
  // box by (M - N) and wraps past the screen edge into the editor. Fix: center
  // manually with the unified (max) measure, emit only leading + content with
  // the row fg, and size the node to its NATIVE width so no fg trailing fill
  // is ever emitted. The (M - N) terminal overhang lands in the caller
  // reserve margin inside the sidebar, never past the screen edge. ASCII
  // (reserve == 0) keeps the pre-V0.5.6 fixed-width native path.
  const shapedSingle = () => !!props.truncate && (props.reserve ?? 0) > 0 && rows().length <= 1
  const singleRow = () => rows()[0] ?? ""
  const singleM = () => shapedSingle() ? measureMax(singleRow()) : 0
  const singleLeading = () => {
    if (!shapedSingle() || !props.center) return 0
    const outer = Math.max(1, Math.floor(props.width))
    return Math.max(0, Math.floor((outer - singleM()) / 2))
  }
  const singlePadded = () => (shapedSingle() ? " ".repeat(singleLeading()) + singleRow() : "")
  const nativeWidth = (text: string) => {
    try {
      const live = ((props.renderer as unknown as { widthMethod?: WidthMethod }).widthMethod) ?? "unicode"
      return Math.max(1, measureEditText(text, { widthMethod: live }))
    } catch { return Math.max(1, text.length) }
  }
  // OpenTUI can resume at an absolute native column after a ZWJ emoji.
  // On the Windows advance model that column can be inside the preceding
  // glyph. Place the suffix at the conservatively measured column instead.
  const anchoredRuns = createMemo(() => {
    if (!shapedSingle() || !singleRow().includes("\u200d")) return []
    const runs: { left: number; text: string }[] = []
    let prefix = ""
    let text = ""
    const flush = () => {
      if (!text) return
      runs.push({ left: singleLeading() + measureMax(prefix), text })
      prefix += text
      text = ""
    }
    for (const cluster of clusters(singleRow())) {
      text += cluster
      if (cluster.includes("\u200d") && /\p{Extended_Pictographic}/u.test(cluster)) flush()
    }
    flush()
    return runs
  })
  return <Show when={shapedSingle()} fallback={
    <text id={props.id} width={Math.max(1, props.width)} minWidth={0} height={rows().length}
      flexShrink={0} wrapMode="none" truncate textAlign={props.center ? "center" : "left"}
      selectable={props.selectable} fg={props.fg} attributes={attributes()}>{rows().join("\n")}</text>
  }>
    <Show when={anchoredRuns().length > 1} fallback={
      <text id={props.id} width={nativeWidth(singlePadded())} minWidth={0} height={1}
        flexShrink={0} wrapMode="none" truncate textAlign="left"
        selectable={props.selectable} fg={props.fg} attributes={attributes()}>{singlePadded()}</text>
    }>
      <box id={props.id} width={Math.max(1, props.width)} minWidth={0} height={1} flexShrink={0} overflow="hidden">
        {anchoredRuns().map((run) => <text position="absolute" top={0} left={run.left}
          width={nativeWidth(run.text)} height={1} wrapMode="none" truncate
          selectable={props.selectable} fg={props.fg} attributes={attributes()}>{run.text}</text>)}
      </box>
    </Show>
  </Show>
}

export interface ControlAction {
  id: string
  label: string
  accessibleLabel?: string
  active?: boolean
  disabled?: boolean
  reason?: string
  run: () => void | boolean | Promise<void | boolean>
}
export function Control(props: {
  action: ControlAction; foreground: ColorInput; muted: ColorInput; accent: ColorInput; background?: ColorInput
  busy?: boolean; active?: boolean; width?: number; renderer: CliRenderer
}) {
  const [hover, setHover] = createSignal(false)
  const [pressed, setPressed] = createSignal(false)
  const busy = () => !!props.busy
  // Pointer-only contract: disabled clicks still call action.run() so the
  // caller MUST explain why via toast (reason ?? label unavailable).
  // Controls must never go silent on disabled. Only busy suppresses run.
  return <box id={props.action.id} width={props.width} minWidth={0} height={1} flexShrink={0}
    backgroundColor={props.background} onMouseOver={() => setHover(true)} onMouseOut={() => { setHover(false); setPressed(false) }}
    onMouseDown={(event) => {
      if (event.button !== 0) return
      event.preventDefault()
      event.stopPropagation()
      setPressed(true)
    }}
    onMouseUp={(event) => {
      if (event.button !== 0) return
      event.preventDefault()
      event.stopPropagation()
      const trigger = pressed()
      setPressed(false)
      if (trigger && !busy()) void props.action.run()
    }}>
    <CellText renderer={props.renderer} width={props.width ?? Math.max(1, cellMeasure(props.renderer)(props.action.label) + 2)}
      text={`${props.busy || pressed() ? "·" : " "}${props.busy ? "Working…" : props.action.label} `}
      bold={hover() || pressed() || props.active} underline={props.active} truncate selectable={false}
      fg={props.action.disabled ? props.muted : hover() || pressed() || props.active ? props.accent : props.foreground} />
  </box>
}
