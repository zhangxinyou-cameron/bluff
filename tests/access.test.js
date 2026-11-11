const assert = require('node:assert/strict');
const { test } = require('node:test');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');
const { server, wss, access } = require('../server');
const { passwordRecord } = require('../access');

test('password protection covers HTTP, files, WebSockets and session revocation', async t => {
  const password = 'test-access-' + require('node:crypto').randomBytes(12).toString('hex');
  access.configure(await passwordRecord(password));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    for (const ws of wss.clients) ws.terminate();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => server.close(resolve));
  });
  const login = (value, extra = {}) => fetch(base + '/auth/login', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...extra }, body: new URLSearchParams({ password: value }) });
  let cookie;

  await t.test('unauthenticated visitors get only a generic password gate', async () => {
    const response = await fetch(base);
    const text = await response.text();
    assert.match(text, /访问验证/);
    assert.doesNotMatch(text, /德州扑克|THE RIVER|createRoom|audio\.js|styles\.css/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    for (const resource of ['/index.html', '/styles.css', '/audio.js', '/voice.js', '/voice-worklet.js', '/audio/lounge-jazz.wav', '/audio/rain-jazz.wav', '/audio/levels.json', '/server.js', '/data/access.json']) {
      const blocked = await fetch(base + resource);
      assert.equal(blocked.status, 401, resource);
      assert.doesNotMatch(await blocked.text(), /const |RIFF|THE RIVER/);
    }
  });
  await t.test('WebSocket upgrade without login is denied', async () => {
    const ws = new WebSocket(base.replace('http:', 'ws:'));
    await new Promise((resolve, reject) => {
      ws.on('open', () => reject(new Error('Unauthenticated socket was accepted')));
      ws.on('error', error => { assert.match(error.message, /401/); resolve(); });
    });
  });
  await t.test('incorrect password and cross-origin login are rejected', async () => {
    const incorrect = await login('wrong-password');
    assert.equal(incorrect.status, 401);
    assert.equal(incorrect.headers.get('set-cookie'), null);
    assert.equal((await login(password, { Origin: 'https://unrelated.example' })).status, 403);
  });
  await t.test('password grants a protected session and access to assets', async () => {
    const response = await login(password, { 'X-Forwarded-Proto': 'https' });
    assert.equal(response.status, 303);
    const header = response.headers.get('set-cookie');
    assert.match(header, /HttpOnly/);
    assert.match(header, /SameSite=Lax/);
    assert.match(header, /Secure/);
    cookie = header.split(';')[0];
    const home = await fetch(base, { headers: { Cookie: cookie } });
    assert.match(await home.text(), /THE RIVER/);
    const music = await fetch(base + '/audio/lounge-jazz.wav', { headers: { Cookie: cookie } });
    assert.equal(music.headers.get('content-type'), 'audio/wav');
    const bytes = Buffer.from(await music.arrayBuffer());
    assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
  });
  await t.test('authenticated requests still cannot traverse outside public files', async () => {
    const response = await fetch(base + '/..%5cserver.js', { headers: { Cookie: cookie } });
    assert.equal(response.status, 403);
    assert.equal((await fetch(base + '/data/access.json', { headers: { Cookie: cookie } })).status, 404);
    assert.equal((await fetch(base + '/%FF', { headers: { Cookie: cookie } })).status, 400);
  });
  await t.test('logout revokes both HTTP access and an already-open WebSocket', async () => {
    const ws = new WebSocket(base.replace('http:', 'ws:'), { headers: { Cookie: cookie } });
    await once(ws, 'open');
    const closed = once(ws, 'close');
    await fetch(base + '/auth/logout', { method: 'POST', headers: { Cookie: cookie }, redirect: 'manual' });
    const [code] = await closed;
    assert.equal(code, 1008);
    assert.equal((await fetch(base + '/index.html', { headers: { Cookie: cookie } })).status, 401);
  });
  await t.test('expired or forged cookies cannot access game resources', async () => {
    const response = await login(password);
    const expired = response.headers.get('set-cookie').split(';')[0];
    const key = access.token({ headers: { cookie: expired } });
    access.sessions.set(key, Date.now()-1);
    assert.equal((await fetch(base + '/audio.js', { headers: { Cookie: expired } })).status, 401);
    assert.equal((await fetch(base + '/index.html', { headers: { Cookie: 'river_session='+'a'.repeat(43) } })).status, 401);
  });
  await t.test('repeated incorrect passwords are rate limited', async () => {
    for (let i=0; i<8; i++) assert.equal((await login('wrong-password')).status, 401);
    const blocked = await login(password);
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  });
});

test('each startup requires a fresh hidden password and never persists it', async () => {
  for (let run=0;run<2;run++) {
    const password='startup-'+require('node:crypto').randomBytes(12).toString('hex');
    const child=spawn(process.execPath,['-e','require("./access").promptStartupPassword().then(record=>{if(!/^[a-f0-9]{128}$/.test(record.hash))process.exitCode=1}).catch(()=>{process.exitCode=1})'],{cwd:path.join(__dirname,'..'),windowsHide:true,stdio:['pipe','pipe','pipe']});
    let transcript='',entered=false;
    const timeout=setTimeout(()=>child.kill(),10000);
    child.stdout.on('data',chunk=>{
      transcript+=chunk;
      if(!entered&&transcript.includes('本次访问密码:')){entered=true;child.stdin.end(password+'\n');}
    });
    const [code]=await once(child,'exit');clearTimeout(timeout);
    assert.equal(code,0);assert.equal(entered,true);
    assert.equal(transcript.includes(password),false);
    assert.match(transcript,/仅在内存中/);
  }
});

test('a duplicate startup reports the occupied port before prompting for a password', async t => {
  const listener = net.createServer();
  listener.listen(0, '0.0.0.0');
  await once(listener, 'listening');
  t.after(() => new Promise(resolve => listener.close(resolve)));
  const { port } = listener.address();
  const child = spawn(process.execPath, ['-e',
    'require("./server").startServer(Number(process.argv[1])).catch(error => { console.error(error.message); process.exitCode = 1; })',
    String(port)
  ], { cwd: path.join(__dirname, '..'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const timeout = setTimeout(() => child.kill(), 10_000);
  let output = '', errors = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { errors += chunk; });
  try {
    const [code] = await once(child, 'close');
    assert.equal(code, 1);
    assert.match(errors, new RegExp(`端口 ${port} 已被占用`));
    assert.doesNotMatch(output, /访问密码|联赛插件/);
    assert.doesNotMatch(errors, /Unhandled|node:events/);
    assert.equal(listener.listening, true);
  } finally {
    clearTimeout(timeout);
  }
});
