const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createCoupleHandler } = require('./couple');
const ROOM='11111111-1111-4111-8111-111111111111', USER='22222222-2222-4222-8222-222222222222', SESSION='33333333-3333-4333-8333-333333333333';
process.env.SUPABASE_URL='https://database.test';process.env.SUPABASE_PUBLISHABLE_KEY='test-publishable';
function fixture({member=true,signedIn=true,payload={items:[]},rpcError=null}={}) {
  const calls=[];
  const handler=createCoupleHandler({authenticateUser:async()=>signedIn?{data:{userClaims:{id:USER}}}:{error:{}},fetchImpl:async(url,options)=>{
    calls.push({url,options});const result=url.includes('/watch_room_members?')?(member?[{user_id:USER}]:[]):url.includes('/watch_rooms?')?[{name:'Us',invite_code:'invite'}]:url.includes('/profiles?')?[{user_id:USER,display_name:'Person',avatar_key:'moon'}]:payload;
    if(url.includes('/rpc/')&&rpcError) return {ok:false,json:async()=>rpcError};
    return {ok:true,json:async()=>result};
  }});
  const request=async(method,route,body)=>{
    const req=Readable.from(body===undefined?[]:[JSON.stringify(body)]);Object.assign(req,{method,url:'/api/rooms/'+ROOM+route,headers:{authorization:'Bearer account'}});
    let result;await handler(req,{},(_res,status,data)=>result={status,data});return result;
  };
  return {request,calls};
}
test('progress and completion require authentication and membership before touching room data',async()=>{
  const signedOut=fixture({signedIn:false});assert.equal((await signedOut.request('GET','/progress')).status,401);assert.equal(signedOut.calls.length,0);
  const outsider=fixture({member:false});assert.equal((await outsider.request('POST','/completion',{})).status,403);assert.equal(outsider.calls.length,1);
});
test('completion forwards only session, epoch and confirmation; client actor fields cannot confirm for a partner',async()=>{
  const f=fixture();assert.equal((await f.request('POST','/completion',{sessionId:SESSION,epoch:1,confirmed:true,userId:'partner',previewPartner:true})).status,200);
  assert.deepEqual(JSON.parse(f.calls.at(-1).options.body),{p_room_id:ROOM,p_session_id:SESSION,p_epoch:1,p_confirmed:true});
  assert.equal((await f.request('POST','/completion',{sessionId:SESSION,epoch:0,confirmed:true})).status,400);
});
test('stale completion is a conflict and missing migration gives an actionable setup error',async()=>{
  const conflict=fixture({payload:{conflict:true}});assert.equal((await conflict.request('POST','/completion',{sessionId:SESSION,epoch:1,confirmed:true})).status,409);
  const missing=fixture({rpcError:{code:'PGRST202'}});const result=await missing.request('GET','/progress');assert.equal(result.status,503);assert.match(result.data.error,/phase2.sql/);
});
test('room members can rename and read invitation/member details; invalid names are rejected',async()=>{
  const f=fixture();assert.equal((await f.request('PATCH','',{name:'  Our cinema  '})).status,200);assert.equal(JSON.parse(f.calls.at(-1).options.body).p_name,'Our cinema');
  assert.equal((await f.request('PATCH','',{name:' '})).status,400);
  const details=await f.request('GET','/details');assert.equal(details.data.members[0].displayName,'Person');assert.equal(details.data.inviteCode,'invite');
});
