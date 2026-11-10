const assert=require('node:assert/strict'),{chromium}=require('playwright');
const {server,wss,access,roomManager}=require('../server'),{passwordRecord}=require('../access'),E=require('../public/poker-engine');
(async()=>{
  const password='win-rate-rule-test-only';access.configure(await passwordRecord(password));roomManager.configureTimings({deal:80,street:80,action:30,runout:80});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}/`;
  const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'}),errors=[];
  const idle=p=>p.waitForFunction(()=>!RiverSession.getDiagnostics().pending);
  async function open(code){const ctx=await browser.newContext({viewport:code?{width:390,height:844}:{width:1280,height:800}});await ctx.addInitScript(()=>localStorage.setItem('river_audio',JSON.stringify({music:false,sfx:false})));
    const p=await ctx.newPage();p.on('pageerror',e=>errors.push(e.message));await p.goto(base+(code?'#room='+code:''));await p.getByLabel('访问密码').fill(password);await p.getByRole('button',{name:'验证并进入'}).click();await p.waitForFunction(()=>!!window.RiverSession);
    if(code){await p.waitForFunction(()=>wsConnected&&mySeatId>0);await p.locator('#readyBtn').click();await idle(p);}else{await p.locator('#createBtn').click();await p.locator('#waitTip').filter({hasText:'房间已创建'}).waitFor();await p.locator('#allowBuyInSel').selectOption('yes');await idle(p);}return p;}
  async function inspect(p,show){await p.waitForFunction(show=>{const s=isHost?g:clientGameState,e=document.getElementById('winRateText');return s?.showWinRate===show&&e.hidden===!show&&(show?e.textContent.includes('%'):e.textContent==='');},show);assert.equal(await p.locator('#winRateText').isVisible(),show);}
  try{
    for(const show of [false,true]){
      const host=await open();assert.equal(await host.locator('#showWinRateSel').inputValue(),'yes');
      await host.locator('#showWinRateSel').selectOption(show?'yes':'no');await idle(host);
      const code=await host.locator('#displayRoomCode').textContent(),guest=await open(code),pages=[host,guest],room=roomManager.games.get(code);
      await guest.locator('#waitRuleSummary').filter({hasText:show?'显示胜率':'不显示胜率'}).waitFor();
      for(const p of pages)await p.evaluate(()=>{window.__oddsCalls=0;const calc=calcWinRate;calcWinRate=(...args)=>{window.__oddsCalls++;return calc(...args);};});
      await host.locator('#startBtn').click();await host.waitForFunction(()=>g?.phase==='pre_flop');
      for(let hand=1;hand<=2;hand++){
        let steps=0,refreshed=false;
        while(E.betting(room.game)){
          assert.ok(++steps<15);const game=room.game,rev=game.revision,p=game.players[game.currentPlayerIndex];
          for(const viewer of pages)await inspect(viewer,show);
          if(hand===1&&game.phase==='flop'&&!refreshed){await guest.reload();await inspect(guest,show);refreshed=true;}
          const actor=pages[p.id];await actor.waitForFunction(rev=>(isHost?g:clientGameState)?.revision===rev&&!!document.querySelector('#actionPanel button'),rev);
          await actor.locator(p.currentBet<game.currentBet?'.action-call':'.action-check').click();await idle(actor);await host.waitForFunction(rev=>g.revision>rev,rev);
        }
        for(const viewer of pages)await viewer.locator('#resultScreen').waitFor({state:'visible'});roomManager.check(room);
        if(hand===1){for(const viewer of pages){await viewer.locator('#nextHandBtn').click();await idle(viewer);}await host.waitForFunction(()=>g.handNumber===2);}
      }
      assert.equal((await host.evaluate(()=>window.__oddsCalls))>0,show);
      for(const p of pages)await p.context().close();
    }
    assert.deepEqual(errors,[]);console.log('Win-rate rule passed: 2 independent clients, both settings, 4 full hands, all streets, refresh recovery, and disabled calculation.');
  }finally{await browser.close();for(const ws of wss.clients)ws.terminate();await new Promise(r=>wss.close(r));await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
