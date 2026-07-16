// scenarios.js — deterministic seeded starting states.
//
// Each scenario is a PURE function of (grid, rng, dims). The ONLY source of
// randomness is the injected seeded `rng` (mulberry32) — never the wall clock,
// never Math.random. Same seed => byte-identical scene => the harness can diff.
//
// These double as showpieces (frame-one "wow") and as clean test fixtures.
//
// GEOMETRY RULES (learned the hard way):
//   * Draw SOLID FILLED shapes. A cone is a fully-filled triangle of stone, not
//     a stack of thin horizontal lines with empty gaps — gaps let liquids leak
//     sideways and flood the interior.
//   * Containers (boilers, tanks, hourglasses) need CONTINUOUS walls: no
//     one-cell holes anywhere, including the floor and the lid, or the contents
//     escape.
//   * Bore channels/conduits as narrow columns THROUGH already-solid rock.
//
// THERMAL NOTE: grid.set() seeds a cell's temperature from its material's
// baseTemp (lava 1150C, molten metal 1500C, fire 820C, ember 700C, ice -12C,
// steam 110C). Everything else starts at ambient (22C). Scenes are composed so
// the interesting physics unfolds on its own once the sim runs.

import { M } from './materials.js';

// ---- drawing helpers --------------------------------------------------------

// Filled axis-aligned rectangle (inclusive of both corners), order-agnostic.
function fill(grid, x0, y0, x1, y1, id) {
  const ax = Math.min(x0, x1), bx = Math.max(x0, x1);
  const ay = Math.min(y0, y1), by = Math.max(y0, y1);
  for (let y = ay; y <= by; y++)
    for (let x = ax; x <= bx; x++)
      if (grid.inBounds(x, y)) grid.set(x, y, id);
}

// A single horizontal span (one row) — inclusive.
function row(grid, xa, xb, y, id) {
  const lo = Math.min(xa, xb), hi = Math.max(xa, xb);
  for (let x = lo; x <= hi; x++) if (grid.inBounds(x, y)) grid.set(x, y, id);
}

// A single vertical span (one column) — inclusive.
function col(grid, x, ya, yb, id) {
  const lo = Math.min(ya, yb), hi = Math.max(ya, yb);
  for (let y = lo; y <= hi; y++) if (grid.inBounds(x, y)) grid.set(x, y, id);
}

// Filled disc of radius r centered at (cx,cy).
function disc(grid, cx, cy, r, id) {
  const r2 = r * r;
  for (let y = cy - r; y <= cy + r; y++)
    for (let x = cx - r; x <= cx + r; x++) {
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy <= r2 && grid.inBounds(x, y)) grid.set(x, y, id);
    }
}

// Overwrite a cell only if it currently holds material `onlyIf` (used to bore
// a channel through solid rock without punching into open air first).
function carveIf(grid, x, y, onlyIf, id) {
  if (!grid.inBounds(x, y)) return;
  const i = grid.idx(x, y);
  if (grid.mat[i] === onlyIf) grid.set(x, y, id);
}

// ---- scenarios --------------------------------------------------------------

export const SCENARIOS = {
  // VOLCANO ------------------------------------------------------------------
  // A properly FILLED stone cone: for each row, the full horizontal span from
  // the left flank to the right flank is solid rock. A lava chamber sits at the
  // base; a narrow throat is bored straight up through the solid rock to a
  // crater. A little ice cap perches on the summit (melts + trickles), and two
  // small water pools rest in stone basins on the flanks (steam when reached).
  Volcano(grid, rng, d) {
    const W = grid.w, H = grid.h;
    grid.clear();

    const groundY = H - 18;                 // top of the ground slab
    fill(grid, 0, groundY, W - 1, H - 1, M.STONE);

    const cx = W >> 1;
    const peakY = 26;                        // summit row (near sky)
    const halfBase = 96;                     // half-width where the cone meets ground
    const coneH = groundY - peakY;           // vertical extent of the cone

    // Fully-filled triangular cone. Each row's half-width scales linearly from
    // the summit (a few cells wide) to the base. Slight per-row jitter gives the
    // flanks a natural, non-ruler-straight silhouette without opening any gaps.
    for (let y = peakY; y < groundY; y++) {
      const t = (y - peakY) / coneH;         // 0 at summit .. 1 at base
      let half = Math.round(4 + t * (halfBase - 4));
      half += rng.int(3) - 1;                // -1..+1 wobble
      if (half < 3) half = 3;
      row(grid, cx - half, cx + half, y, M.STONE);
    }

    // Lava chamber: a fat pocket carved into the solid base, then filled.
    const chTop = groundY - 14, chBot = groundY + 10;
    fill(grid, cx - 30, chTop, cx + 30, chBot, M.STONE); // ensure solid host rock
    fill(grid, cx - 22, chTop + 2, cx + 22, chBot - 2, M.LAVA);

    // Bore a narrow vertical throat straight up from the chamber to just below
    // the summit, carving ONLY through stone so we never open the flanks.
    const throatTop = peakY + 8;
    for (let y = throatTop; y <= chTop + 2; y++) {
      for (let x = cx - 2; x <= cx + 2; x++) carveIf(grid, x, y, M.STONE, M.LAVA);
    }
    // Open a small crater mouth at the very top (empty bowl the lava wells into).
    fill(grid, cx - 4, peakY, cx + 4, peakY + 5, M.EMPTY);
    fill(grid, cx - 2, peakY + 4, cx + 2, throatTop, M.LAVA);

    // A little ice cap straddling the crater rim — will melt and drip.
    row(grid, cx - 8, cx - 5, peakY - 1, M.ICE);
    row(grid, cx + 5, cx + 8, peakY - 1, M.ICE);
    fill(grid, cx - 9, peakY, cx - 5, peakY + 1, M.ICE);
    fill(grid, cx + 5, peakY, cx + 9, peakY + 1, M.ICE);

    // Two small water pools cradled in stone basins on the flanks. The basin
    // walls are solid so the water can't drain into the cone.
    const poolY = groundY - 3;
    // left basin
    fill(grid, 26, poolY - 3, 52, poolY + 2, M.STONE);
    fill(grid, 29, poolY - 2, 49, poolY + 1, M.WATER);
    // right basin
    fill(grid, W - 52, poolY - 3, W - 26, poolY + 2, M.STONE);
    fill(grid, W - 49, poolY - 2, W - 29, poolY + 1, M.WATER);
  },

  // ICE AGE ------------------------------------------------------------------
  // A frozen landscape: a thick ice sheet blanketing a stone bedrock, with a
  // few glassy ice hummocks on the surface. Buried in the bedrock is a walled
  // lava pocket (a geothermal vent) plus a lone ember nearer the surface. Heat
  // radiates upward and thaws the ice from below and within — watch the melt
  // line advance and meltwater pool in the low spots.
  IceAge(grid, rng, d) {
    const W = grid.w, H = grid.h;
    grid.clear();

    const bedrockTop = H - 40;
    fill(grid, 0, bedrockTop, W - 1, H - 1, M.STONE);

    // Ice sheet over the bedrock, with a gently rolling top surface.
    const iceBase = bedrockTop - 1;          // ice sits on the bedrock
    const iceTopMean = H - 92;
    for (let x = 0; x < W; x++) {
      // smooth deterministic rolling surface from two phase-offset cosines
      const roll = Math.round(
        5 * Math.cos(x * 0.05) + 3 * Math.cos(x * 0.11 + 1.7)
      );
      let top = iceTopMean + roll;
      if (rng.chance(0.15)) top -= 1;         // sparse surface texture
      col(grid, x, top, iceBase, M.ICE);
    }

    // A couple of icy hummocks rising off the sheet for silhouette interest.
    disc(grid, 70, H - 96, 6, M.ICE);
    disc(grid, W - 90, H - 100, 7, M.ICE);

    // Buried geothermal vent: a stone-lined lava pocket deep in the bedrock so
    // the lava is contained and simply radiates heat upward through the rock.
    const vx = W >> 1, vy = H - 22;
    fill(grid, vx - 16, vy - 8, vx + 16, vy + 8, M.STONE);
    fill(grid, vx - 11, vy - 4, vx + 11, vy + 5, M.LAVA);

    // A lone ember lodged just under the ice on one side — a second, faster
    // thaw front closer to the surface.
    const ex = 96;
    fill(grid, ex - 3, bedrockTop - 4, ex + 3, bedrockTop + 1, M.STONE);
    fill(grid, ex - 1, bedrockTop - 2, ex + 1, bedrockTop - 1, M.EMBER);

    // A shallow surface meltwater pool to seed the "already thawing" story.
    fill(grid, 150, iceTopMean - 2, 190, iceTopMean, M.WATER);
  },

  // THERMITE -----------------------------------------------------------------
  // A row of steel billets on a stone floor. Each billet has an oil-soaked wick
  // channel bored down into its top, capped with fire. Metal conducts heat
  // fast (conduct 0.92): the fire lights the oil, the oil sustains a hot flame,
  // the steel glows, banks latent heat, and finally slumps into molten metal.
  Thermite(grid, rng, d) {
    const W = grid.w, H = grid.h;
    grid.clear();

    const floorTop = H - 16;
    fill(grid, 0, floorTop, W - 1, H - 1, M.STONE);

    const count = 5;
    const blockW = 30;
    const gap = (W - count * blockW) / (count + 1);
    const blockTop = H - 66;

    for (let k = 0; k < count; k++) {
      const x0 = Math.round(gap + k * (blockW + gap));
      const x1 = x0 + blockW - 1;

      // Solid steel billet standing on the floor.
      fill(grid, x0, blockTop, x1, floorTop - 1, M.METAL);

      // Bore a wick well down into the billet's top and flood it with oil.
      const wx0 = x0 + 10, wx1 = x1 - 10;
      const wellBot = blockTop + 12;
      for (let y = blockTop; y <= wellBot; y++)
        for (let x = wx0; x <= wx1; x++) carveIf(grid, x, y, M.METAL, M.OIL);

      // A raised oil bead + fire cap sitting proud of the billet to ignite it.
      fill(grid, wx0, blockTop - 4, wx1, blockTop - 1, M.OIL);
      fill(grid, wx0 + 1, blockTop - 7, wx1 - 1, blockTop - 5, M.FIRE);
      // a lick of extra flame, jittered so the five don't look stamped
      if (rng.chance(0.6)) grid.set(wx0 + 1 + rng.int(wx1 - wx0 - 1), blockTop - 8, M.FIRE);
    }
  },

  // STEAM --------------------------------------------------------------------
  // A sealed steel boiler over a lava firebox. The boiler has CONTINUOUS walls
  // on all four sides (left, right, lid, and a solid metal floor) so neither
  // water nor steam can leak. Beneath the metal floor sits a lava firebox in a
  // stone hearth; heat conducts up through the metal (conduct 0.92) into the
  // water, driving it to a rolling boil — steam collects under the lid.
  Steam(grid, rng, d) {
    const W = grid.w, H = grid.h;
    grid.clear();

    // Ground/hearth base.
    fill(grid, 0, H - 12, W - 1, H - 1, M.STONE);

    // Boiler footprint.
    const bx0 = 74, bx1 = W - 74;            // inner-wall reference edges
    const lidY = H - 118;                     // top wall (lid)
    const floorY = H - 40;                    // boiler floor (metal, 2 thick)
    const wall = 3;                           // wall thickness

    // Continuous metal shell: lid, floor, and both side walls. Draw each as a
    // filled bar so there are provably no one-cell holes.
    fill(grid, bx0 - wall, lidY, bx1 + wall, lidY + wall - 1, M.METAL);      // lid
    fill(grid, bx0 - wall, floorY, bx1 + wall, floorY + 1, M.METAL);         // floor (2 thick)
    fill(grid, bx0 - wall, lidY, bx0 - 1, floorY + 1, M.METAL);              // left wall
    fill(grid, bx1 + 1, lidY, bx1 + wall, floorY + 1, M.METAL);             // right wall

    // Water fills most of the interior, leaving a headspace under the lid for
    // steam to gather.
    const interiorTop = lidY + wall;
    const waterTop = interiorTop + 10;        // ~10 cells of headspace
    fill(grid, bx0, waterTop, bx1, floorY - 1, M.WATER);

    // Lava firebox in a stone hearth directly beneath the metal floor. The
    // stone hearth wraps the lava so it stays put and feeds heat into the floor.
    const fbTop = floorY + 2, fbBot = H - 13;
    fill(grid, bx0 - wall, fbTop, bx1 + wall, fbBot, M.STONE);   // solid hearth
    fill(grid, bx0 + 4, fbTop + 1, bx1 - 4, fbBot - 1, M.LAVA);  // lava pocket

    // A wisp of steam pre-seeded in the headspace so frame one already reads as
    // a live boiler rather than a cold tank.
    for (let n = 0; n < 6; n++) {
      const sx = bx0 + 4 + rng.int(bx1 - bx0 - 8);
      const sy = interiorTop + 1 + rng.int(6);
      grid.set(sx, sy, M.STEAM);
    }
  },

  // HOURGLASS ----------------------------------------------------------------
  // Two glass chambers joined by a narrow neck, the upper chamber packed with
  // sand. The frame is solid glass (with a continuous outline), the neck is a
  // one-to-few-cell aperture. Sand drains through the pinch and piles at its
  // angle of repose in the lower bulb — powder-flow beauty.
  Hourglass(grid, rng, d) {
    const W = grid.w, H = grid.h;
    grid.clear();

    // Floor to stand on.
    fill(grid, 0, H - 10, W - 1, H - 1, M.STONE);

    const cx = W >> 1;
    const topY = 16;                          // top of the upper bulb
    const botY = H - 12;                      // bottom of the lower bulb
    const midY = (topY + botY) >> 1;          // the pinch
    const maxHalf = 60;                       // half-width at the flared ends
    const neckHalf = 3;                        // half-width at the neck aperture

    // For each row, the glass silhouette is two triangles meeting at the neck.
    // half(y) shrinks linearly to the neck then grows again — an hourglass.
    const halfAt = (y) => {
      const span = midY - topY;
      const frac = Math.abs(y - midY) / span;  // 0 at neck, 1 at the flares
      return Math.round(neckHalf + frac * (maxHalf - neckHalf));
    };

    // Draw the glass WALLS as a continuous outline: at each row, place glass on
    // the left and right edges (a few cells thick) so the interior is sealed.
    const wallT = 3;
    for (let y = topY; y <= botY; y++) {
      const half = halfAt(y);
      // left wall and right wall
      row(grid, cx - half - wallT + 1, cx - half, y, M.GLASS);
      row(grid, cx + half, cx + half + wallT - 1, y, M.GLASS);
    }
    // Cap the very top and bottom with solid glass lids so sand can't spill out.
    row(grid, cx - halfAt(topY) - wallT + 1, cx + halfAt(topY) + wallT - 1, topY, M.GLASS);
    fill(grid, cx - halfAt(topY) - wallT + 1, topY, cx + halfAt(topY) + wallT - 1, topY + 1, M.GLASS);
    fill(grid, cx - halfAt(botY) - wallT + 1, botY - 1, cx + halfAt(botY) + wallT - 1, botY, M.GLASS);

    // Fill the UPPER bulb interior with sand (leave a little headroom at the
    // very top and don't fill the neck itself so it can trickle).
    for (let y = topY + 2; y < midY - 1; y++) {
      const half = halfAt(y) - 1;             // stay just inside the glass
      if (half < 1) continue;
      // sparse deterministic gaps make the packed sand look granular, not solid
      for (let x = cx - half; x <= cx + half; x++) {
        if (rng.chance(0.02)) continue;       // occasional void grain
        grid.set(x, y, M.SAND);
      }
    }

    // Open the neck aperture so the sand has a path down into the lower bulb.
    for (let y = midY - 1; y <= midY + 1; y++)
      fill(grid, cx - neckHalf + 1, y, cx + neckHalf - 1, y, M.EMPTY);
  },

  // EMPTY --------------------------------------------------------------------
  // A clean sandbox: just a stone floor to build on.
  Empty(grid, rng, d) {
    const W = grid.w, H = grid.h;
    grid.clear();
    fill(grid, 0, H - 12, W - 1, H - 1, M.STONE);
  },
};

// ---- case-insensitive lookup + loader ---------------------------------------

const LOOKUP = {};
for (const k of Object.keys(SCENARIOS)) LOOKUP[k.toLowerCase()] = k;

export function loadScenario(name, grid, rng, dims) {
  const key = LOOKUP[(name || '').toLowerCase()];
  if (!key) return false;
  SCENARIOS[key](grid, rng, dims);
  return true;
}
