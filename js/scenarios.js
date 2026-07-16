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
  // A steel foundry crucible: thin steel rods dipped into a molten-metal bath.
  //
  // Physics note that shaped this scene: steel melts at 1400C, but lava only
  // holds ~1150C — lava physically CANNOT melt steel. Molten metal, however,
  // is a persistent ~1500C source. And a THICK billet acts as a heat sink that
  // never reaches melt. So the working recipe is THIN rods (2 cells) standing
  // in a molten-metal bath: each rod cell is surrounded by 1500C liquid, banks
  // its latent-melt energy fast, glows incandescent, and slumps into the bath.
  // Oil-soaked wicks capped with fire ride on top for the ignition flash.
  Thermite(grid, rng, d) {
    const W = grid.w, H = grid.h;
    grid.clear();

    const floorTop = H - 14;
    fill(grid, 0, floorTop, W - 1, H - 1, M.STONE);

    // Stone crucible with CONTINUOUS walls cradling a deep molten-metal bath.
    const cxL = 30, cxR = W - 30;
    const bathTop = H - 80, bathBot = floorTop - 1;                    // DEEP bath
    fill(grid, cxL - 5, bathTop - 3, cxR + 5, bathBot + 1, M.STONE);   // solid host rock
    fill(grid, cxL, bathTop, cxR, bathBot, M.MOLTEN_METAL);            // 1500C bath

    // Thin steel rods DEEPLY dipped: each rod runs from 2 cells above the bath
    // surface down to near the bottom, so its submerged length is enveloped on
    // three sides by 1500C liquid — that envelopment is what actually melts it.
    // The 2-cell tips poking into cool air survive as glowing incandescent studs.
    const count = 9;
    const span = cxR - cxL;
    const stepX = span / count;
    const rodTopY = bathTop - 2;
    const rodBotY = bathBot - 3;

    for (let k = 0; k < count; k++) {
      const rx = Math.round(cxL + stepX * (k + 0.5));
      fill(grid, rx - 1, rodTopY, rx, rodBotY, M.METAL);   // 2-wide rod

      // Oil bead + fire cap on the exposed tip for the ignition flash.
      fill(grid, rx - 1, rodTopY - 3, rx, rodTopY - 1, M.OIL);
      grid.set(rx - 1, rodTopY - 5, M.FIRE);
      if (rng.chance(0.6)) grid.set(rx, rodTopY - 6, M.FIRE);
    }

    // A ragged oil ribbon skimming the rod tips so the flame front travels
    // across the crucible instead of sitting in nine isolated dots.
    const ribbonY = rodTopY - 2;
    for (let x = cxL + 4; x <= cxR - 4; x++)
      if (rng.chance(0.5)) grid.set(x, ribbonY, M.OIL);
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

  // CRYO LAB -----------------------------------------------------------------
  // A liquid-nitrogen tank breach flash-freezes a warm pool. An overhead metal
  // tank (CONTINUOUS walls) holds LN2 at -205C; its floor is breached by a 2-cell
  // drain hole so the cryo liquid streams straight down (gravity feed) into a
  // concrete tub of ~ambient water directly below. As the LN2 lands it snap-freezes
  // the water to ice and boils off to cold nitrogen fog — a cryogenic liquid
  // boiling *because the room is warm*. A frosted plant bed, subliming dry-ice
  // bricks, and a dusting of snow complete the cold-lab tableau.
  CryoLab(grid, rng, d) {
    const W = grid.w, H = grid.h;
    grid.clear();

    const floorTop = H - 14;
    fill(grid, 0, floorTop, W - 1, H - 1, M.CONCRETE);        // lab floor

    // Overhead LN2 tank — CONTINUOUS metal shell, hollowed and part-filled.
    const tx0 = 40, tx1 = 150, tTop = 18, tBot = 70, wall = 3;
    fill(grid, tx0 - wall, tTop, tx1 + wall, tBot + wall, M.METAL);   // solid metal block
    fill(grid, tx0, tTop + wall, tx1, tBot - 1, M.EMPTY);             // hollow interior
    fill(grid, tx0, tTop + wall + 2, tx1, tBot - 2, M.LIQUID_NITROGEN); // -205C fill, headspace above

    // Breach the tank floor: a 2-cell drain hole so LN2 streams straight down.
    const holeX = (tx0 + tx1) >> 1;
    fill(grid, holeX - 1, tBot - 1, holeX + 1, tBot + wall, M.EMPTY);  // carve through the metal floor

    // Target basin directly under the drain: warm water in a concrete tub.
    const bx0 = holeX - 34, bx1 = holeX + 34, bTop = floorTop - 26, bBot = floorTop - 1;
    fill(grid, bx0 - 4, bTop - 2, bx1 + 4, bBot + 2, M.CONCRETE);      // solid tub host
    fill(grid, bx0, bTop, bx1, bBot, M.EMPTY);                         // hollow it
    fill(grid, bx0, bTop + 8, bx1, bBot, M.WATER);                     // ambient water (freeze target)

    // A living plant bed to the right that will frost over.
    for (let x = bx1 + 16; x < W - 24; x++) {
      grid.set(x, floorTop - 1, M.CONCRETE);
      if (rng.chance(0.5)) col(grid, x, floorTop - 4, floorTop - 2, M.PLANT);
    }
    fill(grid, bx1 + 14, floorTop - 3, bx1 + 14, floorTop - 1, M.WATER); // damp soil edge

    // Dry-ice bricks on the floor (foreground): sublime into a low CO2 fog.
    for (let k = 0; k < 4; k++) {
      const dx = 170 + k * 22 + rng.int(4);
      fill(grid, dx, floorTop - 4, dx + 6, floorTop - 1, M.DRY_ICE);
    }

    // A light dusting of snow across the whole floor for atmosphere.
    for (let x = 4; x < W - 4; x++)
      if (rng.chance(0.18)) grid.set(x, floorTop - 1, M.SNOW);

    // Frame-one wisp of cryo liquid already leaking from the drain so it reads live.
    for (let n = 0; n < 5; n++)
      grid.set(holeX - 2 + rng.int(5), bTop - 3 - rng.int(4), M.LIQUID_NITROGEN);
  },

  // POWDER KEG ---------------------------------------------------------------
  // A spark drops onto a tar-soaked fuse rope; the flame front races along the
  // slow-burning tar to a sealed stone vault packed with gunpowder, where the
  // powder deflagrates cell-to-cell in a fast chain and blows out through a
  // deliberately thin (weak) roof panel. A napalm-skinned wooden crate ignites
  // into a sticky, long-burning secondary fire — gunpowder's fast cascade vs
  // napalm's slow sticky burn side by side.
  PowderKeg(grid, rng, d) {
    const W = grid.w, H = grid.h;
    grid.clear();

    const floorTop = H - 12;
    fill(grid, 0, floorTop, W - 1, H - 1, M.STONE);

    // Sealed powder vault: CONTINUOUS stone walls, one thin (weak) roof panel.
    const vx0 = 180, vx1 = 280, vTop = floorTop - 70, vBot = floorTop - 1, wall = 4;
    fill(grid, vx0 - wall, vTop - wall, vx1 + wall, vBot, M.STONE);    // solid host block
    fill(grid, vx0, vTop, vx1, vBot - 1, M.EMPTY);                     // hollow chamber
    fill(grid, vx0, vBot - 30, vx1, vBot - 1, M.GUNPOWDER);            // packed powder charge
    for (let x = vx0; x <= vx1; x++)
      if (rng.chance(0.08)) grid.set(x, vBot - 31, M.GUNPOWDER);       // ragged top surface
    row(grid, vx0, vx1, vTop - 1, M.STONE);                           // deliberately thin blow-out lid

    // Fuse entry: bore a 2-cell tar channel through the LEFT vault wall.
    const fuseY = vBot - 6;
    for (let x = vx0 - wall - 1; x <= vx0; x++) carveIf(grid, x, fuseY, M.STONE, M.TAR);
    for (let x = vx0 - wall - 1; x <= vx0; x++) carveIf(grid, x, fuseY + 1, M.STONE, M.TAR);

    // Tar fuse rope laid across the open floor out to the ignition point.
    const fuseStartX = 30;
    for (let x = fuseStartX; x < vx0 - wall; x++) {
      grid.set(x, fuseY, M.TAR);
      grid.set(x, fuseY + 1, M.TAR);
    }

    // Napalm-coated crate near the vault: a wood core wrapped in napalm skin.
    const kx = vx0 - 40;
    fill(grid, kx - 8, floorTop - 16, kx + 8, floorTop - 1, M.WOOD);  // crate core
    row(grid, kx - 9, kx + 9, floorTop - 17, M.NAPALM);              // top skin
    col(grid, kx - 9, floorTop - 17, floorTop - 1, M.NAPALM);        // left skin
    col(grid, kx + 9, floorTop - 17, floorTop - 1, M.NAPALM);        // right skin

    // The igniter: a single spark cell resting ON the fuse tail.
    grid.set(fuseStartX, fuseY - 1, M.SPARK);
    if (rng.chance(0.5)) grid.set(fuseStartX + 1, fuseY - 1, M.SPARK);
  },

  // CHEM LAB -----------------------------------------------------------------
  // Three tiered concrete neutralization basins. The top basin holds acid that
  // overflows a notched weir and dissolves the concrete lip it runs across; the
  // drip lands in a middle water basin over a salt bed; the bottom basin holds a
  // heavy silver pool of MERCURY that everything stratifies above — acid and
  // water ride on top of the densest liquid in the sim instead of mixing down.
  // Density stratification + acid-corrodes-concrete on display.
  ChemLab(grid, rng, d) {
    const W = grid.w, H = grid.h;
    grid.clear();

    const floorTop = H - 12;
    fill(grid, 0, floorTop, W - 1, H - 1, M.CONCRETE);

    // A walled concrete basin (continuous walls) for the given inner box.
    const basin = (x0, y0, x1, y1) => {
      fill(grid, x0 - 3, y0 - 3, x1 + 3, y1, M.CONCRETE);
      fill(grid, x0, y0, x1, y1 - 1, M.EMPTY);
    };

    // Top basin (acid), highest = lowest y.
    const t0 = 40, tt = 34, t1 = 150, tb = 78;
    basin(t0, tt, t1, tb);
    fill(grid, t0, tb - 16, t1, tb - 1, M.ACID);                     // acid pool
    fill(grid, t1, tb - 2, t1 + 3, tb - 1, M.EMPTY);                 // notch the right lip -> weir
    fill(grid, t1 + 3, tb - 1, 175, tb + 1, M.CONCRETE);            // apron the overflow etches

    // Middle basin (water + salt bed), catches the acid drip.
    const m0 = 150, mt = 92, m1 = 250, mb = 132;
    basin(m0, mt, m1, mb);
    fill(grid, m0, mb - 18, m1, mb - 1, M.WATER);
    for (let x = m0 + 2; x <= m1 - 2; x++) col(grid, x, mb - 2, mb - 1, M.SALT); // dissolving salt bed

    // Bottom basin (dense mercury pool) — everything stratifies above it.
    const b0 = 90, bt = 150, b1 = 250, bb = floorTop - 1;
    basin(b0, bt, b1, bb);
    fill(grid, b0, bb - 14, b1, bb - 1, M.MERCURY);                  // heaviest liquid
    fill(grid, b0, bb - 22, b1, bb - 15, M.WATER);                  // water pre-layered on top
    fill(grid, m1, mb - 2, m1 + 3, mb - 1, M.EMPTY);               // middle lip notch
    fill(grid, m1 + 3, mb - 1, b1, mb + 1, M.CONCRETE);            // apron down into mercury basin

    // Frame-one: a bead of mercury dropped from above to show it plummeting.
    disc(grid, (b0 + b1) >> 1, bt - 6, 2, M.MERCURY);
  },

  // THERMITE FOUNDRY ---------------------------------------------------------
  // A hopper of thermite sits over a thick STEEL plate that caps a sand-lined
  // concrete casting mold. A spark ignites the thermite, which flashes to
  // ~2500C molten iron — hotter than steel's 1400C melt point — and cuts DOWN
  // through the plate; the molten metal pours through the breach into the mold
  // cavity, where it loses heat to the concrete/sand and freezes into a solid
  // cast. A small water quench trough sits to the side for a steam puff.
  ThermiteFoundry(grid, rng, d) {
    const W = grid.w, H = grid.h;
    grid.clear();

    const floorTop = H - 12;
    fill(grid, 0, floorTop, W - 1, H - 1, M.CONCRETE);
    const cx = W >> 1;

    // Concrete casting mold cavity in the floor, sand-lined (parting sand).
    const mx0 = cx - 40, mx1 = cx + 40, mTop = floorTop - 40, mBot = floorTop - 1;
    fill(grid, mx0 - 6, mTop - 6, mx1 + 6, mBot, M.CONCRETE);        // solid mold block
    fill(grid, mx0, mTop, mx1, mBot - 1, M.EMPTY);                   // hollow cavity
    row(grid, mx0, mx1, mBot - 1, M.SAND);                          // sand floor liner
    col(grid, mx0, mTop, mBot - 1, M.SAND);                         // sand left liner
    col(grid, mx1, mTop, mBot - 1, M.SAND);                         // sand right liner

    // Steel plate CAPPING the mold — the barrier the thermite must cut through.
    const plateY = mTop - 2;
    fill(grid, mx0 - 6, plateY - 2, mx1 + 6, plateY, M.METAL);       // thick continuous steel lid

    // Thermite hopper directly above the plate: concrete funnel + thermite charge.
    const hx0 = cx - 14, hx1 = cx + 14, hTop = plateY - 40, hBot = plateY - 4;
    fill(grid, hx0 - 4, hTop - 4, hx1 + 4, hBot + 4, M.CONCRETE);   // hopper host
    fill(grid, hx0, hTop, hx1, hBot, M.EMPTY);                      // hollow
    fill(grid, hx0, hTop + 6, hx1, hBot, M.THERMITE);               // packed thermite
    // Bore a 3-cell nozzle through the concrete under the hopper down to the plate.
    for (let y = hBot; y <= plateY - 1; y++)
      for (let x = cx - 1; x <= cx + 1; x++) carveIf(grid, x, y, M.CONCRETE, M.EMPTY);

    // Igniter: a spark on top of the thermite pile.
    grid.set(cx, hTop + 5, M.SPARK);
    if (rng.chance(0.5)) grid.set(cx - 1, hTop + 5, M.SPARK);

    // Small water quench trough to the side (post-cast steam beauty puff).
    fill(grid, mx1 + 20, floorTop - 10, mx1 + 40, floorTop - 1, M.CONCRETE);
    fill(grid, mx1 + 23, floorTop - 8, mx1 + 37, floorTop - 1, M.WATER);
  },

  // RUBE GOLDBERG ------------------------------------------------------------
  // One spark starts a descending chain that tours five expansion materials in
  // sequence: a spark lights a gunpowder mortar whose fire jet reaches a thermite
  // cutting-charge on a steel shelf; the thermite melts the shelf so a held-back
  // LN2 reservoir dumps onto a warm water pool (flash-freeze + boil-off fog); the
  // cold shock frees a perched mercury bead that rolls down a concrete staircase
  // into a final catch basin. Each link is a different material's signature trick.
  RubeGoldberg(grid, rng, d) {
    const W = grid.w, H = grid.h;
    grid.clear();

    const floorTop = H - 12;
    fill(grid, 0, floorTop, W - 1, H - 1, M.CONCRETE);

    // Stage 1 (top-left): spark -> gunpowder mortar. Concrete tube open at top.
    const g0 = 24, g1 = 44, gTop = floorTop - 70, gBot = floorTop - 30;
    fill(grid, g0 - 4, gTop - 2, g1 + 4, gBot + 4, M.CONCRETE);      // mortar body
    fill(grid, g0, gTop, g1, gBot, M.EMPTY);                         // bore
    fill(grid, g0, gBot - 16, g1, gBot, M.GUNPOWDER);                // charge at the bore bottom
    grid.set((g0 + g1) >> 1, gBot - 1, M.SPARK);                    // igniter buried in the charge

    // Stage 2 (upper-mid): thermite cutting-charge on a steel shelf.
    const shelfY = gTop - 2, sx0 = 70, sx1 = 120;
    fill(grid, sx0, shelfY, sx1, shelfY + 2, M.METAL);              // continuous steel shelf
    fill(grid, sx0 + 6, shelfY - 10, sx1 - 6, shelfY - 1, M.THERMITE); // thermite on the shelf

    // Stage 3 (mid-right): the shelf is the FLOOR of an LN2 reservoir.
    const r0 = sx0 + 4, r1 = sx1 - 4, rTop = shelfY - 42, rBot = shelfY - 11;
    fill(grid, r0 - 3, rTop - 3, r1 + 3, rBot, M.CONCRETE);         // reservoir walls
    fill(grid, r0, rTop, r1, rBot - 1, M.EMPTY);                    // hollow
    fill(grid, r0, rTop + 8, r1, rBot - 1, M.LIQUID_NITROGEN);      // held-back cryo charge

    // Stage 4 (below shelf): warm water catch pool that flash-freezes.
    const w0 = 64, w1 = 126, wTop = floorTop - 24, wBot = floorTop - 1;
    fill(grid, w0 - 4, wTop - 2, w1 + 4, wBot, M.CONCRETE);
    fill(grid, w0, wTop, w1, wBot - 1, M.EMPTY);
    fill(grid, w0, wTop + 6, w1, wBot - 1, M.WATER);                // 22C water -> ice + cold fog

    // Stage 5 (far right): a mercury bead perched above a descending concrete ramp.
    const px = 150;
    disc(grid, px, floorTop - 40, 2, M.MERCURY);                    // perched bead
    grid.set(px + 1, floorTop - 38, M.CONCRETE);                    // tiny detent
    for (let k = 0; k < 8; k++) {                                    // descending staircase
      const rx = px + 6 + k * 18, ry = floorTop - 36 + k * 3;
      fill(grid, rx, ry, rx + 16, ry + 2, M.CONCRETE);
    }
    // Final catch basin bottom-right.
    const c0 = W - 40, c1 = W - 8, cTop = floorTop - 14;
    fill(grid, c0 - 3, cTop - 2, c1 + 3, floorTop - 1, M.CONCRETE);
    fill(grid, c0, cTop, c1, floorTop - 2, M.EMPTY);
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
