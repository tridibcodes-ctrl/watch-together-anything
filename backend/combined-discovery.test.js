const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const html=fs.readFileSync(path.join(__dirname,'../frontend/index.html'),'utf8'),source=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].at(-1)[1];
test('genre merging retains the correct movie and TV IDs without dropping TV-only genres',async()=>{
  const context=vm.createContext({mode:'api',genreCache:new Map(),request:async url=>({items:url.endsWith('movie')?[{id:18,name:'Drama'},{id:28,name:'Action'}]:[{id:18,name:'Drama'},{id:10759,name:'Action & Adventure'}]})});
  vm.runInContext(source.slice(source.indexOf('    async function getGenres('),source.indexOf('    function renderGenreControls(')),context);
  const genres=await context.getGenres('all');assert.equal(genres.length,3);assert.equal(genres.find(g=>g.name==='Drama').movie,18);assert.equal(genres.find(g=>g.name==='Drama').tv,18);assert.equal(genres.find(g=>g.name==='Action & Adventure').tv,10759);
});
test('combining results preserves relevance order and treats a movie and TV show sharing an ID as different titles',()=>{
  const context=vm.createContext({});vm.runInContext(source.slice(source.indexOf('    function combineTitles('),source.indexOf('    async function discoveryShelves(')),context);
  const groups=[[{tmdbId:1,mediaType:'movie'},{tmdbId:2,mediaType:'movie'}],[{tmdbId:1,mediaType:'tv'},{tmdbId:1,mediaType:'tv'}]];
  assert.deepEqual(Array.from(context.combineTitles(groups),t=>t.mediaType+':'+t.tmdbId),['movie:1','tv:1','movie:2']);
});
test('a search queries both media types on the same page and keeps combined pagination',async()=>{
  const calls=[],nodes={};let rendered;
  const context=vm.createContext({catalogVersion:0,catalogState:null,catalogLoading:false,selectedGenre:'',controls(){},$:id=>nodes[id]??={value:'shared title',setAttribute(){}},getGenres:async()=>[],
    request:async url=>{calls.push(new URL(url,'http://test'));const type=calls.at(-1).searchParams.get('type');return {items:[{mediaType:type,tmdbId:1}],hasMore:type==='tv'};},renderGenreControls(){},renderCatalog(items){rendered=items;}});
  vm.runInContext(source.slice(source.indexOf('    function combineTitles('),source.indexOf('    async function discoveryShelves(')),context);
  vm.runInContext(source.slice(source.indexOf('    async function catalog('),source.indexOf('    function listPath(')),context);
  await context.catalog(2);assert.deepEqual(calls.map(url=>url.searchParams.get('type')),['movie','tv']);assert.ok(calls.every(url=>url.searchParams.get('page')==='2'));assert.equal(rendered.length,2);assert.equal(context.catalogState.hasMore,true);
});
test('the invite copy control copies only the active room code',async()=>{
  let action,copied;const context=vm.createContext({me:{roomId:'room',rooms:[{roomId:'room',inviteCode:'abc123'}]},navigator:{clipboard:{writeText:async value=>copied=value}},say(){},bind(_id,fn){action=fn;}});
  vm.runInContext(source.slice(source.indexOf("    bind('copy-invite'"),source.indexOf("    bind('accept-invitation'")),context);await action();assert.equal(copied,'abc123');
});
