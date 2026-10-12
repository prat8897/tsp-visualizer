import { construct } from "../js/solver.js";
import { readFileSync } from "node:fs";
const rows = JSON.parse(readFileSync("bench_results.json", "utf8"));
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
for (const n of [60, 120]) {
  console.log(`n=${n}`);
  for (const [bw, br] of [[8, 3], [16, 3]]) for (const alpha of [0, 0.5, 1, 1.5, 2.5]) {
    const g = [], ms = [];
    for (const r of rows.filter((x) => x.n === n)) {
      const res = construct(Float64Array.from(r.points), n, { arcMax: 3, beamWidth: bw, branch: br, estimateWeight: alpha });
      g.push((res.length / r.ortools - 1) * 100); ms.push(res.ms);
    }
    console.log(`  beam ${bw}x${br} alpha ${alpha}: mean ${mean(g).toFixed(2).padStart(6)}%  shorter ${g.filter((v) => v < -1e-6).length}/8  worst ${Math.max(...g).toFixed(2)}%  ${mean(ms).toFixed(0)} ms`);
  }
}
