const{test}=require('node:test');const assert=require('node:assert/strict');const E=require('../public/poker-engine');
const players=n=>Array.from({length:n},(_,id)=>({id,chips:2000,connected:true}));
test('custom position rule charges first seat after dealer 1x, second seat half, and nobody else',()=>{
  for(const deckMode of['short','standard'])for(let n=3;n<=8;n++){
    const g=E.createGame(players(n),20,{deckMode,blindMode:'position'});E.startHand(g);assert.equal(g.pot,30);assert.equal(g.blindRule,'position');assert.deepEqual(g.blindSeats,{full:1,half:2});
    for(const p of g.players)assert.equal(p.totalBet,p.id===1?20:p.id===2?10:0);
    assert.equal(g.players[g.currentPlayerIndex].id,2,'action starts after the full blind, keeping its option');
  }
});
test('heads-up dealer is half blind, opponent is full blind, and positions alternate',()=>{
  const g=E.createGame(players(2),20,{deckMode:'short',blindMode:'position'});const full=[];
  for(let hand=1;hand<=4;hand++){
    assert.ok(E.startHand(g));const dealer=g.players[g.dealerIndex];assert.equal(g.blindSeats.half,dealer.id);assert.equal(g.players[g.currentPlayerIndex].id,dealer.id);full.push(g.blindSeats.full);
    while(E.betting(g)){const p=g.players[g.currentPlayerIndex];E.applyAction(g,p.id,'fold');}for(const p of E.confirmationPlayers(g))E.confirmNextHand(g,p.id,g.handNumber);
  }
  assert.deepEqual(full,[1,0,1,0]);
});
test('sparse, offline and unfunded seats are skipped; every active player rotates through both blinds',()=>{
  const g=E.createGame([{id:0,chips:2000},{id:1,chips:2000,connected:false},{id:3,chips:2000},{id:5,chips:0},{id:7,chips:2000}],20,{deckMode:'standard',blindMode:'position'});const full=[],half=[];
  for(let i=0;i<3;i++){assert.ok(E.startHand(g));full.push(g.blindSeats.full);half.push(g.blindSeats.half);while(E.betting(g)){const p=g.players[g.currentPlayerIndex];E.applyAction(g,p.id,'fold');}for(const p of E.confirmationPlayers(g))E.confirmNextHand(g,p.id,g.handNumber);}
  assert.deepEqual(full,[3,7,0]);assert.deepEqual(half,[7,0,3]);
});
test('all-player antes can also be selected for a standard deck without changing hand rankings',()=>{
  const g=E.createGame(players(5),20,{deckMode:'standard',blindMode:'ante'});E.startHand(g);assert.equal(g.variant,'standard');assert.equal(g.pot,120);assert.equal(g.blindSeats,null);assert.equal(g.players[g.dealerIndex].totalBet,40);
});
test('short stacks only post what they have, with valid main and side pots',()=>{
  const g=E.createGame([{id:0,chips:100},{id:1,chips:7},{id:2,chips:4}],20,{deckMode:'short',blindMode:'position'});E.startHand(g);assert.equal(g.pot,11);assert.equal(g.players[1].totalBet,7);assert.equal(g.players[2].totalBet,4);
  let steps=0;while(E.betting(g)){assert.ok(++steps<30);const p=g.players[g.currentPlayerIndex];assert.ok(E.applyAction(g,p.id,p.currentBet<g.currentBet?'call':'check').ok);}assert.equal(g.players.reduce((s,p)=>s+p.chips,0),111);
});
test('420 seeded hands across all blind modes, both deck types and 2–8 players conserve every chip',()=>{
  let seed=998;const random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296);
  for(let n=2;n<=8;n++)for(const deckMode of['short','standard'])for(const blindMode of['auto','ante','position'])for(let hand=0;hand<10;hand++){
    const g=E.createGame(players(n),20,{deckMode,blindMode});E.startHand(g,random);let steps=0;
    while(E.betting(g)){assert.ok(++steps<120);const p=g.players[g.currentPlayerIndex],r=random();const action=r<.08?'fold':r>.94&&E.canRaise(g,p)?'allin':p.currentBet<g.currentBet?'call':'check';assert.ok(E.applyAction(g,p.id,action).ok);}
    assert.equal(g.players.reduce((s,p)=>s+p.chips,0),n*2000);assert.equal(g.pot,0);
  }
});
test('standard six-max and full-ring position names follow the requested order, with no LJ in six-max',()=>{
  for(const [n,expected]of[[6,['UTG','HJ','CO','BTN','SB','BB']],[8,['UTG','UTG+1','LJ','HJ','CO','BTN','SB','BB']],[9,['UTG','UTG+1','UTG+2','LJ','HJ','CO','BTN','SB','BB']]]){
    const g=E.createGame(players(n),20,{deckMode:'short',blindMode:'standard'});E.startHand(g);assert.deepEqual(g.actionOrder.preflop.map(id=>g.positions[id].label),expected);assert.equal(g.positions[g.players[g.currentPlayerIndex].id].label,'UTG');
    assert.equal(g.players.find(p=>g.positions[p.id].label==='SB').totalBet,10);assert.equal(g.players.find(p=>g.positions[p.id].label==='BB').totalBet,20);
  }
});
test('position labels remain fixed through a hand and are reassigned after the button moves',()=>{
  const g=E.createGame(players(6),20,{blindMode:'standard'});E.startHand(g);const before=JSON.stringify(g.positions);const first=g.players[g.currentPlayerIndex];E.applyAction(g,first.id,'fold');assert.equal(JSON.stringify(g.positions),before);
  while(E.betting(g)){const p=g.players[g.currentPlayerIndex];E.applyAction(g,p.id,'fold');}for(const p of E.confirmationPlayers(g))E.confirmNextHand(g,p.id,g.handNumber);E.startHand(g);assert.notEqual(JSON.stringify(g.positions),before);assert.equal(g.positions[g.players[g.dealerIndex].id].label,'BTN');
});
test('ante positions use button distance, and custom blinds label the real full/half posters correctly',()=>{
  const g=E.createGame(players(4),20,{deckMode:'standard',blindMode:'ante'});E.startHand(g);assert.deepEqual(g.actionOrder.preflop.map(id=>g.positions[id].label),['BTN+1','BTN+2','BTN+3','BTN']);
  const h=E.createGame(players(4),20,{blindMode:'position'});E.startHand(h);assert.equal(h.positions[h.blindSeats.full].label,'BB');assert.equal(h.positions[h.blindSeats.half].label,'SB');
});
