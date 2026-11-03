const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {Readable}=require('node:stream'),{randomUUID}=require('node:crypto'),{PGlite}=require('@electric-sql/pglite');
const {createInvitationHandler}=require('./invitations');
const sql=file=>fs.readFileSync(path.join(__dirname,file),'utf8');

test('movie invitations are atomic, private, idempotent, recipient-only and bound to the selected session',async()=>{
  const db=new PGlite();
  try{
    await db.exec(`create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;`);
    for(const file of ['schema.sql','playback.sql','phase2.sql','watch-invitations.sql','watch-invitations.sql'])await db.exec(sql(file));
    const [a,b,c]=Array.from({length:3},randomUUID);
    await db.query('insert into auth.users values($1),($2),($3)',[a,b,c]);
    const as=async actor=>{await db.exec('set role authenticated');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[actor]);};
    const rpc=async(name,args=[])=> (await db.query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) result`,args)).rows[0].result;
    await as(a);const room=await rpc('create_watch_room',['Us']);
    await as(b);await rpc('join_watch_room',[room.inviteCode]);await as(a);
    const select=async(id,revision)=> (await rpc('watch_playback',[room.roomId,'media',randomUUID(),revision,null,{mediaType:'movie',tmdbId:id,title:'Movie'},null,null])).state;
    let state=await select(155,0);
    let inbox=await rpc('watch_invitation_inbox');assert.equal(inbox.items.length,1);
    const first=inbox.items[0];assert.equal(first.senderId,a);assert.equal(first.recipientId,b);assert.equal(first.sessionId,state.sessionId);
    assert.equal((await rpc('watch_invite',[room.roomId,state.sessionId])).id,first.id);
    await assert.rejects(rpc('watch_respond_invitation',[first.id,true]),/not for your account/);
    await assert.rejects(db.query("update watch_invitations set status='accepted'"),/permission denied/);
    await as(c);assert.equal((await rpc('watch_invitation_inbox')).items.length,0);assert.equal((await db.query('select * from watch_invitations')).rows.length,0);
    await assert.rejects(rpc('watch_invite',[room.roomId,state.sessionId]),/membership/);
    await as(b);assert.equal((await rpc('watch_respond_invitation',[first.id,false])).status,'declined');
    assert.equal((await rpc('watch_respond_invitation',[first.id,true])).conflict,true);
    await as(a);const retry=await rpc('watch_invite',[room.roomId,state.sessionId]);assert.notEqual(retry.id,first.id);
    await as(b);assert.equal((await rpc('watch_respond_invitation',[retry.id,true])).status,'accepted');
    assert.equal((await rpc('watch_respond_invitation',[retry.id,true])).status,'accepted');
    await as(a);state=await select(27205,state.revision);
    const next=(await rpc('watch_invitation_inbox')).items[0];assert.notEqual(next.id,retry.id);
    await as(b);await assert.rejects(rpc('watch_respond_invitation',[retry.id,true]),/not for your account/);
    await db.exec('reset role');await db.query("update watch_invitations set expires_at=now()-interval '1 minute'");
    await as(b);assert.equal((await rpc('watch_invitation_inbox')).items.length,0);assert.equal((await rpc('watch_respond_invitation',[next.id,true])).conflict,true);
    await as(a);await assert.rejects(rpc('watch_invite',[room.roomId,first.sessionId]),/movie has changed/);
  }finally{await db.close();}
});

test('invitation API validates requests, forwards the user JWT and ignores forged actor fields',async()=>{
  process.env.SUPABASE_URL='https://database.test';process.env.SUPABASE_PUBLISHABLE_KEY='public-test';
  const id=randomUUID(),session=randomUUID();let signedIn=true,result={ok:true,json:async()=>({items:[]})};const calls=[];
  const handler=createInvitationHandler({authenticateUser:async()=>signedIn?{data:{userClaims:{id}}}:{error:{}},fetchImpl:async(url,options)=>{calls.push({url,options});return result;}});
  const call=async(method,url,body)=>{const req=Readable.from(body===undefined?[]:[JSON.stringify(body)]);Object.assign(req,{method,url,headers:{authorization:'Bearer user'}});let reply;await handler(req,{},(_r,status,data)=>reply={status,data});return reply;};
  signedIn=false;assert.equal((await call('GET','/api/watch-invitations')).status,401);assert.equal(calls.length,0);signedIn=true;
  assert.equal((await call('POST',`/api/watch-invitations/${id}/response`,{accept:'yes'})).status,400);
  assert.equal((await call('POST',`/api/watch-invitations/${id}/response`,{accept:true,recipientId:'forged'})).status,200);
  assert.deepEqual(JSON.parse(calls.at(-1).options.body),{p_id:id,p_accept:true});assert.equal(calls.at(-1).options.headers.Authorization,'Bearer user');
  assert.equal((await call('POST',`/api/rooms/${id}/watch-invitation`,{sessionId:session,senderId:'forged'})).status,200);
  assert.deepEqual(JSON.parse(calls.at(-1).options.body),{p_room_id:id,p_session_id:session});
  result={ok:false,json:async()=>({code:'PGRST202'})};assert.match((await call('GET','/api/watch-invitations')).data.error,/watch-invitations.sql/);
  result={ok:true,json:async()=>({conflict:true})};assert.equal((await call('POST',`/api/watch-invitations/${id}/response`,{accept:true})).status,409);
});
