"""Diagnostic: capture several frames + thermal overlay + a water-on-lava test."""
import sys, os, json
sys.path.insert(0, r"C:\Users\nmurcin\Lumen\local\tmp\swarm\harness")
import cdp

APP = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SHOTS = os.path.join(APP, "testing", "shots")
os.makedirs(SHOTS, exist_ok=True)


def main():
    srv = cdp.StaticServer(APP).__enter__()
    c = cdp.Chrome(width=1280, height=800); c.launch()
    try:
        c.load(srv.url("/index.html"))
        c.eval("return window.__FLUX.reseed(7)")
        # thermal overlay of the volcano
        c.eval("return window.__FLUX.loadScenario('Volcano')")
        c.eval("return window.__FLUX.setOverlay('thermal')")
        c.eval("return window.__FLUX.step(2)")
        c.screenshot(os.path.join(SHOTS, "volcano_thermal.png"))
        # normal, freshly loaded (tick ~0) to see the drawn scene before it moves
        c.eval("return window.__FLUX.loadScenario('Volcano')")
        c.eval("return window.__FLUX.setOverlay('normal')")
        c.eval("return window.__FLUX.step(1)")
        c.screenshot(os.path.join(SHOTS, "volcano_t1.png"))
        # water-on-lava reaction test: clear, lava puddle, water above
        c.eval("return window.__FLUX.reset()")
        c.eval("return window.__FLUX.paintRect(120, 170, 200, 190, 'lava')")
        c.eval("return window.__FLUX.paintRect(140, 120, 180, 140, 'water')")
        before = c.eval("return window.__FLUX.sample()")
        c.eval("return window.__FLUX.step(80)")
        after = c.eval("return window.__FLUX.sample()")
        mass = c.eval("return JSON.parse(JSON.stringify(window.__STATE__.totals.massByMaterial))")
        print("water+lava before:", json.dumps(before))
        print("water+lava after :", json.dumps(after))
        print("masses after     :", json.dumps(mass))
        c.screenshot(os.path.join(SHOTS, "waterlava.png"))
    finally:
        c.close(); srv.__exit__()


if __name__ == "__main__":
    main()
