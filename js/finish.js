// Parallel finishing stages. Pure functions: the heavy ones run in Web Workers, the plan itself is a small async function
// that is handed an `exec(jobs)` function, so the same code runs in the page (workers) and in Node (tests).
//
//   1. race:      one greedy build per cost function (all side by side), each polished with its own seed
//   2. merge:     recombine those tours: keep the cheaper side wherever two tours differ in a self-contained patch
//   3. segments:  cut the merged tour into stretches with fixed ends, search every stretch at once, stitch them back,
//                 then cut again at shifted places so the old seams get searched too
import { construct, distanceMatrix, iteratedLocalSearch, tourLength, EPS } from "./solver.js";

const BIG = 1e7;

/* ---------------------------------------------------------------- 3. segment search (the worker half) */

/** Improve a path with both ends fixed: the same iterated local search on the closed loop, with the closing edge made un-removable. */
export function improvePath(P, path, iters, seed) {
  const m = path.length;
  if (m < 8) return path.slice();
  const Q = new Float64Array(2 * m);
  for (let i = 0; i < m; i++) { Q[2 * i] = P[2 * path[i]]; Q[2 * i + 1] = P[2 * path[i] + 1]; }
  const D = distanceMatrix(Q, m);
  D[m - 1] = D[(m - 1) * m] = -BIG;                       // entry 0 <-> m-1
  const res = iteratedLocalSearch(D, m, Array.from({ length: m }, (_, i) => i), { maxIters: iters, seed });
  const t = res.tour, i0 = t.indexOf(0), dir = t[(i0 + 1) % m] === m - 1 ? -1 : 1;
  const out = new Array(m);
  for (let q = 0; q < m; q++) out[q] = path[t[(i0 + dir * q + 2 * m) % m]];
  return out;
}

/** Cut a cyclic tour into `parts` stretches (rotated by `offset` positions). */
export function cutTour(tour, parts, offset) {
  const n = tour.length, rot = tour.slice(offset % n).concat(tour.slice(0, offset % n)), out = [];
  for (let s = 0; s < parts; s++) out.push(rot.slice(Math.floor((s * n) / parts), Math.floor(((s + 1) * n) / parts)));
  return out;
}

/* ---------------------------------------------------------------- 2. merging tours */

const ekey = (u, v, n) => (u < v ? u * n + v : v * n + u);

/** Walk an edge set (two neighbours per point) from point 0; returns the tour, or null if it is more than one cycle. */
function walk(nb, n) {
  const t = [0]; let prev = -1, cur = 0;
  for (let k = 1; k < n; k++) {
    const nx = nb[2 * cur] !== prev ? nb[2 * cur] : nb[2 * cur + 1];
    if (nx === 0) return null;
    t.push(nx); prev = cur; cur = nx;
  }
  return t;
}

/**
 * Where tour A and tour B differ, the differences fall into separate patches (connected pieces of the edges that only one of
 * them has). For each patch, try taking B's side instead of A's; keep it if it is shorter and the result is still one tour.
 */
export function recombine(D, n, A, B) {
  const nb = new Int32Array(2 * n);
  for (let i = 0; i < n; i++) { nb[2 * A[i]] = A[(i - 1 + n) % n]; nb[2 * A[i] + 1] = A[(i + 1) % n]; }
  const aSet = new Set(), bSet = new Set();
  for (let i = 0; i < n; i++) { aSet.add(ekey(A[i], A[(i + 1) % n], n)); bSet.add(ekey(B[i], B[(i + 1) % n], n)); }
  const onlyA = [], onlyB = [];
  for (let i = 0; i < n; i++) {
    const a = [A[i], A[(i + 1) % n]], b = [B[i], B[(i + 1) % n]];
    if (!bSet.has(ekey(a[0], a[1], n))) onlyA.push(a);
    if (!aSet.has(ekey(b[0], b[1], n))) onlyB.push(b);
  }
  if (!onlyA.length) return A.slice();
  const uf = Int32Array.from({ length: n }, (_, i) => i);
  const find = (x) => { while (uf[x] !== x) { uf[x] = uf[uf[x]]; x = uf[x]; } return x; };
  for (const [u, v] of onlyA.concat(onlyB)) uf[find(u)] = find(v);
  const patches = new Map();
  for (const e of onlyA) { const r = find(e[0]); if (!patches.has(r)) patches.set(r, { a: [], b: [], ga: 0, gb: 0 }); const p = patches.get(r); p.a.push(e); p.ga += D[e[0] * n + e[1]]; }
  for (const e of onlyB) { const r = find(e[0]); const p = patches.get(r); if (p) { p.b.push(e); p.gb += D[e[0] * n + e[1]]; } }
  const order = [...patches.values()].filter((p) => p.gb < p.ga - EPS).sort((x, y) => (y.ga - y.gb) - (x.ga - x.gb));
  const setNb = (u, oldV, newV) => { if (nb[2 * u] === oldV) nb[2 * u] = newV; else nb[2 * u + 1] = newV; };
  for (const p of order) {
    const save = nb.slice();
    // take A's patch edges out (mark -1), then put B's in
    for (const [u, v] of p.a) { setNb(u, v, -1); setNb(v, u, -1); }
    let ok = true;
    for (const [u, v] of p.b) {
      for (const [x, y] of [[u, v], [v, u]]) { if (nb[2 * x] === -1) nb[2 * x] = y; else if (nb[2 * x + 1] === -1) nb[2 * x + 1] = y; else ok = false; }
    }
    if (!ok || walk(nb, n) === null) nb.set(save);
  }
  return walk(nb, n) || A.slice();
}

/** Fold several tours into one that is no longer than the best of them. */
export function mergeTours(D, n, tours) {
  const ranked = tours.map((t) => ({ t, L: tourLength(D, n, t) })).sort((x, y) => x.L - y.L);
  let cur = ranked[0].t.slice(), L = ranked[0].L;
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    for (let i = 1; i < ranked.length; i++) {
      const c = recombine(D, n, cur, ranked[i].t), cl = tourLength(D, n, c);
      if (cl < L - 1e-9) { cur = c; L = cl; changed = true; }
    }
    if (!changed) break;
  }
  return cur;
}

/* ---------------------------------------------------------------- the plan */

// (detourRatio is left out of the race: it triggers thousands of re-adoptions and builds ~15x slower)
export const RACE_COSTS = ["detour", "perPoint", "log"];

/**
 * exec(jobs) -> Promise of results, in order; jobs run side by side wherever the caller can run them.
 * job types: {type:"build", opts} -> {tour}      {type:"polish", tour, iters, seed} -> {tour}
 *            {type:"path", path, iters, seed} -> {path}
 * `first` is the construction result (with events) the page animates; its own cost function is not rebuilt.
 */
export async function finishInParallel(P, n, first, exec, { workers = 4, iters, rounds = 2, segIters, buildOpts = {} } = {}) {
  const D = distanceMatrix(P, n);
  const stats = { stages: [] };
  const mark = (name, tour) => stats.stages.push({ name, length: tourLength(D, n, tour) });
  mark("build", first.tour);
  const firstCost = first.costUsed || "detour";
  const others = RACE_COSTS.filter((c) => c !== firstCost).slice(0, Math.max(0, workers - 1));

  // 1. race: the first tour + one build per other cost function, each polished with its own seed
  const builds = await exec(others.map((cost) => ({ type: "build", opts: { ...buildOpts, cost, polishIters: 0 } })));
  const starts = [first.tour, ...builds.map((b) => b.tour)];
  const polished = await exec(starts.map((tour, i) => ({ type: "polish", tour, iters, seed: i + 1 })));
  const tours = polished.map((r) => r.tour);
  mark("race (best single)", tours.reduce((b, t) => (tourLength(D, n, t) < tourLength(D, n, b) ? t : b)));

  // 2. merge
  let tour = mergeTours(D, n, tours);
  mark("merge", tour);

  // 3. segments, cut again at shifted places
  const parts = Math.max(1, Math.min(workers, Math.floor(n / 20)));
  if (parts > 1) {
    for (let r = 0; r < rounds; r++) {
      const cuts = cutTour(tour, parts, Math.floor((r * n) / (parts * rounds)));
      const res = await exec(cuts.map((path, i) => ({ type: "path", path, iters: segIters || Math.max(100, 6 * path.length), seed: 10 * r + i + 1 })));
      const joined = [].concat(...res.map((x) => x.path));
      if (tourLength(D, n, joined) <= tourLength(D, n, tour) + 1e-9) tour = joined;
    }
    mark("segments", tour);
  }
  return { tour, length: tourLength(D, n, tour), stats };
}

/** What a worker (or a test) does with one job. */
export function runJob(P, n, job) {
  if (job.type === "build") return { tour: construct(P, n, job.opts).tour };
  if (job.type === "polish") {
    const D = distanceMatrix(P, n);
    return { tour: iteratedLocalSearch(D, n, job.tour, { maxIters: job.iters, seed: job.seed }).tour };
  }
  if (job.type === "path") return { path: improvePath(P, job.path, job.iters, job.seed) };
  throw new Error("unknown job " + job.type);
}

/** Add the finished tour to a construct() result as one last step, so the page can show what the parallel stages changed. */
export function attachSqueeze(result, D, tour, stats) {
  const before = new Set(), after = new Set(), n = result.n;
  const key = (t, i) => { const a = t[i], b = t[(i + 1) % n]; return Math.min(a, b) * 65536 + Math.max(a, b); };
  for (let i = 0; i < n; i++) { before.add(key(result.tour, i)); after.add(key(tour, i)); }
  const dec = (k) => [Math.floor(k / 65536), k % 65536];
  const oldLen = tourLength(D, n, result.tour), newLen = tourLength(D, n, tour);
  if (newLen < oldLen - 1e-9) {
    const step = result.events.length ? result.events[result.events.length - 1].step + 1 : 0;
    result.events.push({
      type: "polish", step, net: oldLen - newLen, squeeze: true,
      removed: [...before].filter((k) => !after.has(k)).map(dec), added: [...after].filter((k) => !before.has(k)).map(dec),
      tourAfter: tour.slice(),
    });
    result.tour = tour; result.length = newLen; result.polishes = result.events.filter((e) => e.type === "polish").length;
  }
  result.squeezeStages = stats.stages;
  return result;
}
