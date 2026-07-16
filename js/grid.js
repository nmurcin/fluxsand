// grid.js — the single source of truth. FROZEN LAYOUT.
//
// Three parallel flat typed arrays indexed by (y*W + x):
//   mat[i]   : Uint16  material id
//   temp[i]  : Float32 temperature in degrees C
//   latent[i]: Float32 accumulated latent energy toward the next phase change
//
// Plus a per-cell scratch:
//   life[i]  : Int16   remaining lifetime for ephemeral materials (fire/steam/smoke), else -1
//   moved[i] : Uint8   "already moved this tick" flag to prevent double-stepping
//
// Everything else in the app is a pure function of these arrays.

import { MATERIALS, M, PHASE } from './materials.js';

export class Grid {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    const n = w * h;
    this.n = n;
    this.mat = new Uint16Array(n);
    this.temp = new Float32Array(n);
    this.latent = new Float32Array(n);
    this.life = new Int16Array(n);
    this.moved = new Uint8Array(n);
    this.ambient = 22; // ambient/room temperature in C
    this.clear();
  }

  idx(x, y) {
    return y * this.w + x;
  }
  inBounds(x, y) {
    return x >= 0 && y >= 0 && x < this.w && y < this.h;
  }

  clear() {
    this.mat.fill(M.EMPTY);
    this.temp.fill(this.ambient);
    this.latent.fill(0);
    this.life.fill(-1);
    this.moved.fill(0);
  }

  // Place a material at a cell, initializing temp/lifetime from its definition.
  set(x, y, id) {
    if (!this.inBounds(x, y)) return;
    const i = y * this.w + x;
    this.setIdx(i, id);
  }

  setIdx(i, id) {
    const def = MATERIALS[id];
    this.mat[i] = id;
    this.latent[i] = 0;
    if (def.baseTemp !== undefined) this.temp[i] = def.baseTemp;
    this.life[i] = def.lifetime ? def.lifetime : -1;
  }

  // Convert a cell to a new material WITHOUT resetting its temperature
  // (used by phase changes so energy history is preserved sensibly).
  convert(i, id, keepTemp = true) {
    const def = MATERIALS[id];
    const t = this.temp[i];
    this.mat[i] = id;
    this.latent[i] = 0;
    if (!keepTemp && def.baseTemp !== undefined) this.temp[i] = def.baseTemp;
    else this.temp[i] = t;
    this.life[i] = def.lifetime ? def.lifetime : -1;
  }

  phaseAt(i) {
    return MATERIALS[this.mat[i]].phase;
  }
  defAt(i) {
    return MATERIALS[this.mat[i]];
  }
  isEmpty(i) {
    return this.mat[i] === M.EMPTY;
  }
}
