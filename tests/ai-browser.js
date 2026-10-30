const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');const{chromium}=require('playwright');
const{server,wss,access,roomManager}=require('../server');const{passwordRecord}=require('../access');
(async()=>{
  const password='ai-browser-test-only';access.configure(await passwordRecord(password));roomManager.configureTimings({deal:120,action:40,street:120,runout:180,ai:80});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}/`,browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'}),errors=[],report=[];
  const idle=p=>p.waitForFunction(()=>!RiverSession.getDiagnostics().pending);
  async function open(code,id){const context=await browser.newContext({viewport:id?{width:390,height:844}:{width:1280,height:800}});await context.addInitScript(()=>localStorage.setItem('river_audio',JSON.stringify({music:false,sfx:false})));const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(base+(code?'#room='+code:''));await page.getByLabel('访问密码').fill(password);await page.getByRole('button',{name:'验证并进入'}).click();await page.waitForFunction(()=>!!window.RiverSession);
    if(code){await page.waitForFunction(()=>mySeatId>0);await page.locator('#readyBtn').click();await idle(page);}else{await page.locator('#createBtn').click();await page.locator('#waitTip').filter({hasText:'房间已创建'}).waitFor();await page.locator('#allowBuyInSel').selectOption('yes');await idle(page);}return page;
  }
  try{
    for(const count of[3,6,8]){
      const host=await open(null,0),code=await host.locator('#displayRoomCode').textContent(),guest=await open(code,1),humans=[host,guest];
      while(Number(await host.locator('#maxPlayersVal').textContent())!==count){const current=Number(await host.locator('#maxPlayersVal').textContent());await host.locator('.mini-btn').filter({hasText:current<count?'+':'-'}).click();await idle(host);}
      for(let seat=2;seat<count;seat++){await host.locator('#seats>.seat').nth(seat).click();await idle(host);}await host.locator('#startBtn').click();await host.waitForFunction(()=>!!g);const room=roomManager.games.get(code);
      let moves=0,aiMoves=0,raises=0;
      for(let hand=1;hand<=6;hand++){
        if(hand===6){await host.locator('#finishSessionBtn').click();await idle(host);}let steps=0,humanRaised=false;
        while(!['hand_over','tournament_over'].includes(room.game.phase)){
          assert.ok(++steps<160);const g=room.game;
          if(g.phase==='runout_vote'){
            const voter=g.runoutVote.eligibleIds.find(id=>id<2);if(voter!==undefined){await humans[voter].locator('#voteOnceBtn').click();await idle(humans[voter]);}else await host.waitForFunction(()=>g.phase!=='runout_vote');continue;
          }
          const actor=g.players[g.currentPlayerIndex],revision=g.revision;
          if(actor.isAI){await host.waitForFunction(rev=>g.revision>rev,revision,{timeout:5000});aiMoves++;}
          else{
            const page=humans[actor.id];await page.waitForFunction(rev=>(isHost?g:clientGameState).revision===rev&&!!document.querySelector('#actionPanel button'),revision);
            if(hand%3===0&&!humanRaised&&await page.locator('.action-raise').count()){await page.locator('.action-raise').click();await page.locator('.action-confirm').click();humanRaised=true;raises++;}
            else await page.locator(await page.locator('.action-check').count()?'.action-check':'.action-call').click();
            await host.waitForFunction(rev=>g.revision>rev,revision);await idle(page);
          }
          moves++;assert.equal(room.paused,false);roomManager.check(room);
          for(const page of humans){const serialized=await page.evaluate(()=>JSON.stringify(isHost?g:clientGameState));assert.ok(!serialized.includes('"metrics"')&&!serialized.includes('"equity"')&&!serialized.includes('semi_bluff'));}
        }
        const phase=room.game.phase;for(const page of humans)await page.locator(phase==='tournament_over'?'.final-ranking':'#resultScreen').waitFor({state:'visible'});roomManager.check(room);
        if(hand<6){for(let id=0;id<2;id++)if(room.game.players.find(p=>p.id===id).chips<1000){const page=humans[id];await page.locator('#bankBtn').click();await page.locator('#bankAmount').fill('2000');await page.locator('#bankBorrowBtn').click();await idle(page);await page.getByRole('button',{name:'关闭银行'}).click();}
          for(const page of humans){await page.locator('#nextHandBtn').click();await idle(page);}await host.waitForFunction(n=>g.handNumber===n,hand+1);
        }
      }
      assert.equal(room.game.phase,'tournament_over');assert.ok(aiMoves>0);assert.ok(room.history.filter(e=>e.kind==='action'&&e.seatId>=2).every(e=>!('reason'in e)&&!('equity'in e)));assert.deepEqual(errors,[]);
      report.push({players:count,humans:2,bots:count-2,hands:6,moves,aiMoves,humanRaises:raises,result:'passed'});for(const p of humans)await p.context().close();console.log(`${count} seats: 6 mixed human/AI hands passed.`);
    }
    await fs.writeFile(path.join(__dirname,'ai-browser-report.json'),JSON.stringify({testedAt:new Date().toISOString(),cases:report,result:'passed',limit:'Local independent Chrome contexts; actual WAN/mobile devices not tested'},null,2));console.log('18 mixed-client AI hands passed, with private strategy data and balanced bank accounts.');
  }finally{await browser.close();for(const ws of wss.clients)ws.terminate();await new Promise(r=>wss.close(r));await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
