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
  SALT: 14,
  EMBER: 15,
  ASH: 16,
  GLASS: 17,
  MOLTEN_GLASS: 18,
  ACID: 19,
  PLANT: 20,
  // --- expansion roster ---
  LIQUID_NITROGEN: 21,
  NITROGEN: 22,
  DRY_ICE: 23,
  CO2: 24,
  GUNPOWDER: 25,
  THERMITE: 26,
  GASOLINE: 27,
  TAR: 28,
  MERCURY: 29,
  LYE: 30,
  SNOW: 31,
  COAL: 32,
  CONCRETE_WET: 33,
  SPARK: 34,
  MOLD: 35,
  WAX: 36,
  // companion products
  MOLTEN_WAX: 37,
  CONCRETE: 38,
  RUST: 39,
  NAPALM: 40,
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
  { id: 0, name: 'empty', phase: PHASE.EMPTY, color: [11, 13, 18], density: 0,
    conduct: 0.03, heatCap: 1.0, glow: 0 },

  // 1 SAND — warm ochre powder; melts to glass at high heat
  // heatCap 0.8: silica c_p ~700 J/kgK ~= 0.17x water; kept a touch high for feel.
  { id: 1, name: 'sand', phase: PHASE.POWDER, color: [201, 164, 92], density: 12,
    conduct: 0.22, heatCap: 0.8, melt: 1200, latentMelt: 90, meltTo: () => M.MOLTEN_GLASS,
    repose: 0.55, glow: 0 },

  // 2 WATER — translucent teal; freezes / boils with real-ratio latent heats.
  // latentFreeze 34 vs latentBoil 226 encodes real fusion:vaporization ~1:6.75.
  { id: 2, name: 'water', phase: PHASE.LIQUID, color: [58, 132, 178], density: 10,
    conduct: 0.55, heatCap: 4.18, freeze: 0, latentFreeze: 34,
    boil: 100, latentBoil: 226, boilTo: () => M.STEAM, freezeTo: () => M.ICE,
    quench: true, viscosity: 0.02, glow: 0 },

  // 3 STONE — inert solid; melts to lava. heatCap 1.0: basalt ~900 J/kgK ~= 0.22x water.
  { id: 3, name: 'stone', phase: PHASE.SOLID, color: [110, 112, 122], density: 40,
    conduct: 0.30, heatCap: 1.0, melt: 1150, latentMelt: 80, meltTo: () => M.LAVA, glow: 0 },

  // 4 LAVA — crimson->orange liquid; freezes to stone; ignites; melts metal on contact
  // viscosity 0.9: real basaltic lava is ~10^4-10^5x water viscosity — it creeps.
  { id: 4, name: 'lava', phase: PHASE.LIQUID, color: [190, 52, 28], density: 32,
    conduct: 0.30, heatCap: 1.0, freeze: 700, latentFreeze: 80, freezeTo: () => M.STONE,
    baseTemp: 1150, viscosity: 0.9, glow: 1.0, heatColor: true, ignitesNeighbors: true },

  // 5 ICE — pale solid; melts to water. latentMelt 34 = water's latent heat of fusion.
  { id: 5, name: 'ice', phase: PHASE.SOLID, color: [176, 214, 232], density: 9,
    conduct: 0.35, heatCap: 2.0, melt: 0, latentMelt: 34, meltTo: () => M.WATER,
    baseTemp: -12, glow: 0 },

  // 6 STEAM — luminous white gas; rises; condenses back to water when cool.
  // conduct 0.04: real steam k ~0.027 W/mK is ~22x below liquid water — gases are
  // the WORST conductors, so hot gas must NOT dump heat into neighbors quickly.
  { id: 6, name: 'steam', phase: PHASE.GAS, color: [214, 224, 232], density: 2,
    conduct: 0.04, heatCap: 2.0, condense: 90, condenseTo: () => M.WATER,
    baseTemp: 110, lifetime: 900, glow: 0.08 },

  // 7 OIL — dark iridescent liquid; highly flammable
  // viscosity 0.35: motor/crude oil is ~10-100x water — flows, but slower.
  { id: 7, name: 'oil', phase: PHASE.LIQUID, color: [70, 54, 40], density: 8,
    conduct: 0.20, heatCap: 1.9, flammable: true, ignite: 180, burnTo: () => M.FIRE,
    viscosity: 0.35, glow: 0 },

  // 8 FIRE — hot plasma gas; short-lived; ignites; decays to smoke/ember.
  // conduct 0.05 (gas): fire heats neighbors via the strong CONTACT term in
  // igniteAround, not via bulk diffusion, so keep its diffusive conduct low.
  { id: 8, name: 'fire', phase: PHASE.GAS, color: [255, 148, 42], density: 1,
    conduct: 0.05, heatCap: 0.7, baseTemp: 820, glow: 1.0, heatColor: true,
    lifetime: 90, ignitesNeighbors: true, decayTo: () => M.SMOKE },

  // 9 WOOD — solid fuel; burns to ember/ash. Dry wood c_p is genuinely high (~1.0-1.6).
  { id: 9, name: 'wood', phase: PHASE.SOLID, color: [120, 82, 46], density: 20,
    conduct: 0.12, heatCap: 1.3, flammable: true, ignite: 250, burnTo: () => M.EMBER,
    glow: 0 },

  // 10 METAL — steel solid; conducts heat fast; glows then melts.
  // heatCap 0.5: steel c_p ~500 J/kgK ~= 0.12x water; low cap => heats/melts readily.
  { id: 10, name: 'metal', phase: PHASE.SOLID, color: [150, 158, 170], density: 60,
    conduct: 0.92, heatCap: 0.5, melt: 1400, latentMelt: 120, meltTo: () => M.MOLTEN_METAL,
    heatColor: true, glow: 0 },

  // 11 MOLTEN_METAL — glowing liquid; freezes back to metal. viscosity 0.5:
  // molten steel is runnier than lava but still notably thicker than water.
  { id: 11, name: 'molten_metal', phase: PHASE.LIQUID, color: [232, 120, 40], density: 55,
    conduct: 0.9, heatCap: 0.5, viscosity: 0.5, freeze: 1350, latentFreeze: 120, freezeTo: () => M.METAL,
    baseTemp: 1500, glow: 1.0, heatColor: true },

  // 12 SMOKE — gray gas; rises and dissipates. conduct 0.03 (gas, poor conductor).
  { id: 12, name: 'smoke', phase: PHASE.GAS, color: [80, 82, 90], density: 2,
    conduct: 0.03, heatCap: 1.0, baseTemp: 120, lifetime: 620, glow: 0 },

  // 13 OBSIDIAN — glassy black solid; made when lava is quenched by water.
  // melt 1200 (>= stone 1150): silica glass softens at/above basalt, not below.
  { id: 13, name: 'obsidian', phase: PHASE.SOLID, color: [28, 24, 38], density: 42,
    conduct: 0.28, heatCap: 1.0, melt: 1200, latentMelt: 90, meltTo: () => M.LAVA, glow: 0 },

  // 14 SALT — white powder; lowers water freeze point (chemistry nod), melts high
  { id: 14, name: 'salt', phase: PHASE.POWDER, color: [225, 226, 232], density: 11,
    conduct: 0.2, heatCap: 1.3, repose: 0.6, dissolves: true, glow: 0 },

  // 15 EMBER — glowing burning wood; radiates heat, decays to ash
  { id: 15, name: 'ember', phase: PHASE.SOLID, color: [206, 74, 30], density: 18,
    conduct: 0.3, heatCap: 1.2, baseTemp: 700, glow: 0.9, heatColor: true,
    lifetime: 260, ignitesNeighbors: true, decayTo: () => M.ASH },

  // 16 ASH — light gray powder residue
  { id: 16, name: 'ash', phase: PHASE.POWDER, color: [96, 92, 92], density: 6,
    conduct: 0.12, heatCap: 0.9, repose: 0.5, glow: 0 },

  // 17 GLASS — transparent-ish solid from cooled molten glass
  { id: 17, name: 'glass', phase: PHASE.SOLID, color: [150, 196, 200], density: 24,
    conduct: 0.3, heatCap: 0.8, melt: 1150, latentMelt: 90, meltTo: () => M.MOLTEN_GLASS, glow: 0 },

  // 18 MOLTEN_GLASS — glowing viscous liquid; freezes to glass
  { id: 18, name: 'molten_glass', phase: PHASE.LIQUID, color: [230, 150, 90], density: 22,
    conduct: 0.35, heatCap: 0.8, freeze: 1000, latentFreeze: 90, freezeTo: () => M.GLASS,
    baseTemp: 1250, viscosity: 0.96, glow: 0.9, heatColor: true },

  // 19 ACID — corrosive green liquid; dissolves stone/metal (stretch chemistry)
  { id: 19, name: 'acid', phase: PHASE.LIQUID, color: [120, 210, 60], density: 9,
    conduct: 0.3, heatCap: 2.0, corrosive: true, viscosity: 0.08, glow: 0.05 },

  // 20 PLANT — green solid; grows into adjacent water, flammable
  { id: 20, name: 'plant', phase: PHASE.SOLID, color: [70, 150, 66], density: 14,
    conduct: 0.12, heatCap: 1.6, flammable: true, ignite: 220, burnTo: () => M.FIRE,
    grows: true, glow: 0 },

  // ====================== EXPANSION ROSTER =============================
  // All CoolProp/textbook-grounded (see js docs). Reactions live in reaction_rules.js.

  // 21 LIQUID_NITROGEN — cryo liquid; boils at -196C into cold nitrogen gas.
  // density 7 (floats above oil 8/water 10). latentBoil 20: real LN2 latent vap
  // ~199 kJ/kg is tiny vs water's 2.26 MJ/kg, so it flashes off fast when warmed.
  // baseTemp -205 (below its -196 boil point) so a fresh pour stays liquid and
  // has time to flash-freeze neighbors before it warms up and boils to nitrogen.
  { id: 21, name: 'liquid_nitrogen', phase: PHASE.LIQUID, color: [126, 208, 236], density: 7,
    conduct: 0.5, heatCap: 2.05, viscosity: 0.05, baseTemp: -205,
    boil: -196, latentBoil: 20, boilTo: () => M.NITROGEN, glow: 0 },

  // 22 NITROGEN — cold inert gas boiled off LN2; light, rises, dissipates.
  { id: 22, name: 'nitrogen', phase: PHASE.GAS, color: [200, 214, 224], density: 2,
    conduct: 0.04, heatCap: 1.04, baseTemp: -150, condense: -190, condenseTo: () => M.LIQUID_NITROGEN,
    lifetime: 500, glow: 0 },

  // 23 DRY_ICE — solid CO2; sublimates straight to CO2 gas at -78C (no liquid at 1 atm).
  { id: 23, name: 'dry_ice', phase: PHASE.SOLID, color: [222, 230, 236], density: 15,
    conduct: 0.25, heatCap: 0.85, baseTemp: -78, melt: -78, latentMelt: 25, meltTo: () => M.CO2, glow: 0 },

  // 24 CO2 — the HEAVIEST gas (density 5 > steam/smoke/nitrogen): sinks and pools,
  // creeping downhill to smother fire from below. Its signature novelty among gases.
  // color: a faint greenish-gray, distinct from metal/concrete grays so the
  // heavy fog reads as a gas, not a solid.
  { id: 24, name: 'co2', phase: PHASE.GAS, color: [126, 150, 138], density: 5,
    conduct: 0.04, heatCap: 0.85, baseTemp: 18, lifetime: 600, glow: 0 },

  // 25 GUNPOWDER — black powder; autoignites ~160C, deflagrates cell-to-cell (via reactions).
  { id: 25, name: 'gunpowder', phase: PHASE.POWDER, color: [58, 58, 64], density: 12,
    conduct: 0.15, heatCap: 1.0, repose: 0.5, flammable: true, ignite: 160, burnTo: () => M.FIRE, glow: 0 },

  // 26 THERMITE — inert powder until a very hot starter (>=900C) sets it off; then
  // reactions turn it into molten_metal at ~2500C, hot enough to melt through steel.
  { id: 26, name: 'thermite', phase: PHASE.POWDER, color: [128, 96, 72], density: 16,
    conduct: 0.2, heatCap: 0.9, repose: 0.55, flammable: true, ignite: 900, burnTo: () => M.MOLTEN_METAL, glow: 0 },

  // 27 GASOLINE — very runny, lighter than water/oil (floats), flashes at low temp.
  { id: 27, name: 'gasoline', phase: PHASE.LIQUID, color: [188, 168, 96], density: 6,
    conduct: 0.2, heatCap: 1.1, viscosity: 0.02, flammable: true, ignite: 45, burnTo: () => M.FIRE, glow: 0 },

  // 28 TAR — near-solid ultra-viscous liquid (bitumen); forms sticky pits; burns sooty.
  { id: 28, name: 'tar', phase: PHASE.LIQUID, color: [24, 22, 26], density: 11,
    conduct: 0.12, heatCap: 1.4, viscosity: 0.97, flammable: true, ignite: 300, burnTo: () => M.FIRE, glow: 0 },

  // 29 MERCURY — the DENSEST material (70): sinks under everything. Near-zero heatCap
  // (0.14) => snaps to any temperature instantly; conducts like a metal.
  { id: 29, name: 'mercury', phase: PHASE.LIQUID, color: [190, 194, 200], density: 70,
    conduct: 0.85, heatCap: 0.14, viscosity: 0.1, freeze: -39, latentFreeze: 10, freezeTo: () => M.METAL,
    boil: 357, latentBoil: 15, boilTo: () => M.SMOKE, glow: 0 },

  // 30 LYE — alkaline base; neutralizes acid to salt+water (exothermic). density 10.
  { id: 30, name: 'lye', phase: PHASE.LIQUID, color: [150, 120, 190], density: 10,
    conduct: 0.32, heatCap: 2.0, viscosity: 0.15, glow: 0.05 },

  // 31 SNOW — lightest powder (4); heaps into steep drifts; melts to water easily; insulator.
  { id: 31, name: 'snow', phase: PHASE.POWDER, color: [238, 244, 250], density: 4,
    conduct: 0.15, heatCap: 2.0, repose: 0.7, baseTemp: -5, melt: 0, latentMelt: 20, meltTo: () => M.WATER, glow: 0 },

  // 32 COAL — solid fuel; high ignite (400C); burns to a long-lived ember (forge fuel).
  { id: 32, name: 'coal', phase: PHASE.SOLID, color: [40, 38, 42], density: 22,
    conduct: 0.1, heatCap: 1.3, flammable: true, ignite: 400, burnTo: () => M.EMBER, glow: 0 },

  // 33 CONCRETE_WET — thick slurry that cures to solid concrete over time (via reactions).
  { id: 33, name: 'concrete_wet', phase: PHASE.LIQUID, color: [140, 138, 132], density: 20,
    conduct: 0.3, heatCap: 1.2, viscosity: 0.78, cures: true, glow: 0 },

  // 34 SPARK — electric arc; brilliant, ephemeral (lifetime 6), STATIC (doesn't
  // drift — propagates by reaction, jumping along metal/mercury conductors).
  { id: 34, name: 'spark', phase: PHASE.GAS, color: [255, 246, 180], density: 1,
    conduct: 0.1, heatCap: 0.5, baseTemp: 600, lifetime: 6, static: true,
    glow: 1.0, heatColor: true, decayTo: () => M.EMPTY },

  // 35 MOLD — living blight; creeps over organics in a living temp band; dies to fire/frost.
  { id: 35, name: 'mold', phase: PHASE.SOLID, color: [96, 128, 72], density: 13,
    conduct: 0.12, heatCap: 1.5, flammable: true, ignite: 200, burnTo: () => M.FIRE, glow: 0 },

  // 36 WAX — low-melt solid; liquefies at candle warmth (~60C) into molten_wax.
  { id: 36, name: 'wax', phase: PHASE.SOLID, color: [236, 226, 196], density: 13,
    conduct: 0.1, heatCap: 1.6, melt: 60, latentMelt: 25, meltTo: () => M.MOLTEN_WAX,
    flammable: true, ignite: 250, burnTo: () => M.FIRE, glow: 0 },

  // 37 MOLTEN_WAX — pale runny liquid; re-freezes to wax when it cools below 55C.
  { id: 37, name: 'molten_wax', phase: PHASE.LIQUID, color: [246, 236, 210], density: 12,
    conduct: 0.1, heatCap: 1.6, viscosity: 0.4, freeze: 55, latentFreeze: 20, freezeTo: () => M.WAX,
    flammable: true, ignite: 250, burnTo: () => M.FIRE, glow: 0 },

  // 38 CONCRETE — cured solid; stone-like, inert.
  { id: 38, name: 'concrete', phase: PHASE.SOLID, color: [156, 152, 146], density: 40,
    conduct: 0.3, heatCap: 1.0, melt: 1150, latentMelt: 80, meltTo: () => M.LAVA, glow: 0 },

  // 39 RUST — flaky orange corrosion product of metal + water; acid-soluble.
  { id: 39, name: 'rust', phase: PHASE.POWDER, color: [150, 78, 42], density: 18,
    conduct: 0.2, heatCap: 1.0, repose: 0.5, glow: 0 },

  // 40 NAPALM — sticky flammable liquid; catches from any flame and self-reignites.
  { id: 40, name: 'napalm', phase: PHASE.LIQUID, color: [180, 120, 60], density: 9,
    conduct: 0.18, heatCap: 1.5, viscosity: 0.6, flammable: true, ignite: 120, burnTo: () => M.FIRE, glow: 0 },
];

// Fast lookup by name (used by tools/UI and scenarios).
export const BY_NAME = {};
for (const m of MATERIALS) BY_NAME[m.name] = m.id;

// Palette shown in the dock (order matters for UI + number keys 1..9,0).
// First 10 map to keys 1-9,0; the rest are click-only in the dock.
export const PALETTE = [
  'sand', 'water', 'oil', 'lava', 'ice', 'wood', 'metal', 'stone', 'gasoline', 'fire',
  'liquid_nitrogen', 'gunpowder', 'thermite', 'spark', 'mercury', 'tar', 'napalm', 'lye', 'acid',
  'dry_ice', 'snow', 'coal', 'wax', 'concrete_wet', 'salt', 'plant', 'mold',
];

export function matName(id) {
  return (MATERIALS[id] && MATERIALS[id].name) || 'empty';
}
export function phaseName(p) {
  return ['empty', 'powder', 'liquid', 'gas', 'solid'][p] || 'empty';
}
