// audio.js — a procedural WebAudio "juice" layer for Fluxsand.
//
// ============================ THE DETERMINISM FIREWALL ======================
// Audio is DISPLAY-ONLY. It is allowed to READ window.__STATE__ (blasts,
// changes, hottestCell, totals, tick) and NOTHING ELSE. It MUST NEVER:
//   * write to the sim grid or any sim buffer,
//   * call the sim's seeded Rng (that would desync every determinism test),
//   * run at all while the render loop is frozen (rafFrozen === true — the
//     headless harness freezes rAF and drives step(n) directly).
//
// The invariant the test suite enforces (tests 03 + 18): window.__FLUX.stateHash()
// after N steps is byte-identical whether or not audio is loaded. This module
// touches no sim state, so loading it cannot change a single cell.
//
// The gesture-unlock + rafFrozen guard that actually wire this live in main.js
// (the frame() loop, which only calls audioEngine.tick() when !rafFrozen) and
// tools.js (unlock() on the first click/keydown). This class is written so that
// even if it WERE called under a suspended/absent audio context, every method
// no-ops safely instead of throwing.
//
// White-noise buffers use the browser's non-seeded Math.random. That is fine:
// the noise never feeds a sim cell, so it cannot affect stateHash().
// ===========================================================================

// Resolve an AudioContext constructor without touching the sim. Returns null in
// any environment that lacks WebAudio (some headless setups) so callers no-op.
function _AC() {
  return (typeof window !== 'undefined')
    ? (window.AudioContext || window.webkitAudioContext || null)
    : null;
}

export class AudioEngine {
  constructor() {
    this.ctx = null;          // lazily created inside a user gesture (unlock)
    this.master = null;       // master GainNode; muting rides this
    this.noiseBuf = null;     // shared white-noise AudioBuffer (built once)
    this.muted = false;       // default UNMUTED (but silent until unlock)
    this.unlocked = false;    // true once unlock() has created+resumed a ctx

    // --- edge-detection memory for event->sound mapping (pure numbers) ------
    // These are the ONLY state this engine keeps between ticks. They are read
    // from window.__STATE__ (a copy), never written back to the sim.
    this._lastTick = -1;
    this._prevSteam = 0;      // steam mass last tick (for the sizzle spike test)
    this._prevChanges = 0;    // phase-change count last tick

    // --- last-computed volumes, exposed via audioState() for the harness -----
    // The harness has no speakers and a suspended context, so it asserts that
    // the EVENT->VOLUME MAPPING was computed, not that sound came out.
    this.lastBoomVol = 0;
    this.lastSizzleVol = 0;
    this.lastCrackleVol = 0;
    this._ambientOn = false;

    // ambient hum node handles (kept so setMuted can leave them running silently)
    this._humA = null;
    this._humB = null;
    this._humGain = null;
  }

  // -------------------------------------------------------------------------
  // unlock(): lazily create the AudioContext and resume() it. MUST be called
  // from inside a user gesture (browser autoplay policy) — tools.js wires this
  // to the first click/keydown. Safe to call again; only the first call builds.
  // Wrapped in try/catch so a blocked/absent context never throws into the UI.
  // -------------------------------------------------------------------------
  unlock() {
    try {
      const AC = _AC();
      if (!AC) return;                       // no WebAudio here — stay inert
      if (!this.ctx) {
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.gain.value = this.muted ? 0 : 0.9;
        this.master.connect(this.ctx.destination);
        this.noiseBuf = this._buildNoise();
        this._startAmbient();
      }
      // A context created outside a gesture starts 'suspended'; resume() inside
      // the gesture flips it to 'running'. In headless Chrome (no audio device)
      // this promise may reject or stay suspended — that's fine, we swallow it.
      if (this.ctx.state === 'suspended' && this.ctx.resume) {
        const p = this.ctx.resume();
        if (p && p.catch) p.catch(() => {});
      }
      this.unlocked = true;
    } catch (_e) {
      // Never let an audio failure surface as an uncaught error in the app.
    }
  }

  // -------------------------------------------------------------------------
  // setMuted(bool): ride the master gain to 0 (or back up). Leaves all nodes —
  // including the always-on ambient hum — running so unmuting is instant. Pure
  // audio-graph state; touches no sim data.
  // -------------------------------------------------------------------------
  setMuted(m) {
    this.muted = !!m;
    try {
      if (this.master && this.ctx) {
        const now = this.ctx.currentTime;
        this.master.gain.cancelScheduledValues(now);
        this.master.gain.setValueAtTime(this.muted ? 0 : 0.9, now);
      }
    } catch (_e) { /* no-op on a dead context */ }
    return this.muted;
  }

  // -------------------------------------------------------------------------
  // audioState(): a NUMBERS/booleans-only snapshot for the test harness. No
  // audio hardware is required to read this — it reports what the mapping layer
  // computed, so a suspended/headless context can still be asserted against.
  // -------------------------------------------------------------------------
  audioState() {
    return {
      unlocked: this.unlocked,
      muted: this.muted,
      ctxState: this.ctx ? this.ctx.state : 'none',
      lastBoomVol: this.lastBoomVol,
      lastSizzleVol: this.lastSizzleVol,
      lastCrackleVol: this.lastCrackleVol,
      ambientOn: this._ambientOn,
      lastTick: this._lastTick,
    };
  }

  // -------------------------------------------------------------------------
  // tick(state): the per-frame event->sound mapping. Called from main.js
  // frame() ONLY when (!rafFrozen && !muted). Reads a snapshot of __STATE__ and
  // triggers the relevant one-shot sounds. Every branch is guarded; if `state`
  // is missing or the context is dead, it computes/records nothing and returns.
  //
  // IMPORTANT: this NEVER writes to the sim. The only things it mutates are this
  // engine's own edge-detection fields (_prevSteam, _prevChanges, _lastTick) and
  // the WebAudio graph. Nothing here can move a cell or draw from the seeded rng.
  // -------------------------------------------------------------------------
  tick(state) {
    if (!state) return;
    // De-dupe: run the mapping at most once per sim tick even if frame() fires
    // several times between ticks. Also the natural home for "ONE boom per tick".
    const tk = state.tick | 0;
    if (tk === this._lastTick) return;
    this._lastTick = tk;

    const totals = state.totals || {};
    const mass = totals.massByMaterial || {};
    const steam = mass.steam || 0;
    const fire = mass.fire || 0;
    const changes = state.changes | 0;
    const blasts = state.blasts | 0;

    // Reset per-tick volume readouts (so audioState reflects THIS tick).
    this.lastBoomVol = 0;
    this.lastSizzleVol = 0;
    this.lastCrackleVol = 0;

    // --- BOOM: explosions. blasts = cells affected by detonations this tick. --
    // ONE boom per tick regardless of how many cells/clusters detonated; volume
    // scales with the blast size up to a cap so a huge TNT breach is louder than
    // a single gunpowder grain but never clips.
    if (blasts > 0) {
      const BLAST_CAP = 60;
      const vol = Math.min(blasts, BLAST_CAP) / BLAST_CAP; // 0..1
      this.lastBoomVol = vol;
      this._boom(vol);
    }

    // --- SIZZLE: water meets lava -> a spike of steam. Fire when steam mass is --
    // RISING and there's a burst of phase-change activity this tick (the hiss).
    const steamRising = steam > this._prevSteam;
    const changeSpike = changes > 4; // a real burst, not one stray cell
    if (steamRising && changeSpike) {
      const gained = steam - this._prevSteam;
      const vol = Math.min(1, 0.25 + gained / 40); // louder for a bigger flash
      this.lastSizzleVol = vol;
      this._sizzle(vol);
    }

    // --- CRACKLE: fire ambience. Short noise ticks fired probabilistically with --
    // probability scaled by current fire mass. Uses Math.random (browser, NOT the
    // sim rng) — this randomness never touches a sim cell, so determinism holds.
    if (fire > 0) {
      const p = Math.min(0.6, fire / 120);   // more fire -> more frequent crackle
      // Record the intended crackle intensity for the harness even on ticks
      // where the probabilistic roll doesn't fire an actual sound.
      this.lastCrackleVol = Math.min(1, 0.2 + fire / 200);
      if (Math.random() < p) this._crackle(this.lastCrackleVol);
    }

    // advance edge-detection memory
    this._prevSteam = steam;
    this._prevChanges = changes;
  }

  // =========================== SOUND PRIMITIVES ==============================
  // Each primitive builds a tiny throwaway node graph, schedules an ADSR-style
  // gain envelope (setValueAtTime -> exponentialRampToValueAtTime), and lets the
  // nodes stop themselves. All are guarded: if there's no running context they
  // return immediately. None of them read or write sim state.

  _ready() {
    // A primitive should actually emit only when there's a running, unmuted
    // context. audioState still records the computed volume above regardless.
    return !!(this.ctx && this.master && !this.muted && this.ctx.state === 'running');
  }

  // Build a 1-second white-noise buffer once and reuse it for all noise voices.
  _buildNoise() {
    try {
      const sr = this.ctx.sampleRate || 44100;
      const buf = this.ctx.createBuffer(1, sr, sr);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      return buf;
    } catch (_e) {
      return null;
    }
  }

  _noiseSource() {
    if (!this.noiseBuf) this.noiseBuf = this._buildNoise();
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    return src;
  }

  // boom(): a white-noise burst layered with a low sine sweeping downward, both
  // with a fast exponential decay. The classic explosion "thud + crack".
  _boom(vol) {
    if (!this._ready()) return;
    try {
      const ctx = this.ctx, now = ctx.currentTime;
      const peak = 0.9 * Math.max(0.05, Math.min(1, vol));

      // noise burst (the crack)
      const noise = this._noiseSource();
      const nGain = ctx.createGain();
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(1800, now);
      lp.frequency.exponentialRampToValueAtTime(180, now + 0.4);
      nGain.gain.setValueAtTime(peak, now);
      nGain.gain.exponentialRampToValueAtTime(0.0008, now + 0.5);
      noise.connect(lp); lp.connect(nGain); nGain.connect(this.master);
      noise.start(now); noise.stop(now + 0.55);

      // low sine sweep (the thud)
      const osc = ctx.createOscillator();
      const oGain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(140, now);
      osc.frequency.exponentialRampToValueAtTime(38, now + 0.45);
      oGain.gain.setValueAtTime(peak, now);
      oGain.gain.exponentialRampToValueAtTime(0.0008, now + 0.5);
      osc.connect(oGain); oGain.connect(this.master);
      osc.start(now); osc.stop(now + 0.55);
    } catch (_e) { /* dead context — ignore */ }
  }

  // sizzle(): band-limited (band-pass) noise with a medium decay — the wet hiss
  // of water flashing to steam on lava.
  _sizzle(vol) {
    if (!this._ready()) return;
    try {
      const ctx = this.ctx, now = ctx.currentTime;
      const peak = 0.35 * Math.max(0.05, Math.min(1, vol));
      const noise = this._noiseSource();
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(3200, now);
      bp.frequency.exponentialRampToValueAtTime(1400, now + 0.6);
      bp.Q.value = 0.8;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0008, now);
      g.gain.exponentialRampToValueAtTime(peak, now + 0.03); // quick attack
      g.gain.exponentialRampToValueAtTime(0.0008, now + 0.7); // medium decay
      noise.connect(bp); bp.connect(g); g.connect(this.master);
      noise.start(now); noise.stop(now + 0.72);
    } catch (_e) { /* ignore */ }
  }

  // crackle(): a very short filtered noise tick — one "pop" of the fire bed.
  _crackle(vol) {
    if (!this._ready()) return;
    try {
      const ctx = this.ctx, now = ctx.currentTime;
      const peak = 0.18 * Math.max(0.05, Math.min(1, vol));
      const noise = this._noiseSource();
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 900 + Math.random() * 1600; // vary the timbre per pop
      const g = ctx.createGain();
      g.gain.setValueAtTime(peak, now);
      g.gain.exponentialRampToValueAtTime(0.0006, now + 0.06); // very fast decay
      noise.connect(hp); hp.connect(g); g.connect(this.master);
      noise.start(now); noise.stop(now + 0.08);
    } catch (_e) { /* ignore */ }
  }

  // ambient hum: two slightly detuned low sines at very low gain, always on
  // while unlocked — a subtle "the world is alive" presence. Started once in
  // unlock(); rides the master gain so muting silences it too.
  _startAmbient() {
    if (this._ambientOn || !this.ctx) return;
    try {
      const ctx = this.ctx, now = ctx.currentTime;
      this._humGain = ctx.createGain();
      this._humGain.gain.value = 0.035; // very quiet bed
      this._humA = ctx.createOscillator();
      this._humB = ctx.createOscillator();
      this._humA.type = 'sine'; this._humB.type = 'sine';
      this._humA.frequency.value = 55;   // low A-ish
      this._humB.frequency.value = 55.4; // slight detune -> slow beating
      this._humA.connect(this._humGain);
      this._humB.connect(this._humGain);
      this._humGain.connect(this.master);
      this._humA.start(now); this._humB.start(now);
      this._ambientOn = true;
    } catch (_e) {
      this._ambientOn = false;
    }
  }
}
