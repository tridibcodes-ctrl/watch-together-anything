(function(root){
  'use strict';
  const duration=5500;
  const key=t=>t.key || t.mediaType+':'+t.tmdbId;
  function eligible(mode,options,members){
    if(mode==='title'){const seen=new Set();return members.flatMap(m=>m.choices||[]).filter(t=>{const k=key(t);if(seen.has(k))return false;seen.add(k);return true;}).sort((a,b)=>key(a).localeCompare(key(b)));}
    const vetoes=new Set(members.flatMap(m=>m.choices||[]));return options.filter(t=>mode!=='genre'||!vetoes.has(t.key));
  }
  function angle(index,count){return 1800+((360-(index+.5)*360/count)%360+360)%360;}
  function create({request,getContext,onTitle,onGenre}){
    const $=id=>document.getElementById(id),el=(tag,text='')=>{const e=document.createElement(tag);e.textContent=text;return e;};
    const button=(text,fn)=>{const b=el('button',text);b.className='button-55';b.type='button';b.onclick=()=>run(fn);return b;};
    let state=null,generation=0,timer=null,busy=false,editing=null,draft=[],searchVersion=0,searchTimer=null,offset=0;
    let animation=null,animationKey=null,resultTimer=null,poolKey='',demo=null,origin=null;
    let preview=[],idleAnimation=null,reading=null;
    const contextKey=()=>{const c=getContext();return [c.mode,c.roomId,c.userId].join(':');};
    function stopIdle(){idleAnimation?.cancel();idleAnimation=null;}
    function syncIdle(){
      const c=getContext(),pool=state?.roundId?state.pool||[]:preview;
      const idle=c.userId&&c.view==='picker'&&!document.hidden&&!$('picker-dialog').open&&!state?.result&&(!state?.roundId||state.mode==='trending')&&pool.length>0&&!window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if(!idle){stopIdle();return;}
      if(!idleAnimation)idleAnimation=$('picker-rotor').animate([{transform:'rotate(0deg)'},{transform:'rotate(360deg)'}],{duration:90000,iterations:Infinity,easing:'linear'});
    }
    async function loadPreview(){
      const version=generation,identity=contextKey();
      try{
        const data=await request('/api/catalog?type=all&feed=trending-week');
        if(version!==generation||identity!==contextKey())return;
        preview=(data.items||[]).filter(t=>['movie','tv'].includes(t.mediaType)).map(t=>({...t,key:key(t)}));render();
      }catch{if(version===generation&&identity===contextKey()&&!state?.roundId)$('picker-error').textContent='Could not load the trending preview. Choose a wheel to try again.';}
    }
    async function demoRequest(body){
      const c=getContext();if(!body)return demo ? structuredClone({...demo,serverTime:new Date().toISOString()}) : {roomId:c.roomId,roundId:null,revision:0,members:[]};
      if(body.action==='start'){
        let options=[];
        if(body.mode==='genre'){
          const lists=await Promise.all(['movie','tv'].map(type=>request('/api/genres?type='+type)));
          options=[...new Set(lists.flatMap(list=>list.items.map(g=>g.name)))].sort().map(name=>({key:'genre:'+name,title:name}));
        }else if(body.mode==='trending')options=(await request('/api/catalog?type=all&feed=trending-week')).items.map(t=>({...t,key:key(t)}));
        demo={roomId:c.roomId,roundId:body.roundId,revision:(demo?.revision||0)+1,mode:body.mode,options,members:[{userId:c.userId,displayName:c.name||'You',submitted:false,choices:[]},{userId:'demo-partner',displayName:'Demo partner',submitted:false,choices:[]}],result:null,resultIndex:null,spinAt:null};
      }else{
        if(!demo||demo.roundId!==body.roundId)throw new Error('The round changed.');
        if(body.action==='submit'){
          const member=demo.members.find(m=>m.userId===editing);member.choices=structuredClone(body.choices);member.submitted=true;demo.revision++;
        }else if(body.action==='spin'&&!demo.result){
          if(!demo.members.every(m=>m.submitted))throw new Error('Both partners must be ready.');
          const pool=eligible(demo.mode,demo.options,demo.members);if(!pool.length)throw new Error('All genres are excluded. Edit your choices or try Trending.');
          demo.resultIndex=Math.floor(Math.random()*pool.length);demo.result=pool[demo.resultIndex];demo.spinAt=new Date(Date.now()+3000).toISOString();demo.revision++;
        }
      }
      demo.pool=eligible(demo.mode,demo.options,demo.members);demo.ready=demo.members.every(m=>m.submitted);demo.serverTime=new Date().toISOString();return structuredClone(demo);
    }
    async function transport(body){
      const c=getContext(),version=generation,identity=contextKey(),started=Date.now();
      if(!c.roomId||!c.userId)throw new Error('Create or join a room on Home first.');
      const result=c.mode==='demo'?await demoRequest(body):await request('/api/rooms/'+c.roomId+'/picker',body?'POST':'GET',body);
      if(version!==generation||identity!==contextKey())return null;
      if(state && result.revision<state.revision)return null;
      offset=Date.parse(result.serverTime||new Date().toISOString())-(started+Date.now())/2;
      if(state?.roundId!==result.roundId || result.result&&!state?.result){close();}
      if(state?.roundId!==result.roundId){stopIdle();animation?.cancel();animationKey=null;poolKey='';$('picker-rotor').style.transform='';}
      state=result;render();return result;
    }
    async function run(fn){
      if(busy)return;busy=true;render();$('picker-error').textContent='';$('picker-dialog-error').textContent='';
      try{await fn();}catch(error){$('picker-error').textContent=error.message;$('picker-dialog-error').textContent=error.message;}
      finally{busy=false;render();updateDraft();}
    }
    function draw(pool){
      const signature=JSON.stringify(pool.map(t=>[key(t),t.title]));if(signature===poolKey)return;poolKey=signature;
      const svg=$('picker-svg');svg.replaceChildren();
      const ns='http://www.w3.org/2000/svg',colors=['#674879','#3e596f','#82546b','#4c6864','#68517f','#80614c'];
      const polar=a=>[220+207*Math.cos(a*Math.PI/180),220+207*Math.sin(a*Math.PI/180)];
      if(!pool.length){const circle=document.createElementNS(ns,'circle');circle.setAttribute('cx','220');circle.setAttribute('cy','220');circle.setAttribute('r','207');circle.setAttribute('fill','#302735');svg.append(circle);return;}
      pool.forEach((item,i)=>{
        const step=360/pool.length,a=-90+i*step,b=a+step,p=polar(a),q=polar(b),mid=(a+b)/2;
        const shape=document.createElementNS(ns,pool.length===1?'circle':'path');
        if(pool.length===1){shape.setAttribute('cx','220');shape.setAttribute('cy','220');shape.setAttribute('r','207');}
        else shape.setAttribute('d',`M220 220 L${p[0]} ${p[1]} A207 207 0 ${step>180?1:0} 1 ${q[0]} ${q[1]} Z`);
        shape.setAttribute('fill',colors[i%colors.length]);shape.setAttribute('stroke','#d5bad03b');svg.append(shape);
        const text=document.createElementNS(ns,'text'),pos=[220+137*Math.cos(mid*Math.PI/180),220+137*Math.sin(mid*Math.PI/180)];
        text.setAttribute('x',pos[0]);text.setAttribute('y',pos[1]);text.setAttribute('text-anchor','middle');text.setAttribute('dominant-baseline','middle');text.setAttribute('fill','#fff');text.setAttribute('font-size',pool.length>16?'12':'11');
        text.textContent=pool.length>16?String(i+1):item.title.length>18?item.title.slice(0,16)+'…':item.title;svg.append(text);
      });
    }
    function showResult(){
      $('picker-result').hidden=!state?.result;
      if(!state?.result)return;
      $('picker-winner').textContent=state.result.title;
      $('picker-result-action').textContent=state.mode==='genre'?'Browse '+state.result.title:'View title details';
    }
    function animate(){
      if(!state?.result)return;
      stopIdle();
      const signature=state.roundId+':'+state.resultIndex;if(animationKey===signature)return;animationKey=signature;
      animation?.cancel();clearTimeout(resultTimer);$('picker-result').hidden=true;
      const rotor=$('picker-rotor'),target=angle(state.resultIndex,state.pool.length),elapsed=Date.now()+offset-Date.parse(state.spinAt);
      if(window.matchMedia('(prefers-reduced-motion: reduce)').matches||elapsed>=duration){rotor.style.transform=`rotate(${target}deg)`;showResult();return;}
      rotor.style.transform='rotate(0deg)';
      animation=rotor.animate([{transform:'rotate(0deg)'},{transform:`rotate(${target}deg)`}],{duration,delay:Math.max(0,-elapsed),easing:'cubic-bezier(.12,.75,.2,1)',fill:'forwards'});
      if(elapsed>0)animation.currentTime=elapsed;
      animation.onfinish=showResult;resultTimer=setTimeout(showResult,Math.max(0,duration-elapsed)+50);
    }
    function render(){
      const c=getContext(),own=state?.members?.find(m=>m.userId===c.userId),members=state?.members||[];
      const active=!!state?.roundId;
      $('picker-status').textContent=!c.roomId?'Preview this week’s trending titles. Create or join a room on Home to pick together.':!active?'Previewing Trending This Week. Choose a wheel to start a shared round.':state.result?'A shared result has been chosen.':state.ready?(state.pool.length?'Both ready. Either of you can spin.':'Every genre was excluded. Edit choices or use Trending This Week.'):members.length<2?'Invite your partner to this room before spinning.':'Waiting for '+members.filter(m=>!m.submitted).map(m=>m.displayName).join(' and ')+' to submit.';
      for(const [id,mode] of [['picker-genre','genre'],['picker-title','title'],['picker-trending','trending']]){
        $(id).disabled=busy||!c.roomId;$(id).setAttribute('aria-pressed',String((active?state.mode:'trending')===mode));
      }
      $('picker-choose').disabled=busy||!active||!!state?.result;
      $('picker-choose').textContent=own?.submitted?'Edit my choices':'Add my choices';
      $('picker-spin').disabled=busy||!state?.ready||!state.pool?.length||!!state.result;
      $('picker-demo-partner').hidden=c.mode!=='demo'||!active||!!state?.result;
      $('picker-demo-partner').disabled=busy;
      $('picker-members').replaceChildren(...members.map(m=>el('p',m.displayName+' · '+(m.submitted?'Ready':'Choosing'))));
      const pool=active?state.pool||[]:preview;draw(pool);
      $('picker-pool-heading').textContent=!active||state.mode==='trending'?'Trending This Week':state.mode==='genre'?'On the genre wheel':'On the title wheel';
      const options=state?.mode==='genre'?state.options:pool;
      $('picker-options').replaceChildren(...options.map((item,i)=>{
        const li=el('li');const excluded=active&&state.mode==='genre'?members.filter(m=>(m.choices||[]).includes(item.key)):[];
        const label=el(excluded.length?'s':'span',item.title);
        li.append(label);if(excluded.length)li.append(el('small','Excluded by '+excluded.map(m=>m.displayName).join(' and ')));return li;
      }));
      if(!state?.result)$('picker-result').hidden=true;else animate();
      syncIdle();
    }
    function close(){
      searchVersion++;clearTimeout(searchTimer);const dialog=$('picker-dialog');if(dialog.open)dialog.close();editing=null;
      if(origin?.isConnected)origin.focus({preventScroll:true});origin=null;
      syncIdle();
    }
    function prepare(actor){
      if(!state?.roundId||state.result)return;
      editing=actor||getContext().userId;draft=structuredClone(state.members.find(m=>m.userId===editing)?.choices||[]);
      origin=document.activeElement;const partner=editing==='demo-partner';
      $('picker-dialog-heading').textContent=(partner?'Demo partner: ':'')+(state.mode==='genre'?'Exclude genres':state.mode==='title'?'Choose at least two titles':'Use Trending This Week');
      $('picker-dialog-error').textContent='';$('picker-search-area').hidden=state.mode!=='title';$('picker-genre-choices').hidden=state.mode!=='genre';$('picker-trending-help').hidden=state.mode!=='trending';
      $('picker-title-query').value='';$('picker-search-results').replaceChildren();
      $('picker-genre-choices').replaceChildren(...state.options.map(item=>{
        const label=el('label'),input=el('input');input.type='checkbox';input.value=item.key;input.checked=draft.includes(item.key);
        input.onchange=()=>{draft=input.checked?[...draft,item.key]:draft.filter(k=>k!==item.key);};label.append(input,document.createTextNode(item.title));return label;
      }));
      updateDraft();$('picker-dialog').showModal();$('picker-dialog-heading').focus({preventScroll:true});syncIdle();
    }
    function updateDraft(){
      $('picker-submit').disabled=busy||!state||state.mode==='title'&&(draft.length<2||draft.length>10);
      if(!state||state.mode!=='title'){$('picker-selected').replaceChildren();return;}
      $('picker-selected').replaceChildren(...draft.map(item=>{
        const li=el('li',item.title+' · '+(item.mediaType==='tv'?'TV SERIES':'MOVIE')+' ');
        li.append(button('Remove',()=>{draft=draft.filter(t=>key(t)!==key(item));updateDraft();}));return li;
      }));
      $('picker-title-count').textContent=draft.length+' / 10 selected · at least 2 required';
    }
    async function begin(mode){
      if(state?.roundId&&state.mode===mode&&!state.result){prepare();return;}
      if(state?.roundId&&!state.result&&!window.confirm('Start a new round? This clears both partners’ current choices.'))return;
      const next=await transport({action:'start',mode,roundId:crypto.randomUUID(),expectedRoundId:state?.roundId||null});if(next)prepare();
    }
    async function search(){
      const q=$('picker-title-query').value.trim(),version=++searchVersion,identity=contextKey();
      $('picker-search-results').replaceChildren();if(q.length<2)return;
      try{
        const lists=await Promise.all(['movie','tv'].map(type=>request('/api/search?type='+type+'&q='+encodeURIComponent(q)+'&page=1')));
        if(version!==searchVersion||identity!==contextKey()||!$('picker-dialog').open)return;
        const items=[];for(let i=0;i<4;i++)for(const list of lists)if(list.items[i])items.push(list.items[i]);
        if(!items.length){$('picker-search-results').append(el('p','No matches. Try a different title.'));return;}
        $('picker-search-results').append(...items.map(t=>{
          const control=button(t.title+' · '+(t.mediaType==='tv'?'TV SERIES':'MOVIE')+(t.year?' · '+t.year:''),()=>{if(draft.length>=10)return;if(!draft.some(item=>key(item)===key(t)))draft.push({...t,key:key(t)});updateDraft();});
          control.disabled=draft.some(item=>key(item)===key(t));return control;
        }));
      }catch{if(version===searchVersion)$('picker-dialog-error').textContent='Search failed. Type again to retry.';}
    }
    function stop(){generation++;clearInterval(timer);timer=null;clearTimeout(resultTimer);close();state=null;preview=[];stopIdle();reading=null;animation?.cancel();animationKey=null;poolKey='';$('picker-rotor').style.transform='';render();}
    function start(){stop();const c=getContext();if(!c.userId)return;void loadPreview();if(!c.roomId)return;void refresh();timer=setInterval(refresh,3000);}
    async function refresh(){if(reading===generation||busy)return;const version=generation;reading=version;try{await transport();}catch(error){if(version===generation)$('picker-error').textContent=error.message;}finally{if(reading===version)reading=null;}}
    $('picker-genre').onclick=()=>run(()=>begin('genre'));$('picker-title').onclick=()=>run(()=>begin('title'));$('picker-trending').onclick=()=>run(()=>begin('trending'));
    $('picker-choose').onclick=()=>prepare();$('picker-demo-partner').onclick=()=>prepare('demo-partner');
    $('picker-close').onclick=close;$('picker-dialog').addEventListener('cancel',event=>{event.preventDefault();close();});
    $('picker-submit').onclick=()=>run(async()=>{const body={action:'submit',roundId:state.roundId,choices:state.mode==='trending'?[]:draft};const next=await transport(body);if(next)close();});
    $('picker-spin').onclick=()=>run(()=>transport({action:'spin',roundId:state.roundId}));
    $('picker-title-query').oninput=()=>{clearTimeout(searchTimer);searchVersion++;searchTimer=setTimeout(search,300);};
    $('picker-result-action').onclick=()=>{if(state?.result){if(state.mode==='genre')onGenre(state.result.title);else onTitle(state.result);}};
    document.addEventListener('visibilitychange',syncIdle);
    window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener?.('change',syncIdle);
    render();return {start,stop,refresh,close,viewChanged:syncIdle};
  }
  const api={create,eligible,angle,duration};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.MultiplayPicker=api;
})(typeof window!=='undefined'?window:globalThis);
