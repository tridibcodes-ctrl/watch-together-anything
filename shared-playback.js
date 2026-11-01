(function (root) {
  'use strict';
  const MAX_POSITION = 604800000;
  const controllable = provider => ['cinesrc', 'cinemaos'].includes(provider);
  function intendedPosition(state, now = Date.now()) {
    return Math.min(MAX_POSITION, Math.max(0, state.positionMs + (state.status === 'playing' ? Math.max(0, now + (state.offset || 0) - Date.parse(state.anchorAt)) : 0)));
  }
  function createRoomSync({ request, player, subscribe = () => () => {}, onChange = () => {}, onError = () => {}, now = Date.now, setIntervalImpl = setInterval, clearIntervalImpl = clearInterval }) {
    let roomId = null, state = null, joined = false, generation = 0, fetching = false, refreshQueued = false;
    let stopSubscription = () => {}, poll = null, correction = null, loadedKey = null, busy = false, online = false, lastCommandAt = 0;
    let pendingCommand = null, preparationKey = null, pauseIssued = false;
    let clientId = null, reporting = false, reportQueued = false, lastReport = null;
    const epochKey = () => state ? `${state.sessionId}:${state.provider}:${state.readyEpoch}` : '';
    function localReady() {
      const actual = player.getStatus();
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
      } finally { if (version === generation) { busy = false; emit(); } }
    }
    const commandId = () => root.crypto.randomUUID();
    function ensureJoined() { if (!joined) { clientId = commandId(); lastReport = null; reporting = false; reportQueued = false; } joined = true; }
    async function command(action, extra = {}) {
      if (!joined || !state?.sessionId) throw new Error('Join this playback session first.');
      if (action !== 'provider' && !controllable(state.provider)) throw new Error('Shared controls require CineSrc or CinemaOS.');
      return send('commands', { commandId: commandId(), expectedRevision: state.revision, sessionId: state.sessionId, action, ...extra });
    }
    return {
      selectRoom, refresh, command,
      async watch(media) {
        if (!state || !online) throw new Error('Playback is not ready. Refresh the room or apply the playback migration.');
        ensureJoined(); emit(); await send('media', { ...media, commandId: commandId(), expectedRevision: state.revision });
      },
      join() { if (!state?.media) throw new Error('Choose a title first.'); ensureJoined(); reconcile(); },
      leave() { release(); joined = false; clientId = null; reporting = false; reportQueued = false; lastReport = null; loadedKey = null; preparationKey = null; player.clear(); emit(); },
      retryPlayer() { if (joined && state?.media) { loadedKey = null; preparationKey = null; pauseIssued = false; reconcile(); } },
      async retryCommand() { if (pendingCommand) return send(pendingCommand.route, pendingCommand.body); },
      playerEvent(event) {
        if (!joined || !state || !online) { emit(); return; }
        // Player acknowledgements report readiness, never echo user control commands.
        if (controllable(event.provider)) reconcile(); else emit();
      },
      destroy() { selectRoom(null); }
    };
  }
  const api = { intendedPosition, createRoomSync };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MultiplaySync = api;
})(typeof window !== 'undefined' ? window : globalThis);
