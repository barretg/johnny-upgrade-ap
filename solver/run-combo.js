// Worker: run ability combos and write the results into the atlas.
//
// Safe to launch as many of these at once as you have cores/RAM for. Each writes its own file,
// a combo already on disk is skipped, and each worker re-reads the atlas between combos, so
// parallel instances pick up each other's results and stop duplicating work.
//
//   node --max-old-space-size=4096 run-combo.js --spd 8 --jmp 4 --dj 0 --energy 2
//   node --max-old-space-size=4096 run-combo.js --loop            # keep taking work until done
//   node --max-old-space-size=4096 run-combo.js --loop --worker 3/8
//
// --worker i/n makes N workers take different slices of each planned batch.

const F = require('./fastsim');
const A = require('./atlas');
const L = require('./locations');
const SETTINGS = require('./settings');

function parseArgs(argv) {
  const a = {};
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith('--')) continue;
    const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
    a[k.slice(2)] = v;
  }
  return a;
}

function runOne(combo) {
  const existing = A.loadCombo(combo);
  if (existing) {
    console.log(`[skip] ${A.comboId(combo)} already in atlas`);
    return existing;
  }
  const t0 = Date.now();
  const r = F.search({
    spdTier: combo.s,
    jmpTier: combo.j,
    doubleJump: !!combo.d,
    energyTier: combo.e,
    ammoTier: combo.g || 0,
    ...SETTINGS,
  });
  const seconds = (Date.now() - t0) / 1000;

  const frames = new Array(L.N_LOC).fill(-1);
  for (let i = 0; i < F.N_COIN; i++) frames[i] = r.coinFrame[i];
  frames[L.GUN_INDEX] = r.gunFrame;
  frames[L.GATE_INDEX] = r.gateFrame;
  L.ROBOT_ENE_INDICES.forEach((eneIdx, n) => {
    frames[L.ROBOT_INDEX0 + n] = r.shotFrame[eneIdx];
  });

  // "complete" = the BFS exhausted its reachable state space unaided, with no truncation by the
  // frame budget or the visited-set capacity. Only a complete run can prove a location
  // UNreachable, so the atlas records the distinction and closure() respects it.
  const complete = !r.stats.truncated && !r.stats.hitFrameLimit;
  const result = { combo, frames, complete, stats: r.stats, seconds, settings: SETTINGS };
  A.saveCombo(combo, result);
  const found = frames.filter((f) => f >= 0).length;
  console.log(
    `[done] ${A.comboId(combo)} ${seconds.toFixed(0)}s reached=${found}/${L.N_LOC} ` +
      `complete=${complete} visited=${r.stats.visited} lastFrame=${r.stats.layers * SETTINGS.stride}`
  );
  return result;
}

function main() {
  const args = parseArgs(process.argv);
  A.saveSettings(SETTINGS);

  if (args.spd !== undefined) {
    runOne({ s: +args.spd, j: +args.jmp, d: +(args.dj || 0), e: +(args.energy || 1), g: +(args.ammo || 0) });
    return;
  }

  let wi = 0;
  let wn = 1;
  if (args.worker) [wi, wn] = args.worker.split('/').map(Number);
  const limit = args.n ? +args.n : args.loop ? Infinity : 1;

  for (let k = 0; k < limit; k++) {
    const known = A.loadAll();
    const batch = A.planBatch(known, L.N_LOC, wn * 3);
    const mine = batch.filter((_, idx) => idx % wn === wi);
    const pick = (mine[0] || batch[0] || null);
    if (!pick) {
      console.log('[idle] lattice fully determined -- nothing left to run');
      return;
    }
    runOne(pick.combo);
  }
}

if (require.main === module) main();
module.exports = { runOne };
