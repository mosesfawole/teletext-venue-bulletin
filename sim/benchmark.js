import { FIXED_CANONICAL, PRIORITY_CANONICAL } from '../src/schedules.js';

export function measure(cycle) {
  return [...new Set(cycle)].sort().map(page => {
    const waits = cycle.map((_, start) => {
      let offset = 0;
      while (cycle[(start + offset) % cycle.length] !== page) offset++;
      return offset + 1;
    });
    return { page, mean: waits.reduce((sum, wait) => sum + wait, 0) / waits.length, max: Math.max(...waits) };
  });
}

console.log('Simulated seconds: one equal-sized slot per second; join just after each slot.');
console.table(measure(FIXED_CANONICAL).map(row => ({ mode: 'fixed', ...row }))
  .concat(measure(PRIORITY_CANONICAL).map(row => ({ mode: 'priority', ...row }))));
