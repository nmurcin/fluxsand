// effects.js — a presentation-only post-process layer: additive blackbody BLOOM
// and heat-SHIMMER (mirage) over hot regions.
//
// ============================ THE DETERMINISM FIREWALL ======================
// Like js/particles.js, this is DISPLAY-ONLY. It is allowed to READ the grid
// (mat/temp) and window.__STATE__ read-only, and to draw onto the visible canvas
// AFTER the sim blit. It MUST NEVER:
//   * write to the sim grid or any sim buffer,
//   * call the sim's seeded Rng,
//   * run at all while the render loop is frozen (rafFrozen === true — the
//     headless suite freezes rAF and drives step(n), and testing/visual.py
//     screenshots the FROZEN render path).
//
// The invariant preserved: window.__FLUX.stateHash() and testing/visual.py are
// BOTH unchanged. stateHash is untouched because we never write a sim cell;
// visual.py is untouched because render.js only invokes this layer on the LIVE
// path (renderer.draw(true), i.e. live === !rafFrozen). On the frozen path the
// scene is blitted exactly as before — no bloom, no shimmer.
//
// Time-based animation (shimmer wobble) uses a wall-clock phase passed in from
// the live frame; it never touches sim.tick or the seeded rng, so it cannot
// affect determinism. It only ever runs live, so it also can't affect baselines.
// ===========================================================================

// Bloom is built at a downscaled resolution (cheap gaussian-ish blur) then added
// back over the scene with 'lighter' compositing so hot pixels grow a soft halo.
// Shimmer samples vertical slices of the already-rendered canvas and redraws them
// with a small per-row horizontal offset that decays with height above the heat,
// reading as rising-air refraction.

export class Effects {
  // scale: canvas px per grid cell (same convention as particles.js). We read the
  // grid to locate hot cells; we read the canvas to post-process its pixels.
  constructor(canvas, grid, scale = 1) {
    this.canvas = canvas;
    this.g = grid;
    this.scale = scale;
    this.ctx = canvas.getContext('2d');

    // toggles (persisted by tools.js via localStorage; defaults ON for the wow).
    this.bloomOn = true;
    this.shimmerOn = true;

    // Bloom scratch canvas at 1/BLOOM_DIV resolution (a blurred bright-pass).
    this.BLOOM_DIV = 4;
    this.bw = Math.max(1, Math.floor(canvas.width / this.BLOOM_DIV));
    this.bh = Math.max(1, Math.floor(canvas.height / this.BLOOM_DIV));
    this.bloomCanvas = document.createElement('canvas');
    this.bloomCanvas.width = this.bw;
    this.bloomCanvas.height = this.bh;
    this.bctx = this.bloomCanvas.getContext('2d');

    // A second scratch for the two-pass separable blur (h then v).
    this.blurCanvas = document.createElement('canvas');
    this.blurCanvas.width = this.bw;
    this.blurCanvas.height = this.bh;
    this.blurCtx = this.blurCanvas.getContext('2d');

    // Bloom threshold: only pixels brighter than this (max channel) bloom, so
    // only fire/lava/molten/live-wire glow — not the whole scene washing out.
    this.BLOOM_THRESH = 150;
    // How strongly the halo is added back (0..1 global alpha on the add pass).
    this.BLOOM_STRENGTH = 0.65;
    // Blur radius in bloom-buffer px (via canvas filter blur()).
    this.BLOOM_BLUR = 3;

    // Shimmer tuning. We warp a band of canvas ABOVE hot cells. Amplitude in px,
    // wavelength in canvas px, and a wall-clock-driven phase for the wobble.
    this.SHIMMER_AMP = 2.4;      // max horizontal displacement (screen px)
    this.SHIMMER_ROWS = 3;       // sample band height in bloom-scale rows per slice
    this.HOT_C = 300;            // cells hotter than this radiate shimmer above them
    this.SHIMMER_MAX_H = 46;     // how many canvas px above a hot cell to warp

    // Reused scratch for the hot-column heightmap (max hot y per grid column,
    // and the temperature there). Rebuilt per live frame from the grid.
    this._hotTopY = new Int32Array(grid.w);   // topmost hot grid-row per column, -1 none
    this._hotByCol = new Float32Array(grid.w); // temp at that cell (for amplitude)
  }

  setBloom(on) { this.bloomOn = !!on; }
  setShimmer(on) { this.shimmerOn = !!on; }

  // Post-process the ALREADY-DRAWN canvas. Called from render.js ONLY on the live
  // path (draw(true)), AFTER the sim blit + particles. `phase` is a wall-clock
  // value in ms (for shimmer animation); passing it in keeps this module free of
  // any direct clock call. ox/oy is the live shake offset so effects ride it too.
  //
  // Order matters: shimmer first (it warps the base scene), then bloom on top
  // (so halos sit over the warped image, not under it).
  apply(phase, ox = 0, oy = 0) {
    if (this.shimmerOn) this._shimmer(phase, ox, oy);
    if (this.bloomOn) this._bloom();
  }

  // ---- BLOOM ---------------------------------------------------------------
  // Bright-pass -> blur -> add back with 'lighter'. Uses the canvas 2D filter
  // for the blur (GPU-accelerated in modern browsers), so it stays cheap even
  // though it touches the full frame. Purely a read of the canvas + an additive
  // draw back onto it — no sim state.
  _bloom() {
    const ctx = this.ctx;
    const cw = this.canvas.width, ch = this.canvas.height;
    const bw = this.bw, bh = this.bh;
    const bctx = this.bctx;

    // 1) Downscale the current frame into the bloom buffer.
    bctx.globalCompositeOperation = 'source-over';
    bctx.globalAlpha = 1;
    bctx.clearRect(0, 0, bw, bh);
    bctx.imageSmoothingEnabled = true;
    bctx.drawImage(this.canvas, 0, 0, cw, ch, 0, 0, bw, bh);

    // 2) Bright-pass: knock out everything below threshold by subtracting a
    //    flat grey with 'difference'-like trick. Simpler + robust: read pixels,
    //    zero the dim ones. The bloom buffer is tiny (cw/4 x ch/4) so this is cheap.
    const img = bctx.getImageData(0, 0, bw, bh);
    const d = img.data;
    const th = this.BLOOM_THRESH;
    for (let p = 0; p < d.length; p += 4) {
      const r = d[p], g = d[p + 1], b = d[p + 2];
      const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
      if (mx < th) {
        d[p] = 0; d[p + 1] = 0; d[p + 2] = 0;
      } else {
        // Soft knee: scale so just-above-threshold pixels bloom gently.
        const k = (mx - th) / (255 - th); // 0..1
        d[p] = (r * k) | 0; d[p + 1] = (g * k) | 0; d[p + 2] = (b * k) | 0;
      }
    }
    bctx.putImageData(img, 0, 0);

    // 3) Blur the bright-pass (separable-ish via the canvas filter) into blurCanvas.
    const blurCtx = this.blurCtx;
    blurCtx.clearRect(0, 0, bw, bh);
    blurCtx.filter = `blur(${this.BLOOM_BLUR}px)`;
    blurCtx.drawImage(this.bloomCanvas, 0, 0);
    blurCtx.filter = 'none';

    // 4) Add the blurred halo back over the full canvas with 'lighter' (additive).
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = this.BLOOM_STRENGTH;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.blurCanvas, 0, 0, bw, bh, 0, 0, cw, ch);
    ctx.restore();
  }

  // ---- HEAT SHIMMER --------------------------------------------------------
  // Build a per-column "hot top" heightmap from the grid, then warp thin vertical
  // slices of the canvas ABOVE those hot cells by a small, height- and time-varying
  // horizontal offset (a sine in wall-clock phase + column). Reads grid.temp
  // read-only and self-copies canvas regions — no sim writes.
  _shimmer(phase, ox, oy) {
    const g = this.g, mat = g.mat, temp = g.temp, w = g.w, h = g.h;
    const hotTop = this._hotTopY;
    const HOT = this.HOT_C;

    // Find the topmost hot cell in each column (scan top-down, first hot wins).
    let anyHot = false;
    for (let x = 0; x < w; x++) {
      let ty = -1;
      for (let y = 0; y < h; y++) {
        if (mat[y * w + x] !== 0 && temp[y * w + x] >= HOT) { ty = y; break; }
      }
      hotTop[x] = ty;
      if (ty >= 0) anyHot = true;
    }
    if (!anyHot) return; // nothing hot on screen -> no shimmer, no cost

    const ctx = this.ctx;
    const cw = this.canvas.width, ch = this.canvas.height;
    const s = this.scale;              // canvas px per grid cell
    const amp = this.SHIMMER_AMP;
    const maxH = this.SHIMMER_MAX_H;   // canvas px of warp band above a hot cell
    // Slice width in canvas px: a few grid columns per slice so we don't do w
    // individual draws. Group columns into slices of SLICE grid-cols.
    const SLICE = 3;
    const sliceW = Math.max(1, (SLICE * s) | 0);

    // Wobble: phase advances with wall clock; columns get a spatial offset so the
    // warp isn't a rigid sheet. Two summed sines read as chaotic rising air.
    const t = phase * 0.004;

    for (let x = 0; x < w; x += SLICE) {
      // Representative hot top for this slice = the highest (smallest y) hot cell
      // among its columns.
      let ty = -1;
      for (let c = x; c < x + SLICE && c < w; c++) {
        const cy = hotTop[c];
        if (cy >= 0 && (ty < 0 || cy < ty)) ty = cy;
      }
      if (ty < 0) continue; // no hot cell under this slice

      const sx = (x * s + ox) | 0;
      const hotCanvasY = ty * s + oy;         // canvas y of the hot cell top
      const bandTop = Math.max(0, hotCanvasY - maxH);
      const bandH = hotCanvasY - bandTop;
      if (bandH <= 1) continue;

      // Warp the band as a few horizontal sub-rows, each shifted more the closer
      // it is to the heat (bottom of band = strongest). Copy from the current
      // canvas (self-blit) shifted horizontally. Small row height keeps it smooth.
      const ROW = 3;
      for (let yy = bandTop; yy < hotCanvasY; yy += ROW) {
        const frac = (yy - bandTop) / bandH;        // 0 top .. 1 at the heat
        const strength = frac * frac;               // stronger near the source
        const dx = Math.sin(t + x * 0.25 + yy * 0.08) * amp * strength
                 + Math.sin(t * 1.7 + x * 0.11) * amp * 0.4 * strength;
        const rh = Math.min(ROW, hotCanvasY - yy);
        // self-copy this row-strip shifted by dx. drawImage can read+write the
        // same canvas; overlapping self-blits are well-defined per spec.
        ctx.drawImage(
          this.canvas,
          sx, yy, sliceW, rh,
          (sx + dx) | 0, yy, sliceW, rh,
        );
      }
    }
  }
}
