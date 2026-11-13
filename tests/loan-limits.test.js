const {test}=require('node:test'),assert=require('node:assert/strict'),E=require('../public/poker-engine');
const {RoomManager}=require('../room-manager');
let seq=0;
const game=(per,total)=>E.createGame([{id:0,chips:2000},{id:1,chips:2000}],20,{allowBuyIn:true,loanPerHandLimit:per,loanTotalLimit:total});
const bank=(g,kind,amount)=>E.bankTransaction(g,0,kind,amount,{handNumber:g.handNumber,bankVersion:g.players[0].bankVersion,requestId:'limit-'+(++seq)});
test('per-hand borrowing is cumulative, repayments never replenish it, new hands reset it',()=>{
  const g=game(1000,5000);assert.ok(bank(g,'borrow',600).ok);assert.ok(bank(g,'borrow',400).ok);
  const before=JSON.stringify(g);assert.equal(bank(g,'borrow',1).ok,false);assert.equal(JSON.stringify(g),before);
  assert.ok(bank(g,'repay',400).ok);assert.equal(E.loanAllowance(g,g.players[0]),0);
  E.startHand(g);while(E.betting(g)){const p=g.players[g.currentPlayerIndex];E.applyAction(g,p.id,'fold');}
  assert.equal(E.loanAllowance(g,g.players[0]),1000);assert.ok(bank(g,'borrow',1000).ok);
  assert.equal(g.players.reduce((s,p)=>s+p.chips-p.bankDebt,0)+g.pot,g.initialTotal);
});
test('total limit caps outstanding principal independently per player and repayment frees total room',()=>{
  const g=game(null,700);assert.ok(bank(g,'borrow',700).ok);assert.equal(bank(g,'borrow',1).ok,false);
  assert.ok(bank(g,'repay',200).ok);assert.equal(E.loanAllowance(g,g.players[0]),200);assert.ok(bank(g,'borrow',200).ok);
  assert.equal(E.loanAllowance(g,g.players[1]),700);assert.equal(g.players[0].totalBorrowed,900);
});
test('zero, unlimited, exact boundaries, duplicate requests and malformed settings',()=>{
  for(const limits of [[0,null],[null,0],[0,0]])assert.equal(bank(game(...limits),'borrow',1).ok,false);
  assert.ok(bank(game(null,null),'borrow',200000).ok);
  const g=game(10,10),request={handNumber:0,bankVersion:0,requestId:'same-limit'};
  assert.ok(E.bankTransaction(g,0,'borrow',10,request).ok);assert.ok(E.bankTransaction(g,0,'borrow',10,request).duplicate);assert.equal(g.players[0].borrowedThisHand,10);
  for(const value of [-1,.1,Infinity,NaN,'100','无限',{},Number.MAX_SAFE_INTEGER+1])assert.equal(E.validLoanLimit(value),false);
});
test('AI rebuys obey both caps, borrow partial allowance, and cannot bypass a zero limit',()=>{
  for(const [cap,threshold,expected] of [[0,null,0],[300,null,200],[300,0,0],[300,1,200]]){
    const g=game(cap,200);g.buyInThreshold=threshold;g.players[1].isAI=true;g.players[0].chips+=g.players[1].chips;g.players[1].chips=0;
    assert.equal(E.startHand(g),expected>0);assert.equal(g.players[1].bankDebt,expected);
    assert.equal(g.players.reduce((s,p)=>s+p.chips-p.bankDebt,0)+g.pot,g.initialTotal);
  }
});
test('buy-in threshold uses current chips before each loan and repayment remains open',()=>{
  const g=game(600,500);
  g.buyInThreshold=2001;
  assert.ok(bank(g,'borrow',1).ok);
  assert.equal(E.loanAllowance(g,g.players[0]),0);
  assert.match(bank(g,'borrow',1).message,/低于 2001/);
  assert.ok(bank(g,'repay',1).ok);
  assert.ok(bank(g,'borrow',500).ok);
  assert.match(bank(g,'borrow',1).message,/低于 2001/);
  assert.ok(bank(g,'repay',500).ok);
  g.buyInThreshold=0;
  assert.equal(bank(g,'borrow',1).ok,false);
  g.buyInThreshold=null;
  assert.equal(E.loanAllowance(g,g.players[0]),99);
});
test('room settings validate limits, require host and propagate authoritative caps to the game',t=>{
  const m=new RoomManager(new Map());t.after(()=>m.dispose());const ws={readyState:1,send(){},close(){}};
  m.join(ws,{roomCode:'456789',seatId:0,name:'Host'});const r=m.games.get('456789'),host=r.people.get(0),base={...r.settings,allowBuyIn:true,loanPerHandLimit:123,loanTotalLimit:456,buyInThreshold:500};
  assert.equal(m.command(r,{id:1},{type:'roomSettings',settings:base}).ok,false);
  for(const value of [-1,.5,'100'])assert.equal(m.command(r,host,{type:'roomSettings',settings:{...base,loanTotalLimit:value}}).ok,false);
  for(const value of [-1,.5,'100'])assert.equal(m.command(r,host,{type:'roomSettings',settings:{...base,buyInThreshold:value}}).ok,false);
  assert.ok(m.command(r,host,{type:'roomSettings',settings:base,maxPlayers:2,aiSlots:{1:true}}).ok);
  assert.ok(m.command(r,host,{type:'startGame'}).ok);assert.equal(r.game.loanPerHandLimit,123);assert.equal(m.serialize(r,0).loanTotalLimit,456);
  assert.equal(m.serialize(r,0).buyInThreshold,500);
  assert.equal(m.command(r,host,{type:'roomSettings',settings:{...base,loanTotalLimit:null}}).ok,false);
});
