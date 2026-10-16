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
process.exit(bad ? 1 : 0);
