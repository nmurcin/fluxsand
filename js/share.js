// share.js — encode/decode a scene into the URL hash. Fully static, no backend.
//
// Format: #s=<seed>~<w>x<h>~<rle> where rle is a run-length encoding of material
// ids over the grid in row-major order, base36-packed as "<count>.<id>" runs
// joined by "!". Temperatures are reset to each material's baseTemp/ambient on
// load (we only persist material layout, which keeps the hash compact and the
// reload deterministic). Good enough to share a built scene; the sim re-derives
// heat from the materials themselves.

import { MATERIALS } from './materials.js';

export function encodeScene(grid, seed) {
  const mat = grid.mat;
  const parts = [];
  let runId = mat[0], runLen = 1;
  for (let i = 1; i < grid.n; i++) {
    if (mat[i] === runId) { runLen++; }
    else { parts.push(runLen.toString(36) + '.' + runId.toString(36)); runId = mat[i]; runLen = 1; }
  }
  parts.push(runLen.toString(36) + '.' + runId.toString(36));
  return `s=${(seed >>> 0).toString(36)}~${grid.w}x${grid.h}~${parts.join('!')}`;
}

export function decodeScene(hash) {
  // hash without leading '#'
  const m = /^s=([0-9a-z]+)~(\d+)x(\d+)~(.*)$/i.exec(hash);
  if (!m) return null;
  const seed = parseInt(m[1], 36);
  const w = +m[2], h = +m[3];
  const runs = m[4].split('!');
  const cells = new Uint16Array(w * h);
  let idx = 0;
  for (const r of runs) {
    const dot = r.indexOf('.');
    if (dot < 0) continue;
    const count = parseInt(r.slice(0, dot), 36);
    const id = parseInt(r.slice(dot + 1), 36);
    if (!(id >= 0 && id < MATERIALS.length)) return null;
    for (let k = 0; k < count && idx < cells.length; k++) cells[idx++] = id;
  }
  if (idx !== w * h) return null; // corrupt / wrong size
  return { seed, w, h, cells };
}

// Apply a decoded scene onto a grid (must match dimensions).
export function applyScene(grid, decoded) {
  if (!decoded || decoded.w !== grid.w || decoded.h !== grid.h) return false;
  grid.clear();
  for (let i = 0; i < grid.n; i++) grid.setIdx(i, decoded.cells[i]);
  return true;
}
