const assert=require('node:assert/strict'),{chromium}=require('playwright');
const {server,wss,access,roomManager}=require('../server'),{passwordRecord}=require('../access'),E=require('../public/poker-engine');
(async()=>{
  const password='threshold-browser-only';access.configure(await passwordRecord(password));roomManager.configureTimings({deal:80,action:30,street:70,runout:80});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}/`,errors=[];
  const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'}),idle=p=>p.waitForFunction(()=>!RiverSession.getDiagnostics().pending);
  async function open(code,id){const context=await browser.newContext({viewport:id?{width:390,height:844}:{width:1280,height:800}});await context.addInitScript(id=>{localStorage.setItem('starstone_name','门槛玩家'+id);localStorage.setItem('river_audio',JSON.stringify({music:false,sfx:false}));},id);
    const p=await context.newPage();p.on('pageerror',e=>errors.push(e.message));await p.goto(base+(code?'#room='+code:''));await p.getByLabel('访问密码').fill(password);await p.getByRole('button',{name:'验证并进入'}).click();await p.waitForFunction(()=>!!window.RiverSession);
    if(code){await p.waitForFunction(()=>wsConnected&&mySeatId>0);await p.locator('#readyBtn').click();await idle(p);}else{await p.locator('#createBtn').click();await p.locator('#waitTip').filter({hasText:'房间已创建'}).waitFor();await p.locator('#allowBuyInSel').selectOption('yes');await idle(p);}return p;}
  async function set(p,amount){await p.locator('#peekSettingsBtn').click();await p.locator('#peekAutoEnabled').setChecked(amount!==null);if(amount!==null)await p.locator('#peekThresholdAmount').fill(String(amount));
    const bounds=await p.locator('#peekSettingsDialog').evaluate(e=>{const r=e.getBoundingClientRect();return{top:r.top,bottom:r.bottom,right:r.right,height:innerHeight,width:innerWidth};});assert.ok(bounds.top>=0&&bounds.bottom<=bounds.height+1&&bounds.right<=bounds.width+1);
    await p.locator('#savePeekThreshold').click();await idle(p);await p.locator('#peekSettingsDialog').waitFor({state:'hidden'});}
  const close=async p=>{if(await p.locator('#socialDialog').evaluate(e=>e.open))await p.getByRole('button',{name:'关闭互动'}).click();};
  async function request(page,target,tip){await close(page);await page.locator(`.player-card[data-seat="${target}"]`).click();await page.locator('[data-social-tab="peek"]').click();await page.locator('#peekTip').fill(String(tip));await page.locator('#requestPeekBtn').click();await idle(page);}
  let pages,host,room;
  async function step(kind){const g=room.game,p=g.players[g.currentPlayerIndex],rev=g.revision,page=pages[p.id];await page.waitForFunction(rev=>(isHost?g:clientGameState)?.revision===rev&&!!document.querySelector('#actionPanel button'),rev);await page.locator('.action-'+(kind||(p.currentBet<g.currentBet?'call':'check'))).click();await idle(page);await host.waitForFunction(rev=>g.revision>rev,rev);}
  async function finish(){let steps=0;while(E.betting(room.game)){assert.ok(++steps<60);await step();}for(const page of pages)await page.locator('#resultScreen').waitFor({state:'visible'});roomManager.check(room);}
  async function next(){for(const page of pages){await close(page);await page.locator('#nextHandBtn').click();await idle(page);}await host.waitForFunction(()=>g.handNumber===2);}
  try{
    host=await open(null,0);const code=await host.locator('#displayRoomCode').textContent();pages=[host];for(let id=1;id<4;id++)pages.push(await open(code,id));room=roomManager.games.get(code);
    await set(host,25);await set(pages[2],30);await set(pages[3],0);await host.reload();await host.waitForFunction(()=>wsConnected&&mySeatId===0);await host.locator('#peekSettingsBtn').filter({hasText:'25筹码'}).waitFor();
    await host.locator('#startBtn').click();await host.waitForFunction(()=>g?.phase==='pre_flop');assert.equal(room.game.players[room.game.currentPlayerIndex].id,1);await step('fold');const payer=room.game.players[1],before=payer.chips;
    for(const page of pages)await page.evaluate(()=>{window.__peekPopups=0;new MutationObserver(changes=>{for(const change of changes)if(change.attributeName==='open'&&change.target.open)window.__peekPopups++;}).observe(document.getElementById('peekConsentDialog'),{attributes:true});});
    await request(pages[1],0,25);assert.match(await pages[1].locator('#socialPeekThreshold').textContent(),/25/);assert.equal(room.game.peekRequests[0].automatic,true);
    await pages[1].waitForFunction(()=>clientGameState.players[0].holeCards.length===2);assert.equal(await host.evaluate(()=>window.__peekPopups),0);assert.equal(await pages[2].evaluate(()=>clientGameState.players[0].holeCards.length),0);assert.equal(payer.chips,before);
    await request(pages[1],2,29);await pages[2].locator('#peekConsentDialog').waitFor({state:'visible'});await pages[2].locator('#peekConsentDecline').click();await idle(pages[2]);assert.equal(room.game.peekRequests[1].status,'declined');
    await request(pages[1],3,0);assert.equal(room.game.peekRequests[2].automatic,true);assert.equal(await pages[3].evaluate(()=>window.__peekPopups),0);await close(pages[1]);await finish();assert.equal(payer.chips,before-25);
    await set(host,null);await next();while(room.game.players[room.game.currentPlayerIndex].id!==1)await step();await step('fold');
    await request(pages[1],0,25);assert.match(await pages[1].locator('#socialPeekThreshold').textContent(),/手动确认/);await host.locator('#peekConsentDialog').waitFor({state:'visible'});await host.locator('#peekConsentAccept').click();await idle(host);await close(pages[1]);await finish();
    assert.equal(room.game.tips.length,1);assert.equal(room.game.tips[0].paid,true);assert.deepEqual(errors,[]);
    console.log('Peek thresholds passed: 4 clients, 2 full hands, public personal settings, refresh, exact/free auto approval without popups, manual below threshold/disabled, private cards and one-time tip settlement.');
  }finally{await browser.close();for(const ws of wss.clients)ws.terminate();await new Promise(r=>wss.close(r));await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
