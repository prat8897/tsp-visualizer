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

## Beam search

The greedy run always takes the cheapest agreed pair. With **Beam search** (Algorithm panel) the construction keeps several partial tours, forks each into its cheapest agreed pairs at every step, drops duplicates and keeps the best. The animation replays the winning branch. Dragging points always uses the greedy run so it stays instant.

Measured on 8 random 120-point instances, arcs up to 3 points, against OR-Tools:

| Search | Average length vs OR-Tools | Time |
| --- | --- | --- |
| Greedy | +0.86% | 51 ms |
| Beam 8 x 3 | -0.07% (-0.22% with look-ahead weight 0) | 0.6 s |
| Beam 16 x 3 | +0.33% (-0.10% with weight 0) | 1.2 s |
| Best of 20 different configurations | -0.53% | about 14 s one after another |

Wider beams did not reliably help, and with 8 instances differences of a few tenths of a percent are noise (`tests/beam.mjs`, `tests/beam_alpha.mjs`, `tests/portfolio.mjs`).

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
node beam_events.mjs   # beam-search timelines must replay consistently
node beam.mjs          # beam search vs greedy vs OR-Tools
node portfolio.mjs     # best of many configurations vs OR-Tools
node bench_js.mjs && python3 bench_ortools.py 2   # regenerate the OR-Tools comparison (needs: pip install ortools numpy scipy matplotlib)
```

`parity.mjs` compares 36 instances (3 layouts, 12 / 25 / 40 points, 2 seeds, arcs of 1 and 3). All tour lengths match the Python original.

OR-Tools comparison, 8 random instances per size, OR-Tools given `3 + n/5` seconds, arcs limited to 4 points:

| Points | Average length vs OR-Tools | Shorter / equal | Adoption tour | OR-Tools |
| --- | --- | --- | --- | --- |
| 30 | +1.17% | 0 / 2 of 8 | 9 ms | 9 s |
| 60 | 0.00% | 3 / 1 of 8 | 31 ms | 15 s |
| 120 | +0.11% | 4 / 0 of 8 | 211 ms | 27 s |

One run per instance, one machine. The in-page "reference" is a 2-opt + Or-opt iterated local search, not OR-Tools (which can't run in a browser); in this test it beat OR-Tools on all 8 of the 120-point instances.
