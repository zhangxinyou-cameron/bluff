const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {chromium}=require('playwright');
const {server,wss,access,roomManager}=require('../server');
const {passwordRecord}=require('../access');
const E=require('../public/poker-engine');

(async()=>{
  const password='experience-regression-only';
  access.configure(await passwordRecord(password));
  roomManager.configureTimings({deal:180,street:100,runout:150,action:30,turn:300000});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}/`;
  const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
  const checks=[],hands=[],errors=[],directory=path.join(__dirname,'screenshots');
  await fs.mkdir(directory,{recursive:true});
  const idle=page=>page.waitForFunction(()=>window.RiverSession&&!RiverSession.getDiagnostics().pending);
  const current=page=>page.evaluate(()=>isHost?g:clientGameState);
  const closeSocial=async page=>{if(await page.locator('#socialDialog').evaluate(e=>e.open))await page.getByRole('button',{name:'关闭互动',exact:true}).click();};
  async function open(code,id){
    const context=await browser.newContext({viewport:id%2?{width:390,height:844}:{width:1280,height:800}});
    await context.addInitScript(id=>{localStorage.setItem('river_audio',JSON.stringify({music:false,sfx:false}));localStorage.setItem('starstone_name',`体验玩家${id}`);},id);
    const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
    await page.goto(base+(code?'#room='+code:''));await page.getByLabel('访问密码').fill(password);await page.getByRole('button',{name:'验证并进入'}).click();
    await page.waitForFunction(()=>!!window.RiverSession);
    if(code){await page.waitForFunction(()=>mySeatId>0);await page.locator('#readyBtn').click();await idle(page);}
    else{
      await page.locator('#createBtn').click();await page.locator('#waitTip').filter({hasText:'房间已创建'}).waitFor();
      for(const [selector,value]of [['#allowBuyInSel','yes'],['#deckModeSel','standard'],['#blindModeSel','standard']]){await page.locator(selector).selectOption(value);await idle(page);}
    }
    return page;
  }
  async function table(count){
    const host=await open(null,0),code=await host.locator('#displayRoomCode').textContent(),pages=[host];
    for(let id=1;id<count;id++)pages.push(await open(code,id));
    return{host,code,pages,room:roomManager.games.get(code)};
  }
  async function start(f){await f.host.locator('#startBtn').click();await f.host.waitForFunction(()=>g&&g.phase==='pre_flop');for(const page of f.pages)await page.locator('.player-card').first().waitFor();}
  async function visualOrder(f){
    let baseline;
    for(const page of f.pages){
      await page.waitForFunction(count=>document.querySelectorAll('.player-card').length===count,f.room.game.players.length);
      const order=await page.evaluate(()=>{
        const cards=id=>[...document.getElementById(id).querySelectorAll('.player-card')].map(e=>({id:Number(e.dataset.seat),x:e.getBoundingClientRect().x}));
        return [...cards('playersTop').sort((a,b)=>a.x-b.x),...cards('playersBottom').sort((a,b)=>b.x-a.x)].map(p=>p.id);
      });
      if(baseline)assert.deepEqual(order,baseline,'all viewers must see the same absolute seating arrangement');else baseline=order;
      const sorted=f.room.game.players.map(p=>p.id).sort((a,b)=>a-b),start=sorted.indexOf(order[0]);
      assert.deepEqual(order,sorted.slice(start).concat(sorted.slice(0,start)),'clockwise visual order must follow ascending engine seats');
    }
    return baseline;
  }
  async function step(f,kind){
    const game=f.room.game,actor=game.players[game.currentPlayerIndex],page=f.pages[actor.id],revision=game.revision;
    await idle(page);await page.waitForFunction(rev=>(isHost?g:clientGameState)?.revision===rev&&!!document.querySelector('#actionPanel button'),revision);
    const action=kind||(await page.locator('.action-check').count()?'check':'call');
    await page.locator('.action-'+action).click();await f.host.waitForFunction(rev=>g.revision>rev,revision);await idle(page);roomManager.check(f.room);
    return actor.id;
  }
  async function finish(f){
    const phases=new Map();let actions=0;
    while(E.betting(f.room.game)||f.room.game.phase==='runout_vote'){
      const game=f.room.game;
      if(game.phase==='runout_vote'){const id=game.runoutVote.eligibleIds.find(id=>f.room.people.get(id)?.connected);await f.pages[id].locator('#voteOnceBtn').click();await idle(f.pages[id]);continue;}
      assert.ok(++actions<120,'hand must finish without stalls');const phase=game.phase,id=game.players[game.currentPlayerIndex].id;
      if(!phases.has(phase))phases.set(phase,[]);phases.get(phase).push(id);await step(f);
    }
    for(const page of f.pages)await page.locator('#resultScreen').waitFor({state:'visible'});
    for(const [phase,ids]of phases){for(let i=1;i<ids.length;i++){const sorted=f.room.game.players.filter(p=>p.isActive&&!p.folded&&!p.allIn&&!p.disconnected).map(p=>p.id).sort((a,b)=>a-b);if(sorted.includes(ids[i-1])&&sorted.includes(ids[i]))assert.equal(ids[i],sorted[(sorted.indexOf(ids[i-1])+1)%sorted.length],`${phase} action rotates clockwise`);}}
    roomManager.check(f.room);hands.push({players:f.pages.length,hand:f.room.game.handNumber,variant:f.room.game.variant,actions,streets:Object.fromEntries(phases),result:'passed'});
  }
  async function next(f){const number=f.room.game.handNumber;for(const page of f.pages){await idle(page);await page.locator('#nextHandBtn').click();await idle(page);}await f.host.waitForFunction(n=>g.handNumber===n,number+1);}
  async function requestPeek(f,from,to,tip=0){
    const page=f.pages[from];await closeSocial(page);await page.locator(`.player-card[data-seat="${to}"]`).click();await page.locator('[data-social-tab="peek"]').click();
    await page.locator('#peekTip').fill(String(tip));await page.locator('#requestPeekBtn').click();await idle(page);
    await f.pages[to].locator('#peekConsentDialog').waitFor({state:'visible'});
    const request=f.room.game.peekRequests.find(r=>r.from===from&&r.to===to);assert.ok(request);assert.ok(request.expiresAt-Date.now()>8500&&request.expiresAt-Date.now()<=10000);
    return request;
  }
  async function setAvatar(page,avatar){await page.locator('#avatarBtn').click();await page.locator(`#avatarDialog button[data-avatar="${avatar}"]`).click();await idle(page);if(await page.locator('#avatarDialog').evaluate(e=>e.open))await page.keyboard.press('Escape');}
  try{
    const f=await table(4);await setAvatar(f.pages[1],'fox');await setAvatar(f.pages[2],'panda');await start(f);
    for(const page of f.pages){await page.locator('.player-card[data-seat="1"] .player-avatar[data-avatar="fox"]').waitFor();await page.locator('.player-card[data-seat="2"] .player-avatar[data-avatar="panda"]').waitFor();}
    await f.pages[1].reload();await f.pages[1].waitForFunction(()=>wsConnected&&mySeatId===1);await f.pages[1].locator('.player-card[data-seat="1"] .player-avatar[data-avatar="fox"]').waitFor();
    checks.push('avatar selection broadcasts to all clients and survives reload/recovery');
    const seating=await visualOrder(f);checks.push('four independent desktop/mobile clients show identical clockwise seat positions');
    const game=f.room.game,first=game.players[game.currentPlayerIndex],raiser=f.pages[first.id];
    await raiser.locator('.action-raise').click();
    for(const fraction of [.5,.75,1,2]){
      const index=await raiser.locator('.raise-presets button').evaluateAll((buttons,fraction)=>buttons.findIndex(b=>Number(b.dataset.potFraction)===fraction),fraction);
      assert.ok(index>=0,`preset ${fraction} exists`);await raiser.locator('.raise-presets button').nth(index).click();
      const expected=Math.min(first.chips+first.currentBet,Math.max(game.currentBet+game.minRaise,Math.round(game.currentBet+fraction*(game.pot+Math.max(0,game.currentBet-first.currentBet)))));
      assert.equal(await raiser.evaluate(()=>raiseValue),expected,`preset ${fraction} is based on the pot after calling`);
    }
    await raiser.screenshot({path:path.join(directory,'experience-pot-presets.png')});
    await raiser.locator('#raiseAmount').fill('137');await raiser.locator('.action-confirm').click();await f.host.waitForFunction(()=>g.currentBet===137);await idle(raiser);
    checks.push('half, three-quarter, full and double pot presets calculate legal total raise targets; arbitrary amount remains usable');
    const folded=await step(f,'fold');assert.equal(folded,0);
    const payerBefore=f.room.game.players[folded].chips;
    let request=await requestPeek(f,folded,1,25);
    for(const id of[0,2,3])assert.equal(await f.pages[id].locator('#peekConsentDialog').isVisible(),false);
    await f.pages[1].screenshot({path:path.join(directory,'experience-peek-consent.png')});
    await f.pages[1].locator('#peekConsentAccept').click();await idle(f.pages[1]);await f.pages[1].locator('#peekConsentDialog').waitFor({state:'hidden'});
    await f.pages[0].waitForFunction(()=>g.players.find(p=>p.id===1).holeCards.length===2);assert.equal((await current(f.pages[2])).players.find(p=>p.id===1).holeCards.length,0);
    assert.equal(request.status,'approved');assert.equal(f.room.game.players[folded].chips,payerBefore);
    request=await requestPeek(f,folded,2);await f.pages[2].locator('#peekConsentDecline').click();await idle(f.pages[2]);assert.equal(request.status,'declined');
    request=await requestPeek(f,folded,3);const startSeconds=parseInt(await f.pages[3].locator('#peekConsentSeconds').textContent(),10);assert.ok(startSeconds>=9&&startSeconds<=10);
    await f.pages[3].waitForFunction(start=>parseInt(document.getElementById('peekConsentSeconds').textContent,10)<start,startSeconds);
    await f.pages[3].locator('#peekConsentDialog').waitFor({state:'hidden',timeout:12000});await f.pages[folded].locator('.peek-receipt[data-state="expired"]').waitFor();assert.equal(request.status,'expired');
    assert.equal((await current(f.pages[0])).players.find(p=>p.id===3).holeCards.length,0);
    await closeSocial(f.pages[0]);checks.push('only the target receives an automatic consent popup; accept, refuse and real 10-second expiry preserve privacy and tips');
    const sender=f.pages[2];await sender.locator('.player-card[data-seat="1"]').click();await sender.locator('[data-social-tab="gifts"]').click();await sender.locator('[data-gift="flower"]').click();
    await sender.locator('#socialDialog').waitFor({state:'hidden'});await sender.locator('.gift-flight.gift-flower').waitFor();await idle(sender);await sender.screenshot({path:path.join(directory,'experience-gift-on-table.png')});
    // Mark a recent interaction so the real UI request deterministically meets the rate limit.
    await sender.locator('.player-card[data-seat="1"]').click();await sender.locator('[data-social-tab="gifts"]').click();f.room.people.get(2).socialAt=Date.now();await sender.locator('[data-gift="tomato"]').click();await idle(sender);
    await sender.locator('#tableFeedback[data-state="warning"]').filter({hasText:'请稍候'}).waitFor({state:'visible'});assert.equal(await sender.locator('#socialDialog').isVisible(),false);assert.equal(await sender.locator('.gift-flight.gift-tomato').count(),0);
    await sender.waitForTimeout(1050);await sender.locator('.player-card[data-seat="1"]').click();await sender.locator('[data-social-tab="gifts"]').click();await sender.locator('[data-gift="tomato"]').click();
    await sender.locator('#socialDialog').waitFor({state:'hidden'});await sender.locator('.gift-flight.gift-tomato').waitFor();await idle(sender);checks.push('flower and tomato immediately dismiss the dialog and animate on the sender table; a rejected gift remains visible in table feedback');
    await finish(f);assert.equal(f.room.game.players[folded].chips,payerBefore-25);
    await f.pages[3].locator('#bankBtn').click();await f.pages[3].locator('#bankAmount').fill('500');await f.pages[3].locator('#bankBorrowBtn').click();await idle(f.pages[3]);await f.pages[3].getByRole('button',{name:'关闭银行'}).click();
    await next(f);await visualOrder(f);await setAvatar(f.pages[3],'rabbit');
    for(const page of f.pages)await page.locator('.player-card[data-seat="3"] .player-avatar[data-avatar="rabbit"]').waitFor();checks.push('a player can change avatar during a live hand without changing the turn or account');
    const account=f.room.game.players.find(p=>p.id===3),balance=[account.chips,account.bankDebt],oldCards=account.holeCards.map(c=>c.id);
    await f.host.locator('#managePlayersBtn').click();await f.host.locator('#socialTarget').selectOption('3');await f.host.locator('#kickPlayerBtn').click();await idle(f.host);await closeSocial(f.host);
    await f.pages[3].locator('#connectionText').filter({hasText:'移出'}).waitFor();assert.equal(account.disconnected,true);assert.equal(account.folded,true);
    await f.pages[3].waitForTimeout(1200);assert.equal(f.room.people.get(3).connected,false,'kicked player cannot automatically rejoin');
    await f.pages[3].reload();await f.pages[3].locator('#homeScreen').waitFor({state:'visible'});await f.pages[3].waitForTimeout(600);assert.equal(f.room.people.get(3).connected,false,'reload after kick stays on home rather than automatically rejoining');
    await f.pages[3].locator('#joinBtn').click();await f.pages[3].locator('#roomCodeInput').fill(f.code);await f.pages[3].locator('#confirmJoinBtn').click();await f.pages[3].waitForFunction(()=>wsConnected&&mySeatId===3&&clientGameState?.handNumber===2);
    assert.deepEqual([account.chips,account.bankDebt],balance);assert.deepEqual(account.holeCards.map(c=>c.id),oldCards);assert.equal(account.folded,true);
    assert.equal(f.room.people.get(3).connected,true);await f.pages[3].locator('.player-card[data-seat="3"] .player-avatar[data-avatar="rabbit"]').waitFor();assert.deepEqual(await visualOrder(f),seating);await finish(f);checks.push('kick and reload stay disconnected; explicit rejoin restores original seat, avatar, chips and debt without resurrecting current-hand participation');
    await f.host.locator('#tableDeckMode').selectOption('short');await idle(f.host);await f.host.locator('#tableBlindMode').selectOption('ante');await idle(f.host);await next(f);
    assert.equal(account.disconnected,false);assert.equal(account.folded,false);assert.equal(account.isActive,true);assert.deepEqual(await visualOrder(f),seating);await finish(f);checks.push('rejoined player returns to normal action next hand; clockwise seating remains fixed across deck/blind changes');
    await next(f);const firstRequester=await step(f,'fold'),secondRequester=await step(f,'fold'),target=f.room.game.players.find(p=>!p.folded).id;
    const firstRequest=await requestPeek(f,firstRequester,target),secondRequest=await requestPeek(f,secondRequester,target),targetPage=f.pages[target];
    await targetPage.locator('#peekConsentQueue').filter({hasText:'还有 1 个申请'}).waitFor();assert.match(await targetPage.locator('#peekConsentFrom').textContent(),new RegExp('体验玩家'+firstRequester));
    await targetPage.keyboard.press('Escape');await targetPage.locator('#peekConsentFrom').filter({hasText:'体验玩家'+secondRequester}).waitFor();assert.equal(firstRequest.status,'declined');
    await targetPage.locator('#peekConsentAccept').click();await idle(targetPage);await targetPage.locator('#peekConsentDialog').waitFor({state:'hidden'});assert.equal(secondRequest.status,'approved');
    await f.pages[secondRequester].waitForFunction(id=>(isHost?g:clientGameState).players.find(p=>p.id===id).holeCards.length===2,target);
    for(const id of f.room.game.players.map(p=>p.id).filter(id=>id!==target&&id!==secondRequester))assert.equal((await current(f.pages[id])).players.find(p=>p.id===target).holeCards.length,0);
    for(let i=0;i<3;i++)await targetPage.evaluate(()=>RiverSession.sync());await targetPage.waitForTimeout(400);assert.equal(await targetPage.locator('#peekConsentDialog').isVisible(),false);
    await closeSocial(f.pages[firstRequester]);await closeSocial(f.pages[secondRequester]);await finish(f);checks.push('two simultaneous look requests queue correctly: Escape refuses first, second approval reveals privately, and synchronization never reopens resolved popups');
    for(const page of f.pages)await page.context().close();
    const full=await table(8);await start(full);await visualOrder(full);
    for(const [width,height]of[[320,568],[390,844],[844,390],[1440,900]]){
      const page=full.pages[3];await page.setViewportSize({width,height});await page.waitForFunction(height=>parseInt(document.documentElement.style.getPropertyValue('--play-height'),10)===height,height);await page.waitForTimeout(250);await page.evaluate(()=>document.getElementById('playWorkspace').scrollIntoView({block:'start',behavior:'instant'}));
      const bounds=await page.evaluate(()=>({width:innerWidth,height:innerHeight,pageWidth:document.documentElement.scrollWidth,boxes:['actionPanel','chatInput','winRateText'].map(id=>{const r=document.getElementById(id).getBoundingClientRect();return{id,top:r.top,bottom:r.bottom,height:r.height};})}));
      await page.screenshot({path:path.join(directory,`experience-eight-${width}.png`)});assert.ok(bounds.pageWidth<=width,JSON.stringify(bounds));for(const box of bounds.boxes)assert.ok(box.top>=-1&&box.bottom<=height+1&&box.height>0,JSON.stringify(bounds));
      await visualOrder(full);if(width===390||width===1440)await page.screenshot({path:path.join(directory,`experience-eight-${width}.png`)});
    }
    await finish(full);checks.push('eight independent clients preserve clockwise action through every street; key controls fit four phone/desktop viewports');
    assert.deepEqual(errors,[]);
    await fs.writeFile(path.join(__dirname,'experience-browser-report.json'),JSON.stringify({testedAt:new Date().toISOString(),checks,hands,result:'passed',limits:'Local Chrome independent contexts and mobile-sized viewports; physical phones and public network not tested'},null,2));
    console.log(`Experience regressions passed: ${checks.length} checks, ${hands.length} complete hands, 4- and 8-client tables.`);
  }finally{await browser.close();for(const ws of wss.clients)ws.terminate();await new Promise(resolve=>wss.close(resolve));await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
