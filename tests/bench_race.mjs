// Fresh instances (seeds 11-18): greedy with the default cost vs the best of all cost functions. Writes race_cases.json.
import { construct, makeInstance, COSTS } from "../js/solver.js";
import { writeFileSync } from "node:fs";
const arcFor = (n) => (n <= 40 ? 5 : n <= 150 ? 4 : 3);   // the page's defaults
const out = [];
for (const n of [30, 60, 120]) for (let seed = 11; seed <= 18; seed++) {
  const P = makeInstance("random", n, seed);
  const t0 = performance.now();
  const lens = {};
  for (const k of Object.keys(COSTS)) lens[k] = construct(P, n, { cost: k, arcMax: arcFor(n) }).length;
  const seqMs = performance.now() - t0;
  const best = Math.min(...Object.values(lens));
  out.push({ n, seed, points: Array.from(P), single: lens.detour, race: best, lens, seqMs, winner: Object.keys(lens).find((k) => lens[k] === best) });
  console.log(n, seed, lens.detour.toFixed(2), best.toFixed(2), out[out.length - 1].winner, seqMs.toFixed(0) + "ms");
}
writeFileSync("race_cases.json", JSON.stringify(out));
