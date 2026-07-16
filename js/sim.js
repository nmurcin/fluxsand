// sim.js — the cellular automaton. Movement + reactions + phase changes.
//
// Determinism rules:
//  - the ONLY randomness is the injected Rng (seeded mulberry32)
//  - movement scans bottom-up for falling materials, top-down for rising gases,
//    and uses a per-tick `moved` flag so a cell steps at most once
//  - left/right tie-breaks are decided by the seeded Rng, not Math.random
//
// A tick = movement pass + N thermal sub-steps + phase-change pass + reactions.

import { MATERIALS, M, PHASE } from './materials.js';
import { Thermal } from './thermal.js';

export class Sim {
  constructor(grid, rng) {
    this.g = grid;
    this.rng = rng;
    this.thermal = new Thermal(grid);
    this.tick = 0;
    this.thermalSubsteps = 3;
    // counters exposed to the HUD / tests
    this.lastChanges = 0;
    this.lastReactions = 0;
  }

  step() {
    const g = this.g;
    g.moved.fill(0);

    this.movePass();
    for (let s = 0; s < this.thermalSubsteps; s++) this.thermal.diffuse(1.0);
    this.lastChanges = this.thermal.phaseChanges(1.0);
    this.lastReactions = this.reactionPass();
    this.lifetimePass();

    this.tick++;
  }

  // ---- movement -----------------------------------------------------------

  movePass() {
    const g = this.g;
    const { w, h, mat, moved } = g;

    // Falling solids/powders/liquids: scan bottom-up so a cell falls into space
    // vacated this same tick without teleporting multiple rows.
    for (let y = h - 1; y >= 0; y--) {
      // alternate horizontal scan direction by row+tick to avoid drift bias
      const ltr = ((y + this.tick) & 1) === 0;
      for (let k = 0; k < w; k++) {
        const x = ltr ? k : w - 1 - k;
        const i = y * w + x;
        if (moved[i]) continue;
        const id = mat[i];
        if (id === M.EMPTY) continue;
        const ph = MATERIALS[id].phase;
        if (ph === PHASE.POWDER) this.movePowder(x, y, i);
        else if (ph === PHASE.LIQUID) this.moveLiquid(x, y, i);
      }
    }

    // Rising gases: scan top-down so a gas rises into space vacated above it.
    for (let y = 0; y < h; y++) {
      const ltr = ((y + this.tick) & 1) === 1;
      for (let k = 0; k < w; k++) {
        const x = ltr ? k : w - 1 - k;
        const i = y * w + x;
        if (moved[i]) continue;
        if (MATERIALS[mat[i]].phase === PHASE.GAS) this.moveGas(x, y, i);
      }
    }
  }

  swap(i, j) {
    const g = this.g;
    const tm = g.mat[i], tt = g.temp[i], tl = g.latent[i], tf = g.life[i];
    g.mat[i] = g.mat[j]; g.temp[i] = g.temp[j]; g.latent[i] = g.latent[j]; g.life[i] = g.life[j];
    g.mat[j] = tm; g.temp[j] = tt; g.latent[j] = tl; g.life[j] = tf;
    g.moved[j] = 1;
  }

  // can material at i sink into cell j? (j must be empty or a strictly lighter fluid/gas)
  canDisplace(i, j) {
    const g = this.g;
    const a = MATERIALS[g.mat[i]];
    const bId = g.mat[j];
    if (bId === M.EMPTY) return true;
    const b = MATERIALS[bId];
    // heavier material sinks through lighter LIQUID/GAS
    if ((b.phase === PHASE.LIQUID || b.phase === PHASE.GAS) && a.density > b.density) return true;
    return false;
  }

  movePowder(x, y, i) {
    const g = this.g, w = g.w, h = g.h;
    if (y >= h - 1) return;
    const below = i + w;
    if (this.canDisplace(i, below)) { this.swap(i, below); return; }
    // diagonal repose: try down-left / down-right in seeded order
    const first = this.rng.next() < 0.5 ? -1 : 1;
    for (const dx of [first, -first]) {
      const nx = x + dx;
      if (nx < 0 || nx >= w) continue;
      const d = i + w + dx;
      if (this.canDisplace(i, d)) {
        // only slide if the straight-below is blocked (piling behavior)
        this.swap(i, d);
        return;
      }
    }
  }

  moveLiquid(x, y, i) {
    const g = this.g, w = g.w, h = g.h;
    // fall straight down
    if (y < h - 1 && this.canDisplace(i, i + w)) { this.swap(i, i + w); return; }
    // diagonal down
    const first = this.rng.next() < 0.5 ? -1 : 1;
    for (const dx of [first, -first]) {
      const nx = x + dx;
      if (nx < 0 || nx >= w) continue;
      if (y < h - 1 && this.canDisplace(i, i + w + dx)) { this.swap(i, i + w + dx); return; }
    }
    // spread sideways to find its level (biased random walk, deterministic)
    for (const dx of [first, -first]) {
      const nx = x + dx;
      if (nx < 0 || nx >= w) continue;
      const s = i + dx;
      if (g.mat[s] === M.EMPTY) { this.swap(i, s); return; }
    }
  }

  moveGas(x, y, i) {
    const g = this.g, w = g.w;
    // rise straight up
    if (y > 0 && this.canRiseInto(i, i - w)) { this.swap(i, i - w); return; }
    // diagonal up
    const first = this.rng.next() < 0.5 ? -1 : 1;
    for (const dx of [first, -first]) {
      const nx = x + dx;
      if (nx < 0 || nx >= w) continue;
      if (y > 0 && this.canRiseInto(i, i - w + dx)) { this.swap(i, i - w + dx); return; }
    }
    // drift sideways (dissipation)
    for (const dx of [first, -first]) {
      const nx = x + dx;
      if (nx < 0 || nx >= w) continue;
      if (g.mat[i + dx] === M.EMPTY) { this.swap(i, i + dx); return; }
    }
  }

  canRiseInto(i, j) {
    const g = this.g;
    const bId = g.mat[j];
    if (bId === M.EMPTY) return true;
    const b = MATERIALS[bId];
    // gases rise through liquids (bubble up)
    if (b.phase === PHASE.LIQUID) return true;
    return false;
  }

  // ---- reactions ----------------------------------------------------------

  reactionPass() {
    const g = this.g;
    const { w, h, mat, temp } = g;
    let count = 0;

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const id = mat[i];
        if (id === M.EMPTY) continue;
        const d = MATERIALS[id];

        // 1) Materials that ignite neighbors (fire, ember, lava) heat + light adjacent flammables
        if (d.ignitesNeighbors) {
          count += this.igniteAround(x, y, i);
        }

        // 2) Flammable materials self-ignite above their ignite temp
        if (d.flammable && d.ignite !== undefined && temp[i] >= d.ignite && d.burnTo) {
          // wood/plant leave ember; oil flashes to fire
          g.convert(i, d.burnTo(), false);
          count++;
          continue;
        }

        // 3) Water quenching: if water is adjacent to fire/ember, cool it and make steam-ish
        if (d.quench) {
          count += this.quenchAround(x, y, i);
        }

        // 4) Lava + water contact => obsidian (lava side) + steam (water side)
        if (id === M.LAVA) {
          count += this.lavaWaterContact(x, y, i);
        }

        // 5) Plant growth into adjacent water (slow, deterministic)
        if (d.grows && this.rng.chance(0.02)) {
          count += this.growInto(x, y, i);
        }

        // 6) Acid corrodes adjacent stone/metal
        if (d.corrosive && this.rng.chance(0.15)) {
          count += this.corrodeAround(x, y, i);
        }
      }
    }
    return count;
  }

  neighbors(x, y) {
    const w = this.g.w, h = this.g.h;
    const out = [];
    if (x > 0) out.push((y) * w + (x - 1));
    if (x < w - 1) out.push((y) * w + (x + 1));
    if (y > 0) out.push((y - 1) * w + x);
    if (y < h - 1) out.push((y + 1) * w + x);
    return out;
  }

  igniteAround(x, y, i) {
    const g = this.g;
    let c = 0;
    for (const j of this.neighbors(x, y)) {
      const d = MATERIALS[g.mat[j]];
      // dump heat hard into neighbors on contact — a flame lick is intense locally.
      // This is what lets a short-lived fire actually ignite fuel / heat metal
      // before it rises away as a gas.
      if (g.temp[j] < g.temp[i]) g.temp[j] += (g.temp[i] - g.temp[j]) * 0.45;
      // directly ignite flammables that are hot enough
      if (d.flammable && d.ignite !== undefined && g.temp[j] >= d.ignite && d.burnTo) {
        g.convert(j, d.burnTo(), false);
        c++;
      }
    }
    return c;
  }

  quenchAround(x, y, i) {
    const g = this.g;
    let c = 0;
    for (const j of this.neighbors(x, y)) {
      const id = g.mat[j];
      if (id === M.FIRE || id === M.EMBER) {
        // put out the fire; water heats up toward boiling
        g.convert(j, M.SMOKE, false);
        g.temp[i] += 30;
        c++;
      }
    }
    return c;
  }

  lavaWaterContact(x, y, i) {
    const g = this.g;
    let c = 0;
    for (const j of this.neighbors(x, y)) {
      if (g.mat[j] === M.WATER) {
        // lava freezes to obsidian; the touching water flashes to steam
        g.convert(i, M.OBSIDIAN, false);
        g.temp[i] = 400;
        g.convert(j, M.STEAM, false);
        g.temp[j] = 130;
        c += 2;
        return c; // one contact resolves this lava cell
      }
    }
    return c;
  }

  growInto(x, y, i) {
    const g = this.g;
    for (const j of this.neighbors(x, y)) {
      if (g.mat[j] === M.WATER) {
        g.convert(j, M.PLANT, false);
        return 1;
      }
    }
    return 0;
  }

  corrodeAround(x, y, i) {
    const g = this.g;
    for (const j of this.neighbors(x, y)) {
      const id = g.mat[j];
      if (id === M.STONE || id === M.METAL || id === M.SAND || id === M.WOOD) {
        g.convert(j, M.EMPTY, false);
        // acid is consumed sometimes
        if (this.rng.chance(0.3)) g.convert(i, M.EMPTY, false);
        return 1;
      }
    }
    return 0;
  }

  // ---- lifetimes ----------------------------------------------------------

  lifetimePass() {
    const g = this.g;
    for (let i = 0; i < g.n; i++) {
      if (g.life[i] < 0) continue;
      g.life[i]--;
      if (g.life[i] <= 0) {
        const d = MATERIALS[g.mat[i]];
        if (d.decayTo) g.convert(i, d.decayTo(), false);
        else g.convert(i, M.EMPTY, false);
      }
    }
  }
}
