const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../frontend/index.html'), 'utf8');
const source = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].at(-1)[1];

function navigation({ signedIn = true, mode = 'api' } = {}) {
  const nodes = {};
  const element = id => nodes[id] ??= { id, hidden: true, attributes: {}, focus() { focused = id; },
    setAttribute(name, value) { this.attributes[name] = value; }, removeAttribute(name) { delete this.attributes[name]; } };
  let focused = null;
  const views = ['home', 'browse', 'list', 'room', 'profile', 'developer'].map(element);
  const links = views.map(view => ({ ...element('link-' + view.id), getAttribute: () => '#' + view.id }));
  const scrolls = [];
  const context = vm.createContext({
    $: element, mode, me: signedIn ? { userId: 'me' } : null, authSession: signedIn ? {} : null, joined: true,
    location: { hash: '#room' }, currentView: '', viewScroll: new Map(), pendingNavigationFocus: null,
    window: { scrollY: 0, scrollTo(x, y) { scrolls.push(y); this.scrollY = y; } },
    document: { querySelectorAll: selector => selector === '[data-view]' ? views : links,
      querySelector: selector => element(selector) },
    isPlaybackExpanded: () => false, setChatOpen(open) { element('chat-panel').hidden = !open; }
  });
  vm.runInContext(source.slice(source.indexOf('    function inviteFromHash('), source.indexOf('    function inviteCodeFromInput(')), context);
  vm.runInContext(source.slice(source.indexOf('    function route('), source.indexOf('    function renderExperience(')), context);
  return { context, nodes, views, links, scrolls, focused: () => focused };
}

test('navigation preserves the room while switching views and restores browsing position', () => {
  const app = navigation();
  const session = app.context.me;
  app.context.route();
  assert.equal(app.nodes.room.hidden, false);
  app.context.location.hash = '#browse'; app.context.route();
  app.context.window.scrollY = 650;
  app.nodes['chat-panel'].hidden = false;
  app.context.location.hash = '#home'; app.context.route();
  assert.equal(app.nodes['chat-panel'].hidden, true);
  app.context.location.hash = '#browse'; app.context.route(true);
  assert.equal(app.context.window.scrollY, 650);
  assert.equal(app.context.me, session);
  assert.deepEqual(app.views.filter(view => !view.hidden).map(view => view.id), ['browse']);
  assert.equal(app.links.find(link => link.id === 'link-browse').attributes['aria-current'], 'page');
});

test('signed-out visitors see sign-in instead of private views; developer tools stay accessible', () => {
  const app = navigation({ signedIn: false });
  app.context.route();
  assert.ok(app.views.every(view => view.hidden));
  assert.equal(app.nodes.auth.hidden, false);
  app.context.location.hash = '#developer'; app.context.route();
  assert.equal(app.nodes.developer.hidden, false);
  assert.equal(app.nodes.auth.hidden, true);
});

test('demo browsing needs no account and remains clearly marked as a preview', () => {
  const app = navigation({ signedIn: false, mode: 'demo' });
  app.context.location.hash = '#browse'; app.context.route();
  assert.equal(app.nodes.browse.hidden, false);
  assert.equal(app.nodes['demo-banner'].hidden, false);
});

test('the cinema cannot open before joining; membership invitation links lead to Home', () => {
  const app = navigation(); app.context.joined = false;
  app.context.route(); assert.equal(app.nodes.home.hidden, false); assert.equal(app.nodes.room.hidden, true);
  app.context.location.hash = '#invite=abc123'; app.context.route(); assert.equal(app.nodes.home.hidden, false);
});

test('opening details keeps keyboard focus on the details rather than the browse heading', () => {
  const app = navigation();
  app.nodes['title-details'] = { hidden: false };
  app.context.location.hash = '#browse'; app.context.route(true);
  assert.equal(app.focused(), 'details-heading');
});
