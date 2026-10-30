(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PokerEngine = api;
})(globalThis, function() {
  'use strict';
  const HAND_NAMES = {10:'皇家同花顺',9:'同花顺',8:'四条',7:'葫芦',6:'同花',5:'顺子',4:'三条',3:'两对',2:'一对',1:'高牌'};
  function createDeck(variant = 'standard') {
  const d = [];
  for (let s=0;s<4;s++) for (let r=variant==='short'?6:2;r<=14;r++) d.push({suit:s, rank:r, id:s*13+(r-2)});
  return d;
}
function shuffle(deck, random = Math.random) {
  const a=[...deck];
  for (let i=a.length-1;i>0;i--) { const j=Math.floor(random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; }
  return a;
}
function getCombos(arr, k) {
  const result=[], combo=[];
  (function bt(start) {
    if (combo.length===k) { result.push([...combo]); return; }
    for (let i=start;i<arr.length;i++) { combo.push(arr[i]); bt(i+1); combo.pop(); }
  })(0);
  return result;
}
function eval5(cards, variant = 'standard') {
  const sorted=[...cards].sort((a,b)=>b.rank-a.rank);
  const ranks=sorted.map(c=>c.rank), suits=sorted.map(c=>c.suit);
  const freq={}; ranks.forEach(r=>freq[r]=(freq[r]||0)+1);
  const groups=Object.entries(freq).map(([r,c])=>({rank:parseInt(r),count:c})).sort((a,b)=>b.count-a.count||b.rank-a.rank);
  const isFlush=suits.every(s=>s===suits[0]);
  const ur=[...new Set(ranks)].sort((a,b)=>b-a);
  let isStraight=false, sh=0;
  if (ur.length===5) {
    if (ur[0]-ur[4]===4) { isStraight=true; sh=ur[0]; }
    else if (variant==='short'&&ur.join(',')==='14,9,8,7,6') { isStraight=true;sh=9; }
    else if (variant!=='short'&&ur[0]===14&&ur[1]===5&&ur[4]===2) { isStraight=true; sh=5; }
  }
  if (isFlush&&isStraight&&sh===14) return {rank:10,name:HAND_NAMES[10],tb:[14]};
  if (isFlush&&isStraight) return {rank:9,name:HAND_NAMES[9],tb:[sh]};
  if (groups[0].count===4) return {rank:8,name:HAND_NAMES[8],tb:[groups[0].rank,groups[1]?groups[1].rank:0]};
  if (groups[0].count===3&&groups[1]&&groups[1].count===2) return {rank:variant==='short'?6:7,name:HAND_NAMES[7],tb:[groups[0].rank,groups[1].rank]};
  if (isFlush) return {rank:variant==='short'?7:6,name:HAND_NAMES[6],tb:ranks};
  if (isStraight) return {rank:5,name:HAND_NAMES[5],tb:[sh]};
  if (groups[0].count===3) return {rank:4,name:HAND_NAMES[4],tb:[groups[0].rank,...groups.slice(1).map(g=>g.rank).sort((a,b)=>b-a)]};
  if (groups[0].count===2&&groups[1]&&groups[1].count===2) return {rank:3,name:HAND_NAMES[3],tb:[groups[0].rank,groups[1].rank,groups[2]?groups[2].rank:0]};
  if (groups[0].count===2) return {rank:2,name:HAND_NAMES[2],tb:[groups[0].rank,...groups.slice(1).map(g=>g.rank).sort((a,b)=>b-a)]};
  return {rank:1,name:HAND_NAMES[1],tb:ranks};
}
function evalBest(cards, variant = 'standard') {
  if (cards.length<5) return null;
  let best=null;
  for (const c of getCombos(cards,5)) {
    const r=eval5(c,variant);
    if (!best||cmpHand(r,best)>0) best=r;
  }
  return best;
}
function cmpHand(a,b) {
  if (a.rank!==b.rank) return a.rank>b.rank?1:-1;
  for (let i=0;i<Math.max(a.tb.length,b.tb.length);i++) {
    const av=a.tb[i]||0,bv=b.tb[i]||0;
    if (av!==bv) return av>bv?1:-1;
  }
  return 0;
}



  const betting = g => ['pre_flop','flop','turn','river'].includes(g.phase);
  const live = p => p.isActive && !p.folded;
  const actionable = p => live(p) && !p.allIn && !p.disconnected && p.chips > 0;
  function nextIndex(g, from, predicate) {
    for (let step=1; step<=g.players.length; step++) {
      const index = (from + step + g.players.length) % g.players.length;
      if (predicate(g.players[index])) return index;
    }
    return -1;
  }
  function createGame(players, bigBlind, options = {}) {
    return { players: players.slice().sort((a,b)=>a.id-b.id).map(p => ({ ...p, holeCards: [], currentBet: 0, totalBet: 0, eliminatedHand: null, eliminationStack: null,
      initialChips:p.chips,bankDebt:0,totalBorrowed:0,totalRepaid:0,bankVersion:0,lastBankRequest:null,chipsAfterHand:null })),
      allowBuyIn:options.allowBuyIn===true,hostSeatId:options.hostSeatId??0,endRequested:false,bankLog:[],bankSequence:0,
      autoDeck:options.autoDeck===true,deckMode:options.deckMode||'auto',variant:'standard',blindMode:options.blindMode||'auto',blindRule:'standard',blindSeats:null,runTwiceEnabled:options.runTwiceEnabled===true,
      initialTotal:players.reduce((sum,p)=>sum+p.chips,0),
      deck: [], communityCards: [], pot: 0, currentBet: 0, minRaise: bigBlind,
      smallBlind: Math.floor(bigBlind/2), bigBlind, phase: 'waiting', dealerIndex: -1,
      currentPlayerIndex: -1, handNumber: 0, revision: 0, winners: [], pots: [], nextHandReady: [], lastBigBlindId: null };
  }
  function confirmationPlayers(g) { return g.players.filter(p=>!p.isAI&&!p.disconnected&&p.connected!==false); }
  function allConfirmed(g) { return confirmationPlayers(g).every(p=>(g.nextHandReady||[]).includes(p.id)); }
  function confirmNextHand(g, seatId, handNumber) {
    if (!g || g.phase!=='hand_over' || handNumber!==g.handNumber || !confirmationPlayers(g).some(p=>p.id===seatId)) return false;
    if (!g.nextHandReady.includes(seatId)) g.nextHandReady.push(seatId);
    return true;
  }
  function commit(g, p, amount) {
    p.chips -= amount; p.currentBet += amount; p.totalBet += amount; g.pot += amount;
    p.allIn = p.chips === 0;
  }
  function assignPositions(g){
    const active=g.players.filter(p=>p.isActive),button=g.players[g.dealerIndex],n=active.length,buttonIndex=active.indexOf(button);
    const around=Array.from({length:n},(_,i)=>active[(buttonIndex+i)%n]);
    const labels={2:['BTN/SB','BB'],3:['BTN','SB','BB'],4:['CO','BTN','SB','BB'],5:['UTG','CO','BTN','SB','BB'],6:['UTG','HJ','CO','BTN','SB','BB'],7:['UTG','LJ','HJ','CO','BTN','SB','BB'],8:['UTG','UTG+1','LJ','HJ','CO','BTN','SB','BB'],9:['UTG','UTG+1','UTG+2','LJ','HJ','CO','BTN','SB','BB']}[n];
    const first=g.blindRule==='ante'?1:n===2?0:g.blindRule==='position'?2:3;
    const pre=Array.from({length:n},(_,i)=>around[(first+i)%n].id),post=Array.from({length:n},(_,i)=>around[(1+i)%n].id);
    const descriptions={UTG:'枪口位','UTG+1':'枪口＋1','UTG+2':'枪口＋2',LJ:'低劫持位',HJ:'劫持位',CO:'截止位',BTN:'庄位 / 按钮位',SB:'小盲位',BB:'大盲位','BTN/SB':'庄位 / 小盲位'};
    const standardFirst=n===2?0:3;g.positions={};
    for(let i=0;i<n;i++){
      const p=around[(standardFirst+i)%n];let label=labels?.[i]||'P'+(i+1);
      if(g.blindRule==='ante'){const offset=around.indexOf(p);label=offset===0?'BTN':'BTN+'+offset;}
      else if(g.blindRule==='position'&&n>2){if(p===around[1])label='BB';if(p===around[2])label='SB';}
      g.positions[p.id]={label,description:descriptions[label]||(label.startsWith('BTN+')?'庄家左手第 '+label.slice(4)+' 位':'座位'),preflop:pre.indexOf(p.id)+1,postflop:post.indexOf(p.id)+1};
    }
    g.actionOrder={preflop:pre,postflop:post};
  }
  function startHand(g, random = Math.random) {
    if (!['waiting','hand_over'].includes(g.phase) || g.endRequested) return false;
    if (g.phase==='hand_over' && !allConfirmed(g)) return false;
    if (g.players.filter(p=>!p.disconnected&&p.connected!==false&&(p.chips>0||(g.allowBuyIn&&p.isAI))).length<2) return false;
    if(g.allowBuyIn)for(const p of g.players) {
      if(p.isAI&&!p.disconnected&&p.chips===0)bankTransaction(g,p.id,'borrow',p.initialChips,{handNumber:g.handNumber,bankVersion:p.bankVersion,requestId:`ai-${g.handNumber}-${p.id}`});
    }
    const participating=g.players.filter(p=>p.chips>0&&!p.disconnected&&p.connected!==false);
    if(participating.length<2)return false;
    g.variant=g.deckMode==='short'?'short':g.deckMode==='standard'?'standard':g.autoDeck&&participating.length<=4?'short':'standard';
    g.blindRule=g.blindMode==='ante'||(g.blindMode==='auto'&&g.variant==='short')?'ante':g.blindMode==='position'?'position':'standard';g.blindSeats=null;
    g.runoutVote=null;g.runoutDecision=false;g.runoutBoards=null;g.peekRequests=[];g.privateReveals={};g.tips=[];
    g.handNumber++; g.revision++; g.deck=shuffle(createDeck(g.variant), random); g.communityCards=[];
    g.pot=0; g.currentBet=g.bigBlind; g.minRaise=g.bigBlind;
    g.phase='pre_flop'; g.winners=[]; g.pots=[]; g.nextHandReady=[];
    for (const p of g.players) Object.assign(p, { holeCards: [], currentBet: 0, totalBet: 0,
      folded: !!p.disconnected||p.connected===false, allIn: false, handResult: null, handResults:null, isActive: p.chips>0&&!p.disconnected&&p.connected!==false,
      lastAction:null,
      chipsBeforeHand: p.chips, chipsAfterHand:null, acted: false, lastActionBet: null, showFolded: false });
    g.dealerIndex=nextIndex(g,g.dealerIndex,live);
    const headsUp = g.players.filter(live).length===2;
    if (g.blindRule!=='ante' && headsUp && g.handNumber>1 && g.players[nextIndex(g,g.dealerIndex,live)].id===g.lastBigBlindId) g.dealerIndex=nextIndex(g,g.dealerIndex,live);
    assignPositions(g);
    for (let round=0; round<2; round++) {
      let index=g.dealerIndex;
      for (let step=0; step<g.players.filter(live).length; step++) {
        index=nextIndex(g,index,live); g.players[index].holeCards.push(g.deck.pop());
      }
    }
    if(g.blindRule==='ante') {
      g.lastBigBlindId=null;
      for(const p of g.players.filter(live)){commit(g,p,Math.min(g.bigBlind,p.chips));p.currentBet=0;}
      const button=g.players[g.dealerIndex];commit(g,button,Math.min(g.bigBlind,button.chips));
      g.currentPlayerIndex=g.dealerIndex;advance(g);return true;
    }
    const first=nextIndex(g,g.dealerIndex,live);
    const sb=g.blindRule==='position'?nextIndex(g,first,live):headsUp?g.dealerIndex:first;
    const bb=g.blindRule==='position'?first:nextIndex(g,sb,live);
    g.blindSeats={full:g.players[bb].id,half:g.players[sb].id};
    g.lastBigBlindId=g.players[bb].id;
    commit(g,g.players[sb],Math.min(g.smallBlind,g.players[sb].chips));
    commit(g,g.players[bb],Math.min(g.bigBlind,g.players[bb].chips));
    g.currentPlayerIndex=bb;
    advance(g);
    return true;
  }
  function canRaise(g,p) {
    return actionable(p) && g.players.some(other=>other!==p&&actionable(other)) &&
      (!p.acted || p.lastActionBet===null || g.currentBet-p.lastActionBet>=g.minRaise);
  }
  function minimumRaiseTo(g) { return g.currentBet+g.minRaise; }
  function applyAction(g, seatId, action, amount, expected) {
    if (!g || !betting(g)) return { ok:false, message:'本局已经结束' };
    if (expected && (expected.handNumber!==g.handNumber || expected.revision!==g.revision)) return { ok:false, message:'牌局已更新，请按当前状态操作' };
    const p=g.players[g.currentPlayerIndex];
    if (!p || p.id!==seatId || !actionable(p)) return { ok:false, message:'尚未轮到你行动' };
    const need=Math.max(0,g.currentBet-p.currentBet);
    let total=p.currentBet;
    if (action==='fold') p.folded=true;
    else if (action==='check') {
      if (need>0) return { ok:false, message:'当前需要跟注，不能过牌' };
    } else if (action==='call') total+=Math.min(need,p.chips);
    else if (action==='raise' || action==='allin') {
      total=action==='allin'?p.currentBet+p.chips:amount;
      if (!Number.isSafeInteger(total) || total<=p.currentBet || total>p.currentBet+p.chips) return { ok:false, message:'下注金额无效' };
      if (total>g.currentBet) {
        if (!canRaise(g,p)) return { ok:false, message:'当前不能再次加注，只能跟注或弃牌' };
        if (total<minimumRaiseTo(g) && total!==p.currentBet+p.chips) return { ok:false, message:'加注未达到最小额度' };
      } else if (action==='raise') return { ok:false, message:'加注必须高于当前下注' };
    } else return { ok:false, message:'未知操作' };
    const oldBet=g.currentBet;
    commit(g,p,total-p.currentBet);
    if (p.currentBet>oldBet) {
      const raise=p.currentBet-oldBet;
      if (raise>=g.minRaise) g.minRaise=raise;
      g.currentBet=p.currentBet;
    }
    p.acted=true;
    p.lastActionBet=action==='check' && oldBet===0 ? null : g.currentBet;
    g.revision++;
    advance(g);
    return { ok:true };
  }
  function advance(g) {
    if (!betting(g)) return;
    const contenders=g.players.filter(live);
    if (contenders.length<=1) { settle(g,false); return; }
    const actors=g.players.filter(actionable);
    if (actors.length<=1 && actors.every(p=>p.currentBet>=g.currentBet)) { runout(g); return; }
    const pending=p=>actionable(p)&&(!p.acted||p.currentBet<g.currentBet);
    const next=nextIndex(g,g.currentPlayerIndex,pending);
    if (next<0) { endRound(g); return; }
    g.currentPlayerIndex=next;
  }
  function dealStreet(g) {
    g.deck.pop();
    const count=g.communityCards.length===0?3:1;
    for (let i=0;i<count;i++) g.communityCards.push(g.deck.pop());
    g.phase=({3:'flop',4:'turn',5:'river'})[g.communityCards.length];
  }
  function endRound(g) {
    if (g.phase==='river') { settle(g,true); return; }
    for (const p of g.players) { p.currentBet=0; p.acted=false; p.lastActionBet=null; }
    g.currentBet=0; g.minRaise=g.bigBlind;
    dealStreet(g);
    g.currentPlayerIndex=g.dealerIndex;
    advance(g);
  }
  function runout(g) {
    if(g.runTwiceEnabled&&!g.runoutDecision&&g.communityCards.length<5&&g.players.filter(live).length>1){
      g.phase='runout_vote';g.currentPlayerIndex=-1;
      g.runoutVote={handNumber:g.handNumber,eligibleIds:g.players.filter(live).map(p=>p.id),yesIds:[],expiresAt:0};return;
    }
    while (g.communityCards.length<5) dealStreet(g);
    settle(g,true);
  }
  function resolveRunout(g,twice){
    if(g.phase!=='runout_vote')return false;
    const prefix=[...g.communityCards],boards=[];
    // Continue both boards from the same exposed prefix, using one shared deck.
    for(let run=0;run<(twice?2:1);run++){
      const board=[...prefix];
      while(board.length<5){g.deck.pop();const count=board.length===0?3:1;for(let i=0;i<count;i++){const card=g.deck.pop();if(!card)throw new Error('Insufficient cards for runout');board.push(card);}}
      boards.push(board);
    }
    g.runoutDecision=true;g.runoutBoards=twice?boards:null;g.communityCards=boards[0];g.runoutVote=null;g.revision++;settle(g,true);return true;
  }
  function settle(g,showdown=true) {
    if (g.phase==='hand_over') return;
    const contenders=g.players.filter(live);
    const boards=g.runoutBoards||[g.communityCards];
    if (showdown) for (const p of contenders) {p.handResults=boards.map(board=>evalBest([...p.holeCards,...board],g.variant));p.handResult=p.handResults[0];}
    // Return unmatched chips before splitting main and side pots.
    const contributions=g.players.slice().sort((a,b)=>b.totalBet-a.totalBet);
    if (contributions.length>1 && contributions[0].totalBet>contributions[1].totalBet) {
      const p=contributions[0], refund=p.totalBet-contributions[1].totalBet;
      p.chips+=refund; p.totalBet-=refund; g.pot-=refund;
      p.currentBet=Math.max(0,p.currentBet-refund);
    }
    const levels=[...new Set(g.players.map(p=>p.totalBet).filter(Boolean))].sort((a,b)=>a-b);
    const won=new Set(); g.pots=[];
    const layers=[];
    let previous=0;
    for (const level of levels) {
      const contributors=g.players.filter(p=>p.totalBet>=level);
      const amount=(level-previous)*contributors.length;
      const eligible=showdown?contributors.filter(live):contenders;
      previous=level;
      if (!eligible.length) {
        for (const p of contributors) p.chips+=amount/contributors.length;
        continue;
      }
      // A folded contribution alone does not create a distinct side pot.
      const last=layers[layers.length-1];
      if(last && last.eligible.length===eligible.length && last.eligible.every((p,i)=>p===eligible[i])) last.amount+=amount;
      else layers.push({amount,eligible});
    }
    for(const {amount,eligible} of layers) {
      const runs=[],combined=new Map();
      for(let index=0;index<boards.length;index++){
        const portion=boards.length===1?amount:index===0?Math.ceil(amount/2):Math.floor(amount/2);
        let winners=[];
        if(!showdown)winners=contenders;
        else for(const p of eligible){const score=p.handResults[index];if(!winners.length||cmpHand(score,winners[0].handResults[index])>0)winners=[p];else if(cmpHand(score,winners[0].handResults[index])===0)winners.push(p);}
        const share=Math.floor(portion/winners.length);let odd=portion%winners.length;
        const order=g.players.map((_,i)=>g.players[(g.dealerIndex+1+i)%g.players.length]).filter(p=>winners.includes(p));
        const awards=order.map(p=>({seatId:p.id,amount:share+(odd-->0?1:0)}));
        for(const award of awards){g.players.find(p=>p.id===award.seatId).chips+=award.amount;if(award.amount>0){won.add(award.seatId);combined.set(award.seatId,(combined.get(award.seatId)||0)+award.amount);}}
        runs.push({index,amount:portion,winners:winners.map(p=>p.id),awards});
      }
      g.pots.push({amount,winners:[...combined.keys()],awards:[...combined].map(([seatId,amount])=>({seatId,amount})),...(boards.length>1?{boards:runs}:{})});
    }
    for(const p of g.players) {
      p.chipsAfterHand=p.chips;
      if(!g.allowBuyIn && p.chips===0 && p.chipsBeforeHand>0 && p.eliminatedHand==null) {
        p.eliminatedHand=g.handNumber;p.eliminationStack=p.chipsBeforeHand;
      }
    }
    g.winners=[...won];
    g.pot=0; g.phase='hand_over'; g.currentPlayerIndex=-1; g.nextHandReady=[];
    if(g.allowBuyIn&&g.endRequested)finalizeSession(g);
  }
  function disconnect(g,seatId) {
    const p=g.players.find(p=>p.id===seatId);
    if (!p || p.disconnected) return;
    p.disconnected=true;
    if (betting(g)) {
      if (!p.allIn) p.folded=true;
      g.revision++;
      // Preserve the current player's turn when somebody else leaves.
      if (g.players[g.currentPlayerIndex]===p || g.players.filter(live).length<=1) advance(g);
      else if (g.players.filter(actionable).length<=1) {
        const actor=g.players.find(actionable);
        if (!actor || actor.currentBet>=g.currentBet) runout(g);
      }
    }
  }
  function standings(g) {
    if(g.allowBuyIn) {
      const sorted=g.players.map(p=>({...p,netChips:p.chips-p.bankDebt,netProfit:p.chips-p.bankDebt-p.initialChips})).sort((a,b)=>b.netChips-a.netChips);
      return sorted.map((p,i)=>({...p,place:i>0&&p.netChips===sorted[i-1].netChips?sorted.findIndex(other=>other.netChips===p.netChips)+1:i+1}));
    }
    const category=p=>p.chips>0?(p.disconnected?2:0):1;
    const compare=(a,b)=>category(a)-category(b) || (a.chips===0&&b.chips===0
      ?(b.eliminatedHand??-1)-(a.eliminatedHand??-1)||(b.eliminationStack??0)-(a.eliminationStack??0)
      :b.chips-a.chips);
    const sorted=g.players.slice().sort(compare),ranked=[];
    sorted.forEach((p,i)=>ranked.push({...p,place:i>0&&compare(sorted[i-1],p)===0?ranked[i-1].place:i+1}));
    return ranked;
  }
  function bankTransaction(g,seatId,kind,amount,expected) {
    const fail=message=>({ok:false,message});
    if(!g||!g.allowBuyIn)return fail('本场未开启买入和银行');
    if(!['waiting','hand_over'].includes(g.phase)||g.endRequested)return fail('银行仅在每手结束后开放；整场结算后不可操作');
    const p=g.players.find(p=>p.id===seatId);
    if(!p||p.disconnected)return fail('玩家不在本场牌局中');
    if(!['borrow','repay'].includes(kind)||!Number.isSafeInteger(amount)||amount<=0)return fail('请输入有效的正整数筹码');
    if(!expected||!Number.isSafeInteger(expected.bankVersion)||typeof expected.requestId!=='string'||expected.requestId.length>100)return fail('银行请求无效');
    if(p.lastBankRequest?.requestId===expected.requestId) {
      if(p.lastBankRequest.kind===kind&&p.lastBankRequest.amount===amount)return {ok:true,duplicate:true};
      return fail('重复请求的金额或类型不一致');
    }
    if(expected.handNumber!==g.handNumber||expected.bankVersion!==p.bankVersion)return fail('账户或牌局已更新，请核对后重试');
    if(kind==='repay'&&(amount>p.chips||amount>p.bankDebt))return fail('还款不能超过持有筹码或未还贷款');
    const delta=kind==='borrow'?amount:-amount;
    const borrowed=p.totalBorrowed+(kind==='borrow'?amount:0),repaid=p.totalRepaid+(kind==='repay'?amount:0);
    const issued=g.initialTotal+g.players.reduce((sum,other)=>sum+other.bankDebt,0)+delta;
    if(![p.chips+delta,p.bankDebt+delta,borrowed,repaid,issued,g.bankSequence+1].every(Number.isSafeInteger))return fail('金额超出可安全记录的范围');
    p.chips+=delta;p.bankDebt+=delta;p.totalBorrowed=borrowed;p.totalRepaid=repaid;p.bankVersion++;
    p.lastBankRequest={requestId:expected.requestId,kind,amount};
    g.nextHandReady=g.nextHandReady.filter(id=>id!==seatId);
    const entry={sequence:++g.bankSequence,seatId,kind,amount,handNumber:g.handNumber,debt:p.bankDebt};
    g.bankLog.push(entry);if(g.bankLog.length>60)g.bankLog.shift();
    g.revision++;
    return {ok:true,entry};
  }
  function finalizeSession(g) {
    g.phase='tournament_over';g.currentPlayerIndex=-1;g.nextHandReady=[];
  }
  function requestSessionEnd(g,seatId) {
    if(!g||!g.allowBuyIn||seatId!==g.hostSeatId||g.phase==='tournament_over')return {ok:false,message:'只有房主可以结算买入场'};
    if(g.endRequested)return {ok:true,duplicate:true};
    g.endRequested=true;g.revision++;
    if(!betting(g)&&g.phase!=='runout_vote')finalizeSession(g);
    return {ok:true};
  }
  return {createDeck,shuffle,getCombos,eval5,evalBest,cmpHand,createGame,startHand,applyAction,canRaise,minimumRaiseTo,advance,endRound,settle,resolveRunout,disconnect,betting,confirmationPlayers,allConfirmed,confirmNextHand,standings,bankTransaction,requestSessionEnd};
});
