const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {randomUUID}=require('node:crypto'),{Readable}=require('node:stream'),{PGlite}=require('@electric-sql/pglite');
const {createPickerHandler}=require('./picker'),{eligible,angle}=require('../frontend/picker');
test('shared picker enforces both accounts, genre vetoes, title minimums, one result and stale round protection',async()=>{
  const db=new PGlite();try{
    await db.exec(`create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;`);
    for(const file of ['schema.sql','playback.sql','phase2.sql','picker.sql','picker.sql'])await db.exec(fs.readFileSync(path.join(__dirname,file),'utf8'));
    const [a,b,c]=Array.from({length:3},randomUUID);await db.query('insert into auth.users values($1),($2),($3)',[a,b,c]);
    const as=async id=>{await db.exec('set role authenticated');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);};
    const rpc=async(name,args=[])=> (await db.query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) result`,args)).rows[0].result;
    await as(a);const room=await rpc('create_watch_room',['Us']);
    const action=(kind,id=null,expected=null,mode=null,options=[],choices=[])=>rpc('watch_picker',[room.roomId,kind,id,expected,mode,options,choices]);
    const genres=['Action','Drama','Romance'].map(title=>({key:'genre:'+title,title}));const round=randomUUID();
    let state=await action('start',round,null,'genre',genres);assert.equal(state.ready,false);
    state=await action('submit',round,null,null,[],['genre:Action']);assert.equal(state.ready,false);await assert.rejects(action('spin',round),/Both partners/);
    await as(b);await rpc('join_watch_room',[room.inviteCode]);state=await action('submit',round,null,null,[],['genre:Action']);
    assert.equal(state.ready,true);assert.deepEqual(state.pool.map(o=>o.title),['Drama','Romance']);
    await as(a);state=await action('submit',round,null,null,[],genres.map(o=>o.key));assert.equal(state.pool.length,0);await assert.rejects(action('spin',round),/All genres/);
    state=await action('submit',round,null,null,[],['genre:Drama']);assert.deepEqual(state.pool.map(o=>o.title),['Romance']);
    const spun=await action('spin',round);assert.equal(spun.result.title,'Romance');assert.equal(spun.resultIndex,0);assert.ok(Date.parse(spun.spinAt)-Date.parse(spun.serverTime)>2500);
    await as(b);assert.deepEqual((await action('spin',round)).result,spun.result);assert.equal((await action('submit',round,null,null,[],[])).revision,spun.revision);
    await as(c);await assert.rejects(action('get'),/membership/);assert.equal((await db.query('select * from watch_room_picker')).rows.length,0);
    await as(a);await assert.rejects(db.query("update watch_room_picker set submissions='{}'"),/permission denied/);
    const titlesRound=randomUUID();assert.equal((await action('start',titlesRound,randomUUID(),'title')).conflict,true);
    state=await action('start',titlesRound,round,'title');assert.equal(state.members.every(m=>!m.submitted),true);assert.equal((await action('spin',round)).conflict,true);
    const movie={key:'movie:1',mediaType:'movie',tmdbId:1,title:'Movie'},show={key:'tv:1',mediaType:'tv',tmdbId:1,title:'Series'};
    await assert.rejects(action('submit',titlesRound,null,null,[],[movie]),/at least two/);
    await assert.rejects(action('submit',titlesRound,null,null,[],[movie,movie]),/at least two/);
    await action('submit',titlesRound,null,null,[],[movie,show]);await as(b);state=await action('submit',titlesRound,null,null,[],[movie,show]);assert.equal(state.pool.length,2);assert.equal(state.ready,true);
    const chosen=await action('spin',titlesRound);assert.ok(['movie:1','tv:1'].includes(chosen.result.key));assert.deepEqual((await action('spin',titlesRound)).result,chosen.result);
    const fallback=randomUUID();await action('start',fallback,titlesRound,'trending',[movie,show]);await action('submit',fallback);await as(a);state=await action('submit',fallback);assert.equal(state.ready,true);assert.equal(state.pool.length,2);assert.ok((await action('spin',fallback)).result);
    const manyRound=randomUUID(),manyGenres=Array.from({length:30},(_,i)=>({key:'genre:'+i,title:'Genre '+i}));
    await action('start',manyRound,fallback,'genre',manyGenres);
    state=await action('submit',manyRound,null,null,[],manyGenres.map(g=>g.key));assert.equal(state.pool.length,0);
    await as(b);await action('submit',manyRound);await assert.rejects(action('spin',manyRound),/All genres/);
  }finally{await db.close();}
});

test('picker API authenticates membership before TMDB and canonicalizes titles without trusting client actors or options',async()=>{
  process.env.SUPABASE_URL='https://db.test';process.env.SUPABASE_PUBLISHABLE_KEY='public';process.env.TMDB_READ_ACCESS_TOKEN='tmdb-test';
  const room=randomUUID(),user=randomUUID(),round=randomUUID(),calls=[];let member=false;
  const handler=createPickerHandler({authenticateUser:async()=>({data:{userClaims:{id:user}}}),fetchImpl:async(url,options)=>{
    calls.push({url,options});return {ok:true,json:async()=>url.includes('watch_room_members')?member?[{user_id:user}]:[]:url.includes('api.themoviedb')?url.includes('genre/')?{genres:[{name:'Drama'}]}:{id:Number(new URL(url).pathname.split('/').pop()),title:'Canonical title'}:{roundId:round}};
  }});
  const call=async body=>{const req=Readable.from([JSON.stringify(body)]);Object.assign(req,{url:`/api/rooms/${room}/picker`,method:'POST',headers:{authorization:'Bearer user'}});let out;await handler(req,{},(_r,status,data)=>out={status,data});return out;};
  assert.equal((await call({action:'start',roundId:round,mode:'genre'})).status,403);assert.equal(calls.length,1);member=true;
  assert.equal((await call({action:'start',roundId:round,mode:'genre',options:[{title:'Forged'}],userId:'partner'})).status,200);
  let args=JSON.parse(calls.at(-1).options.body);assert.equal(args.p_options[0].title,'Drama');assert.equal(args.userId,undefined);assert.equal(calls.at(-1).options.headers.Authorization,'Bearer user');
  assert.equal((await call({action:'submit',roundId:round,choices:[{mediaType:'movie',tmdbId:1,title:'Fake'},{mediaType:'tv',tmdbId:2,title:'Fake'}],userId:'partner'})).status,200);
  args=JSON.parse(calls.at(-1).options.body);assert.deepEqual(args.p_choices.map(t=>t.title),['Canonical title','Canonical title']);assert.deepEqual(args.p_choices.map(t=>t.key),['movie:1','tv:2']);
});

test('wheel geometry lands on the chosen slice; either veto excludes a genre and duplicate titles get one slot',()=>{
  for(let count=1;count<=50;count++)for(let i=0;i<count;i++)assert.ok(Math.abs((((i+.5)*360/count+angle(i,count))%360))<.00001 || Math.abs((((i+.5)*360/count+angle(i,count))%360)-360)<.00001);
  const options=[{key:'a'},{key:'b'},{key:'c'}];assert.deepEqual(eligible('genre',options,[{choices:['a']},{choices:['b']}]),[{key:'c'}]);
  assert.equal(eligible('title',[],[{choices:[{key:'movie:1'}]},{choices:[{key:'movie:1'},{key:'tv:1'}]}]).length,2);
});
