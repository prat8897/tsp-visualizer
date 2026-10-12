"""
Mutual-agreement adoption + re-adoption TSP construction, animated, vs an OR-Tools reference.
Purely cost-driven: no crossing / inside / area tests anywhere. (The only geometry left is
scipy's convex hull, which gives the starting tour.)

ADOPTION (one per step)
  * The tour starts as the convex hull; every tour edge is "active".
  * A candidate is a point, or an ARC (a chain of up to ARC_MAX unadopted, nearby points).
  * Inside-out force : every candidate prefers its cheapest active edge.
    Outside-in force: every active edge prefers its cheapest candidate.
    A pair is ADOPTABLE only when both forces agree. The top agreed pair is adopted
    (ORDER = "best": cheapest first). The broken edge is replaced by the two new ones, repeat.

RE-ADOPTION (after every adoption step, and as a polish once everything is adopted)
  Points adopted in an EARLIER step (never hull points) may be lifted out again, singly or as an
  arc of up to ARC_MAX consecutive tour points, and re-adopted whole, in either direction, into
  another tour edge:    gain = cost where it sits now - cost in the new edge.
  The best move with gain > 0 is applied, then the search repeats; a point moves once per step.
  With REQUIRE_SHORTER_TOUR the real tour length must also drop (safe for any cost function).

THE COST: edit adoption_cost() below. Every decision uses only that function.
THE PARAMETERS: edit the block right under it (or override any of them with command-line flags).
REFERENCE: OR-Tools guided local search (strong, but NOT a proof of optimality). For n <= 12 the
exact Held-Karp optimum is also printed as a check.

Usage:  python tsp_mutual_adoption_ortools.py --n 30 --seed 3
Needs:  pip install numpy scipy matplotlib pillow ortools
"""
import os
import argparse
import time
from collections import defaultdict
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.animation as animation
from matplotlib.lines import Line2D
from scipy.spatial import ConvexHull


# ======================================================================================
#  THE COST FUNCTION  --  EDIT ME
# ======================================================================================
def adoption_cost(a_to_first, arc_length, last_to_b, a_to_b, n_points):
    """Cost of adopting an arc into the tour edge a-b.  LOWER = BETTER.

    The edge a-b is replaced by the path   a -> (the arc) -> b   where
        a_to_first : distance from a to the first point of the arc
        arc_length : total length of the arc itself (0 for a single point)
        last_to_b  : distance from the last point of the arc to b
        a_to_b     : length of the edge being broken
        n_points   : how many points the arc has (1 for a single point)
    For one point c this is the classic  ac + cb - ab.

    All inputs are numpy arrays (or plain numbers), so use numpy functions here
    (np.log1p, np.sqrt, ...), not the math module."""
    detour = a_to_first + arc_length + last_to_b - a_to_b
    return detour
    # other costs you could try (replace the line above):
    # return detour - detour / a_to_b             # the cost used in the branch/prune script
    # return detour / n_points                    # average detour per point
    # return np.log1p(detour)                     # compress big detours


# ======================================================================================
#  PARAMETERS  --  EDIT ME  (each can also be overridden from the command line)
# ======================================================================================
N_POINTS = 12            # number of random points                         (--n)
SEED = 7                 # seed for the random points                      (--seed)
USE_MESSY_POINTS = False # True = use the hand-picked 12-point set below   (--messy)

ORDER = "best"           # which agreed pair is adopted each step:
                         #   "best" = the cheapest, "worst" = the most expensive   (--order)
RANK_BY = "per_point"    # how candidates are compared:
                         #   "per_point" = cost / number of points adopted, "total" = raw cost  (--rank)
USE_ARCS = True          # allow adopting / re-adopting chains of several points    (--no-arcs)
ARC_MAX = N_POINTS//2 - 1            # most points in one arc                                    (--arc-max)
KNN = 6                  # arc links: neighbouring arc points must be among each
                         # other's KNN nearest points                                (--knn)

READOPT = True           # lift already-adopted points/arcs and re-adopt them        (--no-readopt)
REQUIRE_SHORTER_TOUR = True  # a re-adoption must also make the real tour shorter

OR_TOOLS_SECONDS = None  # OR-Tools time limit in seconds; None = 3 + n/5, at most 60   (--time)
MAKE_GIF = True          # write the animation + final picture                       (--no-gif)
OUTPUT_PREFIX = None     # None = next to this script                                 (--out)

GIF_DETAIL_MAX_ADOPTIONS = 25  # above this many adoptions, skip the "agreement" frames
GIF_MAX_FRAMES = 150           # longer animations are thinned out to about this many frames
GIF_DPI = 80                   # picture size of the GIF
LABEL_FONT = None              # point-number font size; None = automatic (hidden above 50 points)

EPS = 1e-9                     # smallest gain that counts as an improvement

MESSY_POINTS = np.array([
    [11.4, 64.7], [51.7, 94.7], [26.3, 71.9], [35.0, 7.4],
    [96.9, 15.2], [11.2, 24.4], [10.5, 2.2], [35.9, 58.5],
    [53.9, 12.4], [39.6, 29.5], [47.5, 22.9], [40.7, 39.4],
])


# ======================================================================================
#  helpers
# ======================================================================================
def tour_len(P, tour):
    idx = np.asarray(tour)
    return float(np.linalg.norm(P[idx] - P[np.roll(idx, -1)], axis=1).sum())


def edge_set(tour):
    m = len(tour)
    return {tuple(sorted((tour[k], tour[(k + 1) % m]))) for k in range(m)}


# ======================================================================================
#  the construction
# ======================================================================================
class Builder:
    def __init__(self, P, order, rank_by, use_arcs, arc_max, knn, readopt, require_shorter):
        self.P, self.n = P, len(P)
        self.D = D = np.linalg.norm(P[:, None] - P[None], axis=2)
        self.order, self.rank_by = order, rank_by
        self.arc_max = arc_max if use_arcs else 1
        self.readopt_on, self.require_shorter = readopt, require_shorter
        self.tour = [int(v) for v in ConvexHull(P).vertices]      # the starting tour: the hull
        self.hull_set = set(self.tour)
        self.remaining = set(range(self.n)) - self.hull_set       # points not adopted yet
        self.last_change = {}                                     # point -> step it last moved
        interior = sorted(self.remaining)

        # every arc that can be adopted: ordered chains of 1..arc_max unadopted points
        nn = {i: {int(j) for j in np.argsort(D[i])[1:knn + 1]} for i in range(self.n)}
        linked = lambda i, j: j in nn[i] or i in nn[j]
        chains = [(p,) for p in interior]
        if use_arcs:
            frontier = chains[:]
            for _ in range(2, arc_max + 1):
                frontier = [ch + (q,) for ch in frontier for q in interior
                            if q not in ch and linked(ch[-1], q)]
                chains += frontier
        self.chains = chains
        self.arc_length = np.array([sum(D[c[i], c[i + 1]] for i in range(len(c) - 1)) for c in chains])
        self.n_points = np.array([len(c) for c in chains], dtype=float)
        self.first = np.array([c[0] for c in chains], dtype=int)
        self.last = np.array([c[-1] for c in chains], dtype=int)
        self.alive = np.ones(len(chains), dtype=bool)             # arcs whose points are all unadopted
        self.chains_of_point = defaultdict(list)
        for ci, c in enumerate(chains):
            for p in c:
                self.chains_of_point[p].append(ci)

    # ------------------------------------------------------------------ adoption
    def adopt_step(self, step_i):
        D, tour = self.D, self.tour
        m = len(tour)
        A = np.array(tour)                    # edge e runs from A[e] to B[e]
        B = np.roll(A, -1)
        al = np.nonzero(self.alive)[0]        # the candidates still available
        k = self.n_points[al][:, None]
        cost = adoption_cost(D[A[None, :], self.first[al][:, None]], self.arc_length[al][:, None],
                             D[self.last[al][:, None], B[None, :]], D[A, B][None, :], k)
        metric = cost / k if self.rank_by == "per_point" else cost     # rows = candidates, cols = edges

        best_item = metric.argmin(axis=0)     # outside-in: for every edge, its favourite candidate
        best_edge = metric.argmin(axis=1)     # inside-out: for every candidate, its favourite edge
        agreed = [(int(best_item[e]), e) for e in range(m) if best_edge[best_item[e]] == e]
        if not agreed:
            raise SystemExit("no agreed pair -- is adoption_cost() returning NaN?")
        pick = (min if self.order == "best" else max)(agreed, key=lambda ae: metric[ae[0], ae[1]])
        ai, e = pick
        ch = self.chains[al[ai]]

        ev = dict(type="adopt", step=step_i, tour=tour[:], chain=ch, edge=e,
                  a=tour[e], c=tour[(e + 1) % m], cost=float(cost[ai, e]), metric=float(metric[ai, e]),
                  agreed=[(self.chains[al[x]], y, float(metric[x, y]), float(cost[x, y])) for x, y in agreed])
        self.tour = tour[:e + 1] + list(ch) + tour[e + 1:]
        for p in ch:
            self.remaining.discard(p)
            self.last_change[p] = step_i
            self.alive[self.chains_of_point[p]] = False
        ev["tour_after"] = self.tour[:]
        return ev

    # -------------------------------------------------------------- re-adoption
    def _best_readopt(self, step_i):
        D, tour = self.D, self.tour
        m = len(tour)
        movable = [(p not in self.hull_set) and self.last_change.get(p, -1) < step_i for p in tour]
        best = None                                               # (gain, i, L, j, reversed)
        for i in range(m):                                        # the arc starts at tour[i]
            for L in range(1, self.arc_max + 1):                  # ... and has L points
                if m - L < 3 or not all(movable[(i + q) % m] for q in range(L)):
                    break
                arc = [tour[(i + q) % m] for q in range(L)]
                u, w = tour[i - 1], tour[(i + L) % m]             # its neighbours in the tour
                length = sum(D[arc[q], arc[q + 1]] for q in range(L - 1))
                cost_here = adoption_cost(D[u, arc[0]], length, D[arc[-1], w], D[u, w], L)
                real_here = D[u, arc[0]] + length + D[arc[-1], w] - D[u, w]
                rest = [tour[(i + L + q) % m] for q in range(m - L)]      # the tour without the arc: w ... u
                Ea, Eb = np.array(rest[:-1]), np.array(rest[1:])          # its edges (not the gap u-w)
                for reverse in ((False, True) if L > 1 else (False,)):
                    f, l = (arc[-1], arc[0]) if reverse else (arc[0], arc[-1])
                    gain = cost_here - adoption_cost(D[Ea, f], length, D[l, Eb], D[Ea, Eb], L)
                    if self.require_shorter:
                        shorter = real_here - (D[Ea, f] + length + D[l, Eb] - D[Ea, Eb])
                        gain = np.where(shorter > EPS, gain, -np.inf)
                    j = int(np.argmax(gain))
                    if gain[j] > EPS and (best is None or gain[j] > best[0]):
                        best = (float(gain[j]), i, L, j, reverse)
        if best is None:
            return None
        gain, i, L, j, reverse = best
        arc = [tour[(i + q) % m] for q in range(L)]
        u, w = tour[i - 1], tour[(i + L) % m]
        rest = [tour[(i + L + q) % m] for q in range(m - L)]
        placed = arc[::-1] if reverse else arc
        self.tour = rest[:j + 1] + placed + rest[j + 1:]
        for p in arc:
            self.last_change[p] = step_i
        return dict(type="readopt", step=step_i, tour=tour[:], arc=tuple(arc), placed=tuple(placed),
                    u=u, w=w, a=rest[j], b=rest[j + 1], net=gain, tour_after=self.tour[:])

    def readopt(self, step_i):
        moves = []
        while True:
            mv = self._best_readopt(step_i)
            if mv is None:
                return moves
            moves.append(mv)

    # ---------------------------------------------------------------------- run
    def run(self):
        events, step_i = [], 0
        while step_i < 3 * self.n + 30:
            batch = []
            if self.remaining:
                batch.append(self.adopt_step(step_i))
            if self.readopt_on:
                batch += self.readopt(step_i)
            if not batch:
                break
            events += batch
            step_i += 1
        assert sorted(self.tour) == list(range(self.n)), "construction did not produce a permutation"
        return events


# ======================================================================================
#  reference solvers
# ======================================================================================
def solve_exact(P):
    """Exact optimum via Held-Karp (small n only)."""
    n = len(P)
    D = np.linalg.norm(P[:, None] - P[None], axis=2)
    m = n - 1
    dp = np.full((1 << m, m), np.inf)
    par = np.full((1 << m, m), -1, dtype=int)
    for j in range(m):
        dp[1 << j, j] = D[0, j + 1]
    for mask in range(1, 1 << m):
        for j in range(m):
            if not (mask >> j) & 1 or not np.isfinite(dp[mask, j]):
                continue
            for k in range(m):
                if (mask >> k) & 1:
                    continue
                nm, c = mask | (1 << k), dp[mask, j] + D[j + 1, k + 1]
                if c < dp[nm, k]:
                    dp[nm, k], par[nm, k] = c, j
    full = (1 << m) - 1
    j = int(np.argmin(dp[full] + D[1:, 0]))
    tour, mask = [], full
    while j != -1:
        tour.append(j + 1)
        mask, j = mask ^ (1 << j), int(par[mask, j])
    tour = [0] + tour[::-1]
    return tour, tour_len(P, tour)


def solve_ortools(P, seconds):
    """OR-Tools routing: PATH_CHEAPEST_ARC start, then guided local search for `seconds`.
    Strong but NOT a proof of optimality."""
    from ortools.constraint_solver import pywrapcp, routing_enums_pb2
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
    if sol is None:
        raise SystemExit("OR-Tools found no solution")
    tour, i = [], rt.Start(0)
    while not rt.IsEnd(i):
        tour.append(mgr.IndexToNode(i))
        i = sol.Value(rt.NextVar(i))
    return tour, tour_len(P, tour)


# ======================================================================================
#  animation
# ======================================================================================
def render(P, events, hull, final_tour, ref_tour, ref_len, ref_label, out_gif, out_png, cfg):
    n = len(P)
    ref_edges = edge_set(ref_tour)
    final_len = tour_len(P, final_tour)
    shared = len(edge_set(final_tour) & ref_edges)
    lo, hi = P.min(0) - 8, P.max(0) + 8
    GREEN, GRAY, BLUE, ORANGE, RED, GOLD, ORCHID = (
        "tab:green", "0.25", "tab:blue", "tab:orange", "crimson", "gold", "orchid")
    S = 60 if n <= 15 else max(12, 900 / n)                       # marker size
    FS = LABEL_FONT if LABEL_FONT is not None else (9 if n <= 20 else (7 if n <= 50 else 0))
    W = 1.0 if n <= 20 else 0.65                                  # line-width scale

    detail = sum(e["type"] == "adopt" for e in events) <= GIF_DETAIL_MAX_ADOPTIONS
    frames = [("start", None)]
    for k, e in enumerate(events):
        if e["type"] == "adopt":
            if detail:
                frames.append(("select", k))
            frames.append(("adopt", k))
        else:
            frames.append(("readopt", k))
    frames += [("final", None)] * 3
    if len(frames) > GIF_MAX_FRAMES:
        body = frames[1:-3]
        stride = int(np.ceil(len(body) / (GIF_MAX_FRAMES - 4)))
        frames = [frames[0]] + body[::stride] + frames[-3:]

    fig, (axL, axR) = plt.subplots(1, 2, figsize=(16, 8.4))

    def style(ax):
        ax.set_aspect("equal")
        ax.set_xlim(lo[0], hi[0]); ax.set_ylim(lo[1], hi[1])
        ax.set_xticks([]); ax.set_yticks([])

    def seg(ax, u, v, **kw):
        ax.plot([P[u, 0], P[v, 0]], [P[u, 1], P[v, 1]], **kw)

    def arrow(ax, p, q, color, lw):
        ax.annotate("", xy=q, xytext=p, zorder=6,
                    arrowprops=dict(arrowstyle="-|>", color=color, lw=lw * W, mutation_scale=16 * W,
                                    shrinkA=0, shrinkB=0))

    def labels(ax):
        if FS:
            for i in range(n):
                ax.annotate(str(i), P[i], textcoords="offset points", xytext=(5, 5),
                            fontsize=FS, fontweight="bold", zorder=7)

    def draw_tour(ax, tour, glow=()):
        m = len(tour)
        for k in range(m):
            u, v = tour[k], tour[(k + 1) % m]
            if tuple(sorted((u, v))) in glow:
                seg(ax, u, v, color=GOLD, lw=8 * W, alpha=0.55, zorder=1, solid_capstyle="round")
        for k in range(m):
            u, v = tour[k], tour[(k + 1) % m]
            good = tuple(sorted((u, v))) in ref_edges
            seg(ax, u, v, color=GREEN if good else GRAY, lw=(3.2 if good else 2.4) * W, zorder=3)

    def draw_points(ax, adopted, new=(), new_color=GOLD):
        rem = [i for i in range(n) if i not in adopted and i not in new]
        ad = [i for i in adopted if i not in new]
        ax.scatter(P[ad, 0], P[ad, 1], s=S, color="black", zorder=5)
        if rem:
            ax.scatter(P[rem, 0], P[rem, 1], s=S, facecolor="white", edgecolor="black", lw=1.6 * W, zorder=5)
        if new:
            ax.scatter(P[list(new), 0], P[list(new), 1], s=2 * S, facecolor=new_color,
                       edgecolor="black", lw=1.6 * W, zorder=6)
        labels(ax)

    def label(ch):
        return f"point {ch[0]}" if len(ch) == 1 else "arc " + "-".join(map(str, ch))

    def draw_right(final):
        axR.plot(*np.vstack([P[hull], P[hull[0]]]).T, color="0.7", lw=1.2 * W, ls="--", zorder=1)
        for k in range(n):
            seg(axR, ref_tour[k], ref_tour[(k + 1) % n], color=GREEN, lw=3.4 * W, zorder=3)
        if final:
            for k in range(n):
                u, v = final_tour[k], final_tour[(k + 1) % n]
                if tuple(sorted((u, v))) not in ref_edges:
                    seg(axR, u, v, color=ORANGE, lw=2.6 * W, ls=(0, (4, 2)), zorder=4)
        axR.scatter(P[:, 0], P[:, 1], s=S, color="black", zorder=5)
        labels(axR)
        if final:
            axR.set_title(f"{ref_label} (green) + constructed tour's other edges (orange dashed)\n"
                          f"reference {ref_len:.2f}  |  constructed {final_len:.2f}  "
                          f"({(final_len / ref_len - 1) * 100:+.2f}%)  |  shares {shared}/{n} edges", fontsize=11)
        else:
            axR.set_title(f"{ref_label}: length {ref_len:.2f}\ndashed grey = convex hull", fontsize=11)
        style(axR)

    handles = [Line2D([0], [0], color=GREEN, lw=3, label="tour edge also in the reference"),
               Line2D([0], [0], color=GRAY, lw=2.4, label="tour edge not in the reference"),
               Line2D([0], [0], color=BLUE, lw=2, marker=">", ms=7, label="inside-out: candidate -> best edge"),
               Line2D([0], [0], color=ORANGE, lw=2, marker=">", ms=7, label="outside-in: edge -> best candidate"),
               Line2D([0], [0], color=RED, lw=2.5, ls="--", label="move being adopted"),
               Line2D([0], [0], color="purple", lw=2, ls="--", label="re-adoption: edges the arc left")]

    def draw(fi):
        axL.clear(); axR.clear()
        kind, k = frames[fi]
        if kind == "start":
            draw_tour(axL, hull); draw_points(axL, set(hull))
            axL.set_title(f"Start: convex hull, length {tour_len(P, hull):.1f}\n"
                          f"{n - len(hull)} points still to adopt", fontsize=11)
        elif kind == "select":
            e = events[k]
            draw_tour(axL, e["tour"]); draw_points(axL, set(e["tour"]))
            for ch, ei, met, cst in e["agreed"]:
                a, c = e["tour"][ei], e["tour"][(ei + 1) % len(e["tour"])]
                ip, em = P[list(ch)].mean(0), (P[a] + P[c]) / 2
                mid = (ip + em) / 2
                lw = 3.2 if (ch == e["chain"] and ei == e["edge"]) else 1.6
                arrow(axL, ip, mid, BLUE, lw)
                arrow(axL, em, mid, ORANGE, lw)
                for u, v in zip(ch, ch[1:]):
                    seg(axL, u, v, color=BLUE, lw=1.4 * W, alpha=0.7, zorder=2)
            ch, a, c = e["chain"], e["a"], e["c"]
            seg(axL, a, c, color=RED, lw=3 * W, ls=(0, (2, 2)), zorder=4)
            path = [a, *ch, c]
            for u, v in zip(path, path[1:]):
                seg(axL, u, v, color=RED, lw=2.8 * W, ls=(0, (5, 2)), zorder=4)
            per = f"  ({e['metric']:.1f} per point)" if len(ch) > 1 else ""
            axL.set_title(f"Step {e['step'] + 1}: {len(e['agreed'])} agreed pair(s); "
                          f"adopting {label(ch)} into edge {a}-{c}\n"
                          f"cost +{e['cost']:.1f}{per}   |   tour so far {tour_len(P, e['tour']):.1f}", fontsize=11)
        elif kind == "adopt":
            e = events[k]
            added = {tuple(sorted(x)) for x in zip([e["a"], *e["chain"]], [*e["chain"], e["c"]])}
            draw_tour(axL, e["tour_after"], glow=added)
            draw_points(axL, set(e["tour_after"]), new=set(e["chain"]))
            axL.set_title(f"Step {e['step'] + 1}: adopted {label(e['chain'])} "
                          f"(edge {e['a']}-{e['c']} broken, {len(e['chain']) + 1} new edge(s))\n"
                          f"{n - len(e['tour_after'])} point(s) left   |   "
                          f"tour so far {tour_len(P, e['tour_after']):.1f}", fontsize=11)
        elif kind == "readopt":
            e = events[k]
            t = e["tour_after"]
            for x, y in ((e["u"], e["arc"][0]), (e["arc"][-1], e["w"])):
                seg(axL, x, y, color="purple", lw=2.2 * W, ls=(0, (4, 2)), zorder=4)
            added = {tuple(sorted(x)) for x in ((e["a"], e["placed"][0]), (e["placed"][-1], e["b"]),
                                                (e["u"], e["w"]))}
            draw_tour(axL, t, glow=added)
            draw_points(axL, set(t), new=set(e["arc"]), new_color=ORCHID)
            axL.set_title(f"Step {e['step'] + 1}: RE-ADOPT {label(e['arc'])}: lifted from between "
                          f"{e['u']} and {e['w']}, re-adopted into edge {e['a']}-{e['b']}\n"
                          f"gain {e['net']:.2f}   |   tour now {tour_len(P, t):.1f}", fontsize=11)
        else:
            draw_tour(axL, final_tour); draw_points(axL, set(final_tour))
            axL.set_title(f"Done ({cfg}): length {final_len:.2f}\n"
                          f"{shared}/{n} edges match the reference", fontsize=11)
        style(axL)
        draw_right(kind == "final")

    fig.subplots_adjust(left=0.01, right=0.99, top=0.865, bottom=0.095, wspace=0.03)
    fig.legend(handles=handles, loc="lower center", ncol=6, fontsize=8.5, frameon=False)
    interval = int(np.clip(14000 / len(frames), 250, 1200))
    anim = animation.FuncAnimation(fig, draw, frames=len(frames), interval=interval, repeat=True)
    anim.save(out_gif, writer=animation.PillowWriter(fps=1000 / interval), dpi=GIF_DPI)
    draw(len(frames) - 1)
    fig.savefig(out_png, dpi=110)
    plt.close(fig)


# ======================================================================================
#  main
# ======================================================================================
def main():
    ap = argparse.ArgumentParser(description="Every default below is the constant at the top of the file.")
    ap.add_argument("--n", type=int, default=N_POINTS)
    ap.add_argument("--seed", type=int, default=SEED)
    ap.add_argument("--messy", action="store_true", default=USE_MESSY_POINTS)
    ap.add_argument("--time", type=float, default=OR_TOOLS_SECONDS)
    ap.add_argument("--order", choices=["best", "worst"], default=ORDER)
    ap.add_argument("--rank", choices=["per_point", "total"], default=RANK_BY)
    ap.add_argument("--no-arcs", action="store_true", default=not USE_ARCS)
    ap.add_argument("--no-readopt", action="store_true", default=not READOPT)
    ap.add_argument("--arc-max", type=int, default=ARC_MAX)
    ap.add_argument("--knn", type=int, default=KNN)
    ap.add_argument("--no-gif", action="store_true", default=not MAKE_GIF)
    ap.add_argument("--out", default=OUTPUT_PREFIX)
    args = ap.parse_args()

    if args.messy:
        P = MESSY_POINTS.copy()
    else:
        if args.n < 4:
            raise SystemExit("need n >= 4")
        P = np.round(np.random.default_rng(args.seed).uniform(0, 100, (args.n, 2)), 1)
    n = len(P)
    tag = "messy_n12" if args.messy else f"n{n}_seed{args.seed}"
    prefix = args.out or os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                      f"tsp_mutual_adoption_{tag}")
    secs = args.time if args.time is not None else min(60.0, 3 + n / 5)
    cfg = (f"order={args.order}, rank={args.rank}, arcs={'off' if args.no_arcs else args.arc_max}, "
           f"re-adoption={'off' if args.no_readopt else 'on'}")

    t0 = time.time()
    b = Builder(P, args.order, args.rank, not args.no_arcs, args.arc_max, args.knn,
                not args.no_readopt, REQUIRE_SHORTER_TOUR)
    events = b.run()
    build_s = time.time() - t0
    tour, L = b.tour, tour_len(P, b.tour)
    hull = [int(v) for v in ConvexHull(P).vertices]

    for e in events:
        if e["type"] == "adopt":
            ch = e["chain"]
            what = f"point {ch[0]}" if len(ch) == 1 else f"arc {'-'.join(map(str, ch))}"
            print(f"step {e['step'] + 1:>3}: adopt    {what:<18} -> edge {e['a']}-{e['c']}  cost {e['cost']:6.2f}")
        else:
            ar = e["arc"]
            what = f"point {ar[0]}" if len(ar) == 1 else f"arc {'-'.join(map(str, ar))}"
            print(f"step {e['step'] + 1:>3}: RE-ADOPT {what:<18} {e['u']}|{e['w']} -> edge {e['a']}-{e['b']}  "
                  f"gain {e['net']:.2f}")
    print(f"[{cfg}] built in {build_s:.1f}s: {sum(e['type'] == 'adopt' for e in events)} adoptions, "
          f"{sum(e['type'] == 'readopt' for e in events)} re-adoptions, length {L:.2f}")

    print(f"running OR-Tools for {secs:.0f}s ...", flush=True)
    ref_tour, ref_len = solve_ortools(P, secs)
    print(f"OR-Tools {ref_len:.2f} | ours {L:.2f} | gap {(L / ref_len - 1) * 100:+.2f}% | "
          f"shared edges {len(edge_set(tour) & edge_set(ref_tour))}/{n}")
    if n <= 12:
        _, ex_len = solve_exact(P)
        print(f"exact Held-Karp optimum {ex_len:.2f} "
              f"({'OR-Tools matches it' if abs(ref_len - ex_len) < 1e-6 else 'OR-Tools did NOT reach it'})")
    if not args.no_gif:
        render(P, events, hull, tour, ref_tour, ref_len, f"OR-Tools (guided local search, {secs:.0f}s)",
               prefix + ".gif", prefix + "_final.png", cfg)
        print(f"saved {prefix}.gif and {prefix}_final.png")


if __name__ == "__main__":
    main()