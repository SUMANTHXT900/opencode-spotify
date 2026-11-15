/*
 * OpenCode Spotify V0.4 maintained extension (protocol 2).
 *
 * The extension talks to the authenticated OpenCode server at ws://127.0.0.1:18765. It
 * keeps the original unsolicited track/lyrics events and adds an allowlisted
 * request/response protocol for playlists, queue, library and search.
 *
 * Only test this on your own Spotify desktop installation.
 */
(function () {
  "use strict";
  window.OpenCodeSpotifyDispose?.();

  const URL = "ws://127.0.0.1:18765";
  const PROTOCOL = 2;
  // Replaced only in the installed copy by the approved installer.
  const installationSecret = "__OPENCODE_SPOTIFY_SECRET__";
  const HANDSHAKE = "auto-1";
  let authenticated = false;
  let lastPlayback = 0;
  let disposed = false;
  let handshakeTimer = null;
  let initTimer = null;
  let retryAttempt = 0;
  let clientNonce = "";
  let challengeSeen = false;
  let requestsInFlight = 0;
  let requestTimes = [];
  let receivedMessages = 0, receivedWindow = Date.now();
  const recentRequests = new Set();
  let snapshotTimer = null;
  let lastSnapshotKey = "";
  let verifiedServer = false;
  const MAX_PAGE = 200;
  const DEFAULT_LIMIT = 50;
  const COLLECTION_URI = "spotify:collection:tracks";
  const TRACK_URI = /^spotify:(?:track|episode):[A-Za-z0-9]{22}$/;
  const PLAYLIST_URI = /^spotify:playlist:[A-Za-z0-9]{22}$/;
  const CONTEXT_URI = /^spotify:(?:playlist|album|artist|show):[A-Za-z0-9]{22}$/;

  const COMMANDS = new Set([
    "get_capabilities",
    "get_playlists",
    "get_playlist_tracks",
    "get_queue",
    "get_library",
    "search",
    "play_track",
    "play_context",
    "add_to_queue",
    "remove_from_queue",
    "ping",
    "get_playback", "play", "pause", "toggle_play", "next", "previous", "seek",
    "refresh_lyrics",
    "set_shuffle", "set_repeat", "set_volume", "set_mute", "set_liked",
  ]);

  // Search definitions are registered lazily when Spotify's search route
  // loads.  These persisted-query descriptors match the installed client and
  // are only used as a fallback when the definitions are not registered yet.
  const SEARCH_TRACKS_DEFINITION = {
    name: "searchTracks",
    operation: "query",
    sha256Hash:
      "b02683192a98dde7966b5e6655a79eeb62713eab703eda9902c932818dd52751",
    value: null,
  };
  const SEARCH_DESKTOP_DEFINITION = {
    name: "searchDesktop",
    operation: "query",
    sha256Hash:
      "eef7cc54888d91bdd6802623477873caa3948ae173a0c34fd86827b267e94c03",
    value: null,
  };

  let socket = null;
  let retryTimer = null;
  let currentUri = null;
  let currentRequest = 0;
  let queueListenerAttached = false;
  let queueCallback = null;
  let queueEvents = null;
  let queueUpdateTimer = null;
  let pendingQueueEvent = null;
  let lastQueueKey = "";

  function emit(data) {
    if (!disposed && authenticated && socket && socket.readyState === WebSocket.OPEN) {
      const raw = JSON.stringify(data);
      if (raw.length > 4 * 1024 * 1024 || socket.bufferedAmount > 4 * 1024 * 1024) { socket.close(); return; }
      socket.send(raw);
    }
  }

  function bridgeError(code, message) {
    const error = new Error(message);
    error.bridgeCode = code;
    return error;
  }

  function safeText(value, limit = 500) {
    return typeof value === "string"
      ? value.replace(/[\x00-\x1f\x7f-\x9f]/g, "").trim().slice(0, limit)
      : "";
  }

  function cleanInt(value, fallback = 0, minimum = 0, maximum = 10000000) {
    const number = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(maximum, Math.max(minimum, Math.trunc(number)));
  }

  function isTrackUri(uri) {
    return typeof uri === "string" && TRACK_URI.test(uri);
  }

  function isPlaylistUri(uri) {
    return (
      uri === COLLECTION_URI ||
      (typeof uri === "string" && PLAYLIST_URI.test(uri))
    );
  }

  function isContextUri(uri) {
    return (
      uri === COLLECTION_URI ||
      (typeof uri === "string" && CONTEXT_URI.test(uri))
    );
  }

  function imageSize(image) {
    return Math.max(
      cleanInt(image?.width, 0),
      cleanInt(image?.height, 0),
      cleanInt(image?.maxWidth, 0),
      cleanInt(image?.maxHeight, 0),
      cleanInt(image?.size, 0)
    );
  }

  function normalizeImage(images) {
    const values = Array.isArray(images) ? images : images ? [images] : [];
    let best = "";
    let bestSize = -1;
    for (const image of values) {
      const url =
        typeof image === "string"
          ? image
          : image?.url || image?.source || image?.uri || "";
      if (
        typeof url !== "string" ||
        !url ||
        url.length > 2000 ||
        !/^(https?:\/\/|spotify:image:)/.test(url)
      ) {
        continue;
      }
      const size = typeof image === "string" ? 0 : imageSize(image);
      if (size >= bestSize) {
        best = url;
        bestSize = size;
      }
    }
    return best;
  }

  function normalizeArtists(artists) {
    if (!Array.isArray(artists)) return [];
    const result = [];
    for (const artist of artists.slice(0, 50)) {
      const name =
        typeof artist === "string"
          ? safeText(artist, 200)
          : safeText(artist?.profile?.name ?? artist?.name, 200);
      if (!name) continue;
      const uri =
        typeof artist?.uri === "string" &&
        artist.uri.startsWith("spotify:artist:")
          ? artist.uri
          : "";
      result.push({ uri, name });
    }
    return result;
  }

  function normalizeTrack(item) {
    if (!item || typeof item !== "object" || !isTrackUri(item.uri)) {
      return null;
    }
    const album =
      item.album && typeof item.album === "object"
        ? item.album
        : item.albumOfTrack && typeof item.albumOfTrack === "object"
          ? item.albumOfTrack
          : {};
    const images =
      album.images || album.coverArt?.sources || item.images || [];
    const duration =
      item.duration?.milliseconds ??
      item.duration?.totalMilliseconds ??
      item.duration_ms;
    const artists = normalizeArtists(item.artists);
    const playable =
      item.isPlayable !== false &&
      item.playability?.playable !== false &&
      item.isLocal !== true;
    return {
      type: item.uri.startsWith("spotify:episode:") ? "episode" : "track",
      uri: item.uri,
      name: safeText(item.name) || "Unknown track",
      artists,
      artist:
        artists.map((artist) => artist.name).join(", ") || "Unknown artist",
      album: safeText(album.name),
      album_uri:
        typeof album.uri === "string" && album.uri.startsWith("spotify:album:")
          ? album.uri
          : "",
      image: normalizeImage(images),
      duration_ms: cleanInt(duration, 0, 0, 86400000),
      is_playable: playable,
      uid: item.uid ?? null,
      provider: safeText(item.provider, 80) || null,
    };
  }

  function normalizePlaylist(item) {
    if (!item || typeof item !== "object" || !isPlaylistUri(item.uri)) {
      return null;
    }
    const owner =
      typeof item.owner === "string"
        ? item.owner
        : safeText(item.owner?.displayName ?? item.owner?.name, 200);
    return {
      type: "playlist",
      uri: item.uri,
      name:
        safeText(item.name, 300) ||
        (item.uri === COLLECTION_URI ? "Liked Songs" : "Untitled playlist"),
      owner: owner || "",
      image: normalizeImage(item.images || item.image),
      total_tracks: cleanInt(
        item.totalLength ?? item.trackCount ?? item.total_tracks,
        0
      ),
      can_play: item.canPlay !== false,
      is_owned: item.isOwnedBySelf === true,
    };
  }

  function normalizeRootlist(value, depth = 0, budget = { count: 0 }) {
    const items = Array.isArray(value)
      ? value
      : Array.isArray(value?.items)
        ? value.items
        : [];
    const result = [];
    for (const item of items) {
      if (budget.count >= 5000 || depth > 10) break;
      if (!item || typeof item !== "object") continue;
      budget.count += 1;
      const isFolder =
        item.type === "folder" ||
        (Array.isArray(item.items) && !isPlaylistUri(item.uri));
      if (isFolder) {
        const children = normalizeRootlist(item.items || [], depth + 1, budget);
        result.push({
          type: "folder",
          uri: safeText(item.uri, 300),
          name: safeText(item.name, 300) || "Folder",
          children,
          child_count: children.length,
        });
      } else {
        const playlist = normalizePlaylist(item);
        if (playlist) result.push(playlist);
      }
    }
    return result;
  }

  function normalizeQueue(value) {
    const source = value && typeof value === "object" ? value : {};
    const current = normalizeTrack(source.current);
    if (current) current.section = "current";
    const queued = (Array.isArray(source.queued) ? source.queued : [])
      .slice(0, 500)
      .map(normalizeTrack)
      .filter(Boolean);
    queued.forEach((item) => {
      item.section = "queued";
    });
    const nextUp = (
      Array.isArray(source.nextUp)
        ? source.nextUp
        : Array.isArray(source.next_up)
          ? source.next_up
          : []
    )
      .slice(0, 500)
      .map(normalizeTrack)
      .filter(Boolean);
    nextUp.forEach((item) => {
      item.section = "next_up";
    });
    return {
      current,
      queued,
      next_up: nextUp,
      counts: { queued: queued.length, next_up: nextUp.length },
    };
  }

  function normalizeSearchTrack(wrapper) {
    const data = wrapper?.item?.data ?? wrapper?.data ?? wrapper;
    if (!data || data.__typename !== "Track") return null;
    return normalizeTrack({
      uri: data.uri,
      name: data.name,
      album: {
        uri: data.albumOfTrack?.uri,
        name: data.albumOfTrack?.name,
        images: data.albumOfTrack?.coverArt?.sources || [],
      },
      artists: (data.artists?.items || []).map((artist) => ({
        uri: artist.uri,
        name: artist.profile?.name,
      })),
      duration: { milliseconds: data.duration?.totalMilliseconds },
      isPlayable: data.playability?.playable !== false,
    });
  }

  function normalizeSearchPage(tracksV2, offset, limit) {
    const rawItems = Array.isArray(tracksV2?.items) ? tracksV2.items : [];
    const items = rawItems.slice(0, limit).map(normalizeSearchTrack).filter(Boolean);
    const total = cleanInt(tracksV2?.totalCount, items.length, 0);
    return { items, offset, limit, total };
  }

  function pageParams(params, requireUri) {
    const offset = cleanInt(params?.offset, 0, 0, 1000000);
    const limit = cleanInt(params?.limit, DEFAULT_LIMIT, 1, MAX_PAGE);
    let uri = null;
    if (requireUri) {
      uri = params?.uri;
      if (!isPlaylistUri(uri)) {
        throw bridgeError("invalid_uri", "Invalid playlist URI");
      }
    }
    return { uri, offset, limit };
  }

  function getQueueRaw() {
    const queue = Spicetify.Player?.origin?._queue;
    if (typeof queue?.getQueue !== "function") {
      throw bridgeError("unsupported", "Queue API is unavailable");
    }
    return Promise.resolve(queue.getQueue());
  }

  async function getLibraryPage(offset, limit) {
    const api = Spicetify.Platform?.LibraryAPI;
    if (typeof api?.getTracks !== "function") {
      throw bridgeError("unsupported", "Library API is unavailable");
    }
    const page = await api.getTracks({ offset, limit });
    const rawItems = Array.isArray(page?.items) ? page.items : [];
    const items = rawItems.slice(0, limit).map(normalizeTrack).filter(Boolean);
    const total = cleanInt(
      page?.unfilteredTotalLength ?? page?.totalLength ?? page?.totalCount,
      items.length,
      0
    );
    return { items, offset, limit, total };
  }

  function getDefinition(name) {
    const definitions = Spicetify.GraphQL?.Definitions;
    const definition = definitions?.[name];
    return definition &&
      typeof definition === "object" &&
      typeof definition.sha256Hash === "string"
      ? definition
      : null;
  }

  async function requestSearch(definition, variables) {
    const request = Spicetify.GraphQL?.Request;
    if (typeof request !== "function") {
      throw bridgeError("unsupported", "Search is unavailable");
    }
    const response = await request(definition, variables);
    if (response?.errors?.length) {
      const message = response.errors
        .map((error) => error?.message)
        .filter(Boolean)
        .join(", ")
        .slice(0, 300);
      throw bridgeError("search_failed", message || "Search request failed");
    }
    return response;
  }

  async function searchDesktop(query) {
    return requestSearch(SEARCH_DESKTOP_DEFINITION, {
      searchTerm: query,
      offset: 0,
      limit: 50,
      numberOfTopResults: 20,
      includeAudiobooks: true,
      includeArtistHasConcertsField: false,
      includePreReleases: true,
      includeAlbumPreReleases: false,
      includeAuthors: false,
      includeEpisodeContentRatingsV2: false,
      isPrefix: null,
      sectionFilters: ["Generic"],
      clientFeatures: {},
    });
  }

  async function searchTracks(query, offset, limit) {
    const definition = getDefinition("searchTracks") || SEARCH_TRACKS_DEFINITION;
    let response;
    try {
      response = await requestSearch(definition, {
        searchTerm: query,
        offset,
        limit,
        numberOfTopResults: 20,
        includePreReleases: false,
        includeAlbumPreReleases: false,
        sectionFilters: ["Generic"],
      });
    } catch (error) {
      if (offset !== 0) throw error;
      response = await searchDesktop(query);
    }
    const tracksV2 = response?.data?.searchV2?.tracksV2;
    if (tracksV2) return normalizeSearchPage(tracksV2, offset, limit);
    if (offset !== 0) {
      throw bridgeError("search_failed", "Search returned no track data");
    }
    const fallback = await searchDesktop(query);
    return normalizeSearchPage(
      fallback?.data?.searchV2?.tracksV2,
      0,
      limit
    );
  }

  function detectCapabilities() {
    const platform = Spicetify.Platform || {};
    const apis = {
      playlists:
        typeof platform.RootlistAPI?.getContents === "function" &&
        typeof platform.PlaylistAPI?.getContents === "function",
      library: typeof platform.LibraryAPI?.getTracks === "function",
      queue: typeof Spicetify.Player?.origin?._queue?.getQueue === "function",
      queue_mutation:
        typeof Spicetify.addToQueue === "function" &&
        typeof Spicetify.removeFromQueue === "function",
      play: typeof Spicetify.Player?.playUri === "function",
      search: typeof Spicetify.GraphQL?.Request === "function",
    };
    const commands = ["get_capabilities", "ping", "refresh_lyrics"];
    if (apis.playlists) {
      commands.push("get_playlists", "get_playlist_tracks");
    }
    if (apis.library) commands.push("get_library");
    if (apis.queue) commands.push("get_queue");
    if (apis.queue_mutation) {
      commands.push("add_to_queue", "remove_from_queue");
    }
    if (apis.play) commands.push("play_track", "play_context");
    if (apis.search) commands.push("search");
    commands.push("get_playback");
    for (const [command, method] of Object.entries(PLAYER_COMMANDS)) {
      if (typeof Spicetify.Player?.[method] === "function") commands.push(command);
    }
    if (typeof platform.PlayerAPI?.seekTo === "function") commands.push("seek");
    return {
      protocol: PROTOCOL,
      apis,
      commands,
      search_mode: apis.search ? "graphql" : null,
    };
  }

  function emitCapabilities() {
    emit({ type: "capabilities", ...detectCapabilities() });
  }

  async function handleCommand(command, params) {
    if (command === "refresh_lyrics") {
      const uri = Spicetify.Player.data?.item?.uri;
      if (!isTrackUri(uri)) throw bridgeError("invalid_uri", "No current track");
      void sendLyrics(uri, ++currentRequest, true);
      return { accepted: true };
    }
    if (command === "get_playback") return playbackState();
    if (command === "seek") {
      const ms = params.positionMs;
      if (!Number.isFinite(ms) || ms < 0 || ms > 86400000) throw bridgeError("invalid_input", "Seek uses nonnegative milliseconds");
      if (typeof Spicetify.Platform?.PlayerAPI?.seekTo !== "function") throw bridgeError("unsupported", "Millisecond seeking unavailable");
      await Spicetify.Platform.PlayerAPI.seekTo(Math.min(ms, Spicetify.Player.getDuration()));
      sendPlayback(true);
      return { accepted: true };
    }
    if (PLAYER_COMMANDS[command]) {
      const method = PLAYER_COMMANDS[command];
      if (typeof Spicetify.Player?.[method] !== "function") throw bridgeError("unsupported", "Player method unavailable");
      if (["set_shuffle", "set_mute", "set_liked"].includes(command) && typeof params.value !== "boolean") throw bridgeError("invalid_input", "Expected boolean");
      if (command === "set_repeat" && ![0, 1, 2].includes(params.value)) throw bridgeError("invalid_input", "Repeat must be 0, 1 or 2");
      if (command === "set_volume" && (!Number.isFinite(params.value) || params.value < 0 || params.value > 1)) throw bridgeError("invalid_input", "Volume must be 0..1");
      if (command === "set_liked" && (typeof params.uri !== "string" || !/^spotify:track:[A-Za-z0-9]{22}$/.test(params.uri) || params.uri !== Spicetify.Player.data?.item?.uri)) throw bridgeError("stale_track", "Only the current track can be liked");
      await Promise.resolve(Spicetify.Player[method](params.value));
      sendPlayback(true);
      return { accepted: true };
    }
    switch (command) {
      case "get_capabilities":
        return detectCapabilities();
      case "ping":
        return { pong: true, protocol: PROTOCOL };
      case "get_playlists": {
        const api = Spicetify.Platform?.RootlistAPI;
        if (typeof api?.getContents !== "function") {
          throw bridgeError("unsupported", "Rootlist API is unavailable");
        }
        const contents = await api.getContents();
        const items = normalizeRootlist(contents);
        return { items, count: countNodes(items) };
      }
      case "get_playlist_tracks": {
        const { uri, offset, limit } = pageParams(params, true);
        if (uri === COLLECTION_URI) {
          return getLibraryPage(offset, limit);
        }
        const api = Spicetify.Platform?.PlaylistAPI;
        if (typeof api?.getContents !== "function") {
          throw bridgeError("unsupported", "Playlist API is unavailable");
        }
        const page = await api.getContents(uri, { offset, limit });
        const rawItems = Array.isArray(page?.items) ? page.items : [];
        const items = rawItems.slice(0, limit).map(normalizeTrack).filter(Boolean);
        const total = cleanInt(page?.totalLength, items.length, 0);
        return { items, offset, limit, total };
      }
      case "get_library": {
        const { offset, limit } = pageParams(params, false);
        return getLibraryPage(offset, limit);
      }
      case "get_queue":
        return normalizeQueue(await getQueueRaw());
      case "search": {
        const query = safeText(params?.query, 200);
        if (!query) {
          throw bridgeError("invalid_query", "Search query is required");
        }
        const { offset, limit } = pageParams(params, false);
        return searchTracks(query, offset, limit);
      }
      case "play_track": {
        if (!isTrackUri(params?.uri)) {
          throw bridgeError("invalid_uri", "Invalid track URI");
        }
        if (typeof Spicetify.Player?.playUri !== "function") {
          throw bridgeError("unsupported", "Playback API is unavailable");
        }
        await Promise.resolve(Spicetify.Player.playUri(params.uri));
        return { accepted: true, uri: params.uri };
      }
      case "play_context": {
        if (!isContextUri(params?.uri)) {
          throw bridgeError("invalid_uri", "Invalid context URI");
        }
        if (typeof Spicetify.Player?.playUri !== "function") {
          throw bridgeError("unsupported", "Playback API is unavailable");
        }
        await Promise.resolve(Spicetify.Player.playUri(params.uri));
        return { accepted: true, uri: params.uri };
      }
      case "add_to_queue": {
        if (!isTrackUri(params?.uri)) {
          throw bridgeError("invalid_uri", "Invalid track URI");
        }
        if (typeof Spicetify.addToQueue !== "function") {
          throw bridgeError("unsupported", "Queue mutation API is unavailable");
        }
        await Promise.resolve(
          Spicetify.addToQueue([{ uri: params.uri, uid: null }])
        );
        await sendQueueSnapshot();
        return { accepted: true, uri: params.uri };
      }
      case "remove_from_queue": {
        if (!isTrackUri(params?.uri)) {
          throw bridgeError("invalid_uri", "Invalid track URI");
        }
        const uid = params?.uid;
        if (
          !(
            (typeof uid === "string" && uid.length > 0 && uid.length <= 128) ||
            (typeof uid === "number" && Number.isSafeInteger(uid) && uid >= 0)
          )
        ) {
          throw bridgeError("invalid_uid", "A queue item uid is required");
        }
        if (typeof Spicetify.removeFromQueue !== "function") {
          throw bridgeError("unsupported", "Queue mutation API is unavailable");
        }
        const currentQueue = normalizeQueue(await getQueueRaw());
        if (currentQueue.queued.filter((item) => item.uri === params.uri && item.uid === uid).length !== 1) {
          throw bridgeError("unsafe_removal", "Queue occurrence is missing or ambiguous; refresh the queue");
        }
        await Promise.resolve(
          Spicetify.removeFromQueue([{ uri: params.uri, uid }])
        );
        await sendQueueSnapshot();
        return { accepted: true, uri: params.uri, uid };
      }
      default:
        throw bridgeError("unsupported_command", "Unsupported command");
    }
  }

  function countNodes(items) {
    let count = 0;
    for (const item of items) {
      count += 1;
      if (Array.isArray(item.children)) {
        count += countNodes(item.children);
      }
    }
    return count;
  }

  function sendResponse(id, ok, result, error) {
    const message = { type: "response", id, ok };
    if (ok) {
      message.result = result ?? {};
    } else {
      message.error = error ?? {
        code: "error",
        message: "The command failed",
      };
    }
    emit(message);
  }

  async function onMessage(event) {
    const requestSocket = socket;
    if (!authenticated) return;
    if (typeof event.data !== "string" || event.data.length > 16384) return;
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!message || message.type !== "request") return;
    const id = message.id;
    if (typeof id !== "string" || !id || id.length > 64) return;
    const command = message.command;
    if (!COMMANDS.has(command)) {
      sendResponse(id, false, undefined, {
        code: "unsupported_command",
        message: "Unsupported command",
      });
      return;
    }
    const params =
      message.params &&
      typeof message.params === "object" &&
      !Array.isArray(message.params)
        ? message.params
         : {};
    const keys = {
      seek: ["positionMs"], set_shuffle: ["value"], set_repeat: ["value"], set_volume: ["value"],
      set_mute: ["value"], set_liked: ["uri", "value"], play_track: ["uri"], play_context: ["uri"],
      add_to_queue: ["uri"], remove_from_queue: ["uri", "uid"], get_playlist_tracks: ["uri", "offset", "limit"],
      get_library: ["offset", "limit"], search: ["query", "offset", "limit"],
    };
    try {
      if (!message.params || typeof message.params !== "object" || Array.isArray(message.params) ||
          Object.keys(params).some((key) => !(keys[command] || []).includes(key))) throw bridgeError("invalid_input", "Invalid parameters");
      if (["search", "get_library", "get_playlist_tracks"].includes(command)) {
        if (params.offset !== undefined && (!Number.isInteger(params.offset) || params.offset < 0 || params.offset > 1000000) ||
            params.limit !== undefined && (!Number.isInteger(params.limit) || params.limit < 1 || params.limit > 200)) throw bridgeError("invalid_input", "Invalid page");
      }
      if (command === "search" && (typeof params.query !== "string" || !params.query.trim() || params.query.length > 200)) throw bridgeError("invalid_input", "Invalid search query");
      requestTimes = requestTimes.filter((time) => Date.now() - time < 60000);
      if (requestsInFlight >= 16 || requestTimes.length >= 120 || recentRequests.has(id)) throw bridgeError("rate_limited", "Too many or duplicate requests");
      requestTimes.push(Date.now());
      recentRequests.add(id);
      if (recentRequests.size > 120) recentRequests.delete(recentRequests.values().next().value);
      requestsInFlight++;
      try {
      const result = await handleCommand(command, params);
      if (requestSocket === socket && authenticated) sendResponse(id, true, result);
      } finally { requestsInFlight--; }
    } catch (error) {
      const code =
        error && typeof error.bridgeCode === "string"
          ? error.bridgeCode
          : "command_failed";
      const text =
        error && typeof error.message === "string" && error.message
          ? error.message.slice(0, 300)
          : "The command failed";
      if (requestSocket === socket && authenticated) sendResponse(id, false, undefined, { code, message: code === "command_failed" ? "Spotify API failed; refresh or check compatibility" : text });
    }
  }

  function attachQueueListener() {
    if (queueListenerAttached) return;
    const events = Spicetify.Platform?.PlayerAPI?._events;
    if (typeof events?.addListener !== "function") return;
    try {
      queueCallback = (event) => {
        pendingQueueEvent = event;
        if (queueUpdateTimer) return;
        queueUpdateTimer = setTimeout(() => {
          queueUpdateTimer = null;
          const value = pendingQueueEvent;
          pendingQueueEvent = null;
          const queue = normalizeQueue(value?.data ?? value);
          const key = JSON.stringify(queue);
          if (key === lastQueueKey) return;
          lastQueueKey = key;
          emit({ type: "queue_update", queue });
        }, 250);
      };
      events.addListener("queue_update", queueCallback);
      queueEvents = events;
      queueListenerAttached = true;
    } catch (error) {
      // Optional API; explicit refresh remains available.
    }
  }

  async function sendQueueSnapshot() {
    try {
      const queue = normalizeQueue(await getQueueRaw());
      lastQueueKey = JSON.stringify(queue);
      emit({ type: "queue_update", queue });
    } catch (error) {
      // Queue support is optional; capabilities tell the UI whether to show it.
    }
  }

  function getTrack() {
    const item = Spicetify.Player.data?.item;
    if (!item || !item.uri) return null;
    const meta = item.metadata || {};
    const artists = normalizeArtists(item.artists);
    return {
      type: "track",
      uri: item.uri,
      title: meta.title || "",
      artist: artists.length ? artists.map((artist) => artist.name).join(", ") : meta.artist_name || "",
      album: meta.album_title || "",
      image: normalizeImage(meta.image_url || meta.image_xlarge_url || item.images || []),
    };
  }

  const lyricCache = new Map();
  const lyricTimers = new Set();
  async function sendLyrics(uri, requestId, refresh = false) {
    // The Spotify internal provider only accepts track URIs.
    if (!/^spotify:track:[A-Za-z0-9]{22}$/.test(uri)) {
      emit({ type: "lyrics_unavailable", uri, reason: "Not a Spotify track" });
      return;
    }

    const id = uri.split(":")[2];
    const cached = lyricCache.get(uri);
    if (!refresh && cached?.expires > Date.now()) { emit(cached.message); return; }
    let timeout;
    const remember = (message) => {
      if (disposed || requestId !== currentRequest) return;
      if (lyricCache.size >= 12) lyricCache.delete(lyricCache.keys().next().value);
      lyricCache.set(uri, { message, expires: Date.now() + (message.type === "lyrics" ? 900000 : 60000) });
      emit(message);
    };
    try {
      const url = `https://spclient.wg.spotify.com/color-lyrics/v2/track/${id}?format=json&vocalRemoval=false&market=from_token`;
      const response = await Promise.race([
        Spicetify.CosmosAsync.get(url),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("Lyrics timeout")), 6000); lyricTimers.add(timeout); }),
      ]);
      // Ignore stale results when the user skips tracks.
      if (requestId !== currentRequest) return;
      if (!response?.lyrics?.lines?.length) {
        remember({ type: "lyrics_unavailable", uri, reason: "No lyrics returned" });
        return;
      }
      remember({
        type: "lyrics",
        uri,
        sync_type: response.lyrics.syncType || "UNKNOWN",
        provider: "spotify",
        language: typeof response.lyrics.language === "string" ? safeText(response.lyrics.language, 20) : null,
        // Kept in-memory; receiver deliberately doesn't print or store lyrics.
        lines: response.lyrics.lines.slice(0, 5000).map((line) => ({
          startTimeMs: line.startTimeMs ?? null,
          text: safeText(line.words, 4096),
        })),
      });
    } catch (error) {
      if (requestId === currentRequest) {
        remember({ type: "lyrics_unavailable", uri, reason: "Provider request failed" });
      }
    } finally {
      clearTimeout(timeout);
      lyricTimers.delete(timeout);
    }
  }

  function updateSong(force = false) {
    if (!authenticated) return;
    const track = getTrack();
    if (!track || !isTrackUri(track.uri)) {
      currentUri = null;
      ++currentRequest;
      emit({ type: "track_cleared" });
      sendPlayback(true);
      return;
    }
    if (!force && track.uri === currentUri) return;
    currentUri = track.uri;
    const requestId = ++currentRequest;
    emit(track);
    sendPlayback(true);
    void sendLyrics(track.uri, requestId);
  }

  function connect() {
    if (disposed) return;
    if (!/^[a-f0-9]{64}$/.test(installationSecret)) {
      console.warn("OpenCode Spotify: connection configuration error. Run Spotify extension repair.");
      return;
    }
    authenticated = false;
    verifiedServer = false;
    challengeSeen = false;
    clientNonce = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
    try {
      socket = new WebSocket(URL);
      const connection = socket;
      socket.onopen = () => {
        authenticated = false;
        verifiedServer = false;
        connection.send(JSON.stringify({ type: "hello", protocol: PROTOCOL, handshake: HANDSHAKE, role: "extension", nonce: clientNonce }));
      };
      handshakeTimer = setTimeout(() => connection.close(1008, "Authentication timeout"), 5000);
      socket.onmessage = (event) => {
        if (socket !== connection) return;
        void receiveServer(event, connection).catch(() => connection.close());
      };
      socket.onclose = () => {
        if (socket !== connection) return;
        socket = null;
        authenticated = false;
        ++currentRequest;
        clearTimeout(handshakeTimer);
        clearInterval(snapshotTimer);
        if (retryTimer) clearTimeout(retryTimer);
        if (!disposed) retryTimer = setTimeout(connect, retryDelay());
      };
      socket.onerror = () => {
        // onclose handles reconnection.
      };
    } catch (error) {
      retryTimer = setTimeout(connect, retryDelay());
    }
  }
  function retryDelay() {
    return Math.min(60000, 1000 * 2 ** Math.min(retryAttempt++, 6)) * (0.8 + Math.random() * 0.4);
  }

  function init() {
    if (disposed) return;
    if (!window.Spicetify?.Player || !window.Spicetify?.CosmosAsync) {
      initTimer = setTimeout(init, 300);
      return;
    }
    Spicetify.Player.addEventListener("songchange", songChanged);
    Spicetify.Player.addEventListener("onplaypause", playbackChanged);
    Spicetify.Player.addEventListener("onprogress", progressChanged);
    connect();
  }

  const PLAYER_COMMANDS = {
    play: "play", pause: "pause", toggle_play: "togglePlay", next: "next", previous: "back",
    set_shuffle: "setShuffle", set_repeat: "setRepeat", set_volume: "setVolume",
    set_mute: "setMute", set_liked: "setHeart",
  };
  function read(method, fallback = null) {
    try { return typeof Spicetify.Player?.[method] === "function" ? Spicetify.Player[method]() : fallback; }
    catch { return fallback; }
  }
  function playbackState() {
    const boolean = (method) => { const v = read(method); return typeof v === "boolean" ? v : null; };
    const numeric = (method, fallback) => { const v = read(method); return Number.isFinite(v) ? v : fallback; };
    const repeat = read("getRepeat");
    const volume = read("getVolume");
    const uri = Spicetify.Player.data?.item?.uri;
    return {
      trackUri: isTrackUri(uri) ? uri : null,
      isPlaying: boolean("isPlaying"), positionMs: Math.max(0, numeric("getProgress", 0)),
      durationMs: Math.max(0, numeric("getDuration", 0)), shuffle: boolean("getShuffle"),
      repeat: [0, 1, 2].includes(repeat) ? repeat : null,
      volume: Number.isFinite(volume) && volume >= 0 && volume <= 1 ? volume : null,
      muted: boolean("getMute"), liked: boolean("getHeart"), updatedAt: Date.now(),
    };
  }
  function sendPlayback(force = false) {
    if (!authenticated) return;
    if (!force && performance.now() - lastPlayback < 2000) return;
    lastPlayback = performance.now();
    emit({ type: "playback", playback: playbackState() });
  }
  function songChanged() { updateSong(true); }
  function playbackChanged() { sendPlayback(true); }
  function progressChanged() { sendPlayback(); }
  async function receiveServer(event, connection) {
    if (disposed || socket !== connection || connection.readyState !== WebSocket.OPEN) return;
    let message;
    if (Date.now() - receivedWindow > 1000) { receivedWindow = Date.now(); receivedMessages = 0; }
    if (++receivedMessages > 60) { connection.close(1008, "Rate limited"); return; }
    if (typeof event.data !== "string" || event.data.length > 16384) { connection.close(1008, "Invalid message"); return; }
    try { message = JSON.parse(event.data); } catch { connection.close(1008, "Invalid message"); return; }
    let values = 0;
    function check(value, depth) {
      if (++values > 2000 || depth > 8) throw new Error("Invalid message");
      if (value && typeof value === "object") for (const child of Object.values(value)) check(child, depth + 1);
    }
    check(message, 0);
    if (message?.type === "challenge") {
      if (challengeSeen || authenticated || message.protocol !== PROTOCOL || message.handshake !== HANDSHAKE || !/^[a-f0-9]{64}$/.test(message.nonce)) { connection.close(1008, "Extension incompatible"); return; }
      challengeSeen = true;
      if (typeof message.serverProof !== "string" || !/^[a-f0-9]{64}$/.test(message.serverProof)) { connection.close(); return; }
      const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(installationSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
      const proofBytes = new Uint8Array(message.serverProof.match(/../g).map((b) => parseInt(b, 16)));
      const transcript = `extension:${clientNonce}:${message.nonce}`;
      if (!await crypto.subtle.verify("HMAC", key, proofBytes, new TextEncoder().encode(`${HANDSHAKE}:server:${transcript}`))) {
        console.warn("OpenCode Spotify: connection configuration error. Run Spotify extension repair.");
        retryAttempt = 6;
        connection.close(1008, "Authentication failed"); return;
      }
      if (socket !== connection || connection.readyState !== WebSocket.OPEN) return;
      verifiedServer = true;
      const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${HANDSHAKE}:client:${transcript}`));
      const proof = Array.from(new Uint8Array(signature), (b) => b.toString(16).padStart(2, "0")).join("");
      if (socket === connection && connection.readyState === WebSocket.OPEN) connection.send(JSON.stringify({ type: "auth", protocol: PROTOCOL, proof }));
      return;
    }
    if (message?.type === "authenticated") {
      if (!verifiedServer || authenticated || message.protocol !== PROTOCOL) return;
      authenticated = true;
      retryAttempt = 0;
      clearTimeout(handshakeTimer);
      attachQueueListener();
      emitCapabilities();
      void sendQueueSnapshot();
      updateSong(true);
      sendPlayback(true);
      clearInterval(snapshotTimer);
      // Bounded local snapshots catch external shuffle/volume changes while
      // paused. There are no Spotify HTTP polls and no terminal redraw loop.
      snapshotTimer = setInterval(() => {
        const p = playbackState();
        const key = JSON.stringify({ ...p, updatedAt: 0 });
        if (key !== lastSnapshotKey) { lastSnapshotKey = key; sendPlayback(true); }
      }, 5000);
      return;
    }
    await onMessage(event);
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    clearTimeout(retryTimer);
    clearTimeout(initTimer);
    clearTimeout(handshakeTimer);
    clearTimeout(queueUpdateTimer);
    clearInterval(snapshotTimer);
    for (const timer of lyricTimers) clearTimeout(timer);
    lyricTimers.clear();
    lyricCache.clear();
    Spicetify.Player.removeEventListener("songchange", songChanged);
    Spicetify.Player.removeEventListener("onplaypause", playbackChanged);
    Spicetify.Player.removeEventListener("onprogress", progressChanged);
    if (queueCallback && typeof queueEvents?.removeListener === "function") queueEvents.removeListener("queue_update", queueCallback);
    socket?.close();
    window.removeEventListener?.("beforeunload", dispose);
  }
  window.OpenCodeSpotifyDispose = dispose;
  window.addEventListener("beforeunload", dispose);
  init();
})();
