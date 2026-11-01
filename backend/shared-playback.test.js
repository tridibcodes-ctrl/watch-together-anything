const test = require('node:test');
const assert = require('node:assert/strict');
const { createRoomSync, intendedPosition } = require('../shared-playback');
const initial = {roomId:'room',sessionId:'session',media:{mediaType:'movie',tmdbId:155,title:'Movie'},revision:1,provider:'cinemaos',status:'paused',positionMs:0,readyEpoch:1,playRequested:false,readiness:{bothReady:true,readyCount:2,requiredCount:2},anchorAt:new Date(10000).toISOString(),serverTime:new Date(10000).toISOString()};
const flush = () => new Promise(resolve => setImmediate(resolve));
function client(request, { autoAck = true, loadReady = true } = {}) {
  const events=[], loads=[], commands=[], timers=[], subs=[];
  let actual={ready:true,seconds:0,playing:false}, time=10000;
  const player={ clear(){actual={...actual,ready:false};},load(media,provider,seconds){loads.push({media,provider,seconds});actual={ready:loadReady,playable:loadReady,seconds,playing:false};}, getStatus(){return actual;}, requestStatus(){}, command(action,params){commands.push({action,params});if(!autoAck && action==='seek') actual={...actual,seekPending:true};if(autoAck){ if(action==='seek') actual={...actual,seconds:params.time,seekPending:false}; if(action==='play'||action==='pause') actual={...actual,playing:action==='play'}; }return true;} };
  const sync=createRoomSync({request,player,now:()=>time,onChange:e=>events.push(e),onError:message=>events.push({error:message}),subscribe:(room,refresh)=>{subs.push(refresh);return()=>{};},setIntervalImpl:fn=>{timers.push(fn);return fn;},clearIntervalImpl:()=>{}});
  return {sync,events,loads,commands,subs,timers,player,setTime:t=>time=t,setActual:s=>actual=s};
}
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

test('CineSrc room commands apply on both joined clients; fallback stays manual',async()=>{
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
  state={...state,provider:'vidlink',revision:state.revision+1};await b.sync.refresh();assert.equal(b.events.at(-1).canControl,false);
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
