# V0.6.0-beta.1 developer physical QA (Windows)

This checklist is performed by the developer, not by an agent. It begins only
after a prerelease is published and `npx` can fetch it. Automated tests and the
local tarball verifier are not substitutes.

## 0. Record the exact artifact

- GitHub commit SHA:
- npm version and dist-tags (`npm view opencode-spotify dist-tags --json`):
- Tarball SHA-256 from the release run:
- Windows version / terminal / font:

## 1. Back up the current state (do this first)

Do not continue without backups.

```powershell
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = Join-Path $HOME "opencode-spotify-qa-backup-$stamp"
New-Item -ItemType Directory -Force $backup | Out-Null

# Credentials, Spicetify config/extensions/themes, OpenCode configuration.
Copy-Item "$env:APPDATA\opencode-spotify" (Join-Path $backup "opencode-spotify") -Recurse -Force
Copy-Item "$env:APPDATA\spicetify" (Join-Path $backup "spicetify") -Recurse -Force
Copy-Item "$HOME\.config\opencode\opencode.json*" $backup -Force -ErrorAction SilentlyContinue
Copy-Item "$HOME\.config\opencode\cli.json" $backup -Force -ErrorAction SilentlyContinue
Write-Output "Backup: $backup"
```

Store the bridge secret only in the protected backup; never paste it into a
ticket, screenshot, shell history, or chat.

## 2. Remove the existing plugin and bridge

From the existing checkout (`plugin/`), inspect first, then remove only owned
files. Each command asks for explicit approval; do not pass `-Yes`.

```powershell
pwsh -NoProfile -File scripts/install-extension.ps1
pwsh -NoProfile -File scripts/install-extension.ps1 -Uninstall
opencode plugin remove opencode-spotify
opencode plugin list
```

If a project-level `opencode.json(c)` also lists `./plugin`, remove that entry
manually after backing it up. The V0.6.0 installer never edits project config.

Apply the bridge removal:

```powershell
spicetify apply
```

Then verify Spotify still starts and other extensions/themes still work.

## 3. Optional: clean Spicetify removal (only for Test A)

Skip this if you are running Test B (existing Spicetify installation).

```powershell
spicetify restore
# Confirm Spotify starts clean before deleting files.
Remove-Item "$env:APPDATA\spicetify" -Recurse -Force
Remove-Item "$env:LOCALAPPDATA\spicetify" -Recurse -Force
# Remove the user PATH entry containing %LOCALAPPDATA%\spicetify yourself.
# If installed through winget/scoop/choco, use that manager's uninstall command.
```

Do not remove Spotify Desktop, unrelated extensions, themes, custom apps, or
OpenCode configuration.

## 4. Install from the real registry

```powershell
npx opencode-spotify@0.6.0-beta.1
```

Also verify the explicit form and the beta tag form:

```powershell
npx opencode-spotify@0.6.0-beta.1 setup
npx opencode-spotify@beta setup
```

The installer must detect the environment, show a plan, and ask before each
modification. Cancel once and confirm nothing changed. Then repeat and complete
the installation.

## 5. Test matrix

### A. Fresh install without Spicetify
- [ ] Missing Spicetify is reported accurately.
- [ ] Automatic, manual, and exit choices appear.
- [ ] Automatic install shows the method/source and requires
      confirmation. For the official-script path, the log states the checksum
      covers the downloaded file only and the script is unsigned; prefer
      winget or manual install when in doubt.
- [ ] Cancelling changes nothing.
- [ ] Completing setup registers the plugin globally and installs the bridge.
- [ ] `spicetify apply` is a separate confirmation.
- [ ] Spotify reconnects after restarting Spotify/OpenCode.

### B. Existing Spicetify
- [ ] Existing Spicetify is detected and not reinstalled unnecessarily.
- [ ] Existing themes/extensions survive.

### C. Global availability
- [ ] Works in the original development project.
- [ ] Works in an unrelated project.
- [ ] Works in a newly created project and new session.
- [ ] Works in a new terminal window and after a Windows restart.
- [ ] Multiple OpenCode processes attach without duplicate bridge owners or
      port conflicts.
- [ ] No project-specific configuration is required.

### D. Existing installation detection
- [ ] Rerunning `npx opencode-spotify@beta` detects plugin, Spicetify, bridge,
      and versions.
- [ ] Maintenance choices appear; no duplicate registration or extension is
      created.

### E. Plugin-only update
- [ ] A newer compatible version is detected.
- [ ] Plugin and required bridge update together; Spicetify CLI is unchanged.
- [ ] Registration, credentials, and playback survive the restart.

### F. Combined update
- [ ] The correct Spicetify owner/upgrade method is identified.
- [ ] Unrelated extensions/configurations survive.
- [ ] Plugin and bridge remain compatible.
- [ ] Failure produces a useful recovery message.

### G. Maintenance commands
```powershell
npx opencode-spotify@beta status
npx opencode-spotify@beta status --json
npx opencode-spotify@beta doctor
npx opencode-spotify@beta doctor --json
npx opencode-spotify@beta repair
```
- [ ] Status/doctor make no changes.
- [ ] Doctor reports real problems with actionable fixes.
- [ ] Repair fixes only owned registration/bridge state.

### H. Uninstall
```powershell
npx opencode-spotify@beta uninstall
```
- [ ] Global registration and owned bridge are removed.
- [ ] Spotify, Spicetify, other extensions/themes, unrelated OpenCode
      configuration, and backups remain.
- [ ] Reinstallation is possible.
- [ ] Credential removal is optional and separately confirmed.

### I. V0.5.7 player regressions
- [ ] Tamil, Malayalam, Telugu — no ghost/stale lyric cells.
- [ ] Rapid track switching and backward/forward seeks.
- [ ] Editor typing uninterrupted during playback and lyric changes.
- [ ] Mouse-only Spotify controls; no focus theft.
- [ ] Volume, seek, transport, artwork, Music/Lyrics/More.
- [ ] 120×40, 100×40, smaller heights, expanded/collapsed Context/MCP/Todo.
- [ ] Multiple OpenCode processes and authenticated bridge connectivity.

## 6. Failure handling

- Keep the failed candidate off `latest`.
- Capture the exact command, environment, and redacted output.
- Do not overwrite a published npm version; bump and republish a corrected
  candidate under `beta`.
- Repeat the relevant tests.

## 7. Stable promotion

Only after every check above passes:

```powershell
npm dist-tag add opencode-spotify@0.6.0 latest
```

Use the same reviewed stable artifact that passed the registry QA. Do not
promote an artifact that was not installed from the registry. Record the tag
change and the QA evidence in `docs/VERIFICATION.md`.
