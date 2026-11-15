import { createMemo, createSignal, onCleanup, type Accessor } from "solid-js"
import { measureEditText, TextAttributes, type BoxRenderable, type CliRenderer, type ColorInput } from "@opentui/core"
import { wrapCells, truncateCells } from "./layout"

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
export const cellMeasure = (renderer: CliRenderer) => (value: string) => measureEditText(value, { widthMethod: renderer.widthMethod })

export function CellText(props: {
  text: string; width: number; renderer: CliRenderer; fg?: ColorInput; bold?: boolean; truncate?: boolean; center?: boolean; id?: string; selectable?: boolean
}) {
  const rows = createMemo(() => props.truncate
    ? [truncateCells(props.text, props.width, cellMeasure(props.renderer))]
    : wrapCells(props.text, props.width, cellMeasure(props.renderer)))
  return <text id={props.id} width={Math.max(1, props.width)} minWidth={0} height={rows().length}
    flexShrink={0} wrapMode="none" selectable={props.selectable} fg={props.fg} attributes={props.bold ? TextAttributes.BOLD : 0}>{
    (props.center ? rows().map((row) => " ".repeat(Math.max(0, Math.floor((props.width - cellMeasure(props.renderer)(row)) / 2))) + row) : rows()).join("\n")
  }</text>
}

export interface ControlAction {
  id: string
  label: string
  accessibleLabel?: string
  disabled?: boolean
  reason?: string
  run: () => void | boolean | Promise<void | boolean>
}
export function Control(props: {
  action: ControlAction; foreground: ColorInput; muted: ColorInput; accent: ColorInput; background?: ColorInput
  busy?: boolean; focused?: boolean; width?: number; renderer: CliRenderer; focus?: () => void
}) {
  const [hover, setHover] = createSignal(false)
  const [pressed, setPressed] = createSignal(false)
  const disabled = () => props.action.disabled || props.busy
  return <box id={props.action.id} width={props.width} minWidth={0} height={1} flexShrink={0}
    backgroundColor={props.background} onMouseOver={() => setHover(true)} onMouseOut={() => { setHover(false); setPressed(false) }}
    onMouseDown={(event) => { event.stopPropagation(); props.focus?.(); setPressed(true) }}
    onMouseUp={(event) => {
      event.stopPropagation()
      const trigger = pressed()
      setPressed(false)
      if (trigger && !disabled()) void props.action.run()
    }}>
    <CellText renderer={props.renderer} width={props.width ?? Math.max(1, cellMeasure(props.renderer)(props.action.label) + 2)}
      text={`${props.focused ? "›" : props.busy || pressed() ? "·" : " "}${props.action.label} `}
      bold={props.focused || hover()} truncate selectable={false}
      fg={disabled() ? props.muted : props.focused || hover() || pressed() ? props.accent : props.foreground} />
  </box>
}

export function useControlKeys(actions: Accessor<ControlAction[]>) {
  const [focus, setFocus] = createSignal(0)
  const move = (delta: number) => setFocus((index) => (index + delta + actions().length) % Math.max(1, actions().length))
  const activate = () => { const action = actions()[focus()]; if (action && !action.disabled) void action.run() }
  return { focus, setFocus, move, activate }
}
