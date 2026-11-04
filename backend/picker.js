const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function authenticate(req){const {verifyAuth}=await import('@supabase/server/core');const headers=new Headers();for(const key of ['authorization','apikey'])if(req.headers[key])headers.set(key,req.headers[key]);return verifyAuth(new Request(new URL(req.url,'http://localhost'),{headers}),{auth:'user'});}
function createPickerHandler({authenticateUser=authenticate,fetchImpl=fetch}={}){
  return async function handlePicker(req,res,send){
    const match=/^\/api\/rooms\/([^/]+)\/picker$/.exec(new URL(req.url,'http://localhost').pathname);if(!match)return false;
    const fail=(status,error)=>{send(res,status,{error});return true;};
    try{
      if(!UUID.test(match[1]))return fail(400,'Invalid room ID');if(!['GET','POST'].includes(req.method))return fail(405,'Use GET or POST');
      const {data,error}=await authenticateUser(req);if(error||!data?.userClaims?.id)return fail(401,'Sign-in required');
      if(!process.env.SUPABASE_URL||!process.env.SUPABASE_PUBLISHABLE_KEY)return fail(503,'Supabase configuration missing');
      const headers={apikey:process.env.SUPABASE_PUBLISHABLE_KEY,Authorization:req.headers.authorization};
      const base=process.env.SUPABASE_URL.replace(/\/+$/,'')+'/rest/v1';
      const members=await fetchImpl(base+'/watch_room_members?room_id=eq.'+match[1]+'&select=user_id',{headers,signal:AbortSignal.timeout(10000)});
      if(!members.ok)return fail(502,'Could not check room membership');
      if(!(await members.json()).some(m=>m.user_id===data.userClaims.id))return fail(403,'Room membership required');
      const args={p_room_id:match[1],p_action:'get'};
      const tmdb=async path=>{if(!process.env.TMDB_READ_ACCESS_TOKEN)throw new Error('TMDB configuration missing');const result=await fetchImpl('https://api.themoviedb.org/3/'+path,{headers:{Authorization:'Bearer '+process.env.TMDB_READ_ACCESS_TOKEN},signal:AbortSignal.timeout(10000)});if(!result.ok)throw new Error('Could not load picker titles or genres');return result.json();};
      const title=(item,type)=>({key:type+':'+item.id,tmdbId:item.id,mediaType:type,title:item.title||item.name||'Untitled',year:(item.release_date||item.first_air_date||'').slice(0,4),posterPath:item.poster_path||null,backdropPath:item.backdrop_path||null});
      if(req.method==='POST'){
        let raw='',size=0;for await(const chunk of req){size+=Buffer.byteLength(chunk);if(size>16384)return fail(413,'Choices are too large');raw+=chunk;}
        let body;try{body=JSON.parse(raw);}catch{return fail(400,'Invalid JSON');}
        if(!['start','submit','spin'].includes(body?.action)||!UUID.test(body.roundId||'')||(body.expectedRoundId!=null&&!UUID.test(body.expectedRoundId)))return fail(400,'Current round and action required');
        Object.assign(args,{p_action:body.action,p_round_id:body.roundId});
        if(body.action==='start'){
          if(!['genre','title','trending'].includes(body.mode))return fail(400,'Choose genre or title mode');
          if(body.mode==='trending'&&!['day','week'].includes(body.trendingWindow||'week'))return fail(400,'Choose trending today or this week');
          args.p_mode=body.mode;args.p_expected_round_id=body.expectedRoundId||null;args.p_options=[];
          if(body.mode==='genre'){
            const lists=await Promise.all(['movie','tv'].map(type=>tmdb('genre/'+type+'/list?language=en-US')));
            const names=[...new Set(lists.flatMap(list=>list.genres.map(g=>g.name)))].sort();args.p_options=names.map(name=>({key:'genre:'+name,title:name}));
          }else if(body.mode==='trending'){
            const trendingWindow=body.trendingWindow||'week';
            const list=await tmdb('trending/all/'+trendingWindow+'?language=en-US');args.p_options=list.results.filter(item=>['movie','tv'].includes(item.media_type)).map(item=>({...title(item,item.media_type),trendingWindow}));
          }
        }else if(body.action==='submit'){
          if(!Array.isArray(body.choices)||body.choices.length>80)return fail(400,'Invalid choices');
          if(body.choices.some(c=>typeof c!=='string')){
            if(body.choices.length<2||body.choices.length>10||body.choices.some(c=>!['movie','tv'].includes(c?.mediaType)||!Number.isSafeInteger(c?.tmdbId)||c.tmdbId<1||c.tmdbId>2147483647))return fail(400,'Choose two to ten movies or series');
            args.p_choices=await Promise.all(body.choices.map(async c=>title(await tmdb(c.mediaType+'/'+c.tmdbId+'?language=en-US'),c.mediaType)));
          }else args.p_choices=body.choices;
        }
      }
      const result=await fetchImpl(base+'/rpc/watch_picker',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(args),signal:AbortSignal.timeout(10000)});
      const payload=await result.json().catch(()=>({}));if(!result.ok){if(['PGRST202','42P01'].includes(payload.code))return fail(503,'Picker setup required: apply backend/picker.sql in Supabase SQL Editor.');return fail(payload.code==='42501'?403:payload.code==='22023'?400:502,payload.message||'Could not update picker');}
      if(payload.conflict)return fail(409,'The picker round changed. Reopen your choices.');
      // Persist the window with the canonical shared options, using the existing picker schema.
      if(payload.mode==='trending')payload.trendingWindow=payload.options?.[0]?.trendingWindow==='day'?'day':'week';
      send(res,200,payload);return true;
    }catch(error){return fail(502,error.message||'Picker unavailable');}
  };
}
module.exports={createPickerHandler,handlePicker:createPickerHandler()};
