const assert = require('node:assert/strict');
const test = require('node:test');
const { aggregate } = require('../league-points');
const { MatchStats, empty, scores, title } = require('../match-stats');
const { dealtLuck, evaluateDecision } = require('../rating-model');
const E = require('../public/poker-engine');

const cards = text => text.split(' ').map(card => {
  const rank = { T: 10, J: 11, Q: 12, K: 13, A: 14 }[card[0]] || Number(card[0]);
  const suit = { s: 0, h: 1, c: 2, d: 3 }[card[1]];
  return { rank, suit, id: suit * 13 + rank - 2 };
});

function match(id, bigBlind, rows, overrides = {}) {
  return {
    id, status: 'completed', hands: 10,
    players: rows.map(([uid, teamId, profit, points, hands = 10]) => ({
      uid, teamId, profit, points, hands, bb: profit / bigBlind, name: uid, metrics: empty()
    })), ...overrides
  };
}

test('four-team scores, debt-normalized BB, equal weight by appearance and leader qualifications', () => {
  const league = { minHands: 5, minMatches: 2, teams: ['A', 'B', 'C', 'D'].map(id => ({ id, name: id })) };
  const rows = [
    match('1', 20, [['a', 'A', 200, 100], ['b', 'B', 0, 50], ['c', 'C', 0, 50], ['d', 'D', -200, 0]]),
    match('2', 50, [['a', 'A', -100, 0], ['b', 'B', 100, 100]]),
    match('3', 20, [['c', 'C', 200, 100], ['a', 'A', -200, 0]], { voidReason: '测试作废' }),
    match('4', 20, [['c', 'C', 200, 100], ['a', 'A', -200, 0]], { hands: 4 })
  ];
  const { teams, players, ledger } = aggregate(league, rows);
  assert.deepEqual(ledger[0].teams.map(team => team.points), [3, 4 / 3, 4 / 3, 0]);
  assert.deepEqual(teams.slice(0, 2).map(team => [team.id, team.place]), [['B', 1], ['A', 2]]);
  assert.equal(teams.find(team => team.id === 'C').place, undefined);
  assert.deepEqual(teams.find(team => team.id === 'A').headToHead.B, { matches: 2, points: 3 });
  assert.deepEqual(players.slice(0, 2).map(player => [player.uid, player.average, player.bb]), [['b', 75, 2], ['a', 50, 8]]);
  assert.equal(players.find(player => player.uid === 'a').bb100, 40);
  assert.equal(teams.find(team => team.id === 'A').mvp[0].uid, 'a');
  assert.deepEqual(teams.find(team => team.id === 'C').mvp, []);
});

test('six-dimensional results require enough hands and valid samples and can be combined by opportunity', () => {
  const metrics = empty();
  metrics.courage = { total: 4, samples: 5 };
  metrics.calculation = { total: 8, samples: 10 };
  metrics.luck = { total: 4, samples: 4 };
  assert.equal(scores(metrics, 9).courage.score, null);
  const result = scores(metrics, 10);
  assert.equal(result.luck.score, null);
  assert.equal(result.courage.score, 4);
  assert.equal(title(result), null);
  assert.equal(title(scores(metrics, 10, 2, true), 2), '胆大心细');
  const league = { minHands: 1, minMatches: 1, teams: [] };
  const first = match('1', 20, [['a', null, 0, 50]]);
  const second = match('2', 20, [['a', null, 0, 50]]);
  first.players[0].metrics.calculation = { total: 5, samples: 5 };
  second.players[0].metrics.calculation = { total: 5, samples: 15 };
  const { players } = aggregate(league, [first, second]);
  assert.deepEqual(players[0].values.calculation, { score: 3, samples: 20, observed: 10 });
});

test('rating maps 0, neutral and 1 to 1, 3 and 5, and separates historical observations from new ones', () => {
  const league = { minHands: 1, minMatches: 1, teams: [] };
  const first = match('1', 20, [['a', null, 20, 0]]);
  const second = match('2', 20, [['a', null, -20, 0]], { ratingVersion: 3 });
  first.players[0].metrics.stability = { total: 5, samples: 5 };
  second.players[0].metrics.stability = { total: 0, samples: 5 };
  second.players[0].metrics.courage = { total: 2.5, samples: 5 };
  assert.equal(aggregate(league, [first], true).players[0].values.stability.score, 5);
  const player = aggregate(league, [first, second], true).players[0];
  assert.equal(player.values.stability.score, 2);
  assert.deepEqual(player.values.courage, { score: 3, samples: 5, observed: null });
  assert.equal(player.ratingVersion, 3);
  assert.equal(player.matches, 2);
  assert.equal(player.points, 0);
});

test('each dimension can reach tier five with sustained performance, capped with fewer than twelve samples', () => {
  const metrics = empty();
  for (const metric of Object.values(metrics)) Object.assign(metric, { total: 24, samples: 24 });
  assert.ok(Object.values(scores(metrics, 24)).every(value => value.score === 5));
  for (const metric of Object.values(metrics)) Object.assign(metric, { total: 11, samples: 11 });
  assert.ok(Object.values(scores(metrics, 24)).every(value => Number.isInteger(value.score) && value.score < 5));
  for (const metric of Object.values(metrics)) Object.assign(metric, { total: 0, samples: 24 });
  assert.ok(Object.values(scores(metrics, 24)).every(value => Number.isInteger(value.score) && value.score >= 1));
});

test('folded royal counts as dealt luck, while a shared board royal earns no rarity bonus', () => {
  const game = E.createGame([0, 1, 2].map(id => ({ id, chips: 1000 })), 20);
  Object.assign(game, { dealerIndex: 0, handNumber: 1, phase: 'river', communityCards: cards('Ts Js Qs 2h 3d') });
  ['As Ks', 'Ad Ah', '6c 2d'].forEach((hole, id) => Object.assign(game.players[id], {
    holeCards: cards(hole), isActive: true, chipsBeforeHand: 1000, folded: id === 0, totalBet: id ? 20 : 0
  }));
  const stats = Object.create(MatchStats.prototype);
  const room = { game, settings: {}, people: new Map(game.players.map(p => [p.id, { uid: 'player-' + p.id }])) };
  stats.open(room);
  stats.startHand(room);
  const normal = dealtLuck(game);
  assert.ok(normal.get(0).value > normal.get(2).value);
  assert.equal(normal.get(0).rare, 1);
  game.pot = 40;
  E.settle(game, true);
  stats.settleHand(room);
  stats.settleHand(room);
  const row = room.statistics.players.get(0);
  assert.equal(row.metrics.luck.samples, 1);
  assert.equal(row.metrics.luck.rarity, 1);
  assert.equal(game.winners.includes(0), false);
  game.players[0].holeCards = cards('4c 5h');
  game.communityCards = cards('Ts Js Qs Ks As');
  assert.ok([...dealtLuck(game).values()].every(result => result.rare === 0));
  game.communityCards = [];
  const preflop = dealtLuck(game);
  assert.ok(preflop.get(1).value > preflop.get(0).value);
  assert.ok(Math.abs([...preflop.values()].reduce((sum, result) => sum + result.value, 0) / 3 - 0.5) < 1e-9);
  game.runoutBoards = [cards('Ts Js Qs 2h 3d'), cards('5h 5s 7c Jd 8c')];
  game.players[0].holeCards = cards('As Ks');
  assert.equal(dealtLuck(game).get(0).rare, 1);
});

test('decision model separates calculated restraint, low-equity courage and strong-hand value', () => {
  const stats = Object.create(MatchStats.prototype);
  const view = {
    seatId: 0, phase: 'river', variant: 'standard', actions: [], canRaise: true, bigBlind: 20,
    hole: cards('2h 3c'), board: cards('As Ks Qs Js 9d'), currentBet: 80, pot: 120,
    players: [{ id: 0, isActive: true, chips: 300, currentBet: 0, totalBet: 20 },
      { id: 1, isActive: true, chips: 220, currentBet: 80, totalBet: 100 }]
  };
  const decision = { view, seed: 123, minimum: 160 };
  function observe(action, amount, raised, snapshot = decision, priorLoss = false) {
    const hand = { observations: new Map(), valueBets: [] };
    const room = { statistics: { hand, lastLoss: new Map([[0, priorLoss]]) } };
    stats.action(room, 0, snapshot, { action, amount, raised, street: 'river' });
    return hand.observations.get(0);
  }
  const fold = observe('fold', 0, false);
  const call = observe('call', 80, false);
  assert.ok(fold.calculation.total > call.calculation.total);
  assert.ok(fold.stability.total / fold.stability.samples > call.stability.total / call.stability.samples);
  assert.ok(call.courage.total > fold.courage.total);
  assert.equal(call.attack.samples, 0);
  const strong = { ...decision, view: { ...view, hole: cards('Ts 3c') } };
  const model = evaluateDecision(strong, 'call', 80, false);
  assert.ok(model.best.size > 80);
  assert.ok(observe('raise', model.best.size, true, strong).attack.total > observe('call', 80, false, strong).attack.total);
  assert.equal(observe('raise', model.best.size, true, strong).courage.samples, 0);
  const shove = observe('allin', 300, true);
  const chase = observe('allin', 300, true, decision, true);
  assert.ok(chase.stability.total <= shove.stability.total);
  assert.equal(shove.strategy.samples, 1);
});

test('rare hands visibly lift the rating and five good folds cannot confer a steady title', () => {
  const metrics = empty();
  metrics.luck = { samples: 16, total: 8 };
  metrics.stability = { samples: 5, total: 5 };
  const baseline = scores(metrics, 16);
  metrics.luck.rarity = 1;
  const royal = scores(metrics, 16);
  assert.ok(royal.luck.score > baseline.luck.score);
  assert.equal(title(baseline), null);
  delete metrics.luck.rarity;
  metrics.stability = { samples: 16, total: 14 };
  assert.notEqual(title(scores(metrics, 16)), '稳健派');
  metrics.calculation = { samples: 16, total: 12.5 };
  assert.equal(title(scores(metrics, 16)), '稳健派');
});

test('profitable weak-hand pressure gains strategy credit when the opponent voluntarily folds', () => {
  const stats = Object.create(MatchStats.prototype);
  function bluff(automatic) {
    const game = E.createGame([0, 1].map(id => ({ id, chips: 500 })), 20);
    Object.assign(game, { phase: 'river', dealerIndex: 0, currentPlayerIndex: 0, currentBet: 0, minRaise: 20,
      handNumber: 1, communityCards: cards('As Ks Qs Jh 9d'), pot: 200 });
    game.players.forEach((player, index) => Object.assign(player, {
      isActive: true, holeCards: cards(index === 0 ? '2h 3c' : 'Ts 4c'), chipsBeforeHand: 600, totalBet: 100
    }));
    const room = { game, history: [], settings: {}, people: new Map([[0, { uid: 'one' }], [1, { uid: 'two' }]]) };
    stats.open(room);
    stats.startHand(room);
    const before = stats.beforeAction(room, game.players[0], false);
    assert.ok(E.applyAction(game, 0, 'raise', 100).ok);
    stats.action(room, 0, before, { action: 'raise', amount: 100, raised: true, street: 'river' });
    assert.ok(E.applyAction(game, 1, 'fold').ok);
    stats.action(room, 1, null, { action: 'fold', amount: 0, raised: false, street: 'river', automatic });
    stats.settleHand(room);
    return room.statistics.players.get(0).metrics.strategy;
  }
  const manual = bluff(false), timeout = bluff(true);
  assert.equal(manual.samples, 1);
  assert.equal(timeout.samples, 1);
  assert.ok(manual.total > timeout.total);
});

test('net BB counts actual hands only and adds uneven team contributions without changing absentees', () => {
  const league = { minHands: 5, minMatches: 1, teams: ['A', 'B', 'C'].map(id => ({ id, name: id })) };
  const first = match('1', 20, [['a', 'A', 100, 0, 1], ['a2', 'A', -20, 0, 1], ['b', 'B', -100, 0, 1],
    ['solo', null, 20, 0, 1], ['watcher', 'C', 0, 0, 0]], { hands: 1 });
  const second = match('2', 50, [['a', 'A', -50, 0, 1], ['solo', null, 50, 0, 1]], { hands: 1 });
  const initial = aggregate(league, [first], true), result = aggregate(league, [first, second], true);
  assert.equal(result.players.some(row => row.uid === 'watcher'), false);
  assert.deepEqual(result.players.find(row => row.uid === 'b'), initial.players.find(row => row.uid === 'b'));
  assert.equal(result.players.find(row => row.uid === 'solo').points, 2);
  assert.equal(result.teams.find(row => row.id === 'A').points, 3);
  assert.equal(result.teams.find(row => row.id === 'A').average, 1.5);
  assert.equal(result.teams.find(row => row.id === 'C').matches, 0);
  assert.equal(result.ledger[1].teams.length, 1);
});

test('season totals count tied MVPs, retain recorded knockouts and skip void matches', () => {
  const league = { minHands: 1, minMatches: 1, teams: [] };
  const legacy = match('legacy', 20, [['a', null, 20, 0], ['b', null, 20, 0], ['c', null, -40, 0]]);
  const current = match('current', 20, [['a', null, 40, 0], ['b', null, -40, 0]]);
  current.players[0].knockouts = 2;
  current.players[1].knockouts = 0;
  const voided = match('voided', 20, [['c', null, 20, 0]], { voidReason: '测试' });
  const { players, ledger } = aggregate(league, [legacy, current, voided], true);
  assert.deepEqual(ledger.map(row => row.mvpUids), [['a', 'b'], ['a']]);
  const totals = new Map(players.map(row => [row.uid, [row.mvps, row.knockouts, row.knockoutMatches]]));
  assert.deepEqual(totals.get('a'), [2, 2, 1]);
  assert.deepEqual(totals.get('b'), [1, 0, 1]);
  assert.deepEqual(totals.get('c'), [0, 0, 0]);
});

test('knockout credits the sole winner of the last eligible side pot once', () => {
  const stats = Object.create(MatchStats.prototype);
  function settle(stacks, hands, board, allowBuyIn = false) {
    const game = E.createGame(stacks.map((chips, id) => ({ chips, id })), 20, { allowBuyIn });
    const people = new Map(stacks.map((_, id) => [id, { uid: String(id), name: String(id) }]));
    const room = { game, people, settings: { allowBuyIn } };
    const suits = { s: 0, h: 1, c: 2, d: 3 }, ranks = { T: 10, J: 11, Q: 12, K: 13, A: 14 };
    const cards = text => text.split(' ').map(card => {
      const rank = ranks[card[0]] || Number(card[0]), suit = suits[card[1]];
      return { rank, suit, id: suit * 13 + rank - 2 };
    });
    Object.assign(game, { dealerIndex: 0, handNumber: 1, phase: 'river', communityCards: cards(board) });
    game.players.forEach((player, index) => Object.assign(player, {
      chips: 0, totalBet: stacks[index], isActive: true, folded: false,
      holeCards: cards(hands[index]), chipsBeforeHand: stacks[index]
    }));
    game.pot = stacks.reduce((sum, stack) => sum + stack, 0);
    stats.open(room);
    stats.startHand(room);
    E.settle(game, true);
    stats.settleHand(room);
    stats.settleHand(room);
    return {
      eliminated: game.players.filter(player => player.eliminatedHand === 1).map(player => player.id),
      knockouts: [...room.statistics.players.values()].map(row => row.knockouts)
    };
  }
  const sidePot = [[50, 100, 100], ['As Ah', 'Ks Kh', 'Qs Qh'], '2s 3h 7c 9d Js'];
  assert.deepEqual(settle(...sidePot), { eliminated: [2], knockouts: [0, 1, 0] });
  assert.deepEqual(settle(...sidePot, true), { eliminated: [], knockouts: [0, 0, 0] });
  assert.deepEqual(settle([50, 50, 50], ['Ts 3h', 'Th 5h', '6h 7h'], 'As Kh Qs Jd 9d'),
    { eliminated: [2], knockouts: [0, 0, 0] });
});
