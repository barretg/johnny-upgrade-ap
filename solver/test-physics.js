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

console.log('spawn', P.SPAWN, 'stomper trigger band', P.STOMPER_TRIG_XMIN, P.STOMPER_TRIG_XMAX);

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
// seals the corridor.
console.log('\ncrusher escape (hold right from spawn):');
for (let t = 1; t <= 10; t++) {
  const cfg = P.makeConfig({ spdTier: t, jmpTier: 0, doubleJump: false });
  const tr = run(cfg, () => ({ dir: 1, jump: false }), 400);
  const last = tr[tr.length - 1];
  const trig = tr.findIndex((s) => s.stomperFall);
  console.log(
    `  spd${t}: dead=${!!last.dead} finalX=${last.x.toFixed(1)} triggerFrame=${trig} frames=${tr.length - 1}`
  );
}

// Laser cycle sanity.
console.log('\nlaser 0 active over 210 frames:',
  Array.from({ length: 210 }, (_, f) => (require('./physics').computeWorld(f).lasers[0].active ? '#' : '.')).join(''));
