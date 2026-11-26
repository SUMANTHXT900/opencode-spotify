# Ink design system fixtures (C14)

A small, reusable visual system and its normalized Ink snapshots for the
interactive installer. The tree is dependency-light on purpose: tokens, layout,
glyph selection, truncation and frame invariants are plain modules; only
`runtime.ts` touches Ink, and it does so dynamically.

## Visual contract

- **One accent.** Spotify green (`#1DB954` dark, `#0B7A33` light). Every other
  token is neutral chrome. No gradients, no album-derived palettes.
- **Terminal background wins.** There is no background token and no
  `backgroundColor` / inverse-video use. The UI paints glyphs only.
- **Compact borders.** A single leading rule (`│`, or `|` at narrow widths).
  No boxes, corners, nested panels, braille or large ASCII art.
- **Compact typography.** One bold title line, one muted subtitle per section,
  at most one blank line between blocks, two-cell gutter.
- **Small glyph budget.** Eight Unicode glyphs total (`● ▲ ✕ ○ · ❯ │ …`), all one
  cell wide. A 40-column terminal switches to `* ! x o - > | ...`.
- **Status and selection.** Colour lives in the status glyph; labels stay
  neutral. The selected menu row is `❯` / `>` + accent + bold, never a filled
  row, so selection survives any terminal palette.
- **Responsive.** `< 60` columns is narrow: no detail column, shorter copy,
  ASCII only. `>= 60` columns adds the detail column and Unicode glyphs.
  Widths are hard-clamped to `[24, 120]`.

Assumed backgrounds for contrast maths (not painted): `#0E1116` dark,
`#F7F8F4` light. Every text-bearing token clears WCAG AA (4.5:1); the rule is
decorative and intentionally below 3:1.

## Files

| File | Purpose |
|---|---|
| `tokens.ts` | palettes, contrast helpers, forbidden background token |
| `layout.ts` | 60-column breakpoint, 40/100 snapshot widths, spacing scale |
| `glyphs.ts` | Unicode and ASCII glyph sets, one-cell guarantee |
| `normalize.ts` | display width, truncation, frame normalization/invariants |
| `components.ts` | Ink primitives built with `React.createElement` (no JSX) |
| `scenes.ts` | deterministic prompt / plan / error / token scenes |
| `runtime.ts` | dynamic Ink loader + `renderToString` wrapper |
| `generate.ts` | snapshot writer/checker (CLI) |
| `snapshots/` | 14 stored frames |

`runtime.ts` exists because Ink 5/6/7 have no `renderToString` export;
`ink-testing-library`'s `lastFrame()` is the same contract. The wrapper keeps the
name and normalizes CRLF / trailing whitespace / trailing blank lines only.
Colors are intentionally not in the frames: the fake stdout has no color
support, so snapshots pin layout and text. Color intent is covered by the token
contrast tests and by traversing the React element tree for `color`/`bold`
props, so wiring cannot silently drift.

## Snapshots

Both themes (`dark`, `light`), each at:

| State | Narrow (40) | Wide (100) |
|---|---|---|
| Prompt with selected menu row | yes | yes |
| Plan with ok / warn / pending | yes | yes |
| Error with error + warn + hint | yes | yes |
| Token report (light/dark differ) | - | yes |

Narrow files are asserted ASCII-only. Wide files may use only the approved
glyph set. Every line is width-checked and every file is asserted to need no
normalization.

## Running

The repository pins `ink@7.1.1`, `react@19.2.9` and
`ink-testing-library@4.0.0`, so from `plugin/`:

```powershell
node --test tests/cli-ink-snapshot.test.ts
node tests/fixtures/ink/generate.ts          # check
node tests/fixtures/ink/generate.ts --write  # regenerate after an intentional change
```

When the dependencies are absent the test still validates all stored frames
statically and marks the two render tests as skipped. It never reports a pass
for a render that did not happen.

Probe evidence for this handoff also covered `ink@5.2.1` + `react@18.3.1` and
`ink@6.1.1` + `react@19.2.0`; the same 14 frames matched byte-for-byte.

## What these snapshots do not prove

These are normalized Ink view-tree snapshots, not a Windows terminal
certification. They do not exercise ConPTY cursor placement, font shaping,
wide/shrunk cell rendering, real 24-bit color output or live terminal resize.
Those remain covered by the existing OpenTUI/ConPTY verification work; no claim
of live Windows terminal compatibility is made here.

## Integration note

The primitives are exportable and have no fixture-only assumptions, but they
currently live under `tests/fixtures/ink/` because C13 owns `src/cli/ui/`.
Lifting `tokens.ts`, `layout.ts`, `glyphs.ts`, `components.ts` and
`normalize.ts` into the published tree is a C13/orchestrator action; the
snapshots and invariants here can then be pointed at those modules unchanged.
