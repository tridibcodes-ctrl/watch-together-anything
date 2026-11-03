const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createTmdbHandler}=require('./tmdb');
const html=fs.readFileSync(path.join(__dirname,'../frontend/index.html'),'utf8');
const source=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].at(-1)[1];
test('season metadata preserves episode stills and missing artwork without replacing it with the series poster',async()=>{
  const handler=createTmdbHandler({getToken:()=> 'test',authenticateUser:async()=>({data:{userClaims:{id:'member'}}}),fetchImpl:async()=>({ok:true,json:async()=>({episodes:[{episode_number:1,name:'Pilot',overview:'First episode',still_path:'/pilot.jpg'},{episode_number:2,name:'Second'}]})})});
  let result;await handler({method:'GET',url:'/api/titles/tv/1396/seasons/1',headers:{}},{setHeader(){}},(_r,status,body)=>result={status,body});
  assert.equal(result.status,200);assert.equal(result.body.episodes[0].stillPath,'/pilot.jpg');assert.equal(result.body.episodes[0].overview,'First episode');assert.equal(result.body.episodes[1].stillPath,null);
});
test('episode row selection updates the playback episode and only marks that row selected',()=>{
  const rows=[1,2,3].map(n=>({dataset:{episode:String(n)},classList:{toggle(_name,value){this.selected=value;}},control:{setAttribute(_name,value){this.pressed=value;}},label:{hidden:true},querySelector(selector){return selector==='[data-episode-choice]'?this.control:this.label;}}));
  const context=vm.createContext({$:id=>id==='episode'?{value:'2'}:{querySelectorAll:()=>rows}});
  vm.runInContext(source.slice(source.indexOf('    function showEpisode()'),source.indexOf('    function card(')),context);context.showEpisode();
  assert.deepEqual(rows.map(row=>row.control.pressed),['false','true','false']);assert.deepEqual(rows.map(row=>row.label.hidden),[true,false,true]);
});
