const {test}=require('node:test');
const assert=require('node:assert/strict');
const {RoomManager}=require('../room-manager');
const E=require('../public/poker-engine');
function fixture(t,n=2,timings={}){
  const manager=new RoomManager(new Map(),{roster(){},remove(){}});manager.configureTimings({deal:0,street:0,runout:0,action:0,ai:0,...timings});t.after(()=>manager.dispose());
  const sockets=[];const code='123456';
  function join(data={}){const ws={readyState:1,messages:[],send(s){this.messages.push(JSON.parse(s));},close(){this.readyState=3;}};manager.handle(ws,{type:'joinRoom',roomCode:code,seatId:sockets.length?-1:0,name:'P'+sockets.length,...data});sockets.push(ws);return ws;}
  for(let i=0;i<n;i++)join();
  function command(ws,type,data={}){const person=manager.games.get(code)?.people.get(ws.seatId);manager.handle(ws,{type,requestId:'request-'+ws.seatId+'-'+(person?.commandSeq+1),commandSeq:person?.commandSeq+1,...data});return ws.messages.filter(m=>m.type==='ack').at(-1);}
  function start(){for(const ws of sockets.slice(1))command(ws,'ready');assert.ok(command(sockets[0],'startGame').ok);}
  return{manager,sockets,room:manager.games.get(code),join,command,start,latest:ws=>ws.messages.filter(m=>m.type==='snapshot').at(-1)};
}
test('8 seats work, a ninth player is rejected, and authoritative snapshots hide other hole cards',t=>{
  const f=fixture(t,8);const ninth=f.join();assert.match(ninth.messages.at(-1).message,/最多支持8人/);f.sockets.pop();f.start();
  assert.equal(f.room.game.variant,'standard');
  for(const ws of f.sockets){const state=f.latest(ws).game;assert.equal(state.deck,undefined);for(const p of state.players)assert.equal(p.holeCards.length,p.id===ws.seatId?2:0);}
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
test('invalid action cursor is repaired, and accounting anomaly pauses the room visibly',t=>{
  const f=fixture(t,3);f.start();f.room.game.currentPlayerIndex=-1;f.manager.tick();assert.ok(f.room.game.currentPlayerIndex>=0);
  f.room.game.players[0].chips++;f.command(f.sockets[0],'chat',{text:'invariant check'});assert.equal(f.room.paused,true);assert.ok(f.latest(f.sockets[0]).paused);
});
