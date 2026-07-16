// rng.js — the ONLY source of randomness in Fluxsand.
// Seeded mulberry32. No Math.random, no Date.now, no performance.now anywhere.
// Determinism is a hard requirement: same seed + same input log => identical sim.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A small stateful RNG wrapper so modules share one deterministic stream.
export class Rng {
  constructor(seed = 1337) {
    this.seed = seed >>> 0;
    this._next = mulberry32(this.seed);
  }
  reseed(seed) {
    this.seed = seed >>> 0;
    this._next = mulberry32(this.seed);
  }
  // [0,1)
  next() {
    return this._next();
  }
  // integer in [0,n)
  int(n) {
    return (this._next() * n) | 0;
  }
  // float in [lo,hi)
  range(lo, hi) {
    return lo + (hi - lo) * this._next();
  }
  // true with probability p
  chance(p) {
    return this._next() < p;
  }
  // -1 or +1
  sign() {
    return this._next() < 0.5 ? -1 : 1;
  }
}
