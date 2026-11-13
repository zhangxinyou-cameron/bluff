const E = require('./public/poker-engine');
const AI = require('./poker-ai');

const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));
const rankBase = 15 ** 5;

function seededRandom(seed) {
  let state = seed | 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) | 0;
    return (state >>> 0) / 4294967296;
  };
}

function relativeStrength(share, fairShare) {
  return 0.45 * Math.tanh((share - fairShare) / fairShare);
}

function shares(players, board, variant, totals) {
  const ranks = players.map(player => AI.score([...player.holeCards, ...board], variant));
  const best = Math.max(...ranks);
  const tied = ranks.filter(rank => rank === best).length;
  ranks.forEach((rank, index) => { if (rank === best) totals[index] += 1 / tied; });
  return ranks;
}

function dealtLuck(game) {
  const players = game.players.filter(player => player.holeCards.length === 2);
  const results = new Map();
  if (players.length < 2) return results;
  const used = new Set(players.flatMap(player => player.holeCards.map(card => card.id)));
  const available = E.createDeck(game.variant).filter(card => !used.has(card.id));
  const random = seededRandom(game.handNumber * 101 + 41);
  const trials = 128;
  const preflop = players.map(() => 0);
  for (let i = 0; i < trials; i++) {
    const pool = available.slice();
    const board = Array.from({ length: 5 }, () => {
      const index = Math.floor(random() * pool.length), card = pool[index];
      pool[index] = pool.at(-1);
      pool.pop();
      return card;
    });
    shares(players, board, game.variant, preflop);
  }

  // Rate only the public boards actually dealt, including for players who folded.
  const boards = (game.runoutBoards || [game.communityCards]).filter(board => board.length >= 3);
  const final = players.map(() => 0), rare = players.map(() => 0);
  const fair = 1 / players.length;
  const categories = game.variant === 'short'
    ? [0, 0.05, 0.20, 0.41, 0.55, 0.63, 0.78, 0.91, 0.98, 1, 1]
    : [0, 0.08, 0.29, 0.53, 0.70, 0.80, 0.87, 0.94, 0.99, 1, 1];
  const ordinary = game.variant === 'short' ? { 3: 0.21, 4: 0.30, 5: 0.39 } : { 3: 0.21, 4: 0.29, 5: 0.38 };
  for (const board of boards) {
    const winners = players.map(() => 0);
    const ranks = shares(players, board, game.variant, winners);
    const boardRank = board.length === 5 ? AI.score(board, game.variant) : 0;
    ranks.forEach((rank, index) => {
      const category = Math.floor(rank / rankBase);
      const boardCategory = Math.floor(boardRank / rankBase);
      const added = category === boardCategory ? 0.35 : 1;
      const quality = clamp(0.5 + (categories[category] - ordinary[board.length]) * added);
      final[index] += category === 10 && rank > boardRank ? 1 : 0.70 * quality + 0.30 * (0.5 + relativeStrength(winners[index], fair));
      if (rank > boardRank && category >= 8) rare[index] = Math.max(rare[index], [0.25, 0.6, 1][category - 8]);
    });
  }
  const openings = preflop.map(won => relativeStrength(won / trials, fair));
  const meanOpening = openings.reduce((sum, value) => sum + value, 0) / openings.length;
  players.forEach((player, index) => {
    const opening = clamp(0.5 + openings[index] - meanOpening);
    const value = boards.length ? 0.50 * opening + 0.50 * final[index] / boards.length : opening;
    results.set(player.id, { value, rare: rare[index] });
  });
  return results;
}

function decisionSnapshot(game, player, history) {
  const view = AI.observe(game, player.id, history);
  return {
    view,
    seed: game.handNumber * 997 + game.revision * 91,
    minimum: E.minimumRaiseTo(game)
  };
}

function callFrequency(opponent, amount, view) {
  if (amount <= 0) return 1;
  if (opponent.allIn || opponent.disconnected || opponent.chips <= 0) return 0;
  const price = Math.min(opponent.chips, amount);
  const history = view.actions.filter(action => action.seatId === opponent.id && action.facedBet && !action.automatic);
  const continued = history.filter(action => action.action !== 'fold').length;
  const tendency = (continued + 3) / (history.length + 6) - 0.5;
  const potOdds = price / Math.max(1, view.pot + price);
  const stackPressure = price / opponent.chips;
  return clamp(0.86 - 1.18 * potOdds - 0.21 * stackPressure + 0.55 * tendency, 0.08, 0.88);
}

function raiseModel(view, hero, opponents, equity, total) {
  const raisedTo = hero.currentBet + total;
  const cap = hero.totalBet + total;
  const dead = view.players.filter(player => player !== hero && !opponents.includes(player)).map(player => player.totalBet);
  const choices = opponents.map(player => {
    const price = Math.max(0, raisedTo - player.currentBet);
    const committed = player.allIn || player.chips === 0;
    return {
      base: player.totalBet,
      paid: committed ? 0 : Math.min(player.chips, price),
      chance: committed ? 1 : callFrequency(player, price, view),
      baseline: Math.max(0, Math.min(player.chips, view.currentBet - player.currentBet)),
      committed
    };
  });
  let ev = 0, extra = 0, foldChance = 0;
  // Each subset of callers has a separate pot, uncalled refund and equity.
  for (let mask = 0; mask < (1 << choices.length); mask++) {
    let weight = 1;
    const live = [], dropped = [];
    for (const [index, choice] of choices.entries()) {
      if (mask & (1 << index)) {
        weight *= choice.chance;
        live.push(choice);
      } else {
        weight *= 1 - choice.chance;
        dropped.push(choice.base);
      }
      if (weight === 0) break;
    }
    if (weight === 0) continue;
    if (live.length === 0) {
      foldChance += weight;
      ev += weight * view.pot;
      continue;
    }
    const contributors = live.map(choice => Math.min(cap, choice.base + choice.paid));
    const folded = [...dropped, ...dead];
    const matched = Math.min(cap, Math.max(hero.totalBet, ...contributors, ...folded));
    const limits = [...new Set([...contributors, matched].filter(level => level > 0 && level <= matched))].sort((a, b) => a - b);
    let previous = 0, payout = 0;
    for (const level of limits) {
      const eligible = contributors.filter(chips => chips >= level).length;
      const layer = level - previous + [...contributors, ...folded]
        .reduce((sum, chips) => sum + Math.max(0, Math.min(chips, level) - previous), 0);
      // Approximate equity against fewer callers and stronger continuing ranges.
      const share = eligible ? equity ** (eligible / opponents.length) : 1;
      const narrowed = live.some(choice => !choice.committed) ? share - 0.48 * share * (1 - share) * (1 - Math.min(...live.map(choice => choice.chance))) : share;
      payout += layer * narrowed;
      previous = level;
    }
    ev += weight * (payout - (matched - hero.totalBet));
    extra += weight * live.reduce((sum, choice) => sum + Math.max(0, Math.min(matched - choice.base, choice.paid) - choice.baseline), 0);
  }
  return { ev, extra, foldChance };
}

function callExpectation(view, hero, opponents, equity, need) {
  const cap = hero.totalBet + need;
  const opponentsPaid = opponents.map(player => Math.min(cap, player.totalBet));
  const coverage = opponents.map(player => Math.min(cap, player.totalBet + player.chips));
  const levels = [...new Set([...opponentsPaid, cap])].sort((a, b) => a - b);
  let previous = 0, payout = 0;
  for (const level of levels) {
    const rivals = coverage.filter(chips => chips >= level).length;
    const layer = level - previous + view.players.filter(player => player !== hero)
      .reduce((sum, player) => sum + Math.max(0, Math.min(player.totalBet, level) - previous), 0);
    payout += layer * (rivals ? equity ** (rivals / opponents.length) : 1);
    previous = level;
  }
  return payout - need;
}

function evaluateDecision({ view, minimum, seed }, action, paid, raised) {
  const hero = view.players.find(player => player.id === view.seatId);
  const opponents = view.players.filter(player => player !== hero && player.isActive && !player.folded);
  if (!opponents.length) return null;
  const need = Math.min(hero.chips, Math.max(0, view.currentBet - hero.currentBet));
  const effective = Math.min(hero.chips, Math.max(0, ...opponents.map(player => player.chips + player.currentBet - hero.currentBet)));
  const canRaise = view.canRaise && effective > need && hero.chips > need;
  if (!need && !canRaise) return null;

  const { equity } = AI.estimateEquity(view, { samples: 96, exactRiver: false, allOpponents: true, random: seededRandom(seed) });
  const cap = hero.totalBet + need;
  const contestable = need + view.players.reduce((sum, player) => sum + Math.min(player.totalBet, cap), 0);
  const scale = Math.max(2 * view.bigBlind, contestable, effective * 0.12);
  const callEV = callExpectation(view, hero, opponents, equity, need);
  const floor = Math.min(hero.chips, minimum - hero.currentBet);
  const maxMatched = Math.max(floor, effective);
  const sizes = canRaise ? [...new Set([
    floor, ...[0.5, 1, 1.5].map(fraction => Math.max(floor, Math.min(maxMatched, need + Math.round(contestable * fraction)))),
    maxMatched, ...(raised ? [Math.min(maxMatched, paid)] : [])
  ])].filter(size => size > need) : [];
  const models = sizes.map(size => ({ size, ...raiseModel(view, hero, opponents, equity, size) }));
  const best = models.reduce((better, model) => model.ev > better.ev ? model : better, { ev: Math.max(0, callEV), extra: 0, size: need });
  const chosen = raised ? models.find(model => model.size === Math.min(maxMatched, paid)) : null;
  const actualEV = action === 'fold' ? 0 : (chosen?.ev ?? callEV);
  return { equity, fair: 1 / (opponents.length + 1), effective, need, scale, callEV, best, chosen,
    regret: Math.max(0, best.ev - actualEV - scale * 0.06), actualEV, opponents,
    canPressure: models.some(model => model.foldChance > 0.05),
    bluffOpportunity: models.some(model => model.foldChance > 0.10 && model.ev > Math.max(0, callEV) + scale * 0.08),
    valueTarget: Math.max(0, ...models.filter(model => model.ev >= best.ev - scale * 0.08).map(model => model.extra)) };
}

module.exports = { clamp, dealtLuck, decisionSnapshot, evaluateDecision };
