const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');
const {chromium}=require('playwright');const{server,wss,access,roomManager}=require('../server');const{passwordRecord}=require('../access');
(async()=>{
  access.configure(await passwordRecord('feature-test-only-password'));roomManager.configureTimings({deal:250,street:150,runout:300,action:60,ai:100,vote:8000});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}/`;
  const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'}),errors=[],checks=[],hands=[];
  async function open(room,id){const context=await browser.newContext({viewport:{width:390,height:844}});await context.addInitScript(id=>{localStorage.setItem('river_audio',JSON.stringify({music:false,sfx:false}));localStorage.setItem('starstone_name','Player '+id);},id);
    const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(base+(room?'#room='+room:''));await page.getByLabel('访问密码').fill('feature-test-only-password');await page.getByRole('button',{name:'验证并进入'}).click();
    if(room){await page.waitForFunction(()=>mySeatId>0);await page.locator('#readyBtn').click();}else{await page.locator('#createBtn').click();await page.locator('#waitTip').filter({hasText:'房间已创建'}).waitFor();await page.locator('#allowBuyInSel').selectOption('yes');await idle(page);}return page;
  }
  const idle=page=>page.waitForFunction(()=>!RiverSession.getDiagnostics().pending);
  const snapshot=page=>page.evaluate(()=>isHost?g:clientGameState);
  let pages,host,room;
  async function step(kind){const g=room.game,actor=g.players[g.currentPlayerIndex],page=pages[actor.id],revision=g.revision;
    await page.waitForFunction(rev=>(isHost?g:clientGameState)?.revision===rev&&!!document.querySelector('#actionPanel button'),revision);
    const selector=kind||((await page.locator('.action-check').count())?'check':'call');await page.locator('.action-'+selector).click();await host.waitForFunction(rev=>g.revision>rev,revision);await idle(page);
  }
  async function finish(mode='normal'){
    let actions=0;while(!['hand_over','tournament_over'].includes(room.game.phase)){
      if(room.game.phase==='runout_vote'){
        const ids=[...room.game.runoutVote.eligibleIds];
        if(mode==='timeout'){room.game.runoutVote.expiresAt=Date.now()-1;roomManager.tick();}
        else if(mode==='twice'){for(const id of ids){await pages[id].locator('#voteTwiceBtn').click();await idle(pages[id]);}}
        else{await pages[ids[0]].locator('#voteOnceBtn').click();await idle(pages[ids[0]]);}
        continue;
      }
      assert.ok(++actions<100);const g=room.game,p=g.players[g.currentPlayerIndex];await step(mode!=='normal'&&p.canRaise!==false&&require('../public/poker-engine').canRaise(g,p)?'allin':undefined);
    }
    for(const page of pages.filter((_,i)=>room.people.get(i)?.connected))await page.locator(room.game.phase==='tournament_over'?'.final-ranking':'#resultScreen').waitFor({state:'visible'});
    roomManager.check(room);hands.push({hand:room.game.handNumber,mode,boards:room.game.runoutBoards?.length||1,actions});
  }
  async function buyIn(){for(const p of room.game.players.filter(p=>p.connected!==false)){
    const page=pages[p.id];await page.locator('#bankBtn').click();await page.locator('#bankAmount').fill('1000');await page.locator('#bankBorrowBtn').click();await idle(page);await page.getByRole('button',{name:'关闭银行'}).click();
  }}
  async function next(){const hand=room.game.handNumber;for(const p of room.game.players.filter(p=>!p.isAI&&!p.disconnected&&p.connected!==false)){await idle(pages[p.id]);await pages[p.id].locator('#nextHandBtn').click();}await host.waitForFunction(n=>g.handNumber===n,hand+1);}
  try{
    await fs.mkdir(path.join(__dirname,'screenshots'),{recursive:true});
    host=await open(null,0);const code=await host.locator('#displayRoomCode').textContent();pages=[host];for(let i=1;i<4;i++)pages.push(await open(code,i));room=roomManager.games.get(code);
    await host.locator('#startBtn').click();await pages[1].locator('.action-raise').waitFor();assert.equal(room.game.variant,'short');
    assert.equal(await host.locator('#voiceDock').count(),0);checks.push('microphone UI and relay removed');
    for(const [width,height]of[[390,844],[320,568],[844,390],[1280,800]]){
      const page=pages[1];await page.setViewportSize({width,height});await page.waitForFunction(height=>parseInt(document.documentElement.style.getPropertyValue('--play-height'),10)===height,height);await page.evaluate(()=>document.getElementById('playWorkspace').scrollIntoView({block:'start',behavior:'instant'}));
      const boxes=await page.evaluate(()=>({height:innerHeight,width:innerWidth,pageWidth:document.documentElement.scrollWidth,rects:['actionPanel','winRateText','chatInput'].map(id=>{const r=document.getElementById(id).getBoundingClientRect();return{id,top:r.top,bottom:r.bottom,height:r.height};})}));
      assert.ok(boxes.pageWidth<=width,JSON.stringify(boxes));for(const b of boxes.rects)assert.ok(b.height>0&&b.top>=-1&&b.bottom<=height+1,JSON.stringify(boxes));
      if(width===390||width===320||width===1280)await page.screenshot({path:path.join(__dirname,'screenshots',`features-play-${width}.png`)});
    }
    await pages[1].setViewportSize({width:390,height:844});await pages[1].waitForFunction(()=>parseInt(document.documentElement.style.getPropertyValue('--play-height'),10)===844);await pages[1].evaluate(()=>document.getElementById('playWorkspace').scrollIntoView({block:'start',behavior:'instant'}));
    assert.equal(await pages[1].locator('#turnCue').getAttribute('data-active'),'true');checks.push('chat, win rate, action controls and clear turn countdown fit one viewport at four sizes');
    await pages[1].locator('.action-raise').click();
    const range=pages[1].locator('.raise-slider input[type=range]');assert.equal(await range.getAttribute('step'),'10');
    await range.evaluate(e=>{e.value='100';e.dispatchEvent(new Event('input',{bubbles:true}));});await range.focus();await pages[1].keyboard.press('ArrowRight');assert.equal(await pages[1].locator('#raiseAmount').inputValue(),'110');
    await pages[1].keyboard.press('ArrowLeft');assert.equal(await pages[1].locator('#raiseAmount').inputValue(),'100');await pages[1].keyboard.press('End');const stackMax=room.game.players[1].chips+room.game.players[1].currentBet;assert.equal(await pages[1].locator('#raiseAmount').inputValue(),String(stackMax));await pages[1].locator('#raiseMaxBtn').click();assert.equal(await pages[1].locator('#raiseAmount').inputValue(),String(stackMax));
    const expectedPotRaise=Math.max(room.game.currentBet+room.game.minRaise,room.game.currentBet+Math.round(.75*(room.game.pot+Math.max(0,room.game.currentBet-room.game.players[1].currentBet))));await pages[1].locator('.raise-presets button[data-pot-fraction="0.75"]').click();assert.equal(await pages[1].evaluate(()=>raiseValue),expectedPotRaise);
    await pages[1].screenshot({path:path.join(__dirname,'screenshots','features-raise-mobile.png')});
    await pages[1].locator('#raiseAmount').fill('77');await pages[1].locator('.action-confirm').click();await host.waitForFunction(()=>g.currentBet===77);await idle(pages[1]);checks.push('raise multiplier presets and arbitrary numeric raise');
    await step('fold');assert.equal(room.game.players[2].folded,true);const beforeTip=room.game.players[2].chips;
    await pages[2].locator('.player-card[data-seat="0"]').click();await pages[2].locator('[data-social-tab="peek"]').click();await pages[2].locator('#peekTip').fill('25');await pages[2].locator('#requestPeekBtn').click();await idle(pages[2]);
    assert.equal((await snapshot(pages[2])).players[0].holeCards.length,0);await pages[2].getByRole('button',{name:'关闭互动'}).click();
    await host.locator('#peekConsentAccept').click();await idle(host);await host.locator('#tableSocialBtn').click();
    await pages[2].waitForFunction(()=>clientGameState.players[0].holeCards.length===2);assert.equal((await snapshot(pages[3])).players[0].holeCards.length,0);assert.equal(room.game.players[2].chips,beforeTip);
    assert.match(await pages[2].locator('.player-card[data-seat="0"]').textContent(),/仅向你亮牌/);checks.push('owner consent reveals cards to one folded viewer and leaves other packets private');
    await host.locator('[data-social-tab="phrases"]').click();await host.locator('[data-phrase="hurry"]').click();await idle(host);await host.getByRole('button',{name:'关闭互动'}).click();
    await pages[3].locator('.player-card[data-seat="0"] .speech-bubble').waitFor();
    await pages[3].locator('#chatInput').fill('语言包之后仍正常聊天');await pages[3].locator('.chat-send').click();await idle(pages[3]);await pages[3].locator('.player-card[data-seat="0"] .speech-bubble').waitFor();
    await pages[2].locator('#phraseOpenBtn').click();await pages[2].locator('[data-social-tab="gifts"]').click();await pages[2].locator('#socialTarget').selectOption('3');await pages[2].locator('[data-gift="tomato"]').click();await idle(pages[2]);await pages[3].locator('.gift-flight.gift-tomato').waitFor();assert.equal(await pages[2].locator('#socialDialog').isVisible(),false);checks.push('classic phrase bubble persists through updates, gift dialog closes and tomato animation reaches chosen target');
    await finish();assert.equal(room.game.players[2].chips,beforeTip-25);checks.push('accepted tip transfers exactly once after settlement');
    await host.locator('#tableDeckMode').selectOption('standard');await idle(host);await next();assert.equal(room.game.variant,'standard');await finish('twice');assert.equal(room.game.runoutBoards.length,2);
    for(const page of pages){assert.equal(await page.locator('.board-result').count(),2);assert.ok(await page.locator('.pot-allocation small').count()>0);}checks.push('all four players explicitly agree to two boards and see per-board payouts');
    await buyIn();const old=room.game.players[3];const balance=[old.chips,old.bankDebt];
    await pages[3].locator('#awayBtn').click();await pages[3].locator('#homeScreen').waitFor({state:'visible'});assert.equal(room.people.get(3).connected,false);
    await pages[3].locator('#joinBtn').click();await pages[3].locator('#roomCodeInput').fill(code);await pages[3].locator('#confirmJoinBtn').click();await pages[3].waitForFunction(()=>mySeatId===3&&clientGameState?.handNumber===2);
    assert.deepEqual([room.game.players[3].chips,room.game.players[3].bankDebt],balance);checks.push('explicit leave then manual rejoin restores original position and account');
    await host.locator('#managePlayersBtn').click();await host.locator('#socialTarget').selectOption('3');await host.locator('#kickPlayerBtn').click();await idle(host);await host.getByRole('button',{name:'关闭互动'}).click();
    await pages[3].locator('#connectionText').filter({hasText:'移出'}).waitFor();assert.equal(room.game.players[3].disconnected,true);await pages[3].locator('#confirmJoinBtn').click();await pages[3].waitForFunction(()=>mySeatId===3&&wsConnected);assert.deepEqual([room.game.players[3].chips,room.game.players[3].bankDebt],balance);checks.push('host kick disconnects immediately; explicit rejoin restores the original seat and account');
    await host.locator('#tableDeckMode').selectOption('short');await idle(host);await next();assert.equal(room.game.variant,'short');await finish('once');assert.equal(room.game.runoutBoards,null);checks.push('one player declining runs a single board');
    await buyIn();await next();await finish('timeout');assert.equal(room.game.runoutBoards,null);checks.push('negotiation timeout resolves safely without stalling');
    await host.locator('#finishSessionBtn').click();await host.locator('.final-ranking').waitFor();assert.equal(await host.locator('.ranking-row').count(),4);roomManager.check(room);checks.push('final debt-adjusted ranking retains departed accounts');
    await fs.mkdir(path.join(__dirname,'screenshots'),{recursive:true});await host.screenshot({path:path.join(__dirname,'screenshots','table-features-final.png'),fullPage:true});assert.deepEqual(errors,[]);
    await fs.writeFile(path.join(__dirname,'table-features-report.json'),JSON.stringify({testedAt:new Date().toISOString(),checks,hands,result:'passed',limits:'Local Chrome independent contexts, mobile viewports; physical phones/WAN not tested'},null,2));
    console.log(`New table features passed: ${checks.length} checks, ${hands.length} complete hands, 4 independent clients.`);
  }finally{await browser.close();for(const ws of wss.clients)ws.terminate();await new Promise(resolve=>wss.close(resolve));await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
