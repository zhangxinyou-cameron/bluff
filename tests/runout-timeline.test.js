const {test}=require('node:test'),assert=require('node:assert/strict');
const T=require('../public/runout-timeline'),E=require('../public/poker-engine'),{RoomManager}=require('../room-manager');
test('3-second runouts reveal a full flop then single turn/river, pause between boards and before results',()=>{
  const t=T.build(0,2,3000);assert.equal(t.duration,21000);
  for(const [time,counts] of [[0,[0,0]],[2999,[0,0]],[3000,[3,0]],[6000,[4,0]],[9000,[5,0]],[11999,[5,0]],[12000,[5,3]],[15000,[5,4]],[18000,[5,5]],[20999,[5,5]]])assert.deepEqual(T.frame(t,time).counts,counts);
  assert.equal(T.frame(t,20999).complete,false);assert.equal(T.frame(t,21000).complete,true);
  assert.equal(T.build(0,1,3000).duration,12000);assert.equal(T.build(3,2,3000).duration,15000);assert.equal(T.build(4,1,3000).duration,6000);assert.equal(T.build(5,1,3000).duration,3000);
  assert.equal(T.build(0,2,0).duration,0);
});
test('server snapshots and reconnects expose only revealed boards and withhold results until final hold ends',t=>{
  let now=1000;t.mock.method(Date,'now',()=>now);const m=new RoomManager(new Map());t.after(()=>m.dispose());
  const g=E.createGame([{id:0,chips:1000},{id:1,chips:1000}],20,{allowBuyIn:true,runTwiceEnabled:true});E.startHand(g);
  while(E.betting(g)){const p=g.players[g.currentPlayerIndex];E.applyAction(g,p.id,'allin');}E.resolveRunout(g,true);
  const room={game:g,settings:{runoutDelayMs:3000},people:new Map()};m.pace(room,'runout',0,100);const full=JSON.stringify(g.runoutBoards);
  for(const [elapsed,lengths]of[[0,[0]],[3000,[3]],[6000,[4]],[9000,[5]],[12000,[5,3]],[15000,[5,4]],[18000,[5,5]]]){
    now=1000+elapsed;const view=m.serialize(room,0);assert.deepEqual(view.runoutBoards.map(b=>b.length),lengths);assert.deepEqual(view.pots,[]);assert.deepEqual(view.winners,[]);assert.ok(view.players.every(p=>p.handResult==null));assert.equal(view.players.reduce((s,p)=>s+p.chips-p.bankDebt,0)+view.pot,g.initialTotal);
  }
  now=22000;assert.deepEqual(m.serialize(room,0).pots,g.pots);assert.equal(JSON.stringify(g.runoutBoards),full);m.check(room);
});
test('full raises count 2-bet, 3-bet and 4-bet, with street reset',()=>{
  const g=E.createGame([{id:0,chips:2000},{id:1,chips:2000},{id:2,chips:2000}],20,{blindMode:'standard'});E.startHand(g);assert.equal(g.betLevel,1);
  for(const amount of [60,180,540]){const p=g.players[g.currentPlayerIndex];assert.ok(E.applyAction(g,p.id,'raise',amount).ok);assert.equal(g.betLevel,[60,180,540].indexOf(amount)+2);}
  while(g.phase==='pre_flop'){const p=g.players[g.currentPlayerIndex];E.applyAction(g,p.id,p.currentBet<g.currentBet?'call':'check');}assert.equal(g.betLevel,0);
  const h=E.createGame([{id:0,chips:1000},{id:1,chips:1000},{id:2,chips:90}],20,{blindMode:'standard'});E.startHand(h);E.applyAction(h,0,'raise',60);E.applyAction(h,1,'call');E.applyAction(h,2,'allin');assert.equal(h.betLevel,2,'short all-in does not count as a full 3-bet');
});
test('runout delay is a bounded host-only pregame setting with a 3-second default',t=>{
  const m=new RoomManager(new Map());t.after(()=>m.dispose());m.join({readyState:1,send(){},close(){}},{roomCode:'987654',seatId:0,name:'Host'});const r=m.games.get('987654'),p=r.people.get(0),base={...r.settings};
  for(const runoutDelayMs of [-1,3001,'3000',null])assert.equal(m.command(r,p,{type:'roomSettings',settings:{...base,runoutDelayMs}}).ok,false);
  assert.equal(m.command(r,{id:1},{type:'roomSettings',settings:{...base,runoutDelayMs:3000}}).ok,false);
  for(const runoutDelayMs of [0,1000,2000,3000])assert.ok(m.command(r,p,{type:'roomSettings',settings:{...base,runoutDelayMs}}).ok);
  assert.ok(m.command(r,p,{type:'roomSettings',settings:base}).ok);assert.equal(r.settings.runoutDelayMs,3000);
});
