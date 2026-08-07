# Johnny Upgrade reachability solver

Derives, for every check in the level, the **Pareto-minimal set of stat permutations** that can
reach it — by reimplementing the game's actual physics frame-for-frame and searching the real
state space, rather than approximating the level as a platform graph.

## Why the previous approach failed

`scratch-work/reachability-solver/solver.js` modelled platforms as graph nodes with
midpoint-to-midpoint jump arcs. That cannot represent: ceiling collision, moving platforms,
hazard timing, coins collected mid-arc, or the interaction between them. Its hazard rules were
hand-tuned constants bolted on afterward, which is why its answers were wrong.

## How this works

`fastsim.js` reimplements `LevelState.update()` in its exact order — `stomperCode`,
`platMoveCode`, `controls`, `leftRightCode`, `gravCode`, `spikeCode` — plus the deterministic
world (`bombCode`, `laserCode`, `eneCode`). `physics.js` is a readable reference implementation
of the same model that `test-physics.js` checks against; `fastsim.js` is the same thing
restructured onto typed arrays so a frame step costs no allocations.

The search is a **frame-layered BFS**: layer *f* is every distinct player state reachable at
frame *f*. Minimum frames to a location therefore falls straight out of the layer index, which
is what makes "time spent dodging a saw" and "time spent riding a lift" real costs rather than
guesses — they are simply frames the search had to spend. Time Limit tier is then the inverse of
the game's own `tim = round(T*6+3)` formula.

Key physics, all recovered from `js/level.js` and `js/shop.js` (tier `T` → `v = T*0.1`, because
`addITM` indexes its price array with `Math.round(v*10)` and `shopBtnPress` adds a flat `0.1`):

| quantity | formula |
|---|---|
| run accel | `spd = 0.8 + 0.2*T` , applied as `vx = (vx + spd)*0.8` → terminal `4*spd` |
| jump | `vy = -(1.1*T + 12)`, gravity `vy += 1`, capped at 90 |
| jumps | `jumpMax = 1 + jmp2.v` → 1, or 2 with Double Jump |
| timer | `6*T + 3` seconds, death at `tim < 1` → `(6*T+2)*60` frames |
| ammo | `round(ammo.v * 20)` = **2 bullets per tier** |
| hitbox | player `x±30`, `y-90..y` (anchor at the feet) |

### Validation

The port reproduces, from physics alone, the **Speed 5 crusher threshold** that was previously
known only from playtesting: Speed 1–4 get sealed in by the falling slab, Speed 5+ escape.

## Findings that changed the logic

**Robot `ene4` is a hard gate on the entire back half of the map.** Under `plat31` the floor-to-
ceiling clearance is 200px (floor `y=2240`, `plat31` underside `y=2040`). The robot is 120px tall
and the player is 90px — 210px needed. You cannot jump it and you cannot walk through it, so with
1 heart and no gun the search exhausts at **212/246 coins with the boss arena unreachable**.

Two things get past it, and they are exactly the two the logic notes flagged as TODO:

- **Damage boost** — Energy ≥ 2 buys 60 i-frames (`killSprite` sets `sprt.inv = 60`). Energy 2
  alone yields 246/246 coins and the boss gate.
- **Shooting it** — `killRobot` splices the robot out permanently. Ammo 1 (2 bullets) yields
  246/246 coins, the boss gate, and all 6 robot checks.

`which-blockers.js` force-kills each killable hazard in turn and confirms **`ene4` is the only
one that gates anything**.

**Robot checks are gun-only.** `killRobot` is reachable from `bulletHitEnemy` and nowhere else,
so enemysanity checks always require the gun plus ammo — the energy arm correctly reports
248/254 (everything except the 6 robots).

**Bullet-hop is real.** `shoot()` applies `yy -= 12` when `ju == 0`, giving a ~66px hop (vs Jump
1's 79px), once per landing, 1 ammo each. At `spd5 jmp0`, Ammo 1 takes the reachable count from
10 coins to 20 — confirming the "Jump 1 OR (HasGun AND Ammo 1)" note.

**Gun Power does not affect reachability**, only the boss: it scales `b.scale.x` (bullet width)
while the vertical hitbox stays pinned at `±12`, and robot/bomb kills have no HP check.

## The atlas

The lattice is `(speed, jump, doubleJump, energy, ammo)`. Results are cached per combo in
`out/combo/`, so nothing is ever recomputed, and any number of workers can run at once.

It is swept as **two arms** rather than a full cross product:

| arm | combos |
|---|---|
| energy arm: `(spd, jmp, dj, energy 1–5)`, no gun | 1,210 |
| gun arm: `(spd, jmp, dj, ammo 1–3)`, energy 1 | 726 |

Energy and the gun are alternative answers to the same blockers, so the OR of the two arms is
what the logic needs. Omitting the both-at-once corner can only make a requirement *stricter*
(a player holding both is at least as capable as either arm alone), never unbeatable — and it
turns 6,050 runs into 1,936.

**Monotone closure and sandwiching.** AP rules are monotone by construction
(`Has(item, count >= n)`), and extra ability is never forced in-game — a Speed 10 player can tap
to move like Speed 3. So "reached at A" implies "reached at every C ≥ A". That makes sandwiching
sound: if `A ≤ C ≤ B` and A and B agree about a location, C's answer is *determined* and C never
has to run. Running the lattice extremes first collapses a large fraction of the space.

Only a run that **exhausted its state space** (`complete: true`) can prove a location
unreachable; `closure()` respects that distinction.

## Running it

```bash
cd solver
node test-physics.js                      # sanity-check the physics port
node --max-old-space-size=6000 run-combo.js --loop --worker 0/8    # one worker per shell
node status.js                            # coverage + what is still undetermined
node report.js --py                       # emit the requirements
node map.js 10 10 1                       # ASCII reachability map for one combo
```

Workers coordinate through the atlas directory: each re-reads it between combos, skips anything
already on disk, and takes a different slice of the planned batch. Interrupting one is safe —
results are written with write-then-rename, so a killed process cannot leave a torn file.

Outputs land in `out/`:
- `requirements.json` — per location, the Pareto-minimal options, each tagged
  `via: base | damage | gun`, plus `noDamageOptions` for when damage boosting is disabled in yaml
- `logic.generated.txt` — human-readable, in the shape of `scratch-work/logic.txt`
- `generated_requirements.py` — for the apworld

## Conservatism

Every discretization knob errs toward *under*-reporting reachability: merging states can only
remove routes, never invent them. A too-strict rule delays a check; a too-loose one can generate
an unbeatable seed. Settings were chosen empirically (`settings.js`) — results are identical at
`qPos` 6 vs 8, `stride` 3/4/5, and `beamCap` 32/64/128/256, so the search is converged rather
than discretization-limited.
