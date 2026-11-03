const test = require('node:test');
const assert = require('node:assert/strict');
const { createRoomSync, intendedPosition } = require('../frontend/shared-playback');
const initial = {roomId:'room',sessionId:'session',media:{mediaType:'movie',tmdbId:155,title:'Movie'},revision:1,provider:'cinemaos',status:'paused',positionMs:0,readyEpoch:1,playRequested:false,readiness:{bothReady:true,readyCount:2,requiredCount:2},anchorAt:new Date(10000).toISOString(),serverTime:new Date(10000).toISOString()};
const flush = () => new Promise(resolve => setImmediate(resolve));
function client(request, { autoAck = true, loadReady = true, requireSessionConsent = false } = {}) {
  const events=[], loads=[], commands=[], timers=[], subs=[];
  let actual={ready:true,seconds:0,playing:false}, time=10000;
  const player={ clear(){actual={...actual,ready:false};},load(media,provider,seconds){loads.push({media,provider,seconds});actual={ready:loadReady,playable:loadReady,seconds,playing:false};}, getStatus(){return actual;}, requestStatus(){}, command(action,params){commands.push({action,params});if(!autoAck && action==='seek') actual={...actual,seekPending:true};if(autoAck){ if(action==='seek') actual={...actual,seconds:params.time,seekPending:false}; if(action==='play'||action==='pause') actual={...actual,playing:action==='play'}; }return true;} };
  const sync=createRoomSync({request,player,requireSessionConsent,now:()=>time,onChange:e=>events.push(e),onError:message=>events.push({error:message}),subscribe:(room,refresh)=>{subs.push(refresh);return()=>{};},setIntervalImpl:fn=>{timers.push(fn);return fn;},clearIntervalImpl:()=>{}});
  return {sync,events,loads,commands,subs,timers,player,setTime:t=>time=t,setActual:s=>actual=s};
}

test('a new partner-selected session waits for consent; stale accepted invitations cannot load a different movie',async()=>{
  let state={...initial};const app=client(async()=>({...state}),{requireSessionConsent:true});
  app.sync.selectRoom('room');await flush();app.sync.join();assert.equal(app.loads.length,1);
  state={...state,sessionId:'next',media:{...state.media,tmdbId:27205},revision:2};await app.sync.refresh();
  assert.equal(app.events.at(-1).joined,false);assert.equal(app.loads.length,1);
  await assert.rejects(app.sync.joinSession('session'),/movie changed/);assert.equal(app.loads.length,1);
  await app.sync.joinSession('next');assert.equal(app.loads.length,2);assert.equal(app.events.at(-1).joined,true);
  app.sync.destroy();
});

test('the person choosing a movie joins their own new session without a second consent prompt',async()=>{
  let state={...initial};const app=client(async(_path,method,body)=>{
    if(method==='POST'&&body.tmdbId)state={...state,sessionId:'chosen',media:body,revision:2};return {...state};
  },{requireSessionConsent:true});
  app.sync.selectRoom('room');await flush();app.sync.join();
  await app.sync.watch({mediaType:'movie',tmdbId:27205,title:'Next'});
  assert.equal(app.events.at(-1).joined,true);assert.equal(app.loads.at(-1).media.tmdbId,27205);app.sync.destroy();
});

test('a delayed selection response cannot join a newer partner-selected session',async()=>{
  let state={...initial},resolve;
  const app=client(async(path,method,body)=>method==='POST'&&body.tmdbId?new Promise(done=>resolve=done):{...state},{requireSessionConsent:true});
  app.sync.selectRoom('room');await flush();app.sync.join();
  const selecting=app.sync.watch({mediaType:'movie',tmdbId:27205,title:'Mine'});
  state={...state,revision:3,sessionId:'partner',media:{...state.media,tmdbId:111}};await app.sync.refresh();
  resolve({...state,revision:2,sessionId:'mine',media:{...state.media,tmdbId:27205}});
  await assert.rejects(selecting,/partner selected another/);assert.equal(app.events.at(-1).joined,false);assert.equal(app.loads.length,1);
  app.sync.destroy();
});

test('leaving while movie selection is pending cannot reopen the player on its late response',async()=>{
  let resolve;const app=client(async(path,method,body)=>method==='POST'&&body.tmdbId?new Promise(done=>resolve=done):{...initial},{requireSessionConsent:true});
  app.sync.selectRoom('room');await flush();
  const selecting=app.sync.watch({mediaType:'movie',tmdbId:27205,title:'Next'});
  app.sync.leave();resolve({...initial,revision:2,sessionId:'next',media:{mediaType:'movie',tmdbId:27205,title:'Next'}});await selecting;
  assert.equal(app.events.at(-1).joined,false);assert.equal(app.loads.length,0);app.sync.destroy();
});

test('leaving while accepting an invitation prevents its delayed response from joining',async()=>{
  let resolve,delay=false;const app=client(async()=>delay?new Promise(done=>resolve=done):{...initial});
  app.sync.selectRoom('room');await flush();delay=true;
  const accepting=app.sync.joinSession('session');app.sync.leave();resolve({...initial});
  await assert.rejects(accepting,/cancelled|changed/);assert.equal(app.events.at(-1).joined,false);assert.equal(app.loads.length,0);app.sync.destroy();
});

test('retrying a failed movie selection reuses its identity and joins only while that choice is still active',async()=>{
  let fail=true;const bodies=[];
  const app=client(async(_path,method,body)=>{
    if(method==='POST'&&body.tmdbId){bodies.push(body);if(fail){fail=false;throw new Error('network');}return {...initial,revision:2,sessionId:'chosen',media:body};}
    return {...initial};
  },{requireSessionConsent:true});
  app.sync.selectRoom('room');await flush();await assert.rejects(app.sync.watch({mediaType:'movie',tmdbId:27205,title:'Next'}),/network/);
  assert.equal(app.events.at(-1).joined,false);await app.sync.retryCommand();assert.equal(app.events.at(-1).joined,true);assert.equal(bodies[0].commandId,bodies[1].commandId);
  app.sync.leave();await app.sync.retryCommand();assert.equal(app.events.at(-1).joined,false);app.sync.destroy();
});
test('both members apply committed seek/play and provider changes; nonjoined clients do not autoplay',async()=>{
  let state={...initial};
  const request=async(path,method,body)=>{
    if(method==='POST' && !path.endsWith('/readiness')){
      assert.equal(body.expectedRevision,state.revision);
      state={...state,revision:state.revision+1,readyEpoch:state.readyEpoch+(['seek','pause','provider'].includes(body.action)?1:0),positionMs:body.action==='seek'?body.targetPositionMs:state.positionMs,status:body.action==='play'?'playing':body.action==='provider'?'paused':state.status,provider:body.provider||state.provider};
    }return {...state};
  };
  const a=client(request),b=client(request);
  a.sync.selectRoom('room');b.sync.selectRoom('room');await flush();
  assert.equal(b.loads.length,0);
  a.sync.join();b.sync.join();
  await a.sync.command('seek',{targetPositionMs:120000});await b.sync.refresh();
  assert.ok(b.commands.some(c=>c.action==='seek'&&c.params?.time===120));
  await b.sync.command('play');await a.sync.refresh();
  assert.equal(a.commands.at(-1).action,'play');
  await a.sync.command('provider',{provider:'vidlink'});await b.sync.refresh();
  assert.equal(b.loads.at(-1).provider,'vidlink');
  assert.equal(b.events.at(-1).canControl,false);
  await assert.rejects(b.sync.command('play'),/CinemaOS/);
  a.sync.destroy();b.sync.destroy();
});
test('old room responses are discarded, disconnected controls disabled, and retries keep command identity',async()=>{
  let resolve, fail=false;const bodies=[];
  const c=client(async(path,method,body)=>{
    if(path.includes('/old/'))return new Promise(done=>resolve=done);
    if(method==='POST' && !path.endsWith('/readiness')){bodies.push(body);if(fail){fail=false;throw new Error('network');}}
    return {...initial};
  });
  c.sync.selectRoom('old');c.sync.selectRoom('room');await flush();
  resolve({...initial,roomId:'old',revision:500});await flush();
  c.sync.join();assert.equal(c.loads.length,1);
  fail=true;await assert.rejects(c.sync.command('play'),/network/);
  await c.sync.retryCommand();assert.equal(bodies[0].commandId,bodies[1].commandId);
  assert.deepEqual(bodies[0],bodies[1]);
  c.sync.leave();assert.equal(c.events.at(-1).joined,false);
  c.sync.destroy();
});
test('remote acknowledgements do not echo commands and drift follows the server time anchor',async()=>{
  let writes=0, server={...initial,status:'paused',positionMs:100000};
  const c=client(async(path,method)=>{if(method==='POST' && !path.endsWith('/readiness'))writes++;return {...server};});
  c.sync.selectRoom('room');await flush();c.sync.join();await flush();
  server={...server,status:'playing',revision:2};await c.sync.refresh();
  c.sync.playerEvent({provider:'cinemaos',status:'play'});c.sync.playerEvent({provider:'cinemaos',status:'seeked'});
  assert.equal(writes,0);
  c.setTime(15000);c.setActual({ready:true,playing:true,seconds:50});c.timers[1]();
  assert.ok(c.commands.some(command=>command.action==='seek'&&command.params.time===105));
  assert.equal(intendedPosition({...initial,status:'playing',positionMs:100000,offset:500},15000),105500);
  c.sync.destroy();
});
test('conflicts apply the authoritative snapshot without reissuing stale commands',async()=>{
  let writes=0;const c=client(async(path,method)=>{
    if(method==='POST' && !path.endsWith('/readiness')){writes++;throw Object.assign(new Error('conflict'),{state:{...initial,revision:3,positionMs:30000}});}
    return {...initial};
  });c.sync.selectRoom('room');await flush();c.sync.join();
  await assert.rejects(c.sync.command('play'),/conflict/);
  assert.equal(c.events.at(-1).state.revision,3);
  await c.sync.retryCommand();assert.equal(writes,1);
  c.sync.destroy();
});

test('CineSrc room commands apply on both joined clients; switching preserves controls',async()=>{
  let state={...initial,provider:'cinesrc'};
  const request=async(path,method,body)=>{
    if(method==='POST' && !path.endsWith('/readiness')) state={...state,revision:state.revision+1,readyEpoch:state.readyEpoch+(['seek','pause','provider'].includes(body.action)?1:0),status:body.action==='play'?'playing':'paused',positionMs:body.targetPositionMs??state.positionMs};
    return {...state};
  };
  const a=client(request), b=client(request);
  a.sync.selectRoom('room');b.sync.selectRoom('room');await flush();a.sync.join();b.sync.join();
  assert.equal(a.events.at(-1).canControl,true);assert.equal(b.events.at(-1).canControl,true);
  await a.sync.command('play');await b.sync.refresh();assert.equal(b.commands.at(-1).action,'play');
  await b.sync.command('seek',{targetPositionMs:120000});await a.sync.refresh();assert.ok(a.commands.some(c=>c.action==='seek'&&c.params.time===120));
  await a.sync.command('pause');await b.sync.refresh();assert.equal(b.player.getStatus().playing,false);
  state={...state,provider:'vidrift',revision:state.revision+1};await b.sync.refresh();assert.equal(b.events.at(-1).canControl,true);
  a.sync.destroy();b.sync.destroy();
});

test('a slow partner loads against a frozen target without repeated seeks, then both resume',async()=>{
  let server={...initial,provider:'cinesrc',positionMs:120000,playRequested:true,waitingForReady:true,readiness:{bothReady:false,readyCount:0,requiredCount:2}};
  const readiness=new Map();
  const request=actor=>async(path,method,body)=>{
    if(path.endsWith('/readiness')){
      if(body.joined)readiness.set(actor,body.ready);else readiness.delete(actor);
      const count=[...readiness.values()].filter(Boolean).length;
      server={...server,readiness:{bothReady:count===2,readyCount:count,requiredCount:2},waitingForReady:count!==2};
      if(count===2&&server.status==='paused')server={...server,status:'playing',revision:server.revision+1};
    }
    return structuredClone(server);
  };
  const a=client(request('a')),b=client(request('b'),{loadReady:false,autoAck:false});
  a.sync.selectRoom('room');b.sync.selectRoom('room');await flush();a.sync.join();b.sync.join();await flush();
  assert.equal(server.status,'paused');assert.equal(server.readiness.readyCount,1);
  for(let i=1;i<=8;i++){b.setTime(10000+i*3000);b.timers[1]();await flush();}
  assert.equal(b.commands.filter(c=>c.action==='seek').length,0);assert.equal(server.positionMs,120000);
  b.setActual({ready:true,playable:false,seconds:0,playing:false,seekPending:false});b.sync.playerEvent({provider:'cinesrc',status:'ready'});await flush();
  assert.equal(b.commands.filter(c=>c.action==='seek').length,1);assert.equal(b.commands.find(c=>c.action==='seek').params.time,120);
  for(let i=1;i<=8;i++){b.setTime(40000+i*3000);b.timers[1]();await flush();}
  assert.equal(b.commands.filter(c=>c.action==='seek').length,1);assert.equal(server.status,'paused');
  b.setActual({ready:true,playable:true,seconds:120,playing:false,seekPending:false});b.sync.playerEvent({provider:'cinesrc',status:'seeked'});await flush();await a.sync.refresh();
  assert.equal(server.status,'playing');assert.equal(a.player.getStatus().playing,true);
  a.sync.destroy();b.sync.destroy();
});

test('a server without readiness migration fails closed rather than starting an unguarded clock',async()=>{
  const c=client(async()=>{const state={...initial};delete state.readyEpoch;return state;});
  c.sync.selectRoom('room');await flush();assert.equal(c.events.findLast(e=>'online' in e).online,false);assert.equal(c.loads.length,0);assert.ok(c.events.some(e=>e.error?.includes('readiness')||e.error?.includes('Readiness')));c.sync.destroy();
});

test('native initialization overshoot realigns to the same frozen anchor, not a moving time',async()=>{
  const server={...initial,provider:'cinesrc',positionMs:120000,waitingForReady:true,readiness:{bothReady:false,readyCount:1,requiredCount:2}};
  const c=client(async()=>({...server}));c.sync.selectRoom('room');await flush();c.sync.join();await flush();
  c.setTime(14000);c.setActual({ready:true,playable:true,playing:true,seconds:124,seekPending:false});c.sync.playerEvent({provider:'cinesrc',status:'timeupdate'});
  assert.equal(c.player.getStatus().seconds,120);assert.equal(c.player.getStatus().playing,false);c.sync.destroy();
});

test('native controls commit once and mirror to the partner on all added providers',async()=>{
  for(const provider of ['vidspark','vidrift','vidbolt']){
    let state={...initial,provider}, writes=[];
    const request=async(path,method,body)=>{
      if(path.endsWith('/commands')){
        writes.push(body);assert.equal(body.expectedRevision,state.revision);
        state={...state,revision:state.revision+1,status:body.action==='play'?'playing':'paused',playRequested:body.action==='play'?true:body.action==='pause'?false:state.playRequested,positionMs:body.targetPositionMs??state.positionMs,readyEpoch:state.readyEpoch+(body.action==='play'?0:1)};
      }return {...state};
    };
    const a=client(request),b=client(request);a.sync.selectRoom('room');b.sync.selectRoom('room');await flush();a.sync.join();b.sync.join();await flush();
    a.setActual({ready:true,playable:true,playing:true,seconds:0});a.sync.playerEvent({provider,nativeIntent:{action:'play'}});await flush();await b.sync.refresh();
    assert.equal(b.player.getStatus().playing,true);assert.equal(writes.length,1);
    b.setActual({ready:true,playable:true,playing:false,seconds:0});b.sync.playerEvent({provider,nativeIntent:{action:'pause'}});await flush();await a.sync.refresh();
    assert.equal(a.player.getStatus().playing,false);assert.equal(writes.length,2);
    a.setActual({ready:true,playable:true,playing:false,seconds:120});a.sync.playerEvent({provider,nativeIntent:{action:'seek',seconds:120}});await flush();await b.sync.refresh();
    assert.equal(b.player.getStatus().seconds,120);assert.equal(writes.length,3);
    a.sync.playerEvent({provider,status:'seeked'});b.sync.playerEvent({provider,status:'pause'});await flush();assert.equal(writes.length,3);
    a.sync.destroy();b.sync.destroy();
  }
});

test('rapid native actions queue through a slow write, and do not seek back to the old anchor',async()=>{
  let state={...initial,provider:'vidspark'},resolve;
  const writes=[];
  const c=client(async(path,method,body)=>{
    if(path.endsWith('/commands')){
      writes.push(body);
      if(writes.length===1)await new Promise(done=>resolve=done);
      state={...state,revision:state.revision+1,status:body.action==='play'?'playing':'paused',playRequested:body.action==='play'?true:body.action==='pause'?false:state.playRequested,positionMs:body.targetPositionMs??state.positionMs,readyEpoch:state.readyEpoch+(body.action==='play'?0:1)};
    }return {...state};
  });
  c.sync.selectRoom('room');await flush();c.sync.join();await flush();
  c.setActual({ready:true,playable:true,playing:true,seconds:0});c.sync.playerEvent({provider:'vidspark',nativeIntent:{action:'play'}});
  c.setTime(14000);c.setActual({ready:true,playable:true,playing:false,seconds:120});
  c.sync.playerEvent({provider:'vidspark',nativeIntent:{action:'seek',seconds:100}});
  c.sync.playerEvent({provider:'vidspark',nativeIntent:{action:'seek',seconds:120}});
  c.sync.playerEvent({provider:'vidspark',nativeIntent:{action:'pause'}});
  c.timers[1]();assert.equal(c.commands.filter(c=>c.action==='seek').length,0);
  resolve();await flush();await flush();
  assert.deepEqual(writes.map(b=>b.action),['play','seek','pause']);assert.equal(writes[1].targetPositionMs,120000);assert.equal(state.playRequested,false);
  assert.deepEqual(writes.map(b=>b.expectedRevision),[1,2,3]);c.sync.destroy();
});

test('native failures retain exact retry identity and ignore events from other providers',async()=>{
  let fail=true,writes=[],state={...initial,provider:'vidspark'};
  const c=client(async(path,method,body)=>{
    if(path.endsWith('/commands')){writes.push(body);if(fail){fail=false;throw new Error('network');}state={...state,revision:2,playRequested:true};}return {...state};
  });
  c.sync.selectRoom('room');await flush();c.sync.join();await flush();
  c.sync.playerEvent({provider:'vidspark',nativeIntent:{action:'play'}});await flush();
  assert.ok(c.events.some(e=>e.error==='network'));await c.sync.retryCommand();assert.deepEqual(writes[0],writes[1]);
  const count=writes.length;c.sync.playerEvent({provider:'vidrift',nativeIntent:{action:'seek',seconds:10}});await flush();assert.equal(writes.length,count);
  c.sync.destroy();
});

test('a failed native command can recover from a conflicting retry without leaving controls blocked',async()=>{
  let attempt=0,state={...initial,provider:'vidspark'};
  const c=client(async(path,method,body)=>{
    if(path.endsWith('/commands')){
      attempt++;
      if(attempt===1)throw new Error('network');
      if(attempt===2){state={...state,revision:3};throw Object.assign(new Error('conflict'),{state});}
      state={...state,revision:state.revision+1,playRequested:body.action==='play'};
    }return {...state};
  });
  c.sync.selectRoom('room');await flush();c.sync.join();await flush();c.sync.playerEvent({provider:'vidspark',nativeIntent:{action:'play'}});await flush();
  await assert.rejects(c.sync.retryCommand(),/conflict/);await c.sync.command('pause');assert.equal(attempt,3);c.sync.destroy();
});

test('queued native actions from an old room are discarded after selection changes',async()=>{
  let resolve;const writes=[];
  const c=client(async(path,method,body)=>{
    if(path.endsWith('/commands')){writes.push(body);await new Promise(done=>resolve=done);}
    return {...initial,provider:'vidspark',roomId:path.includes('/other/')?'other':'room'};
  });
  c.sync.selectRoom('room');await flush();c.sync.join();await flush();
  c.sync.playerEvent({provider:'vidspark',nativeIntent:{action:'play'}});c.sync.playerEvent({provider:'vidspark',nativeIntent:{action:'pause'}});
  c.sync.selectRoom('other');await flush();resolve();await flush();
  assert.equal(writes.length,1);assert.equal(c.events.at(-1).roomId,'other');assert.equal(c.events.at(-1).joined,false);c.sync.destroy();
});

test('native play still waits for both accounts, and a native pause cancels queued play',async()=>{
  let state={...initial,provider:'vidrift',readiness:{bothReady:false,readyCount:1,requiredCount:2},playRequested:false,waitingForReady:true};
  const c=client(async(path,method,body)=>{if(path.endsWith('/commands'))state={...state,revision:state.revision+1,playRequested:body.action==='play'};return {...state};});
  c.sync.selectRoom('room');await flush();c.sync.join();await flush();
  c.setActual({ready:true,playable:true,playing:true,seconds:0});c.sync.playerEvent({provider:'vidrift',nativeIntent:{action:'play'}});await flush();
  assert.equal(state.status,'paused');assert.equal(state.playRequested,true);assert.equal(c.player.getStatus().playing,false);
  c.sync.playerEvent({provider:'vidrift',nativeIntent:{action:'pause'}});await flush();assert.equal(state.playRequested,false);c.sync.destroy();
});
