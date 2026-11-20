const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),{chromium}=require('playwright');
const {server,wss,access,roomManager}=require('../server'),{passwordRecord}=require('../access'),E=require('../public/poker-engine');
(async()=>{
  const password='shove-ui-test-only';access.configure(await passwordRecord(password));roomManager.configureTimings({deal:80,action:30,runout:120000});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}/`,browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'}),errors=[];
  const idle=p=>p.waitForFunction(()=>!RiverSession.getDiagnostics().pending);
  async function open(code){const ctx=await browser.newContext({viewport:{width:390,height:844}});await ctx.addInitScript(()=>localStorage.setItem('river_audio',JSON.stringify({music:false,sfx:false})));const p=await ctx.newPage();p.on('pageerror',e=>errors.push(e.message));await p.goto(base+(code?'#room='+code:''));await p.getByLabel('访问密码').fill(password);await p.getByRole('button',{name:'验证并进入'}).click();await p.waitForFunction(()=>!!window.RiverSession);if(code){await p.waitForFunction(()=>wsConnected&&mySeatId>0);await p.locator('#readyBtn').click();await idle(p);}else{await p.locator('#createBtn').click();await p.locator('#waitTip').filter({hasText:'房间已创建'}).waitFor();}return p;}
  try{
    const host=await open(),code=await host.locator('#displayRoomCode').textContent(),guest=await open(code),pages=[host,guest],room=roomManager.games.get(code);
    for(const page of pages)await page.evaluate(()=>{
      const layer=document.getElementById('chipFlightLayer');
      window.shoveFlights=0;
      new MutationObserver(records=>{window.shoveFlights+=records.reduce((count,record)=>count+record.addedNodes.length,0);}).observe(layer,{childList:true});
    });
    await host.locator('#startBtn').click();
    const shove=guest.locator('.action-allin'),dialog=guest.locator('#allinDialog');
    await shove.waitFor();
    const actor=room.game.players[room.game.currentPlayerIndex],revision=room.game.revision,stack=actor.chips;
    await shove.click();await dialog.waitFor();
    assert.equal(await guest.locator('#allinAmount').textContent(),stack.toLocaleString('zh-CN'));
    assert.equal(await guest.locator('#allinCancel').evaluate(button=>document.activeElement===button),true);
    assert.equal(room.game.revision,revision);
    await guest.locator('#allinCancel').click();await dialog.waitFor({state:'hidden'});
    assert.equal(room.game.revision,revision);
    await guest.locator('.action-raise').click();
    await guest.locator('#raiseMaxBtn').click();
    await guest.locator('.action-confirm').click();await dialog.waitFor();
    assert.equal(room.game.revision,revision);
    await guest.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
    assert.equal(await guest.locator('#raiseAmount').inputValue(),String(stack+actor.currentBet));
    await guest.locator('.action-confirm').click();await dialog.waitFor();
    await guest.locator('#allinConfirm').click();await idle(guest);
    const confirmed=room.history.filter(event=>event.kind==='action'&&event.shoved);
    assert.equal(confirmed.length,1);
    assert.equal(confirmed[0].action,'raise');
    assert.equal(confirmed[0].amount,stack);
    for(const page of pages){
      await page.waitForFunction(()=>window.shoveFlights===1);
      await page.locator('.chip-flight').waitFor({state:'detached'});
      await page.evaluate(()=>RiverSession.sync());
    }
    await guest.emulateMedia({reducedMotion:'reduce'});
    await host.locator('.action-call').click();
    await host.waitForFunction(()=>window.shoveFlights===2);
    await host.locator('.chip-flight').waitFor({state:'detached'});
    assert.equal(await guest.evaluate(()=>window.shoveFlights),1);
    assert.equal(room.history.find(event=>event.action==='call').shoved,true);
    const directory=path.join(__dirname,'screenshots');await fs.mkdir(directory,{recursive:true});
    for(const n of [3,8]){
      const g=E.createGame(Array.from({length:n},(_,id)=>({id,name:'玩家'+id,chips:23456789,isAI:id>1,connected:true})),20,{allowBuyIn:true,runTwiceEnabled:true,blindMode:'standard'});E.startHand(g);
      g.players[n-1].folded=true;while(E.betting(g)){const p=g.players[g.currentPlayerIndex];E.applyAction(g,p.id,'allin');}assert.equal(g.phase,'runout_vote');E.resolveRunout(g,true);room.game=g;roomManager.pace(room,'runout',0,0);
      // Show both completed boards during the final hold, matching the reported screenshot.
      room.presentation.startedAt=Date.now()-room.presentation.timeline.steps.at(-1).at;room.blockedUntil=room.presentation.startedAt+room.presentation.duration;room.presentation.until=room.blockedUntil;roomManager.publish(room);
      for(const page of pages){await page.waitForFunction(n=>document.querySelectorAll('.player-card').length===n,n);for(const [width,height]of [[320,568],[390,844],[430,932],[844,390],[1280,800],[1440,900]]){
        await page.setViewportSize({width,height});await page.waitForFunction(height=>parseInt(document.documentElement.style.getPropertyValue('--play-height'),10)===height,height);await page.evaluate(()=>document.getElementById('playWorkspace').scrollIntoView({block:'start',behavior:'instant'}));
        const result=await page.evaluate(()=>{const overlap=(a,b)=>a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top;return{pageWidth:document.documentElement.scrollWidth,width:innerWidth,stamps:document.querySelectorAll('.allin-tag,.fold-tag').length,bad:[...document.querySelectorAll('.player-card')].filter(p=>{const action=p.querySelector('.player-action').getBoundingClientRect();return [...p.querySelectorAll('.hole-cards .card')].some(c=>overlap(action,c.getBoundingClientRect()));}).map(p=>p.dataset.seat),labels:[...document.querySelectorAll('.player-card.allin .player-action')].map(e=>e.textContent)};});
        assert.equal(result.stamps,0);assert.deepEqual(result.bad,[]);assert.ok(result.pageWidth<=result.width);assert.ok(result.labels.every(text=>text.includes('梭哈')));assert.doesNotMatch(await page.locator('#gameScreen').innerText(),/全押|全压/);
        if(page===guest&&(width===390||width===1280))await page.screenshot({path:path.join(directory,`shove-clear-cards-${n}-${width}.png`)});
      }}roomManager.check(room);
    }
    const expiryHost=await open(),expiryCode=await expiryHost.locator('#displayRoomCode').textContent(),expiryGuest=await open(expiryCode),expiryRoom=roomManager.games.get(expiryCode);
    await expiryHost.locator('#startBtn').click();
    await expiryGuest.locator('.action-allin').click();
    await expiryGuest.locator('#allinDialog').waitFor();
    expiryRoom.deadline=Date.now()-1;roomManager.tick();
    await expiryGuest.locator('#allinDialog').waitFor({state:'hidden'});
    await expiryGuest.locator('#allinConfirm').evaluate(button=>button.click());
    assert.equal(expiryRoom.history.some(event=>event.shoved),false);
    assert.equal(expiryRoom.history.some(event=>event.kind==='action'&&event.automatic),true);
    assert.deepEqual(errors,[]);console.log('Shove UI passed: cancel and Escape, full-stack raise confirmation, stale-turn rejection, both clients see animation, reduced motion, and double-board layouts.');
  }finally{await browser.close();for(const ws of wss.clients)ws.terminate();await new Promise(r=>wss.close(r));await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
