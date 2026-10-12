// Cross-check: same points -> JS construct() vs the original Python Builder.
import { construct, makeInstance } from "../js/solver.js";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "tsp-"));
let bad = 0;
const cases = [];
for (const kind of ["random", "clusters", "grid"]) for (const n of [12, 25, 40]) for (const seed of [1, 2]) for (const arc of [1, 3]) cases.push({ kind, n, seed, arc });
for (const c of cases) {
  const P = makeInstance(c.kind, c.n, c.seed);
  const js = construct(P, c.n, { arcMax: c.arc, maxChains: 1e9 });
  const f = join(dir, "p.json");
  writeFileSync(f, JSON.stringify({ points: Array.from(P), arcMax: c.arc }));
  const py = JSON.parse(execFileSync("python3", ["compare.py", f], { encoding: "utf8" }).trim().split("\n").pop());
  const same = JSON.stringify(js.tour) === JSON.stringify(py.tour);
  const close = Math.abs(js.length - py.length) < 1e-6;
  if (!close) bad++;
  console.log(`${c.kind.padEnd(8)} n=${String(c.n).padEnd(3)} seed=${c.seed} arc=${c.arc}  js ${js.length.toFixed(3)}  py ${py.length.toFixed(3)}  ${same ? "identical tour" : close ? "same length" : "DIFFERENT"}  (js ${js.ms.toFixed(0)}ms, py ${(py.secs * 1000).toFixed(0)}ms)`);
}
console.log(bad ? `${bad} mismatches` : "all lengths match");
process.exit(bad ? 1 : 0);
