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

## Final search

Once every point is adopted, a short 2-opt + Or-opt search with random kicks runs on the tour (4 kicks per point, a few tens of milliseconds). 2-opt and Or-opt alone find nothing on a construction tour: none of 48 tours checked exhaustively had an improving 2-opt move. The kicks (swap two neighbouring stretches, repair, keep only if shorter) are what pay. Every kept improvement is a step in the animation. Turn it off with the *Finish with a 2-opt and Or-opt search* checkbox or `polishIters: 0`.

## Parallelism

- **Parallel final searches.** The tour is built once, then the page runs the final search on several Web Workers at once (seeds 1 to K, K = cores - 1, 2 to 6) and keeps the shortest result. Wall time stays about one search. Measured on 12 random instances: best of 8 seeds is about 0.3% shorter than one seed at 120 and 200 points (854.98 vs 857.96, 1076.05 vs 1079.28), and beats a single search given 4x the iterations. Against OR-Tools on the 24 fresh instances the mean moves only from -1.10% to -1.13%, so this is a small gain. `node tests/fresh_parallel.mjs`.
- **Batch adoption** (`batch: k`). Each round adopts up to k agreed pairs instead of one, taking the best first and then only pairs that share no points with it and whose candidate would not prefer one of the edges just created. `batch: 1` is the original rule and is what the Python parity test checks. 8 random instances: at 300 points batch 4 builds in 0.64 s instead of 0.82 s (final length equal within 0.2%); at 120 points 0.09 s vs 0.11 s. The page uses `batch: 4` above 150 points and 1 below, so small instances still animate one pair at a time.

## Tried and dropped

- **Forking the first choice.** Running builds that start from the 2nd, 3rd... best agreed pair, or send the best candidate to its 2nd to 4th cheapest edge, gives the same final tour: re-adoption and the final search undo the difference. Best of 8 forks was within 0.1% of one build; best of 8 final-search seeds was 3x better, so only the final search is run in parallel.

All measured against OR-Tools on random instances, small samples:

- **Beam search** (fork the top few agreed pairs at every step, keep the best partial tours): 8 tours with 3 forks cut the 120-point gap from +0.86% to about 0%, at roughly 12x the time. Reverted.
- **Racing ten cost functions** and keeping the shortest: about 0.5% better at 60 to 120 points, but about 10 s of work at 120 points. Reverted.
- **Margin (regret) ranking** of the agreed pairs, 28 variants: none beat plain cheapest-first. Weighting the column margin made 120-point tours 1.5 to 2% worse.

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
node final_search.mjs  # final search: validity, and tuning vs fresh instances against OR-Tools
node bench_js.mjs && python3 bench_ortools.py 2   # regenerate the OR-Tools comparison (needs: pip install ortools numpy scipy matplotlib)
```

`parity.mjs` compares 36 instances (3 layouts, 12 / 25 / 40 points, 2 seeds, arcs of 1 and 3), with the final search off. All tour lengths match the Python original.

OR-Tools comparison on fresh instances (seeds 21-28, generated after the method was fixed; `bench_fresh.json`), 8 per size, OR-Tools given `3 + n/5` seconds, the page's default arc sizes:

| Points | Adoption only vs OR-Tools | With final search | Final search: shorter / equal | Time with final search | OR-Tools time |
| --- | --- | --- | --- | --- | --- |
| 30 | +0.40% | 0.00% | 0 / 8 of 8 | about 25 ms | 9 s |
| 60 | +0.54% | -0.58% | 3 / 5 of 8 | about 45 ms | 15 s |
| 120 | -0.15% | -2.71% | 8 / 0 of 8 | about 190 ms | 27 s |

One run per instance, one machine. The in-page "reference" is the same search started from a nearest-neighbour tour and given a time budget, not OR-Tools (which can't run in a browser).
