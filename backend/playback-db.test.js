const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');

test('PostgreSQL playback transactions enforce membership, revisions, sessions, deduplication and RLS', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated;
      create schema auth;
      create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as
        $$ select nullif(current_setting('request.jwt.claim.sub', true),'')::uuid $$;
      grant usage on schema auth to authenticated;
      grant execute on function auth.uid() to authenticated;
    `);
    await db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
    const migration = fs.readFileSync(path.join(__dirname, 'playback.sql'), 'utf8');
    await db.exec(migration); await db.exec(migration);
    const [a,b,outsider,room] = Array.from({length:4}, randomUUID);
    await db.query('insert into auth.users values ($1),($2),($3)',[a,b,outsider]);
    await db.query("insert into public.watch_rooms(id,name,created_by,invite_code) values($1,'Test room',$2,'test-code')",[room,a]);
    await db.query('insert into public.watch_room_members(room_id,user_id) values ($1,$2),($1,$3)',[room,a,b]);
    await db.exec('set role authenticated');
    const as = user => db.query("select set_config('request.jwt.claim.sub',$1,false)",[user]);
    const call = async ({action='get',id=null,revision=null,session=null,media=null,provider=null,position=null}={}) =>
      (await db.query('select public.watch_playback($1,$2,$3,$4,$5,$6,$7,$8) as result',[room,action,id,revision,session,media,provider,position])).rows[0].result;
    await as(outsider);
    await assert.rejects(call(), /Room membership required/);
    await as(a); assert.equal((await call()).state.revision,0);
    const id = randomUUID();
    const media = {mediaType:'movie',tmdbId:155,title:'Movie'};
    const first = await call({action:'media',id,revision:0,media});
    assert.equal(first.state.revision,1);
    assert.equal(first.state.provider,'vidspark');
    assert.equal(first.state.status,'paused');
    const session = first.state.sessionId;
    assert.equal((await call({action:'media',id,revision:0,media})).outcome,'duplicate');
    assert.equal((await call({action:'media',id,revision:0,media:{...media,tmdbId:27205}})).outcome,'conflict');
    const clients = [randomUUID(),randomUUID()];
    await db.query('select public.watch_report_readiness($1,$2,$3,$4,$5,$6,$7)',[room,session,'vidspark',first.state.readyEpoch,clients[0],true,true]);
    await as(b);
    await db.query('select public.watch_report_readiness($1,$2,$3,$4,$5,$6,$7)',[room,session,'vidspark',first.state.readyEpoch,clients[1],true,true]);
    const play = await call({action:'play',id:randomUUID(),revision:1,session});
    assert.equal(play.state.status,'playing');
    assert.equal(play.state.revision,2);
    const competing = await call({action:'pause',id:randomUUID(),revision:1,session});
    assert.equal(competing.outcome,'conflict'); assert.equal(competing.state.status,'playing');
    const seek = await call({action:'seek',id:randomUUID(),revision:2,session,position:120000});
    assert.equal(seek.state.positionMs,120000);
    const switched = await call({action:'provider',id:randomUUID(),revision:3,session,provider:'vidlink'});
    assert.equal(switched.state.status,'paused'); assert.ok(switched.state.positionMs>=120000);
    assert.equal((await call({action:'pause',id:randomUUID(),revision:4,session:randomUUID()})).outcome,'conflict');
    await assert.rejects(call({action:'seek',id:randomUUID(),revision:4,session,position:-1}),/Invalid seek/);
    await assert.rejects(call({action:'media',id:randomUUID(),revision:4,media:{mediaType:'tv',tmdbId:1396,title:'Show',season:1,episode:0}}),/Invalid TV episode/);
    await assert.rejects(db.query('update public.watch_room_playback set revision=99 where room_id=$1',[room]),/permission denied/);
    await assert.rejects(db.query('select * from public.watch_playback_commands'),/permission denied/);
    await as(outsider); assert.equal((await db.query('select * from public.watch_room_playback')).rows.length,0);
    await as(a); assert.equal((await call()).state.revision,4);
    const alternative = await call({action:'provider',id:randomUUID(),revision:4,session,provider:'cinesrc'});
    assert.equal(alternative.state.provider,'cinesrc');
    assert.equal(alternative.state.status,'paused');
    const legacy = await call({action:'provider',id:randomUUID(),revision:5,session,provider:'cinemaos'});
    assert.equal(legacy.state.provider,'cinemaos');
    await db.exec('reset role');
    await db.exec("alter table public.watch_room_playback drop constraint watch_room_playback_provider_check; alter table public.watch_room_playback add constraint watch_room_playback_provider_check check (provider in ('cinemaos','vidlink'))");
    await db.exec(migration); await db.exec('set role authenticated'); await as(a);
    assert.equal((await call()).state.provider,'cinemaos');
    assert.equal((await call()).state.revision,6);
    assert.equal((await call({action:'provider',id:randomUUID(),revision:6,session,provider:'cinesrc'})).state.provider,'cinesrc');
    await db.exec('set role anon');
    await assert.rejects(call(),/permission denied/);
  } finally { await db.close(); }
});

async function readinessFixture() {
  const db=new PGlite();
  await db.exec(`create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;`);
  await db.exec(fs.readFileSync(path.join(__dirname,'schema.sql'),'utf8'));
  await db.exec(fs.readFileSync(path.join(__dirname,'playback.sql'),'utf8'));
  const [a,b,outsider,room]=Array.from({length:4},randomUUID);
  await db.query('insert into auth.users values($1),($2),($3)',[a,b,outsider]);
  await db.query("insert into watch_rooms(id,created_by,invite_code) values($1,$2,'code')",[room,a]);
  await db.query('insert into watch_room_members(room_id,user_id) values($1,$2),($1,$3)',[room,a,b]);
  await db.exec('set role authenticated');let state;
  const as=actor=>db.query("select set_config('request.jwt.claim.sub',$1,false)",[actor]);
  async function action(kind='get',extra={},actor=a){
    await as(actor);
    const result=(await db.query('select public.watch_playback($1,$2,$3,$4,$5,$6,$7,$8) result',[
      room,kind,kind==='get'?null:randomUUID(),state?.revision??0,state?.sessionId??null,extra.media??null,extra.provider??null,extra.position??null
    ])).rows[0].result;
    state=result.state;return result;
  }
  async function report(actor,ready,snapshot=state,joined=true){
    await as(actor);
    const result=(await db.query('select public.watch_report_readiness($1,$2,$3,$4,$5,$6,$7) result',[
      room,snapshot.sessionId,snapshot.provider,snapshot.readyEpoch,actor,ready,joined
    ])).rows[0].result;state=result.state;return result;
  }
  await action('media',{media:{mediaType:'movie',tmdbId:155,title:'Movie'}});
  return {db,a,b,outsider,room,as,action,report,state:()=>state};
}

test('named readiness and server-authored playback notices survive retries without attributing automatic holds',async()=>{
  const f=await readinessFixture();
  try {
    await f.db.exec('reset role');
    await f.db.exec('grant select,insert on public.watch_room_messages to authenticated');
    await f.db.query("insert into profiles(user_id,display_name) values($1,'Tridib'),($2,'Partner name')",[f.a,f.b]);
    await f.db.exec('set role authenticated');
    await f.report(f.a,true);await f.report(f.b,false);
    assert.equal(f.state().readiness.members.find(m=>m.userId===f.a).ready,true);
    assert.deepEqual(f.state().readiness.members.find(m=>m.userId===f.b),{userId:f.b,displayName:'Partner name',ready:false});
    await f.action('play');
    let rows=(await f.db.query("select body,kind,sender_id from watch_room_messages where room_id=$1",[f.room])).rows;
    assert.equal(rows.length,1);assert.equal(rows[0].kind,'playback');assert.equal(rows[0].sender_id,f.a);assert.match(rows[0].body,/Tridib has pressed Play/);
    await f.report(f.b,true);await f.report(f.b,false); // automatic start and buffering hold
    assert.equal((await f.db.query('select * from watch_room_messages')).rows.length,1);
    const id=randomUUID(),before=f.state();await f.as(f.b);
    const pause=()=>f.db.query('select watch_playback($1,$2,$3,$4,$5) result',[f.room,'pause',id,before.revision,before.sessionId]);
    assert.equal((await pause()).rows[0].result.outcome,'ok');assert.equal((await pause()).rows[0].result.outcome,'duplicate');
    rows=(await f.db.query('select body from watch_room_messages order by created_at,id')).rows;
    assert.equal(rows.length,2);assert.ok(rows.some(row=>row.body==='Partner name has paused.'));
    await f.action('get');await f.report(f.a,true);await f.report(f.b,true);await f.action('play');
    assert.ok((await f.db.query('select body from watch_room_messages')).rows.some(row=>row.body==='Tridib has started playback.'));
    await assert.rejects(f.db.query("insert into watch_room_messages(room_id,sender_id,client_message_id,sender_name,body,kind) values($1,$2,$3,'Forged','Forged notice','playback')",[f.room,f.b,randomUUID()]),/row-level security/i);
  } finally {await f.db.close();}
});

test('readiness freezes the room for a slow partner, resumes both, and respects manual pause and epochs',async()=>{
  const f=await readinessFixture();
  try{
    await f.action('play');assert.equal(f.state().status,'paused');assert.equal(f.state().playRequested,true);
    const original=f.state();await f.report(f.a,true);await f.report(f.b,false);
    assert.equal(f.state().readiness.readyCount,1);assert.equal(f.state().waitingForReady,true);
    await f.action();assert.equal(f.state().positionMs,0);
    await f.report(f.b,true);assert.equal(f.state().status,'playing');assert.equal(f.state().readiness.readyCount,2);
    await f.report(f.b,false);assert.equal(f.state().status,'paused');assert.ok(f.state().readyEpoch>original.readyEpoch);
    const frozen=f.state().positionMs;await f.action();assert.equal(f.state().positionMs,frozen);
    const stale=await f.report(f.a,true,original);assert.equal(stale.outcome,'conflict');assert.equal(f.state().status,'paused');
    await f.report(f.a,true);await f.report(f.b,true);assert.equal(f.state().status,'playing');
    await f.action('pause');assert.equal(f.state().playRequested,false);
    await f.report(f.a,true);await f.report(f.b,true);assert.equal(f.state().status,'paused');assert.equal(f.state().readiness.bothReady,true);
    await f.action('play');assert.equal(f.state().status,'playing');
    await f.action('seek',{position:120000});assert.equal(f.state().status,'paused');assert.equal(f.state().positionMs,120000);assert.equal(f.state().playRequested,true);
    await f.report(f.a,true);await f.report(f.b,true);assert.equal(f.state().status,'playing');
    const beforeProvider=f.state();await f.action('provider',{provider:'cinemaos'});assert.equal(f.state().readiness.readyCount,0);
    await f.report(f.a,true,beforeProvider);assert.equal(f.state().readiness.readyCount,0);
    await assert.rejects(f.report(f.outsider,true),/membership/i);
    await f.as(f.a);await assert.rejects(f.db.query('select * from public.watch_playback_readiness'),/permission denied/);
  }finally{await f.db.close();}
});

test('expired readiness leases pause at lease expiry and leaving pauses the partner',async()=>{
  const f=await readinessFixture();
  try{
    await f.report(f.a,true);await f.report(f.b,true);await f.action('play');assert.equal(f.state().status,'playing');
    await f.db.exec('reset role');
    await f.db.exec("update watch_room_playback set position_ms=10000,anchor_at=clock_timestamp()-interval '30 seconds'; update watch_playback_readiness set updated_at=clock_timestamp()-interval '30 seconds'");
    await f.db.exec('set role authenticated');await f.action();
    assert.equal(f.state().status,'paused');assert.ok(f.state().positionMs>=24000&&f.state().positionMs<28000);
    const held=f.state().positionMs;await f.action();assert.equal(f.state().positionMs,held);
    await f.report(f.a,true);await f.report(f.b,true);assert.equal(f.state().status,'playing');
    await f.report(f.b,false,f.state(),false);assert.equal(f.state().status,'paused');assert.equal(f.state().playRequested,true);
  }finally{await f.db.close();}
});

test('each added provider uses the two-account gate and survives migration reapplication',async()=>{
  const f=await readinessFixture();
  try{
    for(const provider of ['vidspark','vidrift','vidbolt']){
      await f.action('provider',{provider});assert.equal(f.state().provider,provider);assert.equal(f.state().status,'paused');
      await f.action('play');await f.report(f.a,true);await f.report(f.b,false);assert.equal(f.state().status,'paused');
      await f.report(f.b,true);assert.equal(f.state().status,'playing');
      await f.report(f.b,false);assert.equal(f.state().status,'paused');assert.equal(f.state().playRequested,true);
      const saved=f.state();await f.db.exec('reset role');await f.db.exec(fs.readFileSync(path.join(__dirname,'playback.sql'),'utf8'));await f.db.exec('set role authenticated');await f.action();
      assert.equal(f.state().provider,provider);assert.equal(f.state().sessionId,saved.sessionId);assert.equal(f.state().positionMs,saved.positionMs);
      await f.report(f.a,true);await f.report(f.b,true);assert.equal(f.state().status,'playing');
      await f.action('pause');await f.report(f.a,true);await f.report(f.b,true);assert.equal(f.state().status,'paused');assert.equal(f.state().playRequested,false);
    }
  }finally{await f.db.close();}
});
