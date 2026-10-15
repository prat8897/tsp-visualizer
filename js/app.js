import {
  makeInstance, INSTANCE_KINDS, COSTS, DEFAULTS, edgeKey, edgeSet, distanceMatrix, tourLength, construct, referenceSolve,
} from "./solver.js";
import { Renderer, hex } from "./gl.js";

/* ============================================================================ constants */
const COL = {
  ink: hex("#131b36"), inkSoft: hex("#131b36", 0.55), grid: hex("#131b36", 0.055), gridStrong: hex("#131b36", 0.1),
  cobalt: hex("#2340ff"), amber: hex("#f59e0b"), glow: hex("#ffb020", 0.5), orchid: hex("#b83fd1"),
  jade: hex("#0e9f72"), red: hex("#ec3d2a"), white: hex("#ffffff"), purple: hex("#7c3aed"),
  refUnder: hex("#ffc46b", 0.6), gold: hex("#ffc21a"),
};
const MIN_POINTS = 4, MAX_POINTS = 250;

const $ = (id) => document.getElementById(id);
const el = {
  plot: $("plot"), gl: $("gl"), labels: $("labels"), caption: $("caption"), nogl: $("nogl"),
  play: $("play"), back: $("back"), fwd: $("fwd"), replay: $("replay"), instant: $("instant"),
  scrub: $("scrub"), speed: $("speed"), speedLabel: $("speedLabel"),
  kind: $("kind"), n: $("n"), nLabel: $("nLabel"), seed: $("seed"), shuffle: $("shuffle"), clear: $("clear"),
  edit: $("edit"),
  cost: $("cost"), arc: $("arc"), arcLabel: $("arcLabel"), readopt: $("readopt"), polish: $("polish"), order: $("order"), rank: $("rank"),
  knn: $("knn"), knnLabel: $("knnLabel"),
  forces: $("forces"), numbers: $("numbers"), compare: $("compare"), showRef: $("showRef"),
  sLen: $("sLen"), sStep: $("sStep"), sHull: $("sHull"), sBuilt: $("sBuilt"), sRef: $("sRef"), sGap: $("sGap"), sShared: $("sShared"),
  sMoves: $("sMoves"), warn: $("warn"),
};

/* ============================================================================ state */
const fine = matchMedia("(pointer: fine)").matches;
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

function autoArc(n) { return n <= 40 ? 5 : n <= 150 ? 4 : 3; }

const S = {
  kind: "random", n: 40, seed: 7, P: null,
  opts: { ...DEFAULTS, arcMax: autoArc(40) },
  result: null, ref: null, refEdges: null,
  t: 0, playing: true, rate: 4,
  showForces: true, showNumbers: true, compare: true, showRef: false,
  editMode: fine ? "add" : "off", drag: -1, solving: false,
  view: { scale: 1, ox: 0, oy: 0, w: 1, h: 1 },
  hullSet: null,
};
let token = 0;

/* ============================================================================ solver plumbing */
class Engine {
  constructor() {
    this.worker = null; this.refWorker = null; this.busy = false; this.pending = null; this.id = 0;
    this._makeWorker();
  }
  _makeWorker() {
    try {
      this.worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
      this.worker.onerror = () => { this.worker = null; if (this.current) this._run(this.current, true); };
    } catch { this.worker = null; }
  }
  solve(P, n, opts) {
    return new Promise((resolve) => {
      const job = { id: ++this.id, P, n, opts, resolve };
      if (this.busy) { if (this.pending) this.pending.resolve(null); this.pending = job; } else this._run(job);
    });
  }
  _run(job, retry = false) {
    this.busy = true; this.current = job;
    const done = (res) => {
      this.busy = false; this.current = null; job.resolve(res);
      const p = this.pending; this.pending = null; if (p) this._run(p);
    };
    if (this.worker) {
      this.worker.onmessage = (e) => {
        if (e.data.type === "built") done(e.data.result);
        else if (e.data.type === "error") { console.error(e.data.message); done(null); }
      };
      this.worker.postMessage({ type: "construct", id: job.id, points: job.P, n: job.n, opts: job.opts });
    } else {
      setTimeout(() => {
        try { done(construct(job.P, job.n, job.opts)); } catch (err) { console.error(err); done(null); }
      }, 0);
    }
  }
  reference(P, n, budgetMs) {
    if (this.refWorker) { this.refWorker.terminate(); this.refWorker = null; }
    return new Promise((resolve) => {
      try {
        const w = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
        this.refWorker = w;
        w.onmessage = (e) => { if (e.data.type === "reference") { resolve(e.data.result); w.terminate(); if (this.refWorker === w) this.refWorker = null; } };
        w.onerror = () => { setTimeout(() => resolve(referenceSolve(P, n, budgetMs, 1)), 0); };
        w.postMessage({ type: "reference", id: 0, points: P, n, budgetMs, seed: 1 });
      } catch {
        setTimeout(() => resolve(referenceSolve(P, n, budgetMs, 1)), 0);
      }
    });
  }
}
const engine = new Engine();

async function solve({ animate }) {
  const my = ++token;
  S.live = false;
  const n = S.P.length / 2;
  S.ref = null; S.refEdges = null;
  if (n < MIN_POINTS) { S.result = null; S.solving = false; updateAll(); return; }
  S.solving = true; updateAll();
  const result = await engine.solve(S.P, n, { ...S.opts });
  if (my !== token || !result) return;
  S.result = result; S.solving = false;
  S.hullSet = new Set(result.hull);
  const E = result.events.length;
  el.scrub.max = String(E * 2);
  if (animate && !reduceMotion) {
    S.t = 0; S.playing = true;
    S.showForces = el.forces.checked = result.adoptions <= 30;
    S.rate = Math.min(40, Math.max(1.2, E / 10));
    el.speed.value = String(rateToSlider(S.rate));
  } else {
    S.t = E; S.playing = false;
  }
  updateAll();
  if (!S.live) requestReference(my, n);
}

function requestReference(my, n) {
  const P = S.P;
  engine.reference(P, n, Math.min(3000, 900 + n * 10)).then((ref) => {
    if (my !== token || !ref) return;
    S.ref = ref; S.refEdges = edgeSet(ref.tour);
    updateAll();
  });
}

let liveTimer = 0;
function solveLive() {            // while dragging a point: show the finished tour at once
  S.live = true;
  const my = ++token;
  const n = S.P.length / 2;
  if (n < MIN_POINTS) return;
  engine.solve(S.P, n, { ...S.opts }).then((result) => {
    if (my !== token || !result) return;
    S.result = result; S.hullSet = new Set(result.hull);
    S.t = result.events.length; S.playing = false; S.ref = null; S.refEdges = null;
    el.scrub.max = String(result.events.length * 2);
    updateAll();
  });
}

/* ============================================================================ instance & controls */
function newInstance(kind = S.kind, n = S.n, seed = S.seed) {
  S.kind = kind;
  S.n = kind === "messy12" ? 12 : n;
  S.seed = seed;
  S.P = makeInstance(kind, S.n, seed);
  if (!S.arcTouched) S.opts.arcMax = autoArc(S.n);
  syncControls();
  solve({ animate: true });
  writeHash();
}

function syncControls() {
  const n = S.P.length / 2;
  el.kind.value = INSTANCE_KINDS[S.kind] ? S.kind : "custom";
  el.n.value = String(Math.min(MAX_POINTS, n)); el.n.disabled = S.kind === "messy12";
  el.nLabel.textContent = String(n);
  el.seed.value = String(S.seed);
  el.cost.value = S.opts.cost; el.arc.value = String(S.opts.arcMax); el.arcLabel.textContent = String(S.opts.arcMax);
  el.readopt.checked = S.opts.readopt; el.polish.checked = S.opts.polishIters !== 0; el.order.value = S.opts.order; el.rank.value = S.opts.rankBy;
  el.knn.value = String(S.opts.knn); el.knnLabel.textContent = String(S.opts.knn);
  el.numbers.checked = S.showNumbers; el.compare.checked = S.compare; el.showRef.checked = S.showRef;
  for (const b of document.querySelectorAll("[data-edit]")) b.setAttribute("aria-pressed", String(b.dataset.edit === S.editMode));
  el.plot.dataset.edit = S.editMode;
}

function writeHash() {
  if (S.kind === "custom") { history.replaceState(null, "", location.pathname + location.search); return; }
  const h = new URLSearchParams({ kind: S.kind, n: String(S.n), seed: String(S.seed), arc: String(S.opts.arcMax), cost: S.opts.cost });
  history.replaceState(null, "", "#" + h.toString());
}

function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  if (INSTANCE_KINDS[h.get("kind")]) S.kind = h.get("kind");
  const n = parseInt(h.get("n")); if (n >= MIN_POINTS && n <= MAX_POINTS) S.n = n; else S.n = 40;
  const seed = parseInt(h.get("seed")); if (Number.isFinite(seed)) S.seed = seed;
  const arc = parseInt(h.get("arc"));
  S.arcTouched = arc >= 1 && arc <= 8;
  S.opts.arcMax = S.arcTouched ? arc : autoArc(S.n);
  if (COSTS[h.get("cost")]) S.opts.cost = h.get("cost");
}

function bindControls() {
  let t1 = 0;
  const later = (fn) => { clearTimeout(t1); t1 = setTimeout(fn, 140); };
  el.kind.innerHTML = Object.entries(INSTANCE_KINDS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("") +
    `<option value="custom" hidden>Your own points</option>`;
  el.cost.innerHTML = Object.entries(COSTS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join("");

  el.kind.onchange = () => { const k = el.kind.value; newInstance(k, k === "messy12" ? 12 : S.n, S.seed); };
  el.n.oninput = () => { el.nLabel.textContent = el.n.value; later(() => newInstance(S.kind === "custom" ? "random" : S.kind, +el.n.value, S.seed)); };
  el.seed.onchange = () => newInstance(S.kind === "custom" ? "random" : S.kind, S.n, parseInt(el.seed.value) || 0);
  el.shuffle.onclick = () => newInstance(S.kind === "custom" || S.kind === "messy12" ? "random" : S.kind, S.n, Math.floor(Math.random() * 9000) + 1);
  el.clear.onclick = () => { S.kind = "custom"; S.P = new Float64Array(0); S.result = null; S.ref = null; token++; syncControls(); updateAll(); if (S.editMode === "off") { S.editMode = "add"; syncControls(); } writeHash(); };

  for (const b of document.querySelectorAll("[data-edit]")) b.onclick = () => { S.editMode = b.dataset.edit; syncControls(); };

  const opt = () => { syncControls(); solve({ animate: true }); writeHash(); };
  el.cost.onchange = () => { S.opts.cost = el.cost.value; opt(); };
  el.arc.oninput = () => { S.arcTouched = true; el.arcLabel.textContent = el.arc.value; later(() => { S.opts.arcMax = +el.arc.value; opt(); }); };
  el.knn.oninput = () => { el.knnLabel.textContent = el.knn.value; later(() => { S.opts.knn = +el.knn.value; opt(); }); };
  el.readopt.onchange = () => { S.opts.readopt = el.readopt.checked; opt(); };
  el.polish.onchange = () => { S.opts.polishIters = el.polish.checked ? null : 0; opt(); };
  el.order.onchange = () => { S.opts.order = el.order.value; opt(); };
  el.rank.onchange = () => { S.opts.rankBy = el.rank.value; opt(); };

  el.forces.onchange = () => { S.showForces = el.forces.checked; };
  el.numbers.onchange = () => { S.showNumbers = el.numbers.checked; };
  el.compare.onchange = () => { S.compare = el.compare.checked; };
  el.showRef.onchange = () => { S.showRef = el.showRef.checked; };

  el.play.onclick = () => togglePlay();
  el.replay.onclick = () => { if (!S.result) return; S.t = 0; S.playing = true; };
  el.instant.onclick = () => { if (!S.result) return; S.t = S.result.events.length; S.playing = false; };
  el.back.onclick = () => { stepBy(-1); };
  el.fwd.onclick = () => { stepBy(1); };
  el.scrub.oninput = () => { S.t = +el.scrub.value / 2; S.playing = false; };
  el.speed.oninput = () => { S.rate = sliderToRate(+el.speed.value); };

  addEventListener("keydown", (e) => {
    if (e.target.matches("input, select, textarea")) return;
    if (e.key === " ") { e.preventDefault(); togglePlay(); }
    else if (e.key === "ArrowRight") { stepBy(1); }
    else if (e.key === "ArrowLeft") { stepBy(-1); }
    else if (e.key.toLowerCase() === "r") { el.replay.onclick(); }
    else if ((e.key === "Backspace" || e.key === "Delete") && S.editMode !== "off" && S.P.length) {
      S.kind = "custom"; S.P = S.P.slice(0, S.P.length - 2); afterEdit();
    }
  });

  for (const a of document.querySelectorAll("[data-preset]")) a.onclick = (e) => {
    e.preventDefault();
    const p = JSON.parse(a.dataset.preset);
    if (p.cost) S.opts.cost = p.cost;
    if (p.arc) { S.opts.arcMax = p.arc; S.arcTouched = true; }
    if (p.readopt !== undefined) S.opts.readopt = p.readopt;
    newInstance(p.kind || S.kind, p.n || S.n, p.seed ?? S.seed);
    document.getElementById("top").scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth" });
  };
}

const sliderToRate = (v) => 0.5 * Math.pow(2, (v / 100) * 9);
const rateToSlider = (r) => Math.round((Math.log2(r / 0.5) / 9) * 100);

function togglePlay() {
  if (!S.result) return;
  const E = S.result.events.length;
  if (S.t >= E) S.t = 0;
  S.playing = !S.playing;
}
function stepBy(dir) {
  if (!S.result) return;
  const E = S.result.events.length, u = S.showForces ? 0.5 : 1;
  S.playing = false;
  S.t = Math.min(E, Math.max(0, (Math.floor(S.t / u + 1e-9) + dir) * u));
}

/* ============================================================================ pointer editing */
function toWorld(sx, sy) { const v = S.view; return [(sx - v.ox) / v.scale, (v.oy - sy) / v.scale]; }
function toScreen(x, y) { const v = S.view; return [v.ox + x * v.scale, v.oy - y * v.scale]; }
function hitPoint(sx, sy) {
  let best = -1, bd = 14 * 14;
  for (let i = 0; i < S.P.length / 2; i++) {
    const [x, y] = toScreen(S.P[2 * i], S.P[2 * i + 1]);
    const d = (x - sx) ** 2 + (y - sy) ** 2;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}
function afterEdit() {
  S.kind = "custom"; S.n = S.P.length / 2;
  syncControls(); S.live = true; token++;
  S.ref = null; S.refEdges = null;
  const n = S.P.length / 2;
  if (n < MIN_POINTS) { S.result = null; S.ref = null; updateAll(); return; }
  solveLive();
  clearTimeout(liveTimer);
  liveTimer = setTimeout(() => { S.live = false; const my = token; requestReference(my, S.P.length / 2); }, 450);
  writeHash();
}
function bindPointer() {
  const c = el.gl;
  const local = (e) => { const r = c.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  c.addEventListener("contextmenu", (e) => { if (S.editMode !== "off") e.preventDefault(); });
  c.addEventListener("pointerdown", (e) => {
    if (S.editMode === "off") return;
    const [sx, sy] = local(e), hit = hitPoint(sx, sy);
    const remove = S.editMode === "remove" || e.button === 2 || e.shiftKey || e.altKey;
    if (remove) {
      if (hit >= 0) {
        const n = S.P.length / 2, Q = new Float64Array((n - 1) * 2);
        for (let i = 0, j = 0; i < n; i++) if (i !== hit) { Q[j++] = S.P[2 * i]; Q[j++] = S.P[2 * i + 1]; }
        S.P = Q; afterEdit();
      }
      return;
    }
    if (hit >= 0) { S.drag = hit; c.setPointerCapture(e.pointerId); e.preventDefault(); return; }
    const [wx, wy] = toWorld(sx, sy);
    if (S.P.length / 2 >= MAX_POINTS) return;
    const Q = new Float64Array(S.P.length + 2); Q.set(S.P);
    Q[S.P.length] = Math.round(Math.min(100, Math.max(0, wx)) * 10) / 10;
    Q[S.P.length + 1] = Math.round(Math.min(100, Math.max(0, wy)) * 10) / 10;
    S.P = Q; afterEdit();
  });
  c.addEventListener("pointermove", (e) => {
    if (S.drag < 0) return;
    const [sx, sy] = local(e), [wx, wy] = toWorld(sx, sy);
    S.P = S.P.slice();
    S.P[2 * S.drag] = Math.round(Math.min(100, Math.max(0, wx)) * 10) / 10;
    S.P[2 * S.drag + 1] = Math.round(Math.min(100, Math.max(0, wy)) * 10) / 10;
    afterEdit();
  });
  const up = () => { S.drag = -1; };
  c.addEventListener("pointerup", up); c.addEventListener("pointercancel", up);
}

/* ============================================================================ frame state */
function frame() {
  const R = S.result;
  if (!R) return { kind: "empty" };
  const E = R.events.length, t = S.t;
  if (t <= 0) return { kind: "start" };
  if (t >= E) return { kind: "final" };
  const k = Math.floor(t), f = t - k, ev = R.events[k];
  if (ev.type === "adopt") return { kind: S.showForces && f < 0.5 ? "select" : "adopt", ev, k };
  if (ev.type === "polish") return { kind: "polish", ev, k };
  return { kind: "readopt", ev, k };
}
const tourBefore = (R, k) => (k === 0 ? R.hull : R.events[k - 1].tourAfter);
const label = (ch) => (ch.length === 1 ? `point ${ch[0]}` : `arc ${ch.join("-")}`);

/* ============================================================================ drawing */
let renderer = null, ctx2d = null;

function resize() {
  const r = el.plot.getBoundingClientRect();
  const w = Math.max(200, r.width), h = Math.max(200, r.height), dpr = Math.min(2, devicePixelRatio || 1);
  renderer.resize(w, h, dpr);
  el.labels.width = Math.round(w * dpr); el.labels.height = Math.round(h * dpr);
  el.labels.style.width = w + "px"; el.labels.style.height = h + "px";
  ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
  const narrow = w < 640;
  const pad = { l: 26, r: 26, t: narrow ? 118 : 104, b: narrow ? 92 : 84 };
  const scale = Math.min(w - pad.l - pad.r, h - pad.t - pad.b) / 112;
  S.view = { w, h, scale, ox: pad.l + (w - pad.l - pad.r) / 2 - 50 * scale, oy: pad.t + (h - pad.t - pad.b) / 2 + 50 * scale };
}

function draw() {
  const R = S.result, n = S.P.length / 2, F = frame();
  const rd = renderer, v = S.view;
  rd.bg = [0.985, 0.988, 0.996];
  rd.begin();

  // drafting-sheet grid
  for (let g = 0; g <= 100; g += 10) {
    const strong = g % 50 === 0, c = strong ? COL.gridStrong : COL.grid;
    const [x0, y0] = toScreen(g, 0), [, y1] = toScreen(g, 100), [x1] = toScreen(100, 0), [xa, ya] = toScreen(0, g);
    rd.seg(x0, y0, x0, y1, 1, c);
    rd.seg(xa, ya, x1, ya, 1, c);
  }

  const dense = n > 150 ? 0.55 : n > 80 ? 0.7 : n > 40 ? 0.85 : 1;
  const sz = n <= 15 ? 12 : n <= 40 ? 10 : n <= 100 ? 8 : n <= 160 ? 6.5 : 5;
  const goodW = 3.4 * dense, plainW = 2.5 * dense;
  const P = S.P, pt = (i) => toScreen(P[2 * i], P[2 * i + 1]);
  const seg = (u, w, width, c, on = 0, off = 0, ext = 0) => { const a = pt(u), b = pt(w); rd.seg(a[0], a[1], b[0], b[1], width, c, on, off, ext); };

  const drawTour = (tour, glow) => {
    const m = tour.length;
    if (glow) for (const [u, w] of glow) seg(u, w, 9 * dense + 3, COL.glow, 0, 0, 5 * dense);
    const cmp = S.compare && S.refEdges && (F.kind === "final" || F.kind === "adopt" || F.kind === "readopt" || F.kind === "polish" || F.kind === "start");
    for (let k = 0; k < m; k++) {
      const u = tour[k], w = tour[(k + 1) % m];
      const good = cmp && S.refEdges.has(edgeKey(u, w));
      seg(u, w, good ? goodW : plainW, good ? COL.jade : COL.ink);
    }
  };
  const drawPoints = (adoptedTour, fresh, freshColor) => {
    const done = new Uint8Array(n);
    for (const i of adoptedTour) done[i] = 1;
    const isNew = new Uint8Array(n);
    if (fresh) for (const i of fresh) isNew[i] = 1;
    for (let i = 0; i < n; i++) {
      if (isNew[i]) continue;
      const [x, y] = pt(i);
      if (done[i]) rd.dot(x, y, sz, COL.ink, COL.ink, 1);
      else rd.dot(x, y, sz, COL.white, COL.ink, 1.6 * dense + 0.2);
    }
    if (fresh) for (const i of fresh) { const [x, y] = pt(i); rd.dot(x, y, sz * 1.75, freshColor, COL.ink, 1.8 * dense + 0.2); }
  };

  if (!R) {
    for (let i = 0; i < n; i++) { const [x, y] = pt(i); rd.dot(x, y, sz, COL.white, COL.ink, 1.8); }
  } else {
    if (S.showRef && S.ref && F.kind === "final") {
      const T = S.ref.tour;
      for (let k = 0; k < T.length; k++) seg(T[k], T[(k + 1) % T.length], 10 * dense, COL.refUnder, 0, 0, 3);
    }
    if (F.kind === "start") {
      drawTour(R.hull, null); drawPoints(R.hull);
    } else if (F.kind === "final") {
      drawTour(R.tour, null); drawPoints(R.tour);
    } else if (F.kind === "select") {
      const ev = F.ev, before = tourBefore(R, F.k), m = before.length;
      drawTour(before, null); drawPoints(before);
      for (const ag of ev.agreed) {
        const a = before[ag.edge], c = before[(ag.edge + 1) % m];
        let cx = 0, cy = 0;
        for (const p of ag.chain) { const q = pt(p); cx += q[0]; cy += q[1]; }
        cx /= ag.chain.length; cy /= ag.chain.length;
        const pa = pt(a), pc = pt(c), mx = (pa[0] + pc[0]) / 2, my = (pa[1] + pc[1]) / 2;
        const chosen = ag.edge === ev.edge && ag.chain.join() === ev.chain.join();
        const w = chosen ? 3 : 1.7, midx = (cx + mx) / 2, midy = (cy + my) / 2;
        rd.arrow(cx, cy, midx, midy, w, COL.cobalt, chosen ? 12 : 9);
        rd.arrow(mx, my, midx, midy, w, COL.amber, chosen ? 12 : 9);
        for (let q = 0; q + 1 < ag.chain.length; q++) seg(ag.chain[q], ag.chain[q + 1], 1.6, [COL.cobalt[0], COL.cobalt[1], COL.cobalt[2], 0.7]);
      }
      seg(ev.a, ev.c, 3, COL.red, 6, 5);
      const path = [ev.a, ...ev.chain, ev.c];
      for (let q = 0; q + 1 < path.length; q++) seg(path[q], path[q + 1], 3, COL.red, 7, 4);
      // redraw candidate points over the arrows
      for (const p of ev.chain) { const [x, y] = pt(p); rd.dot(x, y, sz * 1.5, COL.gold, COL.ink, 1.8); }
    } else if (F.kind === "adopt") {
      const ev = F.ev, glow = [];
      const path = [ev.a, ...ev.chain, ev.c];
      for (let q = 0; q + 1 < path.length; q++) glow.push([path[q], path[q + 1]]);
      drawTour(ev.tourAfter, glow); drawPoints(ev.tourAfter, ev.chain, COL.gold);
    } else if (F.kind === "readopt") {
      const ev = F.ev;
      seg(ev.u, ev.arc[0], 2.4, COL.purple, 5, 4); seg(ev.arc[ev.arc.length - 1], ev.w, 2.4, COL.purple, 5, 4);
      const glow = [[ev.a, ev.placed[0]], [ev.placed[ev.placed.length - 1], ev.b], [ev.u, ev.w]];
      drawTour(ev.tourAfter, glow); drawPoints(ev.tourAfter, ev.arc, COL.orchid);
    } else if (F.kind === "polish") {
      const ev = F.ev;
      for (const [u, w] of ev.removed) seg(u, w, 2.4, COL.purple, 5, 4);
      drawTour(ev.tourAfter, ev.added);
      drawPoints(ev.tourAfter, [...new Set([...ev.removed, ...ev.added].flat())], COL.orchid);
    }
  }
  rd.end();

  // point numbers on the 2D overlay
  ctx2d.clearRect(0, 0, v.w, v.h);
  if (S.showNumbers && n <= 60) {
    ctx2d.font = `700 ${n <= 25 ? 12 : 10}px "Bricolage Grotesque", system-ui, sans-serif`;
    ctx2d.fillStyle = "#131b36"; ctx2d.textBaseline = "alphabetic";
    ctx2d.lineWidth = 3; ctx2d.strokeStyle = "rgba(251,252,254,0.9)";
    for (let i = 0; i < n; i++) {
      const [x, y] = pt(i), s = String(i);
      ctx2d.strokeText(s, x + sz * 0.7 + 1, y - sz * 0.7); ctx2d.fillText(s, x + sz * 0.7 + 1, y - sz * 0.7);
    }
  }
}

/* ============================================================================ text */
const f1 = (x) => x.toFixed(1);
let lastCaption = "";
function setText(node, s) { if (node.textContent !== s) node.textContent = s; }

function updateText() {
  const R = S.result, n = S.P.length / 2, F = frame();
  let cap;
  if (n < MIN_POINTS) cap = n === 0 ? "Click the sheet to place points. You need at least 4." : `Add ${MIN_POINTS - n} more point${MIN_POINTS - n > 1 ? "s" : ""} to solve.`;
  else if (!R) cap = "Solving...";
  else if (F.kind === "start") cap = `Start: the convex hull, length ${f1(R.hullLength)}. ${n - R.hull.length} points still to adopt.`;
  else if (F.kind === "select") {
    const ev = F.ev;
    cap = `Step ${ev.step + 1}: ${ev.agreed.length} agreed pair${ev.agreed.length > 1 ? "s" : ""}. The cheapest sends ${label(ev.chain)} into edge ${ev.a}-${ev.c}, adding ${f1(ev.cost)}.`;
  } else if (F.kind === "adopt") {
    const ev = F.ev, left = n - ev.tourAfter.length;
    cap = `Step ${ev.step + 1}: adopted ${label(ev.chain)} into edge ${ev.a}-${ev.c}. ${left} left, tour so far ${f1(len(ev.tourAfter))}.`;
  } else if (F.kind === "readopt") {
    const ev = F.ev;
    cap = `Step ${ev.step + 1}: re-adopted ${label(ev.arc)}, lifted from between ${ev.u} and ${ev.w} into edge ${ev.a}-${ev.b}, saving ${ev.net.toFixed(2)}.`;
  } else if (F.kind === "polish") {
    const ev = F.ev;
    cap = `Step ${ev.step + 1}: final search swapped ${ev.removed.length} edges for ${ev.added.length} and saved ${ev.net.toFixed(2)}. Tour now ${f1(len(ev.tourAfter))}.`;
  } else {
    cap = `Done: length ${f1(R.length)} after ${R.adoptions} adoptions, ${R.readoptions} re-adoptions and ${R.polishes} final-search improvements.`;
  }
  if (S.solving && R) cap = "Solving...";
  if (cap !== lastCaption) { el.caption.textContent = cap; lastCaption = cap; }

  if (R) {
    const E = R.events.length;
    let cur = R.hullLength;
    if (F.kind === "final") cur = R.length; else if (F.kind === "adopt" || F.kind === "select") cur = len(F.kind === "select" ? tourBefore(R, F.k) : F.ev.tourAfter);
    else if (F.kind === "readopt" || F.kind === "polish") cur = len(F.ev.tourAfter);
    setText(el.sLen, f1(cur));
    setText(el.sStep, F.kind === "final" ? `${E} of ${E}` : `${Math.min(E, Math.floor(S.t))} of ${E}`);
    setText(el.sHull, f1(R.hullLength));
    setText(el.sBuilt, `${R.ms < 10 ? R.ms.toFixed(1) : Math.round(R.ms)} ms`);
    setText(el.sMoves, `${R.adoptions} adoptions, ${R.readoptions} re-adoptions, ${R.polishes} final-search swaps`);
    if (S.ref) {
      setText(el.sRef, `${f1(S.ref.length)} in ${(S.ref.ms / 1000).toFixed(1)} s`);
      const g = (R.length / S.ref.length - 1) * 100;
      setText(el.sGap, Math.abs(g) < 0.005 ? "equal" : g < 0 ? `${Math.abs(g).toFixed(2)}% shorter` : `${g.toFixed(2)}% longer`);
      el.sGap.dataset.better = String(g <= 0);
      let shared = 0; const mine = edgeSet(R.tour); for (const k of mine) if (S.refEdges.has(k)) shared++;
      setText(el.sShared, `${shared} of ${n} edges`);
    } else {
      setText(el.sRef, n >= MIN_POINTS && !S.live ? "searching..." : "-"); setText(el.sGap, "-"); setText(el.sShared, "-"); el.sGap.dataset.better = "";
    }
    el.warn.hidden = !R.capped;
    if (R.capped) el.warn.textContent = `Arcs capped at ${R.arcMaxUsed} points: longer chains would mean more than ${DEFAULTS.maxChains.toLocaleString()} candidates.`;
  } else {
    for (const k of ["sLen", "sStep", "sHull", "sBuilt", "sRef", "sGap", "sShared", "sMoves"]) setText(el[k], "-");
    el.warn.hidden = true;
  }
  if (R) {
    const v = String(Math.round(S.t * 2));
    if (document.activeElement !== el.scrub && el.scrub.value !== v) el.scrub.value = v;
  }
  el.play.setAttribute("aria-label", S.playing ? "Pause" : "Play");
  el.play.dataset.state = S.playing ? "playing" : "paused";
  setText(el.speedLabel, S.rate >= 100 ? `${Math.round(S.rate)} steps/s` : `${S.rate < 10 ? S.rate.toFixed(1) : Math.round(S.rate)} steps/s`);
  for (const b of [el.back, el.fwd, el.replay, el.instant, el.play, el.scrub]) b.disabled = !R;
}
const lenCache = new WeakMap();
function len(tour) {
  let v = lenCache.get(tour);
  if (v === undefined) {
    const n = S.P.length / 2; v = 0;
    for (let k = 0; k < tour.length; k++) {
      const a = tour[k], b = tour[(k + 1) % tour.length];
      v += Math.hypot(S.P[2 * a] - S.P[2 * b], S.P[2 * a + 1] - S.P[2 * b + 1]);
    }
    void n; lenCache.set(tour, v);
  }
  return v;
}

function updateAll() { updateText(); }

/* ============================================================================ main loop */
let last = performance.now();
function tick(now) {
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  if (S.playing && S.result) {
    const E = S.result.events.length;
    S.t = Math.min(E, S.t + dt * S.rate);
    if (S.t >= E) S.playing = false;
  }
  draw(); updateText();
  requestAnimationFrame(tick);
}

function boot() {
  try {
    renderer = new Renderer(el.gl);
  } catch (err) {
    el.nogl.hidden = false; console.error(err); return;
  }
  ctx2d = el.labels.getContext("2d");
  readHash();
  bindControls(); bindPointer();
  new ResizeObserver(resize).observe(el.plot);
  resize();
  S.P = makeInstance(S.kind, S.n, S.seed);
  S.n = S.P.length / 2;
  syncControls();
  el.speed.value = String(rateToSlider(S.rate));
  solve({ animate: true });
  requestAnimationFrame(tick);
}
boot();
