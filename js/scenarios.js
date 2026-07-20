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

// ---- virtual coordinate system ----------------------------------------------
// Scenarios are authored in a fixed 320x200 VIRTUAL space (so the layouts read
// the same regardless of the real grid resolution). Each scenario sets up the
// scale via `dims` (see the W/H it destructures), and the drawing helpers below
// map virtual coords -> real grid cells. This lets us raise the sim resolution
// without rescaling every scenario by hand.
export const VW = 320, VH = 200;
let SX = 1, SY = 1;
function setScale(grid) { SX = grid.w / VW; SY = grid.h / VH; }
function rx(v) { return Math.round(v * SX); }
function ry(v) { return Math.round(v * SY); }
function rr(v) { return Math.max(1, Math.round(v * (SX + SY) * 0.5)); } // radius (avg scale)

// ---- drawing helpers (accept VIRTUAL coords, write REAL cells) --------------

// Filled axis-aligned rectangle (inclusive of both corners), order-agnostic.
function fill(grid, x0, y0, x1, y1, id) {
  const ax = Math.min(rx(x0), rx(x1)), bx = Math.max(rx(x0), rx(x1));
  const ay = Math.min(ry(y0), ry(y1)), by = Math.max(ry(y0), ry(y1));
  for (let y = ay; y <= by; y++)
    for (let x = ax; x <= bx; x++)
      if (grid.inBounds(x, y)) grid.set(x, y, id);
}

// A single horizontal span (one virtual row -> a real band tall enough to be continuous).
function row(grid, xa, xb, y, id) {
  const lo = Math.min(rx(xa), rx(xb)), hi = Math.max(rx(xa), rx(xb));
  const y0 = ry(y), y1 = Math.max(y0, ry(y + 1) - 1); // cover the full scaled row height
  for (let yy = y0; yy <= y1; yy++)
    for (let x = lo; x <= hi; x++) if (grid.inBounds(x, yy)) grid.set(x, yy, id);
}

// A single vertical span (one virtual column -> a real band wide enough to be continuous).
function col(grid, x, ya, yb, id) {
  const lo = Math.min(ry(ya), ry(yb)), hi = Math.max(ry(ya), ry(yb));
  const x0 = rx(x), x1 = Math.max(x0, rx(x + 1) - 1);
  for (let xx = x0; xx <= x1; xx++)
    for (let y = lo; y <= hi; y++) if (grid.inBounds(xx, y)) grid.set(xx, y, id);
}

// Filled disc of virtual radius r centered at (cx,cy).
function disc(grid, cx, cy, r, id) {
  const RX = rx(cx), RY = ry(cy), R = rr(r), r2 = R * R;
  for (let y = RY - R; y <= RY + R; y++)
    for (let x = RX - R; x <= RX + R; x++) {
      const dx = x - RX, dy = y - RY;
      if (dx * dx + dy * dy <= r2 && grid.inBounds(x, y)) grid.set(x, y, id);
    }
}

// Set a single VIRTUAL point -> a real scaled block (use instead of raw grid.set
// in scenario bodies, so hand-placed accents scale with resolution).
function put(grid, x, y, id) {
  const x0 = rx(x), x1 = Math.max(x0, rx(x + 1) - 1);
  const y0 = ry(y), y1 = Math.max(y0, ry(y + 1) - 1);
  for (let xx = x0; xx <= x1; xx++)
    for (let yy = y0; yy <= y1; yy++)
      if (grid.inBounds(xx, yy)) grid.set(xx, yy, id);
}

// Overwrite a cell only if it currently holds material `onlyIf` (bores a channel
// through solid rock). Scales the virtual cell to a real block so channels stay
// continuous at higher resolution.
function carveIf(grid, x, y, onlyIf, id) {
  const x0 = rx(x), x1 = Math.max(x0, rx(x + 1) - 1);
  const y0 = ry(y), y1 = Math.max(y0, ry(y + 1) - 1);
  for (let xx = x0; xx <= x1; xx++)
    for (let yy = y0; yy <= y1; yy++) {
      if (!grid.inBounds(xx, yy)) continue;
      const i = grid.idx(xx, yy);
      if (grid.mat[i] === onlyIf) grid.set(xx, yy, id);
    }
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
    const W = VW, H = VH;
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
    const W = VW, H = VH;
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
    const W = VW, H = VH;
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
      // rod x-position in VIRTUAL space. Named rodX (NOT rx) so it never
      // shadows the module-scope rx() scale function.
      const rodX = Math.round(cxL + stepX * (k + 0.5));
      fill(grid, rodX - 1, rodTopY, rodX, rodBotY, M.METAL);   // 2-wide rod

      // Oil bead + fire cap on the exposed tip for the ignition flash.
      fill(grid, rodX - 1, rodTopY - 3, rodX, rodTopY - 1, M.OIL);
      put(grid, rodX - 1, rodTopY - 5, M.FIRE);
      if (rng.chance(0.6)) put(grid, rodX, rodTopY - 6, M.FIRE);
    }

    // A ragged oil ribbon skimming the rod tips so the flame front travels
    // across the crucible instead of sitting in nine isolated dots.
    const ribbonY = rodTopY - 2;
    for (let x = cxL + 4; x <= cxR - 4; x++)
      if (rng.chance(0.5)) put(grid, x, ribbonY, M.OIL);
  },

  // STEAM --------------------------------------------------------------------
  // A sealed steel boiler over a lava firebox. The boiler has CONTINUOUS walls
  // on all four sides (left, right, lid, and a solid metal floor) so neither
  // water nor steam can leak. Beneath the metal floor sits a lava firebox in a
  // stone hearth; heat conducts up through the metal (conduct 0.92) into the
  // water, driving it to a rolling boil — steam collects under the lid.
  Steam(grid, rng, d) {
    const W = VW, H = VH;
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
      put(grid, sx, sy, M.STEAM);
    }
  },

  // HOURGLASS ----------------------------------------------------------------
  // Two glass chambers joined by a narrow neck, the upper chamber packed with
  // sand. The frame is solid glass (with a continuous outline), the neck is a
  // one-to-few-cell aperture. Sand drains through the pinch and piles at its
  // angle of repose in the lower bulb — powder-flow beauty.
  Hourglass(grid, rng, d) {
    const W = VW, H = VH;
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
        put(grid, x, y, M.SAND);
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
    const W = VW, H = VH;
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
      put(grid, cx - 3 + rng.int(7), tBot + wall + 1 + rng.int(4), M.LIQUID_NITROGEN);
  },

  // SPARKWIRE DETONATION -----------------------------------------------------
  // A spark on a left-edge pad runs down a METAL wire (conduct 0.92 — heat races
  // along it) straight through the wall of a centered stone vault and into a deep
  // packed gunpowder charge. The buried wire tip heats the powder past its ~200C
  // ignite point; the charge deflagrates cell-to-cell in a fast chain and blows
  // out through a deliberately thin stone lid. A gasoline puddle to the right sits
  // in reach of the blast for a volatile secondary flash.
  PowderKeg(grid, rng, d) {
    const W = VW, H = VH;
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
    row(grid, 12, vx0, wireY, M.METAL);                              // open-air run to the wall
    for (let x = vx0 - wall - 1; x <= vx0; x++) carveIf(grid, x, wireY, M.STONE, M.METAL); // bore through wall
    col(grid, vx0 + 1, wireY - 6, wireY + 6, M.GUNPOWDER);            // wire tip buried in charge

    // The igniter: spark on the wire's left-edge pad.
    put(grid, 12, wireY, M.SPARK);
    if (rng.chance(0.5)) put(grid, 13, wireY, M.SPARK);

    // Gasoline puddle to the right the blast can reach and ignite.
    fill(grid, vx1 + wall + 10, floorTop - 3, vx1 + wall + 40, floorTop - 1, M.GASOLINE);
  },

  // STRATIFICATION COLUMN ----------------------------------------------------
  // One tall centered glass column, sealed floor to lid, stacked as a density
  // set: a slick of light OIL floats on green ACID, which in turn rests on a
  // dense MERCURY floor — three immiscible liquids settle into clean bands by
  // density (oil 9 < acid 10 << mercury 136). A pair of stone shelves jut into
  // the acid layer and slowly dissolve, and a metal block half-sunk in the
  // mercury amalgamates away. Density stratification + corrosion, all in-frame.
  ChemLab(grid, rng, d) {
    const W = VW, H = VH;
    grid.clear();

    const floorTop = H - 12;
    fill(grid, 0, floorTop, W - 1, H - 1, M.CONCRETE);
    const cx = W >> 1;

    // Tall glass column, centered, with continuous walls and a sealed floor.
    const gx0 = cx - 24, gx1 = cx + 24, gTop = 24, gBot = floorTop - 1, wt = 3;
    fill(grid, gx0 - wt, gTop, gx1 + wt, gBot + wt, M.GLASS);          // solid glass host
    fill(grid, gx0, gTop + wt, gx1, gBot, M.EMPTY);                    // hollow interior
    fill(grid, gx0, gBot, gx1, gBot, M.GLASS);                         // seal the floor

    // Fill: light oil over green acid — they settle into two clean bands.
    const mid = (gTop + gBot) >> 1;
    fill(grid, gx0, gTop + wt + 6, gx1, mid - 1, M.OIL);             // light oil, upper
    fill(grid, gx0, mid + 1, gx1, gBot - 2, M.ACID);                // green acid, lower

    // Dense mercury puddle on the column floor — everything stratifies above it.
    fill(grid, gx0 + 2, gBot - 6, gx1 - 2, gBot - 2, M.MERCURY);

    // A metal block half-sunk in the mercury slowly amalgamates away.
    fill(grid, cx - 4, gBot - 8, cx + 4, gBot - 5, M.METAL);

    // A pair of small stone shelves the acid runs across and slowly eats.
    row(grid, gx0, gx0 + 8, mid + 4, M.STONE);
    row(grid, gx1 - 8, gx1, mid + 8, M.STONE);
  },

  // THERMITE CUT -------------------------------------------------------------
  // A steel beam spans two stone pillars in full view, with a pile of THERMITE
  // heaped on top of it and a spark on the pile. Thermite ignites at 900C and
  // flashes to ~2500C molten iron — well past steel's 1400C melt point — so the
  // beam melts and slumps right where the pile sits, cut in the middle of the
  // frame. The severed steel drips into a catch pit below with a shallow water
  // quench for a steam puff. Open geometry: nothing hidden, the cut is the show.
  ThermiteFoundry(grid, rng, d) {
    const W = VW, H = VH;
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

    // Thermite pile heaped ON the beam.
    const pileTop = beamY - 12, pileBot = beamY - 1;
    fill(grid, cx - 16, pileTop, cx + 16, pileBot, M.THERMITE);

    // Igniter: SPARK grains painted DIRECTLY INTO the pile's interior, AFTER the
    // thermite fill so they overwrite a few thermite cells. Embedding guarantees the
    // spark is fully surrounded by thermite at any resolution — and, crucially, that
    // contact survives the powder settling one row on tick 1 (the old bug: a spark
    // perched one row ABOVE the pile lost contact when the heap slumped down, opening
    // a 2-cell gap the Moore neighborhood can't bridge, so it decayed without lighting).
    // Buried in the pile, spark+thermite fires on tick 1 (chance 1) before the ~6-tick
    // spark lifetime elapses. A short vertical seam of spark lights a wide cut fast.
    const igY = Math.round((pileTop + pileBot) / 2);   // mid-height of the heap
    put(grid, cx, igY, M.SPARK);
    put(grid, cx, igY + 1, M.SPARK);
    if (rng.chance(0.5)) put(grid, cx - 1, igY, M.SPARK);

    // Catch pit below the cut, with a shallow water quench for a steam puff.
    const px0 = cx - 30, px1 = cx + 30, pTop = floorTop - 22;
    fill(grid, px0 - 3, pTop - 2, px1 + 3, floorTop - 1, M.STONE);    // solid pit host
    fill(grid, px0, pTop, px1, floorTop - 2, M.EMPTY);               // hollow it
    fill(grid, px0, floorTop - 8, px1, floorTop - 2, M.WATER);       // quench water
  },

  // RUBE GOLDBERG ------------------------------------------------------------
  // A REAL chain reaction: one spark cascades through five stages, each built on
  // a HIGH-PROBABILITY reaction (each link verified by probe) so it fires reliably
  // from a standing start and finishes within ~200 ticks:
  //
  //   1. SPARK on the fuse head lights a GUNPOWDER fuse (spark+gunpowder chance 1).
  //   2. the fuse DEFLAGRATES left-to-right along the top shelf (a running flame).
  //   3. the fuse runs THROUGH a GASOLINE slick -> the whole slick flashes
  //      (fuse-in-fuel is the reliable ignite, not a flame drifting onto a pool).
  //   4. the fuse ends in a GUNPOWDER charge packed against a THERMITE pile at the
  //      shelf's open right edge; the blast lights the thermite -> ~2500C MOLTEN
  //      IRON, which pours off the ledge.
  //   5. the falling iron lands on a METAL GATE damming a WATER reservoir over an
  //      air gap and a LAVA pool; the 2500C iron melts the gate, the water drops
  //      through onto the lava -> a big STEAM burst (lava+water chance 1). Water
  //      and lava never touch until the gate breaks, so the tank is dry until the
  //      chain reaches it — the steam is the finale, not a pre-existing leak.
  //
  // The chain reads left-to-right along the elevated shelf, then drops into the
  // tank on the right. Centered in the frame.
  RubeGoldberg(grid, rng, d) {
    const W = VW, H = VH;
    grid.clear();

    const floorTop = H - 10;
    fill(grid, 0, floorTop, W - 1, H - 1, M.STONE);

    // The chain rides ONE elevated shelf near the top of the frame. `fuseY` is the
    // fuse row; the shelf sits just below it. The fuse is drawn LAST as an unbroken
    // 2-row trail so the deflagration never hits a gap. The shelf's RIGHT end is
    // open (a ledge) over the tank so the molten iron can pour off it.
    // A small origin shift centers the whole machine horizontally in the frame
    // (content is ~224 wide in a 320 space, so nudge it right by ~half the slack).
    const ox = 32;
    const shelfX0 = 20 + ox;          // left end of the shelf
    const ledgeX = 176 + ox;          // shelf's open right edge (iron pours off here)
    const railY = 58;                 // shelf top
    const fuseY = railY - 3;          // fuse line (2 rows: fuseY, fuseY+1)

    // The elevated stone shelf (kept BELOW the fuse rows).
    fill(grid, shelfX0, railY, ledgeX, railY + 3, M.STONE);

    // Fuse extents (from the lead tip to the charge).
    const fuseStart = 44 + ox;
    const fuseEnd = 150 + ox;

    // ---- STAGE 1: the trigger — spark on the fuse head ----------------------
    // A short metal detonator lead runs into the fuse head for looks. The spark
    // grains themselves are placed at the very end of this function, directly on
    // the first powder cells, so the fuse lights on tick one (spark+gunpowder
    // chance 1) — no long, flaky arc-down-a-wire delay.
    fill(grid, shelfX0 + 2, fuseY, fuseStart, fuseY + 1, M.METAL); // detonator lead (cosmetic)

    // ---- STAGE 3 (structure first): the gasoline slick trough ---------------
    // A shallow gasoline slick in a stone trough DIRECTLY BELOW the fuse (the fuse
    // bottom row is adjacent to the slick top). The running flame flashes the
    // whole slick (verified far more reliable than a flame drifting onto a pool).
    const gx0 = 60 + ox, gx1 = 116 + ox;
    col(grid, gx0 - 1, railY - 2, railY, M.STONE);              // left trough wall
    col(grid, gx1 + 1, railY - 2, railY, M.STONE);              // right trough wall
    row(grid, gx0, gx1, railY - 1, M.GASOLINE);                 // slick, one row under the fuse

    // ---- STAGE 4 (structure first): powder charge + thermite pile -----------
    // The fuse ends in a packed gunpowder charge shoved against a thermite pile
    // that sits at the shelf's open right edge. The charge's blast lights the
    // thermite (verified) -> ~2500C molten iron. The pile is on the SHELF, high
    // above the lava, so nothing preheats it — only the fuse's charge lights it.
    const cx0 = 126 + ox, cx1 = 146 + ox;                       // charge x-span
    const tx0 = 148 + ox, tx1 = ledgeX;                         // thermite pile out to the ledge
    fill(grid, cx0, railY - 6, cx1, railY - 1, M.GUNPOWDER);    // packed charge
    fill(grid, tx0, railY - 8, tx1, railY - 1, M.THERMITE);     // thermite pile to the open edge

    // ---- STAGE 5: the tank — water reservoir / gate / air gap / lava --------
    // Below the ledge sits a sealed stone tank. A thin METAL GATE holds a WATER
    // reservoir up; below the gate is an AIR GAP, then a LAVA pool on the tank
    // floor. Water and lava are separated by the gate AND the gap, so the tank is
    // bone dry until the molten iron (pouring off the ledge) melts the gate — then
    // the water column drops through the gap onto the lava for the steam burst.
    const bx0 = ledgeX - 8, bx1 = ledgeX + 60;                  // tank spans under/right of the ledge
    const boxTop = railY + 6, boxBot = floorTop - 1;
    fill(grid, bx0 - 3, boxTop - 2, bx1 + 3, boxBot + 1, M.STONE); // solid tank host
    fill(grid, bx0, boxTop, bx1, boxBot, M.EMPTY);                 // hollow the tank
    const gateY = boxTop + 14;                                     // gate a bit below the rim
    fill(grid, bx0, gateY, bx1, gateY + 1, M.METAL);              // the meltable gate (2 rows)
    fill(grid, bx0, boxTop + 2, bx1, gateY - 1, M.WATER);        // water reservoir dammed on the gate
    const lavaTop = boxBot - 12;
    fill(grid, bx0, lavaTop, bx1, boxBot, M.LAVA);               // lava pool on the tank floor (air gap above)

    // ---- STAGE 2 (drawn LAST): the continuous gunpowder fuse ----------------
    // One unbroken 2-row powder trail from the lead tip into the charge. Drawn
    // after every structure so NOTHING overwrites it — the deflagration front has
    // a clean, gap-free path the whole way across.
    fill(grid, fuseStart, fuseY, fuseEnd, fuseY + 1, M.GUNPOWDER);

    // The igniter: spark grains placed LAST, directly on the fuse head, so the
    // fuse lights on tick one (spark+gunpowder chance 1).
    put(grid, fuseStart, fuseY, M.SPARK);
    put(grid, fuseStart, fuseY + 1, M.SPARK);
    put(grid, fuseStart + 1, fuseY, M.SPARK);
  },

  // CIRCUIT ------------------------------------------------------------------
  // A hand-built electrical circuit: a SPARK on a left-edge pad energizes a long
  // COPPER wire (spark+copper -> live_wire), the current races down the copper
  // (live_wire+copper propagation), and at the far right the wire runs straight
  // into a GASOLINE fuel pad sitting in a stone trough. When the live current
  // reaches the pad it arcs the gasoline alight (live_wire+gasoline -> fire).
  // Current flows ONLY through the copper, never through the air above it — the
  // showcase for the electricity feature. A water-dipped branch on the way could
  // short it (left as a build-your-own toy); the mainline reaches the fuel.
  Circuit(grid, rng, d) {
    const W = VW, H = VH;
    grid.clear();

    const floorTop = H - 12;
    fill(grid, 0, floorTop, W - 1, H - 1, M.STONE);

    // One long horizontal copper wire on an elevated stone shelf, left to right.
    const wireY = 90;
    const wireX0 = 24, wireX1 = 250;
    fill(grid, wireX0, wireY + 2, wireX1 + 6, wireY + 4, M.STONE); // shelf under the wire
    row(grid, wireX0, wireX1, wireY, M.COPPER);                    // the conductor

    // Fuel pad in a stone trough at the wire's right end (the load the current lights).
    const padX0 = wireX1 - 2, padX1 = wireX1 + 6;
    col(grid, padX0 - 1, wireY - 4, wireY + 1, M.STONE);          // trough left wall
    col(grid, padX1 + 1, wireY - 4, wireY + 1, M.STONE);          // trough right wall
    fill(grid, padX0, wireY - 3, padX1, wireY - 1, M.GASOLINE);   // gasoline pad on the wire end

    // The igniter: a spark on the wire's left-edge pad energizes the copper.
    put(grid, wireX0, wireY, M.SPARK);
    put(grid, wireX0 + 1, wireY, M.SPARK);
    if (rng.chance(0.5)) put(grid, wireX0, wireY - 1, M.SPARK);
  },

  // EMPTY --------------------------------------------------------------------
  // A clean sandbox: just a stone floor to build on.
  Empty(grid, rng, d) {
    const W = VW, H = VH;
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
  setScale(grid);   // map the virtual 320x200 authoring space onto the real grid
  SCENARIOS[key](grid, rng, dims);
  return true;
}
