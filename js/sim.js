// sim.js — the cellular automaton. Movement + reactions + phase changes.
//
// Determinism rules:
//  - the ONLY randomness is the injected Rng (seeded mulberry32)
//  - movement scans bottom-up for falling materials, top-down for rising gases,
//    and uses a per-tick `moved` flag so a cell steps at most once
//  - left/right tie-breaks are decided by the seeded Rng, not Math.random
//
// A tick = movement pass + N thermal sub-steps + phase-change pass + reactions.

import {
  MATERIALS, M, PHASE,
  PHASE_LUT, DENSITY_LUT, VISCOSITY_LUT, DISPERSION_LUT, REPOSE_LUT, STATIC_LUT,
  RXN_FLAGS_LUT, FLAG_IGNITES, FLAG_EXPLOSIVE, FLAG_FLAMMABLE,
} from './materials.js';
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
    const { w, h, mat, moved, rowCount } = g;

    // Falling solids/powders/liquids: scan bottom-up so a cell falls into space
    // vacated this same tick without teleporting multiple rows.
    for (let y = h - 1; y >= 0; y--) {
      if (rowCount[y] === 0) continue; // empty row has nothing to move (byte-identical skip)
      // alternate horizontal scan direction by row+tick to avoid drift bias
      const ltr = ((y + this.tick) & 1) === 0;
      for (let k = 0; k < w; k++) {
        const x = ltr ? k : w - 1 - k;
        const i = y * w + x;
        if (moved[i]) continue;
        const id = mat[i];
        if (id === M.EMPTY) continue;
        const ph = PHASE_LUT[id];
        if (ph === PHASE.POWDER) this.movePowder(x, y, i);
        else if (ph === PHASE.LIQUID) this.moveLiquid(x, y, i);
      }
    }

    // Rising gases: scan top-down so a gas rises into space vacated above it.
    for (let y = 0; y < h; y++) {
      if (rowCount[y] === 0) continue; // empty row: no gas to rise (byte-identical skip)
      const ltr = ((y + this.tick) & 1) === 1;
      for (let k = 0; k < w; k++) {
        const x = ltr ? k : w - 1 - k;
        const i = y * w + x;
        if (moved[i]) continue;
        const gid = mat[i];
        // `static` gases (spark/electric arc) don't drift — they stay put for their
        // short life and propagate purely by reaction (jumping along conductors),
        // so a spark can actually ignite the fuel it was painted onto.
        if (PHASE_LUT[gid] === PHASE.GAS && STATIC_LUT[gid] === 0) this.moveGas(x, y, i);
      }
    }
  }

  swap(i, j) {
    const g = this.g;
    const tm = g.mat[i], tt = g.temp[i], tl = g.latent[i], tf = g.life[i];
    // Maintain per-row occupancy across the swap. A swap moves mat[i]<->mat[j];
    // if the two cells are in DIFFERENT rows and differ in emptiness, occupancy
    // transfers between those rows. Same-row swaps net to zero (both deltas cancel).
    // Uses the pre-swap ids (tm = old mat[i], g.mat[j] = old mat[j]).
    const ri = (i / g.w) | 0, rj = (j / g.w) | 0;
    if (ri !== rj) {
      const iEmpty = tm === M.EMPTY, jEmpty = g.mat[j] === M.EMPTY;
      if (iEmpty !== jEmpty) {
        // after swap, row ri holds old-j and row rj holds old-i
        if (jEmpty) { g.rowCount[ri]--; g.rowCount[rj]++; }  // i had material, moves to rj
        else { g.rowCount[ri]++; g.rowCount[rj]--; }         // j had material, moves to ri
      }
    }
    g.mat[i] = g.mat[j]; g.temp[i] = g.temp[j]; g.latent[i] = g.latent[j]; g.life[i] = g.life[j];
    g.mat[j] = tm; g.temp[j] = tt; g.latent[j] = tl; g.life[j] = tf;
    g.moved[j] = 1;
  }

  // can material at i sink into cell j? (j must be empty or a strictly lighter fluid/gas)
  // LUT hot path: this runs several times per moving cell per tick.
  canDisplace(i, j) {
    const mat = this.g.mat;
    const bId = mat[j];
    if (bId === M.EMPTY) return true;
    const bph = PHASE_LUT[bId];
    // heavier material sinks through lighter LIQUID/GAS
    if ((bph === PHASE.LIQUID || bph === PHASE.GAS) && DENSITY_LUT[mat[i]] > DENSITY_LUT[bId]) return true;
    return false;
  }

  movePowder(x, y, i) {
    const g = this.g, w = g.w, h = g.h;
    if (y >= h - 1) return;
    const below = i + w;
    if (this.canDisplace(i, below)) { this.swap(i, below); return; }
    // ANGLE OF REPOSE: only slide diagonally with probability (1 - repose). High
    // repose (snow 0.7) rests at a steep angle and rarely slides -> tall drifts;
    // low repose (ash 0.5) slumps flatter. REPOSE_LUT uses -1 as the "no repose
    // declared" sentinel (the old code's `repose !== undefined` guard), so the
    // rng.next() draw only happens for materials that actually declare repose —
    // preserving the exact rng consumption order (byte-identical).
    const repose = REPOSE_LUT[g.mat[i]];
    if (repose >= 0 && this.rng.next() < repose) return; // rest at angle
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
    const myId = g.mat[i];
    const myDensity = DENSITY_LUT[myId];
    // BUOYANCY: a lighter liquid rises through a strictly heavier liquid above it
    // (oil/gasoline float up out of water) — the mirror of density sinking, so
    // immiscible layers separate cleanly in both directions. (audit fix)
    if (y > 0) {
      const upId = g.mat[i - w];
      if (PHASE_LUT[upId] === PHASE.LIQUID && DENSITY_LUT[upId] > myDensity && this.rng.next() < 0.5) {
        this.swap(i, i - w); return;
      }
    }
    // fall straight down (into empty or a lighter fluid/gas -> density sinking)
    if (y < h - 1 && this.canDisplace(i, i + w)) { this.swap(i, i + w); return; }
    // diagonal down. Unrolled the [first,-first] iteration to avoid a per-cell
    // array literal allocation in this hot path (same rng draw + same order).
    const first = this.rng.next() < 0.5 ? -1 : 1;
    if (y < h - 1) {
      const nx1 = x + first;
      if (nx1 >= 0 && nx1 < w && this.canDisplace(i, i + w + first)) { this.swap(i, i + w + first); return; }
      const nx2 = x - first;
      if (nx2 >= 0 && nx2 < w && this.canDisplace(i, i + w - first)) { this.swap(i, i + w - first); return; }
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
    const visc = VISCOSITY_LUT[myId];                   // 0.0 default baked into LUT
    if (this.rng.next() < visc) return;                 // too thick to flow this tick
    const reach = DISPERSION_LUT[myId];                 // 4 default baked into LUT
    // Indexed 2-iteration loop (dir = first then -first) instead of a per-cell
    // [first,-first] array literal — same order, no allocation.
    for (let t = 0; t < 2; t++) {
      const dx = t === 0 ? first : -first;
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
    const myId = g.mat[i];
    // BUOYANCY scales with temperature: hot gas rises eagerly, cool/heavy gas
    // (e.g. CO2, cold nitrogen) is sluggish and can even sink. rise = P(rise up).
    const over = g.temp[i] - g.ambient;          // how much hotter than room
    // dense gases (co2, cold n2) with density high enough sink instead of rise
    const buoyant = DENSITY_LUT[myId] < 3.0;     // light gas -> rises; heavy -> sinks
    if (buoyant) {
      const rise = Math.max(0.15, Math.min(1, 0.35 + over / 900)); // 0.15..1
      if (this.rng.next() < rise) {
        if (y > 0 && this.canRiseInto(i, i - w)) { this.swap(i, i - w); return; }
        const first = this.rng.next() < 0.5 ? -1 : 1;
        for (let t = 0; t < 2; t++) {
          const dx = t === 0 ? first : -first;
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
      for (let t = 0; t < 2; t++) {
        const dx = t === 0 ? first : -first;
        const nx = x + dx;
        if (nx < 0 || nx >= w) continue;
        if (y < g.h - 1 && this.canSinkGasInto(i, i + w + dx)) { this.swap(i, i + w + dx); return; }
      }
    }
    // drift sideways (dissipation) — spread through empty OR any other gas so
    // plumes MIX and thin out instead of clumping against each other.
    const fd = this.rng.next() < 0.5 ? -1 : 1;
    for (let t = 0; t < 2; t++) {
      const dx = t === 0 ? fd : -fd;
      const nx = x + dx;
      if (nx < 0 || nx >= w) continue;
      const bId = g.mat[i + dx];
      if (bId === M.EMPTY || PHASE_LUT[bId] === PHASE.GAS) {
        if (bId === M.EMPTY || bId !== myId) { this.swap(i, i + dx); return; }
      }
    }
  }

  // a heavy gas can sink into empty or a strictly-lighter gas below it
  canSinkGasInto(i, j) {
    const mat = this.g.mat;
    const bId = mat[j];
    if (bId === M.EMPTY) return true;
    return PHASE_LUT[bId] === PHASE.GAS && DENSITY_LUT[bId] < DENSITY_LUT[mat[i]];
  }

  canRiseInto(i, j) {
    const mat = this.g.mat;
    const bId = mat[j];
    if (bId === M.EMPTY) return true;
    const bph = PHASE_LUT[bId];
    // gases rise through liquids (bubble up)
    if (bph === PHASE.LIQUID) return true;
    // a light gas bubbles up through a strictly-heavier gas (e.g. through CO2)
    if (bph === PHASE.GAS && DENSITY_LUT[bId] > DENSITY_LUT[mat[i]]) return true;
    return false;
  }

  // ---- reactions ----------------------------------------------------------

  reactionPass() {
    const g = this.g;
    const { w, h, mat, temp, rowCount } = g;
    let count = 0;
    const nbuf = [0, 0, 0, 0, 0, 0, 0, 0];

    for (let y = 0; y < h; y++) {
      if (rowCount[y] === 0) continue; // all-empty row: every cell would `continue` below
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const id = mat[i];
        if (id === M.EMPTY) continue;

        // FAST REJECT: a cell only does anything in this pass if it has one of the
        // three special flags (ignites/explosive/flammable) OR a data-driven rule.
        // A plain, ruleless material (sand, stone, water, most solids) is INERT here
        // — so skip it before the neighbor-gather, saving the whole 8-cell buffer
        // fill + branch chain for the common case. One LUT read + one Map probe
        // replaces per-cell object-property lookups. Byte-identical: a skipped cell
        // produced no reaction anyway (its branches were all false).
        const flags = RXN_FLAGS_LUT[id];
        const hasRules = this.reactions.hasRules(id);
        if (flags === 0 && !hasRules) continue;

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
        if (flags & FLAG_IGNITES) {
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
        if (flags & FLAG_EXPLOSIVE) {
          let touched = false;
          for (let k = 0; k < n; k++) {
            const nid = mat[nbuf[k]];
            if (nid === M.FIRE || nid === M.EMBER || nid === M.SPARK || nid === M.LAVA) { touched = true; break; }
          }
          if (touched) {
            this.blast.queue(x, y, 1.0, MATERIALS[id].explosive);
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
        if (flags & FLAG_FLAMMABLE) {
          // Only now do we need the material's object for the ignite/flammability
          // details (rare relative to the whole-grid scan, so the deref is cheap here).
          const d = MATERIALS[id];
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
            if (flags & FLAG_EXPLOSIVE) this.blast.queue(x, y, 1.0, d.explosive);
            g.convert(i, d.burnTo(), false); count++; continue;
          }
        }

        // 3) DATA-DRIVEN reactions: the generic engine handles all pairwise
        //    interactions declared in reaction_rules.js (lava+water, acid+base,
        //    cryo freezing, combustion bursts, dissolving, neutralization, ...).
        if (hasRules) {
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
    const { w, h, rowCount, life } = g;
    // life>=0 only on ephemeral non-empty cells, so an empty row is all life=-1.
    for (let y = 0; y < h; y++) {
      if (rowCount[y] === 0) continue;
      const rowBase = y * w, rowEnd = rowBase + w;
      for (let i = rowBase; i < rowEnd; i++) {
        if (life[i] < 0) continue;
        life[i]--;
        if (life[i] <= 0) {
          const d = MATERIALS[g.mat[i]];
          if (d.decayTo) g.convert(i, d.decayTo(), false);
          else g.convert(i, M.EMPTY, false);
        }
      }
    }
  }
}
