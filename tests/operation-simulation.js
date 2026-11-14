const assert = require('node:assert/strict');
const E = require('../public/poker-engine');
const AI = require('../poker-ai');
const { MatchStats, scores, operationEstimates } = require('../match-stats');
const { operationIndex, operationRating } = require('../operation-rating');

const rng = initial => {
  let seed = initial;
  return () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
};
const pass = need => ({ action: need ? 'call' : 'check' });
const fold = { action: 'fold' };
const tiers = ['新手', '进阶', '概率', '顶级'];
const seatTiers = [0, 1, 1, 2, 2, 3];

// This policy uses its own bet-size and opponent response model. Its input is
// the same public table information and own cards available to the other bots.
function expert(view, random) {
  const analysis = AI.analyze(view, { samples: 512, random, allOpponents: view.phase !== 'pre_flop' });
  const { me, equity, opponents, foldable, call, need, contestable, effective } = analysis;
  const pot = Math.max(view.bigBlind, contestable + call);
  const callEV = equity * pot - call;
  let best = callEV >= 0 || !need ? pass(need) : fold;
  let bestEV = Math.max(0, callEV);
  if (!view.canRaise || !foldable.length || effective <= need) return best;
  if (view.phase === 'pre_flop' && equity < Math.max(.50, 1 / (analysis.modeledOpponents + 1) + .06)) return best;

  const min = view.currentBet + view.minRaise - me.currentBet;
  const maximum = Math.min(me.chips, effective);
  const sizes = [...new Set([min, ...[.35, .60, 1, 1.5].map(fraction =>
    Math.max(min, Math.min(maximum, call + Math.round(pot * fraction))))])];
  for (const paid of sizes) {
    if (paid > maximum) continue;
    let expectedCalls = 0, whenCalled = 0, allFold = 1;
    for (const opponent of opponents) {
      const price = Math.min(opponent.chips, Math.max(0, paid + me.currentBet - opponent.currentBet));
      const decisions = view.actions.filter(action => action.seatId === opponent.id && action.facedBet && !action.automatic);
      const folds = decisions.filter(action => action.action === 'fold').length;
      const priorFold = (folds + 2) / (decisions.length + 7);
      const pressure = price / (pot + price);
      const foldProbability = opponent.allIn ? 0 : Math.max(.03, Math.min(.87, priorFold + .65 * (pressure - .25)));
      expectedCalls += (1 - foldProbability) * price;
      whenCalled += 1 - foldProbability;
      allFold *= foldProbability;
    }
    const called = 1 - allFold;
    const share = equity ** Math.min(1, whenCalled / (called * Math.max(1, analysis.modeledOpponents)));
    const conditional = share * (1 - .24 * (1 - share) * Math.min(1, paid / pot));
    const raiseEV = allFold * view.pot + conditional * (called * (view.pot + paid) + expectedCalls) - called * paid;
    const risk = Math.max(0, paid - call) * (.05 + .10 * (1 - equity));
    if (raiseEV - risk > bestEV + .02 * pot) {
      bestEV = raiseEV - risk;
      best = { action: paid === me.chips ? 'allin' : 'raise', amount: paid + me.currentBet };
    }
  }
  return best;
}

function choose(view, tier, random) {
  if (tier === 3) return expert(view, random);
  if (tier === 2) return AI.decide(view, { random });
  const me = view.players.find(p => p.id === view.seatId);
  const need = view.currentBet - me.currentBet;
  const minimum = view.currentBet + view.minRaise;
  const strength = AI.startingStrength(view.hole, view.variant);
  const category = view.board.length ? Math.floor(AI.score([...view.hole, ...view.board], view.variant) / (15 ** 5)) : 0;
  const good = view.board.length ? category >= 3 : strength >= .73;
  const raise = size => view.canRaise && me.chips + me.currentBet >= minimum ?
    { action: 'raise', amount: Math.min(me.chips + me.currentBet, Math.max(minimum, size)) } : pass(need);
  if (tier === 0) {
    if (good && random() < .2) return raise(minimum);
    if (need > me.chips * .65 && !good && random() < .55) return fold;
    return pass(need);
  }
  if (good && need <= view.pot / 2 && random() < .75) return raise(view.currentBet + Math.round(view.pot / 2));
  if (need && !good) {
    const playable = view.board.length ? category >= 2 || AI.drawInfo(view).outs >= 4 : strength >= .54;
    if (need > Math.min(view.pot * .55, me.chips * .35) || (!playable && need > view.bigBlind)) return fold;
  }
  return pass(need);
}

const rows = [];
const holdout = process.argv.includes('--holdout');
for (const deckMode of ['standard', 'short']) for (let match = 0; match < 6; match++) {
  const shift = holdout ? 43117 : 0;
  const deal = rng(910 + shift + match * 197 + (deckMode === 'short' ? 7207 : 0));
  const decisions = seatTiers.map((_, seat) => rng(717 + shift * 7 + match * 903 + seat * 101));
  const stats = Object.create(MatchStats.prototype);
  const game = E.createGame(Array.from({ length: 6 }, (_, id) => ({ id, chips: 2000 })), 20,
    { allowBuyIn: true, deckMode, blindMode: 'standard' });
  const room = { game, settings: {}, history: [], people: new Map(game.players.map(p => [p.id, { uid: String(p.id) }])) };
  stats.open(room);
  const tierFor = id => seatTiers[(id + match) % seatTiers.length];
  for (let hand = 0; hand < 80; hand++) {
    for (const player of game.players) {
      if (player.chips < 1000) assert.ok(E.bankTransaction(game, player.id, 'borrow', 2000 - player.chips,
        { handNumber: game.handNumber, bankVersion: player.bankVersion, requestId: `buy-in-${hand}` }).ok);
      if (hand) assert.ok(E.confirmNextHand(game, player.id, game.handNumber));
    }
    assert.ok(E.startHand(game, deal));
    stats.startHand(room);
    let steps = 0;
    while (E.betting(game) || game.phase === 'runout_vote') {
      if (game.phase === 'runout_vote') { assert.ok(E.resolveRunout(game, false)); continue; }
      assert.ok(++steps < 160, 'stalled hand');
      const player = game.players[game.currentPlayerIndex];
      const decision = stats.beforeAction(room, player, false);
      const { action, amount } = choose(decision.view, tierFor(player.id), decisions[player.id]);
      const { chips, currentBet } = player, street = game.phase, tableBet = game.currentBet;
      const result = E.applyAction(game, player.id, action, amount);
      assert.ok(result.ok, JSON.stringify({ action, amount, result }));
      const paid = chips - player.chips;
      // ApplyAction may already have paid winnings/refunds; use the submitted amount.
      const committed = action === 'raise' ? amount - currentBet : action === 'allin' ? chips :
        action === 'call' ? Math.min(chips, tableBet - currentBet) : 0;
      if (game.phase === street) assert.equal(paid, committed);
      const event = { kind: 'action', seatId: player.id, hand: game.handNumber, street, action, amount: committed,
        raised: currentBet + committed > tableBet, facedBet: tableBet > currentBet };
      stats.action(room, player.id, decision, event);
      room.history.push(event);
    }
    assert.equal(game.phase, 'hand_over');
    stats.settleHand(room);
    assert.equal(game.players.reduce((sum, p) => sum + p.chips - p.bankDebt, 0), 12000);
  }
  for (const player of game.players) {
    const data = room.statistics.players.get(player.id);
    const values = scores(data.metrics, data.hands);
    const estimates = operationEstimates(data.metrics, values);
    const { raw } = operationIndex(estimates);
    const rating = operationRating(values, estimates);
    assert.ok(rating, '80 hands should produce enough scoring samples');
    rows.push({ deckMode, match, tier: tiers[tierFor(player.id)], ...rating, luck: values.luck.score,
      bb: (player.chips - player.bankDebt - player.initialChips) / 20,
      raw, tiers: Object.values(values).map(value => value.score) });
  }
}

function average(rows, field) { return +(rows.reduce((sum, row) => sum + row[field], 0) / rows.length).toFixed(2); }
for (const deck of ['standard', 'short', 'both']) {
  const byDeck = rows.filter(row => deck === 'both' || row.deckMode === deck);
  const result = tiers.map(tier => {
    const sample = byDeck.filter(row => row.tier === tier);
    return { deck, tier, cases: sample.length, avgRating: average(sample, 'score'), min: Math.min(...sample.map(row => row.score)),
      max: Math.max(...sample.map(row => row.score)), avgLuck: average(sample, 'luck'), avgBB: average(sample, 'bb') };
  });
  console.table(result);
  assert.ok(result.every((row, index) => index === 0 || row.avgRating > result[index - 1].avgRating), 'Rating separates strategies in ' + deck);
}
const ordered = rows.map(row => row.score).sort((a, b) => a - b);
const median = (ordered[ordered.length / 2 - 1] + ordered[ordered.length / 2]) / 2;
const summary = { mean: average(rows, 'score'), median, min: ordered[0], max: ordered.at(-1),
  expertAbove9: rows.filter(row => row.tier === tiers[3] && row.score > 9).length,
  bands: [0, 6, 7, 8, 9, 10].map((low, index, limits) => ordered.filter(score => score >= low && (index === 5 || score < limits[index + 1])).length) };
assert.ok(summary.mean >= 7.6 && summary.mean <= 8.4, 'Mixed table rating should center around 8');
assert.ok(summary.expertAbove9 >= 6, 'At least half of the expert results should exceed 9.0');
assert.ok(summary.bands[2] + summary.bands[3] > ordered.length / 2, 'Middle bands should contain the most scores');
if (!holdout) assert.deepEqual([summary.min, summary.max], [0, 10], 'Calibration covers both endpoints');
console.log(summary);
console.log('960 hands, 12 seeded matches with rotating seats, ' + (holdout ? 'holdout' : 'calibration'));
if (process.argv.includes('--raw')) console.log(JSON.stringify(rows));
