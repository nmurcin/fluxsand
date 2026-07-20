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

// --- Smooth inferno colormap for the thermal overlay --------------------------
// The thermal cam intentionally DROPS the 8-bit posterization for this one view.
// These anchor stops are the classic matplotlib "inferno" perceptual colormap
// sampled at 9 points from cold (near-black purple) to hot (pale yellow-white).
// They are interpolated LINEARLY per-channel (see infernoSmooth) so the result
// is a continuous gradient, not discrete bands. Normalized position u in [0,1].
const INFERNO_RAMP = [
  [0, 0, 4],       // 0.000  black
  [31, 12, 72],    // 0.125  deep indigo
  [85, 15, 109],   // 0.250  purple
  [136, 34, 106],  // 0.375  magenta
  [186, 54, 85],   // 0.500  red-magenta
  [227, 89, 51],   // 0.625  red-orange
  [249, 140, 10],  // 0.750  orange
  [249, 201, 50],  // 0.875  amber
  [252, 255, 164], // 1.000  pale yellow-white
];

// Map a normalized value u in [0,1] to a smoothly interpolated inferno RGB.
// Writes into out=[r,g,b] to avoid per-cell allocation in the draw hot loop.
function infernoSmooth(u, out) {
  if (u <= 0) { const c = INFERNO_RAMP[0]; out[0] = c[0]; out[1] = c[1]; out[2] = c[2]; return out; }
  if (u >= 1) { const c = INFERNO_RAMP[INFERNO_RAMP.length - 1]; out[0] = c[0]; out[1] = c[1]; out[2] = c[2]; return out; }
  const segs = INFERNO_RAMP.length - 1; // 8 segments between 9 anchors
  const scaled = u * segs;
  let i = scaled | 0;
  if (i >= segs) i = segs - 1;
  const f = scaled - i;
  const a = INFERNO_RAMP[i], b = INFERNO_RAMP[i + 1];
  out[0] = (a[0] + (b[0] - a[0]) * f) | 0;
  out[1] = (a[1] + (b[1] - a[1]) * f) | 0;
  out[2] = (a[2] + (b[2] - a[2]) * f) | 0;
  return out;
}

// Export the smooth colormap + anchor stops so the on-screen legend can render
// the exact same gradient (see tools.js buildThermalLegend).
export { infernoSmooth, INFERNO_RAMP };

// Thermal overlay background for empty cells (dark, so material heat pops).
const THERMAL_BG = [10, 8, 18];

// Chunky glow stamp colors (single fixed palette colors, no accumulation/blur).
const GLOW_HOT = [254, 174, 52];  // feae34  orange — fire / hot / molten
const GLOW_COLD = [44, 232, 245]; // 2ce8f5  cyan   — cryo glow (unused by current mats but supported)

// Display (fat-pixel) buffer resolution: half the sim in each axis => 2x2 blocks.
const DISP_DIV = 1;

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

    // DISPLAY-ONLY presentation layer (particles + screen shake). It is only
    // ever exercised on LIVE frames (draw(true)); when the render loop is frozen
    // for the headless/visual harness the sim is blitted exactly as before, with
    // zero shake offset and zero particles, so baselines never drift. See
    // js/particles.js for the full firewall note. Assigned by main.js.
    this.particles = null;

    // DISPLAY-ONLY post-process (blackbody bloom + heat shimmer). Same firewall:
    // only applied on the LIVE path (draw(true)) and never touches sim state, so
    // stateHash + visual.py baselines are unaffected. Assigned by main.js.
    this.effects = null;

    // Live thermal range (deg C) computed each thermal frame from the actual
    // scene. Published so the on-screen legend can label min/mid/max. Seeded
    // with the ambient so a cold/empty scene still shows a sane bar.
    this.thermalRange = { min: grid.ambient, max: grid.ambient };
    // Scratch histogram for the robust (percentile) range, reused each frame.
    // Buckets span TR_LO..TR_HI degC; anything outside is clamped into the ends.
    this._trLo = -220; this._trHi = 3000; this._trBins = 256;
    this._trHist = new Int32Array(this._trBins);
    this._rgbScratch = [0, 0, 0];
  }

  // Robust dynamic range over non-empty cells: the 2nd..98th percentile of the
  // temperature distribution, so a single lava/plasma cell can't flatten the
  // gradient and a single cold speck can't drag the floor down. Falls back to
  // exact min/max when there are too few cells for percentiles to be meaningful.
  // Result is stashed in this.thermalRange and returned.
  _computeThermalRange() {
    const g = this.g, mat = g.mat, temp = g.temp, n = g.n;
    const lo = this._trLo, hi = this._trHi, bins = this._trBins;
    const hist = this._trHist;
    hist.fill(0);
    const span = hi - lo;
    let count = 0;
    let tmin = Infinity, tmax = -Infinity;
    for (let i = 0; i < n; i++) {
      if (mat[i] === M.EMPTY) continue;
      const t = temp[i];
      if (t < tmin) tmin = t;
      if (t > tmax) tmax = t;
      let bi = ((t - lo) / span * bins) | 0;
      if (bi < 0) bi = 0; else if (bi >= bins) bi = bins - 1;
      hist[bi]++;
      count++;
    }
    if (count === 0) {
      const a = g.ambient;
      this.thermalRange.min = a; this.thermalRange.max = a;
      return this.thermalRange;
    }
    // Percentile edges via cumulative histogram. For small scenes (few cells)
    // the 2/98 percentile collapses toward the extremes, so just use exact.
    let pmin, pmax;
    if (count < 50) {
      pmin = tmin; pmax = tmax;
    } else {
      const loTarget = count * 0.02, hiTarget = count * 0.98;
      let cum = 0, biLo = 0, biHi = bins - 1, gotLo = false, gotHi = false;
      for (let b = 0; b < bins; b++) {
        cum += hist[b];
        if (!gotLo && cum >= loTarget) { biLo = b; gotLo = true; }
        if (!gotHi && cum >= hiTarget) { biHi = b; gotHi = true; break; }
      }
      pmin = lo + (biLo / bins) * span;
      pmax = lo + ((biHi + 1) / bins) * span;
      // Never report a range wider than the true extremes.
      if (pmin < tmin) pmin = tmin;
      if (pmax > tmax) pmax = tmax;
    }
    // Guarantee a non-degenerate span so normalization never divides by ~0.
    if (pmax - pmin < 1) { const mid = (pmax + pmin) / 2; pmin = mid - 0.5; pmax = mid + 0.5; }
    this.thermalRange.min = pmin;
    this.thermalRange.max = pmax;
    return this.thermalRange;
  }

  // The current thermal range (deg C) for external readers (the legend).
  getThermalRange() { return this.thermalRange; }

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

  // draw(live): render the sim. `live` is TRUE only on the wall-clock rAF frame
  // (main.js passes !rafFrozen). When live, the presentation layer applies a
  // decaying screen-shake offset to the sim blit and draws particles on top;
  // when NOT live (the frozen path the harness + visual.py drive) it renders the
  // scene byte-for-byte as before — no offset, no particles — so visual
  // baselines and stateHash stay put. Defaults to false so any legacy/frozen
  // caller is inherently safe.
  draw(live = false, phase = 0) {
    // Presentation layer runs ONLY on live frames. Compute the shake offset up
    // front so both the ascii and chunky paths can ride it.
    let ox = 0, oy = 0;
    const P = (live && this.particles) ? this.particles : null;
    if (P) { const o = P.shakeOffset(); ox = o.x; oy = o.y; }
    // Post-process effects also live-only. `phase` is a wall-clock ms value the
    // live caller passes for shimmer animation; it is 0 on the frozen path.
    const FX = (live && this.effects) ? this.effects : null;

    if (this.mode === 'ascii') { this.drawAscii(ox, oy, P); if (FX) FX.apply(phase, ox, oy); return; }
    const g = this.g;
    const data = this.img.data;
    const mat = g.mat, temp = g.temp;
    const thermal = this.mode === 'thermal';
    const dw = this.dw, dh = this.dh;
    const dispMat = this.dispMat, dispGlow = this.dispGlow;

    // Thermal mode: recompute the scene's actual (robust) temperature range this
    // frame, then map every cell through the smooth inferno colormap normalized
    // to that dynamic range. This is what makes a cool ice scene and a hot
    // volcano both use the full color span instead of looking washed out.
    let trMin = 0, trInvSpan = 0;
    const rgb = this._rgbScratch;
    if (thermal) {
      const tr = this._computeThermalRange();
      trMin = tr.min;
      trInvSpan = 1 / (tr.max - tr.min);
    }

    for (let dy = 0; dy < dh; dy++) {
      for (let dx = 0; dx < dw; dx++) {
        const di = dy * dw + dx;
        const si = this._pick2x2(dx, dy);
        const id = mat[si];
        const d = MATERIALS[id];
        const t = temp[si];
        let r, gg, b;

        if (thermal) {
          if (id === M.EMPTY) {
            r = THERMAL_BG[0]; gg = THERMAL_BG[1]; b = THERMAL_BG[2];
          } else {
            let u = (t - trMin) * trInvSpan;
            if (u < 0) u = 0; else if (u > 1) u = 1;
            infernoSmooth(u, rgb);
            r = rgb[0]; gg = rgb[1]; b = rgb[2];
          }
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
    if (ox !== 0 || oy !== 0) {
      // Screen shake: nudge the whole sim blit by the decaying offset. Paint the
      // exposed edge with the EDG32 near-black background first so the shift
      // never reveals stale pixels. LIVE-ONLY (ox/oy are 0 on the frozen path).
      this.ctx.fillStyle = '#181425';
      this.ctx.fillRect(0, 0, cw, ch);
      this.ctx.drawImage(this.buf, 0, 0, dw, dh, ox, oy, cw, ch);
    } else {
      this.ctx.drawImage(this.buf, 0, 0, dw, dh, 0, 0, cw, ch);
    }

    // Particles ride ON TOP of the (shaken) scene. LIVE-ONLY: P is null unless
    // draw() was called with live=true, so this is a no-op on the frozen path.
    if (P) P.draw(this.ctx, ox, oy);

    // Post-process (bloom + shimmer) runs LAST, over the finished scene +
    // particles. LIVE-ONLY: FX is null on the frozen path, so the harness/visual
    // baselines see the un-post-processed blit exactly as before.
    if (FX) FX.apply(phase, ox, oy);
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

  // drawAscii(ox, oy, P): ascii overlay. ox/oy is the live shake offset (0 on the
  // frozen path); P is the live particle system or null. Both are no-ops when
  // called from the frozen render path, keeping the visual baseline stable.
  drawAscii(ox = 0, oy = 0, P = null) {
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
        ctx.fillText(ch2, x * (cw / g.w) + ox, y * (ch / g.h) + oy);
      }
    }
    if (P) P.draw(ctx, ox, oy);
  }
}
