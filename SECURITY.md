# Security policy

## Supported versions

| Version | Support |
|---|---|
| 0.6.0 (Windows) | Supported stable release |
| ≤ 0.5.7 | Player-only; distribution fixes land in 0.6.x |

## Reporting a vulnerability

Do **not** open a public issue for suspected vulnerabilities (credential
handling, bridge auth, installer command execution, secret leaks).

- Contact the maintainer privately (see repository profile) with: affected
  version/commit, reproduction steps, redacted logs (no secrets, tokens, or
  `bridge.json` contents), and impact assessment.
- Expect acknowledgment within 7 days; coordinated disclosure before any fix
  is published.
- Never include real secrets, `bridge.json`, backups, or private machine
  paths in any report or screenshot.

## Guarantees and non-guarantees

- Bridge credentials live in `%APPDATA%/opencode-spotify/bridge.json`
  (0600/0700, symlink-refused) and are never printed or packed.
- The installer never terminates unrelated processes or edits unrelated
  OpenCode plugins, themes, extensions, or backups.
- The bridge authenticates (mutual HMAC over loopback) but does not encrypt
  loopback traffic. Same-user malware, administrators, equally privileged
  Spotify extensions, compromised authorized OpenCode clients, and active
  privileged local relays are outside the isolation guarantees. See
  [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full boundary and
  residual risks.
- Spotify/Spicetify/OpenCode/OpenTUI retain their own terms; optional lyric
  providers retain theirs.
