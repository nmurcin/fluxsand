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
import { ReactionEngine } from './reactions.js';
import { REACTION_RULES } from './reaction_rules.js';

export class Sim {
  constructor(grid, rng) {
    this.g = grid;
    this.rng = rng;
    this.thermal = new Thermal(grid);
    this.reactions = new ReactionEngine(REACTION_RULES);
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
    // Reactions run BEFORE phase changes so contact chemistry (LN2 flash-freezing
    // water, thermite igniting, quenches) gets first crack before a cell would
    // otherwise boil/melt itself away this tick.
    this.lastReactions = this.reactionPass();
    this.lastChanges = this.thermal.phaseChanges(1.0);
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
        const gd = MATERIALS[mat[i]];
        // `static` gases (spark/electric arc) don't drift — they stay put for their
        // short life and propagate purely by reaction (jumping along conductors),
        // so a spark can actually ignite the fuel it was painted onto.
        if (gd.phase === PHASE.GAS && !gd.static) this.moveGas(x, y, i);
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
    const a = MATERIALS[g.mat[i]];
    // fall straight down (into empty or a lighter fluid/gas -> density sinking)
    if (y < h - 1 && this.canDisplace(i, i + w)) { this.swap(i, i + w); return; }
    // diagonal down
    const first = this.rng.next() < 0.5 ? -1 : 1;
    for (const dx of [first, -first]) {
      const nx = x + dx;
      if (nx < 0 || nx >= w) continue;
      if (y < h - 1 && this.canDisplace(i, i + w + dx)) { this.swap(i, i + w + dx); return; }
    }
    // VISCOSITY-GATED SIDEWAYS SPREAD.
    // A liquid's spread rate scales inversely with viscosity: water (0.0) sheets
    // out every tick over many cells; oil (~0.4) is medium; lava (~0.95) barely
    // creeps; tar/honey (~0.99) almost holds shape. Viscosity also caps how far a
    // cell may travel sideways in one tick (dispersion distance).
    const visc = a.viscosity === undefined ? 0.0 : a.viscosity;
    // probability this viscous cell moves sideways at all this tick
    if (this.rng.next() < visc * 0.92) return;   // too thick to flow this tick
    // dispersion: thin liquids search several cells for a downhill/empty slot
    const reach = 1 + Math.round((1 - visc) * 6);  // water ~7, oil ~4, lava ~1
    for (const dx of [first, -first]) {
      let step = 0;
      let cx = x, ci = i;
      while (step < reach) {
        const nx = cx + dx;
        if (nx < 0 || nx >= w) break;
        const s = ci + dx;
        // prefer to flow into empty, or sink one further if there's a drop
        if (g.mat[s] === M.EMPTY) {
          // if there's a hole below the destination, fall in there (finds level)
          if (y < h - 1 && g.mat[s + w] === M.EMPTY) { this.swap(i, s + w); return; }
          this.swap(i, s); return;
        }
        // can we displace a lighter liquid to the side to keep flowing? (level-finding)
        if (!this.canDisplace(i, s)) break;
        this.swap(i, s); return;
      }
    }
  }

  moveGas(x, y, i) {
    const g = this.g, w = g.w;
    const a = MATERIALS[g.mat[i]];
    // BUOYANCY scales with temperature: hot gas rises eagerly, cool/heavy gas
    // (e.g. CO2, cold nitrogen) is sluggish and can even sink. rise = P(rise up).
    const over = g.temp[i] - g.ambient;          // how much hotter than room
    // dense gases (co2, cold n2) with density high enough sink instead of rise
    const buoyant = a.density < 3.0;             // light gas -> rises; heavy -> sinks
    if (buoyant) {
      const rise = Math.max(0.15, Math.min(1, 0.35 + over / 900)); // 0.15..1
      if (this.rng.next() < rise) {
        if (y > 0 && this.canRiseInto(i, i - w)) { this.swap(i, i - w); return; }
        const first = this.rng.next() < 0.5 ? -1 : 1;
        for (const dx of [first, -first]) {
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          if (y > 0 && this.canRiseInto(i, i - w + dx)) { this.swap(i, i - w + dx); return; }
        }
      }
    } else {
      // heavy gas sinks and pools (smothers fire): try to fall
      if (y < g.h - 1 && g.mat[i + w] === M.EMPTY) { this.swap(i, i + w); return; }
      const first = this.rng.next() < 0.5 ? -1 : 1;
      for (const dx of [first, -first]) {
        const nx = x + dx;
        if (nx < 0 || nx >= w) continue;
        if (y < g.h - 1 && g.mat[i + w + dx] === M.EMPTY) { this.swap(i, i + w + dx); return; }
      }
    }
    // drift sideways (dissipation) — both kinds spread laterally
    const fd = this.rng.next() < 0.5 ? -1 : 1;
    for (const dx of [fd, -fd]) {
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
    const nbuf = [0, 0, 0, 0, 0, 0, 0, 0];

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const id = mat[i];
        if (id === M.EMPTY) continue;
        const d = MATERIALS[id];

        // gather 8-neighborhood into a reusable buffer (deterministic order:
        // orthogonals first — left, right, up, down — then diagonals). Using the
        // full Moore neighborhood makes reactions robust to a 1-cell gap that
        // opens when a powder fuel settles a row away from a static igniter.
        let n = 0;
        const up = y > 0, dn = y < h - 1, lf = x > 0, rt = x < w - 1;
        if (lf) nbuf[n++] = i - 1;
        if (rt) nbuf[n++] = i + 1;
        if (up) nbuf[n++] = i - w;
        if (dn) nbuf[n++] = i + w;
        if (up && lf) nbuf[n++] = i - w - 1;
        if (up && rt) nbuf[n++] = i - w + 1;
        if (dn && lf) nbuf[n++] = i + w - 1;
        if (dn && rt) nbuf[n++] = i + w + 1;
        const nb = nbuf.slice(0, n);

        // 1) Contact heating: materials that ignite neighbors (fire/ember/lava)
        //    dump heat hard into cooler neighbors — a flame lick is intense locally.
        if (d.ignitesNeighbors) {
          for (let k = 0; k < n; k++) {
            const j = nbuf[k];
            if (temp[j] < temp[i]) temp[j] += (temp[i] - temp[j]) * 0.45;
          }
        }

        // 2) Self-ignition above ignite temp (flammables flash on their own)
        if (d.flammable && d.ignite !== undefined && temp[i] >= d.ignite && d.burnTo) {
          g.convert(i, d.burnTo(), false);
          count++;
          continue;
        }

        // 3) DATA-DRIVEN reactions: the generic engine handles all pairwise
        //    interactions declared in reaction_rules.js (lava+water, acid+base,
        //    cryo freezing, combustion bursts, dissolving, neutralization, ...).
        if (this.reactions.hasRules(id)) {
          count += this.reactions.apply(g, this.rng, x, y, i, id, nb);
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
