'use strict';
const E=require('./public/poker-engine');
const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
const BASE=15**5;
function pack(category,ranks){let value=category;for(let i=0;i<5;i++)value=value*15+(ranks[i]||0);return value;}
function straight(mask,variant){
  for(let high=14;high>=(variant==='short'?10:6);high--){const run=31<<(high-4);if((mask&run)===run)return high;}
  const wheel=variant==='short'?[14,9,8,7,6]:[14,5,4,3,2];return wheel.every(r=>mask&(1<<r))?wheel[1]:0;
}
function top(mask,count){const out=[];for(let r=14;r>=2&&out.length<count;r--)if(mask&(1<<r))out.push(r);return out;}
// Evaluate 5–7 cards directly instead of enumerating 21 five-card combinations
// for every Monte Carlo trial. Integer scores preserve the engine's ordering.
function score(cards,variant='standard'){
  const counts=new Uint8Array(15),suits=new Uint32Array(4),suitCount=new Uint8Array(4);let mask=0;
  for(const c of cards){counts[c.rank]++;suitCount[c.suit]++;suits[c.suit]|=1<<c.rank;mask|=1<<c.rank;}
  let flush=0;for(let s=0;s<4;s++)if(suitCount[s]>=5){flush=suits[s];const high=straight(flush,variant);if(high)return pack(high===14?10:9,[high]);}
  const pairs=[],trips=[];let quad=0;for(let r=14;r>=2;r--){if(counts[r]===4)quad=r;if(counts[r]>=3)trips.push(r);if(counts[r]>=2)pairs.push(r);}
  if(quad)return pack(8,[quad,...top(mask&~(1<<quad),1)]);
  const full=trips.length&&pairs.find(r=>r!==trips[0]);
  if(flush&&variant==='short')return pack(7,top(flush,5));
  if(full)return pack(variant==='short'?6:7,[trips[0],full]);
  if(flush)return pack(6,top(flush,5));
  const high=straight(mask,variant);if(high)return pack(5,[high]);
  if(trips.length)return pack(4,[trips[0],...top(mask&~(1<<trips[0]),2)]);
  if(pairs.length>=2)return pack(3,[pairs[0],pairs[1],...top(mask&~(1<<pairs[0])&~(1<<pairs[1]),1)]);
  if(pairs.length)return pack(2,[pairs[0],...top(mask&~(1<<pairs[0]),3)]);
  return pack(1,top(mask,5));
}
function startingStrength(hole,variant){
  const [hi,lo]=hole.map(c=>c.rank).sort((a,b)=>b-a),min=variant==='short'?6:2,norm=r=>(r-min)/(14-min);
  if(hi===lo)return .55+.44*norm(hi);
  const gap=hi-lo,suited=hole[0].suit===hole[1].suit;
  return clamp(.12+.37*norm(hi)+.21*norm(lo)+(suited?.06:0)+(gap===1?.055:gap===2?.025:gap>=4?-.045:0)+(hi===14?.025:0),.05,.91);
}
function observe(g,seatId,history=[]){
  const me=g.players.find(p=>p.id===seatId);if(!me||!E.betting(g)||g.players[g.currentPlayerIndex]?.id!==seatId)throw new Error('AI is not the acting player');
  const actions=[];for(let i=history.length-1;i>=0&&actions.length<180;i--){const e=history[i];if(e.kind==='action')actions.push({seatId:e.seatId,hand:e.hand,street:e.street,action:e.action,amount:e.amount,raised:e.raised});}actions.reverse();
  // Explicit allowlist: never copy the game, its deck, private reveals, hand
  // results or any opponent holeCards into the strategy's input.
  const players=g.players.map(p=>({id:p.id,chips:p.chips,currentBet:p.currentBet,totalBet:p.totalBet,folded:!!p.folded,allIn:!!p.allIn,isActive:!!p.isActive,disconnected:!!p.disconnected,acted:!!p.acted}));
  return{seatId,handNumber:g.handNumber,phase:g.phase,variant:g.variant,blindRule:g.blindRule,pot:g.pot,currentBet:g.currentBet,minRaise:g.minRaise,bigBlind:g.bigBlind,
    dealerId:g.players[g.dealerIndex]?.id,position:g.positions?.[seatId]||null,canRaise:E.canRaise(g,me),hole:me.holeCards.map(c=>({rank:c.rank,suit:c.suit})),board:g.communityCards.map(c=>({rank:c.rank,suit:c.suit})),players,
    actions};
}
function context(view){
  const me=view.players.find(p=>p.id===view.seatId),opponents=view.players.filter(p=>p.id!==me.id&&p.isActive&&!p.folded);
  const need=Math.max(0,view.currentBet-me.currentBet),call=Math.min(me.chips,need),cap=me.totalBet+call;
  const contestable=view.players.reduce((sum,p)=>sum+Math.min(p.totalBet,cap),0);
  const foldable=opponents.filter(p=>!p.allIn&&!p.disconnected&&p.chips>0),maxOpponent=Math.max(0,...foldable.map(p=>p.chips+p.currentBet));
  const late=view.position?(view.position.postflop-1)/Math.max(1,view.players.filter(p=>p.isActive).length-1):.5;
  return{me,opponents,foldable,need,call,contestable,potOdds:call/Math.max(1,contestable+call),late,effective:Math.min(me.chips,Math.max(0,maxOpponent-me.currentBet))};
}
function equityOpponents(view,ctx){
  if(view.phase!=='pre_flop')return ctx.opponents;
  // Before the flop, unacted players have not all agreed to enter the pot.
  // Model voluntary entrants plus one/two plausible callers, rather than
  // incorrectly treating every player still waiting to act as already all-in.
  const invested=new Set(view.actions.filter(a=>a.hand===view.handNumber&&a.street==='pre_flop'&&['call','raise','allin'].includes(a.action)).map(a=>a.seatId));
  const chosen=ctx.opponents.filter(p=>invested.has(p.id)||p.allIn||p.currentBet>view.bigBlind);
  const minimum=Math.min(ctx.opponents.length,ctx.opponents.length>=5?2:1);
  const remaining=ctx.opponents.filter(p=>!chosen.includes(p)).sort((a,b)=>b.currentBet-a.currentBet);
  while(chosen.length<minimum)chosen.push(remaining.shift());return chosen;
}
function makeRangeWeight(opponent,view){
  const actions=view.actions.filter(a=>a.hand===view.handNumber&&a.seatId===opponent.id),aggressive=actions.some(a=>a.raised===true||a.action==='raise'),called=actions.some(a=>a.action==='call');
  if(!aggressive&&!called)return()=>1;
  return hole=>{
    const pre=startingStrength(hole,view.variant);
    if(view.board.length<3)return aggressive?.15+.85/(1+Math.exp(-12*(pre-.64))):.35+.65*pre;
    const category=Math.floor(score([...hole,...view.board],view.variant)/BASE);
    const pairUsesHole=hole.some(h=>view.board.some(c=>c.rank===h.rank))||hole[0].rank===hole[1].rank;
    const strength=category>=4?.95:category===3?.80:category===2?(pairUsesHole?.64:.30):.18+pre*.2;
    return aggressive?.22+.78*strength:.45+.55*strength;
  };
}
function estimateEquity(view,{samples=240,random=Math.random}={}){
  const ctx=context(view),opponents=equityOpponents(view,ctx),known=new Set([...view.hole,...view.board].map(c=>c.suit*13+c.rank));
  const available=E.createDeck(view.variant).filter(c=>!known.has(c.suit*13+c.rank)),myKnown=[...view.hole,...view.board];
  const weights=opponents.map(p=>makeRangeWeight(p,view));
  if(!opponents.length)return{equity:1,trials:0,modeledOpponents:0,exact:true};
  if(view.board.length===5&&opponents.length===1){
    const mine=score(myKnown,view.variant);let won=0,total=0;
    for(let i=0;i<available.length-1;i++)for(let j=i+1;j<available.length;j++){const hole=[available[i],available[j]],weight=weights[0](hole),other=score([...hole,...view.board],view.variant);total+=weight;won+=weight*(mine>other?1:mine===other?.5:0);}
    return{equity:won/total,trials:available.length*(available.length-1)/2,modeledOpponents:1,exact:true};
  }
  const trials=clamp(Math.floor(samples)||240,32,512);let won=0;
  for(let trial=0;trial<trials;trial++){
    const pool=available.slice(),holes=[];const take=i=>{const card=pool[i];pool[i]=pool.at(-1);pool.pop();return card;};
    for(let index=0;index<opponents.length;index++){
      let i,j,hole;for(let attempt=0;attempt<6;attempt++){i=Math.floor(random()*pool.length);j=Math.floor(random()*(pool.length-1));if(j>=i)j++;hole=[pool[i],pool[j]];if(random()<=weights[index](hole))break;}
      holes.push(hole);take(Math.max(i,j));take(Math.min(i,j));
    }
    const board=view.board.slice();while(board.length<5)board.push(take(Math.floor(random()*pool.length)));
    const mine=score([...view.hole,...board],view.variant);let ties=1,lost=false;
    for(const hole of holes){const other=score([...hole,...board],view.variant);if(other>mine){lost=true;break;}if(other===mine)ties++;}
    if(!lost)won+=1/ties;
  }
  return{equity:won/trials,trials,modeledOpponents:opponents.length,exact:false};
}
function drawInfo(view){
  const cards=[...view.hole,...view.board],used=new Set(cards.map(c=>c.suit*13+c.rank)),outs=new Set(),boardRanks=new Set(view.board.map(c=>c.rank));
  if(view.board.length<3||view.board.length>=5)return{outs:0,flush:false,straight:false};
  let flush=false,straightDraw=false;const min=view.variant==='short'?6:2;
  for(let suit=0;suit<4;suit++)if(cards.filter(c=>c.suit===suit).length===4&&view.hole.some(c=>c.suit===suit)){
    flush=true;for(let rank=min;rank<=14;rank++)if(!used.has(suit*13+rank))outs.add(suit*13+rank);
  }
  const ranks=new Set(cards.map(c=>c.rank)),runs=[];for(let high=14;high>=min+4;high--)runs.push(Array.from({length:5},(_,i)=>high-i));runs.push(view.variant==='short'?[14,9,8,7,6]:[14,5,4,3,2]);
  for(const run of runs){const missing=run.filter(r=>!ranks.has(r));if(missing.length===1&&view.hole.some(c=>run.includes(c.rank)&&!boardRanks.has(c.rank))){straightDraw=true;for(let s=0;s<4;s++)if(!used.has(s*13+missing[0]))outs.add(s*13+missing[0]);}}
  return{outs:outs.size,flush,straight:straightDraw};
}
function analyze(view,options={}){
  const ctx=context(view),estimate=estimateEquity(view,options),suits=view.board.reduce((a,c)=>(a[c.suit]=(a[c.suit]||0)+1,a),{}),ranks=view.board.map(c=>c.rank).sort((a,b)=>a-b);
  const connected=ranks.some((r,i)=>i>=2&&r-ranks[i-2]<=4),wet=Math.max(0,...Object.values(suits))>=2||connected;
  const current=view.actions.filter(a=>a.hand===view.handNumber),raises=current.filter(a=>a.street===view.phase&&(a.raised===true||a.action==='raise'));
  const priorAggressor=current.filter(a=>a.raised===true||a.action==='raise').at(-1)?.seatId;
  const folds=ctx.opponents.map(p=>{const history=view.actions.filter(a=>a.seatId===p.id);return clamp((3+history.filter(a=>a.action==='fold').length)/(10+history.length),.12,.6);});
  const foldEquity=folds.reduce((a,b)=>a*b,1),blocker=view.hole.some(c=>c.rank===14&&(view.board.filter(b=>b.suit===c.suit).length>=3||view.phase==='river'));
  return{...ctx,...estimate,draw:drawInfo(view),wet,raises:raises.length,priorAggressor,foldEquity,blocker,starting:startingStrength(view.hole,view.variant)};
}
function chooseAction(view,a,random=Math.random){
  const roll=random(),style=1+((view.seatId%3)-1)*.06,pre=view.phase==='pre_flop',hasAllIn=a.opponents.some(p=>p.allIn),crowded=a.opponents.length>2;
  const free=a.need===0,pass=()=>({action:free?'check':'call',reason:free?'check':'pot_odds_call'}),fold=()=>({action:'fold',reason:'insufficient_equity'});
  function raise(reason,fraction=.55){
    const me=a.me,min=view.currentBet+view.minRaise,stack=me.currentBet+me.chips,cover=Math.min(stack,Math.max(0,...a.foldable.map(p=>p.chips+p.currentBet)));
    if(!view.canRaise||cover<=view.currentBet)return null;
    let target;
    if(pre){const limpers=view.players.filter(p=>p.id!==me.id&&p.acted&&p.currentBet===view.bigBlind).length;target=view.currentBet<=view.bigBlind?(2.6+limpers)*view.bigBlind:view.currentBet*(a.late>.65?2.6:3.1);}
    else target=view.currentBet+Math.max(view.bigBlind,(a.contestable+a.call)*fraction);
    // Avoid meaningless overbets into a short stack. A short raise is legal
    // only when it is the actor's own complete all-in.
    target=Math.round(Math.min(Math.max(target,min),stack,Math.max(min,cover)));
    if(target<=view.currentBet)return null;
    const aggressive=reason==='value_bet'||reason==='preflop_value';
    if(aggressive&&a.equity>.72&&stack<=target*1.35)target=stack;
    if(target<min&&target!==stack)return null;
    if(!aggressive&&((target-me.currentBet)>me.chips*.35||hasAllIn))return null;
    return{action:target===stack?'allin':'raise',amount:target,reason};
  }
  const valueThreshold=Math.max(.43,1/(a.modeledOpponents+1)+.20);
  const required=a.potOdds+.025+(crowded?.015:0)+(a.call/Math.max(1,a.me.chips))*.025-a.late*.012;
  // First-in ranges use position as well as probability; eight unacted seats
  // must not cause premium pairs to be folded against one likely caller.
  if(pre&&view.currentBet<=view.bigBlind&&a.call<=view.bigBlind){
    const opening=.67-.10*a.late+(crowded?.025:0);
    if(a.starting>.90||a.starting>=opening&&roll<.80*style){const move=raise('preflop_value');if(move)return move;}
    if(a.late>.70&&a.starting>.46&&a.raises===0&&!hasAllIn&&roll<.09*style){const move=raise('position_steal',.45);if(move)return move;}
    if(a.starting>.86)return pass();
  }
  if(pre&&a.starting>.96&&a.call>0){const move=raise('preflop_value');return move||pass();}
  const canBluff=view.canRaise&&!hasAllIn&&a.foldable.length===a.opponents.length&&a.raises<2;
  if(canBluff&&!pre&&a.draw.outs>=4&&a.equity>.17&&Math.floor(score([...view.hole,...view.board],view.variant)/BASE)<=2){
    const frequency=(free?.19:.10)+Math.min(a.draw.outs,12)*.012;
    if(roll<frequency*(crowded?.35:1)*style&&(free||a.call<=(a.contestable+a.call)*.38)){const move=raise('semi_bluff',.55);if(move)return move;}
  }
  if(a.equity>valueThreshold&&(free||a.equity>Math.max(.70,required+.17))&&roll<(a.equity>.86?.94:.77)*style){const move=raise('value_bet',a.wet?.75:a.equity>.86?.78:.55);if(move)return move;}
  if(free){
    if(!pre&&a.equity>Math.max(.34,1/(a.opponents.length+1)+.06)&&roll<.31*style){const move=raise('thin_value',.38);if(move)return move;}
    if(canBluff&&!pre&&a.opponents.length<=2){
      const continuation=a.priorAggressor===view.seatId&&!a.wet;
      const frequency=(continuation?.28:.09)+(a.late>.65?.035:0)+(a.blocker?.045:0);
      const size=continuation?.42:a.blocker?.58:.38,fe=clamp(a.foldEquity+.04,0,.7),ev=fe*a.contestable+(1-fe)*(a.equity*(a.contestable*(1+2*size))-a.contestable*size);
      if(ev>=0&&roll<frequency*(a.opponents.length>1?.35:1)*style){const move=raise(continuation?'continuation_bet':'bluff',size);if(move)return move;}
    }
    return pass();
  }
  if(canBluff&&!pre&&a.opponents.length===1&&a.blocker&&a.equity>.08&&a.equity<required&&a.late>.65&&a.call<=(a.contestable+a.call)*.30&&roll<.025*style){const move=raise('bluff_raise',.65);if(move)return move;}
  if(a.equity>=required)return pass();
  // Close calls occasionally mix, but never pay a bad price with no equity.
  if(a.equity>.10&&a.equity>=a.potOdds-.01&&a.call<=a.me.chips*.12&&roll<.22)return pass();
  return fold();
}
function decide(view,options={}){
  const analysis=analyze(view,options),decision=chooseAction(view,analysis,options.random||Math.random);
  return{...decision,metrics:{equity:analysis.equity,potOdds:analysis.potOdds,trials:analysis.trials,outs:analysis.draw.outs,modeledOpponents:analysis.modeledOpponents,exact:analysis.exact}};
}
module.exports={observe,score,startingStrength,estimateEquity,drawInfo,analyze,chooseAction,decide};
