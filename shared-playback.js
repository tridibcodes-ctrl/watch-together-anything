(function (root) {
  'use strict';
  const MAX_POSITION = 604800000;
  function intendedPosition(state, now = Date.now()) {
    return Math.min(MAX_POSITION, Math.max(0, state.positionMs + (state.status === 'playing' ? Math.max(0, now + (state.offset || 0) - Date.parse(state.anchorAt)) : 0)));
  }
  function createRoomSync({ request, player, subscribe = () => () => {}, onChange = () => {}, onError = () => {}, now = Date.now, setIntervalImpl = setInterval, clearIntervalImpl = clearInterval }) {
    let roomId = null, state = null, joined = false, generation = 0, fetching = false, refreshQueued = false;
    let stopSubscription = () => {}, poll = null, correction = null, loadedKey = null, busy = false, online = false, lastCommandAt = 0;
    let commandTarget = null, pendingCommand = null;
    const emit = () => onChange({ roomId, state, joined, busy, online, canControl: joined && online && !busy && state?.provider === 'cinemaos' && player.getStatus().ready });
    function reconcile(force = false) {
      if (!joined || !state?.media) { emit(); return; }
      const key = `${state.sessionId}:${state.provider}`;
      if (loadedKey !== key) {
        loadedKey = key; commandTarget = null;
        player.load(state.media, state.provider, intendedPosition(state, now()) / 1000);
      }
      const actual = player.getStatus();
      if (online && actual.ready && state.provider === 'cinemaos' && (force || now() - lastCommandAt > 1500)) {
        const seconds = intendedPosition(state, now()) / 1000;
        const expectedPlaying = state.status === 'playing';
        const drift = Math.abs((actual.seconds || 0) - seconds);
        if (force || drift > 2 || actual.playing !== expectedPlaying) {
          commandTarget = { seconds, playing: expectedPlaying, until: now() + 4000 };
          if (force || drift > 2) player.command('seek', { time: seconds });
          if (force || actual.playing !== expectedPlaying) player.command(expectedPlaying ? 'play' : 'pause');
          lastCommandAt = now();
        }
      }
      emit();
    }
    function accept(next, started) {
      if (!next || next.roomId !== roomId || !Number.isSafeInteger(next.revision) || next.revision < 0 || !Number.isFinite(Date.parse(next.serverTime)) || !Number.isFinite(Date.parse(next.anchorAt))) return;
      if (state && next.revision < state.revision) return;
      const changed = !state || next.revision > state.revision;
      state = { ...next, offset: Date.parse(next.serverTime) - (started + now()) / 2 };
      online = true;
      reconcile(changed);
    }
    async function refresh() {
      if (!roomId) return;
      if (fetching) { refreshQueued = true; return; }
      const version = generation, selected = roomId, started = now(); fetching = true;
      try {
        const next = await request(`/api/rooms/${selected}/state`);
        if (version === generation) accept(next, started);
      } catch (error) {
        if (version === generation) {
          if (online && joined && state?.provider === 'cinemaos') player.command('pause');
          online = false; emit(); onError(error.message);
        }
      } finally {
        if (version === generation) {
          fetching = false;
          if (refreshQueued) { refreshQueued = false; void refresh(); }
        }
      }
    }
    function selectRoom(id) {
      generation++; stopSubscription(); clearIntervalImpl(poll); clearIntervalImpl(correction);
      roomId = id || null; state = null; joined = false; loadedKey = null; online = false; busy = false;
      fetching = false; refreshQueued = false; pendingCommand = null; commandTarget = null;
      player.clear(); emit();
      if (!roomId) return;
      const version = generation;
      stopSubscription = subscribe(roomId, () => { if (version === generation) void refresh(); });
      poll = setIntervalImpl(() => void refresh(), 3000);
      correction = setIntervalImpl(() => {
        if (joined && online) { player.requestStatus(); reconcile(); }
      }, 2000);
      void refresh();
    }
    async function send(route, body) {
      if (!roomId || !state || !online) throw new Error('Load the room playback state first.');
      if (busy) throw new Error('Wait for the current playback command.');
      const version = generation, selected = roomId, started = now(); busy = true; emit();
      // Retain the exact body after a transport failure so Retry cannot apply the
      // same seek/play twice. Explicit newer actions replace the pending command.
      pendingCommand = { route, body };
      try {
        const next = await request(`/api/rooms/${selected}/${route}`, 'POST', body);
        if (version !== generation) return;
        pendingCommand = null; accept(next, started);
      } catch (error) {
        if (version !== generation) return;
        if (error.state) { pendingCommand = null; accept(error.state, started); }
        throw error;
      } finally {
        if (version === generation) { busy = false; emit(); }
      }
    }
    const commandId = () => root.crypto.randomUUID();
    async function command(action, extra = {}) {
      if (!joined || !state?.sessionId) throw new Error('Join this playback session first.');
      if (action !== 'provider' && (state.provider !== 'cinemaos' || !player.getStatus().ready)) throw new Error('Shared controls require a responsive CinemaOS player.');
      return send('commands', { commandId: commandId(), expectedRevision: state.revision, sessionId: state.sessionId, action, ...extra });
    }
    return {
      selectRoom, refresh, command,
      async watch(media) {
        if (!state || !online) throw new Error('Playback is not ready. Refresh the room or apply the playback migration.');
        joined = true; emit();
        await send('media', { ...media, commandId: commandId(), expectedRevision: state.revision });
      },
      join() { if (!state?.media) throw new Error('Choose a title first.'); joined = true; reconcile(true); },
      leave() { joined = false; loadedKey = null; player.clear(); emit(); },
      retryPlayer() { if (joined && state?.media) { loadedKey = null; reconcile(true); } },
      async retryCommand() { if (pendingCommand) return send(pendingCommand.route, pendingCommand.body); },
      playerEvent(event) {
        if (!joined || !state || !online) { emit(); return; }
        if (event.status === 'ready') { reconcile(true); return; }
        emit();
        // Native controls stay local. Polling reconciles them to committed state;
        // remote acknowledgement events are never re-broadcast as new commands.
        if (event.provider === 'cinemaos' && ['play','pause','seeked'].includes(event.status)) {
          if (!commandTarget || now() > commandTarget.until) reconcile();
        }
      },
      destroy() { selectRoom(null); }
    };
  }
  const api = { intendedPosition, createRoomSync };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MultiplaySync = api;
})(typeof window !== 'undefined' ? window : globalThis);
