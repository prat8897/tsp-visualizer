// The final search: tours stay valid and never get longer, the animation's edge diffs match the tours,
// and what it buys against OR-Tools on the tuning instances (bench_results.json) and on fresh ones (bench_fresh.json).
import { construct, makeInstance } from "../js/solver.js";
import { readFileSync } from "node:fs";
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const edges = (t) => { const s = new Set(); t.forEach((v, i) => { const w = t[(i + 1) % t.length]; s.add(v < w ? v * 65536 + w : w * 65536 + v); }); return s; };
let bad = 0, runs = 0, evs = 0;
for (const kind of ["random", "clusters", "ring", "grid", "spiral"]) for (const n of [8, 12, 30, 60, 120, 250]) for (const seed of [1, 2, 3]) {
  const arcMax = n > 150 ? 3 : 4, P = makeInstance(kind, n, seed);
  const on = construct(P, n, { arcMax }), off = construct(P, n, { arcMax, polishIters: 0 });
  runs++;
  let ok = [...on.tour].sort((a, b) => a - b).every((v, i) => v === i) && on.tour.length === n && on.length <= off.length + 1e-9;
  let prev = off.tour;
  for (const ev of on.events.filter((e) => e.type === "polish")) {
    evs++;
    const A = edges(prev), B = edges(ev.tourAfter);
    if ([...A].filter((k) => !B.has(k)).length !== ev.removed.length || [...B].filter((k) => !A.has(k)).length !== ev.added.length || !(ev.net > 0)) ok = false;
    prev = ev.tourAfter;
  }
  if (!same(prev, on.tour)) ok = false;
  if (!ok) { bad++; console.log("PROBLEM", kind, n, seed); }
}
console.log(`${runs} runs, ${evs} final-search improvements: ${bad ? bad + " problems" : "all tours valid, never longer, edge diffs consistent"}`);
for (const [label, file] of [["tuning seeds 1-8", "bench_results.json"], ["fresh seeds 21-28", "bench_fresh.json"]]) {
  const rows = JSON.parse(readFileSync(file, "utf8"));
  for (const n of [30, 60, 120]) {
    const inst = rows.filter((r) => r.n === n), arcMax = n <= 40 ? 5 : 4;
    const run = (o) => inst.map((r) => construct(Float64Array.from(r.points), n, { arcMax, ...o }));
    const off = run({ polishIters: 0 }), on = run({});
    const g = (rs) => rs.map((x, i) => (x.length / inst[i].ortools - 1) * 100), gon = g(on);
    console.log(`${label} n=${n}: adoption only ${mean(g(off)).toFixed(2)}% -> with final search ${mean(gon).toFixed(2)}% (${mean(on.map((x) => x.ms)).toFixed(0)} ms), shorter ${gon.filter((v) => v < -1e-6).length}, equal ${gon.filter((v) => Math.abs(v) <= 1e-6).length}, worst ${Math.max(...gon).toFixed(2)}%`);
  }
}
process.exit(bad ? 1 : 0);
