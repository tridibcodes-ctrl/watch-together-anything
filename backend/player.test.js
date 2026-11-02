const test = require('node:test');
const assert = require('node:assert/strict');
const { embedUrl, playbackEvent, createPlayer } = require('../frontend/player');
const movie = { mediaType: 'movie', tmdbId: 155, title: 'The Dark Knight' };
const tv = { mediaType: 'tv', tmdbId: 1396, season: 0, episode: 1, title: 'Breaking Bad' };

test('provider URLs retain the exact movie or episode and use provider-specific parameters', () => {
  const cinema = new URL(embedUrl(movie, 'cinemaos', 60));
  assert.equal(cinema.origin, 'https://cinemaos.tech');
  assert.equal(cinema.pathname, '/player/155');
  assert.equal(cinema.searchParams.get('autoPlay'), 'false');
  assert.equal(cinema.searchParams.has('startTime'), false);
  assert.equal(new URL(embedUrl(tv, 'cinemaos')).pathname, '/player/1396/0/1');
  assert.throws(() => embedUrl(tv, 'vidlink'), /Unknown player provider/);
  for (const media of [{ ...movie, tmdbId: '155' }, { ...movie, mediaType: 'person' }, { ...tv, episode: 0 }, { ...tv, season: -1 }]) assert.throws(() => embedUrl(media, 'cinemaos'));
  assert.throws(() => embedUrl(movie, 'https://evil.test'));
});

test('removed provider messages are ignored even from their former iframe', () => {
  const frame = { contentWindow: {} };
  const event = { origin: 'https://vidlink.pro', source: frame.contentWindow, data: { type: 'PLAYER_EVENT', data: { event: 'timeupdate', mtmdbId: 1396, mediaType: 'tv', season: 0, episode: 1, currentTime: 90 } } };
  assert.equal(playbackEvent(event, frame, tv, 'vidlink'), null);
  for (const changed of [
    { origin: 'https://vidlink.pro.evil.test' }, { source: {} }, { data: 'bad json' },
    ...[{ mtmdbId: 155 }, { mediaType: 'movie' }, { episode: 2 }, { currentTime: Infinity }, { currentTime: -1 }, { currentTime: '90' }, { event: 'error' }].map(data => ({ data: { type: 'PLAYER_EVENT', data: { ...event.data.data, ...data } } }))
  ]) assert.equal(playbackEvent({ ...event, ...changed }, frame, tv, 'vidlink'), null);
  assert.equal(playbackEvent(event, frame, tv, 'cinemaos'), null);
});

function harness({ now } = {}) {
  const states = [], frames = [], timers = new Map(), listeners = new Map();
  let timerId = 0;
  const container = { children: [], replaceChildren() { this.children = []; }, append(frame) { this.children.push(frame); } };
  const player = createPlayer({ container, now, onState: state => states.push(state),
    windowImpl: { addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) },
    documentImpl: { createElement(tag) { assert.equal(tag, 'iframe'); const frame = { commands: [], contentWindow: { postMessage(message, origin) { frame.commands.push({ message, origin }); } }, setAttribute() {} }; frames.push(frame); return frame; } },
    setTimer(fn) { timers.set(++timerId, fn); return timerId; }, clearTimer(id) { timers.delete(id); }
  });
  return { player, states, frames, timers, listeners, container };
}

test('embedded providers cannot replace the fullscreen stage and hide its chat', () => {
  const app = harness();
  for (const provider of ['vidspark', 'vidrift', 'vidbolt', 'cinesrc', 'cinemaos']) {
    app.player.load(movie, provider);
    assert.equal(app.frames.at(-1).allowFullscreen, false);
    assert.match(app.frames.at(-1).allow, /fullscreen 'none'/);
  }
});

test('VidRift is primary and failed loading offers an explicit retry without changing providers', () => {
  const app = harness();
  app.player.load(tv);
  assert.equal(app.states.at(-1).provider, 'vidrift');
  app.frames[0].onerror();
  assert.equal(app.states.at(-1).provider, 'vidrift');
  assert.equal(app.frames.length, 1);
  assert.equal(app.states.at(-1).status, 'error');
  app.player.load(movie, 'cinemaos');
  assert.equal(app.states.at(-1).provider, 'cinemaos');
  app.player.switchProvider('vidbolt');
  assert.equal(new URL(app.frames.at(-1).src).pathname, '/movie/155');
  assert.equal(app.container.children.length, 1);
});

test('iframe load does not imply a working video; confirmation timer continues without video status', () => {
  const app = harness(); app.player.load(movie, 'cinemaos');
  [...app.timers.values()][0]();
  assert.equal(app.states.at(-1).status, 'unconfirmed');
  assert.equal(app.frames.length, 1);
  app.frames[0].onload();
  assert.equal(app.states.at(-1).status, 'loaded');
  assert.equal(app.timers.size, 1);
  assert.equal(app.player.getStatus().ready, false);
  assert.equal(app.frames[0].commands[0].message.command, 'getStatus');
});

test('CinemaOS controls wait for status and always target the exact provider origin', () => {
  const app = harness(); app.player.load(movie, 'cinemaos');
  assert.equal(app.player.command('play'), false);
  app.frames[0].onload();
  app.listeners.get('message')({ origin: 'https://cinemaos.tech', source: app.frames[0].contentWindow,
    data: { type: 'PLAYER_EVENT', data: { event: 'playerstatus', currentTime: 0, duration: 900, paused: true } } });
  assert.equal(app.player.getStatus().ready, true);
  assert.equal(app.player.command('seek', { time: 120 }), true);
  assert.equal(app.player.command('play'), true);
  assert.equal(app.player.command('seek', { time: -1 }), false);
  assert.deepEqual(app.frames[0].commands.at(-2), { message: { command: 'seek', time: 120 }, origin: 'https://cinemaos.tech' });
  assert.deepEqual(app.frames[0].commands.at(-1), { message: { command: 'play' }, origin: 'https://cinemaos.tech' });
  app.player.switchProvider('vidrift');
  assert.equal(app.player.command('play'), false);
  assert.equal(app.player.getStatus().ready, false);
});

test('verified progress resumes on retry; old frames and late load events are ignored', () => {
  const app = harness(); app.player.load(tv, 'cinemaos');
  const staleLoad = app.frames[0].onload;
  app.player.switchProvider('vidspark');
  const receive = app.listeners.get('message');
  receive({ origin: 'https://vidspark.to', source: app.frames[1].contentWindow, data: { source: 'vidspark-player', event: 'pause', currentTime: 70, duration: 1200 } });
  assert.equal(app.states.at(-1).seconds, 70);
  app.player.retry();
  assert.equal(new URL(app.frames[2].src).searchParams.get('t'), '70');
  const count = app.states.length; staleLoad();
  receive({ origin: 'https://vidspark.to', source: app.frames[1].contentWindow, data: { source: 'vidspark-player', event: 'ended', currentTime: 900, duration: 1200 } });
  assert.equal(app.states.length, count);
  app.player.clear();
  assert.equal(app.container.children.length, 0);
  assert.equal(app.timers.size, 0);
  assert.equal(app.states.at(-1).media, null);
  app.player.destroy(); assert.equal(app.listeners.size, 0);
});

test('CineSrc primary uses TV query parameters and prevents automatic episode changes', () => {
  const url = new URL(embedUrl(tv, 'cinesrc', 75.9));
  assert.equal(url.origin, 'https://cinesrc.st'); assert.equal(url.pathname, '/embed/tv/1396');
  assert.equal(url.searchParams.get('s'), '0'); assert.equal(url.searchParams.get('e'), '1');
  for (const key of ['autoplay','autonext','autoskip','continueprompt']) assert.equal(url.searchParams.get(key), 'false');
  assert.equal(url.searchParams.get('t'), '75');
  const app = harness(); app.player.load(movie, 'cinesrc');
  assert.equal(new URL(app.frames[0].src).origin, 'https://cinesrc.st');
});

test('CineSrc waits for video metadata, then sends documented play/pause/seek commands', () => {
  const app = harness(); app.player.load(tv, 'cinesrc');
  const frame = app.frames[0]; const receive = data => app.listeners.get('message')({ origin:'https://cinesrc.st', source:frame.contentWindow, data });
  frame.onload(); assert.equal(app.player.getStatus().ready, false); assert.equal(app.player.command('play'), false);
  assert.deepEqual(frame.commands.slice(-3).map(c => c.message.command), ['getCurrentTime','getDuration','getPaused']);
  receive({type:'cinesrc:ready'}); assert.equal(app.player.getStatus().ready, false);
  receive({type:'cinesrc:loadedmetadata',duration:1200}); assert.equal(app.player.getStatus().ready,true);
  app.player.command('seek',{time:120}); app.player.command('play'); app.player.command('pause');
  assert.deepEqual(frame.commands.slice(-3).map(c => c.message), [
    {type:'cinesrc:command',command:'seek',args:[120]}, {type:'cinesrc:command',command:'play',args:[]}, {type:'cinesrc:command',command:'pause',args:[]}
  ]);
  assert.ok(frame.commands.every(c => c.origin === 'https://cinesrc.st'));
  receive({type:'cinesrc:timeupdate',currentTime:120,duration:1200});
  receive({type:'cinesrc:response',command:'getPaused',result:false}); assert.equal(app.player.getStatus().playing,true);
  receive({type:'cinesrc:pause'}); assert.equal(app.player.getStatus().playing,false);
  receive({type:'cinesrc:error',error:'source unavailable'}); assert.equal(app.player.getStatus().ready,false); assert.equal(app.player.command('play'),false);
});

test('CineSrc rejects spoofed frames/origins and malformed timing responses', () => {
  const frame={contentWindow:{}};const event={origin:'https://cinesrc.st',source:frame.contentWindow,data:{type:'cinesrc:timeupdate',currentTime:12,duration:100}};
  assert.equal(playbackEvent(event,frame,movie,'cinesrc').seconds,12);
  for(const changed of [{origin:'https://cinesrc.st.evil.test'},{source:{}},{data:{type:'cinesrc:timeupdate',currentTime:-1}},{data:{type:'cinesrc:response',command:'getCurrentTime',result:'12'}},{data:{type:'cinesrc:response',command:'getPaused',result:'false'}}]) assert.equal(playbackEvent({...event,...changed},frame,movie,'cinesrc'),null);
});

test('CineSrc local episode navigation cannot silently synchronize the wrong episode', () => {
  const app = harness();app.player.load(tv,'cinesrc');const frame=app.frames[0];
  const receive = data => app.listeners.get('message')({origin:'https://cinesrc.st',source:frame.contentWindow,data});
  receive({type:'cinesrc:loadedmetadata',duration:1200});assert.equal(app.player.getStatus().ready,true);
  receive({type:'cinesrc:nextepisode',season:0,episode:2,internalNavigation:true});
  assert.equal(app.player.getStatus().ready,false);
  receive({type:'cinesrc:timeupdate',currentTime:10,duration:1200});assert.equal(app.player.getStatus().ready,false);
  app.player.retry();assert.equal(app.player.getStatus().ready,false);assert.equal(new URL(app.frames.at(-1).src).searchParams.get('e'),'1');
});

test('stalled timestamps and pending seeks stop time extrapolation; blocked autoplay requires a gesture', () => {
  let time=0;const app=harness({now:()=>time});app.player.load(tv,'cinesrc');const frame=app.frames[0];
  const receive=data=>app.listeners.get('message')({origin:'https://cinesrc.st',source:frame.contentWindow,data});
  receive({type:'cinesrc:loadedmetadata',duration:1200});assert.equal(app.player.getStatus().playable,false);
  app.player.command('seek',{time:0});assert.equal(app.player.getStatus().seekPending,true);
  receive({type:'cinesrc:response',command:'getCurrentTime',result:0});assert.equal(app.player.getStatus().seekPending,false);
  assert.equal(app.player.getStatus().playable,true);
  receive({type:'cinesrc:play'});time=5000;receive({type:'cinesrc:response',command:'getCurrentTime',result:0});
  assert.equal(app.player.getStatus().buffering,true);assert.equal(app.player.getStatus().seconds,0);
  receive({type:'cinesrc:pause'});app.player.command('seek',{time:10});time=10000;
  receive({type:'cinesrc:response',command:'getCurrentTime',result:0});assert.equal(app.player.getStatus().seekPending,true);
  assert.equal(app.player.getStatus().buffering,true);
  receive({type:'cinesrc:seeked',currentTime:10,duration:1200});assert.equal(app.player.getStatus().seekPending,false);assert.equal(app.player.getStatus().buffering,false);
  app.player.command('play');time=15000;receive({type:'cinesrc:response',command:'getPaused',result:true});
  assert.equal(app.player.getStatus().needsGesture,true);app.player.command('pause');assert.equal(app.player.getStatus().buffering,true);
  receive({type:'cinesrc:play'});assert.equal(app.player.getStatus().needsGesture,false);assert.equal(app.player.getStatus().buffering,false);
});

test('pause and status before an iframe attaches do not throw',()=>{
  const app=harness();app.player.load(tv,'cinesrc');app.frames[0].contentWindow=null;
  assert.equal(app.player.command('pause'),false);assert.equal(app.player.requestStatus(),false);
});

test('frequent small time advances count as progress instead of false buffering',()=>{
  let time=0;const app=harness({now:()=>time});app.player.load(tv,'cinesrc');const frame=app.frames[0];
  const receive=data=>app.listeners.get('message')({origin:'https://cinesrc.st',source:frame.contentWindow,data});
  receive({type:'cinesrc:loadedmetadata',duration:1200});app.player.command('seek',{time:0});receive({type:'cinesrc:seeked',currentTime:0,duration:1200});receive({type:'cinesrc:play'});
  for(time=25;time<=6000;time+=25)receive({type:'cinesrc:timeupdate',currentTime:time/1000,duration:1200});
  assert.equal(app.player.getStatus().buffering,false);
});

const newProviders = {
  vidspark: { origin:'https://vidspark.to', message:(kind,time=0)=>({source:'vidspark-player',event:kind,currentTime:time,duration:1200, ...(kind==='playerstatus'?{paused:true}:{})}) },
  vidrift: { origin:'https://embed.vidrift.net', message:(kind,time=0)=>({type:({play:'vidrift:unpaused',pause:'vidrift:paused',timeupdate:'vidrift:progress',playerstatus:'vidrift:state'})[kind],currentTime:time,duration:1200,tmdbId:1396,mediaType:'tv',season:0,episode:1,...(kind==='playerstatus'?{paused:true}:{})}) },
  vidbolt: { origin:'https://vidbolt.pro', message:(kind,time=0)=>kind==='playerstatus'?{type:'durationchange',duration:1200}:{type:kind,time} }
};
function providerHarness(provider) {
  let time=0;
  const app=harness({now:()=>time});app.player.load(tv,provider);
  const frame=app.frames[0], spec=newProviders[provider];
  const receive=(kind,seconds=0)=>app.listeners.get('message')({origin:spec.origin,source:frame.contentWindow,data:spec.message(kind,seconds)});
  const settleSeek=()=>{for(const [id,fn] of [...app.timers]){app.timers.delete(id);fn();}};
  return {...app,frame,receive,settleSeek,setTime:value=>{time=value;},intents:()=>app.states.filter(s=>s.nativeIntent).map(s=>s.nativeIntent)};
}

test('new provider URLs and parsers enforce exact frames, origins, positions and available identity',()=>{
  for(const [provider,spec] of Object.entries(newProviders)){
    const url=new URL(embedUrl(tv,provider,30));assert.equal(url.origin,spec.origin);
    assert.equal(url.pathname,`${provider==='vidrift'?'/embed':''}/tv/1396/0/1`);
    const frame={contentWindow:{}};
    const event={origin:spec.origin,source:frame.contentWindow,data:spec.message('timeupdate',30)};
    assert.equal(playbackEvent(event,frame,tv,provider).seconds,30);
    assert.equal(playbackEvent({...event,source:{}},frame,tv,provider),null);
    assert.equal(playbackEvent({...event,origin:spec.origin+'.evil.test'},frame,tv,provider),null);
    assert.equal(playbackEvent({...event,data:spec.message('timeupdate',Infinity)},frame,tv,provider),null);
  }
  const frame={contentWindow:{}}, spec=newProviders.vidrift;
  assert.equal(playbackEvent({source:frame.contentWindow,origin:spec.origin,data:{...spec.message('timeupdate'),episode:2}},frame,tv,'vidrift').event,'mismatch');
  assert.equal(new URL(embedUrl(tv,'vidrift')).searchParams.get('autoplay'),'0');
  assert.equal(new URL(embedUrl(tv,'vidspark',30)).searchParams.get('t'),'30');
  const app=harness();app.player.load(tv);assert.equal(new URL(app.frames[0].src).origin,newProviders.vidrift.origin);
});

test('new provider commands use their documented envelopes and do not echo acknowledgements',()=>{
  const expected={
    vidspark:[{action:'seek',time:120},{action:'play'},{action:'pause'}],
    vidrift:[{type:'vidrift:resume',currentTime:120},{type:'vidrift:play'},{type:'vidrift:pause'}],
    vidbolt:[{type:'seek',time:120},{type:'play'},{type:'pause'}]
  };
  for(const provider of Object.keys(newProviders)){
    const a=providerHarness(provider);a.frame.onload();assert.equal(a.player.getStatus().ready,false);
    a.receive('playerstatus');a.receive('timeupdate');
    a.player.command('seek',{time:120});a.receive('timeupdate',120);
    a.player.command('play');a.receive('play',120);a.player.command('pause');a.receive('pause',120);
    assert.deepEqual(a.frame.commands.filter(c=>c.message.action!=='getStatus'&&c.message.type!=='vidrift:get-state'&&c.message.type!=='vidrift:nextup-info').map(c=>c.message),expected[provider]);
    assert.ok(a.frame.commands.every(c=>c.origin===newProviders[provider].origin));
    assert.deepEqual(a.intents(),[]);
    if(provider==='vidrift')assert.ok(a.frame.commands.some(c=>c.message.type==='vidrift:nextup-info'&&c.message.next===null));
    if(provider==='vidbolt')assert.equal(a.player.requestStatus(),false);
  }
});

test('native play/pause and debounced native seeking work for all three new protocols',()=>{
  for(const provider of Object.keys(newProviders)){
    const a=providerHarness(provider);a.receive('playerstatus');a.receive('timeupdate');
    a.receive('play');a.setTime(1000);a.receive('timeupdate',1);a.receive('pause',1);
    assert.deepEqual(a.intents(),[{action:'play'},{action:'pause'}]);
    a.setTime(2000);a.receive('timeupdate',41);a.receive('timeupdate',51);
    assert.equal(a.player.getStatus().seekPending,true);a.settleSeek();
    assert.deepEqual(a.intents().at(-1),{action:'seek',seconds:51});assert.equal(a.intents().filter(i=>i.action==='seek').length,1);
    a.receive('timeupdate',10);a.settleSeek();a.receive('play',10);
    for(let t=2100;t<=8000;t+=100){a.setTime(t);a.receive('timeupdate',10+(t-2000)/1000);}
    assert.equal(a.player.getStatus().buffering,false);
  }
});

test('buffering and heuristic seek events cannot clear play intent; quiet paused VidBolt stays ready',()=>{
  const a=providerHarness('vidspark');a.receive('playerstatus');a.receive('timeupdate',10);a.settleSeek();a.receive('play',10);
  const before=a.intents().length;a.setTime(6000);a.receive('pause',10);a.receive('seeked',10);a.settleSeek();
  assert.equal(a.intents().length,before);
  const b=providerHarness('vidbolt');b.receive('playerstatus');b.receive('timeupdate');b.setTime(60000);
  assert.equal(b.player.getStatus().buffering,false);b.receive('timeupdate',60);b.player.clear();b.settleSeek();assert.deepEqual(b.intents(),[]);
});

test('a delayed saved-progress restore during initialization never becomes a native room seek',()=>{
  for(const provider of Object.keys(newProviders)){
    const a=providerHarness(provider);a.receive('playerstatus');a.receive('timeupdate');a.player.command('seek',{time:0});a.receive('timeupdate');
    a.setTime(5000);a.receive('timeupdate',370);a.settleSeek();assert.deepEqual(a.intents(),[]);
  }
});

test('timestamp-free VidBolt Play/Pause acknowledgements never turn a long pause into native seeking',()=>{
  const a=providerHarness('vidbolt');
  const receive=data=>a.listeners.get('message')({origin:newProviders.vidbolt.origin,source:a.frame.contentWindow,data});
  a.receive('playerstatus');a.receive('timeupdate');
  let time=0,seconds=0;
  for(let i=0;i<8;i++){
    time+=10000;a.setTime(time);a.player.command('play');receive({type:'play'});
    time+=250;seconds+=0.25;a.setTime(time);a.receive('timeupdate',seconds);
    time+=250;seconds+=0.25;a.setTime(time);a.receive('timeupdate',seconds);
    a.player.command('pause');receive({type:'pause'});a.settleSeek();
  }
  assert.deepEqual(a.intents(),[]);
});
