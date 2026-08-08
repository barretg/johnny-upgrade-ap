// Live progress and ETA for a running sweep.
//
//   node progress.js            one snapshot
//   node progress.js --watch    refresh every 20s until the lattice is settled
//
// The ETA is not "remaining combos x average so far" -- combo cost varies by two orders of
// magnitude (median ~1s, worst ~136s) and the cheap ones get taken first, so a flat average is
// wildly optimistic near the end. Instead each unfinished combo is costed from the observed times
// of already-finished combos with similar Speed/Jump (the two dimensions that actually drive
// state-space size), and the total is divided by the parallelism the sweep is really achieving.

const fs = require('fs');
const path = require('path');
const A = require('./atlas');
const L = require('./locations');

function snapshot() {
  const known = A.loadAll();
  const all = A.allCombos();
  const u = A.undetermined(known, L.N_LOC);
  const settled = all.length - known.size - u.length;

  // Cost model: average seconds of finished combos near this (speed, jump), widening the
  // neighbourhood until something is in range.
  const cell = new Map();
  for (const { combo, result } of known.values()) {
    const k = combo.s + ',' + combo.j;
    if (!cell.has(k)) cell.set(k, []);
    cell.get(k).push(result.seconds || 0);
  }
  const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  function predict(c) {
    for (let r = 0; r <= 10; r++) {
      const acc = [];
      for (let ds = -r; ds <= r; ds++)
        for (let dj = -r; dj <= r; dj++) {
          const k = c.s + ds + ',' + (c.j + dj);
          if (cell.has(k)) acc.push(...cell.get(k));
        }
      // The gun arm carries ammo/kill bits in the dedup key, so it explores a bigger space.
      if (acc.length) return avg(acc) * ((c.g || 0) > 0 ? 2.0 : 1) * (c.e > 1 ? 1.2 : 1);
    }
    return 30;
  }

  // Throughput actually being achieved, measured from file mtimes rather than assumed from the
  // worker count -- workers die, machines throttle, and the last stretch is often less parallel.
  const times = [];
  for (const c of all) {
    const p = A.comboPath(c);
    try {
      times.push(fs.statSync(p).mtimeMs);
    } catch {
      /* not done yet */
    }
  }
  times.sort((a, b) => a - b);
  const now = Date.now();
  const recentCut = now - 5 * 60 * 1000;
  const recent = times.filter((t) => t >= recentCut).length;

  const cpuSpent = [...known.values()].reduce((t, v) => t + (v.result.seconds || 0), 0);
  const wall = times.length > 1 ? (times[times.length - 1] - times[0]) / 1000 : 0;
  const parallelism = wall > 0 ? Math.max(1, cpuSpent / wall) : 1;

  const remainingCpu = u.reduce((t, x) => t + predict(x.combo), 0);
  const etaMin = remainingCpu / parallelism / 60;

  return { known, all, u, settled, recent, cpuSpent, wall, parallelism, remainingCpu, etaMin, times };
}

function render() {
  const s = snapshot();
  const pct = ((s.all.length - s.u.length) / s.all.length) * 100;
  const bar = '#'.repeat(Math.round(pct / 2.5)).padEnd(40, '.');
  const stale = s.times.length ? (Date.now() - s.times[s.times.length - 1]) / 1000 : Infinity;

  console.log(`\n[${new Date().toLocaleTimeString()}]  ${bar}  ${pct.toFixed(1)}%`);
  console.log(
    `  combos   ${s.known.size} run + ${s.settled} settled by sandwiching = ` +
      `${s.all.length - s.u.length}/${s.all.length}   (${s.u.length} left)`
  );
  console.log(
    `  cpu      ${(s.cpuSpent / 60).toFixed(0)} min spent over ${(s.wall / 60).toFixed(0)} min wall ` +
      `-> ~${s.parallelism.toFixed(1)}x parallel`
  );
  console.log(`  recent   ${s.recent} combos finished in the last 5 min`);
  if (s.u.length === 0) {
    console.log('  ETA      done -- run report.js');
  } else {
    console.log(
      `  ETA      ~${s.etaMin.toFixed(0)} min  (${(s.remainingCpu / 60).toFixed(0)} cpu-min of work left)`
    );
    // The estimate assumes the remaining combos resemble finished ones of similar stats; the
    // expensive high-mobility tail is exactly where that is weakest, so flag it.
    const heavy = s.u.filter((x) => x.combo.s >= 8 && x.combo.j >= 8).length;
    if (heavy) console.log(`           (${heavy} of those are high-mobility combos -- the slow tail)`);
  }
  if (stale > 180 && s.u.length > 0) {
    console.log(`  WARNING  nothing written for ${(stale / 60).toFixed(0)} min -- are the workers alive?`);
  }
  return s.u.length === 0;
}

if (process.argv.includes('--watch')) {
  const tick = () => {
    if (render()) process.exit(0);
    setTimeout(tick, 20000);
  };
  tick();
} else {
  render();
}
