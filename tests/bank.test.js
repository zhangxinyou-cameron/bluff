const assert=require('node:assert/strict');
const {test}=require('node:test');
const E=require('../public/poker-engine');
function table(n=3,allowBuyIn=true){return E.createGame(Array.from({length:n},(_,id)=>({id,name:'P'+id,chips:2000})),20,{allowBuyIn});}
let request=0;
function bank(g,id,kind,amount){const p=g.players.find(p=>p.id===id);return E.bankTransaction(g,id,kind,amount,{handNumber:g.handNumber,bankVersion:p.bankVersion,requestId:'test-'+(++request)});}
function invariant(g){
  assert.equal(g.players.reduce((sum,p)=>sum+p.chips-p.bankDebt,0)+g.pot,g.initialTotal);
  for(const p of g.players){assert.equal(p.totalBorrowed-p.totalRepaid,p.bankDebt);assert.ok(p.chips>=0&&p.bankDebt>=0);}
}
function confirm(g){for(const p of E.confirmationPlayers(g))E.confirmNextHand(g,p.id,g.handNumber);}
function play(g,allin=false){let actions=0;while(E.betting(g)){
  assert.ok(actions++<200,'hand stalled');const p=g.players[g.currentPlayerIndex];
  const kind=allin&&E.canRaise(g,p)?'allin':p.currentBet<g.currentBet?'call':'check';
  assert.equal(E.applyAction(g,p.id,kind).ok,true);invariant(g);
}}
test('loans/repaid principal conserve net chips, have no interest and clear only the borrower confirmation',()=>{
  const g=table();E.startHand(g);play(g);confirm(g);
  assert.equal(bank(g,1,'borrow',1500).ok,true);assert.equal(g.players[1].bankDebt,1500);
  assert.deepEqual(g.nextHandReady,[0,2]);invariant(g);
  const net=g.players[1].chips-g.players[1].bankDebt;
  assert.equal(bank(g,1,'repay',500).ok,true);assert.equal(g.players[1].bankDebt,1000);
  assert.equal(g.players[1].chips-g.players[1].bankDebt,net);invariant(g);
});
test('bank rejects disabled, mid-hand, invalid, overpayment, disconnected and finished transactions',()=>{
  const off=table(3,false);assert.equal(bank(off,0,'borrow',100).ok,false);
  const g=table();E.startHand(g);assert.equal(bank(g,0,'borrow',100).ok,false);play(g);
  for(const [kind,amount] of[['borrow',-1],['borrow',0],['borrow',1.5],['borrow',Infinity],['borrow',Number.MAX_SAFE_INTEGER],['repay',1],['bad',100]]){
    const before=JSON.stringify(g);assert.equal(bank(g,0,kind,amount).ok,false);assert.equal(JSON.stringify(g),before);
  }
  bank(g,0,'borrow',500);
  assert.equal(bank(g,0,'repay',501).ok,false);
  const debt=g.players[0].bankDebt;g.players[0].chips=1;
  assert.equal(bank(g,0,'repay',2).ok,false);assert.equal(g.players[0].bankDebt,debt);
  g.players[0].disconnected=true;assert.equal(bank(g,0,'borrow',1).ok,false);
  E.requestSessionEnd(g,0);assert.equal(bank(g,1,'borrow',1).ok,false);
});
test('duplicate, stale and altered bank requests never repeat a transaction',()=>{
  const g=table(),expected={handNumber:0,bankVersion:0,requestId:'same-request'};
  assert.equal(E.bankTransaction(g,0,'borrow',1000,expected).ok,true);
  const before=JSON.stringify(g);
  assert.equal(E.bankTransaction(g,0,'borrow',1000,expected).duplicate,true);assert.equal(JSON.stringify(g),before);
  assert.equal(E.bankTransaction(g,0,'borrow',1001,expected).ok,false);
  assert.equal(E.bankTransaction(g,0,'borrow',1000,{...expected,requestId:'other'}).ok,false);
  assert.equal(E.bankTransaction(g,0,'borrow',1000,{handNumber:99,bankVersion:1,requestId:'late'}).ok,false);
  invariant(g);
});
test('zero chips do not eliminate a player; loans restore participation in a later hand',()=>{
  const g=table();let seed=728;
  const fixedDeal=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/2**32);
  E.startHand(g,fixedDeal);play(g,true);
  assert.equal(g.phase,'hand_over');assert.ok(g.players.some(p=>p.chips===0));
  for(const p of g.players){assert.equal(p.eliminatedHand,null);if(p.chips===0)assert.equal(bank(g,p.id,'borrow',2000).ok,true);}
  confirm(g);assert.equal(E.startHand(g),true);assert.ok(g.players.every(p=>p.isActive));
  invariant(g);
});
test('a zero-chip spectator can buy in later, while all-confirmed tables with one stack wait safely',()=>{
  const g=table();E.startHand(g);play(g,true);confirm(g);
  // A random board can tie. Set the one-funded-player scenario explicitly.
  const total=g.players.reduce((s,p)=>s+p.chips,0);g.players.forEach((p,i)=>p.chips=i===0?total:0);
  assert.equal(E.startHand(g),false);
  const broke=g.players.find(p=>p.chips===0);
  assert.equal(bank(g,broke.id,'borrow',2000).ok,true);confirm(g);assert.equal(E.startHand(g),true);
  assert.equal(g.players.filter(p=>p.isActive).length,2);invariant(g);
});
test('AI automatic rebuys are loans included in its final net balance',()=>{
  const g=table(2);g.players[1].isAI=true;E.startHand(g);play(g);
  const moved=g.players[1].chips;g.players[0].chips+=moved;g.players[1].chips=0;
  confirm(g);assert.equal(E.startHand(g),true);
  assert.equal(g.players[1].bankDebt,2000);assert.equal(g.players[1].totalBorrowed,2000);
  assert.equal(g.players[1].isActive,true);invariant(g);
});
test('only host can end, active hands finish fairly, and final ranking deducts outstanding debt',()=>{
  const g=table();bank(g,0,'borrow',5000);E.startHand(g);
  const before=JSON.stringify(g);assert.equal(E.requestSessionEnd(g,1).ok,false);assert.equal(JSON.stringify(g),before);
  assert.equal(E.requestSessionEnd(g,0).ok,true);assert.equal(g.phase,'pre_flop');
  play(g);assert.equal(g.phase,'tournament_over');assert.equal(E.startHand(g),false);invariant(g);
  const h=table();bank(h,0,'borrow',5000);h.players[0].chips-=200;h.players[1].chips+=200;
  assert.equal(E.requestSessionEnd(h,0).ok,true);
  assert.deepEqual(E.standings(h).map(p=>p.id),[1,2,0]);
  assert.equal(E.standings(h).find(p=>p.id===0).netChips,1800);
  assert.equal(E.standings(h).find(p=>p.id===0).netProfit,-200);invariant(h);
});
test('100 consecutive buy-in hands keep accounting balanced and never end automatically',()=>{
  const g=table(6);let seed=728;
  const random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/2**32);
  assert.equal(E.startHand(g,random),true);
  for(let hand=1;hand<=100;hand++){
    let actions=0;while(E.betting(g)){
      assert.ok(actions++<200);const p=g.players[g.currentPlayerIndex],roll=random();
      const kind=roll<.1?'fold':roll<.4&&E.canRaise(g,p)?'allin':p.currentBet<g.currentBet?'call':'check';
      assert.equal(E.applyAction(g,p.id,kind).ok,true);invariant(g);
    }
    assert.equal(g.phase,'hand_over');
    for(const p of g.players){
      if(p.chips<2000)assert.equal(bank(g,p.id,'borrow',2000).ok,true);
      if(p.chips>4000&&p.bankDebt>0)assert.equal(bank(g,p.id,'repay',Math.min(500,p.bankDebt)).ok,true);
      assert.equal(p.eliminatedHand,null);invariant(g);
    }
    confirm(g);if(hand<100)assert.equal(E.startHand(g,random),true);
  }
  assert.equal(E.requestSessionEnd(g,0).ok,true);assert.equal(g.phase,'tournament_over');invariant(g);
});
