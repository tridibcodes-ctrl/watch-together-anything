const test = require('node:test');
const assert = require('node:assert/strict');
const {waitingMessage} = require('../frontend/shared-playback');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname,'../frontend/index.html'),'utf8');
const source = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].at(-1)[1];
test('waiting notice names only unready partners and clears when both are ready',()=>{
  const state={media:{},provider:'vidspark',waitingForReady:true,readiness:{members:[{displayName:'Tridib',ready:false},{displayName:'Partner name',ready:true}]}};
  assert.equal(waitingMessage(state),'Waiting for Tridib to be ready…');
  state.readiness.members[1].ready=false;assert.equal(waitingMessage(state),'Waiting for Tridib and Partner name to be ready…');
  state.waitingForReady=false;assert.equal(waitingMessage(state),'');
  assert.equal(waitingMessage(null),'');
});

test('the chat panel shows named waiting status and clears it when readiness recovers',()=>{
  const nodes={};
  const context=vm.createContext({mode:'api',room:null,joined:false,sharedView:{},$:id=>nodes[id]??={},controls(){},MultiplaySync:{waitingMessage},MultiplayPlayer:require('../frontend/player')});
  vm.runInContext('const receiver={'+source.slice(source.indexOf('      onChange(view)'),source.indexOf('      onError(message)'))+'};function render(view){receiver.onChange(view);}',context);
  const state={media:{title:'Movie'},provider:'vidspark',waitingForReady:true,readiness:{readyCount:1,members:[{displayName:'Tridib',ready:false},{displayName:'Partner',ready:true}]}};
  context.render({roomId:'room',state,online:true,joined:true,canControl:true});
  assert.equal(nodes['chat-playback-status'].textContent,'Waiting for Tridib to be ready…');assert.equal(nodes['chat-playback-status'].hidden,false);
  context.render({roomId:'room',state:{...state,waitingForReady:false},online:true,joined:true,canControl:true});assert.equal(nodes['chat-playback-status'].hidden,true);
});

test('saved playback notices render once without a repeated sender prefix',async()=>{
  function element(tag, text = '') { return { tag, textContent: text, dataset:{}, children: [], append(...items) { this.children.push(...items); }, setAttribute() {},
    insertBefore(child,before){if(child.parent)child.remove();const index=before?this.children.indexOf(before):this.children.length;this.children.splice(index,0,child);child.parent=this;},
    remove(){if(this.parent){this.parent.children.splice(this.parent.children.indexOf(this),1);this.parent=null;}} }; }
  const messages=element('ul');Object.assign(messages,{scrollHeight:0,scrollTop:0,clientHeight:100});
  const items=[{id:'1',kind:'playback',senderName:'Tridib',body:'Tridib has paused.'},{id:'2',senderName:'Partner',body:'Ready!'}];
  const textOf = item => typeof item === 'string' ? item : item.textContent + item.children.map(textOf).join('');
  const context=vm.createContext({me:{roomId:'room',userId:'me'},chatRequestVersion:0,updateChatNotifications(){},node:element,document:{createTextNode:text=>text},
    $:id=>id==='messages'?messages:{},request:async()=>({items})});
  vm.runInContext(source.slice(source.indexOf('    function reconcileChildren('),source.indexOf('    function button(')),context);
  vm.runInContext(source.slice(source.indexOf('    async function chat()'),source.indexOf('    async function loadRooms(')),context);
  await context.chat();assert.deepEqual(messages.children.map(textOf),['Tridib has paused.','☾Partner: Ready!']);
  assert.equal(messages.children[0].className, 'chat-notice');
  assert.equal(messages.children[1].className, 'chat-message');
  const previous=[...messages.children];await context.chat();assert.deepEqual(messages.children,previous);
  items.push({id:'3',senderName:'Partner',body:'Next'});await context.chat();assert.equal(messages.children[1],previous[1]);
  items.shift();await context.chat();assert.equal(messages.children[0],previous[1]);assert.equal(messages.children.length,2);
});
