# opencode-spotify 0.6.0-beta.2 (distribution prerelease, unpublished)

> Private Windows development package for `SUMANTHXT900/opencode-spotify`.
> **Not published to npm yet.** All `npx` commands below are the
> post-publication path. Automated verification covers the implementation;
> physical npm-registry installation QA and release approval are still pending.

V0.6.0-beta.2 keeps the V0.5.7 player and adds the global installer: a compiled
`opencode-spotify` CLI (`setup`, `status`, `update`, `repair`, `doctor`,
`uninstall`), Windows prerequisite detection, Spicetify lifecycle choices,
bridge synchronization, a verified tarball check (`npm run verify:package`),
and an inactive manual OIDC release workflow. Distribution and release details
live in the project repository under `docs/DISTRIBUTION.md` and
`docs/V0.6.0_RELEASE_NOTES.md`
(https://github.com/SUMANTHXT900/opencode-spotify).

After publication, register one exact-version global entry
(`opencode-spotify@0.6.0-beta.2` in the global `opencode.json(c)` `plugins`); one
entry loads server + TUI. The installer uses the native
`opencode plugin add` command. CLI flags: `--dry-run`, `--yes`, `--json`,
`--offline`, `--spicetify`, `--apply`, `--allow-spicetify-upgrade`,
`--remove-credentials`, `--package-spec`, and `--non-interactive`.
Never pair the global entry with a duplicate local path entry; never float
the version.

```powershell
# Post-publication only — do not run yet:
npx opencode-spotify@0.6.0-beta.2 setup
npx opencode-spotify@0.6.0-beta.2 status --json
npx opencode-spotify@0.6.0-beta.2 update --dry-run
```

---

Native OpenCode ≥ 2.3.0 Spotify player and browser. Requires OpenTUI 0.9 and
an installed protocol-2 / auto-1 Spicetify bridge. V0.6.0 provides a pinned
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
contact information. See the repository documentation for verified renderer
and Spotify behavior.

Run `npm ci --ignore-scripts --no-audit`, `npm run typecheck`, `npm test`,
`npm run test:render`, `npm run test:vt`, `npm run test:artwork`,
`npm run verify:package`, and `npm pack --dry-run`. The native rendering, VT,
and artwork tests require Bun. The verify script builds the compiled CLI and
provisioner, packs the tarball, audits its file list, installs it in isolation,
and runs the installed `--version` / `--help`.
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
repository `docs/PROTOCOL.md`, `docs/UI_UX_DESIGN.md` and `docs/VERIFICATION.md`
for protocol, interaction and verification details.
