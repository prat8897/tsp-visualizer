"""OR-Tools guided local search on the same instances (same settings as the original script: PATH_CHEAPEST_ARC + GLS)."""
import json, sys, numpy as np
from multiprocessing import Pool
from ortools.constraint_solver import pywrapcp, routing_enums_pb2

def solve(args):
    P, seconds = args
    P = np.array(P).reshape(-1, 2)
    D = np.linalg.norm(P[:, None] - P[None], axis=2)
    Di = np.rint(D * 1000).astype(int)
    mgr = pywrapcp.RoutingIndexManager(len(D), 1, 0)
    rt = pywrapcp.RoutingModel(mgr)
    cb = rt.RegisterTransitCallback(lambda i, j: int(Di[mgr.IndexToNode(i), mgr.IndexToNode(j)]))
    rt.SetArcCostEvaluatorOfAllVehicles(cb)
    prm = pywrapcp.DefaultRoutingSearchParameters()
    prm.first_solution_strategy = routing_enums_pb2.FirstSolutionStrategy.PATH_CHEAPEST_ARC
    prm.local_search_metaheuristic = routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
    prm.time_limit.FromMilliseconds(int(seconds * 1000))
    sol = rt.SolveWithParameters(prm)
    tour, i = [], rt.Start(0)
    while not rt.IsEnd(i):
        tour.append(mgr.IndexToNode(i)); i = sol.Value(rt.NextVar(i))
    idx = np.array(tour)
    return float(np.linalg.norm(P[idx] - P[np.roll(idx, -1)], axis=1).sum())

if __name__ == "__main__":
    cases = json.load(open("bench_cases.json"))
    jobs = [(c["points"], min(60.0, 3 + c["n"] / 5)) for c in cases]
    with Pool(int(sys.argv[1]) if len(sys.argv) > 1 else 2) as pool:
        res = pool.map(solve, jobs)
    for c, r in zip(cases, res): c["ortools"] = r
    json.dump(cases, open("bench_results.json", "w"))
    print("done")
