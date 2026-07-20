# Fluxsand

**A thermodynamic powder toy - every grain carries a real temperature, and the heat is the physics.**

Fluxsand is a falling-sand sandbox that runs a genuine heat-diffusion and phase-change solver underneath the pixels. Paint from a palette of 28 placeable materials - sand, water, lava, oil, ice, metal, liquid nitrogen, thermite, gunpowder, mercury, and more - then watch fire spread, water boil into steam, lava freeze into obsidian, cryogens flash-freeze a pool, and metal glow cherry-red before it melts. Over 50 interactions between those materials are declared as data, not code, and applied every tick across the full 8-cell neighborhood. No build step, no dependencies, no server - just open the page. And because the only source of randomness is a seeded PRNG, the same seed and the same inputs always produce the exact same world, down to the last cell.

** Live demo: https://nmurcin.github.io/fluxsand/**

---

## What makes it different

Most falling-sand toys fake heat with a color swap or a timer, and hardcode a handful of special-case reactions. Fluxsand actually solves for the heat, and expresses its chemistry as data.

- **A real heat solver.** Every cell holds a temperature in degC. Heat moves between neighbors by explicit finite-difference diffusion (Jacobi double-buffer, stability-clamped), weighted by each material's conductivity and specific heat. Hot cells radiate toward ambient; lava, fire, and molten metal hold their heat like real sources. There is an absolute-zero floor: no code path - not a cryo source, not an endothermic reaction bump - can drive a cell below -273.15 degC. Turn on the thermal camera and you're looking at the actual field, not a decoration.

- **Latent heat, calibrated to reality.** Phase changes are *energy-gated*. A cell that hits its boiling point doesn't flip to gas - it must first bank the material's latent-heat budget. Water's is deliberately enormous, scaled to real water's ~2.256 MJ/kg latent heat of vaporization (and ~4181 J/kgK specific heat), both from **CoolProp** at 1 atm. The visible payoff: **a wall of fire stalls dead when it hits water.** The water pins itself at 100 degC, soaks up energy as a heat sink, and only *then* starts turning to steam - exactly the behavior that makes water a fire suppressant in the real world. Liquid nitrogen sits at the other extreme: its tiny latent heat (~199 kJ/kg, an order of magnitude below water) means it flashes off fast the moment the warm room touches it.

- **Viscosity-based fluid mechanics.** Every liquid carries a viscosity from 0 to 1 that governs how fast it spreads sideways and how far it may travel in a single tick. Water (0.02) sheets out across many cells every tick; oil (0.30) flows at a medium pace; molten metal (0.45) is runny but thick; lava (0.92) barely creeps; molten glass (0.97) almost holds its shape. The ratios are grounded in reality - basaltic lava is roughly 10^4 to 10^5 times water's viscosity - compressed into a playable spread.

- **Density-ordered fluids and buoyant gases.** Liquids stack by density: a denser liquid sinks below a lighter one, so mercury (density 136) drops straight to the bottom and everything floats on it, while gasoline (density 7) rides on top of water (density 10) and oil floats too. Gas buoyancy scales with temperature: hot gas rises eagerly, while heavy or cold gas sinks and pools. CO2 is the heaviest gas in the box, so it flows downhill and smothers a fire from below.

- **A data-driven reaction engine.** More than 50 pairwise interactions live as plain data in `reaction_rules.js` - each a small record saying "when material A touches material B, with some probability and optional temperature gate, A becomes X and B becomes Y, with this heat bump." The engine applies them over the full 8-cell Moore neighborhood, first match wins, in registration order. Adding a new interaction is adding a line of data, not writing code. This is what turns 43 materials into a living chemistry set: acid dissolution, deflagration, cryo-freezing, rusting, amalgamation, sublimation, and more, all declared rather than branched.

- **Incandescent color from temperature.** Glowing materials don't have a "hot texture." Their color is computed from their temperature along a blackbody-ish ramp - first dull red near 500 degC, cherry red by 700 degC, orange at 900 degC, amber at 1100 degC (so lava reads amber, *not* banana yellow), and yellow-white past 1400 degC. A surface-only bloom pass gives glowing masses a rim halo instead of blowing out to a floodlight.

- **Total determinism.** The only randomness anywhere is a seeded **mulberry32** generator, threaded through the sim as an explicit `rng` object. No wall clock, no `Math.random`. Same seed + same input log means a byte-identical simulation, verifiable via a 32-bit FNV state hash. Record inputs, replay them, get the same universe every time.

---

## Materials

Fluxsand ships 43 materials. The originals cover the classic powder-toy palette (sand, water, stone, lava, ice, steam, oil, fire, wood, metal, molten metal, smoke, obsidian, ember, ash, glass, molten glass, acid, plant). The expansion adds the rest, grouped by what they do:

- **Cryogenics.** *Liquid nitrogen* (boils at -196 degC, flash-freezes warm liquids to ice), *nitrogen* gas (the cold vapor it boils off), *dry ice* (sublimates straight to CO2 at -78 degC), *CO2* (the heaviest gas - sinks, pools, and smothers fire), and *snow* (the lightest powder, heaps into steep drifts and melts easily).
- **Pyrotechnics.** *Gunpowder* (deflagrates cell-to-cell), *thermite* (ignites near 900 degC and burns to ~2500 degC molten metal, hot enough to cut through steel), *gasoline* (very runny, floats on water, and a whole slick lights at once), *napalm* (sticky, self-reigniting), *coal* (slow to catch, burns to a long-lived ember bed), *fuse* (a solid cord that burns slowly along its length), and *TNT* (a packed high explosive that detonates in one energy-scaled blast).
- **Chemistry and metals.** *Mercury* (the densest material - sinks under everything, with a near-zero heat capacity that snaps it to any temperature instantly), *rust* (forms slowly where metal meets water), and *concrete* (a cured, stone-like inert solid to build with).
- **Electric and living.** *Spark* (electricity - races along metal and mercury conductors, ignites fuels, and fizzles out in water), *wax* (melts at candle warmth into a runny, flammable liquid), and *plant* (green, flammable, grows into adjacent water).
- **Emitters.** *Water spout*, *lava spout*, and *sand source* - fixed faucets that emit their material into adjacent empty space every tick.

Behind the scenes the roster also includes the companion products those materials turn into - molten metal, molten glass, molten wax, smoke, ember, ash, obsidian, nitrogen, CO2, rust, dented metal, and a lit fuse node - which appear via reactions rather than being placed directly.

Every material's thermal numbers (conductivity, specific heat, melt and boil points, latent-heat budgets) are relative but grounded in CoolProp and textbook values, so the interactions between them behave the way the real substances would.

---

## Controls

| Input | Action |
|-------|--------|
| **click / drag** | paint the selected material |
| **1-9** | select material (sand, water, oil, lava, ice, wood, metal, stone, gasoline) |
| **0** | select fire |
| **F** | toggle thermal camera (inferno false-color by temperature) |
| **G** | toggle ASCII mode (glowing monospace glyphs) |
| **Space** | pause / resume |
| **.** | single-step one tick (works while paused) |
| **C** | clear the world |
| **[** / **]** | shrink / grow the brush |
| **B** | toggle brush shape (circle / square) |
| **M** | mute / unmute audio |

Beyond the keyboard, the toolbar adds a **heat / cool brush** (drag to pour energy in or out), a **variable sim speed** control (0.5x / 1x / 2x / 4x), **PNG export** of the current frame, and a **share button** that packs the current scene into a URL hash so a link reproduces it exactly. Procedural audio plays as the sim runs (mute with the button or **M**), and a first-run onboarding card teaches the core loop (re-openable via the "?" button).

The number keys map to the first ten palette entries. The dock exposes the full 28-material placeable palette - including the whole expansion roster (liquid nitrogen, gunpowder, thermite, spark, mercury, napalm, acid, dry ice, snow, coal, wax, concrete, plant, fuse, TNT, water spout, lava spout, sand source) - along with the three view modes and the scenario gallery.

---

## Gallery

Eleven deterministic starting scenes, each a pure function of the grid + seed, so they double as test fixtures:

- **Volcano** - a filled stone cone over a lava chamber, an ice cap on the summit to melt and drip, and water pools cradled in stone basins on the flanks. The default frame-one scene.
- **Ice Age** - a frozen world with a thick ice sheet over stone bedrock, a buried lava-filled geothermal vent, and a lone ember lodged under the ice to thaw it from within.
- **Thermite** - thin steel rods deeply dipped in a molten-metal bath with oil-soaked wicks and fire on top; watch the metal glow white-hot and slump into the bath.
- **Steam** - a sealed metal boiler, water inside, a lava firebox below. A little steam engine in a box.
- **Hourglass** - two glass chambers of sand draining through a narrow neck; powder repose and flow made visible.
- **Cryo Lab** - an overhead liquid-nitrogen tank pours through a drain slot as a centered curtain onto a warm water basin below, flash-freezing it to ice and boiling off into cold nitrogen fog, while two dry-ice bricks on the tub rim sublime into a low CO2 haze.
- **Powder Keg** - a spark on a left-edge pad races down a metal wire, through the wall of a sealed stone vault, into a deep packed gunpowder charge that deflagrates and blows out a thin stone lid; a gasoline puddle sits in reach of the blast for a volatile secondary flash.
- **Chem Lab** - one tall sealed glass column showing density stratification: a slick of light oil floats on green acid resting on a dense mercury floor, while stone shelves dissolve in the acid and a metal block amalgamates away in the mercury.
- **Thermite Foundry** - a steel beam spanning two stone pillars with a thermite pile heaped on top and a spark buried in it; the thermite flashes to ~2500 degC molten iron and cuts the beam, which drips into a catch pit with a shallow water quench for a steam puff.
- **Rube Goldberg** - a single spark starts a five-stage chain: it lights a gunpowder fuse, the flame races along the fuse and flashes a gasoline slick it runs through, the fuse hits a powder charge whose blast ignites a thermite pile into ~2500 degC molten iron, and the iron pours off the ledge, melts a metal gate, and drops the dammed water onto a lava pool for a steam finale.
- **Empty** - a clean sandbox with a stone floor.

---

## Try this

- **Ignite oil right next to ice** and watch the fire front *stall* the instant it reaches the meltwater - the latent-heat sink in action.
- **Drop water onto lava** -> it flashes to steam and the lava quenches into black **obsidian**.
- **Pour liquid nitrogen onto water** -> the water snap-freezes to ice and the nitrogen boils off into cold fog.
- **Ignite thermite with a spark** -> it flares to ~2500 degC and melts straight through a steel wall into a gush of molten metal.
- **Spread gasoline on a pond and touch it with a spark** -> the whole floating slick goes up at once.
- **Pour acid onto a slab of metal or stone** -> it eats through cell by cell, and drop a spark on a metal wire to watch the arc race along the conductor.
- **Drop dry ice or CO2 onto a fire** -> the heavy gas sinks and smothers it from below.
- **Drop mercury into any pool** -> it sinks straight to the bottom and everything else floats on top of it.
- **Lay a gunpowder trail from a spark** -> the flame races down it like a fuse.
- **Heat a bar of metal** until it glows cherry-red, then amber, then slumps into glowing molten metal, then freezes back to steel as it cools.
- **Bury lava under sand** - the sand hits its melt point and turns to molten glass, then cools into translucent glass.
- **Hit F** mid-eruption to watch the heat field bloom outward from the lava throat.
- **Hit G** and enjoy the entire sim rendered as living ASCII.

---

## Architecture

Deliberately small and boring in all the right ways:

- **Pure ES modules** - `rng`, `grid`, `materials`, `thermal`, `reactions`, `reaction_rules`, `sim`, `scenarios`, `render`, `tools`, `main`. Load directly with `<script type="module">`.
- **Declarative data tables** - materials live in `materials.js` and interactions in `reaction_rules.js` as plain records. The simulation reads them; it doesn't hardcode them. Add a material or a reaction by adding data.
- **Flat typed-array grid** - a 320 x 200 world stored as parallel `Uint16` (material id), `Float32` (temperature), `Float32` (latent-energy accumulator), and lifetime buffers. One cell, several arrays, tight loops.
- **Canvas `ImageData` renderer** - the sim paints into an offscreen buffer at grid resolution, then scales it up with smoothing off for crisp pixels: one `putImageData` + one `drawImage` per frame, plus an optional additive bloom pass.
- **No build step. No dependencies. No framework.** Clone it, open `index.html`, done. (Or serve the folder over any static server for ES-module CORS.)

A tick is: movement pass -> thermal sub-steps -> energy-gated phase changes -> data-driven reactions -> lifetime decay. Powders pile at their angle of repose, liquids find their level at a rate set by their viscosity, gases rise or sink by temperature and density, and denser fluids sink through lighter ones.

---

## Testing

Fluxsand is driven by an automated harness that runs the real app in **headless Chrome over the Chrome DevTools Protocol (CDP)**. The app exposes a frozen contract on `window.__FLUX` (deterministic control: `reseed`, `reset`, `paint`, `step(n)`, `loadScenario`, `stateHash`, `replay`, ...) and mirrors per-tick totals on `window.__STATE__`, with `window.__READY__` flipping true once booted.

Because stepping is fully deterministic - `step(n)` freezes the animation loop, advances exactly `n` ticks, and redraws once - tests can assert on state hashes, energy totals, phase counts, and the hottest cell without a single wall-clock call. The harness loads the page, drives it exactly as a human would (all input routes through `__FLUX`), captures screenshots, and diffs the results. Same contract for humans and bots.

---

## License

MIT.
