// Checks the pieces behind the parallel final search: the worker's "polish" message and attachPolish().
import { construct, makeInstance, distanceMatrix, tourLength, attachPolish, polishBudget } from "../js/solver.js";
const sent = [];
globalThis.self = { postMessage: (m) => sent.push(m) };
await import("../js/worker.js");
let bad = 0;
for (const n of [40, 120]) {
  const P = makeInstance("random", n, 5), D = distanceMatrix(P, n);
  const base = construct(P, n, { polishIters: 0 });
  sent.length = 0;
  for (let seed = 1; seed <= 4; seed++) self.onmessage({ data: { type: "polish", id: seed, points: P, n, tour: base.tour, iters: polishBudget(n), seed } });
  const runs = sent.filter((m) => m.type === "polished").map((m) => m.result);
  runs.sort((a, b) => tourLength(D, n, a.tour) - tourLength(D, n, b.tour));
  const merged = attachPolish(structuredClone(base), D, runs[0]);
  const single = construct(P, n, {});
  const ok = new Set(merged.tour).size === n && merged.length <= single.length + 1e-9 && merged.length <= base.length;
  if (!ok) bad++;
  console.log(`n=${n} build ${base.length.toFixed(2)}  single search ${single.length.toFixed(2)}  best of 4 ${merged.length.toFixed(2)}  ${ok ? "ok" : "BAD"}`);
}
// the generic "job" message used by the squeeze stages
{
  const n = 60, P = makeInstance("random", n, 9), base = construct(P, n, { polishIters: 0 });
  sent.length = 0;
  self.onmessage({ data: { type: "job", id: 1, points: P, n, job: { type: "build", opts: { cost: "log", polishIters: 0 } } } });
  self.onmessage({ data: { type: "job", id: 2, points: P, n, job: { type: "path", path: base.tour.slice(0, 30), iters: 200, seed: 1 } } });
  const [b, p] = sent.map((m) => m.result);
  const ok = sent.every((m) => m.type === "jobdone") && new Set(b.tour).size === n && p.path[0] === base.tour[0] && p.path[29] === base.tour[29] && new Set(p.path).size === 30;
  if (!ok) bad++;
  console.log("worker job messages (build, fixed-end path):", ok ? "ok" : "BAD");
}
process.exit(bad ? 1 : 0);
