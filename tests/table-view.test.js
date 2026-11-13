const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {test}=require('node:test');
const E=require('../public/poker-engine');
const script=fs.readFileSync(path.join(__dirname,'../public/table-page.js'),'utf8');

function view(){
  const elements=new Map();
  const element=id=>{if(!elements.has(id))elements.set(id,{innerHTML:'',textContent:'',value:'',style:{},addEventListener(){}});return elements.get(id);};
  const context=vm.createContext({PokerEngine:E,RiverAvatars:require('../public/avatars'),document:{getElementById:element},localStorage:{getItem(){return null;},setItem(){}},console});
  context.window=context;
  vm.runInContext(script,context);
  // Unrelated bank/odds rendering is not part of these layout assertions.
  vm.runInContext('updateSessionTools=()=>{};calcWinRate=()=>50;wsConnected=true;',context);
  return{context,elements,render(game,id,raising=false){context.game=game;context.viewer=id;context.raising=raising;vm.runInContext('mySeatId=viewer;raiseMode=raising;renderGame(game);',context);},presets(game,player){context.game=game;context.player=player;return JSON.parse(vm.runInContext('JSON.stringify(potRaisePresets(game,player))',context));}};
}
const seats=html=>[...html.matchAll(/data-seat="(\d+)"/g)].map(m=>Number(m[1]));
const rows=v=>[seats(v.elements.get('playersTop').innerHTML),seats(v.elements.get('playersBottom').innerHTML)];

test('every viewer sees one identical clockwise seat ring, including sparse IDs and departed seats',()=>{
  const v=view(),ids=[0,2,3,5,6,9,11,15];
  for(let count=2;count<=8;count++){
    const game=E.createGame(ids.slice(0,count).map(id=>({id,name:'玩家'+id,chips:2000})),20,{blindMode:'standard'});
    E.startHand(game,()=>.42);const expected=ids.slice(0,count);
    let baseline;
    for(const player of game.players){
      v.render(game,player.id);const pair=rows(v);
      assert.deepEqual([...pair[0],...pair[1].slice().reverse()],expected);
      if(baseline)assert.deepEqual(pair,baseline);else baseline=pair;
      const cards=[v.elements.get('playersTop').innerHTML,v.elements.get('playersBottom').innerHTML].join('');
      const self=[...cards.matchAll(/class="player-card is-self[^"\n]*" data-seat="(\d+)"/g)].map(m=>Number(m[1]));
      assert.deepEqual(self,[player.id]);
    }
    Object.assign(game.players[1],{folded:true,disconnected:true,isActive:false});
    v.render(game,0);assert.deepEqual(rows(v),baseline,'leaving does not shift the remaining chairs');
  }
});

test('action highlights advance clockwise within every street for 2–8 standard-blind tables',()=>{
  const v=view();
  for(let count=2;count<=8;count++){
    const game=E.createGame(Array.from({length:count},(_,id)=>({id,name:'玩家'+id,chips:2000})),20,{blindMode:'standard'});
    E.startHand(game,()=>.42);let previous=-1,street=game.phase,steps=0;
    while(E.betting(game)){
      assert.ok(++steps<=count*4);
      const actor=game.players[game.currentPlayerIndex];
      if(game.phase===street&&previous>=0)assert.equal(actor.id,(previous+1)%count);else street=game.phase;
      for(const viewer of game.players){
        v.render(game,viewer.id);
        const rendered=v.elements.get('playersTop').innerHTML+v.elements.get('playersBottom').innerHTML;
        const active=[...rendered.matchAll(/class="player-card [^"]*\bactive\b[^"]*" data-seat="(\d+)"/g)].map(m=>Number(m[1]));
        assert.deepEqual(active,[actor.id]);
      }
      previous=actor.id;
      assert.ok(E.applyAction(game,actor.id,actor.currentBet<game.currentBet?'call':'check').ok);
    }
    assert.equal(game.phase,'hand_over');
  }
});

test('action boxes ignore stale streets and hands, preserving folded and all-in status',()=>{
  const v=view(),game=E.createGame(Array.from({length:4},(_,id)=>({id,name:'玩家'+id,chips:2000})),20,{blindMode:'standard'});E.startHand(game,()=>.42);
  game.phase='flop';game.players[0].lastAction={hand:game.handNumber,phase:'pre_flop',action:'raise',label:'上轮加注'};
  game.players[1].lastAction={hand:game.handNumber-1,phase:'flop',action:'call',label:'上一手跟注'};
  game.players[2].lastAction={hand:game.handNumber,phase:'flop',action:'check',label:'本轮过牌'};
  game.players[3].folded=true;v.render(game,0);
  const boxes=()=>[...(v.elements.get('playersTop').innerHTML+v.elements.get('playersBottom').innerHTML).matchAll(/<div class="player-action [^"]*"[^>]*>([^<]*)<\/div>/g)].map(m=>m[1]);
  assert.deepEqual(boxes().sort(),['尚未行动','尚未行动','过牌','已弃牌'].sort());
  game.players[1].allIn=true;game.phase='turn';v.render(game,0);
  assert.deepEqual(boxes().sort(),['尚未行动','已梭哈','尚未行动','已弃牌'].sort());
});

test('seat amounts take precedence over English labels and betting levels in current and older snapshots',()=>{
  const v=view(),game=E.createGame([{id:0,chips:2000},{id:1,chips:2000}],20);E.startHand(game,()=>.42);
  game.players[0].lastAction={action:'raise',hand:game.handNumber,phase:game.phase,displayAmount:180,label:'3-BET · 加注 RAISE 至 180'};
  game.players[1].lastAction={action:'allin',hand:game.handNumber,phase:game.phase,label:'4-BET · 梭哈 ALL IN 至 1960'};
  v.render(game,0);const cards=v.elements.get('playersTop').innerHTML+v.elements.get('playersBottom').innerHTML;
  assert.match(cards,/<span class="player-action-name">加注至<\/span> <strong class="player-action-amount">180<\/strong>/);
  assert.match(cards,/<span class="player-action-name">梭哈至<\/span> <strong class="player-action-amount">1960<\/strong>/);
  assert.match(cards,/title="3-BET · 加注 RAISE 至 180"/);
});

test('disabled win rate hides and clears estimates without calculating, but keeps hand information',()=>{
  const v=view(),game=E.createGame([{id:0,chips:2000},{id:1,chips:2000}],20,{showWinRate:false});E.startHand(game,()=>.42);
  vm.runInContext('calcWinRate=()=>{throw Error("Disabled odds were calculated");};',v.context);
  v.render(game,0);assert.equal(v.elements.get('winRateText').hidden,true);assert.equal(v.elements.get('winRateText').textContent,'');
  while(game.phase==='pre_flop'){const p=game.players[game.currentPlayerIndex];E.applyAction(game,p.id,p.currentBet<game.currentBet?'call':'check');}
  v.render(game,0);assert.match(v.elements.get('handTypeText').textContent,/当前:/);assert.equal(v.elements.get('winRateText').textContent,'');
  game.showWinRate=true;vm.runInContext('calcWinRate=()=>50;',v.context);v.render(game,0);assert.equal(v.elements.get('winRateText').hidden,false);assert.match(v.elements.get('winRateText').textContent,/50%/);
});

test('raise presets use pot after calling and expose legal total raise-to amounts',()=>{
  const v=view();
  const game={pot:100,currentBet:40,minRaise:20},player={currentBet:10,chips:990};
  assert.deepEqual(v.presets(game,player).map(p=>p.amount),[105,138,170,300]);
  assert.deepEqual(v.presets({pot:200,currentBet:0,minRaise:20},{currentBet:0,chips:2000}).map(p=>p.amount),[100,150,200,400]);
  assert.deepEqual(v.presets({pot:1,currentBet:40,minRaise:40},{currentBet:40,chips:2000}).map(p=>p.amount),[80,80,80,80],'minimum full raise overrides small pot fractions');
  assert.deepEqual(v.presets(game,{currentBet:10,chips:80}).map(p=>p.amount),[90,90,90,90],'presets cap at the player stack');
  const actual=E.createGame([{id:0,name:'甲',chips:2000},{id:1,name:'乙',chips:2000},{id:2,name:'丙',chips:2000}],20,{blindMode:'standard'});
  E.startHand(actual,()=>.42);const actor=actual.players[actual.currentPlayerIndex];actor.canRaise=E.canRaise(actual,actor);
  v.render(actual,actor.id,true);
  const panel=v.elements.get('actionPanel').innerHTML;
  assert.deepEqual([...panel.matchAll(/data-pot-fraction="([\d.]+)"/g)].map(m=>Number(m[1])),[.5,.75,1,2]);
  for(const preset of v.presets(actual,actor)){
    const copy=structuredClone(actual);assert.ok(E.applyAction(copy,actor.id,'raise',preset.amount).ok);
  }
});

test('raise slider uses small-blind multiples while retaining precise numeric and all-in amounts',()=>{
  const v=view();
  for(const bigBlind of [10,20,50,100]){
    const g=E.createGame([{id:0,chips:2000},{id:1,chips:2000}],bigBlind,{blindMode:'standard'});E.startHand(g);const p=g.players[g.currentPlayerIndex];p.canRaise=true;v.render(g,p.id,true);
    const panel=v.elements.get('actionPanel').innerHTML,range=panel.match(/<input type="range"[^>]+>/)[0];assert.match(range,new RegExp(`step="${bigBlind/2}"`));
    for(const attr of ['min','max'])assert.equal(Number(range.match(new RegExp(`${attr}="(\\d+)"`))[1])%(bigBlind/2),0);
  }
  const g=E.createGame([{id:0,chips:1995},{id:1,chips:2000}],20,{blindMode:'standard'});E.startHand(g);const p=g.players[g.currentPlayerIndex];p.canRaise=true;g.currentBet=77;g.minRaise=57;v.render(g,p.id,true);
  const panel=v.elements.get('actionPanel').innerHTML;assert.match(panel,/<input type="range" min="140" max="1990" step="10"/);assert.match(panel,/id="raiseAmount" type="number" min="134" max="1995"/);assert.match(panel,/id="raiseMaxBtn" onclick="RiverTable.raiseTo\(1995\)"/);
  p.chips=139-p.currentBet;v.render(g,p.id,true);assert.match(v.elements.get('actionPanel').innerHTML,/<input type="range"[^>]*disabled/);assert.match(v.elements.get('actionPanel').innerHTML,/RiverTable.raiseTo\(139\)/);
});

test('raise panel disappears when full raises are unavailable and never bypasses short-all-in restrictions',()=>{
  const v=view(),game=E.createGame([{id:0,name:'甲',chips:2000},{id:1,name:'乙',chips:2000},{id:2,name:'丙',chips:2000}],20,{blindMode:'standard'});
  E.startHand(game,()=>.42);const actor=game.players[game.currentPlayerIndex];
  actor.canRaise=false;v.render(game,actor.id,true);
  assert.doesNotMatch(v.elements.get('actionPanel').innerHTML,/raise-presets|action-raise|action-allin/);
  actor.canRaise=true;actor.chips=game.currentBet+game.minRaise-actor.currentBet-1;v.render(game,actor.id,true);
  assert.doesNotMatch(v.elements.get('actionPanel').innerHTML,/raise-presets|action-raise/);
  assert.match(v.elements.get('actionPanel').innerHTML,/action-allin/);
});
