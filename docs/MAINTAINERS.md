# Maintainers — opencode-spotify

CI layout, dependency policy, installer trust spec, packaging verification, and the
npm release process. For the bridge protocol and TUI design see
[ARCHITECTURE.md](ARCHITECTURE.md); for the developer install checklist see
[RELEASE_QA.md](RELEASE_QA.md).

## Contents

- [CI: two Windows jobs](#ci-two-windows-jobs)
- [Test buckets and accounting](#test-buckets-and-accounting)
- [Benchmarks](#benchmarks)
- [Forward compatibility](#forward-compatibility)
- [Dependency policy](#dependency-policy)
- [Installer trust spec](#installer-trust-spec)
- [Execution boundary](#execution-boundary)
- [Cancellation, lock, onboarding, ownership](#cancellation-lock-onboarding-ownership)
- [Update policy](#update-policy)
- [Backup and recovery](#backup-and-recovery)
- [Local tarball verification](#local-tarball-verification)
- [npm release: prepare, then publish](#npm-release-prepare-then-publish)
- [Trusted publishing setup](#trusted-publishing-setup)
- [Repository settings](#repository-settings)

## CI: two Windows jobs

`.github/workflows/ci.yml` runs two parallel `windows-2025` jobs on pull requests,
pushes to `main`, manual dispatch, and release preparation:

| Job | Mandatory verification |
|---|---|
| Static checks and unit tests | Locked install, actionlint, release and compatibility policy tests, typecheck, test accounting, bridge syntax, high/critical dependency audit, Node tests |
| Rendering and package verification | Locked install, Bun-native rendering and state, persistent VT, one isolated package build/install/verification |

Both jobs use reviewed Node 24.12.0 and the lockfile-keyed npm **download** cache;
only the native job needs Bun 1.3.14. Each installs its own `node_modules` with
lifecycle scripts disabled. There is no installed-tree handoff. The jobs always
report checks, including on docs or workflow-only changes, so a path filter cannot
leave a required check pending. Repository required-check settings have not been
verified.

Two runners keep static feedback independent of the native/package critical path. A
single runner would save the second checkout and npm install while putting static
checks on that path. A third runner would repeat setup again. Revisit the choice
after comparable hosted timings.

Release preparation calls these same gates and uploads the exact verified bytes and
digests. The separately authorized publication phase uses the earlier successful
preparation artifact and does not compile or pack.

## Test buckets and accounting

From `plugin/`:

```powershell
npm ci --ignore-scripts --no-audit --no-fund
npm run test:accounting
npm run typecheck
npm test                         # alias for test:fast; Node with PowerShell on Windows
npm run test:bun                 # artwork, native layout, and state; requires Bun
npm run test:vt                  # persistent Windows VT replay; requires Bun
node --check spicetify/opencode-spotify-bridge.js
npm audit --audit-level=high
npm run verify:package           # one full isolated Windows consumer gate
```

Accounting classifies every package test file exactly once: 55 fast, 3 Bun-native,
and 1 VT. The static job separately runs the release-policy tests and compatibility
selector self-checks. The package tests in `test:fast` cover manifest policy and
verifier behavior without building or running a consumer install. Compiled output,
installed entrypoints, native installed rendering, and PowerShell provisioning are
checked by the full package gate. `test:render` and `test:artwork` are targeted
local diagnostics for fixtures already exercised by `test:bun`.

Missing dependencies, broken imports, and unavailable mandatory runtimes are
failures. The policy-block probe can report an environmental skip when Windows
Group Policy prevents exercising the test's `Restricted` setting. One filesystem
fixture's symlink case also depends on local symlink permissions.

Known moderate advisories in transitive glob/minimatch/OpenCode chains remain. CI
reports them and fails on high/critical only. No forced audit fix is applied.

## Benchmarks

Cold/warm local samples only — no hosted workflow was dispatched for the profiling
pass, so no hosted speedup is claimed:

- Locked install ~16s, typecheck ~11s, Node bucket ~10–17s, Bun-native ~15–21s,
  VT ~37s, full package gate ~53–67s, audit ~7s (Node 24.12.0, npm 11.6.2,
  Bun 1.3.14, warm download cache; sample variation is normal).
- Inside the package gate: ~6s compile, ~2s pack, ~22s consumer install, ~7s packed
  Bun TUI load/render, ~2s provisioning, ~9s cleanup.
- Isolated npm-install experiment (same retained tarball, fresh consumer prefix):
  cold ~47–55s, warm ~24–27s; bypassing cache staleness checks showed no practical
  gain, so the gate uses normal npm cache policy.

For a hosted comparison, collect at least three warm and one naturally cold run at
the same reviewed source identity, runtime pins, and Windows image. Record cache
hits, queue times, the elapsed critical path, both jobs' runner durations, and the
verifier breakdown. Use an isolated cache for local cold tests; do not purge the
shared cache.

## Forward compatibility

Run `compatibility.yml` manually after review, or opt into its weekly schedule by
setting the repository Actions variable `SPOTIFY_COMPAT_SCHEDULE` to `true`. Unset
it to pause scheduled runner work. The workflow is separate from required primary
CI and cannot publish.

| Windows lane | Resolution | Main gates |
|---|---|---|
| Engine floors | Node 22.18.0, Bun 1.3.14, committed npm lockfile | Node, Bun, VT and packed consumer; isolated OpenCode 2.3.0 version check |
| Renderer and SDK | Latest stable OpenTUI Solid with its exact Core dependency; newest Solid compatible with its peer; latest OpenCode SDK | Typecheck, native rendering, VT and packed consumer |
| Installer and runtimes | Latest stable Node and Bun, compatible Ink/React/React types and Ink UI | Typecheck, Node/Ink tests and packed consumer on the new runtimes |

Candidate installs and lockfiles live in scratch copies. The workflow reports
versions, audit decisions, and gate results; a failed candidate calls for review,
not an automatic upgrade. Live Spicetify checks read stable release and installer
revision metadata only. An upstream installer revision triggers review of the
immutable pin; no scheduled job executes the mutable script. The OpenCode probe
checks binary startup and version, not full plugin loading. The opt-in schedule
avoids three Windows runs and a native host download each week during stabilization.

## Dependency policy

CI and release use exact resolutions in the npm lockfile. The packed manifest uses
ranges only where an independent patch update is supported. Native/host dependencies
remain direct production dependencies; optional peers failed to resolve from
beta.2's installed plugin scope.

| Direct dependency | Declaration | Review policy |
|---|---|---|
| `@opencode/plugin` | `2.3.0` | Runtime server/TUI/RPC constructors. Review SDK and host contracts together; test both supported host ends. |
| `@opentui/core` | `0.9.0` (runtime only) | Native renderer. Update in the same change as Solid integration; run Windows rendering, VT, and packed TUI. |
| `@opentui/solid` | `0.9.0` (runtime only) | JSX transform and reconciler. Its exact Core dependency must match the direct Core pin. |
| `solid-js` | `1.9.19` (runtime only) | Renderer peer `^1.9.12`; Solid 2 is outside it. Validate upgrades alongside the renderer. |
| `ink` | `~7.1.1` | Installer shell, React and reconciler peers. Test interactions and snapshots before advancing the minor/major. |
| `react` | `~19.2.9` | Keep the tested 19.2 line for Ink 7 and matching types. |
| `@inkjs/ui` | `~2.0.0` | Progress and theme widgets. Check Ink peer support, narrow and plain output. |
| `ws` | `^8.23.0` | Server WebSocket; same major. Check bridge authentication, protocol and audit. |
| `@types/node` | `^24.0.0` | Reviewed CI type surface. Run real Node 22.18.0 probes to catch use of newer APIs. |
| `@types/react` | `~19.2.0` | Keep types on React's corresponding minor; npm lock currently resolves 19.2.18. |
| `@types/ws` | `^8.18.2` | Types for WebSocket 8. |
| `ink-testing-library` | `4.0.0` | Snapshot and input harness; review changes to the harness alongside Ink. |
| `typescript` | `^5.9.0` | Build and typecheck; renderer's `bun-ffi-structs` requires compiler major 5. |

The forward-compatibility workflow exercises a small group of coordinated candidates
on scratch manifests. A successful candidate run is upgrade evidence, not an
automatic change to the lockfile or a release decision. For an upgrade, review
upstream notes, regenerate the lockfile using npm, run the primary gates, and QA
the resulting artifact if shipping it.

Dependabot version PRs remain paused (`open-pull-requests-limit: 0`). After
stabilization, set a nonzero limit to enable the weekly grouped renderer/installer
and GitHub Actions PRs; majors require individual review. Dependabot alerts and
security updates are controlled in repository settings; they are separate from the
version-PR limit.

## Installer trust spec

Implementation: `plugin/src/cli/spicetify-official.ts`
(`patchOfficialInstallerScript`, `buildOfficialWrapperCommand`) and the constants
in `plugin/src/cli/compat.ts`. This spec is byte-exact; any change to the pin
requires the revision-bump review procedure at the end of this section.

### Upstream identity

| Field | Value |
|---|---|
| Repository | `spicetify/cli` |
| Revision | `f4a824fbbe07233adeab889328e6fefdc274660b` |
| URL | `https://raw.githubusercontent.com/spicetify/cli/f4a824fbbe07233adeab889328e6fefdc274660b/install.ps1` |
| Original size | 8,307 bytes |
| Original SHA-256 | `e65d1651dc6e3eacbcb58a56f2979f75ad1af16423b114d78d411312c0a8e22e` |
| Encoding rule | plain ASCII, no UTF-8 BOM (rejected otherwise) |
| Upstream licence | LGPL-2.1 (per the upstream repository) |

The URL is a commit-pinned raw URL, never a branch. The script is downloaded at run
time and is **not** included in the npm tarball. A byte-exact copy of the pinned
revision is embedded (base64) in the automated test fixture
`plugin/tests/release-fixture.ts` so patch and wrapper tests can run offline; that
fixture is excluded from the published package. Nothing is fetched or hashed in
`--dry-run`.

### Why the patch exists

The upstream script is interactive and, at this revision, installs Spicetify
Marketplace by default: it prompts with the Marketplace choice **defaulting to
Yes**; the Yes branch downloads a second installer from the mutable
`spicetify/spicetify-marketplace` `main` branch and pipes it into
`Invoke-Expression`; that nested script is neither pinned nor hashed by the
upstream installer.

`opencode-spotify` does not install, manage, or claim Marketplace. It therefore
replaces exactly that region with comments. Everything else — the existing-install
prompt, the optional `spicetify update`, legacy-folder handling, the release
download/extraction, user-PATH update, and the final message — is kept
byte-identical.

### Byte map

| Segment | Offset | Size |
|---|---|---|
| Prefix (untouched) | `0` … `7258` | 7,259 bytes |
| Reviewed Marketplace block (replaced) | `7259` … `8287` | 1,029 bytes |
| Suffix (untouched) | `8288` … `8306` | 19 bytes |
| Original total | — | 8,307 bytes |
| Replacement block | inserted at `7259` | 958 bytes (19 lines, CRLF) |
| Executed total | — | 8,236 bytes |

The suffix is exactly 19 bytes: the final newline plus the closing `#endregion
Main` line. The patcher refuses any other suffix length rather than assuming the
tail is unchanged.

### Original block (lines 224–242, review reference)

The original block is quoted below **for review only**. It is LGPL-2.1 upstream
source; this repository is MIT, and the upstream script is not part of the npm
package or the shipped MIT source. The quote is included so a reviewer can see
exactly what the reviewed patch removes without fetching the file. It is shown
with LF line endings for readability; the upstream file uses CRLF, and the
digest/size apply to those CRLF bytes. It is identified by all of: line range
224–242 (inclusive), 19 lines, 1,029 bytes including CRLF, SHA-256
`5689b770f84bfedd40b03f08d811107f0be83619e89e8452ccf114de78927d3f`, and the
`#region Marketplace` / `#endregion Marketplace` markers, which must be unique in
the file.

```powershell
#region Marketplace
$Host.UI.RawUI.Flushinputbuffer()
$choices = [System.Management.Automation.Host.ChoiceDescription[]] @(
    (New-Object System.Management.Automation.Host.ChoiceDescription "&Yes", "Install Spicetify Marketplace."),
    (New-Object System.Management.Automation.Host.ChoiceDescription "&No", "Do not install Spicetify Marketplace.")
)
$choice = $Host.UI.PromptForChoice('', "`nDo you also want to install Spicetify Marketplace? It will become available within the Spotify client, where you can easily install themes and extensions.", $choices, 0)
if ($choice -eq 1) {
  Write-Host -Object 'spicetify Marketplace installation aborted' -ForegroundColor 'Yellow'
}
else {
  Write-Host -Object 'Starting the spicetify Marketplace installation script..'
  $Parameters = @{
    Uri             = 'https://raw.githubusercontent.com/spicetify/spicetify-marketplace/main/resources/install.ps1'
    UseBasicParsing = $true
  }
  Invoke-WebRequest @Parameters | Invoke-Expression
}
#endregion Marketplace
```

To verify the exact bytes independently:

```powershell
$url = 'https://raw.githubusercontent.com/spicetify/cli/f4a824fbbe07233adeab889328e6fefdc274660b/install.ps1'
$path = Join-Path $env:TEMP 'spicetify-install-review.ps1'
Invoke-WebRequest -Uri $url -OutFile $path
(Get-Item $path).Length                     # expect 8307
(Get-FileHash $path -Algorithm SHA256).Hash.ToLower()
# expect e65d1651dc6e3eacbcb58a56f2979f75ad1af16423b114d78d411312c0a8e22e
$bytes = [IO.File]::ReadAllBytes($path)
$start = 7259
$block = $bytes[$start..($start + 1028)]
(Get-FileHash -InputStream ([IO.MemoryStream]::new($block)) -Algorithm SHA256).Hash.ToLower()
# expect 5689b770f84bfedd40b03f08d811107f0be83619e89e8452ccf114de78927d3f
```

### Replacement block (verbatim)

The executed region is this 19-line, 958-byte comment block (CRLF line endings):

```powershell
#region Marketplace
# Marketplace installation is disabled by the opencode-spotify adapter.
# Replaces spicetify/cli@f4a824fbbe07233adeab889328e6fefdc274660b
# install.ps1 lines 224-242 (LGPL-2.1).
#
# Upstream prompted with default Yes and then fetched and evaluated a mutable
# Marketplace installer from the upstream Marketplace repository. That prompt
# and its download/evaluation branch are removed here, so no Marketplace code
# is present or reachable and no Marketplace URL is contacted.
#
# Everything outside this region is byte-identical to the pinned revision:
# - the existing-install prompt and optional spicetify update branch,
# - Move-OldSpicetifyFolder (legacy folder copy/delete),
# - Get-Spicetify/Install-Spicetify extraction,
# - Add-SpicetifyToPath (user PATH only), and
# - the final "run spicetify -h" message.
#
# Existing %APPDATA%\spicetify Marketplace files are neither read nor changed.
#endregion Marketplace
```

It is comments only. PowerShell has nothing to execute in the region, so no
Marketplace prompt, URL, download, or evaluation exists in the executed script.

### Digests

| Artifact | Size | SHA-256 |
|---|---|---|
| Pinned original script | 8,307 | `e65d1651dc6e3eacbcb58a56f2979f75ad1af16423b114d78d411312c0a8e22e` |
| Original Marketplace block | 1,029 | `5689b770f84bfedd40b03f08d811107f0be83619e89e8452ccf114de78927d3f` |
| Replacement block | 958 | computed at review time; not a pin |
| Executed (patched) script | 8,236 | `056da19ece34be8c3d8543d0f98ff8ba08651bd384d4dc3a8d3dc9e72a7bf172` |

The executed digest is a hard pin. The staged file is re-hashed in Node and again
inside PowerShell from a held `FileShare.Read` handle. A mismatch exits 90 before
`& $env:SPX_SCRIPT` runs.

### Invariants enforced before execution

`patchOfficialInstallerScript` aborts (no fallback to the original) unless all of
these hold:

- the original matches the 8,307-byte / SHA-256 pin, is plain ASCII, and has no BOM;
- exactly one `#region Marketplace` and one `#endregion Marketplace` exist, in that
  order;
- the extracted block is exactly 1,029 bytes and matches the block digest;
- the prefix is exactly 7,259 bytes and the suffix exactly 19 bytes;
- the replacement block has exactly 19 lines and is plain ASCII;
- the result is exactly 8,236 bytes and matches the executed digest;
- the executed text contains **no** `spicetify-marketplace` URL, **no**
  `Do you also want to install Spicetify Marketplace` prompt, and **no**
  `Invoke-Expression`;
- exactly one binary `Invoke-WebRequest @Parameters` remains;
- `#endregion Main`, `Get-Spicetify`, `Install-Spicetify`,
  `Add-SpicetifyToPath`, and `Move-OldSpicetifyFolder` are still present.

Failure codes are `E_PIN_MISMATCH` (original bytes), `E_PATCH_FAILED`
(structure/offsets), and `E_PATCH_MISMATCH` (result digest/invariants).

### Licensing and non-redistribution

- Upstream `install.ps1` is LGPL-2.1. This repository is MIT.
- The upstream script, the patched script, and the executable are **not** shipped
  in the npm tarball. The installer downloads the pinned original at run time,
  patches it in memory, writes the patched variant to a private temporary
  directory, executes it, and deletes the directory after a confirmed exit.
- The offline test fixture embeds the pinned upstream bytes (base64) only to
  verify the patch and wrapper; it is not part of the published package. If the
  project is redistributed as source, that fixture is governed by the upstream
  LGPL-2.1 terms in `THIRD_PARTY_NOTICES.md` at the repository root.
- The original block is quoted in this document for review only, with its upstream
  licence attribution. It is not part of the shipped MIT source or the package.
- The replacement comments carry the upstream revision and licence attribution. No
  upstream code is copied into the package.
- The Marketplace installer that upstream would have fetched is never fetched, so
  its licence and code never enter the process.

The upstream installer does not answer upstream prompts on the operator's behalf,
except that the Marketplace prompt is removed with the rest of its region by patch.
The existing-install prompt remains interactive and the operator answers it. If the
operator answers Yes, the upstream `spicetify update` branch runs.

### Revision-bump review procedure

Never point the pin at `main`, a tag that can move, or a URL without a commit. To
move to a new upstream revision:

1. Pick an immutable commit. Download
   `https://raw.githubusercontent.com/spicetify/cli/<commit>/install.ps1` and read
   it in full.
2. Record the byte length, SHA-256, and confirm ASCII/no-BOM. Update
   `OFFICIAL_INSTALLER_URL`, `OFFICIAL_INSTALLER_COMMIT`,
   `OFFICIAL_INSTALLER_BYTES`, and `OFFICIAL_INSTALLER_SHA256` in `compat.ts`.
3. Re-locate the Marketplace region. Confirm exactly one `#region Marketplace` /
   `#endregion Marketplace` pair. Record the new prefix length, block length,
   block digest, and suffix length.
4. Re-read the new block. If its behaviour changed, revise the replacement comments
   above. The replacement must remain comments only and must not introduce a URL or
   executable statement.
5. Recompute the patched size and SHA-256. Update
   `OFFICIAL_INSTALLER_PATCHED_BYTES`, `OFFICIAL_INSTALLER_PATCHED_SHA256`,
   `OFFICIAL_INSTALLER_MARKETPLACE_BLOCK_BYTES`,
   `OFFICIAL_INSTALLER_MARKETPLACE_BLOCK_SHA256`, and
   `OFFICIAL_INSTALLER_MARKETPLACE_BLOCK_LINES`.
6. Update the prefix/suffix assertions, the invariant list, and this document's byte
   map and digest table. Update the fixture script bytes used by
   `plugin/tests/cli-official-installer.test.ts` and
   `plugin/tests/cli-official-security.test.ts`.
7. Re-run `npm run typecheck` and the official-installer suites. Verify that a
   wrong original, a missing marker, a duplicated marker, a changed block, a
   changed prefix, and a changed suffix each fail closed.
8. Add the review record (commit, digests, reviewer, date) to the change that bumps
   the pin. Do not widen the pin, skip the block check, or fall back to the
   unpatched script under any condition.

### Spicetify installation policy

Installation is owner-aware; the installer never overlays another owner's copy and
never executes an unpinned script:

- **Script pin (fixed):** `spicetify/cli` commit
  `f4a824fbbe07233adeab889328e6fefdc274660b`,
  `https://raw.githubusercontent.com/spicetify/cli/f4a824fbbe07233adeab889328e6fefdc274660b/install.ps1`,
  8,307 bytes, ASCII/no BOM, SHA-256
  `e65d1651dc6e3eacbcb58a56f2979f75ad1af16423b114d78d411312c0a8e22e`.
- **Release target (dynamic):** the GitHub **latest stable** release is resolved at
  run time, validated as strict stable semver, required to satisfy
  `MIN_SPICETIFY`, and required to publish the exact Windows asset for the host
  architecture. The exact `$v` is passed to the pinned script. There is no static
  target and no fallback. 2.46.7 is **not** hardcoded as the target; it can be the
  resolved value only because it is the current latest stable.
- **Marketplace removal:** the pinned script is patched deterministically before
  execution (byte map and digests above). Prefix and suffix are byte-identical.
  There is no Marketplace prompt, URL, or `Invoke-Expression`, and no Marketplace
  URL is contacted. Existing Marketplace files and unrelated Spicetify
  customisations are neither read nor changed by upgrade/repair; a post-install
  existence snapshot fails verification if those paths change.
- **What remains interactive:** the upstream existing-install prompt (default Yes =
  run `spicetify update`) remains a real prompt. The operator answers it; choosing
  No continues with the pinned `$v` install. The installer does not answer this
  prompt or suppress the upstream branch.
- **Refused before approval:** elevation, non-FullLanguage mode, missing `pwsh`, no
  console (piped/headless), offline mode, noninteractive approval, existing copies
  that must not be overlaid, unknown CPU architecture, and a release with no
  matching asset.
- **Success:** exit 0 is not success. The adapter verifies the installed executable
  after the script returns: Authenticode `Valid`, signer `CN=SignPath Foundation`,
  exact version from `spicetify -v`, user PATH entry, and an unchanged Marketplace
  existence snapshot. A reviewed digest is used only for a release/architecture in
  the ledger (currently 2.46.7 x64); otherwise provenance is stated as
  Authenticode + version only.
- **Post-check:** after success the adapter re-queries GitHub once. If a newer
  stable release appeared while installing, it reports that version as "available"
  without retroactively calling the installed one latest. Unknown, prerelease,
  rate-limited, or offline lookups hide update offers; they never substitute a
  version.
- **Existing install:** winget/scoop/Chocolatey copies are upgraded/removed only
  through that manager. A script-owned copy uses the same pinned official
  installer. Unknown ownership is refused with manual guidance. A fresh install
  refuses to overlay any existing copy.
- **Manual path:** prints the pinned installer URL/hash, the resolved target (or
  "not resolved"), the asset name/URL, and the official docs; it downloads and
  executes nothing.
- `--spicetify=ask|auto|manual|skip` and `--dry-run` remain explicit; dry-run
  performs no download, hash read, approval, or network query.

The installed binary verification checks only the final `spicetify.exe`, not the
other files extracted from the release zip — a residual risk recorded in
[ARCHITECTURE.md](ARCHITECTURE.md). The executable digest is only meaningful for
the release/architecture it was reviewed on; the ledger must never be used to
choose a target, only to tighten verification when the resolved target happens to
match.

## Execution boundary

- Global registration and removal use the native `opencode plugin add/remove`
  commands with argv arrays. The installer does not hand-edit JSONC, does not
  modify project configuration, and re-reads registration instead of guessing
  success.
- All ordinary child processes use `execFile` with `shell: false`. Windows `.cmd`
  shims are invoked through `cmd.exe /d /s /c` with quoted, validated arguments;
  `--package-spec` is restricted to a safe character set.
- The official installer is the one interactive exception. It is **not** executed
  with `Invoke-Expression`. The reviewed patched bytes are written to a private
  temporary file and executed as a file with `& $env:SPX_SCRIPT` under the current
  PowerShell execution policy. The adapter passes no `-ExecutionPolicy` argument
  and never uses `Bypass`.
- A `Restricted` or `AllSigned` policy blocks the file. The wrapper catches the
  `PSSecurityException`, prints `E_POLICY_BLOCKED`, and exits 92. The CLI then
  reports the block and prints manual instructions. No override is attempted.
- The staged file is opened with a `FileShare.Read` handle. The Node and PowerShell
  hashes are computed from the same bytes the file holds while `&` executes it.
  Exit 90 = in-PowerShell pin mismatch, 91 = script exception, 92 = policy block.
  Success is **never** inferred from a sentinel or from exit 0 alone; it requires
  the post-install verification above.
- The child receives a whitelisted minimal environment: `SystemRoot`, `windir`,
  `PATH`, `TEMP`, `TMP`, `LOCALAPPDATA`, `APPDATA`, `USERPROFILE`,
  `PROCESSOR_ARCHITECTURE`, `ComSpec`, plus `SPX_SCRIPT` and `SPX_SCRIPT_SHA256`.
  `PSModulePath` is deleted, so module search paths and inherited secrets are not
  passed.
- Termination uses absolute `%SystemRoot%\System32\taskkill.exe` (and `where.exe`
  for PATH resolution), never a CWD-relative binary. A timeout or cancel requests
  exactly one `taskkill /T /F`; the close event is the only confirmed-exit signal.
  Rollback and staged-script cleanup happen only after a confirmed exit.
- Diagnostics are bounded; the bridge secret is never printed. Error text is
  sanitized before it reaches the terminal.

## Cancellation, lock, onboarding, ownership

### Cancellation

A single `CancelToken` travels through the operation; every mutation receives it.

- The **first** Ctrl+C (or SIGTERM) *requests* cancellation. The current protected
  step (restore, apply, backup, owner-manager removal, the official installer child
  and its cleanup) finishes and verifies; remaining steps are skipped. The run is
  reported as partial/cancelled with exit 130.
- A **second** Ctrl+C (or the 10 s force deadline) escalates. Owned plugin-mutation
  children are tree-killed via `taskkill /T /F`; the terminal is restored.
  Restore/apply/backup/manager removals are never interrupted mid-flight.
- Exit 130 is returned only for a genuine user cancellation. A real failure (1) or
  confirmation-required result (2) wins over a concurrent cancellation.
- The terminal is restored on success, failure, cancellation, and SIGTERM.

### Installer lock

Mutating commands (`setup`, `update`, `repair`, `uninstall`) take a per-user lock at
`%LOCALAPPDATA%\opencode-spotify\installer.lock`. `status`, `doctor`, and
`--dry-run` do not.

- Creation is an atomic `open(..., "wx")` + write + `fsync` + close. A temp-file
  rename is deliberately not used, because rename would replace a live lock on
  Windows.
- The lock stores PID, process start time, `startedAt`, a command name only, host,
  and a nonce. A heartbeat refreshes mtime. Stale reclaim is guarded by
  `installer.lock.reclaim` and re-checks the exact nonce before unlinking. A live
  owner with a matching process start time is never preempted.
- After acquisition, detection is re-read before mutating. Release is in `finally`,
  nonce-checked. A second installer exits 1 and points at the read-only commands. No
  process is auto-killed.

### Onboarding tree

```
setup
├─ detect (read-only: Windows, Node, pwsh, OpenCode, Spotify, Spicetify,
│           bridge files/registration, port 18765, registry versions)
├─ plan (numbered steps with real descriptions; dry-run stops after this)
├─ confirm (interactive prompt, or --yes)
├─ execute (backups first, user+SYSTEM-only ACLs, unrelated extensions kept)
└─ verify (status re-read; success only from post-install checks)
update  → never downgrades; never replaces a local dev registration;
           Spicetify moves only with --allow-spicetify-upgrade
repair  → reuses the existing secret (no rotation)
rotation → packed provisioner `-ResetCredentials` (with `-Install` or
            `-Repair`) with typed confirmation only; not a CLI flag
uninstall → plugin-only by default (owned bridge/registration; credentials and
            backups kept). Complete permanent removal additionally deletes
            credentials and owner-safe Spicetify state. Interactive complete
            removal requires typing UNINSTALL; noninteractive requires
            --complete (or OPENCODE_SPOTIFY_UNINSTALL=complete),
            --non-interactive, and --yes. Spotify is restored before any
            Spicetify-owned deletion; unknown owners are disclosed, never
            deleted.
doctor/status → read-only, safe to run any time (also with --offline)
```

The plan is always shown with its actual step descriptions before consent. The UI
state is not sticky: a result clears the progress bar and prompt, a completed phase
does not remain "running", a versions event refreshes the displayed
installed/latest values, and the activity window shows the recent step history
without replaying the whole run.

### Maintenance menu

Re-running `setup` on an existing installation opens an adaptive menu: update both /
update plugin only / update Spicetify only (each only when that target is genuinely
achievable); Repair (always available, including for a local registration); Uninstall
(when a registration exists); Status + diagnostics, Continue, Exit. It never shows
an inapplicable action and never downgrades. Update entries are suppressed when the
registry tag is older, unknown, a prerelease being compared to stable, or when the
owner has no safe target. A Spicetify approval is collected **once** for the chosen
action; the plan's steps are described before consent and the same approval is not
requested again for the content-changing step. A local-path registration offers
"Switch this global registration to the published package" and is never replaced
implicitly.

### Ownership

Spicetify ownership is classified as `script` (official installer under
`%LOCALAPPDATA%\spicetify`), `winget`, `scoop`, `choco`, or `unknown`. Upgrade:
`script` → pinned official installer; manager → that manager; `unknown` → refuse.
Uninstall: `script` → validated local directory plus exact PATH entries; manager →
manager uninstall; `unknown` → disclose manual steps, never delete.
`status`/`doctor` display the owner and the owner-safe command. Package managers are
never mixed, and a second copy is never installed over the first. Manager package
names are `Spicetify.Spicetify` (winget), `spicetify-cli` (scoop), and
`spicetify-cli` (Chocolatey). Unattended winget removal uses
`--accept-source-agreements --disable-interactivity`.

### Installer UI

`setup`, `status`, `doctor`, `repair`, `update`, and `uninstall` use an inline
Ink/React shell only when stdout and stdin are both TTYs. It renders the installer
dashboard and the applicable menu, never takes over the alternate screen. Plain
output is selected by `--json`, `--plain`/`--no-ink`, a non-TTY stream, `CI`,
`TERM=dumb`, or `OPENCODE_SPOTIFY_UI=plain`. If Ink/React cannot be loaded, the CLI
falls back to plain output (with `--verbose` explaining why) and continues. All UI
packages are loaded by **dynamic import** from the installer shell only; the
server, the OpenCode TUI, and every `--plain`/`--json` path never load them. The
official Spicetify installer runs with the Ink shell suspended so the console is in
cooked mode, then the shell resumes.

The installer uses `ink@~7.1.1`, `react@~19.2.9`, and `@inkjs/ui@~2.0.0` as direct
dependencies. `@inkjs/ui` is used for exactly two things: the themed wide/colour
`ProgressBar` and its `ThemeProvider`. `Select`, `ConfirmInput`, `TextInput`,
`Spinner`, `StatusMessage`, and `Alert` are deliberately **unused** because they
would regress the ASCII/no-colour output, the single-row prompt, key hints, and
typed phrase consent. When `@inkjs/ui` is missing or structurally invalid, the shell
keeps the ASCII progress row. Progress is honest: a percentage bar is drawn only
when an event carries a real, finite `percent`; otherwise the row is indeterminate
and spins. Time is never converted into a fabricated percentage.

## Update policy

- **Pin the exact plugin version** in the global registration
  (`opencode-spotify@0.6.0-beta.3`, never a range or `latest` tag). The plugin and
  the installed bridge move as a pair: a floating spec can silently pair a new
  plugin with a stale bridge (or vice versa) and produce protocol mismatches.
- **No silent Spotify changes.** The updater never applies `spicetify apply`,
  rotates credentials, or upgrades Spicetify without a separate explicit approval.
  Downgrades are never automatic, even if the registry reports an older version. An
  older registry tag is labelled as such and kept.
- **Bridge reuse.** Reinstalls and repairs keep the existing installation secret
  and the pinned desktop Origin. Rotation is a deliberate, separately-confirmed
  provisioner operation (`-ResetCredentials`), followed by an OpenCode restart.
- **No false updates.** A prerelease is never labelled stable; a stable install
  stays on stable. Unknown metadata is shown as unknown, not as a match.

## Backup and recovery

Before any mutation the installer snapshots the existing state with timestamps:
OpenCode config entries, Spicetify config, installed bridge files, and credential
files. Unrelated extension entries are preserved, and duplicate bridge registrations
are deduplicated rather than appended. To roll back: restore the printed
timestamped backups, then run `spicetify apply` only when ready.

Complete uninstall creates no new backup, so it cannot create a new secret-bearing
artifact. It validates an existing Spicetify backup before restoring Spotify and
before deleting Spicetify-owned data.

- PATH removal is CRLF-safe and removes only exact Spicetify entries; every other
  segment is preserved byte-for-byte.
- A run that leaves any residual exits 1 and names the residual; it does not claim
  complete removal. A clean rerun exits 0.
- Backup validation uses the shared inspector: `xpui.spa` 1,000,000–128 MiB and
  `login.spa` 100,000–64 MiB, both present. A missing or invalid backup is reported
  as unknown, never as "Spotify unmodified". This is a sanity range, not
  authenticity: a correctly sized but malicious backup is outside the model.
- Unknown-owner Spicetify config is preserved and disclosed. An orphan bridge file
  or a credential-directory residual (including interrupted
  `bridge.json.backup-*` copies) is reported rather than silently ignored.
- Registration removal is re-verified with `plugin list`; an unverifiable or
  still-listed registration is a failure, not a success.
- Dry-run prompts for nothing and claims nothing. When the Spicetify program is
  already gone but config/backups remain, a later run retries the residual work
  instead of requiring a reinstall.
- The summary says whether `spicetify apply` is still needed to finish removing the
  bridge from the running client. Complete-removal warnings are conditional on
  what is actually planned (for example, backups are not claimed deleted when they
  are not inside a deletion root).

## Local tarball verification

CI and release preparation use the same check as the local command:

```powershell
Set-Location plugin
npm run verify:package
npm run verify:package -- --keep-dir ../release-artifacts/local-candidate
npm run verify:package -- --tarball ../release-artifacts/local-candidate/opencode-spotify-0.6.0-beta.3.tgz
```

Use the first command for ordinary verification, the second when retaining the
verified bytes, or the third when checking a trusted prebuilt tarball. The verifier
compiles both entrypoints into an isolated staging directory and runs `npm pack`
once. Prebuilt mode uses the supplied bytes without compiling or packing and
verifies adjacent digest files when supplied. It asserts the tarball contains
`package.json`, `README.md`, `LICENSE`, `src/index.ts`, `src/tui.tsx`,
`src/rpc.ts`, `bin/opencode-spotify.js`,
`spicetify/opencode-spotify-bridge.js`, and `scripts/install-extension.ps1`;
asserts `bin`/exports/version/license metadata resolve to real files; asserts no
`tests/`, `node_modules`, `.env`, `bridge.json`, credentials, captures, or
device/trailing-dot/absolute tar entries are packed; the bridge still carries the
placeholder secret and no 64-hex value outside the two reviewed Spotify
persisted-query hashes (bridge-only, 64-hex-only check — not a general PII/secret
scan); installs the tarball into an isolated temp prefix with `--ignore-scripts`;
resolves every packed bare import; loads the packed server entry in Node; loads the
packed TUI entry and render-smokes MiniPlayer under Bun; and runs the installed
`bin/opencode-spotify.js --version` / `--help` from an unrelated cwd. npm resolves
dependencies in a fresh consumer prefix using its normal registry/cache behavior.
The checkout lockfile serves development and CI; it does not freeze npm consumer
resolution. The verifier performs no global installs or Spotify operations, and
reports any failure to remove its scratch directory. Packaging unit tests check the
verifier's inputs and integrity logic without running another full install.
Prebuilt-tarball mode is trusted-input-only: it installs and executes the supplied
bytes.

## npm release: prepare, then publish

1. Review the exact commit on `main` or a `release/*` branch. Dispatch `release.yml`
   in preparation mode (empty `prepare_run_id`, `confirm=PREPARE`), using the manifest version and its
   `dist_tag` (`beta` or `latest`). Both mandatory Windows jobs must pass.
2. Download the successful run's candidate artifact. Save its run ID, `proof.json`,
   tarball and digest files. Check the source commit, package version, SHA-256 and
   npm SHA-512 integrity before running the developer physical QA in
   [RELEASE_QA.md](RELEASE_QA.md) on that tarball.
3. After physical QA and explicit publication authorization, dispatch `release.yml`
   with `confirm=PUBLISH`, that `prepare_run_id`, `source_sha`, `source_branch`,
   `expected_sha256`, `expected_sha512`, version and `dist_tag`. The workflow verifies
   the prepared run and both hashes, then publishes those bytes after `npm-release`
   approval. It checks registry integrity and the selected dist-tag. There is no
   rebuild between QA and publication.
4. Use `beta` for prereleases and leave `latest` as it was. Stable has its own
   preparation run and physical QA because it is a different tarball.

`opencode-spotify` already exists on npm. The first manual publication and the
first-package `latest` bootstrap behavior are historical.

## Trusted publishing setup

> Pending — the workflow stays inactive until all of this is done.

- On the npm package: add this repository as a **trusted publisher** (GitHub
  Actions OIDC). This requires the package to exist already. No `NPM_TOKEN` exists
  and none is accepted by the workflow.
- In GitHub: create the `npm-release` environment with required reviewers where the
  account plan allows it (branch restriction to `main` recommended). GitHub may
  auto-create an unprotected environment if it does not exist, so the repository
  variable below is the load-bearing kill switch.
- Set the repository Actions variable `NPM_PUBLISH_ENABLED` to exactly `true`
  (Settings → Variables → Actions). Without it the publish validation fails closed
  (after any required environment approval); leave it unset until the activation
  prerequisites above are verified.
- OIDC needs npm ≥ 11.5.1. The publish job sets up Node 24.12.0 via pinned
  `setup-node` (bundled npm 11.6.2).
- Trusted-publisher configurations created after Sep 2026 default to stage-only
  publishing; explicitly allow direct `npm publish`. A new configuration must
  complete its first successful publish within two days.
- Confirm the environment reviewers and branch restrictions, trusted publisher, and
  repository variable before authorizing a publish dispatch. Repository-side
  activation settings are not verified by this project.

Private-repository caveat: this repository is currently private. npm does not
support provenance for publishes originating from a private repository, so the
release workflow omits `--provenance` while private. Trusted publishing itself
works from a private repository, but the npm "repository" link will not be publicly
viewable and no public provenance badge appears. Do not make the repository public
without separate approval. Revisit this section when visibility changes.

## Repository settings

One-time settings, verified read-only during the public-readiness audit (never
applied by automation — apply them in the GitHub UI):

- Branch protection on `main`: require pull-request review and both current Windows
  CI checks (Static checks and unit tests; Rendering and package verification), and
  disable force pushes. Verify the exact check names in GitHub.
- Secret scanning + push protection on; Dependabot on (config added as
  `.github/dependabot.yml`: npm + actions, weekly).
- Fork PR workflows unprivileged; release stays manual (`workflow_dispatch`,
  `npm-release` environment reviewers, `main`-only rule).
- No hardcoded production secrets, tokens, private keys, or credential files in
  tracked files or reachable history (only the placeholder
  `__OPENCODE_SPOTIFY_SECRET__`, two documented Spotify hashes, and the words
  `NPM_TOKEN` in workflow/docs). No `.npmrc`, `.env`, `bridge.json`, backups, or
  captures tracked. If any credential were ever exposed, rotation (not just file
  removal) would be required.
- `reference/` (including the AGPL `spicy-lyrics/` study material) is untracked,
  ignored, and excluded from the pack. Re-confirm provenance before any reuse —
  no AGPL source was copied into `src/` or `spicetify/`, and MIT licensing applies
  only to the shipped code.
- Commit author email becomes public on open-sourcing (accept or use a private
  email / `.mailmap`; no history rewrite).
