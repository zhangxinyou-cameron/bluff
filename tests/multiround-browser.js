const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');
const { server, wss, access, roomManager } = require('../server');
roomManager.configureTimings({deal:100,street:100,runout:100,action:30,ai:100});
const { passwordRecord } = require('../access');

(async () => {
  const password = 'multi-' + require('node:crypto').randomBytes(12).toString('hex');
  access.configure(await passwordRecord(password));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  const errors = [];
  const report = [];
  async function open(room, index) {
    const context = await browser.newContext({ viewport: index % 2 ? { width: 390, height: 844 } : { width: 1280, height: 900 } });
    await context.addInitScript(() => localStorage.setItem('river_audio', JSON.stringify({ music: false, sfx: false })));
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', msg => { if (msg.type() === 'error' && !msg.text().includes('404')) errors.push(msg.text()); });
    await page.goto(base + (room ? '#room=' + room : ''));
    await page.getByLabel('访问密码').fill(password);
    await page.getByRole('button', { name: '验证并进入' }).click();
    await page.locator('.site-header').waitFor();
    if (room) {
      await page.locator('#readyBtn').waitFor({ state: 'visible' });
      await page.waitForFunction(() => !document.getElementById('readyBtn').disabled);
      await page.locator('#readyBtn').click();
      await page.waitForFunction(() => document.getElementById('readyBtn').disabled);
    }
    return page;
  }
  const state = page => page.evaluate(() => isHost ? window.g : clientGameState);
  try {
    for (const count of [2, 4, 5, 8]) {
      const host = await open(null, 0);
      await host.locator('#createBtn').click();
      await host.locator('#waitTip').filter({ hasText: '房间已创建' }).waitFor();
      await host.locator('#minPlayersSel').selectOption('1');
      const room = await host.locator('#displayRoomCode').textContent();
      const players = [host];
      for (let seat=1; seat<count; seat++) players.push(await open(room, seat));
      await host.locator('#startBtn').click();
      for (let hand=1; hand<=6; hand++) {
        let actions = 0;
        const phases = new Set();
        while (true) {
          const game = await state(host);
          if(game.phase==='runout_vote'){const voter=roomManager.games.get(room).game.runoutVote.eligibleIds.find(id=>!game.players.find(p=>p.id===id).isAI);await players[voter].evaluate(handNumber=>RiverSession.command('runoutVote',{handNumber,twice:false}),game.handNumber);await host.waitForFunction(()=>g.phase!=='runout_vote');continue;}
          phases.add(game.phase);
          if (game.phase === 'hand_over') break;
          assert.ok(actions++ < 100, 'Hand did not terminate');
          const actor = game.players[game.currentPlayerIndex];
          const page = players[actor.id];
          await page.waitForFunction(({ hand, bet, seat }) => {
            const current = isHost ? window.g : clientGameState;
            return current?.handNumber === hand && current.currentBet === bet && current.players[current.currentPlayerIndex]?.id === seat && document.querySelector('#actionPanel button');
          }, { hand: game.handNumber, bet: game.currentBet, seat: actor.id }, { timeout: 5000 });
          const before = JSON.stringify(game);
          if (hand === 6 && actions === 1) {
            await page.locator('.action-allin').click();
          } else if (hand%3 === 2 && actions === 1) {
            await page.locator('.action-raise').click();
            await page.locator('.action-confirm').click();
          } else {
            const button = await page.locator('.action-check').count() ? '.action-check' : '.action-call';
            await page.locator(button).click();
          }
          await host.waitForFunction(previous => JSON.stringify(window.g) !== previous, before, { timeout: 5000 });
          const current = await state(host);
          for (const client of players.slice(1)) {
            await client.waitForFunction(revision => clientGameState?.revision === revision, current.revision);
            const snapshot = await state(client);
            assert.equal(snapshot.phase, current.phase);
            assert.deepEqual(snapshot.players.map(p=>[p.id,p.chips,p.currentBet,p.folded,p.allIn]),current.players.map(p=>[p.id,p.chips,p.currentBet,p.folded,p.allIn]));
          }
          assert.deepEqual(errors, [], `Client errors at ${count} players, hand ${hand}`);
        }
        for (const page of players) {
          await page.locator('#resultScreen').waitFor({ state: 'visible' });
          assert.ok((await page.locator('#winnerNames').textContent()).length > 0, 'Every client shows winners');
          const snapshot = await state(page);
          assert.equal(snapshot.players.reduce((sum,p)=>sum+p.chips,0), count*2000, 'Chips conserved');
          assert.deepEqual(errors, [], 'No settlement errors');
        }
        report.push({ players: count, hand, actions, phases: [...phases] });
        if (hand<6) {
          await host.locator('#nextHandBtn').click();
          assert.equal((await state(host)).handNumber,hand,'Host alone cannot advance');
          for (const client of players.slice(1)) await client.locator('#nextHandBtn').click();
          await host.waitForFunction(number => window.g.handNumber === number, hand+1);
        }
      }
      for (const page of players) await page.context().close();
      console.log(`${count} clients: 6 complete hands passed`);
    }
    // Sparse seats and a human/AI game exercise ID/index separation over several hands.
    {
      const host=await open(null,0);
      await host.locator('#createBtn').click();
      await host.locator('#waitTip').filter({hasText:'房间已创建'}).waitFor();
      await host.locator('#minPlayersSel').selectOption('1');
      const room=await host.locator('#displayRoomCode').textContent();
      const leaving=await open(room,1), guest=await open(room,2);
      await leaving.evaluate(()=>RiverSession.leave({reload:false,permanent:true}));
      await leaving.context().close();
      await host.waitForFunction(()=>seats[1]===null);
      await host.locator('.mini-btn').filter({hasText:'+'}).click();
      await host.locator('.mini-btn').filter({hasText:'+'}).click();
      await host.locator('#seats > .seat').nth(5).click();
      await host.locator('#startBtn').click();
      assert.deepEqual((await state(host)).players.map(p=>p.id),[0,2,5]);
      const old=await state(host);
      // A guest cannot forge an acting seat or advance hands/publish fake state.
      await guest.evaluate(current=>ws.send(JSON.stringify({type:'state',game:{phase:'hand_over'},requestId:'forged-state',commandSeq:current.players.find(p=>p.id===mySeatId).commandSeq+1})),old);
      await guest.waitForFunction(()=>document.getElementById('connectionText').textContent.includes('不能修改'));
      assert.equal((await state(host)).handNumber,old.handNumber);
      for (let hand=1;hand<=3;hand++) {
        let actions=0;
        while ((await state(host)).phase!=='hand_over') {
          assert.ok(actions++<100,'Mixed AI game is stuck');
          const current=await state(host);
          const actor=current.players[current.currentPlayerIndex];
          if (actor.isAI) {
            await host.waitForFunction(revision=>window.g.revision!==revision,current.revision,{timeout:5000});
          } else {
            const client=actor.id===0?host:guest;
            await client.waitForFunction(revision=>(isHost?window.g:clientGameState)?.revision===revision&&!!document.querySelector('#actionPanel button'),current.revision);
            const selector=await client.locator('.action-check').count()?'.action-check':'.action-call';
            await client.locator(selector).click();
            await host.waitForFunction(revision=>window.g.revision!==revision,current.revision,{timeout:5000});
          }
        }
        await guest.locator('#resultScreen').waitFor({state:'visible'});
        assert.equal((await state(host)).players.reduce((sum,p)=>sum+p.chips,0),6000);
        assert.deepEqual(errors,[]);
        report.push({players:3,hand,actions,sparseSeats:[0,2,5],ai:true});
        if (hand<3) {
          await host.locator('#nextHandBtn').click();
          assert.equal((await state(host)).handNumber,hand);
          await guest.locator('#nextHandBtn').click();
          await host.waitForFunction(number=>window.g.handNumber===number,hand+1);
        }
      }
      await host.context().close(); await guest.context().close();
      console.log('Sparse seats + AI: 3 complete hands and forged-action rejection passed');
    }
    await fs.writeFile(path.join(__dirname,'multiround-report.json'),JSON.stringify(report,null,2));
    console.log(`${report.length} complete multi-client hands passed; ${report.reduce((sum,item)=>sum+item.actions,0)} actions. Report: tests/multiround-report.json`);
  } finally {
    await browser.close();
    for (const ws of wss.clients) ws.terminate();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
