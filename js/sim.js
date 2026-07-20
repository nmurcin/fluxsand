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
import { Blast } from './blast.js';

export class Sim {
  constructor(grid, rng) {
    this.g = grid;
    this.rng = rng;
    this.thermal = new Thermal(grid);
    this.reactions = new ReactionEngine(REACTION_RULES);
    this.blast = new Blast(grid, rng);
    this.tick = 0;
    this.thermalSubsteps = 3;
    // counters exposed to the HUD / tests
    this.lastChanges = 0;
    this.lastReactions = 0;
    this.lastBlasts = 0;
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
    // Detonations queued during the reaction pass resolve now, as one batch, so an
    // explosion is a single coherent radial event rather than order-dependent.
    this.lastBlasts = this.blast.hasPending() ? this.blast.resolveAll() : 0;
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
    // ANGLE OF REPOSE: only slide diagonally with probability (1 - repose). High
    // repose (snow 0.7) rests at a steep angle and rarely slides -> tall drifts;
    // low repose (ash 0.5) slumps flatter. (audit fix: repose was declared, unused.)
    const repose = MATERIALS[g.mat[i]].repose;
    if (repose !== undefined && this.rng.next() < repose) return; // rest at angle
    const first = this.rng.next() < 0.5 ? -1 : 1;
    for (const dx of [first, -first]) {
      const nx = x + dx;
      if (nx < 0 || nx >= w) continue;
      const d = i + w + dx;
      if (this.canDisplace(i, d)) { this.swap(i, d); return; }
    }
  }

  moveLiquid(x, y, i) {
    const g = this.g, w = g.w, h = g.h;
    const a = MATERIALS[g.mat[i]];
    // BUOYANCY: a lighter liquid rises through a strictly heavier liquid above it
    // (oil/gasoline float up out of water) — the mirror of density sinking, so
    // immiscible layers separate cleanly in both directions. (audit fix)
    if (y > 0) {
      const up = MATERIALS[g.mat[i - w]];
      if (up.phase === PHASE.LIQUID && up.density > a.density && this.rng.next() < 0.5) {
        this.swap(i, i - w); return;
      }
    }
    // fall straight down (into empty or a lighter fluid/gas -> density sinking)
    if (y < h - 1 && this.canDisplace(i, i + w)) { this.swap(i, i + w); return; }
    // diagonal down
    const first = this.rng.next() < 0.5 ? -1 : 1;
    for (const dx of [first, -first]) {
      const nx = x + dx;
      if (nx < 0 || nx >= w) continue;
      if (y < h - 1 && this.canDisplace(i, i + w + dx)) { this.swap(i, i + w + dx); return; }
    }
    // LEVEL-FINDING HORIZONTAL SCAN (TPT-style, audit fix for mounding), but
    // with a HARD 1-CELL PER-TICK DISPLACEMENT CAP (teleport fix).
    //
    // viscosity = per-tick probability the cell is too thick to flow this tick.
    // dispersion = how many cells the cell may LOOK AHEAD to decide which way to
    // flow — it is a sensing range, NOT a per-tick hop distance. The cell scans
    // THROUGH same-material and displaceable cells so it can SEE a lower slot or a
    // drop several columns away (that intelligence is what flattens a surface),
    // but it only ever MOVES ONE cell toward that target this tick. Over many
    // ticks the fluid still sheets and finds its level (fast for low-viscosity
    // water, slow for lava) — nothing jumps multiple cells in a single frame.
    const visc = a.viscosity === undefined ? 0.0 : a.viscosity;
    if (this.rng.next() < visc) return;                 // too thick to flow this tick
    const myId = g.mat[i];
    const reach = a.dispersion === undefined ? 4 : a.dispersion;
    for (const dx of [first, -first]) {
      // The immediate neighbor in this direction must itself be passable, or we
      // can't step that way at all (a wall/heavier cell 1 over blocks the hop).
      const adjX = x + dx;
      if (adjX < 0 || adjX >= w) continue;
      const adj = i + dx;
      const adjMat = g.mat[adj];
      const adjPassable = adjMat === M.EMPTY || adjMat === myId || this.canDisplace(i, adj);
      if (!adjPassable) continue;                       // blocked one cell over

      // Look ahead up to `reach` cells to confirm there IS a reason to flow this
      // way (an empty slot to slide into, or a drop to fall through). We do not
      // move to it directly — finding it just justifies the single step.
      let ci = i, found = false;
      for (let s = 0; s < reach; s++) {
        const nx = (ci % w) + dx;
        if (nx < 0 || nx >= w) break;
        const nxt = ci + dx;
        const there = g.mat[nxt];
        // a drop along the way (empty or lighter-liquid below) is a valid target
        if (y < h - 1 && this.canDisplace(i, nxt + w)) { found = true; break; }
        if (there === M.EMPTY) { found = true; break; } // an empty slot to fill
        else if (there !== myId && !this.canDisplace(i, nxt)) break; // wall/heavier: stop
        ci = nxt;
      }
      if (found) { this.swap(i, adj); return; }          // step exactly ONE cell
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
      // heavy gas sinks and pools (smothers fire): fall into empty OR a lighter gas
      // (so CO2 sinks THROUGH steam/smoke to blanket a fire from below).
      if (y < g.h - 1 && this.canSinkGasInto(i, i + w)) { this.swap(i, i + w); return; }
      const first = this.rng.next() < 0.5 ? -1 : 1;
      for (const dx of [first, -first]) {
        const nx = x + dx;
        if (nx < 0 || nx >= w) continue;
        if (y < g.h - 1 && this.canSinkGasInto(i, i + w + dx)) { this.swap(i, i + w + dx); return; }
      }
    }
    // drift sideways (dissipation) — spread through empty OR any other gas so
    // plumes MIX and thin out instead of clumping against each other.
    const fd = this.rng.next() < 0.5 ? -1 : 1;
    for (const dx of [fd, -fd]) {
      const nx = x + dx;
      if (nx < 0 || nx >= w) continue;
      const bId = g.mat[i + dx];
      if (bId === M.EMPTY || MATERIALS[bId].phase === PHASE.GAS) {
        if (bId === M.EMPTY || bId !== g.mat[i]) { this.swap(i, i + dx); return; }
      }
    }
  }

  // a heavy gas can sink into empty or a strictly-lighter gas below it
  canSinkGasInto(i, j) {
    const g = this.g;
    const bId = g.mat[j];
    if (bId === M.EMPTY) return true;
    const b = MATERIALS[bId];
    return b.phase === PHASE.GAS && b.density < MATERIALS[g.mat[i]].density;
  }

  canRiseInto(i, j) {
    const g = this.g;
    const bId = g.mat[j];
    if (bId === M.EMPTY) return true;
    const b = MATERIALS[bId];
    // gases rise through liquids (bubble up)
    if (b.phase === PHASE.LIQUID) return true;
    // a light gas bubbles up through a strictly-heavier gas (e.g. through CO2)
    if (b.phase === PHASE.GAS && b.density > MATERIALS[g.mat[i]].density) return true;
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
        // NOTE: nbuf is a reused 8-slot scratch array; only the first `n` entries
        // are valid this cell (the rest are stale from a previous cell). The
        // ignitesNeighbors / explosive branches below read nbuf[0..n) directly.
        // The reactions call passes nbuf + n so the engine reads the same valid
        // prefix — we no longer allocate a fresh nbuf.slice(0,n) per non-empty
        // cell per tick (a large amount of GC churn on a busy grid). Behavior is
        // identical: apply() only ever reads indices [0, n).

        // 1) Contact heating: hot igniters (fire/ember/lava) warm ONLY their 4
        //    orthogonal neighbors, and gently. The old code dumped 45% of the
        //    temp gap into all 8 neighbors every tick, which is non-conservative
        //    and lets a shared cell receive from up to 8 sources at once -> runaway
        //    heating + spontaneous combustion. A small orthogonal-only coupling
        //    keeps flames locally hot without piling heat up. (see TPT/Sandspiel)
        if (d.ignitesNeighbors) {
          const ortho = (up ? 1 : 0) + (dn ? 1 : 0) + (lf ? 1 : 0) + (rt ? 1 : 0);
          for (let k = 0; k < ortho; k++) {   // first `ortho` entries are the 4-neighbors
            const j = nbuf[k];
            // Don't pour contact heat into EMPTY air: air has negligible thermal mass
            // and (post air-insulator fix) doesn't conduct it onward, so heating it
            // only produced a hot "halo" of open cells next to lava/fire (~400C) with
            // no physical payoff. Ignition of adjacent fuel and heating of adjacent
            // water/metal still fire because those targets are non-empty.
            if (mat[j] === M.EMPTY) continue;
            if (temp[j] < temp[i]) temp[j] += (temp[i] - temp[j]) * 0.30;
          }
        }

        // 1b) EXPLOSIVE contact detonation: an explosive (gunpowder) touching an
        //     active flame source (fire/ember/spark/lava) detonates immediately —
        //     this is the deflagration chain that lets a lit corner rip across a
        //     packed charge cell-to-cell. Queue a blast and convert to fire.
        if (d.explosive) {
          let touched = false;
          for (let k = 0; k < n; k++) {
            const nid = mat[nbuf[k]];
            if (nid === M.FIRE || nid === M.EMBER || nid === M.SPARK || nid === M.LAVA) { touched = true; break; }
          }
          if (touched) {
            this.blast.queue(x, y, 1.0, d.explosive);
            g.convert(i, M.FIRE, false); temp[i] = 800;
            count++; continue;
          }
        }

        // 2) IGNITION (probabilistic + hard backstop). A flammable cell catches
        //    with probability p = flammability * over, where over ramps 0..1 as its
        //    temperature rises from `ignite` to `ignite + IGNITE_SCALE`. At ambient
        //    (below `ignite`) over = 0 -> p = 0, so NOTHING spontaneously combusts.
        //    Fire spreads organically: gas/gunpowder whoosh (high flammability),
        //    wood/coal smolder (low). A separate HARD backstop guarantees ignition
        //    once a cell is genuinely superheated (real auto-ignition).
        if (d.flammable && d.ignite !== undefined && d.burnTo) {
          const t = temp[i];
          const IGNITE_SCALE = 120;                  // deg C span from smolder to sure-catch
          const hardAuto = d.ignite + 450;           // guaranteed auto-ignition backstop
          let lit = false;
          if (t >= hardAuto) {
            lit = true;
          } else if (t >= d.ignite) {
            const over = Math.min(1, (t - d.ignite) / IGNITE_SCALE);
            const flam = d.flammability !== undefined ? d.flammability : 0.05;
            if (this.rng.chance(flam * over)) lit = true;
          }
          if (lit) {
            // EXPLOSIVE materials (gunpowder) detonate: queue a radial blast at this
            // cell before converting it. `explosive` is the per-grain blast radius;
            // resolveAll() merges a packed charge's grains into a scaled cluster blast.
            if (d.explosive) this.blast.queue(x, y, 1.0, d.explosive);
            g.convert(i, d.burnTo(), false); count++; continue;
          }
        }

        // 3) DATA-DRIVEN reactions: the generic engine handles all pairwise
        //    interactions declared in reaction_rules.js (lava+water, acid+base,
        //    cryo freezing, combustion bursts, dissolving, neutralization, ...).
        if (this.reactions.hasRules(id)) {
          count += this.reactions.apply(g, this.rng, x, y, i, id, nbuf, n);
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
