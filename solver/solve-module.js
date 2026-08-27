// Solve a module: which rung of the ladder first clears it?
//
//   node solve-module.js                          # every module in mapeditor/modules/
//   node solve-module.js mapeditor/modules/gap-wide-400.json
//   node solve-module.js --write                  # ...and store the answer in the module file
//   node solve-module.js --keep-arenas            # leave the arenas in mapeditor/maps/
//
// This is the cheap half of the "generate from known difficulty" idea. A full atlas sweep is
// hours times a dozen workers because it answers every combo against the whole map; a module is
// a few hundred frames in a box, and because the ladder is a chain, six runs settle it instead
// of thirty-seven. Solving a library once buys a generator that can grade a map by construction.
//
// The rules inherited from the rest of the solver, none of which are relaxed here:
//
//   * Only a run that EXHAUSTED its state space (complete) may say a rung is insufficient. A run
//     that hit its frame cap or filled its visited set proves nothing, and is reported as
//     unknown rather than guessed in either direction -- guessing "clears" is the direction that
//     produces an unbeatable map.
//   * settings.js is part of the answer. A solve record made under different settings is stale.
//   * The module's own objects are part of the answer too. Edit the geometry and the record is
//     dropped, because stale difficulty metadata is the one thing that can silently generate an
//     unbeatable map.
//   * "Physically possible" is not "humanly executable". A solved module still has to be played
//     by hand before it is trusted, exactly as the vanilla logic goes through
//     client/johnny-upgrade-logic-test.user.js and strip_failed.py.
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

/** What a solve record is an answer ABOUT: the geometry, the entry/exit, and the settings. */
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
  mod.hash = want;
  return mod;
}

// ---------------------------------------------------------------------------
// Child mode: fastsim is already pointed at one arena, so solve it and print the answer.
// ---------------------------------------------------------------------------
//
// A separate process per module is not laziness. fastsim.js derives its whole world from the map
// at require() time -- that top-level derivation is where its speed comes from -- so one process
// can only ever solve one map. Phase 7 will have to unpick that to run in a browser; until then,
// a child per arena is the honest way to do it.
function solveLoadedArena() {
  const F = require('./fastsim');
  const SETTINGS = require('./settings');
  const LADDER = require('./ladder');

  if (F.N_COIN !== 1) {
    throw new Error(`arena has ${F.N_COIN} coins; it must have exactly one, as the finish line`);
  }

  const runs = [];
  const clears = (rung) => {
    const t0 = Date.now();
    const r = F.search({
      ...LADDER.searchOpts(rung),
      ...SETTINGS,
      maxFrames: MODULE_FRAMES,
    });
    const reached = r.coinFrame[0] >= 0;
    const complete = !r.stats.truncated && !r.stats.hitFrameLimit;
    runs.push({
      rung: rung.index,
      reached,
      complete,
      frames: reached ? r.coinFrame[0] : null,
      visited: r.stats.visited,
      seconds: (Date.now() - t0) / 1000,
    });
    if (reached) return true;
    // Only an exhausted search may say "no".
    return complete ? false : null;
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

function main() {
  const args = parseArgs(process.argv);

  if (args.flags.arena) {
    // Child. JU_MAP is already set by the parent; requiring fastsim here loads that arena.
    process.stdout.write(JSON.stringify(solveLoadedArena()));
    return;
  }

  // The parent must not require fastsim -- that would bind it to the vanilla map for the rest of
  // the process. settings.js is safe: with JU_MAP unset it reads no map.
  const SETTINGS = require('./settings');
  const { buildArena } = require('./arena');
  const { spawnSync } = require('child_process');

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

  for (const file of files) {
    const mod = readModule(path.resolve(file), SETTINGS);
    const { id, map } = buildArena(mod);
    const arenaPath = path.join(ARENA_DIR, id + '.json');
    fs.mkdirSync(ARENA_DIR, { recursive: true });
    fs.writeFileSync(arenaPath, JSON.stringify(map, null, 1));

    const t0 = Date.now();
    const child = spawnSync(
      process.execPath,
      ['--max-old-space-size=4000', __filename, '--arena', arenaPath],
      { cwd: __dirname, env: { ...process.env, JU_MAP: arenaPath }, encoding: 'utf8', maxBuffer: 1 << 24 }
    );
    if (child.status !== 0) {
      console.log(`FAIL ${mod.name}: ${(child.stderr || '').trim().split('\n').slice(-4).join(' | ')}`);
      process.exitCode = 1;
      continue;
    }
    const res = JSON.parse(child.stdout);
    const seconds = (Date.now() - t0) / 1000;

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

    console.log(
      `${String(mod.name).padEnd(22)} minRung=${res.minRung === null ? '-' : res.minRung}` +
        ` expect=${expected === null ? '-' : expected}` +
        ` frames=${res.frames === null ? '-' : res.frames}` +
        ` probes=${res.probed.length} ${seconds.toFixed(1)}s  ${verdict}`
    );

    if (args.flags.write && res.minRung !== null) {
      const stored = JSON.parse(fs.readFileSync(mod.file, 'utf8'));
      stored.solve = {
        hash: mod.hash,
        settings: SETTINGS,
        minRung: res.minRung,
        combo: res.combo,
        frames: res.frames,
        arena: path.relative(ROOT, arenaPath).replace(/\\/g, '/'),
        solvedAt: new Date().toISOString().slice(0, 10),
      };
      fs.writeFileSync(mod.file, JSON.stringify(stored, null, 1) + '\n');
    }

    if (!args.flags['keep-arenas'] && !args.flags.write) {
      // Arenas are cheap to rebuild, but they are the whole point of writing them out: the map
      // the solver actually solved, openable in the editor and playable in the game. Kept by
      // default; pass --drop-arenas only if the maps folder is in the way.
      if (args.flags['drop-arenas']) fs.unlinkSync(arenaPath);
    }
  }

  if (disagreements || unknowns) {
    console.log(`\n${disagreements} disagreement(s), ${unknowns} unknown(s)`);
    process.exitCode = 1;
  } else {
    console.log('\nall modules agree with their hand-written expectations');
  }
}

if (require.main === module) main();

module.exports = { readModule, moduleHash, MODULE_DIR, ARENA_DIR, MODULE_FRAMES };
