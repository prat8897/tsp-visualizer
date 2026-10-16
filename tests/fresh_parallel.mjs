// Fresh instances (never used for tuning): one build + final search vs the same build + best of K parallel searches vs OR-Tools.
import { readFileSync } from "node:fs";
import { construct, distanceMatrix, tourLength, iteratedLocalSearch, polishBudget } from "../js/solver.js";
const K = Number(process.env.K || 6);
const rows = JSON.parse(readFileSync(new URL("./bench_fresh.json", import.meta.url)));
let a = 0, b = 0, c = 0, wins1 = 0, winsK = 0;
for (const r of rows) {
  const P = Float64Array.from(r.points), n = r.n, D = distanceMatrix(P, n);
  const base = construct(P, n, { polishIters: 0, batch: n > 150 ? 4 : 1 });
  let best = Infinity, one = 0;
  for (let s = 1; s <= K; s++) {
    const res = iteratedLocalSearch(D, n, base.tour, { maxIters: polishBudget(n), seed: s });
    const L = tourLength(D, n, res.tour);
    if (s === 1) one = L;
    best = Math.min(best, L);
  }
  a += one / r.ortools; b += best / r.ortools; if (one < r.ortools) wins1++; if (best < r.ortools) winsK++;
  console.log(`n=${String(n).padEnd(3)} seed=${r.seed}  ortools ${r.ortools.toFixed(1)}  1 search ${one.toFixed(1)}  best of ${K} ${best.toFixed(1)}`);
}
console.log(`mean vs OR-Tools: 1 search ${((a / rows.length - 1) * 100).toFixed(2)}%  best of ${K} ${((b / rows.length - 1) * 100).toFixed(2)}%   shorter than OR-Tools ${wins1}/${rows.length} vs ${winsK}/${rows.length}`);
