const crypto=require('node:crypto');
const E=require('./public/poker-engine');
const PokerAI=require('./poker-ai');
const Avatars=require('./public/avatars');
const RunoutTimeline=require('./public/runout-timeline');
const DEFAULT_TIMING={deal:1800,street:1200,runout:3000,action:900,ai:1100,turn:60000,offlineTurn:30000,reserve:1800000,vote:20000};
const PHASE={pre_flop:'翻牌前',flop:'翻牌',turn:'转牌',river:'河牌',hand_over:'结算'};
const ACTION={fold:'弃牌 FOLD',check:'过牌 CHECK',call:'跟注 CALL',raise:'加注 RAISE',allin:'梭哈 ALL IN'};
const send=(ws,data)=>{if(ws?.readyState===1)ws.send(JSON.stringify(data));};
const hash=token=>crypto.createHash('sha256').update(token).digest('hex');

class RoomManager {
  constructor(connections){
    this.connections=connections;this.games=new Map();this.timing={...DEFAULT_TIMING};
    this.timer=setInterval(()=>this.tick(),250);this.timer.unref();
  }
  configureTimings(values){Object.assign(this.timing,values);if(Object.hasOwn(values,'runout'))this.runoutTimingOverride=values.runout;}
  event(room,kind,text,extra={}){
    const event={id:room.history.length+1,kind,text,time:Date.now(),hand:room.game?.handNumber||0,phase:room.game?.phase||'waiting',...extra};
    room.history.push(event);return event;
  }
  join(ws,data){
    const code=data.roomCode;
    if(typeof code!=='string'||!/^\d{6}$/.test(code)){send(ws,{type:'error',message:'请输入6位数字房间号'});return;}
    let room=this.games.get(code),person,rejoined=false;
    if(data.rejoinToken){
      person=room&&[...room.people.values()].find(p=>p.kicked&&p.rejoinTokenHash===hash(String(data.rejoinToken)));
      if(!person){send(ws,{type:'error',fatal:true,message:'重新入座凭证已失效，请重新加入房间'});return;}
      if(room.game&&!room.game.players.some(p=>p.id===person.id)){
        if(room.game.players.length>=8||room.game.phase==='tournament_over'){send(ws,{type:'error',fatal:true,message:'本场已满或已结算，请等待新房间'});return;}
        const g=room.game,actorId=g.players[g.currentPlayerIndex]?.id,dealerId=g.players[g.dealerIndex]?.id;
        const player=E.createGame([{id:person.id,name:person.name,avatar:person.avatar,chips:room.settings.initChips,isAI:false,connected:true}],g.bigBlind).players[0];
        Object.assign(player,{folded:true,isActive:false,allIn:false,acted:true});
        g.players.push(player);g.players.sort((a,b)=>a.id-b.id);g.initialTotal+=player.initialChips;
        g.currentPlayerIndex=g.players.findIndex(p=>p.id===actorId);g.dealerIndex=g.players.findIndex(p=>p.id===dealerId);g.revision++;
      }
      rejoined=true;person.kicked=false;person.retired=false;this.rotateToken(person);
      delete person.rejoinToken;delete person.rejoinTokenHash;delete person.revokedTokenHash;
    }else if(data.resumeToken){
      const kicked=room&&[...room.people.values()].find(p=>p.kicked&&p.revokedTokenHash===hash(String(data.resumeToken)));
      if(kicked){send(ws,{type:'kicked',fatal:true,message:'你已被房主移出房间，可手动重新加入',rejoinToken:kicked.rejoinToken});return;}
      person=room&&[...room.people.values()].find(p=>p.tokenHash===hash(String(data.resumeToken))&&!p.retired&&(!p.offlineAt||Date.now()-p.offlineAt<this.timing.reserve));
      if(!person){send(ws,{type:'error',fatal:true,message:'房间不存在、已结束或席位保留已到期，请重新创建或加入房间'});return;}
      const old=this.connections.get(code)?.get(person.id);
      if(old&&old!==ws){old.superseded=true;old.close(4001,'Seat resumed elsewhere');}
    }else if(data.seatId===0){
      if(room){send(ws,{type:'error',message:'房间号已被使用，请重新创建房间'});return;}
      room={code,people:new Map(),settings:{bigBlind:20,initChips:2000,minPlayers:2,allowBuyIn:false,showWinRate:true,deckMode:'auto',blindMode:'auto'},maxPlayers:4,aiSlots:{},game:null,history:[],version:0,blockedUntil:0,presentation:null,deadline:0,aiDue:0,paused:false,lastActivity:Date.now()};
      this.games.set(code,room);this.connections.set(code,new Map());
      person=this.newPerson(0,data.name,data.avatar);room.people.set(0,person);
    }else{
      if(!room){send(ws,{type:'error',message:'房间不存在或房主已离线，请核对房间号'});return;}
      if(room.game){send(ws,{type:'error',message:'牌局已开始，请使用原席位恢复连接；新玩家请等待新房间'});return;}
      let id=1;while(room.people.has(id)&&!room.people.get(id).kicked)id++;
      if(id>=8){send(ws,{type:'error',message:'房间已满，最多支持8人'});return;}
      person=this.newPerson(id,data.name,data.avatar);room.people.set(id,person);room.maxPlayers=Math.max(room.maxPlayers,id+1);delete room.aiSlots[id];
    }
    if(ws.roomCode&&ws.roomCode!==code){send(ws,{type:'error',message:'请先离开原房间'});return;}
    const resumed=!!data.resumeToken;
    person.connected=true;person.offlineAt=0;person.ready=resumed?false:person.id===0;
    if(typeof data.clientId==='string'&&/^[a-zA-Z0-9-]{16,100}$/.test(data.clientId))person.clientId=data.clientId;
    ws.roomCode=code;ws.seatId=person.id;ws.playerName=person.name;ws.eventCursor=Number.isSafeInteger(data.afterEvent)?Math.max(0,data.afterEvent):0;
    this.connections.get(code).set(person.id,ws);
    const p=room.game?.players.find(p=>p.id===person.id);
    if(p){p.connected=true;if(rejoined)p.disconnected=false;room.game.nextHandReady=room.game.nextHandReady.filter(id=>id!==p.id);}
    send(ws,{type:'joined',seatId:person.id,isHost:person.id===0,resumeToken:person.token,commandSeq:person.commandSeq,roomCode:code,resumed});
    this.event(room,'system',`${person.name}${rejoined?' 已重新入座，当前手保持原状态，下一手可继续参与':resumed?' 已恢复连接，状态已同步':' 加入牌桌'}`);
    this.publish(room);
  }
  rotateToken(person){person.token=crypto.randomBytes(32).toString('base64url');person.tokenHash=hash(person.token);}
  newPerson(id,name,avatar){const person={id,name:String(name||'玩家').slice(0,32),avatar:Avatars.get(avatar).id,peekThreshold:null,connected:true,ready:id===0,commandSeq:0,receipts:new Map(),offlineAt:0,retired:false};this.rotateToken(person);return person;}
  finished(room){const g=room.game;if(!g)return false;if(g.allowBuyIn)return g.phase==='tournament_over';const alive=g.players.filter(p=>p.chips>0&&!p.disconnected);return alive.length<2||(g.players.length>room.settings.minPlayers&&alive.length<=room.settings.minPlayers);}
  serialize(room,viewer){
    const g=room.game;if(!g)return null;
    const timeline=room.presentation?.timeline,frame=timeline&&Date.now()<room.blockedUntil?RunoutTimeline.frame(timeline,Date.now()-room.presentation.startedAt):null;
    const boards=g.runoutBoards||[g.communityCards],visible=frame?boards.map((board,i)=>board.slice(0,frame.counts[i])):boards;
    const reveal=['hand_over','showdown','tournament_over'].includes(g.phase);
    return{handNumber:g.handNumber,phase:g.phase,currentBet:g.currentBet,dealerIndex:g.dealerIndex,currentPlayerIndex:g.currentPlayerIndex,
      communityCards:frame?visible[frame.board]:g.communityCards,minRaise:g.minRaise,bigBlind:g.bigBlind,betLevel:g.betLevel,pot:frame?g.players.reduce((sum,p)=>sum+p.totalBet,0):g.pot,revision:g.revision,nextHandReady:g.nextHandReady,winners:frame?[]:g.winners,pots:frame?[]:g.pots,showWinRate:g.showWinRate!==false,
      allowBuyIn:g.allowBuyIn,loanPerHandLimit:g.loanPerHandLimit,loanTotalLimit:g.loanTotalLimit,endRequested:g.endRequested,bankLog:g.bankLog,bankSequence:g.bankSequence,variant:g.variant,blindRule:g.blindRule,blindSeats:g.blindSeats,actionOrder:g.actionOrder,runoutBoards:g.runoutBoards?(frame?visible.slice(0,frame.board+1):g.runoutBoards):null,showdownOccurred:g.showdownOccurred===true,
      players:g.players.map(p=>({id:p.id,name:p.name,avatar:p.avatar||'default',chips:frame&&Number.isSafeInteger(p.chipsBeforeHand)?p.chipsBeforeHand-p.totalBet:p.chips,currentBet:p.currentBet,totalBet:p.totalBet,folded:p.folded,allIn:p.allIn,isActive:p.isActive,
        handResult:frame?null:p.handResult,handResults:frame?null:p.handResults,acted:p.acted,canRaise:E.canRaise(g,p),disconnected:!!p.disconnected,connected:p.connected!==false,isAI:!!p.isAI,
        chipsBeforeHand:p.chipsBeforeHand,chipsAfterHand:frame?null:p.chipsAfterHand,initialChips:p.initialChips,bankDebt:p.bankDebt,totalBorrowed:p.totalBorrowed,totalRepaid:p.totalRepaid,bankVersion:p.bankVersion,borrowHandNumber:p.borrowHandNumber,borrowedThisHand:p.borrowedThisHand,
        eliminatedHand:p.eliminatedHand,eliminationStack:p.eliminationStack,showFolded:p.showFolded,lastAction:p.lastAction,
        commandSeq:room.people.get(p.id)?.commandSeq||0,peekThreshold:room.people.get(p.id)?.peekThreshold??null,position:g.positions?.[p.id]||null,
        privateReveal:!!g.privateReveals?.[p.id]?.includes(viewer),
        holeCards:p.id===viewer||(reveal&&((g.showdownOccurred===true&&!p.folded)||p.showFolded))||g.privateReveals?.[p.id]?.includes(viewer)?p.holeCards:[]}))};
  }
  snapshot(room,ws){
    const events=room.history.filter(event=>event.id>(ws.eventCursor||0)).slice(0,25);
    if(events.length)ws.eventCursor=events.at(-1).id;
    send(ws,{type:'snapshot',version:room.version,serverTime:Date.now(),roomCode:room.code,seatId:ws.seatId,isHost:ws.seatId===0,
      commandSeq:room.people.get(ws.seatId)?.commandSeq||0,settings:room.settings,maxPlayers:room.maxPlayers,aiSlots:room.aiSlots,
      seats:Array.from({length:Math.max(...room.people.keys())+1},(_,id)=>{const p=room.people.get(id);return p&&!p.retired?{id:'player-'+id,name:p.name,avatar:p.avatar,isHost:id===0,ready:p.ready,connected:p.connected}:null;}),
      game:this.serialize(room,ws.seatId),presentation:room.presentation,interactiveAt:room.blockedUntil,turnDeadline:room.deadline,paused:room.paused,
      events,hasMore:ws.eventCursor<room.history.length,lastEventId:room.history.length,...this.extraSnapshot(room,ws.seatId)});
  }
  publish(room){room.version++;room.lastActivity=Date.now();for(const ws of this.connections.get(room.code)?.values()||[])this.snapshot(room,ws);}
  history(room,ws,after){const events=room.history.slice(Math.max(0,Number(after)||0),Math.max(0,Number(after)||0)+25);if(events.length)ws.eventCursor=events.at(-1).id;send(ws,{type:'history',events,hasMore:ws.eventCursor<room.history.length,lastEventId:room.history.length});}
  ack(room,ws,data,result){send(ws,{type:'ack',requestId:data.requestId,commandSeq:data.commandSeq,command:data.type,...result});this.snapshot(room,ws);}
  handle(ws,data){
    if(data.type==='joinRoom'){if(!ws.roomCode)this.join(ws,data);return;}
    const room=this.games.get(ws.roomCode);
    if(data.type==='ping'){send(ws,{type:'pong',nonce:data.nonce,serverTime:Date.now(),version:room?.version||0});return;}
    if(!room||this.connections.get(room.code)?.get(ws.seatId)!==ws)return;
    if(data.type==='sync'){ws.eventCursor=Math.max(0,Number(data.afterEvent)||0);this.snapshot(room,ws);return;}
    if(data.type==='history'){this.history(room,ws,data.afterEvent);return;}
    const person=room.people.get(ws.seatId);
    if(data.type==='leaveRoom'){this.leave(ws,data.permanent===true);return;}
    if(!Number.isSafeInteger(data.commandSeq)||data.commandSeq<=0||typeof data.requestId!=='string'||data.requestId.length>100){this.ack(room,ws,data,{ok:false,message:'请求无效，请同步状态后重试'});return;}
    const cached=person.receipts.get(data.requestId);
    if(cached){this.ack(room,ws,data,{...cached,duplicate:true,message:cached.ok?'该笔操作已处理，请核对最新状态。':cached.message});return;}
    if(data.commandSeq<=person.commandSeq){this.ack(room,ws,data,{ok:false,message:'账户或牌局已更新，请核对后重试'});return;}
    person.commandSeq=data.commandSeq;
    let result;
    try{result=this.command(room,person,data)||{ok:true};if(room.game)this.check(room);}
    catch(error){console.error('Room command failed:',error.message);room.paused=true;this.event(room,'system','系统检测到异常，已暂停操作以保护筹码，请同步或联系房主。');result={ok:false,message:'牌局异常，已暂停以保护筹码'};}
    person.receipts.set(data.requestId,result);if(person.receipts.size>64)person.receipts.delete(person.receipts.keys().next().value);
    this.publish(room);this.ack(room,ws,data,result);
  }
  command(room,person,data){
    const g=room.game,fail=message=>({ok:false,message});
    if(room.paused)return fail('系统已暂停牌局，请联系房主检查');
    if(['state','result','gameStart','nextHand','finishSession'].includes(data.type))return fail('不能修改服务器牌局状态');
    const extra=this.extraCommand(room,person,data);if(extra!==undefined)return extra;
    if(data.type==='chat'){
      const text=String(data.text||'').trim().slice(0,300);if(!text)return fail('消息不能为空');
      this.event(room,'chat',text,{name:person.name,seatId:person.id});return{ok:true};
    }
    if(data.type==='roomSettings'){
      if(person.id!==0||g)return fail('只有房主可在开局前设置规则');
      const s=data.settings||{};
      if(s.runoutDelayMs!==undefined&&(!Number.isInteger(s.runoutDelayMs)||s.runoutDelayMs<0||s.runoutDelayMs>3000))return fail('跑马发牌间隔须在0至3000毫秒之间');
      if(s.showWinRate!==undefined&&typeof s.showWinRate!=='boolean')return fail('是否显示胜率设置无效');
      if(!E.validLoanLimit(s.loanPerHandLimit)||!E.validLoanLimit(s.loanTotalLimit))return fail('贷款限额须为0或正整数，无限额请选无限');
      if(![10,20,50,100].includes(s.bigBlind)||![1000,2000,5000].includes(s.initChips)||![1,2,3].includes(s.minPlayers))return fail('房间设置无效');
      room.settings={bigBlind:s.bigBlind,initChips:s.initChips,minPlayers:s.minPlayers,allowBuyIn:s.allowBuyIn===true,showWinRate:s.showWinRate!==false,loanPerHandLimit:s.loanPerHandLimit??null,loanTotalLimit:s.loanTotalLimit??null,deckMode:['auto','short','standard'].includes(s.deckMode)?s.deckMode:room.settings.deckMode,blindMode:['auto','ante','position','standard'].includes(s.blindMode)?s.blindMode:room.settings.blindMode};
      room.settings.runoutDelayMs=s.runoutDelayMs??3000;
      const required=Math.max(...room.people.keys())+1;
      room.maxPlayers=Math.max(required,Math.min(8,Math.max(2,Math.floor(Number(data.maxPlayers)||4))));
      room.aiSlots={};for(let i=1;i<room.maxPlayers;i++)if(data.aiSlots?.[i]&&!room.people.has(i))room.aiSlots[i]=true;
      return{ok:true};
    }
    if(data.type==='ready'){if(g)return fail('牌局已开始');person.ready=true;return{ok:true};}
    if(data.type==='startGame'){
      if(person.id!==0||g)return fail('只有房主可以开局');
      const humans=[...room.people.values()].filter(p=>p.connected&&!p.retired);
      if(humans.some(p=>p.id!==0&&!p.ready))return fail('请等待所有玩家准备');
      const players=humans.map(p=>({id:p.id,name:p.name,avatar:p.avatar,chips:room.settings.initChips,isHost:p.id===0,isAI:false,connected:true}));
      const names=['Alpha','Beta','Gamma','Delta','Omega','Sigma','Echo'];
      for(const key of Object.keys(room.aiSlots))if(room.aiSlots[key])players.push({id:Number(key),name:names[Number(key)-1],avatar:'robot',chips:room.settings.initChips,isAI:true,connected:true});
      if(players.length<2||players.length>8)return fail('请至少安排两人，最多8人');
      room.game=E.createGame(players,room.settings.bigBlind,{allowBuyIn:room.settings.allowBuyIn,showWinRate:room.settings.showWinRate,loanPerHandLimit:room.settings.loanPerHandLimit,loanTotalLimit:room.settings.loanTotalLimit,autoDeck:true,deckMode:room.settings.deckMode,blindMode:room.settings.blindMode,runTwiceEnabled:true});
      this.start(room);return{ok:true};
    }
    if(!g)return fail('牌局尚未开始');
    if(data.type==='endSession'){
      const result=E.requestSessionEnd(g,person.id);
      if(result.ok)this.event(room,'system',g.phase==='tournament_over'?'房主已结算整场，将按净筹码公布排名。':'房主申请结算整场，当前手正常打完后公布排名。');
      return result;
    }
    if(Date.now()<room.blockedUntil)return fail('发牌或操作过场中，请稍候');
    if(data.type==='handReady'){
      if(this.finished(room)&&person.id===0&&!g.allowBuyIn){g.phase='tournament_over';this.event(room,'system','房主公布最终排名');return{ok:true};}
      if(!E.confirmNextHand(g,person.id,data.handNumber))return fail('本手已经更新，请重新确认');
      this.event(room,'system',person.name+' 已确认下一手');this.tryStart(room);return{ok:true};
    }
    if(data.type==='bank'){
      const result=E.bankTransaction(g,person.id,data.kind,data.amount,data);
      if(result.ok&&!result.duplicate)this.event(room,'bank',`${person.name} ${data.kind==='borrow'?'贷款买入':'还款'} ${data.amount}`,{seatId:person.id});
      return result.ok?{...result,message:result.duplicate?'该笔操作已处理，请核对账户。':'银行操作成功，下一手请重新确认。'}:result;
    }
    if(data.type==='showFolded'){
      const p=g.players.find(p=>p.id===person.id),optional=p?.folded||g.showdownOccurred===false&&g.winners.includes(person.id);
      if(g.phase!=='hand_over'||data.handNumber!==g.handNumber||p?.holeCards.length!==2||!optional)return fail('当前不能亮牌');
      p.showFolded=!p.showFolded;return{ok:true};
    }
    if(data.type==='action'||data.type==='raise')return this.act(room,person.id,data.type==='raise'?'raise':data.action,data.amount,data);
    return fail('未知操作');
  }
  start(room){
    if(!E.startHand(room.game))return false;
    const g=room.game;
    const blindText=g.blindRule==='ante'?`全员底注 ${g.bigBlind}，庄家再付一份盲注`:g.blindRule==='position'?`庄家左手第一位 ${g.bigBlind}，第二位 ${g.smallBlind}，其余人不付底注`:`标准大小盲 ${g.smallBlind}/${g.bigBlind}`;
    this.event(room,'hand',`第 ${g.handNumber} 手开始 · ${g.variant==='short'?'36张短牌：6—A，同花大于葫芦，A6789为最小顺子':'52张标准德扑'} · ${blindText}`);
    for(const p of g.players.filter(p=>p.isActive&&p.totalBet>0))this.event(room,'blind',`${p.name} 投入${g.blindRule==='ante'?'底注/庄家盲注':g.blindSeats?.full===p.id?'1倍盲注':'半倍盲注'} ${p.totalBet}`);
    this.pace(room,'hole',0,this.timing.deal);
    if(g.phase==='runout_vote')this.prepareVote(room);
    else if(g.phase==='hand_over')this.recordSettlement(room);
    return true;
  }
  tryStart(room){if(room.game?.phase==='hand_over'&&!this.finished(room)&&E.allConfirmed(room.game))this.start(room);}
  pace(room,kind,fromCards,duration){
    const timeline=kind==='runout'&&room.game.showdownOccurred?RunoutTimeline.build(fromCards,room.game.runoutBoards?.length||1,this.runoutTimingOverride??room.settings.runoutDelayMs??3000,this.runoutTimingOverride??5000):null;
    if(timeline)duration=timeline.duration;
    const now=Date.now();room.blockedUntil=now+Math.max(0,duration);
    room.presentation=kind?{id:`${room.game.handNumber}-${room.game.revision}-${kind}`,kind,fromCards,startedAt:now,until:room.blockedUntil,duration}:null;
    if(room.presentation&&timeline)room.presentation.timeline=timeline;
    room.aiDue=room.blockedUntil+this.timing.ai;room.deadline=room.blockedUntil+this.timing.turn;
  }
  act(room,seatId,action,amount,expected,automatic=false){
    const g=room.game,p=g.players.find(p=>p.id===seatId);const before=p&&{chips:p.chips,bet:p.currentBet,currentBet:g.currentBet,minRaise:g.minRaise,betLevel:g.betLevel||0,phase:g.phase,cards:g.communityCards.length};
    const result=E.applyAction(g,seatId,action,amount,expected);if(!result.ok)return result;
    const paid=action==='call'?Math.min(before.chips,Math.max(0,before.currentBet-before.bet)):action==='allin'?before.chips:action==='raise'?amount-before.bet:0;
    const level=before.bet+paid-before.currentBet>=before.minRaise&&['raise','allin'].includes(action)?before.betLevel+1:0;
    const label=(level?`${level}-BET · `:'')+(action==='raise'?`${ACTION[action]} 至 ${amount}`:action==='allin'?`${ACTION[action]} 至 ${before.chips+before.bet}`:action==='call'?`${ACTION[action]} ${paid}`:ACTION[action]);
    const event=this.event(room,'action',`${p.name} ${automatic?'超时自动 ':''}${label}`,{seatId,name:p.name,action,amount:Math.max(0,paid),raised:before.bet+paid>before.currentBet,label,street:before.phase,automatic});
    // The closing action belongs in history, never in the new street's markers.
    if(g.phase===before.phase)p.lastAction={id:event.id,action,label,hand:g.handNumber,phase:before.phase,automatic};
    else for(const player of g.players)player.lastAction=null;
    if(g.communityCards.length>before.cards)this.event(room,'street',`${PHASE[g.phase]||'公共牌发完'} · ${g.communityCards.map(c=>'♠♥♣♦'[c.suit]+({11:'J',12:'Q',13:'K',14:'A'}[c.rank]||c.rank)).join(' ')}`);
    const changed=g.communityCards.length>before.cards;
    const allinFinish=['hand_over','tournament_over'].includes(g.phase)&&g.showdownOccurred&&g.players.some(p=>p.allIn);
    this.pace(room,allinFinish?'runout':changed?(g.communityCards.length-before.cards>3?'runout':g.phase==='hand_over'?'runout':'street'):null,before.cards,changed?(g.phase==='hand_over'?this.timing.runout:this.timing.street):this.timing.action);
    if(g.phase==='runout_vote')this.prepareVote(room);
    else if(['hand_over','tournament_over'].includes(g.phase))this.recordSettlement(room);
    return result;
  }
  recordSettlement(room){
    const g=room.game;this.payTips(room);for(let i=0;i<g.pots.length;i++)for(const award of g.pots[i].awards)this.event(room,'payout',`${g.players.find(p=>p.id===award.seatId).name} 分得${i===0?'主池':`边池 ${i}`} ${award.amount}`);
    if(g.runoutBoards)g.runoutBoards.forEach((board,index)=>this.event(room,'street',`第${index+1}组公共牌 · ${board.map(c=>'♠♥♣♦'[c.suit]+({11:'J',12:'Q',13:'K',14:'A'}[c.rank]||c.rank)).join(' ')}`));
    this.event(room,'result',`第 ${g.handNumber} 手结束${g.phase==='tournament_over'?'，整场结算':''}`);
  }
  check(room){
    const g=room.game,total=g.players.reduce((sum,p)=>sum+p.chips-p.bankDebt,0)+g.pot;
    if(total!==g.initialTotal||!Number.isSafeInteger(total)||g.players.some(p=>!Number.isSafeInteger(p.chips)||p.chips<0||p.bankDebt<0))throw new Error('chip accounting invariant');
  }
  leave(ws,permanent=false){
    const room=this.games.get(ws.roomCode);if(!room||this.connections.get(room.code)?.get(ws.seatId)!==ws)return;
    this.connections.get(room.code).delete(ws.seatId);
    const person=room.people.get(ws.seatId);person.connected=false;person.ready=false;person.offlineAt=Date.now();
    if(permanent&&ws.seatId===0){this.closeRoom(room.code,'房主已离开，房间已关闭');return;}
    const p=room.game?.players.find(p=>p.id===ws.seatId);
    if(p)p.connected=false;
    if(permanent){person.retired=true;if(room.game)E.disconnect(room.game,person.id);else room.people.delete(person.id);}
    this.event(room,'system',`${person.name} ${permanent?'已离桌':'暂时断线，席位保留30分钟，回来可恢复'}`);
    if(room.game&&E.betting(room.game)&&room.game.players[room.game.currentPlayerIndex]?.id===person.id)room.deadline=Math.min(room.deadline,Date.now()+this.timing.offlineTurn);
    if(room.game?.phase==='hand_over')this.tryStart(room);
    if(room.game?.phase==='runout_vote'&&room.game.runoutVote.eligibleIds.includes(person.id))this.finishVote(room,false,'争池玩家离线，本手发一次牌');
    this.publish(room);
  }
  closeRoom(code,message='房间已结束'){
    const room=this.games.get(code);if(!room)return;
    this.games.delete(code);const clients=this.connections.get(code);this.connections.delete(code);
    for(const ws of clients?.values()||[]){send(ws,{type:'roomClosed',fatal:true,message});ws.close(1000,'Room closed');}
  }
  tick(){
    const now=Date.now();
    for(const room of this.games.values()){
      try{
        const g=room.game;
        let expired=false;for(const r of g?.peekRequests||[])if(r.status==='pending'&&now>=r.expiresAt){r.status='expired';expired=true;}if(expired)this.publish(room);
        for(const p of room.people.values())if(!p.connected&&!p.retired&&p.offlineAt&&now-p.offlineAt>this.timing.reserve){p.retired=true;if(g)E.disconnect(g,p.id);}
        if(![...room.people.values()].some(p=>p.connected)&&now-room.lastActivity>this.timing.reserve){this.closeRoom(room.code,'房间长时间无人在线，已结束');continue;}
        if(!g||room.paused)continue;
        if(room.presentation&&now>=room.blockedUntil){room.presentation=null;this.publish(room);}
        if(room.presentation?.timeline&&now<room.blockedUntil){const key=JSON.stringify(RunoutTimeline.frame(room.presentation.timeline,now-room.presentation.startedAt).counts);if(key!==room.presentation.frameKey){room.presentation.frameKey=key;this.publish(room);}}
        if(g.phase==='runout_vote'){this.prepareVote(room);if(g.runoutVote&&now>=g.runoutVote.expiresAt)this.finishVote(room,false,'协商超时，本手发一次牌');this.check(room);if(g.phase!=='runout_vote')this.publish(room);continue;}
        if(now<room.blockedUntil)continue;
        if(!E.betting(g))continue;
        let actor=g.players[g.currentPlayerIndex];
        if(!actor||!actor.isActive||actor.folded||actor.allIn){
          const beforeCards=g.communityCards.length;E.advance(g);g.revision++;this.event(room,'system','系统已自动校正行动顺序');
          this.pace(room,g.communityCards.length>beforeCards?'runout':null,beforeCards,this.timing.action);
          if(g.phase==='runout_vote')this.prepareVote(room);else if(['hand_over','tournament_over'].includes(g.phase))this.recordSettlement(room);
          this.check(room);this.publish(room);continue;
        }
        if(actor.isAI&&now>=room.aiDue){
          const fallback={action:g.currentBet===actor.currentBet?'check':'fold'};let decision;
          try{decision=PokerAI.decide(PokerAI.observe(g,actor.id,room.history));}catch(error){console.error('AI decision fallback:',error.message);decision=fallback;}
          const result=this.act(room,actor.id,decision.action,decision.amount);if(!result.ok)this.act(room,actor.id,fallback.action);
          this.check(room);this.publish(room);
        }else if(!actor.isAI&&now>=room.deadline){this.act(room,actor.id,g.currentBet===actor.currentBet?'check':'fold',undefined,undefined,true);this.check(room);this.publish(room);}
      }catch(error){room.paused=true;this.event(room,'system','异常检测已暂停牌局以保护筹码，请联系房主检查。');this.publish(room);console.error('Room watchdog:',error.message);}
    }
  }
  dispose(){clearInterval(this.timer);for(const code of [...this.games.keys()])this.closeRoom(code);}
}
require('./room-extras')(RoomManager);
module.exports={RoomManager,DEFAULT_TIMING};
