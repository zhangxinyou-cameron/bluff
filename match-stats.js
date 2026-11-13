const { randomUUID } = require('node:crypto');
const E = require('./public/poker-engine');
const { clamp, dealtLuck, decisionSnapshot, evaluateDecision } = require('./rating-model');
const { readRecords, writeRecord, deleteRecord } = require('./local-store');
const path = require('node:path');

const dimensions = ['luck', 'strategy', 'calculation', 'courage', 'attack', 'stability'];
const RATING_VERSION = 4;
const tierThresholds = {
  luck: [0.37, 0.46, 0.55, 0.67],
  strategy: [0.33, 0.45, 0.56, 0.73],
  calculation: [0.40, 0.54, 0.68, 0.82],
  courage: [0.05, 0.13, 0.26, 0.56],
  attack: [0.12, 0.21, 0.33, 0.70],
  stability: [0.36, 0.55, 0.75, 0.87]
};
const empty = () => Object.fromEntries(dimensions.map(key => [key, { total: 0, samples: 0 }]));
const mean = metric => metric.samples ? metric.total / metric.samples : 0;

function add(metrics, key, value) {
  metrics[key].samples++;
  metrics[key].total += value;
}

function scores(metrics, hands, version = RATING_VERSION, historicalPrecision = false) {
  return Object.fromEntries(dimensions.map(key => {
    const { total, samples } = metrics[key];
    if (hands < 10 || samples < 5) return [key, { score: null, samples }];
    const continuous = version >= 3 || key === 'luck' || (key === 'courage' && version >= 2);
    const rarity = key === 'luck' ? Math.min(0.25, 0.17 * (metrics[key].rarity || 0) * Math.sqrt(20 / Math.max(20, samples))) : 0;
    const average = version >= 3 ? (total + 3) / (samples + 6) + rarity : mean(metrics[key]);
    const score = version >= 4
      ? Math.min(samples < 12 ? 4 : 5, 1 + tierThresholds[key].filter(threshold => average >= threshold).length)
      : historicalPrecision ? Math.round(10 + 40 * clamp(average)) / 10 : Math.round(1 + 4 * clamp(average));
    return [key, { score, samples, observed: continuous ? null : total }];
  }));
}

function title(values, version = RATING_VERSION) {
  const { luck, strategy, calculation, courage, attack, stability } = values;
  if (version >= 4) {
    const candidates = [
      ['好运连连', { ...luck, score: luck.score === 5 ? 5 : null }], ['偷鸡摸狗', strategy], ['主动进攻', attack],
      ['胆大心细', { score: Math.min(courage.score ?? 0, calculation.score ?? 0), samples: Math.min(courage.samples, calculation.samples) }],
      ['敢打敢拼', courage], ['稳健派', { ...stability, score: calculation.score >= 4 ? stability.score : null }],
      ['精算牌手', { ...calculation, score: calculation.score === 5 ? 5 : null }]
    ];
    return candidates.filter(([, value]) => value.samples >= 12 && value.score >= 4)
      .sort(([, a], [, b]) => b.score - a.score)[0]?.[0] ?? null;
  }
  const candidates = [
    ['好运连连', luck.score, 3.8, luck.samples],
    ['偷鸡摸狗', strategy.score, 3.8, strategy.samples],
    ['胆大心细', Math.min(courage.score ?? 0, calculation.score ?? 0), 3.5, Math.min(courage.samples, calculation.samples)],
    ['稳健派', stability.score, 3.8, stability.samples],
    ['主动进攻', attack.score, 3.8, attack.samples],
    ['精算牌手', calculation.score, 3.8, calculation.samples]
  ];
  if (version < 3) return candidates.slice(0, 5).filter(([, score, minimum]) => score >= minimum).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const ranked = candidates.filter(([name, score, minimum, samples]) => samples >= 12 && score >= minimum &&
    (name !== '稳健派' || (score >= 4 && calculation.score >= 3.5)))
    .sort((a, b) => (b[1] - b[2]) - (a[1] - a[2]));
  return ranked[0]?.[0] ?? null;
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
      players: new Map(), lastLoss: new Map()
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
      number: g.handNumber, participating, observations: new Map(), pressure: null, valueBet: null, valueBets: []
    };
  }

  beforeAction(room, player, automatic, expected) {
    const g = room.game;
    if (automatic || !player || !room.statistics?.players.has(player.id) || !E.betting(g) ||
        g.players[g.currentPlayerIndex] !== player) return null;
    if (expected && (expected.handNumber !== g.handNumber || expected.revision !== g.revision)) return null;
    return decisionSnapshot(g, player, room.history);
  }

  action(room, seat, decision, event) {
    const stats = room.statistics, hand = stats?.hand;
    if (!hand) return;
    const { action, amount: paid, raised, street } = event;
    const valueBet = hand.valueBet;
    if (valueBet?.street === street && valueBet.seat !== seat && valueBet.pending.has(seat)) {
      const baseline = valueBet.pending.get(seat);
      valueBet.pending.delete(seat);
      if (action !== 'fold') valueBet.received += Math.max(0, Math.min(paid, baseline.cover) - baseline.call);
    }
    if (valueBet && (raised || valueBet.street !== street)) hand.valueBet = null;
    if (hand.pressure?.street === street && hand.pressure.seat !== seat && action === 'fold' && !event.automatic) {
      hand.pressure.folds.add(seat);
    }
    if (raised) hand.pressure = null;
    if (!decision) return;
    const result = evaluateDecision(decision, action, paid, raised);
    if (!result) return;
    if (!hand.observations.has(seat)) hand.observations.set(seat, empty());
    const metrics = hand.observations.get(seat);
    const { equity, fair, effective, need, scale, callEV, best, chosen, regret, actualEV, valueTarget } = result;
    const accuracy = Math.exp(-regret / (scale * 0.22));
    const exposure = clamp(Math.min(paid, effective) / Math.max(1, effective));
    const lowEquity = equity < fair * 0.90;
    const meaningful = need >= decision.view.bigBlind / 2 || raised || best.ev > callEV + scale * 0.10;
    if (meaningful) add(metrics, 'calculation', 0.08 + accuracy * 0.88);
    if (lowEquity && meaningful) {
      const pressure = Math.min(paid, effective) / Math.max(2 * decision.view.bigBlind, decision.view.pot + need);
      const risk = Math.max(clamp(exposure * 2.5), clamp(pressure * 0.80));
      add(metrics, 'courage', risk * clamp(1.17 - equity / fair * 0.35) * (raised ? 1 : 0.30));
    }
    if (meaningful) {
      const overplay = Math.max(0, -actualEV) / scale;
      const chasing = stats.lastLoss.get(seat) && exposure >= 0.25 && actualEV < -scale * 0.06;
      const missedCall = action === 'fold' ? Math.max(0, callEV) / scale : 0;
      const looseCall = action !== 'fold' && !raised && need >= scale * 0.12 && lowEquity
        ? Math.max(0, 0.18 - callEV / scale) * 1.3 : 0;
      const isStop = action === 'fold' && callEV < -scale * 0.045;
      const weight = 1 + (need >= scale * 0.12 || exposure >= 0.25 ? 2 : 0);
      const stability = clamp((isStop ? 0.97 : 0.83) - 0.17 * (1 - accuracy) - 1.85 * overplay -
        0.85 * missedCall - looseCall - (chasing ? 0.24 : 0));
      for (let i = 0; i < weight; i++) add(metrics, 'stability', stability);
    }
    if (equity > Math.max(fair + 0.12, fair * 1.35) && valueTarget.extra >= decision.view.bigBlind * 0.5) {
      const sizeFit = chosen ? Math.min(1, (valueTarget.size + scale * 0.20) / chosen.size) : 0;
      const excess = chosen ? Math.max(0, chosen.size - need - valueTarget.size * 1.5) / Math.max(scale, valueTarget.size) : 0;
      const captured = chosen ? clamp(chosen.extra / valueTarget.extra) * accuracy * sizeFit * Math.exp(-excess) : 0;
      add(metrics, 'attack', 0.08 + 0.76 * captured);
      if (chosen && captured > 0) {
        const currentBet = decision.view.players.find(player => player.id === seat).currentBet;
        const pending = new Map(result.opponents.filter(player => player.chips > 0 && !player.allIn).map(player => [player.id, {
          call: Math.max(0, decision.view.currentBet - player.currentBet),
          cover: Math.max(0, chosen.size + currentBet - player.currentBet)
        }]));
        hand.valueBet = { seat, street, pending, received: 0, target: valueTarget.extra, captured };
        hand.valueBets.push(hand.valueBet);
      }
    }
    if (!lowEquity || street === 'pre_flop') return;
    if (chosen && chosen.foldChance > 0.05 && paid - need >= decision.view.bigBlind / 2) {
      const score = clamp(0.28 + 0.42 * accuracy - Math.max(0, -chosen.ev) / scale);
      add(metrics, 'strategy', score);
      hand.pressure = { seat, street, folds: new Set(), opponents: result.opponents.map(player => player.id),
        canProfit: chosen.ev >= -scale * 0.06, bonus: Math.min(1 - score, 0.32 * accuracy * (1 - 0.4 * chosen.foldChance)) };
    } else if (result.bluffOpportunity) {
      add(metrics, 'strategy', 0.29 + 0.18 * accuracy);
    } else if (result.canPressure) {
      add(metrics, 'strategy', 0.5);
    }
  }

  settleHand(room) {
    const stats = room.statistics, g = room.game, hand = stats?.hand;
    if (!hand || hand.number !== g.handNumber || stats.lastHand === hand.number) return;
    const luck = dealtLuck(g);
    for (const bet of hand.valueBets) {
      hand.observations.get(bet.seat).attack.total += 0.16 * bet.captured * clamp(bet.received / bet.target);
    }
    const pressure = hand.pressure;
    if (pressure?.canProfit && !g.showdownOccurred && g.winners.includes(pressure.seat) &&
        pressure.opponents.every(id => pressure.folds.has(id))) {
      hand.observations.get(pressure.seat).strategy.total += pressure.bonus;
    }
    for (const [seat, row] of stats.players) {
      if (!hand.participating.has(seat)) continue;
      const player = g.players.find(p => p.id === seat);
      row.hands++;
      for (const [key, { total, samples }] of Object.entries(hand.observations.get(seat) || {})) {
        if (samples) add(row.metrics, key, total / samples);
      }
      const cards = luck.get(seat);
      if (cards) {
        add(row.metrics, 'luck', cards.value);
        if (cards.rare) row.metrics.luck.rarity = (row.metrics.luck.rarity || 0) + cards.rare;
      }
      const starting = player.chipsBeforeHand;
      stats.lastLoss.set(seat, starting - player.chips >= Math.max(3 * g.bigBlind, starting * 0.15));
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
