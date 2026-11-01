const test = require('node:test');
const assert = require('node:assert/strict');
const { createRoomSync, intendedPosition } = require('../shared-playback');
const initial = {roomId:'room',sessionId:'session',media:{mediaType:'movie',tmdbId:155,title:'Movie'},revision:1,provider:'cinemaos',status:'paused',positionMs:0,anchorAt:new Date(10000).toISOString(),serverTime:new Date(10000).toISOString()};
const flush = () => new Promise(resolve => setImmediate(resolve));
function client(request) {
  const events=[], loads=[], commands=[], timers=[], subs=[];
  let actual={ready:true,seconds:0,playing:false}, time=10000;
  const player={ clear(){actual={...actual,ready:false};},load(media,provider,seconds){loads.push({media,provider,seconds});actual={ready:true,seconds,playing:false};}, getStatus(){return actual;}, requestStatus(){}, command(action,params){commands.push({action,params});return true;} };
  const sync=createRoomSync({request,player,now:()=>time,onChange:e=>events.push(e),onError:message=>events.push({error:message}),subscribe:(room,refresh)=>{subs.push(refresh);return()=>{};},setIntervalImpl:fn=>{timers.push(fn);return fn;},clearIntervalImpl:()=>{}});
  return {sync,events,loads,commands,subs,timers,player,setTime:t=>time=t,setActual:s=>actual=s};
}
test('both members apply committed seek/play and provider changes; nonjoined clients do not autoplay',async()=>{
  let state={...initial};
  const request=async(path,method,body)=>{
    if(method==='POST'){
      assert.equal(body.expectedRevision,state.revision);
      state={...state,revision:state.revision+1,positionMs:body.action==='seek'?body.targetPositionMs:state.positionMs,status:body.action==='play'?'playing':body.action==='provider'?'paused':state.status,provider:body.provider||state.provider};
    }return {...state};
  };
  const a=client(request),b=client(request);
  a.sync.selectRoom('room');b.sync.selectRoom('room');await flush();
  assert.equal(b.loads.length,0);
  a.sync.join();b.sync.join();
  await a.sync.command('seek',{targetPositionMs:120000});await b.sync.refresh();
  assert.equal(b.commands.at(-2).params.time,120);
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
    if(method==='POST'){bodies.push(body);if(fail){fail=false;throw new Error('network');}}
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
  let writes=0;const c=client(async(path,method)=>{if(method==='POST')writes++;return {...initial,status:'playing',positionMs:100000};});
  c.sync.selectRoom('room');await flush();c.sync.join();
  c.sync.playerEvent({provider:'cinemaos',status:'play'});
  c.sync.playerEvent({provider:'cinemaos',status:'seeked'});
  assert.equal(writes,0);
  c.setTime(15000);c.setActual({ready:true,playing:true,seconds:50});c.timers[1]();
  assert.equal(c.commands.at(-1).action,'seek');
  assert.equal(c.commands.at(-1).params.time,105);
  assert.equal(intendedPosition({...initial,status:'playing',positionMs:100000,offset:500},15000),105500);
  c.sync.destroy();
});
test('conflicts apply the authoritative snapshot without reissuing stale commands',async()=>{
  let writes=0;const c=client(async(path,method)=>{
    if(method==='POST'){writes++;throw Object.assign(new Error('conflict'),{state:{...initial,revision:3,positionMs:30000}});}
    return {...initial};
  });c.sync.selectRoom('room');await flush();c.sync.join();
  await assert.rejects(c.sync.command('play'),/conflict/);
  assert.equal(c.events.at(-1).state.revision,3);
  await c.sync.retryCommand();assert.equal(writes,1);
  c.sync.destroy();
});
