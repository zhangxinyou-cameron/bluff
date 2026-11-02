const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {server,wss,access,roomManager}=require('../server');
const {passwordRecord}=require('../access');
const E=require('../public/poker-engine');
(async()=>{
  const password='street-action-regression-only';access.configure(await passwordRecord(password));
  roomManager.configureTimings({deal:150,action:60,street:180,runout:200});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}/`,errors=[];
  const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
  const idle=page=>page.waitForFunction(()=>!RiverSession.getDiagnostics().pending);
  async function open(code,id){
    const context=await browser.newContext({viewport:id?{width:390,height:844}:{width:1280,height:800}});
    await context.addInitScript(id=>{localStorage.setItem('starstone_name','换轮测试'+id);localStorage.setItem('river_audio',JSON.stringify({music:false,sfx:false}));},id);
    const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(base+(code?'#room='+code:''));
    await page.getByLabel('访问密码').fill(password);await page.getByRole('button',{name:'验证并进入'}).click();await page.waitForFunction(()=>!!window.RiverSession);
    if(code){await page.waitForFunction(()=>wsConnected&&mySeatId>0);await page.locator('#readyBtn').click();await idle(page);}
    else{await page.locator('#createBtn').click();await page.locator('#waitTip').filter({hasText:'房间已创建'}).waitFor();await page.locator('#allowBuyInSel').selectOption('yes');await idle(page);await page.locator('#blindModeSel').selectOption('standard');await idle(page);}
    return page;
  }
  let transitions=0,actions=0,refreshed=false;
  async function clearRound(pages,room){
    for(const page of pages){
      await page.waitForFunction(phase=>{
        const state=isHost?g:clientGameState;
        return state?.phase===phase&&document.querySelectorAll('.player-action').length===state.players.length&&[...document.querySelectorAll('.player-action')].every(e=>/^(尚未行动|已弃牌|已全押|本手旁观)/.test(e.textContent))&&document.getElementById('actionAnnouncement').dataset.action==='deal';
      },room.game.phase);
      assert.match(await page.locator('#actionAnnouncement').textContent(),/等待行动/);
    }
  }
  try{
    const host=await open(null,0),code=await host.locator('#displayRoomCode').textContent(),pages=[host,await open(code,1),await open(code,2)],room=roomManager.games.get(code);
    await host.locator('#startBtn').click();await host.waitForFunction(()=>g?.phase==='pre_flop');
    for(let hand=1;hand<=2;hand++){
      await clearRound(pages,room);
      while(E.betting(room.game)){
        assert.ok(++actions<50);const game=room.game,phase=game.phase,actor=game.players[game.currentPlayerIndex],page=pages[actor.id],rev=game.revision;
        await page.waitForFunction(rev=>(isHost?g:clientGameState)?.revision===rev&&!!document.querySelector('#actionPanel button'),rev);
        const action=hand===2&&phase==='pre_flop'&&!game.players.some(p=>p.folded)?'fold':actor.currentBet<game.currentBet?'call':'check';
        await page.locator('.action-'+action).click();await idle(page);await host.waitForFunction(rev=>g.revision>rev,rev);
        if(game.phase!==phase&&E.betting(game)){
          transitions++;await clearRound(pages,room);
          if(!refreshed){await pages[1].reload();await pages[1].waitForFunction(()=>wsConnected&&clientGameState?.phase==='flop');await clearRound(pages,room);refreshed=true;}
        }else if(game.phase===phase){
          for(const viewer of pages)await viewer.locator(`.player-card[data-seat="${actor.id}"] .player-action`).filter({hasText:action==='fold'?'弃牌':action==='call'?'跟注':'过牌'}).waitFor();
        }
        roomManager.check(room);
      }
      for(const page of pages)await page.locator('#resultScreen').waitFor({state:'visible'});
      if(hand===1){for(const page of pages){await page.locator('#nextHandBtn').click();await idle(page);}await host.waitForFunction(()=>g.handNumber===2);}
    }
    assert.equal(transitions,6);assert.equal(refreshed,true);assert.equal(room.history.filter(e=>e.kind==='action').length,actions);
    for(const page of pages){await page.locator('#historyFilter').selectOption('all');assert.ok(await page.locator('#chatBox .event-action').count()>0);}
    assert.deepEqual(errors,[]);console.log(`Street action UI passed: 3 clients, 2 hands, ${transitions} new betting rounds, refresh recovery and complete history.`);
  }finally{await browser.close();for(const ws of wss.clients)ws.terminate();await new Promise(r=>wss.close(r));await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
