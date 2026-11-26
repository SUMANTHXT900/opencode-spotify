# Release QA — developer physical checklist (Windows)

Status: **developer-run checklist, not performed by an agent. Never mark it
passed without running it.** Nothing in this document is a claimed result.
Automated suites, renderer fixtures, and the local tarball verifier are not
substitutes for the checks below.

Pre-publication QA uses the **local tarball**, never `npx`. `npx` appears only
in the post-publication section at the end.

Every step is labelled:

| Label | Meaning |
|---|---|
| `READ-ONLY` | Inspects files/commands; writes nothing outside a new backup/evidence directory. |
| `MOCKED` | Uses fixtures or environment variables to simulate a condition; no real service is changed. |
| `ISOLATED-NATIVE` | Runs the real compiled CLI and a real OpenCode process against a throwaway HOME/config/data tree. No real user configuration or Spicetify install is touched. |
| `MUTATING-REAL` | Changes the developer's real OpenCode, Spicetify, Spotify, PATH, or credentials. **Explicit authorization is required before running it.** |

What alters real data:

- §0–§1 (`READ-ONLY`): read the artifact and create a new backup directory;
  no application state changes.
- §2–§6 (`ISOLATED-NATIVE`/`MOCKED`): only files under the throwaway `$root`;
  the real config, Spicetify, credentials, PATH, and Spotify are untouched.
- §7 (`MUTATING-REAL`): changes the real machine (Spicetify install/removal,
  PATH, registration, credentials, playback). Do not run without explicit
  authorization and the §1 backup.

## 0. Record the exact artifact — `READ-ONLY`

For publication, download the tarball, both sidecars, and `proof.json` from
a successful release preparation run. Read the proof for the version,
source SHA and run ID. A locally verified candidate is useful for local QA;
it does not by itself establish which GitHub run will supply the artifact.

```powershell
$tgz = (Resolve-Path '.\opencode-spotify-0.6.0-beta.3.tgz').Path
$side = "$tgz.sha256"
Get-Item $tgz | Select-Object FullName, Length, LastWriteTime
Get-Content $side
```

From the artifact download directory, verify both sidecars:

```powershell
$expected = ((Get-Content $side) -split '\s+')[0].ToLower()
$actual   = (Get-FileHash $tgz -Algorithm SHA256).Hash.ToLower()
if ($actual -ne $expected) { throw "Tarball hash mismatch: $actual" }
$integrity = 'sha512-' + [Convert]::ToBase64String(
  [Security.Cryptography.SHA512]::HashData([IO.File]::ReadAllBytes($tgz)))
if ($integrity -cne (Get-Content "$tgz.integrity" -Raw).Trim()) {
  throw 'Tarball integrity mismatch'
}
"tarball sha256: $actual"
"tarball integrity: $integrity"
```

Record:

- Prepare run ID, source commit SHA and package version (from `proof.json`):
- Tarball size, SHA-256 and npm SHA-512 integrity:
- Automated gate outcomes in the prepare run:
- Windows version / terminal / font:
- OpenCode version (`opencode --version`):
- Node version (`node --version`); Bun version (`bun --version`):

Use this same path for every step below. Any regenerated or changed bytes
need a new verification record and QA before publication.

## 1. Back up the real state — `READ-ONLY`

This section only creates a new backup directory; it changes no application
state. Do this before any `MUTATING-REAL` step.

```powershell
$stamp  = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = Join-Path $HOME "opencode-spotify-qa-backup-$stamp"
New-Item -ItemType Directory -Force $backup | Out-Null

Copy-Item "$env:APPDATA\opencode-spotify" (Join-Path $backup 'opencode-spotify') -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item "$env:APPDATA\spicetify" (Join-Path $backup 'spicetify') -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item "$env:LOCALAPPDATA\spicetify" (Join-Path $backup 'spicetify-local') -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item "$HOME\.config\opencode\opencode.json*" $backup -Force -ErrorAction SilentlyContinue
Copy-Item "$HOME\.config\opencode\cli.json" $backup -Force -ErrorAction SilentlyContinue
Write-Output "Backup: $backup"
```

The bridge secret lives in the protected backup. Never paste it into a ticket,
screenshot, shell history, or chat.

## 2. Build the isolated QA environment — `ISOLATED-NATIVE`

Run the whole recipe in a **fresh PowerShell process**. Setting `HOME`,
`APPDATA`, `LOCALAPPDATA`, the XDG variables, and `OPENCODE_CONFIG_DIR` for the
duration of that process redirects the real CLI, OpenCode, npm, and the bridge
to a throwaway tree.

What this section alters: only files under `$root`. It does **not** touch the
real OpenCode config, Spicetify directories, bridge credentials, or PATH.

```powershell
$root   = Join-Path $env:TEMP ("ocsp-qa-" + [guid]::NewGuid().ToString('N'))
$tgz    = (Resolve-Path '.\opencode-spotify-0.6.0-beta.3.tgz').Path  # exact archive checked in §0
$home   = Join-Path $root 'home'
$prefix = Join-Path $root 'prefix'
$config = Join-Path $root 'config'
$state  = Join-Path $root 'state'
$data   = Join-Path $root 'data'
$local  = Join-Path $root 'local'
$roam   = Join-Path $root 'roaming'
$cwd    = Join-Path $root 'neutral'
$logs   = Join-Path $root 'logs'

$dirs = @($home, $prefix, $config, $state, $data, $local, $roam, $cwd, $logs)
$dirs | ForEach-Object { New-Item -ItemType Directory -Force $_ | Out-Null }

$env:HOME                    = $home
$env:USERPROFILE             = $home
$env:XDG_CONFIG_HOME         = $config
$env:XDG_STATE_HOME          = $state
$env:XDG_DATA_HOME           = $data
$env:XDG_CACHE_HOME          = (Join-Path $root 'cache')
$env:APPDATA                 = $roam
$env:LOCALAPPDATA            = $local
$env:OPENCODE_CONFIG_DIR     = (Join-Path $config 'opencode')
$env:OPENCODE_DISABLE_PROJECT_CONFIG = '1'
New-Item -ItemType Directory -Force $env:OPENCODE_CONFIG_DIR, $env:XDG_CACHE_HOME | Out-Null

Set-Location $cwd
"QA root: $root"
```

Notes:

- `OPENCODE_CONFIG_DIR` keeps the registration and service settings isolated.
- `OPENCODE_DISABLE_PROJECT_CONFIG=1` prevents a project `opencode.json(c)`
  from shadowing the test.
- The neutral working directory avoids the repository's local config.

Use a private service port so the isolated process cannot collide with a real
OpenCode service:

```powershell
cmd /d /s /c "call opencode service set port 28991"
if ($LASTEXITCODE -ne 0) { throw 'opencode service set port failed' }
```

## 3. Install the local tarball into the isolated prefix — `ISOLATED-NATIVE`

Install the tarball by local path. Do not use `npx`, do not hit the registry,
and do not install globally on the real machine.

`npm` and `opencode` are `.cmd` shims on Windows. Calling them through
`cmd /d /s /c "call …"` avoids PowerShell execution-policy problems with
`npm.ps1` and always uses the shim:

```powershell
cmd /d /s /c "call npm install --global --prefix `"$prefix`" `"$tgz`""
if ($LASTEXITCODE -ne 0) { throw 'isolated npm install failed' }

$pkg = Join-Path $prefix 'node_modules\opencode-spotify'
if (-not (Test-Path (Join-Path $pkg 'package.json'))) { throw "package not installed at $pkg" }
Get-Content (Join-Path $pkg 'package.json') | Select-String '"version"'
```

The installed version must be the version under test (`0.6.0-beta.3`), not an
older beta.

## 4. Register the absolute plugin path — `ISOLATED-NATIVE`

Register the **absolute installed package path**, not a registry spec. This
proves the packed package loads without depending on publication.

```powershell
cmd /d /s /c "call opencode plugin add `"$pkg`""
if ($LASTEXITCODE -ne 0) { throw 'opencode plugin add failed' }
```

Then confirm what the host actually loads. `opencode plugin list` is **not**
authoritative: it can list a registration whose module failed to load, and it
does not show the TUI half's failure. The authoritative evidence is the
isolated OpenCode log plus a visible TUI render.

## 5. Launch in a neutral directory and verify the load — `ISOLATED-NATIVE`

Start the real TUI in this isolated shell (a real console is required; do not
redirect stdout/stderr, because that would suppress the TUI):

```powershell
Set-Location $cwd
cmd /d /s /c "call opencode --standalone"
```

Leave it running long enough to see the sidebar footer render, then exit the
TUI normally. Locate the log written under the isolated tree:

```powershell
cmd /d /s /c "call opencode debug paths"
Get-ChildItem -Path $state, $env:OPENCODE_CONFIG_DIR, $logs -Recurse -Filter *.log -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -First 10 FullName, Length, LastWriteTime
```

Verify, case-insensitively:

```powershell
$log = Read-Host 'Path to the isolated OpenCode log'
Select-String -Path $log -Pattern 'loading plugin' -SimpleMatch
Select-String -Path $log -Pattern 'Duplicate plugin ID' -SimpleMatch
Select-String -Path $log -Pattern 'beta\.2'
Select-String -Path $log -Pattern 'Cannot find package' -SimpleMatch
```

Pass conditions:

- [ ] The log contains `loading plugin` for `opencode-spotify`.
- [ ] There is **no** `Duplicate plugin ID` line.
- [ ] No loaded path points at a `beta.2` install.
- [ ] No `Cannot find package '@opentui/core'` (or any other packed import)
      error appears.
- [ ] The TUI sidebar footer renders the player (header, artwork placeholder or
      art, transport, lyric rows).

The bridge will report **"Config error"** in this isolated tree. That is
expected: there is no real Spicetify installation or credential under the
throwaway `APPDATA`. It must be a concise connection-state label, not a crash.
Playback is not part of this gate.

Stop the isolated process before continuing by exiting the TUI normally. If it
is stuck, close only the terminal window you opened for this test; do not run a
broad `Get-Process opencode | Stop-Process` against the real machine.

## 6. Isolated test matrix — `ISOLATED-NATIVE` unless marked

### A. Fresh setup without Spicetify

Pre-publication, a registry-fresh `setup` cannot run: beta.3 has no registry
artifact. Use the installed package as the registration spec. Define a
forward-slash form because `--package-spec` accepts `/`, not `\`:

```powershell
$pkgForward = $pkg -replace '\\','/'
node "$pkg\bin\opencode-spotify.js" setup --dry-run --offline --spicetify=manual --package-spec "$pkgForward"
node "$pkg\bin\opencode-spotify.js" setup --yes --non-interactive --spicetify=skip --package-spec "$pkgForward"
```

Run this in a fresh isolated config (before §4) to exercise registration, or
after §4 to exercise maintenance. If this OpenCode build rejects an absolute
path as a plugin spec, use §4's absolute `plugin add` and mark the
registry-fresh half as post-publication-only; do not fake a registry package.

- [ ] Dry-run shows the plan and changes nothing (compare the isolated tree
      before/after).
- [ ] Missing Spicetify is reported accurately; offline mode makes no network
      query.
- [ ] `--spicetify=manual` prints the pinned installer URL/digests and downloads
      nothing.
- [ ] Completing setup with `--spicetify=skip` registers the plugin (absolute
      path spec or the §4 registration) and installs the bridge under the
      isolated `APPDATA`.
- [ ] Rerunning setup detects the existing installation and offers maintenance.
- [ ] No real PATH, config, or credentials were touched (`READ-ONLY` check of
      the real paths before/after).

### B. Cancellation and lock (`ISOLATED-NATIVE`, second process)

- [ ] Start a long isolated operation, press Ctrl+C once: the in-flight
      protected step finishes, remaining steps are skipped, exit is 130, and
      the terminal is restored.
- [ ] Press Ctrl+C twice: the owned child tree is killed; exit is 130.
- [ ] A second mutating installer while the lock is held exits 1 with the
      "another installer … holds the installer lock" message.
- [ ] `status` and `doctor` still run while the lock is held; they do not
      acquire it.
- [ ] `--dry-run setup` does not take the lock.
- [ ] After a simulated crash (kill the holder), a later mutating run reclaims
      the stale lock; no process is auto-killed.
- [ ] The lock file is `%LOCALAPPDATA%\opencode-spotify\installer.lock` (in the
      isolated tree) and is removed on normal exit.

### C. Maintenance commands

```powershell
node "$pkg\bin\opencode-spotify.js" status
node "$pkg\bin\opencode-spotify.js" status --json
node "$pkg\bin\opencode-spotify.js" doctor
node "$pkg\bin\opencode-spotify.js" doctor --json
node "$pkg\bin\opencode-spotify.js" repair --dry-run
```

- [ ] Status/doctor make no changes.
- [ ] `--json` emits exactly one valid JSON document and no UI text.
- [ ] `--json` is rejected with exit 2 for `setup`, `update`, `repair`, and
      `uninstall`.
- [ ] Doctor reports real problems with actionable fixes.
- [ ] Repair dry-run lists only owned registration/bridge work.

### D. Uninstall modes

```powershell
node "$pkg\bin\opencode-spotify.js" uninstall --dry-run
node "$pkg\bin\opencode-spotify.js" uninstall --yes --non-interactive
```

- [ ] Dry-run prompts for nothing and claims nothing was removed.
- [ ] Plugin-only removal removes the isolated registration and owned bridge;
      credentials, backups, and unrelated files stay.
- [ ] A rerun after successful removal exits 0 and reports no residual work.
- [ ] A residual (for example a leftover bridge file the run could not edit)
      makes the run exit 1 with the exact item named.
- [ ] `--complete` in a noninteractive shell without `--yes` exits 2 and
      changes nothing.
- [ ] Interactive `--complete` requires typing `UNINSTALL`; empty input, Back,
      and Escape cancel without mutating.
- [ ] Complete removal with no validated Spicetify backup preserves Spicetify
      data and states that the Spotify restore state is unknown.
- [ ] No new secret-bearing backup is created by uninstall.

### E. Ink UI and plain fallback

- [ ] In a real TTY, `setup`/`status`/`doctor`/`repair`/`update`/`uninstall`
      render the inline Ink dashboard; no alternate-screen takeover.
- [ ] The wide colour progress bar is the `@inkjs/ui` `ProgressBar`; narrow or
      `--no-color` runs use the ASCII bar.
- [ ] `--plain`, `--no-ink`, `--json`, non-TTY, `CI`, `TERM=dumb`, and
      `OPENCODE_SPOTIFY_UI=plain` produce deterministic plain output.
- [ ] Resize 40×24 and 120×40: rows stay bounded and do not overlap.
- [ ] Ctrl+C exits 130 and leaves the terminal in cooked mode with the cursor
      visible.
- [ ] During the official installer the Ink shell is suspended; the console is
      readable and the shell resumes afterwards.

### F. Engines and packaging

- [ ] `node --version` meets `>= 22.18.0`; the CLI prints its version and help.
- [ ] Bun `>= 1.3.14` is present for the TUI; the installer itself needs only
      Node.
- [ ] `npm ci --ignore-scripts --no-audit` prints an `EBADENGINE` warning for
      `@opentui/core` (`node >=26.4.0`) and still succeeds.
- [ ] `npm run test:fast` results are recorded exactly as observed (see
      [MAINTAINERS.md](MAINTAINERS.md) for the current bucket layout).
- [ ] `npm run test:bun`, `npm run test:vt`, `npm run build:cli`, and
      `node scripts/verify-package.mjs` are run once and recorded.

## 7. Real mutation gates — `MUTATING-REAL` (authorization required)

Each step changes the developer's real machine. Get explicit approval before
running it, record the exact commands, and stop on the first unexpected result.
Back up first (§1).

### G. Clean Spicetify removal (only for a fresh-install test)

- [ ] `spicetify restore`, then remove `%APPDATA%\spicetify` and
      `%LOCALAPPDATA%\spicetify` manually, and remove the exact user PATH entry.
- [ ] Spotify starts cleanly before reinstalling.
- [ ] Do not remove Spotify itself, unrelated extensions/themes, or OpenCode.

### H. Fresh Spicetify install from the real CLI

```powershell
# With the real config (no isolated env), from the installed package:
opencode-spotify setup --spicetify=auto
```

- [ ] The plan shows the GitHub-resolved latest **stable** target, the pinned
      installer revision/digests, and the reviewed Marketplace-removed execution.
- [ ] The upstream existing-install prompt still appears; answer No to keep the
      pinned install path.
- [ ] No Marketplace prompt appears; no Marketplace URL is contacted.
- [ ] When the execution policy is Restricted/AllSigned, the run fails with
      `E_POLICY_BLOCKED` and prints manual instructions; no bypass is attempted.
- [ ] A successful install is claimed only after post-install verification
      (Authenticode Valid, `CN=SignPath Foundation`, exact version, user PATH,
      Marketplace directories unchanged).
- [ ] Cancelling or timing out kills the tree once and rolls back PATH/partial
      install only after confirmed exit.
- [ ] An existing winget/scoop/choco copy is never overlaid; its manager is
      used. Unknown ownership is refused.

### I. Uninstall against real state

- [ ] Plugin-only uninstall removes the real registration and owned bridge and
      says `spicetify apply` is still needed to finish in the running client.
- [ ] Spotify, Spicetify, other extensions/themes, unrelated PATH entries,
      credentials (unless chosen), and backups survive.
- [ ] Complete removal restores Spotify first; a failed/uncertain restore
      deletes nothing.
- [ ] Manager-owned copies are removed via the owner (`winget uninstall --id
      Spicetify.Spicetify -e --accept-source-agreements --disable-interactivity`;
      `scoop uninstall spicetify-cli`; `choco uninstall spicetify-cli -y`).
- [ ] Reinstallation after plugin-only removal reuses the existing secret.

### J. Player regressions (real Spotify session)

- [ ] Tamil, Malayalam, Telugu — no ghost/stale lyric cells.
- [ ] Rapid track switching and backward/forward seeks.
- [ ] Editor typing uninterrupted during playback and lyric changes.
- [ ] Mouse-only Spotify controls; no focus theft.
- [ ] Volume, seek, transport, artwork, Music/Lyrics/More.
- [ ] 120×40, 100×40, smaller heights, expanded/collapsed Context/MCP/Todo.
- [ ] Multiple OpenCode processes attach with one authenticated owner.

## 8. Post-publication QA (only after a registry version exists)

Do not run this section pre-publication. Replace the version with the published
prerelease and re-run the matrix against the registry artifact.

```powershell
npx opencode-spotify@0.6.0-beta.3 setup
npx opencode-spotify@0.6.0-beta.3 status --json
npx opencode-spotify@0.6.0-beta.3 update --dry-run
npx opencode-spotify@beta setup
```

- [ ] `npm view opencode-spotify dist-tags --json` never labels a prerelease as
      stable.
- [ ] The registry tarball digest matches the published integrity.
- [ ] A stable install never advertises/downgrades to an older tag.
- [ ] A beta install offers a newer beta or stable, whichever is compatible.

## 9. Failure handling and promotion

- Keep a failed candidate off `latest`.
- Record the exact command, environment, redacted output, and which label
  (`ISOLATED-NATIVE` vs `MUTATING-REAL`) the failure came from.
- Do not overwrite a published version; bump and republish under `beta`.
- Promote `latest` only after every applicable check passes and the evidence is
  recorded in the release preparation run.

## 10. Cleanup

```powershell
# After stopping every isolated OpenCode process:
Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
```

Keep the logs or a redacted excerpt if a check failed. Remove the temporary
backup only when the real state is verified and the QA record is complete.

## Appendix A. One-time repository checks

Folded in from the pre-launch readiness audit. These run once per release
engineering change, not per candidate:

- [ ] No hardcoded production secrets, tokens, private keys, or credential files
      in tracked files or reachable history (only the placeholder
      `__OPENCODE_SPOTIFY_SECRET__`, two documented Spotify hashes, and the words
      `NPM_TOKEN` in workflow/docs). No `.npmrc`, `.env`, `bridge.json`,
      backups, or captures tracked. If any credential were ever exposed, rotate
      it — file removal alone is not enough.
- [ ] Privacy: no real usernames/home paths/IPs/credentials in tracked docs (only
      `C:\Users\<user>` templates and `$HOME`/`$APPDATA` generics). Screenshots stay
      untracked and ignored; lyric lines in evidence text are redacted or annotated.
- [ ] `LICENSE` (root) byte-identical to `plugin/LICENSE`; `package.json`
      `license: MIT` consistent. Third-party terms disclaimed (Spotify, Spicetify,
      OpenCode, OpenTUI, lyric providers).
- [ ] Retained tarball (if any) rebuilt via `verify:package --keep-dir` plus
      sidecars at release time; stale retained candidates removed or re-verified.
- [ ] Green CI on the launch commit; branch protection requires both Windows CI
      checks; repo settings applied (see [MAINTAINERS.md](MAINTAINERS.md)).
- [ ] First publish stays manual; publication goes to `beta` without moving
      `latest`; stable promotion only after its own QA.
