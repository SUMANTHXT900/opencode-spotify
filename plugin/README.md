# opencode-spotify 0.5.7

> Private Windows dev baseline for `SUMANTHXT900/opencode-spotify`.
> Not publicly published — no npm release. Automated checks only;
> no live QA is claimed.

Native OpenCode 2.3.0 Spotify player and browser. Requires OpenTUI 0.9 and
an installed protocol-2 / auto-1 Spicetify bridge. V0.5.7 provides a pinned
monochrome sidebar card (header, navigation, framed true-pixel artwork, title,
artist, progress, fixed transport, compact volume and a five-line synchronized
lyric window with natural multiline wrapping), a dedicated session panel with
immersive lyrics, release-to-commit
seek, and coalesced live volume drags. Artwork is capped at 9 sidebar rows,
never enlarged beyond its decoded texture, and remains the only color; the
timeline is a static monochrome bar driven by playback time.

Use the mouse for player controls. The sidebar does not take editor focus or
register Spotify key bindings; native OpenCode dialogs and text fields keep
their usual keyboard behavior. Click the gear to set provider, script,
follow, cover visibility, motion and layout density. Existing `lyrics-v0.4`
preferences are retained. Effects follow playback time and respect Reduced
Motion. Lyric timing and artwork remain memory-only. Optional LRCLIB requires
contact information. See the workspace documentation for verified renderer
and Spotify behavior.

Run `npm ci --ignore-scripts --no-audit`, `npm run typecheck`, `npm test`, `npm run test:render`,
`npm run test:vt`, `npm run test:artwork`, and `npm pack --dry-run`. The native
rendering, VT, and artwork tests require Bun.
Run `pwsh -NoProfile -File scripts/install-extension.ps1` for inspection only;
`-Install` requests approval, makes backups, then separately offers to apply.
Do not enable duplicate bridge copies. The receiver binds only `127.0.0.1:18765`.

The approved installer automatically provisions a persistent, installation-specific
secret for both ends. Launch Spotify and OpenCode in either order; connections
authenticate and reconnect automatically, without prompts. Use `-Repair` to
reinstall without rotating credentials; use `-Repair -ResetCredentials` for explicit
rotation, then restart OpenCode. `-Uninstall` removes only this bridge and keeps
credentials/backups for reinstall. The first authenticated connection pins the
desktop's actual Origin; no assumed Spotify website Origin is shipped. See the
workspace `docs/PROTOCOL.md`, `docs/UI_UX_DESIGN.md` and
`docs/VERIFICATION.md`. See the recorded live checks in the workspace verification guide.
