// reaction_rules.js — the declarative reaction matrix (DATA, not code).
//
// Each rule: when a cell of `a` is adjacent to `b` (a material name, a class
// 'any_liquid'|'any_gas'|'any_powder'|'any_solid'|'any', or 'empty'), with
// probability `chance` (and optional temp gates), `a` becomes `a_into` and `b`
// becomes `b_into`. See reactions.js for the full field reference.
//
// Rules are checked in order; the first match for a cell fires. Order matters:
// put specific/high-priority interactions before broad ones.
//
// This file starts as the faithful port of the original hardcoded reactions;
// the expansion swarm's new-material interactions are appended below.

export const REACTION_RULES = [
  // --- classic behaviors, ported verbatim from the old hardcoded sim ---

  // Lava quenched by water -> obsidian (lava side) + steam (water side).
  { a: 'lava', b: 'water', chance: 1, a_into: 'obsidian', b_into: 'steam',
    a_temp: 400, b_temp: 130, desc: 'lava meets water: obsidian crust + steam burst' },

  // Water quenches fire and ember -> smoke, and the water heats up.
  { a: 'water', b: 'fire', chance: 1, a_into: 'keep', b_into: 'smoke',
    heat: 30, desc: 'water snuffs fire into smoke' },
  { a: 'water', b: 'ember', chance: 1, a_into: 'keep', b_into: 'smoke',
    heat: 30, desc: 'water snuffs an ember into smoke' },

  // Plant slowly grows into adjacent water.
  { a: 'plant', b: 'water', chance: 0.02, a_into: 'keep', b_into: 'plant',
    desc: 'plant creeps into water' },

  // Acid corrodes stone / metal / sand / wood (consumes the neighbor; acid
  // sometimes spent). Modeled as two rules: destroy neighbor, sometimes vanish.
  { a: 'acid', b: 'metal', chance: 0.15, a_into: 'keep', b_into: 'empty',
    desc: 'acid eats through metal' },
  { a: 'acid', b: 'stone', chance: 0.12, a_into: 'keep', b_into: 'empty',
    desc: 'acid eats through stone' },
  { a: 'acid', b: 'sand', chance: 0.12, a_into: 'keep', b_into: 'empty',
    desc: 'acid eats through sand' },
  { a: 'acid', b: 'wood', chance: 0.18, a_into: 'empty', b_into: 'empty',
    desc: 'acid dissolves wood and is spent' },
];
