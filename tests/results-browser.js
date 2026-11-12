const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {server,wss,access,roomManager}=require('../server');
const PokerEngine=require('../public/poker-engine');
const {passwordRecord}=require('../access');
(async()=>{
  const password='result-'+require('node:crypto').randomBytes(10).toString('hex');access.configure(await passwordRecord(password));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}/`;
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe'}),errors=[];
  async function open(room,name){
    const context=await browser.newContext({viewport:{width:390,height:844}});
    await context.addInitScript(value=>{localStorage.setItem('starstone_name',value);localStorage.setItem('river_audio',JSON.stringify({music:false,sfx:false}));},name);
    const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
    await page.goto(base+(room?'#room='+room:''));await page.getByLabel('访问密码').fill(password);await page.getByRole('button',{name:'验证并进入'}).click();
    if(room){await page.waitForFunction(()=>mySeatId>0);await page.locator('#readyBtn').click();}
    else{await page.locator('#createBtn').click();await page.locator('#waitTip').filter({hasText:'房间已创建'}).waitFor();}
    return page;
  }
  try{
    const host=await open(null,'小红'),room=await host.locator('#displayRoomCode').textContent();
    await host.locator('#minPlayersSel').selectOption('1');
    await host.waitForFunction(()=>!RiverSession.getDiagnostics().pending);
    const beta=await open(room,'Beta'),ming=await open(room,'小明'),pages=[host,beta,ming];
    await host.locator('#startBtn').click();
    // Deterministic result fixture produced by the actual engine, then sent over real sockets.
    {
      const activeRoom=roomManager.games.get(room),players=activeRoom.game.players.map(p=>({...p,chips:0}));const g=PokerEngine.createGame(players,20);
      const deck=PokerEngine.createDeck(),card=(rank,suit)=>deck.find(c=>c.rank===rank&&c.suit===suit);
      g.handNumber=7;g.dealerIndex=0;g.phase='river';g.communityCards=[card(2,0),card(3,1),card(7,2),card(9,3),card(11,0)];
      g.players.forEach((p,i)=>Object.assign(p,{totalBet:[2560,2640,2640][i],chipsBeforeHand:[2560,2640,2640][i],holeCards:[card([14,13,12][i],0),card([14,13,12][i],1)],isActive:true,folded:false}));
      g.pot=7840;PokerEngine.settle(g,true);activeRoom.game=g;g.initialTotal=7840;activeRoom.presentation=null;activeRoom.blockedUntil=0;roomManager.publish(activeRoom);
    }
    for(const page of pages){
      await page.locator('#winnerNames').filter({hasText:'小红 赢主池 7680'}).waitFor();
      assert.match(await page.locator('#winnerNames').textContent(),/Beta 赢边池 160/);
      assert.equal(await page.locator('.pot-allocation').count(),2);
      for(const width of[320,390,1280]){await page.setViewportSize({width,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}
    }
    {
      const activeRoom=roomManager.games.get(room),g=activeRoom.game;
      Object.assign(g.players[0],{chips:7840,eliminatedHand:null,eliminationStack:null});
      Object.assign(g.players[1],{chips:0,eliminatedHand:2,eliminationStack:2640});
      Object.assign(g.players[2],{chips:0,eliminatedHand:9,eliminationStack:160});
      g.handNumber=9;roomManager.publish(activeRoom);
    }
    for(const page of[beta,ming]){
      await page.locator('#nextHandStatus').filter({hasText:'等待房主公布排名'}).waitFor();
      assert.equal(await page.locator('#nextHandBtn').isVisible(),false);
    }
    await host.locator('#nextHandBtn').click();
    for(const page of pages){
      await page.locator('.final-ranking').waitFor();
      assert.deepEqual(await page.locator('.ranking-row').evaluateAll(rows=>rows.map(row=>[Number(row.dataset.seat),Number(row.dataset.place)])),[[0,1],[2,2],[1,3]]);
      assert.match(await page.locator('.ranking-row[data-seat="2"]').textContent(),/第 9 局出局/);
      for(const width of[320,390,1280]){await page.setViewportSize({width,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}
    }
    assert.deepEqual(errors,[]);
    console.log('Results QA passed: exact main/side-pot awards on 3 clients; waiting-for-host message; elimination-based identical rankings; 320/390/1280px layouts.');
  }finally{await browser.close();for(const ws of wss.clients)ws.terminate();await new Promise(resolve=>wss.close(resolve));await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
