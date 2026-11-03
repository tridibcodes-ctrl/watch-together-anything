const TMDB_BASE = "https://api.themoviedb.org/3/";
const MAX_PAGE = 500;
const CACHE_TTL_MS = 60000;
const CACHE_LIMIT = 100;

async function authenticate(request) {
  const { verifyAuth } = await import("@supabase/server/core");
  const headers = new Headers();
  if (request.headers.authorization) headers.set("authorization", request.headers.authorization);
  if (request.headers.apikey) headers.set("apikey", request.headers.apikey);
  return verifyAuth(new Request(new URL(request.url, "http://localhost:3000"), { headers }), { auth: "user" });
}

// Movie and TV fields differ upstream; keep a single shape for our frontend.
function normalizeTitle(item, mediaType) {
  const date = mediaType === "movie" ? item.release_date : item.first_air_date;
  return {
    tmdbId: item.id,
    mediaType,
    title: (mediaType === "movie" ? item.title : item.name) || "Untitled",
    year: typeof date === "string" ? date.slice(0, 4) : "",
    overview: item.overview || "",
    posterPath: item.poster_path || null,
    backdropPath: item.backdrop_path || null,
    genreIds: item.genre_ids || (item.genres || []).map(genre => genre.id),
  };
}

function normalizeDetails(item, mediaType) {
  if (!Number.isSafeInteger(item.id) || !Array.isArray(item.genres)) throw new Error("Invalid title details");
  return {
    ...normalizeTitle(item, mediaType),
    genres: item.genres.map(genre => genre.name),
    runtimeMinutes: mediaType === "movie" ? item.runtime || null : null,
    status: item.status || "",
    seasons: mediaType === "tv" ? (item.seasons || []).map(season => ({
      seasonNumber: season.season_number, name: season.name,
      episodeCount: season.episode_count, airDate: season.air_date || null,
    })) : [],
  };
}

function createTmdbHandler({ authenticateUser = authenticate, fetchImpl = fetch, getToken = () => process.env.TMDB_READ_ACCESS_TOKEN } = {}) {
  // Only public metadata is cached. Authentication still runs on every request.
  const cache = new Map();

  return async function handleTmdb(request, response, sendJson) {
    const url = new URL(request.url, "http://localhost:3000");
    const details = /^\/api\/titles\/([^/]+)\/([^/]+)(?:\/seasons\/([^/]+))?$/.exec(url.pathname);
    const isGenres = url.pathname === "/api/genres";
    if (!details && !["/api/catalog", "/api/search", "/api/genres"].includes(url.pathname)) return false;
    if (request.method !== "GET") {
      response.setHeader("Allow", "GET");
      sendJson(response, 405, { error: "Use GET for TMDB metadata" });
      return true;
    }

    const mediaType = details ? details[1] : url.searchParams.get("type");
    const isSeason = details?.[3] !== undefined;
    const pageText = url.searchParams.get("page") ?? "1";
    const page = Number(pageText);
    const isSearch = url.pathname === "/api/search";
    const query = (url.searchParams.get("q") || "").trim();
    const genre = url.searchParams.get("genre") || "";
    if (genre && !/^[1-9]\d{0,5}$/.test(genre)) {
      sendJson(response, 400, { error: "Genre must be a positive integer" });
      return true;
    }
    if (!["movie", "tv"].includes(mediaType)) {
      sendJson(response, 400, { error: "Type must be movie or tv" });
      return true;
    }
    if (details && (!/^[1-9]\d*$/.test(details[2]) || !Number.isSafeInteger(Number(details[2])) || Number(details[2]) > 2147483647)) {
      sendJson(response, 400, { error: "TMDB ID must be a positive 32-bit integer" });
      return true;
    }
    if (isSeason && (mediaType !== "tv" || !/^(0|[1-9]\d{0,3})$/.test(details[3]))) {
      sendJson(response, 400, { error: "Season requires a TV title and a number between 0 and 9999" });
      return true;
    }
    if (!/^[1-9]\d{0,2}$/.test(pageText) || page > MAX_PAGE) {
      sendJson(response, 400, { error: "Page must be an integer between 1 and 500" });
      return true;
    }
    if (isSearch && (!query || query.length > 200)) {
      sendJson(response, 400, { error: "Search query must be between 1 and 200 characters" });
      return true;
    }

    try {
      const { data, error } = await authenticateUser(request);
      if (error || !data?.userClaims?.id) {
        sendJson(response, 401, { error: "Sign-in required or token invalid" });
        return true;
      }
    } catch {
      sendJson(response, 500, { error: "Authentication check failed" });
      return true;
    }

    const token = getToken()?.trim();
    if (!token) {
      sendJson(response, 503, { error: "TMDB is not configured. Set TMDB_READ_ACCESS_TOKEN on the server and restart Node." });
      return true;
    }

    const upstreamPath = details ? `${mediaType}/${details[2]}${isSeason ? '/season/' + details[3] : ''}` : isGenres ? `genre/${mediaType}/list` : isSearch ? `search/${mediaType}` : genre ? `discover/${mediaType}` : `${mediaType}/popular`;
    const upstreamUrl = new URL(upstreamPath, TMDB_BASE);
    upstreamUrl.searchParams.set("language", "en-US");
    if (!details && !isGenres) upstreamUrl.searchParams.set("page", String(page));
    if (genre && !isSearch) upstreamUrl.searchParams.set("with_genres", genre);
    if (isSearch) {
      upstreamUrl.searchParams.set("query", query);
      upstreamUrl.searchParams.set("include_adult", "false");
    }
    const key = upstreamUrl.href;
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      sendJson(response, 200, cached.body);
      return true;
    }
    cache.delete(key);

    try {
      const result = await fetchImpl(upstreamUrl, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        signal: AbortSignal.timeout(10000),
      });
      if (result.status === 429) {
        const retryAfter = result.headers.get("retry-after");
        if (retryAfter && /^\d+$/.test(retryAfter)) response.setHeader("Retry-After", retryAfter);
        sendJson(response, 429, { error: "TMDB request limit reached. Please try again shortly." });
        return true;
      }
      if (!result.ok) {
        if (result.status === 404 && details) {
          sendJson(response, 404, { error: "Title or season not found in TMDB" });
          return true;
        }
        console.error("TMDB request failed with HTTP", result.status);
        sendJson(response, 502, { error: "Could not load titles from TMDB. Check the server token if this persists." });
        return true;
      }
      const payload = await result.json();
      let body;
      if (isGenres) {
        if (!Array.isArray(payload.genres)) throw new Error("Invalid genres response");
        body = { items: payload.genres.map(genre => ({ id: genre.id, name: genre.name })) };
      } else if (isSeason) {
        if (!Array.isArray(payload.episodes)) throw new Error("Invalid season details");
        body = { tmdbId: Number(details[2]), mediaType: "tv", seasonNumber: Number(details[3]), name: payload.name || "", episodes: payload.episodes.map(episode => ({
          episodeNumber: episode.episode_number, name: episode.name || "", overview: episode.overview || "",
          airDate: episode.air_date || null, runtimeMinutes: episode.runtime || null,
        })) };
      } else if (details) {
        body = { title: normalizeDetails(payload, mediaType) };
      } else {
        if (!Array.isArray(payload.results) || !Number.isInteger(payload.total_pages) || payload.total_pages < 0) {
          throw new Error("Invalid TMDB response");
        }
        body = {
          items: payload.results.filter(item => !genre || !isSearch || item.genre_ids?.includes(Number(genre))).map(item => normalizeTitle(item, mediaType)),
          page,
          hasMore: page < Math.min(payload.total_pages, MAX_PAGE),
        };
      }
      if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
      cache.set(key, { body, expiresAt: Date.now() + CACHE_TTL_MS });
      sendJson(response, 200, body);
    } catch (error) {
      const timedOut = error.name === "TimeoutError" || error.name === "AbortError";
      sendJson(response, timedOut ? 504 : 502, {
        error: timedOut ? "TMDB took too long to respond. Please try again." : "Could not load titles from TMDB. Please try again.",
      });
    }
    return true;
  };
}

module.exports = { createTmdbHandler, handleTmdb: createTmdbHandler() };
