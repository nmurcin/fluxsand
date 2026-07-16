// reactions.js — data-driven reaction engine.
//
// Reactions are declared as plain data (in reaction_rules.js), referenced by
// material NAME, and compiled here into fast id-indexed lookup tables. One
// generic apply() replaces all the old hardcoded `if (id === M.LAVA)` cases,
// so adding an interaction is a data edit, not a code edit.
//
// Rule shape (all fields optional except a, b, chance, a_into, b_into):
//   {
//     a:      'lava',            // the ACTING cell's material name
//     b:      'water',           // neighbor: a material name, a CLASS
//                                //   ('any_liquid'|'any_gas'|'any_powder'|
//                                //    'any_solid'|'any'), or 'empty'
//     tempMin: 100,             // only if acting cell temp >= this (degC)
//     tempMax: 0,               // only if acting cell temp <= this (degC)
//     bTempMin/bTempMax: ...,   // optional gate on the NEIGHBOR's temp
//     chance:  0.5,             // per-tick probability (seeded rng)
//     a_into:  'obsidian',      // what 'a' becomes ('keep' | 'empty' | name)
//     b_into:  'steam',         // what 'b' becomes ('keep' | 'empty' | name)
//     a_temp:  400,             // optional: set product-a temp (degC)
//     b_temp:  130,             // optional: set product-b temp (degC)
//     heat:    50,              // optional: exo(+)/endo(-) bump added to BOTH (degC)
//   }
//
// Determinism: the ONLY randomness is the injected seeded rng. Rules are checked
// in registration order; the first matching rule for a cell fires and stops.

import { MATERIALS, M, PHASE, BY_NAME } from './materials.js';

const CLASS = {
  any: () => true,
  any_liquid: (d) => d.phase === PHASE.LIQUID,
  any_gas: (d) => d.phase === PHASE.GAS,
  any_powder: (d) => d.phase === PHASE.POWDER,
  any_solid: (d) => d.phase === PHASE.SOLID,
  empty: (d) => d.id === M.EMPTY,
};

function resolveId(name) {
  if (name === 'keep') return -1;      // sentinel: leave material unchanged
  if (name === 'empty') return M.EMPTY;
  const id = BY_NAME[name];
  return id === undefined ? null : id;
}

export class ReactionEngine {
  constructor(rules) {
    // Compile: index rules by acting-material id for O(rules-for-this-material) lookup.
    this.byActor = new Map(); // actorId -> array of compiled rules
    this.warnings = [];
    for (const r of rules) this._compile(r);
  }

  _compile(r) {
    const aId = BY_NAME[r.a];
    if (aId === undefined) { this.warnings.push(`reaction actor '${r.a}' not a material`); return; }

    // neighbor matcher: either a class predicate or a specific id
    let bMatch, bId = null;
    if (CLASS[r.b]) { bMatch = CLASS[r.b]; }
    else {
      bId = BY_NAME[r.b];
      if (bId === undefined) { this.warnings.push(`reaction neighbor '${r.b}' not a material/class`); return; }
      bMatch = (d) => d.id === bId;
    }

    const aInto = resolveId(r.a_into);
    const bInto = resolveId(r.b_into);
    if (aInto === null) { this.warnings.push(`reaction a_into '${r.a_into}' unknown`); return; }
    if (bInto === null) { this.warnings.push(`reaction b_into '${r.b_into}' unknown`); return; }

    const compiled = {
      bId, bMatch,
      tempMin: r.tempMin, tempMax: r.tempMax,
      bTempMin: r.bTempMin, bTempMax: r.bTempMax,
      chance: r.chance === undefined ? 1 : r.chance,
      aInto, bInto,
      aTemp: r.a_temp, bTemp: r.b_temp,
      heat: r.heat || 0,
      desc: r.desc || '',
    };
    if (!this.byActor.has(aId)) this.byActor.set(aId, []);
    this.byActor.get(aId).push(compiled);
  }

  hasRules(actorId) {
    return this.byActor.has(actorId);
  }

  // Try to react cell i (material actorId at x,y) with one of its neighbors.
  // Returns 1 if a reaction fired, else 0. `neighborsOf` returns [indices].
  apply(grid, rng, x, y, i, actorId, neighborIdxs) {
    const rules = this.byActor.get(actorId);
    if (!rules) return 0;
    const aTempC = grid.temp[i];

    for (let ri = 0; ri < rules.length; ri++) {
      const r = rules[ri];
      if (r.tempMin !== undefined && aTempC < r.tempMin) continue;
      if (r.tempMax !== undefined && aTempC > r.tempMax) continue;

      // scan neighbors for a match (deterministic order = neighborIdxs order)
      for (let k = 0; k < neighborIdxs.length; k++) {
        const j = neighborIdxs[k];
        const bDef = MATERIALS[grid.mat[j]];
        if (r.bId !== null) { if (bDef.id !== r.bId) continue; }
        else if (!r.bMatch(bDef)) continue;

        const bTempC = grid.temp[j];
        if (r.bTempMin !== undefined && bTempC < r.bTempMin) continue;
        if (r.bTempMax !== undefined && bTempC > r.bTempMax) continue;

        // gate on probability LAST (so rng is only consumed on an otherwise-valid match)
        if (r.chance < 1 && !rng.chance(r.chance)) continue;

        // fire the reaction
        if (r.aInto !== -1) { grid.convert(i, r.aInto, false); }
        if (r.aTemp !== undefined) grid.temp[i] = r.aTemp;
        if (r.bInto !== -1) { grid.convert(j, r.bInto, false); }
        if (r.bTemp !== undefined) grid.temp[j] = r.bTemp;
        if (r.heat) { grid.temp[i] += r.heat; grid.temp[j] += r.heat; }
        return 1;
      }
    }
    return 0;
  }
}
