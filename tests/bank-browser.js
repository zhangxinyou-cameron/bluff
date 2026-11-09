const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {chromium}=require('playwright');
const {server,wss,access,roomManager}=require('../server');
roomManager.configureTimings({deal:100,street:100,runout:100,action:30});
const {passwordRecord}=require('../access');
(async()=>{
  const password='bank-'+require('node:crypto').randomBytes(10).toString('hex');access.configure(await passwordRecord(password));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}/`;
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe'}),errors=[],report=[];
  async function open(room,id){
    const context=await browser.newContext({viewport:id%2?{width:390,height:844}:{width:1280,height:900}});
    await context.addInitScript(()=>{
      localStorage.setItem('river_audio',JSON.stringify({music:false,sfx:false}));
      const send=WebSocket.prototype.send;
      WebSocket.prototype.send=function(value){if(typeof value==='string'){try{const data=JSON.parse(value);if(data.type==='bank')window.__lastBankMessage=data;}catch(_){}}return send.call(this,value);};
    });
    const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
    page.on('console',message=>{if(message.type()==='error'&&!message.text().includes('404'))errors.push(message.text());});
    await page.goto(base+(room?'#room='+room:''));await page.getByLabel('访问密码').fill(password);await page.getByRole('button',{name:'验证并进入'}).click();
    if(room){await page.waitForFunction(()=>mySeatId>0);await page.locator('#readyBtn').click();}
    else{await page.locator('#createBtn').click();await page.locator('#waitTip').filter({hasText:'房间已创建'}).waitFor();await page.locator('#allowBuyInSel').selectOption('yes');}
    return page;
  }
  const snapshot=page=>page.evaluate(()=>isHost?g:clientGameState);
  function balanced(state,n){assert.equal(state.players.reduce((sum,p)=>sum+p.chips-p.bankDebt,0)+state.pot,n*2000);for(const p of state.players){assert.equal(p.totalBorrowed-p.totalRepaid,p.bankDebt);assert.equal(p.eliminatedHand,null);}}
  async function awaitAccounts(pages,version){for(const page of pages)await page.waitForFunction(value=>(isHost?g:clientGameState).bankSequence===value,version);}
  async function transact(page,host,pages,kind,amount){
    await page.waitForFunction(()=>!RiverSession.getDiagnostics().pending);
    const before=await snapshot(host),id=await page.evaluate(()=>mySeatId),account=before.players.find(p=>p.id===id);
    const handNet=await page.locator('.player-result-row').nth(id).locator('.pr-net').textContent();
    await page.locator('#bankBtn').click();await page.locator('#bankAmount').fill(String(amount));
    await page.locator(kind==='borrow'?'#bankBorrowBtn':'#bankRepayBtn').click();
    await page.waitForFunction(version=>!bankPending&&(isHost?g:clientGameState).players.find(p=>p.id===mySeatId).bankVersion===version,account.bankVersion+1);
    await page.locator('#bankStatus').filter({hasText:'操作成功'}).waitFor();
    const after=await snapshot(host),updated=after.players.find(p=>p.id===id);
    assert.equal(updated.chips-updated.bankDebt,account.chips-account.bankDebt);
    assert.equal(after.nextHandReady.includes(id),false);
    assert.equal(await page.locator('.player-result-row').nth(id).locator('.pr-net').textContent(),handNet,'Bank transactions are not shown as hand winnings');
    await awaitAccounts(pages,after.bankSequence);
    for(const p of pages){const state=await snapshot(p);assert.deepEqual(state.players.map(p=>[p.chips,p.bankDebt,p.bankVersion]),after.players.map(p=>[p.chips,p.bankDebt,p.bankVersion]));}
    await page.getByRole('button',{name:'关闭银行'}).click();balanced(after,pages.length);
  }
  try{
    for(const count of[2,3,6]){
      const host=await open(null,0),room=await host.locator('#displayRoomCode').textContent(),pages=[host];
      for(let id=1;id<count;id++)pages.push(await open(room,id));
      for(const page of pages){await page.locator('#waitRuleSummary').filter({hasText:'银行买入场'}).waitFor();}
      await host.locator('#startBtn').click();
      const guest=pages[1];
      await guest.locator('#bankBtn').click();assert.equal(await guest.locator('#bankBorrowBtn').isDisabled(),true);
      await guest.locator('#bankStatus').filter({hasText:'本手进行中'}).waitFor();await guest.getByRole('button',{name:'关闭银行'}).click();
      await guest.evaluate(()=>ws.send(JSON.stringify({type:'finishSession'})));
      assert.equal((await snapshot(host)).endRequested,false);
      let totalActions=0,transactions=0,brokeSeen=false;
      for(let hand=1;hand<=6;hand++){
        if(hand===6&&count>2){await host.locator('#finishSessionBtn').click();assert.equal((await snapshot(host)).endRequested,true);assert.notEqual((await snapshot(host)).phase,'tournament_over');}
        let actions=0;
        while(true){
          const state=await snapshot(host);if(['hand_over','tournament_over'].includes(state.phase))break;
          if(state.phase==='runout_vote'){const voter=roomManager.games.get(room).game.runoutVote.eligibleIds.find(id=>!state.players.find(p=>p.id===id).isAI);await pages[voter].evaluate(handNumber=>RiverSession.command('runoutVote',{handNumber,twice:false}),state.handNumber);await host.waitForFunction(()=>g.phase!=='runout_vote');continue;}
          assert.ok(actions++<100,'bank game stalled');
          const actor=state.players[state.currentPlayerIndex],page=pages[actor.id];
          await page.waitForFunction(revision=>(isHost?g:clientGameState)?.revision===revision&&!!document.querySelector('#actionPanel button')&&!RiverSession.getDiagnostics().pending,state.revision);
          const selector=(hand===2||hand===4)&&await page.locator('.action-allin').count()?'.action-allin':await page.locator('.action-check').count()?'.action-check':'.action-call';
          await page.locator(selector).click();await host.waitForFunction(revision=>g.revision>revision,state.revision);
        }
        totalActions+=actions;
        const state=await snapshot(host);balanced(state,count);brokeSeen||=state.players.some(p=>p.chips===0);
        for(const page of pages)await page.locator(state.phase==='tournament_over'?'.final-ranking':'#resultScreen').waitFor({state:'visible'});
        if(state.phase==='tournament_over')break;
        assert.equal(state.phase,'hand_over','no bankruptcy auto-finish');
        for(let id=0;id<count;id++){
          await pages[id].locator('#nextHandBtn').click();assert.equal((await snapshot(host)).handNumber,hand);
          await transact(pages[id],host,pages,'borrow',id===0&&hand===3?100000:2000+hand*100);transactions++;
          await transact(pages[id],host,pages,'repay',50);transactions++;
        }
        if(hand===1){
          const before=await snapshot(host);
          await guest.evaluate(()=>ws.send(JSON.stringify(window.__lastBankMessage)));
          await guest.waitForFunction(()=>bankNotice.includes('已处理'));
          assert.deepEqual(await snapshot(host),before,'replay cannot repeat bank transaction');
          await guest.evaluate(()=>ws.send(JSON.stringify({...window.__lastBankMessage,requestId:'old-version-'+Date.now()})));
          await guest.waitForFunction(()=>bankNotice.includes('已更新'));
          assert.deepEqual(await snapshot(host),before);
        }
        if(hand===2){
          const before=await snapshot(host),attacker=before.players[1];
          await guest.evaluate(current=>ws.send(JSON.stringify({type:'bank',seatId:0,kind:'borrow',amount:77,handNumber:current.handNumber,bankVersion:current.players[1].bankVersion,requestId:'forged-seat-'+Date.now(),commandSeq:current.players[1].commandSeq+1})),before);
          await guest.waitForFunction(version=>clientGameState.players[1].bankVersion===version,attacker.bankVersion+1);
          const after=await snapshot(host);assert.equal(after.players[0].bankDebt,before.players[0].bankDebt);assert.equal(after.players[1].bankDebt,attacker.bankDebt+77);
          await awaitAccounts(pages,after.bankSequence);transactions++;
        }
        if(hand===6){await host.locator('#finishSessionBtn').click();break;}
        for(const page of pages)await page.locator('#nextHandBtn').click();
        await host.waitForFunction(number=>g.handNumber===number,hand+1);
      }
      const final=await snapshot(host);assert.equal(final.phase,'tournament_over');assert.equal(final.handNumber,6);balanced(final,count);
      const expected=final.players.slice().sort((a,b)=>(b.chips-b.bankDebt)-(a.chips-a.bankDebt)).map(p=>p.id);
      for(const page of pages){
        await page.locator('.final-ranking').waitFor();
        assert.deepEqual(await page.locator('.ranking-row').evaluateAll(rows=>rows.map(row=>Number(row.dataset.seat))),expected);
        assert.match(await page.locator('.ranking-note').textContent(),/未还贷款/);
        for(const player of final.players){
          const row=page.locator(`.ranking-row[data-seat="${player.id}"]`);
          assert.match(await row.locator('.ranking-player').textContent(),new RegExp('欠款 '+player.bankDebt));
          assert.ok((await row.locator('.ranking-chips').textContent()).startsWith(String(player.chips-player.bankDebt)));
        }
        await page.locator('#bankBtn').click();assert.equal(await page.locator('#bankBorrowBtn').isDisabled(),true);
        await page.getByRole('button',{name:'关闭银行'}).click();
        for(const width of[320,390,1280]){await page.setViewportSize({width,height:900});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}
      }
      if(count===6){
        await fs.mkdir(path.join(__dirname,'screenshots'),{recursive:true});
        await guest.setViewportSize({width:390,height:844});await guest.locator('#bankBtn').click();
        await guest.screenshot({path:path.join(__dirname,'screenshots','bank-mobile.png'),fullPage:true});
        await guest.getByRole('button',{name:'关闭银行'}).click();
        await guest.screenshot({path:path.join(__dirname,'screenshots','bank-ranking-mobile.png'),fullPage:true});
      }
      assert.deepEqual(errors,[]);
      report.push({clients:count,hands:6,actions:totalActions,transactions,brokeSeen,finalNet:final.players.map(p=>({id:p.id,chips:p.chips,debt:p.bankDebt,net:p.chips-p.bankDebt})),checks:'passed'});
      for(const page of pages)await page.context().close();
      console.log(`${count} clients: 6 buy-in hands; ${transactions} bank operations; balanced accounts and final net ranking passed.`);
    }
    await fs.writeFile(path.join(__dirname,'bank-report.json'),JSON.stringify(report,null,2));
    console.log('Bank multi-client self-check passed. Report: tests/bank-report.json');
  }finally{await browser.close();for(const ws of wss.clients)ws.terminate();await new Promise(resolve=>wss.close(resolve));await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
