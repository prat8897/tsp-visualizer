// How much does "run many configurations, keep the best" buy? Uses the same instances as bench_results.json.
import { construct } from "../js/solver.js";
import { readFileSync } from "node:fs";
const rows = JSON.parse(readFileSync("bench_results.json", "utf8"));
const configs = [];
for (const cost of ["detour", "detourRatio", "perPoint", "log"])
  for (const arcMax of [3, 4])
    for (const rankBy of ["per_point", "total"])
      configs.push({ cost, arcMax, rankBy });
for (const knn of [4, 8]) for (const arcMax of [3, 4]) configs.push({ cost: "detour", arcMax, rankBy: "per_point", knn });
const pts = (r) => Float64Array.from(r.points);
for (const n of [60, 120]) {
  let single = [], port = [], ms = [], winners = {};
  for (const r of rows.filter((x) => x.n === n)) {
    const P = pts(r);
    const t0 = performance.now();
    const res = configs.map((c) => ({ c, len: construct(P, n, { ...c, maxChains: 1e9 }).length }));
    ms.push(performance.now() - t0);
    const best = res.reduce((a, b) => (b.len < a.len ? b : a));
    const key = JSON.stringify(best.c); winners[key] = (winners[key] || 0) + 1;
    single.push((r.arc4 / r.ortools - 1) * 100);
    port.push((best.len / r.ortools - 1) * 100);
    r._best = best.len;
  }
  const rs = rows.filter((x) => x.n === n);
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  console.log(`n=${n}: ${configs.length} configs, ${mean(ms).toFixed(0)} ms per instance run one after another`);
  console.log(`  default (arc 4):      mean ${mean(single).toFixed(2)}% vs OR-Tools, shorter on ${single.filter((v) => v < -1e-6).length}/8`);
  console.log(`  best of ${configs.length} configs:  mean ${mean(port).toFixed(2)}% vs OR-Tools, shorter on ${port.filter((v) => v < -1e-6).length}/8`);
  console.log(`  in-page ILS (2 s):    mean ${mean(rs.map((r) => (r.ils / r.ortools - 1) * 100)).toFixed(2)}% vs OR-Tools`);
  console.log(`  distinct winning configs: ${Object.keys(winners).length} of ${configs.length}`);
}
