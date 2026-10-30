const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');const{chromium}=require('playwright');
const{server,wss,access,roomManager}=require('../server');const{passwordRecord}=require('../access');
(async()=>{
  const password='social-ui-test-only';access.configure(await passwordRecord(password));roomManager.configureTimings({deal:300,action:120,street:150,runout:200});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}/`,directory=path.join(__dirname,'screenshots');await fs.mkdir(directory,{recursive:true});
  const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'}),errors=[],checks=[];
  async function open(code,id){const context=await browser.newContext({viewport:id?{width:390,height:844}:{width:1280,height:800}});await context.addInitScript(id=>{localStorage.setItem('river_audio',JSON.stringify({music:false,sfx:false}));localStorage.setItem('starstone_name',['河岸','小红','阿明'][id]);},id);
    const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(base+(code?'#room='+code:''));await page.getByLabel('访问密码').fill(password);await page.getByRole('button',{name:'验证并进入'}).click();
    if(code){await page.waitForFunction(()=>mySeatId>0);await page.locator('#readyBtn').click();await page.waitForFunction(()=>!RiverSession.getDiagnostics().pending);}else{await page.locator('#createBtn').click();await page.locator('#waitTip').filter({hasText:'房间已创建'}).waitFor();await page.locator('#minPlayersSel').selectOption('1');await page.waitForFunction(()=>!RiverSession.getDiagnostics().pending);}return page;
  }
  async function fitDialog(page){const bounds=await page.evaluate(()=>{const d=document.getElementById('socialDialog'),r=d.getBoundingClientRect();return{x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight,overflow:d.scrollWidth>d.clientWidth};});assert.ok(bounds.x>=0&&bounds.y>=0&&bounds.right<=bounds.width+1&&bounds.bottom<=bounds.height+1&&!bounds.overflow,JSON.stringify(bounds));}
  try{
    const host=await open(null,0),code=await host.locator('#displayRoomCode').textContent(),guest=await open(code,1),other=await open(code,2),pages=[host,guest,other];
    await guest.locator('#phraseOpenBtn').click();await guest.locator('[data-social-tab="gifts"]').click();
    await host.locator('#startBtn').click();await guest.locator('#turnNotice').waitFor({state:'visible'});
    await guest.waitForFunction(()=>{const r=document.getElementById('turnNotice').getBoundingClientRect();return Math.abs(r.y+r.height/2-innerHeight/2)<2;});
    const notice=await guest.locator('#turnNotice').evaluate(e=>{const r=e.getBoundingClientRect();return{cx:r.x+r.width/2,cy:r.y+r.height/2,w:innerWidth,h:innerHeight,pointer:getComputedStyle(e).pointerEvents,topLayer:e.matches(':popover-open')};});
    assert.ok(Math.abs(notice.cx-notice.w/2)<2&&Math.abs(notice.cy-notice.h/2)<2,JSON.stringify(notice));assert.equal(notice.pointer,'none');assert.equal(notice.topLayer,true);
    assert.equal(await host.locator('#turnNotice').isVisible(),false);assert.equal(await other.locator('#turnNotice').isVisible(),false);
    await guest.screenshot({path:path.join(directory,'turn-notice-over-dialog.png')});await guest.locator('#turnNotice').waitFor({state:'hidden'});checks.push('centered 1.65-second turn notice appears above an open modal only for the acting player');
    for(let i=0;i<3;i++)await guest.evaluate(()=>RiverSession.sync());await guest.waitForTimeout(350);assert.equal(await guest.locator('#turnNotice').isVisible(),false);
    await guest.locator('#socialTarget').selectOption('0');await guest.locator('[data-gift="coffee"]').click();await guest.waitForFunction(()=>!RiverSession.getDiagnostics().pending);await guest.locator('#tableFeedback').filter({hasText:'送咖啡'}).waitFor();assert.equal(await guest.locator('#socialDialog').isVisible(),false);
    await host.locator('.gift-flight.gift-coffee svg').waitFor();assert.equal(await guest.locator('#turnNotice').isVisible(),false);checks.push('sync and social actions do not repeat the notice; illustrated gift and inline delivery feedback work');
    await guest.locator('#tableSocialBtn').click();
    for(const [width,height]of[[390,844],[320,568],[844,390],[1280,800]]){
      await guest.setViewportSize({width,height});await fitDialog(guest);
      for(const tab of['gifts','phrases','peek']){await guest.locator(`[data-social-tab="${tab}"]`).click();assert.equal(await guest.locator(`[data-social-tab="${tab}"]`).getAttribute('aria-selected'),'true');await fitDialog(guest);if(width===390||width===1280)await guest.screenshot({path:path.join(directory,`social-${tab}-${width}.png`)});}
    }
    checks.push('all three interaction tabs fit mobile, narrow mobile, landscape and desktop viewports');
    await guest.locator('[data-social-tab="gifts"]').focus();await guest.keyboard.press('ArrowRight');assert.equal(await guest.locator('[data-social-tab="phrases"]').getAttribute('aria-selected'),'true');await guest.keyboard.press('End');assert.equal(await guest.locator('[data-social-tab="peek"]').getAttribute('aria-selected'),'true');checks.push('tabs support keyboard navigation');
    await guest.getByRole('button',{name:'关闭互动'}).click();
    // A revision unrelated to betting must not create a fresh turn notification.
    const room=roomManager.games.get(code);room.game.revision++;roomManager.publish(room);await guest.waitForTimeout(250);assert.equal(await guest.locator('#turnNotice').isVisible(),false);checks.push('non-action revision updates do not retrigger the notice');
    for(let step=0;step<3;step++){
      const current=room.game,actor=current.players[current.currentPlayerIndex],page=pages[actor.id],revision=current.revision;
      await page.waitForFunction(rev=>(isHost?g:clientGameState).revision===rev&&!!document.querySelector('#actionPanel button'),revision);
      const action=await page.locator('.action-check').count()?'check':'call';await page.locator('.action-'+action).click();await host.waitForFunction(rev=>g.revision>rev,revision);
      const next=pages[room.game.players[room.game.currentPlayerIndex].id];await next.locator('#turnNotice').waitFor({state:'visible'});
      if(step===1){await next.screenshot({path:path.join(directory,'turn-notice-table-mobile.png')});}
    }
    checks.push('new turns trigger the notice across multiple clients and pointer-through action buttons remain usable');
    await guest.emulateMedia({reducedMotion:'reduce'});await guest.locator('#phraseOpenBtn').click();await fitDialog(guest);assert.equal(await guest.locator('#socialPanelPhrases').evaluate(e=>getComputedStyle(e).animationName),'none');await guest.getByRole('button',{name:'关闭互动'}).click();checks.push('reduced-motion preference removes entrance animations');
    assert.deepEqual(errors,[]);await fs.writeFile(path.join(__dirname,'social-ui-report.json'),JSON.stringify({date:new Date().toISOString(),checks,result:'passed',limit:'Local Chrome with independent clients and mobile viewports; physical phones not tested'},null,2));console.log(`Social UI and turn notice passed: ${checks.length} checks, 3 clients, 4 viewport sizes.`);
  }finally{await browser.close();for(const ws of wss.clients)ws.terminate();await new Promise(r=>wss.close(r));await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
