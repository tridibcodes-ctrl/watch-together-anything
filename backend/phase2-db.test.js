const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const sql = file => fs.readFileSync(path.join(__dirname, file), 'utf8');
async function fixture() {
  const db = new PGlite();
  await db.exec(`create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;`);
  await db.exec(sql('schema.sql')); await db.exec(sql('playback.sql'));
  const [a,b,c] = Array.from({length:3}, randomUUID);
  await db.query('insert into auth.users values($1),($2),($3)', [a,b,c]);
  const as = async actor => { await db.exec('set role authenticated'); await db.query("select set_config('request.jwt.claim.sub',$1,false)", [actor]); };
  const rpc = async (name, args = []) => (await db.query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) result`, args)).rows[0].result;
  return {db,a,b,c,as,rpc};
}
test('couples reuse one room, allow different partners, rename safely, and block duplicate direct joins', async () => {
  const f = await fixture(); const {db,a,b,c,as,rpc} = f;
  try {
    await db.exec(sql('phase2.sql')); await db.exec(sql('phase2.sql'));
    await as(a); const first = await rpc('create_watch_room',['First']);
    await as(b); assert.equal((await rpc('join_watch_room',[first.inviteCode])).roomId, first.roomId);
    assert.equal((await rpc('join_watch_room',[first.inviteCode])).roomId, first.roomId); // full-room retry
    await as(a); const second = await rpc('create_watch_room',['Another invitation']);
    await as(b); assert.equal((await rpc('join_watch_room',[second.inviteCode])).roomId, first.roomId);
    await as(c); assert.equal((await rpc('join_watch_room',[second.inviteCode])).roomId, second.roomId);
    await assert.rejects(rpc('join_watch_room',[first.inviteCode]), /two members/);
    await assert.rejects(rpc('rename_watch_room',[first.roomId,'Intrusion']), /membership/);
    await as(b); await rpc('rename_watch_room',[first.roomId,'Our cinema']);
    await assert.rejects(rpc('rename_watch_room',[first.roomId,' ']), /1 to 60/);
    await db.exec('reset role');
    assert.equal((await db.query('select name from watch_rooms where id=$1',[first.roomId])).rows[0].name,'Our cinema');
    const third = randomUUID();
    await db.query("insert into watch_rooms(id,invite_code) values($1,'third')",[third]);
    await db.query('insert into watch_room_members values($1,$2,now())',[third,b]);
    await assert.rejects(db.query('insert into watch_room_members values($1,$2,now())',[third,a]), /already has a room/);
  } finally { await db.close(); }
});

test('shared history resumes each title/episode; completion needs both accounts and undo rejects stale confirmation', async () => {
  const {db,a,b,c,as,rpc} = await fixture();
  try {
    await db.exec(sql('phase2.sql')); await as(a); const room = await rpc('create_watch_room',['Us']);
    await as(b); await rpc('join_watch_room',[room.inviteCode]);
    let state; const action = async (kind, media=null, position=null) => {
      const result=await rpc('watch_playback',[room.roomId,kind,kind==='get'?null:randomUUID(),state?.revision??0,state?.sessionId??null,media,null,position]);
      assert.equal(result.outcome,'ok'); state=result.state; return state;
    };
    const movie={mediaType:'movie',tmdbId:155,title:'Movie'};
    await action('media',movie); await action('seek',null,42000);
    const episode={mediaType:'tv',tmdbId:1396,title:'Show',season:1,episode:1};
    await action('media',episode); await action('seek',null,73000);
    await action('media',{...episode,episode:2}); assert.equal(state.positionMs,0);
    await action('media',movie); assert.equal(state.positionMs,42000);
    await action('media',episode); assert.equal(state.positionMs,73000);
    const session=state.sessionId;
    await as(a); let history=await rpc('watch_confirm_completion',[room.roomId,session,1,true]);
    let item=history.items.find(item=>item.media.episode===1);
    assert.equal(item.completedAt,null); assert.equal(item.confirmedBy.length,1);
    history=await rpc('watch_confirm_completion',[room.roomId,session,1,true]);
    assert.equal(history.items.find(item=>item.media.episode===1).confirmedBy.length,1);
    await as(c); await assert.rejects(rpc('watch_confirm_completion',[room.roomId,session,1,true]), /membership/);
    await assert.rejects(rpc('watch_progress',[room.roomId]), /membership/);
    await as(b); history=await rpc('watch_confirm_completion',[room.roomId,session,1,true]);
    assert.ok(history.items.find(item=>item.media.episode===1).completedAt);
    assert.equal(history.items.find(item=>item.media.episode===2).completedAt,null);
    assert.equal(history.items.find(item=>item.media.mediaType==='movie').completedAt,null);
    history=await rpc('watch_confirm_completion',[room.roomId,session,1,false]);
    item=history.items.find(item=>item.media.episode===1); assert.equal(item.completedAt,null);assert.equal(item.completionEpoch,2);assert.equal(item.confirmedBy.length,0);
    assert.equal((await rpc('watch_confirm_completion',[room.roomId,session,1,true])).conflict,true);
    assert.equal((await rpc('watch_confirm_completion',[room.roomId,randomUUID(),2,true])).conflict,true);
    await assert.rejects(db.query('update watch_room_progress set completed_at=now()'), /permission denied/);
    await as(a); await rpc('watch_confirm_completion',[room.roomId,session,2,true]);
    await action('get'); await action('media',movie); await action('media',episode);
    item=(await rpc('watch_progress',[room.roomId])).items.find(item=>item.media.episode===1);
    assert.equal(item.confirmedBy.length,0);assert.ok(item.completionEpoch>2);
    await as(b); history=await rpc('watch_confirm_completion',[room.roomId,state.sessionId,item.completionEpoch,true]);
    assert.equal(history.items.find(item=>item.media.episode===1).completedAt,null);
    await as(c); assert.equal((await db.query('select * from watch_room_progress')).rows.length,0);
    await db.exec('reset role'); await db.exec(sql('phase2.sql')); await as(a);
    assert.equal((await rpc('watch_progress',[room.roomId])).items.find(item=>item.media.episode===1).positionMs,73000);
  } finally { await db.close(); }
});

test('upgrade archives duplicate pairs and combines chat, lists and playback history without losing messages', async () => {
  const {db,a,b,as,rpc} = await fixture();
  try {
    await as(a); const first=await rpc('create_watch_room',['First']); const second=await rpc('create_watch_room',['Second']);
    await as(b); await rpc('join_watch_room',[first.inviteCode]); await rpc('join_watch_room',[second.inviteCode]);
    await db.exec('reset role');
    for(const room of [first,second]) {
      await db.query("insert into watch_room_messages(room_id,sender_id,client_message_id,sender_name,body) values($1,$2,$3,'A',$4)",[room.roomId,a,a,room.name]);
      await db.query("insert into watch_room_list_items(room_id,media_type,tmdb_id,title,added_by) values($1,'movie',$2,$3,$4)",[room.roomId,room===first?155:27205,room.name,a]);
    }
    await as(a); await rpc('watch_playback',[second.roomId,'media',randomUUID(),0,null,{mediaType:'movie',tmdbId:27205,title:'Second'}]);
    await db.exec('reset role'); await db.exec(sql('phase2.sql'));await db.exec(sql('phase2.sql'));
    const canonical=(await db.query('select room_id from watch_couples')).rows[0].room_id;
    assert.equal((await db.query('select * from watch_rooms')).rows.length,2);
    assert.equal((await db.query('select * from watch_room_messages where room_id=$1',[canonical])).rows.length,2);
    assert.equal((await db.query('select * from watch_room_list_items where room_id=$1',[canonical])).rows.length,2);
    await as(b); assert.equal((await rpc('join_watch_room',[second.inviteCode])).roomId,canonical);
    const rooms=(await rpc('get_watch_rooms')).items;
    assert.equal(rooms.length,1);assert.equal(rooms[0].roomId,canonical);assert.equal(rooms[0].aliases.length,1);
    assert.equal((await rpc('watch_progress',[canonical])).items[0].media.tmdbId,27205);
  } finally { await db.close(); }
});

test('progress uses the shared clock and freezes at readiness expiry, not at the late reconnect time', async () => {
  const {db,a,b,as,rpc} = await fixture();
  try {
    await db.exec(sql('phase2.sql')); await as(a); const room=await rpc('create_watch_room',['Us']);
    await as(b); await rpc('join_watch_room',[room.inviteCode]);
    let state=(await rpc('watch_playback',[room.roomId,'media',randomUUID(),0,null,{mediaType:'movie',tmdbId:155,title:'Movie'}])).state;
    for(const actor of [a,b]) {
      await as(actor); await rpc('watch_report_readiness',[room.roomId,state.sessionId,state.provider,state.readyEpoch,actor,true,true]);
    }
    state=(await rpc('watch_playback',[room.roomId,'play',randomUUID(),state.revision,state.sessionId])).state;
    assert.equal(state.status,'playing');
    await db.exec('reset role');
    await db.query("update watch_room_playback set anchor_at=clock_timestamp()-interval '60 seconds',position_ms=0 where room_id=$1",[room.roomId]);
    await db.query("update watch_playback_readiness set updated_at=clock_timestamp()-interval '30 seconds' where room_id=$1",[room.roomId]);
    await as(a); const progress=(await rpc('watch_progress',[room.roomId])).items[0];
    assert.ok(progress.positionMs>=44900 && progress.positionMs<47000, String(progress.positionMs));
    const next=(await rpc('watch_progress',[room.roomId])).items[0];
    assert.equal(next.positionMs,progress.positionMs);
    await db.exec('reset role');
    assert.equal((await db.query('select count(*)::int n from watch_room_list_items where room_id=$1',[room.roomId])).rows[0].n,1);
  } finally { await db.close(); }
});
