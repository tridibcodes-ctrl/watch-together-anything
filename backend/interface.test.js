const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Readable } = require('node:stream');
const { randomUUID } = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const { createTmdbHandler } = require('./tmdb');
const { createChatHandler } = require('./chat');
const html = fs.readFileSync(path.join(__dirname, '../frontend/index.html'), 'utf8');
const source = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].at(-1)[1];
const USER = '22222222-2222-4222-8222-222222222222', ROOM = '11111111-1111-4111-8111-111111111111';
const reply = data => ({ ok: true, status: 200, json: async () => data });

test('genre discovery authenticates, filters upstream, preserves genre IDs and separates cached genres', async () => {
  let allowed = true; const urls = [];
  const handler = createTmdbHandler({ authenticateUser: async () => allowed ? { data: { userClaims: { id: USER } } } : { error: {} }, getToken: () => 'test-token',
    fetchImpl: async address => { const url = new URL(address); urls.push(url); return reply(url.pathname.includes('/genre/') ? { genres: [{ id: 28, name: 'Action' }] } : { results: [{ id: 155, title: 'Movie', genre_ids: [28, 80] }], total_pages: 2 }); } });
  const call = async url => { let result; await handler({ method: 'GET', url, headers: {} }, { setHeader() {} }, (_r, status, body) => { result = { status, body }; }); return result; };
  assert.equal((await call('/api/genres?type=movie')).body.items[0].name, 'Action');
  const titles = await call('/api/catalog?type=movie&genre=28');
  assert.equal(urls[1].pathname, '/3/discover/movie'); assert.equal(urls[1].searchParams.get('with_genres'), '28');
  assert.deepEqual(titles.body.items[0].genreIds, [28, 80]);
  assert.equal((await call('/api/catalog?type=movie&genre=invalid')).status, 400);
  allowed = false; assert.equal((await call('/api/genres?type=movie')).status, 401); assert.equal(urls.length, 2);
});

test('chat checks membership before history and adds a 24-hour server-side cutoff', async () => {
  process.env.SUPABASE_URL = 'https://db.test'; process.env.SUPABASE_PUBLISHABLE_KEY = 'test';
  let member = true; const urls = [];
  const handler = createChatHandler({ authenticateUser: async () => ({ data: { userClaims: { id: USER } } }), fetchImpl: async address => { const url = new URL(address); urls.push(url); return reply(url.pathname.endsWith('/watch_room_members') ? member ? [{ user_id: USER }] : [] : []); } });
  const call = async () => { const request = Readable.from([]); Object.assign(request, { method: 'GET', url: `/api/rooms/${ROOM}/messages`, headers: {} }); let result; await handler(request, {}, (_r, status, body) => { result = { status, body }; }); return result; };
  const before = Date.now(); assert.equal((await call()).status, 200);
  const cutoff = Date.parse(urls[1].searchParams.get('created_at').slice(3));
  assert.ok(Math.abs(cutoff - (before - 86400000)) < 1000);
  member = false; assert.equal((await call()).status, 403); assert.equal(urls.length, 3);
});

test('signup confirmation does not authenticate prematurely or send mismatched passwords', async () => {
  let registrations = 0, connects = 0; const nodes = {};
  const context = vm.createContext({ $: id => nodes[id] ??= { value: '' }, location: { protocol: 'https:', origin: 'https://app.test' },
    authClient: { auth: { signUp: async credentials => { registrations++; assert.equal(credentials.options.data.avatar_key, 'heart'); assert.equal(credentials.options.emailRedirectTo, 'https://app.test/'); return { data: { session: null }, error: null }; } } },
    friendlyError: text => text, connect: async () => { connects++; } });
  vm.runInContext(source.slice(source.indexOf('    async function signUp()'), source.indexOf("    bind('show-sign-in'")), context);
  Object.assign(nodes, { 'signup-name': { value: 'New person' }, 'signup-avatar': { value: 'heart' }, 'signup-email': { value: 'user@example.test' }, 'signup-password': { value: 'long-password' }, 'signup-confirm': { value: 'different' } });
  await assert.rejects(context.signUp(), /do not match/); assert.equal(registrations, 0);
  nodes['signup-confirm'].value = 'long-password'; await context.signUp();
  assert.equal(registrations, 1); assert.equal(connects, 0); assert.equal(context.authSession, undefined);
  assert.match(nodes['auth-status'].textContent, /Check your email/); assert.equal(nodes['signup-password'].value, '');
});

test('a list status stays current before progress history arrives; TV completion stays in Watching', () => {
  const context = vm.createContext({ progressItems: [] });
  vm.runInContext(source.slice(source.indexOf('    function listProgress('), source.indexOf('    function renderSavedLists(')), context);
  assert.equal(context.listProgress({ status: 'watching', title: { mediaType: 'movie', tmdbId: 155 } }).status, 'watching');
  context.progressItems = [{ media: { mediaType: 'tv', tmdbId: 1396 }, completedAt: '2026-01-01' }];
  assert.equal(context.listProgress({ title: { mediaType: 'tv', tmdbId: 1396 } }).status, 'watching');
});

test('suggestions from an old query or signed-out user never reopen the dropdown', async () => {
  const nodes = {}, waiting = []; let renders = 0;
  const context = vm.createContext({ suggestionVersion: 0, suggestions: [], mode: 'api', currentView: 'browse', me: { userId: USER },
    $: id => nodes[id] ??= { value: 'dark', hidden: true, replaceChildren() { renders++; }, setAttribute() {} },
    request: url => new Promise(resolve => waiting.push(resolve)) });
  vm.runInContext(source.slice(source.indexOf('    async function suggestTitles()'), source.indexOf('    function resetCatalog()')), context);
  const pending = context.suggestTitles();
  context.me = null;
  for (const resolve of waiting) resolve({ items: [{ title: 'Private old query', mediaType: 'movie' }] });
  await pending; assert.equal(renders, 0); assert.equal(context.suggestions.length, 0);
});

test('signup with a returned session verifies identity before connecting and saves the selected profile', async () => {
  const nodes = {}, calls = [], session = { access_token: 'test' };
  const context = vm.createContext({ $: id => nodes[id] ??= { value: '' }, location: { protocol: 'https:', origin: 'https://app.test' }, mode: 'api', base: '',
    authClient: { auth: { signUp: async () => ({ data: { session } }) } },
    checkBackendIdentity: async actual => { assert.equal(actual, session); calls.push('verify'); },
    connect: async () => { calls.push('connect'); context.me = { profile: {} }; },
    request: async (url, method, profile) => { calls.push('profile'); assert.equal(url, '/api/me/profile'); assert.equal(method, 'PATCH'); return { profile }; },
    preference() {}, controls() {}, say() {}, friendlyError: text => text });
  vm.runInContext(source.slice(source.indexOf('    async function signUp()'), source.indexOf("    bind('show-sign-in'")), context);
  Object.assign(nodes, { 'signup-name': { value: 'New person' }, 'signup-avatar': { value: 'star' }, 'signup-email': { value: 'user@example.test' }, 'signup-password': { value: 'long-password' }, 'signup-confirm': { value: 'long-password' } });
  await context.signUp(); assert.deepEqual(calls, ['verify', 'connect', 'profile']);
  assert.equal(context.me.profile.avatarKey, 'star'); assert.equal(nodes['display-name'].value, 'New person');
});

test('message retention is idempotent, hides expired rows, purges them, and preserves playback history', async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create schema auth; create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;
      create schema cron; create table cron.jobs(name text primary key,schedule text,command text);
      create function cron.schedule(text,text,text) returns bigint language sql as $$ insert into cron.jobs values($1,$2,$3) on conflict(name) do update set schedule=$2,command=$3 returning 1::bigint $$;`);
    await db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
    const retention = fs.readFileSync(path.join(__dirname, 'message-retention.sql'), 'utf8');
    await db.exec(retention); await db.exec(retention);
    assert.equal((await db.query('select count(*) from cron.jobs')).rows[0].count, 1);
    const room = randomUUID(), actor = randomUUID(), other = randomUUID();
    await db.query('insert into auth.users values($1),($2)', [actor, other]);
    await db.query("insert into watch_rooms(id,invite_code) values($1,'retention')", [room]);
    await db.query('insert into watch_room_members(room_id,user_id) values($1,$2)', [room, actor]);
    await db.query("insert into watch_room_messages(room_id,sender_id,client_message_id,sender_name,body,created_at) values($1,$2,gen_random_uuid(),'Sender','expired',now()-interval '25 hours'),($1,$2,gen_random_uuid(),'Sender','current',now()-interval '1 hour')", [room, actor]);
    await db.exec('grant select on watch_room_messages to authenticated; set role authenticated');
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [actor]);
    assert.deepEqual((await db.query('select body from watch_room_messages')).rows.map(row => row.body), ['current']);
    await assert.rejects(db.query('select purge_expired_watch_messages()'), /permission denied/);
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [other]);
    assert.equal((await db.query('select * from watch_room_messages')).rows.length, 0);
    await db.exec('reset role; select public.purge_expired_watch_messages()');
    assert.equal((await db.query('select count(*) from watch_room_messages')).rows[0].count, 1);
    assert.equal((await db.query('select count(*) from watch_rooms')).rows[0].count, 1);
  } finally { await db.close(); }
});
