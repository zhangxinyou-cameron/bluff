const { error, profile } = require('./accounts');

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw error(415, '需要 JSON 请求');
  if (req.headers.origin) {
    let host;
    try { host = new URL(req.headers.origin).host; } catch {}
    if (host !== req.headers.host) throw error(403, '请求来源无效');
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 4096) throw error(413, '提交内容过长');
    chunks.push(chunk);
  }
  let data;
  try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
  if (!data || Array.isArray(data) || typeof data !== 'object') throw error(400, '提交内容无效');
  return data;
}

const accountAssets = new Set(['/account.html', '/account-client.js', '/club.css']);

async function identityHttp(req, res, access, accounts, stats, leagues, rooms, revoke) {
  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;
  const post = req.method === 'POST';
  const gateKey = access.token(req);
  const session = accounts.session(req, gateKey);
  const uid = session?.uid;
  if (post && ['/api/account/register', '/api/account/login'].includes(pathname)) {
    const data = await readBody(req);
    const record = pathname.endsWith('/register') ? await accounts.register(req, data) : await accounts.login(req, data);
    if (!access.authenticated(req)) throw error(401, '本次访问验证已过期');
    if (session) revoke(token => token === session.token);
    res.setHeader('Set-Cookie', accounts.cookie(req, accounts.issue(record, gateKey)));
    json(res, { profile: profile(record) });
    return true;
  }
  if (!uid) {
    if (req.method === 'GET' && accountAssets.has(pathname)) return false;
    if (req.method === 'GET' && ['/', '/index.html', '/club.html'].includes(pathname)) {
      res.writeHead(303, { Location: '/account.html', 'Cache-Control': 'no-store' });
      res.end();
    } else json(res, { message: '请先登录个人账号' }, 401);
    return true;
  }
  if (post && pathname === '/api/account/logout') {
    await readBody(req);
    revoke(token => token === session.token);
    res.setHeader('Set-Cookie', accounts.cookie(req));
    json(res, {});
    return true;
  }
  if (post && pathname === '/api/account/password') {
    await accounts.changePassword(req, uid, await readBody(req));
    revoke((token, value) => value.uid === uid && token !== session.token);
    json(res, {});
    return true;
  }
  if (pathname === '/api/me') {
    const record = accounts.byUid.get(uid);
    const current = post ? accounts.update(uid, await readBody(req)) : profile(record);
    if (post) rooms.updateProfile(uid, current);
    json(res, { profile: current, account: record.number, leagues: !!leagues });
    return true;
  }
  if (pathname === '/api/reports' && req.method === 'GET') {
    const id = url.searchParams.get('id');
    if (id) {
      const report = stats.matches.get(id);
      if (report?.status !== 'completed') throw error(404, '赛报尚未发布');
      if (report.leagueCode) {
        if (leagues) leagues.league(report.leagueCode, uid);
        else if (!report.players.some(player => player.uid === uid)) throw error(404, '赛报不存在');
      } else if (!report.players.some(player => player.uid === uid)) throw error(404, '赛报不存在');
      const { players, ...summary } = report;
      json(res, { ...summary, players: players.map(({ metrics, ...row }) => row) });
    } else {
      const reports = [...stats.matches.values()].filter(report => report.status === 'completed' && report.players.some(row => row.uid === uid))
        .sort((a, b) => b.endedAt - a.endedAt);
      json(res, { reports: reports.map(({ id, name, endedAt, leagueCode, hands, voidReason, players }) => {
        const player = players.find(row => row.uid === uid);
        return { id, name, endedAt, leagueCode, hands, voidReason, profit: player.profit, bb: player.bb, playerHands: player.hands };
      }) });
    }
    return true;
  }
  if (pathname === '/api/league') {
    if (!leagues) throw error(404, '联赛插件未开启');
    if (post) {
      const result = leagues.command(uid, await readBody(req), code => rooms.games.has(code));
      if (result.matchId) rooms.openLeagueRoom(stats.matches.get(result.matchId));
      if (result.closeCode) rooms.closeRoom(result.closeCode, '比赛已中止');
      json(res, result);
    } else if (url.searchParams.has('match')) json(res, leagues.matchView(url.searchParams.get('match'), uid));
    else if (url.searchParams.has('code')) json(res, leagues.detail(leagues.league(url.searchParams.get('code'), uid), uid, code => rooms.games.get(code)));
    else json(res, { leagues: leagues.list(uid) });
    return true;
  }
  return false;
}

module.exports = { identityHttp, json };
