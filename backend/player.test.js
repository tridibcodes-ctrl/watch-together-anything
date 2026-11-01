const test = require('node:test');
const assert = require('node:assert/strict');
const { embedUrl, playbackEvent, createPlayer } = require('../player');
const movie = { mediaType: 'movie', tmdbId: 155, title: 'The Dark Knight' };
const tv = { mediaType: 'tv', tmdbId: 1396, season: 0, episode: 1, title: 'Breaking Bad' };

test('provider URLs retain the exact movie or episode and use provider-specific parameters', () => {
  const cinema = new URL(embedUrl(movie, 'cinemaos', 60));
  assert.equal(cinema.origin, 'https://cinemaos.tech');
  assert.equal(cinema.pathname, '/player/155');
  assert.equal(cinema.searchParams.get('autoPlay'), 'false');
  assert.equal(cinema.searchParams.has('startTime'), false);
  assert.equal(new URL(embedUrl(tv, 'cinemaos')).pathname, '/player/1396/0/1');
  const fallback = new URL(embedUrl(tv, 'vidlink', 65.7));
  assert.equal(fallback.pathname, '/tv/1396/0/1');
  assert.equal(fallback.searchParams.get('startAt'), '65');
  assert.equal(fallback.searchParams.get('autoplay'), 'false');
  assert.equal(fallback.searchParams.get('nextbutton'), 'false');
  assert.equal(new URL(embedUrl(movie, 'vidlink', Infinity)).searchParams.get('startAt'), '0');
  for (const media of [{ ...movie, tmdbId: '155' }, { ...movie, mediaType: 'person' }, { ...tv, episode: 0 }, { ...tv, season: -1 }]) assert.throws(() => embedUrl(media, 'cinemaos'));
  assert.throws(() => embedUrl(movie, 'https://evil.test'));
});

test('VidLink events require active frame, exact origin, media identity and finite position', () => {
  const frame = { contentWindow: {} };
  const event = { origin: 'https://vidlink.pro', source: frame.contentWindow, data: { type: 'PLAYER_EVENT', data: { event: 'timeupdate', mtmdbId: 1396, mediaType: 'tv', season: 0, episode: 1, currentTime: 90 } } };
  assert.deepEqual(playbackEvent(event, frame, tv, 'vidlink'), { event: 'timeupdate', seconds: 90 });
  for (const changed of [
    { origin: 'https://vidlink.pro.evil.test' }, { source: {} }, { data: 'bad json' },
    ...[{ mtmdbId: 155 }, { mediaType: 'movie' }, { episode: 2 }, { currentTime: Infinity }, { currentTime: -1 }, { currentTime: '90' }, { event: 'error' }].map(data => ({ data: { type: 'PLAYER_EVENT', data: { ...event.data.data, ...data } } }))
  ]) assert.equal(playbackEvent({ ...event, ...changed }, frame, tv, 'vidlink'), null);
  assert.equal(playbackEvent(event, frame, tv, 'cinemaos'), null);
});

function harness() {
  const states = [], frames = [], timers = new Map(), listeners = new Map();
  let timerId = 0;
  const container = { children: [], replaceChildren() { this.children = []; }, append(frame) { this.children.push(frame); } };
  const player = createPlayer({ container, onState: state => states.push(state),
    windowImpl: { addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) },
    documentImpl: { createElement(tag) { assert.equal(tag, 'iframe'); const frame = { contentWindow: {}, setAttribute() {} }; frames.push(frame); return frame; } },
    setTimer(fn) { timers.set(++timerId, fn); return timerId; }, clearTimer(id) { timers.delete(id); }
  });
  return { player, states, frames, timers, listeners, container };
}

test('new selection starts primary; explicit or reported load failure falls back once', () => {
  const app = harness();
  app.player.load(tv);
  assert.equal(app.states.at(-1).provider, 'cinemaos');
  app.frames[0].onerror();
  assert.equal(app.states.at(-1).provider, 'vidlink');
  assert.equal(new URL(app.frames[1].src).pathname, '/tv/1396/0/1');
  app.frames[1].onerror();
  assert.equal(app.frames.length, 2);
  assert.equal(app.states.at(-1).status, 'error');
  app.player.load(movie);
  assert.equal(app.states.at(-1).provider, 'cinemaos');
  app.player.switchProvider('vidlink');
  assert.equal(new URL(app.frames.at(-1).src).pathname, '/movie/155');
  assert.equal(app.container.children.length, 1);
});

test('no events or load confirmation only suggests fallback and never interrupts playback automatically', () => {
  const app = harness(); app.player.load(movie);
  [...app.timers.values()][0]();
  assert.equal(app.states.at(-1).status, 'unconfirmed');
  assert.equal(app.frames.length, 1);
  app.frames[0].onload();
  assert.equal(app.states.at(-1).status, 'loaded');
  assert.equal(app.timers.size, 0);
});

test('verified VidLink progress resumes on retry; old frames and late load events are ignored', () => {
  const app = harness(); app.player.load(tv);
  const staleLoad = app.frames[0].onload;
  app.player.switchProvider('vidlink');
  const receive = app.listeners.get('message');
  receive({ origin: 'https://vidlink.pro', source: app.frames[1].contentWindow, data: { type: 'PLAYER_EVENT', data: { event: 'pause', mtmdbId: 1396, mediaType: 'tv', season: 0, episode: 1, currentTime: 70 } } });
  assert.equal(app.states.at(-1).seconds, 70);
  app.player.retry();
  assert.equal(new URL(app.frames[2].src).searchParams.get('startAt'), '70');
  const count = app.states.length; staleLoad();
  receive({ origin: 'https://vidlink.pro', source: app.frames[1].contentWindow, data: { type: 'PLAYER_EVENT', data: { event: 'ended', mtmdbId: 1396, mediaType: 'tv', season: 0, episode: 1, currentTime: 900 } } });
  assert.equal(app.states.length, count);
  app.player.clear();
  assert.equal(app.container.children.length, 0);
  assert.equal(app.timers.size, 0);
  assert.equal(app.states.at(-1).media, null);
  app.player.destroy(); assert.equal(app.listeners.size, 0);
});
