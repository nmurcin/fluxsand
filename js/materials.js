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
  // 0 EMPTY
  { id: 0, name: 'empty', phase: PHASE.EMPTY, color: [11, 13, 18], density: 0,
    conduct: 0.06, heatCap: 1.0, glow: 0 },

  // 1 SAND — warm ochre powder; melts to glass at high heat
  { id: 1, name: 'sand', phase: PHASE.POWDER, color: [201, 164, 92], density: 12,
    conduct: 0.22, heatCap: 1.4, melt: 1200, latentMelt: 90, meltTo: () => M.MOLTEN_GLASS,
    repose: 0.55, glow: 0 },

  // 2 WATER — translucent teal; freezes / boils with real-ratio latent heats
  { id: 2, name: 'water', phase: PHASE.LIQUID, color: [58, 132, 178], density: 10,
    conduct: 0.55, heatCap: 4.18, freeze: 0, latentFreeze: 60,
    boil: 100, latentBoil: 226, boilTo: () => M.STEAM, freezeTo: () => M.ICE,
    quench: true, glow: 0 },

  // 3 STONE — inert solid; melts to lava
  { id: 3, name: 'stone', phase: PHASE.SOLID, color: [110, 112, 122], density: 40,
    conduct: 0.30, heatCap: 1.7, melt: 1150, latentMelt: 80, meltTo: () => M.LAVA, glow: 0 },

  // 4 LAVA — crimson->orange liquid; freezes to stone; ignites; melts metal on contact
  { id: 4, name: 'lava', phase: PHASE.LIQUID, color: [190, 52, 28], density: 32,
    conduct: 0.40, heatCap: 1.7, freeze: 700, latentFreeze: 80, freezeTo: () => M.STONE,
    baseTemp: 1150, glow: 1.0, heatColor: true, ignitesNeighbors: true },

  // 5 ICE — pale solid; melts to water
  { id: 5, name: 'ice', phase: PHASE.SOLID, color: [176, 214, 232], density: 9,
    conduct: 0.35, heatCap: 2.0, melt: 0, latentMelt: 60, meltTo: () => M.WATER,
    baseTemp: -12, glow: 0 },

  // 6 STEAM — luminous white gas; rises; condenses back to water when cool
  { id: 6, name: 'steam', phase: PHASE.GAS, color: [214, 224, 232], density: 2,
    conduct: 0.25, heatCap: 2.0, condense: 90, condenseTo: () => M.WATER,
    baseTemp: 110, lifetime: 900, glow: 0.08 },

  // 7 OIL — dark iridescent liquid; highly flammable
  { id: 7, name: 'oil', phase: PHASE.LIQUID, color: [70, 54, 40], density: 8,
    conduct: 0.20, heatCap: 1.9, flammable: true, ignite: 180, burnTo: () => M.FIRE,
    glow: 0 },

  // 8 FIRE — hot plasma gas; short-lived; ignites; decays to smoke/ember
  { id: 8, name: 'fire', phase: PHASE.GAS, color: [255, 148, 42], density: 1,
    conduct: 0.5, heatCap: 0.7, baseTemp: 820, glow: 1.0, heatColor: true,
    lifetime: 90, ignitesNeighbors: true, decayTo: () => M.SMOKE },

  // 9 WOOD — solid fuel; burns to ember/ash
  { id: 9, name: 'wood', phase: PHASE.SOLID, color: [120, 82, 46], density: 20,
    conduct: 0.12, heatCap: 1.6, flammable: true, ignite: 250, burnTo: () => M.EMBER,
    glow: 0 },

  // 10 METAL — steel solid; conducts heat fast; glows then melts
  { id: 10, name: 'metal', phase: PHASE.SOLID, color: [150, 158, 170], density: 60,
    conduct: 0.92, heatCap: 1.1, melt: 1400, latentMelt: 120, meltTo: () => M.MOLTEN_METAL,
    heatColor: true, glow: 0 },

  // 11 MOLTEN_METAL — glowing liquid; freezes back to metal
  { id: 11, name: 'molten_metal', phase: PHASE.LIQUID, color: [232, 120, 40], density: 55,
    conduct: 0.9, heatCap: 1.1, freeze: 1350, latentFreeze: 120, freezeTo: () => M.METAL,
    baseTemp: 1500, glow: 1.0, heatColor: true },

  // 12 SMOKE — gray gas; rises and dissipates
  { id: 12, name: 'smoke', phase: PHASE.GAS, color: [80, 82, 90], density: 2,
    conduct: 0.15, heatCap: 1.0, baseTemp: 120, lifetime: 620, glow: 0 },

  // 13 OBSIDIAN — glassy black solid; made when lava is quenched by water
  { id: 13, name: 'obsidian', phase: PHASE.SOLID, color: [28, 24, 38], density: 42,
    conduct: 0.28, heatCap: 1.7, melt: 1100, latentMelt: 90, meltTo: () => M.LAVA, glow: 0 },

  // 14 SALT — white powder; lowers water freeze point (chemistry nod), melts high
  { id: 14, name: 'salt', phase: PHASE.POWDER, color: [225, 226, 232], density: 11,
    conduct: 0.2, heatCap: 1.3, repose: 0.6, dissolves: true, glow: 0 },

  // 15 EMBER — glowing burning wood; radiates heat, decays to ash
  { id: 15, name: 'ember', phase: PHASE.SOLID, color: [206, 74, 30], density: 18,
    conduct: 0.3, heatCap: 1.2, baseTemp: 700, glow: 0.9, heatColor: true,
    lifetime: 260, ignitesNeighbors: true, decayTo: () => M.ASH },

  // 16 ASH — light gray powder residue
  { id: 16, name: 'ash', phase: PHASE.POWDER, color: [96, 92, 92], density: 6,
    conduct: 0.12, heatCap: 1.1, repose: 0.5, glow: 0 },

  // 17 GLASS — transparent-ish solid from cooled molten glass
  { id: 17, name: 'glass', phase: PHASE.SOLID, color: [150, 196, 200], density: 24,
    conduct: 0.3, heatCap: 1.4, melt: 1150, latentMelt: 90, meltTo: () => M.MOLTEN_GLASS, glow: 0 },

  // 18 MOLTEN_GLASS — glowing viscous liquid; freezes to glass
  { id: 18, name: 'molten_glass', phase: PHASE.LIQUID, color: [230, 150, 90], density: 22,
    conduct: 0.35, heatCap: 1.4, freeze: 1000, latentFreeze: 90, freezeTo: () => M.GLASS,
    baseTemp: 1250, glow: 0.9, heatColor: true },

  // 19 ACID — corrosive green liquid; dissolves stone/metal (stretch chemistry)
  { id: 19, name: 'acid', phase: PHASE.LIQUID, color: [120, 210, 60], density: 9,
    conduct: 0.3, heatCap: 2.0, corrosive: true, glow: 0.05 },

  // 20 PLANT — green solid; grows into adjacent water, flammable
  { id: 20, name: 'plant', phase: PHASE.SOLID, color: [70, 150, 66], density: 14,
    conduct: 0.12, heatCap: 1.6, flammable: true, ignite: 220, burnTo: () => M.FIRE,
    grows: true, glow: 0 },
];

// Fast lookup by name (used by tools/UI and scenarios).
export const BY_NAME = {};
for (const m of MATERIALS) BY_NAME[m.name] = m.id;

// Palette shown in the dock (order matters for UI + number keys 1..9,0).
export const PALETTE = [
  'sand', 'water', 'oil', 'lava', 'ice', 'wood', 'metal', 'stone', 'salt', 'plant', 'acid', 'fire',
];

export function matName(id) {
  return (MATERIALS[id] && MATERIALS[id].name) || 'empty';
}
export function phaseName(p) {
  return ['empty', 'powder', 'liquid', 'gas', 'solid'][p] || 'empty';
}
