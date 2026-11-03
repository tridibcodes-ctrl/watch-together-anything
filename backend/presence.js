const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function authenticate(request){
  const {verifyAuth}=await import('@supabase/server/core');const headers=new Headers();
  for(const key of ['authorization','apikey'])if(request.headers[key])headers.set(key,request.headers[key]);
  return verifyAuth(new Request(new URL(request.url,'http://localhost:3000'),{headers}),{auth:'user'});
}
function createPresenceHandler({authenticateUser=authenticate,fetchImpl=fetch}={}){
  return async function handlePresence(request,response,sendJson){
    const url=new URL(request.url,'http://localhost');if(url.pathname!=='/api/presence')return false;
    const fail=(status,error)=>{sendJson(response,status,{error});return true;};
    try{
      if(!['GET','POST'].includes(request.method))return fail(405,'Use GET or POST for presence');
      const {data,error}=await authenticateUser(request);if(error||!data?.userClaims?.id)return fail(401,'Sign-in required or token invalid');
      if(!process.env.SUPABASE_URL||!process.env.SUPABASE_PUBLISHABLE_KEY)return fail(503,'Supabase configuration is missing');
      let args={p_room_id:url.searchParams.get('roomId')||null},rpc='watch_presence';
      if(request.method==='POST'){
        let raw='',size=0;for await(const chunk of request){size+=Buffer.byteLength(chunk);if(size>4096)return fail(413,'Request body is too large');raw+=chunk;}
        let body;try{body=JSON.parse(raw);}catch{return fail(400,'Request must be valid JSON');}
        if(!UUID.test(body?.clientId||'')||typeof body?.online!=='boolean')return fail(400,'A client ID and online state are required');
        rpc='watch_presence_heartbeat';args={p_client_id:body.clientId,p_online:body.online,p_room_id:body.roomId??null};
      }
      if(args.p_room_id!==null&&!UUID.test(args.p_room_id))return fail(400,'Invalid room ID');
      const result=await fetchImpl(process.env.SUPABASE_URL.replace(/\/+$/,'')+'/rest/v1/rpc/'+rpc,{method:'POST',headers:{apikey:process.env.SUPABASE_PUBLISHABLE_KEY,Authorization:request.headers.authorization,'Content-Type':'application/json'},body:JSON.stringify(args),signal:AbortSignal.timeout(10000)});
      const payload=await result.json().catch(()=>({}));
      if(!result.ok){
        if(['PGRST202','42P01'].includes(payload.code))return fail(503,'Partner presence needs setup: apply backend/presence.sql in Supabase SQL Editor.');
        return fail(payload.code==='42501'?403:payload.code==='22023'?400:502,'Could not update presence');
      }
      sendJson(response,200,payload);return true;
    }catch{return fail(502,'Presence is temporarily unavailable');}
  };
}
module.exports={createPresenceHandler,handlePresence:createPresenceHandler()};
