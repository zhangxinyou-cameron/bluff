const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');
const { AccessControl, promptStartupPassword } = require('./access');
const { RoomManager } = require('./room-manager');
const { findCloudflared } = require('./tunnel');
const { Accounts } = require('./accounts');
const { MatchStats } = require('./match-stats');
const { Leagues } = require('./leagues');
const { identityHttp, json } = require('./identity-http');
const { readRecords, writeRecord } = require('./local-store');

const PORT = 3000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.json': 'application/json; charset=utf-8'
};

const access = new AccessControl();
let accounts, stats, leagues;
const publicRoot = path.resolve(__dirname, 'public');
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  try {
    if (await access.handle(req, res)) return;
  } catch (error) {
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('访问验证暂时不可用');
    return;
  }
  try {
    if(accounts&&await identityHttp(req,res,access,accounts,stats,leagues,roomManager,revokeAccounts))return;
  } catch(error) {
    if(!error.status)console.error('Account or league request:',error.message);
    json(res,{message:error.status?error.message:'本地数据暂时无法访问，请稍后再试'},error.status||500);return;
  }
  if(['/api/session','/api/me'].includes(req.url.split('?')[0])) {
    json(res,{authenticated:true,profile:null,leagues:false});return;
  }
  let pathname;
  try { pathname = decodeURIComponent(req.url.split('?')[0]); }
  catch (_) { res.writeHead(400); res.end('Bad request'); return; }
  if (pathname === '/') pathname = '/index.html';
  const filePath = path.resolve(publicRoot, '.' + pathname);
  if (!filePath.startsWith(publicRoot + path.sep)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 65536 });
function revokeAccounts(predicate) {
  if(!accounts)return;
  const tokens=new Set();
  for(const [token,session] of accounts.sessions)if(predicate(token,session)){accounts.sessions.delete(token);tokens.add(token);}
  for(const ws of wss.clients)if(tokens.has(ws.accountToken)){ws.accountRevoked=true;ws.close(4004,'Account ended');}
}
access.onSessionRevoked = key => {
  revokeAccounts((_,session)=>session.gateKey===key);
  for (const ws of wss.clients) if (ws.accessKey === key) ws.close(1008, 'Access ended');
};
const sessionCheck = setInterval(() => {
  for (const ws of wss.clients) {
    if ((access.sessions.get(ws.accessKey) || 0) <= Date.now() ||
        accounts&&(accounts.sessions.get(ws.accountToken)?.expires||0)<=Date.now()) {
      ws.accountRevoked=true;ws.close(4004,'Session expired');
    }
  }
}, 60000);
sessionCheck.unref();
server.on('upgrade', (req, socket, head) => {
  const session=accounts?.session(req,access.token(req));
  if (!access.authenticated(req)||(accounts&&!session)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  // Browsers include Origin on upgrades; reject connections opened by other sites.
  if (req.headers.origin) {
    try { if (new URL(req.headers.origin).host !== req.headers.host) { socket.destroy(); return; } }
    catch (_) { socket.destroy(); return; }
  }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req, session));
});
const rooms = new Map();
const roomManager = new RoomManager(rooms);
wss.on('connection', (ws, req, session) => {
  ws.accessKey=access.token(req);ws.roomCode=null;ws.seatId=-1;ws.isAlive=true;
  if(session){ws.uid=session.uid;ws.accountToken=session.token;}
  ws.on('pong',()=>{ws.isAlive=true;});
  ws.on('error',()=>{});
  ws.on('message',(message,isBinary)=>{
    try {
      if(isBinary||ws.accountRevoked)return;
      if((access.sessions.get(ws.accessKey)||0)<=Date.now()||
         accounts&&(accounts.sessions.get(ws.accountToken)?.expires||0)<=Date.now()){ws.close(4004,'Session expired');return;}
      let data;try{data=JSON.parse(message.toString());}catch(_){return;}
      if(!data||typeof data!=='object'||Array.isArray(data))return;
      roomManager.handle(ws,data);
    } catch(error) {console.error('Connection command:',error.message);}
  });
  ws.on('close',()=>{if(!ws.superseded)roomManager.leave(ws);});
});
const heartbeat=setInterval(()=>{
  for(const ws of wss.clients){if(!ws.isAlive){ws.terminate();continue;}ws.isAlive=false;ws.ping();}
},15000);
heartbeat.unref();
wss.on('close',()=>{clearInterval(heartbeat);roomManager.dispose();});

function getLocalIPs() {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        ips.push({ name, ip: net.address });
      }
    }
  }
  return ips;
}

// 启动Cloudflare公网隧道
function startTunnel() {
  const exePath = findCloudflared();

  if (!exePath) {
    console.log('  公网隧道未启动：未找到 cloudflared。');
    console.log('  请将 cloudflared'+(process.platform==='win32'?'.exe':'')+' 放到：'+__dirname);
    console.log('  也可加入系统 PATH，或设置 CLOUDFLARED_PATH 为程序完整路径，然后重启。');
    console.log('  本地和同 WiFi 访问仍可正常使用。');
    return;
  }

  const args = ['tunnel', '--url', `http://localhost:${PORT}`];
  const proc = spawn(exePath, args, { windowsHide:true, stdio: ['ignore', 'pipe', 'pipe'] });

  let publicUrl = null;
  proc.on('error',error=>console.log('  公网隧道程序启动失败：'+error.message+'；请检查程序路径和运行权限。'));
  proc.on('exit',code=>{if(!publicUrl)console.log('  公网隧道程序已退出（'+code+'），尚未生成地址；请检查网络后重启服务器。');});

  proc.stdout.on('data', (data) => {
    const text = data.toString();
    const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (match && !publicUrl) {
      publicUrl = match[0];
      printPublicUrl(publicUrl);
    }
  });

  proc.stderr.on('data', (data) => {
    const text = data.toString();
    const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (match && !publicUrl) {
      publicUrl = match[0];
      printPublicUrl(publicUrl);
    }
  });

  function printPublicUrl(url) {
    console.log('');
    console.log('==================================================');
    console.log('  🌐 公网地址（发给任何朋友，不用同WiFi）:');
    console.log('  ' + url);
    console.log('==================================================');
    console.log('');
  }

  process.on('exit', () => { try { proc.kill(); } catch(e){} });
  process.on('SIGINT', () => { try { proc.kill(); } catch(e){} process.exit(0); });
}

function configureIdentity(root, enableLeagues=true) {
  accounts=new Accounts(root);
  stats=new MatchStats(root);
  leagues=enableLeagues?new Leagues(root,stats,accounts):null;
  Object.assign(roomManager,{accounts,stats,leagues});
  return {accounts,stats,leagues};
}

async function startServer() {
  access.configure(await promptStartupPassword());
  const dataRoot=path.join(__dirname,'data');
  const configDir=path.join(dataRoot,'settings');
  const selected=process.argv.find(arg=>/^--leagues=(on|off)$/.test(arg));
  const enableLeagues=selected?selected.endsWith('=on'):(readRecords(configDir)[0]?.leagues??true);
  if(selected)writeRecord(configDir,'server',{leagues:enableLeagues});
  configureIdentity(dataRoot,enableLeagues);
  console.log('  联赛插件：'+(enableLeagues?'已开启':'已关闭'));
  server.listen(PORT, '0.0.0.0', () => {
  const ips = getLocalIPs();
  console.log('');
  console.log('========================================');
  console.log('  德州扑克服务器已启动');
  console.log('========================================');
  console.log('');
  console.log('  你自己访问:  http://localhost:' + PORT);
  console.log('');
  console.log('  同WiFi朋友:');
  if (ips.length === 0) {
    console.log('    (未检测到)');
  } else {
    ips.forEach(n => {
      console.log(`    http://${n.ip}:${PORT}`);
    });
  }
  console.log('');
  console.log('  正在生成公网地址，请等待...');
  console.log('');

  startTunnel();
  });
}

if (require.main === module) startServer().catch(error => {
  console.error('服务器未启动：' + error.message);
  process.exitCode = 1;
});
module.exports = { server, wss, access, roomManager, rooms, configureIdentity };
