const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {server,wss,access,roomManager}=require('../server');
const {passwordRecord}=require('../access');
const E=require('../public/poker-engine');
(async()=>{
  const password='optional-show-test-only';access.configure(await passwordRecord(password));
  roomManager.configureTimings({deal:120,action:50,street:100,runout:150});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}/`;
  const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'}),errors=[];
  const idle=page=>page.waitForFunction(()=>!RiverSession.getDiagnostics().pending);
  async function open(code,id){
    const context=await browser.newContext({viewport:id?{width:390,height:844}:{width:1280,height:800}});
    await context.addInitScript(id=>{localStorage.setItem('starstone_name','亮牌测试'+id);localStorage.setItem('river_audio',JSON.stringify({music:false,sfx:false}));},id);
    const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(base+(code?'#room='+code:''));
    await page.getByLabel('访问密码').fill(password);await page.getByRole('button',{name:'验证并进入'}).click();await page.waitForFunction(()=>!!window.RiverSession);
    if(code){await page.waitForFunction(()=>wsConnected&&mySeatId>0);await page.locator('#readyBtn').click();await idle(page);}
    else{await page.locator('#createBtn').click();await page.locator('#waitTip').filter({hasText:'房间已创建'}).waitFor();await page.locator('#allowBuyInSel').selectOption('yes');await idle(page);await page.locator('#blindModeSel').selectOption('standard');await idle(page);}
    return page;
  }
  const row=(page,id)=>page.locator(`[data-result-seat="${id}"]`);
  async function visibility(pages,winner,revealed){
    for(let id=0;id<pages.length;id++){
      const expected=id===winner||revealed?2:0;
      await pages[id].waitForFunction(({winner,expected})=>(isHost?g:clientGameState).players.find(p=>p.id===winner).holeCards.length===expected,{winner,expected});
      assert.equal(await row(pages[id],winner).locator('.pr-cards .card').count(),expected);
      if(!expected)assert.match(await row(pages[id],winner).textContent(),/未亮牌/);
      assert.equal(await row(pages[id],winner).locator('[data-show-hand]').count(),id===winner?1:0);
    }
  }
  try{
    const host=await open(null,0),code=await host.locator('#displayRoomCode').textContent(),pages=[host,await open(code,1),await open(code,2)],room=roomManager.games.get(code);
    await host.locator('#startBtn').click();await host.waitForFunction(()=>g?.phase==='pre_flop');
    for(let hand=1;hand<=3;hand++){
      const winner=hand-1;let steps=0;
      while(E.betting(room.game)){
        assert.ok(++steps<20);const game=room.game,p=game.players[game.currentPlayerIndex],rev=game.revision,page=pages[p.id];
        await page.waitForFunction(rev=>(isHost?g:clientGameState)?.revision===rev&&!!document.querySelector('#actionPanel button'),rev);
        const action=p.id!==winner?'fold':p.currentBet<game.currentBet?'call':'check';
        await page.locator('.action-'+action).click();await idle(page);await host.waitForFunction(rev=>g.revision>rev,rev);
      }
      for(const page of pages)await page.locator('#resultScreen').waitFor({state:'visible'});
      assert.equal(room.game.showdownOccurred,false);assert.deepEqual(room.game.winners,[winner]);await visibility(pages,winner,false);
      const observer=pages[(winner+1)%3];await observer.reload();await observer.locator('#resultScreen').waitFor({state:'visible'});await visibility(pages,winner,false);
      const button=pages[winner].locator(`[data-show-hand="${winner}"]`);await button.click();await idle(pages[winner]);await visibility(pages,winner,true);
      await button.click();await idle(pages[winner]);await visibility(pages,winner,false);roomManager.check(room);
      for(const page of pages){await page.locator('#nextHandBtn').click();await idle(page);}await host.waitForFunction(hand=>g.handNumber===hand,hand+1);
      assert.ok(room.game.players.every(p=>!p.showFolded));
    }
    // A normal fourth hand reaches showdown and still automatically reveals live hands.
    let steps=0;while(E.betting(room.game)){
      assert.ok(++steps<20);const game=room.game,p=game.players[game.currentPlayerIndex],page=pages[p.id],rev=game.revision;
      await page.waitForFunction(rev=>(isHost?g:clientGameState)?.revision===rev&&!!document.querySelector('#actionPanel button'),rev);
      await page.locator(p.currentBet<game.currentBet?'.action-call':'.action-check').click();await idle(page);await host.waitForFunction(rev=>g.revision>rev,rev);
    }
    assert.equal(room.game.showdownOccurred,true);
    for(const page of pages){await page.locator('#resultScreen').waitFor({state:'visible'});assert.equal(await page.locator('#playerResults .pr-cards .card').count(),6);assert.equal(await page.locator('[data-show-hand]').count(),0);}
    for(const allowBuyIn of [true,false]){
      // Legitimate engine fixture: one spectator with no chips, two funded players.
      const game=E.createGame(pages.map((_,id)=>({id,name:'亮牌测试'+id,chips:id===2?0:2000,connected:true})),20,{allowBuyIn});
      game.handNumber=room.game.handNumber;room.game=game;E.startHand(game);room.presentation=null;room.blockedUntil=0;room.settings.allowBuyIn=allowBuyIn;roomManager.publish(room);
      await pages[2].locator('#gameScreen').waitFor({state:'visible'});
      await pages[2].locator('#handTypeText').filter({hasText:'观战'}).waitFor();
      await pages[2].locator('.player-card[data-seat="0"]').click();await pages[2].locator('[data-social-tab="peek"]').click();
      await pages[2].locator('#peekTip').fill('0');await pages[2].locator('#requestPeekBtn').click();await idle(pages[2]);
      await host.locator('#peekConsentDialog').waitFor({state:'visible'});assert.equal(game.privateReveals[0],undefined);
      await host.locator('#peekConsentAccept').click();await idle(host);
      await pages[2].waitForFunction(()=>clientGameState.players[0].holeCards.length===2);
      assert.equal(await pages[1].evaluate(()=>clientGameState.players[0].holeCards.length),0);roomManager.check(room);
      await pages[2].getByRole('button',{name:'关闭互动'}).click();
    }
    assert.deepEqual(errors,[]);console.log('Optional show passed: 3 clients, 4 complete hands, private winner reveal/hide and refresh, normal showdown, plus 2 spectator-consent mode checks.');
  }finally{await browser.close();for(const ws of wss.clients)ws.terminate();await new Promise(r=>wss.close(r));await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
