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
  sqrt: {
    label: "Square-root detour",
    fn: (af, al, lb, ab) => Math.sqrt(Math.max(0, af + al + lb - ab)),
  },
  relative: {
    label: "Detour relative to the edge it breaks",
    fn: (af, al, lb, ab) => (af + al + lb - ab) / ab,
  },
  squared: {
    label: "Squared detour (punish big detours)",
    fn: (af, al, lb, ab) => { const d = af + al + lb - ab; return d * d; },
  },
  stretch: {
    label: "Stretch: detour over new path length",
    fn: (af, al, lb, ab) => (af + al + lb - ab) / (af + al + lb),
  },
  keepLong: {
    label: "Detour minus half the broken edge",
    fn: (af, al, lb, ab) => af + al + lb - 1.5 * ab,
  },
  nearEnds: {
    label: "Detour plus the closer end's distance",
    fn: (af, al, lb, ab) => af + al + lb - ab + 0.5 * Math.min(af, lb),
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

/* ------------------------------------------------------------------ the construction
   Split into a shared context (distances, candidate arcs), a cloneable state, and step helpers,
   so a run is just newState + repeated steps. */
function makeContext(P, n, userOpts) {
  const o = { ...DEFAULTS, ...userOpts };
  const cost = (COSTS[o.cost] || COSTS.detour).fn;
  const D = distanceMatrix(P, n);
  const hull = convexHull(P, n);
  const isHull = new Uint8Array(n);
  for (const v of hull) isHull[v] = 1;
  const arcMax = o.useArcs ? Math.max(1, o.arcMax | 0) : 1;

  // every arc that can be adopted: ordered chains of 1..arcMax unadopted, nearby points
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
      const base = ci * prev.L, lastPt = prev.data[base + prev.L - 1];
      for (const q of adj[lastPt]) {
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

  const C = totalChains;
  const chainStart = new Int32Array(C), chainLen = new Uint8Array(C);
  const chainPts = new Int32Array(levels.reduce((s, l) => s + l.count * l.L, 0));
  const first = new Int32Array(C), last = new Int32Array(C);
  const arcLen = new Float64Array(C), kPts = new Float64Array(C);
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
  return {
    P, n, o, cost, perPoint: o.rankBy === "per_point", D, hull, isHull, arcMax,
    C, chainStart, chainLen, chainPts, first, last, arcLen, kPts,
    arcMaxUsed: levels[levels.length - 1].L, capped: cappedAt > 0,
    rowEdge: new Int32Array(C),
    chainOf: (c) => Array.from(chainPts.subarray(chainStart[c], chainStart[c] + chainLen[c])),
  };
}

function newState(ctx) {
  const adopted = new Uint8Array(ctx.n);
  for (const v of ctx.hull) adopted[v] = 1;
  return {
    tour: ctx.hull.slice(), adopted, remaining: ctx.n - ctx.hull.length,
    lastChange: new Int32Array(ctx.n).fill(-1),
    alive: Int32Array.from({ length: ctx.C }, (_, i) => i),     // arcs whose points are all unadopted
  };
}

/** Both forces for every candidate and edge. Returns the pairs where they agree: [chainIndex, edgeIndex, metric]. */
function agreedPairs(ctx, st) {
  const { n, D, cost, perPoint, first, last, arcLen, kPts, rowEdge } = ctx;
  const tour = st.tour, m = tour.length, alive = st.alive;
  const colBest = new Float64Array(m).fill(Infinity), colArg = new Int32Array(m).fill(-1);
  const Dab = new Float64Array(m), T = Int32Array.from(tour), Bn = new Int32Array(m);
  for (let e = 0; e < m; e++) { Bn[e] = tour[(e + 1) % m]; Dab[e] = D[T[e] * n + Bn[e]]; }
  for (let t = 0; t < alive.length; t++) {
    const ci = alive[t], f = first[ci], l = last[ci], len = arcLen[ci], k = kPts[ci];
    let rb = Infinity, re = -1;
    for (let e = 0; e < m; e++) {
      const c = cost(D[T[e] * n + f], len, D[l * n + Bn[e]], Dab[e], k);
      const met = perPoint ? c / k : c;
      if (met < rb) { rb = met; re = e; }
      if (met < colBest[e]) { colBest[e] = met; colArg[e] = ci; }
    }
    rowEdge[ci] = re;
  }
  const pairs = [];
  for (let e = 0; e < m; e++) {
    const ci = colArg[e];
    if (ci >= 0 && rowEdge[ci] === e) pairs.push([ci, e, colBest[e]]);
  }
  if (!pairs.length) throw new Error("no agreed pair -- is the cost function returning NaN?");
  return { pairs, T, Bn, Dab };
}

function pickBest(pairs, order) {
  let pick = pairs[0];
  for (const x of pairs) if (order === "best" ? x[2] < pick[2] : x[2] > pick[2]) pick = x;
  return pick;
}

function describeAgreed(ctx, ag) {
  const { n, D, cost, first, last, arcLen, kPts } = ctx;
  return ag.pairs.map(([ci, e, met]) => ({
    chain: ctx.chainOf(ci), edge: e, metric: met,
    cost: cost(D[ag.T[e] * n + first[ci]], arcLen[ci], D[last[ci] * n + ag.Bn[e]], ag.Dab[e], kPts[ci]),
  }));
}

/** Splice chain ci into edge e. Mutates st; returns the adoption event (without tourAfter). */
function applyAdopt(ctx, st, ag, agreedDesc, pick, stepI) {
  const [ci, e, met] = pick;
  const { n, D, cost, first, last, arcLen, kPts } = ctx;
  const tour = st.tour, m = tour.length, ch = ctx.chainOf(ci);
  const ev = {
    type: "adopt", step: stepI, chain: ch, edge: e, a: tour[e], c: tour[(e + 1) % m],
    cost: cost(D[ag.T[e] * n + first[ci]], arcLen[ci], D[last[ci] * n + ag.Bn[e]], ag.Dab[e], kPts[ci]),
    metric: met, agreed: agreedDesc,
  };
  st.tour = tour.slice(0, e + 1).concat(ch, tour.slice(e + 1));
  for (const p of ch) { st.adopted[p] = 1; st.lastChange[p] = stepI; st.remaining--; }
  const keep = [];
  for (let t = 0; t < st.alive.length; t++) {
    const c = st.alive[t];
    let ok = true;
    for (let q = 0; q < ctx.chainLen[c]; q++) if (st.adopted[ctx.chainPts[ctx.chainStart[c] + q]]) { ok = false; break; }
    if (ok) keep.push(c);
  }
  st.alive = Int32Array.from(keep);
  ev.tourAfter = st.tour.slice();
  return ev;
}

/** The single best re-adoption move (lift a point/arc out, re-adopt it into another edge). Applies it to st. */
function bestReadopt(ctx, st, stepI) {
  const { n, D, cost, isHull, arcMax } = ctx, o = ctx.o;
  const tour = st.tour, m = tour.length, lastChange = st.lastChange;
  const movable = new Uint8Array(m);
  for (let i = 0; i < m; i++) movable[i] = !isHull[tour[i]] && lastChange[tour[i]] < stepI ? 1 : 0;
  let best = null, bestGain = 0;
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
      const rl = m - L;                                  // the tour without the arc: w ... u
      for (let q = 0; q < rl; q++) rest[q] = tour[(i + L + q) % m];
      for (let rev = 0; rev < (L > 1 ? 2 : 1); rev++) {
        const f = rev ? aL : a0, l = rev ? a0 : aL;
        for (let j = 0; j < rl - 1; j++) {
          const ea = rest[j], eb = rest[j + 1];
          const dab = D[ea * n + eb], nf = D[ea * n + f], nl = D[l * n + eb];
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
  st.tour = restArr.slice(0, j + 1).concat(placed, restArr.slice(j + 1));
  for (const p of arc) lastChange[p] = stepI;
  return { type: "readopt", step: stepI, arc, placed, u, w, a: restArr[j], b: restArr[j + 1], net: gain, tourBefore: tour, tourAfter: st.tour.slice() };
}

function readoptAll(ctx, st, stepI, batch) {
  if (ctx.o.readopt) for (let mv; (mv = bestReadopt(ctx, st, stepI)); ) batch.push(mv);
}

const clock = () => (typeof performance !== "undefined" ? performance : Date).now();

function finish(ctx, events, tour, t0, extra = {}) {
  const { n, D } = ctx;
  return {
    events, hull: ctx.hull, tour, n,
    length: tourLength(D, n, tour), hullLength: tourLength(D, n, ctx.hull),
    ms: clock() - t0, chains: ctx.C, arcMaxUsed: ctx.arcMaxUsed, arcMaxAsked: ctx.arcMax, capped: ctx.capped,
    adoptions: events.filter((e) => e.type === "adopt").length,
    readoptions: events.filter((e) => e.type === "readopt").length,
    ...extra,
  };
}

/** Greedy construction: always take the cheapest agreed pair. */
export function construct(P, n, userOpts = {}) {
  const t0 = clock();
  const ctx = makeContext(P, n, userOpts);
  const st = newState(ctx);
  const events = [];
  let stepI = 0;
  while (stepI < 3 * n + 30) {
    const batch = [];
    if (st.remaining > 0) {
      const ag = agreedPairs(ctx, st);
      const pick = pickBest(ag.pairs, ctx.o.order);
      batch.push(applyAdopt(ctx, st, ag, describeAgreed(ctx, ag), pick, stepI));
    }
    readoptAll(ctx, st, stepI, batch);
    if (!batch.length) break;
    events.push(...batch);
    stepI++;
  }
  return finish(ctx, events, st.tour, t0);
}

/* ------------------------------------------------------------------ browser reference solver
   OR-Tools can't run in a browser, so the page compares against a strong, honest stand-in:
   iterated local search (2-opt + Or-opt with neighbour lists, double-bridge kicks). */
export function referenceSolve(P, n, budgetMs = 1500, seed = 1) {
  const D = distanceMatrix(P, n);
  const rnd = mulberry32(seed);
  const K = Math.min(10, n - 1);
  const neigh = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => j).filter((j) => j !== i)
      .sort((a, b) => D[i * n + a] - D[i * n + b]).slice(0, K));
  const now = () => (typeof performance !== "undefined" ? performance : Date).now();
  const start = now();

  // nearest-neighbour start
  let t = [0];
  const used = new Uint8Array(n); used[0] = 1;
  for (let k = 1; k < n; k++) {
    const c = t[k - 1]; let b = -1, bd = Infinity;
    for (let j = 0; j < n; j++) if (!used[j] && D[c * n + j] < bd) { bd = D[c * n + j]; b = j; }
    t.push(b); used[b] = 1;
  }
  let pos = new Int32Array(n);
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
  localSearch(t.slice());
  let best = t.slice(), bestLen = len(), iters = 0;
  while (now() - start < budgetMs && n >= 8) {
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
    if (L2 < bestLen - 1e-9) { bestLen = L2; best = t.slice(); }
    else { t = best.slice(); setPos(); }
  }
  return { tour: best, length: bestLen, iterations: iters, ms: now() - start };
}
