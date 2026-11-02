(function (root) {
  'use strict';
  const MAX_POSITION = 604800000;
  const controllable = provider => ['vidspark', 'vidrift', 'vidbolt', 'cinesrc', 'cinemaos'].includes(provider);
  function intendedPosition(state, now = Date.now()) {
    return Math.min(MAX_POSITION, Math.max(0, state.positionMs + (state.status === 'playing' ? Math.max(0, now + (state.offset || 0) - Date.parse(state.anchorAt)) : 0)));
  }
  function createRoomSync({ request, player, subscribe = () => () => {}, onChange = () => {}, onError = () => {}, now = Date.now, setIntervalImpl = setInterval, clearIntervalImpl = clearInterval }) {
    let roomId = null, state = null, joined = false, generation = 0, fetching = false, refreshQueued = false;
    let stopSubscription = () => {}, poll = null, correction = null, loadedKey = null, busy = false, online = false, lastCommandAt = 0;
    let pendingCommand = null, preparationKey = null, pauseIssued = false;
    let clientId = null, reporting = false, reportQueued = false, lastReport = null;
    let nativeQueue = [], nativeSending = false, nativeBlocked = false;
    const epochKey = () => state ? `${state.sessionId}:${state.provider}:${state.readyEpoch}` : '';
    function localReady() {
      const actual = player.getStatus();
      if (nativeQueue.length || nativeSending || nativeBlocked) return false;
      return preparationKey === epochKey() && actual.ready && actual.playable !== false && !actual.buffering && !actual.seekPending &&
        (state.status === 'playing' || Math.abs(actual.seconds - intendedPosition(state, now()) / 1000) <= 2);
    }
    const emit = () => onChange({ roomId, state, joined, busy, online,
      localReady: !!(joined && state && localReady()),
      canControl: !!(joined && online && !busy && state?.sessionId && controllable(state.provider)) });
    function safePause() { if (controllable(state?.provider)) player.command('pause'); }
    function reconcile() {
      if (!joined || !state?.media) { emit(); return; }
      const key = `${state.sessionId}:${state.provider}`;
      if (loadedKey !== key) {
        loadedKey = key; preparationKey = null; pauseIssued = false;
        player.load(state.media, state.provider, intendedPosition(state, now()) / 1000);
      }
      const actual = player.getStatus();
      if (!controllable(state.provider)) { emit(); return; }
      // Do not correct a native action back to the old anchor while its room command is pending.
      if (nativeQueue.length || nativeSending || nativeBlocked) {
        if (actual.playing && actual.playable !== false) safePause();
        emit(); return;
      }
      const seconds = intendedPosition(state, now()) / 1000;
      const gated = !online || state.status !== 'playing' || !state.readiness?.bothReady || preparationKey !== epochKey();
      if (gated) {
        // Prepare against one frozen anchor. Never chase a running clock while loading.
        if (state.status === 'paused' && actual.ready && !actual.buffering && !actual.seekPending && preparationKey !== epochKey()) {
          preparationKey = epochKey(); pauseIssued = true;
          safePause();
          if (Math.abs(actual.seconds - seconds) > 0.5 || actual.playable === false) player.command('seek', { time: seconds });
          lastCommandAt = now();
        }
        if (state.status === 'paused' && actual.ready && actual.playable !== false && !actual.buffering && !actual.seekPending &&
            preparationKey === epochKey() && Math.abs(actual.seconds - seconds) > 2 && now() - lastCommandAt > 1500) {
          safePause(); player.command('seek', { time: seconds }); lastCommandAt = now();
        }
        // Allow a native user gesture to produce its first time sample, then hold.
        if ((!pauseIssued || actual.playing && actual.playable !== false && now() - lastCommandAt > 1500) && !actual.seekPending) {
          safePause(); pauseIssued = true; lastCommandAt = now();
        }
      } else if (actual.ready && !actual.buffering && !actual.seekPending && now() - lastCommandAt > 1500) {
        const drift = Math.abs(actual.seconds - seconds);
        if (drift > 2) { safePause(); player.command('seek', { time: seconds }); }
        if (!actual.playing && drift <= 2) player.command('play');
        if (drift > 2 || !actual.playing) lastCommandAt = now();
      }
      emit();
      void reportReadiness();
    }
    function accept(next, started) {
      if (!next || next.roomId !== roomId || !Number.isSafeInteger(next.revision) || next.revision < 0 || !Number.isFinite(Date.parse(next.serverTime)) || !Number.isFinite(Date.parse(next.anchorAt))) return;
      if (!Number.isSafeInteger(next.readyEpoch) || !next.readiness) {
        online = false; safePause(); emit(); onError('Readiness setup required: run the updated backend/playback.sql in Supabase SQL Editor.'); return;
      }
      if (state && (next.revision < state.revision || next.revision === state.revision && Date.parse(next.serverTime) < Date.parse(state.serverTime))) return;
      if (state && next.status === 'playing' && next.revision > state.revision) lastCommandAt = -Infinity;
      state = { ...next, offset: Date.parse(next.serverTime) - (started + now()) / 2 };
      online = true; reconcile();
    }
    async function reportReadiness(force = false) {
      if (!joined || !online || !clientId || !state?.sessionId || !controllable(state.provider)) return;
      if (nativeQueue.length || nativeSending) return;
      const body = { clientId, sessionId: state.sessionId, provider: state.provider, epoch: state.readyEpoch, ready: !!localReady(), joined: true };
      const signature = JSON.stringify(body);
      if (!force && lastReport?.signature === signature && now() - lastReport.at < 2000) return;
      if (reporting) { reportQueued = true; return; }
      const version = generation, selected = roomId, connection = clientId, started = now();
      reporting = true; lastReport = { signature, at: now() };
      try {
        const next = await request(`/api/rooms/${selected}/readiness`, 'POST', body);
        if (version === generation && connection === clientId && joined) accept(next, started);
      } catch (error) {
        if (version === generation && connection === clientId && joined) { safePause(); online = false; emit(); onError(error.message); }
      } finally {
        if (version === generation && connection === clientId) {
          reporting = false;
          if (reportQueued) { reportQueued = false; void reportReadiness(); }
        }
      }
    }
    function release() {
      if (!joined || !clientId || !state?.sessionId || !controllable(state.provider)) return;
      const body = { clientId, sessionId: state.sessionId, provider: state.provider, epoch: state.readyEpoch, ready: false, joined: false };
      void request(`/api/rooms/${roomId}/readiness`, 'POST', body).catch(() => {});
    }
    async function refresh() {
      if (!roomId) return;
      if (fetching) { refreshQueued = true; return; }
      const version = generation, selected = roomId, started = now(); fetching = true;
      try {
        const next = await request(`/api/rooms/${selected}/state`);
        if (version === generation) accept(next, started);
      } catch (error) {
        if (version === generation) { if (joined) safePause(); online = false; emit(); onError(error.message); }
      } finally {
        if (version === generation) { fetching = false; if (refreshQueued) { refreshQueued = false; void refresh(); } }
      }
    }
    function selectRoom(id) {
      release(); generation++; stopSubscription(); clearIntervalImpl(poll); clearIntervalImpl(correction);
      roomId = id || null; state = null; joined = false; loadedKey = null; online = false; busy = false;
      fetching = false; refreshQueued = false; pendingCommand = null; preparationKey = null; pauseIssued = false;
      clientId = null; reporting = false; reportQueued = false; lastReport = null;
      nativeQueue = []; nativeSending = false; nativeBlocked = false;
      player.clear(); emit();
      if (!roomId) return;
      const version = generation;
      stopSubscription = subscribe(roomId, () => { if (version === generation) void refresh(); });
      poll = setIntervalImpl(() => void refresh(), 3000);
      correction = setIntervalImpl(() => {
        if (joined && online) { player.requestStatus(); reconcile(); void reportReadiness(true); }
      }, 2000);
      void refresh();
    }
    async function send(route, body) {
      if (!roomId || !state || !online) throw new Error('Load the room playback state first.');
      if (busy) throw new Error('Wait for the current playback command.');
      const version = generation, selected = roomId, started = now(); busy = true; emit();
      pendingCommand = { route, body };
      try {
        const next = await request(`/api/rooms/${selected}/${route}`, 'POST', body);
        if (version !== generation) return;
        pendingCommand = null; accept(next, started);
      } catch (error) {
        if (version !== generation) return;
        if (error.state) { pendingCommand = null; accept(error.state, started); }
        throw error;
      } finally { if (version === generation) { busy = false; emit(); void drainNative(); } }
    }
    const commandId = () => root.crypto.randomUUID();
    function ensureJoined() { if (!joined) { clientId = commandId(); lastReport = null; reporting = false; reportQueued = false; } joined = true; }
    async function command(action, extra = {}) {
      if (!joined || !state?.sessionId) throw new Error('Join this playback session first.');
      if (action !== 'provider' && !controllable(state.provider)) throw new Error('Shared controls require VidSpark, VidRift, VidBolt, CineSrc or CinemaOS.');
      if (nativeBlocked) throw new Error('Retry the last playback command before sending another action.');
      return send('commands', { commandId: commandId(), expectedRevision: state.revision, sessionId: state.sessionId, action, ...extra });
    }
    async function drainNative() {
      if (nativeSending || nativeBlocked || busy || !online || !joined || !nativeQueue.length) return;
      const version = generation, connection = clientId;
      nativeSending = true;
      try {
        while (nativeQueue.length && version === generation && connection === clientId && joined) {
          const intent = nativeQueue.shift();
          if (intent.sessionId !== state.sessionId || intent.provider !== state.provider) { nativeQueue = []; break; }
          if (intent.action === 'play' && state.playRequested || intent.action === 'pause' && !state.playRequested) continue;
          await command(intent.action, intent.action === 'seek' ? { targetPositionMs: Math.round(intent.seconds * 1000) } : {});
        }
      } catch (error) {
        if (version === generation && connection === clientId) {
          nativeQueue = []; nativeBlocked = !!pendingCommand;
          safePause(); onError(error.message);
        }
      } finally {
        if (version === generation && connection === clientId) { nativeSending = false; reconcile(); }
      }
    }
    function queueNative(intent) {
      if (!intent || !['play','pause','seek'].includes(intent.action) || nativeBlocked) return;
      if (intent.action === 'seek' && (!Number.isFinite(intent.seconds) || intent.seconds < 0 || intent.seconds * 1000 > MAX_POSITION)) return;
      const next = { action: intent.action, seconds: intent.seconds, sessionId: state.sessionId, provider: state.provider };
      // Coalesce repeated scrubbing samples; preserve the order of Play / Seek / Pause.
      if (nativeQueue.at(-1)?.action === next.action) nativeQueue[nativeQueue.length - 1] = next;
      else if (nativeQueue.length < 32) nativeQueue.push(next);
      void drainNative();
    }
    return {
      selectRoom, refresh, command,
      async watch(media) {
        if (!state || !online) throw new Error('Playback is not ready. Refresh the room or apply the playback migration.');
        ensureJoined(); emit(); await send('media', { ...media, commandId: commandId(), expectedRevision: state.revision });
      },
      join() { if (!state?.media) throw new Error('Choose a title first.'); ensureJoined(); reconcile(); },
      leave() { release(); joined = false; clientId = null; reporting = false; reportQueued = false; lastReport = null; nativeQueue = []; nativeSending = false; nativeBlocked = false; loadedKey = null; preparationKey = null; player.clear(); emit(); },
      retryPlayer() { if (joined && state?.media) { loadedKey = null; preparationKey = null; pauseIssued = false; reconcile(); } },
      async retryCommand() {
        if (!pendingCommand) return;
        try { await send(pendingCommand.route, pendingCommand.body); }
        finally { if (!pendingCommand) nativeBlocked = false; reconcile(); }
      },
      playerEvent(event) {
        if (!joined || !state || !online) { emit(); return; }
        // Only adapter-classified native actions become commands; acknowledgements only update readiness.
        if (event.provider !== state.provider) return;
        if (controllable(event.provider)) { queueNative(event.nativeIntent); reconcile(); } else emit();
      },
      destroy() { selectRoom(null); }
    };
  }
  const api = { intendedPosition, createRoomSync };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MultiplaySync = api;
})(typeof window !== 'undefined' ? window : globalThis);
