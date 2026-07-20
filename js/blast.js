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

// Damage thresholds (blast energy at a cell, after falloff). Recalibrated per the
// explosion audit (TPT-grounded): a single grain should DENT steel, never breach
// alone — a packed charge breaches. Masonry is split out from brittle glass:
// concrete/stone are as tough as a steel breach; glass/obsidian shatter easily.
const DENT_E = 0.7;      // clean metal buckles -> dented_metal
const BREACH_E = 1.6;    // dented (or a strong charge on clean) metal breaches
const GLASS_E = 0.55;    // glass/obsidian shatter (most brittle)
const MASONRY_E = 1.8;   // stone/concrete crumble (as tough as a metal breach)

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
  //
  // CLUSTER SUPPRESSION (audit fix): in a packed charge EVERY grain queues a blast,
  // and N independent overlapping discs collapse the metal->dented->breach two-hit
  // in one tick, vaporizing huge wall regions. Instead we merge queued detonations
  // that fall within a merge radius into ONE blast per cluster, and scale that
  // blast's energy/radius by the grain count (log-scaled) — so a bigger charge is a
  // bigger bang, but not linearly overpowered. Fully deterministic (queue order +
  // integer math only; no rng, no wall clock).
  resolveAll() {
    const q = this.pending;
    this.pending = [];
    const MERGE = 3; // grains within this many cells collapse into one cluster
    const clusters = [];
    for (let k = 0; k < q.length; k++) {
      const d = q[k];
      let merged = false;
      for (let c = 0; c < clusters.length; c++) {
        const cl = clusters[c];
        if (Math.abs(cl.cx - d.cx) <= MERGE && Math.abs(cl.cy - d.cy) <= MERGE) {
          // accumulate into the cluster centroid + grain count
          cl.sx += d.cx; cl.sy += d.cy; cl.n++;
          cl.baseE = Math.max(cl.baseE, d.E);
          cl.baseR = Math.max(cl.baseR, d.R);
          cl.cx = Math.round(cl.sx / cl.n); cl.cy = Math.round(cl.sy / cl.n);
          merged = true; break;
        }
      }
      if (!merged) clusters.push({ cx: d.cx, cy: d.cy, sx: d.cx, sy: d.cy, n: 1, baseE: d.E, baseR: d.R });
    }
    let affected = 0;
    for (let c = 0; c < clusters.length; c++) {
      const cl = clusters[c];
      // log-scaled: 1 grain -> baseE; 4 grains -> ~2x; 16 -> ~3x. Radius grows sqrt.
      // Bumped: a touch more energy per cluster and a larger radius cap so a real
      // charge produces a bigger, gassier bloom. Wall damage thresholds are
      // unchanged, so this makes the FIRE/SMOKE cloud + fling bigger without
      // turning single grains into wall-breachers (still gated by DENT/BREACH_E).
      const scale = 1.15 + Math.log2(cl.n <= 0 ? 1 : cl.n);
      const E = cl.baseE * scale;
      const R = Math.min(cl.baseR + Math.floor(1.5 * Math.sqrt(cl.n)), 16);
      affected += this._detonate({ cx: cl.cx, cy: cl.cy, E, R, salt: (this._salt = (this._salt + 1) | 0) });
    }
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

        // (a) empty / gas: ERUPT a hot expanding gas cloud (the "pop"). Instead of
        // the old sparse puff (chance 0.7, only e>0.6, so most of the disc stayed
        // empty), fill the disc aggressively: a FIRE core near center and a broad
        // hot SMOKE body across the rest. The seeded gas then rises + billows via
        // the gas movement pass, so the blast visibly blooms outward and lingers.
        // Seeded temps are bounded (<~2000C) so no charge can breach the 5000C
        // no-blowup guard. Deterministic (position hash, no rng, no clock).
        if (id === M.EMPTY || def.phase === PHASE.GAS) {
          const roll = hash01(cx, cy, x, y | 1, salt);
          if (e > 1.0) {
            // CORE: near-certain fire, hot but capped. Hotter toward the center.
            if (roll < 0.9) {
              g.convert(i, M.FIRE, false);
              temp[i] = Math.min(2000, Math.max(temp[i], 700 + e * 110));
              affected++;
            }
          } else if (e > 0.12) {
            // BODY: the bulk of the cloud — hot smoke that rises and expands.
            if (roll < 0.82) {
              g.convert(i, M.SMOKE, false);
              temp[i] = Math.min(900, Math.max(temp[i], 180 + e * 160));
              affected++;
            }
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
          if (e >= GLASS_E) { g.convert(i, M.EMPTY, false); affected++; }
          continue;
        }
        if (id === M.STONE || id === M.CONCRETE) {
          // stone/concrete are as tough as a metal breach — only a strong charge
          // (not a lone grain) crumbles them, half to sand rubble.
          if (e >= MASONRY_E) { g.convert(i, hash01(x, y, cx, cy, salt) < 0.5 ? M.SAND : M.EMPTY, false); affected++; }
          continue;
        }

        // (d) loose powders/liquids: fling outward + heat. hop scales with energy
        // (1 + floor(e*3), capped) and walks inward until it finds an empty cell so
        // debris still moves when the far cell is blocked (audit fix). Marks BOTH
        // vacated source and destination as moved to prevent an extra CA step.
        if (isLoose(def.phase)) {
          temp[i] += e * 60;
          const sx = dx === 0 ? 0 : (dx > 0 ? 1 : -1);
          const sy = dy === 0 ? 0 : (dy > 0 ? 1 : -1);
          // more energetic fling: longer hops (momentum) — scale harder with local
          // energy and raise the cap so a strong blast really throws debris.
          let hop = 1 + Math.floor(e * 5);
          if (hop > 9) hop = 9;
          for (; hop >= 1; hop--) {
            const tx = x + sx * hop, ty = y + sy * hop;
            if (!g.inBounds(tx, ty)) continue;
            const j = ty * w + tx;
            if (mat[j] === M.EMPTY) {
              const tm = mat[i], tt = temp[i], tl = g.latent[i], tf = g.life[i];
              // occupancy: material at i (non-empty, since it's loose debris) moves
              // to the empty cell j. If they're in different rows, transfer the count.
              const ri = (i / w) | 0, rj = (j / w) | 0;
              if (ri !== rj) { g.rowCount[ri]--; g.rowCount[rj]++; }
              mat[i] = mat[j]; temp[i] = temp[j]; g.latent[i] = g.latent[j]; g.life[i] = g.life[j];
              mat[j] = tm; temp[j] = tt; g.latent[j] = tl; g.life[j] = tf;
              g.moved[j] = 1; g.moved[i] = 1;
              break;
            }
          }
          affected++;
        }
      }
    }
    // a hot flash at the very center — a bit hotter now to seed the fire core's
    // glow (still well under the 5000C guard).
    const ci = cy * w + cx;
    if (g.inBounds(cx, cy)) temp[ci] = Math.max(temp[ci], 1200);
    return affected;
  }
}
