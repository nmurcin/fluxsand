# Fluxsand

**A thermodynamic powder toy  -  every grain carries a real temperature, and the heat is the physics.**

Fluxsand is a falling-sand sandbox that runs a genuine heat-diffusion and phase-change solver underneath the pixels. Paint sand, water, lava, oil, ice, and steel, then watch fire spread, water boil into steam, lava freeze into obsidian, and metal glow cherry-red before it melts. No build step, no dependencies, no server  -  just open the page. And because the only source of randomness is a seeded PRNG, the same seed and the same inputs always produce the exact same world, down to the last cell.

** Live demo: https://nmurcin.github.io/fluxsand/**

---

## What makes it different

Most falling-sand toys fake heat with a color swap or a timer. Fluxsand actually solves for it.

- **A real heat solver.** Every cell holds a temperature in  degC. Heat moves between neighbors by explicit finite-difference diffusion (Jacobi double-buffer, stability-clamped), weighted by each material's conductivity and specific heat. Hot cells radiate toward ambient; lava, fire, and molten metal hold their heat like real sources. Turn on the thermal camera and you're looking at the actual field, not a decoration.

- **Latent heat, calibrated to reality.** Phase changes are *energy-gated*. A cell that hits its boiling point doesn't flip to gas  -  it must first bank the material's latent-heat budget. Water's is deliberately enormous, scaled to real water's ~2.256 MJ/kg latent heat of vaporization (and ~4181 J/kgK specific heat), both from **CoolProp** at 1 atm. The visible payoff: **a wall of fire stalls dead when it hits water.** The water pins itself at 100  degC, soaks up energy as a heat sink, and only *then* starts turning to steam  -  exactly the behavior that makes water a fire suppressant in the real world.

- **Incandescent color from temperature.** Glowing materials don't have a "hot texture." Their color is computed from their temperature along a blackbody-ish ramp  -  first dull red near 500  degC, cherry red by 700  degC, orange at 900  degC, amber at 1100  degC (so lava reads amber, *not* banana yellow), and yellow-white past 1400  degC. A surface-only bloom pass gives glowing masses a rim halo instead of blowing out to a floodlight.

- **Total determinism.** The only randomness anywhere is a seeded **mulberry32** generator, threaded through the sim as an explicit `rng` object. No wall clock, no `Math.random`. Same seed + same input log  byte-identical simulation, verifiable via a 32-bit FNV state hash. Record inputs, replay them, get the same universe every time.

---

## Controls

| Input | Action |
|-------|--------|
| **click / drag** | paint the selected material |
| **1-9** | select material (sand, water, oil, lava, ice, wood, metal, stone, salt) |
| **0** | select plant |
| **F** | toggle thermal camera (inferno false-color by temperature) |
| **G** | toggle ASCII mode (glowing monospace glyphs) |
| **Space** | pause / resume |
| **.** | single-step one tick (works while paused) |
| **C** | clear the world |
| **[** / **]** | shrink / grow the brush |

The dock also exposes the full palette (including fire), the three view modes, and the scenario gallery.

---

## Gallery

Six deterministic starting scenes, each a pure function of the grid + seed, so they double as test fixtures:

- **Volcano** - a filled stone cone over a lava chamber, a snow cap to melt, and water pools cradled in stone basins on the flanks. The default frame-one scene.
- **Ice Age** - a frozen world with a buried geothermal vent and a lone ember to thaw it from within.
- **Thermite** - steel rods dipped in a molten-metal bath with oil-soaked wicks and fire on top; watch the metal glow white-hot and melt.
- **Steam** - a sealed metal boiler, water inside, a lava firebox below. A little steam engine in a box.
- **Hourglass** - two chambers of sand draining through a neck; powder repose and flow made visible.
- **Empty** - a clean sandbox with a stone floor.

---

## Try this

- **Ignite oil right next to ice** and watch the fire front *stall* the instant it reaches the meltwater  -  the latent-heat sink in action.
- **Drop water onto lava** -> it flashes to steam and the lava quenches into black **obsidian**.
- **Heat a bar of metal** until it glows cherry-red, then amber, then slumps into glowing molten metal, then freezes back to steel as it cools.
- **Bury lava under sand**  -  the sand hits its melt point and turns to molten glass, then cools into translucent glass.
- **Hit F** mid-eruption to watch the heat field bloom outward from the lava throat.
- **Grow plant into a pond**  -  it creeps into adjacent water  -  then set the whole thing on fire.
- **Pour acid on a steel wall** and watch it eat through.
- **Hit G** and enjoy the entire sim rendered as living ASCII.

---

## Architecture

Deliberately small and boring in all the right ways:

- **Pure ES modules**  -  `rng`, `grid`, `materials`, `thermal`, `sim`, `render`, `tools`, `main`. Load directly with `<script type="module">`.
- **Flat typed-array grid**  -  a 320 x 200 world stored as parallel `Uint16` (material id), `Float32` (temperature), `Float32` (latent-energy accumulator), and lifetime buffers. One cell, several arrays, tight loops.
- **Canvas `ImageData` renderer**  -  the sim paints into an offscreen buffer at grid resolution, then scales it up with smoothing off for crisp pixels: one `putImageData` + one `drawImage` per frame, plus an optional additive bloom pass.
- **No build step. No dependencies. No framework.** Clone it, open `index.html`, done. (Or serve the folder over any static server for ES-module CORS.)

A tick is: movement pass -> thermal sub-steps -> energy-gated phase changes -> reactions -> lifetime decay. Powders pile at their angle of repose, liquids find their level, gases rise and bubble up through liquids, and denser fluids sink through lighter ones.

---

## Testing

Fluxsand is driven by an automated harness that runs the real app in **headless Chrome over the Chrome DevTools Protocol (CDP)**. The app exposes a frozen contract on `window.__FLUX` (deterministic control: `reseed`, `reset`, `paint`, `step(n)`, `loadScenario`, `stateHash`, `replay`, ...) and mirrors per-tick totals on `window.__STATE__`, with `window.__READY__` flipping true once booted.

Because stepping is fully deterministic  -  `step(n)` freezes the animation loop, advances exactly `n` ticks, and redraws once  -  tests can assert on state hashes, energy totals, phase counts, and the hottest cell without a single wall-clock call. The harness loads the page, drives it exactly as a human would (all input routes through `__FLUX`), captures screenshots, and diffs the results. Same contract for humans and bots.

---

## License

MIT.
