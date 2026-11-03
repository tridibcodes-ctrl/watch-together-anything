const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createTmdbHandler}=require('./tmdb');
test('trending feeds keep movie/TV identities, exclude people, authenticate cached reads and expire',async()=>{
  let time=0,allowed=true;const urls=[];
  const handler=createTmdbHandler({now:()=>time,getToken:()=> 'test',authenticateUser:async()=>allowed?{data:{userClaims:{id:'user'}}}:{error:{}},fetchImpl:async url=>{urls.push(new URL(url));return {ok:true,json:async()=>({results:[{id:1,media_type:'movie',title:'Movie'},{id:2,media_type:'tv',name:'Show'},{id:3,media_type:'person',name:'Person'}],total_pages:2})};}});
  const call=async url=>{let out;await handler({url,method:'GET',headers:{}},{setHeader(){}},(_r,status,body)=>out={status,body});return out;};
  const url='/api/catalog?type=all&feed=trending-week';let result=await call(url);
  assert.deepEqual(result.body.items.map(item=>[item.title,item.mediaType]),[['Movie','movie'],['Show','tv']]);assert.equal(urls[0].pathname,'/3/trending/all/week');
  await call(url);assert.equal(urls.length,1);allowed=false;assert.equal((await call(url)).status,401);assert.equal(urls.length,1);allowed=true;
  time=61000;await call(url);assert.equal(urls.length,2);
  await call('/api/catalog?type=all&feed=trending-day');assert.equal(urls.at(-1).pathname,'/3/trending/all/day');
  await call('/api/catalog?type=tv');assert.equal(urls.at(-1).pathname,'/3/tv/popular');
  await call('/api/catalog?type=movie&genre=28');assert.equal(urls.at(-1).pathname,'/3/discover/movie');assert.equal(urls.at(-1).searchParams.get('sort_by'),'popularity.desc');
  assert.equal((await call('/api/catalog?type=all')).status,400);assert.equal((await call('/api/catalog?type=movie&feed=unknown')).status,400);
});
const html=fs.readFileSync(path.join(__dirname,'../frontend/index.html'),'utf8'),source=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].at(-1)[1];
test('shelf loading bounds concurrency and ignores old-account results before rendering cards',async()=>{
  const pending=[];let cards=0;
  const context=vm.createContext({catalogVersion:1,getGenres:async()=>[],catalogGenres:[],renderGenreControls(){},catalogShelf:()=>({section:{},track:{replaceChildren(){}},status:{}}),$:()=>({replaceChildren(){}}),
    request:url=>new Promise(resolve=>pending.push({url,resolve})),card(){cards++;},featureItems:[{}]});
  vm.runInContext(source.slice(source.indexOf('    async function discoveryShelves('),source.indexOf('    function refreshDiscoveryIfDue(')),context);
  const loading=context.discoveryShelves(1,'movie');await new Promise(done=>setImmediate(done));assert.equal(pending.length,3);
  context.catalogVersion=2;for(const item of pending)item.resolve({items:[{}]});await loading;assert.equal(cards,0);assert.equal(pending.length,3);
});
test('discovery refreshes hourly or on a new UTC day without overwriting a search or genre selection',()=>{
  let now=Date.parse('2026-11-03T12:00:00Z'),refreshes=0,clears=0;class Clock extends Date{static now(){return now;}}
  const context=vm.createContext({Date:Clock,document:{hidden:false},currentView:'browse',me:{},catalogLoading:false,selectedGenre:'',discoveryLoadedAt:now-1000,$:()=>({value:''}),genreCache:{clear(){clears++;}},catalog(){refreshes++;}});
  vm.runInContext(source.slice(source.indexOf('    function refreshDiscoveryIfDue('),source.indexOf('    function paintFeature(')),context);
  context.refreshDiscoveryIfDue();assert.equal(refreshes,0);context.discoveryLoadedAt=now-3600001;context.refreshDiscoveryIfDue();assert.equal(refreshes,1);assert.equal(clears,1);
  context.selectedGenre='28';context.refreshDiscoveryIfDue();assert.equal(refreshes,1);context.selectedGenre='';context.$=()=>({value:'search'});context.refreshDiscoveryIfDue();assert.equal(refreshes,1);
  context.$=()=>({value:''});now=Date.parse('2026-11-04T00:00:01Z');context.discoveryLoadedAt=now-2000;context.refreshDiscoveryIfDue();assert.equal(refreshes,2);
});
