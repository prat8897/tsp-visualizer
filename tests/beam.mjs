// Beam search vs greedy vs OR-Tools on the benchmark instances (bench_results.json).
import { construct } from "../js/solver.js";
import { readFileSync } from "node:fs";
const rows = JSON.parse(readFileSync("bench_results.json", "utf8"));
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;

// sanity: width 1 / branch 1 must equal the greedy run
{ const r = rows.find((x) => x.n === 60), P = Float64Array.from(r.points);
  const g = construct(P, 60, { arcMax: 3 }), b = construct(P, 60, { arcMax: 3, beamWidth: 1, branch: 1 });
  const { constructBeam } = await import("../js/solver.js");
  const b1 = constructBeam(P, 60, { arcMax: 3, beamWidth: 1, branch: 1 });
  console.log("sanity: greedy", g.length.toFixed(3), "| beam 1x1", b1.length.toFixed(3), "| events", g.events.length, b1.events.length); }

const settings = [
  { arcMax: 3, beamWidth: 1 }, { arcMax: 3, beamWidth: 4, branch: 2 }, { arcMax: 3, beamWidth: 8, branch: 3 },
  { arcMax: 3, beamWidth: 16, branch: 3 }, { arcMax: 3, beamWidth: 32, branch: 4 },
  { arcMax: 4, beamWidth: 1 }, { arcMax: 4, beamWidth: 8, branch: 3 },
];
for (const n of [60, 120]) {
  console.log(`\nn=${n}  (8 instances; gap = tour length vs OR-Tools, negative = shorter)`);
  for (const s of settings) {
    const gaps = [], ms = [], spread = [];
    for (const r of rows.filter((x) => x.n === n)) {
      const res = construct(Float64Array.from(r.points), n, s);
      gaps.push((res.length / r.ortools - 1) * 100); ms.push(res.ms);
      if (res.beam) spread.push(res.beam.finalists);
    }
    const label = `arc ${s.arcMax}, ${s.beamWidth === 1 ? "greedy" : `beam ${s.beamWidth}x${s.branch}`}`.padEnd(20);
    console.log(`  ${label} mean ${mean(gaps).toFixed(2).padStart(6)}%  shorter ${gaps.filter((v) => v < -1e-6).length}/8  best ${Math.min(...gaps).toFixed(2).padStart(6)}%  worst ${Math.max(...gaps).toFixed(2).padStart(6)}%  ${mean(ms).toFixed(0).padStart(5)} ms`);
  }
  console.log(`  in-page 2 s search   mean ${mean(rows.filter((x) => x.n === n).map((r) => (r.ils / r.ortools - 1) * 100)).toFixed(2).padStart(6)}%`);
}
