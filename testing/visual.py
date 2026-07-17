"""
Visual regression check for Fluxsand.

State-contract tests verify the simulation numbers; this verifies the SCREEN.
For each deterministic fixture we render a fixed frame and compute a cheap,
robust perceptual signature (downsampled luminance grid + color histogram).
On first run it records baselines; on later runs it compares and flags drift
beyond a tolerance. Pure Pillow — no heavy deps.

Usage:
  py visual.py            # compare against baselines (record if missing)
  py visual.py --update   # force-record new baselines
"""
import sys, os, json, argparse
sys.path.insert(0, r"C:\Users\nmurcin\Lumen\local\tmp\swarm\harness")
import cdp
from PIL import Image

APP = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
BASE = os.path.join(os.path.dirname(__file__), "baselines")
SHOTS = os.path.join(os.path.dirname(__file__), "shots")
os.makedirs(BASE, exist_ok=True)
os.makedirs(SHOTS, exist_ok=True)

# fixture: (name, list of __FLUX js ops to run before capture)
FIXTURES = [
    ("volcano", ["reseed(42)", "loadScenario('Volcano')", "setOverlay('normal')", "step(40)"]),
    ("volcano_thermal", ["reseed(42)", "loadScenario('Volcano')", "setOverlay('thermal')", "step(40)"]),
    ("thermite", ["reseed(9)", "loadScenario('Thermite')", "setOverlay('normal')", "step(120)"]),
    ("steam", ["reseed(3)", "loadScenario('Steam')", "setOverlay('normal')", "step(150)"]),
    ("ascii", ["reseed(1)", "loadScenario('Volcano')", "setOverlay('ascii')", "step(30)"]),
]

GRID = 24  # downsample to 24x24 luminance cells

# JS run before capture to guarantee no DOM overlay occludes the canvas.
# The app auto-shows a first-run "Welcome to Fluxsand" onboarding card
# (id 'onboarding') when localStorage 'fluxsand_onboarded' is unset, and a
# per-scenario instruction card (id 'scenario-instructions') that loadScenario
# can re-surface. Both sit over the canvas. This sets the onboarded flag and
# hides both overlays so screenshots capture the scene, not the UI. It never
# touches simulation state — the sim (js/) is unchanged; this is test-only.
CLEAR_OVERLAYS = (
    "try{localStorage.setItem('fluxsand_onboarded','1');}catch(e){}"
    "var o=document.getElementById('onboarding'); if(o){o.hidden=true;o.style.display='none';}"
    "var s=document.getElementById('scenario-instructions'); if(s){s.hidden=true;s.style.display='none';}"
    "return true;"
)


def signature(path):
    im = Image.open(path).convert("RGB")
    # crop the canvas region (right of the 264px dock) so UI text doesn't dominate
    w, h = im.size
    im = im.crop((264, 0, w, h)).resize((GRID, GRID))
    px = list(im.getdata())
    lum = [round(0.299 * r + 0.587 * g + 0.114 * b, 1) for (r, g, b) in px]
    # coarse color histogram (8 bins per channel signature)
    hist = [0] * 24
    for (r, g, b) in px:
        hist[r >> 5] += 1
        hist[8 + (g >> 5)] += 1
        hist[16 + (b >> 5)] += 1
    return {"lum": lum, "hist": hist}


def dist(a, b):
    # normalized L1 over luminance + histogram
    ll = sum(abs(x - y) for x, y in zip(a["lum"], b["lum"])) / (len(a["lum"]) * 255.0)
    hh = sum(abs(x - y) for x, y in zip(a["hist"], b["hist"])) / (sum(a["hist"]) + 1)
    return ll + hh


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--update", action="store_true")
    ap.add_argument("--tol", type=float, default=0.18)
    args = ap.parse_args()

    srv = cdp.StaticServer(APP).__enter__()
    c = cdp.Chrome(width=1280, height=800); c.launch()
    results = []
    try:
        c.load(srv.url("/index.html"))
        c.eval(CLEAR_OVERLAYS)  # dismiss first-run onboarding + instruction cards
        for name, ops in FIXTURES:
            c.eval("return window.__FLUX.reset()")
            for op in ops:
                c.eval(f"return window.__FLUX.{op}")
            # re-clear in case loadScenario re-surfaced an overlay this fixture
            c.eval(CLEAR_OVERLAYS)
            shot = os.path.join(SHOTS, f"vis_{name}.png")
            c.screenshot(shot)
            sig = signature(shot)
            bpath = os.path.join(BASE, f"{name}.json")
            if args.update or not os.path.exists(bpath):
                with open(bpath, "w") as f:
                    json.dump(sig, f)
                results.append((name, "RECORDED", 0.0))
            else:
                with open(bpath) as f:
                    base = json.load(f)
                d = dist(sig, base)
                ok = d <= args.tol
                results.append((name, "OK" if ok else "DRIFT", round(d, 4)))
    finally:
        c.close(); srv.__exit__()

    print("\n=== Visual regression ===")
    bad = 0
    for name, status, d in results:
        flag = "" if status in ("OK", "RECORDED") else "  <-- exceeds tol"
        print(f"  {name:18s} {status:9s} dist={d}{flag}")
        if status == "DRIFT":
            bad += 1
    print(f"{'PASS' if bad == 0 else 'FAIL'}: {len(results)-bad}/{len(results)} fixtures within tolerance")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
