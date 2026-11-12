const {test}=require('node:test');
const assert=require('node:assert/strict');
const {RoomManager}=require('../room-manager');
const E=require('../public/poker-engine');
function fixture(t,n=2,timings={}){
  const manager=new RoomManager(new Map(),{roster(){},remove(){}});manager.configureTimings({deal:0,street:0,runout:0,action:0,ai:0,...timings});t.after(()=>manager.dispose());
  const sockets=[];const code='123456';
  function join(data={}){const ws={uid:data.uid,readyState:1,messages:[],send(s){this.messages.push(JSON.parse(s));},close(){this.readyState=3;}};manager.handle(ws,{type:'joinRoom',roomCode:code,seatId:sockets.length?-1:0,name:'P'+sockets.length,...data});sockets.push(ws);return ws;}
  for(let i=0;i<n;i++)join();
  function command(ws,type,data={}){const person=manager.games.get(code)?.people.get(ws.seatId);manager.handle(ws,{type,requestId:'request-'+ws.seatId+'-'+(person?.commandSeq+1),commandSeq:person?.commandSeq+1,...data});return ws.messages.filter(m=>m.type==='ack').at(-1);}
  function start(){for(const ws of sockets.slice(1))command(ws,'ready');assert.ok(command(sockets[0],'startGame').ok);}
  return{manager,sockets,room:manager.games.get(code),join,command,start,latest:ws=>ws.messages.filter(m=>m.type==='snapshot').at(-1)};
}
test('waiting readiness survives repeated settings and requires the current revision after a rule change',t=>{
  const f=fixture(t),[host,guest]=f.sockets;
  assert.ok(f.command(guest,'ready',{rulesRevision:0}).ok);
  const settings={...f.room.settings};
  assert.ok(f.command(host,'roomSettings',{settings}).ok);
  assert.equal(f.latest(guest).waiting.canStart,true);
  assert.ok(f.command(host,'blindMode',{mode:'standard'}).ok);
  assert.equal(f.latest(guest).waiting.canStart,false);
  assert.deepEqual(f.latest(guest).waiting.awaiting,['P1']);
  assert.equal(f.command(guest,'ready',{rulesRevision:0}).ok,false);
  assert.ok(f.command(guest,'ready',{rulesRevision:1}).ok);
  assert.equal(f.latest(host).waiting.canStart,true);
});
test('8 seats work, a ninth player is rejected, and authoritative snapshots hide other hole cards',t=>{
  const f=fixture(t,8);const ninth=f.join();assert.match(ninth.messages.at(-1).message,/最多支持8人/);f.sockets.pop();f.start();
  assert.equal(f.room.game.variant,'standard');
  for(const ws of f.sockets){const state=f.latest(ws).game;assert.equal(state.deck,undefined);for(const p of state.players)assert.equal(p.holeCards.length,p.id===ws.seatId?2:0);}
});
test('late entrants wait for the next hand, can free capacity, and reclaim the same account by UID',t=>{
  const f=fixture(t);
  const profiles=Array.from({length:8},(_,index)=>({uid:'uid'+index,name:'Late'+index,avatar:'default'}));
  f.manager.accounts={byUid:new Map(profiles.map(profile=>[profile.uid,profile]))};
  f.room.settings.allowBuyIn=true;
  f.start();
  const g=f.room.game,actor=g.players[g.currentPlayerIndex],rev=g.revision;
  const late=f.join({uid:'uid0'}),initial=g.players.find(p=>p.id===late.seatId);
  assert.equal(initial.chips,2000);
  assert.equal(initial.waitingForHand,true);
  assert.equal(initial.holeCards.length,0);
  assert.equal(g.players[g.currentPlayerIndex],actor);
  assert.equal(g.revision,rev);
  while(E.betting(g))assert.ok(f.manager.act(f.room,g.players[g.currentPlayerIndex].id,'fold').ok);
  const debt={kind:'borrow',amount:500,handNumber:g.handNumber,bankVersion:0};
  assert.ok(f.command(late,'bank',debt).ok);
  const others=profiles.slice(1,6).map(profile=>f.join({uid:profile.uid}));
  const full=f.join({uid:'uid6'});
  assert.match(full.messages.at(-1).message,/最多支持8人/);
  f.manager.leave(late,true);
  const replacement=f.join({uid:'uid6'});
  assert.ok(replacement.seatId>=8);
  f.manager.leave(others[0],true);
  const returned=f.join({uid:'uid0'});
  assert.equal(returned.seatId,late.seatId);
  assert.deepEqual([initial.chips,initial.bankDebt],[2500,500]);
  assert.equal(g.players.filter(p=>p.connected!==false&&!p.disconnected).length,8);
  f.manager.check(f.room);
  for(const ws of [f.sockets[0],f.sockets[1],...others.slice(1),replacement,returned])assert.ok(f.command(ws,'handReady',{handNumber:1}).ok);
  assert.equal(g.handNumber,2);
  assert.equal(initial.holeCards.length,2);
  assert.equal(initial.waitingForHand,false);
});

test('kicking an all-in bot preserves its pending pot claim and removes its account after settlement',t=>{
  const f=fixture(t,2,{runout:1000});
  f.room.aiSlots[2]=true;
  f.room.settings.blindMode='standard';
  f.start();
  const g=f.room.game,bot=g.players.find(player=>player.isAI);
  while(E.betting(g)&&!bot.allIn){
    const actor=g.players[g.currentPlayerIndex];
    assert.ok(f.manager.act(f.room,actor.id,actor===bot?'allin':actor.currentBet<g.currentBet?'call':'check').ok);
  }
  assert.equal(bot.allIn,true);
  assert.ok(f.command(f.sockets[0],'kick',{target:bot.id}).ok);
  assert.ok(g.players.includes(bot));
  assert.equal(bot.folded,false);
  while(E.betting(g))assert.ok(f.manager.act(f.room,g.players[g.currentPlayerIndex].id,'call').ok);
  if(g.phase==='runout_vote')f.manager.finishVote(f.room,false,'测试');
  assert.equal(g.pot,0);
  f.room.blockedUntil=0;
  if(f.room.runoutHistory)f.room.runoutHistory.startedAt-=10_000;
  f.manager.publish(f.room);
  assert.equal(g.players.includes(bot),false);
  assert.equal(g.bankLog.some(entry=>entry.seatId===bot.id),false);
  f.manager.check(f.room);
});

test('an authenticated host may leave mid-hand and reclaim the unchanged stack without reopening the folded hand',t=>{
  const f=fixture(t,3),host=f.sockets[0];
  const profile={uid:'owner',name:'Host',avatar:'default'};
  f.manager.accounts={byUid:new Map([[profile.uid,profile]])};
  host.uid=profile.uid;
  Object.assign(f.room.people.get(0),profile);
  f.start();
  const game=f.room.game,seat=game.players[0],chips=seat.chips;
  f.manager.leave(host,true);
  assert.equal(f.manager.games.get(f.room.code),f.room);
  assert.equal(seat.folded,true);
  const returned=f.join({uid:profile.uid});
  assert.equal(returned.seatId,0);
  assert.equal(seat.chips,chips);
  assert.equal(seat.waitingForHand,true);
  assert.equal(seat.folded,true);
  f.manager.check(f.room);
});
test('transient disconnection retains both host and guest seats; token resumes same cards and balance',t=>{
  const f=fixture(t);f.start();const g=f.room.game,before=JSON.stringify(g.players[1].holeCards),token=f.sockets[1].messages.find(m=>m.type==='joined').resumeToken;
  f.manager.leave(f.sockets[1]);assert.equal(g.players[1].disconnected,undefined);assert.equal(f.room.people.get(1).connected,false);
  const resumed=f.join({resumeToken:token});assert.equal(resumed.seatId,1);assert.equal(JSON.stringify(g.players[1].holeCards),before);assert.equal(g.players[1].connected,true);
  f.manager.leave(f.sockets[0]);assert.ok(f.manager.games.has(f.room.code));
});
test('server enforces presentation duration and correct acting seat even with forged browser state',t=>{
  const f=fixture(t,4,{deal:2000});f.start();const g=f.room.game,p=g.players[g.currentPlayerIndex];
  assert.match(f.command(f.sockets[p.id],'action',{action:'call',handNumber:g.handNumber,revision:g.revision}).message,/过场/);
  f.room.blockedUntil=0;
  const other=f.sockets.find(ws=>ws.seatId!==p.id);assert.match(f.command(other,'action',{seatId:p.id,action:'allin',handNumber:g.handNumber,revision:g.revision}).message,/尚未轮到/);
  assert.match(f.command(other,'state',{game:{phase:'hand_over'}}).message,/不能修改/);
});
test('timeout automatically folds or checks; host browser is not required to progress a hand',t=>{
  const f=fixture(t,3);f.start();f.manager.leave(f.sockets[0]);let steps=0;
  while(E.betting(f.room.game)){assert.ok(++steps<60);f.room.deadline=0;f.manager.tick();}
  assert.ok(f.room.history.some(e=>e.automatic));f.manager.check(f.room);
});
test('all online people must confirm next hand; recovered player is required to confirm again',t=>{
  const f=fixture(t,3);f.start();const g=f.room.game;
  while(E.betting(g)){const p=g.players[g.currentPlayerIndex];f.command(f.sockets[p.id],'action',{action:'fold',handNumber:g.handNumber,revision:g.revision});}
  f.command(f.sockets[0],'handReady',{handNumber:1});f.command(f.sockets[1],'handReady',{handNumber:1});assert.equal(g.handNumber,1);
  f.command(f.sockets[2],'handReady',{handNumber:1});assert.equal(g.handNumber,2);
});
test('duplicate command does not repeat a loan; history is paged and contains public events only',t=>{
  const f=fixture(t);f.room.settings.allowBuyIn=true;f.start();const g=f.room.game;
  while(E.betting(g)){const p=g.players[g.currentPlayerIndex];f.command(f.sockets[p.id],'action',{action:'fold',handNumber:g.handNumber,revision:g.revision});}
  const data={kind:'borrow',amount:700,handNumber:g.handNumber,bankVersion:g.players[1].bankVersion,requestId:'loan-once',commandSeq:100};
  assert.ok(f.command(f.sockets[1],'bank',data).ok);assert.ok(f.command(f.sockets[1],'bank',data).duplicate);assert.equal(g.players[1].bankDebt,700);
  for(let i=0;i<80;i++)f.manager.event(f.room,'chat','message '+i,{name:'P1'});
  f.manager.handle(f.sockets[1],{type:'history',afterEvent:0});const page=f.sockets[1].messages.at(-1);assert.equal(page.events.length,25);assert.equal(page.hasMore,true);assert.ok(!JSON.stringify(page).includes('holeCards'));f.manager.check(f.room);
});
test('street changes clear every action marker including the closing actor, while history retains all actions',t=>{
  const f=fixture(t,4);f.room.settings.blindMode='standard';f.room.settings.allowBuyIn=true;f.start();const g=f.room.game;
  // Keep one folded player to check skipped seats are cleared as well.
  let folded=false,steps=0,transitions=0;
  while(E.betting(g)){
    assert.ok(++steps<30);const actor=g.players[g.currentPlayerIndex],phase=g.phase,previous=f.room.history.filter(e=>e.kind==='action').length;
    const action=!folded?'fold':actor.currentBet<g.currentBet?'call':'check';folded=true;
    assert.ok(f.command(f.sockets[actor.id],'action',{action,handNumber:g.handNumber,revision:g.revision}).ok);
    const history=f.room.history.filter(e=>e.kind==='action');assert.equal(history.length,previous+1);assert.equal(history.at(-1).street,phase);
    if(g.phase!==phase){
      transitions++;assert.ok(g.players.every(p=>p.lastAction===null));
      for(const ws of f.sockets)assert.ok(f.latest(ws).game.players.every(p=>p.lastAction===null));
    }else assert.equal(actor.lastAction.label,history.at(-1).label);
  }
  assert.equal(transitions,4);assert.equal(g.phase,'hand_over');assert.equal(f.room.history.filter(e=>e.kind==='action').length,steps);f.manager.check(f.room);
  for(const ws of f.sockets)f.command(ws,'handReady',{handNumber:1});assert.equal(g.handNumber,2);assert.ok(g.players.every(p=>p.lastAction===null));
});

test('uncontested winner stays private until owner opts in; stale, forged and mid-hand reveals fail',t=>{
  const f=fixture(t,3);f.room.settings.allowBuyIn=true;f.start();const g=f.room.game;
  assert.equal(f.command(f.sockets[0],'showFolded',{handNumber:1}).ok,false);
  while(E.betting(g)){const p=g.players[g.currentPlayerIndex];assert.ok(f.command(f.sockets[p.id],'action',{action:'fold',handNumber:1,revision:g.revision}).ok);}
  const winner=g.players.find(p=>g.winners.includes(p.id)),others=f.sockets.filter(ws=>ws.seatId!==winner.id),owner=f.sockets[winner.id];
  assert.equal(g.showdownOccurred,false);assert.equal(f.latest(owner).game.players.find(p=>p.id===winner.id).holeCards.length,2);
  for(const ws of others)assert.equal(f.latest(ws).game.players.find(p=>p.id===winner.id).holeCards.length,0);
  assert.equal(f.command(owner,'showFolded',{handNumber:0}).ok,false);
  // Supplied seat IDs cannot grant permission to somebody else's cards.
  f.command(others[0],'showFolded',{seatId:winner.id,handNumber:1});assert.equal(winner.showFolded,false);
  assert.ok(f.command(owner,'showFolded',{handNumber:1}).ok);
  for(const ws of others)assert.equal(f.latest(ws).game.players.find(p=>p.id===winner.id).holeCards.length,2);
  assert.ok(f.command(owner,'showFolded',{handNumber:1}).ok);
  for(const ws of others)assert.equal(f.latest(ws).game.players.find(p=>p.id===winner.id).holeCards.length,0);
  const token=owner.messages.find(m=>m.type==='joined').resumeToken;f.manager.leave(owner);const resumed=f.join({resumeToken:token});
  assert.equal(f.latest(resumed).game.players.find(p=>p.id===winner.id).holeCards.length,2);
  for(const ws of [...others,resumed])f.command(ws,'handReady',{handNumber:1});
  assert.equal(g.handNumber,2);assert.ok(g.players.every(p=>!p.showFolded));
  assert.equal(f.command(resumed,'showFolded',{handNumber:1}).ok,false);
});

test('contested showdown still reveals all live hands and keeps folded hands private',t=>{
  const f=fixture(t,3);f.room.settings.allowBuyIn=true;f.start();const g=f.room.game;
  let folded=false;while(E.betting(g)){const p=g.players[g.currentPlayerIndex],action=!folded?'fold':p.currentBet<g.currentBet?'call':'check';folded=true;assert.ok(f.command(f.sockets[p.id],'action',{action,handNumber:1,revision:g.revision}).ok);}
  assert.equal(g.showdownOccurred,true);
  for(const ws of f.sockets)for(const p of f.latest(ws).game.players)assert.equal(p.holeCards.length,p.id===ws.seatId||!p.folded?2:0);
  const live=g.players.find(p=>!p.folded);assert.equal(f.command(f.sockets[live.id],'showFolded',{handNumber:1}).ok,false);
});

test('win-rate visibility is a host-only pregame boolean rule preserved in all game snapshots',t=>{
  const f=fixture(t,3);assert.equal(f.room.settings.showWinRate,true);const settings={...f.room.settings,showWinRate:false};
  assert.equal(f.command(f.sockets[1],'roomSettings',{settings}).ok,false);
  for(const value of ['false',0,null])assert.equal(f.command(f.sockets[0],'roomSettings',{settings:{...settings,showWinRate:value}}).ok,false);
  assert.ok(f.command(f.sockets[0],'roomSettings',{settings}).ok);f.start();assert.equal(f.room.game.showWinRate,false);
  for(const ws of f.sockets)assert.equal(f.latest(ws).game.showWinRate,false);
  assert.equal(f.command(f.sockets[0],'roomSettings',{settings:{...settings,showWinRate:true}}).ok,false);
});

test('invalid action cursor is repaired, and accounting anomaly pauses the room visibly',t=>{
  const f=fixture(t,3);f.start();f.room.game.currentPlayerIndex=-1;f.manager.tick();assert.ok(f.room.game.currentPlayerIndex>=0);
  f.room.game.players[0].chips++;f.command(f.sockets[0],'chat',{text:'invariant check'});assert.equal(f.room.paused,true);assert.ok(f.latest(f.sockets[0]).paused);
});
