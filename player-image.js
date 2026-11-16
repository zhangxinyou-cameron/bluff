const imageNames = {
  rock: '岩石',
  tightAggressive: '紧凶',
  looseAggressive: '松凶',
  loosePassive: '松弱',
  callingStation: '跟注站'
};

function newImageStats() {
  return { preflopHands: 0, voluntaryHands: 0, raisedHands: 0, entryThresholdTotal: 0,
    postflopRaises: 0, postflopCalls: 0, postflopFaced: 0 };
}

function recordImageAction(stats, hand, event, tableSize) {
  if (event.automatic) return;
  const betting = event.amount > 0 && event.raised;
  const calling = event.amount > 0 && !betting && ['call', 'allin'].includes(event.action);

  if (event.street === 'pre_flop') {
    if (!hand.acted) {
      hand.acted = true;
      stats.preflopHands++;
      stats.entryThresholdTotal += tableSize <= 2 ? 50 : tableSize <= 4 ? 33 : 23;
    }
    if (!hand.entered && (betting || calling)) {
      hand.entered = true;
      stats.voluntaryHands++;
    }
    if (!hand.raised && betting) {
      hand.raised = true;
      stats.raisedHands++;
    }
    return;
  }

  if (event.facedBet) stats.postflopFaced++;
  if (betting) stats.postflopRaises++;
  if (calling) stats.postflopCalls++;
}

function playerImage(stats) {
  if (!stats) return null;
  const { preflopHands, voluntaryHands, raisedHands, entryThresholdTotal, postflopRaises, postflopCalls, postflopFaced } = stats;
  const vpip = preflopHands ? voluntaryHands / preflopHands : null;
  const pfr = preflopHands ? raisedHands / preflopHands : null;
  const callRate = postflopFaced ? postflopCalls / postflopFaced : null;
  const paidPostflop = postflopRaises + postflopCalls;
  const postflopAggression = paidPostflop ? postflopRaises / paidPostflop : null;
  const aggressive = (raisedHands >= 2 && raisedHands / voluntaryHands >= .60) ||
    (paidPostflop >= 5 && postflopAggression >= .60);
  const tightLimit = preflopHands ? entryThresholdTotal / (100 * preflopHands) : null;

  let type = null;
  if (preflopHands >= 10) {
    if (vpip <= tightLimit * .55) type = 'rock';
    else if (vpip <= tightLimit) type = aggressive ? 'tightAggressive' : 'rock';
    else if (aggressive) type = 'looseAggressive';
    else if (postflopFaced >= 5 && callRate >= .65 && postflopAggression <= .30) type = 'callingStation';
    else type = 'loosePassive';
  }
  return { name: imageNames[type] ?? null, vpip, pfr, callRate, postflopAggression, preflopHands, postflopFaced };
}

module.exports = { newImageStats, recordImageAction, playerImage };
