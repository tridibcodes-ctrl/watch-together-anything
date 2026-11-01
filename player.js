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

  // VidLink documents playback notifications, but no remote control commands.
  function playbackEvent(event, frame, media, provider) {
    if (provider !== 'vidlink' || event.origin !== PROVIDERS.vidlink.origin || event.source !== frame?.contentWindow) return null;
    let payload = event.data;
    if (typeof payload === 'string') {
      if (payload.length > 10000) return null;
      try { payload = JSON.parse(payload); } catch { return null; }
    }
    const data = payload?.data;
    if (payload?.type !== 'PLAYER_EVENT' || !data || !['play', 'pause', 'seeked', 'ended', 'timeupdate'].includes(data.event)) return null;
    if (Number(data.mtmdbId) !== media.tmdbId || data.mediaType !== media.mediaType) return null;
    if (media.mediaType === 'tv' && (Number(data.season) !== media.season || Number(data.episode) !== media.episode)) return null;
    if (typeof data.currentTime !== 'number' || !Number.isFinite(data.currentTime) || data.currentTime < 0 || data.currentTime > 604800) return null;
    return { event: data.event, seconds: data.currentTime };
  }

  function createPlayer({ container, onState = () => {}, windowImpl = window, documentImpl = document, setTimer = setTimeout, clearTimer = clearTimeout }) {
    let frame = null, media = null, provider = 'cinemaos', seconds = 0, timer = null, generation = 0;
    const emit = (status, message) => onState({ media, provider, seconds, status, message });
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
      seconds = provider === 'vidlink' && Number.isFinite(startSeconds) && startSeconds >= 0 ? startSeconds : 0;
      const version = generation;
      frame = documentImpl.createElement('iframe');
      frame.title = `${media.title || 'Selected title'} — ${PROVIDERS[provider].name}`;
      frame.width = '100%'; frame.height = '360';
      frame.allow = 'autoplay; fullscreen; picture-in-picture; encrypted-media';
      frame.allowFullscreen = true;
      frame.referrerPolicy = 'strict-origin-when-cross-origin';
      frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-presentation');
      frame.onload = () => {
        if (version !== generation) return;
        clearTimer(timer); timer = null;
        emit('loaded', `${PROVIDERS[provider].name} frame loaded. Press Play inside the player. If it stays blank or cannot play, ${provider === 'cinemaos' ? 'try VidLink below' : 'retry or choose another title'}.`);
      };
      frame.onerror = () => {
        if (version !== generation) return;
        if (provider === 'cinemaos') {
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
        if (version === generation) emit('unconfirmed', `No frame-load confirmation from ${PROVIDERS[provider].name}. ${provider === 'cinemaos' ? 'Try VidLink if the player is not working.' : 'Retry if the player is not working.'}`);
      }, 20000);
      container.append(frame);
    }
    const receive = event => {
      if (!media || !frame) return;
      const update = playbackEvent(event, frame, media, provider);
      if (!update) return;
      clearTimer(timer); timer = null;
      seconds = update.seconds;
      emit(update.event, `${PROVIDERS[provider].name}: ${update.event} at ${Math.floor(seconds)} seconds.`);
    };
    windowImpl.addEventListener('message', receive);
    return {
      load,
      switchProvider(next) { if (!media) throw new Error('Choose a title first.'); load(media, next, seconds); },
      retry() { if (media) load(media, provider, seconds); },
      clear() { removeFrame(); media = null; seconds = 0; provider = 'cinemaos'; emit('idle', 'Choose Watch on a movie or TV episode to open CinemaOS.'); },
      destroy() { this.clear(); windowImpl.removeEventListener('message', receive); }
    };
  }
  const api = { PROVIDERS, embedUrl, playbackEvent, createPlayer };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MultiplayPlayer = api;
})(typeof window !== 'undefined' ? window : globalThis);
