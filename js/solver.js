// Mutual-agreement adoption + re-adoption TSP construction.
// A faithful JavaScript port of tsp_mutual_adoption_ortools.py (see tests/ for the Python original).
// Pure functions, no DOM: runs in a Web Worker, the main thread, or Node.

export const EPS = 1e-9;

/* ------------------------------------------------------------------ cost functions
   Every decision the construction makes goes through one of these.
   (a_to_first, arc_length, last_to_b, a_to_b, n_points) -> number, lower = better */
export const COSTS = {
  detour: {
    label: "Detour (cheapest insertion)",
    fn: (af, al, lb, ab) => af + al + lb - ab,
  },
  detourRatio: {
    label: "Detour minus detour / edge length",
    fn: (af, al, lb, ab) => { const d = af + al + lb - ab; return d - d / ab; },
  },
  perPoint: {
    label: "Average detour per point",
    fn: (af, al, lb, ab, k) => (af + al + lb - ab) / k,
  },
  log: {
    label: "Compressed detour (log)",
    fn: (af, al, lb, ab) => Math.log1p(Math.max(0, af + al + lb - ab)),
  },
};

export const DEFAULTS = {
  cost: "detour",
  order: "best",         // "best" = cheapest agreed pair first, "worst" = most expensive first
  rankBy: "per_point",   // "per_point" = cost / points adopted, "total" = raw cost
  useArcs: true,
  arcMax: 3,
  knn: 6,
  readopt: true,
  polishIters: null,     // iterations of the final search (2-opt + Or-opt with random kicks): null = 4 per point, 0 = off
  polishSeed: 1,
  batch: 1,
  forkRank: 0,
  forkStep: 0,
  requireShorter: true,
  maxChains: 400000,     // safety valve: arc enumeration grows fast with arcMax
};

/* ------------------------------------------------------------------ helpers */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function distanceMatrix(P, n) {
  const D = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = Math.hypot(P[2 * i] - P[2 * j], P[2 * i + 1] - P[2 * j + 1]);
      D[i * n + j] = d;
      D[j * n + i] = d;
    }
  }
  return D;
}

export function tourLength(D, n, tour) {
  let s = 0;
  for (let k = 0; k < tour.length; k++) s += D[tour[k] * n + tour[(k + 1) % tour.length]];
  return s;
}

export function edgeKey(a, b) { return a < b ? a * 65536 + b : b * 65536 + a; }

export function edgeSet(tour) {
  const s = new Set();
  for (let k = 0; k < tour.length; k++) s.add(edgeKey(tour[k], tour[(k + 1) % tour.length]));
  return s;
}

/** Convex hull (Andrew's monotone chain). Returns point indices, counter-clockwise, collinear points dropped. */
export function convexHull(P, n) {
  const idx = Array.from({ length: n }, (_, i) => i)
    .sort((a, b) => P[2 * a] - P[2 * b] || P[2 * a + 1] - P[2 * b + 1]);
  const cross = (o, a, b) =>
    (P[2 * a] - P[2 * o]) * (P[2 * b + 1] - P[2 * o + 1]) - (P[2 * a + 1] - P[2 * o + 1]) * (P[2 * b] - P[2 * o]);
  const lower = [];
  for (const i of idx) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], i) <= 0) lower.pop();
    lower.push(i);
  }
  const upper = [];
  for (let t = idx.length - 1; t >= 0; t--) {
    const i = idx[t];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], i) <= 0) upper.pop();
    upper.push(i);
  }
  lower.pop(); upper.pop();
  let hull = lower.concat(upper);
  if (hull.length < 3) {                       // all points collinear or duplicated: pick any triangle
    const pick = [idx[0], idx[n - 1], idx[n >> 1]];
    hull = [...new Set(pick)];
    for (let i = 0; hull.length < 3 && i < n; i++) if (!hull.includes(i)) hull.push(i);
  }
  return hull;
}

/* ------------------------------------------------------------------ instances */
export const INSTANCE_KINDS = {
  random: "Uniform random",
  clusters: "Clusters",
  ring: "Ring and core",
  grid: "Jittered grid",
  spiral: "Spiral",
  messy12: "Messy 12 (from the original script)",
};

const MESSY12 = [
  [11.4, 64.7], [51.7, 94.7], [26.3, 71.9], [35.0, 7.4], [96.9, 15.2], [11.2, 24.4],
  [10.5, 2.2], [35.9, 58.5], [53.9, 12.4], [39.6, 29.5], [47.5, 22.9], [40.7, 39.4],
];

export function makeInstance(kind, n, seed) {
  const rnd = mulberry32(seed * 7919 + 17);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
  const clamp = (v) => Math.min(100, Math.max(0, v));
  const pts = [];
  if (kind === "messy12") {
    for (const p of MESSY12) pts.push(p[0], p[1]);
  } else if (kind === "clusters") {
    const k = Math.max(2, Math.min(8, Math.round(Math.sqrt(n) / 1.6)));
    const centers = Array.from({ length: k }, () => [15 + rnd() * 70, 15 + rnd() * 70, 3 + rnd() * 7]);
    for (let i = 0; i < n; i++) {
      const c = centers[Math.floor(rnd() * k)];
      pts.push(clamp(c[0] + gauss() * c[2]), clamp(c[1] + gauss() * c[2]));
    }
  } else if (kind === "ring") {
    for (let i = 0; i < n; i++) {
      if (rnd() < 0.55) {
        const a = rnd() * 2 * Math.PI, r = 42 + gauss() * 2.5;
        pts.push(clamp(50 + r * Math.cos(a)), clamp(50 + r * Math.sin(a)));
      } else {
        pts.push(clamp(50 + gauss() * 11), clamp(50 + gauss() * 11));
      }
    }
  } else if (kind === "grid") {
    const side = Math.ceil(Math.sqrt(n)), step = 90 / Math.max(1, side - 1);
    const cells = [];
    for (let r = 0; r < side; r++) for (let c = 0; c < side; c++) cells.push([r, c]);
    for (let i = cells.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [cells[i], cells[j]] = [cells[j], cells[i]]; }
    for (let i = 0; i < n; i++) {
      const [r, c] = cells[i];
      pts.push(clamp(5 + c * step + (rnd() - 0.5) * step * 0.5), clamp(5 + r * step + (rnd() - 0.5) * step * 0.5));
    }
  } else if (kind === "spiral") {
    for (let i = 0; i < n; i++) {
      const t = (i + rnd() * 0.6) / n, a = t * 4.2 * Math.PI, r = 5 + t * 40;
      pts.push(clamp(50 + r * Math.cos(a) + gauss() * 0.8), clamp(50 + r * Math.sin(a) + gauss() * 0.8));
    }
  } else {
    for (let i = 0; i < n; i++) pts.push(rnd() * 100, rnd() * 100);
  }
  return Float64Array.from(pts.map((v) => Math.round(v * 10) / 10));
}

/* ------------------------------------------------------------------ the construction */
export function construct(P, n, userOpts = {}) {
  const t0 = (typeof performance !== "undefined" ? performance : Date).now();
  const o = { ...DEFAULTS, ...userOpts };
  const cost = (COSTS[o.cost] || COSTS.detour).fn;
  const perPoint = o.rankBy === "per_point";
  const batchSize = Math.max(1, o.batch | 0);
  const D = distanceMatrix(P, n);

  let tour = convexHull(P, n);
  const hull = tour.slice();
  const isHull = new Uint8Array(n);
  for (const v of hull) isHull[v] = 1;
  const adopted = new Uint8Array(n);
  for (const v of hull) adopted[v] = 1;
  let remaining = n - hull.length;
  const lastChange = new Int32Array(n).fill(-1);
  const arcMax = o.useArcs ? Math.max(1, o.arcMax | 0) : 1;

  /* ---- every arc that can be adopted: ordered chains of 1..arcMax unadopted, nearby points ---- */
  const interior = [];
  for (let i = 0; i < n; i++) if (!isHull[i]) interior.push(i);
  const knn = Math.min(o.knn, n - 1);
  const nn = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => j).filter((j) => j !== i)
      .sort((a, b) => D[i * n + a] - D[i * n + b] || a - b).slice(0, knn));
  const linked = Array.from({ length: n }, () => new Set());
  for (let i = 0; i < n; i++) for (const j of nn[i]) { linked[i].add(j); linked[j].add(i); }
  const adj = linked.map((s) => [...s].filter((j) => !isHull[j]).sort((a, b) => a - b));

  const levels = [{ L: 1, count: interior.length, data: Int32Array.from(interior) }];
  let totalChains = interior.length, cappedAt = 0;
  for (let L = 2; L <= arcMax && interior.length > 1; L++) {
    const prev = levels[levels.length - 1];
    let out = new Int32Array(1 << 16), cnt = 0, over = false;
    for (let ci = 0; ci < prev.count && !over; ci++) {
      const base = ci * prev.L, last = prev.data[base + prev.L - 1];
      for (const q of adj[last]) {
        let dup = false;
        for (let t = 0; t < prev.L; t++) if (prev.data[base + t] === q) { dup = true; break; }
        if (dup) continue;
        if ((cnt + 1) * L > out.length) { const bigger = new Int32Array(out.length * 2); bigger.set(out); out = bigger; }
        for (let t = 0; t < prev.L; t++) out[cnt * L + t] = prev.data[base + t];
        out[cnt * L + prev.L] = q;
        cnt++;
        if (totalChains + cnt > o.maxChains) { over = true; break; }
      }
    }
    if (over) { cappedAt = L; break; }
    if (cnt === 0) break;
    levels.push({ L, count: cnt, data: out.subarray(0, cnt * L) });
    totalChains += cnt;
  }
  const arcMaxUsed = levels[levels.length - 1].L;

  const C = totalChains;
  const chainStart = new Int32Array(C), chainLen = new Uint8Array(C);
  const chainPts = new Int32Array(levels.reduce((s, l) => s + l.count * l.L, 0));
  const first = new Int32Array(C), last = new Int32Array(C);
  const arcLen = new Float64Array(C), kPts = new Float64Array(C);
  {
    let ci = 0, off = 0;
    for (const lv of levels) {
      for (let c = 0; c < lv.count; c++, ci++) {
        chainStart[ci] = off; chainLen[ci] = lv.L;
        let len = 0;
        for (let t = 0; t < lv.L; t++) {
          chainPts[off + t] = lv.data[c * lv.L + t];
          if (t > 0) len += D[chainPts[off + t - 1] * n + chainPts[off + t]];
        }
        first[ci] = chainPts[off]; last[ci] = chainPts[off + lv.L - 1];
        arcLen[ci] = len; kPts[ci] = lv.L;
        off += lv.L;
      }
    }
  }
  const chainOf = (ci) => Array.from(chainPts.subarray(chainStart[ci], chainStart[ci] + chainLen[ci]));

  /* ---- incremental bookkeeping ----------------------------------------------------------------
     An adoption (or re-adoption) changes the cost matrix only locally: a few edges disappear, a few appear,
     and the candidates that touch an adopted point die. Every other entry keeps its value. So we remember
     each candidate's favourite edge (row) and each edge's favourite candidate (column) and repair only
     what changed, instead of recomputing candidates x edges from scratch every step. */
  const alive = new Uint8Array(C).fill(1);               // 1 while every point of the chain is unadopted
  const cop = (() => {                                   // chains containing each point, as a CSR index
    const start = new Int32Array(n + 1);
    for (let c = 0; c < C; c++) for (let q = 0; q < chainLen[c]; q++) start[chainPts[chainStart[c] + q] + 1]++;
    for (let i = 0; i < n; i++) start[i + 1] += start[i];
    const fillAt = start.slice(0, n), list = new Int32Array(start[n]);
    for (let c = 0; c < C; c++) for (let q = 0; q < chainLen[c]; q++) list[fillAt[chainPts[chainStart[c] + q]]++] = c;
    return { start, list };
  })();
  let aliveList = Int32Array.from({ length: C }, (_, i) => i);
  const rowEdge = new Int32Array(C).fill(-1), rowMet = new Float64Array(C).fill(Infinity);
  const eA = [], eB = [], eD = [], eLive = [], colChain = [], colMet = [], posOf = [];
  const edgeId = new Map();                              // ordered edge a->b  =>  edge id
  let slotId = [];                                       // slotId[e] = id of the edge at tour position e
  const metricOf = (ci, id) => {
    const k = kPts[ci], c = cost(D[eA[id] * n + first[ci]], arcLen[ci], D[last[ci] * n + eB[id]], eD[id], k);
    return perPoint ? c / k : c;
  };
  function computeColumn(id) {
    let best = Infinity, arg = -1;
    for (let t = 0; t < aliveList.length; t++) {
      const ci = aliveList[t], met = metricOf(ci, id);
      if (met < best) { best = met; arg = ci; }
    }
    colMet[id] = best; colChain[id] = arg;
  }
  /** Diff the tour's edges against the ones we know. Returns the ids of the edges that are new. */
  function syncEdges() {
    const m = tour.length, keys = new Array(m), cur = new Set();
    for (let e = 0; e < m; e++) { keys[e] = tour[e] * n + tour[(e + 1) % m]; cur.add(keys[e]); }
    for (const [key, id] of edgeId) if (!cur.has(key)) { eLive[id] = 0; edgeId.delete(key); }
    const added = [];
    slotId = new Array(m);
    for (let e = 0; e < m; e++) {
      let id = edgeId.get(keys[e]);
      if (id === undefined) {
        id = eA.length;
        eA.push(tour[e]); eB.push(tour[(e + 1) % m]); eD.push(D[tour[e] * n + tour[(e + 1) % m]]);
        eLive.push(1); colChain.push(-1); colMet.push(Infinity); posOf.push(0);
        edgeId.set(keys[e], id); added.push(id);
      }
      slotId[e] = id; posOf[id] = e;
    }
    return added;
  }

  /* ---- one adoption step: both forces must agree ---- */
  function adoptStep(stepI) {
    const added = syncEdges();
    const m = tour.length;
    { let w = 0; for (let t = 0; t < aliveList.length; t++) { const ci = aliveList[t]; if (alive[ci]) aliveList[w++] = ci; } aliveList = aliveList.subarray(0, w); }

    // outside-in: new edges pick a favourite; so do edges whose favourite candidate was just adopted away
    for (const id of added) computeColumn(id);
    for (let e = 0; e < m; e++) { const id = slotId[e]; if (colChain[id] < 0 || !alive[colChain[id]]) computeColumn(id); }
    // inside-out: a candidate only needs a full look if its favourite edge is gone; otherwise it just meets the new edges
    for (let t = 0; t < aliveList.length; t++) {
      const ci = aliveList[t];
      let re = rowEdge[ci], rm = rowMet[ci];
      if (re < 0 || !eLive[re]) {
        rm = Infinity; re = -1;
        for (let e = 0; e < m; e++) { const met = metricOf(ci, slotId[e]); if (met < rm) { rm = met; re = slotId[e]; } }
      } else {
        for (let q = 0; q < added.length; q++) {
          const id = added[q], met = metricOf(ci, id);
          if (met < rm || (met === rm && posOf[id] < posOf[re])) { rm = met; re = id; }
        }
      }
      rowEdge[ci] = re; rowMet[ci] = rm;
    }

    const agreedRaw = [];
    for (let e = 0; e < m; e++) {
      const id = slotId[e], ci = colChain[id];
      if (ci >= 0 && rowEdge[ci] === id) agreedRaw.push([ci, e, colMet[id]]);
    }
    if (!agreedRaw.length) throw new Error("no agreed pair -- is the cost function returning NaN?");
    const costOf = (ci, e) => cost(D[tour[e] * n + first[ci]], arcLen[ci], D[last[ci] * n + tour[(e + 1) % m]], eD[slotId[e]], kPts[ci]);
    // take the best agreed pair, then (batch > 1) further agreed pairs that cannot disturb it:
    // no shared points, and no candidate that would rather take one of the edges just created
    const ordered = agreedRaw.slice().sort((x, y) => (o.order === "best" ? x[2] - y[2] : y[2] - x[2]) || x[1] - y[1]);
    // a fork diverges once, at step forkStep: the best candidate goes into its forkRank-th cheapest edge instead
    if (o.forkRank > 0 && stepI === o.forkStep && m > 2) {
      const ci = ordered[0][0], byEdge = [];
      for (let e = 0; e < m; e++) byEdge.push([metricOf(ci, slotId[e]), e]);
      byEdge.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
      const r = byEdge[Math.min(o.forkRank, byEdge.length - 1)];
      ordered.splice(0, ordered.length, [ci, r[1], r[0]]);
    }
    const take = [ordered[0]];
    const usedPts = new Set(chainOf(ordered[0][0]));
    const newEdges = (ci, e) => {
      const ch = chainOf(ci), a = tour[e], c = tour[(e + 1) % m], out = [[a, ch[0]], [ch[ch.length - 1], c]];
      for (let q = 0; q + 1 < ch.length; q++) out.push([ch[q], ch[q + 1]]);
      return out;
    };
    const fresh = batchSize > 1 ? newEdges(ordered[0][0], ordered[0][1]) : [];
    for (let q = 1; q < ordered.length && take.length < batchSize; q++) {
      const [cj, ej, mj] = ordered[q];
      const chj = chainOf(cj);
      if (chj.some((p) => usedPts.has(p))) continue;
      const k = kPts[cj];
      let ok = true;
      for (const [u, v] of fresh) {
        const c = cost(D[u * n + first[cj]], arcLen[cj], D[last[cj] * n + v], D[u * n + v], k);
        if ((perPoint ? c / k : c) < mj) { ok = false; break; }
      }
      if (!ok) continue;
      take.push(ordered[q]);
      for (const p of chj) usedPts.add(p);
      for (const x of newEdges(cj, ej)) fresh.push(x);
    }
    take.sort((x, y) => y[1] - x[1]);              // splice from the back so earlier edge positions stay valid
    const agreedInfo = agreedRaw.map(([ci, ee, met]) => ({ chain: chainOf(ci), edge: ee, metric: met, cost: costOf(ci, ee) }));
    const evs = [];
    for (const [pci, e, met] of take) {
      const ch = chainOf(pci);
      const ev = { type: "adopt", step: stepI, chain: ch, edge: e, a: tour[e], c: tour[(e + 1) % tour.length], cost: costOf(pci, e), metric: met };
      if (!evs.length) ev.agreed = agreedInfo;
      tour = tour.slice(0, e + 1).concat(ch, tour.slice(e + 1));
      for (const p of ch) {
        adopted[p] = 1; lastChange[p] = stepI; remaining--;
        for (let q = cop.start[p]; q < cop.start[p + 1]; q++) alive[cop.list[q]] = 0;
      }
      ev.tourAfter = tour.slice();
      evs.push(ev);
    }
    return evs;
  }

  /* ---- re-adoption: lift an adopted point / arc out and re-adopt it into another edge ---- */
  function bestReadopt(stepI) {
    const m = tour.length;
    const movable = new Uint8Array(m);
    for (let i = 0; i < m; i++) movable[i] = !isHull[tour[i]] && lastChange[tour[i]] < stepI ? 1 : 0;
    let best = null;                                   // {gain, i, L, j, reverse}
    let bestGain = 0;
    const rest = new Int32Array(m);
    for (let i = 0; i < m; i++) {
      let length = 0;
      for (let L = 1; L <= arcMax; L++) {
        if (m - L < 3 || !movable[(i + L - 1) % m]) break;
        const a0 = tour[i], aL = tour[(i + L - 1) % m];
        if (L > 1) length += D[tour[(i + L - 2) % m] * n + aL];
        const u = tour[(i - 1 + m) % m], w = tour[(i + L) % m];
        const costHere = cost(D[u * n + a0], length, D[aL * n + w], D[u * n + w], L);
        const realHere = D[u * n + a0] + length + D[aL * n + w] - D[u * n + w];
        const rl = m - L;                              // the tour without the arc: w ... u
        for (let q = 0; q < rl; q++) rest[q] = tour[(i + L + q) % m];
        for (let rev = 0; rev < (L > 1 ? 2 : 1); rev++) {
          const f = rev ? aL : a0, l = rev ? a0 : aL;
          for (let j = 0; j < rl - 1; j++) {
            const ea = rest[j], eb = rest[j + 1];
            const dab = D[ea * n + eb];
            const nf = D[ea * n + f], nl = D[l * n + eb];
            if (o.requireShorter && !(realHere - (nf + length + nl - dab) > EPS)) continue;
            const gain = costHere - cost(nf, length, nl, dab, L);
            if (gain > EPS && gain > bestGain) { bestGain = gain; best = { gain, i, L, j, rev: !!rev }; }
          }
        }
      }
    }
    if (!best) return null;
    const { gain, i, L, j, rev } = best;
    const arc = [];
    for (let q = 0; q < L; q++) arc.push(tour[(i + q) % m]);
    const u = tour[(i - 1 + m) % m], w = tour[(i + L) % m];
    const restArr = [];
    for (let q = 0; q < m - L; q++) restArr.push(tour[(i + L + q) % m]);
    const placed = rev ? arc.slice().reverse() : arc;
    const before = tour;
    tour = restArr.slice(0, j + 1).concat(placed, restArr.slice(j + 1));
    for (const p of arc) lastChange[p] = stepI;
    return { type: "readopt", step: stepI, arc, placed, u, w, a: restArr[j], b: restArr[j + 1], net: gain, tourBefore: before, tourAfter: tour.slice() };
  }

  /* ---- run ---- */
  const events = [];
  let stepI = 0;
  while (stepI < 3 * n + 30) {
    const batch = [];
    if (remaining > 0) batch.push(...adoptStep(stepI));
    if (o.readopt) for (let mv; (mv = bestReadopt(stepI)); ) batch.push(mv);
    if (!batch.length) break;
    events.push(...batch);
    stepI++;
  }

  /* ---- finish: a short 2-opt + Or-opt search with random kicks; every improvement is its own step ---- */
  const polishIters = o.polishIters === null || o.polishIters === undefined ? polishBudget(n) : o.polishIters;
  if (polishIters > 0 && n >= 8) {
    const res = iteratedLocalSearch(D, n, tour, { maxIters: polishIters, seed: o.polishSeed, record: true });
    for (const ev of res.improvements) events.push({ ...ev, step: stepI++ });
    tour = res.tour;
  }
  const now = (typeof performance !== "undefined" ? performance : Date).now();
  return {
    events, hull, tour, n,
    length: tourLength(D, n, tour), hullLength: tourLength(D, n, hull),
    ms: now - t0, costUsed: o.cost, chains: C, arcMaxUsed, arcMaxAsked: arcMax, capped: cappedAt > 0,
    adoptions: events.filter((e) => e.type === "adopt").length,
    readoptions: events.filter((e) => e.type === "readopt").length,
    polishes: events.filter((e) => e.type === "polish").length,
  };
}

/* ------------------------------------------------------------------ final search
   Iterated local search on a finished tour: 2-opt and Or-opt with neighbour lists, then random segment-swap
   kicks; a kick is kept only if the tour ends up shorter. On a construction tour 2-opt and Or-opt alone find
   nothing (those tours are already locally optimal), so the kicks are what pay. With `record`, every accepted
   improvement is returned as a "polish" event listing the edges it removed and added. */
/** Default number of final-search iterations for n points. */
export const polishBudget = (n) => Math.min(2000, Math.max(200, 4 * n));

/** Append the winning final search (from a construct() run made with polishIters: 0) to that result. */
export function attachPolish(result, D, res) {
  let step = result.events.length ? result.events[result.events.length - 1].step + 1 : 0;
  for (const ev of res.improvements) result.events.push({ ...ev, step: step++ });
  result.tour = res.tour;
  result.length = tourLength(D, result.n, res.tour);
  result.polishes = res.improvements.length;
  return result;
}

export function iteratedLocalSearch(D, n, startTour, { budgetMs = Infinity, maxIters = Infinity, seed = 1, record = false } = {}) {
  const now = () => (typeof performance !== "undefined" ? performance : Date).now();
  const start = now();
  const rnd = mulberry32(seed);
  const K = Math.min(10, n - 1);
  const neigh = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => j).filter((j) => j !== i)
      .sort((a, b) => D[i * n + a] - D[i * n + b] || a - b).slice(0, K));
  let t = startTour.slice();
  const pos = new Int32Array(n);
  const setPos = () => { for (let i = 0; i < n; i++) pos[t[i]] = i; };
  setPos();
  const nxt = (v) => t[(pos[v] + 1) % n], prv = (v) => t[(pos[v] - 1 + n) % n];

  function reverse(i, j) {                           // reverse cyclic positions i..j inclusive
    let len = ((j - i + n) % n) + 1;
    if (len * 2 > n) { const ni = (j + 1) % n, nj = (i - 1 + n) % n; i = ni; j = nj; len = n - len; }
    for (let s = 0; s < len >> 1; s++) {
      const a = (i + s) % n, b = (j - s + n) % n;
      const va = t[a], vb = t[b]; t[a] = vb; t[b] = va; pos[vb] = a; pos[va] = b;
    }
  }

  function improveNode(a, push) {
    for (let dir = 0; dir < 2; dir++) {              // 2-opt
      const b = dir ? prv(a) : nxt(a), dab = D[a * n + b];
      for (const c of neigh[a]) {
        const dac = D[a * n + c];
        if (dac >= dab) break;
        const d = dir ? prv(c) : nxt(c);
        if (c === b || d === a) continue;
        if (dab + D[c * n + d] - dac - D[b * n + d] > EPS) {
          if (dir === 0) reverse(pos[b], pos[c]); else reverse(pos[a], pos[d]);
          push(a); push(b); push(c); push(d);
          return true;
        }
      }
    }
    for (let dir = 0; dir < 2; dir++) {              // Or-opt: segment of 1..3 starting at a
      let segEnd = a;
      for (let L = 1; L <= 3 && L < n - 3; L++) {
        if (L > 1) segEnd = dir ? prv(segEnd) : nxt(segEnd);
        const s1 = a, sL = segEnd;
        const p0 = dir ? nxt(s1) : prv(s1), n0 = dir ? prv(sL) : nxt(sL);
        if (p0 === sL || n0 === s1 || p0 === n0) break;
        const g = D[p0 * n + s1] + D[sL * n + n0] - D[p0 * n + n0];
        if (g <= EPS) continue;
        const seg = [s1];
        for (let q = 1, v = s1; q < L; q++) { v = dir ? prv(v) : nxt(v); seg.push(v); }
        const inSeg = (v) => seg.includes(v);
        for (const c of neigh[s1]) {
          if (inSeg(c)) continue;
          for (let side = 0; side < 2; side++) {
            const x = side ? c : prv(c), y = side ? nxt(c) : c;      // consecutive in tour order x -> y
            if (inSeg(x) || inSeg(y)) continue;
            const add1 = D[x * n + s1] + D[sL * n + y] - D[x * n + y];  // s1 next to x
            const add2 = D[x * n + sL] + D[s1 * n + y] - D[x * n + y];  // sL next to x
            const add = Math.min(add1, add2);
            if (g - add > EPS) {
              // rebuild: tour without segment, insert between x and y
              const order = dir ? seg.slice().reverse() : seg.slice();  // in tour order
              const firstTour = order[0], lastTour = order[order.length - 1];
              const without = t.filter((v) => !inSeg(v));
              const at = without.indexOf(x);
              // orientation: want s1 adjacent to x when add1 <= add2
              let ins;
              const s1First = firstTour === s1;
              if (add1 <= add2) ins = s1First ? order : order.slice().reverse();
              else ins = s1First ? order.slice().reverse() : order;
              void lastTour;
              t = without.slice(0, at + 1).concat(ins, without.slice(at + 1));
              setPos();
              push(p0); push(n0); push(x); push(y); push(s1); push(sL);
              return true;
            }
          }
        }
      }
    }
    return false;
  }

  function localSearch(queueInit) {
    const inQ = new Uint8Array(n), q = [];
    const push = (v) => { if (!inQ[v]) { inQ[v] = 1; q.push(v); } };
    for (const v of queueInit) push(v);
    while (q.length) {
      const a = q.pop(); inQ[a] = 0;
      while (improveNode(a, push)) { /* keep improving around a */ }
    }
  }

  const len = () => tourLength(D, n, t);
  const improvements = [];
  let best = t.slice(), bestLen = len(), bestSet = record ? edgeSet(best) : null;
  const keep = (tour, L) => {                          // a new best tour: remember it, and what changed
    if (record) {
      const set = edgeSet(tour), dec = (k) => [Math.floor(k / 65536), k % 65536];
      improvements.push({
        type: "polish", net: bestLen - L,
        removed: [...bestSet].filter((k) => !set.has(k)).map(dec), added: [...set].filter((k) => !bestSet.has(k)).map(dec),
        tourAfter: tour.slice(),
      });
      bestSet = set;
    }
    best = tour.slice(); bestLen = L;
  };
  localSearch(t.slice());
  { const L0 = len(); if (L0 < bestLen - 1e-9) keep(t, L0); }
  let iters = 0;
  while (iters < maxIters && now() - start < budgetMs && n >= 8) {
    iters++;
    const i = Math.floor(rnd() * n);
    const maxSeg = Math.max(1, Math.min(30, Math.floor((n - 2) / 2)));
    const l1 = 1 + Math.floor(rnd() * maxSeg), l2 = 1 + Math.floor(rnd() * maxSeg);
    const arr = [];
    for (let q = 0; q < n; q++) arr.push(t[(i + 1 + q) % n]);
    const touched = [t[i], arr[0], arr[l1 - 1], arr[l1], arr[l1 + l2 - 1], arr[(l1 + l2) % n]];
    t = arr.slice(l1, l1 + l2).concat(arr.slice(0, l1), arr.slice(l1 + l2));
    setPos();
    localSearch(touched);
    const L2 = len();
    if (L2 < bestLen - 1e-9) keep(t, L2);
    else { t = best.slice(); setPos(); }
  }
  return { tour: best, length: bestLen, iterations: iters, improvements, ms: now() - start };
}

/* The in-page reference. OR-Tools can't run in a browser, so the page compares against a stand-in:
   the same search, started from a nearest-neighbour tour and given a time budget instead of an iteration count. */
export function referenceSolve(P, n, budgetMs = 1500, seed = 1) {
  const now = () => (typeof performance !== "undefined" ? performance : Date).now();
  const start = now();
  const D = distanceMatrix(P, n);
  const t = [0], used = new Uint8Array(n); used[0] = 1;
  for (let k = 1; k < n; k++) {
    const c = t[k - 1]; let b = -1, bd = Infinity;
    for (let j = 0; j < n; j++) if (!used[j] && D[c * n + j] < bd) { bd = D[c * n + j]; b = j; }
    t.push(b); used[b] = 1;
  }
  const r = iteratedLocalSearch(D, n, t, { budgetMs: Math.max(0, budgetMs - (now() - start)), seed });
  return { tour: r.tour, length: r.length, iterations: r.iterations, ms: now() - start };
}
