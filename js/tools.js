// tools.js — user input: mouse painting, keyboard shortcuts, palette + HUD wiring.
// Pure DOM glue; the sim/state contract lives in main.js. All interaction routes
// through window.__FLUX so behavior is identical whether a human or a bot drives it.

import { MATERIALS, PALETTE, BY_NAME, matName } from './materials.js';

export function initUI(ctx) {
  const { canvas, grid, FLUX, getState, setSelected, setBrush, setOverlay, togglePause, step, reset } = ctx;

  // --- build palette dock ---
  // Local, UI-only grouping of the 27 palette materials into labeled sections.
  // Order within/across groups preserves PALETTE order for the first 10 entries,
  // so number keys 1-9 then 0 keep mapping to PALETTE[0..9] regardless of layout.
  // Derived here in tools.js only; materials.js is never touched.
  const PALETTE_GROUPS = [
    { label: 'Basics', mats: ['sand', 'water', 'oil', 'lava', 'ice', 'wood', 'metal', 'stone'] },
    { label: 'Fire', mats: ['gasoline', 'fire', 'gunpowder', 'thermite', 'napalm', 'coal', 'tar', 'spark'] },
    { label: 'Cryo', mats: ['liquid_nitrogen', 'dry_ice', 'snow'] },
    { label: 'Chem', mats: ['mercury', 'lye', 'acid', 'concrete_wet', 'salt'] },
    { label: 'Life', mats: ['plant', 'mold', 'wax'] },
  ];

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
    const label = name.replace(/_/g, ' '); // "liquid_nitrogen" -> "liquid nitrogen" (wraps, not truncates)
    el.innerHTML =
      `<span class="chip"></span><span class="label">${label}</span>` +
      (badge ? `<span class="key">${badge}</span>` : '');
    el.addEventListener('click', () => selectMat(name));
    return el;
  }

  const dock = document.getElementById('palette');
  if (dock) {
    PALETTE_GROUPS.forEach(group => {
      const head = document.createElement('div');
      head.className = 'palette-group';
      head.textContent = group.label;
      dock.appendChild(head);

      const gridEl = document.createElement('div');
      gridEl.className = 'palette-grid';
      group.mats.forEach(name => {
        if (BY_NAME[name] === undefined) return; // skip any name not in the table
        gridEl.appendChild(makeSwatch(name));
      });
      dock.appendChild(gridEl);
    });
  }

  function selectMat(name) {
    setSelected(name);
    FLUX.setMaterial(name);
    document.querySelectorAll('.swatch').forEach(s => s.classList.toggle('active', s.dataset.mat === name));
  }
  selectMat('sand');

  // --- gallery strip ---
  const gallery = document.getElementById('gallery');
  if (gallery) {
    FLUX.scenarios().forEach(name => {
      const b = document.createElement('button');
      b.className = 'scenario';
      b.textContent = name;
      b.addEventListener('click', () => FLUX.loadScenario(name));
      gallery.appendChild(b);
    });
  }

  // --- mouse painting ---
  let painting = false;
  function toGrid(ev) {
    const rect = canvas.getBoundingClientRect();
    const x = ((ev.clientX - rect.left) / rect.width) * grid.w;
    const y = ((ev.clientY - rect.top) / rect.height) * grid.h;
    return { x: Math.floor(x), y: Math.floor(y) };
  }
  canvas.addEventListener('mousedown', (e) => { painting = true; const { x, y } = toGrid(e); FLUX.paint(x, y); });
  window.addEventListener('mouseup', () => { painting = false; });
  canvas.addEventListener('mousemove', (e) => { if (painting) { const { x, y } = toGrid(e); FLUX.paint(x, y); } });
  // touch
  canvas.addEventListener('touchstart', (e) => { painting = true; const t = e.touches[0]; const { x, y } = toGrid(t); FLUX.paint(x, y); e.preventDefault(); }, { passive: false });
  canvas.addEventListener('touchmove', (e) => { if (painting) { const t = e.touches[0]; const { x, y } = toGrid(t); FLUX.paint(x, y); e.preventDefault(); } }, { passive: false });
  window.addEventListener('touchend', () => { painting = false; });

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
  });

  // --- brush slider ---
  const slider = document.getElementById('brush');
  if (slider) slider.addEventListener('input', () => { const b = +slider.value; setBrush(b); FLUX.setBrush(b); });

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
    }, 120);
  }
}
