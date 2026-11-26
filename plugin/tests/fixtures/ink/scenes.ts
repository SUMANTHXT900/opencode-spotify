/**
 * Deterministic Ink scenes used by the snapshot suite.
 *
 * These are fixtures, not a live app: no clock, environment, filesystem or
 * network input reaches the tree. Every string is literal so a diff means a
 * real visual change.
 */

import type { DesignSystem, InkRuntime, MenuItem, PlanRow } from "./components.ts"
import { createDesignSystem } from "./components.ts"
import { glyphsFor } from "./glyphs.ts"
import type { Breakpoint } from "./layout.ts"
import { SNAPSHOT_WIDTHS, layoutFor } from "./layout.ts"
import { contrastLabel } from "./tokens.ts"
import type { ThemeMode } from "./tokens.ts"
import { ASSUMED_BACKGROUND, CONTRAST_CRITICAL, DECORATIVE_TOKENS, themeFor } from "./tokens.ts"

export const FIXTURE_VERSION = "v0.6.0-beta.3"

export type SceneId = "prompt" | "plan" | "error" | "tokens"

export interface SceneCase {
  id: SceneId
  mode: ThemeMode
  width: number
  breakpoint: Breakpoint
  file: string
}

const PROMPT_ITEMS: MenuItem[] = [
  { label: "Local desktop app", detail: "use the running client" },
  { label: "Web player", detail: "open in the browser" },
  { label: "Skip for now", detail: "finish without playback" },
]

const PLAN_ROWS: PlanRow[] = [
  { index: "1", label: "Install plugin", detail: "opencode plugin add", kind: "ok", status: "ready" },
  { index: "2", label: "Register bridge", detail: "spicetify apply", kind: "ok", status: "ready" },
  { index: "3", label: "Check credential", detail: "bridge.json", kind: "warn", status: "review" },
  { index: "4", label: "Restart OpenCode", detail: "manual step", kind: "pending", status: "pending" },
]

function sceneCase(id: SceneId, mode: ThemeMode, width: number): SceneCase {
  const layout = layoutFor(width)
  return {
    id,
    mode,
    width,
    breakpoint: layout.breakpoint,
    file: `${mode}/${id}-${layout.breakpoint}-${width}.txt`,
  }
}

export const SCENE_CASES: SceneCase[] = [
  sceneCase("prompt", "dark", SNAPSHOT_WIDTHS.narrow),
  sceneCase("prompt", "dark", SNAPSHOT_WIDTHS.wide),
  sceneCase("plan", "dark", SNAPSHOT_WIDTHS.narrow),
  sceneCase("plan", "dark", SNAPSHOT_WIDTHS.wide),
  sceneCase("error", "dark", SNAPSHOT_WIDTHS.narrow),
  sceneCase("error", "dark", SNAPSHOT_WIDTHS.wide),
  sceneCase("tokens", "dark", SNAPSHOT_WIDTHS.wide),
  sceneCase("prompt", "light", SNAPSHOT_WIDTHS.narrow),
  sceneCase("prompt", "light", SNAPSHOT_WIDTHS.wide),
  sceneCase("plan", "light", SNAPSHOT_WIDTHS.narrow),
  sceneCase("plan", "light", SNAPSHOT_WIDTHS.wide),
  sceneCase("error", "light", SNAPSHOT_WIDTHS.narrow),
  sceneCase("error", "light", SNAPSHOT_WIDTHS.wide),
  sceneCase("tokens", "light", SNAPSHOT_WIDTHS.wide),
]

export function createScene(sceneCaseValue: SceneCase, ink: InkRuntime): any {
  const theme = themeFor(sceneCaseValue.mode)
  const layout = layoutFor(sceneCaseValue.width)
  const glyphs = glyphsFor(layout)
  const ds: DesignSystem = createDesignSystem(ink, { theme, layout, glyphs })
  const narrow = layout.breakpoint === "narrow"

  switch (sceneCaseValue.id) {
    case "prompt":
      return ds.document([
        ds.header(FIXTURE_VERSION),
        ds.blank(),
        ds.panel("Spotify source", narrow ? "Pick a playback source." : "Choose where playback comes from."),
        ds.blank(),
        ...ds.menu(PROMPT_ITEMS, 0),
        ds.blank(),
        ds.hint(narrow ? "j/k move  enter select" : "j/k move   enter select   esc cancel"),
      ])

    case "plan":
      return ds.document([
        ds.header(FIXTURE_VERSION),
        ds.blank(),
        ds.panel("Setup plan", narrow ? "4 steps, dry run" : "4 steps · dry run · offline"),
        ds.blank(),
        ...ds.plan(PLAN_ROWS),
        ds.blank(),
        ds.hint(narrow ? "nothing was written" : "nothing was written · re-run without --dry-run to apply"),
      ])

    case "error":
      return ds.document([
        ds.header(FIXTURE_VERSION),
        ds.blank(),
        ds.panel("Bridge check failed", "The bridge credential is stale."),
        ds.blank(),
        ds.status("error", "401 from 127.0.0.1:43871"),
        ds.status("warn", narrow ? "restart Spotify, then retry" : "restart Spotify, then run setup again"),
        ds.blank(),
        ds.hint("opencode-spotify doctor --verbose"),
      ])

    case "tokens": {
      const background = ASSUMED_BACKGROUND[theme.mode]
      const rows: any[] = [
        ds.header(FIXTURE_VERSION),
        ds.blank(),
        ds.panel(
          `${theme.mode === "dark" ? "Dark" : "Light"} theme tokens`,
          `contrast vs assumed bg ${background} (never painted)`,
        ),
        ds.blank(),
        ds.noteRow("background", "terminal default, never painted"),
      ]
      for (const key of CONTRAST_CRITICAL) {
        const hex = theme[key]
        rows.push(ds.tokenRow(String(key), hex, contrastLabel(hex, background)))
      }
      for (const key of DECORATIVE_TOKENS) {
        const hex = theme[key]
        rows.push(ds.tokenRow(String(key), hex, contrastLabel(hex, background), "decorative"))
      }
      rows.push(ds.blank(), ds.hint("only the accent is chromatic; chrome stays neutral"))
      return ds.document(rows)
    }
  }
}
