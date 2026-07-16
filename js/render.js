// render.js — Canvas 2D via a single ImageData buffer per frame.
//
// 8-bit retro look:
//   * one shared limited palette (Endesga-32) — material base colors are already
//     remapped onto EDG32 in materials.js, so the whole scene reads cohesive.
//   * a SNAPPED (posterized) incandescent fire ramp — 6 fixed shades, no blending.
//   * CHUNKY fat pixels — the sim stays 320x200 but we downsample to a 160x100
//     display buffer (each display cell = the dominant material of a 2x2 sim block),
//     then upscale 160x100 -> 1280x800 with imageSmoothing off (clean 8x8 fat pixels).
//   * CHUNKY glow instead of smooth additive bloom — glowing cells stamp a single
//     fixed palette color into their immediate display-buffer neighbors, no blur.
//
// Three modes:
//   'normal'  : material base color, snapped to incandescent when hot
//   'thermal' : posterized inferno false-color by temperature (data-viz overlay)
//   'ascii'   : glowing monospace glyphs (the Caret Cosmos wink)

import { MATERIALS, M, PHASE } from './materials.js';

// --- Endesga-32 fixed fire ramp (the 6 incandescent stops) --------------------
// Each stop is a hard palette color; hot cells SNAP to one of these, no gradient.
// This is the single biggest 8-bit tell: fire shows discrete bands, not a smear.
//   0 dark red, 1 red, 2 orange, 3 yellow, 4 bright yellow, 5 white-hot.
const FIRE_STOPS = [
  [162, 38, 51],   // a22633  dark red
  [228, 59, 68],   // e43b44  red
  [247, 118, 34],  // f77622  orange
  [254, 174, 52],  // feae34  yellow
  [254, 231, 97],  // fee761  bright yellow
  [255, 255, 255], // ffffff  white-hot
];

// Incandescent (blackbody-ish) SNAPPED ramp for hot materials, keyed on temp C.
// Returns one of the 6 FIRE_STOPS, or null below ~500C (use base color).
// No interpolation between stops — hot metal glow and open flame share these
// exact colors, so heated steel and fire read as the same retro fire bands.
//   bucket = floor((t - 500) / 220), clamped to 0..5:
//     500-720 dark red, 720-940 red, 940-1160 orange,
//     1160-1380 yellow, 1380-1600 bright yellow, 1600+ white-hot.
function incandescent(t) {
  if (t < 500) return null;
  let stop = Math.floor((t - 500) / 220);
  if (stop < 0) stop = 0; else if (stop > 5) stop = 5;
  return FIRE_STOPS[stop];
}

// --- Posterized inferno palette for the thermal overlay -----------------------
// 6 fixed EDG32-family stops mapped across -20..1600C, no blending, so the
// thermal cam reads as banded retro false-color rather than a smooth gradient.
const INFERNO_STOPS = [
  [24, 20, 37],    // 181425  near-black (coldest)
  [104, 56, 108],  // 68386c  purple
  [162, 38, 51],   // a22633  dark red
  [247, 118, 34],  // f77622  orange
  [254, 231, 97],  // fee761  bright yellow
  [255, 255, 255], // ffffff  white (hottest)
];

function inferno(t) {
  // map -20..1600C into 6 discrete buckets
  let stop = Math.floor((t + 20) / 270); // 1620 span / 6 ~= 270 per bucket
  if (stop < 0) stop = 0; else if (stop > 5) stop = 5;
  return INFERNO_STOPS[stop];
}

// Chunky glow stamp colors (single fixed palette colors, no accumulation/blur).
const GLOW_HOT = [254, 174, 52];  // feae34  orange — fire / hot / molten
const GLOW_COLD = [44, 232, 245]; // 2ce8f5  cyan   — cryo glow (unused by current mats but supported)

// Display (fat-pixel) buffer resolution: half the sim in each axis => 2x2 blocks.
const DISP_DIV = 2;

export class Renderer {
  constructor(canvas, grid) {
    this.canvas = canvas;
    this.g = grid;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.ctx.imageSmoothingEnabled = false;

    // Chunky display buffer: 160x100 (sim 320x200 downsampled 2x2).
    this.dw = Math.max(1, Math.floor(grid.w / DISP_DIV));
    this.dh = Math.max(1, Math.floor(grid.h / DISP_DIV));
    this.buf = document.createElement('canvas');
    this.buf.width = this.dw;
    this.buf.height = this.dh;
    this.bctx = this.buf.getContext('2d', { alpha: false });
    this.img = this.bctx.createImageData(this.dw, this.dh);

    // Per-display-cell scratch: which material won the 2x2 vote, and whether it glows.
    // Reused each frame so the chunky-glow pass can splat neighbors without re-sampling.
    this.dispMat = new Uint16Array(this.dw * this.dh);
    this.dispGlow = new Uint8Array(this.dw * this.dh); // 0 none, 1 hot, 2 cold

    this.mode = 'normal';
    // ascii glyph ramp by "intensity"
    this.asciiRamp = ' .:-=+*#%@';
  }

  setMode(m) {
    this.mode = m;
  }

  // Choose which of a 2x2 sim block to display: prefer a non-empty, non-gas cell
  // (so powders/liquids/solids read solid), then any non-empty, else empty.
  // Returns the chosen sim index.
  _pick2x2(x2, y2) {
    const g = this.g, w = g.w, h = g.h, mat = g.mat;
    const x0 = x2 * DISP_DIV, y0 = y2 * DISP_DIV;
    let bestSolid = -1, bestAny = -1;
    for (let dy = 0; dy < DISP_DIV; dy++) {
      const yy = y0 + dy;
      if (yy >= h) break;
      for (let dx = 0; dx < DISP_DIV; dx++) {
        const xx = x0 + dx;
        if (xx >= w) break;
        const i = yy * w + xx;
        const id = mat[i];
        if (id === M.EMPTY) continue;
        if (bestAny === -1) bestAny = i;
        const ph = MATERIALS[id].phase;
        if (ph !== PHASE.GAS) { if (bestSolid === -1) bestSolid = i; }
      }
    }
    if (bestSolid !== -1) return bestSolid;
    if (bestAny !== -1) return bestAny;
    return y0 * w + x0; // top-left (empty)
  }

  draw() {
    if (this.mode === 'ascii') return this.drawAscii();
    const g = this.g;
    const data = this.img.data;
    const mat = g.mat, temp = g.temp;
    const thermal = this.mode === 'thermal';
    const dw = this.dw, dh = this.dh;
    const dispMat = this.dispMat, dispGlow = this.dispGlow;

    for (let dy = 0; dy < dh; dy++) {
      for (let dx = 0; dx < dw; dx++) {
        const di = dy * dw + dx;
        const si = this._pick2x2(dx, dy);
        const id = mat[si];
        const d = MATERIALS[id];
        const t = temp[si];
        let r, gg, b;

        if (thermal) {
          if (id === M.EMPTY) { r = 24; gg = 20; b = 37; } // 181425 cold bg
          else { const c = inferno(t); r = c[0]; gg = c[1]; b = c[2]; }
          dispGlow[di] = 0;
        } else {
          const base = d.color;
          r = base[0]; gg = base[1]; b = base[2];
          // SNAP to the incandescent fire ramp for metals/lava/fire/etc.
          let glowKind = 0;
          if (d.heatColor || d.glow > 0) {
            const inc = incandescent(t);
            if (inc) { r = inc[0]; gg = inc[1]; b = inc[2]; }
            if (d.glow > 0 && id !== M.EMPTY) glowKind = 1; // hot glow
          }
          dispGlow[di] = glowKind;
        }
        dispMat[di] = id;
        const p = di * 4;
        data[p] = r; data[p + 1] = gg; data[p + 2] = b; data[p + 3] = 255;
      }
    }

    // Chunky glow: stamp a single fixed palette color into the immediate
    // display-buffer neighbors of glowing cells. No additive blur — the neighbor
    // is simply overwritten if it is currently empty/background, so glow reads as
    // a hard 1-fat-pixel rim, not a soft halo.
    if (!thermal) this._chunkyGlow(data);

    this.bctx.putImageData(this.img, 0, 0);

    // Upscale the chunky buffer to the visible canvas (clean integer fat pixels).
    const cw = this.canvas.width, ch = this.canvas.height;
    this.ctx.imageSmoothingEnabled = false;
    this.ctx.drawImage(this.buf, 0, 0, dw, dh, 0, 0, cw, ch);
  }

  _chunkyGlow(data) {
    const dw = this.dw, dh = this.dh;
    const dispMat = this.dispMat, dispGlow = this.dispGlow;
    // Snapshot which cells were originally empty (background) so we only paint the
    // rim into background, never over another material. Read from dispMat.
    for (let dy = 0; dy < dh; dy++) {
      for (let dx = 0; dx < dw; dx++) {
        const di = dy * dw + dx;
        const k = dispGlow[di];
        if (k === 0) continue;
        const col = k === 2 ? GLOW_COLD : GLOW_HOT;
        // 4-neighborhood; only overwrite EMPTY (background) cells so the glow is
        // a crisp rim around the glowing mass rather than a wash over other stuff.
        const nb = [
          dx > 0 ? di - 1 : -1,
          dx < dw - 1 ? di + 1 : -1,
          dy > 0 ? di - dw : -1,
          dy < dh - 1 ? di + dw : -1,
        ];
        for (let n = 0; n < 4; n++) {
          const ni = nb[n];
          if (ni < 0) continue;
          if (dispMat[ni] !== M.EMPTY) continue; // don't paint over materials
          if (dispGlow[ni] !== 0) continue;       // don't fight another glow source
          const p = ni * 4;
          data[p] = col[0]; data[p + 1] = col[1]; data[p + 2] = col[2]; data[p + 3] = 255;
        }
      }
    }
  }

  drawAscii() {
    const g = this.g;
    const ctx = this.ctx;
    const cw = this.canvas.width, ch = this.canvas.height;
    ctx.fillStyle = '#181425'; // EDG32 near-black background
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
