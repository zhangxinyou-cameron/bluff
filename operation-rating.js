// Earlier ratings used different observations and are not comparable.
const FIRST_OPERATION_VERSION = 4;
const weights = { calculation: 35, stability: 30, strategy: 15, attack: 15, courage: 5 };

function operationRating(values) {
  const valid = key => Number.isInteger(values?.[key]?.score) && values[key].score >= 1 && values[key].score <= 5;
  const available = Object.keys(weights).filter(valid);
  if (available.length < 3 || !valid('calculation') || !valid('stability')) return null;
  const weight = available.reduce((sum, key) => sum + weights[key], 0);
  const total = available.reduce((sum, key) => sum + values[key].score * weights[key], 0);
  const base = Math.round(20 * total / weight);
  const luck = values.luck?.score;
  const performedUnderPressure = values.stability.score >= 4 || (valid('strategy') && values.strategy.score >= 4);
  const bonus = performedUnderPressure && base >= 60 && valid('luck') && luck <= 2 ? Math.min(100 - base, 3 * (3 - luck)) : 0;
  return { score: base + bonus, base, bonus, dimensions: available.length };
}

function rankOperations(players, minimum = 1) {
  const sort = (a, b) => (b.operationRating?.score ?? 0) - (a.operationRating?.score ?? 0);
  const qualified = players.filter(player => player.operationRating && player.operationMatches >= minimum).sort(sort);
  let place = 0;
  return [
    ...qualified.map((player, index) => {
      if (!index || sort(qualified[index - 1], player)) place = index + 1;
      return { ...player, operationPlace: place };
    }),
    ...players.filter(player => !player.operationRating || player.operationMatches < minimum).sort(sort)
  ];
}

module.exports = { FIRST_OPERATION_VERSION, operationRating, rankOperations };
