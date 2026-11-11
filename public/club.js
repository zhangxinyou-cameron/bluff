(() => {
  const { request } = RiverAccount;
  const view = document.getElementById('clubView');
  const status = document.getElementById('clubStatus');
  const params = new URLSearchParams(location.search);
  const leagueCode = params.get('league');
  const reportId = params.get('report');
  const dimensionNames = { luck: '运气', strategy: '博弈', calculation: '算力', courage: '胆量', attack: '进攻', stability: '稳健' };
  const dimensionNotes = {
    luck: '下注锁定后的实际分池与预期分池', strategy: '翻后弱牌主动施压并拿下底池', calculation: '在赔率明确时作出符合估算的跟注或弃牌',
    courage: '一次主动投入至少行动前筹码的四分之一', attack: '有加注权时主动下注或加注', stability: '整手主动投入不超过开手筹码的三分之一'
  };
  let identity, lastDetail, busy = false;

  const content = children => children.flat(Infinity).filter(value => value != null);
  const display = (...children) => view.replaceChildren(...content(children));
  function el(tag, attributes = {}, ...children) {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attributes)) {
      if (value === false || value == null) continue;
      if (name === 'className') node.className = value;
      else node.setAttribute(name, value === true ? '' : value);
    }
    node.append(...content(children));
    return node;
  }
  const panel = (title, ...children) => el('section', { className: 'club-panel' }, el('h2', {}, title), children);
  const muted = text => el('p', { className: 'club-muted' }, text);
  const date = stamp => new Date(stamp).toLocaleString('zh-CN', { hour12: false });
  const number = value => Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  const leagueUrl = code => '/club.html?league=' + encodeURIComponent(code);
  const reportUrl = id => '/club.html?report=' + encodeURIComponent(id);
  const tableUrl = id => '/?leagueMatch=' + encodeURIComponent(id);
  const modeName = mode => mode === 'team' ? '团队赛' : '个人赛';
  const states = { waiting: '等待开赛', running: '比赛进行中', completed: '已结算', interrupted: '已中断' };
  const personName = player => (RiverAvatars.get(player?.avatar).emoji + ' ' + (player?.name || '玩家'));
  const action = (text, handler, secondary = false) => {
    const button = el('button', { type: 'button', className: secondary ? 'club-secondary' : '' }, text);
    button.onclick = handler;
    return button;
  };
  const link = (text, href) => el('a', { href }, text);
  const field = (text, name, properties = {}) => el('label', {}, text, el('input', { name, required: true, ...properties }));
  const numeric = (text, name, value, min, max) => field(text, name, { type: 'number', value, min, max });
  const select = (text, name, options) => el('label', {}, text, el('select', { name },
    options.map(([value, title, selected]) => el('option', { value, selected }, title))));
  const list = rows => el('ul', { className: 'club-list' }, rows.map(row => el('li', {}, row)));
  const row = (...items) => el('div', { className: 'club-row' }, items);
  const grid = (...items) => el('div', { className: 'club-grid' }, items);
  function tell(message) { status.textContent = message; status.hidden = !message; }

  async function run(work) {
    if (busy) return;
    busy = true;
    view.setAttribute('aria-busy', 'true');
    tell('');
    try { await work(); }
    catch (error) { tell(error.message); }
    finally { view.setAttribute('aria-busy', 'false'); busy = false; }
  }

  function form(label, fields, handler) {
    const node = el('form', {}, fields, el('button', {}, label));
    node.onsubmit = event => {
      event.preventDefault();
      run(() => handler(Object.fromEntries(new FormData(node))));
    };
    return node;
  }

  async function mutate(action, fields = {}) {
    const result = await request('/api/league', { action, code: leagueCode, ...fields });
    if (result.matchId) location.href = tableUrl(result.matchId);
    else if (result.code && !leagueCode) location.href = leagueUrl(result.code);
    else await showLeague(true);
  }

  async function showList() {
    if (!identity.leagues) { display(el('h1', {}, '联赛'), muted('联赛插件当前已关闭。')); return; }
    const { leagues } = await request('/api/league');
    const create = form('创建联赛', [
      field('联赛名称', 'name', { maxlength: 40 }),
      select('联赛赛制 · 创建后固定', 'mode', [['solo', '个人赛'], ['team', '团队赛']]),
      el('div', { className: 'club-form-grid', id: 'teamFields', hidden: true },
        numeric('队伍数量', 'teamCount', 2, 2, 16), numeric('每队名额', 'teamSize', 3, 1, 8)),
      el('div', { className: 'club-form-grid' },
        numeric('每场最低手数', 'minHands', 5, 1, 500), numeric('上榜最低场数', 'minMatches', 2, 1, 100))
    ], values => mutate('create', { ...values, teamCount: +values.teamCount, teamSize: +values.teamSize,
      minHands: +values.minHands, minMatches: +values.minMatches }));
    create.elements.mode.onchange = () => { create.querySelector('#teamFields').hidden = create.elements.mode.value !== 'team'; };
    const join = form('加入联赛', [field('8 位联赛码', 'code', { inputmode: 'numeric', pattern: '[0-9]{8}', maxlength: 8 })],
      values => mutate('join', values));
    const cards = leagues.length ? list(leagues.map(league => row(link(league.name, leagueUrl(league.code)),
      el('small', {}, modeName(league.mode) + ' · ' + (league.endedAt ? '历史' : '进行中') + (league.owner === identity.profile.uid ? ' · 我主办' : '')))))
      : muted('加入或创建联赛后，联赛会出现在这里。');
    display(el('h1', {}, '我的联赛'), panel('联赛列表', cards), grid(panel('加入联赛', join), panel('创建联赛', create)));
  }

  function standings(headers, rows) {
    if (!rows.length) return muted('还没有可统计的计分场。');
    return el('div', { className: 'club-scroll', tabindex: 0 }, el('table', { className: 'club-table' },
      el('thead', {}, el('tr', {}, headers.map(text => el('th', { scope: 'col' }, text)))),
      el('tbody', {}, rows.map(cells => el('tr', {}, cells.map(value => el('td', {}, value)))))));
  }

  function dimensionList(values) {
    return el('div', { className: 'club-dimensions' }, Object.entries(dimensionNames).map(([key, name]) => {
      const item = values[key];
      return el('div', {}, el('span', {}, name), el('strong', {}, item.score === null ? '样本不足' : item.score),
        el('small', {}, item.observed == null ? item.samples + ' 次适用机会' : `${item.observed}/${item.samples} 次符合条件`));
    }));
  }

  function radar(values) {
    if (!Object.values(values).some(value => value.score !== null)) return null;
    const canvas = el('canvas', { className: 'club-radar', width: 300, height: 250, 'aria-hidden': true });
    const ctx = canvas.getContext('2d');
    const labels = Object.entries(dimensionNames);
    const point = (index, radius) => {
      const angle = index * Math.PI / 3 - Math.PI / 2;
      return [150 + Math.cos(angle) * radius, 125 + Math.sin(angle) * radius];
    };
    function polygon(radii) {
      ctx.beginPath();
      radii.forEach((radius, index) => ctx.lineTo(...point(index, radius)));
      ctx.closePath();
    }
    ctx.strokeStyle = '#52685a';
    for (const radius of [24, 48, 72, 96]) { polygon(Array(6).fill(radius)); ctx.stroke(); }
    const items = labels.map(([key]) => values[key].score);
    if (items.every(value => value !== null)) {
      polygon(items.map(value => value * .96));
      ctx.fillStyle = '#e4c98d42'; ctx.fill();
      ctx.strokeStyle = '#e4c98d'; ctx.stroke();
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = '14px system-ui';
    labels.forEach(([, name], index) => {
      ctx.fillStyle = '#e6e9dc'; ctx.fillText(name, ...point(index, 115));
      if (items[index] === null) return;
      ctx.fillStyle = '#e4c98d'; ctx.beginPath(); ctx.arc(...point(index, items[index] * .96), 4, 0, Math.PI * 2); ctx.fill();
    });
    return canvas;
  }

  function dimensionsCard(player) {
    return panel(personName(player), muted(`${player.title || '牌风待定'} · ${player.hands} 手`), radar(player.values), dimensionList(player.values));
  }

  function teamsView(league) {
    const me = identity.profile.uid;
    const members = new Map(league.members.map(member => [member.uid, member]));
    const mine = league.teams.find(team => team.members.includes(me));
    const editing = !league.endedAt && !league.matches.some(match => ['waiting', 'running'].includes(match.status));
    const tiles = league.teams.map(team => {
      const roster = list(team.members.map(uid => personName(members.get(uid)) + (uid === team.captain ? ' · 队长' : '')));
      const requests = editing && team.captain === me && team.requests.length ? list(team.requests.map(uid => row(
        personName(members.get(uid)), action('同意', () => run(() => mutate('approveTeam', { teamId: team.id, uid, accept: true }))),
        action('拒绝', () => run(() => mutate('approveTeam', { teamId: team.id, uid, accept: false })), true)))) : null;
      const apply = editing && !mine && team.members.length < league.teamSize
        ? team.requests.includes(me) ? muted('等待队长审批') : action('申请加入', () => run(() => mutate('requestTeam', { teamId: team.id }))) : null;
      const leave = editing && mine === team ? league.locked.includes(me) ? muted('已锁定本届队伍') :
        action('退出队伍', () => run(() => mutate('leaveTeam')), true) : null;
      return panel(team.name, muted(`${team.members.length}/${league.teamSize} 人`), roster, requests, apply, leave);
    });
    if (editing && !mine && league.teams.length < league.teamCount) {
      tiles.push(panel('创建队伍', form('成为队长', [field('队名', 'name', { maxlength: 40 })], values => mutate('createTeam', values))));
    }
    return el('section', {}, el('h2', {}, `队伍 ${league.teams.length}/${league.teamCount}`), grid(tiles));
  }

  function showTeamRank(league) {
    const names = new Map(league.teams.map(team => [team.id, team.name]));
    return panel('团队积分榜', standings(['排名', '队伍', '场数', '对阵胜/平/负', '场均分', '总分', '净收益 BB', '队伍 MVP'],
      league.teamStandings.map(result => [result.place || '待达标', result.name, result.matches, `${result.wins}/${result.draws}/${result.losses}`,
        number(result.average), number(result.points), number(result.bb), result.mvp.map(player => player.name).join('、') || '—'])),
    el('details', { className: 'club-details' }, el('summary', {}, '交锋记录与 MVP 数据'), list(league.teamStandings.map(team =>
      [el('strong', {}, team.name), muted(Object.entries(team.headToHead).map(([id, value]) => `对 ${names.get(id)} ${value.matches} 次、${number(value.points)} 分`).join(' · ') || '暂无交锋'),
        team.mvp.map(player => muted(`${player.name} · ${player.matches} 场 / ${player.hands} 手 · ${number(player.bb)} BB · ${number(player.bb100)} BB/100`))]))));
  }

  function ratingHelp() {
    return el('details', { className: 'club-details' }, el('summary', {}, '六维评分口径'),
      list(Object.entries(dimensionNames).map(([key, name]) => name + ' · ' + dimensionNotes[key])),
      muted('至少打过 10 手，且一维有 5 次适用机会后才显示正式分数。胜率和赔率为模型估算。'));
  }

  async function showLeague(force = false) {
    const league = await request('/api/league?code=' + encodeURIComponent(leagueCode));
    const signature = JSON.stringify(league);
    if (!force && (signature === lastDetail || view.contains(document.activeElement) &&
        document.activeElement.matches('input, select, textarea'))) return;
    lastDetail = signature;
    const owner = league.owner === identity.profile.uid;
    const active = league.matches.find(match => ['waiting', 'running'].includes(match.status));
    const mode = modeName(league.mode);
    const canPlay = league.mode === 'solo' || league.teams.some(team => team.members.includes(identity.profile.uid));
    const activePanel = active ? panel('当前比赛', el('h3', {}, active.name), muted(states[active.status]),
      row(active.status === 'running' && !active.participantUids.includes(identity.profile.uid) ? muted('本场已经开赛，可等待下一场。') :
        canPlay ? el('a', { href: tableUrl(active.id), className: 'club-button' }, owner && active.status === 'waiting' ? '打开等待房' : '进入比赛房') :
        muted('先加入队伍才能入座。'), owner ? action('中止比赛', () => {
        if (confirm('中止这场比赛并关闭牌桌？')) run(() => mutate('cancel'));
      }, true) : null)) : null;
    const organizer = owner && !league.endedAt && !active ? panel('主办方操作',
      form('创建下一场', [field('比赛名称（可选）', 'name', { required: false, maxlength: 40 })], values => mutate('open', values)),
      action('结算联赛', () => { if (confirm('结算后冻结积分榜和队伍名单，继续吗？')) run(() => mutate('finish')); }, true)) : null;
    const history = panel('比赛记录', league.matches.length ? list([...league.matches].reverse().map(match => {
      const text = match.voidReason ? '已作废 · ' + match.voidReason : states[match.status];
      const teamResult = league.ledger.find(entry => entry.id === match.id)?.teams || [];
      const description = teamResult.map(team => {
        const name = league.teams.find(row => row.id === team.id)?.name;
        return `${name} ${number(team.bb)} BB / ${number(team.points)} 分`;
      }).join(' · ');
      return [row(match.status === 'completed' ? link(match.name, reportUrl(match.id)) : match.name,
        el('small', {}, text + (match.hands == null ? '' : ` · ${match.hands} 手${match.hands < league.minHands ? ' · 未达计分门槛' : ''}`))),
      description ? muted(description) : null,
      owner && !league.endedAt && match.status === 'completed' && !match.voidReason ? action('作废', () => {
        const reason = prompt('请输入公开的作废原因');
        if (reason?.trim()) run(() => mutate('void', { matchId: match.id, reason }));
      }, true) : null];
    })) : muted('尚无比赛。'));
    const personal = panel('个人积分榜', standings(['排名', '玩家', '场数', '手数', '场均分', '总分', '净筹码', '净收益 BB', 'BB/100'],
      league.players.map(player => [player.place || '待达标', personName(player), player.matches, player.hands,
        number(player.average), number(player.points), number(player.profit), number(player.bb), number(player.bb100)])));
    display(el('h1', {}, league.name),
      muted(`${mode} · 联赛码 ${league.code} · ${league.endedAt ? '已结算' : '进行中'} · 每场至少 ${league.minHands} 手 · 上榜至少 ${league.minMatches} 场`),
      activePanel, organizer, league.mode === 'team' ? [teamsView(league), showTeamRank(league)] : null, personal,
      league.players.length ? el('details', { className: 'club-details' }, el('summary', {}, '联赛六维与称号'),
        ratingHelp(), grid(league.players.map(dimensionsCard))) : null, history);
  }

  async function showReport() {
    const report = await request('/api/reports?id=' + encodeURIComponent(reportId));
    const rules = report.rules;
    const net = standings(['名次', '玩家', '手数', '起始筹码', '结束筹码', '未还贷款', '净收益', 'BB', '个人积分'],
      report.players.map(player => [player.place, personName(player), player.hands, number(player.initial), number(player.chips),
        number(player.debt), number(player.profit), number(player.bb), number(player.points)]));
    const deck = { short: '短牌', standard: '标准牌', auto: '按人数自动选择牌制' };
    const blinds = { short: '随牌制', auto: '随牌制', ante: '全员底注', position: '下家 1 倍盲注', standard: '标准大小盲' };
    display(el('h1', {}, report.name || '牌局赛报'),
      muted(`${date(report.endedAt)} · ${report.hands} 手 · ${deck[rules.deckMode]} · ${blinds[rules.blindMode]} · 大盲 ${rules.bigBlind} · ${rules.allowBuyIn ? '可贷款买入' : '淘汰制'}`),
      report.voidReason ? muted('本场已作废 · ' + report.voidReason) : null,
      report.leagueCode && identity.leagues ? link('返回所属联赛', leagueUrl(report.leagueCode)) : null,
      panel('赛果', net), ratingHelp(), grid(report.players.map(dimensionsCard)));
  }

  async function showProfile() {
    const { reports } = await request('/api/reports');
    const profile = identity.profile;
    const settings = form('保存个人资料', [field('昵称', 'name', { value: profile.name, maxlength: 32 }),
      select('头像', 'avatar', RiverAvatars.items.map(item => [item.id, item.emoji + ' ' + item.name, item.id === profile.avatar]))], async values => {
      identity = await request('/api/me', values);
      await showProfile();
      tell('个人资料已保存');
    });
    const passwordFields = [['当前数字密码', 'current'], ['新数字密码', 'password'], ['确认密码', 'confirmation']]
      .map(([text, name]) => field(text, name, { type: 'password', inputmode: 'numeric', pattern: '[0-9]+', maxlength: 128,
        autocomplete: name === 'current' ? 'current-password' : 'new-password' }));
    const password = form('更新密码', passwordFields, async values => {
      await request('/api/account/password', values);
      password.reset(); tell('密码已更新');
    });
    display(el('h1', {}, '个人档案'), muted(`账号 ${identity.account} · UID ${profile.uid}`),
      grid(panel('昵称与头像', settings), panel('登录设置', password, action('退出个人账号', () => run(async () => {
        await request('/api/account/logout', {});
        location.replace('/account.html');
      }), true))),
      panel('我的赛报', reports.length ? list(reports.map(report => row(link(report.name || '普通牌局', reportUrl(report.id)),
        el('small', {}, `${date(report.endedAt)} · ${report.hands} 手 · 净收益 ${number(report.profit)}${report.voidReason ? ' · 已作废' : ''}`)))) : muted('打完并结算一场后，就能在这里查看赛报。')));
  }

  run(async () => {
    try {
      identity = await request('/api/me');
      document.getElementById('leagueNav').hidden = !identity.leagues;
      if (reportId) await showReport();
      else if (params.has('profile')) await showProfile();
      else if (leagueCode && identity.leagues) {
        await showLeague(true);
        setInterval(() => { if (!document.hidden && !busy) showLeague().catch(() => {}); }, 5000);
      } else await showList();
    } catch (error) {
      display(el('h1', {}, '页面暂不可用'));
      if (error.status === 401) location.replace('/account.html');
      throw error;
    }
  });
})();
