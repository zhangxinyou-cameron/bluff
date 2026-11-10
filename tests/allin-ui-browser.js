const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),{chromium}=require('playwright');
const {server,wss,access,roomManager}=require('../server'),{passwordRecord}=require('../access'),E=require('../public/poker-engine');
(async()=>{
  const password='shove-ui-test-only';access.configure(await passwordRecord(password));roomManager.configureTimings({deal:80,action:30,runout:120000});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}/`,browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'}),errors=[];
  const idle=p=>p.waitForFunction(()=>!RiverSession.getDiagnostics().pending);
  async function open(code){const ctx=await browser.newContext({viewport:{width:390,height:844}});await ctx.addInitScript(()=>localStorage.setItem('river_audio',JSON.stringify({music:false,sfx:false})));const p=await ctx.newPage();p.on('pageerror',e=>errors.push(e.message));await p.goto(base+(code?'#room='+code:''));await p.getByLabel('访问密码').fill(password);await p.getByRole('button',{name:'验证并进入'}).click();await p.waitForFunction(()=>!!window.RiverSession);if(code){await p.waitForFunction(()=>wsConnected&&mySeatId>0);await p.locator('#readyBtn').click();await idle(p);}else{await p.locator('#createBtn').click();await p.locator('#waitTip').filter({hasText:'房间已创建'}).waitFor();}return p;}
  try{
    const host=await open(),code=await host.locator('#displayRoomCode').textContent(),guest=await open(code),pages=[host,guest],room=roomManager.games.get(code);
    await host.locator('#startBtn').click();await guest.locator('.action-allin').filter({hasText:'梭哈'}).waitFor();await guest.locator('.action-raise').click();assert.equal(await guest.locator('#raiseMaxBtn').textContent(),'梭哈');await guest.locator('.action-cancel').click();await guest.locator('.action-allin').click();await idle(guest);assert.match(room.history.find(e=>e.action==='allin').label,/梭哈/);
    const directory=path.join(__dirname,'screenshots');await fs.mkdir(directory,{recursive:true});
    for(const n of [3,8]){
      const g=E.createGame(Array.from({length:n},(_,id)=>({id,name:'玩家'+id,chips:2000,isAI:id>1,connected:true})),20,{allowBuyIn:true,runTwiceEnabled:true,blindMode:'standard'});E.startHand(g);
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
    assert.deepEqual(errors,[]);console.log('Shove UI passed: 2 clients, 3/8-seat double-board fixtures, 6 viewports, no badge/action overlap, and consistent 梭哈 controls/history.');
  }finally{await browser.close();for(const ws of wss.clients)ws.terminate();await new Promise(r=>wss.close(r));await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
