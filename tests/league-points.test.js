const assert = require('node:assert/strict');
const test = require('node:test');
const { aggregate } = require('../league-points');
const { MatchStats, empty, scores, title } = require('../match-stats');
const E = require('../public/poker-engine');

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
  assert.equal(result.courage.score, 4.2);
  assert.equal(title(result), '胆大心细');
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
  const second = match('2', 20, [['a', null, -20, 0]], { ratingVersion: 2 });
  first.players[0].metrics.stability = { total: 5, samples: 5 };
  second.players[0].metrics.stability = { total: 0, samples: 5 };
  second.players[0].metrics.courage = { total: 2.5, samples: 5 };
  assert.equal(aggregate(league, [first], true).players[0].values.stability.score, 5);
  const player = aggregate(league, [first, second], true).players[0];
  assert.equal(player.values.stability.score, 1);
  assert.deepEqual(player.values.courage, { score: 3, samples: 5, observed: null });
  assert.equal(player.ratingVersion, 2);
  assert.equal(player.matches, 2);
  assert.equal(player.points, 0);
});

test('decision scoring rewards priced folds, real pressure and effective risk', () => {
  const stats = Object.create(MatchStats.prototype);
  const metrics = empty();
  const hand = { courage: new Map(), lastPressure: null };
  const room = { statistics: { hand, players: new Map([[0, { metrics }]]) } };
  const [ace, king, queen, jack, ten] = [14, 13, 12, 11, 10].map(rank => ({ suit: 0, rank }));
  const weakView = {
    seatId: 0, phase: 'river', variant: 'standard', actions: [],
    hole: [{ rank: 2, suit: 1 }, { rank: 3, suit: 2 }], board: [ace, king, queen, jack, { rank: 9, suit: 1 }],
    currentBet: 80, bigBlind: 20,
    players: [{ id: 0, isActive: true, chips: 300, currentBet: 0, totalBet: 20 },
      { id: 1, isActive: true, chips: 220, currentBet: 80, totalBet: 100 }]
  };
  const strongView = { ...weakView, hole: [ten, { rank: 3, suit: 2 }] };
  const decision = { canRaise: true, effective: 300, priced: true, priceMatters: true, potOdds: 0.4, seed: 123, view: weakView };
  stats.action(room, 0, decision, 'fold', 0, false);
  stats.action(room, 0, { ...decision, view: strongView }, 'call', 80, false);
  stats.action(room, 0, { ...decision, bluff: true, priced: false }, 'raise', 150, true);
  assert.deepEqual(metrics.calculation, { samples: 2, total: 2 });
  assert.deepEqual(metrics.stability, { samples: 1, total: 1 });
  assert.deepEqual(metrics.strategy, { samples: 1, total: 0 });
  assert.deepEqual(metrics.attack, { samples: 3, total: 1 });
  assert.equal(hand.courage.get(0), 1);
  assert.equal(hand.lastPressure, 0);
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
