// scenarios.js — deterministic seeded starting states.
// Each scenario is a pure function of (grid, rng, dims). No wall-clock, no Math.random.
// These double as test fixtures the harness diffs against.

import { M } from './materials.js';

function fill(grid, x0, y0, x1, y1, id) {
  for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++)
    for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++)
      if (grid.inBounds(x, y)) grid.set(x, y, id);
}

export const SCENARIOS = {
  // A volcano: stone cone with a lava core, ready to erupt. Great frame-one wow.
  Volcano(grid, rng, d) {
    const W = grid.w, H = grid.h;
    grid.clear();
    // ground
    fill(grid, 0, H - 24, W - 1, H - 1, M.STONE);
    // mountain cone
    const cx = W >> 1;
    for (let y = 0; y < 90; y++) {
      const halfW = 20 + y * 0.9;
      const yy = H - 24 - (90 - y);
      fill(grid, cx - halfW, yy, cx + halfW, yy, M.STONE);
    }
    // lava chamber + throat
    fill(grid, cx - 30, H - 24, cx + 30, H - 6, M.LAVA);
    fill(grid, cx - 5, H - 110, cx + 5, H - 24, M.LAVA);
    // a little snow cap of ice to melt dramatically
    fill(grid, cx - 10, H - 116, cx + 10, H - 112, M.ICE);
    // scattered water pools on the flanks
    fill(grid, 14, H - 26, 40, H - 25, M.WATER);
    fill(grid, W - 40, H - 26, W - 14, H - 25, M.WATER);
  },

  // Ice Age: a frozen world with a warm ember to thaw it.
  IceAge(grid, rng, d) {
    const W = grid.w, H = grid.h;
    grid.clear();
    fill(grid, 0, H - 20, W - 1, H - 1, M.STONE);
    fill(grid, 0, H - 60, W - 1, H - 21, M.ICE);
    // a few frozen ponds of water beneath
    fill(grid, 40, H - 22, 90, H - 21, M.WATER);
    // a lone ember to introduce heat
    fill(grid, W >> 1, H - 64, (W >> 1) + 2, H - 62, M.EMBER);
  },

  // Thermite Cascade: metal + fire columns; watch metal glow and melt.
  Thermite(grid, rng, d) {
    const W = grid.w, H = grid.h;
    grid.clear();
    fill(grid, 0, H - 18, W - 1, H - 1, M.STONE);
    // metal blocks
    for (let k = 0; k < 5; k++) {
      const x = 40 + k * 50;
      fill(grid, x, H - 60, x + 24, H - 19, M.METAL);
    }
    // oil-soaked wicks + fire on top
    for (let k = 0; k < 5; k++) {
      const x = 40 + k * 50;
      fill(grid, x + 6, H - 70, x + 18, H - 61, M.OIL);
      fill(grid, x + 10, H - 74, x + 14, H - 71, M.FIRE);
    }
  },

  // Steam Puzzle: lava under a water tank — makes a roiling steam engine feel.
  Steam(grid, rng, d) {
    const W = grid.w, H = grid.h;
    grid.clear();
    fill(grid, 0, H - 16, W - 1, H - 1, M.STONE);
    // sealed metal boiler walls
    fill(grid, 60, H - 90, 62, H - 16, M.METAL);
    fill(grid, W - 62, H - 90, W - 60, H - 16, M.METAL);
    fill(grid, 60, H - 92, W - 60, H - 90, M.METAL);
    // water inside
    fill(grid, 63, H - 60, W - 63, H - 17, M.WATER);
    // lava firebox below
    fill(grid, 63, H - 15, W - 63, H - 2, M.LAVA);
  },

  // Empty sandbox
  Empty(grid, rng, d) {
    grid.clear();
    fill(grid, 0, grid.h - 12, grid.w - 1, grid.h - 1, M.STONE);
  },
};

// case-insensitive lookup
const LOOKUP = {};
for (const k of Object.keys(SCENARIOS)) LOOKUP[k.toLowerCase()] = k;

export function loadScenario(name, grid, rng, dims) {
  const key = LOOKUP[(name || '').toLowerCase()];
  if (!key) return false;
  SCENARIOS[key](grid, rng, dims);
  return true;
}
