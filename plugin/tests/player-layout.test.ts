import { test } from "node:test"
import assert from "node:assert/strict"
import {
  BUDGET_HYSTERESIS, playerBudget, playerLayout, playerTimeWidth, resolvePlayerBudget, TERMINAL_SETTLE_MS, volumeGeometry,
  VOLUME_LABEL_WIDTH, VOLUME_MUTE_WIDTH,
} from "../src/ui/player-layout.ts"
import { TRANSPORT_WIDTHS } from "../src/ui/transport.ts"

const input = { hasTrack: true, width: 30, aspect: 2, artwork: true, showVolume: true, preview: true }

test("footer budget is bounded and leaves host chrome usable", () => {
  assert.equal(playerBudget(40), 26)
  assert.equal(playerBudget(34), 24)
  assert.equal(playerBudget(30), 20)
  assert.equal(playerBudget(24), 14)
  assert.equal(playerBudget(18), 8)
  assert.equal(playerBudget(12), 6)
  assert.equal(playerBudget(1), 6)
})

test("responsive modes switch from roomy five-line card to transport-first", () => {
  const roomy = playerLayout(26, input)
  assert.equal(roomy.mode, "roomy")
  assert.deepEqual([roomy.header, roomy.nav, roomy.frame, roomy.art, roomy.title, roomy.artist, roomy.seek,
    roomy.transport, roomy.volume, roomy.lyricsRows], [true, true, true, true, true, true, true, true, true, 5])
  assert.equal(roomy.frame, true, "roomy card is framed")
  assert.equal(roomy.artHeight, 9)
  assert.equal(roomy.artWidth, 18)
  assert.equal(roomy.total, 26, "roomy plan consumes its budget")
  assert.equal(roomy.innerWidth, 26)

  const medium = playerLayout(20, input)
  assert.equal(medium.mode, "medium")
  assert.equal(medium.frame, false)
  assert.equal(medium.artHeight, 6)
  assert.equal(medium.lyricsRows, 5)
  assert.equal(medium.total, 20)

  const tight = playerLayout(14, { ...input, width: 24 })
  assert.equal(tight.mode, "tight")
  assert.equal(tight.lyricsRows, 3)
  assert.ok(tight.artHeight >= 3 && tight.artHeight <= 4, `tight art ${tight.artHeight}`)
  assert.equal(tight.total, 14)
  const tightBelow = playerLayout(13, { ...input, width: 24 })
  assert.equal(tightBelow.lyricsRows, 1, "art visibility steps before the 3-line tier")
  assert.equal(tightBelow.artHeight, 3)
  assert.equal(tightBelow.total, 13)

  const veryTight = playerLayout(8, input)
  assert.equal(veryTight.mode, "very-tight")
  assert.equal(veryTight.art, false)
  assert.equal(veryTight.volume, false)
  assert.equal(veryTight.lyricsRows, 1)
  assert.equal(veryTight.total, 8)

  const minimal = playerLayout(6, input)
  assert.equal(minimal.art, false)
  assert.equal(minimal.lyricsRows, 0)
  assert.equal(minimal.volume, false)
  assert.equal(minimal.total, 6)
  assert.ok(minimal.transport && minimal.header && minimal.nav)
})

test("artwork is capped, never dominant, and hides when space or width is scarce", () => {
  for (const budget of [10, 14, 18, 20, 24, 26, 40]) {
    const layout = playerLayout(budget, input)
    assert.ok(layout.artHeight <= 9, `art cap at ${budget}`)
    assert.ok(layout.total <= Math.min(budget, 40), `fits budget ${budget}`)
  }
  assert.equal(playerLayout(26, { ...input, width: 60 }).artHeight, 9)
  assert.equal(playerLayout(26, { ...input, width: 60, artworkSize: "small" }).artHeight, 6)
  assert.equal(playerLayout(20, { ...input, width: 60 }).artHeight, 6)
  assert.equal(playerLayout(20, { ...input, width: 14 }).art, false)
  assert.equal(playerLayout(26, { ...input, artwork: false }).art, false)
  assert.equal(playerLayout(20, { ...input, hasTrack: false }).lyricsRows, 0)
})

test("lyrics block and card row accounting are exact", () => {
  for (const budget of [8, 10, 12, 14, 16, 20, 24, 26]) {
    const layout = playerLayout(budget, input)
    const card = (layout.frame ? 2 : 0) + layout.artHeight + Number(layout.gapArt) + Number(layout.title) +
      Number(layout.artist) + Number(layout.seek) + Number(layout.transport) + Number(layout.volume) +
      Number(layout.gapTransport)
    assert.equal(card, layout.cardHeight)
    const outside = Number(layout.header) + Number(layout.nav) + Number(layout.gapLyrics) + layout.lyricsRows
    assert.equal(layout.cardHeight + outside, layout.total, `row total at ${budget}`)
  }
})

test("fixed geometry constants are width invariant and volume is secondary", () => {
  assert.deepEqual(TRANSPORT_WIDTHS, { previous: 4, toggle: 9, next: 4, like: 4 })
  assert.equal(TRANSPORT_WIDTHS.previous + 1 + TRANSPORT_WIDTHS.toggle + 1 + TRANSPORT_WIDTHS.next, 19)
  assert.equal(playerTimeWidth(26), 6)
  assert.equal(playerTimeWidth(20), 6)
  assert.equal(playerTimeWidth(15), 5)
  for (const width of [15, 16, 20, 24, 30, 60]) {
    const time = playerTimeWidth(width)
    const seek = width - 2 * time - 2
    assert.ok(seek >= 1, `seek area at ${width}`)
    assert.equal(2 * time + 2 + seek, width, "seek row accounting is exact")
  }
  assert.equal(VOLUME_LABEL_WIDTH, 6)
  assert.equal(VOLUME_MUTE_WIDTH, 5)
  for (const width of [11, 15, 16, 20, 30]) {
    const volume = volumeGeometry(width)
    assert.ok(volume.slider <= 12, "volume track is shorter than the seekbar")
    assert.ok(volume.width < width, `volume group stays secondary at ${width}`)
    assert.equal(Number(volume.showMute) * (VOLUME_MUTE_WIDTH + 1) +
      Number(volume.showPercent) * (VOLUME_LABEL_WIDTH + 1) + volume.slider, volume.width)
  }
  assert.equal(volumeGeometry(30).slider, 12)
  assert.equal(volumeGeometry(20).slider, 6)
  assert.equal(volumeGeometry(15).width, 14, "narrow volume leaves a margin")
  assert.equal(volumeGeometry(15).showMute, false)
  assert.equal(volumeGeometry(18).showMute, true)
})

test("adaptive budget resolves raw terminal height with hysteresis", () => {
  assert.equal(BUDGET_HYSTERESIS, 2)
  assert.ok(TERMINAL_SETTLE_MS >= 150 && TERMINAL_SETTLE_MS <= 300, "settle window bounds rapid resizes")
  // No previous budget: raw mapping applies, including non-finite input.
  assert.equal(resolvePlayerBudget(40), 26)
  assert.equal(resolvePlayerBudget(24), 14)
  assert.equal(resolvePlayerBudget(12), 6)
  assert.equal(resolvePlayerBudget(NaN), 6)
  assert.equal(playerBudget(NaN), 6)
  // Sub-threshold oscillation is absorbed: 33<->34 maps to 23<->24 raw.
  assert.equal(resolvePlayerBudget(34, 23), 23, "single-row growth does not flip modes")
  assert.equal(resolvePlayerBudget(33, 24), 24, "single-row shrink does not flip modes")
  // Sustained moves of >= hysteresis adopt the new budget.
  assert.equal(resolvePlayerBudget(36, 23), 26, "roomy re-entry adopts full budget")
  assert.equal(resolvePlayerBudget(30, 26), 20, "tall-to-medium shrink adopts")
  assert.equal(resolvePlayerBudget(29, 20), 20, "one-row shrink below threshold holds")
  assert.equal(resolvePlayerBudget(24, 20), 14, "six-row shrink adopts compact budget")
  assert.equal(resolvePlayerBudget(22, 20), 12, "two-row shrink adopts compact budget")
  // Clamp safety on unexpected previous values.
  assert.equal(resolvePlayerBudget(40, 999), 26)
  assert.equal(resolvePlayerBudget(12, -5), 6)
})

test("mode transitions are stable across settle boundaries", () => {
  // Simulate Todo/terminal oscillation around the roomy and medium entries:
  // raw budgets [23,24,23,24] must not flap modes under hysteresis.
  let budget = resolvePlayerBudget(33)
  assert.equal(budget, 23)
  for (const height of [34, 33, 34, 33, 34]) {
    budget = resolvePlayerBudget(height, budget)
    assert.equal(budget, 23, `holds medium at terminal ${height}`)
  }
  assert.equal(playerLayout(budget, input).mode, "medium")
  budget = resolvePlayerBudget(38, budget)
  assert.equal(budget, 26)
  assert.equal(playerLayout(budget, input).mode, "roomy")
  // Constrained thresholds degrade art before lyrics.
  const mediumBudget = resolvePlayerBudget(30, 26)
  const medium = playerLayout(mediumBudget, { ...input, width: 24 })
  assert.equal(medium.mode, "medium")
  const tight = playerLayout(resolvePlayerBudget(24, mediumBudget), { ...input, width: 24 })
  assert.equal(tight.mode, "tight")
  assert.ok(tight.artHeight <= medium.artHeight, "art shrinks before lyrics collapse")
  assert.ok(tight.total <= medium.total, "total never grows when shrinking")
})
