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
    assert.equal(first.state.status,'paused');
    const session = first.state.sessionId;
    assert.equal((await call({action:'media',id,revision:0,media})).outcome,'duplicate');
    assert.equal((await call({action:'media',id,revision:0,media:{...media,tmdbId:27205}})).outcome,'conflict');
    await as(b);
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
    await db.exec('set role anon');
    await assert.rejects(call(),/permission denied/);
  } finally { await db.close(); }
});
