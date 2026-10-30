const{test}=require('node:test');const assert=require('node:assert/strict');const E=require('../public/poker-engine');const A=require('../poker-ai');
const rng=(initial=19)=>{let seed=initial;return()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296);};
const cards=text=>text.split(' ').map(s=>({rank:({T:10,J:11,Q:12,K:13,A:14})[s[0]]||Number(s[0]),suit:{s:0,h:1,c:2,d:3}[s[1]]}));
function fixture({hole='3c 5d',board='Ks Jh 9c 7d 2s',opponents=1,bet=0,variant='standard'}={}){
  const g=E.createGame(Array.from({length:opponents+1},(_,id)=>({id,chips:2000})),20,{deckMode:variant,blindMode:'standard'});E.startHand(g,rng());g.phase=board?({3:'flop',4:'turn',5:'river'})[cards(board).length]:'pre_flop';g.communityCards=board?cards(board):[];g.currentBet=bet;g.minRaise=Math.max(20,bet);g.currentPlayerIndex=0;g.positions[0]={label:'BTN',postflop:opponents+1,preflop:1};
  for(const p of g.players){p.totalBet=40+(p.id?bet:0);p.currentBet=p.id?bet:0;p.chips=2000-p.totalBet;p.acted=false;p.allIn=false;p.folded=false;}g.players[0].holeCards=cards(hole);g.pot=g.players.reduce((s,p)=>s+p.totalBet,0);return g;
}
function referenceScore(cards,variant){const r=E.evalBest(cards,variant);let out=r.rank;for(let i=0;i<5;i++)out=out*15+(r.tb[i]||0);return out;}
test('fast evaluator matches the production engine for every class and 12000 random 5–7-card hands',()=>{
  const random=rng(300);for(const variant of['standard','short'])for(let count=5;count<=7;count++)for(let i=0;i<2000;i++){const hand=E.shuffle(E.createDeck(variant),random).slice(0,count);assert.equal(A.score(hand,variant),referenceScore(hand,variant));}
  for(const text of['As Ks Qs Js Ts','As 9s 8s 7s 6s','Ah Ad Ac Kh Kd','Ah Ad Ac As Kd','2s 3h 4s 5h As'])for(const variant of['standard','short'])assert.equal(A.score(cards(text),variant),referenceScore(cards(text),variant));
});
test('river heads-up equity enumerates all possible opposing hands and splits ties correctly',()=>{
  const nuts=A.estimateEquity(A.observe(fixture({hole:'As Ks',board:'Qs Js Ts 2d 3c'}),0));assert.equal(nuts.exact,true);assert.equal(nuts.equity,1);assert.equal(nuts.trials,990);
  const tie=A.estimateEquity(A.observe(fixture({hole:'2c 3d',board:'As Ks Qs Js Ts'}),0));assert.equal(tie.equity,.5);
  const multi=A.estimateEquity(A.observe(fixture({hole:'2c 3d',board:'As Ks Qs Js Ts',opponents:3}),0),{random:rng(),samples:120});assert.ok(Math.abs(multi.equity-.25)<1e-10);
});
test('observation and decisions never read opposing cards, the real deck or private peek grants',()=>{
  const g=fixture({opponents:3});for(let i=1;i<g.players.length;i++)g.players[i]=new Proxy(g.players[i],{get(target,key){if(['holeCards','handResult','handResults'].includes(key))throw new Error('Hidden opponent field read');return target[key];}});
  for(const key of['deck','privateReveals','peekRequests'])Object.defineProperty(g,key,{get(){throw new Error('Private game field read');}});
  const view=A.observe(g,0);assert.doesNotThrow(()=>A.decide(view,{random:rng(),samples:80}));assert.ok(!JSON.stringify(view.players).includes('holeCards'));
});
test('changing all hidden cards and future board order cannot change the bot decision',()=>{
  const g=fixture({board:'Qh Jh 2c',hole:'Ah Kh',opponents:3}),before=A.decide(A.observe(g,0),{random:rng(123)});
  g.deck.reverse();g.privateReveals={1:[0]};for(const p of g.players.slice(1)){p.holeCards=cards('As Ad');p.handResult={rank:10};}
  assert.deepEqual(A.decide(A.observe(g,0),{random:rng(123)}),before);
});
test('nut hands value-bet rather than fold; premium preflop pairs open aggressively',()=>{
  const view=A.observe(fixture({hole:'As Ks',board:'Qs Js Ts 2d 3c',bet:400}),0),a=A.analyze(view);let raises=0;
  for(let i=0;i<100;i++){const d=A.chooseAction(view,a,()=>i/100);assert.notEqual(d.action,'fold');raises+=['raise','allin'].includes(d.action);}
  assert.ok(raises>=85);
  for(const n of[2,6,8]){const g=fixture({hole:'As Ah',board:'',opponents:n-1,bet:20});const d=A.decide(A.observe(g,0),{random:rng(9)});assert.ok(['raise','allin'].includes(d.action));}
});
test('a weak river hand rejects a large price, while a free check never becomes a fold',()=>{
  const expensive=A.observe(fixture({bet:700}),0),analysis=A.analyze(expensive);assert.ok(analysis.equity<analysis.potOdds);
  for(let i=0;i<100;i++)assert.equal(A.chooseAction(expensive,analysis,()=>i/100).action,'fold');
  const free=A.observe(fixture(),0),a=A.analyze(free);for(let i=0;i<100;i++)assert.notEqual(A.chooseAction(free,a,()=>i/100).action,'fold');
});
test('draws support semi-bluffs, and pure bluffs are mixed instead of happening every time',()=>{
  const draw=A.observe(fixture({hole:'Ah Kh',board:'Qh Jh 2c'}),0),analysis=A.analyze(draw,{random:rng(25)});assert.ok(analysis.draw.outs>=12);
  const reasons=Array.from({length:100},(_,i)=>A.chooseAction(draw,analysis,()=>i/100).reason);assert.ok(reasons.includes('semi_bluff'));assert.ok(reasons.includes('check'));
  const free=A.observe(fixture(),0),a=A.analyze(free);const bluffs=Array.from({length:100},(_,i)=>A.chooseAction(free,a,()=>i/100)).filter(d=>d.reason==='bluff');assert.ok(bluffs.length>0&&bluffs.length<20);
});
test('multiway pots reduce semi-bluff frequency, and all-in opponents are never bluffed',()=>{
  const count=opponents=>{const v=A.observe(fixture({hole:'Ah Kh',board:'Qh Jh 2c',opponents}),0),a=A.analyze(v,{random:rng(25)});return Array.from({length:100},(_,i)=>A.chooseAction(v,a,()=>i/100)).filter(d=>d.reason==='semi_bluff').length;};assert.ok(count(1)>count(6));
  const g=fixture({hole:'Ah Kh',board:'Qh Jh 2c',opponents:2});g.players[1].allIn=true;g.players[1].chips=0;const v=A.observe(g,0),a=A.analyze(v,{random:rng()});for(let i=0;i<100;i++)assert.ok(!['bluff','bluff_raise','semi_bluff','continuation_bet','position_steal'].includes(A.chooseAction(v,a,()=>i/100).reason));
});
test('side-pot odds exclude the uncallable part of opponents overbets',()=>{
  const g=fixture({opponents:2,bet:1000});g.players[0].chips=50;g.players[0].totalBet=50;g.pot=2130;
  const v=A.observe(g,0),a=A.analyze(v,{random:rng()});assert.equal(a.contestable,250);assert.equal(a.potOdds,50/300);
});
test('a short all-in that does not reopen betting never causes an illegal raise',()=>{
  const g=fixture({hole:'As Ks',board:'Qs Js Ts 2d 3c',bet:30});g.players[0].acted=true;g.players[0].lastActionBet=20;g.minRaise=20;const v=A.observe(g,0);assert.equal(v.canRaise,false);
  const d=A.decide(v,{random:rng()});assert.equal(d.action,'call');assert.ok(E.applyAction(g,0,d.action,d.amount).ok);
});
test('price changes affect calls and a preflop aggressor mixes continuation bets on dry boards',()=>{
  const cheap=A.observe(fixture({hole:'Ac Qd',bet:20}),0),expensive=A.observe(fixture({hole:'Ac Qd',bet:700}),0);
  const low=A.analyze(cheap),high=A.analyze(expensive);assert.ok(low.potOdds<high.potOdds);assert.equal(A.chooseAction(cheap,low,()=>.9).action,'call');assert.equal(A.chooseAction(expensive,high,()=>.9).action,'fold');
  const g=fixture({hole:'Ah 3c',board:'Ks 7d 2h'}),history=[{kind:'action',hand:g.handNumber,street:'pre_flop',seatId:0,action:'raise',raised:true,amount:60}];
  const v=A.observe(g,0,history),a=A.analyze(v,{random:rng(7)});assert.equal(a.priorAggressor,0);assert.equal(a.wet,false);
  assert.ok(Array.from({length:100},(_,i)=>A.chooseAction(v,a,()=>i/100)).some(d=>d.reason==='continuation_bet'));
});
