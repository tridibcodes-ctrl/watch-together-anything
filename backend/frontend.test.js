const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'index.html'), 'utf8');
const source = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].at(-1)[1];

function login({ signIn, verify = async () => {}, connect = async () => {} }) {
  const nodes = { 'auth-email': { value: ' person@example.com ' }, 'auth-password': { value: 'example-password' }, 'auth-status': {}, mode: {}, backend: {} };
  const calls = [];
  let submit;
  const context = vm.createContext({
    $: id => nodes[id], mode: 'demo', base: '', authSession: null,
    authClient: { auth: { signInWithPassword: signIn } },
    form(id, handler) { submit = handler; },
    checkBackendIdentity: verify,
    connect: async () => { calls.push('connect'); await connect(); },
    preference(key, value) { calls.push([key, value]); }
  });
  vm.runInContext(source.slice(source.indexOf("    form('sign-in-form'"), source.indexOf("    bind('sign-out'")), context);
  return { submit, nodes, context, calls };
}

test('successful sign-in leaves demo mode and connects the authenticated app', async () => {
  const session = { access_token: 'test-token' };
  const app = login({ signIn: async credentials => {
    assert.equal(credentials.email, 'person@example.com');
    return { data: { session }, error: null };
  }, verify: async actual => assert.equal(actual, session) });
  await app.submit();
  assert.equal(app.context.mode, 'api');
  assert.equal(app.context.base, '');
  assert.equal(app.nodes.mode.value, 'api');
  assert.equal(app.nodes['auth-password'].value, '');
  assert.ok(app.calls.includes('connect'));
});

test('authentication network failures replace the pending sign-in message', async () => {
  const app = login({ signIn: async () => { throw new Error('Network unavailable'); } });
  await assert.rejects(app.submit(), /Network unavailable/);
  assert.match(app.nodes['auth-status'].textContent, /Sign-in failed: Network unavailable/);
  assert.equal(app.context.mode, 'demo');
  assert.equal(app.calls.length, 0);
});

test('failed token verification cannot connect the app or report successful verification', async () => {
  const app = login({ signIn: async () => ({ data: { session: {} } }), verify: async () => { throw new Error('Verification unavailable'); } });
  await assert.rejects(app.submit(), /Verification unavailable/);
  assert.match(app.nodes['auth-status'].textContent, /account verification failed/);
  assert.equal(app.calls.length, 0);
});

test('room or catalog failures after login are identified as app connection failures', async () => {
  const app = login({ signIn: async () => ({ data: { session: {} } }), connect: async () => { throw new Error('Rooms unavailable'); } });
  await assert.rejects(app.submit(), /Rooms unavailable/);
  assert.match(app.nodes['auth-status'].textContent, /app could not finish connecting: Rooms unavailable/);
});

test('refreshing rooms selects and remembers the newly joined room', async () => {
  const nodes = { 'room-select': { replaceChildren(...items) { this.items = items; }, add(item) { this.items.push(item); } }, 'room-invite': {} };
  const rooms = [{ roomId: 'old', name: 'Old room' }, { roomId: 'new', name: 'New room', inviteCode: 'invite' }];
  const saved = new Map(); let subscriptions = 0;
  const context = vm.createContext({
    $: id => nodes[id], mode: 'api', me: { userId: 'user' },
    request: async () => ({ items: rooms }),
    Option: function(text, value) { this.text = text; this.value = value; },
    preference(key, value) { if (value !== undefined) saved.set(key, value); return saved.get(key); },
    startLiveChat() { subscriptions++; }
  });
  vm.runInContext(source.slice(source.indexOf('    async function loadRooms('), source.indexOf('    async function connect(')), context);
  await context.loadRooms('new');
  assert.equal(nodes['room-select'].items.length, 3);
  assert.equal(nodes['room-select'].value, 'new');
  assert.equal(context.me.roomId, 'new');
  assert.equal(saved.get('multiplay.room.user'), 'new');
  assert.equal(subscriptions, 1);
});
