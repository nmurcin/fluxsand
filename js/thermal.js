// thermal.js — explicit finite-difference heat diffusion + latent-heat accumulator.
//
// Heat moves between 4-neighbors proportional to the mean of their conductivities
// and their temperature difference. We use a double-buffer so the update is
// synchronous (Jacobi).
//
// STABILITY — READ BEFORE TOUCHING THE CLAMP.  This is an EXPLICIT scheme, and
// with the material table's real conductivity/heatCap ratios it is NOT
// unconditionally stable: the effective per-step factor sdt*Sum(conduct)/heatCap
// exceeds 1 for the high-conductivity/low-heatCap metals (metal ~1.6, molten/
// dented metal ~1.6, mercury ~3.7). Left unbounded, those cells would ring and —
// for mercury — diverge to +/-Infinity, which would poison temp[] and corrupt the
// deterministic stateHash. What actually holds the scheme together is the
// PER-STEP dT CLAMP below (DT_CLAMP): it is a LOAD-BEARING stabilizer, not a
// cosmetic safety margin. STABLE (0.22) alone is INSUFFICIENT for those metals —
// do not remove or loosen DT_CLAMP thinking STABLE covers it. (If you ever want a
// truly unconditionally-stable scheme, normalize the 4-neighbor flux by ~1/4 and
// re-tune STABLE + the source-coupling rates, then re-baseline stateHash and the
// visual/behavior fixtures deliberately — that is a stateHash-changing change.)
//
// Phase changes are energy-gated: when a cell crosses a threshold, energy that
// WOULD raise its temperature past the threshold is instead banked into latent[i]
// until it reaches the material's latent budget — only then does it transmute.
// This is what makes a fire front visibly stall at water (water's latentBoil is
// huge, calibrated to real ~2.256 MJ/kg from CoolProp).

import { MATERIALS, M, PHASE, CONDUCT_LUT, HEATCAP_LUT } from './materials.js';

// STABLE: the diffusion-number scale for the flux term. NOTE this is NOT by
// itself sufficient for 2D explicit stability across the whole material table
// (see the header) — the DT_CLAMP below is what actually bounds the update.
const STABLE = 0.22;
// DT_CLAMP: the load-bearing per-substep temperature-change limit (deg C). This
// is what keeps the explicit scheme stable for high-conductivity/low-heatCap
// materials (metal, mercury); it is NOT a cosmetic outlier guard. See header.
const DT_CLAMP = 40;

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

        // 4-neighborhood; out-of-bounds acts as ambient sink (walls lose heat slowly).
        // Air (EMPTY) keeps its genuine low conductivity (0.03) so it still transmits
        // heat across a thin gap between solids (e.g. lava->stone->air->metal floor in
        // the Steam boiler). What stops air from HOARDING that heat — the actual bug —
        // is the fast ambient relaxation of empty cells in the pass below, not a change
        // to how much flux crosses air here.
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
        // LOAD-BEARING per-step clamp (see header + DT_CLAMP): bounds the explicit
        // update so high-conductivity/low-heatCap cells (metal, mercury) can't ring
        // or diverge. In the shipped config dT is always finite here, so the
        // NaN/Infinity guard below never fires — it exists purely so that if a
        // future edit ever loosens this clamp and lets a cell blow up, the bad
        // value is contained at DT_CLAMP instead of poisoning temp[] (and thus the
        // deterministic stateHash) with NaN/Infinity. A cheap, always-safe backstop.
        if (dT !== dT || dT > DT_CLAMP) dT = DT_CLAMP;      // dT!==dT catches NaN
        else if (dT < -DT_CLAMP) dT = -DT_CLAMP;
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
    const EMPTY = M.EMPTY;
    for (let i = lo; i < hi; i++) {
      const d = MATERIALS[mat[i]];
      if (d.id === EMPTY) {
        // AIR RELAXATION — the core of the "air too hot" fix. Air has negligible
        // thermal mass, so OPEN air (exposed to sky) should never sit hot: we snap
        // it hard toward ambient every tick. Before this, empty cells accumulated
        // diffused heat with no relaxation and open sky next to lava crept to ~1100C.
        //
        // BUT a thin air GAP that forms a clean CHANNEL between two solid/liquid
        // faces is a genuine conduction bridge (e.g. the Steam boiler's
        // lava->stone->air->metal floor). If we snapped that gap to ambient too it
        // would insulate the boiler and the water never boils. A clean channel has
        // solids on exactly ONE opposite pair (up&down OR left&right) while the
        // PERPENDICULAR pair stays open (the gap continues sideways) — a 1-cell sheet
        // of air pressed between two plates. That air relaxes only gently so it can
        // carry heat across.
        //
        // A dead-end POCKET (3-4 solid sides, e.g. air trapped in the volcano's rock
        // wall) is NOT a useful bridge — heat flows in but nowhere cooler to go — so
        // it must relax fast like open air, or it hoards heat to hundreds of C. The
        // `!perp` guards below exclude those pockets: the moment a third side is
        // solid, the channel test fails and the cell snaps to ambient.
        const x = i % w, y = (i / w) | 0;
        const upSolid = (y > 0)     && mat[i - w] !== EMPTY;
        const dnSolid = (y < h - 1) && mat[i + w] !== EMPTY;
        const lfSolid = (x > 0)     && mat[i - 1] !== EMPTY;
        const rtSolid = (x < w - 1) && mat[i + 1] !== EMPTY;
        const channel = (upSolid && dnSolid && !lfSolid && !rtSolid) ||
                        (lfSolid && rtSolid && !upSolid && !dnSolid);
        const rate = channel ? 0.02 : 0.4; // thin gap conducts; open air / pocket snaps
        let e = temp[i] - amb;
        e -= e * rate * dt;
        temp[i] = amb + e;
        continue;
      } else {
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
    const { mat, temp, latent, rowCount, w, h } = g;
    let changes = 0;

    // Row-skip empty rows (every cell there would `continue` on EMPTY anyway).
    for (let y = 0; y < h; y++) {
      if (rowCount[y] === 0) continue;
      const rowBase = y * w, rowEnd = rowBase + w;
      for (let i = rowBase; i < rowEnd; i++) {
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
      } // inner per-cell loop
    } // per-row loop
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
