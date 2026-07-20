"""
profile.py — measure sim ms/step across scene loads, and a full-grid stress case.

This is the before/after ruler for the performance refactor. It times step() only
(the deterministic sim + the frozen render path), so numbers are comparable across
machines. Also reports a "fill" stress case (paint most of the grid with a busy mix)
which is the "easy to strain it" scenario the user hit.

    py testing/profile.py                # print timings
    py testing/profile.py --json out.json  # also dump machine-readable

Timing note: headless SwiftShader is ~1.4x slower than a real GPU canvas, so the
real-browser numbers are better than these; we care about the RATIO before/after.
"""
from __future__ import annotations
import os, sys, json, time

HARNESS = r"C:\Users\nmurcin\Lumen\local\tmp\swarm\harness"
sys.path.insert(0, HARNESS)
import cdp  # noqa: E402
APP = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

# (label, setup-js, warmup steps, timed steps)
def cases():
    return [
        ("empty (idle)",        "window.__FLUX.reset();window.__FLUX.reseed(1);", 5, 300),
        ("volcano (sparse hot)", "window.__FLUX.reset();window.__FLUX.reseed(7);window.__FLUX.loadScenario('Volcano');", 50, 200),
        ("steam (boiler)",       "window.__FLUX.reset();window.__FLUX.reseed(3);window.__FLUX.loadScenario('Steam');", 50, 200),
        ("thermite (busy)",      "window.__FLUX.reset();window.__FLUX.reseed(9);window.__FLUX.loadScenario('Thermite');", 50, 200),
        ("rubegoldberg (chain)", "window.__FLUX.reset();window.__FLUX.reseed(1);window.__FLUX.loadScenario('RubeGoldberg');", 50, 200),
        # STRESS: fill ~80% of the grid with alternating sand/water/oil bands +
        # a lava floor + fire top -> lots of movement, reactions, diffusion at once.
        ("STRESS fill (80% grid)",
         ("window.__FLUX.reset();window.__FLUX.reseed(2);"
          "var W=window.__STATE__.grid.w,H=window.__STATE__.grid.h;"
          "window.__FLUX.paintRect(0,H-8,W-1,H-1,'lava');"
          "for(var b=0;b<H-10;b+=6){var m=(b/6)%3===0?'sand':((b/6)%3===1?'water':'oil');"
          "window.__FLUX.paintRect(0,b,W-1,b+4,m);}"
          "window.__FLUX.paintRect(0,0,W-1,3,'fire');"),
         5, 120),
    ]


def time_case(c, setup, warm, timed):
    c.eval(setup + " return null")
    c.eval(f"return window.__FLUX.step({warm})")  # warmup (reach steady busy state)
    # time in-page so we measure pure step() cost, not CDP round-trips
    ms = c.eval(
        f"var t=performance.now();window.__FLUX.step({timed});return performance.now()-t;")
    return ms / timed


def main():
    srv = cdp.StaticServer(APP).__enter__()
    c = cdp.Chrome(width=1280, height=800); c.launch()
    out = {}
    try:
        c.load(srv.url("/index.html"), ready_expr="return window.__READY__===true")
        c.eval("return window.__FLUX.step(0)")  # freeze rAF
        print("=" * 64)
        print("FLUXSAND SIM PROFILE  (ms/step, lower is better)")
        print("=" * 64)
        for label, setup, warm, timed in cases():
            best = min(time_case(c, setup, warm, timed) for _ in range(3))  # best of 3
            out[label] = round(best, 3)
            print(f"  {label:26s} {best:7.3f} ms/step")
        print("=" * 64)
    finally:
        c.close(); srv.__exit__()
    for a in sys.argv:
        if a.endswith(".json"):
            json.dump(out, open(a, "w"), indent=1); print("wrote", a)


if __name__ == "__main__":
    main()
