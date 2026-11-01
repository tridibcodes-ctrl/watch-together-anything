(function (root) {
  'use strict';
  const PROVIDERS = Object.freeze({
    cinesrc: { name: 'CineSrc', origin: 'https://cinesrc.st', controls: true },
    cinemaos: { name: 'CinemaOS', origin: 'https://cinemaos.tech', controls: true },
    vidlink: { name: 'VidLink', origin: 'https://vidlink.pro', controls: false }
  });
  const position = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 604800;
  function validateMedia(media) {
    if (!media || !['movie', 'tv'].includes(media.mediaType) || !Number.isSafeInteger(media.tmdbId) || media.tmdbId < 1) throw new Error('Choose a valid movie or TV show.');
    if (media.mediaType === 'tv' && (!Number.isInteger(media.season) || media.season < 0 || !Number.isInteger(media.episode) || media.episode < 1)) throw new Error('Choose a TV season and episode.');
  }
  function embedUrl(media, provider, seconds = 0) {
    validateMedia(media);
    if (!Object.hasOwn(PROVIDERS, provider)) throw new Error('Unknown player provider.');
    const start = position(seconds) ? Math.floor(seconds) : 0;
    if (provider === 'cinesrc') {
      const url = new URL(`/embed/${media.mediaType}/${media.tmdbId}`, PROVIDERS.cinesrc.origin);
      if (media.mediaType === 'tv') { url.searchParams.set('s', media.season); url.searchParams.set('e', media.episode); }
      for (const key of ['autoplay', 'autonext', 'autoskip', 'continueprompt']) url.searchParams.set(key, 'false');
      url.searchParams.set('t', String(start));
      return url.href;
    }
    const suffix = media.mediaType === 'tv' ? `/${media.season}/${media.episode}` : '';
    const path = provider === 'cinemaos' ? `/player/${media.tmdbId}${suffix}` : `/${media.mediaType}/${media.tmdbId}${suffix}`;
    const url = new URL(path, PROVIDERS[provider].origin);
    if (provider === 'cinemaos') {
      url.searchParams.set('autoPlay', 'false'); url.searchParams.set('autoNext', 'false');
    } else {
      url.searchParams.set('autoplay', 'false'); url.searchParams.set('nextbutton', 'false'); url.searchParams.set('startAt', String(start));
    }
    return url.href;
  }
  function playbackEvent(event, frame, media, provider) {
    if (!Object.hasOwn(PROVIDERS, provider) || event.origin !== PROVIDERS[provider].origin || event.source !== frame?.contentWindow) return null;
    let payload = event.data;
    if (typeof payload === 'string') {
      if (payload.length > 10000) return null;
      try { payload = JSON.parse(payload); } catch { return null; }
    }
    if (provider === 'cinesrc') {
      if (!payload || typeof payload !== 'object') return null;
      const type = payload.type;
      if (type === 'cinesrc:ready') return { event: 'playerstatus', requestStatus: true };
      if (type === 'cinesrc:nextepisode') return media.mediaType !== 'tv' || Number(payload.season) !== media.season || Number(payload.episode) !== media.episode ? { event: 'mismatch' } : null;
      if (type === 'cinesrc:error') return { event: 'error' };
      if (type === 'cinesrc:response') {
        if (payload.command === 'getCurrentTime' && position(payload.result)) return { event: 'playerstatus', seconds: payload.result };
        if (payload.command === 'getDuration' && position(payload.result) && payload.result > 0) return { event: 'playerstatus', duration: payload.result };
        if (payload.command === 'getPaused' && typeof payload.result === 'boolean') return { event: 'playerstatus', playing: !payload.result };
        return null;
      }
      if (type === 'cinesrc:loadedmetadata') return position(payload.duration) && payload.duration > 0 ? { event: 'playerstatus', duration: payload.duration, requestStatus: true } : null;
      const kind = typeof type === 'string' ? type.replace(/^cinesrc:/, '') : '';
      if (type !== 'cinesrc:' + kind || !['play','pause','seeking','seeked','timeupdate','ended'].includes(kind)) return null;
      if (['timeupdate','seeked'].includes(kind) && !position(payload.currentTime)) return null;
      return { event: kind, ...(position(payload.currentTime) ? { seconds: payload.currentTime } : {}),
        ...(position(payload.duration) ? { duration: payload.duration } : {}),
        ...(['play','pause','ended'].includes(kind) ? { playing: kind === 'play' } : {}) };
    }
    const data = payload?.data;
    if (payload?.type !== 'PLAYER_EVENT' || !data || !['play', 'pause', 'seeking', 'seeked', 'ended', 'timeupdate', 'playerstatus'].includes(data.event)) return null;
    const id = data.mtmdbId ?? data.tmdbId;
    if ((provider === 'vidlink' || id !== undefined) && Number(id) !== media.tmdbId) return null;
    if ((provider === 'vidlink' || data.mediaType !== undefined) && data.mediaType !== media.mediaType) return null;
    if (media.mediaType === 'tv' && ((provider === 'vidlink' || data.season !== undefined) && Number(data.season) !== media.season || (provider === 'vidlink' || data.episode !== undefined) && Number(data.episode) !== media.episode)) return null;
    if (!position(data.currentTime)) return null;
    return { event: data.event, seconds: data.currentTime,
      duration: typeof data.duration === 'number' && Number.isFinite(data.duration) ? data.duration : 0,
      playing: typeof data.paused === 'boolean' ? !data.paused : typeof data.playing === 'boolean' ? data.playing : typeof data.isPlaying === 'boolean' ? data.isPlaying : undefined };
  }
  function createPlayer({ container, onState = () => {}, onFallback, windowImpl = window, documentImpl = document, setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now }) {
    let frame = null, media = null, provider = 'cinesrc', seconds = 0, timer = null, generation = 0, ready = false, playing = false, measuredAt = now(), mediaMismatch = false;
    let playable = false, pendingSeek = null, lastAdvanceAt = now(), lastStatusAt = now(), playAttemptAt = null, playBlocked = false, lastProgressSeconds = 0;
    const emit = (status, message) => onState({ media, provider, seconds, ready, playing, playable, status, message });
    function sendCommand(command, params = {}) {
      if (!frame?.contentWindow || !PROVIDERS[provider].controls || (!['getStatus','pause'].includes(command) && !ready)) return false;
      if (!['play','pause','seek','getStatus'].includes(command)) return false;
      if (command === 'seek' && !position(params.time)) return false;
      if (command === 'play' && !playing && playAttemptAt === null) playAttemptAt = now();
      if (command === 'seek') pendingSeek = { target: params.time, at: now() };
      if (provider === 'cinesrc') {
        const send = (name, args = []) => frame.contentWindow.postMessage({ type: 'cinesrc:command', command: name, args }, PROVIDERS.cinesrc.origin);
        if (command === 'getStatus') for (const getter of ['getCurrentTime','getDuration','getPaused']) send(getter);
        else send(command, command === 'seek' ? [params.time] : []);
      } else {
        frame.contentWindow.postMessage({ command, ...(command === 'seek' ? { time: params.time } : {}) }, PROVIDERS.cinemaos.origin);
      }
      return true;
    }
    function removeFrame() {
      generation++; clearTimer(timer); timer = null;
      if (frame) { frame.onload = null; frame.onerror = null; }
      frame = null; container.replaceChildren();
    }
    function load(nextMedia, nextProvider = 'cinesrc', startSeconds = 0) {
      const src = embedUrl(nextMedia, nextProvider, startSeconds);
      removeFrame(); media = { ...nextMedia }; provider = nextProvider;
      ready = false; playing = false; playable = false; pendingSeek = null; mediaMismatch = false; measuredAt = now(); lastStatusAt = now(); lastAdvanceAt = now(); playAttemptAt = null; playBlocked = false;
      seconds = provider !== 'cinemaos' && position(startSeconds) ? startSeconds : 0;
      lastProgressSeconds = seconds;
      const version = generation;
      frame = documentImpl.createElement('iframe');
      frame.title = `${media.title || 'Selected title'} — ${PROVIDERS[provider].name}`;
      frame.width = '100%'; frame.height = '360'; frame.allow = 'autoplay; fullscreen; picture-in-picture; encrypted-media';
      frame.allowFullscreen = true; frame.referrerPolicy = 'strict-origin-when-cross-origin';
      frame.onload = () => {
        if (version !== generation) return;
        emit('loaded', `${PROVIDERS[provider].name} frame loaded; video playback is not confirmed. Press Play inside the player if needed.`);
        sendCommand('getStatus');
      };
      frame.onerror = () => {
        if (version !== generation) return;
        if (provider !== 'vidlink') {
          if (onFallback) { clearTimer(timer); timer = null; onFallback(); return; }
          load(media, 'vidlink', seconds); emit('loading', 'Player could not load. Trying VidLink with manual controls.');
        } else { clearTimer(timer); timer = null; emit('error', 'VidLink could not load. Retry or choose another title.'); }
      };
      frame.src = src; emit('loading', `Loading ${PROVIDERS[provider].name}…`);
      timer = setTimer(() => {
        if (version === generation && !ready) emit('unconfirmed', `No video status from ${PROVIDERS[provider].name}. Press native Play, reload, or choose another provider. VidLink fallback is manual.`);
      }, 20000);
      container.append(frame);
    }
    const receive = event => {
      if (!media || !frame || mediaMismatch) return;
      const update = playbackEvent(event, frame, media, provider);
      if (!update) return;
      if (update.event === 'mismatch') { mediaMismatch = true; ready = false; emit('error', 'Player changed episode locally. Reload the player to return to the room episode.'); return; }
      if (update.event === 'error') { ready = false; emit('error', `${PROVIDERS[provider].name} reported a playback error. Reload or choose another provider.`); return; }
      const previouslyPlaying = playing;
      lastStatusAt = now();
      if (typeof update.seconds === 'number' && update.seconds > lastProgressSeconds + 0.1) {
        lastAdvanceAt = now(); lastProgressSeconds = update.seconds; if (ready || update.duration > 0) playable = true;
      }
      if (update.event === 'seeking' && !pendingSeek) pendingSeek = { target: update.seconds ?? seconds, at: now() };
      if (pendingSeek && typeof update.seconds === 'number' && Math.abs(update.seconds - pendingSeek.target) <= 1 && update.event !== 'seeking') {
        pendingSeek = null; playable = true; lastAdvanceAt = now(); lastProgressSeconds = update.seconds;
      }
      if (['timeupdate','seeked'].includes(update.event) && (ready || update.duration > 0)) playable = true;
      seconds = update.seconds ?? (seconds + (playing ? Math.max(0, now() - measuredAt) / 1000 : 0)); measuredAt = now();
      if (update.playing !== undefined) playing = update.playing;
      if (update.event === 'play') playing = true;
      if (['pause','ended'].includes(update.event)) playing = false;
      if (playing) { playAttemptAt = null; playBlocked = false; }
      if (playing && !previouslyPlaying) lastAdvanceAt = now();
      if (!ready && (update.duration > 0 || update.seconds > 0)) {
        ready = true; clearTimer(timer); timer = null; emit('ready', `${PROVIDERS[provider].name} is responding with video status.`);
      }
      if (update.requestStatus) sendCommand('getStatus');
      emit(update.event, `${PROVIDERS[provider].name}: ${update.event} at ${Math.floor(seconds)} seconds.`);
    };
    windowImpl.addEventListener('message', receive);
    return {
      load, command: sendCommand,
      requestStatus() { return sendCommand('getStatus'); },
      getStatus() {
        if (!playing && playAttemptAt !== null && now() - playAttemptAt > 4000) playBlocked = true;
        const buffering = playBlocked || !ready || (playing && now() - lastAdvanceAt > 4000) || (pendingSeek && now() - pendingSeek.at > 4000) || (ready && now() - lastStatusAt > 8000);
        return { ready, playable, playing, needsGesture: playBlocked, buffering: !!buffering, seekPending: !!pendingSeek,
          seconds: seconds + (playing && !buffering && !pendingSeek ? Math.max(0, now() - measuredAt) / 1000 : 0), provider };
      },
      switchProvider(next) { if (!media) throw new Error('Choose a title first.'); load(media, next, seconds); },
      retry() { if (media) load(media, provider, seconds); },
      clear() { removeFrame(); media = null; seconds = 0; ready = false; playing = false; playable = false; pendingSeek = null; playAttemptAt = null; playBlocked = false; provider = 'cinesrc'; emit('idle', 'Choose Watch on a movie or TV episode to open CineSrc.'); },
      destroy() { this.clear(); windowImpl.removeEventListener('message', receive); }
    };
  }
  const api = { PROVIDERS, embedUrl, playbackEvent, createPlayer };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MultiplayPlayer = api;
})(typeof window !== 'undefined' ? window : globalThis);
