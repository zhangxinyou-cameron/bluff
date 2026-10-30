const assert = require('node:assert/strict');
const { test } = require('node:test');
const E = require('../public/poker-engine');

function cards(text) {
  const suits={s:0,h:1,c:2,d:3}, ranks={T:10,J:11,Q:12,K:13,A:14};
  return text.split(' ').map(card=>{
    const rank=ranks[card[0]]||Number(card[0]), suit=suits[card[1]];
    return {rank,suit,id:suit*13+rank-2};
  });
}
function game(stacks, ids=stacks.map((_,i)=>i), random=Math.random) {
  const g=E.createGame(stacks.map((chips,i)=>({id:ids[i],name:'P'+ids[i],chips})),20);
  E.startHand(g, random);
  return g;
}
function act(g, action, amount) {
  const id=g.players[g.currentPlayerIndex]?.id;
  const result=E.applyAction(g,id,action,amount);
  assert.equal(result.ok,true, `${id}: ${action} ${amount}: ${result.message}`);
}
function finishPassive(g) {
  let guard=0;
  while (E.betting(g)) {
    assert.ok(guard++<100,'Hand is stuck');
    const p=g.players[g.currentPlayerIndex];
    assert.ok(p && p.chips>0&&!p.allIn&&!p.folded&&p.isActive);
    act(g,p.currentBet<g.currentBet?'call':'check');
  }
}
function confirmAll(g) { for (const p of E.confirmationPlayers(g)) E.confirmNextHand(g,p.id,g.handNumber); }

test('all hand classes, ace-low straight, kickers and best five out of seven', () => {
  const examples = ['As Ks Qs Js Ts','9h 8h 7h 6h 5h','As Ah Ac Ad Ks','As Ah Ac Ks Kh','As Js 8s 4s 2s','As 2h 3c 4d 5s','As Ah Ac Ks Qh','As Ah Ks Kh Qh','As Ah Ks Qh 9d','As Kh Qd 9h 3c'];
  examples.forEach((hand,index)=>assert.equal(E.eval5(cards(hand)).rank,10-index));
  assert.equal(E.cmpHand(E.eval5(cards('As 2h 3c 4d 5s')),E.eval5(cards('2s 3h 4c 5d 6s'))),-1);
  assert.equal(E.cmpHand(E.eval5(cards('As Ah Kc 8d 2s')),E.eval5(cards('Ac Ad Qc Jh 9d'))),1);
  assert.deepEqual(E.evalBest(cards('As Ah Ac Ks Kh Kc 2d')).tb,[14,13]);
  assert.equal(E.evalBest(cards('As Ks Qs Js Ts 2c 3d')).rank,10);
});

test('heads-up button is small blind, first preflop and last after the flop', () => {
  const g=game([1000,1000]);
  assert.equal(g.dealerIndex,0);
  assert.equal(g.players[0].currentBet,10);
  assert.equal(g.players[1].currentBet,20);
  assert.equal(g.currentPlayerIndex,0);
  act(g,'call'); assert.equal(g.currentPlayerIndex,1);
  act(g,'check'); assert.equal(g.phase,'flop'); assert.equal(g.currentPlayerIndex,1);
  finishPassive(g);
  confirmAll(g);
  assert.ok(E.startHand(g));
  assert.equal(g.dealerIndex,1); assert.equal(g.currentPlayerIndex,1);
});

test('big blind retains its option before the flop and sparse seats act by seat ID', () => {
  const g=game([1000,1000,1000],[0,2,5]);
  assert.equal(g.players[g.currentPlayerIndex].id,0);
  act(g,'call'); assert.equal(g.players[g.currentPlayerIndex].id,2);
  act(g,'call'); assert.equal(g.phase,'pre_flop'); assert.equal(g.players[g.currentPlayerIndex].id,5);
  act(g,'check'); assert.equal(g.phase,'flop'); assert.equal(g.players[g.currentPlayerIndex].id,2);
  finishPassive(g);
  assert.equal(g.players.reduce((a,p)=>a+p.chips,0),3000);
});

test('out-of-turn, stale, invalid checks and malformed raises leave state unchanged', () => {
  const g=game([1000,1000,1000]);
  for (const [seat,action,amount,expected] of [[1,'fold'],[0,'check'],[0,'raise',-1],[0,'raise',NaN],[0,'raise',Infinity],[0,'raise',30],[0,'raise',40.5],[0,'call',undefined,{handNumber:0,revision:0}]]) {
    const before=JSON.stringify(g);
    assert.equal(E.applyAction(g,seat,action,amount,expected).ok,false);
    assert.equal(JSON.stringify(g),before);
  }
  const old={handNumber:g.handNumber,revision:g.revision};
  act(g,'call');
  assert.equal(E.applyAction(g,0,'allin',undefined,old).ok,false);
});

test('full raises set the next minimum raise; a short all-in does not reopen betting', () => {
  const g=game([1000,1000,1000,150]);
  act(g,'raise',100); // Seat 3: +80 raise, all-in stack is 150 total.
  act(g,'call'); act(g,'call'); act(g,'call');
  assert.equal(g.phase,'flop');
  act(g,'raise',100); // Seat 1 opens, seat 2 calls.
  act(g,'call');
  assert.equal(g.players[g.currentPlayerIndex].id,3);
  act(g,'allin'); // Seat 3 has 50 left: an undercall, not a raise.
  act(g,'call');
  assert.equal(g.phase,'turn');

  const h=game([1000,130,1000,1000]);
  act(h,'raise',100); // Seat 3 raises +80.
  act(h,'call');
  act(h,'allin'); // Seat 1 short-raises 100 -> 130.
  assert.equal(h.minRaise,80);
  assert.equal(E.canRaise(h,h.players[2]),true); // Hasn't acted yet.
  act(h,'call');
  assert.equal(h.players[h.currentPlayerIndex].id,3);
  assert.equal(E.canRaise(h,h.players[3]),false);
  const before=JSON.stringify(h);
  assert.equal(E.applyAction(h,3,'raise',210).ok,false);
  assert.equal(JSON.stringify(h),before);
  act(h,'call'); act(h,'call'); assert.equal(h.phase,'flop');
  assert.equal(h.players[h.currentPlayerIndex].id,2); // Skip all-in seat 1.
});

test('cumulative short all-ins can reopen betting after a full raise is faced', () => {
  const g=game([1000,140,180,1000]);
  act(g,'raise',100); // 80 full raise.
  act(g,'call'); act(g,'allin'); act(g,'allin'); // 140 then 180, cumulative +80.
  assert.equal(g.currentBet,180); assert.equal(g.minRaise,80);
  assert.equal(g.players[g.currentPlayerIndex].id,3);
  assert.equal(E.canRaise(g,g.players[3]),true);
  act(g,'raise',260);
  finishPassive(g);
  assert.equal(g.players.reduce((sum,p)=>sum+p.chips,0),2320);
});

test('all-in players are skipped; completed action automatically runs out the board', () => {
  const g=game([50,200,200,200]);
  act(g,'call'); act(g,'allin'); act(g,'call'); act(g,'call'); act(g,'call');
  assert.equal(g.phase,'flop');
  assert.equal(g.players[g.currentPlayerIndex].id,1);
  finishPassive(g);
  assert.equal(g.communityCards.length,5);
  assert.equal(g.players.reduce((a,p)=>a+p.chips,0),650);
  const h=game([5,10]);
  assert.equal(h.phase,'hand_over'); assert.equal(h.communityCards.length,5);
  assert.equal(h.players.reduce((a,p)=>a+p.chips,0),15);
});

function showdown(stacks, contributions, hands, board, folded=[]) {
  const g=E.createGame(stacks.map((chips,i)=>({id:i,name:'P'+i,chips})),20);
  g.dealerIndex=0; g.handNumber=1; g.phase='river'; g.communityCards=cards(board);
  g.players.forEach((p,i)=>Object.assign(p,{totalBet:contributions[i],currentBet:0,holeCards:cards(hands[i]),isActive:true,folded:folded.includes(i),chipsBeforeHand:stacks[i]+contributions[i]}));
  g.pot=contributions.reduce((a,b)=>a+b,0);
  E.settle(g,true);
  return g;
}
test('short-stack winner receives only main pot; other players compete for side pots', () => {
  const g=showdown([0,0,0],[50,100,200],['As Ah','Ks Kh','Qs Qh'],'2s 3h 7c 9d Js');
  assert.deepEqual(g.players.map(p=>p.chips),[150,100,100]);
  assert.deepEqual(g.pots,[{amount:150,winners:[0],awards:[{seatId:0,amount:150}]},{amount:100,winners:[1],awards:[{seatId:1,amount:100}]}]);
  assert.deepEqual(g.winners,[0,1]);
});
test('tied pots preserve every chip; odd chip goes left of the button', () => {
  const g=showdown([0,0,0],[5,5,5],['2h 3h','4h 5h','6h 7h'],'As Ks Qs Js Ts',[2]);
  assert.deepEqual(g.players.map(p=>p.chips),[7,8,0]);
  assert.deepEqual(g.winners,[1,0]);
  assert.equal(g.players.reduce((a,p)=>a+p.chips,0),15);
  assert.deepEqual(g.pots[0].awards,[{seatId:1,amount:8},{seatId:0,amount:7}]);
});

test('folded contributions do not create fake side pots or duplicate odd-chip payouts',()=>{
  const g=showdown([0,0,0,0,0],[10,10,7,4,1],['2h 3h','4h 5h','6h 7h','8h 9h','2c 3c'],'As Ks Qs Js Ts',[2,3,4]);
  assert.equal(g.pots.length,1);assert.equal(g.pots[0].amount,32);
  assert.deepEqual(g.players.map(p=>p.chips),[16,16,0,0,0]);
  assert.deepEqual(g.pots[0].awards,[{seatId:1,amount:16},{seatId:0,amount:16}]);
});

test('eliminations are recorded after payouts and survive later hands',()=>{
  const g=showdown([0,0,0],[50,100,200],['Qs Qh','Ks Kh','As Ah'],'2s 3h 7c 9d Js');
  assert.equal(g.players[0].eliminatedHand,1);assert.equal(g.players[0].eliminationStack,50);
  assert.equal(g.players[1].eliminatedHand,1);assert.equal(g.players[1].eliminationStack,100);
  assert.equal(g.players[2].eliminatedHand,null);
  assert.deepEqual(E.standings(g).map(p=>[p.id,p.place]),[[2,1],[1,2],[0,3]]);
  // An uncalled refund keeps a player alive.
  const refund=showdown([0,0,0],[50,100,200],['As Ah','Ks Kh','Qs Qh'],'2s 3h 7c 9d Js');
  assert.equal(refund.players[2].eliminatedHand,null);
  refund.players[1].chips=0;refund.players[1].eliminatedHand=1;refund.players[1].eliminationStack=100;
  confirmAll(refund);assert.equal(E.startHand(refund),true);
  assert.equal(refund.players[1].eliminatedHand,1);assert.equal(refund.players[1].eliminationStack,100);
});

test('later eliminations rank higher, and identical same-hand stacks share a place',()=>{
  const g=E.createGame([{id:0,chips:0},{id:1,chips:0},{id:2,chips:300}],20);
  Object.assign(g.players[0],{eliminatedHand:2,eliminationStack:200});
  Object.assign(g.players[1],{eliminatedHand:9,eliminationStack:100});
  assert.deepEqual(E.standings(g).map(p=>[p.id,p.place]),[[2,1],[1,2],[0,3]]);
  Object.assign(g.players[0],{eliminatedHand:9,eliminationStack:100});
  assert.deepEqual(E.standings(g).map(p=>[p.id,p.place]),[[2,1],[0,2],[1,2]]);
});
test('uncalled overbet is returned and folded hands never win a pot', () => {
  const g=showdown([0,0,0],[100,100,250],['As Ah','Ks Kh','Qs Qh'],'2s 3h 7c 9d Js',[0]);
  assert.deepEqual(g.players.map(p=>p.chips),[0,300,150]);
});
test('disconnect folds a live hand, preserves an all-in hand and never skips the current opponent', () => {
  const g=game([1000,1000,1000]);
  E.disconnect(g,1);
  assert.equal(g.players[1].folded,true); assert.equal(g.currentPlayerIndex,0);
  act(g,'call'); assert.equal(g.currentPlayerIndex,2);
  act(g,'check'); assert.equal(g.currentPlayerIndex,2);
  finishPassive(g);
  assert.equal(g.players.reduce((a,p)=>a+p.chips,0),3000);
  const h=game([50,200,200]);
  act(h,'allin'); E.disconnect(h,0);
  assert.equal(h.players[0].folded,false);
  finishPassive(h);
  assert.equal(h.players.reduce((a,p)=>a+p.chips,0),450);
});

test('500 seeded full hands across 2–6 players conserve chips and never stall', () => {
  let seed=20261028;
  const random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/2**32);
  for (let n=2;n<=6;n++) {
    for (let hand=0;hand<100;hand++) {
      const stacks=Array.from({length:n},()=>5+Math.floor(random()*300));
      const initial=stacks.reduce((a,b)=>a+b,0);
      const g=game(stacks,stacks.map((_,i)=>i*2),random);
      let actions=0;
      while (E.betting(g)) {
        assert.ok(actions++<200,`Stuck ${n} players hand ${hand}`);
        const p=g.players[g.currentPlayerIndex];
        assert.ok(p.isActive&&!p.folded&&!p.allIn&&p.chips>0);
        const roll=random();
        if (roll<.12) act(g,'fold');
        else if (roll<.30 && E.canRaise(g,p)) act(g,'allin');
        else if (roll<.50 && E.canRaise(g,p) && p.chips+p.currentBet>=E.minimumRaiseTo(g)) act(g,'raise',E.minimumRaiseTo(g));
        else act(g,p.currentBet<g.currentBet?'call':'check');
        assert.equal(g.players.reduce((a,p)=>a+p.chips,0)+g.pot,initial);
        for (const player of g.players) assert.ok(Number.isSafeInteger(player.chips)&&player.chips>=0);
      }
      assert.equal(g.phase,'hand_over'); assert.ok(g.winners.length>0);
      const dealt=[...g.communityCards,...g.players.flatMap(p=>p.holeCards)];
      assert.equal(new Set(dealt.map(c=>c.id)).size,dealt.length);
      assert.equal(g.players.reduce((a,p)=>a+p.chips,0),initial);
    }
  }
});

test('repeated hands skip eliminated players and finish when only one stack remains', () => {
  const g=game([100,100,100,100,100,100]);
  let hands=0;
  do {
    let actions=0;
    while (E.betting(g)) {
      assert.ok(actions++<100);
      const p=g.players[g.currentPlayerIndex];
      act(g,E.canRaise(g,p)?'allin':p.currentBet<g.currentBet?'call':'check');
      assert.equal(g.players.reduce((a,p)=>a+p.chips,0)+g.pot,600);
    }
    hands++;
    confirmAll(g);
    for (const p of g.players) assert.ok(p.chips>=0);
  } while (hands<50 && E.startHand(g));
  assert.equal(g.players.filter(p=>p.chips>0).length,1);
  assert.equal(E.startHand(g),false);
});

test('next hand requires every online human including host; duplicate/stale confirmations cannot bypass it', () => {
  const g=game([1000,1000,1000]);
  finishPassive(g);
  const hand=g.handNumber;
  assert.equal(E.startHand(g),false);
  assert.equal(E.confirmNextHand(g,0,hand),true);
  assert.equal(E.confirmNextHand(g,0,hand),true);
  assert.deepEqual(g.nextHandReady,[0]);
  assert.equal(E.startHand(g),false);
  assert.equal(E.confirmNextHand(g,1,hand-1),false);
  assert.equal(E.confirmNextHand(g,99,hand),false);
  E.confirmNextHand(g,1,hand);
  assert.equal(E.startHand(g),false);
  E.confirmNextHand(g,2,hand);
  assert.equal(E.startHand(g),true);
  assert.deepEqual(g.nextHandReady,[]);
  assert.equal(E.confirmNextHand(g,1,hand),false);
});

test('AI confirmation is automatic and a disconnected human does not block the next hand', () => {
  const g=game([1000,1000,1000]);
  g.players[2].isAI=true;
  finishPassive(g);
  E.confirmNextHand(g,0,g.handNumber);
  assert.equal(E.allConfirmed(g),false);
  E.disconnect(g,1);
  assert.equal(E.allConfirmed(g),true);
  assert.equal(E.startHand(g),true);
});
