// Does a generated map actually gate what its logic sidecar says it gates?
//
//   node verify-map.js ../mapeditor/maps/generated-1.json            # boundary rungs
//   node verify-map.js ../mapeditor/maps/generated-1.json --quick    # gate rungs only, half the runs
//   node verify-map.js <map> --rungs 1,5,6,8                         # exactly these rungs
//   node verify-map.js <map> --beam 0                                # beam off: negatives become proofs
//
// The generator grades a map BY CONSTRUCTION: a band's entrance is a module the solver graded at
// rung r, the band is sealed behind it, so everything in the band is claimed to need r. That is
// an argument about geometry, and an argument is not a measurement. This runs the assembled map
// through the same simulator the modules were graded with and asks the sidecar's claims directly.
//
// It exists because it already caught a real one: rung 8 reaching band 12's checks in
// generated-1, which turned out to be the beam bug in solve-module.js rather than a bad layout.
// A map is cheap to regenerate and expensive to hand-play, so this runs first.
//
// THREE FAILURES, AND THEY ARE NOT SYMMETRIC:
//
//   LEAK      a check was collected at a rung below the one its band claims. The run FOUND a
//             trajectory, so this is witnessed and always real. It means the map is less gated
//             than the sidecar says, and the sidecar is what becomes apworld logic -- so a leak
//             is a rule that would ship too strict, and the check comes free.
//   MISSING   a band's gate check was NOT collected at the band's own rung. The map may be
//             unbeatable at the rung the logic promises, which is the direction that ruins a
//             seed. But a not-found is only as good as the search that produced it (see the beam
//             note in solve-module.js), and this runs beamed by default, so treat it as a lead:
//             re-run that rung with --beam 0 before believing it.
//   LATE      the earliest frame a check could be collected is beyond what its band's time tier
//             allows. A lower bound over the allowance is real regardless of the beam.
//
// The frame numbers here are FIRST-REACH lower bounds: the search flies straight at a coin and
// ignores that a real run has to pick up everything else on the way. A route that fits here may
// still not fit in practice; a route that does not fit here cannot.

const fs = require('fs');
const path = require('path');

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

/**
 * Which rungs are worth running.
 *
 * A band claims "nothing in here before rung r". The two rungs that can falsify that are r-1
 * (must reach nothing in the band) and r (must reach the band's gate), so the boundary set is
 * exactly those. Every run judges every band at once, which is why this is a set of rungs and
 * not a matrix of band-by-rung.
 *
 * --quick drops the r-1 probes. That keeps the direction that catches an unbeatable map and
 * loses the direction that catches an over-strict one, which is the right half to keep when the
 * point is a fast gate in front of a hand-play session.
 */
function boundaryRungs(bands, quick) {
  const s = new Set();
  for (const b of bands) {
    s.add(b.rung);
    if (!quick && b.rung > 0) s.add(b.rung - 1);
  }
  return [...s].sort((x, y) => x - y);
}

function main() {
  const args = parseArgs(process.argv);
  const mapArg = args.files[0];
  if (!mapArg) {
    console.error(
      'usage: node verify-map.js <map.json> [--quick] [--rungs a,b,c] [--beam N] [--frames N]'
    );
    process.exitCode = 1;
    return;
  }
  const mapPath = path.resolve(process.cwd(), mapArg);
  if (!fs.existsSync(mapPath)) {
    console.error(`no such map: ${mapPath}`);
    process.exitCode = 1;
    return;
  }
  const logicPath = mapPath.replace(/\.json$/, '.logic.json');
  if (!fs.existsSync(logicPath)) {
    console.error(
      `no logic sidecar at ${logicPath}.\n` +
        'Only a generated map can be verified: the sidecar is the claim being tested, and ' +
        'without it there is nothing to hold the map against.'
    );
    process.exitCode = 1;
    return;
  }
  const logic = JSON.parse(fs.readFileSync(logicPath, 'utf8'));

  // Must happen before fastsim is required: fastsim derives its entire world from the map at
  // require() time, which is where its speed comes from and why one process holds one map.
  process.env.JU_MAP = mapPath;
  const F = require('./fastsim');
  const SETTINGS = require('./settings');
  const LADDER = require('./ladder');
  const TIMER = require('./timer');

  // The sidecar was written under one set of settings; this run uses whatever settings.js says
  // now. Say so rather than quietly comparing two different simulators -- that is the same class
  // of mistake the module hashes exist to prevent.
  if (logic.settings && logic.settings.physicsRev !== SETTINGS.physicsRev) {
    console.log(
      `WARNING: the sidecar was generated under physicsRev ${logic.settings.physicsRev}, this ` +
        `run is physicsRev ${SETTINGS.physicsRev}. Regenerate the map before trusting either.\n`
    );
  }

  // Map every sidecar check onto the index fastsim reports a frame for. Coins are matched by
  // exact position, because that is what the generator wrote and what the map still holds; a
  // near-miss match would silently grade the wrong coin, so an unmatched check is fatal.
  const coinAt = new Map();
  F.COINS.forEach((c) => coinAt.set(`${c.x},${c.y}`, c.i));
  const checks = [];
  for (const c of logic.checks) {
    if (c.kind === 'coin') {
      const i = coinAt.get(`${c.x},${c.y}`);
      if (i === undefined) {
        console.error(`sidecar check "${c.name}" at ${c.x},${c.y} matches no coin in the map`);
        process.exitCode = 1;
        return;
      }
      checks.push({ ...c, probe: (r) => r.coinFrame[i] });
    } else if (c.kind === 'colGun') {
      checks.push({ ...c, probe: (r) => r.gunFrame });
    } else if (c.kind === 'boss') {
      checks.push({ ...c, probe: (r) => r.gateFrame });
    } else {
      console.error(`sidecar check "${c.name}" is kind ${c.kind}, which this tool cannot probe`);
      process.exitCode = 1;
      return;
    }
  }

  const rungs = args.flags.rungs
    ? String(args.flags.rungs)
        .split(',')
        .map((s) => Number(s.trim()))
    : boundaryRungs(logic.bands, !!args.flags.quick);
  for (const r of rungs) {
    if (!Number.isInteger(r) || r < 0 || r >= LADDER.N_RUNGS) {
      console.error(`rung ${r} is not on the ladder (0..${LADDER.N_RUNGS - 1})`);
      process.exitCode = 1;
      return;
    }
  }

  // --beam 0 means "off", which for fastsim's Uint16Array counter is 65535: admit everything.
  const beamCap =
    args.flags.beam === undefined ? SETTINGS.beamCap : Number(args.flags.beam) || 65535;
  const maxFrames = Number(args.flags.frames) || SETTINGS.maxFrames;

  console.log(
    `${path.basename(mapPath)}: ${logic.bands.length} bands, ${checks.length} checks, ` +
      `rungs ${rungs.join(',')}, beamCap ${beamCap === 65535 ? 'off' : beamCap}\n`
  );

  const leaks = [];
  const missing = [];
  const late = [];
  let inconclusive = 0;

  for (const rungIndex of rungs) {
    const rung = LADDER.RUNGS[rungIndex];
    const t0 = Date.now();
    const res = F.search({ ...LADDER.searchOpts(rung), ...SETTINGS, beamCap, maxFrames });
    const secs = (Date.now() - t0) / 1000;
    const complete = !res.stats.truncated && !res.stats.hitFrameLimit;
    // The rule the whole pipeline runs on: only a search that exhausted with nothing discarded
    // may say something is unreachable. Anything less can still WITNESS a leak; it just cannot
    // deny one, and it cannot turn a missing gate into a fact.
    const denies = complete && res.stats.beamRejected === 0;
    if (!denies) inconclusive++;

    const perBand = new Map();
    for (const c of checks) {
      const frame = c.probe(res);
      const key = c.band === null || c.band === undefined ? 'pre' : c.band;
      const b = perBand.get(key) || { got: 0, total: 0 };
      b.total++;
      if (frame >= 0) b.got++;
      perBand.set(key, b);

      if (frame >= 0 && rungIndex < c.rung) leaks.push({ rung: rungIndex, check: c, frame });
      if (frame >= 0) {
        const allowed = TIMER.framesAllowed(c.timeTier);
        if (frame > allowed) late.push({ rung: rungIndex, check: c, frame, allowed });
      }
    }
    for (const b of logic.bands) {
      if (rungIndex < b.rung) continue;
      const gate = checks.find((c) => c.band === b.rung && c.module === b.gate);
      if (gate && gate.probe(res) < 0) missing.push({ rung: rungIndex, band: b, denies });
    }

    const cells = [...perBand.entries()]
      .map(([k, v]) => `${k === 'pre' ? 'pre' : 'b' + k}:${v.got}/${v.total}`)
      .join(' ');
    console.log(
      `rung ${String(rungIndex).padStart(2)} ${LADDER.label(rung).padEnd(30)} ${cells}` +
        `  ${secs.toFixed(1)}s` +
        (denies ? '' : '  [not exhaustive: a "not reached" here proves nothing]')
    );
  }

  console.log('');
  for (const l of leaks) {
    console.log(
      `LEAK    rung ${l.rung} collected "${l.check.name}" (band ${l.check.band}) on frame ` +
        `${l.frame} -- witnessed, so the map really is less gated than the sidecar claims`
    );
  }
  for (const m of missing) {
    console.log(
      `MISSING rung ${m.rung} did not reach band ${m.band.rung}'s gate "${m.band.gate}"` +
        (m.denies
          ? ' -- the search exhausted with nothing discarded, so this one is a proof'
          : ' -- but that search was beamed or truncated; re-run the rung with --beam 0 to settle it')
    );
  }
  for (const l of late) {
    console.log(
      `LATE    "${l.check.name}" is first reachable on frame ${l.frame}, but its time tier ` +
        `${l.check.timeTier} allows only ${l.allowed} -- and ${l.frame} is a lower bound`
    );
  }

  const bad = leaks.length + missing.length + late.length;
  if (bad) {
    console.log(`\n${leaks.length} leak(s), ${missing.length} missing, ${late.length} late`);
    process.exitCode = 1;
  } else if (inconclusive) {
    console.log(
      `no leak witnessed and every gate was reached, but ${inconclusive} of ${rungs.length} runs ` +
        'were beamed or truncated -- so "no leak" here is evidence, not proof (--beam 0 settles it)'
    );
  } else {
    console.log('every band gates exactly what the sidecar says it gates, and every run exhausted');
  }
}

if (require.main === module) main();

module.exports = { boundaryRungs };
