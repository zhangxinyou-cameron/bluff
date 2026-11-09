const assert=require('node:assert/strict'),{chromium}=require('playwright');
const {server,wss,access,roomManager}=require('../server'),{passwordRecord}=require('../access'),E=require('../public/poker-engine');
(async()=>{
  const password='loan-limits-browser-only';access.configure(await passwordRecord(password));roomManager.configureTimings({deal:80,action:30,street:70,runout:80});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}/`;
  const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'}),errors=[];
  const idle=p=>p.waitForFunction(()=>!RiverSession.getDiagnostics().pending);
  async function open(code){const context=await browser.newContext({viewport:code?{width:390,height:844}:{width:1280,height:800}});await context.addInitScript(()=>localStorage.setItem('river_audio',JSON.stringify({music:false,sfx:false})));
    const p=await context.newPage();p.on('pageerror',e=>errors.push(e.message));await p.goto(base+(code?'#room='+code:''));await p.getByLabel('访问密码').fill(password);await p.getByRole('button',{name:'验证并进入'}).click();await p.waitForFunction(()=>!!window.RiverSession);
    if(code){await p.waitForFunction(()=>wsConnected&&mySeatId>0);await p.locator('#readyBtn').click();await idle(p);}else{await p.locator('#createBtn').click();await p.locator('#waitTip').filter({hasText:'房间已创建'}).waitFor();await p.locator('#allowBuyInSel').selectOption('yes');await idle(p);}return p;}
  async function table(per,total){const host=await open();for(const [id,value]of [['loanPerHandLimit',per],['loanTotalLimit',total]]){await host.locator('#'+id).fill(value);await host.locator('#'+id).press('Tab');await idle(host);}
    const code=await host.locator('#displayRoomCode').textContent(),guest=await open(code),pages=[host,guest],room=roomManager.games.get(code);await guest.locator('#waitRuleSummary').filter({hasText:'未还本金上限'}).waitFor();await host.locator('#startBtn').click();await host.waitForFunction(()=>!!g);return{host,guest,pages,room};}
  async function finish(f){let steps=0;while(E.betting(f.room.game)){assert.ok(++steps<10);const game=f.room.game,p=game.players[game.currentPlayerIndex],page=f.pages[p.id],rev=game.revision;await page.locator('.action-fold').waitFor();await page.locator('.action-fold').click();await f.host.waitForFunction(rev=>g.revision>rev,rev);await idle(page);}for(const p of f.pages)await p.locator('#resultScreen').waitFor({state:'visible'});roomManager.check(f.room);}
  async function transact(f,kind,amount){const p=f.guest;await p.locator('#bankAmount').fill(String(amount));await p.locator(kind==='borrow'?'#bankBorrowBtn':'#bankRepayBtn').click();await idle(p);roomManager.check(f.room);}
  async function next(f){await f.guest.getByRole('button',{name:'关闭银行'}).click();const number=f.room.game.handNumber;for(const p of f.pages){await p.locator('#nextHandBtn').click();await idle(p);}await f.host.waitForFunction(n=>g.handNumber===n,number+1);await finish(f);await f.guest.locator('#bankBtn').click();}
  try{
    const f=await table('750','1000');assert.equal(f.room.game.loanPerHandLimit,750);assert.equal(f.room.game.loanTotalLimit,1000);await finish(f);await f.guest.locator('#bankBtn').click();
    await transact(f,'borrow',600);await transact(f,'borrow',150);assert.equal(f.room.game.players[1].bankDebt,750);assert.equal(await f.guest.locator('#bankBorrowBtn').isDisabled(),true);
    const version=f.room.game.bankSequence;await f.guest.evaluate(()=>{const s=clientGameState,p=s.players[mySeatId];RiverSession.command('bank',{kind:'borrow',amount:1,handNumber:s.handNumber,bankVersion:p.bankVersion});});await idle(f.guest);assert.equal(f.room.game.bankSequence,version);
    await transact(f,'repay',200);assert.equal(await f.guest.locator('#bankBorrowBtn').isDisabled(),true);
    await f.guest.reload();await f.guest.locator('#resultScreen').waitFor({state:'visible'});await f.guest.locator('#bankBtn').click();await f.guest.locator('#bankLimits').filter({hasText:'本手已借 750'}).waitFor();assert.equal(await f.guest.locator('#bankBorrowBtn').isDisabled(),true);
    await next(f);await f.guest.locator('#bankLimits').filter({hasText:'当前可再借：450'}).waitFor();await transact(f,'borrow',450);assert.equal(f.room.game.players[1].bankDebt,1000);
    await transact(f,'repay',100);await transact(f,'borrow',100);assert.equal(f.room.game.players[1].bankDebt,1000);
    await next(f);await transact(f,'repay',1000);await transact(f,'borrow',750);assert.equal(f.room.game.players[1].bankDebt,750);
    const zero=await table('0','无限');await finish(zero);await zero.guest.locator('#bankBtn').click();assert.equal(await zero.guest.locator('#bankBorrowBtn').isDisabled(),true);
    const unlimited=await table('无限','');await finish(unlimited);await unlimited.guest.locator('#bankBtn').click();await transact(unlimited,'borrow',25000);assert.equal(unlimited.room.game.players[1].bankDebt,25000);
    assert.deepEqual(errors,[]);console.log('Loan limit UI passed: 3 two-client tables, 5 hands, custom/zero/unlimited settings, split borrowing, repayment, refresh, next-hand reset and forged over-limit rejection.');
  }finally{await browser.close();for(const ws of wss.clients)ws.terminate();await new Promise(r=>wss.close(r));await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
