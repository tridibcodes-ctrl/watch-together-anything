const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const html=fs.readFileSync(path.join(__dirname,'../frontend/index.html'),'utf8');
const source=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].at(-1)[1];
test('sidebar names the real partner, distinguishes offline/unknown, and never invents a second demo user',()=>{
  const nodes={},context=vm.createContext({mode:'api',authSession:{},me:{userId:'a',roomId:'room'},roomInfo:{members:[{userId:'b',displayName:'Tanaya',avatarKey:'heart'}]},presenceMembers:[],presenceConfirmedAt:0,partnerPresence:null,navigator:{onLine:true},Date,
    $:id=>nodes[id]??={dataset:{},replaceChildren(...children){this.children=children;}},icon:key=>key});
  vm.runInContext(source.slice(source.indexOf('    function renderPartnerPresence('),source.indexOf('    function stopPartnerPresence(')),context);
  context.renderPartnerPresence();assert.equal(nodes['partner-presence-label'].textContent,'Checking');assert.equal(nodes['partner-presence-name'].textContent,'Tanaya');
  context.presenceMembers=[{userId:'a',displayName:'Tridib',online:true},{userId:'b',displayName:'Tanaya',avatarKey:'heart',online:true}];context.presenceConfirmedAt=Date.now();context.renderPartnerPresence();
  assert.equal(nodes['partner-presence-label'].textContent,'Online');assert.equal(nodes['partner-presence'].dataset.state,'online');assert.deepEqual(nodes['partner-presence-avatar'].children,['heart']);
  context.presenceMembers[1].online=false;context.renderPartnerPresence();assert.equal(nodes['partner-presence-label'].textContent,'Offline');
  context.presenceMembers[1].online=true;context.presenceConfirmedAt=Date.now()-46000;context.renderPartnerPresence();assert.equal(nodes['partner-presence-label'].textContent,'Checking');
  context.presenceConfirmedAt=Date.now();context.partnerPresence={error:'network'};context.renderPartnerPresence();assert.equal(nodes['partner-presence-label'].textContent,'Checking');
  context.mode='demo';context.renderPartnerPresence();assert.equal(nodes['partner-presence'].hidden,true);
});

test('late presence results are discarded after switching accounts; Realtime reads do not write heartbeat loops',async()=>{
  let resolve,delay=true,writes=0,reads=0,renders=0;const listeners=[];
  const channel={on(_type,_filter,fn){listeners.push(fn);return this;},subscribe(){return this;}};
  const context=vm.createContext({mode:'api',authSession:{},me:{userId:'a',roomId:'room'},partnerPresence:null,presenceMembers:[],presenceConfirmedAt:0,presenceGeneration:0,presenceClientId:'tab',Date,
    stopPartnerPresence(){context.partnerPresence=null;},renderPartnerPresence(){renders++;},setInterval(){return 1;},
    authClient:{channel:()=>channel},request:async(_url,method)=>{if(method==='POST')writes++;else reads++;return delay?new Promise(done=>resolve=done):{members:[]};}});
  vm.runInContext(source.slice(source.indexOf('    function startPartnerPresence('),source.indexOf('    function stopLiveChat(')),context);
  context.startPartnerPresence();context.me={userId:'new',roomId:'other'};resolve({members:[{userId:'private',online:true}]});await new Promise(done=>setImmediate(done));assert.equal(renders,0);assert.equal(context.presenceMembers.length,0);
  delay=false;context.startPartnerPresence();await new Promise(done=>setImmediate(done));const written=writes;listeners.at(-1)();await new Promise(done=>setImmediate(done));assert.equal(writes,written);assert.equal(reads,1);
});
