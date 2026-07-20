"""
hashprobe.py — capture deterministic stateHash + key totals across scenarios.

Used to PROVE that a refactor is byte-identical (M5/M6/M1-surgical must not change
the sim). Run before a change to write a baseline, run after to diff.

    py testing/hashprobe.py            # print current hashes
    py testing/hashprobe.py --save     # write baseline to testing/hashprobe.json
    py testing/hashprobe.py --check    # compare current vs saved baseline (exit 1 on drift)
"""
from __future__ import annotations
import os
import sys
import json

HARNESS = r"C:\Users\nmurcin\Lumen\local\tmp\swarm\harness"
sys.path.insert(0, HARNESS)
import cdp  # noqa: E402

APP = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
INDEX_URL_PATH = "/index.html"
BASELINE = os.path.join(os.path.dirname(__file__), "hashprobe.json")

# (scenario, seed, steps). Also probe a hand-painted lava+water case and an
# empty grid so the probe covers reactions, phase change, movement, and idle.
CASES = [
    ("Volcano", 42, 100),
    ("Volcano", 7, 250),
    ("Steam", 3, 200),
    ("Thermite", 9, 300),
    ("IceAge", 5, 150),
    ("CryoLab", 21, 120),
    ("PowderKeg", 1, 120),
    ("ChemLab", 2, 120),
    ("ThermiteFoundry", 9, 150),
    ("RubeGoldberg", 1, 200),
    ("Hourglass", 4, 200),
    ("Empty", 1, 50),
]


def probe(c):
    out = {}
    for scn, seed, steps in CASES:
        c.eval("return window.__FLUX.reset()")
        c.eval(f"return window.__FLUX.reseed({seed})")
        c.eval(f"return window.__FLUX.loadScenario('{scn}')")
        c.eval(f"return window.__FLUX.step({steps})")
        h = c.eval("return window.__FLUX.stateHash()")
        s = c.eval("return JSON.parse(JSON.stringify(window.__STATE__.totals))")
        hot = c.eval("return window.__STATE__.hottestCell ? window.__STATE__.hottestCell.tempC : null")
        key = f"{scn}:{seed}:{steps}"
        out[key] = {
            "hash": int(h) if isinstance(h, (int, float)) else h,
            "energy": s.get("thermalEnergyJ"),
            "phases": s.get("cellsByPhase"),
            "hottest": hot,
        }
    return out


def main():
    save = "--save" in sys.argv
    check = "--check" in sys.argv
    srv = cdp.StaticServer(APP).__enter__()
    c = cdp.Chrome(width=1280, height=800)
    c.launch()
    try:
        ok = c.load(srv.url(INDEX_URL_PATH), ready_expr="return window.__READY__===true")
        if not ok:
            print("FATAL: app did not boot")
            sys.exit(2)
        c.eval("return window.__FLUX.step(0)")  # freeze rAF
        cur = probe(c)
    finally:
        c.close()
        srv.__exit__()

    if save:
        json.dump(cur, open(BASELINE, "w", encoding="utf-8"), indent=1)
        print(f"saved baseline: {BASELINE} ({len(cur)} cases)")
        for k, v in cur.items():
            print(f"  {k:28s} hash=0x{v['hash']:08x} energy={v['energy']}")
        return

    if check:
        if not os.path.exists(BASELINE):
            print("no baseline to check against; run --save first")
            sys.exit(2)
        base = json.load(open(BASELINE, encoding="utf-8"))
        drift = []
        for k, v in cur.items():
            b = base.get(k)
            if b is None:
                drift.append(f"{k}: NEW case (no baseline)")
            elif b["hash"] != v["hash"]:
                drift.append(f"{k}: hash 0x{b['hash']:08x} -> 0x{v['hash']:08x} "
                             f"(energy {b['energy']}->{v['energy']})")
        print("=" * 70)
        if drift:
            print("HASH DRIFT DETECTED (refactor is NOT byte-identical):")
            for d in drift:
                print("  " + d)
            print("=" * 70)
            sys.exit(1)
        print(f"BYTE-IDENTICAL: all {len(cur)} cases match baseline hashes.")
        print("=" * 70)
        sys.exit(0)

    # default: just print
    for k, v in cur.items():
        print(f"  {k:28s} hash=0x{v['hash']:08x} energy={v['energy']} hottest={v['hottest']}")


if __name__ == "__main__":
    main()
