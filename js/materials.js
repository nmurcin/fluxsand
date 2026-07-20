// materials.js — the declarative material table. FROZEN CONTRACT.
//
// Every material is an integer id (index into MATERIALS). The sim stores only
// the id per cell (Uint16) plus temperature (Float32, degrees C) and an
// accumulated latent-energy buffer (Float32) used to stall phase changes.
//
// Thermal numbers are RELATIVE and calibrated against real water:
//   Real water: c_p ~= 4181 J/kg.K, latent heat of vaporization ~= 2.256 MJ/kg
//   (both from CoolProp at 1 atm). We scale so water's latentHeat dominates —
//   that's *why* a fire front visibly stalls when it hits water: the cell must
//   bank ~2.26 MJ/kg of energy before it may turn to steam.
//
// Phases: 'solid' (immovable unless melted), 'powder' (falls + piles at repose),
//         'liquid' (falls + spreads), 'gas' (rises + dissipates), 'empty'.

export const PHASE = { EMPTY: 0, POWDER: 1, LIQUID: 2, GAS: 3, SOLID: 4 };

// id constants — referenced by sim/reactions/scenarios. Keep in sync with order.
export const M = {
  EMPTY: 0,
  SAND: 1,
  WATER: 2,
  STONE: 3,
  LAVA: 4,
  ICE: 5,
  STEAM: 6,
  OIL: 7,
  FIRE: 8,
  WOOD: 9,
  METAL: 10,
  MOLTEN_METAL: 11,
  SMOKE: 12,
  OBSIDIAN: 13,
  EMBER: 14,
  ASH: 15,
  GLASS: 16,
  MOLTEN_GLASS: 17,
  ACID: 18,
  PLANT: 19,
  // --- expansion roster ---
  LIQUID_NITROGEN: 20,
  NITROGEN: 21,
  DRY_ICE: 22,
  CO2: 23,
  GUNPOWDER: 24,
  THERMITE: 25,
  GASOLINE: 26,
  MERCURY: 27,
  SNOW: 28,
  COAL: 29,
  SPARK: 30,
  WAX: 31,
  // companion products
  MOLTEN_WAX: 32,
  CONCRETE: 33,
  RUST: 34,
  NAPALM: 35,
  // blast/damage
  DENTED_METAL: 36,
  // --- pyrotechnics + emitters roster ---
  FUSE: 37,
  FUSE_LIT: 38,
  TNT: 39,
  WATER_SPOUT: 40,
  LAVA_SPOUT: 41,
  SAND_SOURCE: 42,
  // --- electricity roster ---
  COPPER: 43,
  LIVE_WIRE: 44,
};

// color: base RGB [r,g,b] at "cool" temperature.
// glow: if >0, cell emits incandescent light scaled by temperature (blackbody-ish).
// heatColor: if true, render blends toward incandescent orange/white when hot.
// density: for buoyancy ordering (higher sinks). Gases have low/negative-ish density.
// conduct: thermal conductivity multiplier (0..1) — how fast it exchanges heat.
// heatCap: relative specific heat — how much energy to change its temperature.
// melt/boil/ignite: threshold temps in C (null = not applicable).
// latentMelt/latentBoil: relative energy that must accumulate before the transition
//   completes (this is the "stall"). Water's latentBoil is intentionally huge.
// flammable: can be ignited by adjacent FIRE/EMBER/LAVA above ignite temp.
// lifetime: for ephemeral materials (FIRE, STEAM, SMOKE) — ticks before decay (0=none).

export const MATERIALS = [
  // 0 EMPTY (air) — a poor conductor, like real air/gas
  { id: 0, name: 'empty', phase: PHASE.EMPTY, color: [24, 20, 37], density: 0,
    conduct: 0.03, heatCap: 1.0, glow: 0 },

  // 1 SAND — warm ochre powder; melts to glass at high heat
  // heatCap 0.8: silica c_p ~700 J/kgK ~= 0.17x water; kept a touch high for feel.
  { id: 1, name: 'sand', phase: PHASE.POWDER, color: [228, 166, 114], density: 12,
    conduct: 0.22, heatCap: 0.8, melt: 1200, latentMelt: 90, meltTo: () => M.MOLTEN_GLASS,
    repose: 0.55, glow: 0 },

  // 2 WATER — translucent teal; freezes / boils with real-ratio latent heats.
  // latentFreeze 34 vs latentBoil 226 encodes real fusion:vaporization ~1:6.75.
  { id: 2, name: 'water', phase: PHASE.LIQUID, color: [0, 153, 219], density: 10,
    conduct: 0.55, heatCap: 4.18, freeze: 0, latentFreeze: 34,
    boil: 100, latentBoil: 226, boilTo: () => M.STEAM, freezeTo: () => M.ICE,
    quench: true, viscosity: 0.02, dispersion: 6, glow: 0 },

  // 3 STONE — inert solid; melts to lava. heatCap 1.0: basalt ~900 J/kgK ~= 0.22x water.
  { id: 3, name: 'stone', phase: PHASE.SOLID, color: [139, 155, 180], density: 40,
    conduct: 0.30, heatCap: 1.0, melt: 1150, latentMelt: 80, meltTo: () => M.LAVA, glow: 0 },

  // 4 LAVA — crimson->orange liquid; freezes to stone; ignites; melts metal on contact
  // viscosity 0.9: real basaltic lava is ~10^4-10^5x water viscosity — it creeps.
  { id: 4, name: 'lava', phase: PHASE.LIQUID, color: [247, 118, 34], density: 32,
    conduct: 0.30, heatCap: 1.0, freeze: 700, latentFreeze: 80, freezeTo: () => M.STONE,
    baseTemp: 1150, viscosity: 0.92, dispersion: 2, glow: 1.0, heatColor: true, ignitesNeighbors: true },

  // 5 ICE — pale solid; melts to water. latentMelt 34 = water's latent heat of fusion.
  { id: 5, name: 'ice', phase: PHASE.SOLID, color: [44, 232, 245], density: 9,
    conduct: 0.35, heatCap: 2.0, melt: 0, latentMelt: 34, meltTo: () => M.WATER,
    baseTemp: -12, glow: 0 },

  // 6 STEAM — luminous white gas; rises; condenses back to water when cool.
  // conduct 0.04: real steam k ~0.027 W/mK is ~22x below liquid water — gases are
  // the WORST conductors, so hot gas must NOT dump heat into neighbors quickly.
  { id: 6, name: 'steam', phase: PHASE.GAS, color: [192, 203, 220], density: 2,
    conduct: 0.04, heatCap: 2.0, condense: 90, condenseTo: () => M.WATER,
    baseTemp: 110, lifetime: 900, glow: 0.08 },

  // 7 OIL — dark iridescent liquid; highly flammable
  // viscosity 0.35: motor/crude oil is ~10-100x water — flows, but slower.
  { id: 7, name: 'oil', phase: PHASE.LIQUID, color: [115, 62, 57], density: 9,
    conduct: 0.20, heatCap: 1.9, flammable: true, ignite: 200, flammability: 0.10, burnTo: () => M.FIRE,
    viscosity: 0.30, dispersion: 4, glow: 0 },

  // 8 FIRE — hot plasma gas; short-lived; ignites; decays to smoke/ember.
  // conduct 0.05 (gas): fire heats neighbors via the strong CONTACT term in
  // igniteAround, not via bulk diffusion, so keep its diffusive conduct low.
  { id: 8, name: 'fire', phase: PHASE.GAS, color: [255, 137, 51], density: 1,
    conduct: 0.05, heatCap: 0.7, baseTemp: 820, glow: 1.0, heatColor: true,
    lifetime: 90, ignitesNeighbors: true, decayTo: () => M.SMOKE },

  // 9 WOOD — solid fuel; burns to ember/ash. Dry wood c_p is genuinely high (~1.0-1.6).
  { id: 9, name: 'wood', phase: PHASE.SOLID, color: [184, 111, 80], density: 20,
    conduct: 0.12, heatCap: 1.3, flammable: true, ignite: 280, flammability: 0.05, burnTo: () => M.EMBER,
    glow: 0 },

  // 10 METAL — steel solid; conducts heat fast; glows then melts.
  // heatCap 0.5: steel c_p ~500 J/kgK ~= 0.12x water; low cap => heats/melts readily.
  { id: 10, name: 'metal', phase: PHASE.SOLID, color: [168, 181, 178], density: 60,
    conduct: 0.92, heatCap: 0.5, melt: 1400, latentMelt: 120, meltTo: () => M.MOLTEN_METAL,
    heatColor: true, glow: 0 },

  // 11 MOLTEN_METAL — glowing liquid; freezes back to metal. viscosity 0.5:
  // molten steel is runnier than lava but still notably thicker than water.
  // ignitesNeighbors: molten metal at 1500C should light adjacent fuel like lava
  // does, not just heat it slowly through bulk diffusion (audit fix).
  { id: 11, name: 'molten_metal', phase: PHASE.LIQUID, color: [254, 174, 52], density: 55,
    conduct: 0.9, heatCap: 0.5, viscosity: 0.45, dispersion: 3, freeze: 1350, latentFreeze: 120, freezeTo: () => M.METAL,
    baseTemp: 1500, glow: 1.0, heatColor: true, ignitesNeighbors: true },

  // 12 SMOKE — gray gas; rises and dissipates. conduct 0.03 (gas, poor conductor).
  { id: 12, name: 'smoke', phase: PHASE.GAS, color: [90, 105, 136], density: 2,
    conduct: 0.03, heatCap: 1.0, baseTemp: 120, lifetime: 620, glow: 0 },

  // 13 OBSIDIAN — glassy black solid; made when lava is quenched by water.
  // melt 1200 (>= stone 1150): silica glass softens at/above basalt, not below.
  { id: 13, name: 'obsidian', phase: PHASE.SOLID, color: [24, 20, 37], density: 42,
    conduct: 0.28, heatCap: 1.0, melt: 1200, latentMelt: 90, meltTo: () => M.LAVA, glow: 0 },

  // 14 EMBER — glowing burning wood; radiates heat, decays to ash
  { id: 14, name: 'ember', phase: PHASE.SOLID, color: [162, 38, 51], density: 18,
    conduct: 0.3, heatCap: 1.2, baseTemp: 700, glow: 0.9, heatColor: true,
    lifetime: 260, ignitesNeighbors: true, decayTo: () => M.ASH },

  // 15 ASH — light gray powder residue
  { id: 15, name: 'ash', phase: PHASE.POWDER, color: [93, 93, 93], density: 6,
    conduct: 0.12, heatCap: 0.9, repose: 0.5, glow: 0 },

  // 16 GLASS — transparent-ish solid from cooled molten glass
  { id: 16, name: 'glass', phase: PHASE.SOLID, color: [192, 203, 220], density: 24,
    conduct: 0.3, heatCap: 0.8, melt: 1150, latentMelt: 90, meltTo: () => M.MOLTEN_GLASS, glow: 0 },

  // 17 MOLTEN_GLASS — glowing viscous liquid; freezes to glass
  { id: 17, name: 'molten_glass', phase: PHASE.LIQUID, color: [254, 174, 52], density: 22,
    conduct: 0.35, heatCap: 0.8, freeze: 1000, latentFreeze: 90, freezeTo: () => M.GLASS,
    baseTemp: 1250, viscosity: 0.97, dispersion: 1, glow: 0.9, heatColor: true },

  // 18 ACID — corrosive green liquid; dissolves stone/metal (stretch chemistry)
  // density 10: sinks under oil (9) so an acid+oil pair layers correctly.
  { id: 18, name: 'acid', phase: PHASE.LIQUID, color: [99, 199, 77], density: 10,
    conduct: 0.3, heatCap: 2.0, corrosive: true, viscosity: 0.06, dispersion: 5, glow: 0.05 },

  // 19 PLANT — green solid; grows into adjacent water, flammable
  { id: 19, name: 'plant', phase: PHASE.SOLID, color: [62, 137, 72], density: 14,
    conduct: 0.12, heatCap: 1.6, flammable: true, ignite: 230, flammability: 0.12, burnTo: () => M.EMBER,
    grows: true, glow: 0 },

  // ====================== EXPANSION ROSTER =============================
  // All CoolProp/textbook-grounded (see js docs). Reactions live in reaction_rules.js.

  // 20 LIQUID_NITROGEN — cryo liquid; boils at -196C into cold nitrogen gas.
  // density 7 (floats above oil 8/water 10). latentBoil 20: real LN2 latent vap
  // ~199 kJ/kg is tiny vs water's 2.26 MJ/kg, so it flashes off fast when warmed.
  // baseTemp -205 (below its -196 boil point) so a fresh pour stays liquid and
  // has time to flash-freeze neighbors before it warms up and boils to nitrogen.
  // density 6: floats on gasoline (7) and everything else — LN2 sits on top.
  { id: 20, name: 'liquid_nitrogen', phase: PHASE.LIQUID, color: [44, 232, 245], density: 6,
    conduct: 0.5, heatCap: 2.05, viscosity: 0.03, dispersion: 6, baseTemp: -205,
    boil: -196, latentBoil: 20, boilTo: () => M.NITROGEN, glow: 0 },

  // 21 NITROGEN — cold inert gas boiled off LN2; light, rises, dissipates.
  { id: 21, name: 'nitrogen', phase: PHASE.GAS, color: [192, 203, 220], density: 2,
    conduct: 0.04, heatCap: 1.04, baseTemp: -150, condense: -190, condenseTo: () => M.LIQUID_NITROGEN,
    lifetime: 500, glow: 0 },

  // 22 DRY_ICE — solid CO2; sublimates straight to CO2 gas at -78C (no liquid at 1 atm).
  { id: 22, name: 'dry_ice', phase: PHASE.SOLID, color: [255, 255, 255], density: 15,
    conduct: 0.25, heatCap: 0.85, baseTemp: -78, melt: -78, latentMelt: 25, meltTo: () => M.CO2, glow: 0 },

  // 23 CO2 — the HEAVIEST gas (density 5 > steam/smoke/nitrogen): sinks and pools,
  // creeping downhill to smother fire from below. Its signature novelty among gases.
  // color: a faint greenish-gray, distinct from metal/concrete grays so the
  // heavy fog reads as a gas, not a solid.
  { id: 23, name: 'co2', phase: PHASE.GAS, color: [139, 155, 180], density: 5,
    conduct: 0.04, heatCap: 0.85, baseTemp: 18, lifetime: 600, glow: 0 },

  // 24 GUNPOWDER — black powder; ignites ~200C, deflagrates + EXPLODES (via reactions).
  // flammability 0.9: a loose energetic powder catches fast once hot (dust-like).
  // explosive: 2 (blast radius per grain). A single grain now only DENTS steel;
  // a packed charge's merged, energy-scaled blast is what breaches (audit fix).
  { id: 24, name: 'gunpowder', phase: PHASE.POWDER, color: [58, 68, 102], density: 12,
    conduct: 0.15, heatCap: 1.0, repose: 0.5, flammable: true, ignite: 210, flammability: 0.9,
    explosive: 2, burnTo: () => M.FIRE, glow: 0 },

  // 25 THERMITE — inert powder until a very hot starter (>=900C) sets it off; then
  // reactions turn it into molten_metal at ~2500C, hot enough to melt through steel.
  // Low flammability (0.02): even at 900C+ it should need a dramatic starter, not a
  // stray hot cell — the spark/fire/ember/lava reaction rules are the intended path.
  { id: 25, name: 'thermite', phase: PHASE.POWDER, color: [184, 111, 80], density: 16,
    conduct: 0.2, heatCap: 0.9, repose: 0.55, flammable: true, ignite: 900, flammability: 0.02, burnTo: () => M.MOLTEN_METAL, glow: 0 },

  // 26 GASOLINE — very runny, lighter than water/oil (floats). Volatile: catches
  // readily above ~120C (flammability 0.60, like TPT GAS), so a spark flashes a whole
  // slick — but it no longer self-ignites at room temperature (ignite was 45C, a bug).
  { id: 26, name: 'gasoline', phase: PHASE.LIQUID, color: [234, 212, 170], density: 7,
    conduct: 0.2, heatCap: 1.1, viscosity: 0.01, dispersion: 7, flammable: true, ignite: 120, flammability: 0.60, burnTo: () => M.FIRE, glow: 0 },

  // 27 MERCURY — the DENSEST material: density 136 (real Hg SG 13.6, on the water=10
  // scale) so it sinks under LITERALLY everything, even solid metal grains falling in
  // float up. Near-zero heatCap (0.14) => snaps to any temperature instantly.
  { id: 27, name: 'mercury', phase: PHASE.LIQUID, color: [192, 203, 220], density: 136,
    conduct: 0.85, heatCap: 0.14, viscosity: 0.08, dispersion: 5,
    boil: 357, latentBoil: 15, boilTo: () => M.SMOKE, glow: 0 },

  // 28 SNOW — lightest powder (4); heaps into steep drifts; melts to water easily; insulator.
  { id: 28, name: 'snow', phase: PHASE.POWDER, color: [255, 255, 255], density: 4,
    conduct: 0.15, heatCap: 2.0, repose: 0.7, baseTemp: -5, melt: 0, latentMelt: 20, meltTo: () => M.WATER, glow: 0 },

  // 29 COAL — solid fuel; high ignite (400C); burns to a long-lived ember (forge fuel).
  // ignite 480, flam 0.015: coal is near-impossible to light with a match — needs
  // sustained high heat (the coal+fire reaction >700C is the intended path). Burns
  // to a long, low, glowing ember bed (forge fuel).
  { id: 29, name: 'coal', phase: PHASE.SOLID, color: [38, 43, 68], density: 22,
    conduct: 0.1, heatCap: 1.3, flammable: true, ignite: 480, flammability: 0.015, burnTo: () => M.EMBER, glow: 0 },

  // 30 SPARK — electric arc; brilliant, ephemeral (lifetime 6), STATIC (doesn't
  // drift — propagates by reaction, jumping along metal/mercury conductors).
  { id: 30, name: 'spark', phase: PHASE.GAS, color: [254, 231, 97], density: 1,
    conduct: 0.1, heatCap: 0.5, baseTemp: 600, lifetime: 6, static: true,
    glow: 1.0, heatColor: true, decayTo: () => M.EMPTY },

  // 31 WAX — low-melt solid; liquefies at candle warmth (~60C) into molten_wax.
  // burnTo molten_wax: a candle MELTS then the liquid burns — solid wax shouldn't
  // teleport straight to flame (audit fix). molten_wax carries the flame.
  { id: 31, name: 'wax', phase: PHASE.SOLID, color: [234, 212, 170], density: 13,
    conduct: 0.1, heatCap: 1.6, melt: 60, latentMelt: 25, meltTo: () => M.MOLTEN_WAX,
    flammable: true, ignite: 245, flammability: 0.03, burnTo: () => M.MOLTEN_WAX, glow: 0 },

  // 32 MOLTEN_WAX — pale runny liquid; the actual "candle fuel". Behaves oil-like:
  // flam 0.20 so a wick burns steadily (was 0.06, too sluggish for a running fuel).
  { id: 32, name: 'molten_wax', phase: PHASE.LIQUID, color: [254, 231, 97], density: 12,
    conduct: 0.1, heatCap: 1.6, viscosity: 0.35, dispersion: 4, freeze: 55, latentFreeze: 20, freezeTo: () => M.WAX,
    flammable: true, ignite: 245, flammability: 0.20, burnTo: () => M.FIRE, glow: 0 },

  // 33 CONCRETE — cured solid; stone-like, inert.
  { id: 33, name: 'concrete', phase: PHASE.SOLID, color: [139, 155, 180], density: 40,
    conduct: 0.3, heatCap: 1.0, melt: 1150, latentMelt: 80, meltTo: () => M.LAVA, glow: 0 },

  // 34 RUST — flaky orange corrosion product of metal + water; acid-soluble.
  { id: 34, name: 'rust', phase: PHASE.POWDER, color: [190, 74, 47], density: 18,
    conduct: 0.2, heatCap: 1.0, repose: 0.5, glow: 0 },

  // 35 NAPALM — sticky flammable liquid; catches from any flame and self-reignites.
  { id: 35, name: 'napalm', phase: PHASE.LIQUID, color: [255, 137, 51], density: 10,
    conduct: 0.18, heatCap: 1.5, viscosity: 0.55, dispersion: 2, flammable: true, ignite: 160, flammability: 0.45, burnTo: () => M.FIRE, glow: 0 },

  // 36 DENTED_METAL — steel that a blast has buckled but not breached. A second
  // hit breaches it (-> empty). Visually darker/rougher than clean metal. Still a
  // solid; conducts and melts like metal.
  { id: 36, name: 'dented_metal', phase: PHASE.SOLID, color: [90, 105, 136], density: 60,
    conduct: 0.9, heatCap: 0.5, melt: 1400, latentMelt: 120, meltTo: () => M.MOLTEN_METAL,
    heatColor: true, glow: 0 },

  // ================== PYROTECHNICS + EMITTERS =========================
  // Reactions for these live in reaction_rules.js.

  // 37 FUSE — a solid cord that burns SLOWLY along its length. Unlike gunpowder
  // (a fast deflagrating powder), fuse is flammable-but-slow: reaction rules light
  // it at a LOW chance (~0.15) into a short-lived fuse_lit that decays to smoke and
  // ignites the next cell, so the flame visibly CREEPS at a controlled speed. Low
  // conduct + high ignite means stray heat won't run the whole line — only the
  // cell-to-cell reaction crawl does. NOT explosive.
  { id: 37, name: 'fuse', phase: PHASE.SOLID, color: [120, 90, 60], density: 16,
    conduct: 0.08, heatCap: 1.2, glow: 0 },

  // 38 FUSE_LIT — the burning node on a fuse cord. lifetime 25: a node must reliably
  // OUTLIVE the ~1/0.15≈6.7-tick expected handoff so the front never stalls mid-cord,
  // yet each cell still DWELLS (the slow crawl) rather than flashing. Glows/heats like
  // an ember, ignitesNeighbors so it can touch off an adjacent charge at the line's
  // end, then decays to smoke.
  { id: 38, name: 'fuse_lit', phase: PHASE.SOLID, color: [255, 137, 51], density: 16,
    conduct: 0.1, heatCap: 1.0, baseTemp: 650, glow: 0.9, heatColor: true,
    lifetime: 25, ignitesNeighbors: true, decayTo: () => M.SMOKE },

  // 39 TNT — packed high explosive. Solid so a charge stays put until lit. explosive:6
  // (blast radius per cell) vs gunpowder's 2, and the reactionPass explosive-contact
  // branch queues a blast keyed off this property, so a spark/fire touching TNT
  // detonates it instantly. blast.resolveAll cluster-merges a packed charge's cells
  // into ONE energy-scaled blast the same tick -> a real high-order bang that breaches
  // a sealed metal box in 1-2 ticks (contrast gunpowder's cell-by-cell deflagration).
  { id: 39, name: 'tnt', phase: PHASE.SOLID, color: [178, 44, 44], density: 20,
    conduct: 0.12, heatCap: 1.0, explosive: 6, glow: 0 },

  // 40 WATER_SPOUT — a fixed faucet. A static solid (won't move); a reaction rule
  // emits water into an adjacent EMPTY cell each tick at a metered chance. `static`
  // is a no-op on solids (they don't move anyway) but documents intent.
  { id: 40, name: 'water_spout', phase: PHASE.SOLID, color: [0, 90, 160], density: 80,
    conduct: 0.3, heatCap: 1.0, static: true, glow: 0 },

  // 41 LAVA_SPOUT — a fixed lava vent. Static solid; a reaction rule emits lava into
  // an adjacent EMPTY cell. baseTemp keeps the vent itself hot so emitted lava reads
  // molten immediately (lava seeds its own baseTemp on placement via grid.set).
  { id: 41, name: 'lava_spout', phase: PHASE.SOLID, color: [120, 40, 20], density: 80,
    conduct: 0.3, heatCap: 1.0, baseTemp: 1150, static: true, glow: 0.3, heatColor: true },

  // 42 SAND_SOURCE — a fixed hopper. Static solid; a reaction rule emits sand into an
  // adjacent EMPTY cell (a continuous sand faucet the player can place).
  { id: 42, name: 'sand_source', phase: PHASE.SOLID, color: [150, 110, 60], density: 80,
    conduct: 0.22, heatCap: 0.8, static: true, glow: 0 },

  // ====================== ELECTRICITY ==================================
  // Reactions for these live in reaction_rules.js. Copper carries a real
  // CURRENT: a spark energizes copper into live_wire, and live_wire races
  // down adjacent copper (chance-gated + short-lived so it can't fill the
  // grid). Flowing current warms the wire toward its melt point.

  // 43 COPPER — a solid conductor wire the player builds circuits from. Real
  // copper conducts even better than steel, so conduct 0.95 (> metal's 0.92);
  // heatCap 0.45 keeps it safely inside the DT_CLAMP envelope like metal (0.5),
  // so its high conductivity can't destabilize the explicit thermal solver.
  // melt 1085C (real Cu m.p.) -> reuses molten_metal (no dedicated molten_copper
  // needed). heatColor so it glows incandescent when a short-circuit heats it.
  // A coppery brown [199,120,60] distinct from the incandescent orange ramp.
  { id: 43, name: 'copper', phase: PHASE.SOLID, color: [199, 120, 60], density: 58,
    conduct: 0.95, heatCap: 0.45, melt: 1085, latentMelt: 110, meltTo: () => M.MOLTEN_METAL,
    heatColor: true, glow: 0 },

  // 44 LIVE_WIRE — the ENERGIZED copper node: the visible pulse of current in the
  // wire. A SOLID (stays in the wire, does NOT drift). Bright electric cyan-white
  // [140,240,255], glow 0.9, heatColor FALSE so it keeps its electric-blue look
  // instead of blending to fire-orange. lifetime 10: a pulse dwells in a cell then
  // reverts to copper (decayTo copper), so the current is transient and the wire
  // remains. baseTemp 320C: flowing current WARMS the copper (well below its 1085C
  // melt so a bare wire won't melt itself) — a sustained/looping current can still
  // drive a hotspot up toward melt via diffusion. ignitesNeighbors so a hot live
  // wire can touch off adjacent fuel by contact (electrical ignition); baseTemp is
  // low enough that this heats without self-destructing.
  { id: 44, name: 'live_wire', phase: PHASE.SOLID, color: [140, 240, 255], density: 58,
    conduct: 0.95, heatCap: 0.45, baseTemp: 320, glow: 0.9, heatColor: false,
    lifetime: 10, ignitesNeighbors: true, decayTo: () => M.COPPER },
];

// Fast lookup by name (used by tools/UI and scenarios).
export const BY_NAME = {};
for (const m of MATERIALS) BY_NAME[m.name] = m.id;

// Flat property LUTs indexed by material id. Hot loops (thermal diffusion,
// movement, reactions) read these typed arrays instead of dereferencing
// MATERIALS[id].prop per neighbor per cell — object property access in a
// w*h(*4) loop is one of the biggest JS costs, and a flat typed-array read is
// several times faster. Every hot-loop property a pass needs has a LUT here.
//
//   CONDUCT/HEATCAP  — thermal.js diffusion
//   PHASE/DENSITY    — sim.js movement (fall/float/sink ordering)
//   VISCOSITY/DISPERSION/REPOSE — sim.js liquid/powder flow (default when absent)
//   STATIC           — sim.js gas drift gate (spark/emitters don't drift)
//   RXN_FLAGS bitset — sim.js reactionPass fast-reject (ignites/explosive/flammable)
//
// Materials that don't declare a property get the SAME default the old per-cell
// code applied via `=== undefined ? default`, so the LUT read is a drop-in
// replacement — byte-identical behavior.
export const CONDUCT_LUT = new Float32Array(MATERIALS.length);
export const HEATCAP_LUT = new Float32Array(MATERIALS.length);
export const PHASE_LUT = new Uint8Array(MATERIALS.length);
export const DENSITY_LUT = new Float32Array(MATERIALS.length);
export const VISCOSITY_LUT = new Float32Array(MATERIALS.length);   // default 0.0
export const DISPERSION_LUT = new Uint8Array(MATERIALS.length);    // default 4
export const REPOSE_LUT = new Float32Array(MATERIALS.length);      // -1 == "no repose" sentinel
export const STATIC_LUT = new Uint8Array(MATERIALS.length);        // 1 if static
// Reaction-pass fast-reject flags (one bit each) so reactionPass can skip a
// plain cell's three special-branch checks with a single LUT read + mask.
export const FLAG_IGNITES = 1;
export const FLAG_EXPLOSIVE = 2;
export const FLAG_FLAMMABLE = 4;
export const RXN_FLAGS_LUT = new Uint8Array(MATERIALS.length);
for (const m of MATERIALS) {
  CONDUCT_LUT[m.id] = m.conduct;
  HEATCAP_LUT[m.id] = m.heatCap;
  PHASE_LUT[m.id] = m.phase;
  DENSITY_LUT[m.id] = m.density;
  VISCOSITY_LUT[m.id] = m.viscosity === undefined ? 0.0 : m.viscosity;
  DISPERSION_LUT[m.id] = m.dispersion === undefined ? 4 : m.dispersion;
  REPOSE_LUT[m.id] = m.repose === undefined ? -1 : m.repose;
  STATIC_LUT[m.id] = m.static ? 1 : 0;
  let f = 0;
  if (m.ignitesNeighbors) f |= FLAG_IGNITES;
  if (m.explosive) f |= FLAG_EXPLOSIVE;
  if (m.flammable && m.ignite !== undefined && m.burnTo) f |= FLAG_FLAMMABLE;
  RXN_FLAGS_LUT[m.id] = f;
}

// Palette shown in the dock (order matters for UI + number keys 1..9,0).
// First 10 map to keys 1-9,0; the rest are click-only in the dock.
export const PALETTE = [
  'sand', 'water', 'oil', 'lava', 'ice', 'wood', 'metal', 'stone', 'gasoline', 'fire',
  'liquid_nitrogen', 'gunpowder', 'thermite', 'spark', 'mercury', 'napalm', 'acid',
  'dry_ice', 'snow', 'coal', 'wax', 'concrete', 'plant',
  'fuse', 'tnt', 'water_spout', 'lava_spout', 'sand_source',
  'copper', 'live_wire',
];

export function matName(id) {
  return (MATERIALS[id] && MATERIALS[id].name) || 'empty';
}
export function phaseName(p) {
  return ['empty', 'powder', 'liquid', 'gas', 'solid'][p] || 'empty';
}
