"""Quick boot smoke test for Fluxsand via the CDP harness."""
import sys, os, json
HARNESS = r"C:\Users\nmurcin\Lumen\local\tmp\swarm\harness"
sys.path.insert(0, HARNESS)
import cdp  # noqa

APP = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SHOTS = os.path.join(APP, "testing", "shots")
os.makedirs(SHOTS, exist_ok=True)


def main():
    srv = cdp.StaticServer(APP).__enter__()
    c = cdp.Chrome(width=1280, height=800)
    c.launch()
    try:
        ok = c.load(srv.url("/index.html"), ready_expr="return window.__READY__===true")
        print("READY:", ok)
        if c.errors:
            print("JS ERRORS:")
            for e in c.errors[:10]:
                print("  -", e)
        st = c.state()
        print("STATE keys:", list(st.keys()) if st else None)
        if st:
            print("  tick:", st.get("tick"), "scenario:", st.get("lastScenario"))
            print("  totals.cellsByPhase:", st.get("totals", {}).get("cellsByPhase"))
            print("  hottest:", st.get("hottestCell"))
        # advance deterministically and confirm ticks progress
        c.eval("return window.__FLUX.reseed(42)")
        c.eval("return window.__FLUX.loadScenario('Volcano')")
        h0 = c.eval("return window.__FLUX.step(60)")
        s1 = c.eval("return window.__FLUX.sample()")
        print("after step(60):", json.dumps(s1))
        c.screenshot(os.path.join(SHOTS, "boot.png"))
        print("shot: testing/shots/boot.png")
        print("console tail:", c.console[-6:])
    finally:
        c.close(); srv.__exit__()


if __name__ == "__main__":
    main()
