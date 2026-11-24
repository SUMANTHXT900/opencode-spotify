# V0.6.0 installer and distribution security

## Installer review (V0.6.0)

- Global registration and removal use the native
  `opencode plugin add/remove` commands with argv arrays. The installer does not
  hand-edit JSONC, does not modify project configuration, and refuses to guess
  a successful registration without re-reading it.
- All child processes use `execFile` with `shell: false`. Windows `.cmd` shims
  are invoked through `cmd.exe /d /s /c` with quoted, validated arguments;
  `--package-spec` is restricted to a safe character set. No `iex`,
  `Invoke-Expression`, or `curl | sh` is used.
- Every mutating command prints a plan first. `--dry-run` executes no step;
  noninteractive mutations require `--yes`; `spicetify apply` requires a
  separate `--apply`/confirmation even after bridge files are approved;
  credential deletion requires another phrase confirmation.
- Spicetify detection is read-only and checks PATH plus LOCALAPPDATA, `-c`,
  owner-specific installation location, and the Store caveat. Automatic
  installation prefers winget. The fallback downloads the official
  `spicetify/cli` installer over HTTPS, displays its SHA-256, requires a typed
  `INSTALL`, runs it with `pwsh -File`, and cleans the temp file. Upgrades use
  the detected owner and never mix package managers.
- The bridge installer remains the single implementation. It reuses valid
  credentials by default, refuses symlinked config/extension paths and
  ambiguous duplicate `extensions =` keys, preserves unrelated extensions,
  creates timestamped backups, restricts credentials to the current user and
  SYSTEM, and never prints the secret. Uninstall removes only the owned
  extension/registration.
- `scripts/verify-package.mjs` packs a real tarball, checks the file list and
  placeholder secret, installs it into an isolated prefix, and provisions a
  bridge against a fake Spicetify config in a temporary APPDATA. It does not
  touch the developer's Spotify, Spicetify, or OpenCode configuration.
- Update policy pins the plugin version (exact npm spec) so OpenCode's
  automatic package refresh cannot silently leave an incompatible bridge.
  Updates never downgrade and never replace a local development registration
  without an explicit setup choice.
- The release workflow is manual-only, disabled unless
  `NPM_PUBLISH_ENABLED=true`, uses SHA-pinned actions, read-only top-level
  permissions, `id-token: write` only in the publish job, and publishes the
  exact verified tarball. First publication must be manual because OIDC trusted
  publishing requires an existing package. Provenance is omitted while the
  repository is private.
- Dependencies: no new runtime dependencies were added for the installer.
  The 26 moderate advisories remain in transitive glob/minimatch/OpenCode
  chains; CI reports them and fails on high/critical only. No forced audit fix
  was applied.

## Legacy V0.4 audit findings

Preserved from V0.3: IPv4-loopback binding, secure random challenges, HMAC-SHA256,
role-separated proofs, timing-safe verification, pre-auth gating, authentication
deadline, command allowlist, scalar validation, request correlation, disconnect
rejection, metadata/lyrics normalization, bounded queries/pagination, exact Host/
path/loopback checks, authenticated Origin enrollment, observer ownership and
never-retried mutations.

V0.4 changes reviewed:

- Optional LRCLIB access is explicit opt-in and server-side only. It sends track
  title, artist, album, rounded duration and the user-provided project URL/email;
  it never sends the bridge secret, track URI, credentials, terminal state or
  existing lyrics.
- Provider responses are rejected unless title/artist normalize exactly and
  duration is within two seconds. Redirects are disabled. Requests time out after
  six seconds, responses are capped at 512 KiB and must be JSON, and synced LRC
  source is capped at 256 KiB / 5,000 lines. One lookup may be in flight, requests
  are sequential with a 500 ms gap, the cache holds 12 entries and `Retry-After`
  is honored with bounded cooldown.
- lrc.red was evaluated but not implemented; Settings shows it disabled. No
  private Spicy Lyrics backend, hosted transliteration or dynamic-colour service
  is contacted. No artwork URL is fetched or opened.
- `refresh_lyrics` is allowlisted, parameterless, current-track-only and returns
  only an acceptance acknowledgement. It cannot read lyric text back over the
  response channel; lyrics still arrive as validated events. Old extensions simply
  do not advertise it.
- `getLyricsSources` validates a track URI, boolean opt-in/refresh flags and a
  bounded HTTPS/email contact; it rechecks the current track before and after the
  async provider lookup. Output candidates and availability are revalidated and
  bounded to eight candidates/two providers.
- Optional word timings are accepted only with finite ordered numeric
  `startMs`/`endMs` values, no overlap, at most 500 words per line, and exact
  reconstruction of the line text after normalization. Numeric strings are
  normalized to numbers. Missing/guessed timing is never synthesized.
- Unicode layout uses grapheme segmentation and renderer `unicode` measurement;
  terminal escapes/directional overrides are stripped before display. Lyric rows
  are pre-wrapped and clipped, so untrusted text cannot widen or escape the UI.
- Settings are validated on read/write, reject unknown/credential-like fields and
  bound overrides to 200 entries. Lyrics and source candidates remain memory-only.

## Design and boundaries

Approved setup provisions a per-installation 256-bit secret into private user
configuration and the installed extension. Existing credentials are reused; only
explicit `-ResetCredentials` rotates them. Package/source retain a placeholder,
never a production secret. Nothing reads old localStorage credentials. Old manual
credentials are no longer accepted.

Mutual HMAC proofs bind role and both peers' fresh nonces. Unauthenticated
connections cannot access commands/state. Host/path/loopback checks occur before
upgrade. Origin enrollment remains handshake-only until an authenticated extension
proof pins the actual header; after pinning, exact pre-upgrade Origin rejection
applies. No installed Origin is claimed verified until the live checklist is done.

Native observer connections use a separate role/header and mandatory
authentication. Missing/null/opaque Origins remain exact distinct values, never
standing exceptions. See [PROTOCOL.md](PROTOCOL.md) for transcripts, limits and
enrollment policy.

Untrusted metadata and lyrics are bounded and rendered as OpenTUI text, never HTML
or code. Artwork references are parsed as HTTPS/Spotify image metadata; no fetching
or drawing occurs. No generic execution, filesystem or arbitrary-network RPC was
added. The only new outbound destination is `https://lrclib.net/api/get`, reached
only under the opt-in policy above.

Same-user malware, administrators, equivalent-privilege Spotify extensions,
compromised authorized OpenCode clients and active privileged local relays remain
outside isolation guarantees. The bridge authenticates but does not encrypt
loopback traffic. Resource limits reduce abuse, not all local denial of service.
A provider outage/rate limit is surfaced as unavailable/error and cannot mutate
playback, authentication or bridge ownership.

## Installer

`-Install` / `-Repair` / `-Uninstall` require approval, with a separate apply
prompt. Reset additionally requires `RESET`. The installer detects the current
user's Spicetify config, refuses ambiguous/legacy-port registrations and symlink
targets, backs up before replacement, preserves unrelated entries/files,
deduplicates this bridge, provisions privately, verifies registration/content/
syntax, and never downloads an installer. Uninstall keeps private credentials/
backups for reuse. Reset rollback requires restoring the matching credential and
extension backups. Running sessions must restart after credential rotation.

## Changed files (V0.4)

Workspace:

- `README.md`
- `docs/ARCHITECTURE.md`, `docs/FEATURE_MATRIX.md`, `docs/PROTOCOL.md`
- `docs/ROADMAP.md`, `docs/SECURITY_AUDIT.md`, `docs/VERIFICATION.md`
- `docs/UI_UX_DESIGN.md`, `docs/V0.4_RENDER_SNAPSHOTS.txt`

Plugin:

- `plugin/package.json`, `plugin/package-lock.json` (version only; dependencies unchanged)
- `plugin/README.md`
- `plugin/scripts/install-extension.ps1` (V0.4 uninstall marker only; installer
  safety behavior unchanged)
- `plugin/spicetify/opencode-spotify-bridge.js` (lyrics cache, provider/language,
  stale suppression, `refresh_lyrics`; authentication unchanged)
- `plugin/src/rpc.ts`, `plugin/src/index.ts`, `plugin/src/tui.tsx`
- `plugin/src/components/MiniPlayer.tsx`, `Music.tsx`, `LyricsView.tsx`,
  `LyricsSettings.ts`
- `plugin/src/services/lyrics.ts`, `lyrics-source.ts`, `LyricsSourceManager.ts`,
  `SpicetifyServer.ts`, `protocol.ts`, `state.ts`, `validation.ts`
- `plugin/src/ui/layout.ts`, `primitives.tsx`, `colors.ts`, `player-actions.ts`
- `plugin/tests/*` including the native render suite and provider/RPC/layout tests

No changes to `reference/`, dependency versions, installed Spotify/Spicetify
files, global OpenCode configuration or npm publishing. No `spicetify apply` was
run.

## Verification

See [VERIFICATION.md](VERIFICATION.md) for command results, advisory deferral and
the required live security/feature checklist. Automated and renderer tests are not
evidence of live Spotify playback, auth, font shaping or installed-client visuals.
