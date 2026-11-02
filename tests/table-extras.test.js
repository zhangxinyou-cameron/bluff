const {test}=require('node:test');const assert=require('node:assert/strict');
const E=require('../public/poker-engine');const {RoomManager}=require('../room-manager');
function table(t,n=3){
  const m=new RoomManager(new Map());m.configureTimings({deal:0,action:0,street:0,runout:0,ai:0,vote:1000});t.after(()=>m.dispose());const sockets=[];
  const join=(extra={})=>{const ws={readyState:1,messages:[],send(s){this.messages.push(JSON.parse(s));},close(){this.readyState=3;}};m.handle(ws,{type:'joinRoom',roomCode:'345678',seatId:sockets.length?-1:0,name:'P'+sockets.length,clientId:'browser-identity-'+sockets.length,...extra});sockets.push(ws);return ws;};
  for(let i=0;i<n;i++)join();const r=m.games.get('345678');
  const command=(ws,type,data={})=>{const p=r.people.get(ws.seatId);m.handle(ws,{type,requestId:'r-'+ws.seatId+'-'+(p.commandSeq+1),commandSeq:p.commandSeq+1,...data});return ws.messages.filter(x=>x.type==='ack').at(-1);};
  const start=()=>{for(const s of sockets.slice(1))command(s,'ready');assert.ok(command(sockets[0],'startGame').ok);};
  const act=(action='fold')=>{const g=r.game;return command(sockets[g.players[g.currentPlayerIndex].id],'action',{action,handNumber:g.handNumber,revision:g.revision});};
  const latest=ws=>ws.messages.filter(x=>x.type==='snapshot').at(-1);
  return{m,r,sockets,join,command,start,act,latest};
}
test('temporary leave restores the seat; kick stops automatic resume but a one-time credential permits manual rejoin',t=>{
  const f=table(t),guest=f.sockets[1],token=guest.messages.find(x=>x.type==='joined').resumeToken;
  f.m.handle(guest,{type:'leaveRoom'});assert.equal(f.r.people.get(1).retired,false);
  const restored=f.join({resumeToken:token,clientId:'browser-identity-1'});assert.equal(restored.seatId,1);
  assert.equal(f.command(f.sockets[2],'kick',{target:1}).ok,false);assert.equal(f.command(f.sockets[0],'kick',{target:0}).ok,false);
  assert.equal(f.command(f.sockets[0],'kick',{target:1}).ok,true);assert.equal(restored.messages.at(-1).type,'kicked');
  const kicked=restored.messages.at(-1);assert.ok(kicked.rejoinToken);assert.notEqual(kicked.rejoinToken,token);
  const rejected=f.join({resumeToken:token,clientId:'browser-identity-1'});assert.equal(rejected.seatId,undefined);assert.equal(rejected.messages.at(-1).type,'kicked');assert.equal(rejected.messages.at(-1).rejoinToken,kicked.rejoinToken);
  const rejoined=f.join({rejoinToken:kicked.rejoinToken,clientId:'browser-identity-1'});assert.equal(rejoined.seatId,1);assert.equal(f.r.people.get(1).kicked,false);assert.equal(f.r.people.get(1).retired,false);
  const freshToken=rejoined.messages.find(x=>x.type==='joined').resumeToken;assert.notEqual(freshToken,token);assert.notEqual(freshToken,kicked.rejoinToken);
  const replay=f.join({rejoinToken:kicked.rejoinToken});assert.equal(replay.seatId,undefined);assert.equal(replay.messages.at(-1).type,'error');
  const old=f.join({resumeToken:token});assert.equal(old.seatId,undefined);assert.equal(old.messages.at(-1).type,'error');
  const seq=f.r.people.get(1).commandSeq,history=f.r.history.length;
  f.m.handle(restored,{type:'chat',requestId:'old-socket',commandSeq:seq+1,text:'should not send'});assert.equal(f.r.history.length,history);assert.equal(f.r.people.get(1).commandSeq,seq);
  assert.ok(f.command(f.sockets[0],'kick',{target:1}).ok);const secondToken=rejoined.messages.at(-1).rejoinToken;assert.notEqual(secondToken,kicked.rejoinToken);
  assert.equal(f.join({rejoinToken:secondToken}).seatId,1);
});

test('kicked player rejoining mid-hand keeps seat, debt and chips without reviving folded cards, then plays the next hand',t=>{
  const f=table(t,4);f.r.settings.allowBuyIn=true;f.start();const g=f.r.game;
  while(E.betting(g))f.act('fold');
  assert.ok(f.command(f.sockets[1],'bank',{kind:'borrow',amount:700,handNumber:g.handNumber,bankVersion:g.players[1].bankVersion}).ok);
  for(const ws of f.sockets)f.command(ws,'handReady',{handNumber:1});assert.equal(g.handNumber,2);
  const p=g.players[1],balances=[p.chips,p.bankDebt,p.totalBet],cards=JSON.stringify(p.holeCards),initial=g.initialTotal;
  assert.ok(f.command(f.sockets[0],'kick',{target:1}).ok);const rejoinToken=f.sockets[1].messages.at(-1).rejoinToken;
  assert.equal(p.folded,true);const rejoined=f.join({rejoinToken});assert.equal(rejoined.seatId,1);f.sockets[1]=rejoined;f.sockets.pop();
  assert.deepEqual([p.chips,p.bankDebt,p.totalBet],balances);assert.equal(JSON.stringify(p.holeCards),cards);assert.equal(p.folded,true);assert.equal(p.disconnected,false);assert.equal(p.connected,true);assert.equal(g.initialTotal,initial);
  assert.equal(f.command(rejoined,'action',{action:'call',handNumber:g.handNumber,revision:g.revision}).ok,false);
  while(E.betting(g))f.act('fold');for(const ws of f.sockets)f.command(ws,'handReady',{handNumber:2});
  assert.equal(g.handNumber,3);assert.equal(p.folded,false);assert.equal(p.isActive,true);assert.equal(p.holeCards.length,2);f.m.check(f.r);
});

test('a guest kicked before start may return to their retained slot after start and enter only the next hand',t=>{
  const f=table(t,4);f.r.settings.allowBuyIn=true;assert.ok(f.command(f.sockets[0],'kick',{target:1}).ok);const rejoinToken=f.sockets[1].messages.at(-1).rejoinToken;
  for(const ws of[f.sockets[2],f.sockets[3]])f.command(ws,'ready');assert.ok(f.command(f.sockets[0],'startGame').ok);const g=f.r.game;
  const actor=g.players[g.currentPlayerIndex].id,button=g.players[g.dealerIndex].id,initial=g.initialTotal,deck=JSON.stringify(g.deck);
  const rejoined=f.join({rejoinToken});f.sockets[1]=rejoined;f.sockets.pop();const p=g.players.find(p=>p.id===1);
  assert.equal(rejoined.seatId,1);assert.equal(g.players.length,4);assert.equal(p.isActive,false);assert.equal(p.folded,true);assert.equal(p.holeCards.length,0);assert.equal(g.initialTotal,initial+f.r.settings.initChips);
  assert.equal(g.players[g.currentPlayerIndex].id,actor);assert.equal(g.players[g.dealerIndex].id,button);assert.equal(JSON.stringify(g.deck),deck);f.m.check(f.r);
  while(E.betting(g))f.act('fold');for(const ws of f.sockets)f.command(ws,'handReady',{handNumber:1});assert.equal(g.handNumber,2);assert.equal(p.holeCards.length,2);assert.equal(p.isActive,true);f.m.check(f.r);
});

test('kicking an all-in player preserves their live pot claim and manual rejoin keeps the settled account',t=>{
  const f=table(t,3);f.r.settings.allowBuyIn=true;f.start();const g=f.r.game;f.act('fold');f.act('allin');f.act('call');assert.equal(g.phase,'runout_vote');
  const reference=structuredClone(g);E.resolveRunout(reference,false);
  const target=g.runoutVote.eligibleIds.find(id=>id!==0);assert.ok(f.command(f.sockets[0],'kick',{target}).ok);assert.equal(g.phase,'hand_over');
  const p=g.players.find(p=>p.id===target),settled=p.chips;assert.equal(p.folded,false);assert.deepEqual(g.players.map(p=>p.chips),reference.players.map(p=>p.chips));assert.deepEqual(g.pots,reference.pots);f.m.check(f.r);
  const ws=f.join({rejoinToken:f.sockets[target].messages.at(-1).rejoinToken});assert.equal(ws.seatId,target);assert.equal(p.chips,settled);f.m.check(f.r);
});

test('avatars are allowlisted, synchronized to lobby and game, and restored without trusting a new join avatar',t=>{
  const f=table(t,3);assert.equal(f.command(f.sockets[1],'avatar',{avatar:'<script>'}).ok,false);assert.equal(f.r.people.get(1).avatar,'default');
  assert.ok(f.command(f.sockets[1],'avatar',{avatar:'fox'}).ok);let snap=f.latest(f.sockets[0]);assert.equal(snap.seats[1].avatar,'fox');assert.equal(snap.roster.find(p=>p.id===1).avatar,'fox');
  f.start();assert.equal(f.latest(f.sockets[2]).game.players[1].avatar,'fox');assert.ok(f.command(f.sockets[1],'avatar',{avatar:'panda'}).ok);assert.equal(f.latest(f.sockets[0]).game.players[1].avatar,'panda');
  const token=f.sockets[1].messages.find(x=>x.type==='joined').resumeToken;f.m.leave(f.sockets[1]);const resumed=f.join({resumeToken:token,avatar:'lion'});
  assert.equal(f.latest(resumed).game.players[1].avatar,'panda');assert.equal(f.r.people.get(1).avatar,'panda');
  const fresh=table(t,1);const newcomer=fresh.join({avatar:'rabbit'});assert.equal(fresh.r.people.get(newcomer.seatId).avatar,'rabbit');
});
test('manual deck mode supports 8-player short deck, rejects mid-hand changes and resets confirmations between hands',t=>{
  const f=table(t,8);assert.ok(f.command(f.sockets[0],'deckMode',{mode:'short'}).ok);f.start();assert.equal(f.r.game.variant,'short');
  assert.equal(f.command(f.sockets[1],'deckMode',{mode:'standard'}).ok,false);assert.equal(f.command(f.sockets[0],'deckMode',{mode:'standard'}).ok,false);
  while(E.betting(f.r.game))f.act();assert.equal(f.r.game.phase,'hand_over');f.r.game.nextHandReady=[0,1];
  assert.ok(f.command(f.sockets[0],'deckMode',{mode:'standard'}).ok);assert.deepEqual(f.r.game.nextHandReady,[]);
  for(const ws of f.sockets)f.command(ws,'handReady',{handNumber:1});assert.equal(f.r.game.variant,'standard');assert.equal(f.r.game.handNumber,2);
});
test('social phrases and gifts are validated, rate limited and never change balances',t=>{
  const f=table(t);f.start();const before=f.r.game.players.map(p=>p.chips);
  assert.equal(f.command(f.sockets[1],'phrase',{phraseId:'forged'}).ok,false);
  assert.ok(f.command(f.sockets[1],'phrase',{phraseId:'hurry'}).ok);assert.match(f.r.history.at(-1).text,/花儿都谢了/);
  assert.equal(f.command(f.sockets[1],'gift',{target:0,giftId:'tomato'}).ok,false);f.r.people.get(1).socialAt=0;
  assert.ok(f.command(f.sockets[1],'gift',{target:0,giftId:'tomato'}).ok);assert.equal(f.r.history.at(-1).to,0);assert.deepEqual(f.r.game.players.map(p=>p.chips),before);
});
test('peek requires a folded requester and owner consent; only that viewer receives cards; tips settle once after the hand',t=>{
  const f=table(t);f.r.settings.allowBuyIn=true;f.start();const g=f.r.game;
  assert.equal(f.command(f.sockets[1],'peekRequest',{target:0,tip:25,handNumber:1}).ok,false);
  assert.ok(f.act('fold').ok);const before=g.players.map(p=>p.chips);
  assert.ok(f.command(f.sockets[1],'peekRequest',{target:0,tip:25,handNumber:1}).ok);const request=g.peekRequests[0];
  assert.equal(f.latest(f.sockets[2]).peekRequests.length,0);assert.equal(f.command(f.sockets[2],'peekReply',{peekId:request.id,accept:true}).ok,false);
  assert.ok(f.command(f.sockets[0],'peekReply',{peekId:request.id,accept:true}).ok);
  assert.deepEqual(g.players.map(p=>p.chips),before);assert.equal(f.latest(f.sockets[1]).game.players[0].holeCards.length,2);assert.equal(f.latest(f.sockets[2]).game.players[0].holeCards.length,0);
  assert.equal(f.command(f.sockets[0],'peekReply',{peekId:request.id,accept:true}).ok,false);
  const payer=before[1];while(E.betting(g))f.act('fold');assert.equal(g.players[1].chips,payer-25);assert.equal(g.tips[0].paid,true);f.m.check(f.r);
  assert.ok(!JSON.stringify(f.r.history).includes('holeCards'));
  for(const ws of f.sockets)f.command(ws,'handReady',{handNumber:1});assert.deepEqual(g.privateReveals,{});assert.deepEqual(g.peekRequests,[]);
});
test('zero-chip spectators in both modes can request private cards with consent, but active all-ins cannot',t=>{
  for(const allowBuyIn of [false,true]){
    const f=table(t,4);f.r.settings.minPlayers=1;
    const g=E.createGame(Array.from({length:4},(_,id)=>({id,name:'P'+id,chips:id===3?0:2000,connected:true})),20,{allowBuyIn});
    f.r.game=g;E.startHand(g);f.m.publish(f.r);const spectator=g.players[3];
    assert.equal(spectator.isActive,false);assert.equal(spectator.folded,false);assert.equal(spectator.holeCards.length,0);
    assert.ok(f.command(f.sockets[3],'peekRequest',{target:0,tip:0,handNumber:1}).ok);const req=g.peekRequests[0];
    assert.equal(f.latest(f.sockets[3]).game.players[0].holeCards.length,0);
    assert.ok(f.command(f.sockets[0],'peekReply',{peekId:req.id,accept:true}).ok);
    assert.equal(f.latest(f.sockets[3]).game.players[0].holeCards.length,2);assert.equal(f.latest(f.sockets[1]).game.players[0].holeCards.length,0);
    assert.equal(g.tips.length,0);f.m.check(f.r);
    assert.equal(f.command(f.sockets[3],'peekRequest',{target:1,tip:1,handNumber:1}).ok,false);
    assert.equal(f.command(f.sockets[1],'peekRequest',{target:0,tip:0,handNumber:1}).ok,false);
  }
  assert.equal(E.canRequestPeek({isActive:true,chips:0,allIn:true,folded:false,holeCards:[{},{}]}),false);
  assert.equal(E.canRequestPeek({isActive:false,chips:0,disconnected:true}),false);
  assert.equal(E.canRequestPeek({isActive:false,chips:2000,folded:false,holeCards:[]}),false);
});

test('peek refusal, expiry and overlapping tip offers never debit chips',t=>{
  const f=table(t,4);f.start();const g=f.r.game;f.act('fold');const before=g.players[1].chips;
  f.command(f.sockets[1],'peekRequest',{target:0,tip:1500,handNumber:1});f.command(f.sockets[1],'peekRequest',{target:2,tip:1000,handNumber:1});
  assert.ok(f.command(f.sockets[0],'peekReply',{peekId:g.peekRequests[0].id,accept:true}).ok);
  assert.equal(f.command(f.sockets[2],'peekReply',{peekId:g.peekRequests[1].id,accept:true}).ok,false);
  assert.ok(f.command(f.sockets[2],'peekReply',{peekId:g.peekRequests[1].id,accept:false}).ok);assert.equal(g.players[1].chips,before);
  f.command(f.sockets[1],'peekRequest',{target:3,tip:0,handNumber:1});g.peekRequests.at(-1).expiresAt=0;
  assert.equal(f.command(f.sockets[3],'peekReply',{peekId:g.peekRequests.at(-1).id,accept:true}).ok,false);assert.equal(g.players[1].chips,before);
});

test('peek expires at exactly ten seconds in both replies and watchdog without a tip or reveal',t=>{
  let now=100000;t.mock.method(Date,'now',()=>now);const f=table(t,4);f.start();const g=f.r.game;f.act('fold');const balances=g.players.map(p=>p.chips);
  for(const target of[0,2])assert.ok(f.command(f.sockets[1],'peekRequest',{target,tip:25,handNumber:1}).ok);
  for(const request of g.peekRequests)assert.equal(request.expiresAt,110000);
  now=109999;f.m.tick();assert.ok(g.peekRequests.every(r=>r.status==='pending'));
  now=110000;assert.equal(f.command(f.sockets[0],'peekReply',{peekId:g.peekRequests[0].id,accept:true}).ok,false);assert.equal(g.peekRequests[0].status,'expired');
  f.m.tick();assert.ok(g.peekRequests.every(r=>r.status==='expired'));assert.deepEqual(g.players.map(p=>p.chips),balances);assert.deepEqual(g.privateReveals,{});assert.deepEqual(g.tips,[]);
});
test('run twice waits for every eligible player; decline/timeout resolve once; spectator cannot vote',t=>{
  for(const decision of['yes','no','timeout']){
    const f=table(t,3);f.r.settings.allowBuyIn=true;f.start();const g=f.r.game;f.act('fold');f.act('allin');f.act('call');
    assert.equal(g.phase,'runout_vote');assert.equal(g.communityCards.length,0);
    assert.equal(f.command(f.sockets[1],'runoutVote',{twice:true,handNumber:1}).ok,false);
    assert.ok(f.command(f.sockets[0],'runoutVote',{twice:true,handNumber:1}).ok);assert.equal(g.phase,'runout_vote');
    if(decision==='timeout'){g.runoutVote.expiresAt=Date.now()-1;f.m.tick();}
    else assert.ok(f.command(f.sockets[2],'runoutVote',{twice:decision==='yes',handNumber:1}).ok);
    assert.equal(g.phase,'hand_over');assert.equal(g.runoutBoards?.length||1,decision==='yes'?2:1);f.m.check(f.r);
    const after=g.players.map(p=>p.chips);assert.equal(f.command(f.sockets[2],'runoutVote',{twice:true,handNumber:1}).ok,false);assert.deepEqual(g.players.map(p=>p.chips),after);
  }
});
test('requesting session end during a runout vote keeps the pot until normal settlement',t=>{
  const f=table(t,2);f.r.settings.allowBuyIn=true;f.start();const g=f.r.game;f.act('allin');f.act('call');
  assert.equal(g.phase,'runout_vote');assert.ok(f.command(f.sockets[0],'endSession').ok);assert.equal(g.phase,'runout_vote');assert.ok(g.pot>0);
  f.command(f.sockets[0],'runoutVote',{twice:false,handNumber:1});assert.equal(g.phase,'tournament_over');assert.equal(g.pot,0);f.m.check(f.r);
});
test('700 all-in double-board hands across 2–8 players preserve card uniqueness and side-pot accounting',()=>{
  let seed=4444;const random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296);
  for(let n=2;n<=8;n++)for(let i=0;i<100;i++){
    const g=E.createGame(Array.from({length:n},(_,id)=>({id,chips:100+id*31})),20,{allowBuyIn:true,autoDeck:true,runTwiceEnabled:true});E.startHand(g,random);
    let steps=0;while(E.betting(g)){assert.ok(++steps<40);const p=g.players[g.currentPlayerIndex];assert.ok(E.applyAction(g,p.id,E.canRaise(g,p)?'allin':p.currentBet<g.currentBet?'call':'check').ok);}
    assert.equal(g.phase,'runout_vote');assert.ok(E.resolveRunout(g,true));assert.equal(g.phase,'hand_over');assert.equal(g.players.reduce((s,p)=>s+p.chips,0),g.initialTotal);
    const cards=[...g.players.flatMap(p=>p.holeCards),...g.runoutBoards.flat()];assert.equal(new Set(cards.map(c=>c.id)).size,cards.length);
    for(const pot of g.pots){assert.equal(pot.boards.reduce((s,b)=>s+b.amount,0),pot.amount);assert.equal(pot.awards.reduce((s,a)=>s+a.amount,0),pot.amount);}
  }
});
test('two boards keep an exposed flop, draw distinct remaining cards, and split odd pot chips deterministically',()=>{
  const g=E.createGame([{id:0,chips:101},{id:1,chips:101},{id:2,chips:101}],20,{allowBuyIn:true,runTwiceEnabled:true});E.startHand(g,()=>.5);
  while(g.phase==='pre_flop'){const p=g.players[g.currentPlayerIndex];E.applyAction(g,p.id,p.currentBet<g.currentBet?'call':'check');}
  const prefix=[...g.communityCards];let steps=0;while(E.betting(g)){assert.ok(++steps<20);const p=g.players[g.currentPlayerIndex];E.applyAction(g,p.id,E.canRaise(g,p)?'allin':p.currentBet<g.currentBet?'call':'check');}
  assert.equal(g.phase,'runout_vote');E.resolveRunout(g,true);
  for(const board of g.runoutBoards)assert.deepEqual(board.slice(0,3),prefix);
  const drawn=g.runoutBoards.flatMap(b=>b.slice(3));assert.equal(new Set(drawn.map(c=>c.id)).size,4);
  assert.equal(g.pots[0].amount,303);assert.deepEqual(g.pots[0].boards.map(b=>b.amount),[152,151]);assert.equal(g.players.reduce((s,p)=>s+p.chips,0),303);
});
test('an offline spectator does not cancel the all-in players vote; an offline contender does',t=>{
  const f=table(t);f.r.settings.allowBuyIn=true;f.start();f.act('fold');f.act('allin');f.act('call');
  assert.equal(f.r.game.phase,'runout_vote');f.m.leave(f.sockets[1]);assert.equal(f.r.game.phase,'runout_vote');f.m.leave(f.sockets[0]);assert.equal(f.r.game.phase,'hand_over');f.m.check(f.r);
});
test('watchdog repair initializes the negotiation deadline before sending a recovered state',t=>{
  const f=table(t);f.start();const g=f.r.game;for(const p of g.players)Object.assign(p,{chips:0,currentBet:2000,totalBet:2000,allIn:true,acted:true});g.pot=6000;g.currentBet=2000;g.currentPlayerIndex=-1;
  f.m.tick();assert.equal(g.phase,'runout_vote');assert.ok(g.runoutVote.expiresAt>Date.now());f.m.check(f.r);
});
test('blind-mode changes are host-only, rejected mid-hand, and reset everyone confirmation for the next hand',t=>{
  const f=table(t,4);assert.equal(f.command(f.sockets[1],'blindMode',{mode:'position'}).ok,false);assert.equal(f.command(f.sockets[0],'blindMode',{mode:'invalid'}).ok,false);
  f.start();assert.equal(f.r.game.blindRule,'ante');assert.equal(f.command(f.sockets[0],'blindMode',{mode:'position'}).ok,false);
  while(E.betting(f.r.game))f.act('fold');f.command(f.sockets[0],'handReady',{handNumber:1});assert.deepEqual(f.r.game.nextHandReady,[0]);
  assert.ok(f.command(f.sockets[0],'blindMode',{mode:'position'}).ok);assert.deepEqual(f.r.game.nextHandReady,[]);assert.equal(f.latest(f.sockets[2]).settings.blindMode,'position');assert.equal(f.r.game.blindRule,'ante','current hand rule remains fixed');
  for(const ws of f.sockets)f.command(ws,'handReady',{handNumber:1});assert.equal(f.r.game.blindRule,'position');assert.equal(f.r.game.pot,30);f.m.check(f.r);
});
