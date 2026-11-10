/* Transport, recovery and presentation; the Node server owns all game mutations. */
(() => {
  'use strict';
  const node=id=>document.getElementById(id);
  let entry=null,lastSnapshot=null,lastVersion=-1,clockOffset=0,lastReceived=0,lastPing=0,retry=0,reconnectTimer=null,watchdog=null,renderTimer=null;
  let intentional=false,stopped=false,sequence=0,eventId=0,paintKey='',animationKey='',pending=null,historyLimit=100;
  const events=[],seen=new Set(),storageKey='river_room_resume_v2';
  const registryKey='river_saved_seats_v3';
  const readRegistry=()=>{try{return JSON.parse(localStorage.getItem(registryKey)||'{}');}catch(_){return{};}};
  const clientId=(()=>{try{let id=localStorage.getItem('river_client_id');if(!id){id=typeof crypto!=='undefined'&&crypto.randomUUID?crypto.randomUUID():Date.now().toString(36)+Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2);localStorage.setItem('river_client_id',id);}return id;}catch(_){return '';}})();
  let rendering=false,renderErrors=0;
  let warningUntil=0;
  const now=()=>Date.now()+clockOffset;
  const safeRead=()=>{try{return JSON.parse(sessionStorage.getItem(storageKey)||'null');}catch(_){return null;}};
  function save(){try{if(entry){const saved={...entry,commandSeq:sequence};sessionStorage.setItem(storageKey,JSON.stringify(saved));if(entry.resumeToken){const registry=readRegistry();registry[entry.roomCode]={...saved,updatedAt:Date.now()};for(const [code,value]of Object.entries(registry))if(Date.now()-value.updatedAt>86400000)delete registry[code];localStorage.setItem(registryKey,JSON.stringify(registry));}}else sessionStorage.removeItem(storageKey);}catch(_){}}
  function status(text,kind='recovering'){
    const banner=node('connectionBanner');banner.hidden=false;banner.dataset.state=kind;node('connectionText').textContent=text;
    node('reconnectBtn').textContent=kind==='expired'?'重新登录 / 载入':'重新同步';
  }
  function raw(data){if(ws?.readyState===WebSocket.OPEN)ws.send(JSON.stringify(data));}
  function sync(){if(ws?.readyState===WebSocket.OPEN)raw({type:'sync',afterEvent:eventId});else connect();}
  function command(type,data={}){
    if(!wsConnected||!entry||ws?.readyState!==WebSocket.OPEN){status('尚未恢复连接，正在核对牌局');connect();return;}
    if(pending){status('上一操作正在确认，请稍候');return;}
    const requestId=data.requestId||`${mySeatId}-${Date.now()}-${++bankRequestSequence}`;
    const payload={...data,type,requestId,commandSeq:++sequence};save();
    pending={...payload,at:Date.now()};
    if(type==='bank')bankPending=true;
    if(type==='action'||type==='raise')actionPending=true;
    raw(payload);paint(true);return true;
  }
  function addEvents(items){
    for(const event of items||[])if(!seen.has(event.id)){seen.add(event.id);events.push(event);eventId=Math.max(eventId,event.id);window.RiverTable?.event(event);}
    events.sort((a,b)=>a.id-b.id);renderHistory();
  }
  function renderHistory(){
    const box=node('chatBox'),filter=node('historyFilter').value||'all';
    const presenting=lastSnapshot?.presentation&&now()<lastSnapshot.interactiveAt;
    const filtered=events.filter(event=>!(presenting&&event.hand===lastSnapshot.game?.handNumber&&['street','payout','result'].includes(event.kind))&&(filter==='all'||(filter==='chat'?['chat','phrase'].includes(event.kind):!['chat','phrase'].includes(event.kind))));
    const nearBottom=(box.scrollHeight||0)-(box.scrollTop||0)-(box.clientHeight||0)<70;
    box.innerHTML=filtered.slice(-historyLimit).map(event=>{
      const time=new Date(event.time).toLocaleTimeString('zh-CN',{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'});
      return `<div class="history-event event-${escapeHtml(event.kind)}"><span class="history-meta">${time} · ${event.hand?'第 '+event.hand+' 手':'等待室'}</span><span>${['chat','phrase'].includes(event.kind)?`<b>${escapeHtml(event.name)}：</b>`:''}${escapeHtml(event.text)}</span></div>`;
    }).join('');
    node('loadEarlierBtn').hidden=filtered.length<=historyLimit;
    node('historyCount').textContent=`本场 ${events.length} 条记录`;
    if(nearBottom)box.scrollTop=box.scrollHeight;
    node('chatQuick').innerHTML='';
  }
  function snapshot(data){
    if(data.version<lastVersion)return;
    const previous=lastSnapshot?.game;
    if(data.game&&(data.game.handNumber!==previous?.handNumber||!PokerEngine.betting(data.game)||data.game.players[data.game.currentPlayerIndex]?.id!==data.seatId))raiseMode=false;
    lastVersion=data.version;lastSnapshot=data;clockOffset=data.serverTime-Date.now();wsConnected=true;retry=0;
    isHost=data.isHost;mySeatId=data.seatId;roomCode=data.roomCode;sequence=Math.max(sequence,data.commandSeq||0);save();
    settings=data.settings;maxPlayers=data.maxPlayers;aiSlots=data.aiSlots;seats=data.seats;
    g=isHost?data.game:null;clientGameState=data.game;
    window.RiverTable?.update(data);
    addEvents(data.events);
    if(data.hasMore)raw({type:'history',afterEvent:eventId});
    if(pending&&Date.now()-pending.at>6000){const received=(data.commandSeq||0)>=pending.commandSeq;pending=null;bankPending=false;actionPending=false;status(received?'已核对最新状态，请按当前牌局继续':'上次操作未到达服务器，请根据当前状态重新操作','ok');}
    if(!data.paused&&Date.now()>warningUntil)status('连接正常 · 服务器托管牌局，后台返回可自动恢复','ok');
    paint(true);
  }
  function paint(force=false){
    if(rendering)return;rendering=true;
    try{draw(force);renderErrors=0;}catch(error){
      console.error('Display recovery:',error.message);renderErrors++;wsConnected=false;
      if(renderErrors>=3){stopped=true;status('界面异常未能自动恢复，请重新载入；服务器仍保留席位','expired');}
      else{status('界面异常，正在读取完整状态');raw({type:'sync',afterEvent:eventId});}
    }finally{rendering=false;}
  }
  function draw(force=false){
    if(stopped)return;
    const data=lastSnapshot;if(!data)return;
    const state=data.game,remaining=Math.max(0,(data.interactiveAt||0)-now());
    const progress=data.presentation?Math.max(0,Math.min(1,(now()-data.presentation.startedAt)/Math.max(1,data.presentation.duration))):1;
    const key=`${data.version}-${wsConnected}-${!!pending}-${remaining>0}-${Math.floor(progress*8)}`;
    if(!force&&paintKey===key){updateClock();return;}paintKey=key;
    node('activityPanel').hidden=false;node('connectionBanner').hidden=false;
    window.RiverTable?.layout(data,remaining);
    if(!state){
      showWaitScreen();
      node('maxPlayersVal').textContent=maxPlayers;
      for(const [id,value]of[['bigBlindSel',settings.bigBlind],['initChipsSel',settings.initChips],['minPlayersSel',settings.minPlayers],['allowBuyInSel',settings.allowBuyIn?'yes':'no']])node(id).value=String(value);
      node('minPlayersSel').disabled=settings.allowBuyIn;
      node('showWinRateSel').value=settings.showWinRate===false?'no':'yes';node('showWinRateSel').disabled=!isHost;
      for(const [id,key]of [['loanPerHandLimit','loanPerHandLimit'],['loanTotalLimit','loanTotalLimit']]){if(document.activeElement!==node(id))node(id).value=settings[key]==null?'无限':String(settings[key]);node(id).disabled=!isHost||!settings.allowBuyIn;}
      const me=seats[mySeatId];
      setConnectionStatus(isHost?'房间已创建，等待玩家加入...':me?.ready?'已准备，等待房主开始游戏':'已连接房间，请点击准备');
      node('dealingStage').hidden=true;return;
    }
    const locked=!wsConnected||data.paused||remaining>0||!!pending;
    actionPending=locked;bankPending=pending?.type==='bank';
    let view=state;
    if(remaining>0&&['hand_over','tournament_over'].includes(state.phase))view={...state,phase:'showdown'};
    const presentation=data.presentation;
    if(presentation&&remaining>0){
      const elapsed=now()-presentation.startedAt,from=presentation.fromCards||0,total=state.communityCards.length-from;
      const shown=presentation.kind==='hole'?0:Math.max(0,Math.min(total,Math.floor((elapsed-200)/Math.max(1,presentation.duration*.72/Math.max(1,total)))+1));
      view={...view,communityCards:state.communityCards.slice(0,from+shown),dealing:presentation.kind==='hole'};
      if(['hand_over','tournament_over'].includes(state.phase))view.phase=view.communityCards.length>=5?'river':view.communityCards.length===4?'turn':view.communityCards.length>=3?'flop':'pre_flop';
      const stage=node('dealingStage');stage.hidden=false;
      if(animationKey!==presentation.id){
        animationKey=presentation.id;
        const title=presentation.kind==='hole'?'洗牌 · 两轮发牌':presentation.kind==='runout'?'依次发完公共牌':'公共牌揭晓';
        stage.innerHTML=`<div class="deal-title">${title}</div><div class="deal-deck">♠</div>${Array.from({length:presentation.kind==='hole'?state.players.filter(p=>p.isActive).length*2:3},(_,i)=>`<span class="flying-card" style="--dx:${(i%4-1.5)*55}px;--dy:${i%2?-80:80}px;animation-delay:${i*80-elapsed}ms">♠</span>`).join('')}<span id="dealRemaining"></span><div class="deal-track"><i id="dealProgress"></i></div>`;
      }
      node('dealRemaining').textContent=`请稍候 ${(remaining/1000).toFixed(1)} 秒`;
      node('dealProgress').style.width=`${Math.round(progress*100)}%`;
    }else{node('dealingStage').hidden=true;animationKey='';}
    if((state.phase==='tournament_over'||state.phase==='hand_over')&&remaining<=0){
      if(state.phase==='tournament_over')renderFinalRanking(state);else showResultScreen(state);
      node('nextHandBtn')&&(node('nextHandBtn').disabled=!!pending||!wsConnected||(state.nextHandReady||[]).includes(mySeatId));
    }else{showGameScreen();renderGame(view);}
    const blindRule=state.blindRule||(state.variant==='short'?'ante':'standard'),blindLabel=blindRule==='ante'?'全员底注＋庄家盲注':blindRule==='position'?'下家1倍 / 下下家半倍':'标准大小盲';
    node('rulesBadge').textContent=`${state.variant==='short'?'短牌':'标准德扑'} · ${blindLabel}`;
    node('rulesBadge').title=(state.variant==='short'?'36张6—A，同花大于葫芦，A6789最小顺子；':'52张标准德州扑克；')+(blindRule==='position'?`庄家左手第一位 ${state.bigBlind}、第二位 ${Math.floor(state.bigBlind/2)}，其他人不付底注`:blindRule==='ante'?`全员底注 ${state.bigBlind}，庄家另付一份盲注`:`小盲 ${Math.floor(state.bigBlind/2)} / 大盲 ${state.bigBlind}`);
    const last=events.filter(event=>event.kind==='action'&&event.hand===state.handNumber&&event.street===state.phase).at(-1);
    node('actionAnnouncement').textContent=last?last.text:`第 ${state.handNumber} 手 · ${PHASE_NAMES[state.phase]||'本轮'} · 等待行动`;
    node('actionAnnouncement').dataset.action=last?.action||'deal';
    if(data.paused)status('异常检测已暂停牌局以保护筹码，请联系房主检查','error');
    if(node('bankDialog').open){renderBank(state);if(locked&&state.phase==='hand_over'){node('bankBorrowBtn').disabled=true;node('bankRepayBtn').disabled=true;if(remaining>0)node('bankStatus').textContent='结算过场中，稍后可借还款。';}}
    window.RiverTable?.render(data,locked);
    updateClock();
  }
  function updateClock(){
    const state=lastSnapshot?.game;if(!state)return;
    window.RiverTable?.clock(lastSnapshot,now(),!!pending||!wsConnected);
    const remaining=Math.max(0,(lastSnapshot.interactiveAt||0)-now());
    if(remaining>0){node('actionHint').textContent=`${lastSnapshot.presentation?'正在发牌':'正在确认上一操作'} · ${(remaining/1000).toFixed(1)} 秒后继续`;return;}
    if(!wsConnected){node('actionHint').textContent='正在恢复连接，暂时不能操作';return;}
    if(pending){node('actionHint').textContent='操作已发送，正在确认；请勿重复点击';return;}
    if(PokerEngine.betting(state)){
      const actor=state.players[state.currentPlayerIndex],seconds=Math.max(0,Math.ceil((lastSnapshot.turnDeadline-now())/1000));
      node('actionHint').textContent=`${actor?.id===mySeatId?'轮到你':`等待 ${actor?.name||'其他玩家'}`} · ${seconds} 秒 · 超时自动过牌或弃牌`;
    }
  }
  function receive(event){
    lastReceived=Date.now();
    if(event.data instanceof ArrayBuffer)return;
    let data;try{data=JSON.parse(event.data);}catch(_){recover('收到异常数据，正在重新同步');return;}
    try{
      if(data.type==='joined'){
        entry={roomCode:data.roomCode,resumeToken:data.resumeToken,isHost:data.isHost};roomCode=data.roomCode;isHost=data.isHost;mySeatId=data.seatId;sequence=Math.max(sequence,data.commandSeq||0);save();
        clearTimeout(connectionTimer);return;
      }
      if(data.type==='snapshot'){snapshot(data);return;}
      if(data.type==='history'){addEvents(data.events);if(data.hasMore)raw({type:'history',afterEvent:eventId});return;}
      if(data.type==='pong'){clockOffset=data.serverTime-Date.now();return;}
      if(data.type==='ack'){
        window.RiverTable?.feedback(data,pending?.requestId===data.requestId?pending:null);
        if(pending?.requestId===data.requestId)pending=null;
        bankPending=false;actionPending=false;
        sequence=Math.max(sequence,data.commandSeq||0,lastSnapshot?.commandSeq||0);save();
        if(data.command==='bank'){bankNotice=data.message||(data.ok?'银行操作成功，下一手请重新确认。':'银行操作未完成');}
        if(data.ok&&data.message){warningUntil=Date.now()+3500;status(data.message,'ok');}
        if(!data.ok){warningUntil=Date.now()+5000;status(data.message||'操作被拒绝，已同步状态','warning');bankNotice=data.message||bankNotice;}
        paint(true);return;
      }
      if(data.type==='error'||data.type==='roomClosed'||data.type==='kicked'){
        stopped=true;intentional=true;wsConnected=false;clearTimeout(reconnectTimer);window.RiverTable?.stop();
        const code=entry?.roomCode||roomCode;
        if(data.fatal||data.type==='roomClosed'||data.type==='kicked'){
          try{const registry=readRegistry();delete registry[code];if(data.type==='kicked'&&data.rejoinToken)registry[code]={roomCode:code,isHost:false,rejoinToken:data.rejoinToken,updatedAt:Date.now()};localStorage.setItem(registryKey,JSON.stringify(registry));}catch(_){}
        }
        status(data.message,'error');setConnectionStatus(data.message,true);document.querySelector('.subtitle').textContent=data.message;
        if(data.fatal||data.type==='roomClosed'||data.type==='kicked'){entry=null;save();}
        if(data.type==='kicked'){
          // Removing the link prevents reload from submitting an automatic join.
          history.replaceState(null,'',location.pathname+location.search);g=null;clientGameState=null;pending=null;actionPending=false;bankPending=false;mySeatId=-1;seats=[];
          node('homeScreen').style.display='';node('waitScreen').style.display='none';node('gameScreen').style.display='none';node('resultScreen').style.display='none';node('sessionToolbar').hidden=true;node('activityPanel').hidden=true;node('positionGuide').hidden=true;
          node('roomCodeInput').value=code;node('roomCodeInput').style.display='';node('confirmJoinBtn').style.display='';node('confirmJoinBtn').textContent='重新加入房间';
          node('reconnectBtn').textContent='重新加入房间';
        }
        ws.close();return;
      }
    }catch(error){console.error(error);recover('界面出现异常，正在重新读取服务器状态');}
  }
  function recover(message){status(message);wsConnected=false;actionPending=true;bankPending=false;paint(true);sync();}
  function connect(){
    if(stopped||!entry)return;
    clearTimeout(reconnectTimer);
    if(ws&&[WebSocket.OPEN,WebSocket.CONNECTING].includes(ws.readyState)&&Date.now()-lastReceived<12000)return;
    if(ws){ws.onclose=null;ws.close();}
    intentional=false;wsConnected=false;
    const socket=new WebSocket((location.protocol==='https:'?'wss:':'ws:')+'//'+location.host);ws=socket;socket.binaryType='arraybuffer';lastReceived=Date.now();
    status(retry?'正在重连并核对牌局…':'正在连接服务器…');
    socket.onopen=()=>{if(ws!==socket)return;raw({type:'joinRoom',roomCode:entry.roomCode,name:myName,avatar:window.RiverAvatars?.read(),seatId:entry.isHost?0:-1,resumeToken:entry.resumeToken,rejoinToken:entry.rejoinToken,clientId,afterEvent:eventId});};
    socket.onmessage=event=>{if(ws===socket)receive(event);};
    socket.onerror=()=>{if(ws===socket)status('网络暂不可用，正在自动恢复连接');};
    socket.onclose=event=>{
      if(ws!==socket)return;wsConnected=false;
      if(intentional||stopped)return;
      if(event.code===4001){stopped=true;status('该席位已在另一页面恢复，请关闭本页','error');return;}
      status('连接中断，席位已保留，正在自动重连…');paint(true);
      reconnectTimer=setTimeout(connect,Math.min(8000,600*2**Math.min(retry++,4)));
      if(retry===3&&typeof fetch==='function')fetch('/api/session').then(result=>{if(result.status===401){stopped=true;status('登录已过期，请重新登录后恢复席位','expired');}}).catch(()=>{});
    };
    clearTimeout(connectionTimer);connectionTimer=setTimeout(()=>{if(ws===socket&&!wsConnected){socket.close();}},12000);
  }
  function begin(code,host){
    intentional=true;if(ws){ws.onclose=null;ws.close();}
    g=null;clientGameState=null;lastSnapshot=null;lastVersion=-1;events.length=0;seen.clear();eventId=0;pending=null;sequence=0;stopped=false;retry=0;
    const saved=safeRead(),known=readRegistry()[code];entry=saved?.roomCode===code?saved:known||{roomCode:code,isHost:host};sequence=entry.commandSeq||0;
    roomCode=code;isHost=host;mySeatId=host?0:-1;seats=[];wsConnected=false;showWaitScreen();setConnectionStatus('正在连接房间…');lastReceived=0;connect();
  }
  function leave({reload=true,permanent=false}={}){intentional=true;stopped=true;save();raw({type:'leaveRoom',permanent});clearTimeout(reconnectTimer);if(permanent&&entry){try{const registry=readRegistry();delete registry[entry.roomCode];localStorage.setItem(registryKey,JSON.stringify(registry));}catch(_){}}entry=null;save();window.RiverTable?.stop();ws?.close();if(reload)location.href=location.pathname;}
  createRoom=()=>begin(String(Math.floor(100000+Math.random()*900000)),true);
  joinRoom=()=>{const code=node('roomCodeInput').value.trim();if(!/^\d{6}$/.test(code)){alert('请输入6位数字房间号');return;}begin(code,false);};
  connectWS=()=>{if(!entry)entry={roomCode:roomCode||'100000',isHost};lastReceived=0;connect();};
  startGameHost=()=>command('startGame');
  scheduleAI=()=>{};syncAfterAction=()=>{};broadcast=()=>{};broadcastSeatsAll=()=>{};sendToPlayer=()=>{};
  playerAction=action=>{const state=lastSnapshot?.game;if(state)command('action',{action,handNumber:state.handNumber,revision:state.revision});};
  confirmRaise=()=>{raiseMode=false;const state=lastSnapshot?.game;if(state)command('raise',{amount:raiseValue,handNumber:state.handNumber,revision:state.revision});};
  nextHand=()=>{const state=lastSnapshot?.game;if(state)command('handReady',{handNumber:state.handNumber});};
  toggleShowFolded=()=>{if(lastSnapshot?.game)command('showFolded',{handNumber:lastSnapshot.game.handNumber});};
  finishSession=()=>{if(isHost)command('endSession');};
  submitBank=kind=>{
    const state=lastSnapshot?.game,p=state?.players.find(p=>p.id===mySeatId);if(!p)return;
    command('bank',{kind,amount:Number(node('bankAmount').value),handNumber:state.handNumber,bankVersion:p.bankVersion});
  };
  broadcastSettings=()=>{if(isHost)command('roomSettings',{settings,maxPlayers,aiSlots});};
  sendChat=()=>{const text=node('chatInput').value.trim();if(!text)return;command('chat',{text});node('chatInput').value='';};
  sendQuickChat=index=>{const phrase=lastSnapshot?.packs?.phrases[index];if(phrase)command('phrase',{phraseId:phrase.id});};
  renderChat=renderHistory;backToHome=()=>leave();node('leaveBtn').onclick=()=>leave();
  node('readyBtn').onclick=()=>command('ready');
  node('historyFilter').onchange=renderHistory;
  node('loadEarlierBtn').onclick=()=>{historyLimit+=100;renderHistory();};
  node('exportHistoryBtn').onclick=()=>{
    const text=events.map(event=>`${new Date(event.time).toLocaleString('zh-CN')} 第${event.hand}手 ${event.kind==='chat'?event.name+'：':''}${event.text}`).join('\n');
    const url=URL.createObjectURL(new Blob([text],{type:'text/plain;charset=utf-8'})),link=document.createElement('a');link.href=url;link.download=`牌局-${roomCode}-记录.txt`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
  node('reconnectBtn').onclick=()=>{if(stopped){const saved=readRegistry()[roomCode];if(saved?.rejoinToken){begin(roomCode,false);return;}location.reload();return;}lastReceived=0;recover('正在手动同步最新状态…');};
  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&entry){lastReceived=0;recover('已回到牌桌，正在核对状态…');}});
  window.addEventListener('online',()=>{if(entry){lastReceived=0;recover('网络已恢复，正在核对状态…');}});
  window.addEventListener('pageshow',event=>{if(event.persisted&&entry){lastReceived=0;recover('页面恢复，正在核对状态…');}});
  window.addEventListener('error',()=>{if(entry&&!stopped)recover('检测到界面异常，正在自动同步');});
  window.addEventListener('unhandledrejection',()=>{if(entry&&!stopped)recover('检测到异步异常，正在自动同步');});
  watchdog=setInterval(()=>{
    if(!entry||stopped||document.hidden)return;
    if(ws?.readyState===WebSocket.OPEN){
      if(Date.now()-lastReceived>16000){lastReceived=0;status('检测到连接无响应，正在重建连接');connect();return;}
      if(Date.now()-lastPing>5000){lastPing=Date.now();raw({type:'ping',nonce:lastPing});}
      if(pending&&Date.now()-pending.at>6000){status('操作响应较慢，正在核对处理结果，避免重复执行');sync();}
    }else if(!reconnectTimer)connect();
  },1000);
  renderTimer=setInterval(()=>{if(!document.hidden)paint();},180);
  const previousLoad=window.onload;
  window.onload=()=>{
    const saved=safeRead(),match=location.hash.match(/room=(\d{6})/);
    if(saved&&(!match||match[1]===saved.roomCode)){const name=localStorage.getItem('starstone_name');if(name)myName=name;node('nameInput').value=myName;entry=saved;sequence=saved.commandSeq||0;roomCode=saved.roomCode;isHost=saved.isHost;showWaitScreen();connect();}
    else if(previousLoad)previousLoad();
  };
  window.RiverSession={sync,reconnect:()=>{lastReceived=0;connect();},leave,clearResume:()=>{entry=null;save();},getDiagnostics:()=>({connected:wsConnected,retry,version:lastVersion,eventId,pending:pending?.type||null,interactiveAt:lastSnapshot?.interactiveAt,serverNow:now()}),command};
  // Mobile bfcache freezes timers; keep them registered so pageshow can resume them.
})();
