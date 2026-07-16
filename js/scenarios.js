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

  // CRYO POUR ----------------------------------------------------------------
  // A liquid-nitrogen tank pours straight down into a wide warm-water pool. The
  // whole scene is stacked on the vertical centerline: a CONTINUOUS-walled metal
  // tank up top, a short air gap, and a broad shallow concrete basin below. The
  // tank floor has one wide drain slot so LN2 falls as a centered curtain into
  // the pool — where it flash-freezes the water to ice and boils off to cold
  // nitrogen fog (a cryo liquid boiling *because the room is warm*). Two dry-ice
  // bricks on the tub rim sublime into a low CO2 haze for garnish.
  CryoLab(grid, rng, d) {
    const W = grid.w, H = grid.h;
    grid.clear();

    const floorTop = H - 14;
    fill(grid, 0, floorTop, W - 1, H - 1, M.CONCRETE);        // lab floor
    const cx = W >> 1;

    // Warm-water basin: centered, wide, and shallow, sitting below the tank.
    const bx0 = cx - 70, bx1 = cx + 70, bTop = 120, bBot = floorTop - 1;
    fill(grid, bx0 - 4, bTop - 2, bx1 + 4, bBot + 2, M.CONCRETE);     // solid tub host
    fill(grid, bx0, bTop, bx1, bBot, M.EMPTY);                        // hollow it
    fill(grid, bx0, bTop + 10, bx1, bBot, M.WATER);                   // ambient water (freeze target)

    // LN2 tank centered directly ABOVE, with a short ~12-cell air gap to the pool.
    const tx0 = cx - 40, tx1 = cx + 40, tTop = 20, tBot = 108, wall = 3;
    fill(grid, tx0 - wall, tTop, tx1 + wall, tBot + wall, M.METAL);   // continuous metal shell
    fill(grid, tx0, tTop + wall, tx1, tBot - 1, M.EMPTY);             // hollow interior
    fill(grid, tx0, tTop + wall + 4, tx1, tBot - 2, M.LIQUID_NITROGEN); // -205C fill, headspace above

    // Wide drain slot bored through the tank floor -> a centered LN2 curtain.
    fill(grid, cx - 3, tBot - 1, cx + 3, tBot + wall, M.EMPTY);

    // Two dry-ice bricks on the tub rim: sublime into a low CO2 fog.
    fill(grid, bx0 - 2, bTop - 6, bx0 + 6, bTop - 1, M.DRY_ICE);
    fill(grid, bx1 - 6, bTop - 6, bx1 + 2, bTop - 1, M.DRY_ICE);

    // Frame-one: LN2 already spilling into the gap so it reads live.
    for (let n = 0; n < 6; n++)
      grid.set(cx - 3 + rng.int(7), tBot + wall + 1 + rng.int(4), M.LIQUID_NITROGEN);
  },

  // SPARKWIRE DETONATION -----------------------------------------------------
  // A spark on a left-edge pad runs down a METAL wire (conduct 0.92 — heat races
  // along it) straight through the wall of a centered stone vault and into a deep
  // packed gunpowder charge. The buried wire tip heats the powder past its ~200C
  // ignite point; the charge deflagrates cell-to-cell in a fast chain and blows
  // out through a deliberately thin stone lid. A gasoline puddle to the right sits
  // in reach of the blast for a volatile secondary flash.
  PowderKeg(grid, rng, d) {
    const W = grid.w, H = grid.h;
    grid.clear();

    const floorTop = H - 12;
    fill(grid, 0, floorTop, W - 1, H - 1, M.STONE);
    const cx = W >> 1;

    // Sealed powder vault: CONTINUOUS stone walls, one thin (weak) roof panel.
    const vx0 = cx - 45, vx1 = cx + 45, vTop = floorTop - 70, vBot = floorTop - 1, wall = 4;
    fill(grid, vx0 - wall, vTop - wall, vx1 + wall, vBot, M.STONE);    // solid host block
    fill(grid, vx0, vTop, vx1, vBot - 1, M.EMPTY);                     // hollow chamber
    fill(grid, vx0, vBot - 40, vx1, vBot - 1, M.GUNPOWDER);            // deep packed charge
    row(grid, vx0, vx1, vTop - 1, M.STONE);                           // deliberately thin blow-out lid

    // Metal wire from a left-edge spark pad, THROUGH the wall, into the powder.
    const wireY = vBot - 20;
    for (let x = 12; x <= vx0; x++) grid.set(x, wireY, M.METAL);       // open-air run to the wall
    for (let x = vx0 - wall - 1; x <= vx0; x++) carveIf(grid, x, wireY, M.STONE, M.METAL); // bore through wall
    col(grid, vx0 + 1, wireY - 6, wireY + 6, M.GUNPOWDER);            // wire tip buried in charge

    // The igniter: spark on the wire's left-edge pad.
    grid.set(12, wireY, M.SPARK);
    if (rng.chance(0.5)) grid.set(13, wireY, M.SPARK);

    // Gasoline puddle to the right the blast can reach and ignite.
    fill(grid, vx1 + wall + 10, floorTop - 3, vx1 + wall + 40, floorTop - 1, M.GASOLINE);
  },

  // NEUTRALIZATION COLUMN ----------------------------------------------------
  // One tall centered glass column, sealed floor to lid, stacked as a chemistry
  // set: green ACID in the upper half rests on purple LYE in the lower half. Where
  // the two meet they neutralize to salt + water (exothermic) — a churning band
  // develops mid-column. A dense MERCURY puddle floors the column so the lighter
  // liquids stratify above it, and a small stone shelf near the acid slowly
  // dissolves. Acid/base neutralization + density stratification, all in-frame.
  ChemLab(grid, rng, d) {
    const W = grid.w, H = grid.h;
    grid.clear();

    const floorTop = H - 12;
    fill(grid, 0, floorTop, W - 1, H - 1, M.CONCRETE);
    const cx = W >> 1;

    // Tall glass column, centered, with continuous walls and a sealed floor.
    const gx0 = cx - 24, gx1 = cx + 24, gTop = 24, gBot = floorTop - 1, wt = 3;
    fill(grid, gx0 - wt, gTop, gx1 + wt, gBot + wt, M.GLASS);          // solid glass host
    fill(grid, gx0, gTop + wt, gx1, gBot, M.EMPTY);                    // hollow interior
    fill(grid, gx0, gBot, gx1, gBot, M.GLASS);                         // seal the floor

    // Fill: green acid over purple lye, meeting at mid-column to neutralize.
    const mid = (gTop + gBot) >> 1;
    fill(grid, gx0, gTop + wt + 6, gx1, mid - 1, M.ACID);             // green acid, upper
    fill(grid, gx0, mid + 1, gx1, gBot - 2, M.LYE);                   // purple lye, lower

    // Dense mercury puddle on the column floor — everything stratifies above it.
    fill(grid, gx0 + 2, gBot - 6, gx1 - 2, gBot - 2, M.MERCURY);

    // A sprinkle of salt across the neutralization boundary (the reaction product).
    for (let x = gx0 + 2; x <= gx1 - 2; x++)
      if (rng.chance(0.25)) grid.set(x, mid, M.SALT);

    // A small stone shelf at the top-left the acid runs across and slowly eats.
    row(grid, gx0, gx0 + 8, gTop + wt + 10, M.STONE);
  },

  // THERMITE CUT -------------------------------------------------------------
  // A steel beam spans two stone pillars in full view, with a pile of THERMITE
  // heaped on top of it and a spark on the pile. Thermite ignites at 900C and
  // flashes to ~2500C molten iron — well past steel's 1400C melt point — so the
  // beam melts and slumps right where the pile sits, cut in the middle of the
  // frame. The severed steel drips into a catch pit below with a shallow water
  // quench for a steam puff. Open geometry: nothing hidden, the cut is the show.
  ThermiteFoundry(grid, rng, d) {
    const W = grid.w, H = grid.h;
    grid.clear();

    const floorTop = H - 12;
    fill(grid, 0, floorTop, W - 1, H - 1, M.STONE);
    const cx = W >> 1;

    // A steel beam spanning two 3-wide stone pillars, centered.
    const beamY = 70, beamX0 = cx - 60, beamX1 = cx + 60;
    for (let d2 = 1; d2 <= 3; d2++) {
      col(grid, beamX0 - d2, beamY, floorTop - 1, M.STONE);          // left pillar
      col(grid, beamX1 + d2, beamY, floorTop - 1, M.STONE);          // right pillar
    }
    fill(grid, beamX0, beamY, beamX1, beamY + 3, M.METAL);           // 4-thick steel beam

    // Thermite pile heaped ON the beam, with a spark to set it off.
    fill(grid, cx - 16, beamY - 12, cx + 16, beamY - 1, M.THERMITE);
    grid.set(cx, beamY - 13, M.SPARK);
    if (rng.chance(0.5)) grid.set(cx - 1, beamY - 13, M.SPARK);

    // Catch pit below the cut, with a shallow water quench for a steam puff.
    const px0 = cx - 30, px1 = cx + 30, pTop = floorTop - 22;
    fill(grid, px0 - 3, pTop - 2, px1 + 3, floorTop - 1, M.STONE);    // solid pit host
    fill(grid, px0, pTop, px1, floorTop - 2, M.EMPTY);               // hollow it
    fill(grid, px0, floorTop - 8, px1, floorTop - 2, M.WATER);       // quench water
  },

  // FOUR CORNERS -------------------------------------------------------------
  // No fragile chain — a self-heating LAVA spire stands dead center in a stone
  // chimney and radiates heat, while four independent reactions run in the four
  // corners, each a different material's signature trick: NW a gunpowder shelf
  // the spire's heat can reach; NE an LN2 reservoir whose floor touches the hot
  // chimney and boils to fog; SW a tar pit that slowly catches; SE a mercury pool
  // with a metal block half-sunk that amalgamates. One legible source, four
  // parallel payoffs, all visible at once.
  RubeGoldberg(grid, rng, d) {
    const W = grid.w, H = grid.h;
    grid.clear();

    const floorTop = H - 12;
    fill(grid, 0, floorTop, W - 1, H - 1, M.STONE);
    const cx = W >> 1;

    // Central lava spire in a stone chimney — the self-heating source.
    const chx0 = cx - 8, chx1 = cx + 8, chTop = 40, chBot = floorTop - 1;
    fill(grid, chx0 - 4, chTop - 2, chx1 + 4, chBot, M.STONE);        // chimney host
    fill(grid, chx0, chTop, chx1, chBot - 1, M.LAVA);                // molten core

    // NW: a gunpowder shelf the radiating heat can reach.
    fill(grid, 40, 60, 88, 64, M.STONE);                             // shelf
    fill(grid, 46, 52, 82, 59, M.GUNPOWDER);                         // charge

    // NE: an LN2 reservoir whose floor touches the hot chimney -> boils to fog.
    const r0 = 232, r1 = 280, rTop = 48, rBot = 78;
    fill(grid, r0 - 3, rTop - 3, r1 + 3, rBot, M.STONE);             // reservoir walls
    fill(grid, r0, rTop, r1, rBot - 1, M.EMPTY);                     // hollow
    fill(grid, r0, rTop + 6, r1, rBot - 1, M.LIQUID_NITROGEN);       // cryo charge

    // SW: a tar pit that slowly catches from the ambient heat.
    fill(grid, 36, floorTop - 8, 96, floorTop - 1, M.TAR);

    // SE: a mercury pool with a metal block half-sunk that amalgamates.
    fill(grid, 224, floorTop - 8, 288, floorTop - 1, M.MERCURY);
    fill(grid, 248, floorTop - 14, 264, floorTop - 9, M.METAL);

    // Frame-one heat wisps rising off the spire so it reads live.
    for (let n = 0; n < 5; n++)
      grid.set(cx - 4 + rng.int(9), chTop - 2 - rng.int(5), M.FIRE);
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
