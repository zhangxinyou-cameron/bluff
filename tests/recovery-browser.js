const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {chromium}=require('playwright');
const {server,wss,access,roomManager}=require('../server');
const {passwordRecord}=require('../access');
(async()=>{
  const password='recovery-'+require('node:crypto').randomBytes(12).toString('hex');access.configure(await passwordRecord(password));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}/`;
  const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'}),errors=[],checks=[];
  async function open(room){
    const context=await browser.newContext({viewport:{width:390,height:844}});
    await context.addInitScript(()=>localStorage.setItem('river_audio',JSON.stringify({music:false,sfx:false})));
    const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
    await page.goto(base+(room?'#room='+room:''));await page.getByLabel('访问密码').fill(password);await page.getByRole('button',{name:'验证并进入'}).click();
    if(room){await page.waitForFunction(()=>typeof mySeatId!=='undefined'&&mySeatId>0);await page.locator('#readyBtn').click();}
    else{await page.locator('#createBtn').click();await page.locator('#waitTip').filter({hasText:'房间已创建'}).waitFor();await page.locator('#allowBuyInSel').selectOption('yes');await page.waitForFunction(()=>!RiverSession.getDiagnostics().pending);}
    return page;
  }
  const current=page=>page.evaluate(()=>isHost?g:clientGameState);
  async function idle(page){await page.waitForFunction(()=>!RiverSession.getDiagnostics().pending);}
  async function act(page,action){await page.locator('.action-'+action).click();await idle(page);}
  try{
    const host=await open(),code=await host.locator('#displayRoomCode').textContent(),guest=await open(code),third=await open(code),pages=[host,guest,third];
    await host.locator('#startBtn').click();await guest.locator('#dealingStage').waitFor({state:'visible'});
    assert.equal(await guest.locator('#actionPanel button').count(),0);checks.push('fixed dealing animation locks actions');
    const room=roomManager.games.get(code),first=room.game.players[room.game.currentPlayerIndex];assert.equal(first.id,1);
    const cdp=await host.context().newCDPSession(host);await cdp.send('Page.setWebLifecycleState',{state:'frozen'});
    const revision=room.game.revision;await act(guest,'call');assert.ok(room.game.revision>revision);checks.push('guest action progresses while host page is frozen');
    await cdp.send('Page.setWebLifecycleState',{state:'active'});await host.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})));
    await host.waitForFunction(rev=>g.revision===rev,room.game.revision);checks.push('background host restores latest snapshot');
    assert.match(await third.locator('#actionAnnouncement').textContent(),/跟注 \d+/);assert.ok((await third.locator('.player-action').allTextContents()).some(t=>/跟注\s*\d+/.test(t)));checks.push('persistent per-player action and large announcement');
    const before=await current(guest),cards=before.players[1].holeCards;
    await guest.reload();await guest.waitForFunction(()=>clientGameState?.handNumber===1&&mySeatId===1);
    assert.deepEqual((await current(guest)).players[1].holeCards,cards);checks.push('reload resumes same seat and cards');
    await guest.context().setOffline(true);await guest.evaluate(()=>ws.close());await guest.waitForFunction(()=>!RiverSession.getDiagnostics().connected);
    await guest.context().setOffline(false);await guest.evaluate(()=>window.dispatchEvent(new Event('online')));
    await guest.waitForFunction(()=>RiverSession.getDiagnostics().connected&&mySeatId===1);assert.deepEqual((await current(guest)).players[1].holeCards,cards);checks.push('offline/online recovers without losing cards');
    for(let hand=1;hand<=3;hand++){
      let steps=0;
      while(!['hand_over','tournament_over'].includes(room.game.phase)){
        assert.ok(++steps<80);const actor=room.game.players[room.game.currentPlayerIndex],page=pages[actor.id];
        await page.waitForFunction(rev=>(isHost?g:clientGameState)?.revision===rev&&!!document.querySelector('#actionPanel button'),room.game.revision);
        await act(page,await page.locator('.action-check').count()?'check':'call');
      }
      for(const page of pages)await page.locator('#resultScreen').waitFor({state:'visible'});
      if(hand===1){
        // Drop all acknowledgements/state for a loan, then let the pending-operation watchdog recover.
        await guest.evaluate(()=>{window.__originalReceiver=ws.onmessage;ws.onmessage=event=>{if(typeof event.data==='string'){const m=JSON.parse(event.data);if(m.type==='ack'||m.type==='snapshot')return;}window.__originalReceiver(event);};});
        await guest.locator('#bankBtn').click();await guest.locator('#bankAmount').fill('500');await guest.locator('#bankBorrowBtn').click();
        await host.waitForFunction(()=>g.players[1].bankDebt===500);
        await guest.evaluate(()=>ws.onmessage=window.__originalReceiver);
        await guest.waitForFunction(()=>!RiverSession.getDiagnostics().pending&&clientGameState.players[1].bankDebt===500,null,{timeout:12000});
        assert.equal(room.game.players[1].bankDebt,500);await guest.getByRole('button',{name:'关闭银行'}).click();checks.push('lost loan acknowledgement recovers without double charging');
        for(let i=0;i<130;i++)roomManager.event(room,'chat','history check '+i,{name:'test'});roomManager.publish(room);
        await guest.waitForFunction(()=>RiverSession.getDiagnostics().eventId>=130);await guest.reload();await guest.locator('#resultScreen').waitFor({state:'visible'});
        await guest.waitForFunction(total=>RiverSession.getDiagnostics().eventId===total,room.history.length);checks.push('whole session history is restored across reload and paging');
      }
      if(hand<3){for(const page of pages){await idle(page);await page.locator('#nextHandBtn').click();}await host.waitForFunction(n=>g.handNumber===n,hand+1);}
    }
    checks.push('three complete hands after freeze/reload/offline recovery');assert.deepEqual(errors,[]);
    const downloadPromise=guest.waitForEvent('download');await guest.locator('#exportHistoryBtn').click();const download=await downloadPromise;
    const exported=await fs.readFile(await download.path(),'utf8');assert.match(exported,/history check 0/);assert.match(exported,/第3手/);checks.push('complete public history exports successfully');
    await fs.mkdir(path.join(__dirname,'screenshots'),{recursive:true});await guest.screenshot({path:path.join(__dirname,'screenshots','recovery-journal-mobile.png'),fullPage:true});
    await fs.writeFile(path.join(__dirname,'recovery-report.json'),JSON.stringify({date:new Date().toISOString(),checks,result:'passed',limitation:'Chrome mobile viewport and lifecycle simulation; physical phone and public WAN not tested'},null,2));
    console.log('Recovery QA passed: '+checks.length+' checks; 3 complete hands.');
  }finally{await browser.close();for(const ws of wss.clients)ws.terminate();await new Promise(resolve=>wss.close(resolve));await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
