# opencode-spotify 0.5.0

Native OpenCode 2.3.0 Spotify player and browser. Requires OpenTUI 0.9 and
an installed protocol-2 / auto-1 Spicetify bridge. V0.5 adds centered album
covers, release-to-commit seek and volume sliders, a rolling lyric carousel,
instrumental dots and grouped settings. OpenTUI draws detected native graphics
or colored blocks. RGB terminals can show album colors or the soft artwork wash.

Use **Spotify: Focus player controls** from the command palette, then Tab or
Shift+Tab to select, Enter to activate, and Escape to leave. Left/Right and
Home/End work on focused sliders. Click the gear to set motion, provider,
script, follow, cover visibility and appearance. Existing `lyrics-v0.4`
preferences are retained. Effects follow playback time and respect Reduced
Motion. Lyric timing and artwork remain memory-only. Optional LRCLIB requires
contact information. See the workspace documentation for verified renderer
and Spotify behavior.

Run `npm install`, `npm run typecheck`, `npm test`, and `npm pack --dry-run`.
The native OpenTUI renderer test requires Bun; `npm test` invokes it automatically.
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
