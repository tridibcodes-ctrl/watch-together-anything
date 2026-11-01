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
  };
}

function createTmdbHandler({ authenticateUser = authenticate, fetchImpl = fetch, getToken = () => process.env.TMDB_READ_ACCESS_TOKEN } = {}) {
  // Only public metadata is cached. Authentication still runs on every request.
  const cache = new Map();

  return async function handleTmdb(request, response, sendJson) {
    const url = new URL(request.url, "http://localhost:3000");
    if (!["/api/catalog", "/api/search"].includes(url.pathname)) return false;
    if (request.method !== "GET") {
      response.setHeader("Allow", "GET");
      sendJson(response, 405, { error: "Use GET for catalog and search" });
      return true;
    }

    const mediaType = url.searchParams.get("type");
    const pageText = url.searchParams.get("page") ?? "1";
    const page = Number(pageText);
    const isSearch = url.pathname === "/api/search";
    const query = (url.searchParams.get("q") || "").trim();
    if (!["movie", "tv"].includes(mediaType)) {
      sendJson(response, 400, { error: "Type must be movie or tv" });
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

    const upstreamUrl = new URL(isSearch ? `search/${mediaType}` : `${mediaType}/popular`, TMDB_BASE);
    upstreamUrl.searchParams.set("language", "en-US");
    upstreamUrl.searchParams.set("page", String(page));
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
        console.error("TMDB request failed with HTTP", result.status);
        sendJson(response, 502, { error: "Could not load titles from TMDB. Check the server token if this persists." });
        return true;
      }
      const payload = await result.json();
      if (!Array.isArray(payload.results) || !Number.isInteger(payload.total_pages) || payload.total_pages < 0) {
        throw new Error("Invalid TMDB response");
      }
      const body = {
        items: payload.results.map(item => normalizeTitle(item, mediaType)),
        page,
        hasMore: page < Math.min(payload.total_pages, MAX_PAGE),
      };
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
