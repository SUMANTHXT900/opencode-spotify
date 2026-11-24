# V0.5.7 compatibility and feature matrix

Baseline: OpenCode 2.3.0 SDK types inspected; Spicetify CLI 2.46.7 detected.
Available commands depend on the installed Spotify client. See the
[live verification results](VERIFICATION.md) for observed V0.5 behavior.

| Feature / wire name | Reference support / API | Plugin behavior | Availability / safe fallback |
|---|---|---|---|
| `get_capabilities`, `ping` | protocol 1, command list and API booleans | authenticated protocol 2; `refresh_lyrics` advertised | old extension rejected with update message |
| track | automatic on connect + songchange, `Player.data.item.metadata` | image reference, duration | missing fields remain empty |
| playback | absent (old Python used Windows media controls) | Player methods and `get_playback` snapshots | per-method detection; unknown getters stay null |
| seeking | absent | `Platform.PlayerAPI.seekTo(ms)` | disabled if unavailable; no ambiguous fractional seek |
| shuffle / repeat | absent | Player getters/setters; repeat 0/1/2 | disabled individually; no Smart Shuffle toggle |
| volume / mute | absent | Player getters/setters; volume 0..1 | disabled individually |
| heart | absent in old bridge | guarded current-track `getHeart`/`setHeart`; sidebar and menu controls | selected-track/foreign-URI mutations rejected; current URI must match |
| Spotify lyrics / `lyrics_unavailable` | Cosmos color-lyrics, track-bound lines | normalized provider/language, partial timing, bounded cache, stale suppression | line/static only in the maintained bridge; unavailable never affects playback |
| `refresh_lyrics` | absent in V0.3 | parameterless command requests a fresh current-track payload | capability-gated; old extension falls back to RPC hydration |
| `getLyricsSources` | absent in V0.3 | OpenCode RPC returns Spotify + optional LRCLIB candidates and availability | current-track URI rechecked before/after; bounded 8 candidates/2 providers |
| LRCLIB provider | documented public API | opt-in exact metadata match, LRC/static candidates, caching, sequential requests, Retry-After | no request without contact; redirects/size/type/rate failures never become lyrics |
| lrc.red provider | documented public API attribution/contact rules | evaluated only; shown disabled in Settings | not implemented; no unverified private service |
| script selection | provider text/script classification | original/romanized/auto with explicit fallback notes | no transliteration package or generated romanization; unconfirmed Latin labelled |
| lyric moments | Spotify timed lyric lines | no-track/loading/ready/unsynced/unavailable/error and instrumental presentation states; explicit timed blank/marker gaps | only known intro and explicit timed gaps are shown as instrumental; ordinary timestamp gaps do not imply a break; no end time/outro is fabricated |
| word-level lyrics | optional `WORD_SYNCED` word arrays | service validates ordered timing and maps provider text to UTF-16 offsets shared by renderers | maintained Spotify and LRCLIB paths currently supply line/static timing only; no guessed word timing |
| `get_queue`, `queue_update` | `Player.origin._queue.getQueue` and private `queue_update` | receiver + UI | private API may change; explicit refresh |
| `add_to_queue`, `remove_from_queue` | `Spicetify.addToQueue`/`removeFromQueue` | request correlation + safe UI removal | URI+uid must uniquely match explicit queue; no clear fallback |
| `get_playlists` | `Platform.RootlistAPI.getContents`; nested folders | lazy browser with nested titles | error shown without disconnect |
| `get_playlist_tracks` | `Platform.PlaylistAPI.getContents({offset,limit})` | paging and selection | unplayable/local items skipped by normalizer |
| `get_library` | `Platform.LibraryAPI.getTracks` | paging | selected-track library mutations remain unavailable |
| `search` | GraphQL `searchTracks` + original `searchDesktop` fallback | paged track results | hashes/private schemas may expire; request error |
| `play_track`, `play_context` | `Player.playUri` | Play Now and whole-playlist context actions | exact selected-track-in-playlist context remains unavailable pending validated shape |
| images | normalized `spotify:image` references in track metadata | largest-candidate selection, 512 px decode ceiling, no-upscale cover renderer | accepts only fixed `i.scdn.co` image URLs; redirects refused; 2 MiB/2048 px limits; source aspect ratio; OpenTUI auto selects the usable protocol; colored blocks verified live |
| artwork-derived wash | cover pixels | accent and 4×3 ambient-color analysis retained for diagnostics only | V0.5.3 paints no derived color or wash; true image pixels are the only color |
| seek and volume drag | native slider input | immediate local preview; seek commits once on release; volume sends coalesced live commits and a final release commit | last-wins targets; stale poll cannot move an active drag; live OpenCode check performed |
| TUI sidebar | `sidebar.footer` slot, keymap, dialog | pinned responsive card with four modes, named controls, compact volume and five-line lyric window | Todo expansion scrolls content without moving the player; short terminals reduce art/lyrics before controls |
| TUI lyrics | custom dialog + pinned window | wrapped row-virtualized viewer, five-line centered window, follow/manual, settings/refresh, bounded motion | right-margin/native-clip containment; host-composition fixture asserts no editor-area leakage; font shaping still terminal-dependent |
| Lyrics Settings | native dialogs | provider/script/priority/display/motion/background/accent/LRCLIB/overrides | invalid settings rejected; lrc.red disabled with reason |

Sources: official [Player](https://spicetify.app/docs/development/api-wrapper/methods/player),
[Platform](https://spicetify.app/docs/development/api-wrapper/methods/platform),
[Queue](https://spicetify.app/docs/development/api-wrapper/properties/queue),
[GraphQL](https://spicetify.app/docs/development/api-wrapper/methods/graphql),
[Extensions](https://spicetify.app/docs/development/extensions),
[LRCLIB](https://lrclib.net/docs.txt), [lrc.red](https://lrc.red/api),
[OpenCode TUI](https://opencode.ai/docs/build/plugins/cli/),
[RPC](https://opencode.ai/docs/build/plugins/rpc/).
