const { randomUUID } = require('node:crypto');
const E = require('./public/poker-engine');
const AI = require('./poker-ai');
const { readRecords, writeRecord, deleteRecord } = require('./local-store');
const path = require('node:path');

const dimensions = ['luck', 'strategy', 'calculation', 'courage', 'attack', 'stability'];
const RATING_VERSION = 2;
const empty = () => Object.fromEntries(dimensions.map(key => [key, { total: 0, samples: 0 }]));
const clamp = value => Math.max(0, Math.min(1, value));

function add(metrics, key, value) {
  metrics[key].samples++;
  metrics[key].total += value;
}

function scores(metrics, hands, version = RATING_VERSION) {
  return Object.fromEntries(dimensions.map(key => {
    const { total, samples } = metrics[key];
    if (hands < 10 || samples < 5) return [key, { score: null, samples }];
    const continuous = key === 'luck' || (key === 'courage' && version >= RATING_VERSION);
    const score = Math.round(10 + 40 * clamp(total / samples)) / 10;
    return [key, { score, samples, observed: continuous ? null : total }];
  }));
}

function title(values) {
  const { luck, strategy, calculation, courage, attack, stability } = values;
  const candidates = [
    ['好运连连', luck.score, 3.8],
    ['偷鸡摸狗', strategy.score, 3.8],
    ['胆大心细', Math.min(courage.score ?? 0, calculation.score ?? 0), 3.5],
    ['稳健派', stability.score, 3.8],
    ['主动进攻', attack.score, 3.8]
  ];
  return candidates.filter(([, score, minimum]) => score >= minimum).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
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
    this.revision = 0;
    for (const match of this.matches.values()) {
      if (['waiting', 'running'].includes(match.status)) this.save({ ...match, status: 'interrupted', endedAt: Date.now() });
    }
  }

  save(match) {
    writeRecord(this.directory, match.id, match);
    this.matches.set(match.id, match);
    this.revision++;
    return match;
  }

  deleteMatches(ids) {
    this.revision++;
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
        teamId: teamForUid(person.uid) ?? null, hands: 0, knockouts: 0, metrics: empty() });
    }
    room.statistics.hand = {
      number: g.handNumber, participating, courage: new Map(), lastPressure: null, lockBoard: null
    };
  }

  beforeAction(room, player, action, amount, automatic, expected) {
    const g = room.game;
    if (automatic || !player || !room.statistics?.players.has(player.id) || !E.betting(g) ||
        g.players[g.currentPlayerIndex] !== player) return null;
    if (expected && (expected.handNumber !== g.handNumber || expected.revision !== g.revision)) return null;
    const need = Math.min(player.chips, Math.max(0, g.currentBet - player.currentBet));
    const opponents = g.players.filter(other => other !== player && other.isActive && !other.folded);
    const canRaise = player.chips > need && E.canRaise(g, player);
    const cap = player.totalBet + need;
    const contestable = g.players.reduce((sum, other) => sum + Math.min(other.totalBet, cap), 0) + need;
    const effective = Math.min(player.chips, Math.max(0, ...opponents.map(other => other.chips + other.currentBet - player.currentBet)));
    const sizing = action === 'allin' ? player.chips : action === 'raise' ? amount - player.currentBet : 0;
    const bluff = g.communityCards.length >= 3 && canRaise && opponents.length <= 2 &&
      opponents.every(other => !other.allIn) && Math.min(sizing, effective) - need >= Math.max(g.bigBlind, contestable / 4);
    const priced = g.communityCards.length >= 3 && need > 0 &&
      (['call', 'fold'].includes(action) || action === 'allin' && sizing === need);
    return { canRaise, effective, need, potOdds: need / Math.max(1, contestable), priceMatters: need >= Math.max(g.bigBlind, player.chips / 10),
      bluff, priced, view: bluff || priced ? AI.observe(g, player.id, room.history) : null, seed: g.revision + 91 };
  }

  action(room, seat, decision, action, paid, raised) {
    const stats = room.statistics, hand = stats?.hand;
    if (!hand) return;
    if (raised) hand.lastPressure = null;
    if (!decision) return;
    const { metrics } = stats.players.get(seat);
    if (decision.effective > 0) {
      const risk = clamp(Math.min(paid, decision.effective) / decision.effective * 2);
      hand.courage.set(seat, Math.max(hand.courage.get(seat) ?? 0, risk));
    }
    if (decision.canRaise) add(metrics, 'attack', Number(raised));
    if (!decision.view) return;
    const { equity } = AI.estimateEquity(decision.view, { samples: 96, exactRiver: false, random: seededRandom(decision.seed) });
    if (raised && decision.bluff && equity < 0.65 / decision.view.players.filter(player => player.isActive && !player.folded).length) {
      add(metrics, 'strategy', 0);
      hand.lastPressure = seat;
    }
    const edge = equity - decision.potOdds;
    if (decision.priced && Math.abs(edge) >= 0.10) {
      add(metrics, 'calculation', Number((edge > 0) === (action !== 'fold')));
      if (decision.priceMatters && edge < 0) add(metrics, 'stability', Number(action === 'fold'));
    }
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
      if (hand.courage.has(seat)) add(row.metrics, 'courage', hand.courage.get(seat));
      if (!g.showdownOccurred && hand.lastPressure === seat && g.winners.includes(seat)) row.metrics.strategy.total++;
      if (expected?.has(seat)) {
        const contested = g.pots.reduce((sum, pot, index) => sum + (g.potEligibility[index].includes(seat) && g.potEligibility[index].length > 1 ? pot.amount : 0), 0);
        const actual = g.pots.reduce((sum, pot, index) => sum + (g.potEligibility[index].length > 1 ?
          (pot.awards.find(a => a.seatId === seat)?.amount || 0) : 0), 0);
        if (contested) add(row.metrics, 'luck', clamp(0.5 + (actual - expected.get(seat)) / (2 * contested)));
      }
      if (!g.allowBuyIn && player.eliminatedHand === hand.number) {
        const potIndex = g.potEligibility.findLastIndex(seats => seats.includes(seat));
        const winners = g.pots[potIndex]?.winners;
        if (winners?.length === 1) {
          const winner = stats.players.get(winners[0]);
          if (winner) winner.knockouts++;
        }
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
      scoringVersion: prior?.scoringVersion ?? 1, ratingVersion: RATING_VERSION });
    room.reportId = stats.id;
  }
}

module.exports = { MatchStats, RATING_VERSION, dimensions, empty, scores, title };
