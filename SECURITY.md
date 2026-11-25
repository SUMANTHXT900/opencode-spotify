# Security policy

## Supported versions

| Version | Support |
|---|---|
| 0.6.0-beta.x (Windows) | Best-effort prerelease support |
| ≤ 0.5.7 | Player-only; distribution fixes land in 0.6.0 |

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
- Spotify/Spicetify/OpenCode/OpenTUI retain their own terms; optional lyric
  providers retain theirs.
