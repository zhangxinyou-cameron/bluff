const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { WebSocket } = require('ws');
const { server, wss, access, roomManager, configureIdentity } = require('../server');
const { passwordRecord } = require('../access');

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bluff-league-test-'));
  const errors = [];
  const gate = 'league-browser-fixture';
  let services, browser;
  try {
    services = configureIdentity(root);
    access.configure(await passwordRecord(gate));
    roomManager.configureTimings({ deal: 50, action: 25, street: 50, runout: 50 });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + server.address().port;
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });

    async function api(page, endpoint, data, code = 200) {
      const response = data ? await page.request.post(base + endpoint, { data }) : await page.request.get(base + endpoint);
      const value = await response.json();
      assert.equal(response.status(), code, JSON.stringify(value));
      return value;
    }
    const change = (page, action, code, fields = {}, status) => api(page, '/api/league', { action, code, ...fields }, status);
    const detail = (page, code) => api(page, '/api/league?code=' + code);
    const idle = page => page.waitForFunction(() => wsConnected && !RiverSession.getDiagnostics().pending);
    const settings = async (page, id, value) => {
      await page.locator('#' + id).selectOption(value);
      await idle(page);
    };
    const send = async (page, type, payload = {}) => {
      assert.equal(await page.evaluate(([type, payload]) => RiverSession.command(type, payload), [type, payload]), true);
      await idle(page);
    };
    async function gatedPage(index) {
      const context = await browser.newContext({ viewport: index % 2 ? { width: 320, height: 680 } : { width: 1280, height: 800 } });
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(base);
      await page.getByLabel('访问密码').fill(gate);
      await page.getByRole('button', { name: '验证并进入' }).click();
      await page.waitForURL('**/account.html');
      return page;
    }
    async function signIn(page, index, register = false) {
      const form = page.locator('#accountForm');
      if (register) await page.locator('#accountToggle').click();
      await form.locator('[name=number]').fill('00' + index);
      await form.locator('[name=password]').fill('7');
      if (register) await form.locator('[name=confirmation]').fill('7');
      await form.locator('#accountSubmit').click();
      await page.waitForURL(base + '/');
      await page.locator('#homeProfile').waitFor();
    }
    const host = await gatedPage(1);
    await api(host, '/api/account/register', { number: '001', password: '7', confirmation: '8' }, 400);
    const gateCookies = (await host.context().cookies()).map(cookie => cookie.name + '=' + cookie.value).join('; ');
    const denied = await new Promise((resolve, reject) => {
      const socket = new WebSocket(base.replace(/^http/, 'ws'), { headers: { Cookie: gateCookies } });
      socket.on('unexpected-response', (_, response) => { response.resume(); resolve(response.statusCode); });
      socket.on('error', reject);
      socket.on('open', () => { socket.close(); reject(new Error('站点密码绕过账号登录')); });
    });
    assert.equal(denied, 401);
    await signIn(host, 1, true);
    const pages = [host];
    for (let index = 2; index <= 5; index++) {
      const page = await gatedPage(index);
      await signIn(page, index, true);
      pages.push(page);
    }
    await api(host, '/api/account/register', { number: '001', password: '7', confirmation: '7' }, 409);
    const profiles = await Promise.all(pages.map((page, index) => api(page, '/api/me', { name: '牌手' + (index + 1), avatar: index ? 'cat' : 'owl' })));
    const uids = profiles.map(result => result.profile.uid);
    assert.equal(new Set(uids).size, 5);
    assert.equal(profiles[0].account, '001');
    const credentialFiles = await fs.readdir(path.join(root, 'accounts'));
    assert.equal(credentialFiles.length, 5);
    const record = JSON.parse(await fs.readFile(path.join(root, 'accounts', uids[0] + '.json'), 'utf8'));
    assert.notEqual(record.credentials.hash, '7');
    assert.equal(record.password, undefined);

    await host.locator('#homeLeagues').click();
    await host.getByLabel('联赛名称').fill('四队联赛');
    await host.getByLabel('联赛赛制').selectOption('team');
    await host.getByLabel('队伍数量').fill('4');
    await host.getByLabel('每队名额').fill('2');
    await host.getByLabel('每场最低手数').fill('1');
    await host.getByRole('button', { name: '创建联赛' }).click();
    await host.getByRole('heading', { name: '四队联赛', exact: true }).waitFor();
    const code = new URL(host.url()).searchParams.get('league');
    await api(pages[1], '/api/league?code=' + code, null, 404);
    for (const page of pages.slice(1)) await change(page, 'join', code);
    for (const [index, page] of pages.slice(0, 4).entries()) await change(page, 'createTeam', code, { name: '队伍' + (index + 1) });
    let league = await detail(host, code);
    const firstTeam = league.teams[0].id;
    await change(pages[4], 'requestTeam', code, { teamId: firstTeam });
    await change(pages[1], 'approveTeam', code, { teamId: firstTeam, uid: uids[4], accept: true }, 403);
    await change(host, 'approveTeam', code, { teamId: firstTeam, uid: uids[4], accept: true });

    async function enter(page, id) {
      await page.goto(base + '/?leagueMatch=' + id);
      await idle(page);
      if (page !== host) { await page.locator('#readyBtn').click(); await idle(page); }
    }
    async function takeAction(group, action) {
      const room = roomManager.games.get(await host.evaluate(() => roomCode));
      const before = room.game.revision;
      const seat = room.game.players[room.game.currentPlayerIndex].id;
      const ids = await Promise.all(group.map(page => page.evaluate(() => mySeatId)));
      await group[ids.indexOf(seat)].locator('.action-' + action).click();
      await host.waitForFunction(revision => g.revision > revision, before);
    }
    async function finish() {
      await host.locator('#finishSessionBtn').click();
      await host.getByRole('link', { name: '查看六维赛报' }).waitFor();
      const url = await host.getByRole('link', { name: '查看六维赛报' }).getAttribute('href');
      return new URL(url, base).searchParams.get('report');
    }

    const first = await change(host, 'open', code, { name: '四队短牌', mode: 'solo' });
    await enter(host, first.matchId);
    await api(pages[4], '/api/league?match=invalid', null, 404);
    await enter(pages[1], first.matchId);
    await enter(pages[4], first.matchId);
    await host.locator('#startBtn').click();
    await host.getByText('团队场至少需要两支队伍，且各队上场人数必须相同').first().waitFor();
    await pages[4].evaluate(() => RiverSession.leave({ permanent: true }));
    await host.waitForFunction(() => seats.filter(Boolean).length === 2);
    await enter(pages[2], first.matchId);
    await enter(pages[3], first.matchId);
    await settings(host, 'deckModeSel', 'short');
    await host.locator('#startBtn').click();
    await host.waitForFunction(() => g?.handNumber === 1);
    for (let index = 0; index < 3; index++) await takeAction(pages.slice(0, 4), 'fold');
    await host.waitForFunction(() => g.phase === 'hand_over');
    assert.equal(await finish(), first.matchId);
    league = await detail(host, code);
    assert.equal(league.matches[0].mode, 'team');
    assert.deepEqual(league.teamStandings.map(team => team.matches), [1, 1, 1, 1]);
    assert.equal(league.teamStandings.every(team => team.place === undefined), true);
    assert.equal(league.locked.includes(uids[4]), false);
    await change(host, 'leaveTeam', code, {}, 409);
    await change(pages[4], 'leaveTeam', code);

    const second = await change(host, 'open', code, { name: '两队标准牌买入' });
    await api(pages[4], '/api/league?match=' + second.matchId, null, 403);
    await enter(host, second.matchId);
    await enter(pages[1], second.matchId);
    await settings(host, 'allowBuyInSel', 'yes');
    await settings(host, 'deckModeSel', 'standard');
    await settings(host, 'bigBlindSel', '50');
    await host.locator('#startBtn').click();
    await host.waitForFunction(() => g?.handNumber === 1);
    await takeAction(pages.slice(0, 2), 'allin');
    await takeAction(pages.slice(0, 2), 'call');
    for (const page of pages.slice(0, 2)) await page.locator('#voteTwiceBtn').click();
    await host.waitForFunction(() => g.phase === 'hand_over' && RiverSession.getDiagnostics().serverNow >= RiverSession.getDiagnostics().interactiveAt);
    const account = await host.evaluate(() => g.players.find(player => player.id === mySeatId));
    await send(host, 'bank', { kind: 'borrow', amount: 500, handNumber: 1, bankVersion: account.bankVersion });
    assert.equal(await finish(), second.matchId);
    const result = await api(host, '/api/reports?id=' + second.matchId);
    assert.equal(result.rules.bigBlind, 50);
    assert.equal(result.players.find(player => player.uid === uids[0]).debt, 500);
    assert.equal(result.players.reduce((sum, player) => sum + player.profit, 0), 0);
    assert.ok(result.players.every(player => player.values.luck.samples === 1 && player.values.luck.score === null));
    await host.getByRole('link', { name: '查看六维赛报' }).click();
    await host.getByRole('heading', { name: '两队标准牌买入', exact: true }).waitFor();
    assert.equal(await host.locator('.club-dimensions').count(), 2);
    await host.getByRole('link', { name: '返回所属联赛' }).click();
    try { await host.getByRole('heading', { name: '团队积分榜' }).waitFor({ timeout: 4000 }); }
    catch (error) { throw new Error(host.url() + '\n' + await host.locator('body').innerText(), { cause: error }); }
    assert.equal(await host.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    league = await detail(host, code);
    assert.equal(league.teamStandings.filter(team => team.place !== undefined).length, 2);
    assert.equal(league.teamStandings.filter(team => team.mvp.length > 0).length, 2);
    await api(host, '/api/me', { name: '改名后的玩家' });
    assert.equal((await api(host, '/api/reports')).reports.length, 2);
    assert.equal((await api(host, '/api/reports?id=' + second.matchId)).players.find(player => player.uid === uids[0]).name, '牌手1');
    await change(host, 'finish', code);
    await change(host, 'open', code, {}, 409);

    const solo = await change(pages[2], 'create', null, { name: '个人联赛', mode: 'solo', minHands: 1, minMatches: 1 });
    await change(host, 'join', solo.code);
    await change(pages[2], 'createTeam', solo.code, { name: '队伍' }, 400);
    const soloMatch = await change(pages[2], 'open', solo.code, { mode: 'team' });
    assert.equal((await detail(host, solo.code)).matches[0].mode, 'solo');
    await pages[2].goto(base + '/?leagueMatch=' + soloMatch.matchId);
    await idle(pages[2]);
    await host.goto(base + '/?leagueMatch=' + soloMatch.matchId);
    await idle(host);
    await host.locator('#readyBtn').click();
    await idle(host);
    await pages[2].locator('#startBtn').click();
    await pages[2].waitForFunction(() => g?.handNumber === 1);
    const soloRoom = roomManager.games.get(await pages[2].evaluate(() => roomCode));
    const soloActor = soloRoom.game.players[soloRoom.game.currentPlayerIndex].id === 0 ? pages[2] : host;
    await soloActor.locator('.action-fold').click();
    await pages[2].locator('#finishSessionBtn').click();
    await pages[2].getByRole('link', { name: '查看六维赛报' }).waitFor();
    assert.equal((await detail(host, solo.code)).players.length, 2);
    const interrupted = await change(pages[2], 'open', solo.code);

    for (const room of roomManager.games.values()) roomManager.closeRoom(room.code);
    services = configureIdentity(root, false);
    await host.goto(base);
    await host.waitForURL('**/account.html');
    await signIn(host, 1);
    assert.equal((await api(host, '/api/me')).profile.uid, uids[0]);
    assert.equal(await host.locator('#homeLeagues').isHidden(), true);
    await api(host, '/api/league', null, 404);
    assert.equal((await api(host, '/api/reports')).reports.length, 3);
    services = configureIdentity(root);
    await host.goto(base);
    await host.waitForURL('**/account.html');
    await signIn(host, 1);
    assert.equal((await detail(host, code)).endedAt > 0, true);
    assert.equal((await detail(host, solo.code)).matches.find(match => match.id === interrupted.matchId).status, 'interrupted');
    assert.equal(services.stats.matches.size, 4);
    assert.deepEqual(errors, []);
    console.log('League browser passed: five accounts, three scored matches, four/two teams, fixed formats, debts, double runout, history and reload with plugin toggled.');
  } finally {
    await browser?.close();
    for (const ws of wss.clients) ws.terminate();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => server.close(resolve));
    const resolved = await fs.realpath(root);
    assert.equal(path.dirname(resolved), await fs.realpath(os.tmpdir()));
    assert.match(path.basename(resolved), /^bluff-league-test-/);
    await fs.rm(resolved, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
