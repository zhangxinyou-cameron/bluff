const { empty, scores, title, RATING_VERSION } = require('./match-stats');

const close = value => Math.abs(value) < 1e-9 ? 0 : value;
const compareRecord = (a, b) => close(b.average - a.average) || close(b.bb100 - a.bb100);

function rank(rows, minimum, compare) {
  const qualified = rows.filter(row => row.matches >= minimum).sort(compare);
  qualified.forEach((row, index) => {
    row.place = index && !compare(qualified[index - 1], row) ? qualified[index - 1].place : index + 1;
  });
  return [...qualified, ...rows.filter(row => row.matches < minimum).sort(compare)];
}

function aggregate(league, matches, netPoints = false) {
  const playerRows = new Map();
  const teamRows = new Map(league.teams.map(team => [team.id, {
    id: team.id, name: team.name, matches: 0, points: 0, bb: 0, profit: 0,
    wins: 0, draws: 0, losses: 0, headToHead: {}, contributions: new Map()
  }]));
  const ledger = [];
  for (const match of matches) {
    const counted = match.status === 'completed' && !match.voidReason && match.hands >= (netPoints ? 1 : league.minHands);
    if (!counted) continue;
    const teams = new Map();
    const participants = match.players.filter(player => player.hands > 0);
    const highest = Math.max(...participants.map(player => player.bb));
    const mvpUids = new Set(participants.filter(player => !close(player.bb - highest)).map(player => player.uid));
    for (const player of netPoints ? participants : match.players) {
      if (!playerRows.has(player.uid)) playerRows.set(player.uid, { uid: player.uid, matches: 0, hands: 0, profit: 0, bb: 0, points: 0,
        mvps: 0, knockouts: 0, knockoutMatches: 0, ratings: new Map() });
      const row = playerRows.get(player.uid);
      row.name = player.name;
      row.avatar = player.avatar;
      row.matches++;
      if (mvpUids.has(player.uid)) row.mvps++;
      if (Number.isInteger(player.knockouts)) {
        row.knockouts += player.knockouts;
        row.knockoutMatches++;
      }
      for (const field of ['hands', 'profit', 'bb']) row[field] += player[field];
      row.points += netPoints ? player.bb : player.points;
      const version = match.ratingVersion ?? 1;
      if (!row.ratings.has(version)) row.ratings.set(version, { hands: 0, metrics: empty() });
      const rating = row.ratings.get(version);
      rating.hands += player.hands;
      for (const key of Object.keys(rating.metrics)) {
        rating.metrics[key].total += player.metrics[key].total;
        rating.metrics[key].samples += player.metrics[key].samples;
      }
      const team = teamRows.get(player.teamId);
      if (!team) continue;
      if (!teams.has(team.id)) teams.set(team.id, { id: team.id, bb: 0, profit: 0 });
      const appearance = teams.get(team.id);
      appearance.bb += player.bb;
      appearance.profit += player.profit;
      const contribution = team.contributions.get(player.uid) || { uid: player.uid, matches: 0, hands: 0, bb: 0 };
      contribution.matches++;
      contribution.hands += player.hands;
      contribution.bb += player.bb;
      team.contributions.set(player.uid, contribution);
    }
    for (const own of teams.values()) {
      const row = teamRows.get(own.id);
      row.matches++;
      row.bb += own.bb;
      row.profit += own.profit;
      if (netPoints) {
        own.points = own.bb;
        row.points += own.points;
        continue;
      }
      let points = 0;
      for (const opponent of teams.values()) {
        if (opponent.id === own.id) continue;
        const outcome = own.profit === opponent.profit ? 'draws' : own.profit > opponent.profit ? 'wins' : 'losses';
        const score = { wins: 3, draws: 1, losses: 0 }[outcome];
        row[outcome]++;
        points += score;
        const record = row.headToHead[opponent.id] ||= { matches: 0, points: 0 };
        record.matches++;
        record.points += score;
      }
      own.points = points / Math.max(1, teams.size - 1);
      row.points += own.points;
    }
    ledger.push({ id: match.id, teams: [...teams.values()], mvpUids: [...mvpUids] });
  }
  const players = [...playerRows.values()].map(row => {
    const { ratings, ...rest } = row;
    const ratingVersion = ratings.has(RATING_VERSION) ? RATING_VERSION : 1;
    const rating = ratings.get(ratingVersion);
    const values = scores(rating.metrics, rating.hands, ratingVersion);
    return { ...rest, average: row.points / row.matches, bb100: 100 * row.bb / row.hands, values, ratingVersion, title: title(values) };
  });
  const teams = [...teamRows.values()].map(({ contributions, ...row }) => {
    const eligible = [...contributions.values()].filter(player => player.matches >= league.minMatches).sort((a, b) => b.bb - a.bb);
    return { ...row, average: row.matches ? row.points / row.matches : 0, bbPerMatch: row.matches ? row.bb / row.matches : 0,
      mvp: eligible.filter(player => !close(player.bb - eligible[0].bb)).map(player => ({ ...player,
        name: playerRows.get(player.uid).name, bb100: 100 * player.bb / player.hands })) };
  });
  for (const team of netPoints ? [] : teams) {
    const tied = teams.filter(other => other !== team && other.matches >= league.minMatches && Math.abs(team.average - other.average) < 1e-9);
    if (tied.length && [team, ...tied].every(a => [team, ...tied].every(b => a === b || a.headToHead[b.id]))) {
      const records = tied.map(other => team.headToHead[other.id]);
      team.direct = records.reduce((sum, record) => sum + record.points, 0) / records.reduce((sum, record) => sum + record.matches, 0);
    }
  }
  return { players: rank(players, league.minMatches, compareRecord), ledger,
    teams: rank(teams, league.minMatches, (a, b) => close(b.average - a.average) ||
      close((b.direct ?? 0) - (a.direct ?? 0)) || close(b.bbPerMatch - a.bbPerMatch)) };
}

module.exports = { id: 'points', version: 1, aggregate };
