// Worker: run one ability combo (or a whole planned batch, one at a time) and write its result
// into the atlas. Safe to launch several of these concurrently -- each writes its own file, and
// a combo already on disk is skipped, so parallel instances just divide the work.
//
//   node run-combo.js --spd 8 --jmp 4 --dj 0
//   node run-combo.js --auto 5            # take the 5 most informative undetermined combos
//   node run-combo.js --shard 0/4         # take every 4th undetermined combo, starting at 0
//
// Reserve memory for the visited set: node --max-old-space-size=8192 run-combo.js ...

const fs = require('fs');
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
    console.log(`[skip] ${A.comboId(combo)} already in atlas (complete=${existing.complete})`);
    return existing;
  }
  const t0 = Date.now();
  const r = F.search({
    spdTier: combo.s,
    jmpTier: combo.j,
    doubleJump: !!combo.d,
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

  // "complete" means the BFS exhausted the reachable state space on its own -- no truncation by
  // the frame budget or the visited-set capacity. Only complete runs can prove a location
  // UNreachable, so the atlas records the distinction.
  const complete = !r.stats.truncated && !r.stats.hitFrameLimit;
  const result = {
    combo,
    frames,
    complete,
    stats: r.stats,
    seconds,
    settings: SETTINGS,
  };
  A.saveCombo(combo, result);
  const found = frames.filter((f) => f >= 0).length;
  console.log(
    `[done] ${A.comboId(combo)} ${seconds.toFixed(1)}s reached=${found}/${L.N_LOC} ` +
      `complete=${complete} visited=${r.stats.visited} layers=${r.stats.layers} peak=${r.stats.peak}`
  );
  return result;
}

function main() {
  const args = parseArgs(process.argv);
  A.saveSettings(SETTINGS);

  if (args.spd !== undefined) {
    runOne({ s: +args.spd, j: +args.jmp, d: +(args.dj || 0) });
    return;
  }

  let n = args.auto ? +args.auto : 1;
  let shard = null;
  if (args.shard) {
    const [i, total] = args.shard.split('/').map(Number);
    shard = { i, total };
    n = args.n ? +args.n : 1000;
  }

  for (let k = 0; k < n; k++) {
    const known = A.loadAll();
    let batch = A.planBatch(known, L.N_LOC, shard ? shard.total * 4 : 1);
    if (shard) batch = batch.filter((_, idx) => idx % shard.total === shard.i);
    if (batch.length === 0) {
      console.log('[idle] nothing undetermined left to run');
      return;
    }
    runOne(batch[0].combo);
  }
}

if (require.main === module) main();
module.exports = { runOne };
