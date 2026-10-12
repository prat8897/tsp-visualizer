"""Run the original Python Builder on a JSON point set and print a summary (for cross-checking the JS port)."""
import sys, json, importlib.util, time
import numpy as np
spec = importlib.util.spec_from_file_location("ref", __file__.replace("compare.py", "reference_tsp_mutual_adoption.py"))
ref = importlib.util.module_from_spec(spec); spec.loader.exec_module(ref)

def run(P, arc_max, knn=6, order="best", rank="per_point"):
    b = ref.Builder(P, order, rank, True, arc_max, knn, True, True)
    t0 = time.time(); ev = b.run(); dt = time.time() - t0
    return b.tour, ref.tour_len(P, b.tour), ev, dt

if __name__ == "__main__":
    data = json.load(open(sys.argv[1]))
    P = np.array(data["points"], dtype=float).reshape(-1, 2)
    arc = int(data["arcMax"])
    tour, L, ev, dt = run(P, arc, data.get("knn", 6), data.get("order", "best"), data.get("rank", "per_point"))
    print(json.dumps({"length": L, "tour": [int(x) for x in tour], "adopt": sum(e["type"]=="adopt" for e in ev),
                      "readopt": sum(e["type"]=="readopt" for e in ev), "secs": dt}))
