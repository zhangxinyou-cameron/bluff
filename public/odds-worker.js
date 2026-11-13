importScripts('/poker-engine.js');

const { createDeck, evalBest, cmpHand } = PokerEngine;

self.onmessage = ({ data: { key, hole, board, opponents, variant } }) => {
  const used = new Set([...hole, ...board].map(card => card.id));
  const available = createDeck(variant).filter(card => !used.has(card.id));
  const needed = 5 - board.length;
  const count = needed + 2 * opponents;
  const trials = 100;
  let wins = 0;
  for (let trial = 0; trial < trials; trial++) {
    const pool = available.slice();
    for (let i = 0; i < count; i++) {
      const j = i + Math.floor(Math.random() * (pool.length - i));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const community = [...board, ...pool.slice(0, needed)];
    const mine = evalBest([...hole, ...community], variant);
    let ties = 1;
    for (let i = needed; i < count; i += 2) {
      const result = cmpHand(mine, evalBest([pool[i], pool[i + 1], ...community], variant));
      if (result < 0) { ties = 0; break; }
      if (result === 0) ties++;
    }
    if (ties) wins += 1 / ties;
  }
  self.postMessage({ key, value: Math.round(wins / trials * 100) });
};
