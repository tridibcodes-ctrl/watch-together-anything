(function (root) {
  'use strict';
  const PROVIDERS = Object.freeze({
    vidspark: { name: 'VidSpark', origin: 'https://vidspark.to', controls: true },
    vidrift: { name: 'VidRift', origin: 'https://embed.vidrift.net', controls: true },
    vidbolt: { name: 'VidBolt', origin: 'https://vidbolt.pro', controls: true, pushOnly: true },
    cinesrc: { name: 'CineSrc', origin: 'https://cinesrc.st', controls: true },
    cinemaos: { name: 'CinemaOS', origin: 'https://cinemaos.tech', controls: true }
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
    if (['vidspark', 'vidrift', 'vidbolt'].includes(provider)) {
      const suffix = media.mediaType === 'tv' ? `/${media.season}/${media.episode}` : '';
      const url = new URL(`${provider === 'vidrift' ? '/embed' : ''}/${media.mediaType}/${media.tmdbId}${suffix}`, PROVIDERS[provider].origin);
      if (provider === 'vidspark') url.searchParams.set('t', String(start));
      if (provider === 'vidrift') url.searchParams.set('autoplay', '0');
      return url.href;
    }
    if (provider === 'cinesrc') {
      const url = new URL(`/embed/${media.mediaType}/${media.tmdbId}`, PROVIDERS.cinesrc.origin);
      if (media.mediaType === 'tv') { url.searchParams.set('s', media.season); url.searchParams.set('e', media.episode); }
      for (const key of ['autoplay', 'autonext', 'autoskip', 'continueprompt']) url.searchParams.set(key, 'false');
      url.searchParams.set('t', String(start));
      return url.href;
    }
    const suffix = media.mediaType === 'tv' ? `/${media.season}/${media.episode}` : '';
    const url = new URL(`/player/${media.tmdbId}${suffix}`, PROVIDERS.cinemaos.origin);
    url.searchParams.set('autoPlay', 'false'); url.searchParams.set('autoNext', 'false');
    return url.href;
  }
  function playbackEvent(event, frame, media, provider) {
    if (!Object.hasOwn(PROVIDERS, provider) || event.origin !== PROVIDERS[provider].origin || event.source !== frame?.contentWindow) return null;
    let payload = event.data;
    if (typeof payload === 'string') {
      if (payload.length > 10000) return null;
      try { payload = JSON.parse(payload); } catch { return null; }
    }
    if (!payload || typeof payload !== 'object') return null;
    if (provider === 'vidspark') {
      if (payload.source !== 'vidspark-player' || !['play','pause','seeked','timeupdate','ended','playerstatus'].includes(payload.event) || !position(payload.currentTime)) return null;
      return { event: payload.event, seconds: payload.currentTime,
        ...(position(payload.duration) ? { duration: payload.duration } : {}),
        ...(typeof payload.paused === 'boolean' ? { playing: !payload.paused } : {}) };
    }
    if (provider === 'vidrift') {
      const kinds = { 'vidrift:state': 'playerstatus', 'vidrift:progress': 'timeupdate', 'vidrift:unpaused': 'play', 'vidrift:paused': 'pause', 'vidrift:ended': 'ended', 'vidrift:episode': 'episode' };
      if (!Object.hasOwn(kinds, payload.type)) return null;
      if (Number(payload.tmdbId) !== media.tmdbId || payload.mediaType !== media.mediaType || media.mediaType === 'tv' && (Number(payload.season) !== media.season || Number(payload.episode) !== media.episode)) return { event: 'mismatch' };
      if (kinds[payload.type] === 'episode') return null;
      if (!position(payload.currentTime)) return null;
      return { event: kinds[payload.type], seconds: payload.currentTime,
        ...(position(payload.duration) ? { duration: payload.duration } : {}),
        ...(typeof payload.paused === 'boolean' ? { playing: !payload.paused } : {}) };
    }
    if (provider === 'vidbolt') {
      if (payload.type === 'ready') return { event: 'playerstatus' };
      if (payload.type === 'durationchange') return position(payload.duration) && payload.duration > 0 ? { event: 'playerstatus', duration: payload.duration } : null;
      if (!['play','pause','timeupdate','ended'].includes(payload.type)) return null;
      if (payload.type === 'timeupdate' && !position(payload.time)) return null;
      return { event: payload.type, ...(position(payload.time) ? { seconds: payload.time } : {}) };
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
    if (id !== undefined && Number(id) !== media.tmdbId) return null;
    if (data.mediaType !== undefined && data.mediaType !== media.mediaType) return null;
    if (media.mediaType === 'tv' && (data.season !== undefined && Number(data.season) !== media.season || data.episode !== undefined && Number(data.episode) !== media.episode)) return null;
    if (!position(data.currentTime)) return null;
    return { event: data.event, seconds: data.currentTime,
      duration: typeof data.duration === 'number' && Number.isFinite(data.duration) ? data.duration : 0,
      playing: typeof data.paused === 'boolean' ? !data.paused : typeof data.playing === 'boolean' ? data.playing : typeof data.isPlaying === 'boolean' ? data.isPlaying : undefined };
  }
  function createPlayer({ container, onState = () => {}, windowImpl = window, documentImpl = document, setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now }) {
    let frame = null, media = null, provider = 'vidrift', seconds = 0, timer = null, generation = 0, ready = false, playing = false, measuredAt = now(), mediaMismatch = false;
    let playable = false, pendingSeek = null, lastAdvanceAt = now(), lastStatusAt = now(), playAttemptAt = null, playBlocked = false, lastProgressSeconds = 0;
    let expectedPlayback = [], seekEcho = null, sample = null, nativeSeek = null, seekTimer = null, duration = 0, activatedAt = null;
    const emit = (status, message, nativeIntent) => onState({ media, provider, seconds, ready, playing, playable, status, message, ...(nativeIntent ? { nativeIntent } : {}) });
    function sendCommand(command, params = {}) {
      if (!frame?.contentWindow || !PROVIDERS[provider].controls || (!['getStatus','pause'].includes(command) && !ready)) return false;
      if (!['play','pause','seek','getStatus'].includes(command)) return false;
      if (command === 'seek' && !position(params.time)) return false;
      if (command === 'getStatus' && PROVIDERS[provider].pushOnly) return false;
      if (['play','pause'].includes(command) && (playing !== (command === 'play') || !ready)) {
        expectedPlayback = expectedPlayback.filter(item => now() - item.at < 6000);
        expectedPlayback.push({ playing: command === 'play', at: now() });
        expectedPlayback = expectedPlayback.slice(-8);
      }
      if (command === 'play' && !playing && playAttemptAt === null) playAttemptAt = now();
      if (command === 'seek') { pendingSeek = { target: params.time, at: now() }; seekEcho = { ...pendingSeek }; }
      const post = message => frame.contentWindow.postMessage(message, PROVIDERS[provider].origin);
      if (provider === 'cinesrc') {
        const send = (name, args = []) => frame.contentWindow.postMessage({ type: 'cinesrc:command', command: name, args }, PROVIDERS.cinesrc.origin);
        if (command === 'getStatus') for (const getter of ['getCurrentTime','getDuration','getPaused']) send(getter);
        else send(command, command === 'seek' ? [params.time] : []);
      } else if (provider === 'vidspark') post({ action: command, ...(command === 'seek' ? { time: params.time } : {}) });
      else if (provider === 'vidrift') post(command === 'seek' ? { type: 'vidrift:resume', currentTime: params.time } : { type: 'vidrift:' + (command === 'getStatus' ? 'get-state' : command) });
      else if (provider === 'vidbolt') post({ type: command, ...(command === 'seek' ? { time: params.time } : {}) });
      else post({ command, ...(command === 'seek' ? { time: params.time } : {}) });
      return true;
    }
    function removeFrame() {
      generation++; clearTimer(timer); clearTimer(seekTimer); timer = null; seekTimer = null; nativeSeek = null;
      if (frame) { frame.onload = null; frame.onerror = null; }
      frame = null; container.replaceChildren();
    }
    function load(nextMedia, nextProvider = 'vidrift', startSeconds = 0) {
      const src = embedUrl(nextMedia, nextProvider, startSeconds);
      removeFrame(); media = { ...nextMedia }; provider = nextProvider;
      ready = false; playing = false; playable = false; pendingSeek = null; mediaMismatch = false; measuredAt = now(); lastStatusAt = now(); lastAdvanceAt = now(); playAttemptAt = null; playBlocked = false;
      expectedPlayback = []; seekEcho = null; sample = null; duration = 0; activatedAt = null;
      seconds = ['cinesrc','vidspark'].includes(provider) && position(startSeconds) ? startSeconds : 0;
      lastProgressSeconds = seconds;
      const version = generation;
      frame = documentImpl.createElement('iframe');
      frame.title = `${media.title || 'Selected title'} — ${PROVIDERS[provider].name}`;
      // Fullscreen belongs to the parent stage so its chat overlay stays visible.
      frame.width = '100%'; frame.height = '360'; frame.allow = "autoplay; fullscreen 'none'; picture-in-picture; encrypted-media";
      frame.allowFullscreen = false; frame.referrerPolicy = 'strict-origin-when-cross-origin';
      frame.onload = () => {
        if (version !== generation) return;
        emit('loaded', `${PROVIDERS[provider].name} frame loaded; video playback is not confirmed. Press Play inside the player if needed.`);
        if (provider === 'vidrift') frame.contentWindow?.postMessage({ type: 'vidrift:nextup-info', next: null }, PROVIDERS.vidrift.origin);
        sendCommand('getStatus');
      };
      frame.onerror = () => {
        if (version !== generation) return;
        clearTimer(timer); timer = null; ready = false; playable = false;
        emit('error', `${PROVIDERS[provider].name} could not load. Reload the player or choose another provider.`);
      };
      frame.src = src; emit('loading', `Loading ${PROVIDERS[provider].name}…`);
      timer = setTimer(() => {
        if (version === generation && !ready) emit('unconfirmed', `No video status from ${PROVIDERS[provider].name}. Press native Play, reload, or choose another provider.`);
      }, 20000);
      container.append(frame);
    }
    function queueNativeSeek(target) {
      nativeSeek = { target, at: now() };
      lastAdvanceAt = now(); lastProgressSeconds = target;
      clearTimer(seekTimer);
      const version = generation;
      seekTimer = setTimer(() => {
        if (version !== generation || !nativeSeek) return;
        const target = nativeSeek.target;
        nativeSeek = null; seekTimer = null;
        emit('seeked', `${PROVIDERS[provider].name}: sharing native seek.`, { action: 'seek', seconds: target });
      }, 200);
    }
    const receive = event => {
      if (!media || !frame || mediaMismatch) return;
      const update = playbackEvent(event, frame, media, provider);
      if (!update) return;
      if (update.event === 'mismatch') { mediaMismatch = true; ready = false; emit('error', 'Player changed episode locally. Reload the player to return to the room episode.'); return; }
      if (update.event === 'error') { ready = false; emit('error', `${PROVIDERS[provider].name} reported a playback error. Reload or choose another provider.`); return; }
      const previouslyPlaying = playing, wasReady = ready, wasPlayable = playable;
      const stamp = now(), stalled = playing && stamp - lastAdvanceAt > 4000;
      let nativeIntent;
      const nextPlaying = update.event === 'play' ? true : ['pause','ended'].includes(update.event) ? false : update.playing;
      expectedPlayback = expectedPlayback.filter(item => stamp - item.at < 6000);
      const ack = typeof nextPlaying === 'boolean' ? expectedPlayback.findIndex(item => item.playing === nextPlaying) : -1;
      if (ack >= 0) expectedPlayback.splice(0, ack + 1);
      // An opposite native action is still accepted while another command is awaiting acknowledgement.
      if (ack < 0 && nextPlaying !== previouslyPlaying && PROVIDERS[provider].controls) {
        if (update.event === 'play') nativeIntent = { action: 'play' };
        if (update.event === 'pause' && wasReady && wasPlayable && !stalled && !pendingSeek && !nativeSeek && !(duration > 0 && seconds >= duration - 1)) nativeIntent = { action: 'pause' };
      }
      const ownSeek = !!pendingSeek || seekEcho && stamp - seekEcho.at < 1500 && position(update.seconds) && Math.abs(update.seconds - seekEcho.target) < 2;
      const elapsed = sample ? Math.max(0, stamp - sample.at) / 1000 : 0;
      const expectedTime = sample ? sample.seconds + (sample.playing && previouslyPlaying ? elapsed : 0) : seconds;
      const jump = sample && position(update.seconds) && Math.abs(update.seconds - expectedTime) > 2;
      // Some providers restore old local progress after metadata/seek acknowledgement.
      // Establish playback first before interpreting subsequent time jumps as native seeks.
      if (PROVIDERS[provider].controls && activatedAt !== null && stamp - activatedAt >= 1000 && wasReady && wasPlayable && !ownSeek && !stalled &&
          ['seeking','seeked','timeupdate','playerstatus'].includes(update.event) && jump) queueNativeSeek(update.seconds);
      if (update.duration > 0) {
        if (duration && Math.abs(update.duration - duration) > 2) { sample = null; nativeSeek = null; clearTimer(seekTimer); }
        duration = update.duration;
      }
      lastStatusAt = now();
      if (typeof update.seconds === 'number' && update.seconds > lastProgressSeconds + 0.1) {
        lastAdvanceAt = now(); lastProgressSeconds = update.seconds; if (ready || update.duration > 0) playable = true;
      }
      if (pendingSeek && typeof update.seconds === 'number' && Math.abs(update.seconds - pendingSeek.target) <= 1 && update.event !== 'seeking') {
        pendingSeek = null; playable = true; lastAdvanceAt = now(); lastProgressSeconds = update.seconds;
      }
      if (['timeupdate','seeked'].includes(update.event) && (ready || update.duration > 0)) playable = true;
      seconds = update.seconds ?? (seconds + (playing ? Math.max(0, now() - measuredAt) / 1000 : 0)); measuredAt = now();
      if (update.playing !== undefined) playing = update.playing;
      if (update.event === 'play') playing = true;
      if (update.event === 'play' && activatedAt === null) activatedAt = stamp;
      if (['pause','ended'].includes(update.event)) playing = false;
      // Play/Pause may omit a timestamp (VidBolt). Never extrapolate across time spent paused.
      if (position(update.seconds) || previouslyPlaying !== playing) sample = { seconds, at: stamp, playing };
      if (playing) { playAttemptAt = null; playBlocked = false; }
      if (playing && !previouslyPlaying) lastAdvanceAt = now();
      if (!ready && (update.duration > 0 || update.seconds > 0)) {
        ready = true; clearTimer(timer); timer = null; emit('ready', `${PROVIDERS[provider].name} is responding with video status.`);
      }
      if (update.requestStatus) sendCommand('getStatus');
      emit(update.event, `${PROVIDERS[provider].name}: ${update.event} at ${Math.floor(seconds)} seconds.`, nativeIntent);
    };
    windowImpl.addEventListener('message', receive);
    return {
      load, command: sendCommand,
      requestStatus() { return sendCommand('getStatus'); },
      getStatus() {
        if (!playing && playAttemptAt !== null && now() - playAttemptAt > 4000) playBlocked = true;
        const buffering = playBlocked || !ready || (playing && now() - lastAdvanceAt > 4000) || (pendingSeek && now() - pendingSeek.at > 4000) || (ready && !PROVIDERS[provider].pushOnly && now() - lastStatusAt > 8000);
        return { ready, playable, playing, needsGesture: playBlocked, buffering: !!buffering, seekPending: !!(pendingSeek || nativeSeek),
          seconds: seconds + (playing && !buffering && !pendingSeek && !nativeSeek ? Math.max(0, now() - measuredAt) / 1000 : 0), provider };
      },
      switchProvider(next) { if (!media) throw new Error('Choose a title first.'); load(media, next, seconds); },
      retry() { if (media) load(media, provider, seconds); },
      clear() { removeFrame(); media = null; seconds = 0; ready = false; playing = false; playable = false; pendingSeek = null; playAttemptAt = null; playBlocked = false; expectedPlayback = []; seekEcho = null; sample = null; duration = 0; activatedAt = null; provider = 'vidrift'; emit('idle', 'Choose Watch on a movie or TV episode to open VidRift.'); },
      destroy() { this.clear(); windowImpl.removeEventListener('message', receive); }
    };
  }
  const api = { PROVIDERS, embedUrl, playbackEvent, createPlayer };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MultiplayPlayer = api;
})(typeof window !== 'undefined' ? window : globalThis);
