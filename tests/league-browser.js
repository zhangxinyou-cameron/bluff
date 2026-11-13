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
    const idle = page => page.waitForFunction(() => typeof wsConnected !== 'undefined' && wsConnected && !RiverSession.getDiagnostics().pending);
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
    async function signIn(page, index, register = false, destination = base + '/') {
      const form = page.locator('#accountForm');
      if (register) await page.locator('#accountToggle').click();
      await form.locator('[name=number]').fill('00' + index);
      await form.locator('[name=password]').fill('7');
      if (register) await form.locator('[name=confirmation]').fill('7');
      await form.locator('#accountSubmit').click();
      if (destination) await page.waitForURL(destination);
      if (destination === base + '/') await page.locator('#homeProfile').waitFor();
    }
    const host = await gatedPage(1);
    await api(host, '/api/account/register', { number: '001', password: '7', confirmation: '8' }, 400);
    const gateOnly = await host.context().cookies();
    const gateCookies = gateOnly.map(cookie => cookie.name + '=' + cookie.value).join('; ');
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

    assert.equal(await host.locator('#homeLeagues').evaluate(node => getComputedStyle(node).textDecorationLine), 'none');
    await host.locator('#homeLeagues').click();
    await host.getByRole('heading', { name: '个人联赛战绩' }).waitFor();
    assert.equal(await host.locator('.club-dashboard').evaluate(node => getComputedStyle(node).gridTemplateColumns.split(' ').length), 1);
    await host.getByRole('link', { name: '创建联赛' }).click();
    await host.waitForURL('**/club.html?new');
    await host.getByLabel('联赛名称').fill('四队联赛');
    await host.getByLabel('联赛房间号').fill('00420125');
    assert.equal(await host.getByRole('radio').count(), 0);
    await host.getByText('队伍和榜单设置', { exact: true }).click();
    await host.getByLabel('队伍上限').fill('4');
    await host.getByLabel('每队名额').fill('2');
    await host.getByRole('button', { name: '创建联赛' }).click();
    await host.getByRole('heading', { name: '四队联赛', exact: true }).waitFor();
    const code = new URL(host.url()).searchParams.get('league');
    assert.equal(code, '00420125');
    await change(host, 'create', code, { name: '重复', mode: 'solo', minHands: 1, minMatches: 1 }, 409);
    await change(host, 'create', '../x', { name: '错误房号', mode: 'solo', minHands: 1, minMatches: 1 }, 400);
    await api(pages[1], '/api/league?code=' + code, null, 404);
    await pages[1].locator('#homeLeagues').click();
    assert.equal(await pages[1].locator('.club-dashboard').evaluate(node => getComputedStyle(node).gridTemplateColumns.split(' ').length), 2);
    await pages[1].getByRole('link', { name: '加入联赛' }).click();
    await pages[1].getByLabel('联赛房间号').fill(code);
    await pages[1].getByRole('button', { name: '加入联赛' }).click();
    await pages[1].getByRole('heading', { name: '四队联赛', exact: true }).waitFor();
    await host.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: async url => { window.copiedInvite = url; } } });
    });
    await host.getByRole('button', { name: '复制联赛邀请' }).click();
    const invite = await host.evaluate(() => window.copiedInvite);
    assert.equal(invite, base + '/club.html?league=' + code);
    const invited = pages[2];
    await invited.context().clearCookies();
    await invited.goto(invite);
    await invited.getByLabel('访问密码').fill(gate);
    await invited.getByRole('button', { name: '验证并进入' }).click();
    await invited.waitForURL(url => url.pathname === '/account.html' && url.searchParams.get('next') === '/club.html?league=' + code);
    await signIn(invited, 3, false, invite);
    await invited.getByRole('heading', { name: '联赛邀请' }).waitFor();
    await invited.getByRole('button', { name: '加入联赛' }).click();
    await invited.getByRole('heading', { name: '四队联赛', exact: true }).waitFor();
    for (const page of pages.slice(3)) await change(page, 'join', code);
    const overview = host.getByRole('region', { name: '我的联赛战绩' });
    assert.equal(await overview.locator('.club-overview-dimensions dd').count(), 6);
    assert.equal(await overview.getByText('MVP 次数').isVisible(), true);
    assert.equal(await overview.getByText('击杀数').isVisible(), true);
    assert.equal(await overview.evaluate(node => node.querySelector('canvas').getBoundingClientRect().bottom < innerHeight), true);
    await host.getByLabel('队名').fill('队伍1');
    assert.equal(await host.getByRole('radio').count(), 8);
    await host.getByRole('radio', { name: '深海星旗' }).check();
    await host.getByRole('button', { name: '成为队长' }).click();
    await overview.locator('.team-flag[data-flag="tide"]').waitFor();
    const folder = path.join(root, 'team-flags');
    await fs.mkdir(folder);
    const picture = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBt8AAAAASUVORK5CYII=', 'base64');
    const file = '试验旗.png';
    await fs.writeFile(path.join(folder, file), picture);
    await fs.writeFile(path.join(folder, '非旗帜.txt'), '忽略');
    await change(pages[1], 'createTeam', code, { name: '队伍2', flagId: 'file:../试验旗.png' }, 400);
    await pages[1].reload();
    await pages[1].getByLabel('队名').fill('队伍2');
    await pages[1].getByRole('radio', { name: '试验旗' }).check();
    assert.equal(await pages[1].getByRole('radio').count(), 9);
    await pages[1].getByRole('button', { name: '成为队长' }).click();
    await pages[1].waitForFunction(() => document.querySelector('.club-overview-team img')?.naturalWidth === 1);
    for (const [index, page] of pages.slice(2, 4).entries()) await change(page, 'createTeam', code, { name: '队伍' + (index + 3) });
    let league = await detail(host, code);
    const custom = league.flags.find(flag => flag.id === 'file:' + file);
    const image = await host.request.get(base + custom.src);
    assert.equal(image.headers()['content-type'], 'image/png');
    assert.deepEqual(await image.body(), picture);
    const anonymous = await browser.newContext();
    await anonymous.addCookies(gateOnly);
    assert.equal((await anonymous.request.get(base + custom.src)).status(), 401);
    await anonymous.close();
    assert.deepEqual(league.teams.map(team => team.flagId), ['tide', 'file:' + file, 'pine', 'pine']);
    const firstTeam = league.teams[0].id;
    await change(pages[4], 'requestTeam', code, { teamId: firstTeam });
    await change(pages[1], 'approveTeam', code, { teamId: firstTeam, uid: uids[4], accept: true }, 403);
    await change(host, 'approveTeam', code, { teamId: firstTeam, uid: uids[4], accept: true });

    async function enter(page, id, tableHost = host) {
      await page.goto(base + '/?leagueMatch=' + id);
      await idle(page);
      if (page !== tableHost) { await page.locator('#readyBtn').click(); await idle(page); }
    }
    async function takeAction(group, action, tableHost = host) {
      const room = roomManager.games.get(await tableHost.evaluate(() => roomCode));
      const before = room.game.revision;
      const seat = room.game.players[room.game.currentPlayerIndex].id;
      const ids = await Promise.all(group.map(page => page.evaluate(() => mySeatId)));
      await group[ids.indexOf(seat)].locator('.action-' + action).click();
      await tableHost.waitForFunction(revision => g.revision > revision, before);
    }
    async function finish(tableHost = host) {
      await idle(tableHost);
      await tableHost.locator('#finishSessionBtn').click();
      await tableHost.getByRole('link', { name: '查看六维赛报' }).waitFor();
      const url = await tableHost.getByRole('link', { name: '查看六维赛报' }).getAttribute('href');
      return new URL(url, base).searchParams.get('report');
    }

    const first = await change(host, 'open', code, { name: '四队短牌', mode: 'solo' });
    await enter(host, first.matchId);
    await api(pages[4], '/api/league?match=invalid', null, 404);
    await enter(pages[1], first.matchId);
    await enter(pages[4], first.matchId);
    await host.locator('#leagueReadyState').filter({ hasText: '全员已准备' }).waitFor();
    assert.equal(await host.locator('#startBtn').isEnabled(), true);
    await enter(pages[2], first.matchId);
    await settings(host, 'deckModeSel', 'short');
    const firstGuests=[pages[1],pages[2],pages[4]];
    for (const guest of firstGuests) {
      await guest.locator('#waitRuleSummary').filter({ hasText: '36 张短牌' }).waitFor();
      await guest.locator('#leagueReadyState').filter({ hasText: '规则已更新' }).waitFor();
      await guest.locator('#readyBtn').click();
      await idle(guest);
    }
    await host.locator('#startBtn').click();
    await host.waitForFunction(() => g?.handNumber === 1);
    const directGuest=pages[3],matchPath='/?leagueMatch='+first.matchId;
    await directGuest.context().clearCookies();
    await directGuest.goto(base+matchPath);
    await directGuest.getByLabel('访问密码').fill(gate);
    await directGuest.getByRole('button',{name:'验证并进入'}).click();
    await directGuest.waitForURL(url=>url.pathname==='/account.html'&&url.searchParams.get('next')===matchPath);
    await signIn(directGuest,4,false,null);
    await idle(directGuest);
    await directGuest.locator('#handTypeText').filter({ hasText: '本手观战 · 下一手入座' }).waitFor();
    assert.equal(await directGuest.locator('#actionPanel button').count(), 0);
    for (let index = 0; index < 3; index++) await takeAction([host,...firstGuests], 'fold');
    await host.waitForFunction(() => g.phase === 'hand_over');
    assert.equal(await finish(), first.matchId);
    league = await detail(host, code);
    assert.equal(league.format, 'points:2');
    assert.equal(league.players.some(player => player.uid === uids[3]), false);
    assert.equal(league.teamStandings.filter(team=>team.matches===1).length,3);
    assert.equal(league.teamStandings.every(team => team.place === undefined), true);
    assert.equal(league.locked.includes(uids[3]), false);
    assert.equal(league.locked.includes(uids[4]), true);
    const absentee = league.players.find(player=>player.uid===uids[4]);
    await change(host, 'leaveTeam', code, {}, 409);
    await change(directGuest, 'leaveTeam', code);

    const memberHost = pages[1];
    await host.goto(base + '/club.html?league=' + code);
    await memberHost.goto(base + '/club.html?league=' + code);
    await memberHost.getByLabel('比赛名称（可选）').fill('两队标准牌买入');
    await memberHost.getByRole('button', { name: '创建比赛房' }).click();
    await idle(memberHost);
    const second = (await detail(host, code)).matches.at(-1);
    assert.equal(second.owner, uids[1]);
    assert.equal((await api(directGuest, '/api/league?match=' + second.id)).host, false);
    await change(pages[2], 'cancel', code, {}, 403);
    await host.getByRole('heading', { name: '两队标准牌买入' }).waitFor();
    await host.getByRole('link', { name: '加入比赛房' }).click();
    await idle(host);
    await pages[2].goto(base + '/club.html?league=' + code);
    await pages[2].locator('.club-match .club-metric').filter({ hasText: '1 / 2' }).waitFor();
    const waiting = await detail(pages[2], code);
    const unchangedUrl = '/api/league?code=' + code + '&since=' + encodeURIComponent(waiting.revision);
    assert.deepEqual(await api(pages[2], unchangedUrl), { revision: waiting.revision });
    assert.equal(await memberHost.locator('#startBtn').isDisabled(), true);
    await host.locator('#readyBtn').click();
    await idle(host);
    await memberHost.locator('#leagueReadyState').filter({ hasText: '全员已准备' }).waitFor();
    await pages[2].locator('.club-match .club-metric').filter({ hasText: '2 / 2' }).waitFor();
    assert.notEqual((await api(pages[2], unchangedUrl)).revision, waiting.revision);
    await settings(memberHost, 'allowBuyInSel', 'yes');
    await settings(memberHost, 'deckModeSel', 'standard');
    await settings(memberHost, 'bigBlindSel', '50');
    await host.locator('#waitRuleSummary').filter({ hasText: '1 倍底注 50' }).waitFor();
    await host.locator('#readyBtn').click();
    await idle(host);
    await memberHost.locator('#startBtn').click();
    await memberHost.waitForFunction(() => g?.handNumber === 1);
    await takeAction(pages.slice(0, 2), 'allin', memberHost);
    await takeAction(pages.slice(0, 2), 'call', memberHost);
    for (const page of pages.slice(0, 2)) await page.locator('#voteTwiceBtn').click();
    await host.locator('#resultScreen').waitFor({ state: 'visible' });
    const account = await host.evaluate(() => clientGameState.players.find(player => player.id === mySeatId));
    await send(host, 'bank', { kind: 'borrow', amount: 500, handNumber: 1, bankVersion: account.bankVersion });
    const original=await host.evaluate(()=>clientGameState.players.find(player=>player.id===mySeatId));
    await host.locator('#awayBtn').click();
    await host.locator('#homeProfile').waitFor();
    await memberHost.waitForFunction(id=>g.players.find(player=>player.id===id)?.disconnected,original.id);
    await host.goto(base+'/?leagueMatch='+second.id);
    await idle(host);
    const returned=await host.evaluate(()=>clientGameState.players.find(player=>player.id===mySeatId));
    assert.deepEqual([returned.id,returned.chips,returned.bankDebt],[original.id,original.chips,500]);
    const newcomer=directGuest;
    await newcomer.goto(base+'/club.html?league='+code);
    await newcomer.getByRole('link',{name:'加入比赛房'}).click();
    await idle(newcomer);
    await newcomer.locator('#nextHandBtn').waitFor();
    assert.equal(await newcomer.evaluate(()=>clientGameState.players.find(player=>player.id===mySeatId).chips),2000);
    for(const page of [host,memberHost,newcomer]){await page.locator('#nextHandBtn').click();await idle(page);}
    await memberHost.waitForFunction(()=>g.handNumber===2);
    const secondRoom=roomManager.games.get(await memberHost.evaluate(()=>roomCode));
    while(['pre_flop','flop','turn','river'].includes(secondRoom.game.phase))await takeAction([host,memberHost,newcomer],'fold',memberHost);
    assert.equal(await finish(memberHost), second.id);
    const result = await api(host, '/api/reports?id=' + second.id);
    assert.equal(result.rules.bigBlind, 50);
    assert.equal(result.ratingVersion, 4);
    const archivedId = '4f178643-48ba-4c79-aad0-48347dc61e6f';
    const saved = services.stats.matches.get(second.id);
    services.stats.save({ ...saved, id: archivedId, leagueCode: null, ratingVersion: undefined,
      players: saved.players.map(player => ({ ...player, hands: 10, title: '稳健派',
        metrics: { ...player.metrics, stability: { total: 4, samples: 5 } } })) });
    const historical = await api(host, '/api/reports?id=' + archivedId);
    assert.equal(historical.ratingVersion, 1);
    assert.deepEqual(historical.players[0].values.stability, { score: 4, samples: 5, observed: 4 });
    assert.equal(historical.players[0].title, '稳健派');
    services.stats.deleteMatches([archivedId]);
    assert.equal(result.players.find(player => player.uid === uids[0]).debt, 500);
    assert.equal(result.players.reduce((sum, player) => sum + player.profit, 0), 0);
    assert.ok(result.players.every(player => player.values.luck.samples === player.hands && player.values.luck.score === null));
    assert.equal(result.players.find(player=>player.uid===uids[3]).hands,1);
    assert.equal(result.players.find(player=>player.uid===uids[3]).teamId,null);
    await host.getByRole('link', { name: '查看六维赛报' }).click();
    await host.getByRole('heading', { name: '两队标准牌买入', exact: true }).waitFor();
    assert.equal(await host.locator('.club-dimensions').count(), 3);
    await host.getByRole('link', { name: '返回所属联赛' }).click();
    try { await host.getByRole('heading', { name: '团队积分榜' }).waitFor({ timeout: 4000 }); }
    catch (error) { throw new Error(host.url() + '\n' + await host.locator('body').innerText(), { cause: error }); }
    assert.equal(await host.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    league = await detail(host, code);
    const personal = league.players.find(player => player.uid === uids[0]);
    assert.equal(Number(await overview.locator('.club-metric').filter({ hasText: 'MVP 次数' }).locator('strong').innerText()), personal.mvps);
    assert.equal(await overview.locator('.club-metric').filter({ hasText: '赛季积分' }).locator('strong').innerText(),
      (personal.points > 0 ? '+' : '') + Number(personal.points.toFixed(2)) + ' BB');
    assert.equal(await overview.locator('.club-overview-recent a').count(), 2);
    assert.equal(await host.getByRole('row').filter({ hasText: '队伍1' }).locator('.team-flag[data-flag="tide"]').count(), 1);
    assert.equal(await overview.evaluate(node => node.querySelector('.club-metrics').getBoundingClientRect().bottom < innerHeight), true);
    assert.deepEqual(league.players.find(player=>player.uid===uids[4]),absentee);
    assert.equal(league.teamStandings.filter(team => team.place !== undefined).length, 2);
    assert.equal(league.teamStandings.filter(team => team.mvp.length > 0).length, 2);
    await host.getByRole('navigation').getByRole('link', { name: '联赛', exact: true }).click();
    await host.locator('.club-record').filter({ hasText: '两队标准牌买入' }).getByRole('link', { name: '看赛报' }).waitFor();
    await host.locator('.club-league-card').filter({ hasText: '四队联赛' }).getByRole('link', { name: '进入联赛' }).click();
    await host.getByRole('heading', { name: '四队联赛', exact: true }).waitFor();
    await api(host, '/api/me', { name: '改名后的玩家' });
    assert.equal((await api(host, '/api/reports')).reports.length, 2);
    assert.equal((await api(host, '/api/reports?id=' + second.id)).players.find(player => player.uid === uids[0]).name, '牌手1');
    await change(host, 'delete', code, {}, 409);
    await change(host, 'finish', code);
    await change(host, 'open', code, {}, 409);

    const solo = await change(pages[2], 'create', null, { name: '朋友联赛', minMatches: 1 });
    await change(host, 'join', solo.code);
    await host.goto(base + '/club.html');
    await host.getByLabel('查看联赛战绩').selectOption(solo.code);
    await overview.getByText('上榜需 1 场').waitFor();
    await overview.getByText('未加入队伍').waitFor();
    await host.getByLabel('查看联赛战绩').selectOption(code);
    await overview.locator('.team-flag[data-flag="tide"]').waitFor();
    const soloMatch = await change(pages[2], 'open', solo.code);
    await host.goto(base + '/?leagueMatch=' + soloMatch.matchId);
    await idle(host);
    await host.locator('#readyBtn').click();
    await idle(host);
    await pages[2].goto(base + '/?leagueMatch=' + soloMatch.matchId);
    await idle(pages[2]);
    await pages[2].getByRole('button',{name:'添加人机'}).first().click();
    await idle(pages[2]);
    await pages[2].locator('#startBtn').click();
    await pages[2].waitForFunction(() => g?.handNumber === 1);
    const soloRoom = roomManager.games.get(await pages[2].evaluate(() => roomCode));
    const bot=soloRoom.game.players.find(player=>player.isAI);
    await pages[2].locator('#managePlayersBtn').click();
    await pages[2].locator('#socialTarget').selectOption(String(bot.id));
    await pages[2].getByRole('button',{name:'移除所选人机'}).click();
    await idle(pages[2]);
    await pages[2].getByRole('button',{name:'关闭互动'}).click();
    const soloActor = soloRoom.game.players[soloRoom.game.currentPlayerIndex].id === 0 ? pages[2] : host;
    await soloActor.locator('.action-fold').click();
    await pages[2].locator('#finishSessionBtn').click();
    await pages[2].getByRole('link', { name: '查看六维赛报' }).waitFor();
    const soloReport=await api(host,'/api/reports?id='+soloMatch.matchId);
    assert.equal(soloRoom.game.players.some(player=>player.isAI),false);
    assert.equal(soloReport.players.length,2);
    roomManager.check(soloRoom);
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
    assert.deepEqual((await detail(host, code)).teams.slice(0, 2).map(team => team.flagId), ['tide', 'file:' + file]);
    await fs.unlink(path.join(folder, file));
    assert.equal((await detail(host, code)).teams[1].flagId, 'pine');
    assert.equal((await host.request.get(base + custom.src)).status(), 404);
    assert.equal((await detail(host, solo.code)).matches.find(match => match.id === interrupted.matchId).status, 'interrupted');
    assert.equal(services.stats.matches.size, 4);

    const oldLeague = base + '/club.html?league=' + code;
    await memberHost.goto(base);
    await memberHost.waitForURL('**/account.html');
    await signIn(memberHost, 2);
    await memberHost.goto(oldLeague);
    await memberHost.getByRole('heading', { name: '四队联赛', exact: true }).waitFor();
    assert.equal(await memberHost.getByRole('button', { name: '删除联赛' }).count(), 0);
    await change(memberHost, 'delete', code, {}, 403);
    await host.goto(oldLeague);
    const remove = host.getByRole('button', { name: '删除联赛' });
    let confirmation;
    host.once('dialog', dialog => { confirmation = dialog.message(); return dialog.dismiss(); });
    await remove.click();
    assert.match(confirmation, /赛报将永久删除/);
    assert.ok((await detail(host, code)).endedAt);
    host.once('dialog', dialog => dialog.accept());
    await remove.click();
    await host.waitForURL(base + '/club.html');
    await host.getByRole('heading', { name: '联赛大厅' }).waitFor();
    assert.equal(await host.locator('.club-league-card').filter({ hasText: '四队联赛' }).count(), 0);
    await api(memberHost, '/api/league?code=' + code, null, 404);
    await api(host, '/api/reports?id=' + first.matchId, null, 404);
    assert.deepEqual((await api(host, '/api/reports')).reports.map(report => report.id), [soloMatch.matchId]);
    for (const [folder, id] of [['leagues', code], ['matches', first.matchId], ['matches', second.id]]) {
      await assert.rejects(fs.access(path.join(root, folder, id + '.json')), { code: 'ENOENT' });
    }
    services = configureIdentity(root);
    assert.equal(services.leagues.leagues.has(code), false);
    assert.equal(services.stats.matches.has(second.id), false);
    assert.equal(services.stats.matches.has(soloMatch.matchId), true);
    assert.deepEqual(errors, []);
    console.log('League browser passed: five accounts, season dashboard, team flags, three matches, late entry, UID return, bot removal, rankings and archive deletion.');
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
