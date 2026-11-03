const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function authenticate(request) {
  const { verifyAuth } = await import('@supabase/server/core');
  const headers = new Headers();
  for (const key of ['authorization','apikey']) if (request.headers[key]) headers.set(key,request.headers[key]);
  return verifyAuth(new Request(new URL(request.url,'http://localhost:3000'),{headers}),{auth:'user'});
}
function createInvitationHandler({authenticateUser=authenticate,fetchImpl=fetch}={}) {
  return async function handleInvitations(request,response,sendJson) {
    const pathname = new URL(request.url,'http://localhost').pathname;
    const room = /^\/api\/rooms\/([^/]+)\/watch-invitation$/.exec(pathname);
    const reply = /^\/api\/watch-invitations\/([^/]+)\/response$/.exec(pathname);
    if (pathname !== '/api/watch-invitations' && !room && !reply) return false;
    const fail=(status,error)=>{sendJson(response,status,{error});return true;};
    try {
      if (request.method !== (room||reply?'POST':'GET')) return fail(405,'Method not allowed');
      if ((room||reply) && !UUID.test((room||reply)[1])) return fail(400,'Invalid invitation or room ID');
      const {data,error}=await authenticateUser(request);
      if (error||!data?.userClaims?.id) return fail(401,'Sign-in required or token invalid');
      if (!process.env.SUPABASE_URL||!process.env.SUPABASE_PUBLISHABLE_KEY) return fail(503,'Supabase configuration is missing');
      let rpc='watch_invitation_inbox',args={};
      if (room||reply) {
        let raw='',size=0;
        for await(const chunk of request) {size+=Buffer.byteLength(chunk);if(size>4096)return fail(413,'Request body is too large');raw+=chunk;}
        let body;try{body=JSON.parse(raw);}catch{return fail(400,'Request must be valid JSON');}
        if(room) {
          if(!UUID.test(body?.sessionId||''))return fail(400,'Current movie session is required');
          rpc='watch_invite';args={p_room_id:room[1],p_session_id:body.sessionId};
        } else {
          if(typeof body?.accept!=='boolean')return fail(400,'Choose accept or decline');
          rpc='watch_respond_invitation';args={p_id:reply[1],p_accept:body.accept};
        }
      }
      const result=await fetchImpl(process.env.SUPABASE_URL.replace(/\/+$/,'')+'/rest/v1/rpc/'+rpc,{
        method:'POST',headers:{apikey:process.env.SUPABASE_PUBLISHABLE_KEY,Authorization:request.headers.authorization,'Content-Type':'application/json'},
        body:JSON.stringify(args),signal:AbortSignal.timeout(10000)});
      const payload=await result.json().catch(()=>({}));
      if(!result.ok){
        if(['PGRST202','42P01'].includes(payload.code))return fail(503,'Movie invitations need setup: apply backend/watch-invitations.sql last in Supabase SQL Editor.');
        return fail(payload.code==='42501'?403:payload.code==='22023'?400:502,'Could not update the movie invitation.');
      }
      if(payload.conflict)return fail(409,'This invitation has expired or the movie changed. Ask your partner to invite you again.');
      sendJson(response,200,payload);return true;
    } catch{return fail(502,'Could not reach movie invitations. Please try again.');}
  };
}
module.exports={createInvitationHandler,handleInvitations:createInvitationHandler()};
