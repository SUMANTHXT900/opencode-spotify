import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const tui = readFileSync(join(root, "src", "tui.tsx"), "utf8")

test("player uses exactly one pinned footer claim", () => {
  const footerClaims = tui.match(/(?:prepend|append)\s*:\s*"sidebar\.footer"/g) ?? []
  assert.equal(footerClaims.length, 1, "exactly one sidebar.footer claim")
  assert.ok(/prepend:\s*"sidebar\.footer"/.test(tui), "footer claim pins above host footer content")
  assert.ok(!/sidebar\.content/.test(tui), "no content claim that Todo expansion could push below the fold")
})

test("slot lifecycle cleans up without duplicating subscriptions", () => {
  assert.ok(/const remove = context\.ui\.slot\(/.test(tui), "footer remover is retained")
  assert.ok(/const removePanel = context\.ui\.slot\(/.test(tui), "panel remover is retained")
  assert.ok(/removePanel\(\); ?remove\(\)/.test(tui), "teardown removes panel then player")
  // Playback/network subscriptions are set up once per setup(), not per slot.
  const subscribes = tui.match(/rpc\.events\.on\("updated"/g) ?? []
  assert.equal(subscribes.length, 1, "single authoritative-state subscription")
  const intervals = tui.match(/setInterval\(/g) ?? []
  assert.ok(intervals.length <= 2, `bounded timers, found ${intervals.length}`)
})

test("ephemeral UI state is keyed to shared identity, not slot lifetime", () => {
  const mini = readFileSync(join(root, "src", "components", "MiniPlayer.tsx"), "utf8")
  assert.ok(/stickyBudget/.test(mini), "hysteresis budget survives re-renders")
  assert.ok(/settleTimer/.test(mini), "terminal settle debounce exists")
  assert.ok(/onCleanup\(\(\) => \{ if \(settleTimer\)/.test(mini), "settle timer is disposed")
  assert.ok(/createEffect\(on\(identity/.test(mini), "drag/optimistic state resets on track change, not on layout change")
})

test("pointer-only: no custom key interception", () => {
  const mini = readFileSync(join(root, "src", "components", "MiniPlayer.tsx"), "utf8")
  const panel = readFileSync(join(root, "src", "components", "NowPlayingPanel.tsx"), "utf8")
  const lyrics = readFileSync(join(root, "src", "components", "LyricsView.tsx"), "utf8")
  for (const [name, source] of [["MiniPlayer", mini], ["NowPlayingPanel", panel], ["LyricsView", lyrics]] as const) {
    assert.ok(!/context\.keymap\.layer/.test(source), `${name} registers no keymap layers`)
    assert.ok(!/spotify\.focus/.test(source), `${name} has no focus palette`)
    assert.ok(!/bind\s*:\s*"(tab|return|space|escape|left|right|home|end|up|down|pageup|pagedown|f|s|r|t)"/.test(source),
      `${name} has no custom key binds`)
  }
  assert.ok(!/context\.keymap\.layer/.test(tui), "tui registers no global Spotify palette")
  assert.ok(!/spotify\.(music|lyrics|panel|toggle_play|shuffle|repeat|like)/.test(tui), "unbound global palette removed")
})

test("pointer controls never steal host focus", () => {
  const primitives = readFileSync(join(root, "src", "ui", "primitives.tsx"), "utf8")
  assert.ok(/preventDefault/.test(primitives), "Control down prevents default focus climb")
  assert.ok(!/focus\?:/.test(primitives), "Control has no focus prop")
  assert.ok(!/focused\?:/.test(primitives), "Control has no focused visual state")
  const mini = readFileSync(join(root, "src", "components", "MiniPlayer.tsx"), "utf8")
  assert.ok(!/focusable/.test(mini), "MiniPlayer root is not focusable")
  assert.ok(!/root\?\.focus/.test(mini), "no explicit root focus")
  assert.ok(!/onFocus/.test(mini), "sliders do not engage focus")
  const slider = readFileSync(join(root, "src", "components", "PlaybackSlider.tsx"), "utf8")
  assert.ok(/preventDefault/.test(slider), "slider down/drag prevents default focus climb")
  assert.ok(!/onFocus/.test(slider), "slider has no onFocus prop")
  assert.ok(!/focused\?:/.test(slider), "slider has no focused prop")
})

test("panel props stay host-owned (no focused hijack)", () => {
  const panel = readFileSync(join(root, "src", "components", "NowPlayingPanel.tsx"), "utf8")
  assert.ok(!/focused/.test(panel.match(/export interface NowPlayingPanelProps[\s\S]*?\}/)?.[0] ?? ""), "panel props have no focused")
  assert.ok(!/focused=\{/.test(panel), "panel does not consume focused")
  assert.ok(/close=\{input\.close\}/.test(tui) || /close=\{/.test(tui), "tui still wires host close")
  assert.ok(!/focused=\{input\.focused\}/.test(tui), "tui does not pass focused")
})

test("all palette operations have mouse counterparts", () => {
  const mini = readFileSync(join(root, "src", "components", "MiniPlayer.tsx"), "utf8")
  const music = readFileSync(join(root, "src", "components", "Music.tsx"), "utf8")
  const playerActs = readFileSync(join(root, "src", "ui", "player-actions.ts"), "utf8")
  // Direct buttons (MiniPlayer navigation + transport via transportActions).
  assert.ok(mini.includes("spotify-music") && mini.includes("spotify-lyrics") && mini.includes("spotify-more"), "nav buttons exist")
  assert.ok(mini.includes("transport().toggle") && mini.includes("transport().previous") && mini.includes("transport().next"), "transport buttons exist")
  assert.ok(playerActs.includes("spotify-toggle") && playerActs.includes("spotify-previous") && playerActs.includes("spotify-next"), "player-actions defines toggle/prev/next")
  assert.ok(mini.includes("spotify-timeline") && mini.includes("spotify-volume") && mini.includes("spotify-mute"), "seek/volume/mute exist")
  assert.ok(mini.includes("spotify-settings"), "settings gear exists")
  // Dialog fallbacks (host-native, pointer-operable).
  assert.ok(/Refresh state/.test(music), "refresh reachable via Music dialog")
  assert.ok(/Refresh playback/.test(music), "manual get_playback reachable via More dialog")
  assert.ok(/get_playback/.test(music), "More dialog wires get_playback with supported() gate")
  assert.ok(/Shuffle/.test(music) && /Repeat/.test(music), "shuffle/repeat reachable via More dialog")
  assert.ok(/Queue/.test(music) && /Search/.test(music), "queue/search reachable via Music dialog")
  assert.ok(/Like/.test(music), "like reachable via More dialog")
})

test("narrow <13 More fallback stays complete (gear-hidden reachable)", () => {
  const mini = readFileSync(join(root, "src", "components", "MiniPlayer.tsx"), "utf8")
  assert.ok(/width\(\) < 13/.test(mini), "narrow threshold explicit")
  assert.ok(/!layout\(\)\.nav/.test(mini), "header fallback when nav hidden")
  assert.ok(/headerMore/.test(mini) && /props\.open\(\)/.test(mini), "fallback opens complete Music menu")
  assert.ok((mini.match(/spotify-more/g) ?? []).length >= 2, "More id exists in nav and header fallback")
})

test("SDK data.on cleanup follows documented contract", () => {
  // SDK: Data.on: (type, handler) => () => void. tui stores the cleanup and calls it.
  assert.ok(/const reconnect = context\.data\.on\("server\.connected"/.test(tui), "reconnect stores SDK cleanup")
  assert.ok(/reconnect\(\)/.test(tui), "teardown calls SDK cleanup")
  assert.ok(/return \(\) => \{[^}]*reconnect\(\)/.test(tui), "cleanup runs on teardown")
})

test("disabled controls preserve explanatory caller toasts (never silent)", () => {
  const prim = readFileSync(join(root, "src", "ui", "primitives.tsx"), "utf8")
  assert.ok(/caller MUST explain why via toast/.test(prim) || /caller can\n\/\/ explain why/.test(prim), "Control documents caller-toast contract")
  assert.ok(/Only busy suppresses/.test(prim), "only busy suppresses, disabled still runs")
  const mini = readFileSync(join(root, "src", "components", "MiniPlayer.tsx"), "utf8")
  assert.ok(/reason \?\?/.test(mini) && /toast\.show/.test(mini), "MiniPlayer explains disabled with reason")
  const panel = readFileSync(join(root, "src", "components", "NowPlayingPanel.tsx"), "utf8")
  assert.ok(/reason \?\?/.test(panel) && /toast\.show/.test(panel), "panel explains disabled with reason")
})
