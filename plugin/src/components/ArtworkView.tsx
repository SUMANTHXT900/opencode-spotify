import { createEffect, createMemo, createSignal, on, onCleanup, Show, type Accessor } from "solid-js"
import { NativeImage, type ColorInput } from "@opentui/core"
import { artworkUrl, fitArtworkCells, spotifyArtwork, type Artwork } from "../services/artwork"
import { CellText } from "../ui/primitives"
import type { CliRenderer } from "@opentui/core"

type ArtworkState = { kind: "loading" | "missing" } | { kind: "ready"; data: Artwork }

export function useArtwork(reference: Accessor<string>, enabled: Accessor<boolean>) {
  const url = createMemo(() => enabled() ? artworkUrl(reference()) : null)
  const [result, setResult] = createSignal<{ url: string; data: Artwork | null }>()
  createEffect(on(url, (current) => {
    setResult(undefined)
    if (!current) return
    const request = spotifyArtwork.acquire(current)
    let active = true
    onCleanup(() => { active = false; request.release() })
    void request.result.then((data) => { if (active) setResult({ url: current, data }) })
  }))
  return createMemo<ArtworkState>(() => {
    const current = url()
    const value = result()
    if (!current) return { kind: "missing" }
    if (value?.url !== current) return { kind: "loading" }
    return value.data ? { kind: "ready", data: value.data } : { kind: "missing" }
  })
}

export function ArtworkView(props: {
  artwork: ArtworkState; width: number; height: number; renderer: CliRenderer; muted: ColorInput
}) {
  const [image, setImage] = createSignal<NativeImage>()
  const [failed, setFailed] = createSignal(false)
  const art = createMemo(() => props.artwork.kind === "ready" ? props.artwork.data : undefined)
  // Never ask the terminal to enlarge a decoded texture: on low-DPI/block
  // fallbacks that is what turns a 160 px thumbnail into a blurry 300 px cover.
  const display = createMemo(() => {
    const data = art()
    if (!data) return { width: props.width, height: props.height }
    const pixels = props.renderer.resolution
    const cellWidth = pixels && props.renderer.width > 0 ? pixels.width / props.renderer.width : 0
    const cellHeight = pixels && props.renderer.height > 0 ? pixels.height / props.renderer.height : 0
    return fitArtworkCells(data.width, data.height, props.width, props.height, cellWidth, cellHeight)
  })
  createEffect(on(art, (data) => {
    setImage(undefined)
    setFailed(false)
    if (!data) return
    try {
      const cover = NativeImage.fromRgba(data.pixels, data.width, data.height)
      setImage(cover)
      onCleanup(() => cover.dispose())
    } catch { setFailed(true) }
  }))
  return <box id="spotify-cover" width={props.width} height={props.height} overflow="hidden"
    alignItems="center" justifyContent="center" flexShrink={0}>
    <Show when={art() && image() && !failed()} fallback={
      <CellText renderer={props.renderer} width={props.width} text={props.artwork.kind === "loading" ? "Loading…" : "No cover"}
        fg={props.muted} center truncate />
    }>
      <image id="spotify-cover-image" width={display().width} height={display().height} protocol="auto" fit="fit"
        source={image()} onError={() => setFailed(true)} />
    </Show>
  </box>
}
