const assert = require('node:assert/strict');
const { test } = require('node:test');
const { newImageStats, playerImage, recordImageAction } = require('../player-image');

function record(stats, hand, action, options = {}) {
  const { tableSize = 6, ...event } = options;
  recordImageAction(stats, hand, { action, street: 'pre_flop', amount: 0, ...event }, tableSize);
}

function play({ hands = 20, enters, raises, calls = 0, faced = 0, postRaises = 0, tableSize = 6 }) {
  const stats = newImageStats();
  for (let i = 0; i < hands; i++) {
    if (i < raises) record(stats, {}, 'raise', { amount: 60, raised: true, tableSize });
    else if (i < enters) record(stats, {}, 'call', { amount: 20, facedBet: true, tableSize });
    else record(stats, {}, 'fold', { facedBet: true, tableSize });
  }
  for (let i = 0; i < faced; i++) {
    const calling = i < calls;
    record(stats, {}, calling ? 'call' : 'fold', { street: 'flop', facedBet: true, amount: calling ? 20 : 0 });
  }
  for (let i = 0; i < postRaises; i++) record(stats, {}, 'raise', { street: 'turn', amount: 60, raised: true });
  return playerImage(stats);
}

test('player images distinguish all five playing styles and use postflop betting as evidence of aggression', () => {
  assert.equal(play({ enters: 2, raises: 2 }).name, '岩石');
  assert.equal(play({ enters: 4, raises: 3 }).name, '紧凶');
  assert.equal(play({ enters: 9, raises: 6 }).name, '松凶');
  assert.equal(play({ enters: 9, raises: 1, postRaises: 5 }).name, '松凶');
  assert.equal(play({ enters: 11, raises: 1, calls: 4, faced: 8 }).name, '松弱');
  assert.equal(play({ enters: 11, raises: 1, calls: 4, faced: 4 }).name, '松弱');
  const station = play({ enters: 11, raises: 1, calls: 7, faced: 9, postRaises: 1 });
  assert.deepEqual(station, { name: '跟注站', vpip: .55, pfr: .05, callRate: 7 / 9, postflopAggression: 1 / 8, preflopHands: 20, postflopFaced: 9 });
  assert.equal(play({ hands: 9, enters: 8, raises: 8 }).name, null);
  assert.equal(playerImage(undefined), null);
});

test('the same voluntary rate can be tight heads-up and loose at a full table', () => {
  assert.equal(play({ enters: 8, raises: 5, tableSize: 2 }).name, '紧凶');
  assert.equal(play({ enters: 8, raises: 5, tableSize: 6 }).name, '松凶');
});

test('only manual decisions count, and repeated raises and call-sized all-ins are recorded correctly', () => {
  const stats = newImageStats();
  record(stats, {}, 'fold', { automatic: true, facedBet: true });
  record(stats, {}, 'check');
  const limpReraise = {};
  record(stats, limpReraise, 'call', { amount: 20, facedBet: true });
  record(stats, limpReraise, 'raise', { amount: 100, raised: true, facedBet: true });
  record(stats, limpReraise, 'allin', { amount: 200, raised: true, facedBet: true });
  record(stats, {}, 'allin', { amount: 5, facedBet: true });
  record(stats, {}, 'check', { street: 'flop' });
  record(stats, {}, 'fold', { street: 'flop', automatic: true, facedBet: true });
  record(stats, {}, 'allin', { street: 'turn', facedBet: true, amount: 5 });
  record(stats, {}, 'raise', { street: 'river', facedBet: true, amount: 30, raised: true });
  assert.deepEqual(stats, { preflopHands: 3, voluntaryHands: 2, raisedHands: 1, entryThresholdTotal: 69,
    postflopRaises: 1, postflopCalls: 1, postflopFaced: 2 });
});
