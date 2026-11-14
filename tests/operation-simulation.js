const assert = require('node:assert/strict');
const E = require('../public/poker-engine');
const AI = require('../poker-ai');
const { MatchStats, scores } = require('../match-stats');
const { operationRating } = require('../operation-rating');

const rng = initial => {
  let seed = initial;
  return () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
};
const pass = need => ({ action: need ? 'call' : 'check' });
const fold = { action: 'fold' };
const tiers = ['新手', '进阶', '概率'];

function choose(view, tier, random) {
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
for (const deckMode of ['standard', 'short']) for (let match = 0; match < 6; match++) {
  const deal = rng(910 + match * 197), decide = rng(717 + match * 903);
  const stats = Object.create(MatchStats.prototype);
  const game = E.createGame(Array.from({ length: 6 }, (_, id) => ({ id, chips: 2000 })), 20,
    { allowBuyIn: true, deckMode, blindMode: 'standard' });
  const room = { game, settings: {}, history: [], people: new Map(game.players.map(p => [p.id, { uid: String(p.id) }])) };
  stats.open(room);
  const tierFor = id => Math.floor(((id + match) % 6) / 2);
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
      const { action, amount } = choose(decision.view, tierFor(player.id), decide);
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
    const rating = operationRating(values);
    assert.ok(rating, '80 hands should produce enough scoring samples');
    rows.push({ deckMode, match, tier: tiers[tierFor(player.id)], ...rating, luck: values.luck.score,
      bb: (player.chips - player.bankDebt - player.initialChips) / 20 });
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
  assert.ok(result[2].avgRating > result[1].avgRating && result[1].avgRating > result[0].avgRating,
    'Average operation rating should separate the three strategies in ' + deck);
}
console.log('960 hands, 12 seeded matches with rotating seats. Downside bonus cases:');
console.table(rows.filter(row => row.bonus));
