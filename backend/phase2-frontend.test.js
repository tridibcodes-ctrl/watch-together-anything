const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'), path=require('node:path'), vm=require('node:vm');
const html=fs.readFileSync(path.join(__dirname,'../frontend/index.html'),'utf8');
const source=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].at(-1)[1];
test('invitation links are parsed without visiting their URL or interpreting script fragments',()=>{
  const context=vm.createContext({URL});
  vm.runInContext(source.slice(source.indexOf('    function inviteFromHash('),source.indexOf('    function mediaKey(')),context);
  assert.equal(context.inviteCodeFromInput('https://example.test/#invite=ABC123'),'abc123');
  assert.equal(context.inviteCodeFromInput('https://example.test/#invite=<script>'),null);
  assert.equal(context.inviteCodeFromInput('a valid room'),null);
  assert.equal(context.inviteFromHash('#room'),null);
});
test('a delayed progress response cannot expose the previous room history',async()=>{
  let resolve,rendered=0;const nodes={};
  const context=vm.createContext({progressVersion:0,me:{roomId:'old',userId:'user'},$:id=>nodes[id]??={},request:()=>new Promise(done=>resolve=done),renderSavedLists(){rendered++;},renderProgressHistory(){rendered++;},controls(){rendered++;}});
  vm.runInContext(source.slice(source.indexOf('    async function loadProgress('),source.indexOf('    async function loadRoomInfo(')),context);
  const pending=context.loadProgress();context.me.roomId='new';resolve({items:[{media:{title:'Private history'}}]});await pending;
  assert.equal(rendered,0);assert.equal(context.progressItems,undefined);
});
test('episode completion never labels the whole series Watched',()=>{
  const context=vm.createContext({progressItems:[{media:{mediaType:'tv',tmdbId:1396,season:1,episode:1},completedAt:'2026-01-01'},{media:{mediaType:'tv',tmdbId:1396,season:1,episode:2},completedAt:null}]});
  vm.runInContext(source.slice(source.indexOf('    function listProgress('),source.indexOf('    function renderSavedLists(')),context);
  const item=context.listProgress({title:{mediaType:'tv',tmdbId:1396}});assert.equal(item.status,'watching');assert.equal(item.watchedEpisodes,1);
});
