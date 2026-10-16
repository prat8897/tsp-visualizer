// How close are we to near-optimal (LKH, see bench_lkh.py)?  single = build + one final search;  squeeze = race + merge + segments.
import { readFileSync } from "node:fs";
import { construct, distanceMatrix, tourLength, polishBudget } from "../js/solver.js";
import { finishInParallel, runJob } from "../js/finish.js";
const rows = JSON.parse(readFileSync(process.env.FILE || new URL("./bench_lkh.json", import.meta.url)));
const only = (process.env.SIZES || "120,200,300").split(",").map(Number);
const agg = {};
for (const r of rows.filter((x) => only.includes(x.n))) {
  const n = r.n, P = Float64Array.from(r.points), D = distanceMatrix(P, n), batch = n > 150 ? 4 : 1;
  const first = construct(P, n, { polishIters: 0, batch });
  let wall = first.ms;
  const exec = async (jobs) => { let slow = 0; const out = jobs.map((j) => { const t = performance.now(); const o = runJob(P, n, j); slow = Math.max(slow, performance.now() - t); return o; }); wall += slow; return out; };
  const res = await finishInParallel(P, n, first, exec, { workers: 4, iters: polishBudget(n), buildOpts: { batch } });
  const single = r.ours, sq = res.length;
  const a = (agg[n] ||= { single: 0, squeeze: 0, k: 0, wall: 0 });
  a.single += (single / r.lkh - 1) * 100; a.squeeze += (sq / r.lkh - 1) * 100; a.k++; a.wall += wall;
  console.log(`n=${n} seed=${r.seed} lkh ${r.lkh.toFixed(1)}  single ${single.toFixed(1)} (+${((single / r.lkh - 1) * 100).toFixed(2)}%)  squeeze ${sq.toFixed(1)} (+${((sq / r.lkh - 1) * 100).toFixed(2)}%)`);
}
for (const [n, a] of Object.entries(agg)) console.log(`n=${n}: mean gap to LKH  single ${(a.single / a.k).toFixed(2)}%  squeeze ${(a.squeeze / a.k).toFixed(2)}%   (squeeze simulated wall ${(a.wall / a.k).toFixed(0)} ms)`);
