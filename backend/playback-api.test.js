const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { randomUUID } = require('node:crypto');
const { createPlaybackHandler } = require('./playback');

test('API allows new providers in commands/readiness and rejects unknown or manual readiness providers', async()=>{
  process.env.SUPABASE_URL='https://db.test';process.env.SUPABASE_PUBLISHABLE_KEY='publishable-test';
  const room=randomUUID(), actor=randomUUID(), session=randomUUID(), calls=[];
  const handler=createPlaybackHandler({authenticateUser:async()=>({data:{userClaims:{id:actor}}}),fetchImpl:async(url,options)=>{
    if(url.includes('/watch_room_members?'))return {ok:true,json:async()=>[{user_id:actor}]};
    calls.push({url,body:JSON.parse(options.body)});return {ok:true,json:async()=>({outcome:'ok',state:{roomId:room}})};
  }});
  async function request(route,provider){
    const body=route==='readiness'?{clientId:randomUUID(),sessionId:session,epoch:1,ready:true,joined:true,provider}:{commandId:randomUUID(),expectedRevision:1,sessionId:session,action:'provider',provider};
    const req=Readable.from([JSON.stringify(body)]);req.method='POST';req.url=`/api/rooms/${room}/${route}`;req.headers={authorization:'Bearer test'};
    let result;await handler(req,{},(_,status,data)=>{result={status,data};});return result;
  }
  for(const provider of ['vidspark','vidrift','vidbolt','cinesrc','cinemaos']){
    assert.equal((await request('commands',provider)).status,200);assert.equal(calls.at(-1).body.p_provider,provider);
    assert.equal((await request('readiness',provider)).status,200);assert.ok(calls.at(-1).url.endsWith('/watch_report_readiness'));
  }
  assert.equal((await request('commands','vidlink')).status,400);
  const before=calls.length;
  for(const provider of ['vidlink','__proto__','https://evil.test',null])assert.equal((await request('readiness',provider)).status,400);
  for(const provider of ['__proto__','https://evil.test',null])assert.equal((await request('commands',provider)).status,400);
  assert.equal(calls.length,before);
});
