const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const pickerSource = fs.readFileSync(path.join(__dirname, '../frontend/picker.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../frontend/index.html'), 'utf8');
const source = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].at(-1)[1];
const flush = () => new Promise(resolve => setImmediate(resolve));

function picker({ roomId = 'room', delayedPreview = false } = {}) {
  const nodes = {}, animations = [], calls = [], intervals = new Set(); let reduced = false, resolvePreview;
  const context = { mode: 'api', roomId, userId: 'me', name: 'Me', view: 'picker' };
  const element = () => ({ children: [], style: {}, hidden: false, open: false, textContent: '', replacements:0,
    replaceChildren(...children) { this.children = children; this.replacements++; }, append(...children) { this.children.push(...children); },
    setAttribute(name, value) { this[name] = value; }, addEventListener() {}, focus() {}, close() { this.open = false; }, showModal() { this.open = true; },
    animate(frames, timing) { const item = { frames, timing, cancelled: false, cancel() { this.cancelled = true; } }; animations.push(item); return item; } });
  const forbidden = new Set(['picker-notice', 'picker-notice-text', 'picker-nav-badge', 'picker-open-notice']);
  const document = { hidden: false, activeElement: null, createElement: element, createElementNS: element, createTextNode: text => text, addEventListener() {},
    querySelector: () => Object.values(nodes).find(node=>node.open)||null,
    getElementById(id) { assert.equal(forbidden.has(id), false, 'Picker must not access notification UI'); return nodes[id] ??= element(); } };
  const module = { exports: {} };
  vm.runInNewContext(pickerSource, { module, document, window: { matchMedia: () => ({ matches: reduced, addEventListener() {} }) },
    structuredClone, Date, crypto: { randomUUID: () => 'round' }, setTimeout: () => 1, clearTimeout() {},
    setInterval(fn) { intervals.add(fn); return fn; }, clearInterval(fn) { intervals.delete(fn); } });
  const titles = [{ mediaType: 'movie', tmdbId: 1, title: 'Trending movie' }, { mediaType: 'tv', tmdbId: 2, title: 'Trending series' }];
  let state = { roomId, roundId: null, revision: 0, members: [] };
  const controller = module.exports.create({ getContext: () => context, onTitle() {}, onGenre() {}, request: async (url, method, body) => {
    calls.push({ url, method, body });
    if (url.includes('/api/catalog')) return delayedPreview ? new Promise(resolve => { resolvePreview = resolve; }) : { items: titles };
    if (url.includes('/api/titles/')) return {title:{...titles[0],overview:'A shared movie night.'}};
    if(body?.action==='start')state={roundId:body.roundId,revision:(state.revision||0)+1,mode:body.mode,trendingWindow:body.trendingWindow,options:titles,pool:titles,members:[]};
    return structuredClone({ ...state, serverTime: new Date().toISOString() });
  } });
  return { controller, nodes, context, calls, animations, intervals,
    setState(value) { state = value; }, setReduced(value) { reduced = value; }, resolvePreview() { resolvePreview({ items: titles }); } };
}

test('trending idle preview rotates slowly without starting a shared round or creating notices', async () => {
  const app = picker(); app.controller.start(); await flush();
  assert.equal(app.nodes['picker-options'].children.length, 2);
  assert.equal(app.nodes['picker-pool-heading'].textContent, 'Trending This Week');
  assert.ok(app.calls.every(call => !call.method || call.method === 'GET'));
  const idle = app.animations.find(animation => animation.timing.iterations === Infinity);
  assert.equal(idle.timing.duration, 90000);
  app.context.view = 'home'; app.controller.viewChanged(); assert.equal(idle.cancelled, true);
  app.context.view = 'picker'; app.controller.viewChanged();
  const current = app.animations.at(-1); assert.equal(current.cancelled, false);
  app.setReduced(true); app.controller.viewChanged(); assert.equal(current.cancelled, true);
  app.controller.stop(); assert.equal(app.intervals.size, 0);
});

test('the idle preview stops before a deterministic shared result animation and polling cannot replay it', async () => {
  const app = picker(); app.controller.start(); await flush();
  const idle = app.animations.at(-1);
  app.setState({ roundId: 'round', revision: 1, mode: 'trending', members: [], pool: [{ key: 'movie:1', title: 'Winner' }],
    options: [], ready: true, result: { key: 'movie:1', title: 'Winner' }, resultIndex: 0, spinAt: new Date().toISOString() });
  await app.controller.refresh();
  assert.equal(idle.cancelled, true);
  assert.equal(app.animations.at(-1).timing.duration, 5500);
  const count = app.animations.length; await app.controller.refresh(); assert.equal(app.animations.length, count);
  app.controller.stop();
});

test('trending preview works without a room and ignores a response after sign-out', async () => {
  const app = picker({ roomId: null, delayedPreview: true }); app.controller.start(); await flush();
  assert.equal(app.calls.length, 1); assert.match(app.calls[0].url, /trending-week/);
  app.context.userId = null; app.controller.stop(); app.resolvePreview(); await flush();
  assert.equal(app.nodes['picker-options'].children.length, 0); assert.equal(app.animations.length, 0);
});

test('daily and weekly buttons create distinct shared rounds and unchanged polling preserves options', async () => {
  const app=picker();app.controller.start();await flush();
  await app.nodes['picker-trending-day'].onclick();
  assert.equal(app.calls.find(call=>call.body?.action==='start').body.trendingWindow,'day');
  assert.equal(app.nodes['picker-pool-heading'].textContent,'Trending Today');
  assert.match(app.nodes['picker-trending-help'].textContent,/today/);
  const changes=app.nodes['picker-options'].replacements;
  await app.controller.refresh();assert.equal(app.nodes['picker-options'].replacements,changes);
  app.controller.close();
  // A completed daily round can be followed by the weekly round without a reset prompt.
  app.setState({roundId:'finished',revision:3,mode:'trending',trendingWindow:'day',members:[],options:[],pool:[{mediaType:'movie',tmdbId:1,title:'Pick'}],result:{mediaType:'movie',tmdbId:1,title:'Pick'},resultIndex:0,spinAt:new Date().toISOString()});
  await app.controller.refresh();await app.nodes['picker-trending'].onclick();
  assert.equal(app.calls.filter(call=>call.body?.action==='start').at(-1).body.trendingWindow,'week');
  assert.equal(app.nodes['picker-pool-heading'].textContent,'Trending This Week');app.controller.stop();
});

test('a completed spin opens its result once; polling does not reopen it and View result still works', async () => {
  const app=picker();app.controller.start();await flush();
  app.setState({roundId:'finished',revision:1,mode:'trending',members:[],options:[],pool:[{mediaType:'movie',tmdbId:1,title:'Pick'}],result:{mediaType:'movie',tmdbId:1,title:'Pick'},resultIndex:0,spinAt:new Date().toISOString()});
  await app.controller.refresh();assert.equal(app.nodes['picker-result-dialog'].open,false);
  app.animations.at(-1).onfinish();await flush();
  assert.equal(app.nodes['picker-result-dialog'].open,true);assert.match(app.nodes['picker-result-description'].textContent,/shared movie night/);
  app.nodes['picker-result-close'].onclick();await app.controller.refresh();
  assert.equal(app.nodes['picker-result-dialog'].open,false);
  app.nodes['picker-result-action'].onclick();assert.equal(app.nodes['picker-result-dialog'].open,true);
  app.context.view='home';app.controller.viewChanged();assert.equal(app.nodes['picker-result-dialog'].open,false);app.controller.stop();
});

test('picker invite links keep a validated destination and successful room joining opens Picker', async () => {
  const context = vm.createContext({ URL, mode: 'api', me: { roomId: 'room', rooms: [{ roomId: 'room', inviteCode: 'abc123' }] }, location: { href: 'https://app.test/#picker', hash: '#invite=abc123&to=picker' },
    pendingInvite: 'abc123', pendingInviteTarget: 'picker', inviteBusy: false, controls() {}, preference() {}, say() {},
    request: async () => ({ roomId: 'room' }), loadRooms: async () => {} });
  vm.runInContext(source.slice(source.indexOf('    function inviteFromHash('), source.indexOf('    function inviteCodeFromInput(')), context);
  vm.runInContext(source.slice(source.indexOf('    function pickerInviteLink('), source.indexOf("    bind('picker-invite'")), context);
  const link = context.pickerInviteLink(); assert.equal(new URL(link).hash, '#invite=abc123&to=picker');
  assert.equal(context.inviteFromHash(new URL(link).hash), 'abc123'); assert.equal(context.inviteTargetFromHash(new URL(link).hash), 'picker');
  assert.equal(context.inviteFromHash('#invite=abc123&to=<script>'), null); assert.equal(context.inviteTargetFromHash('#invite=abc123'), 'home');
  vm.runInContext(source.slice(source.indexOf('    async function acceptInvitation('), source.indexOf('    // The only HTTP function.')), context);
  await context.acceptInvitation(); assert.equal(context.location.hash, 'picker'); assert.equal(context.pendingInvite, null);
});

test('the shared-screen card forwards background clicks to resume without intercepting its other links', () => {
  const nodes = { 'home-session': {}, 'home-watch': { click() { this.onclick({ preventDefault() {} }); } } }, calls = [];
  const media = { mediaType: 'tv', tmdbId: 1396, title: 'Series', season: 1, episode: 2 };
  const context = vm.createContext({ $: id => nodes[id], room: { media }, progressItems: [], joined: false, location: { hash: 'home' }, act: fn => fn(), watchTitle: (...args) => calls.push(args) });
  vm.runInContext(source.slice(source.indexOf("    $('home-watch').onclick"), source.indexOf('    function pickerInviteLink(')), context);
  nodes['home-session'].onclick({ target: { closest: () => null } });
  assert.equal(calls.length, 1); assert.equal(calls[0][0], media); assert.equal(calls[0][1], media);
  nodes['home-session'].onclick({ target: { closest: () => ({ tagName: 'A' }) } }); assert.equal(calls.length, 1);
  context.joined = true; nodes['home-session'].onclick({ target: { closest: () => null } });
  assert.equal(context.location.hash, 'room'); assert.equal(calls.length, 1);
});
