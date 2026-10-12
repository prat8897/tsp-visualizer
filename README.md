# TSP Visualiser

Watch a travelling salesman tour grow inward from the convex hull, one agreed move at a time, drawn live in WebGL.

**Live site:** https://prat8897.github.io/tsp-visualizer/

Click the sheet to place your own points, drag them around and the tour re-solves as you move. Or pick a layout (random, clusters, ring, grid, spiral) and scrub through how it was built.

## The algorithm

Mutual-agreement adoption plus re-adoption, purely cost-driven:

1. The tour starts as the convex hull.
2. A candidate is a point or an *arc* (a chain of up to `arcMax` nearby points). Every candidate picks the tour edge it would stretch least, and every edge picks the candidate that would stretch it least.
3. A pair is allowed only when both picks agree. The cheapest allowed pair is adopted and the edge breaks into the new edges.
4. After each adoption, points and arcs adopted in earlier steps may be lifted out and re-adopted into another edge (either direction) if the real tour gets shorter.

No crossing, inside or area tests anywhere. All decisions go through one cost function (`COSTS` in `js/solver.js`).

## Racing cost functions

Every decision goes through one cost function (`COSTS` in `js/solver.js`, ten of them). Each run is plain greedy, always the cheapest agreed pair, but different costs build different tours. The page runs one greedy build per cost on a pool of Web Workers and keeps the shortest. Click a row under *Race results* to replay that cost's timeline. With racing off, one run uses the cost chosen under Algorithm. Dragging points always uses a single run so it stays instant.

## Run locally

No build step.

```sh
python3 -m http.server
# open http://localhost:8000
```

## Layout

| Path | What it is |
| --- | --- |
| `index.html`, `style.css` | The page |
| `js/solver.js` | The construction, instance generators and the in-browser reference search. No DOM, runs in a worker or Node |
| `js/worker.js` | Web Worker wrapper so the page stays responsive |
| `js/gl.js` | Small WebGL 1 renderer (anti-aliased lines, dashes, arrowheads, round markers) |
| `js/app.js` | State, controls, playback, point editing |
| `tests/` | The original Python script, a parity check against it, and the benchmark scripts |

## Checks and benchmarks

```sh
cd tests
node parity.mjs        # same points through the Python original and the JS port; lengths must match
node speed.mjs         # timings by n and arc size
node costs.mjs         # single cost functions and best-of portfolios on seeds 1-8
node bench_race.mjs && python3 race_ortools.py 2   # the fresh-seed comparison above
node time_costs.mjs    # time per cost function
node bench_js.mjs && python3 bench_ortools.py 2   # OR-Tools on seeds 1-8 (needs: pip install ortools numpy scipy matplotlib)
```

`parity.mjs` compares 36 instances (3 layouts, 12 / 25 / 40 points, 2 seeds, arcs of 1 and 3). All tour lengths match the Python original.

Fresh instances (seeds 11-18, not used to choose the cost functions), 8 per size, OR-Tools given `3 + n/5` seconds, the page's default arc sizes:

| Points | One greedy run vs OR-Tools | Race of 10 vs OR-Tools | Race: shorter / equal | OR-Tools time |
| --- | --- | --- | --- | --- |
| 30 | +0.23% | +0.08% | 0 / 6 of 8 | 9 s |
| 60 | +0.27% | -0.61% | 4 / 3 of 8 | 15 s |
| 120 | +0.84% | -0.49% | 5 / 0 of 8 | 27 s |

The ten runs take about 10 s one after another at 120 points; spread over workers the wall time is set by the slowest single run (about 2 s, estimated from per-run timings). One run per instance, one machine. The in-page "reference" is a 2-opt + Or-opt iterated local search, not OR-Tools (which can't run in a browser).
