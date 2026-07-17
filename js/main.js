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
import { AudioEngine } from './audio.js';
import { Particles } from './particles.js';

export const GRID_W = 400;
export const GRID_H = 250;
const DEFAULT_SEED = 1337;

const canvas = document.getElementById('c');

const rng = new Rng(DEFAULT_SEED);
const grid = new Grid(GRID_W, GRID_H);
const sim = new Sim(grid, rng);
const renderer = new Renderer(canvas, grid);

// DISPLAY-ONLY procedural audio. See js/audio.js for the determinism firewall.
// The engine only READS window.__STATE__ and is only ticked while the live rAF
// loop is running (never while rafFrozen), so it cannot affect stateHash().
const audioEngine = new AudioEngine();
let muted = false;

// DISPLAY-ONLY particle + screen-shake layer. Same determinism firewall as the
// audio engine: it only READS window.__STATE__ + is only ticked/drawn on the
// live rAF frame (never while rafFrozen), so it cannot touch stateHash() or the
// visual baselines. `scale` = canvas px per grid cell (both axes are integer
// multiples). renderer.draw(live) applies its shake + particle draw only when
// live === !rafFrozen. See js/particles.js.
const particles = new Particles(512, canvas.width / grid.w);
renderer.particles = particles;

let paused = false;
let overlay = 'normal';
let selectedMaterial = 'sand';
let brushSize = 6;
let brushShape = 'circle'; // 'circle' (default, hash-preserving) | 'square'
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
    brushShape,
    paused,
    overlay,
    simSpeed,
    totals: {
      thermalEnergyJ: t.thermalEnergyJ,
      cellsByPhase: t.cellsByPhase,
      massByMaterial: t.massByMaterial,
    },
    hottestCell: t.hottest,
    lastScenario,
    changes: sim.lastChanges,
    reactions: sim.lastReactions,
    blasts: sim.lastBlasts,
    // Live thermal-overlay range (deg C) so the on-screen legend can label the
    // color bar. Only meaningful in thermal mode; harmless otherwise.
    thermalRange: renderer.getThermalRange
      ? { ...renderer.getThermalRange() }
      : null,
  };
}

// ---- painting (grid coords) ------------------------------------------------
// Place a material at one cell. Painting EMPTY (the eraser) is a true erase:
// it also resets the cell's thermal history — temp back to ambient, latent 0,
// life -1 — so an erased cell leaves NO ghost heat behind for the solver to
// pick up. Every other material routes through grid.set (which seeds temp/life
// from the material definition). This is deterministic; paint touches no rng.
function placeCell(i, id) {
  if (id === M.EMPTY) {
    grid.mat[i] = M.EMPTY;
    grid.temp[i] = grid.ambient;
    grid.latent[i] = 0;
    grid.life[i] = -1;
  } else {
    grid.setIdx(i, id);
  }
}
function paint(cx, cy, r = brushSize, id = BY_NAME[selectedMaterial]) {
  const rr = r * r;
  const square = brushShape === 'square';
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      // circle: keep the radius test; square: fill the whole (2r+1)^2 box.
      if (!square && dx * dx + dy * dy > rr) continue;
      const x = cx + dx, y = cy + dy;
      if (grid.inBounds(x, y)) placeCell(grid.idx(x, y), id);
    }
  }
}
function paintRect(x0, y0, x1, y1, id) {
  for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++)
    for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++)
      if (grid.inBounds(x, y)) placeCell(grid.idx(x, y), id);
}
// Stamp the circular/square brush along a line from (x0,y0) to (x1,y1),
// stepping one cell at a time so a fast drag leaves a continuous stroke with
// no dotted gaps. Integer DDA (lerp) — deterministic, no rng.
function paintLine(x0, y0, x1, y1, r = brushSize, id = BY_NAME[selectedMaterial]) {
  const dx = x1 - x0, dy = y1 - y0;
  const steps = Math.max(Math.abs(dx), Math.abs(dy));
  if (steps === 0) { paint(x0, y0, r, id); return; }
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    paint(Math.round(x0 + dx * t), Math.round(y0 + dy * t), r, id);
  }
}

// ---- heat/cool brush (grid coords) ----------------------------------------
// Add `delta` degrees to grid.temp for every cell within radius r of (cx,cy),
// clamped to never go below absolute zero (-273.15C). This is pure arithmetic
// on the temp array — it touches no rng and no wall clock, so it is fully
// deterministic and safe for the seed-hashed test suite. Circle neighborhood
// (same radius test as paint) so it reads like a temperature brush.
function heatBrush(cx, cy, delta, r = brushSize) {
  const rr = r * r;
  const temp = grid.temp;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > rr) continue;
      const x = cx + dx, y = cy + dy;
      if (!grid.inBounds(x, y)) continue;
      const i = grid.idx(x, y);
      let t = temp[i] + delta;
      if (t < -273.15) t = -273.15;
      temp[i] = t;
    }
  }
}

// ---- main loop (fixed-dt; rAF can be frozen for deterministic stepping) ----
// simSpeed: >=1 runs that many sim.step() calls per frame (fast-forward);
// <1 steps only every Kth frame (slow-mo) via _slowFrames. Total sim.step()
// calls remain integer and seed-driven, so determinism is preserved — the
// harness still drives sim.step() directly through FLUX.step(n) and never
// depends on the rAF cadence.
let rafFrozen = false;
let simSpeed = 1;      // 0.5 | 1 | 2 | 4
let _slowFrames = 0;   // counts frames while slow-mo waits to take a step
function frame(now) {
  if (!rafFrozen) {
    let dt = 16;
    if (_lastT) {
      dt = now - _lastT;
      _fpsAccum += dt; _fpsCount++;
      if (_fpsAccum >= 250) { fps = 1000 / (_fpsAccum / _fpsCount); _fpsAccum = 0; _fpsCount = 0; }
    }
    _lastT = now;
    if (!paused) {
      if (simSpeed >= 1) {
        // fast-forward: N integer steps this frame
        const n = simSpeed | 0;
        for (let k = 0; k < n; k++) sim.step();
      } else {
        // slow-mo: take one step every Math.round(1/simSpeed) frames
        const period = Math.max(1, Math.round(1 / simSpeed));
        if (++_slowFrames >= period) { _slowFrames = 0; sim.step(); }
      }
    }
    renderer.setMode(overlay);
    publishState();
    // DISPLAY-ONLY particles + screen shake. This is the firewall's live-side
    // guard: particles are spawned/integrated ONLY inside this !rafFrozen branch
    // of frame(), reading the __STATE__ we just published (blasts, changes,
    // hottestCell, totals). They never write sim state or call the seeded rng.
    // The headless harness + visual.py freeze rAF (rafFrozen=true) and drive
    // step(n) directly, so frame() never runs and update() is never called under
    // the frozen path — and draw(true) below is the ONLY path that applies the
    // shake offset + draws particles, so baselines cannot drift.
    particles.update(window.__STATE__, dt);
    renderer.draw(true); // live: apply shake + draw particles on top
    // DISPLAY-ONLY audio (same firewall). Ticked ONLY here, only when unmuted.
    if (!muted) audioEngine.tick(window.__STATE__);
    requestAnimationFrame(frame);
  }
}

// ---- the frozen control contract ------------------------------------------
const FLUX = {
  // materials + palette introspection
  materials: MATERIALS.map(m => m.name),
  palette: PALETTE.slice(),
  M,

  reseed(n) { rafFrozen = true; rng.reseed(n | 0); publishState(); return rng.seed; },
  reset() { rafFrozen = true; grid.clear(); sim.tick = 0; lastScenario = ''; publishState(); },
  setMaterial(id) {
    if (typeof id === 'number') selectedMaterial = matName(id);
    else if (BY_NAME[id] !== undefined) selectedMaterial = id;
    publishState(); return selectedMaterial;
  },
  setBrush(px) { brushSize = Math.max(0, px | 0); publishState(); return brushSize; },
  // brush neighborhood shape: 'circle' (default) or 'square'. Default stays
  // circle so existing hashes/baselines are unaffected until a caller changes it.
  setBrushShape(s) { if (s === 'circle' || s === 'square') brushShape = s; publishState(); return brushShape; },
  paint(x, y, r) { paint(x | 0, y | 0, r === undefined ? brushSize : r | 0); },
  paintRect(x0, y0, x1, y1, id) {
    paintRect(x0 | 0, y0 | 0, x1 | 0, y1 | 0, typeof id === 'string' ? BY_NAME[id] : (id | 0));
  },
  // line-interpolated painting: stamp the brush along the whole segment so a
  // fast pointer drag leaves a gapless stroke. id optional (defaults to selected).
  paintLine(x0, y0, x1, y1, r, id) {
    paintLine(
      x0 | 0, y0 | 0, x1 | 0, y1 | 0,
      r === undefined ? brushSize : r | 0,
      id === undefined ? BY_NAME[selectedMaterial]
        : (typeof id === 'string' ? BY_NAME[id] : (id | 0)));
  },
  // heat/cool brush: add `delta` degC to every cell within radius r of (x,y),
  // clamped at absolute zero. Pure temp arithmetic — deterministic, no rng.
  // r optional (defaults to the current brush size).
  heatBrush(x, y, delta, r) {
    heatBrush(x | 0, y | 0, +delta || 0, r === undefined ? brushSize : r | 0);
    if (rafFrozen) publishState();
  },
  // variable sim speed for the live rAF loop. mult in {0.5,1,2,4} (any >0 is
  // accepted): >=1 runs `mult` integer steps/frame, <1 steps every Kth frame.
  // Does NOT change step(n) — the harness still drives ticks directly — and
  // total steps stay integer + seed-driven, so determinism is untouched.
  setSpeed(mult) {
    const m = +mult;
    if (isFinite(m) && m > 0) { simSpeed = m; _slowFrames = 0; }
    publishState();
    return simSpeed;
  },
  // export the current canvas as a PNG data URL (renders happen on the canvas
  // element, so this is a straight toDataURL). Pure read of pixels — no sim state.
  exportPNG() { return canvas.toDataURL('image/png'); },

  // ---- DISPLAY-ONLY audio control (no sim state) --------------------------
  // audioState(): numbers/booleans-only snapshot of the audio mapping layer, so
  // the headless harness (no speakers, suspended context) can assert the
  // event->sound MAPPING without needing to hear anything. See js/audio.js.
  audioState() { return audioEngine.audioState(); },
  // ---- DISPLAY-ONLY particle count (no sim state) -------------------------
  // particleCount(): live particle count in the presentation layer. Lets the
  // headless harness assert spawn-on-blast during LIVE play() without pixel
  // flakiness. Reads a cached counter — touches no sim state. Always 0 under the
  // frozen path (frame() never runs to spawn/integrate), which is exactly what
  // proves particles don't leak into the deterministic tests.
  particleCount() { return particles.count(); },
  // unlockAudio(): create+resume the AudioContext. MUST be invoked from a user
  // gesture (browser autoplay policy) — tools.js calls it on first click/keydown.
  unlockAudio() { audioEngine.unlock(); return audioEngine.audioState(); },
  // setMuted(bool): toggle audio output. Default UNMUTED. Rides the master gain,
  // touches no sim state. Returns the new muted flag.
  setMuted(m) { muted = !!m; audioEngine.setMuted(muted); publishState(); return muted; },
  isMuted() { return muted; },
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
  // reaction-engine compile warnings (misnamed materials in rules, etc.) — for tests
  reactionWarnings() { return sim.reactions.warnings.slice(); },
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
    // The audio engine is passed so tools.js can unlock() it on the first user
    // gesture (browser autoplay policy) and drive the Mute toggle. tools.js only
    // ever calls unlock()/setMuted — it never reaches into sim state through it.
    audioEngine,
    getState: () => ({ selectedMaterial, brushSize, brushShape, paused, overlay, fps, tick: sim.tick, muted }),
    setMuted: (m) => FLUX.setMuted(m),
    setSelected: (m) => { selectedMaterial = m; },
    setBrush: (b) => { brushSize = b; },
    setBrushShape: (s) => { if (s === 'circle' || s === 'square') brushShape = s; },
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
