"""Empirical check: does CURRENT propagate down a copper wire and warm it?

Paints a horizontal COPPER wire, drops a SPARK on the left end, steps the sim,
and asserts via cellAt that a live_wire pulse reached the FAR (right) end of the
wire (current propagated through copper, not air) and that the wire warmed up
above ambient (flowing current heats the conductor). Prints PASS/FAIL.

Throwaway probe modeled on testing/probe_live_freeze.py's CDP boilerplate.
"""
import os, sys
HARNESS = r"C:\Users\nmurcin\Lumen\local\tmp\swarm\harness"
sys.path.insert(0, HARNESS)
import cdp
APP = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

srv = cdp.StaticServer(APP).__enter__()
c = cdp.Chrome(width=1280, height=800); c.launch()
try:
    c.load(srv.url("/index.html"), ready_expr="return window.__READY__===true")
    # Freeze the live rAF loop so the sim only advances when we call step(n).
    c.eval("return window.__FLUX.pause()")
    c.eval("return window.__FLUX.reset()")
    c.eval("return window.__FLUX.reseed(1)")
    c.eval("return window.__FLUX.step(0)")

    g = c.eval("return window.__STATE__.grid")
    W, H = g["w"], g["h"]
    y = H // 2
    # A wire ~120 cells long: long enough to PROVE the pulse crossed copper (not
    # air) yet short enough for the seeded ~0.6-chance front to reach the far end
    # well within the step budget below (measured front speed ~1 cell/tick).
    x0, x1 = 20, 140
    # Paint a 1-row copper wire.
    c.eval(f"return window.__FLUX.paintRect({x0},{y},{x1},{y},'copper')")
    # Drop a spark on the LEFT end of the wire to energize it.
    c.eval(f"return window.__FLUX.paintRect({x0},{y},{x0+1},{y},'spark')")
    c.eval("return window.__FLUX.step(0)")

    # Step and watch for a live_wire pulse to reach the far (right) end.
    far_reached = False
    max_temp = -999.0
    for _ in range(200):
        c.eval("return window.__FLUX.step(1)")
        # scan the right quarter of the wire for a live_wire pulse
        res = c.eval(
            f"var found=false,mt=-999;"
            f"for(var x={x0};x<={x1};x++){{var cc=window.__FLUX.cellAt(x,{y});"
            f"if(!cc)continue;"
            f"if((cc.material==='copper'||cc.material==='live_wire')&&cc.tempC>mt)mt=cc.tempC;"
            f"if(cc.material==='live_wire'&&x>={x1-4})found=true;}}"
            f"return {{found:found,mt:mt}};"
        )
        if res["mt"] > max_temp:
            max_temp = res["mt"]
        if res["found"]:
            far_reached = True
            break

    # Final wire census.
    census = c.eval(
        f"var copper=0,live=0,molten=0;"
        f"for(var x={x0};x<={x1};x++){{var cc=window.__FLUX.cellAt(x,{y});"
        f"if(!cc)continue;"
        f"if(cc.material==='copper')copper++;"
        f"if(cc.material==='live_wire')live++;"
        f"if(cc.material==='molten_metal')molten++;}}"
        f"return {{copper:copper,live:live,molten:molten}};"
    )

    warmed = max_temp > 30  # meaningfully above ambient 22C

    print(f"[wire census]  copper={census['copper']} live_wire={census['live']} molten={census['molten']}")
    print(f"[propagation]  live_wire reached far end (x>= {x1-4}): {far_reached}")
    print(f"[heating]      hottest wire cell during run: {max_temp:.0f}C (warmed>30C: {warmed})")

    # CONTROL: current must NOT jump an air gap. Two copper segments separated by a
    # 6-cell air break; spark the left segment; the right segment must stay dead.
    c.eval("return window.__FLUX.reset()")
    c.eval("return window.__FLUX.reseed(2)")
    c.eval("return window.__FLUX.step(0)")
    yc = H // 3
    segL0, segL1 = 20, 60
    gap = 6
    segR0, segR1 = segL1 + 1 + gap, segL1 + 1 + gap + 40
    c.eval(f"return window.__FLUX.paintRect({segL0},{yc},{segL1},{yc},'copper')")
    c.eval(f"return window.__FLUX.paintRect({segR0},{yc},{segR1},{yc},'copper')")
    c.eval(f"return window.__FLUX.paintRect({segL0},{yc},{segL0+1},{yc},'spark')")
    c.eval("return window.__FLUX.step(120)")
    right_live = c.eval(
        f"var live=0;for(var x={segR0};x<={segR1};x++){{var cc=window.__FLUX.cellAt(x,{yc});"
        f"if(cc&&cc.material==='live_wire')live++;}}return live;"
    )
    left_live_ever = c.eval(
        f"var seen=0;for(var x={segL0};x<={segL1};x++){{var cc=window.__FLUX.cellAt(x,{yc});"
        f"if(cc&&(cc.material==='live_wire'||cc.tempC>30))seen++;}}return seen;"
    )
    air_gap_blocks = (right_live == 0) and (left_live_ever > 0)
    print(f"[air-gap ctrl] left segment energized cells={left_live_ever}, "
          f"right segment live_wire across a {gap}-cell air gap={right_live} "
          f"(current confined to copper: {air_gap_blocks})")

    ok = far_reached and warmed and air_gap_blocks
    print("RESULT:", "PASS" if ok else "FAIL",
          "-- current propagated the full wire, heated it, and stayed in copper" if ok
          else "-- current did NOT propagate/heat, or leaked across the air gap")
finally:
    c.close(); srv.__exit__()
