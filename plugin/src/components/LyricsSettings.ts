import type { MusicProps } from "./Music"
import { validateLyricsSettings, validContact } from "../services/lyrics-source"
import { truncateCells } from "../ui/layout"
import { cellMeasure } from "../ui/primitives"
import { graphicsCapabilities } from "../ui/colors"

export async function lyricsSettingsDialog(props: MusicProps) {
  const { context } = props
  let draft = validateLyricsSettings(props.settings())
  const fit = (value: string) => truncateCells(value, Math.max(1, Math.min(60, context.renderer.width - 10)), cellMeasure(context.renderer))
  const menu = (title: string, rows: { title: string; value: string; description?: string; disabled?: boolean; category?: string }[], current?: string) =>
    context.ui.dialog.select({ title: fit(title), current, options: rows.map((row) => ({ ...row, title: fit(row.title), description: row.description ? fit(row.description) : undefined })) })
  const toggleKeys = ["preview", "follow", "reducedMotion", "background", "artwork", "showVolume", "instrumental"] as const
  const toggles = (key: typeof toggleKeys[number], title: string, category: string) => ({
    title: `${title}: ${draft[key] ? "on" : "off"}`, value: key, category,
  })
  while (true) {
    const graphics = graphicsCapabilities(context.renderer.capabilities, !!context.renderer.resolution)
    const lyric = props.lyrics()
    const choice = await menu("Spotify Settings · changes apply on Save", [
      { title: `Seek increment: ${draft.seekSeconds === null ? "default" : `${draft.seekSeconds}s`}`, value: "seekSeconds", category: "Playback" },
      toggles("showVolume", "Sidebar volume", "Playback"),
      { title: `Source: ${draft.provider}`, value: "provider", category: "Lyrics" },
      { title: "This track's version…", value: "track", category: "Lyrics" },
      { title: `Script: ${draft.script}`, value: "script", category: "Lyrics" },
      { title: `Priority: ${draft.priority === "timing" ? "synchronization" : "selected script"}`, value: "priority", category: "Lyrics" },
      toggles("preview", "Lyric window (5/3/1 lines)", "Lyrics"),
      toggles("follow", "Follow active line", "Lyrics"),
      { title: `LRCLIB access: ${draft.lrclibEnabled ? "enabled" : "off"}`, value: "access", category: "Lyrics" },
      { title: "Refresh sources (saved settings)", value: "refresh", category: "Lyrics" },
      toggles("artwork", "Cover artwork (true image pixels)", "Appearance"),
      { title: `Cover size: ${draft.artworkSize}`, value: "artworkSize", category: "Appearance" },
      toggles("reducedMotion", "Reduced motion", "Appearance"),
      toggles("background", "Neutral lyric background", "Appearance"),
      toggles("instrumental", "Instrumental dots", "Appearance"),
      { title: `Spotify: ${props.state().connection}`, value: "connection", disabled: true, category: "Diagnostics" },
      { title: `Lyrics: ${lyric.provider ?? "none"} · ${lyric.format}`, value: "lyric-status", disabled: true, category: "Diagnostics" },
      { title: `Artwork renderer: ${graphics.imageProtocol}`, value: "graphics", disabled: true, category: "Diagnostics",
        description: `RGB ${graphics.trueColor ? "yes" : "no"} · Kitty ${graphics.kitty ? "yes" : "no"} · Sixel ${graphics.sixel ? "yes" : "no"}` },
      { title: "Save", value: "save" },
      { title: "Cancel", value: "cancel" },
    ])
    if (!choice || choice === "cancel") return
    if (choice === "save") {
      await props.saveSettings(validateLyricsSettings(draft))
      context.ui.toast.show({ message: "Spotify settings saved", variant: "success" })
      return
    }
    const key = toggleKeys.find((value) => choice === value)
    if (key) {
      draft = { ...draft, [key]: !draft[key] }
    } else if (choice === "artworkSize") {
      draft = { ...draft, artworkSize: draft.artworkSize === "auto" ? "small" : "auto" }
    } else if (choice === "seekSeconds") {
      const value = await context.ui.dialog.prompt({ title: "Seek step in seconds (1–120, empty = default)", placeholder: "10" })
      if (value === "") draft = { ...draft, seekSeconds: null }
      else if (value !== undefined) {
        const seconds = Number(value)
        if (Number.isInteger(seconds) && seconds >= 1 && seconds <= 120) draft = { ...draft, seekSeconds: seconds }
        else context.ui.toast.show({ message: "Enter a whole number from 1 to 120" })
      }
    } else if (choice === "provider") {
      const available = (provider: string) => {
        const source = props.sources()?.availability.find((item) => item.provider === provider)
        return source ? `${source.state}: ${source.detail}` : "Not resolved for this track"
      }
      const value = await menu("Preferred provider (fallback if unavailable)", [
        { title: "Automatic", value: "auto" },
        { title: "Spotify", value: "spotify", description: available("spotify") },
        { title: "LRCLIB", value: "lrclib", disabled: !draft.lrclibEnabled, description: available("lrclib") },
        { title: "lrc.red: not implemented", value: "lrc.red", disabled: true, description: "Requires separate identified integration and attribution" },
      ], draft.provider)
      if (value === "auto" || value === "spotify" || value === "lrclib") draft = { ...draft, provider: value }
    } else if (choice === "track") {
      const uri = props.state().track?.uri
      if (!uri) { context.ui.toast.show({ message: "Play a track first" }); continue }
      const candidates = props.sources()?.uri === uri ? props.sources()?.candidates ?? [] : []
      const value = await menu("Available versions for this track", [
        { title: "Use global preferences", value: "auto" },
        ...candidates.filter((c) => c.id).map((c) => ({ title: `${c.provider} · ${c.format} · ${c.script}`,
          description: c.romanized === true ? "Romanized" : c.script === "latin" ? "Latin; romanization unconfirmed" : c.attribution, value: c.id! })),
      ], draft.overrides[uri] ?? "auto")
      if (value) {
        draft.overrides = { ...draft.overrides }
        if (value === "auto") delete draft.overrides[uri]
        else {
          if (Object.keys(draft.overrides).length >= 200 && !draft.overrides[uri]) delete draft.overrides[Object.keys(draft.overrides)[0]!]
          draft.overrides[uri] = value
        }
      }
    } else if (choice === "script") {
      const value = await menu("Script preference (no automatic transliteration)", [
        { title: "Romanized preferred", value: "romanized", description: "Prefer Latin/verified romanized versions when available" },
        { title: "Original script preferred", value: "original" },
        { title: "Automatic / available source", value: "auto" },
      ], draft.script)
      if (value === "romanized" || value === "original" || value === "auto") draft = { ...draft, script: value }
    } else if (choice === "priority") {
      const value = await menu("When script and timing differ", [
        { title: "Prefer synchronized lyrics", value: "timing" },
        { title: "Prefer selected script", value: "script" },
      ], draft.priority)
      if (value === "timing" || value === "script") draft = { ...draft, priority: value }
    } else if (choice === "access") {
      if (draft.lrclibEnabled) draft = { ...draft, lrclibEnabled: false }
      else if (await context.ui.dialog.confirm({ title: "Enable LRCLIB?", message: "Shares the current title, artist, album and duration with lrclib.net. Lyrics stay in memory. An application URL or contact email is required." })) {
        const contact = await context.ui.dialog.prompt({ title: "Your application URL or contact email", placeholder: "https://your-project.example" })
        if (contact && validContact(contact)) draft = { ...draft, lrclibEnabled: true, lrclibContact: contact }
        else if (contact !== undefined) context.ui.toast.show({ message: "A valid HTTPS project URL or email is required", variant: "error" })
      }
    } else if (choice === "refresh") await props.refreshLyrics()
  }
}
