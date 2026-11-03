const { createTmdbHandler } = require('./tmdb');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function authenticate(request) {
  const { verifyAuth } = await import('@supabase/server/core');
  const headers = new Headers();
  for (const key of ['authorization', 'apikey']) if (request.headers[key]) headers.set(key, request.headers[key]);
  return verifyAuth(new Request(new URL(request.url, 'http://localhost:3000'), { headers }), { auth: 'user' });
}
const shape = (row, progress = []) => {
  const history = progress.filter(item => item.media_type === row.media_type && item.tmdb_id === row.tmdb_id);
  const watched = history.filter(item => item.completed_at);
  return { id: row.id, status: row.media_type === 'movie' && watched.length ? 'watched' : history.length ? 'watching' : 'planned',
    watchedEpisodes: row.media_type === 'tv' ? watched.length : 0,
    title: { tmdbId: row.tmdb_id, mediaType: row.media_type, title: row.title, year: row.year, overview: row.overview, posterPath: row.poster_path } };
};
function createWatchlistHandler({ authenticateUser = authenticate, fetchImpl = fetch } = {}) {
  const metadata = createTmdbHandler({ authenticateUser, fetchImpl });
  return async function handleWatchlist(request, response, sendJson) {
    const url = new URL(request.url, 'http://localhost:3000');
    const match = /^\/api\/rooms\/([^/]+)\/list(?:\/([^/]+))?$/.exec(url.pathname);
    if (!match) return false;
    try {
      const [, roomId, itemId] = match;
      if (!UUID.test(roomId) || (itemId && !UUID.test(itemId))) { sendJson(response, 400, { error: 'Invalid room or list item ID' }); return true; }
      if (!(itemId ? request.method === 'DELETE' : ['GET', 'POST'].includes(request.method))) { sendJson(response, 405, { error: 'Use GET/POST on the list or DELETE on an item' }); return true; }
      const { data, error } = await authenticateUser(request);
      if (error || !data?.userClaims?.id) { sendJson(response, 401, { error: 'Sign-in required or token invalid' }); return true; }
      const userId = data.userClaims.id;
      const base = (process.env.SUPABASE_URL || '').replace(/\/+$/, '') + '/rest/v1';
      const headers = { apikey: process.env.SUPABASE_PUBLISHABLE_KEY, Authorization: request.headers.authorization };
      if (!process.env.SUPABASE_URL || !headers.apikey) throw new Error('Missing Supabase configuration');
      const upstream = (path, options = {}) => fetchImpl(base + path, { ...options, headers: { ...headers, ...options.headers }, signal: AbortSignal.timeout(10000) });
      const members = await upstream(`/watch_room_members?room_id=eq.${roomId}&user_id=eq.${userId}&select=user_id`);
      if (!members.ok) throw new Error('Membership lookup failed');
      if (!(await members.json()).length) { sendJson(response, 403, { error: 'You are not a member of this room' }); return true; }
      const table = '/watch_room_list_items';
      const filter = `room_id=eq.${roomId}`;
      if (request.method === 'GET') {
        const result = await upstream(`${table}?${filter}&removed_at=is.null&order=created_at.desc,id.desc`);
        if (!result.ok) throw new Error('List lookup failed');
        const history = await upstream(`/watch_room_progress?${filter}&select=media_type,tmdb_id,completed_at`);
        if (!history.ok) { sendJson(response,503,{error:'Shared progress setup required: apply backend/phase2.sql after schema.sql and playback.sql'}); return true; }
        const progress = await history.json();
        sendJson(response, 200, { items: (await result.json()).map(row => shape(row,progress)) }); return true;
      }
      const change = async (query, removedAt) => {
        const result = await upstream(`${table}?${query}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: JSON.stringify({ removed_at: removedAt }) });
        if (!result.ok) throw new Error('List update failed');
        return result.json();
      };
      if (itemId) {
        const rows = await change(`${filter}&id=eq.${itemId}`, new Date().toISOString());
        if (!rows.length) { sendJson(response, 404, { error: 'List item not found in this room' }); return true; }
        response.writeHead(204, { 'Cache-Control': 'no-store' }); response.end(); return true;
      }
      let raw = '', bytes = 0;
      for await (const chunk of request) { bytes += Buffer.byteLength(chunk); if (bytes > 4096) { sendJson(response, 413, { error: 'Request body is too large' }); return true; } raw += chunk; }
      let input;
      try { input = JSON.parse(raw); } catch { sendJson(response, 400, { error: 'Request body must be valid JSON' }); return true; }
      if (!['movie', 'tv'].includes(input?.mediaType) || !Number.isInteger(input?.tmdbId) || input.tmdbId < 1 || input.tmdbId > 2147483647) { sendJson(response, 400, { error: 'Provide movie or tv and a positive TMDB ID' }); return true; }
      const identity = `${filter}&media_type=eq.${input.mediaType}&tmdb_id=eq.${input.tmdbId}`;
      const existing = await upstream(`${table}?${identity}`);
      if (!existing.ok) throw new Error('List lookup failed');
      const rows = await existing.json();
      if (rows.length) { const row = rows[0].removed_at ? (await change(identity, null))[0] : rows[0]; sendJson(response, 200, { item: shape(row) }); return true; }
      let info;
      await metadata({ method: 'GET', url: `/api/titles/${input.mediaType}/${input.tmdbId}`, headers: request.headers }, { setHeader() {} }, (_response, status, body) => { info = { status, body }; });
      if (info.status !== 200) { sendJson(response, info.status, info.body); return true; }
      const title = info.body.title;
      const result = await upstream(`${table}?on_conflict=room_id,media_type,tmdb_id`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates,return=representation' },
        body: JSON.stringify({ room_id: roomId, media_type: input.mediaType, tmdb_id: input.tmdbId, title: title.title, year: title.year, overview: title.overview, poster_path: title.posterPath, added_by: userId }),
      });
      if (!result.ok) throw new Error('List insert failed');
      const inserted = await result.json();
      const row = inserted[0] || (await change(identity, null))[0];
      if (!row) throw new Error('Missing list item after insert');
      sendJson(response, inserted.length ? 201 : 200, { item: shape(row) });
    } catch (error) {
      console.error('Watchlist failed:', error.message);
      sendJson(response, 502, { error: 'Could not update or load the list. Check the watchlist schema is installed.' });
    }
    return true;
  };
}
module.exports = { createWatchlistHandler, handleWatchlist: createWatchlistHandler() };
