# Roadmap

- **V0.1 / Phase 1:** native additive sidebar and command (previously user-verified).
- **V0.2 / Phase 2:** real metadata, shared receiver/RPC, reconnect (previously user-verified).
- **V0.3 implementation:** automatically authenticated extension, player commands/state,
  bounded progress, line lyrics, queue, nested playlists, library, track search,
  tests and opt-in development deployment. **Live validation remains pending.**
- **V0.4 implementation:** grapheme-safe virtualized lyrics, responsive
  MiniPlayer, native Lyrics Settings, stable source/script/timing selection, optional
  exact-match LRCLIB, `refresh_lyrics` and `getLyricsSources`, palette/accessibility
  polish and expanded renderer/regression tests. **Live validation remains pending**;
  see [VERIFICATION.md](VERIFICATION.md).
- **V0.4 validation:** approve/install the updated extension, execute all real
  Spotify/TUI checks, inspect terminal font shaping at narrow widths, and investigate
  any client-specific API or lyric-format failures.
- **V0.5 implementation (current):** responsive animated player, album cover
  loading through the fixed HTTPS `i.scdn.co` allowlist with redirects rejected,
  bounded memory-only artwork cache, OpenTUI 0.9 automatic Kitty/Sixel image
  selection with colored-block fallback, native-cell color/blur wash modes,
  release-only seek/volume RPC commits, and explicit conservative lyric-moment
  states. Reduced motion and the authenticated bridge security model remain in
  force. Live cover, seek, volume and timed lyrics are recorded in [verification](VERIFICATION.md). Mock results do
  not establish Spotify or terminal compatibility.
- **V0.5 validation:** confirm cover rendering and image sizing in supported live
  terminals, fallback behavior without graphics protocols, reduced-motion
  behavior, release-only slider RPC count, responsive layouts and Spotify lyric
  state transitions after an approved extension update.
- **Future compatibility:** exact selected-track playlist context, selected-track
  library mutations, genuine word timestamps only if a verified provider supplies
  them, and additional provider integrations. Do not fabricate support for these.
- **Release:** dependency/security review, installation hardening, package-name
  recheck, and npm publication only after explicit approval.
