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
  let children;
  function element(tag, text = '') { return { tag, textContent: text, children: [], append(...items) { this.children.push(...items); }, setAttribute() {} }; }
  const textOf = item => typeof item === 'string' ? item : item.textContent + item.children.map(textOf).join('');
  const context=vm.createContext({me:{roomId:'room',userId:'me'},chatRequestVersion:0,updateChatNotifications(){},node:element,document:{createTextNode:text=>text},
    $:()=>({scrollHeight:0,scrollTop:0,clientHeight:100,replaceChildren(...items){children=items;}}),
    request:async()=>({items:[{kind:'playback',senderName:'Tridib',body:'Tridib has paused.'},{senderName:'Partner',body:'Ready!'}]})});
  vm.runInContext(source.slice(source.indexOf('    async function chat()'),source.indexOf('    async function loadRooms(')),context);
  await context.chat();assert.deepEqual(children.map(textOf),['Tridib has paused.','☾Partner: Ready!']);
  assert.equal(children[0].className, 'chat-notice');
  assert.equal(children[1].className, 'chat-message');
});
