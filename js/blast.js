// blast.js — deterministic radial-impulse explosions.
//
// Modeled on The Powder Toy's approach (radial energy + staged pressure damage)
// but simplified to a single-pass radial impulse — no persistent pressure field,
// so it stays cheap and fully deterministic on our CA.
//
// On detonation at (cx,cy) with energy E and radius R we scan the R-disc and, per
// cell, by distance falloff (1 at center -> 0 at edge):
//   - convert flammable / weak cells to fire or smoke
//   - fling loose particles (powder/liquid) outward by swapping them a few cells
//     down the radial direction into empty space
//   - damage walls in STAGES: clean metal -> dented -> breached(empty); brittle
//     solids (glass/obsidian/stone/concrete) crack to rubble/empty above a higher
//     threshold; truly hard materials just resist.
//   - deposit heat so the blast is also a heat source.
//
// Determinism: all randomness comes from a position hash of (cx,cy,x,y,salt) so the
// result is independent of scan order and reproducible. NO Math.random / Date.

import { MATERIALS, M, PHASE } from './materials.js';

// order-independent deterministic hash -> [0,1)
function hash01(a, b, c, d) {
  let h = (a * 374761393) ^ (b * 668265263) ^ (c * 2246822519) ^ (d * 3266489917);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// Damage thresholds (blast energy at a cell, after falloff). Tuned for feel.
const DENT_E = 0.9;      // clean metal buckles
const BREACH_E = 1.8;    // dented metal (or strong hit on clean) breaches
const BRITTLE_E = 1.2;   // glass/obsidian/stone/concrete shatter

// materials that loose-fling outward (powders + liquids)
function isLoose(ph) {
  return ph === PHASE.POWDER || ph === PHASE.LIQUID;
}

export class Blast {
  constructor(grid, rng) {
    this.g = grid;
    this.rng = rng;
    // per-tick queue of pending detonations {cx, cy, E, R, salt}
    this.pending = [];
    this._salt = 0;
  }

  // Queue a detonation to be resolved at the end of the reaction pass.
  queue(cx, cy, energy, radius) {
    this.pending.push({ cx, cy, E: energy, R: radius, salt: (this._salt = (this._salt + 1) | 0) });
  }

  hasPending() {
    return this.pending.length > 0;
  }

  // Resolve all queued detonations. Returns cells affected (for counters).
  resolveAll() {
    let affected = 0;
    const q = this.pending;
    this.pending = [];
    for (let k = 0; k < q.length; k++) affected += this._detonate(q[k]);
    return affected;
  }

  _detonate({ cx, cy, E, R, salt }) {
    const g = this.g;
    const { w, h, mat, temp } = g;
    const R2 = R * R;
    let affected = 0;

    for (let dy = -R; dy <= R; dy++) {
      const y = cy + dy;
      if (y < 0 || y >= h) continue;
      for (let dx = -R; dx <= R; dx++) {
        const d2 = dx * dx + dy * dy;
        if (d2 > R2) continue;
        const x = cx + dx;
        if (x < 0 || x >= w) continue;
        const i = y * w + x;
        const id = mat[i];
        const def = MATERIALS[id];
        const falloff = 1 - d2 / R2;          // 1 center -> 0 edge
        const e = E * falloff;                // local blast energy
        if (e <= 0.05) continue;

        // (a) empty / gas: seed a puff of fire near center, smoke further out
        if (id === M.EMPTY || def.phase === PHASE.GAS) {
          if (e > 0.6 && hash01(cx, cy, x, y | 1, salt) < 0.7) {
            g.convert(i, e > 1.2 ? M.FIRE : M.SMOKE, false);
            affected++;
          }
          continue;
        }

        // (b) flammable / weak powders & liquids -> ignite or scatter
        if (def.flammable) {
          g.convert(i, M.FIRE, false);
          temp[i] = 700;
          affected++;
          continue;
        }

        // (c) staged WALL damage
        if (id === M.METAL) {
          if (e >= BREACH_E) { g.convert(i, M.EMPTY, false); }
          else if (e >= DENT_E) { g.convert(i, M.DENTED_METAL, false); }
          affected++;
          continue;
        }
        if (id === M.DENTED_METAL) {
          if (e >= DENT_E) { g.convert(i, M.EMPTY, false); affected++; }  // already weak -> breach
          continue;
        }
        if (id === M.GLASS || id === M.OBSIDIAN) {
          if (e >= BRITTLE_E * 0.8) { g.convert(i, M.EMPTY, false); affected++; }
          continue;
        }
        if (id === M.STONE || id === M.CONCRETE) {
          // stone/concrete only crumble very close to a strong blast, else resist
          if (e >= BRITTLE_E) { g.convert(i, hash01(x, y, cx, cy, salt) < 0.5 ? M.SAND : M.EMPTY, false); affected++; }
          continue;
        }

        // (d) loose powders/liquids: fling outward + heat
        if (isLoose(def.phase)) {
          temp[i] += e * 60;
          // fling: try to hop this cell 1-2 steps down the radial direction into empty
          const sx = dx === 0 ? 0 : (dx > 0 ? 1 : -1);
          const sy = dy === 0 ? 0 : (dy > 0 ? 1 : -1);
          const hop = e > 1.0 ? 2 : 1;
          const tx = x + sx * hop, ty = y + sy * hop;
          if (g.inBounds(tx, ty)) {
            const j = ty * w + tx;
            if (mat[j] === M.EMPTY) {
              // swap outward
              const tm = mat[i], tt = temp[i], tl = g.latent[i], tf = g.life[i];
              mat[i] = mat[j]; temp[i] = temp[j]; g.latent[i] = g.latent[j]; g.life[i] = g.life[j];
              mat[j] = tm; temp[j] = tt; g.latent[j] = tl; g.life[j] = tf;
              g.moved[j] = 1;
            }
          }
          affected++;
        }
      }
    }
    // a hot flash at the very center
    const ci = cy * w + cx;
    if (g.inBounds(cx, cy)) temp[ci] = Math.max(temp[ci], 900);
    return affected;
  }
}
