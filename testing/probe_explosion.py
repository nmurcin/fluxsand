import os,sys
HARNESS=r"C:\Users\nmurcin\Lumen\local\tmp\swarm\harness"; sys.path.insert(0,HARNESS)
import cdp
APP=os.path.abspath(os.path.join(os.path.dirname(__file__),".."))
srv=cdp.StaticServer(APP).__enter__(); c=cdp.Chrome(width=1280,height=800); c.launch()
def masses(c): return c.eval("return JSON.parse(JSON.stringify(window.__STATE__.totals.massByMaterial))")
try:
    c.load(srv.url("/index.html"),ready_expr="return window.__READY__===true")
    c.eval("return window.__FLUX.reset()")
    c.eval("return window.__FLUX.reseed(4)")
    # a floor, a TNT block mid-air, a spark to set it off
    c.eval("var W=window.__STATE__.grid.w,H=window.__STATE__.grid.h;"
           "window.__FLUX.paintRect(0,H-6,W-1,H-1,'stone');"
           "window.__FLUX.paintRect(W/2-6,H/2,W/2+6,H/2+8,'tnt');"
           "window.__FLUX.paintRect(W/2-1,H/2-2,W/2+1,H/2-1,'spark'); return null")
    c.eval("return window.__FLUX.step(0)")
    m0=masses(c); hot0=c.eval("return window.__STATE__.hottestCell.tempC")
    c.eval("return window.__FLUX.step(3)")   # detonation window
    mp=masses(c); hotp=c.eval("return window.__STATE__.hottestCell.tempC")
    c.eval("return window.__FLUX.step(12)")  # cloud develops
    m1=masses(c)
    def g(m,k): return m.get(k,0)
    print(f"[pre]   tnt={g(m0,'tnt')} fire={g(m0,'fire')} smoke={g(m0,'smoke')} hottest={hot0}C")
    print(f"[t+3]   tnt={g(mp,'tnt')} fire={g(mp,'fire')} smoke={g(mp,'smoke')} hottest={hotp}C")
    print(f"[t+15]  fire={g(m1,'fire')} smoke={g(m1,'smoke')}  (gas cloud = {g(m1,'fire')+g(m1,'smoke')} cells)")
    gas=g(m1,'fire')+g(m1,'smoke')
    print(f"[verdict] detonated={g(mp,'tnt')<g(m0,'tnt')}  made_lots_of_gas={gas>150}  under_5000C={hotp<5000}")
finally:
    c.close(); srv.__exit__()
