const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const WebSocket = require('ws');
const { server, wss, access, roomManager } = require('../server');
roomManager.configureTimings({deal:0,street:0,runout:0,action:0});
const { passwordRecord } = require('../access');
let sessionCookie;
class AuthenticatedSocket extends WebSocket {
  constructor(url) { super(url, { headers: { Cookie: sessionCookie } }); }
}

const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const script = fs.readFileSync(path.join(__dirname, '../public/table-page.js'), 'utf8');

// Run the actual page script in independent browser-like contexts with real sockets.
// DOM rendering is recorded; no game or networking functions are replaced.
function page(baseUrl, hash = '', Socket = AuthenticatedSocket) {
  const elements = new Map([...html.matchAll(/id="([^"]+)"/g)].map(m => [m[1], {
    style: {}, dataset:{}, textContent: '', innerHTML: '', value: '', disabled: false,
    addEventListener() {}, focus() {}
  }]));
  const errors = [];
  let documentReady;
  const timers = new Set();
  const location = new URL(baseUrl + hash);
  const context = vm.createContext({
    PokerEngine: require('../public/poker-engine'),
    WebSocket: Socket, location,
    document: {
      addEventListener(name, callback){ if (name === 'DOMContentLoaded') documentReady = callback; },
      getElementById(id) {
        assert.ok(elements.has(id), `Unknown DOM element: ${id}`);
        return elements.get(id);
      },
      querySelector(selector) {
        if (!elements.has(selector)) elements.set(selector, { style: {}, textContent: '', innerHTML: '' });
        return elements.get(selector);
      }
    },
    localStorage: { getItem() { return null; }, setItem() {} },
    sessionStorage:{getItem(){return null;},setItem(){},removeItem(){}},
    addEventListener(){},
    navigator: { clipboard: { writeText() {} } },
    console: { log() {}, error(...args) { errors.push(args); console.error(...args); } },
    alert(text) { errors.push(new Error(text)); },
    setTimeout(fn, ms) {
      const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms);
      timers.add(timer);
      return timer;
    },
    setInterval(fn,ms){const timer=setInterval(fn,ms);timers.add(timer);return timer;},
    clearInterval(timer){clearInterval(timer);timers.delete(timer);},
    clearTimeout(timer) { clearTimeout(timer); timers.delete(timer); }
  });
  context.window = context;
  vm.runInContext(script, context);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/session-client.js'),'utf8'),context);
  return {
    elements, errors,
    ready() { return documentReady(); },
    run(code) { return vm.runInContext(code, context); },
    click(id) { assert.equal(elements.get(id).disabled, false); return elements.get(id).onclick(); },
    close() {
      for (const timer of timers) {clearTimeout(timer);clearInterval(timer);}
      const socket = vm.runInContext('ws', context);
      if (socket) { socket.onclose = null; socket.close(); }
    }
  };
}

async function until(predicate, description) {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `Timed out: ${description}`);
    await delay(10);
  }
}

test('room connection and readiness regression', async t => {
  const password = 'regression-only-password';
  access.configure(await passwordRecord(password));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/`;
  const login = await fetch(baseUrl + 'auth/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ password }), redirect: 'manual' });
  sessionCookie = login.headers.get('set-cookie').split(';')[0];
  const pages = [];
  const open = (hash = '') => {
    const client = page(baseUrl, hash);
    pages.push(client);
    return client;
  };
  t.after(async () => {
    for (const client of pages) client.close();
    for (const client of wss.clients) client.terminate();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => server.close(resolve));
  });

  const host = open();
  let roomCode;
  let manual;
  let shared;
  let replacement;

  await t.test('host creates a room and waits for server confirmation', async () => {
    host.click('createBtn');
    await until(() => host.elements.get('waitTip').textContent.includes('房间已创建'), 'host confirmation');
    roomCode = host.run('roomCode');
    assert.match(roomCode, /^\d{6}$/);
    assert.equal(host.elements.get('startBtn').disabled, true);
    host.run('toggleAI(3)');
  });

  await t.test('manual join gets a seat, current settings and an enabled ready button', async () => {
    manual = open();
    manual.elements.get('roomCodeInput').value = roomCode;
    manual.click('confirmJoinBtn');
    assert.equal(manual.elements.get('readyBtn').disabled, true);
    await until(() => manual.run('mySeatId') === 1 && manual.run('maxPlayers') === 8, 'manual join');
    assert.equal(manual.elements.get('readyBtn').disabled, false);
    assert.equal(manual.run('aiSlots[3]'), true);
    assert.match(manual.elements.get('waitTip').textContent, /已连接/);
  });

  await t.test('share URL automatically joins through the same WebSocket connection', async () => {
    shared = open('#room=' + roomCode);
    shared.ready();
    await until(() => shared.run('mySeatId') === 2 && manual.run('!!seats[2]'), 'share join and seat broadcast');
    assert.equal(shared.elements.get('readyBtn').disabled, false);
  });

  await t.test('waiting room names unready players and only enables start after the current rules are accepted', async () => {
    manual.click('readyBtn');
    await until(() => host.run('seats[1].ready') && shared.run('seats[1].ready'), 'first ready synchronization');
    assert.equal(host.elements.get('startBtn').disabled, true);
    assert.match(host.elements.get('leagueReadyState').textContent, /等待 .+ 准备/);
    assert.equal(manual.elements.get('readyBtn').disabled, true);
    host.run("RiverSession.command('roomSettings',{settings:{...settings,bigBlind:50},maxPlayers,aiSlots})");
    await until(() => !manual.elements.get('readyBtn').disabled && [manual,shared].every(client=>client.run('settings.bigBlind')===50), 'rule update clears readiness');
    assert.equal(manual.elements.get('waitRuleSummary').textContent,host.elements.get('waitRuleSummary').textContent);
    assert.match(manual.elements.get('leagueReadyState').textContent,/规则已更新/);
    manual.click('readyBtn');
    shared.click('readyBtn');
    await until(() => !host.elements.get('startBtn').disabled && shared.elements.get('readyBtn').disabled, 'all players ready');
    assert.match(shared.elements.get('waitTip').textContent, /已准备/);
  });

  await t.test('leaving and rejoining reuses the seat and resets readiness without rendering errors', async () => {
    manual.run('RiverSession.leave({reload:false,permanent:true})');manual.close();
    await until(() => host.run('seats[1] === null') && shared.run('seats[1] === null'), 'leave synchronization');
    replacement = open('#room=' + roomCode);
    replacement.ready();
    await until(() => replacement.run('mySeatId') === 1 && shared.run('!!seats[1]'), 'replacement join');
    assert.equal(host.run('seats[1].ready'), false);
    assert.equal(host.elements.get('startBtn').disabled, true);
    replacement.click('readyBtn');
    await until(() => !host.elements.get('startBtn').disabled, 'replacement readiness');
  });

  await t.test('host starts the game and guests receive their own cards', async () => {
    host.click('startBtn');
    await until(() => shared.run('clientGameState !== null') && replacement.run('clientGameState !== null'), 'game start');
    for (const client of [shared, replacement]) {
      assert.equal(client.elements.get('gameScreen').style.display, 'flex');
      assert.equal(client.run('clientGameState.players.find(p => p.id === mySeatId).holeCards.length'), 2);
      assert.equal(client.run('clientGameState.players.filter(p => p.id !== mySeatId).every(p => p.holeCards.length === 0)'), true);
    }
  });

  await t.test('nonexistent room reports failure and does not enable readiness', async () => {
    const missing = open('#room=' + (roomCode === '999999' ? '999998' : '999999'));
    missing.ready();
    await until(() => missing.elements.get('waitTip').textContent.includes('房间不存在'), 'missing room error');
    assert.equal(missing.elements.get('readyBtn').disabled, true);
    assert.equal(missing.run('mySeatId'), -1);
  });

  await t.test('explicit host leave closes the room and disables guest readiness', async () => {
    host.run('RiverSession.leave({reload:false,permanent:true})');host.close();
    await until(() => shared.elements.get('waitTip').textContent.includes('房主已离开'), 'host offline');
    assert.equal(shared.elements.get('readyBtn').disabled, true);
    assert.equal(shared.run('wsConnected'), false);
  });

  await t.test('page scripts complete without JavaScript exceptions', () => {
    for (const client of pages) assert.deepEqual(client.errors, []);
  });

  await t.test('public HTTPS pages choose secure WebSocket on the public hostname', () => {
    class Socket {
      static OPEN = 1;
      constructor(url) { this.url = url; }
      close() {}
    }
    const secure = page('https://example.trycloudflare.com/', '', Socket);
    try {
      secure.run('connectWS()');
      assert.equal(secure.run('ws.url'), 'wss://example.trycloudflare.com');
    } finally { secure.close(); }
  });
});
