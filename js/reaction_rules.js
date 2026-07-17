// reaction_rules.js — the declarative reaction matrix (DATA, not code).
//
// Each rule: when a cell of `a` is adjacent to `b` (a material name, a class
// 'any_liquid'|'any_gas'|'any_powder'|'any_solid'|'any', or 'empty'), with
// probability `chance` (and optional temp gates tempMin/tempMax on the actor),
// `a` becomes `a_into` and `b` becomes `b_into` ('keep' = unchanged, 'empty' =
// cleared). Optional a_temp/b_temp set product temps; `heat` is an exo(+)/endo(-)
// bump applied to both cells. See reactions.js for the full field reference.
//
// Rules are checked in registration order; the FIRST match for a cell fires and
// stops. Order matters — put specific/high-priority interactions first.
//
// Designed by a swarm (materials + systems + fluids specialists), grounded in
// CoolProp/textbook values, integrated + conflict-resolved by hand.

export const REACTION_RULES = [
  // ============ classic behaviors (ported from the old hardcoded sim) ============
  { a: 'lava', b: 'water', chance: 1, a_into: 'obsidian', b_into: 'steam',
    a_temp: 400, b_temp: 130, desc: 'lava meets water: obsidian crust + steam burst' },
  { a: 'water', b: 'fire', chance: 1, a_into: 'keep', b_into: 'smoke', heat: 30,
    desc: 'water snuffs fire into smoke' },
  { a: 'water', b: 'ember', chance: 1, a_into: 'keep', b_into: 'smoke', heat: 30,
    desc: 'water snuffs an ember into smoke' },
  { a: 'plant', b: 'water', chance: 0.02, a_into: 'keep', b_into: 'plant',
    desc: 'plant creeps into water' },
  { a: 'acid', b: 'metal', chance: 0.15, a_into: 'keep', b_into: 'empty', desc: 'acid eats metal' },
  { a: 'acid', b: 'stone', chance: 0.12, a_into: 'keep', b_into: 'empty', desc: 'acid eats stone' },
  { a: 'acid', b: 'concrete', chance: 0.10, a_into: 'keep', b_into: 'empty', desc: 'acid eats concrete' },
  { a: 'acid', b: 'sand', chance: 0.12, a_into: 'keep', b_into: 'empty', desc: 'acid eats sand' },
  { a: 'acid', b: 'wood', chance: 0.18, a_into: 'empty', b_into: 'empty', desc: 'acid dissolves wood, spent' },
  { a: 'acid', b: 'obsidian', chance: 0.02, a_into: 'keep', b_into: 'empty',
    desc: 'even obsidian slowly etches in acid' },

  // ============ CRYO — liquid nitrogen, dry ice, CO2, snow ============
  // LN2 flash-freezes any warmish foreign liquid to ice and boils to nitrogen gas.
  // tempMax -50: LN2 warms as it works, so allow it to keep reacting up to -50C.
  { a: 'liquid_nitrogen', b: 'any_liquid', chance: 0.85, tempMax: -50,
    a_into: 'nitrogen', b_into: 'ice', a_temp: -150, b_temp: -40, heat: -50,
    desc: 'LN2 flash-frost bloom: neighbor liquid snap-freezes to ice, LN2 boils off' },
  // LN2 boils off against hot gas plumes, chilling them (endothermic sink).
  { a: 'liquid_nitrogen', b: 'any_gas', chance: 0.6, tempMax: -50,
    a_into: 'nitrogen', b_into: 'keep', a_temp: -150, heat: -40,
    desc: 'LN2 boils into cold nitrogen against hot vapor, chilling the plume' },
  // The most dramatic quench in the box: LN2 slams lava to cold obsidian.
  { a: 'lava', b: 'liquid_nitrogen', chance: 1, a_into: 'obsidian', b_into: 'nitrogen',
    a_temp: 100, b_temp: -120, heat: -60, desc: 'cryo shock: lava cracks to cold obsidian' },
  // Dry ice sublimates to heavy CO2 fog on contact with liquid.
  { a: 'dry_ice', b: 'any_liquid', chance: 0.4, a_into: 'co2', b_into: 'keep',
    a_temp: -78, heat: -40, desc: 'dry ice fog-machine bloom over liquid' },
  // CO2 smothers fire and embers (heavy gas starves combustion).
  { a: 'co2', b: 'fire', chance: 0.9, a_into: 'co2', b_into: 'smoke', heat: -20,
    desc: 'CO2 smothers flame to smoke' },
  { a: 'co2', b: 'ember', chance: 0.5, a_into: 'co2', b_into: 'ash', heat: -20,
    desc: 'CO2 blanket starves an ember to ash' },
  // Snow slumps to water against anything above freezing.
  { a: 'snow', b: 'any_liquid', chance: 0.3, tempMin: 2, a_into: 'water', b_into: 'keep',
    heat: -5, desc: 'snow melts against warm liquid' },

  // ============ THERMITE — burns THROUGH metal at ~2500C ============
  { a: 'thermite', b: 'spark', chance: 1, a_into: 'molten_metal', b_into: 'fire',
    a_temp: 2500, heat: 1000, desc: 'spark ignites thermite into a molten-metal gush' },
  { a: 'thermite', b: 'fire', chance: 0.95, a_into: 'molten_metal', b_into: 'fire',
    a_temp: 2500, heat: 900, desc: 'thermite detonates into white-hot molten iron' },
  { a: 'thermite', b: 'ember', chance: 0.9, a_into: 'molten_metal', b_into: 'ember',
    a_temp: 2500, heat: 900, desc: 'a glowing ember touches off buried thermite' },
  { a: 'thermite', b: 'lava', chance: 0.9, a_into: 'molten_metal', b_into: 'keep',
    a_temp: 2500, heat: 900, desc: 'lava is hot enough to light thermite' },
  // Thermite cannot be put out by water — it just flashes it to steam.
  { a: 'thermite', b: 'water', chance: 0.9, tempMin: 1000, a_into: 'keep', b_into: 'steam',
    b_temp: 130, desc: 'burning thermite flashes water to steam and keeps going' },

  // ============ FUSE — a slow, controlled crawl (NOT a whoosh) ============
  // A lit fuse node (fuse_lit) or a stray flame lights an adjacent fuse cell at a
  // LOW per-tick chance (~0.15) into fuse_lit. Contrast gunpowder (~0.95): the low
  // chance means each next cell takes several ticks to catch, so the burning front
  // visibly CREEPS along the cord. fuse_lit is short-lived (lifetime 14) and decays
  // to smoke, and it ignitesNeighbors, so the flame hands off cell-to-cell down the
  // line at a steady, slow speed and can touch off a charge at the far end.
  { a: 'fuse', b: 'fuse_lit', chance: 0.15, a_into: 'fuse_lit', b_into: 'keep',
    a_temp: 650, desc: 'the burning fuse front slowly creeps to the next cord cell' },
  { a: 'fuse', b: 'fire', chance: 0.15, a_into: 'fuse_lit', b_into: 'keep',
    a_temp: 650, desc: 'a flame lights the fuse (slow catch)' },
  { a: 'fuse', b: 'ember', chance: 0.15, a_into: 'fuse_lit', b_into: 'keep',
    a_temp: 650, desc: 'an ember lights the fuse (slow catch)' },
  { a: 'fuse', b: 'spark', chance: 0.15, a_into: 'fuse_lit', b_into: 'empty',
    a_temp: 650, desc: 'a spark lights the fuse end (slow catch), spark spent' },
  { a: 'fuse', b: 'lava', chance: 0.15, a_into: 'fuse_lit', b_into: 'keep',
    a_temp: 650, desc: 'lava lights an adjacent fuse (slow catch)' },

  // ============ FUSES & FUELS — gunpowder, gasoline, napalm, coal, spark ============
  { a: 'gunpowder', b: 'spark', chance: 1, a_into: 'fire', b_into: 'fire',
    a_temp: 900, b_temp: 900, heat: 300, desc: 'spark flashes gunpowder to a double burst' },
  { a: 'gunpowder', b: 'fire', chance: 0.95, a_into: 'fire', b_into: 'fire',
    a_temp: 900, heat: 300, desc: 'flame races through a powder trail (deflagration)' },
  { a: 'gunpowder', b: 'ember', chance: 0.8, a_into: 'fire', b_into: 'ember',
    a_temp: 900, heat: 300, desc: 'an ember lights the powder trail' },
  { a: 'napalm', b: 'fire', chance: 0.8, a_into: 'fire', b_into: 'fire',
    a_temp: 950, heat: 200, desc: 'napalm catches into a sticky self-reigniting flame wall' },
  { a: 'napalm', b: 'ember', chance: 0.7, a_into: 'fire', b_into: 'ember',
    a_temp: 950, heat: 200, desc: 'embers light clingy napalm into a sustained sheet of fire' },
  // Spark: propagates through metal + mercury (a current), ignites fuels, fizzles in water.
  { a: 'spark', b: 'metal', chance: 0.6, a_into: 'spark', b_into: 'spark',
    desc: 'arc jumps along a metal wire — electricity races down a conductor' },
  { a: 'spark', b: 'mercury', chance: 0.7, a_into: 'spark', b_into: 'spark',
    desc: 'arc races along a liquid-mercury trace' },
  { a: 'spark', b: 'gasoline', chance: 1, a_into: 'empty', b_into: 'fire', b_temp: 820,
    desc: 'spark ignites a gasoline slick' },
  { a: 'spark', b: 'gunpowder', chance: 1, a_into: 'empty', b_into: 'fire', b_temp: 820,
    desc: 'remote spark detonator sets off gunpowder' },
  { a: 'spark', b: 'oil', chance: 0.8, a_into: 'empty', b_into: 'fire', b_temp: 820,
    desc: 'spark over oil ignites it (the fuel exception)' },
  { a: 'spark', b: 'napalm', chance: 1, a_into: 'empty', b_into: 'fire', b_temp: 900,
    desc: 'spark ignites napalm' },
  { a: 'spark', b: 'water', chance: 0.6, a_into: 'empty', b_into: 'keep',
    desc: 'electricity shorts out and dies in water (a firebreak)' },
  // Coal: slow to light, becomes a long, low, steady ember bed.
  { a: 'coal', b: 'fire', chance: 0.12, a_into: 'ember', b_into: 'fire', a_temp: 700, heat: 150,
    desc: 'coal catches into a long-lived glowing ember (forge fuel)' },
  { a: 'coal', b: 'ember', chance: 0.08, a_into: 'ember', b_into: 'ember', a_temp: 700, heat: 100,
    desc: 'an ember bed slowly lights adjacent coal' },
  // Wax: melts to burning oil-like fuel near flame (a dripping candle).
  { a: 'wax', b: 'fire', chance: 0.5, a_into: 'molten_wax', b_into: 'fire', a_temp: 90,
    desc: 'heat weeps wax into running flammable liquid' },

  // ============ CHEMISTRY — rust, mercury ============
  // Rust: metal slowly oxidizes in water; rust dissolves fast in acid.
  { a: 'metal', b: 'water', chance: 0.004, tempMin: 5, a_into: 'rust', b_into: 'keep',
    desc: 'steel left in water slowly rusts (time-lapse)' },
  { a: 'rust', b: 'acid', chance: 0.25, a_into: 'empty', b_into: 'keep',
    desc: 'acid eats corroded steel far faster than clean metal' },
  // Mercury amalgamates and consumes solid metal into more mercury.
  { a: 'mercury', b: 'metal', chance: 0.03, a_into: 'keep', b_into: 'mercury',
    desc: 'mercury amalgamates metal, creeping through machinery' },

  // ============ EMITTERS — fixed faucets / vents / hoppers ============
  // Each spout is a static solid that stays put (a_into 'keep') and, at a metered
  // per-tick chance (seeded rng, so fully deterministic), turns an adjacent EMPTY
  // cell into its product. The product then falls/flows/piles on its own via the
  // movement pass, giving a continuous faucet the player can place.
  { a: 'water_spout', b: 'empty', chance: 0.25, a_into: 'keep', b_into: 'water',
    desc: 'water faucet: emits water into adjacent empty space' },
  { a: 'lava_spout', b: 'empty', chance: 0.25, a_into: 'keep', b_into: 'lava',
    desc: 'lava vent: emits lava into adjacent empty space' },
  { a: 'sand_source', b: 'empty', chance: 0.25, a_into: 'keep', b_into: 'sand',
    desc: 'sand hopper: emits sand into adjacent empty space' },
];
