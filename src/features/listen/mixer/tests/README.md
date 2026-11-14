# Mixer planner tests

```sh
pnpm test:mixer
```

Plain `node --test` (Node 24 strips the TypeScript types; no test framework, no extra dependencies). The tests are
type-checked with `tsconfig.node.json` (they need Node's types) and kept out of the app build.

- `fixtures.ts`: synthetic `TrackMix` analyses (`fixture({ bpm, duration, vocals, drops, ... })`: a steady beat grid,
  simple sections, vocal spans, energy) and `check(transition, a, b)`, an invariant checker written independently of
  the planner (positions inside the songs, sorted keyframes in range, rates within 3.5 %, tempos meeting, no two
  basslines or voices, summed band energy, in and out points on the grid).
- `planner.test.ts`: `planTransition`/`planVariants` scenarios (tempo gaps, half time, vocals, drops, unsure and
  garbage analyses, forced presets, attack clarity, loops, loudness, opt-in options, timing).
- `sort.test.ts`: `sortForMix` and `buildTransitions`/`transitionFor` on a seeded synthetic library.
- `engine.test.ts`: the engine's pure parts: curve values and steps, the kill high-pass and filter mappings, the
  coloured span, echo and reverb tails, and what `scheduleAutomation` puts on each param (on a stand-in deck from
  `deck-fixtures.ts`, read back from the engine's own timeline).
- `schedule.test.ts`: deck positions against the integral of the rate, schedule points without drift, loops, B settling,
  stretched spans and the buffer deck's kind.
- `xcorr.test.ts`: locating a recording inside a slice, to the sample and between samples.

What needs real Web Audio (rendering, the stretcher, the reverb, timing in a real-time context) is checked in a browser:
`../checks/*.html` on the dev server.

## Real songs (not in the repository)

Analyses of real songs come from a user's own library, so they stay out of the repository, and so do the suites that
use them. They live next to the analyses on the machine that made them and import the mixer sources from the working
tree (its path is set at the top of each script, or by `MIXDIR`). With the analysis JSONs
(`analysis/json/<slug>.json`, the planner's `TrackMix`) and the songs' audio (`analysis/wav-stereo/<slug>.wav`) next to
the `planner/` folder:

- **Rated-transition anchors** (`planner/test-planner.ts`): the transitions a listener rated 4 or 5 stars must still be
  planned as the class they rated (kind, bars, where A and B meet), e.g. a drop swap first, or a 16-bar blend from A
  around 4:38 among the variants. `cd planner && node test-planner.ts`.
- **Rule checker** (`planner/review/check2.ts`): plans every pair of the folder in both styles and counts violations
  (two voices, two basslines, energy over the loud level, handover drops, tempo, phrase alignment).
  `cd planner/review && node check2.ts ../../analysis/json`.
- **Lag judge** (`planner/review/dumpplans3.ts` + `lag3.py`, owned by the analysis side): renders where both decks'
  beats are heard and measures the lag between their attacks in the audio (verdicts OK / FLAM-offset / FLAM-scatter /
  AMBIGUOUS). `cd planner/review && node dumpplans3.ts ../../analysis/json plans.json`, then
  `python -I lag3.py plans.json ../../analysis/wav-stereo`.

Run them after changing the planner's rules; a new FLAM verdict or a failed anchor is a regression.
