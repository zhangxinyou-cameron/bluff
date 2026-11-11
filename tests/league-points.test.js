const assert = require('node:assert/strict');
const test = require('node:test');
const { aggregate } = require('../league-points');
const { empty, scores, title } = require('../match-stats');

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
  assert.equal(result.courage.score, 80);
  assert.equal(title(result), '胆大心细');
  const league = { minHands: 1, minMatches: 1, teams: [] };
  const first = match('1', 20, [['a', null, 0, 50]]);
  const second = match('2', 20, [['a', null, 0, 50]]);
  first.players[0].metrics.calculation = { total: 5, samples: 5 };
  second.players[0].metrics.calculation = { total: 5, samples: 15 };
  const { players } = aggregate(league, [first, second]);
  assert.deepEqual(players[0].values.calculation, { score: 50, samples: 20, observed: 10 });
});
