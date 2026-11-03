const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function authenticate(request) {
  const { verifyAuth } = await import('@supabase/server/core');
  const headers = new Headers();
  for (const key of ['authorization', 'apikey']) if (request.headers[key]) headers.set(key, request.headers[key]);
  return verifyAuth(new Request(new URL(request.url, 'http://localhost:3000'), { headers }), { auth: 'user' });
}
function createCoupleHandler({ authenticateUser = authenticate, fetchImpl = fetch } = {}) {
  return async function handleCouple(request, response, sendJson) {
    const match = /^\/api\/rooms\/([^/]+)(?:\/(progress|completion|details))?$/.exec(new URL(request.url, 'http://localhost').pathname);
    if (!match || (!match[2] && request.method !== 'PATCH')) return false;
    const [, roomId, route = 'rename'] = match;
    const fail = (status, error) => { sendJson(response, status, { error }); return true; };
    try {
      if (!UUID.test(roomId)) return fail(400, 'Invalid room ID');
      const method = { progress: 'GET', details: 'GET', completion: 'POST', rename: 'PATCH' }[route];
      if (request.method !== method) return fail(405, `Use ${method} for this action`);
      const { data, error } = await authenticateUser(request);
      if (error || !data?.userClaims?.id) return fail(401, 'Sign-in required or token invalid');
      if (!process.env.SUPABASE_URL || !process.env.SUPABASE_PUBLISHABLE_KEY) return fail(503, 'Supabase configuration is missing');
      const base = process.env.SUPABASE_URL.replace(/\/+$/, '') + '/rest/v1';
      const headers = { apikey: process.env.SUPABASE_PUBLISHABLE_KEY, Authorization: request.headers.authorization };
      const upstream = async (path, options = {}) => {
        const result = await fetchImpl(base + path, { ...options, headers: { ...headers, ...options.headers }, signal: AbortSignal.timeout(10000) });
        const payload = await result.json().catch(() => ({}));
        if (!result.ok) {
          const error = new Error(payload.message || 'Room service unavailable');
          error.status = ['PGRST202', '42P01', '42703'].includes(payload.code) ? 503 : payload.code === '42501' ? 403 : payload.code === '22023' ? 400 : 502;
          if (error.status === 503) error.message = 'Phase 2 setup required: apply backend/phase2.sql after schema.sql and playback.sql';
          throw error;
        }
        return payload;
      };
      const members = await upstream(`/watch_room_members?room_id=eq.${roomId}&select=user_id`);
      if (!members.some(member => member.user_id === data.userClaims.id)) return fail(403, 'You are not a member of this room');
      if (route === 'details') {
        const rooms = await upstream(`/watch_rooms?id=eq.${roomId}&select=id,name,invite_code`);
        if (!rooms.length) return fail(404, 'Room not found');
        const profiles = await upstream(`/profiles?user_id=in.(${members.map(member => member.user_id).join(',')})&select=user_id,display_name,avatar_key`);
        sendJson(response, 200, { roomId, name: rooms[0].name, inviteCode: rooms[0].invite_code,
          members: members.map(member => ({ userId: member.user_id, displayName: profiles.find(profile => profile.user_id === member.user_id)?.display_name || 'Partner', avatarKey: profiles.find(profile => profile.user_id === member.user_id)?.avatar_key || 'moon' })) });
        return true;
      }
      const args = { p_room_id: roomId };
      if (method !== 'GET') {
        let raw = '', size = 0;
        for await (const chunk of request) { size += Buffer.byteLength(chunk); if (size > 4096) return fail(413, 'Request body is too large'); raw += chunk; }
        let input;
        try { input = JSON.parse(raw); } catch { return fail(400, 'Request must be valid JSON'); }
        if (route === 'rename') {
          if (typeof input?.name !== 'string' || !input.name.trim() || input.name.trim().length > 60) return fail(400, 'Room name must be 1 to 60 characters');
          args.p_name = input.name.trim();
        } else {
          if (!UUID.test(input?.sessionId || '') || !Number.isSafeInteger(input.epoch) || input.epoch < 1 || typeof input.confirmed !== 'boolean') return fail(400, 'Current session, completion version and confirmation are required');
          Object.assign(args, { p_session_id: input.sessionId, p_epoch: input.epoch, p_confirmed: input.confirmed });
        }
      }
      const rpc = { rename: 'rename_watch_room', progress: 'watch_progress', completion: 'watch_confirm_completion' }[route];
      const payload = await upstream('/rpc/' + rpc, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
      if (payload.conflict) return fail(409, 'The movie or completion status changed. Refresh and try again.');
      sendJson(response, 200, payload);
    } catch (error) { return fail(error.status || 502, error.status ? error.message : 'Could not update your room. Please try again.'); }
    return true;
  };
}
module.exports = { createCoupleHandler, handleCouple: createCoupleHandler() };
