// Writes bench_cases.json: random instances + results of the JS construction and the in-browser reference solver.
import { construct, makeInstance, referenceSolve } from "../js/solver.js";
import { writeFileSync } from "node:fs";
const cases = [];
for (const n of [30, 60, 120]) {
  for (let seed = 1; seed <= 8; seed++) {
    const P = makeInstance("random", n, seed);
    const a3 = construct(P, n, { arcMax: 3 }), a4 = construct(P, n, { arcMax: 4 });
    const ils = referenceSolve(P, n, 2000, 1);
    cases.push({ n, seed, points: Array.from(P),
      arc3: a3.length, arc3ms: a3.ms, arc4: a4.length, arc4ms: a4.ms, ils: ils.length });
    console.log(n, seed, a3.length.toFixed(2), a4.length.toFixed(2), ils.length.toFixed(2));
  }
}
writeFileSync("bench_cases.json", JSON.stringify(cases));
