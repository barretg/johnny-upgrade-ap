// Solve a module: which rung of the ladder first clears it?
//
//   node solve-module.js                          # every module in mapeditor/modules/
//   node solve-module.js mapeditor/modules/gap-wide-400.json
//   node solve-module.js --write                  # ...and store the answer in the module file
//   node solve-module.js --keep-arenas            # leave the arenas in mapeditor/maps/
//   node solve-module.js --fast                   # trust the beam; rungs become upper bounds
//   node solve-module.js --jobs 4                 # four modules at once (memory is the ceiling)
//
// This is the cheap half of the "generate from known difficulty" idea. A full atlas sweep is
// hours times a dozen workers because it answers every combo against the whole map; a module is
// a few hundred frames in a box, and because the ladder is a chain, six runs settle it instead
// of thirty-seven. Solving a library once buys a generator that can grade a map by construction.
//
// The rules inherited from the rest of the solver, none of which are relaxed here:
//
//   * Only a run that EXHAUSTED its state space may say a rung is insufficient. A run that hit
//     its frame cap or filled its visited set proves nothing, and is reported as unknown rather
//     than guessed in either direction -- guessing "clears" is the direction that produces an
//     unbeatable map.
//     `complete: true` alone is NOT that guarantee: beamCap discards states, and a frontier that
//     empties after states were thrown away has not exhausted anything. So a negative is escalated
//     through wider beams until it is either exhausted with nothing discarded (a proof), or the
//     search starts truncating -- in which case the best complete-but-beamed answer is kept and
//     the record is marked `exact: false`, meaning the rung is an UPPER BOUND.
//   * settings.js is part of the answer. A solve record made under different settings is stale.
//   * The module's own objects are part of the answer too. Edit the geometry and the record is
//     dropped, because stale difficulty metadata is the one thing that can silently generate an
//     unbeatable map.
//   * "Physically possible" is not "humanly executable". A solved module still has to be played
//     by hand before it is trusted, exactly as the vanilla logic goes through
//     client/johnny-upgrade-logic-test.user.js and strip_failed.py.
//     That verdict is recorded in the module's `handPlay` block and it may only ever RAISE the
//     rung: the effective difficulty of a module is max(solve.minRung, handPlay.minRung). A
//     handPlay BELOW the solved rung is not a correction, it is a claim that a human did
//     something the simulator says is impossible -- that is a physics bug and it is refused here
//     rather than written down.
//
// Every module carries a hand-written `expect.minRung` and this compares against it. The
// interesting output is a disagreement, and the two directions are NOT equally interesting: the
// solver saying a module is HARDER than expected is usually a module that does not do what its
// author thought. The solver saying it is EASIER is a possible hole in the physics or in the
// arena, and it is the direction that reaches the generator as a too-loose rule.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const MODULE_DIR = path.join(ROOT, 'mapeditor', 'modules');
const ARENA_DIR = path.join(ROOT, 'mapeditor', 'maps');

// A module arena is tiny, so it does not need the sweep's 9000-frame budget. It does need enough
// room that a slow rung can still walk the whole thing, and enough that "did not reach it" is a
// real answer rather than the budget running out -- if a run ends on the frame limit it is
// reported as unknown, so this being too small shows up as unknowns, never as a wrong answer.
const MODULE_FRAMES = 1800; // 30 seconds

const canonical = (v) => {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  }
  return JSON.stringify(v === undefined ? null : v);
};

/**
 * What a HAND-PLAY verdict is an answer about: the geometry and the entry/exit, and nothing else.
 *
 * A person played the arena in the real game and reported the rung they cleared it at. That is a
 * fact about the game and the ladder, neither of which moves when the simulator's discretization
 * or its physics revision does -- so redraw the module and the verdict dies, but bump qPos or fix
 * a knockback rule and it stands. Hashing settings in here would silently throw away every
 * hand-play the moment the solver was corrected, which is exactly when they matter most.
 */
function geometryHash(mod) {
  return crypto
    .createHash('sha1')
    .update(canonical({ objects: mod.objects, entry: mod.entry, exit: mod.exit }))
    .digest('hex')
    .slice(0, 12);
}

/**
 * What a SOLVE record is an answer about: the geometry, the entry/exit, AND the settings.
 *
 * Settings belong here and not in geometryHash because the solve record is this simulator's
 * output, and every knob in settings.js -- physicsRev included -- can change it.
 */
function moduleHash(mod, settings) {
  return crypto
    .createHash('sha1')
    .update(canonical({ objects: mod.objects, entry: mod.entry, exit: mod.exit, settings }))
    .digest('hex')
    .slice(0, 12);
}

/**
 * Read a module, dropping a `solve` record that no longer describes it.
 *
 * Dropped, not kept and flagged: a record that has drifted from its geometry is worse than no
 * record, because everything downstream treats a record as an answer.
 */
function readModule(file, settings) {
  const mod = JSON.parse(fs.readFileSync(file, 'utf8'));
  mod.file = file;
  if (!mod.name) mod.name = path.basename(file, '.json');
  const want = moduleHash(mod, settings);
  if (mod.solve && mod.solve.hash !== want) {
    mod.staleSolve = mod.solve;
    mod.solve = null;
  }
  // A hand-play verdict goes stale on GEOMETRY alone: someone who widens a gap has not played the
  // wider gap, but someone who fixes the simulator has not un-played anything.
  const wantGeom = geometryHash(mod);
  if (mod.handPlay && mod.handPlay.hash !== wantGeom) {
    mod.staleHandPlay = mod.handPlay;
    mod.handPlay = null;
  }
  mod.hash = want;
  mod.geometryHash = wantGeom;
  return mod;
}

/**
 * The rung a module is actually worth, once a human has played it.
 *
 * The solver answers "physically possible", frame by frame. A hand-play verdict is the other
 * half of the answer, and it is allowed to move the number in exactly one direction: UP. A
 * module that the simulator clears at rung 5 but a person can only clear at rung 22 is a rung-22
 * module, because a generated map is played by people.
 *
 * A handPlay BELOW the solve rung is refused. It would mean a human did something the simulator
 * proved impossible, which is a bug in the physics, not a difficulty correction -- and quietly
 * lowering a rung is the direction that produces an unbeatable map.
 *
 * Returns { rung, source, played }; rung is null if the module has no usable solve record.
 */
function effectiveMinRung(mod) {
  const solved = mod.solve && typeof mod.solve.minRung === 'number' ? mod.solve.minRung : null;
  const hand = mod.handPlay && typeof mod.handPlay.minRung === 'number' ? mod.handPlay.minRung : null;
  if (hand !== null && solved !== null && hand < solved) {
    throw new Error(
      `${mod.name}: handPlay.minRung ${hand} is below solve.minRung ${solved}. A person cleared ` +
        'a rung the simulator says is impossible, so the physics is wrong. Fix that before ' +
        'recording it -- hand-play may only ever raise a rung.'
    );
  }
  if (hand !== null && solved === null) return { rung: hand, source: 'handPlay', played: true };
  if (hand === null) return { rung: solved, source: 'solve', played: false };
  return { rung: Math.max(hand, solved), source: hand > solved ? 'handPlay' : 'solve', played: true };
}

/*
 * Can the module simply be walked OVER?
 *
 * The arena is a sealed box, but the box is a long way above the module, so any slab
 * the player can stand on top of is a second route from entry to exit -- one that
 * meets none of the module's hazards. That is not hypothetical: every corridor module
 * in the library was built with a 200px-thick ceiling whose roof sat 300px above the
 * ledges, which rung 18 (jmp6 plus the double jump, 328px) clears comfortably. It
 * changed none of their grades only because all three of them solve at rung 12, well
 * below that. A corridor that deserved a grade ABOVE its roof rung would have been
 * quietly graded at the roof instead -- a too-loose rule, and the kind that reaches
 * the generator as an unbeatable seed.
 *
 * So this reports the rung at which a module stops being able to grade any higher.
 * "A roof" is a plat whose top surface is above both ledges and which spans nearly
 * the whole module, since anything shorter is an island to land on rather than a way
 * across. `maxRise` over-estimates the jump, so this errs toward CLAIMING a bypass --
 * a false warning costs a reading, a missed one costs a map.
 */
function roofRung(mod, LADDER) {
  const ledge = Math.min(mod.entry.y, mod.exit.y);
  const w = (mod.size && mod.size.w) || 0;
  let best = null;
  for (const o of mod.objects) {
    if (o.kind !== 'plat' || o.stomper) continue;       // a falling slab is not a floor
    if (o.y >= ledge) continue;                         // not above the ledges
    if (o.x > w * 0.05 || o.x + o.w < w * 0.95) continue; // an island, not a way across
    const climb = ledge - o.y;
    for (const r of LADDER.RUNGS) {
      if (LADDER.maxRise(r) >= climb && (best === null || r.index < best.rung)) {
        best = { rung: r.index, climb };
        break;
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Child mode: fastsim is already pointed at one arena, so solve it and print the answer.
// ---------------------------------------------------------------------------
//
// A separate process per module is not laziness. fastsim.js derives its whole world from the map
// at require() time -- that top-level derivation is where its speed comes from -- so one process
// can only ever solve one map. Phase 7 will have to unpick that to run in a browser; until then,
// a child per arena is the honest way to do it.
/*
 * The beam is a heuristic, and a beamed "no" is not a proof.
 *
 * `beamCap` admits at most N states per (16px cell, hazard phase) per layer and DROPS the rest.
 * Dropping states can only lose routes, never invent them, which is why it is safe for the atlas
 * sweep -- but the search still reports `complete: true` when the frontier empties, because
 * "frontier empty" and "everything was explored" stopped being the same thing the moment a state
 * was thrown away. The rule this whole pipeline rests on -- only an exhausted search may say a
 * rung is insufficient -- was therefore not being enforced.
 *
 * It is not hypothetical. robot-single graded at rung 12 with the beam on and an exhausted
 * frontier; at beamCap 256 the same arena is cleared at rung 8. Four rungs, on a proof.
 *
 * So a negative is re-run with the beam effectively off (beamCount is a Uint16Array, so 65535
 * admits everything) before it is believed. Positives are never re-run: a route the search
 * FOUND is a real frame-by-frame trajectory and no heuristic can fake one. That keeps the cost
 * where it belongs -- gap-wide's decisive negative is 4s beamed and 252s unbeamed, and only the
 * handful of negatives a binary search actually performs pay it.
 */
const BEAM_OFF = 65535;
// Tried in order, and the first CONCLUSIVE answer wins. The middle rung matters: unbeaming a
// module entirely can blow the visited-set budget and come back "truncated", which proves
// nothing at all -- crusher-gate does exactly that -- so a partial widening is often the
// strongest conclusive evidence available.
const BEAM_LADDER = [1024, BEAM_OFF];

function solveLoadedArena(opts = {}) {
  const F = require('./fastsim');
  const SETTINGS = require('./settings');
  const LADDER = require('./ladder');

  if (F.N_COIN !== 1) {
    throw new Error(`arena has ${F.N_COIN} coins; it must have exactly one, as the finish line`);
  }

  const runs = [];
  let exact = true; // did every negative that mattered come from an unbeamed search?
  const once = (rung, beamCap) => {
    const t0 = Date.now();
    const r = F.search({
      ...LADDER.searchOpts(rung),
      ...SETTINGS,
      beamCap,
      maxFrames: MODULE_FRAMES,
    });
    const out = {
      rung: rung.index,
      beamCap,
      reached: r.coinFrame[0] >= 0,
      complete: !r.stats.truncated && !r.stats.hitFrameLimit,
      beamRejected: r.stats.beamRejected,
      frames: r.coinFrame[0] >= 0 ? r.coinFrame[0] : null,
      visited: r.stats.visited,
      seconds: (Date.now() - t0) / 1000,
    };
    runs.push(out);
    return out;
  };

  /*
   * Escalate until the "no" is worth something.
   *
   * A positive at any beam width is final -- the search FOUND a trajectory, and no heuristic can
   * fake one. A negative is only worth as much as the search that produced it: exhausted with
   * nothing discarded is a proof, exhausted with states discarded is an upper bound, and
   * truncated is nothing. So widen the beam while the answer is merely an upper bound, keep the
   * best one seen, and stop the moment widening starts truncating -- past that point a wider
   * beam only makes the state space bigger and the answer weaker.
   */
  const clears = (rung) => {
    let bound = null; // a complete-but-beamed "no": real evidence, not a proof
    for (const cap of [SETTINGS.beamCap, ...(opts.fast ? [] : BEAM_LADDER)]) {
      const r = once(rung, cap);
      if (r.reached) return true;
      if (r.complete && r.beamRejected === 0) return false; // exhausted, nothing discarded
      if (r.complete) bound = r;                            // exhausted, but the beam had a hand
      else break;                                           // truncated: wider will only be worse
    }
    if (bound) {
      exact = false;
      return false;
    }
    return null; // nothing conclusive at any width
  };

  const res = LADDER.findMinRung(clears);
  let frames = null;
  if (res.minRung !== null) {
    const hit = runs.find((r) => r.rung === res.minRung && r.reached);
    frames = hit ? hit.frames : null;
  }
  return {
    minRung: res.minRung,
    combo: res.minRung === null ? null : LADDER.searchOpts(LADDER.RUNGS[res.minRung]),
    frames,
    // false => the rung is an UPPER BOUND: some negative was decided by a beamed search that had
    // thrown states away, so the module may be clearable lower down. Upper bounds are the safe
    // direction (a check labelled harder than it is comes available early, which cannot make a
    // seed unbeatable) but they are not what "solved" is supposed to mean.
    exact,
    probed: res.probed,
    unclearable: !!res.unclearable,
    unknownAt: res.unknownAt === undefined ? null : res.unknownAt,
    runs,
  };
}

// ---------------------------------------------------------------------------
// Parent mode
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const a = { files: [], flags: {} };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k.startsWith('--')) {
      const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      a.flags[k.slice(2)] = v;
    } else a.files.push(k);
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.flags.arena) {
    // Child. JU_MAP is already set by the parent; requiring fastsim here loads that arena.
    process.stdout.write(JSON.stringify(solveLoadedArena({ fast: !!args.flags.fast })));
    return;
  }

  // The parent must not require fastsim -- that would bind it to the vanilla map for the rest of
  // the process. settings.js is safe: with JU_MAP unset it reads no map.
  const SETTINGS = require('./settings');
  const { buildArena } = require('./arena');
  const { spawn } = require('child_process');

  let files = args.files;
  if (!files.length) {
    if (!fs.existsSync(MODULE_DIR)) {
      console.error(`no modules: ${MODULE_DIR} does not exist`);
      process.exitCode = 1;
      return;
    }
    files = fs
      .readdirSync(MODULE_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => path.join(MODULE_DIR, f));
  }
  if (!files.length) {
    console.error('no modules to solve');
    process.exitCode = 1;
    return;
  }

  let disagreements = 0;
  let unknowns = 0;
  let unplayed = 0;

  /*
   * How many modules to solve at once.
   *
   * Each module is already its own process -- fastsim derives its world from JU_MAP at require()
   * time, so one process can only ever solve one map -- which makes solving several at once free
   * of any coordination. Nothing is shared: each has its own arena file and writes only its own
   * module file.
   *
   * Within a module there is nothing to parallelise. findMinRung is a binary search, so each
   * probe decides which rung to try next; running them at once would mean running rungs nobody
   * needs.
   *
   * THE LIMIT IS MEMORY, NOT CORES. An unbeamed negative can hold tens of millions of states --
   * gap-wide's reaches 24M -- so each child gets a 6GB heap and four of them can genuinely
   * exhaust a machine. Sequential stays the default for that reason: raise it deliberately, and
   * lower it again if a run dies instead of answering.
   */
  const jobs = Math.max(1, Number(args.flags.jobs) || 1);

  const solveOne = (file) => new Promise((resolve) => {
    const mod = readModule(path.resolve(file), SETTINGS);
    const { id, map } = buildArena(mod);
    const arenaPath = path.join(ARENA_DIR, id + '.json');
    fs.mkdirSync(ARENA_DIR, { recursive: true });
    fs.writeFileSync(arenaPath, JSON.stringify(map, null, 1));

    const t0 = Date.now();
    const child = spawn(
      process.execPath,
      ['--max-old-space-size=6000', __filename, '--arena', arenaPath]
        .concat(args.flags.fast ? ['--fast'] : []),
      { cwd: __dirname, env: { ...process.env, JU_MAP: arenaPath } }
    );
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (status) =>
      resolve({ mod, arenaPath, status, out, err, seconds: (Date.now() - t0) / 1000 }));
  });

  // A pool rather than Promise.all, so --jobs really is a ceiling on concurrent children.
  /*
   * Report each module the moment it lands, not at the end.
   *
   * Collecting everything and printing it sorted reads better, and it was the first thing tried
   * -- but an unbeamed negative is minutes long, so a sorted report means a run that prints
   * nothing at all for ten minutes and then everything at once. Silence is indistinguishable
   * from a hang. Completion order it is; with --jobs 1 that is library order anyway.
   */
  let nextFile = 0;
  const worker = async () => {
    while (nextFile < files.length) report(await solveOne(files[nextFile++]));
  };

  function report(done) {
    const { mod, arenaPath, seconds } = done;
    if (done.status !== 0) {
      console.log(`FAIL ${mod.name}: ${(done.err || '').trim().split('\n').slice(-4).join(' | ')}`);
      process.exitCode = 1;
      return;
    }
    const res = JSON.parse(done.out);

    const roof = roofRung(mod, require('./ladder'));
    const expected = mod.expect && typeof mod.expect.minRung === 'number' ? mod.expect.minRung : null;
    // A module whose grade rides on a continuous quantity -- how wide a gap is, how tall a step
    // is -- cannot be predicted to the rung by hand, so it may declare how far off the estimate
    // is allowed to be, and say why in expect.why. A module gated by a discrete fact (an item
    // exists or it does not) declares 0 and must be exact.
    const tol = (mod.expect && mod.expect.tolerance) || 0;
    let verdict;
    if (res.minRung === null && res.unclearable) {
      verdict = 'UNCLEARABLE even at the top rung';
      disagreements++;
    } else if (res.minRung === null) {
      verdict = `UNKNOWN: rung ${res.unknownAt} neither reached the exit nor exhausted its state space`;
      unknowns++;
    } else if (expected === null) {
      verdict = 'no expect.minRung to compare against';
    } else if (res.minRung === expected) {
      verdict = 'matches expect';
    } else if (Math.abs(res.minRung - expected) <= tol) {
      verdict = `within tolerance ${tol} of expect (${expected})`;
    } else if (res.minRung > expected) {
      verdict = `HARDER than expect (${expected}) -- check the module does what you think`;
      disagreements++;
    } else {
      verdict =
        `EASIER than expect (${expected}) -- the dangerous direction; understand it before ` +
        'accepting it';
      disagreements++;
    }

    // The hand-play verdict is checked against THIS run's answer, not against the stored one:
    // if the solver has just moved, a verdict recorded below where it now sits has to be caught
    // here rather than surviving in the file as an answer.
    // A grade at or above the roof rung is not a grade, it is the roof.
    let roofNote = '';
    if (roof) {
      roofNote = `  [roof ${roof.climb}px up is reachable from rung ${roof.rung}` +
        (res.minRung !== null && res.minRung >= roof.rung
          ? ' -- AT OR BELOW THE SOLVED RUNG, so this module is graded on walking over it'
          : ', which caps how hard this module can ever grade') + ']';
      if (res.minRung !== null && res.minRung >= roof.rung) disagreements++;
    }

    let handNote = '';
    if (mod.handPlay && typeof mod.handPlay.minRung === 'number') {
      const hand = mod.handPlay.minRung;
      if (res.minRung !== null && hand < res.minRung) {
        handNote =
          `  [HAND-PLAY ${hand} IS BELOW THE SOLVED RUNG -- a person cleared what the ` +
          'simulator says is impossible; that is a physics bug, not a difficulty correction]';
        disagreements++;
      } else if (res.minRung !== null && hand > res.minRung) {
        handNote = `  [hand-play raises it to ${hand}: ${mod.handPlay.why || 'no reason recorded'}]`;
      } else {
        handNote = '  [hand-played, confirmed]';
      }
    } else if (res.minRung !== null) {
      handNote = '  [NOT hand-played: physically possible only]';
      unplayed++;
    }
    console.log(
      `${String(mod.name).padEnd(22)} minRung=${res.minRung === null ? '-' : res.minRung}` +
        ` expect=${expected === null ? '-' : expected}` +
        ` frames=${res.frames === null ? '-' : res.frames}` +
        ` probes=${res.probed.length} ${seconds.toFixed(1)}s  ${verdict}` +
        (res.exact === false ? '  [UPPER BOUND: the decisive negative still had the beam ' +
          'discarding states, so this rung may be higher than the truth]' : '') + `${handNote}${roofNote}`
    );

    if (args.flags.write && res.minRung !== null) {
      const stored = JSON.parse(fs.readFileSync(mod.file, 'utf8'));
      stored.solve = {
        hash: mod.hash,
        settings: SETTINGS,
        minRung: res.minRung,
        // Absent means exact. Present and false means the rung is an upper bound -- see BEAM_OFF.
        ...(res.exact === false ? { exact: false } : {}),
        combo: res.combo,
        frames: res.frames,
        arena: path.relative(ROOT, arenaPath).replace(/\\/g, '/'),
        solvedAt: new Date().toISOString().slice(0, 10),
      };
      // readModule already decided whether the stored handPlay still describes this module.
      // Writing that decision back is the point: a stale verdict left in the file would be read
      // as an answer by the next tool that opens it.
      if (mod.handPlay) stored.handPlay = mod.handPlay;
      else delete stored.handPlay;
      fs.writeFileSync(mod.file, JSON.stringify(stored, null, 1) + '\n');
    }

    if (!args.flags['keep-arenas'] && !args.flags.write) {
      // Arenas are cheap to rebuild, but they are the whole point of writing them out: the map
      // the solver actually solved, openable in the editor and playable in the game. Kept by
      // default; pass --drop-arenas only if the maps folder is in the way.
      if (args.flags['drop-arenas']) fs.unlinkSync(arenaPath);
    }
  }

  await Promise.all(Array.from({ length: Math.min(jobs, files.length) }, worker));

  if (disagreements || unknowns) {
    console.log(
      `\n${disagreements} disagreement(s), ${unknowns} unknown(s), ${unplayed} not hand-played`
    );
    process.exitCode = 1;
  } else if (unplayed) {
    // Not a failure: a module can be freshly written and not yet played. It is still worth
    // saying out loud, because "solved" reads as "trusted" and they are not the same thing.
    console.log(
      `\nall modules agree with their hand-written expectations; ${unplayed} still awaiting a hand-play pass`
    );
  } else {
    console.log('\nall modules agree with their expectations, and all are hand-played');
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e && e.stack ? e.stack : String(e));
    process.exitCode = 1;
  });
}

module.exports = {
  roofRung,
  readModule,
  moduleHash,
  geometryHash,
  effectiveMinRung,
  MODULE_DIR,
  ARENA_DIR,
  MODULE_FRAMES,
};
