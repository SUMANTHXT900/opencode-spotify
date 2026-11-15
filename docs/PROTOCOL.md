# Bridge protocol 2 / auto-1 (V0.4)

The bridge wire protocol is unchanged from V0.3. V0.4 adds one optional
parameterless command (`refresh_lyrics`) and OpenCode RPC methods that never
travel over the bridge. Existing authentication, Origin, Host, ownership and
rate-limit behavior is preserved.

Transport: WebSocket at `ws://127.0.0.1:18765`. Maximum message size: 4 MiB;
no compression. Bind address is always IPv4 `127.0.0.1`, never all interfaces.
Upgrade requires peer `127.0.0.1`, exact Host `127.0.0.1:18765`, and path `/`
(no query). Tests alone inject ephemeral ports. Hostnames, alternate ports,
forwarded headers and DNS aliases are not trusted.

## Automatic provisioning and Origin enrollment

The explicitly approved installer generates 32 secure random bytes once. The
64-character hex string is stored in `%APPDATA%\opencode-spotify\bridge.json`
(fallback `%USERPROFILE%\AppData\Roaming`) on Windows, or
`$XDG_CONFIG_HOME/opencode-spotify/bridge.json` / `~/.config/opencode-spotify/bridge.json`
elsewhere. It is substituted into the **installed copy** of the extension.
The package contains only a placeholder. Normal launches only read credentials;
repair/update reuses them. Malformed existing config fails closed.

Windows installer ACLs grant only the current user and SYSTEM access to the
credential directory/files and installed extension/backups. POSIX uses directory
0700/files 0600. Administrators, same-user processes, and equivalent Spotify
extensions remain trusted. Backups contain secrets and must remain private.
No credential-returning RPC, prompt, localStorage handler or menu remains.

**No Spotify Origin is assumed or claimed live-verified here.** A newly provisioned
configuration has an empty Origin list. During this one-time bootstrap only,
loopback/Host-validated clients with a syntactically exact HTTPS Origin, literal
`null`, or no Origin may enter the handshake. They cannot send commands or state.
Only after a valid extension-role HMAC proof does the receiver atomically persist
that connection's exact observed Origin, **before enabling application messages**.
Failed proofs cannot pin an Origin. This is authenticated enrollment, not
unauthenticated trust-on-first-use or a wildcard application allowlist.

After enrollment, extension upgrades with any different Origin are rejected
before the handshake. Missing Origin and literal `null` are distinct and are
rejected unless that exact form was cryptographically observed. If either is
observed, opaque/sandboxed or nonbrowser clients can reach the handshake as well;
they still need the secret. Origin is defense-in-depth, not process identity.
An Origin change requires explicit repair/reset, not automatic allowlist widening.

## Mutual authentication

1. Client sends `{type:"hello",protocol:2,handshake:"auto-1",role,nonce:clientNonce}`.
   Both parties generate independent 32-byte nonces using secure OS/Web Crypto RNG.
2. Server returns `{type:"challenge",protocol:2,handshake:"auto-1",nonce:serverNonce,serverProof}`.
3. Proof is hex HMAC-SHA256 with the secret's **UTF-8 hex string** as key over
   `auto-1:server:${role}:${clientNonce}:${serverNonce}`.
4. Client verifies through Web Crypto (Node peers use `timingSafeEqual`), then sends
   `{type:"auth",protocol:2,proof}` over the same transcript with `client` replacing
   `server`. The receiver verifies using `timingSafeEqual`.
5. Receiver sends `{type:"authenticated",protocol:2}`; application messages start.

Each handshake is single-use, role-separated and has a five-second deadline.
Fresh client nonces also prevent replaying an old receiver proof to the extension.
Old protocol-2 manual-auth extensions are intentionally incompatible with auto-1.
No secret appears in URLs, normal messages, logs or error strings. This is
not protection against a compromised OS, Spotify renderer, trusted extension,
authorized OpenCode client, or active local relay with access to both endpoints.
OpenCode RPC uses OpenCode's existing authentication; there is no separate HTTP
Spotify control endpoint.

## Shared port ownership and lifecycle

On `EADDRINUSE`, the new OpenCode process connects with an internal observer role
and the `X-OpenCode-Spotify: auto-1` header, no Origin. This exception only permits
a handshake; role-bound mutual HMAC authentication is still mandatory. Browser
WebSocket callers cannot set that header. A forged header without the key grants
no access. Observers mirror validated owner snapshots and forward only allowlisted
RPCs, with lyrics/queue documents sent only when their revisions change.
Wrong-key, incompatible and unrelated listeners produce `Local port unavailable`;
no process is ever killed. There is one Spotify extension connection per owner
and at most eight observer processes. Same-process references share one receiver.

The owner sends WebSocket ping every 15 seconds and terminates missed-pong peers
on the next tick. Observers also enforce 45 seconds without traffic/ping.
After owner loss, observers back off with jitter and contend for the fixed port;
losers authenticate to the winner. Extension retries use exponential backoff
(nominal 1..60 seconds with ±20% jitter; maximum 72 seconds).
Successful authentication resets backoff; proof mismatch starts at the long delay
and emits only a generic repair diagnostic. Disposal clears timers/listeners,
closes sockets and rejects pending requests. Mutations are never replayed.

## Limits and untrusted data

- At most 12 accepted sockets, 30 upgrade attempts/minute, 60 messages/second/socket.
- 16 KiB handshake/client-command messages; 4 MiB server-bound frames;
  compression disabled; binary/malformed/over-depth JSON is closed.
- Receiver JSON depth ≤24, ≤100,000 values. RPC parameters allow only known scalar
  keys, bounded strings, finite numbers, valid Spotify URIs and integer pagination.
- At most 32 pending requests and 120 requests/minute per receiver. Owner limits
  aggregate observer requests too. Each observer/extension admits at most 16
  concurrent API operations, with a bounded recent-ID duplicate cache.
- Default request timeout eight seconds; seek 0..86,400,000 ms; volume 0..1;
  query ≤200 characters; pages ≤200 tracks. Extension queue output is capped at
  500 entries per section; receiver normalization caps at 5,000.
- Root lists ≤5,000 nodes/depth 10; lyric lists ≤5,000 lines/4,096 characters
  each; optional word arrays ≤500 words/line with finite ordered millisecond
  spans, subject also to total frame/value limits.
- Displayed metadata/control characters are bounded/stripped. OpenTUI receives
  text nodes, not HTML, JavaScript or evaluated markup. Artwork is metadata only;
  **no artwork URLs are fetched or opened**. Do not add fetching without a separate
  HTTPS/host/redirect/SSRF policy.
- No shell, evaluation, filesystem or arbitrary-network RPC exists. Spotify API
  destinations are hardcoded and track identifiers/URIs are validated.

## Requests

`{type:"request",id,command,params}` → `{type:"response",id,ok,result}` or
`{type:"response",id,ok:false,error:{code,message}}`.

- Reads: `get_capabilities`, `get_playback`, `get_queue`, `get_playlists`,
  `get_playlist_tracks {uri,offset,limit}`, `get_library {offset,limit}`,
  `search {query,offset,limit}`, `ping`.
- Lyrics: `refresh_lyrics {}` (no parameters; current track only). It schedules a
  fresh provider request and responds `{accepted:true}`; the resulting
  `lyrics`/`lyrics_unavailable` event arrives separately and stale generations
  are suppressed. The command is absent from older extensions' capability lists.
- Playback: `play`, `pause`, `toggle_play`, `next`, `previous`,
  `seek {positionMs}`, `set_shuffle {value:boolean}`,
  `set_repeat {value:0|1|2}`, `set_volume {value:0..1}`, `set_mute {value:boolean}`.
- Track actions: `play_track {uri}`, `play_context {uri}`,
  `add_to_queue {uri}`, `remove_from_queue {uri,uid}`,
  `set_liked {uri,value:boolean}` (current URI only).
- Pagination: offset 0..1,000,000; limit 1..200; query 1..200 characters.
- Queue removal preserves numeric/string UID identity and requires a unique
  match in the extension's latest explicit queue.

Commands are allowlisted and capability-gated. The receiver times out requests
after eight seconds and rejects pending requests on disconnect. A timeout does
not prove the operation failed; **no mutation is automatically retried**.
Successful responses mean the Spicetify API call returned/accepted the operation,
not that Spotify's audio output was independently observed.

## Events and state

- `capabilities`: protocol, api flags, command list, search mode.
- `track`: URI, title, artist, album, image reference.
- `track_cleared`: clears track, timeline and lyrics.
- `playback`: trackUri, isPlaying, positionMs, durationMs, shuffle, repeat,
  volume, muted, liked, updatedAt. Missing/unavailable getters yield null.
- `lyrics`: URI, sync_type, provider (`spotify`), optional language, and lines
  `{startTimeMs,text}`. Validated word arrays are accepted when a provider
  supplies genuine ordered spans, but the maintained Spotify endpoint currently
  returns line text/timing only. Stored in memory only; stale URI/request payloads
  are ignored and a valid document survives temporary transport loss.
- `lyrics_unavailable`: URI and reason. It does not affect playback or other
  features.
- `queue_update`: current, queued, next_up, counts.

The reference browsing/search implementations and request IDs are retained.
Playback snapshots arrive on song/play/pause changes, after player commands,
on progress events at most once per two seconds, and on changed local snapshots
at five-second intervals. The TUI interpolates with its monotonic clock at 4 Hz
for line/static lyrics and 10 Hz only when genuine word timings exist, with a
ten-second extrapolation ceiling.

RPC state includes an owner epoch, monotonically increasing revision, and queue/
lyrics revision counters. The `updated` event represents connection, metadata,
playback, capability and revision changes without carrying lyric documents,
queue contents or playlists on every progress update. Lyrics are hydrated through
`getLyrics`; queue and browsing use validated request/reply RPCs.

## OpenCode RPC additions

These methods travel over OpenCode's authenticated RPC, not the bridge WebSocket:

- `getLyrics` returns the validated current lyric document, or an empty/loading
  document when none is available.
- `getLyricsSources {uri, lrclib, contact, refresh}` takes a track URI, the
  opt-in flag, the client contact string and a refresh flag. It rejects a URI
  that is not the current track and returns at most eight candidates plus provider
  availability (`spotify`/`lrclib`; `ready`/`unavailable`/`disabled`/`error`).
  Output candidates are revalidated; detail strings are bounded to 300 characters.
  The contact must be an HTTPS URL or email and is rejected if malformed. This RPC
  never returns credentials or environment data.
- The server may contact LRCLIB only when `lrclib` is true and contact is valid.
  It sends exact title/artist/album/rounded duration and identifies the client in
  the User-Agent. Redirects are disabled; timeout is six seconds; responses are
  capped at 512 KiB and must be JSON. Title/artist must match after Unicode
  normalization and duration must agree within two seconds. Synced LRC (≤256 KiB
  source, ≤5,000 lines) and plain text become separate candidates. Requests are
  sequential with a 500 ms minimum gap, one in-flight lookup, a 12-entry cache and
  `Retry-After` backoff. Provider text/lyrics remain memory-only and are not
  logged or persisted.

`getLyricsSources` is capability-independent: Spotify candidates come from the
existing bridge, while LRCLIB is a server-side opt-in. A provider failure is
reported as availability, not as a bridge disconnect or playback error.
