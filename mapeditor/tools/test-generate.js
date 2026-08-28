// The generated map's load-bearing claims, checked as geometry rather than trusted as intent.
//
//   node mapeditor/tools/test-generate.js
//
// The generator's whole argument is that a check's requirement is a FACT ABOUT THE LAYOUT: a gate
// is a hole in a wall, bands ascend from west to east, and nothing outside a module is dangerous.
// Each of those is a property of the object list, so each of them can be asserted. What cannot be
// asserted here is that the rungs are right -- that is solver/verify-map.js's job in Phase 6, and
// these tests exist so that when it disagrees, the layout is not what is in question.

const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const GM = require('./generate-map.js');
const ARENA = require(path.join(ROOT, 'solver', 'arena.js'));
const SM = require(path.join(ROOT, 'solver', 'solve-module.js'));
const SETTINGS = require(path.join(ROOT, 'solver', 'settings.js'));
const TIMER = require(path.join(ROOT, 'solver', 'timer.js'));
const LADDER = require(path.join(ROOT, 'solver', 'ladder.js'));
const fs = require('fs');

let fail = 0;
const eq = (a, b, m) => {
  const s = JSON.stringify(a), t = JSON.stringify(b);
  if (s !== t) { console.log('FAIL', m, '\n  got ', s, '\n  want', t); fail++; }
  else console.log('ok  ', m);
};
const ok = (c, m, extra) => {
  if (!c) { console.log('FAIL', m, extra === undefined ? '' : '  [' + extra + ']'); fail++; }
  else console.log('ok  ', m);
};

const MODDIR = path.join(ROOT, 'mapeditor', 'modules');
const modules = fs.readdirSync(MODDIR).filter((f) => f.endsWith('.json'))
  .map((f) => SM.readModule(path.join(MODDIR, f), SETTINGS));

// ---------------------------------------------------------------- a slot IS the arena
/*
 * The claim the band's requirement rests on: a module in the map is in the same box it was
 * solved in. Same ledges, same lethal pit, same headroom, same everything -- so the rung the
 * solver measured is a statement about the thing the player will meet.
 *
 * The one deliberate difference is the two doorways, which are cut out of the side walls. So the
 * comparison drops the side walls from both sides and checks them separately: the slot's wall
 * pieces must cover exactly the arena's wall, minus one opening of the stated height at ledge
 * level, and nothing else.
 */
for (const mod of modules) {
  const ar = ARENA.buildArena(mod);
  const slot = GM.buildSlot(mod, mod.entry.x, mod.entry.y); // same coordinates the arena uses
  const key = (o) => [Math.round(o.x), Math.round(o.y), Math.round(o.w), Math.round(o.h)].join(',');

  const arenaPlats = ar.map.plats.map(key).sort();
  const slotPlats = slot.objects.filter((o) => o.kind === 'plat').map(key).sort();
  const wallXs = new Set([Math.round(slot.x0), Math.round(slot.x1) - GM.G.wall]);
  const isWall = (s) => wallXs.has(Number(s.split(',')[0]));

  eq(slotPlats.filter((s) => !isWall(s)), arenaPlats.filter((s) => !isWall(s)),
     `${mod.name}: every platform except the side walls is the arena's, verbatim`);
  eq(slot.objects.filter((o) => o.kind === 'spike').map(key).sort(),
     ar.map.spikes.map(key).sort(), `${mod.name}: and so is the lethal floor`);

  // the walls, and the two holes in them
  for (const [side, wx, openAt] of [['entry', slot.x0, slot.entryY], ['exit', slot.x1 - GM.G.wall, slot.exitY]]) {
    // width filter: the floor, ceiling and spike slab all start at the same x as the left wall
    const pieces = slot.objects.filter((o) => o.kind === 'plat' &&
        Math.round(o.x) === Math.round(wx) && Math.round(o.w) === GM.G.wall)
      .map((o) => [o.y, o.y + o.h]).sort((a, b) => a[0] - b[0]);
    ok(pieces.length === 2, `${mod.name}: the ${side} wall is exactly two pieces`, pieces.length);
    if (pieces.length === 2) {
      const gap = [pieces[0][1], pieces[1][0]];
      eq([gap[1] - gap[0], gap[1] - openAt], [GM.G.doorway, 0],
         `${mod.name}: the ${side} doorway is ${GM.G.doorway}px tall and sits on the ledge`);
      eq([pieces[0][0], pieces[1][1]], [slot.yTop, slot.yBot],
         `${mod.name}: and the ${side} wall is otherwise solid, floor to ceiling`);
    }
  }
}

// ---------------------------------------------------------------- the map as a whole
const opts = { seed: 7, checks: 6, slack: 1.6, allowUnplayed: true, id: 'test', name: 'test' };
const res = GM.generate(opts);

ok(res.bands.length > 0, 'the generator produces bands from the library', res.bands.length);
eq(res.bands.map((b) => b.rung), res.bands.map((b) => b.rung).slice().sort((a, b) => a - b),
   'bands ascend by rung');
ok(res.bands.every((b, i) => i === 0 || b.x0 >= res.bands[i - 1].x1),
   'and ascend in space too -- band k is east of every band below it, which is what makes ' +
   'crossing its gate a precondition for reaching it');
ok(res.bands.every((b) => b.rung > (res.bands[res.bands.indexOf(b) - 1] || { rung: -1 }).rung),
   'no two bands share a rung');

for (const c of res.checks) {
  if (c.band === null) continue;
  const band = res.bands.find((b) => b.rung === c.band);
  ok(c.rung === band.rung && c.x >= band.x0 && c.x <= band.x1,
     `check "${c.name}" is inside its band and carries its rung`, `${c.x} vs ${band.x0}..${band.x1}`);
}

// ---------------------------------------------------------------- the clock
ok(res.bands.every((b) => b.timeTier <= TIMER.MAX_TIME_TIER),
   'no band needs more time than the game can sell');
ok(res.bands.every((b) => TIMER.framesAllowed(b.timeTier) >= b.framesEstimate),
   'and each band\'s tier really does cover its own estimate');
ok(res.bands.every((b, i) => i === 0 || b.timeTier >= res.bands[i - 1].timeTier),
   'a further band never needs less time than a nearer one');
eq(TIMER.timeTierForFrames(TIMER.framesAllowed(9)), 9,
   'timeTierForFrames is the inverse of framesAllowed at the boundary');
eq(TIMER.timeTierForFrames(TIMER.framesAllowed(9) + 1), 10, 'and one frame over needs one more tier');

// ---------------------------------------------------------------- determinism
const again = GM.generate(opts);
eq(JSON.stringify(again.map), JSON.stringify(res.map),
   'the same seed gives the same map, byte for byte -- otherwise a seed is not a seed');

// ---------------------------------------------------------------- coverage
eq(GM.coverageGaps(res.objects), [], 'the finished map contains one of every obstacle the SDK makes');
const stripped = res.objects.filter((o) => !(o.kind === 'ene' && o.typ === 'saw'));
eq(GM.coverageGaps(stripped), ['ene saw'], 'and the assertion notices when one is missing');

/*
 * The display case holds only what the map lacks. A conformance crusher next to a band already
 * gated by a crusher module is not free: every crusher costs the dedup key a factor of three,
 * on a map wide enough that the key is already tight.
 */
const crushers = res.objects.filter((o) => o.kind === 'plat' && o.stomper);
const gatedByCrusher = res.bands.some((b) => /crusher/.test(b.gate));
ok(crushers.length === 1, 'exactly one crusher in the map', crushers.length);
ok(!gatedByCrusher || crushers.length === 1,
   'and when a band is gated by a crusher module, the display case does not add a second');

// ---------------------------------------------------------------- provenance and the sidecar
const prov = res.map.meta.modules;
ok(Array.isArray(prov) && prov.length >= res.bands.length,
   'every module placed is recorded in meta.modules', prov && prov.length);
ok(prov.every((p) => typeof p.name === 'string' && Number.isInteger(p.minRung)),
   'with the name and rung it was placed for');
ok(res.objects.every((o) => o.solve === undefined && o.minRung === undefined),
   'and no difficulty metadata is written into an object');

// ---------------------------------------------------------------- library refusals
const lib = GM.loadLibrary({ allowUnplayed: false });
ok(lib.usable.every((m) => m.handPlayed),
   'without --allow-unplayed, only hand-played modules are used');
ok(lib.usable.every((m) => {
  const roof = SM.roofRung(modules.find((x) => x.name === m.name), LADDER);
  return !roof || m.rung < roof.rung;
}), 'and never one whose grade is really a measurement of its own roof');

console.log(fail ? `\n${fail} failure(s)` : '\nall ok');
process.exitCode = fail ? 1 : 0;
