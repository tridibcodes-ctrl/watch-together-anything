const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'), path=require('node:path'), vm=require('node:vm');
const html=fs.readFileSync(path.join(__dirname,'../frontend/index.html'),'utf8');
const source=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].at(-1)[1];

test('details open over the current view; closing returns focus and rejects a delayed response',async()=>{
  const nodes={}, classes=new Set(), scrolls=[]; let resolve, focusReturned=false;
  const opener={isConnected:true,focus(){focusReturned=true;}};
  const element=id=>nodes[id]??={hidden:true,open:false,textContent:'',classList:{remove(){}},
    append(){},replaceChildren(){},setAttribute(){},focus(){},showModal(){this.open=true;},close(){this.open=false;}};
  const context=vm.createContext({$:element,currentView:'list',detailsVersion:0,seasonVersion:0,selectedTitle:null,selectedEpisodes:[],detailsOrigin:null,
    window:{scrollY:480,scrollTo(x,y){scrolls.push(y);}},document:{activeElement:opener,body:{classList:{add:v=>classes.add(v),remove:v=>classes.delete(v)}}},
    featureTimer:null,featureFade:null,clearTimeout(){},scheduleFeature(){},placeMovieInvitations(){},request:()=>new Promise(done=>resolve=done),controls(){},node(){throw new Error('Stale content must not render');}});
  vm.runInContext(source.slice(source.indexOf('    function closeDetails('),source.indexOf('    async function loadSeason(')),context);
  const pending=context.showDetails({mediaType:'movie',tmdbId:155,title:'Movie'});
  assert.equal(nodes['title-details'].open,true);assert.equal(context.currentView,'list');assert.deepEqual(scrolls,[]);assert.equal(classes.has('details-open'),true);
  context.closeDetails(true);assert.equal(nodes['title-details'].open,false);assert.equal(focusReturned,true);assert.deepEqual(scrolls,[480]);
  resolve({title:{title:'Old response'}});await pending;assert.equal(context.selectedTitle,null);
});

test('sidebar status distinguishes a verified connection, network loss, signed out and demo',()=>{
  const nodes={}; const context=vm.createContext({mode:'api',authSession:{},me:{profile:{displayName:'Tanaya'}},connectionHealth:'online',navigator:{onLine:true},$:id=>nodes[id]??={dataset:{}}});
  vm.runInContext(source.slice(source.indexOf('    function renderConnection('),source.indexOf('    async function checkConnection(')),context);
  context.renderConnection();assert.equal(nodes['presence-label'].textContent,'Online');assert.equal(nodes['account-presence'].dataset.state,'online');
  context.navigator.onLine=false;context.renderConnection();assert.equal(nodes['presence-label'].textContent,'Offline');
  context.navigator.onLine=true;context.authSession=null;context.me=null;context.renderConnection();assert.equal(nodes['presence-label'].textContent,'Signed out');
  context.mode='demo';context.renderConnection();assert.equal(nodes['presence-label'].textContent,'Local Demo');assert.notEqual(nodes['account-presence'].dataset.state,'online');
});

test('carousel rotation waits seven seconds and stops for dialogs, other views and a pause preference',()=>{
  const active=new Map();let sequence=0;
  const dialog={open:false}, feature={matches:()=>false,contains:()=>false};
  const context=vm.createContext({featureTimer:null,featurePaused:false,featureItems:[{},{}],currentView:'home',
    document:{hidden:false,activeElement:null},$:id=>id==='title-details'?dialog:feature,
    clearTimeout:id=>active.delete(id),setTimeout(fn,delay){active.set(++sequence,{fn,delay});return sequence;},advanceFeature(){}});
  vm.runInContext(source.slice(source.indexOf('    function scheduleFeature('),source.indexOf('    function advanceFeature(')),context);
  context.scheduleFeature();assert.equal([...active.values()][0].delay,7000);
  dialog.open=true;context.scheduleFeature();assert.equal(active.size,0);
  dialog.open=false;context.currentView='browse';context.scheduleFeature();assert.equal(active.size,0);
  context.currentView='home';context.featurePaused=true;context.scheduleFeature();assert.equal(active.size,0);
});
