const test=require('node:test'),assert=require('node:assert/strict'),{Readable}=require('node:stream');
const {createPlaybackHandler}=require('./playback');
const id='11111111-1111-4111-8111-111111111111';
process.env.SUPABASE_URL='https://test.invalid';process.env.SUPABASE_PUBLISHABLE_KEY='test';
async function run(body,{member=true,authenticated=true,rpcError=null}={}){
  const calls=[];let output;
  const handler=createPlaybackHandler({authenticateUser:async()=>authenticated?{data:{userClaims:{id}}}:{error:{}},fetchImpl:async(url,options)=>{
    calls.push({url,options});if(url.includes('/watch_room_members?'))return{ok:true,json:async()=>member?[{user_id:id}]:[]};
    return{ok:!rpcError,json:async()=>rpcError||{outcome:'conflict',state:{roomId:id,readyEpoch:3,status:'paused'}}};
  }});
  const req=Readable.from([JSON.stringify(body)]);req.url='/api/rooms/'+id+'/readiness';req.method='POST';req.headers={authorization:'Bearer test'};
  await handler(req,{setHeader(){}},(_r,status,data)=>output={status,data});return{output,calls};
}
const valid={clientId:id,sessionId:id,provider:'cinesrc',epoch:1,ready:false,joined:true};
test('readiness route rejects unsigned users and nonmembers before RPC',async()=>{
  let r=await run(valid,{authenticated:false});assert.equal(r.output.status,401);assert.equal(r.calls.length,0);
  r=await run(valid,{member:false});assert.equal(r.output.status,403);assert.equal(r.calls.length,1);
});
test('readiness validates lease context and forwards no client-supplied user identity',async()=>{
  for(const patch of [{clientId:'bad'},{sessionId:null},{epoch:0},{ready:'true'},{joined:undefined},{provider:'vidlink'}])assert.equal((await run({...valid,...patch})).output.status,400);
  const r=await run({...valid,ready:true,userId:'spoof'});assert.equal(r.output.status,200);assert.equal(r.output.data.readyEpoch,3);
  const call=r.calls.at(-1);assert.ok(call.url.endsWith('/rpc/watch_report_readiness'));const args=JSON.parse(call.options.body);
  assert.equal(args.p_ready,true);assert.equal(args.p_epoch,1);assert.equal(args.p_client_id,id);assert.equal(args.p_user_id,undefined);assert.equal(args.p_expected_revision,undefined);
});
test('readiness route exposes a missing SQL migration as setup required',async()=>{
  const r=await run(valid,{rpcError:{code:'PGRST202'}});assert.equal(r.output.status,503);assert.match(r.output.data.error,/playback.sql/);
});
