import { construct, makeInstance, referenceSolve } from "../js/solver.js";
for (const n of [60, 120, 200]) {
  for (const arc of [1, 2, 3, 4, 5]) {
    const P = makeInstance("random", n, 3);
    const r = construct(P, n, { arcMax: arc });
    console.log(`n=${n} arc=${arc} -> len ${r.length.toFixed(1)} chains ${r.chains}${r.capped ? " (capped)" : ""} ${r.ms.toFixed(0)}ms  adopt ${r.adoptions} readopt ${r.readoptions}`);
  }
}
const P = makeInstance("random", 120, 3);
const ref = referenceSolve(P, 120, 2000, 1);
console.log("reference ILS n=120:", ref.length.toFixed(1), ref.iterations, "iters");
