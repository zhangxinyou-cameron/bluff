const {test}=require('node:test');
const assert=require('node:assert/strict');
const E=require('../public/poker-engine');
const players=n=>Array.from({length:n},(_,id)=>({id,name:'P'+id,chips:2000,connected:true}));
const cards=(ranks,suits=[0,1,2,3,0])=>ranks.map((rank,i)=>({rank,suit:suits[i]}));
test('short deck has 36 unique cards from six to ace, with the correct hand ordering',()=>{
  const d=E.createDeck('short');assert.equal(d.length,36);assert.equal(new Set(d.map(c=>c.id)).size,36);assert.ok(d.every(c=>c.rank>=6));
  const low=E.eval5(cards([14,6,7,8,9]),'short');assert.equal(low.name,'顺子');assert.deepEqual(low.tb,[9]);
  assert.equal(E.eval5(cards([14,6,7,8,9])).name,'高牌');
  const flush=cards([6,8,10,12,14],[0,0,0,0,0]),full=cards([8,8,8,9,9]);
  assert.ok(E.cmpHand(E.eval5(flush,'short'),E.eval5(full,'short'))>0);
  assert.ok(E.cmpHand(E.eval5(flush),E.eval5(full))<0);
  assert.ok(E.cmpHand(low,E.eval5(cards([14,14,14,10,11]),'short'))>0);
  assert.equal(E.evalBest([...flush,...cards([9,9],[1,2])],'short').name,'同花');
});
test('2–4 funded online players use short deck; 5–8 use standard; ante and button blind are correct',()=>{
  for(let n=2;n<=8;n++){
    const g=E.createGame(players(n),20,{autoDeck:true});assert.ok(E.startHand(g));
    assert.equal(g.variant,n<=4?'short':'standard');assert.equal(g.deck.length,(n<=4?36:52)-n*2);
    if(n<=4){assert.equal(g.pot,(n+1)*20);assert.equal(g.players[g.dealerIndex].currentBet,20);assert.equal(g.currentPlayerIndex,(g.dealerIndex+1)%n);for(const p of g.players)assert.equal(p.totalBet,p.id===g.players[g.dealerIndex].id?40:20);}
    else assert.equal(g.pot,30);
  }
});
test('variant is fixed within a hand and recalculated next hand after a player goes offline',()=>{
  const g=E.createGame(players(5),20,{autoDeck:true});E.startHand(g);g.players[4].connected=false;
  assert.equal(g.variant,'standard');
  while(E.betting(g)){const p=g.players[g.currentPlayerIndex];assert.ok(E.applyAction(g,p.id,'fold').ok);}
  for(const p of E.confirmationPlayers(g))E.confirmNextHand(g,p.id,g.handNumber);
  assert.ok(E.startHand(g));assert.equal(g.variant,'short');assert.equal(g.players[4].isActive,false);
});
test('700 seeded hands across 2–8 players finish with valid decks and conserved chips',()=>{
  let seed=72341;const random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296);
  for(let n=2;n<=8;n++)for(let round=0;round<100;round++){
    const g=E.createGame(players(n),20,{autoDeck:true});E.startHand(g,random);let steps=0;
    while(E.betting(g)){
      assert.ok(++steps<150);const p=g.players[g.currentPlayerIndex],r=random();
      const action=r<.08?'fold':r>.93&&E.canRaise(g,p)?'allin':g.currentBet>p.currentBet?'call':'check';
      assert.ok(E.applyAction(g,p.id,action).ok);
    }
    assert.equal(g.players.reduce((s,p)=>s+p.chips,0),n*2000);
    const dealt=[...g.communityCards,...g.players.flatMap(p=>p.holeCards)];assert.equal(new Set(dealt.map(c=>c.id)).size,dealt.length);
    if(n<=4)assert.ok(dealt.every(c=>c.rank>=6));
  }
});
