# Modules

A **module** is a small piece of level with a known difficulty: an entry point, an exit point,
and whatever geometry sits between them. The point of the library is that once each module has
been solved once, a map assembled out of them is difficulty-graded *by construction* — no atlas
sweep per candidate map, which is what makes generate-then-solve unaffordable.

Difficulty is a **rung** on `solver/ladder.js`: rung 0 is a fresh run with nothing bought, and
each of the 36 rungs above it adds exactly one item. Rung k+1 dominates rung k on every axis, so
"the lowest rung that clears this module" is well defined and can be found in ~6 runs instead of
37.

## Format

```json
{ "name": "gap-wide", "version": 1,
  "tags": ["gap", "speed", "jump"],
  "objects": [ { "kind": "plat", "x": 0, "y": 0, "w": 600, "h": 400 } ],
  "size": { "w": 1865, "h": 400 },
  "entry": { "x": 0, "y": 0 },
  "exit":  { "x": 1865, "y": 0 },
  "expect": { "minRung": 20, "tolerance": 1, "why": "..." },
  "solve":  { "hash": "...", "settings": {}, "minRung": 20, "combo": {}, "frames": 256,
              "arena": "mapeditor/maps/module-gap-wide.json", "solvedAt": "2026-08-27" } }
```

- `objects` are in the **editor's** object model (`kind` + `x/y/w/h` + per-kind props), the same
  shape `mapkit/mapformat.js` translates. Coordinates are module-local, with the bounding box's
  top-left at the origin.
- `entry` and `exit` are points on top surfaces, at the left and right ends. The arena builder
  lines its ledges up with them exactly, so the module is the only thing between spawn and coin.
  Arenas run left to right: `exit.x` must be greater than `entry.x`.
- `expect` is **hand-written, before the solver is ever run on the module**. That is the whole
  value of the seven modules currently here: each one's rung was predicted from the physics
  (terminal speed `4*(0.8 + 0.2*spd)`, jump rise `n*J - n*(n+1)/2` for `J = 12 + 1.1*jmp`,
  `n = floor(J)`, doubled by Double Jump) and then checked. A harness that quietly reports
  everything as hard, or everything as easy, cannot pass seven independent predictions.
  - `tolerance` is how many rungs the hand estimate may be out by, and defaults to 0. Only a
    module graded on a *continuous* quantity — how wide a gap is, how tall a step is — may
    declare one, and it has to say why. A module gated by a discrete fact (an item exists or it
    does not) is exact or it is wrong.
- `solve` is written by `solver/solve-module.js --write`. It is **dropped, not kept**, if the
  module's geometry, entry/exit or `solver/settings.js` change: stale difficulty metadata is the
  one thing that can silently generate an unbeatable map.

## Solving

```bash
cd solver
node solve-module.js                       # every module here, compared against expect
node solve-module.js --write               # ...and store the answers
node solve-module.js ../mapeditor/modules/gap-wide.json
```

Each module is wrapped in a synthetic arena (`solver/arena.js`) — entry ledge, the module, exit
ledge, sealed box, lethal spike floor, one coin as the finish line — and that arena is written to
`mapeditor/maps/module-<name>.json` as a **real map**. Open it in the editor, play it in the
game: it is exactly the map the solver solved, and a module whose arena cannot be opened is not
a test case.

## What the solver does and does not answer

It answers **physically possible**, frame by frame, under `solver/settings.js`. It does not
answer **humanly executable** — the same gap the vanilla logic has, corrected by hand through
`client/johnny-upgrade-logic-test.user.js` and `solver/strip_failed.py`. A module library
inherits that gap into every map built from it, so a solved module still has to be played by
hand at its rung before it is trusted.

Two rules the harness will not bend:

- Only a run that **exhausted its state space** may say a rung is insufficient. A run that hit
  its frame budget or filled its visited set is reported as *unknown*, never as "impossible".
- A disagreement with `expect` is the interesting output, and the two directions are not equally
  interesting. **Harder** than expected is usually a module that does not do what its author
  thought. **Easier** than expected is a possible hole in the physics or the arena, and it is
  the direction that reaches the generator as a too-loose rule.
