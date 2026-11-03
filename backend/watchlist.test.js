const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createWatchlistHandler } = require('./watchlist');
const ROOM = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const ITEM = '33333333-3333-4333-8333-333333333333';
process.env.SUPABASE_URL = 'https://db.test';
process.env.SUPABASE_PUBLISHABLE_KEY = 'test-publishable';
process.env.TMDB_READ_ACCESS_TOKEN = 'test-token';
function setup({ signedIn = true, member = true, existing = [], progress = [], failRead = false } = {}) {
  const rows = existing.map(row => ({ ...row })), calls = [];
  let metadataRequests = 0;
  const reply = data => ({ ok: true, status: 200, json: async () => data });
  const handler = createWatchlistHandler({
    authenticateUser: async () => signedIn ? { data: { userClaims: { id: USER } } } : { error: {} },
    fetchImpl: async (address, options = {}) => {
      const url = new URL(address); calls.push({ url, options });
      if (url.hostname === 'api.themoviedb.org') {
        metadataRequests++;
        return reply({ id: 155, title: 'Canonical title', release_date: '2008-07-16', overview: 'TMDB summary', poster_path: '/poster.jpg', genres: [] });
      }
      if (url.pathname.endsWith('/watch_room_members')) return reply(member ? [{ user_id: USER }] : []);
      if (url.pathname.endsWith('/watch_room_progress')) return reply(progress);
      if (failRead) return { ok: false, status: 500 };
      assert.ok(url.pathname.endsWith('/watch_room_list_items'));
      let matches = rows.filter(row => row.room_id === url.searchParams.get('room_id')?.slice(3));
      for (const field of ['id', 'media_type', 'tmdb_id']) if (url.searchParams.has(field)) matches = matches.filter(row => String(row[field]) === url.searchParams.get(field).slice(3));
      if (options.method === 'POST') {
        const input = JSON.parse(options.body);
        const previous = rows.find(row => row.room_id === input.room_id && row.media_type === input.media_type && row.tmdb_id === input.tmdb_id);
        if (previous) return reply([]);
        const inserted = { ...input, id: ITEM, removed_at: null }; rows.push(inserted); return reply([inserted]);
      }
      if (options.method === 'PATCH') { for (const row of matches) Object.assign(row, JSON.parse(options.body)); return reply(matches); }
      if (url.searchParams.has('removed_at')) matches = matches.filter(row => !row.removed_at);
      return reply(matches);
    },
  });
  async function request(method, body, item = '', room = ROOM) {
    const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
    req.method = method; req.url = '/api/rooms/' + room + '/list' + (item ? '/' + item : '');
    req.headers = { authorization: 'Bearer test' };
    let result;
    const res = { writeHead(status) { result = { status }; }, end() {} };
    await handler(req, res, (_res, status, data) => { result = { status, data }; });
    return result;
  }
  return { request, rows, calls, get metadataRequests() { return metadataRequests; } };
}
const row = () => ({ id: ITEM, room_id: ROOM, media_type: 'movie', tmdb_id: 155, title: 'Saved title', year: '2008', overview: '', poster_path: null, removed_at: null });
test('authentication and membership reject before metadata or list access', async () => {
  let app = setup({ signedIn: false }); assert.equal((await app.request('GET')).status, 401); assert.equal(app.calls.length, 0);
  app = setup({ member: false }); assert.equal((await app.request('POST', { mediaType: 'movie', tmdbId: 155 })).status, 403); assert.equal(app.calls.length, 1);
});
test('invalid IDs and payloads do not reach TMDB', async () => {
  const app = setup(); assert.equal((await app.request('GET', undefined, '', 'bad')).status, 400);
  for (const body of [null, {}, { mediaType: 'other', tmdbId: 155 }, { mediaType: 'movie', tmdbId: '155' }]) assert.equal((await app.request('POST', body)).status, 400);
  assert.equal(app.metadataRequests, 0);
});
test('add uses canonical metadata and verified creator, not client snapshots', async () => {
  const app = setup(); const result = await app.request('POST', { mediaType: 'movie', tmdbId: 155, title: 'Forged', added_by: 'spoof' });
  assert.equal(result.status, 201); assert.equal(result.data.item.title.title, 'Canonical title'); assert.equal(app.rows[0].added_by, USER); assert.equal(app.rows[0].room_id, ROOM);
});
test('duplicates return one item and removed items can be restored', async () => {
  const app = setup({ existing: [row()] });
  assert.equal((await app.request('POST', { mediaType: 'movie', tmdbId: 155 })).status, 200); assert.equal(app.rows.length, 1); assert.equal(app.metadataRequests, 0);
  assert.equal((await app.request('DELETE', undefined, ITEM)).status, 204); assert.ok(app.rows[0].removed_at);
  assert.equal((await app.request('GET')).data.items.length, 0);
  await app.request('POST', { mediaType: 'movie', tmdbId: 155 }); assert.equal(app.rows.length, 1); assert.equal(app.rows[0].removed_at, null);
});
test('removal is scoped to room and missing item returns 404', async () => {
  const other = { ...row(), room_id: '44444444-4444-4444-8444-444444444444' };
  const app = setup({ existing: [other] }); assert.equal((await app.request('DELETE', undefined, ITEM)).status, 404); assert.equal(app.rows[0].removed_at, null);
});
test('list response has frontend shape and hides removed items', async () => {
  const app = setup({ existing: [row(), { ...row(), id: USER, removed_at: '2026-01-01' }] });
  const result = await app.request('GET'); assert.equal(result.data.items.length, 1); assert.equal(result.data.items[0].title.tmdbId, 155); assert.equal(result.data.items[0].status, 'planned');
});
test('database failure returns an actionable error', async () => {
  const app = setup({ failRead: true }); assert.equal((await app.request('GET')).status, 502);
});
test('shared list uses movie completion but keeps partially completed television shows Watching', async () => {
  const movie=row(), show={...row(),id:USER,media_type:'tv',tmdb_id:1396,title:'Show'};
  const app=setup({existing:[movie,show],progress:[{media_type:'movie',tmdb_id:155,completed_at:'2026-01-01'},{media_type:'tv',tmdb_id:1396,completed_at:'2026-01-01'},{media_type:'tv',tmdb_id:1396,completed_at:null}]});
  const result=await app.request('GET');assert.equal(result.data.items[0].status,'watched');assert.equal(result.data.items[1].status,'watching');assert.equal(result.data.items[1].watchedEpisodes,1);
});
function frontend() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'index.html'), 'utf8');
  const source = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].at(-1)[1];
  new vm.Script(source);
  return source;
}
test('frontend ignores a delayed list from the previous room', async () => {
  const source = frontend(); let resolve, renders = 0; const nodes = {};
  const ctx = vm.createContext({ mode: 'api', me: { roomId: ROOM, userId: USER }, listVersion: 0, $: id => nodes[id] ??= { replaceChildren() { renders++; } }, request: () => new Promise(done => resolve = done), card() {} });
  vm.runInContext(source.slice(source.indexOf('    function listPath()'), source.indexOf('    function closeDetails(')), ctx);
  const promise = ctx.list(); ctx.me.roomId = USER; resolve({ items: [] }); await promise; assert.equal(renders, 0);
});
test('demo add/remove keeps mock paths and does not use real room API', async () => {
  const source = frontend(), paths = [], nodes = {};
  const ctx = vm.createContext({ mode: 'demo', me: { roomId: 'demo-room', groupId: 'demo-group' }, listVersion: 0, $: id => nodes[id] ??= { replaceChildren() {} }, request: async (url, method) => { paths.push([url, method]); return { items: [] }; }, card() {}, say() {} });
  vm.runInContext(source.slice(source.indexOf('    function listPath()'), source.indexOf('    function closeDetails(')), ctx);
  await ctx.add({ mediaType: 'movie', tmdbId: 155 }); await ctx.removeListItem('demo-item'); assert.ok(paths.every(([url]) => url.startsWith('/api/groups/demo-group/list')));
});

test('live list listens for insert/update in selected room and ignores old channels', () => {
  const source = frontend(), channels = [], removed = [], pending = new Map(), nodes = {}; let next = 0, listReads = 0;
  const ctx = vm.createContext({ mode: 'api', authSession: {}, me: { roomId: ROOM }, $: id => nodes[id] ??= { replaceChildren() {}, setAttribute() {} }, chat: async () => {}, list: async () => { listReads++; }, setTimeout(fn) { pending.set(++next, fn); return next; }, clearTimeout(id) { pending.delete(id); }, authClient: { removeChannel: async c => removed.push(c), channel() { const c = { listeners: [], on(type, filter, fn) { this.listeners.push({ type, filter, fn }); return this; }, subscribe(fn) { this.status = fn; } }; channels.push(c); return c; } } });
  ctx.loadProgress = async () => {}; ctx.loadRoomInfo = async () => {};
  vm.runInContext(source.slice(source.indexOf('    let chatChannel ='), source.indexOf('    authClient.auth.onAuthStateChange')), ctx);
  // Invitations have their own account-wide channel; this fixture isolates room-list delivery.
  ctx.startMovieInvitations = () => {}; ctx.stopMovieInvitations = () => {};
  ctx.startLiveChat();
  const listEvents = channels[0].listeners.filter(l => l.filter?.table === 'watch_room_list_items');
  assert.deepEqual(listEvents.map(l => l.filter.event), ['INSERT', 'UPDATE']);
  assert.ok(listEvents.every(l => l.filter.filter === 'room_id=eq.' + ROOM));
  ctx.me.roomId = USER; ctx.startLiveChat(); assert.equal(removed.length, 1);
  const count = pending.size; listEvents[0].fn(); assert.equal(pending.size, count);
  for (const fn of [...pending.values()]) fn(); assert.equal(listReads, 1);
  ctx.stopLiveChat(); assert.equal(pending.size, 0);
  ctx.mode = 'demo'; ctx.startLiveChat(); assert.equal(channels.length, 2);
});
