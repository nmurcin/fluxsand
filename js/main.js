// main.js — wiring + rAF loop + the immutable window.__FLUX / window.__STATE__ contract.
//
// The test harness (headless Chrome via CDP) drives the app entirely through
// window.__FLUX and reads window.__STATE__. This contract is FROZEN — every
// testing bot depends on it. See README / spec test_hooks.

import { Rng } from './rng.js';
import { Grid } from './grid.js';
import { Sim } from './sim.js';
import { Renderer } from './render.js';
import { MATERIALS, M, PHASE, BY_NAME, PALETTE, matName, phaseName } from './materials.js';
import { SCENARIOS, loadScenario } from './scenarios.js';
import { initUI } from './tools.js';
import { encodeScene, decodeScene, applyScene } from './share.js';

export const GRID_W = 320;
export const GRID_H = 200;
const DEFAULT_SEED = 1337;

const canvas = document.getElementById('c');

const rng = new Rng(DEFAULT_SEED);
const grid = new Grid(GRID_W, GRID_H);
const sim = new Sim(grid, rng);
const renderer = new Renderer(canvas, grid);

let paused = false;
let overlay = 'normal';
let selectedMaterial = 'sand';
let brushSize = 6;
let lastScenario = '';
let fps = 0;
let _fpsAccum = 0, _fpsCount = 0, _lastT = 0;

// ---- deterministic state hash (FNV-1a over mat + quantized temp) -----------
function stateHash() {
  let h = 0x811c9dc5 >>> 0;
  const mat = grid.mat, temp = grid.temp;
  for (let i = 0; i < grid.n; i++) {
    h ^= mat[i] & 0xff; h = Math.imul(h, 0x01000193) >>> 0;
    const tq = ((temp[i] + 273) | 0) & 0xffff;
    h ^= tq & 0xff; h = Math.imul(h, 0x01000193) >>> 0;
    h ^= (tq >>> 8) & 0xff; h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// ---- totals for HUD + tests ------------------------------------------------
function computeTotals() {
  const cellsByPhase = { empty: 0, powder: 0, liquid: 0, gas: 0, solid: 0 };
  const massByMaterial = {};
  let thermalEnergy = 0;
  let hottest = { x: 0, y: 0, tempC: -999 };
  const mat = grid.mat, temp = grid.temp;
  for (let i = 0; i < grid.n; i++) {
    const id = mat[i];
    const d = MATERIALS[id];
    cellsByPhase[phaseName(d.phase)]++;
    if (id !== M.EMPTY) {
      const nm = d.name;
      massByMaterial[nm] = (massByMaterial[nm] || 0) + 1;
      thermalEnergy += d.heatCap * (temp[i] - grid.ambient);
      if (temp[i] > hottest.tempC) {
        hottest = { x: i % grid.w, y: (i / grid.w) | 0, tempC: Math.round(temp[i]) };
      }
    }
  }
  return {
    thermalEnergyJ: Math.round(thermalEnergy),
    cellsByPhase,
    massByMaterial,
    hottest,
  };
}

function publishState() {
  const t = computeTotals();
  window.__STATE__ = {
    ready: true,
    tick: sim.tick,
    fps: Math.round(fps),
    seed: rng.seed,
    grid: { w: grid.w, h: grid.h },
    selectedMaterial,
    brushSize,
    paused,
    overlay,
    totals: {
      thermalEnergyJ: t.thermalEnergyJ,
      cellsByPhase: t.cellsByPhase,
      massByMaterial: t.massByMaterial,
    },
    hottestCell: t.hottest,
    lastScenario,
    changes: sim.lastChanges,
    reactions: sim.lastReactions,
  };
}

// ---- painting (grid coords) ------------------------------------------------
function paint(cx, cy, r = brushSize, id = BY_NAME[selectedMaterial]) {
  const rr = r * r;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > rr) continue;
      const x = cx + dx, y = cy + dy;
      if (grid.inBounds(x, y)) grid.set(x, y, id);
    }
  }
}
function paintRect(x0, y0, x1, y1, id) {
  for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++)
    for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++)
      if (grid.inBounds(x, y)) grid.set(x, y, id);
}

// ---- main loop (fixed-dt; rAF can be frozen for deterministic stepping) ----
let rafFrozen = false;
function frame(now) {
  if (!rafFrozen) {
    if (_lastT) {
      const dt = now - _lastT;
      _fpsAccum += dt; _fpsCount++;
      if (_fpsAccum >= 250) { fps = 1000 / (_fpsAccum / _fpsCount); _fpsAccum = 0; _fpsCount = 0; }
    }
    _lastT = now;
    if (!paused) sim.step();
    renderer.setMode(overlay);
    renderer.draw();
    publishState();
    requestAnimationFrame(frame);
  }
}

// ---- the frozen control contract ------------------------------------------
const FLUX = {
  // materials + palette introspection
  materials: MATERIALS.map(m => m.name),
  palette: PALETTE.slice(),
  M,

  reseed(n) { rng.reseed(n | 0); publishState(); return rng.seed; },
  reset() { grid.clear(); sim.tick = 0; lastScenario = ''; publishState(); },
  setMaterial(id) {
    if (typeof id === 'number') selectedMaterial = matName(id);
    else if (BY_NAME[id] !== undefined) selectedMaterial = id;
    publishState(); return selectedMaterial;
  },
  setBrush(px) { brushSize = Math.max(0, px | 0); publishState(); return brushSize; },
  paint(x, y, r) { paint(x | 0, y | 0, r === undefined ? brushSize : r | 0); },
  paintRect(x0, y0, x1, y1, id) {
    paintRect(x0 | 0, y0 | 0, x1 | 0, y1 | 0, typeof id === 'string' ? BY_NAME[id] : (id | 0));
  },
  // deterministic stepping: freeze rAF, advance exactly n ticks, redraw once
  step(n = 1) {
    rafFrozen = true;
    for (let k = 0; k < n; k++) sim.step();
    renderer.setMode(overlay);
    renderer.draw();
    publishState();
    return sim.tick;
  },
  // resume the live rAF loop
  play() { paused = false; if (rafFrozen) { rafFrozen = false; _lastT = 0; requestAnimationFrame(frame); } publishState(); },
  pause() { paused = true; publishState(); },
  setOverlay(mode) {
    if (['normal', 'thermal', 'ascii'].includes(mode)) overlay = mode;
    renderer.setMode(overlay);
    if (rafFrozen) renderer.draw();
    publishState(); return overlay;
  },
  loadScenario(name) {
    const ok = loadScenario(name, grid, rng, { GRID_W, GRID_H });
    if (ok) { lastScenario = name; sim.tick = 0; }
    publishState(); return ok;
  },
  scenarios() { return Object.keys(SCENARIOS); },
  cellAt(x, y) {
    if (!grid.inBounds(x, y)) return null;
    const i = grid.idx(x, y);
    return { material: matName(grid.mat[i]), tempC: Math.round(grid.temp[i]), phase: phaseName(grid.defAt(i).phase) };
  },
  sample() {
    const t = computeTotals();
    return { tick: sim.tick, seed: rng.seed, hottestC: t.hottest.tempC, energy: t.thermalEnergyJ, gas: t.cellsByPhase.gas, liquid: t.cellsByPhase.liquid, solid: t.cellsByPhase.solid };
  },
  stateHash,
  totalEnergy() { return sim.thermal.totalEnergy(); },
  // shareable scene URLs (fully static, no backend)
  shareURL() {
    const enc = encodeScene(grid, rng.seed);
    const base = location.href.split('#')[0];
    return base + '#' + enc;
  },
  loadHash(hash) {
    const h = (hash || location.hash || '').replace(/^#/, '');
    const dec = decodeScene(h);
    if (dec && applyScene(grid, dec)) { rng.reseed(dec.seed); sim.tick = 0; lastScenario = 'shared'; publishState(); return true; }
    return false;
  },
  // replay a recorded input log [{tick, op, args}] from a clean reset+reseed
  replay(inputLog, seed = DEFAULT_SEED) {
    rafFrozen = true;
    grid.clear(); rng.reseed(seed); sim.tick = 0;
    let li = 0;
    const maxTick = inputLog.length ? inputLog[inputLog.length - 1].tick : 0;
    for (let tk = 0; tk <= maxTick; tk++) {
      while (li < inputLog.length && inputLog[li].tick === tk) {
        const { op, args } = inputLog[li];
        if (typeof this[op] === 'function') this[op](...(args || []));
        li++;
      }
      sim.step();
    }
    renderer.setMode(overlay); renderer.draw(); publishState();
    return stateHash();
  },
};

window.__FLUX = FLUX;

// ---- boot ------------------------------------------------------------------
function boot() {
  // if the URL carries a shared scene, load it; otherwise an inviting default
  let loadedShared = false;
  if (location.hash && location.hash.indexOf('s=') >= 0) {
    loadedShared = FLUX.loadHash(location.hash);
  }
  if (!loadedShared) {
    loadScenario('Volcano', grid, rng, { GRID_W, GRID_H });
    lastScenario = 'Volcano';
  }
  initUI({
    canvas, grid, FLUX,
    getState: () => ({ selectedMaterial, brushSize, paused, overlay, fps, tick: sim.tick }),
    setSelected: (m) => { selectedMaterial = m; },
    setBrush: (b) => { brushSize = b; },
    setOverlay: (o) => FLUX.setOverlay(o),
    togglePause: () => { paused = !paused; },
    step: () => FLUX.step(1),
    reset: () => FLUX.reset(),
  });
  publishState();
  requestAnimationFrame(frame);
  // signal readiness after first successful tick+render
  requestAnimationFrame(() => { window.__READY__ = true; if (window.__STATE__) window.__STATE__.ready = true; });
}

boot();
