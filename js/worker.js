// Web Worker: keeps the page responsive while the solver runs.
import { construct, referenceSolve, distanceMatrix, iteratedLocalSearch } from "./solver.js";

self.onmessage = (e) => {
  const m = e.data;
  try {
    if (m.type === "construct") {
      const result = construct(m.points, m.n, m.opts);
      self.postMessage({ type: "built", id: m.id, result });
    } else if (m.type === "polish") {
      // one of several final searches that run side by side, each with its own random seed
      const D = distanceMatrix(m.points, m.n);
      const res = iteratedLocalSearch(D, m.n, m.tour, { maxIters: m.iters, seed: m.seed, record: true });
      self.postMessage({ type: "polished", id: m.id, seed: m.seed, result: res });
    } else if (m.type === "reference") {
      const result = referenceSolve(m.points, m.n, m.budgetMs, m.seed || 1);
      self.postMessage({ type: "reference", id: m.id, result });
    }
  } catch (err) {
    self.postMessage({ type: "error", id: m.id, message: String(err && err.message || err) });
  }
};
