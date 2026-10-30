const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');
const { server, wss, access } = require('../server');
const { passwordRecord } = require('../access');

(async () => {
  const password = 'ui-test-' + require('node:crypto').randomBytes(12).toString('hex');
  access.configure(await passwordRecord(password));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const directory = path.join(__dirname, 'screenshots');
  await fs.mkdir(directory, { recursive: true });
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  const errors = [];
  async function newPage(viewport) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      window.__audioStarts = 0;
      const original = AudioBufferSourceNode.prototype.start;
      AudioBufferSourceNode.prototype.start = function(...args) { window.__audioStarts++; return original.apply(this, args); };
    });
    return page;
  }
  async function login(page) {
    await page.getByLabel('访问密码').fill(password);
    await page.getByRole('button', { name: '验证并进入' }).click();
    await page.locator('.site-header').waitFor();
  }
  async function fits(page, label) {
    const sizes = await page.evaluate(() => ({ viewport: innerWidth, page: document.documentElement.scrollWidth }));
    if(sizes.page>sizes.viewport)console.log(await page.evaluate(()=>[...document.querySelectorAll('body *')].map(e=>({tag:e.tagName,id:e.id,cls:e.className,right:e.getBoundingClientRect().right,width:e.getBoundingClientRect().width})).filter(x=>x.right>innerWidth+1&&x.width>0).slice(0,18)));
    assert.ok(sizes.page <= sizes.viewport, `${label}: horizontal overflow ${JSON.stringify(sizes)}`);
  }
  const sizes = [[1440,900],[1024,768],[768,1024],[390,844],[360,800],[320,740],[844,390]];
  try {
    const host = await newPage({ width: 1440, height: 900 });
    await host.goto(base);
    assert.equal(await host.locator('#homeScreen').count(), 0);
    await host.screenshot({ path: path.join(directory, 'password-gate.png'), fullPage: true });
    await login(host);
    for (const [width, height] of sizes) {
      await host.setViewportSize({ width, height });
      await fits(host, `home ${width}`);
      if (width === 1440 || width === 390) await host.screenshot({ path: path.join(directory, `home-${width}.png`), fullPage: true });
    }
    await host.setViewportSize({ width: 1440, height: 900 });
    await host.locator('#nameInput').fill('River 房主');
    await host.locator('#createBtn').click();
    await host.locator('#waitTip').filter({ hasText: '房间已创建' }).waitFor();
    const room = await host.locator('#displayRoomCode').textContent();
    await host.waitForFunction(() => document.getElementById('audioStatus').textContent.includes('72 BPM'));
    assert.ok(await host.evaluate(() => window.__audioStarts >= 2), 'Music and the first click both start audio');
    await host.locator('.sound-settings summary').click();
    await host.locator('#nextTrackBtn').click();
    await host.locator('#trackTitle').filter({hasText:'雨后慢拍'}).waitFor();
    await host.locator('#nextTrackBtn').click();
    await host.locator('#trackTitle').filter({hasText:'窗边月色'}).waitFor();
    await host.locator('#nextTrackBtn').click();
    await host.locator('#trackTitle').filter({hasText:'午夜河岸'}).waitFor();
    await host.locator('.sound-settings summary').click();
    for (const [width, height] of sizes) {
      await host.setViewportSize({ width, height });
      await fits(host, `lobby ${width}`);
      if (width === 1440 || width === 390) await host.screenshot({ path: path.join(directory, `lobby-${width}.png`), fullPage: true });
    }
    const guest = await newPage({ width: 390, height: 844 });
    await guest.goto(base + '#room=' + room);
    await login(guest);
    await guest.locator('#waitTip').filter({ hasText: '已连接' }).waitFor();
    assert.ok(guest.url().endsWith('#room=' + room), 'Password submission preserves share-link room');
    await guest.locator('#readyBtn').click();
    await guest.locator('#readyBtn').filter({ hasText: '已准备' }).waitFor();
    await host.setViewportSize({ width: 1440, height: 900 });
    await host.locator('#startBtn').click();
    await guest.locator('#gameScreen').waitFor({ state: 'visible' });
    for (const page of [host, guest]) {
      for (const [width, height] of sizes) {
        await page.setViewportSize({ width, height });
        await fits(page, `table ${width}`);
        if (page === guest && (width === 1440 || width === 390)) await page.screenshot({ path: path.join(directory, `table-${width}.png`), fullPage: true });
      }
    }
    // Exercise actual dynamically-created game controls and verify click audio.
    const acting = await host.locator('.action-fold').isVisible() ? host : guest;
    await acting.waitForFunction(() => document.getElementById('audioStatus').textContent.includes('72 BPM'));
    const before = await acting.evaluate(() => window.__audioStarts);
    await acting.locator('.action-fold').click();
    assert.ok(await acting.evaluate(() => window.__audioStarts) > before);
    await host.locator('#resultScreen').waitFor({ state: 'visible' });
    for (const [width, height] of sizes) {
      await host.setViewportSize({ width, height });
      await fits(host, `results ${width}`);
      if(width===390||width===1440)await host.screenshot({path:path.join(directory,`results-${width}.png`),fullPage:true});
    }
    // Mute preferences survive navigation and logout takes access away.
    await host.locator('#musicToggle').click();
    await host.locator('#sfxToggle').click();
    await host.evaluate(()=>RiverSession.leave({reload:false}));
    await host.reload();
    assert.equal(await host.locator('#musicToggle').getAttribute('aria-pressed'), 'false');
    assert.equal(await host.locator('#sfxToggle').getAttribute('aria-pressed'), 'false');
    // Fill all eight seats to check the denser mobile player row with real state.
    await host.locator('#createBtn').click();
    await host.locator('#waitTip').filter({ hasText: '房间已创建' }).waitFor();
    const fullRoom = await host.locator('#displayRoomCode').textContent();
    const otherGuests = [];
    for (let i=0; i<7; i++) {
      const player = await newPage({ width: 390, height: 844 });
      await player.goto(base + '#room=' + fullRoom);
      await login(player);
      await player.locator('#waitTip').filter({ hasText: '已连接' }).waitFor();
      await player.locator('#readyBtn').click();
      await player.locator('#readyBtn').filter({ hasText: '已准备' }).waitFor();
      otherGuests.push(player);
    }
    await host.locator('#startBtn').click();
    await host.locator('.player-card').nth(7).waitFor();
    assert.equal(await host.evaluate(()=>g.variant),'standard');
    await host.locator('#dealingStage').waitFor({state:'hidden'});
    for (const [width, height] of sizes) {
      await host.setViewportSize({ width, height });
      await fits(host, `eight-player table ${width}`);
      const cardOverflow = await host.locator('.player-card').evaluateAll(cards => cards.some(card => {
        const outer = card.getBoundingClientRect();
        return [...card.querySelectorAll('.hole-cards .card')].some(playingCard => {
          const rect = playingCard.getBoundingClientRect();
          return rect.left < outer.left - 1 || rect.right > outer.right + 1;
        });
      }));
      assert.equal(cardOverflow, false, `Player cards fit at ${width}px`);
      if (width === 390 || width === 1440) await host.screenshot({ path: path.join(directory, `table-eight-${width}.png`), fullPage: true });
    }
    await host.getByRole('button', { name: '退出', exact: true }).click();
    await host.getByRole('heading', { name: '访问验证' }).waitFor();
    assert.deepEqual(errors, [], 'No browser JavaScript exceptions');
    console.log('Browser QA passed: password/share-link flow, 7 viewport sizes × 4 screens, eight-player table, audio decode/playback, dynamic button SFX, mute persistence and logout.');
    console.log('Screenshots: ' + directory);
  } finally {
    await browser.close();
    for (const ws of wss.clients) ws.terminate();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
