"""Empirical check: does calling reset()/loadScenario() freeze the LIVE rAF loop?

Boots the app (live), then calls a FLUX method and checks whether sim.tick keeps
advancing on its own (real wall-clock rAF frames). If tick stalls, the live
animation is frozen by that call.
"""
import os, sys, time
HARNESS = r"C:\Users\nmurcin\Lumen\local\tmp\swarm\harness"
sys.path.insert(0, HARNESS)
import cdp
APP = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

srv = cdp.StaticServer(APP).__enter__()
c = cdp.Chrome(width=1280, height=800); c.launch()
try:
    c.load(srv.url("/index.html"), ready_expr="return window.__READY__===true")

    def tick():
        return c.eval("return window.__STATE__.tick")

    # 1) BASELINE live: after boot, does tick advance on its own?
    t0 = tick(); time.sleep(0.6); t1 = tick()
    print(f"[live boot]         tick {t0} -> {t1}   advancing={t1>t0}")

    # 2) After loadScenario (current build): does it keep advancing?
    c.eval("return window.__FLUX.loadScenario('Volcano')")
    t2 = tick(); time.sleep(0.6); t3 = tick()
    print(f"[after loadScenario] tick {t2} -> {t3}   advancing={t3>t2}")

    # 3) After reset(): does it keep advancing?
    c.eval("return window.__FLUX.reset()")
    t4 = tick(); time.sleep(0.6); t5 = tick()
    print(f"[after reset]        tick {t4} -> {t5}   advancing={t5>t4}")

    # 4) After play(): does it resume?
    c.eval("return window.__FLUX.play()")
    t6 = tick(); time.sleep(0.6); t7 = tick()
    print(f"[after play]         tick {t6} -> {t7}   advancing={t7>t6}")
finally:
    c.close(); srv.__exit__()
