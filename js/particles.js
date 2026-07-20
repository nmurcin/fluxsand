// particles.js — a presentation-only particle + screen-shake "juice" layer.
//
// ============================ THE DETERMINISM FIREWALL ======================
// Particles + screen shake are DISPLAY-ONLY. They are allowed to READ
// window.__STATE__ (blasts, changes, hottestCell, totals) and the grid
// read-only, and NOTHING ELSE. They MUST NEVER:
//   * write to the sim grid or any sim buffer,
//   * call the sim's seeded Rng (that would desync every determinism test),
//   * run at all while the render loop is frozen (rafFrozen === true — the
//     headless harness freezes rAF and drives step(n) directly, and the
//     VISUAL REGRESSION suite screenshots the frozen render path).
//
// The invariant this preserves: window.__FLUX.stateHash() and testing/visual.py
// are BOTH unchanged by this feature. stateHash is untouched because we never
// write a sim cell; visual.py is untouched because every spawn/integrate/draw
// path and the shake offset are gated behind !rafFrozen — when frozen the sim is
// blitted exactly as before, with zero offset and zero particles on screen.
//
// The rafFrozen guard is enforced at the two live entry points:
//   * update(state, dtMs) — called ONLY from the !rafFrozen branch of frame().
//   * render.js applies the shake offset + draws particles ONLY when it is told
//     the frame is live (renderer.draw(live) with live === !rafFrozen).
// So this class NEVER runs under the frozen path even though it exists.
//
// Particle spawn positions/velocities use the browser's non-seeded Math.random.
// That is fine: it never feeds a sim cell, so it cannot affect stateHash().
// ===========================================================================

// EDG32 / fire-palette colors chosen so particles read native to the 8-bit art.
// Sparks/embers reuse the incandescent FIRE_STOPS family; smoke uses cool greys.
const SPARK_COLORS = [
  [255, 255, 255], // ffffff  white-hot spark core
  [254, 231, 97],  // fee761  bright yellow
  [254, 174, 52],  // feae34  yellow
  [247, 118, 34],  // f77622  orange
  [228, 59, 68],   // e43b44  red
];
const EMBER_COLORS = [
  [247, 118, 34],  // f77622  orange
  [254, 174, 52],  // feae34  yellow
  [228, 59, 68],   // e43b44  red
  [162, 38, 51],   // a22633  dark red
];
const SMOKE_COLORS = [
  [192, 203, 220], // c0cbdc  light steel (EDG32)
  [139, 155, 180], // 8b9bb4  steel grey
  [89, 86, 82],    // 595652  warm grey
];

function pick(arr) { return arr[(Math.random() * arr.length) | 0]; }

export class Particles {
  // capacity: fixed-size ring buffer. scale: screen px per grid cell (canvas
  // is `scale`x the grid in each axis). We keep particle coords in SCREEN space
  // so draw() can splat them straight onto the main canvas ctx as fat rects.
  constructor(capacity = 512, scale = 1) {
    this.cap = capacity;
    this.scale = scale;

    // Parallel arrays (SoA) — cheaper than an array of objects in the hot loop.
    // A slot is "alive" iff life > 0. `head` is the next slot to (re)use.
    this.x = new Float32Array(this.cap);
    this.y = new Float32Array(this.cap);
    this.vx = new Float32Array(this.cap);
    this.vy = new Float32Array(this.cap);
    this.life = new Float32Array(this.cap);   // remaining life in ms
    this.life0 = new Float32Array(this.cap);  // original life (for fade/size)
    this.size = new Float32Array(this.cap);   // draw size in screen px
    this.kind = new Uint8Array(this.cap);     // 0 spark, 1 ember, 2 smoke
    this.r = new Uint8Array(this.cap);
    this.g = new Uint8Array(this.cap);
    this.b = new Uint8Array(this.cap);
    this.head = 0;

    // --- screen shake (decaying magnitude in screen px) ----------------------
    this.shakeMag = 0;
    this.SHAKE_MAX = 12;      // cap so it reads as a punch (raised for the new blasts)
    this.SHAKE_DECAY = 0.88;  // per-frame multiplicative decay (slightly longer punch)

    // --- edge-detection memory for spawn events (pure numbers, never sim) -----
    this._lastTick = -1;
    this._prevSteam = 0;
    this._prevChanges = 0;

    this._alive = 0; // cached live count for particleCount()
  }

  // Spawn one particle into the ring buffer (overwrites the oldest slot when
  // full — a fixed-capacity recycle, no allocation). Screen coords.
  _spawn(x, y, vx, vy, lifeMs, sizePx, kind, col) {
    const i = this.head;
    this.head = (this.head + 1) % this.cap;
    this.x[i] = x; this.y[i] = y;
    this.vx[i] = vx; this.vy[i] = vy;
    this.life[i] = lifeMs; this.life0[i] = lifeMs;
    this.size[i] = sizePx; this.kind[i] = kind;
    this.r[i] = col[0]; this.g[i] = col[1]; this.b[i] = col[2];
  }

  // Burst of sparks + embers from a detonation, centered on a screen point.
  // `power` scales count + speed (from the blast cell count). Overhauled for a
  // punchy, energetic "pop": many more particles, much higher OUTWARD radial
  // velocity (real momentum that decays with drag), a bias toward a shell rather
  // than a uniform disc (so it reads as an expanding front), plus a fast bright
  // shockwave ring of tiny sparks and a few rising smoke puffs. Display-only.
  _burst(sx, sy, power) {
    // count scales with power but is capped by the ring buffer; a big charge
    // throws a genuine cloud of debris, not a dozen dots.
    const n = Math.min(220, 40 + (power * 6) | 0);
    const spdBase = this.scale * (0.22 + power * 0.06);   // much faster than before
    for (let k = 0; k < n; k++) {
      const ang = Math.random() * Math.PI * 2;
      // Shell bias: most speed near a moving front (0.55..1.0 of spdBase) with a
      // fast tail, so the burst expands as a ring instead of a fuzzy blob.
      const shell = 0.55 + Math.random() * 0.45;
      const spd = spdBase * shell * (0.6 + Math.random() * 0.9);
      const ember = Math.random() < 0.4;
      const vx = Math.cos(ang) * spd;
      let vy = Math.sin(ang) * spd;
      if (ember) vy -= 0.03 * this.scale;   // embers get an upward buoyancy kick
      this._spawn(
        sx + (Math.random() - 0.5) * this.scale * 2,
        sy + (Math.random() - 0.5) * this.scale * 2,
        vx, vy,
        ember ? 600 + Math.random() * 800 : 260 + Math.random() * 380,
        ember ? 1.5 + Math.random() * 2.5 : 1 + Math.random() * 1.8,
        ember ? 1 : 0,
        ember ? pick(EMBER_COLORS) : pick(SPARK_COLORS),
      );
    }
    // SHOCKWAVE RING: a tight burst of very fast, short-lived white/yellow sparks
    // all at nearly the same high speed, so they read as a single expanding rim.
    const ringN = Math.min(90, 24 + (power * 3) | 0);
    const ringSpd = spdBase * 1.7;
    for (let k = 0; k < ringN; k++) {
      const ang = (k / ringN) * Math.PI * 2 + Math.random() * 0.15;
      const spd = ringSpd * (0.9 + Math.random() * 0.2);
      this._spawn(sx, sy, Math.cos(ang) * spd, Math.sin(ang) * spd,
        180 + Math.random() * 160, 1 + Math.random() * 1.2, 0,
        Math.random() < 0.5 ? [255, 255, 255] : [254, 231, 97]);
    }
    // A few rising smoke puffs launched with the blast (the lingering cloud).
    const puffs = Math.min(10, 2 + (power * 0.5) | 0);
    for (let k = 0; k < puffs; k++) {
      const ang = Math.random() * Math.PI * 2;
      const spd = spdBase * 0.4 * (0.4 + Math.random() * 0.6);
      this._spawn(
        sx + (Math.random() - 0.5) * this.scale * 3,
        sy + (Math.random() - 0.5) * this.scale * 3,
        Math.cos(ang) * spd, Math.sin(ang) * spd - 0.03 * this.scale,
        900 + Math.random() * 900, 2.5 + Math.random() * 3, 2, pick(SMOKE_COLORS));
    }
  }

  // A rising smoke wisp near a screen point (drifts up, slows, fades).
  _wisp(sx, sy) {
    this._spawn(
      sx + (Math.random() - 0.5) * this.scale * 3,
      sy + (Math.random() - 0.5) * this.scale * 2,
      (Math.random() - 0.5) * 0.03 * this.scale,
      -(0.03 + Math.random() * 0.05) * this.scale, // rise
      700 + Math.random() * 700,
      2 + Math.random() * 2.5,
      2,
      pick(SMOKE_COLORS),
    );
  }

  // A drifting ember floating up over a large fire mass (screen point).
  _driftEmber(sx, sy) {
    this._spawn(
      sx, sy,
      (Math.random() - 0.5) * 0.04 * this.scale,
      -(0.02 + Math.random() * 0.05) * this.scale,
      600 + Math.random() * 700,
      1 + Math.random() * 1.5,
      1,
      pick(EMBER_COLORS),
    );
  }

  // ------------------------------------------------------------------------
  // update(state, dtMs): read events off a __STATE__ snapshot, spawn, then
  // integrate all live particles by wall-clock dt. Called ONLY from the live
  // (!rafFrozen) branch of frame() — never under the frozen/test path.
  //
  // `state` is window.__STATE__ (read-only). `grid` is the grid dims from state
  // so we can convert grid coords -> screen. dtMs is the real elapsed ms.
  // ------------------------------------------------------------------------
  update(state, dtMs) {
    // Clamp dt so a background-tab hitch (huge dt) can't fling particles off.
    let dt = dtMs;
    if (!(dt > 0)) dt = 16;
    if (dt > 50) dt = 50;

    if (state && state.ready) this._spawnFromEvents(state);
    this._integrate(dt);
  }

  _spawnFromEvents(state) {
    const gw = (state.grid && state.grid.w) || 0;
    const s = this.scale;

    // Convert the hottest cell to screen coords (grid -> canvas, both x`scale`).
    const hc = state.hottestCell || null;
    const hx = hc ? (hc.x + 0.5) * s : 0;
    const hy = hc ? (hc.y + 0.5) * s : 0;

    // Only fire spawn logic once per new sim tick so speed multipliers / repeat
    // frames on the same tick don't over-spawn. (Purely a display heuristic.)
    const tick = state.tick | 0;
    const newTick = tick !== this._lastTick;
    this._lastTick = tick;

    // --- blasts -> spark/ember burst + screen shake -------------------------
    const blasts = (state.blasts | 0);
    if (blasts > 0 && hc) {
      this._burst(hx, hy, blasts);
      // stronger, punchier shake that ramps faster with blast size (still capped).
      const mag = Math.min(this.SHAKE_MAX, 3 + blasts * 0.6);
      if (mag > this.shakeMag) this.shakeMag = mag;
    }

    if (!newTick) { this._prevChanges = state.changes | 0; return; }

    // --- steam rising / changes spike -> rising smoke wisps -----------------
    const totals = state.totals || {};
    const byMat = totals.massByMaterial || {};
    const steam = (byMat.steam | 0);
    const changes = (state.changes | 0);
    const changeSpike = changes - this._prevChanges;
    this._prevChanges = changes;

    if (steam > 0 && gw) {
      // a couple of wisps rising from around the hottest region (proxy for the
      // active steam front). Rate scales gently with steam mass.
      const nw = Math.min(3, 1 + (steam / 60) | 0);
      for (let k = 0; k < nw; k++) {
        const px = hc ? hx + (Math.random() - 0.5) * 12 * s / 3.2 : Math.random() * gw * s;
        const py = hc ? hy : Math.random() * 20 * s;
        this._wisp(px, py);
      }
    } else if (changeSpike > 8 && hc) {
      // a burst of phase changes with no steam (melt/freeze front): a wisp or two.
      this._wisp(hx, hy);
    }

    // --- large fire mass -> occasional embers drifting up -------------------
    const fire = (byMat.fire | 0);
    if (fire > 20 && hc && Math.random() < 0.5) {
      this._driftEmber(hx + (Math.random() - 0.5) * 6 * s, hy);
    }
  }

  _integrate(dt) {
    const g = 0.00018 * this.scale; // gravity accel (screen px / ms^2), gentle
    let alive = 0;
    for (let i = 0; i < this.cap; i++) {
      let life = this.life[i];
      if (life <= 0) continue;
      life -= dt;
      if (life <= 0) { this.life[i] = 0; continue; }
      // integrate
      this.x[i] += this.vx[i] * dt;
      this.y[i] += this.vy[i] * dt;
      const kind = this.kind[i];
      if (kind === 0) {
        // sparks: fall under gravity with light air drag. Drag is per-ms via a
        // frame-rate-independent factor so the initial blast momentum carries
        // visibly outward before gravity takes over (was a flat 0.98/frame).
        this.vy[i] += g * dt;
        const drag = Math.pow(0.992, dt);
        this.vx[i] *= drag;
        this.vy[i] *= drag;
      } else if (kind === 1) {
        // embers: near-neutral buoyancy, drift up slowly, wobble
        this.vy[i] -= g * 0.35 * dt;
        this.vx[i] += (Math.random() - 0.5) * 0.0006 * this.scale * dt;
      } else {
        // smoke: rises, decelerates, spreads
        this.vy[i] -= g * 0.2 * dt;
        this.vx[i] *= 0.985;
        this.vy[i] *= 0.99;
      }
      this.life[i] = life;
      alive++;
    }
    this._alive = alive;
  }

  // Advance ONLY the screen-shake decay by one frame; returns a fresh random
  // offset {x,y} within +/- current magnitude, then decays the magnitude.
  // Called from render.js right before the sim blit, ONLY on live frames.
  shakeOffset() {
    if (this.shakeMag <= 0.05) { this.shakeMag = 0; return { x: 0, y: 0 }; }
    const m = this.shakeMag;
    const ox = (Math.random() * 2 - 1) * m;
    const oy = (Math.random() * 2 - 1) * m;
    this.shakeMag = m * this.SHAKE_DECAY;
    return { x: ox, y: oy };
  }

  // Draw all live particles as small filled rects onto the main canvas ctx.
  // Called from render.js AFTER the sim blit, ONLY on live frames. `ox,oy` is
  // the shake offset so particles ride the same shake as the scene.
  draw(ctx, ox = 0, oy = 0) {
    for (let i = 0; i < this.cap; i++) {
      const life = this.life[i];
      if (life <= 0) continue;
      const t = life / this.life0[i];           // 1 -> 0 over lifetime
      // fade alpha out over the last ~60% of life; sparks pop then fade.
      let a = t < 0.4 ? t / 0.4 : 1;
      if (this.kind[i] === 2) a *= 0.55;         // smoke is translucent
      if (a <= 0) continue;
      const sz = Math.max(1, this.size[i] * (0.5 + 0.5 * t)) | 0;
      ctx.globalAlpha = a;
      ctx.fillStyle = `rgb(${this.r[i]},${this.g[i]},${this.b[i]})`;
      ctx.fillRect((this.x[i] + ox) | 0, (this.y[i] + oy) | 0, sz, sz);
    }
    ctx.globalAlpha = 1;
  }

  // Live particle count — exposed via window.__FLUX.particleCount() so the
  // harness can assert spawn-on-blast during live play.
  count() { return this._alive; }
}
