import { construct, makeInstance, COSTS } from "../js/solver.js";
const P = makeInstance("random", 120, 11);
for (const k of Object.keys(COSTS)) { const r = construct(P, 120, { cost: k, arcMax: 4 }); console.log(k.padEnd(12), r.ms.toFixed(0).padStart(5), "ms", "steps", r.adoptions + r.readoptions, "chains", r.chains); }
