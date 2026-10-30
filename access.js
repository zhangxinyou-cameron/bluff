const crypto = require('node:crypto');
const readline = require('node:readline');
const { Writable } = require('node:stream');
const { promisify } = require('node:util');
const scrypt = promisify(crypto.scrypt);
const COOKIE = 'river_session';
const SESSION_MS = 12 * 60 * 60 * 1000;
const ATTEMPT_MS = 15 * 60 * 1000;

async function passwordRecord(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = (await scrypt(password, salt, 64)).toString('hex');
  return { version: 1, salt, hash };
}

function hiddenQuestion(prompt) {
  return new Promise((resolve, reject) => {
    let muted = false;
    const output = new Writable({ write(chunk, encoding, callback) {
      if (!muted) process.stdout.write(chunk, encoding);
      callback();
    } });
    const input = readline.createInterface({ input: process.stdin, output, terminal: !!process.stdin.isTTY });
    input.once('SIGINT', () => { input.close(); reject(new Error('密码设置已取消')); });
    input.question(prompt, answer => {
      muted = false;
      process.stdout.write('\n');
      input.close();
      resolve(answer);
    });
    muted = true;
    input.once('close', () => { if (muted) reject(new Error('未输入密码，服务器未启动')); });
  });
}

async function promptStartupPassword() {
  console.log('\n每次启动都需要设置本次网站访问密码（8—128个字符，输入不回显）。');
  while (true) {
    const password = await hiddenQuestion('本次访问密码: ');
    if (password.length < 8 || password.length > 128 || !password.trim()) {
      console.log('密码须为8—128个字符，不能全为空格。');
      continue;
    }
    const record = await passwordRecord(password);
    console.log('本次访问密码已设置，仅在内存中保留摘要。服务器关闭后失效。\n');
    return record;
  }
}

function gatePage(message = '', retry = false) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="theme-color" content="#0c1716"><title>访问验证</title><style>
  :root{color-scheme:dark;font-family:'Segoe UI','Microsoft YaHei',sans-serif}*{box-sizing:border-box}body{margin:0;background:radial-gradient(ellipse at 50% 15%,#20382a,#0c1716 70%);color:#ede8d7;min-height:100svh;display:grid;place-items:center;padding:24px}main{width:100%;max-width:380px;padding:36px 28px;background:#182b21;border:1px solid #49553c;border-radius:12px;box-shadow:0 20px 70px #0003}.mark{font:28px Georgia;color:#d3b778;margin-bottom:24px}h1{font-size:23px;font-weight:500;letter-spacing:3px;margin:0 0 12px}p{color:#a4b09e;font-size:12px;line-height:1.8;margin:0 0 28px}label{font-size:12px;color:#c9cfba;display:block;margin-bottom:10px}input,button{font:inherit;width:100%;min-height:50px;border-radius:6px}input{color:#eee8d8;background:#102019;border:1px solid #4a5840;padding:12px 14px;font-size:16px}button{margin-top:16px;color:#18281b;background:#d3b778;border:0;cursor:pointer;letter-spacing:2px;font-size:13px;font-weight:600}button:disabled{opacity:.5;cursor:default}input:focus-visible,button:focus-visible{outline:2px solid #d3b778;outline-offset:3px}.message{font-size:12px;color:#dfab8e;min-height:20px;margin-top:16px;line-height:1.7}.note{font-size:10px;color:#7f927d;margin:22px 0 0;text-align:center}
  </style></head><body><main><div class="mark" aria-hidden="true">◇</div><h1>访问验证</h1><p>请输入服务端设置的访问密码。</p><form method="post"><label for="password">访问密码</label><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="128" autofocus><button type="submit" ${retry ? 'disabled' : ''}>验证并进入</button><div class="message" role="alert">${message}</div></form><p class="note">仅验证通过的访客可以继续访问</p></main></body></html>`;
}

class AccessControl {
  constructor() { this.record = null; this.sessions = new Map(); this.attempts = new Map(); }
  configure(record) { this.record = record; this.sessions.clear(); this.attempts.clear(); }
  token(req) {
    const match = (req.headers.cookie || '').match(/(?:^|;\s*)river_session=([A-Za-z0-9_-]{43})(?:;|$)/);
    return match ? crypto.createHash('sha256').update(match[1]).digest('hex') : null;
  }
  authenticated(req) {
    if (!this.record) return false; // Fail closed until first-run password setup completes.
    const key = this.token(req);
    const expires = this.sessions.get(key);
    if (expires && expires > Date.now()) return true;
    if (key) this.sessions.delete(key);
    return false;
  }
  sendGate(res, code = 200, message = '', retry = false) {
    res.writeHead(code, {
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
    });
    res.end(gatePage(message, retry));
  }
  async handle(req, res) {
    const pathname = req.url.split('?')[0];
    if (['/', '/login', '/auth/login'].includes(pathname) && req.method === 'POST') {
      if (!this.record) { this.sendGate(res, 503, '服务尚未完成密码设置'); return true; }
      if (req.headers.origin) {
        try {
          if (new URL(req.headers.origin).host !== req.headers.host) { this.sendGate(res, 403, '请求来源无效，请重新打开网址'); return true; }
        } catch (_) { this.sendGate(res, 403, '请求来源无效'); return true; }
      }
      if (!String(req.headers['content-type']).startsWith('application/x-www-form-urlencoded')) { this.sendGate(res, 415, '请通过验证页面提交密码'); return true; }
      // Cloudflared supplies CF-Connecting-IP; trust it only on a local tunnel connection.
      const remote = req.socket.remoteAddress || 'unknown';
      const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote);
      const ip = local && req.headers['cf-connecting-ip'] ? String(req.headers['cf-connecting-ip']) : remote;
      const now = Date.now();
      for (const [key, attempt] of this.attempts) if (attempt.until <= now) this.attempts.delete(key);
      let attempt = this.attempts.get(ip);
      if (attempt && attempt.count >= 8) {
        res.setHeader('Retry-After', String(Math.ceil((attempt.until-now)/1000)));
        this.sendGate(res, 429, '尝试次数过多，请15分钟后刷新重试', true);
        return true;
      }
      if (!attempt) {
        if (this.attempts.size >= 2048) { this.sendGate(res, 429, '请求较多，请稍后重试'); return true; }
        attempt = { count: 0, until: now + ATTEMPT_MS };
        this.attempts.set(ip, attempt);
      }
      attempt.count++;
      let body = '';
      for await (const chunk of req) {
        body += chunk.toString('utf8');
        if (Buffer.byteLength(body) > 4096) { this.sendGate(res, 413, '提交内容过长'); return true; }
      }
      const password = new URLSearchParams(body).get('password') || '';
      const validLength = password.length >= 8 && password.length <= 128;
      const candidate = validLength ? await scrypt(password, this.record.salt, 64) : Buffer.alloc(64);
      if (!validLength || !crypto.timingSafeEqual(candidate, Buffer.from(this.record.hash, 'hex'))) {
        this.sendGate(res, 401, '密码不正确，请重新输入');
        return true;
      }
      this.attempts.delete(ip);
      for (const [key, expires] of this.sessions) if (expires <= now) this.sessions.delete(key);
      if (this.sessions.size >= 2048) this.sessions.delete(this.sessions.keys().next().value);
      const token = crypto.randomBytes(32).toString('base64url');
      this.sessions.set(crypto.createHash('sha256').update(token).digest('hex'), now + SESSION_MS);
      const secure = req.socket.encrypted || (local && String(req.headers['x-forwarded-proto']).split(',')[0].trim() === 'https');
      res.writeHead(303, { Location: '/', 'Set-Cookie': `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MS/1000}${secure ? '; Secure' : ''}`, 'Cache-Control': 'no-store' });
      res.end();
      return true;
    }
    if (pathname === '/auth/logout' && req.method === 'POST') {
      const token = this.token(req);
      this.sessions.delete(token);
      if (token && this.onSessionRevoked) this.onSessionRevoked(token);
      res.writeHead(303, { Location: '/', 'Set-Cookie': `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`, 'Cache-Control': 'no-store' });
      res.end();
      return true;
    }
    if (this.authenticated(req)) return false;
    if (req.method === 'GET' && (pathname === '/' || pathname === '/login')) this.sendGate(res);
    else { res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); res.end('请先验证访问密码'); }
    return true;
  }
}

module.exports = { AccessControl, passwordRecord, promptStartupPassword };
