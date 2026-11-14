// Earlier ratings used different observations and are not comparable.
const FIRST_OPERATION_VERSION = 4;
const weights = { calculation: 35, stability: 30, strategy: 15, attack: 15, courage: 5 };
// Fixed reference points from the 960-hand calibration batch. The endpoints
// are the observed extremes, and the middle percentiles center the scale at 8.
const calibration = [[36.24, 0], [37.33, 6.2], [39.87, 7], [46.60, 7.3], [51.70, 8],
  [58.85, 8.7], [60, 8.8], [63.31, 9], [67.08, 9.7], [69.20, 10]];
const roundTenth = score => Math.round(score * 10) / 10;

function operationIndex(estimates) {
  const available = Object.keys(weights).filter(key => Number.isFinite(estimates[key]));
  if (available.length < 3 || !available.includes('calculation') || !available.includes('stability')) return null;
  const weight = available.reduce((sum, key) => sum + weights[key], 0);
  const total = available.reduce((sum, key) => sum + estimates[key] * weights[key], 0);
  return { raw: 20 * total / weight, dimensions: available.length };
}

function normalize(raw) {
  const upper = calibration.findIndex(([index]) => index >= raw);
  if (upper === 0) return 0;
  if (upper === -1) return 10;
  const [lowerIndex, lowerScore] = calibration[upper - 1];
  const [upperIndex, upperScore] = calibration[upper];
  const fraction = (raw - lowerIndex) / (upperIndex - lowerIndex);
  return roundTenth(lowerScore + fraction * (upperScore - lowerScore));
}

function operationRating(values, estimates) {
  const index = operationIndex(estimates);
  if (!index) return null;
  const base = normalize(index.raw);
  const luck = values.luck?.score;
  const performedUnderPressure = values.stability.score >= 4 || values.strategy?.score >= 4;
  const boost = base >= 8.8 && performedUnderPressure ? ({ 1: .6, 2: .3 })[luck] ?? 0 : 0;
  const score = Math.min(10, roundTenth(base + boost));
  return { score, base, bonus: roundTenth(score - base), dimensions: index.dimensions };
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

module.exports = { FIRST_OPERATION_VERSION, operationIndex, operationRating, rankOperations };
