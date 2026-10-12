// Which cost functions are worth racing? Single-cost results, then greedy forward selection of a portfolio.
import { construct, COSTS } from "../js/solver.js";
import { readFileSync } from "node:fs";
const rows = JSON.parse(readFileSync("bench_results.json", "utf8")).filter((r) => r.n >= 60);
const arcFor = (n) => 3;
const keys = Object.keys(COSTS);
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
// length[cost][instance]
const L = {};
for (const k of keys) L[k] = rows.map((r) => construct(Float64Array.from(r.points), r.n, { cost: k, arcMax: arcFor(r.n) }).length);
const gap = (lens) => lens.map((v, i) => (v / rows[i].ortools - 1) * 100);
console.log("single cost, arc 3, per_point ranking, n = 60 and 120 pooled (gap vs OR-Tools):");
for (const k of keys) { const g = gap(L[k]); console.log(`  ${k.padEnd(12)} mean ${mean(g).toFixed(2).padStart(6)}%  shorter ${g.filter((v) => v < -1e-6).length}/${rows.length}`); }
// greedy forward selection of a portfolio by mean of best-of
const chosen = []; let best = rows.map(() => Infinity);
for (let step = 0; step < 6; step++) {
  let pick = null, pv = Infinity;
  for (const k of keys) { if (chosen.includes(k)) continue; const m = mean(gap(best.map((b, i) => Math.min(b, L[k][i])))); if (m < pv) { pv = m; pick = k; } }
  chosen.push(pick); best = best.map((b, i) => Math.min(b, L[pick][i]));
  const g = gap(best);
  console.log(`portfolio +${pick.padEnd(12)} -> best-of-${chosen.length}: mean ${mean(g).toFixed(2)}%  shorter ${g.filter((v) => v < -1e-6).length}/${rows.length}`);
}
const gall = gap(rows.map((_, i) => Math.min(...keys.map((k) => L[k][i]))));
console.log(`all ${keys.length} costs: mean ${mean(gall).toFixed(2)}%  shorter ${gall.filter((v) => v < -1e-6).length}/${rows.length}`);
