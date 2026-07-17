// tools.js — user input: mouse painting, keyboard shortcuts, palette + HUD wiring.
// Pure DOM glue; the sim/state contract lives in main.js. All interaction routes
// through window.__FLUX so behavior is identical whether a human or a bot drives it.

import { MATERIALS, PALETTE, BY_NAME, matName } from './materials.js';
import { INFERNO_RAMP } from './render.js';

// Build a CSS linear-gradient string from the shared inferno anchor stops so the
// legend bar shows the EXACT same smooth colormap the renderer paints. Top of the
// bar = hottest, so the ramp is emitted reversed (last anchor first).
function infernoGradientCss() {
  const n = INFERNO_RAMP.length;
  const stops = [];
  for (let i = n - 1; i >= 0; i--) {
    const [r, g, b] = INFERNO_RAMP[i];
    const pct = ((n - 1 - i) / (n - 1)) * 100;
    stops.push(`rgb(${r},${g},${b}) ${pct.toFixed(1)}%`);
  }
  return `linear-gradient(to top, ${stops.join(', ')})`;
}

export function initUI(ctx) {
  const { canvas, grid, FLUX, getState, setSelected, setBrush, setBrushShape, togglePause, step, reset } = ctx;
  // setOverlay is wrapped below (after the legend elements exist) so that every
  // overlay change — keyboard F/G, buttons, or programmatic — also toggles and
  // refreshes the thermal legend. Declared with `let` so it can be rebound.
  let setOverlay = ctx.setOverlay;

  // --- build palette dock ---
  // Local, UI-only grouping of the palette materials into labeled sections.
  // Order within/across groups preserves PALETTE order for the first 10 entries,
  // so number keys 1-9 then 0 keep mapping to PALETTE[0..9] regardless of layout.
  // Derived here in tools.js only; materials.js is never touched.
  const PALETTE_GROUPS = [
    { label: 'Basics', mats: ['sand', 'water', 'oil', 'lava', 'ice', 'wood', 'metal', 'stone'] },
    { label: 'Fire', mats: ['gasoline', 'fire', 'gunpowder', 'thermite', 'napalm', 'coal', 'spark'] },
    { label: 'Cryo', mats: ['liquid_nitrogen', 'dry_ice', 'snow'] },
    { label: 'Chem', mats: ['mercury', 'acid', 'concrete'] },
    { label: 'Life', mats: ['plant', 'wax'] },
    // Tools group: the Eraser paints EMPTY (which resets a cell's thermal
    // history to ambient, see main.placeCell). 'empty' is a real material name
    // so it flows through the same selectMat/FLUX.setMaterial path as any swatch.
    { label: 'Tools', mats: ['empty'] },
  ];
  // Human labels for special palette entries that shouldn't show their raw
  // material name (EMPTY -> "Eraser").
  const SWATCH_LABEL = { empty: 'Eraser' };

  // Key-badge label for a material: keys 1-9 then 0 map to the first 10 PALETTE
  // entries; everything past index 9 gets no badge.
  function keyLabel(name) {
    const idx = PALETTE.indexOf(name);
    if (idx < 0 || idx > 9) return '';
    return idx === 9 ? '0' : String(idx + 1);
  }

  function makeSwatch(name) {
    const id = BY_NAME[name];
    const def = MATERIALS[id];
    const el = document.createElement('button');
    el.className = 'swatch';
    el.dataset.mat = name;
    const [r, g, b] = def.color;
    el.style.setProperty('--sw', `rgb(${r},${g},${b})`);
    const badge = keyLabel(name);
    const label = SWATCH_LABEL[name] || name.replace(/_/g, ' '); // "liquid_nitrogen" -> "liquid nitrogen"
    // Compact horizontal swatch: small color chip + short label side-by-side.
    // Full name lives in the tooltip so a truncated label is still discoverable.
    el.title = label + (badge ? `  (${badge})` : '');
    el.innerHTML =
      `<span class="chip"></span><span class="label">${label}</span>` +
      (badge ? `<span class="key">${badge}</span>` : '');
    el.addEventListener('click', () => selectMat(name));
    return el;
  }

  // Build the palette as a single horizontal strip: for each group emit a small
  // inline divider label (Basics/Fire/Cryo/Chem/Life) followed by that group's
  // swatches, all flowing left-to-right. The strip lives in the bottom bar and
  // scrolls/wraps as needed (see css). Derived from PALETTE order; groups only
  // organize the layout — number-key mapping stays tied to PALETTE indices.
  const dock = document.getElementById('palette');
  if (dock) {
    PALETTE_GROUPS.forEach((group, gi) => {
      const div = document.createElement('span');
      div.className = 'palette-group' + (gi === 0 ? ' first' : '');
      div.textContent = group.label;
      dock.appendChild(div);

      group.mats.forEach(name => {
        if (BY_NAME[name] === undefined) return; // skip any name not in the table
        dock.appendChild(makeSwatch(name));
      });
    });
  }

  function selectMat(name) {
    setSelected(name);
    FLUX.setMaterial(name);
    document.querySelectorAll('.swatch').forEach(s => s.classList.toggle('active', s.dataset.mat === name));
    // Picking a material leaves temp-tool mode (defined below via setTempTool).
    if (typeof clearTempTool === 'function') clearTempTool();
  }
  // Forward declaration hook: selectMat may run before the temp-tool helpers are
  // defined, so it calls through this optional reference set up later.
  let clearTempTool = null;
  selectMat('sand');

  // --- per-scenario instruction overlay ---
  // A short, human-readable description shown when a scenario becomes active.
  // Keyed by scenario name (as returned by FLUX.scenarios()). Scenarios not in
  // the map show no card. Each entry has a title and a list of steps; the
  // RubeGoldberg entry walks the chain reaction stage by stage. Kept here in the
  // UI layer so authoring physics (scenarios.js) stays free of presentation.
  const SCENARIO_INFO = {
    RubeGoldberg: {
      title: 'Rube Goldberg — a chain reaction',
      steps: [
        '1. A spark lights the gunpowder fuse.',
        '2. The flame races along the fuse…',
        '3. …flashing the gasoline slick it runs through.',
        '4. The fuse hits a powder charge — the blast ignites the thermite into ~2500°C molten iron.',
        '5. The iron pours off the ledge, melts the metal gate, and the freed water hits the lava — steam!',
      ],
      hint: 'Press play and watch it cascade. Click to dismiss.',
    },
  };

  const siEl = document.getElementById('scenario-instructions');
  const siTitle = document.getElementById('si-title');
  const siBody = document.getElementById('si-body');
  const siClose = document.getElementById('si-close');
  let siFadeTimer = null, siHideTimer = null, siShownFor = null;

  function hideInstructions() {
    if (siFadeTimer) { clearTimeout(siFadeTimer); siFadeTimer = null; }
    if (siHideTimer) { clearTimeout(siHideTimer); siHideTimer = null; }
    if (siEl) { siEl.hidden = true; siEl.classList.remove('fading'); }
  }

  // Show the instruction card for `name` (if it has an entry). Auto-fades after a
  // few seconds so it never blocks play; re-showing resets the timers.
  function showInstructions(name) {
    if (!siEl) return;
    siShownFor = name;                       // remember the scenario we last reacted to
    const info = SCENARIO_INFO[name];
    if (!info) { hideInstructions(); return; }
    if (siFadeTimer) { clearTimeout(siFadeTimer); siFadeTimer = null; }
    if (siHideTimer) { clearTimeout(siHideTimer); siHideTimer = null; }
    siTitle.textContent = info.title;
    const steps = (info.steps || []).map(s => `<span class="si-step">${s}</span>`).join('');
    const hint = info.hint ? `<span class="si-hint">${info.hint}</span>` : '';
    siBody.innerHTML = steps + hint;
    siEl.hidden = false;
    // force reflow so removing .fading re-triggers the transition
    void siEl.offsetWidth;
    siEl.classList.remove('fading');
    // auto-fade: begin fading after a dwell, fully hide once the transition ends
    siFadeTimer = setTimeout(() => {
      siEl.classList.add('fading');
      siHideTimer = setTimeout(() => { siEl.hidden = true; siEl.classList.remove('fading'); }, 700);
    }, 9000);
  }

  if (siClose) siClose.addEventListener('click', (e) => { e.stopPropagation(); hideInstructions(); });
  if (siEl) siEl.addEventListener('click', () => hideInstructions());

  // --- gallery strip ---
  const gallery = document.getElementById('gallery');
  if (gallery) {
    FLUX.scenarios().forEach(name => {
      const b = document.createElement('button');
      b.className = 'scenario';
      b.textContent = name;
      b.addEventListener('click', () => { FLUX.loadScenario(name); showInstructions(name); });
      gallery.appendChild(b);
    });
  }

  // Show the card for whatever scenario is active at boot (e.g. a shared link or
  // the default), and keep it in sync if the active scenario changes by any path
  // (gallery click, programmatic loadScenario, replay). The HUD poll below also
  // re-checks lastScenario each tick so this covers non-UI scenario switches.
  {
    const s0 = window.__STATE__;
    if (s0 && s0.lastScenario) showInstructions(s0.lastScenario);
  }

  // --- mouse painting ---
  // painting: 'paint' (left button, selected material), 'erase' (right button,
  // EMPTY), or false (idle). lastX/lastY hold the previous grid cell of the
  // stroke so a fast drag is filled with FLUX.paintLine (no dotted gaps).
  let painting = false;
  let lastX = 0, lastY = 0;
  // tempTool: null (normal material painting), 'heat' (+400/step), or 'cool'
  // (-400/step). When set, dragging on the canvas applies FLUX.heatBrush along
  // the stroke instead of painting material. Selecting a material swatch or the
  // eraser clears it (see selectMat wrapper below).
  let tempTool = null;
  const HEAT_DELTA = 400, COOL_DELTA = -400;
  function toGrid(ev) {
    const rect = canvas.getBoundingClientRect();
    const x = ((ev.clientX - rect.left) / rect.width) * grid.w;
    const y = ((ev.clientY - rect.top) / rect.height) * grid.h;
    return { x: Math.floor(x), y: Math.floor(y) };
  }
  // Stamp from the last stroke cell to the current one. In temp-tool mode, apply
  // heatBrush at each interpolated cell along the segment (so a fast drag heats a
  // continuous band, matching how material painting fills). Otherwise 'erase'
  // paints EMPTY (id 0) regardless of selection; 'paint' uses the selection.
  function strokeTo(x, y) {
    if (tempTool) {
      const delta = tempTool === 'cool' ? COOL_DELTA : HEAT_DELTA;
      const dx = x - lastX, dy = y - lastY;
      const steps = Math.max(Math.abs(dx), Math.abs(dy));
      if (steps === 0) FLUX.heatBrush(x, y, delta);
      else for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        FLUX.heatBrush(Math.round(lastX + dx * t), Math.round(lastY + dy * t), delta);
      }
      lastX = x; lastY = y;
      return;
    }
    const id = painting === 'erase' ? 0 : undefined; // undefined -> selected material
    FLUX.paintLine(lastX, lastY, x, y, undefined, id);
    lastX = x; lastY = y;
  }
  canvas.addEventListener('mousedown', (e) => {
    const { x, y } = toGrid(e);
    // button 2 = right = erase; anything else = paint the selected material.
    painting = (e.button === 2) ? 'erase' : 'paint';
    lastX = x; lastY = y;
    strokeTo(x, y);
    e.preventDefault();
  });
  window.addEventListener('mouseup', () => { painting = false; });
  canvas.addEventListener('mousemove', (e) => {
    const { x, y } = toGrid(e);
    if (painting) strokeTo(x, y);
    updateInspect(e, x, y); // hover-inspect tracks the cursor whether or not we're painting
  });
  // Right-click on the canvas erases instead of opening the context menu.
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('mouseleave', () => hideInspect());
  // touch (single-finger paint with line interpolation; touch has no eraser button)
  canvas.addEventListener('touchstart', (e) => {
    painting = 'paint'; const t = e.touches[0]; const { x, y } = toGrid(t);
    lastX = x; lastY = y; strokeTo(x, y); e.preventDefault();
  }, { passive: false });
  canvas.addEventListener('touchmove', (e) => {
    if (painting) { const t = e.touches[0]; const { x, y } = toGrid(t); strokeTo(x, y); e.preventDefault(); }
  }, { passive: false });
  window.addEventListener('touchend', () => { painting = false; });

  // --- hover-inspect tooltip ---
  // On mousemove (painting or not), show a small tooltip near the cursor reading
  // the cell under it as "material  tempC  phase" (e.g. "lava  1142C  liquid").
  // Reads live via FLUX.cellAt; pure DOM, never touches sim state. rAF-throttled
  // so it updates at most once per frame no matter how fast the pointer moves.
  const tipEl = document.getElementById('inspect-tip');
  let tipPending = null; // {clientX, clientY, gx, gy} queued for the next frame
  let tipRaf = 0;

  function hideInspect() {
    tipPending = null;
    if (tipEl) tipEl.hidden = true;
  }
  function updateInspect(ev, gx, gy) {
    if (!tipEl) return;
    tipPending = { clientX: ev.clientX, clientY: ev.clientY, gx, gy };
    if (!tipRaf) tipRaf = requestAnimationFrame(flushInspect);
  }
  function flushInspect() {
    tipRaf = 0;
    const p = tipPending;
    if (!p) return;
    if (!grid.inBounds(p.gx, p.gy)) { hideInspect(); return; }
    const cell = FLUX.cellAt(p.gx, p.gy);
    if (!cell) { hideInspect(); return; }
    const mat = String(cell.material).replace(/_/g, ' ');
    tipEl.textContent = `${mat}  ${cell.tempC}C  ${cell.phase}`;
    // Offset a little from the cursor; keep it on-screen near the right/bottom edges.
    const off = 14;
    let left = p.clientX + off, top = p.clientY + off;
    const w = tipEl.offsetWidth || 80, h = tipEl.offsetHeight || 20;
    if (left + w > window.innerWidth) left = p.clientX - off - w;
    if (top + h > window.innerHeight) top = p.clientY - off - h;
    tipEl.style.left = left + 'px';
    tipEl.style.top = top + 'px';
    tipEl.hidden = false;
  }

  // --- keyboard shortcuts ---
  window.addEventListener('keydown', (e) => {
    const k = e.key;
    if (k >= '1' && k <= '9') { const i = +k - 1; if (PALETTE[i]) selectMat(PALETTE[i]); }
    else if (k === '0') { if (PALETTE[9]) selectMat(PALETTE[9]); }
    else if (k === 'f' || k === 'F') { const cur = getState().overlay; setOverlay(cur === 'thermal' ? 'normal' : 'thermal'); }
    else if (k === 'g' || k === 'G') { const cur = getState().overlay; setOverlay(cur === 'ascii' ? 'normal' : 'ascii'); }
    else if (k === ' ') { togglePause(); e.preventDefault(); }
    else if (k === '.') { step(); }
    else if (k === 'c' || k === 'C') { reset(); }
    else if (k === '[') { const b = Math.max(0, getState().brushSize - 2); setBrush(b); FLUX.setBrush(b); }
    else if (k === ']') { const b = getState().brushSize + 2; setBrush(b); FLUX.setBrush(b); }
    else if (k === 'b' || k === 'B') { toggleShape(); }
  });

  // --- brush shape toggle (circle <-> square) ---
  // Default stays circle so existing hashes are unaffected until the user flips
  // it. Routes through FLUX.setBrushShape so a bot drives it identically.
  const shapeBtn = document.getElementById('shapeBtn');
  function refreshShapeBtn() {
    if (!shapeBtn) return;
    const s = getState().brushShape || 'circle';
    shapeBtn.textContent = (s === 'square' ? 'Square' : 'Circle') + ' (B)';
  }
  function toggleShape() {
    const cur = getState().brushShape || 'circle';
    const next = cur === 'circle' ? 'square' : 'circle';
    if (setBrushShape) setBrushShape(next);
    FLUX.setBrushShape(next);
    refreshShapeBtn();
  }
  if (shapeBtn) shapeBtn.addEventListener('click', () => toggleShape());
  refreshShapeBtn();

  // --- brush slider ---
  const slider = document.getElementById('brush');
  if (slider) slider.addEventListener('input', () => { const b = +slider.value; setBrush(b); FLUX.setBrush(b); });

  // --- thermal legend ---
  // The legend is a DOM color bar bottom-left of the stage. It's shown only in
  // thermal mode and its labels track the scene's live dynamic range (published
  // as __STATE__.thermalRange by the renderer). The bar gradient is set once
  // from the shared inferno colormap.
  const legendEl = document.getElementById('thermal-legend');
  const barEl = document.getElementById('tl-bar');
  const minEl = document.getElementById('tl-min');
  const midEl = document.getElementById('tl-mid');
  const maxEl = document.getElementById('tl-max');
  if (barEl) barEl.style.background = infernoGradientCss();

  function refreshThermalLegend() {
    if (!legendEl) return;
    const s = window.__STATE__;
    const isThermal = s ? s.overlay === 'thermal' : (getState().overlay === 'thermal');
    legendEl.hidden = !isThermal;
    if (!isThermal) return;
    const tr = s && s.thermalRange;
    if (tr && isFinite(tr.min) && isFinite(tr.max)) {
      const lo = Math.round(tr.min), hi = Math.round(tr.max);
      const mid = Math.round((tr.min + tr.max) / 2);
      if (maxEl) maxEl.textContent = `${hi}°`;
      if (midEl) midEl.textContent = `${mid}°`;
      if (minEl) minEl.textContent = `${lo}°`;
    }
  }

  // Wrap the incoming setOverlay so every overlay change also toggles the legend.
  const _setOverlay = setOverlay;
  setOverlay = (mode) => { _setOverlay(mode); refreshThermalLegend(); };

  // --- overlay buttons ---
  document.querySelectorAll('[data-overlay]').forEach(btn => {
    btn.addEventListener('click', () => setOverlay(btn.dataset.overlay));
  });
  const pauseBtn = document.getElementById('pauseBtn');
  if (pauseBtn) pauseBtn.addEventListener('click', () => togglePause());
  const stepBtn = document.getElementById('stepBtn');
  if (stepBtn) stepBtn.addEventListener('click', () => step());
  const clearBtn = document.getElementById('clearBtn');
  if (clearBtn) clearBtn.addEventListener('click', () => reset());

  // --- heat / cool temperature tools ---
  // Selecting a tool enters temp-brush mode (strokeTo applies FLUX.heatBrush
  // instead of painting material). The buttons toggle: clicking the active one
  // exits back to material painting. Picking a material swatch also exits (via
  // the clearTempTool hook wired into selectMat).
  const heatBtn = document.getElementById('heatBtn');
  const coolBtn = document.getElementById('coolBtn');
  function refreshTempButtons() {
    if (heatBtn) heatBtn.classList.toggle('active', tempTool === 'heat');
    if (coolBtn) coolBtn.classList.toggle('active', tempTool === 'cool');
    // A temp tool overrides the material selection cue; drop the swatch highlight
    // while a temp tool is active so the UI shows exactly one active tool.
    if (tempTool) document.querySelectorAll('.swatch').forEach(s => s.classList.remove('active'));
  }
  function setTempTool(which) {
    tempTool = (tempTool === which) ? null : which; // toggle off if re-clicked
    refreshTempButtons();
    if (!tempTool) {
      // returning to material painting: restore the active swatch highlight
      const m = getState().selectedMaterial;
      document.querySelectorAll('.swatch').forEach(s => s.classList.toggle('active', s.dataset.mat === m));
    }
  }
  // Wire the forward-declared hook so selectMat can clear the tool on material pick.
  clearTempTool = () => { if (tempTool) { tempTool = null; refreshTempButtons(); } };
  if (heatBtn) heatBtn.addEventListener('click', () => setTempTool('heat'));
  if (coolBtn) coolBtn.addEventListener('click', () => setTempTool('cool'));

  // --- variable sim speed (0.5x / 1x / 2x / 4x) ---
  // Routes through FLUX.setSpeed so a bot drives it identically. The active
  // button is highlighted; 1x is the default at boot.
  const speedBtns = Array.from(document.querySelectorAll('.pill.speed'));
  function refreshSpeedButtons(mult) {
    speedBtns.forEach(b => b.classList.toggle('active', +b.dataset.speed === mult));
  }
  speedBtns.forEach(b => b.addEventListener('click', () => {
    const m = FLUX.setSpeed(+b.dataset.speed);
    refreshSpeedButtons(m);
  }));
  refreshSpeedButtons(1);

  // --- PNG export ---
  // Grab the canvas as a PNG data URL (FLUX.exportPNG) and trigger a browser
  // download via a synthetic anchor with a timestamped filename.
  const exportBtn = document.getElementById('exportBtn');
  if (exportBtn) exportBtn.addEventListener('click', () => {
    const url = FLUX.exportPNG();
    if (!url) return;
    const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
    const a = document.createElement('a');
    a.href = url;
    a.download = `fluxsand_${ts}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  });

  // --- HUD updater ---
  const hud = document.getElementById('hud');
  if (hud) {
    setInterval(() => {
      const s = window.__STATE__;
      if (!s) return;
      const t = s.totals || {};
      const ph = t.cellsByPhase || {};
      hud.innerHTML =
        `<div class="row"><span>tick</span><b>${s.tick}</b></div>` +
        `<div class="row"><span>fps</span><b>${s.fps}</b></div>` +
        `<div class="row"><span>hottest</span><b>${s.hottestCell ? s.hottestCell.tempC + '&deg;C' : '-'}</b></div>` +
        `<div class="row"><span>energy</span><b>${(t.thermalEnergyJ || 0).toLocaleString()}</b></div>` +
        `<div class="row"><span>liquid</span><b>${ph.liquid || 0}</b></div>` +
        `<div class="row"><span>gas</span><b>${ph.gas || 0}</b></div>` +
        `<div class="row"><span>mat</span><b>${s.selectedMaterial}</b></div>`;
      // Keep the thermal legend labels tracking the live dynamic range.
      refreshThermalLegend();
      // Detect scenario changes made outside the gallery buttons (programmatic
      // loadScenario, shared-link load, replay) and surface the instruction card.
      if (s.lastScenario !== siShownFor) showInstructions(s.lastScenario);
    }, 120);
  }

  // Initial legend state (hidden unless we booted straight into thermal).
  refreshThermalLegend();
}
