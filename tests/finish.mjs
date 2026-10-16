// Parallel finishing stages, simulated in one thread: wall time of a stage = its slowest job (as if every job had its own core).
import { construct, makeInstance, distanceMatrix, tourLength, iteratedLocalSearch, polishBudget } from "../js/solver.js";
import { finishInParallel, runJob } from "../js/finish.js";
const seeds = (process.env.SEEDS || "31,32,33,34,35,36,37,38").split(",").map(Number);
const sizes = (process.env.SIZES || "60,120,200").split(",").map(Number);
const workers = Number(process.env.W || 4);
for (const n of sizes) {
  const acc = { single: 0, race: 0, merge: 0, segments: 0, bestOfSeeds: 0 }; let wall = 0, wallSingle = 0, rows = 0, valid = true;
  for (const sd of seeds) {
    const P = makeInstance("random", n, sd), D = distanceMatrix(P, n);
    let t = performance.now();
    const first = construct(P, n, { polishIters: 0 });
    const single = construct(P, n, {});
    wallSingle += performance.now() - t;
    let stageWall = 0;
    const exec = async (jobs) => { let slow = 0; const out = jobs.map((j) => { const t0 = performance.now(); const r = runJob(P, n, j); slow = Math.max(slow, performance.now() - t0); return r; }); stageWall += slow; return out; };
    const it = polishBudget(n);
    const r = await finishInParallel(P, n, first, exec, { workers, iters: it });
    wall += stageWall + first.ms;
    const g = (name) => (r.stats.stages.find((s) => s.name.startsWith(name)) || {}).length;
    acc.single += single.length; acc.race += g("race"); acc.merge += g("merge"); acc.segments += r.length;
    // comparison: the earlier idea, best of `workers` seeds on the same build
    let b = Infinity; for (let s = 1; s <= workers; s++) b = Math.min(b, tourLength(D, n, iteratedLocalSearch(D, n, first.tour, { maxIters: it, seed: s }).tour));
    acc.bestOfSeeds += b;
    if (new Set(r.tour).size !== n || Math.abs(tourLength(D, n, r.tour) - r.length) > 1e-6) valid = false;
    rows++;
  }
  console.log(`n=${n} workers=${workers} | ` + Object.entries(acc).map(([k, v]) => `${k} ${(v / rows).toFixed(2)}`).join("  ") + `  | wall (simulated) ${(wall / rows).toFixed(0)} ms vs single build+search ${(wallSingle / rows / 2).toFixed(0)}+ ms  ${valid ? "valid" : "INVALID"}`);
}
