// render.js — Canvas 2D via a single ImageData buffer per frame.
//
// Three modes:
//   'normal'  : material base color, blended toward incandescent when hot
//   'thermal' : inferno-style false-color by temperature (data-viz overlay)
//   'ascii'   : glowing monospace glyphs (the Caret Cosmos wink)
//
// The grid is GRID_W x GRID_H cells; the canvas is that upscaled by CELL px.
// We paint into an offscreen ImageData at grid resolution, then draw it scaled
// (imageSmoothing off) for crisp pixels — one putImageData / drawImage per frame.

import { MATERIALS, M, PHASE } from './materials.js';

// Incandescent (blackbody-ish) color ramp for hot materials, keyed on temp C.
// Returns [r,g,b]. Below ~500C returns null (use base color).
// Calibrated to the real visual progression of heated matter:
//   ~500C first dull red glow, 700C cherry red, 900C orange, 1100C amber,
//   1300C yellow, 1500C+ yellow-white. Green rises slowly and blue only late,
//   so lava at ~1100C reads amber/orange (NOT banana yellow).
function incandescent(t) {
  if (t < 500) return null;
  const k = Math.min(1, (t - 500) / 1100); // 0 at 500C, 1 at 1600C
  const r = 255;
  // green climbs gently: near 0 at dull-red, ~150 (orange) by ~1050C, 230 by ~1450C
  const g = Math.round(255 * Math.pow(k, 0.85) * 0.92);
  // blue stays absent until yellow-white territory (>~1250C)
  const b = Math.round(255 * Math.max(0, (k - 0.68) / 0.32) * 0.9);
  return [r, Math.min(240, g), Math.min(230, b)];
}

// Inferno-ish palette for thermal overlay (t in C, mapped -20..1600).
function inferno(t) {
  let u = (t + 20) / 1620;
  if (u < 0) u = 0; else if (u > 1) u = 1;
  // piecewise: black -> purple -> red -> orange -> yellow -> white
  const stops = [
    [0.0, [4, 2, 20]],
    [0.2, [60, 12, 90]],
    [0.4, [140, 30, 90]],
    [0.6, [220, 70, 40]],
    [0.8, [250, 160, 30]],
    [1.0, [255, 255, 220]],
  ];
  for (let s = 0; s < stops.length - 1; s++) {
    const [a, ca] = stops[s];
    const [b, cb] = stops[s + 1];
    if (u >= a && u <= b) {
      const f = (u - a) / (b - a);
      return [
        Math.round(ca[0] + (cb[0] - ca[0]) * f),
        Math.round(ca[1] + (cb[1] - ca[1]) * f),
        Math.round(ca[2] + (cb[2] - ca[2]) * f),
      ];
    }
  }
  return [255, 255, 220];
}

export class Renderer {
  constructor(canvas, grid) {
    this.canvas = canvas;
    this.g = grid;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.ctx.imageSmoothingEnabled = false;
    // offscreen buffer at grid resolution
    this.buf = document.createElement('canvas');
    this.buf.width = grid.w;
    this.buf.height = grid.h;
    this.bctx = this.buf.getContext('2d', { alpha: false });
    this.img = this.bctx.createImageData(grid.w, grid.h);
    this.mode = 'normal';
    // ascii glyph ramp by "intensity"
    this.asciiRamp = ' .:-=+*#%@';
  }

  setMode(m) {
    this.mode = m;
  }

  draw() {
    if (this.mode === 'ascii') return this.drawAscii();
    const g = this.g;
    const data = this.img.data;
    const mat = g.mat, temp = g.temp;
    const thermal = this.mode === 'thermal';

    for (let i = 0; i < g.n; i++) {
      const id = mat[i];
      const d = MATERIALS[id];
      let r, gg, b;

      if (thermal) {
        if (id === M.EMPTY) { r = 6; gg = 6; b = 12; }
        else { const c = inferno(temp[i]); r = c[0]; gg = c[1]; b = c[2]; }
      } else {
        const base = d.color;
        r = base[0]; gg = base[1]; b = base[2];
        // heat-driven incandescence for metals/lava/fire/etc.
        if (d.heatColor || d.glow > 0) {
          const inc = incandescent(temp[i]);
          if (inc) {
            const k = Math.min(1, (temp[i] - 480) / 900);
            r = Math.round(r + (inc[0] - r) * k);
            gg = Math.round(gg + (inc[1] - gg) * k);
            b = Math.round(b + (inc[2] - b) * k);
          }
        }
      }
      const p = i * 4;
      data[p] = r; data[p + 1] = gg; data[p + 2] = b; data[p + 3] = 255;
    }
    this.bctx.putImageData(this.img, 0, 0);

    // scale to the visible canvas
    const cw = this.canvas.width, ch = this.canvas.height;
    this.ctx.imageSmoothingEnabled = false;
    this.ctx.drawImage(this.buf, 0, 0, g.w, g.h, 0, 0, cw, ch);

    // second additive pass: bloom for glowing cells (normal mode only)
    if (!thermal) this.bloomPass();
  }

  bloomPass() {
    // Bloom = a soft rim glow around glowing cells that border empty space, so a
    // solid lava mass gets a halo instead of turning into a white floodlight.
    // We only splat cells adjacent to at least one EMPTY neighbor (the surface),
    // keep alpha low, and use 'screen' so overlaps saturate gracefully.
    const g = this.g;
    const ctx = this.ctx;
    const sx = this.canvas.width / g.w;
    const sy = this.canvas.height / g.h;
    const mat = g.mat, temp = g.temp, w = g.w, h = g.h;
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const d = MATERIALS[mat[i]];
        if (d.glow <= 0) continue;
        // surface test: skip fully-buried cells (all 4 neighbors non-empty)
        const surface =
          (x === 0 || mat[i - 1] === M.EMPTY) ||
          (x === w - 1 || mat[i + 1] === M.EMPTY) ||
          (y === 0 || mat[i - w] === M.EMPTY) ||
          (y === h - 1 || mat[i + w] === M.EMPTY);
        if (!surface) continue;
        const heat = Math.min(1, Math.max(0, (temp[i] - 400) / 900));
        const a = d.glow * (0.05 + 0.18 * heat);
        if (a < 0.02) continue;
        const inc = incandescent(temp[i]) || [255, 140, 50];
        ctx.fillStyle = `rgba(${inc[0]},${inc[1]},${inc[2]},${a.toFixed(3)})`;
        ctx.fillRect((x - 0.6) * sx, (y - 0.6) * sy, sx * 2.2, sy * 2.2);
      }
    }
    ctx.restore();
  }

  drawAscii() {
    const g = this.g;
    const ctx = this.ctx;
    const cw = this.canvas.width, ch = this.canvas.height;
    ctx.fillStyle = '#05060a';
    ctx.fillRect(0, 0, cw, ch);
    // coarse cell size so glyphs are legible
    const step = 2; // sample every 2 grid cells
    const px = (cw / g.w) * step;
    ctx.font = `${Math.floor(px * 1.1)}px ui-monospace, Menlo, Consolas, monospace`;
    ctx.textBaseline = 'top';
    const mat = g.mat, temp = g.temp;
    for (let y = 0; y < g.h; y += step) {
      for (let x = 0; x < g.w; x += step) {
        const i = y * g.w + x;
        const id = mat[i];
        if (id === M.EMPTY) continue;
        const d = MATERIALS[id];
        const heat = Math.min(1, Math.max(0, (temp[i] + 20) / 1200));
        const gi = Math.min(this.asciiRamp.length - 1, 1 + Math.floor(heat * (this.asciiRamp.length - 1)));
        const ch2 = this.asciiRamp[gi];
        const inc = incandescent(temp[i]);
        const c = inc || d.color;
        ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
        ctx.fillText(ch2, x * (cw / g.w), y * (ch / g.h));
      }
    }
  }
}
