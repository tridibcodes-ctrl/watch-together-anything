const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const html=fs.readFileSync(path.join(__dirname,'../frontend/index.html'),'utf8');
const source=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].at(-1)[1];
class Element {
  constructor(tag='div',text=''){this.tagName=tag;this.textContent=text;this.children=[];this.dataset={};this.attributes={};}
  append(...children){for(const child of children){child.parent=this;this.children.push(child);}}
  replaceChildren(...children){this.children=[];this.append(...children);}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(child=>child!==this);}
  setAttribute(key,value){this.attributes[key]=value;}
  querySelector(selector){return this.querySelectorAll(selector)[0];}
  querySelectorAll(selector){return this.children.flatMap(child=>[...(selector==='button'&&child.tagName==='button'||selector==='.invite-error'&&child.className==='invite-error'?[child]:[]),...child.querySelectorAll(selector)]);}
}
const invite={id:'invite',roomId:'room',sessionId:'session',senderId:'a',recipientId:'b',senderName:'Partner',status:'pending',media:{title:'A movie',mediaType:'movie'},expiresAt:new Date(Date.now()+600000).toISOString()};
function renderApp(){
  const host=new Element();const context=vm.createContext({Date,Set,me:{userId:'b',roomId:'room'},joined:false,room:null,
    dismissedMovieInvites:new Set(),$:()=>host,node:(tag,text)=>new Element(tag,text),button:(text,onclick)=>Object.assign(new Element('button',text),{onclick}),friendlyError:text=>text,respondMovieInvitation:async()=>{},placeMovieInvitations(){}});
  vm.runInContext(source.slice(source.indexOf('    function renderMovieInvitations('),source.indexOf('    async function respondMovieInvitation(')),context);
  return {host,context};
}

test('invitation cards have named accept/decline controls, preserve focus across polls and remove replaced/expired titles',()=>{
  const {host,context}=renderApp();context.renderMovieInvitations([invite],'b');assert.equal(host.children.length,1);
  const card=host.children[0],buttons=card.querySelectorAll('button');assert.equal(buttons.length,2);
  assert.match(buttons[0].attributes['aria-label'],/Decline/);assert.match(buttons[1].attributes['aria-label'],/Accept and watch/);
  context.renderMovieInvitations([invite],'b');assert.equal(host.children[0],card);
  context.renderMovieInvitations([{...invite,id:'new'}],'b');assert.notEqual(host.children[0],card);assert.equal(host.children.length,1);
  context.renderMovieInvitations([{...invite,expiresAt:'2000-01-01'}],'b');assert.equal(host.children.length,0);
  context.renderMovieInvitations([invite],'outsider');assert.equal(host.children.length,0);
});

test('notifications stay interactive inside a details modal or fullscreen player and return to the document afterwards',()=>{
  const host={},dialog={open:true,append(child){child.parentElement=this;}},body={append(child){child.parentElement=this;}},stage={append(child){child.parentElement=this;}};
  const context=vm.createContext({$:id=>id==='title-details'?dialog:host,document:{body,fullscreenElement:null}});
  vm.runInContext(source.slice(source.indexOf('    function placeMovieInvitations('),source.indexOf('    function stopMovieInvitations(')),context);
  context.placeMovieInvitations();assert.equal(host.parentElement,dialog);
  dialog.open=false;context.document.fullscreenElement=stage;context.placeMovieInvitations();assert.equal(host.parentElement,stage);
  context.document.fullscreenElement=null;context.placeMovieInvitations();assert.equal(host.parentElement,body);
});

test('decline stays on the current page; accept verifies the exact session before navigation and can retry a failed join',async()=>{
  let joins=0,leaves=0,fail=false;const context=vm.createContext({mode:'api',me:{userId:'b',roomId:'room'},joined:false,room:{sessionId:'session'},currentView:'browse',location:{hash:'#browse'},dismissedMovieInvites:new Set(),
    request:async(_url,_method,body)=>({roomId:'room',sessionId:'session',status:body.accept?'accepted':'declined'}),
    sharedPlayback:{async joinSession(id){assert.equal(id,'session');if(fail)throw new Error('movie changed');joins++;},leave(){leaves++;}},
    $:()=>({open:false}),say(){}});
  vm.runInContext(source.slice(source.indexOf('    async function respondMovieInvitation('),source.indexOf('    function stopLiveChat(')),context);
  await context.respondMovieInvitation(invite,false);assert.equal(context.location.hash,'#browse');assert.equal(joins,0);assert.equal(leaves,0);
  fail=true;await assert.rejects(context.respondMovieInvitation(invite,true),/movie changed/);assert.equal(context.location.hash,'#browse');
  fail=false;await context.respondMovieInvitation(invite,true);assert.equal(context.location.hash,'room');assert.equal(joins,1);
  context.me.userId='outsider';await assert.rejects(context.respondMovieInvitation(invite,true),/invited account/);assert.equal(joins,1);
});

test('an accepted invitation offers a retry after a load failure and stays hidden once that session is joined',()=>{
  const {host,context}=renderApp();context.renderMovieInvitations([{...invite,status:'accepted'}],'b');assert.equal(host.children.length,1);
  assert.match(host.children[0].textContent||host.children[0].children[0].textContent,/Your movie is ready/);
  context.joined=true;context.room={sessionId:'session'};context.renderMovieInvitations([{...invite,status:'accepted'}],'b');assert.equal(host.children.length,0);
});

test('a delayed invitation inbox cannot reopen notifications after sign-out',async()=>{
  let resolve,renders=0;const host=new Element(),channel={on(){return this;},subscribe(){return this;}};
  const context=vm.createContext({mode:'api',me:{userId:'b'},authSession:{},invitationWatch:null,invitationOwner:null,movieInvitationGeneration:0,dismissedMovieInvites:new Set(),$:()=>host,clearTimeout(){},setTimeout(){return 1;},
    authClient:{channel:()=>channel,removeChannel:async()=>{}},request:()=>new Promise(done=>resolve=done),renderMovieInvitations(){renders++;}});
  vm.runInContext(source.slice(source.indexOf('    function stopMovieInvitations('),source.indexOf('    function renderMovieInvitations(')),context);
  context.startMovieInvitations();context.stopMovieInvitations();context.me=null;resolve({items:[invite]});
  await new Promise(done=>setImmediate(done));assert.equal(renders,0);assert.equal(host.children.length,0);
});

test('new title selection relies on its atomic invitation and never re-sends after a fast acceptance',async()=>{
  const calls=[];let selections=0,setupFails=false;
  const context=vm.createContext({mode:'api',me:{userId:'user',roomId:'room'},room:{sessionId:null,media:null},location:{hash:'#browse'},invitationWatch:{refresh(){}},
    mediaKey:media=>media?`${media.mediaType}:${media.tmdbId}`:'',
    request:async(path,method)=>{calls.push({path,method});if(setupFails)throw new Error('Invitation setup required');return {invited:true};},
    loadProgress:async()=>{},list:async()=>{},closeDetails(){},say(){},controls(){}});
  context.sharedPlayback={join(){},async watch(media){selections++;context.room={sessionId:'selected',media};}};
  vm.runInContext(source.slice(source.indexOf('    async function watchTitle('),source.indexOf('    async function command(')),context);
  const movie={mediaType:'movie',tmdbId:155,title:'Movie'};
  await context.watchTitle(movie);assert.equal(selections,1);assert.equal(calls.filter(call=>call.method==='POST').length,0);
  await context.watchTitle(movie);assert.equal(selections,1);assert.equal(calls.filter(call=>call.method==='POST').length,1);
  setupFails=true;await assert.rejects(context.watchTitle({...movie,tmdbId:27205}),/setup required/);assert.equal(selections,1);
});
