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
  // Two estimates, because the honest answer is a range. Cost climbs steeply with speed and jump
  // and the expensive corner of the lattice is the LAST thing to be measured, so a neighbourhood
  // average is biased low there and the ETA creeps up as real data lands. Bracketing with the
  // neighbourhood max shows how much of the estimate is still extrapolation.
  function predict(c, pick) {
    for (let r = 0; r <= 10; r++) {
      const acc = [];
      for (let ds = -r; ds <= r; ds++)
        for (let dj = -r; dj <= r; dj++) {
          const k = c.s + ds + ',' + (c.j + dj);
          if (cell.has(k)) acc.push(...cell.get(k));
        }
      // The gun arm carries ammo/kill bits in the dedup key, so it explores a bigger space.
      if (acc.length) return pick(acc) * ((c.g || 0) > 0 ? 2.0 : 1) * (c.e > 1 ? 1.2 : 1);
    }
    return 30;
  }
  const measured = (c) => cell.has(c.s + ',' + c.j);

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

  // Parallelism over a RECENT window, not the whole run. Early on the sweep is all sub-second
  // combos and the per-combo atlas re-scan dominates, so a lifetime average badly understates
  // what the pool achieves once combos get expensive -- and it is the expensive ones that are
  // left. Fall back to the lifetime figure until the window has enough data.
  const WINDOW_MIN = 10;
  const winCut = now - WINDOW_MIN * 60 * 1000;
  let winCpu = 0;
  let winCount = 0;
  for (const c of all) {
    try {
      const st = fs.statSync(A.comboPath(c));
      if (st.mtimeMs >= winCut) {
        const r = known.get(A.comboId(c));
        if (r) {
          winCpu += r.result.seconds || 0;
          winCount++;
        }
      }
    } catch {
      /* not done yet */
    }
  }
  const winWall = Math.min(WINDOW_MIN * 60, wall);
  const parallelism =
    winCount >= 5 && winWall > 0
      ? Math.max(1, winCpu / winWall)
      : wall > 0
        ? Math.max(1, cpuSpent / wall)
        : 1;

  const max = (a) => Math.max(...a);
  const remainingCpu = u.reduce((t, x) => t + predict(x.combo, avg), 0);
  const remainingCpuHigh = u.reduce((t, x) => t + predict(x.combo, max), 0);
  const extrapolated = u.filter((x) => !measured(x.combo)).length;
  const etaMin = remainingCpu / parallelism / 60;
  const etaMinHigh = remainingCpuHigh / parallelism / 60;

  return {
    known, all, u, settled, recent, cpuSpent, wall, parallelism,
    remainingCpu, remainingCpuHigh, etaMin, etaMinHigh, extrapolated, times,
  };
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
      `-> ~${s.parallelism.toFixed(1)}x parallel (recent window)`
  );
  console.log(`  recent   ${s.recent} combos finished in the last 5 min`);
  if (s.u.length === 0) {
    console.log('  ETA      done -- run report.js');
  } else {
    console.log(
      `  ETA      ${s.etaMin.toFixed(0)}-${s.etaMinHigh.toFixed(0)} min  ` +
        `(${(s.remainingCpu / 60).toFixed(0)}-${(s.remainingCpuHigh / 60).toFixed(0)} cpu-min left)`
    );
    // Cost climbs steeply with speed/jump and that corner is measured last, so the low end is
    // biased optimistic and the printed ETA drifts up as those combos land. Say how much of the
    // estimate is still pure extrapolation rather than pretending to a single number.
    if (s.extrapolated) {
      console.log(
        `           ${s.extrapolated}/${s.u.length} left have no finished (speed,jump) peer yet --`
      );
      console.log('           the low end is optimistic and will drift up as they land.');
    }
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
