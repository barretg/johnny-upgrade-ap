// Worker: run ability combos and write the results into the atlas.
//
// Safe to launch as many of these at once as you have cores/RAM for. Each writes its own file,
// a combo already on disk is skipped, and each worker re-reads the atlas between combos, so
// parallel instances pick up each other's results and stop duplicating work.
//
//   node --max-old-space-size=4096 run-combo.js --spd 8 --jmp 4 --dj 0 --energy 2
//   node --max-old-space-size=4096 run-combo.js --loop            # keep taking work until done
//   node run-combo.js --spawn 16                # spawn 16 workers, one tagged central log
//   node run-combo.js --spawn 16 --mem 4000     # ...with a smaller heap per worker
//   node --max-old-space-size=4096 run-combo.js --loop --worker 3/8   # one worker by hand
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
  // Never let a storage hiccup kill a worker -- the result is deterministic, so the worst case is
  // that some later worker recomputes this combo.
  let stored = false;
  try {
    stored = A.saveCombo(combo, result);
  } catch (e) {
    console.log(`[warn] ${A.comboId(combo)} could not be stored: ${e.message}`);
  }
  if (!stored) console.log(`[warn] ${A.comboId(combo)} not stored; it will be recomputed later`);
  const found = frames.filter((f) => f >= 0).length;
  console.log(
    `[done] ${A.comboId(combo)} ${seconds.toFixed(0)}s reached=${found}/${L.N_LOC} ` +
      `complete=${complete} visited=${r.stats.visited} lastFrame=${r.stats.layers * SETTINGS.stride}`
  );
  return result;
}

/**
 * Spawn N worker processes and funnel all of their output into one tagged stream.
 *
 * Each child is this same script with --loop --worker i/N, so they coordinate through the atlas
 * exactly as separate shells would -- this just saves opening N terminals and interleaves the
 * logs. Every line is prefixed with its worker id and mirrored to out/sweep.log.
 */
function spawnWorkers(n, mem, extra) {
  const { spawn } = require('child_process');
  const fs = require('fs');
  const path = require('path');
  A.ensureDirs();
  const logPath = path.join(A.OUT, 'sweep.log');
  const logFile = fs.createWriteStream(logPath, { flags: 'a' });
  const stamp = () => new Date().toISOString().slice(11, 19);

  function emit(tag, line) {
    if (!line) return;
    const out = `[${stamp()}] [${tag}] ${line}`;
    console.log(out);
    logFile.write(out + '\n');
  }

  emit('main', `spawning ${n} worker(s), ${mem}MB each -> ${logPath}`);
  let alive = n;
  const t0 = Date.now();

  for (let i = 0; i < n; i++) {
    const tag = 'w' + String(i).padStart(2, '0');
    const child = spawn(
      process.execPath,
      [`--max-old-space-size=${mem}`, __filename, '--loop', '--worker', `${i}/${n}`, ...extra],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    // Children emit whole lines; buffer partial ones so a tag never lands mid-line.
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const l of lines) emit(tag, l.trimEnd());
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => {
      if (buf) emit(tag, buf.trimEnd());
      alive--;
      emit('main', `${tag} exited (${code}); ${alive} still running`);
      if (alive === 0) {
        emit('main', `all workers done in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
        logFile.end();
      }
    });
  }

  // Ctrl-C should take the whole pool down, not orphan the children.
  process.on('SIGINT', () => {
    emit('main', 'interrupted -- stopping workers');
    process.exit(1);
  });
}

function main() {
  const args = parseArgs(process.argv);
  A.saveSettings(SETTINGS);

  if (args.spawn) {
    const n = +args.spawn;
    const passthrough = [];
    if (args.n) passthrough.push('--n', args.n);
    spawnWorkers(n, +(args.mem || 6000), passthrough);
    return;
  }

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
    // Falling back to batch[0] made every worker whose slice had emptied pile onto the SAME
    // combo -- wasted work, and two processes writing one result at once. Offset into whatever
    // is left by worker index instead, so they spread out as the queue drains.
    const pick = mine[0] || batch[wi % Math.max(1, batch.length)] || null;
    if (!pick) {
      console.log('[idle] lattice fully determined -- nothing left to run');
      return;
    }
    runOne(pick.combo);
  }
}

if (require.main === module) main();
module.exports = { runOne };
