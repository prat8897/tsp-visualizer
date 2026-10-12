// The page replays result.events, so for a beam result the winning path must form one consistent timeline.
import { construct, makeInstance } from "../js/solver.js";
let bad = 0, checked = 0;
for (const [kind, n, seed, arc, bw, br] of [["random", 30, 1, 3, 8, 3], ["clusters", 60, 2, 4, 4, 2], ["random", 80, 5, 3, 16, 3], ["grid", 40, 3, 2, 8, 4]]) {
  const P = makeInstance(kind, n, seed);
  const r = construct(P, n, { arcMax: arc, beamWidth: bw, branch: br });
  let prev = r.hull.slice(); checked++;
  const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
  for (const ev of r.events) {
    if (ev.type === "adopt") {
      const removed = ev.tourAfter.filter((v) => !ev.chain.includes(v));
      const ok = ev.tourAfter.length === prev.length + ev.chain.length && removed.length === prev.length;
      // after removing the chain, the cyclic order must equal the previous tour
      const i0 = removed.indexOf(prev[0]);
      const rot = removed.slice(i0).concat(removed.slice(0, i0));
      if (!ok || !same(rot, prev)) { bad++; console.log("adopt mismatch", kind, n, ev.step); break; }
    } else if (!same(ev.tourBefore, prev)) { bad++; console.log("readopt mismatch", kind, n, ev.step); break; }
    prev = ev.tourAfter;
  }
  const valid = [...r.tour].sort((a, b) => a - b).every((v, i) => v === i) && r.tour.length === n;
  if (!valid || !same(prev, r.tour)) { bad++; console.log("final tour mismatch", kind, n); }
  console.log(`${kind} n=${n} beam ${bw}x${br}: ${r.events.length} events, length ${r.length.toFixed(1)}, explored ${r.beam.explored}, finalists ${r.beam.finalists}`);
}
console.log(bad ? `${bad} problems` : `all ${checked} timelines consistent`);
process.exit(bad ? 1 : 0);
