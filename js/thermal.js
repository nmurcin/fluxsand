// thermal.js — explicit finite-difference heat diffusion + latent-heat accumulator.
//
// Heat moves between 4-neighbors proportional to the harmonic-ish mean of their
// conductivities and their temperature difference. We use a double-buffer so the
// update is synchronous (Jacobi), and we clamp the effective diffusion number to
// keep the explicit scheme stable (alpha*dt/dx^2 <= STABLE).
//
// Phase changes are energy-gated: when a cell crosses a threshold, energy that
// WOULD raise its temperature past the threshold is instead banked into latent[i]
// until it reaches the material's latent budget — only then does it transmute.
// This is what makes a fire front visibly stall at water (water's latentBoil is
// huge, calibrated to real ~2.256 MJ/kg from CoolProp).

import { MATERIALS, M, PHASE, CONDUCT_LUT, HEATCAP_LUT } from './materials.js';

const STABLE = 0.22; // < 0.25 for 2D explicit stability, with margin

export class Thermal {
  constructor(grid) {
    this.g = grid;
    this.tempB = new Float32Array(grid.n); // scratch double-buffer
  }

  // One diffusion sub-step. dt is a fixed sim timestep (unitless, tuned).
  diffuse(dt = 1.0) {
    const g = this.g;
    const { w, h, mat, temp } = g;
    const B = this.tempB;
    const amb = g.ambient;

    // Read material conductivity/heatCap from flat typed-array LUTs (indexed by id)
    // rather than dereferencing MATERIALS[id].prop per neighbor per cell — the hot
    // loop runs w*h*4 conductivity reads per substep, so this is a large speedup.
    const CL = CONDUCT_LUT, HL = HEATCAP_LUT;
    const sdt = STABLE * dt;

    // ACTIVE-BAND SKIP: find the vertical span of rows that hold any non-ambient
    // temperature and only diffuse there (padded by 1 row for the gradient edge).
    // A large ambient region — the empty sky above most scenes — has zero flux, so
    // computing it is wasted work. This is the biggest win at higher resolution,
    // where idle cells dominate. Diffusion moves heat <=1 row/substep, so +1 pad
    // is exact; results are identical to scanning the whole grid.
    let yTop = h, yBot = -1;
    const EPS = 0.25; // temps within 0.25C of ambient are "idle"
    for (let y = 0; y < h; y++) {
      const rb = y * w;
      let active = false;
      for (let x = 0; x < w; x++) {
        const d = temp[rb + x] - amb;
        if (d > EPS || d < -EPS) { active = true; break; }
      }
      if (active) { if (y < yTop) yTop = y; if (y > yBot) yBot = y; }
    }
    if (yBot < 0) { this._activeTop = 0; this._activeBot = -1; return; } // fully ambient: nothing to do
    yTop = yTop > 0 ? yTop - 1 : 0;
    yBot = yBot < h - 1 ? yBot + 1 : h - 1;
    this._activeTop = yTop; this._activeBot = yBot;

    for (let y = yTop; y <= yBot; y++) {
      const rowBase = y * w;
      for (let x = 0; x < w; x++) {
        const i = rowBase + x;
        const ci = CL[mat[i]];
        const ti = temp[i];
        let flux = 0;

        // 4-neighborhood; out-of-bounds acts as ambient sink (walls lose heat slowly)
        if (x > 0) { const j = i - 1; flux += 0.5 * (ci + CL[mat[j]]) * (temp[j] - ti); }
        else flux += 0.02 * (amb - ti);
        if (x < w - 1) { const j = i + 1; flux += 0.5 * (ci + CL[mat[j]]) * (temp[j] - ti); }
        else flux += 0.02 * (amb - ti);
        if (y > 0) { const j = i - w; flux += 0.5 * (ci + CL[mat[j]]) * (temp[j] - ti); }
        else flux += 0.02 * (amb - ti);
        if (y < h - 1) { const j = i + w; flux += 0.5 * (ci + CL[mat[j]]) * (temp[j] - ti); }
        else flux += 0.02 * (amb - ti);

        // energy change -> temperature change, scaled by heat capacity
        const cap = HL[mat[i]];
        let dT = (sdt * flux) / (cap > 0.2 ? cap : 0.2);
        // clamp per-step delta to avoid oscillation on huge gradients
        if (dT > 40) dT = 40;
        else if (dT < -40) dT = -40;
        B[i] = ti + dT;
      }
    }
    // commit ONLY the active band we recomputed (the rest of B is stale)
    temp.set(B.subarray(yTop * w, (yBot + 1) * w), yTop * w);

    // AMBIENT RELAXATION (TPT-style): every cell drifts slowly toward room temp
    // each tick. This guarantees isolated hot cells decay and the whole grid can
    // never drift hot — the single most reliable guard against runaway heating.
    // Steady sources (lava, molten metal) below re-assert their own temperature,
    // so this only bleeds off stray/accumulated heat, not the sources themselves.
    // Only the active band can be non-ambient, so relax just that span.
    const lo = yTop * w, hi = (yBot + 1) * w;
    for (let i = lo; i < hi; i++) {
      const d = MATERIALS[mat[i]];
      if (d.id !== M.EMPTY) {
        temp[i] -= (temp[i] - amb) * 0.005 * dt;
      }
      // extra radiative loss for very hot cells (glow scales with heat)
      if (d.glow > 0 || temp[i] > 300) {
        const over = temp[i] - amb;
        temp[i] -= over * 0.0012 * dt;
      }
      // sources: materials with a baseTemp actively hold their heat (lava/fire/ember)
      if (d.baseTemp !== undefined && d.glow > 0 && d.lifetime === undefined) {
        // steady heat source (lava, molten metal/glass) — pin firmly to baseTemp so
        // it keeps radiating into neighbors instead of cooling itself off. Strong
        // coupling here is what lets a lava firebox actually boil a boiler of water.
        temp[i] += (d.baseTemp - temp[i]) * 0.25 * dt;
      } else if (d.baseTemp !== undefined && d.glow > 0 && d.lifetime !== undefined) {
        // ephemeral hot sources (fire, ember): hold their heat hard while alive so
        // they can dump energy downward into fuel/metal before they decay.
        temp[i] += (d.baseTemp - temp[i]) * 0.35 * dt;
      }
      // absolute-zero floor: exothermic/endothermic reaction bumps and cryo sources
      // must never drive a cell below -273.15C (physically impossible + corrupts
      // the solver). Clamp here so no code path can produce sub-zero-Kelvin temps.
      if (temp[i] < -273.15) temp[i] = -273.15;
    }
  }

  // Apply energy-gated phase transitions. Returns number of cells transmuted.
  phaseChanges(dt = 1.0) {
    const g = this.g;
    const { mat, temp, latent } = g;
    let changes = 0;

    for (let i = 0; i < g.n; i++) {
      const id = mat[i];
      if (id === M.EMPTY) continue;
      const d = MATERIALS[id];
      const t = temp[i];

      // MELT (solid/powder -> liquid) when temp exceeds melt point
      if (d.melt !== undefined && t >= d.melt && d.meltTo) {
        latent[i] += (t - d.melt) * 0.5 * dt;
        if (latent[i] >= (d.latentMelt || 1)) {
          g.convert(i, d.meltTo(), true);
          changes++;
          continue;
        }
      } else if (d.melt !== undefined) {
        // bleed latent back down when below threshold
        if (latent[i] > 0) latent[i] = Math.max(0, latent[i] - 0.6 * dt);
      }

      // BOIL (liquid -> gas)
      if (d.boil !== undefined && t >= d.boil && d.boilTo) {
        latent[i] += (t - d.boil) * 0.5 * dt;
        if (latent[i] >= (d.latentBoil || 1)) {
          // boiling consumes latent heat: the new gas starts near boil temp, not superheated
          const gasId = d.boilTo();
          g.convert(i, gasId, false);
          changes++;
          continue;
        } else {
          // while banking latent heat, the cell is pinned near boiling and
          // acts as a heat SINK — this is the "fire stalls at water" behavior
          if (temp[i] > d.boil) temp[i] = d.boil + 1;
        }
      } else if (d.boil !== undefined) {
        if (latent[i] > 0) latent[i] = Math.max(0, latent[i] - 0.6 * dt);
      }

      // FREEZE (liquid -> solid) when temp drops below freeze point
      if (d.freeze !== undefined && t <= d.freeze && d.freezeTo) {
        latent[i] += (d.freeze - t) * 0.5 * dt;
        if (latent[i] >= (d.latentFreeze || 1)) {
          g.convert(i, d.freezeTo(), true);
          changes++;
          continue;
        }
      } else if (d.freeze !== undefined) {
        if (latent[i] > 0) latent[i] = Math.max(0, latent[i] - 0.6 * dt);
      }

      // CONDENSE (gas -> liquid) when a gas cools below its condense point
      if (d.condense !== undefined && t <= d.condense && d.condenseTo) {
        g.convert(i, d.condenseTo(), true);
        changes++;
        continue;
      }
    }
    return changes;
  }

  // Total thermal energy proxy (sum of heatCap*temp over non-empty cells).
  // Used by the test harness to assert energy conservation (no numerical drift).
  totalEnergy() {
    const g = this.g;
    let e = 0;
    for (let i = 0; i < g.n; i++) {
      const d = MATERIALS[g.mat[i]];
      if (d.id === M.EMPTY) continue;
      e += d.heatCap * (g.temp[i] - g.ambient);
    }
    return e;
  }
}
