const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {randomUUID}=require('node:crypto'),{Readable}=require('node:stream'),{PGlite}=require('@electric-sql/pglite');
const {createPresenceHandler}=require('./presence');
test('presence is member-scoped, authenticated, expires and keeps another open tab online',async()=>{
  const db=new PGlite();try{
    await db.exec(`create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;`);
    for(const file of ['schema.sql','phase2.sql']){
      if(file==='phase2.sql')await db.exec(fs.readFileSync(path.join(__dirname,'playback.sql'),'utf8'));
      await db.exec(fs.readFileSync(path.join(__dirname,file),'utf8'));
    }
    await db.exec(fs.readFileSync(path.join(__dirname,'presence.sql'),'utf8'));await db.exec(fs.readFileSync(path.join(__dirname,'presence.sql'),'utf8'));
    const [a,b,c,tab1,tab2,tabB]=Array.from({length:6},randomUUID);
    await db.query('insert into auth.users values($1),($2),($3)',[a,b,c]);
    await db.query("insert into profiles(user_id,display_name,avatar_key) values($1,'A','moon'),($2,'B','heart')",[a,b]);
    const as=async id=>{await db.exec('set role authenticated');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);};
    const rpc=async(name,args=[])=> (await db.query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) result`,args)).rows[0].result;
    await as(a);const room=await rpc('create_watch_room',['Us']);
    await as(b);await rpc('join_watch_room',[room.inviteCode]);
    await rpc('watch_presence_heartbeat',[tabB,true,room.roomId]);
    await as(a);let result=await rpc('watch_presence_heartbeat',[tab1,true,room.roomId]);
    assert.equal(result.members.length,2);assert.ok(result.members.every(member=>member.online));
    await rpc('watch_presence_heartbeat',[tab2,true,room.roomId]);result=await rpc('watch_presence_heartbeat',[tab1,false,room.roomId]);
    assert.equal(result.members.find(member=>member.userId===a).online,true);
    result=await rpc('watch_presence_heartbeat',[tab2,false,room.roomId]);assert.equal(result.members.find(member=>member.userId===a).online,false);
    await assert.rejects(db.query('insert into watch_presence_leases values($1,$2,now())',[b,tab1]),/permission denied/);
    await as(c);await assert.rejects(rpc('watch_presence',[room.roomId]),/membership/);
    await assert.rejects(rpc('watch_presence_heartbeat',[tab1,true,room.roomId]),/membership/);
    assert.equal((await db.query('select * from watch_presence_leases')).rows.length,0);
    await db.exec('reset role');await db.query("update watch_presence_leases set seen_at=now()-interval '46 seconds'");
    await as(a);result=await rpc('watch_presence',[room.roomId]);assert.ok(result.members.every(member=>!member.online));
    await as(b);await rpc('watch_presence_heartbeat',[tabB,true,room.roomId]);
    await as(a);result=await rpc('watch_presence',[room.roomId]);assert.equal(result.members.find(member=>member.userId===b).online,true);
  }finally{await db.close();}
});

test('presence API forwards only the verified user JWT and validated lease parameters',async()=>{
  process.env.SUPABASE_URL='https://db.test';process.env.SUPABASE_PUBLISHABLE_KEY='public-test';
  const id=randomUUID(),room=randomUUID(),calls=[];let signedIn=true,error=null;
  const handler=createPresenceHandler({authenticateUser:async()=>signedIn?{data:{userClaims:{id}}}:{error:{}},fetchImpl:async(url,options)=>{calls.push({url,options});return {ok:!error,json:async()=>error||{members:[]}};}});
  const call=async(method,body,url='/api/presence')=>{const req=Readable.from(body===undefined?[]:[JSON.stringify(body)]);Object.assign(req,{method,url,headers:{authorization:'Bearer current-user'}});let result;await handler(req,{},(_r,status,data)=>result={status,data});return result;};
  signedIn=false;assert.equal((await call('GET')).status,401);assert.equal(calls.length,0);signedIn=true;
  assert.equal((await call('POST',{clientId:id,online:'true'})).status,400);
  assert.equal((await call('POST',{clientId:id,online:true,roomId:room,userId:'forged',seenAt:'2099-01-01'})).status,200);
  assert.deepEqual(JSON.parse(calls[0].options.body),{p_client_id:id,p_online:true,p_room_id:room});assert.equal(calls[0].options.headers.Authorization,'Bearer current-user');
  error={code:'42501'};assert.equal((await call('GET',undefined,'/api/presence?roomId='+room)).status,403);
  error={code:'PGRST202'};assert.match((await call('GET')).data.error,/presence.sql/);
});
