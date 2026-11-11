const { randomInt, randomUUID } = require('node:crypto');
const path = require('node:path');
const { error, profile } = require('./accounts');
const { readRecords, writeRecord, deleteRecord } = require('./local-store');
const points = require('./league-points');

const formats = new Map([[`${points.id}:${points.version}`, points]]);
const active = match => ['waiting', 'running'].includes(match.status);
const bounded = (number, min, max) => Number.isInteger(number) && number >= min && number <= max;
const label = value => typeof value === 'string' ? value.trim().slice(0, 40) : '';

class Leagues {
  constructor(root, stats, accounts) {
    this.directory = path.join(root, 'leagues');
    this.leagues = new Map(readRecords(this.directory).map(record => [record.code, record]));
    this.stats = stats;
    this.accounts = accounts;
    for (const league of this.leagues.values()) {
      if (league.deletedAt) this.purge(league);
    }
  }

  save(league) {
    writeRecord(this.directory, league.code, league);
    this.leagues.set(league.code, league);
  }

  matches(league) {
    return [...this.stats.matches.values()].filter(match => match.leagueCode === league.code).sort((a, b) => a.createdAt - b.createdAt);
  }

  purge(marker) {
    try {
      this.stats.deleteMatches(marker.matchIds);
      deleteRecord(this.directory, marker.code);
      this.leagues.delete(marker.code);
      return true;
    } catch (error) {
      console.error('联赛档案清理失败，将在下次启动时重试:', error.message);
      return false;
    }
  }

  league(code, uid) {
    const league = this.leagues.get(code);
    if (!league || league.deletedAt || !league.members.includes(uid)) throw error(404, '联赛不存在或你尚未加入');
    return league;
  }

  list(uid) {
    return [...this.leagues.values()].filter(league => !league.deletedAt && league.members.includes(uid))
      .map(({ code, name, owner, mode, endedAt }) => ({ code, name, owner, mode, endedAt }));
  }

  detail(league, uid, roomForCode) {
    const matches = this.matches(league);
    const format = formats.get(league.format);
    if (!format) throw error(503, '当前联赛规则版本未安装');
    const { players, teams: teamStandings, ledger } = format.aggregate(league, matches);
    return { ...league, members: league.members.map(id => profile(this.accounts.byUid.get(id))),
      teams: league.teams.map(team => ({ ...team, requests: team.captain === uid ? team.requests : team.requests.filter(id => id === uid) })),
      matches: matches.map(({ players, ...match }) => {
        const room = match.status === 'waiting' ? roomForCode(match.code) : null;
        const seats = room ? [...room.people.values()].filter(person => person.connected && !person.retired)
          .map(({ uid, name, avatar, id, ready }) => ({ uid, name, avatar, host: id === 0, ready: id === 0 || ready })) : [];
        return { ...match, participantCount: players?.length || match.participantUids?.length || 0,
          ...(room ? { seats, capacity: room.maxPlayers } : {}) };
      }),
      locked: league.members.filter(id => this.locked(league, id)), players, teamStandings, ledger };
  }

  matchForCode(code) {
    return [...this.stats.matches.values()].find(match => match.code === code && active(match));
  }

  matchView(id, uid) {
    const match = this.stats.matches.get(id);
    if (!match?.leagueCode || !active(match)) throw error(404, '比赛房已关闭');
    this.admit(match, uid);
    if (match.status === 'running' && !match.participantUids.includes(uid)) throw error(409, '比赛已开始，请等待下一场');
    return { code: match.code, host: match.owner === uid };
  }

  admit(match, uid) {
    const league = this.league(match.leagueCode, uid);
    if (league.endedAt || !active(this.stats.matches.get(match.id))) throw error(409, '比赛已结束');
    if (league.mode === 'team' && !league.teams.some(team => team.members.includes(uid))) throw error(403, '请先加入本联赛的队伍');
    return league;
  }

  roster(match, humans) {
    const league = this.league(match.leagueCode, humans[0]?.uid);
    const teams = {};
    const counts = new Map();
    for (const { uid } of humans) {
      this.admit(match, uid);
      if (league.mode !== 'team') continue;
      const team = league.teams.find(row => row.members.includes(uid));
      teams[uid] = team.id;
      counts.set(team.id, (counts.get(team.id) || 0) + 1);
    }
    if (league.mode === 'team' && (counts.size < 2 || new Set(counts.values()).size !== 1)) {
      throw error(400, '团队场至少需要两支队伍，且各队上场人数必须相同');
    }
    return { ...match, teams };
  }

  locked(league, uid) {
    return this.matches(league).some(match => match.status === 'completed' &&
      match.hands >= league.minHands && match.players.some(player => player.uid === uid && player.teamId));
  }

  command(uid, data, roomExists) {
    if (data.action === 'create') {
      const name = label(data.name);
      const { mode, minHands, minMatches } = data;
      if (!name || !['solo', 'team'].includes(mode) || !bounded(minHands, 1, 500) || !bounded(minMatches, 1, 100) ||
          (mode === 'team' && (!bounded(data.teamCount, 2, 16) || !bounded(data.teamSize, 1, 8)))) {
        throw error(400, '请核对联赛名称、赛制、队伍人数和出场门槛');
      }
      let code = data.code;
      if (code == null) {
        do { code = String(randomInt(10_000_000, 100_000_000)); } while (this.leagues.has(code));
      } else {
        if (typeof code !== 'string' || !/^[0-9]{8}$/.test(code)) throw error(400, '请输入 8 位数字联赛房间号');
        if (this.leagues.has(code)) throw error(409, '此联赛房间号已被使用，请换一个号码');
      }
      const league = { code, name, mode, minHands, minMatches, owner: uid, members: [uid], teams: [],
        teamCount: mode === 'team' ? data.teamCount : 0, teamSize: mode === 'team' ? data.teamSize : 0,
        format: `${points.id}:${points.version}`, createdAt: Date.now(), endedAt: null };
      this.save(league);
      return { code };
    }
    if (data.action === 'join') {
      const league = this.leagues.get(data.code);
      if (!league || league.deletedAt) throw error(404, '联赛不存在');
      if (league.members.includes(uid)) return { code: league.code };
      if (league.endedAt) throw error(409, '联赛已结算');
      this.save({ ...league, members: [...league.members, uid] });
      return { code: league.code };
    }

    const existing = this.league(data.code, uid);
    if (data.action === 'delete') {
      if (existing.owner !== uid) throw error(403, '只有联赛主办方可以删除联赛');
      const matches = this.matches(existing);
      if (!existing.endedAt || matches.some(active)) throw error(409, '请先结算联赛，再删除档案');
      const marker = { code: existing.code, deletedAt: Date.now(), matchIds: matches.map(match => match.id) };
      // Preserve the deletion across restarts even if a file is temporarily locked.
      this.save(marker);
      return { deleted: true, cleanupPending: !this.purge(marker) };
    }

    const league = structuredClone(existing);
    if (league.endedAt) throw error(409, '联赛已结算，只能查看历史');
    const isOwner = league.owner === uid;
    const current = this.matches(league).find(active);
    if (['finish', 'void'].includes(data.action) && !isOwner) throw error(403, '仅主办方可以操作');
    if (data.action === 'open') {
      if (current) throw error(409, '请先结束现有比赛');
      if (league.mode === 'team' && (!league.teams.some(team => team.members.includes(uid)) || league.teams.length < 2)) {
        throw error(409, '请先创建至少两支队伍，开房成员也须加入一队');
      }
      let code;
      do { code = String(randomInt(100_000, 1_000_000)); } while (roomExists(code) || this.matchForCode(code));
      const match = this.stats.save({ id: randomUUID(), code, name: label(data.name) || `第 ${this.matches(league).length + 1} 场`,
        leagueCode: league.code, mode: league.mode, owner: uid, status: 'waiting', createdAt: Date.now() });
      return { matchId: match.id };
    }
    if (data.action === 'cancel') {
      if (!current) throw error(409, '当前没有进行中的比赛');
      if (!isOwner && current.owner !== uid) throw error(403, '只有联赛主办方或本场房主可以中止比赛');
      this.stats.save({ ...current, status: 'interrupted', endedAt: Date.now() });
      return { closeCode: current.code };
    }
    if (data.action === 'void') {
      const match = this.matches(league).find(row => row.id === data.matchId);
      const reason = typeof data.reason === 'string' ? data.reason.trim().slice(0, 200) : '';
      if (match?.status !== 'completed' || match.voidReason || !reason) throw error(400, '请选择已结算的比赛并填写作废原因');
      this.stats.save({ ...match, voidReason: reason, voidedAt: Date.now(), voidedBy: uid });
      return {};
    }
    if (data.action === 'finish') {
      if (current) throw error(409, '请先结算或中止当前比赛');
      league.endedAt = Date.now();
      this.save(league);
      return {};
    }

    if (league.mode !== 'team') throw error(400, '个人联赛没有队伍');
    if (current) throw error(409, '请在两场比赛之间调整队伍');
    const mine = league.teams.find(team => team.members.includes(uid));
    const team = league.teams.find(row => row.id === data.teamId);
    if (data.action === 'createTeam') {
      const name = label(data.name);
      if (mine || !name || league.teams.length >= league.teamCount || league.teams.some(row => row.name === name)) {
        throw error(409, '已有队伍、队名重复或队伍名额已满');
      }
      league.teams.push({ id: randomUUID(), name, captain: uid, members: [uid], requests: [] });
    } else if (data.action === 'requestTeam') {
      if (mine || !team || team.members.length >= league.teamSize) throw error(409, '无法申请该队伍');
      if (!team.requests.includes(uid)) team.requests.push(uid);
    } else if (data.action === 'approveTeam') {
      const target = data.uid;
      if (team?.captain !== uid || !team.requests.includes(target)) throw error(403, '只有队长可以处理申请');
      if (data.accept === true) {
        if (team.members.length >= league.teamSize || league.teams.some(row => row.members.includes(target))) throw error(409, '队伍已满或玩家已入队');
        team.members.push(target);
      }
      for (const row of data.accept === true ? league.teams : [team]) row.requests = row.requests.filter(id => id !== target);
    } else if (data.action === 'leaveTeam') {
      if (!mine || this.locked(league, uid)) throw error(409, '已为该队打完计分场，本届联赛锁队');
      mine.members = mine.members.filter(id => id !== uid);
      if (!mine.members.length) league.teams = league.teams.filter(row => row !== mine);
      else if (mine.captain === uid) mine.captain = mine.members[0];
    } else throw error(400, '未知联赛操作');
    if (data.action === 'createTeam') {
      for (const row of league.teams) row.requests = row.requests.filter(id => id !== uid);
    }
    this.save(league);
    return {};
  }
}

module.exports = { Leagues };
