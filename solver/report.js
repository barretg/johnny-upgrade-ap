// Turn the atlas into the deliverable: for every location, the Pareto-minimal set of stat
// permutations that reach it.
//
// A requirement point is (speed, jump, doubleJump, energy, ammo, time). The first five come from
// the combo; `time` is derived from that combo's minimum frame count via the game's own timer
// formula. Because a weaker combo takes longer, time trades off against the other stats -- which
// is exactly why a single tuple cannot describe a location and an antichain (an OR of ANDs) can.
//
// Each option is tagged with the route it needs, so rules.py can filter on yaml settings:
//   base   - no damage taken, no gun
//   damage - needs Energy >= 2, i.e. a damage boost is in logic
//   gun    - needs the gun plus Ammo >= N
//
//   node report.js         # out/requirements.json + out/logic.generated.txt
//   node report.js --py    # also out/generated_requirements.py

const fs = require('fs');
const path = require('path');
const F = require('./fastsim');
const A = require('./atlas');
const L = require('./locations');

// Pruning knobs: at most MAX_TERMS alternatives per location, stopping early once the kept
// options already admit COVERAGE of the players who can genuinely reach it.
const argOf = (n, dflt) => { const i = process.argv.indexOf('--' + n); return i > 0 ? +process.argv[i + 1] : dflt; };
const MAX_TERMS = argOf('terms', 4);
const COVERAGE = argOf('coverage', 0.98);

// Execution slack on the round timer.
//
// The solver plays optimally: it changes input every `stride` frames and never wastes one. A
// person does not, so a route the search finishes with two frames to spare is a route nobody can
// actually complete. Requiring the optimal frame count x this factor pushes those up a Time tier
// and keeps TAS-level timing out of logic entirely -- it is not a difficulty setting, it is the
// correction for the search being inhumanly efficient.
//
// Only ever raises a requirement, so it cannot make a seed unbeatable. Options that no longer fit
// inside Time tier 24 drop out via the existing `t === null` path, falling back to stronger stats.
const TIME_MARGIN = argOf('time-margin', 1.35);

const DIMS = ['s', 'j', 'd', 'e', 'g', 't'];
const le = (a, b) => DIMS.every((k) => a[k] <= b[k]);

/** Minimal elements under componentwise <=, deduped. */
function paretoMin(points) {
  const out = [];
  for (const p of points) {
    if (points.some((q) => q !== p && le(q, p) && DIMS.some((k) => q[k] < p[k]))) continue;
    if (out.some((q) => DIMS.every((k) => q[k] === p[k]))) continue;
    out.push(p);
  }
  return out.sort((a, b) => a.s - b.s || a.j - b.j || a.d - b.d || a.e - b.e || a.g - b.g || a.t - b.t);
}

const via = (p) => (p.g > 0 ? 'gun' : p.e > 1 ? 'damage' : 'base');

/**
 * Trim a full Pareto antichain down to something a human and a rule engine can both live with.
 *
 * The complete antichain is exact but unusable -- some locations have 29 alternatives, most of
 * them degenerate corners like "Speed 1 + Jump 10 + Double Jump + Time 6" (technically minimal:
 * crawl there slowly using a high-jump route). Dropping options can only make a rule STRICTER,
 * never admit a player who cannot actually get there, so pruning is safe in the direction that
 * matters.
 *
 * Choice of what to keep is a greedy set cover over the true player-state space: enumerate every
 * (combo, time tier) a player could actually hold and that genuinely reaches this location, then
 * repeatedly take the option covering the most still-uncovered states. That keeps the
 * broadly-useful routes and discards the corners, and reports exactly how much was given up.
 */
function simplify(options, states, maxTerms, coverageTarget) {
  if (options.length <= 1) return { kept: options, coverage: 1 };
  const admits = (o, st) =>
    st.s >= o.s && st.j >= o.j && st.d >= o.d && st.e >= o.e && st.g >= o.g && st.t >= o.t;
  const covered = new Uint8Array(states.length);
  const kept = [];
  let nCovered = 0;
  while (kept.length < maxTerms && nCovered < states.length) {
    let best = null;
    let bestGain = 0;
    for (const o of options) {
      if (kept.includes(o)) continue;
      let gain = 0;
      for (let i = 0; i < states.length; i++) if (!covered[i] && admits(o, states[i])) gain++;
      if (gain > bestGain) {
        bestGain = gain;
        best = o;
      }
    }
    if (!best) break;
    for (let i = 0; i < states.length; i++) if (!covered[i] && admits(best, states[i])) covered[i] = 1;
    nCovered += bestGain;
    kept.push(best);
    if (nCovered / states.length >= coverageTarget) break;
  }
  kept.sort((a, b) => a.s - b.s || a.j - b.j || a.d - b.d || a.e - b.e || a.g - b.g || a.t - b.t);
  return { kept, coverage: states.length ? nCovered / states.length : 1 };
}

function fmt(p) {
  const parts = [`Speed ${p.s}`];
  if (p.j > 0) parts.push(`Jump ${p.j}`);
  if (p.d) parts.push('Double Jump');
  if (p.e > 1) parts.push(`Energy ${p.e}`);
  if (p.g > 0) parts.push(`Gun AND Ammo ${p.g}`);
  if (p.t > 0) parts.push(`Time ${p.t}`);
  return '(' + parts.join(' AND ') + ')';
}

function main() {
  const known = A.loadAll();
  if (known.size === 0) {
    console.error('Atlas is empty. Run: node run-combo.js --loop');
    process.exit(1);
  }
  const { reach, frames } = A.closure(known, L.N_LOC);
  const combos = A.allCombos();
  const perLoc = [];
  let unknownPairs = 0;

  for (let i = 0; i < L.N_LOC; i++) {
    const pts = [];
    for (const c of combos) {
      const id = A.comboId(c);
      const st = reach.get(id)[i];
      if (st === 2) unknownPairs++;
      if (st !== 1) continue;
      // +1: update() runs clockCode before coinCode, and coinCode tests the position produced by
      // the PREVIOUS frame's movement. So a coin touched at position-frame f is only banked on
      // frame f+1, after the timer has ticked f+1 times. TIME_MARGIN then adds human slack on top.
      const t = F.timeTierForFrames(Math.ceil((frames.get(id)[i] + 1) * TIME_MARGIN));
      if (t === null) continue; // slower than Time tier 24 allows, so not actually doable
      pts.push({ s: c.s, j: c.j, d: c.d, e: c.e, g: c.g || 0, t });
    }
    // "Find the Gun" must not be gated on already owning the gun. The gun-arm runs start armed
    // (ldat.wpn persists across runs), so their answer for this one location is circular.
    const filtered = L.kinds[i] === 'gun' ? pts.filter((p) => p.g === 0) : pts;
    // Every seed force-starts with one Progressive Speed (see generate_early), so a Speed 0
    // option is really a Speed 1 option; normalising first lets it collapse against its twin.
    for (const p of filtered) if (p.s < 1) p.s = 1;
    const options = paretoMin(filtered).map((p) => ({ ...p, via: via(p) }));
    // What survives if damage boosting is switched off in the yaml.
    const noDamage = paretoMin(filtered.filter((p) => p.e === 1)).map((p) => ({ ...p, via: via(p) }));

    // Every player item-vector that genuinely reaches this location, used as the ground truth
    // the pruned rule is scored against.
    const states = [];
    for (const p of filtered) for (let t = p.t; t <= 24; t++) states.push({ ...p, t });
    const simple = simplify(options, states, MAX_TERMS, COVERAGE);
    const simpleNoDmg = simplify(
      noDamage,
      states.filter((st) => st.e === 1),
      MAX_TERMS,
      COVERAGE
    );

    perLoc.push({
      index: i,
      name: L.names[i],
      kind: L.kinds[i],
      x: L.kinds[i] === 'coin' ? F.COINS[i].x : null,
      y: L.kinds[i] === 'coin' ? F.COINS[i].y : null,
      reachable: options.length > 0,
      options: simple.kept,
      coverage: simple.coverage,
      fullOptions: options,
      noDamageOptions: simpleNoDmg.kept,
    });
  }

  A.ensureDirs();
  fs.writeFileSync(path.join(A.OUT, 'requirements.json'), JSON.stringify(perLoc, null, 1));

  const lines = [];
  lines.push('# Generated by solver/report.js -- do not hand-edit.');
  lines.push(`# Atlas coverage: ${known.size}/${combos.length} combos run.`);
  if (unknownPairs > 0) {
    lines.push(`# WARNING: ${unknownPairs} (combo, location) pairs still undetermined --`);
    lines.push('# run more combos (node run-combo.js --loop) before trusting this.');
  }
  lines.push('#');
  lines.push('# Tier counts are minimums (>=). "Energy N" = N hearts total, i.e. N-1 Progressive');
  lines.push('# Energy on top of the 1 heart every run starts with. "Ammo N" also implies having');
  lines.push('# found the gun. Options on one line are alternatives (OR).');
  lines.push('');

  for (const kind of ['gun', 'coin', 'robot', 'boss']) {
    const group = perLoc.filter((p) => p.kind === kind);
    if (!group.length) continue;
    lines.push(`=== ${kind.toUpperCase()} ===`);
    for (const p of group) {
      const where = p.x !== null ? ` @(${p.x},${p.y})` : '';
      lines.push(
        `${p.name}${where}: ` + (p.reachable ? p.options.map(fmt).join(' OR ') : 'UNREACHABLE')
      );
    }
    lines.push('');
  }
  fs.writeFileSync(path.join(A.OUT, 'logic.generated.txt'), lines.join('\n'));

  const reachable = perLoc.filter((p) => p.reachable);
  const lostWithoutDamage = reachable.filter((p) => p.noDamageOptions.length === 0);
  const cov=perLoc.filter(p=>p.reachable).map(p=>p.coverage);
  console.log(`pruning: max ${MAX_TERMS} terms/location, coverage target ${COVERAGE} -> mean coverage ${(cov.reduce((a,b)=>a+b,0)/cov.length*100).toFixed(1)}%, worst ${(Math.min(...cov)*100).toFixed(1)}%`);
  console.log(`locations ${L.N_LOC} | reachable ${reachable.length} | combos run ${known.size}/${combos.length}`);
  console.log(`undetermined (combo,location) pairs: ${unknownPairs}`);
  console.log(`locations that need a damage boost (no gun-only route): ${lostWithoutDamage.length}`);
  if (lostWithoutDamage.length) {
    console.log('  ' + lostWithoutDamage.slice(0, 12).map((p) => p.name).join(', ') +
      (lostWithoutDamage.length > 12 ? ', ...' : ''));
  }
  const buckets = new Map();
  for (const p of perLoc) {
    const key = p.reachable ? p.options.map(fmt).join(' OR ') : 'UNREACHABLE';
    buckets.set(key, (buckets.get(key) || 0) + 1);
  }
  console.log(`\ndistinct requirement classes: ${buckets.size}`);
  for (const [k, n] of [...buckets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
    console.log(`  ${String(n).padStart(4)}x  ${k}`);
  }
  console.log('\nwrote out/requirements.json and out/logic.generated.txt');
  if (process.argv.includes('--py')) writePython(perLoc, unknownPairs, known.size, combos.length);
}

function writePython(perLoc, unknownPairs, ran, total) {
  const py = [];
  py.push('"""Generated by solver/report.js -- do not hand-edit.');
  py.push('');
  py.push(`Atlas coverage: ${ran}/${total} combos; ${unknownPairs} undetermined (combo, location) pairs.`);
  py.push('');
  py.push('Each requirement is a list of alternatives (OR); each alternative is a dict of minimum');
  py.push('tiers (AND). Absent keys mean no requirement on that track.');
  py.push('  speed  Progressive Speed count');
  py.push('  jump   Progressive Jump Power count');
  py.push('  double Double Jump owned');
  py.push('  energy total hearts (1 = base, so N means N-1 Progressive Energy items).');
  py.push('         Any option with energy > 1 relies on a damage boost -- drop those options');
  py.push('         when the "damage boosts in logic" yaml setting is off.');
  py.push('  ammo   Progressive Ammo count; also implies CanReachLocation("Find the Gun")');
  py.push('  time   Progressive Time Limit count');
  py.push('  via    "base" | "damage" | "gun", the route this option depends on');
  py.push('"""');
  py.push('');
  const emit = (p) => {
    const o = { speed: p.s };
    if (p.j) o.jump = p.j;
    if (p.d) o.double = true;
    if (p.e > 1) o.energy = p.e;
    if (p.g) o.ammo = p.g;
    if (p.t) o.time = p.t;
    return (
      '{' +
      Object.entries(o)
        .map(([k, v]) => `"${k}": ${v === true ? 'True' : v}`)
        .join(', ') +
      '}'
    );
  };

  // 254 locations share only ~175 distinct requirement sets, so emit each set once and have
  // locations reference it by index. rules.py then builds each rule object once and shares it,
  // instead of reconstructing ~4,800 near-duplicate rule trees.
  const classes = [];
  const classIndex = new Map();
  const idOf = (p) => {
    if (!p.reachable) return -1;
    const key = JSON.stringify(p.options.map(emit));
    if (!classIndex.has(key)) {
      classIndex.set(key, classes.length);
      classes.push(p.options);
    }
    return classIndex.get(key);
  };
  const coinIds = perLoc.filter((p) => p.kind === 'coin').map(idOf);
  const robotIds = perLoc.filter((p) => p.kind === 'robot').map(idOf);
  const gunId = idOf(perLoc.find((p) => p.kind === 'gun'));
  const bossId = idOf(perLoc.find((p) => p.kind === 'boss'));

  py.push('# Each entry is one alternative set (OR); each dict inside is a set of minimums (AND).');
  py.push('REQUIREMENT_CLASSES: list[list[dict]] = [');
  classes.forEach((opts, i) => {
    py.push(`    # ${i}`);
    py.push(`    [${opts.map(emit).join(', ')}],`);
  });
  py.push(']');
  py.push('');
  const dumpIds = (name, ids, items) => {
    py.push(`${name}: list[int] = [`);
    ids.forEach((id, n) => py.push(`    ${id},  # ${items[n].name}`));
    py.push(']');
    py.push('');
  };
  dumpIds('COIN_REQUIREMENT_IDS', coinIds, perLoc.filter((p) => p.kind === 'coin'));
  dumpIds('ENEMY_REQUIREMENT_IDS', robotIds, perLoc.filter((p) => p.kind === 'robot'));
  py.push(`GUN_REQUIREMENT_ID = ${gunId}`);
  py.push(`BOSS_ARENA_REQUIREMENT_ID = ${bossId}`);
  py.push('');
  fs.writeFileSync(path.join(A.OUT, 'generated_requirements.py'), py.join('\n'));
  console.log('wrote out/generated_requirements.py');
}

if (require.main === module) main();
