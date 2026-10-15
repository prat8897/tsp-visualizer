// Fresh instances (seeds 21-28) for checking the finished method; run OR-Tools on them with bench_ortools.py
import { makeInstance } from "../js/solver.js";
import { writeFileSync } from "node:fs";
const cases = [];
for (const n of [30, 60, 120]) for (let seed = 21; seed <= 28; seed++) cases.push({ n, seed, points: Array.from(makeInstance("random", n, seed)) });
writeFileSync("bench_cases.json", JSON.stringify(cases));
console.log(cases.length, "cases");
