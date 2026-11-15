import assert from "node:assert/strict"
import { testRender, useRenderer } from "@opentui/solid"
import { createSignal } from "solid-js"
import { LyricCarousel } from "../src/components/LyricCarousel.tsx"
import { normalizeLyrics } from "../src/services/lyrics.ts"
import { defaultLyricsSettings } from "../src/services/lyrics-source.ts"
import { initialState } from "../src/services/state.ts"
import type { MusicProps } from "../src/components/Music.tsx"

const uri = "spotify:track:1234567890123456789012"
const doc = normalizeLyrics({ uri, sync_type: "LINE_SYNCED", lines: [
  {text: "Previous line", startTimeMs: 0}, {text: "తెలుగు పదాలు current line with wrapping", startTimeMs: 2000},
  {text: "Next line", startTimeMs: 4000}, {text: "[instrumental]", startTimeMs: 6000}, {text: "Resumed line", startTimeMs: 8000},
] })!
let position!: (n: number) => void
let setInstrumental!: (value: boolean) => void, setWidth!: (value: number) => void
function Fixture() {
 const renderer = useRenderer(); const [at, setAt] = createSignal(2100); position = setAt
 const [instrumental, updateInstrumental] = createSignal(true); setInstrumental = updateInstrumental
 const [width, updateWidth] = createSignal(20); setWidth = updateWidth
 const state = { ...initialState(), track: {uri, title: "test", artist: "test", album: "test", image: ""}, playback: {...initialState().playback, isPlaying: true} }
 const props = {context: {renderer, theme: {text: {base:"#eeeeee", muted:"#aaaaaa", action:{primary:{base:"#99ddaa"}}}}},
   state: () => state, lyrics: () => doc, position: at, settings: () => ({...defaultLyricsSettings(), reducedMotion: true, instrumental: instrumental()}),
   sources: () => null, saveSettings: async () => {}, refreshLyrics: async () => {}, rpc: {}} as unknown as MusicProps
 return <box flexDirection="row" width="100%" height="100%"><text width={2} height="100%">{"LL\n".repeat(8)}</text><LyricCarousel {...props} width={width()} height={5}/><text width={2} height="100%">{"RR\n".repeat(8)}</text></box>
}
const render = await testRender(() => <Fixture />, {width: 24, height: 5})
try {
 await render.flush(); let frame = render.captureCharFrame(); assert.match(frame, /Previous line/); assert.match(frame, /Next line/)
 for (const line of frame.split("\n").slice(0, 5)) { assert.ok(line.startsWith("LL")); assert.ok(line.endsWith("RR")) }
 position(6100); await render.flush(); frame = render.captureCharFrame(); assert.match(frame, /●  ●  ●/); assert.doesNotMatch(frame, /unavailable/i)
 setInstrumental(false); await render.flush(); assert.match(render.captureCharFrame(), /Music playing/); assert.doesNotMatch(render.captureCharFrame(), /●/)
 position(8100); await render.flush(); assert.match(render.captureCharFrame(), /Resumed line/)
 setWidth(15); await render.flush(); assert.match(render.captureCharFrame(), /Resumed line/)
} finally { await render.dispose() }
console.log("carousel renderer states and boundaries passed")

