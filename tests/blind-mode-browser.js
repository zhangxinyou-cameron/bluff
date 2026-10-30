const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');const{chromium}=require('playwright');
const{server,wss,access,roomManager}=require('../server');const{passwordRecord}=require('../access');
(async()=>{
  const password='blind-mode-test-only';access.configure(await passwordRecord(password));roomManager.configureTimings({deal:90,action:25,street:80,runout:150});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}/`;
  const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'}),errors=[],report=[];
  const idle=p=>p.waitForFunction(()=>!RiverSession.getDiagnostics().pending);
  async function open(code,id){const context=await browser.newContext({viewport:id%2?{width:390,height:844}:{width:1280,height:800}});await context.addInitScript(()=>localStorage.setItem('river_audio',JSON.stringify({music:false,sfx:false})));const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(base+(code?'#room='+code:''));await page.getByLabel('访问密码').fill(password);await page.getByRole('button',{name:'验证并进入'}).click();await page.waitForFunction(()=>!!window.RiverSession);if(code){await page.waitForFunction(()=>typeof mySeatId!=='undefined'&&mySeatId>0);await page.locator('#readyBtn').click();await idle(page);}else{await page.locator('#createBtn').click();await page.locator('#waitTip').filter({hasText:'房间已创建'}).waitFor();await page.locator('#allowBuyInSel').selectOption('yes');await idle(page);await page.locator('#blindModeSel').selectOption('position');await idle(page);await page.locator('#deckModeSel').selectOption('short');await idle(page);}return page;}
  try{
    for(const count of[2,6,8]){
      const host=await open(null,0),code=await host.locator('#displayRoomCode').textContent(),pages=[host];for(let id=1;id<count;id++)pages.push(await open(code,id));await host.locator('#startBtn').click();const room=roomManager.games.get(code);
      for(const [index,mode]of['position','standard','ante','auto'].entries()){
        const g=room.game;assert.equal(g.handNumber,index+1);const rule=mode==='auto'?(count<=4?'ante':'standard'):mode;
        assert.equal(g.blindRule,rule);assert.equal(g.pot,rule==='ante'?(count+1)*20:30);
        if(rule==='position'){assert.equal(g.players.find(p=>p.id===g.blindSeats.full).totalBet,20);assert.equal(g.players.find(p=>p.id===g.blindSeats.half).totalBet,10);}
        if(mode==='standard'&&count===6)assert.deepEqual(g.actionOrder.preflop.map(id=>g.positions[id].label),['UTG','HJ','CO','BTN','SB','BB']);
        for(const page of pages){await page.waitForFunction(n=>(isHost?g:clientGameState)?.handNumber===n,index+1);assert.equal(await page.locator('#tableBlindMode').isDisabled(),true);}
        let actions=0;while(g.phase!=='hand_over'){
          assert.ok(++actions<100);const p=g.players[g.currentPlayerIndex],page=pages[p.id],revision=g.revision;
          await page.waitForFunction(rev=>(isHost?g:clientGameState).revision===rev&&!!document.querySelector('#actionPanel button'),revision);
          const selector=await page.locator('.action-check').count()?'.action-check':'.action-call';await page.locator(selector).click();await host.waitForFunction(rev=>g.revision>rev,revision);await idle(page);
        }
        roomManager.check(room);for(const page of pages)await page.locator('#resultScreen').waitFor({state:'visible'});report.push({players:count,mode,variant:g.variant,hand:g.handNumber,actions,result:'passed'});
        if(index<3){const nextMode=['standard','ante','auto'][index];await host.locator('#nextHandBtn').click();await idle(host);assert.ok(g.nextHandReady.includes(0));await host.locator('#tableBlindMode').selectOption(nextMode);await idle(host);assert.deepEqual(g.nextHandReady,[]);
          await host.locator('#tableDeckMode').selectOption(nextMode==='auto'?'auto':nextMode==='ante'?'standard':'short');await idle(host);
          for(const page of pages){await page.locator('#nextHandBtn').click();await idle(page);}await host.waitForFunction(n=>g.handNumber===n,index+2);
        }
      }
      for(const page of pages)await page.context().close();console.log(`${count} clients: 4 blind modes, position mapping and complete hands passed.`);
    }
    assert.deepEqual(errors,[]);await fs.writeFile(path.join(__dirname,'blind-mode-report.json'),JSON.stringify({date:new Date().toISOString(),hands:report,result:'passed',limit:'Local independent Chrome clients; physical phones/WAN not tested'},null,2));console.log('12 multi-client hands passed across custom, standard, ante and automatic modes.');
  }finally{await browser.close();for(const ws of wss.clients)ws.terminate();await new Promise(r=>wss.close(r));await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
