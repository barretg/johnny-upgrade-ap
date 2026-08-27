// Sanity checks on the physics port: terminal speed, jump apex, the crusher escape window,
// and a plain "hold right from spawn" run.
const P = require('./physics');

function run(cfg, inputs, n) {
  let s = P.initialState(cfg);
  const trace = [s];
  for (let f = 1; f <= n; f++) {
    s = P.step(s, inputs(f, s), cfg);
    trace.push(s);
    if (s.dead) break;
  }
  return trace;
}

// The vanilla map has exactly one crusher; a map may have none, or several.
console.log(
  'spawn',
  P.SPAWN,
  'stomper trigger band',
  ...P.CRUSHERS.flatMap((c) => [c.trigXmin, c.trigXmax])
);

for (const t of [1, 5, 10]) {
  const cfg = P.makeConfig({ spdTier: t, jmpTier: 0, doubleJump: false });
  const tr = run(cfg, () => ({ dir: 1, jump: false }), 120);
  const last = tr[tr.length - 1];
  console.log(
    `spd${t}: accel=${cfg.spd.toFixed(2)} terminal=${(4 * cfg.spd).toFixed(2)} ` +
      `after ${tr.length - 1}f x=${last.x.toFixed(1)} vx=${last.vx.toFixed(2)} dead=${!!last.dead}`
  );
}

// Jump apex, measured on flat ground far from anything.
for (const j of [1, 3, 5, 10]) {
  const cfg = P.makeConfig({ spdTier: 1, jmpTier: j, doubleJump: false });
  const tr = run(cfg, (f) => ({ dir: 0, jump: f === 5 }), 100);
  const apex = Math.min(...tr.map((s) => s.y));
  console.log(`jmp${j}: jh=${cfg.jh.toFixed(1)} apex rise=${(360 - apex).toFixed(1)}px`);
  const cfg2 = P.makeConfig({ spdTier: 1, jmpTier: j, doubleJump: true });
  let peakSeen = false;
  const tr2 = run(cfg2, (f, s) => {
    let jump = f === 5;
    if (!peakSeen && f > 5 && s.vy >= 0) {
      jump = true;
      peakSeen = true;
    }
    return { dir: 0, jump };
  }, 120);
  const apex2 = Math.min(...tr2.map((s) => s.y));
  console.log(`      + double jump apex rise=${(360 - apex2).toFixed(1)}px`);
}

// Crusher: sprint right from spawn and see which speed tier clears x >= 720 before the slab
// seals the corridor. triggerFrame is the first crusher to arm, whichever one that is; a map
// with no crusher has nothing to report here.
if (P.CRUSHERS.length) {
  console.log('\ncrusher escape (hold right from spawn):');
  for (let t = 1; t <= 10; t++) {
    const cfg = P.makeConfig({ spdTier: t, jmpTier: 0, doubleJump: false });
    const tr = run(cfg, () => ({ dir: 1, jump: false }), 400);
    const last = tr[tr.length - 1];
    const trig = tr.findIndex((s) => s.crushers.some((c) => c.flag === 1));
    console.log(
      `  spd${t}: dead=${!!last.dead} finalX=${last.x.toFixed(1)} triggerFrame=${trig} frames=${tr.length - 1}`
    );
  }
}

// Laser cycle sanity. Skipped on a map with no lasers.
if (P.LASERS.length) {
  console.log('\nlaser 0 active over 210 frames:',
    Array.from({ length: 210 }, (_, f) => (P.computeWorld(f).lasers[0].active ? '#' : '.')).join(''));
}

// ---------------------------------------------------------------------------
// physics.js vs fastsim.js
// ---------------------------------------------------------------------------
// physics.js is the readable reference; fastsim.js is the typed-array version the sweep
// actually runs, and the two carry the same rules twice. Crusher state in particular now lives
// in both files, so step them frame-for-frame over pseudorandom input and check they agree.
//
// Held to the plain-movement case on purpose: 1 heart (any contact is fatal in both), no gun,
// no shooting. The knockback and recoil paths are settings-gated in fastsim and absent from the
// comparison, so this checks geometry, gravity, platforms and crushers, which is where the two
// files duplicate each other.
const FS = require('./fastsim');
const I = FS._internals;

function crossCheck(cfg, seed, frames) {
  I.buildWorld(frames + 8);
  let ps = P.initialState(cfg);
  const fsState = I.newState();
  // Cheap deterministic PRNG so a failure is reproducible from the seed alone.
  let r = seed >>> 0;
  const rnd = () => ((r = (r * 1103515245 + 12345) >>> 0) / 4294967296);
  for (let f = 1; f <= frames; f++) {
    const dir = [-1, 0, 1][Math.floor(rnd() * 3)];
    const jump = rnd() < 0.25;
    const next = P.step(ps, { dir, jump }, cfg);
    const rc = I.stepFrame(fsState, f, dir, jump ? 1 : 0, cfg.spd, cfg.jh === null ? 0 : cfg.jh, cfg.jumpMax, 0);
    const fsDead = rc === 1;
    if (next.dead || fsDead) {
      if (next.dead !== fsDead) return `frame ${f}: died in ${next.dead ? 'physics' : 'fastsim'} only`;
      return null; // both dead on the same frame: agreed, and there is nothing left to compare
    }
    const pairs = [
      ['x', next.x, fsState[I.S_X]],
      ['y', next.y, fsState[I.S_Y]],
      ['vx', next.vx, fsState[I.S_VX]],
      ['vy', next.vy, fsState[I.S_VY]],
      ['ju', next.ju, fsState[I.S_JU]],
    ];
    for (let c = 0; c < I.N_CR; c++) {
      pairs.push([`crusher${c}.y`, next.crushers[c].y, fsState[I.S_CR0 + c * 3]]);
      pairs.push([`crusher${c}.flag`, next.crushers[c].flag, fsState[I.S_CR0 + c * 3 + 2]]);
    }
    for (const [name, pv, fv] of pairs) {
      if (Math.abs(pv - fv) > 1e-9) return `frame ${f}: ${name} physics=${pv} fastsim=${fv}`;
    }
    ps = next;
  }
  return null;
}

console.log('\nphysics.js vs fastsim.js (1 heart, no gun):');
let mismatches = 0;
for (const t of [{ spdTier: 1, jmpTier: 1, doubleJump: false }, { spdTier: 5, jmpTier: 3, doubleJump: true },
                 { spdTier: 10, jmpTier: 10, doubleJump: true }, { spdTier: 3, jmpTier: 0, doubleJump: false }]) {
  const cfg = P.makeConfig(t);
  let bad = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const err = crossCheck(cfg, seed * 7919, 300);
    if (err) {
      if (bad === 0) console.log(`  spd${t.spdTier}/jmp${t.jmpTier}/dj${t.doubleJump ? 1 : 0} seed ${seed}: ${err}`);
      bad++;
      mismatches++;
    }
  }
  console.log(`  spd${t.spdTier}/jmp${t.jmpTier}/dj${t.doubleJump ? 1 : 0}: ${40 - bad}/40 runs agree`);
}
console.log(mismatches === 0 ? '  OK' : `  ${mismatches} MISMATCHES`);
if (mismatches) process.exitCode = 1;
