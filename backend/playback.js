const { createTmdbHandler } = require('./tmdb');
const { PROVIDERS } = require('../frontend/player');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function authenticate(request) {
  const { verifyAuth } = await import('@supabase/server/core');
  const headers = new Headers();
  for (const key of ['authorization', 'apikey']) if (request.headers[key]) headers.set(key, request.headers[key]);
  return verifyAuth(new Request(new URL(request.url, 'http://localhost:3000'), { headers }), { auth: 'user' });
}
function createPlaybackHandler({ authenticateUser = authenticate, fetchImpl = fetch } = {}) {
  const metadata = createTmdbHandler({ authenticateUser, fetchImpl });
  return async function handlePlayback(request, response, sendJson) {
    const match = /^\/api\/rooms\/([^/]+)\/(state|media|commands|readiness)$/.exec(new URL(request.url, 'http://localhost').pathname);
    if (!match) return false;
    const [, roomId, route] = match;
    const fail = (status, error) => { sendJson(response, status, { error }); return true; };
    try {
      if (!UUID.test(roomId)) return fail(400, 'Invalid room ID');
      if (request.method !== (route === 'state' ? 'GET' : 'POST')) return fail(405, route === 'state' ? 'Use GET for playback state' : 'Use POST for playback commands');
      const { data, error } = await authenticateUser(request);
      if (error || !data?.userClaims?.id) return fail(401, 'Sign-in required or token invalid');
      const base = (process.env.SUPABASE_URL || '').replace(/\/+$/, '') + '/rest/v1';
      const headers = { apikey: process.env.SUPABASE_PUBLISHABLE_KEY, Authorization: request.headers.authorization };
      if (!process.env.SUPABASE_URL || !headers.apikey) return fail(503, 'Supabase configuration is missing');
      const upstream = (path, options = {}) => fetchImpl(base + path, { ...options, headers: { ...headers, ...options.headers }, signal: AbortSignal.timeout(10000) });
      const memberResponse = await upstream(`/watch_room_members?room_id=eq.${roomId}&user_id=eq.${data.userClaims.id}&select=user_id`);
      if (!memberResponse.ok) return fail(502, 'Could not verify room membership');
      if (!(await memberResponse.json()).length) return fail(403, 'You are not a member of this room');
      const args = { p_room_id: roomId, p_action: 'get' };
      if (route !== 'state') {
        let raw = '', size = 0;
        for await (const chunk of request) {
          size += Buffer.byteLength(chunk);
          if (size > 8192) return fail(413, 'Playback request is too large');
          raw += chunk;
        }
        let input;
        try { input = JSON.parse(raw); } catch { return fail(400, 'Request must be valid JSON'); }
        if (route === 'readiness') {
          if (!input || !UUID.test(input.sessionId || '') || !UUID.test(input.clientId || '') ||
              !Object.hasOwn(PROVIDERS, input.provider) || !PROVIDERS[input.provider].controls || !Number.isSafeInteger(input.epoch) || input.epoch < 1 ||
              typeof input.ready !== 'boolean' || typeof input.joined !== 'boolean') return fail(400, 'Invalid readiness report');
          delete args.p_action;
          Object.assign(args, { p_session_id: input.sessionId, p_client_id: input.clientId, p_provider: input.provider,
            p_epoch: input.epoch, p_ready: input.ready, p_joined: input.joined });
        } else {
          if (!input || !UUID.test(input.commandId || '') || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) return fail(400, 'A command ID and nonnegative expectedRevision are required');
          args.p_command_id = input.commandId;
          args.p_expected_revision = input.expectedRevision;
          if (route === 'media') {
            if (!['movie', 'tv'].includes(input.mediaType) || !Number.isInteger(input.tmdbId) || input.tmdbId < 1 || input.tmdbId > 2147483647) return fail(400, 'Invalid title identity');
            if (input.mediaType === 'tv' && (!Number.isInteger(input.season) || input.season < 0 || input.season > 9999 || !Number.isInteger(input.episode) || input.episode < 1 || input.episode > 9999)) return fail(400, 'Choose a valid season and episode');
            const readMetadata = async path => {
              let result;
              await metadata({ url: path, method: 'GET', headers: request.headers }, { setHeader() {} }, (_, status, body) => { result = { status, body }; });
              return result;
            };
            const result = await readMetadata(`/api/titles/${input.mediaType}/${input.tmdbId}`);
            if (result.status !== 200) { sendJson(response, result.status, result.body); return true; }
            const title = result.body.title;
            args.p_action = 'media';
            args.p_media = { mediaType: input.mediaType, tmdbId: input.tmdbId, title: title.title.slice(0, 500) };
            if (input.mediaType === 'tv') {
              const season = await readMetadata(`/api/titles/tv/${input.tmdbId}/seasons/${input.season}`);
              if (season.status !== 200) { sendJson(response, season.status, season.body); return true; }
              if (!season.body.episodes.some(episode => episode.episodeNumber === input.episode)) return fail(400, 'Episode not found in this season');
              Object.assign(args.p_media, { season: input.season, episode: input.episode });
            }
          } else {
            if (!UUID.test(input.sessionId || '') || !['play', 'pause', 'seek', 'provider'].includes(input.action)) return fail(400, 'Valid session ID and playback action required');
            args.p_action = input.action; args.p_session_id = input.sessionId;
            if (input.action === 'seek') {
              if (!Number.isSafeInteger(input.targetPositionMs) || input.targetPositionMs < 0 || input.targetPositionMs > 604800000) return fail(400, 'Seek position must be between 0 and 604800000 milliseconds');
              args.p_position_ms = input.targetPositionMs;
            }
            if (input.action === 'provider') {
              if (!Object.hasOwn(PROVIDERS, input.provider)) return fail(400, 'Unknown provider');
              args.p_provider = input.provider;
            }
          }
        }
      }
      const rpc = route === 'readiness' ? 'watch_report_readiness' : 'watch_playback';
      const result = await upstream('/rpc/' + rpc, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
      const payload = await result.json();
      if (!result.ok) {
        if (payload.code === 'PGRST202' || payload.code === '42P01' || payload.code === '42703') return fail(503, 'Playback setup required: run backend/playback.sql in Supabase SQL Editor');
        if (payload.code === '42501') return fail(403, 'Room membership required');
        if (payload.code === '22023') return fail(400, 'Invalid playback command');
        return fail(502, 'Could not read or update playback state');
      }
      if (payload.outcome === 'conflict' && route !== 'readiness') {
        sendJson(response, 409, { error: 'Playback changed. The latest room state has been loaded; try your action again.', state: payload.state });
      } else {
        sendJson(response, 200, { ...payload.state, duplicate: payload.outcome === 'duplicate' });
      }
    } catch {
      return fail(502, 'Playback service is unavailable. Check the connection and retry.');
    }
    return true;
  };
}
module.exports = { createPlaybackHandler, handlePlayback: createPlaybackHandler() };
