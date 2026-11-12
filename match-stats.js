const { randomUUID } = require('node:crypto');
const E = require('./public/poker-engine');
const AI = require('./poker-ai');
const { readRecords, writeRecord, deleteRecord } = require('./local-store');
const path = require('node:path');

const dimensions = ['luck', 'strategy', 'calculation', 'courage', 'attack', 'stability'];
const empty = () => Object.fromEntries(dimensions.map(key => [key, { total: 0, samples: 0 }]));

function add(metrics, key, value) {
  metrics[key].samples++;
  metrics[key].total += value;
}

function scores(metrics, hands) {
  return Object.fromEntries(dimensions.map(key => {
    const { total, samples } = metrics[key];
    if (hands < 10 || samples < 5) return [key, { score: null, samples }];
    return [key, { score: Math.round(100 * total / samples), samples, observed: key === 'luck' ? null : total }];
  }));
}

function title(values) {
  const high = key => values[key].score !== null && values[key].score >= 70;
  if (high('luck')) return '好运连连';
  if (high('strategy')) return '偷鸡摸狗';
  if (high('courage') && high('calculation')) return '胆大心细';
  if (high('stability')) return '稳健派';
  if (high('attack')) return '主动进攻';
  return null;
}

function seededRandom(seed) {
  let state = seed | 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) | 0;
    return (state >>> 0) / 4294967296;
  };
}

function expectedPots(game, board) {
  const used = new Set([...game.players.flatMap(p => p.holeCards), ...board].map(c => c.suit * 16 + c.rank));
  const available = E.createDeck(game.variant).filter(c => !used.has(c.suit * 16 + c.rank));
  const live = game.players.filter(p => p.isActive && !p.folded);
  const expected = new Map(live.map(p => [p.id, 0]));
  const random = seededRandom(game.handNumber + board.length * 901);
  const trials = board.length === 4 ? available.length : 96;
  for (let trial = 0; trial < trials; trial++) {
    const pool = available.slice(), full = board.slice();
    while (full.length < 5) {
      const index = board.length === 4 ? trial : Math.floor(random() * pool.length);
      full.push(pool[index]);
      pool[index] = pool.at(-1);
      pool.pop();
    }
    const ranks = new Map(live.map(p => [p.id, AI.score([...p.holeCards, ...full], game.variant)]));
    for (const [index, pot] of game.pots.entries()) {
      const eligible = game.potEligibility[index];
      const best = Math.max(...eligible.map(id => ranks.get(id)));
      const winners = eligible.filter(id => ranks.get(id) === best);
      for (const id of winners) expected.set(id, expected.get(id) + pot.amount / winners.length / trials);
    }
  }
  return expected;
}

class MatchStats {
  constructor(root) {
    this.directory = path.join(root, 'matches');
    this.matches = new Map(readRecords(this.directory).map(record => [record.id, record]));
    for (const match of this.matches.values()) {
      if (['waiting', 'running'].includes(match.status)) this.save({ ...match, status: 'interrupted', endedAt: Date.now() });
    }
  }

  save(match) {
    writeRecord(this.directory, match.id, match);
    this.matches.set(match.id, match);
    return match;
  }

  deleteMatches(ids) {
    for (const id of ids) this.matches.delete(id);
    for (const id of ids) deleteRecord(this.directory, id);
  }

  open(room, humans) {
    const match = room.leagueMatch;
    room.statistics = {
      id: match?.id || randomUUID(), startedAt: Date.now(), hands: 0, rules: { ...room.settings },
      players: new Map()
    };
    if (match) this.save({ ...match, status: 'running', startedAt: room.statistics.startedAt,
      participantUids: humans.map(person => person.uid), rules: room.statistics.rules });
  }

  startHand(room, teamForUid = () => null) {
    if (!room.statistics) return;
    const g = room.game;
    const participating = new Set(g.players.filter(p => p.holeCards.length === 2).map(p => p.id));
    for (const seat of participating) {
      const person = room.people.get(seat);
      if (!person?.uid || room.statistics.players.has(seat)) continue;
      room.statistics.players.set(seat, { uid: person.uid, name: person.name, avatar: person.avatar,
        teamId: teamForUid(person.uid) ?? null, hands: 0, metrics: empty() });
    }
    room.statistics.hand = {
      number: g.handNumber, forced: new Map(g.players.map(p => [p.id, p.totalBet])),
      participating,
      voluntary: new Map(), lastPressure: null, lockBoard: null
    };
  }

  beforeAction(room, player, action, automatic) {
    const g = room.game;
    if (automatic || !player || !room.statistics?.players.has(player.id) || !E.betting(g) ||
        g.players[g.currentPlayerIndex] !== player) return null;
    const canRaise = E.canRaise(g, player);
    const need = Math.min(player.chips, Math.max(0, g.currentBet - player.currentBet));
    const aggressive = action === 'raise' || action === 'allin' && player.chips > need;
    let weak = false, correct = null;
    if (g.communityCards.length && (aggressive || need > 0 && ['call', 'fold'].includes(action))) {
      const view = AI.observe(g, player.id, room.history);
      const cap = player.totalBet + need;
      const odds = need / (need + g.players.reduce((sum, other) => sum + Math.min(other.totalBet, cap), 0));
      const estimate = AI.estimateEquity(view, { samples: 64, random: seededRandom(g.revision + 91) }).equity;
      weak = aggressive && estimate < 0.30;
      if (!aggressive && Math.abs(estimate - odds) >= 0.07) correct = (estimate >= odds) === (action === 'call');
    }
    return { canRaise, aggressive, weak, correct, stack: player.chips };
  }

  action(room, seat, decision, paid, raised) {
    const stats = room.statistics, hand = stats?.hand;
    if (!hand) return;
    if (raised) hand.lastPressure = decision?.weak ? seat : null;
    if (!decision) return;
    const { metrics } = stats.players.get(seat);
    add(metrics, 'courage', Number(paid >= decision.stack / 4));
    if (decision.canRaise) add(metrics, 'attack', Number(decision.aggressive));
    if (decision.weak) add(metrics, 'strategy', 0);
    if (decision.correct !== null) add(metrics, 'calculation', Number(decision.correct));
    hand.voluntary.set(seat, (hand.voluntary.get(seat) || 0) + paid);
  }

  lock(room) {
    if (room.statistics?.hand) room.statistics.hand.lockBoard = room.game.communityCards.slice();
  }

  settleHand(room) {
    const stats = room.statistics, g = room.game, hand = stats?.hand;
    if (!hand || hand.number !== g.handNumber || stats.lastHand === hand.number) return;
    const expected = hand.lockBoard && hand.lockBoard.length < 5 && g.showdownOccurred && g.pots.length
      ? expectedPots(g, hand.lockBoard) : null;
    for (const [seat, row] of stats.players) {
      if (!hand.participating.has(seat)) continue;
      const player = g.players.find(p => p.id === seat);
      row.hands++;
      const voluntary = Math.min(hand.voluntary.get(seat) || 0, Math.max(0, player.totalBet - hand.forced.get(seat)));
      add(row.metrics, 'stability', Number(voluntary <= player.chipsBeforeHand / 3));
      if (!g.showdownOccurred && hand.lastPressure === seat && g.winners.includes(seat)) row.metrics.strategy.total++;
      if (expected?.has(seat)) {
        const contested = g.pots.reduce((sum, pot, index) => sum + (g.potEligibility[index].includes(seat) && g.potEligibility[index].length > 1 ? pot.amount : 0), 0);
        const actual = g.pots.reduce((sum, pot) => sum + (pot.awards.find(a => a.seatId === seat)?.amount || 0), 0);
        if (contested) add(row.metrics, 'luck', Math.min(1, Math.max(0, 0.5 + (actual - expected.get(seat)) / (2 * contested))));
      }
    }
    stats.lastHand = hand.number;
    stats.hands++;
  }

  finish(room) {
    const stats = room.statistics;
    if (!stats || room.reportId) return;
    const prior = this.matches.get(stats.id);
    if (prior?.status === 'completed') { room.reportId = stats.id; return; }
    if (prior && prior.status !== 'running') return;
    const game = room.game;
    const standings = E.standings({ ...game, players: game.players.filter(p => stats.players.get(p.id)?.hands) });
    const players = [];
    for (const player of standings) {
      const row = stats.players.get(player.id);
      if (!row?.hands) continue;
      const profit = player.chips - player.bankDebt - player.initialChips;
      const values = scores(row.metrics, row.hands);
      const tied = standings.filter(other => other.place === player.place).length;
      const points = prior?.scoringVersion === 2 ? profit / game.bigBlind :
        100 * (standings.length - player.place - (tied - 1) / 2) / Math.max(1, standings.length - 1);
      players.push({ ...row, profit, bb: profit / game.bigBlind, initial: player.initialChips, chips: player.chips,
        debt: player.bankDebt, place: player.place, points, values, title: title(values) });
    }
    this.save({ ...prior, id: stats.id, status: 'completed', endedAt: Date.now(), startedAt: stats.startedAt,
      rules: stats.rules, hands: stats.hands, players, participantUids: players.map(player => player.uid),
      scoringVersion: prior?.scoringVersion ?? 1 });
    room.reportId = stats.id;
  }
}

module.exports = { MatchStats, dimensions, empty, scores, title };
