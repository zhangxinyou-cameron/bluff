const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');const E=require('../public/poker-engine');const A=require('../poker-ai');
const rng=initial=>{let seed=initial;return()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296);};
(async()=>{
  const report={testedAt:new Date().toISOString(),hands:0,actions:0,doubleBoards:0,reasons:{},moves:{},configurations:[],timings:[],result:'passed'};
  for(const count of[2,3,6,8])for(const deckMode of['standard','short'])for(const blindMode of['auto','standard','ante','position']){
    const seed=count*233+deckMode.length*41+blindMode.length*5,dealRandom=rng(seed),decisionRandom=rng(seed+9999),history=[];
    const g=E.createGame(Array.from({length:count},(_,id)=>({id,name:'AI'+id,chips:2000,isAI:true})),20,{allowBuyIn:true,deckMode,blindMode,runTwiceEnabled:true});let configActions=0,maxSteps=0;
    for(let hand=1;hand<=10;hand++){
      assert.ok(E.startHand(g,dealRandom));let steps=0;
      while(E.betting(g)||g.phase==='runout_vote'){
        if(g.phase==='runout_vote'){assert.ok(E.resolveRunout(g,true));report.doubleBoards++;continue;}
        assert.ok(++steps<160,'AI hand stalled');const p=g.players[g.currentPlayerIndex],before={bet:p.currentBet,chips:p.chips,currentBet:g.currentBet,street:g.phase};
        const start=performance.now(),decision=A.decide(A.observe(g,p.id,history),{random:decisionRandom});report.timings.push(performance.now()-start);
        const paid=decision.action==='call'?Math.min(before.chips,Math.max(0,before.currentBet-before.bet)):decision.action==='allin'?before.chips:decision.action==='raise'?decision.amount-before.bet:0;
        const result=E.applyAction(g,p.id,decision.action,decision.amount,{handNumber:g.handNumber,revision:g.revision});assert.ok(result.ok,JSON.stringify({decision,result}));
        history.push({kind:'action',seatId:p.id,hand:g.handNumber,street:before.street,action:decision.action,amount:paid,raised:before.bet+paid>before.currentBet});
        report.moves[decision.action]=(report.moves[decision.action]||0)+1;report.reasons[decision.reason]=(report.reasons[decision.reason]||0)+1;report.actions++;configActions++;
        assert.equal(g.players.reduce((s,p)=>s+p.chips-p.bankDebt,0)+g.pot,g.initialTotal);assert.ok(g.players.every(p=>Number.isSafeInteger(p.chips)&&p.chips>=0&&p.bankDebt>=0));
      }
      assert.equal(g.phase,'hand_over');assert.equal(g.pot,0);assert.equal(g.players.reduce((s,p)=>s+p.chips-p.bankDebt,0),g.initialTotal);report.hands++;maxSteps=Math.max(maxSteps,steps);
    }
    report.configurations.push({players:count,deckMode,blindMode,hands:10,actions:configActions,maxSteps});
    if(report.hands%80===0)console.log(`AI simulations: ${report.hands}/320 hands passed.`);
  }
  for(const key of['fold','call','check','raise'])assert.ok(report.moves[key]>0);assert.ok(report.reasons.semi_bluff>0);assert.ok((report.reasons.bluff||0)+(report.reasons.continuation_bet||0)>0);
  const times=report.timings.sort((a,b)=>a-b);report.performanceMs={median:+times[Math.floor(times.length*.5)].toFixed(3),p95:+times[Math.floor(times.length*.95)].toFixed(3),maximum:+times.at(-1).toFixed(3)};delete report.timings;
  await fs.writeFile(path.join(__dirname,'ai-simulation-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({hands:report.hands,actions:report.actions,reasons:report.reasons,performanceMs:report.performanceMs}));
})().catch(error=>{console.error(error);process.exitCode=1;});
