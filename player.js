(function (root) {
  'use strict';
  const PROVIDERS = Object.freeze({
    cinemaos: { name: 'CinemaOS', origin: 'https://cinemaos.tech' },
    vidlink: { name: 'VidLink', origin: 'https://vidlink.pro' }
  });

  function validateMedia(media) {
    if (!media || !['movie', 'tv'].includes(media.mediaType) || !Number.isSafeInteger(media.tmdbId) || media.tmdbId < 1) throw new Error('Choose a valid movie or TV show.');
    if (media.mediaType === 'tv' && (!Number.isInteger(media.season) || media.season < 0 || !Number.isInteger(media.episode) || media.episode < 1)) throw new Error('Choose a TV season and episode.');
  }

  function embedUrl(media, provider, seconds = 0) {
    validateMedia(media);
    if (!Object.hasOwn(PROVIDERS, provider)) throw new Error('Unknown player provider.');
    const suffix = media.mediaType === 'tv' ? `/${media.season}/${media.episode}` : '';
    const path = provider === 'cinemaos' ? `/player/${media.tmdbId}${suffix}` : `/${media.mediaType}/${media.tmdbId}${suffix}`;
    const url = new URL(path, PROVIDERS[provider].origin);
    if (provider === 'cinemaos') {
      url.searchParams.set('autoPlay', 'false');
      url.searchParams.set('autoNext', 'false');
    } else {
      url.searchParams.set('autoplay', 'false');
      url.searchParams.set('nextbutton', 'false');
      url.searchParams.set('startAt', String(Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0));
    }
    return url.href;
  }

  // CinemaOS command/event names were supplied from its embed documentation.
  // VidLink exposes notifications only; never send speculative commands to it.
  function playbackEvent(event, frame, media, provider) {
    if (!Object.hasOwn(PROVIDERS, provider) || event.origin !== PROVIDERS[provider].origin || event.source !== frame?.contentWindow) return null;
    let payload = event.data;
    if (typeof payload === 'string') {
      if (payload.length > 10000) return null;
      try { payload = JSON.parse(payload); } catch { return null; }
    }
    const data = payload?.data;
    if (payload?.type !== 'PLAYER_EVENT' || !data || !['play', 'pause', 'seeked', 'ended', 'timeupdate', 'playerstatus'].includes(data.event)) return null;
    const id = data.mtmdbId ?? data.tmdbId;
    if ((provider === 'vidlink' || id !== undefined) && Number(id) !== media.tmdbId) return null;
    if ((provider === 'vidlink' || data.mediaType !== undefined) && data.mediaType !== media.mediaType) return null;
    if (media.mediaType === 'tv' && ((provider === 'vidlink' || data.season !== undefined) && Number(data.season) !== media.season || (provider === 'vidlink' || data.episode !== undefined) && Number(data.episode) !== media.episode)) return null;
    if (typeof data.currentTime !== 'number' || !Number.isFinite(data.currentTime) || data.currentTime < 0 || data.currentTime > 604800) return null;
    return { event: data.event, seconds: data.currentTime,
      duration: typeof data.duration === 'number' && Number.isFinite(data.duration) ? data.duration : 0,
      playing: typeof data.paused === 'boolean' ? !data.paused : typeof data.playing === 'boolean' ? data.playing : typeof data.isPlaying === 'boolean' ? data.isPlaying : undefined };
  }

  function createPlayer({ container, onState = () => {}, onFallback, windowImpl = window, documentImpl = document, setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now }) {
    let frame = null, media = null, provider = 'cinemaos', seconds = 0, timer = null, generation = 0, ready = false, playing = false, measuredAt = now();
    const emit = (status, message) => onState({ media, provider, seconds, ready, playing, status, message });
    function sendCommand(command, params = {}) {
      if (!frame || provider !== 'cinemaos' || (command !== 'getStatus' && !ready)) return false;
      if (!['play','pause','seek','getStatus'].includes(command)) return false;
      if (command === 'seek' && (!Number.isFinite(params.time) || params.time < 0 || params.time > 604800)) return false;
      frame.contentWindow.postMessage({ command, ...(command === 'seek' ? { time: params.time } : {}) }, PROVIDERS.cinemaos.origin);
      return true;
    }
    function removeFrame() {
      generation++;
      clearTimer(timer); timer = null;
      if (frame) { frame.onload = null; frame.onerror = null; }
      frame = null;
      container.replaceChildren();
    }
    function load(nextMedia, nextProvider = 'cinemaos', startSeconds = 0) {
      const src = embedUrl(nextMedia, nextProvider, startSeconds);
      removeFrame();
      media = { ...nextMedia }; provider = nextProvider;
      ready = false; playing = false;
      measuredAt = now();
      seconds = provider === 'vidlink' && Number.isFinite(startSeconds) && startSeconds >= 0 ? startSeconds : 0;
      const version = generation;
      frame = documentImpl.createElement('iframe');
      frame.title = `${media.title || 'Selected title'} — ${PROVIDERS[provider].name}`;
      frame.width = '100%'; frame.height = '360';
      frame.allow = 'autoplay; fullscreen; picture-in-picture; encrypted-media';
      frame.allowFullscreen = true;
      frame.referrerPolicy = 'strict-origin-when-cross-origin';
      // VidLink refuses sandboxed embeds. Use the providers' documented iframe
      // setup; the cross-origin boundary still prevents access to our page DOM.
      frame.onload = () => {
        if (version !== generation) return;
        emit('loaded', `${PROVIDERS[provider].name} frame navigation finished; video playback is not confirmed. Press Play inside the player. If it cannot play, ${provider === 'cinemaos' ? 'try VidLink below' : 'retry or choose another title'}.`);
        sendCommand('getStatus');
      };
      frame.onerror = () => {
        if (version !== generation) return;
        if (provider === 'cinemaos') {
          if (onFallback) { clearTimer(timer); timer = null; onFallback(); return; }
          load(media, 'vidlink', seconds);
          emit('loading', 'CinemaOS could not load. Trying VidLink.');
        } else {
          clearTimer(timer); timer = null;
          emit('error', 'VidLink could not load. Retry or choose another title.');
        }
      };
      frame.src = src;
      emit('loading', `Loading ${PROVIDERS[provider].name}…`);
      timer = setTimer(() => {
        if (version === generation && !ready) emit('unconfirmed', `Video playback has not been confirmed by ${PROVIDERS[provider].name}. ${provider === 'cinemaos' ? 'Try VidLink if the player is not working.' : 'Press Play or retry if the player is not working.'}`);
      }, 20000);
      container.append(frame);
    }
    const receive = event => {
      if (!media || !frame) return;
      const update = playbackEvent(event, frame, media, provider);
      if (!update) return;
      seconds = update.seconds;
      measuredAt = now();
      if (update.playing !== undefined) playing = update.playing;
      if (update.event === 'play') playing = true;
      if (['pause','ended'].includes(update.event)) playing = false;
      if (!ready && (update.duration > 0 || update.seconds > 0)) {
        ready = true; clearTimer(timer); timer = null;
        emit('ready', `${PROVIDERS[provider].name} is responding with video status.`);
      }
      emit(update.event, `${PROVIDERS[provider].name}: ${update.event} at ${Math.floor(seconds)} seconds.`);
    };
    windowImpl.addEventListener('message', receive);
    return {
      load,
      command: sendCommand,
      requestStatus() { return sendCommand('getStatus'); },
      getStatus() { return { ready, playing, seconds: seconds + (playing ? Math.max(0, now() - measuredAt) / 1000 : 0), provider }; },
      switchProvider(next) { if (!media) throw new Error('Choose a title first.'); load(media, next, seconds); },
      retry() { if (media) load(media, provider, seconds); },
      clear() { removeFrame(); media = null; seconds = 0; ready = false; playing = false; provider = 'cinemaos'; emit('idle', 'Choose Watch on a movie or TV episode to open CinemaOS.'); },
      destroy() { this.clear(); windowImpl.removeEventListener('message', receive); }
    };
  }
  const api = { PROVIDERS, embedUrl, playbackEvent, createPlayer };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MultiplayPlayer = api;
})(typeof window !== 'undefined' ? window : globalThis);
