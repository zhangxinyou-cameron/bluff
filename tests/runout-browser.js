const assert=require('node:assert/strict'),{chromium}=require('playwright');
const {server,wss,access,roomManager}=require('../server'),{passwordRecord}=require('../access');
(async()=>{
  const password='runout-browser-only';access.configure(await passwordRecord(password));roomManager.configureTimings({deal:80,action:40,street:80});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}/`;
  const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'}),errors=[],idle=p=>p.waitForFunction(()=>!RiverSession.getDiagnostics().pending);
  async function open(code){const c=await browser.newContext({viewport:code?{width:390,height:844}:{width:1280,height:800}});await c.addInitScript(()=>localStorage.setItem('river_audio',JSON.stringify({music:false,sfx:false})));const p=await c.newPage();p.on('pageerror',e=>errors.push(e.message));await p.goto(base+(code?'#room='+code:''));await p.getByLabel('访问密码').fill(password);await p.getByRole('button',{name:'验证并进入'}).click();await p.waitForFunction(()=>!!window.RiverSession);
    if(code){await p.waitForFunction(()=>wsConnected&&mySeatId>0);await p.locator('#readyBtn').click();await idle(p);}else{await p.locator('#createBtn').click();await p.locator('#waitTip').filter({hasText:'房间已创建'}).waitFor();for(const [id,v]of [['allowBuyInSel','yes'],['deckModeSel','standard'],['blindModeSel','standard']]){await p.locator('#'+id).selectOption(v);await idle(p);}}return p;}
  let host,pages,room;
  async function act(action){const g=room.game,actor=pages[g.players[g.currentPlayerIndex].id],rev=g.revision;await actor.locator('.action-'+action).waitFor();await actor.locator('.action-'+action).click();await idle(actor);await host.waitForFunction(rev=>g.revision>rev,rev);}
  async function raise(multiple,level){
    const g=room.game,id=g.players[g.currentPlayerIndex].id,page=pages[id],rev=g.revision,amount=g.currentBet*multiple;
    await page.locator('.action-raise').filter({hasText:level+'-BET'}).waitFor();await page.locator('.action-raise').click();
    assert.match(await page.locator('.raise-level').textContent(),new RegExp(level+'-BET'));
    await page.locator(`[data-raise-multiple="${multiple}"]`).click();assert.equal(await page.locator('#raiseAmount').inputValue(),String(amount));
    await page.locator('.action-confirm').click();await idle(page);await host.waitForFunction(rev=>g.revision>rev,rev);assert.equal(g.betLevel,level);
    for(const viewer of pages){
      const action=viewer.locator(`.player-card[data-seat="${id}"] .player-action`);
      const number=action.locator('.player-action-amount');await number.waitFor();assert.equal(await number.textContent(),String(amount));
      assert.equal(await number.evaluate(e=>{const a=e.getBoundingClientRect(),b=e.parentElement.getBoundingClientRect();return a.left>=b.left&&a.right<=b.right&&e.scrollWidth<=e.clientWidth;}),true);
      assert.doesNotMatch(await action.textContent(),/BET|RAISE/);
      await viewer.locator('#betNotice').filter({hasText:level+'-BET'}).waitFor();
    }
    if(level===3){await host.locator('#betNotice').waitFor({state:'hidden',timeout:4000});assert.equal(await host.locator('#actionAnnouncementText').textContent().then(text=>text.includes(String(amount))),true);}
  }
  try{
    host=await open();assert.equal(await host.locator('#runoutDelaySel').inputValue(),'3000');const code=await host.locator('#displayRoomCode').textContent();pages=[host,await open(code)];await pages[1].setViewportSize({width:320,height:568});room=roomManager.games.get(code);await host.locator('#startBtn').click();await host.waitForFunction(()=>!!g);
    for(let hand=1;hand<=2;hand++){
      if(hand===1){await raise(3,2);await raise(3,3);await raise(4,4);assert.ok(room.history.some(e=>e.label?.startsWith('3-BET')));assert.ok(room.history.some(e=>e.label?.startsWith('4-BET')));}
      await act('allin');await act('call');await host.locator('#runoutPanel').waitFor({state:'visible'});
      if(hand===1){await host.locator('#voteOnceBtn').click();await idle(host);}else for(const page of pages){await page.locator('#voteTwiceBtn').click();await idle(page);}
      const started=room.presentation.startedAt,duration=room.presentation.duration;assert.equal(duration,hand===1?14000:23000);
      const frames=hand===1?[[0],[3],[4],[5]]:[[0],[3],[4],[5],[5,3],[5,4],[5,5]];
      for(let index=0;index<frames.length;index++){
        const lengths=frames[index];for(const page of pages)await page.waitForFunction(lengths=>{const root=document.getElementById('communityCards'),rows=[...root.querySelectorAll('.runout-board')],counts=rows.length?rows.map(r=>r.querySelectorAll('.card:not(.card-empty)').length):[root.querySelectorAll('.card:not(.card-empty)').length];return JSON.stringify(counts)===JSON.stringify(lengths);},lengths);
        assert.ok(Date.now()-started>=(index===0?0:5000+(index-1)*3000)-100);for(const page of pages)assert.equal(await page.locator('#resultScreen').isVisible(),false);
        if(index===0){for(const page of pages){assert.equal(await page.locator('.player-card .hole-cards .card:not(.card-back)').count(),4);await page.locator('#actionAnnouncement').filter({hasText:'手牌已亮'}).waitFor();}await host.waitForTimeout(1500);await pages[1].reload();await pages[1].waitForFunction(()=>wsConnected&&clientGameState?.communityCards.length===0);assert.ok(Date.now()-started<5000);}
        if(hand===1&&index===2){await pages[1].reload();await pages[1].waitForFunction(()=>wsConnected&&clientGameState?.communityCards.length===4);assert.equal(await pages[1].locator('#resultScreen').isVisible(),false);}
      }
      for(const page of pages)await page.locator('#resultScreen').waitFor({state:'visible'});assert.ok(Date.now()-started>=duration-100);roomManager.check(room);
      if(hand===1){for(let id=0;id<2;id++){if(room.game.players[id].chips<2000){await pages[id].locator('#bankBtn').click();await pages[id].locator('#bankAmount').fill('2000');await pages[id].locator('#bankBorrowBtn').click();await idle(pages[id]);await pages[id].getByRole('button',{name:'关闭银行'}).click();}}for(const page of pages){await page.locator('#nextHandBtn').click();await idle(page);}await host.waitForFunction(()=>g.handNumber===2);}
    }
    assert.deepEqual(errors,[]);console.log('Runout passed: real 3-second single/double board timelines, final holds, 2 clients, refresh recovery, 3-bet/4-bet labels and 3x/4x presets.');
  }finally{await browser.close();for(const ws of wss.clients)ws.terminate();await new Promise(r=>wss.close(r));await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
