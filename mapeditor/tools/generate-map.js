// Generate a full Johnny Upgrade level out of solved modules.
//
//   node mapeditor/tools/generate-map.js --list
//   node mapeditor/tools/generate-map.js --seed 1 --checks 6 --out mapeditor/maps/generated-1.json
//
// The idea the whole pipeline rests on: solving a candidate map is unaffordable (a full atlas
// sweep is hours times a dozen workers), so difficulty is not measured after the fact -- it is
// built in. Every obstacle in this map is a module that has already been solved against
// solver/ladder.js and, ideally, played by a person. The map is then laid out so that the rung a
// check needs is a fact about the layout rather than a claim about the physics.
//
// The layout, left to right:
//
//   [start]  [ band 1 ]  [ band 8 ]  [ band 12 ] ...  [ boss ]
//
// and a band is:
//
//   =gate slot=--corridor--=interior slot=--corridor--
//    ^ a module whose rung IS the band's        ^ coins, and modules of any lower rung
//
// Three properties do the work, and each is geometric rather than a promise:
//
//   1. A GATE IS A HOLE IN A WALL. Every module sits in its own sealed box -- the same box
//      solver/arena.js solved it in, same ledges, same lethal pit, same headroom -- and the only
//      openings are two doorways at ledge height, one in each side wall. There is no over, no
//      under and no around: to be east of a gate you have crossed it. That is why the band's rung
//      is the requirement for everything east of it.
//   2. BANDS ASCEND. Band k sits east of every band below it, so reaching it means having
//      crossed all of their gates too. The requirement for a check is therefore the rung of its
//      own band, not a union that has to be computed.
//   3. NOTHING OUTSIDE A MODULE IS DANGEROUS. Corridors are flat, sealed tubes at the walkway
//      height. A coin in a corridor is free to whoever got into the corridor, which is the
//      point: it inherits the gate's requirement exactly and adds nothing of its own.
//
// What this does NOT do is prove any of that -- Phase 6's verify-map.js runs the finished map at
// every rung and checks each location first becomes reachable where it was meant to. This file's
// job is to lay out something worth verifying, and to refuse to emit one it can already tell is
// wrong.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const LADDER = require(path.join(ROOT, 'solver', 'ladder.js'));
const SM = require(path.join(ROOT, 'solver', 'solve-module.js'));
const SETTINGS = require(path.join(ROOT, 'solver', 'settings.js'));
const ARENA = require(path.join(ROOT, 'solver', 'arena.js'));
const TIMER = require(path.join(ROOT, 'solver', 'timer.js'));
const MapFormat = require(path.join(ROOT, 'mapkit', 'mapformat.js'));

const MODULE_DIR = path.join(ROOT, 'mapeditor', 'modules');

/*
 * Geometry, in world pixels.
 *
 * The slot numbers are ARENA.DEFAULTS deliberately, not copies of them: a slot whose ledges or
 * pit differed from the arena the module was solved in would be a different question wearing the
 * same answer. Only the numbers with no arena counterpart live here.
 */
const G = {
  ...ARENA.DEFAULTS,
  doorway: 200,      // height of the opening cut in a slot wall, at ledge level
  corridorH: 620,    // inside height of a connecting tube -- more than the 506px top-rung jump,
                     // so no jump is ever clipped, and there is nothing in it to land on
  corridorMin: 900,  // shortest a corridor may be
  corridorPerCheck: 700, // how much floor each corridor coin gets to itself
  coinLift: 45,      // how far above the floor a coin floats (arena.js uses the same)
  bossRoom: 3000,
};

// ---------------------------------------------------------------------------
// The library
// ---------------------------------------------------------------------------
/*
 * Load every module and grade it.
 *
 * The grade is effectiveMinRung -- max(solve, handPlay) -- never the solved rung, because a
 * person having found a module harder than the simulator did is the more trustworthy of the two
 * numbers and is the whole reason hand-play exists.
 *
 * Three kinds of module are refused rather than used:
 *   * unsolved, or solved under different settings (readModule has already dropped that record) --
 *     an ungraded obstacle in a graded map is the exact thing this pipeline exists to avoid;
 *   * one with a reachable roof, which can be walked over instead of through. Inside a slot the
 *     wall seals the way over, so the roof cannot be used here -- but a module that grades on its
 *     roof was never measuring its own obstacle, and its rung is not a fact about it;
 *   * one never played by a person, unless --allow-unplayed says otherwise. The solver answers
 *     what is possible; a map is played by someone who has to do it.
 */
function loadLibrary(opts = {}) {
  const files = fs.readdirSync(MODULE_DIR).filter((f) => f.endsWith('.json'));
  const usable = [];
  const rejected = [];
  for (const f of files) {
    const mod = SM.readModule(path.join(MODULE_DIR, f), SETTINGS);
    const eff = SM.effectiveMinRung(mod);
    if (eff.rung === null) {
      rejected.push({ name: mod.name, why: 'unsolved (or solved under different settings)' });
      continue;
    }
    const roof = SM.roofRung(mod, LADDER);
    if (roof && eff.rung >= roof.rung) {
      rejected.push({ name: mod.name, why: `graded ${eff.rung}, but its roof is walkable from rung ${roof.rung}` });
      continue;
    }
    if (!opts.allowUnplayed && !mod.handPlay) {
      rejected.push({ name: mod.name, why: 'never hand-played -- pass --allow-unplayed to use it anyway' });
      continue;
    }
    usable.push({
      name: mod.name,
      rung: eff.rung,
      source: eff.source,
      frames: (mod.solve && mod.solve.frames) || null,
      tags: mod.tags || [],
      objects: mod.objects,
      entry: mod.entry,
      exit: mod.exit,
      size: mod.size,
      handPlayed: !!mod.handPlay,
    });
  }
  usable.sort((a, b) => a.rung - b.rung || a.name.localeCompare(b.name));
  return { usable, rejected };
}

// ---------------------------------------------------------------------------
// Seeded picking
// ---------------------------------------------------------------------------
// mulberry32: tiny, and the same seed has to give the same map on any machine or the seed is not
// a seed. Nothing here touches Math.random.
function rng(seed) {
  let a = (seed >>> 0) || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (rand, list) => list[Math.floor(rand() * list.length)];

/*
 * Pick something that is not already in this band, if the library can manage it.
 *
 * Four interior modules is only an improvement on three corridor coins if they are four
 * DIFFERENT rooms; the same ledge four times in a row is its own kind of boring, and with a
 * library of eight it is what uniform random picking gives you. Falls back to the whole pool
 * rather than failing, because a repeat is still better than a coin on a flat floor.
 */
function pickFresh(rand, list, used) {
  const fresh = list.filter((m) => !used.has(m.name));
  return pick(rand, fresh.length ? fresh : list);
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------
const plat = (x, y, w, h, extra) => Object.assign({ kind: 'plat', x, y, w, h }, extra || {});

/*
 * A camera area over exactly what it is given.
 *
 * scrollCode computes NaN outside an area, so a region nobody covered is a region that cannot be
 * played -- and the areas are the one part of a generated map that a purely geometric mistake
 * makes silently unplayable rather than visibly wrong. Measured off the objects rather than
 * guessed from the walkway height, because the slots are 3000px tall and the corridors are 800.
 */
function areaOver(objects, pad = 200) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const o of objects) {
    x0 = Math.min(x0, o.x); y0 = Math.min(y0, o.y);
    x1 = Math.max(x1, o.x + (o.w || 0)); y1 = Math.max(y1, o.y + (o.h || 0));
  }
  return { kind: 'area', x: x0 - pad, y: y0 - pad, w: x1 - x0 + 2 * pad, h: y1 - y0 + 2 * pad,
           xx: 400, yy: 300, xmin: 0, xmax: 0, ymin: 0, ymax: 0 };
}

/*
 * A module in its box.
 *
 * `atY` is where the module's ENTRY point lands in world space; the box is built around it the
 * way solver/arena.js builds an arena, and the module's own exit height carries the walkway on to
 * whatever comes next -- so a module that steps up leaves the level a step higher, exactly as a
 * hand-built level would.
 *
 * The two doorways are the only openings. Each is G.doorway tall and sits directly above its
 * ledge, so it is walked through rather than jumped through.
 */
function buildSlot(mod, atX, atY) {
  const dx = atX - mod.entry.x;
  const dy = atY - mod.entry.y;
  const objs = mod.objects.map((o) => ({ ...o, x: o.x + dx, y: o.y + dy }));
  for (const o of objs) {
    // patrol ranges and crusher trigger columns are absolute, so they move with the object
    if (typeof o.xmin === 'number') { o.xmin += dx; o.xmax += dx; }
    if (typeof o.ymin === 'number') { o.ymin += dy; o.ymax += dy; }
    if (typeof o.trigX === 'number') o.trigX += dx;
    if (typeof o.trigY === 'number') o.trigY += dy;
    if (typeof o.fallTo === 'number') o.fallTo += dy;
  }

  const entryY = atY;
  const exitY = mod.exit.y + dy;
  let top = Math.min(entryY, exitY);
  let bottom = Math.max(entryY, exitY);
  for (const o of objs) {
    top = Math.min(top, o.y);
    bottom = Math.max(bottom, o.y + (o.h || 0));
  }
  const xMin = atX - G.ledge;
  const xMax = mod.exit.x + dx + G.ledge;
  const yTop = top - G.headroom;
  const yBot = bottom + G.pit;

  const out = [];
  // Floor, and the spikes that make missing it fatal. A survivable pit under a gap module would
  // let anyone walk the bottom of the box from one doorway to the other.
  out.push(plat(xMin - G.wall, yBot, xMax - xMin + 2 * G.wall, G.wall));
  out.push({ kind: 'spike', x: xMin - G.wall, y: yBot - G.spikeHeight, w: xMax - xMin + 2 * G.wall, h: G.spikeHeight });
  out.push(plat(xMin - G.wall, yTop - G.wall, xMax - xMin + 2 * G.wall, G.wall));

  // side walls, each cut once at ledge height
  const wall = (x, openAt) => {
    out.push(plat(x, yTop, G.wall, openAt - G.doorway - yTop));
    out.push(plat(x, openAt, G.wall, yBot - openAt));
  };
  wall(xMin - G.wall, entryY);
  wall(xMax, exitY);

  out.push(plat(xMin, entryY, G.ledge, G.ledgeThickness));
  out.push(plat(mod.exit.x + dx, exitY, G.ledge, G.ledgeThickness));
  for (const o of objs) out.push(o);

  return {
    objects: out,
    x0: xMin - G.wall,
    x1: xMax + G.wall,
    entryY,
    exitY,
    yTop,
    yBot,
    outX: xMax + G.wall, // where the walkway continues on the far side of the box
    coin: { x: mod.exit.x + dx + G.coinOffsetX, y: exitY - G.coinOffsetY },
  };
}

/*
 * A flat sealed tube. Whatever is in here is free to whoever got in here -- that is the property
 * that lets a corridor coin inherit the band's requirement without being solved.
 */
function buildCorridor(x0, y, len) {
  return {
    objects: [
      plat(x0, y, len, G.ledgeThickness),
      plat(x0, y - G.corridorH - G.wall, len, G.wall),
    ],
    x0,
    x1: x0 + len,
    y,
    yTop: y - G.corridorH - G.wall,
    yBot: y + G.ledgeThickness,
  };
}

/*
 * Layout profiles, most generous first.
 *
 * The clock, not the geometry, is the binding constraint -- Johnny replays ONE map per round
 * against a countdown whose ceiling is 147 seconds, and a check nobody can reach in 147 seconds
 * is not a check. So the layout is TRIED rather than computed: lay the map out, price the walk
 * to the far end, and if the last band wants more time than the game can sell, throw it away and
 * lay it out tighter. That is the re-lay the plan called for, and it is why the number of
 * interior modules and the corridor lengths are a profile rather than constants.
 *
 * Compactness is spent in the order it hurts least: interior modules first (they are texture --
 * the gate is what grades the band), then corridor length (which is only walking).
 *
 * The generous end of the ladder was raised in 5c-1, from two interior modules to four, and its
 * corridors shortened rather than lengthened. The old top profile put one gate, two rooms and
 * three coins-on-a-flat-floor in a band, which is a level that is half walking; the point of a
 * band is the playing, and a corridor is the thing between two pieces of playing rather than
 * content in its own right. Where the clock or the library cannot afford that, the ladder still
 * walks down to exactly what it used to be.
 */
const PROFILES = [
  { interiors: 4, corridorMin: 600, perCheck: 400 },
  { interiors: 3, corridorMin: 600, perCheck: 400 },
  { interiors: 3, corridorMin: 900, perCheck: 700 },
  { interiors: 2, corridorMin: 900, perCheck: 700 },
  { interiors: 1, corridorMin: 900, perCheck: 700 },
  { interiors: 1, corridorMin: 700, perCheck: 500 },
  { interiors: 0, corridorMin: 700, perCheck: 500 },
  { interiors: 0, corridorMin: 500, perCheck: 350 },
];
const MAX_TIME_TIER = TIMER.MAX_TIME_TIER;

// ---------------------------------------------------------------------------
// The build
// ---------------------------------------------------------------------------
/*
 * Lay out the whole map, or report that this profile cannot fit the clock.
 */
function layout(opts, profile) {
  const { usable, rejected } = loadLibrary(opts);
  if (!usable.length) {
    throw new Error('no usable modules:\n  ' + rejected.map((r) => `${r.name}: ${r.why}`).join('\n  '));
  }
  const rand = rng(opts.seed);
  const byRung = new Map();
  for (const m of usable) {
    if (!byRung.has(m.rung)) byRung.set(m.rung, []);
    byRung.get(m.rung).push(m);
  }
  const bandRungs = [...byRung.keys()].sort((a, b) => a - b);

  const objects = [];
  const checks = [];
  const bands = [];
  const provenance = [];
  let x = 0;
  let y = 0;
  /*
   * The two halves of the walk to the far end, kept apart because they price differently.
   *
   * Corridor pixels are walked at whatever speed the run has, so they are divided by the
   * terminal speed of the BAND being priced -- a run that reaches band 20 walks the whole spine
   * at rung 20. Module frames are the solver's own count, measured at that module's minimum
   * rung, which is the slowest a run can possibly be through it; a run at a higher rung is
   * faster and this over-counts. Over-counting is the safe direction here: it buys a bigger
   * timer than needed, where under-counting would put a check behind a clock that cannot reach
   * it.
   */
  let corridorPx = 0;
  let moduleFrames = 0;

  const terminal = (rung) => 5 * LADDER.moveAccel(LADDER.RUNGS[rung].speed);
  const addCheck = (c) => { checks.push(c); objects.push({ kind: 'coin', x: c.x, y: c.y, w: 0, h: 0 }); };

  // --- the start: somewhere to stand, the gun pickup, and the display case
  const start = buildCorridor(x, y, 2400);
  objects.push(...start.objects);
  objects.push({ kind: 'sprt', x: x + 200, y: y - 1, w: 0, h: 0, xx: 1 });
  objects.push({ kind: 'colGun', x: x + 1500, y: y - 60, w: 0, h: 0 });
  /*
   * The gun sits 1300px along the start corridor, and that walk costs frames like any other.
   *
   * It used to be written down as rung 0, time tier 0, which is wrong twice over: rung 0 has
   * moveAccel 0, so it cannot walk anywhere at all, and tier 0 is 3 seconds -- 120 frames for a
   * 1300px walk that verify-map.js measures at 310. Both numbers were placeholders that read as
   * answers. Rung 1 is the first rung that can move; price the walk at rung 1's terminal speed
   * with the same slack every other check gets.
   */
  const gunX = x + 1500;
  const gunFrames = Math.round(((gunX - (x + 200)) / terminal(1)) * opts.slack);
  const gunTier = TIMER.timeTierForFrames(gunFrames);
  if (gunTier === null) return { overrun: { rung: 1, timeTier: 'above ' + MAX_TIME_TIER, frames: gunFrames } };
  checks.push({ name: 'Find the Gun', kind: 'colGun', x: gunX, y: y - 60, band: null, rung: 1,
                timeTier: gunTier });
  const vitrineAt = { x: x + 400, y: start.yBot + 900 };
  // The start corridor is walked by every run on the way to every band, so it is spine like any
  // other corridor. Leaving it out under-priced band 1 by 2400px -- 480 frames at rung 1 -- and
  // under-pricing the clock is the direction that puts a check behind a timer that cannot reach
  // it. verify-map.js found this as a LATE on the last coin of band 1.
  corridorPx += 2400;
  x = start.x1;

  // --- one band per rung the library can gate
  for (const rung of bandRungs) {
    const bandFirstObject = objects.length;
    const gate = pick(rand, byRung.get(rung));
    const interiorPool = usable.filter((m) => m.rung <= rung && m.name !== gate.name);
    // what this band has already used, so the interiors are four different rooms
    const usedHere = new Set([gate.name]);
    const bandX0 = x;
    const bandChecks = [];
    const speed = terminal(rung);

    const slot = buildSlot(gate, x + G.wall + G.ledge, y);
    objects.push(...slot.objects);
    provenance.push({ name: gate.name, x: slot.x0, y: slot.entryY, minRung: gate.rung });
    moduleFrames += gate.frames || 600;
    y = slot.exitY;
    x = slot.outX;
    bandChecks.push({ name: `${gate.name} cleared`, kind: 'coin', module: gate.name,
                      x: slot.coin.x, y: slot.coin.y });

    // How the band's checks are divided: the gate's coin, then up to two interior modules each
    // carrying one, then corridor coins for the rest.
    const want = Math.max(1, opts.checks);
    /*
     * `want - 1` because the gate's own coin is one of them: a band CAN be nothing but modules,
     * with no corridor coin at all. The cap used to be `want - 2`, which reserved one check for a
     * coin on a flat floor no matter what -- there is no reason a band needs one, and with a
     * small check count that reservation was the difference between a room and a corridor.
     */
    const interiors = Math.min(interiorPool.length, Math.max(0, Math.min(profile.interiors, want - 1)));
    let remaining = want - 1 - interiors;

    for (let i = 0; i <= interiors; i++) {
      const here = i === interiors ? remaining : Math.ceil(remaining / (interiors - i + 1));
      remaining -= here;
      const len = profile.corridorMin + here * profile.perCheck;
      const cor = buildCorridor(x, y, len);
      objects.push(...cor.objects);
      for (let c = 0; c < here; c++) {
        const cx = x + profile.corridorMin / 2 + (c + 0.5) * profile.perCheck;
        bandChecks.push({ name: `Rung ${rung} corridor coin ${c + 1}`, kind: 'coin',
                          x: Math.round(cx), y: y - G.coinLift });
      }
      corridorPx += len;
      x = cor.x1;

      if (i < interiors) {
        const inner = pickFresh(rand, interiorPool, usedHere);
        usedHere.add(inner.name);
        const s = buildSlot(inner, x + G.wall + G.ledge, y);
        objects.push(...s.objects);
        provenance.push({ name: inner.name, x: s.x0, y: s.entryY, minRung: inner.rung });
        moduleFrames += inner.frames || 600;
        y = s.exitY;
        x = s.outX;
        bandChecks.push({ name: `${inner.name} cleared (rung ${rung} band)`, kind: 'coin',
                          module: inner.name, x: s.coin.x, y: s.coin.y });
      }
    }

    /*
     * The timer.
     *
     * Johnny replays ONE map per round against a countdown, so a check is not reachable merely
     * because a route exists -- the route has to fit in the clock. The formula is the game's and
     * lives in solver/timer.js; the hard ceiling is tier 24, 147 seconds.
     *
     * The estimate is deliberately crude and deliberately pessimistic: module frames come from
     * the solver's own run at that module's MINIMUM rung, the slowest a run through it can be,
     * corridors are walked at terminal speed with no credit for acceleration, and the slack
     * factor covers everything a straight line does not. Over-estimating buys a bigger timer
     * than needed; under-estimating puts a check behind a clock that cannot reach it.
     */
    const frames = Math.round((corridorPx / speed + moduleFrames) * opts.slack);
    const timeTier = TIMER.timeTierForFrames(frames);
    if (timeTier === null) {
      return { overrun: { rung, timeTier: 'above ' + MAX_TIME_TIER, frames } };
    }
    for (const c of bandChecks) {
      c.band = rung;
      c.rung = rung;
      c.timeTier = timeTier;
      addCheck(c);
    }
    bands.push({ rung, x0: bandX0, x1: x, gate: gate.name, checks: bandChecks.length, timeTier,
                 framesEstimate: frames });
    objects.push(areaOver(objects.slice(bandFirstObject)));
  }

  // --- the ending: gate, door, arena
  const bossFirstObject = objects.length;
  const boss = buildCorridor(x, y, G.bossRoom);
  objects.push(...boss.objects);
  objects.push({ kind: 'bossGate', x: x + 300, y: y - 400, w: 200, h: 400 });
  objects.push({ kind: 'door', x: x + 900, y: y - 500, w: 100, h: 500, trigger: 'boss', closeTo: y - 500 });
  objects.push({ kind: 'bossRange', x: x + 1200, y: y - 900, w: 1600, h: 900 });
  objects.push(areaOver(objects.slice(bossFirstObject)));

  // --- the start has no camera area yet, and the vitrine is under it
  objects.push(areaOver(start.objects));

  /*
   * The display case goes in LAST, holding only what the map does not already have.
   *
   * Building it blind was worse than redundant. Every crusher costs the solver a factor of 3 in
   * a dedup key that is already tight on a map this wide, so a conformance stomper sitting in a
   * sealed box next to a band gated BY a crusher module was buying nothing and spending the
   * budget that verifying the map runs on.
   */
  const vitrineKinds = coverageGaps(objects);
  const displayed = vitrine(vitrineAt.x, vitrineAt.y, vitrineKinds);
  objects.push(...displayed);

  const missing = coverageGaps(objects);
  if (missing.length) throw new Error('coverage assertion failed, nothing supplied: ' + missing.join(', '));

  let yBot = -Infinity;
  for (const o of objects) yBot = Math.max(yBot, o.y + (o.h || 0));

  const map = MapFormat.toGame({
    meta: {
      id: opts.id,
      name: opts.name,
      generatedBy: 'mapeditor/tools/generate-map.js',
      seed: opts.seed,
      bands,
      modules: provenance,
    },
    yEnd: Math.round(yBot + 400),
    objects,
  });
  return { map, objects, checks, bands, rejected, usable, bandRungs, profile };
}

/*
 * Lay it out, tightening until it fits the clock.
 */
function generate(opts) {
  const tried = [];
  for (const profile of PROFILES) {
    const res = layout(opts, profile);
    if (!res.overrun) return { ...res, tried, profile };
    tried.push({ profile, ...res.overrun });
  }
  const last = tried[tried.length - 1];
  throw new Error(
    `no layout fits the clock. The tightest tried still needs ${last.frames} frames to reach ` +
    `band ${last.rung}, which is ${last.timeTier} -- the game's maximum is ` +
    `${MAX_TIME_TIER} (${TIMER.timerSeconds(MAX_TIME_TIER)}s, ${TIMER.framesAllowed(MAX_TIME_TIER)} frames).
` +
    'The spine is simply longer than a round: ask for fewer checks per band (--checks), or ' +
    'accept a lower slack factor (--slack) if the estimate is the thing that is wrong.'
  );
}

/*
 * The display case.
 *
 * The coverage assertion wants the generated map to contain one of every obstacle the SDK can
 * make, so that a custom level exercises every path through iniLevel() rather than only the ones
 * the module library happens to use. But an obstacle dropped on the spine is an UNGRADED
 * obstacle, and this whole pipeline exists so that no such thing is in the map.
 *
 * So they go in a sealed box under the start corridor: created by the game, ticked by the game,
 * reachable by nobody. It is not scenery and it is not a puzzle -- it is a conformance fixture
 * that happens to live in the level.
 *
 * `want` is the list of kinds the map turned out not to contain, so a band already gated by a
 * crusher does not get a second one in here.
 */
function vitrine(x, y, want) {
  const need = new Set(want);
  const w = 1800, h = 700;
  const box = [
    plat(x, y + h, w, G.wall),
    plat(x, y - G.wall, w, G.wall),
    plat(x - G.wall, y - G.wall, G.wall, h + 2 * G.wall),
    plat(x + w, y - G.wall, G.wall, h + 2 * G.wall),
  ];
  const exhibits = [
    ['plat semi', plat(x + 100, y + 400, 300, 20, { semi: 1 })],
    ['plat stomper', plat(x + 500, y + 200, 200, 100,
      { stomper: 1, fallTo: y + 500, trigX: x + 500, trigW: 200, trigY: y })],
    ['platMove', { kind: 'platMove', x: x + 900, y: y + 500, w: 0, h: 0, xx: 2, yy: 0,
      xmin: x + 900, xmax: x + 1300, ymin: y + 500, ymax: y + 500 }],
    ['bomb', { kind: 'bomb', x: x + 200, y: y + 550, w: 0, h: 0, xxsi: 0, yysi: 0, xmax: 0, ymax: 0 }],
    ['laser horizontal', { kind: 'laser', x: x + 1450, y: y + 120, w: 0, h: 0, horizontal: 1,
      length: 300, ctMax: 120, ctSwitch: 60, ctCurr: 120 }],
    ['laser upright', { kind: 'laser', x: x + 1650, y: y + 300, w: 0, h: 0, horizontal: 0,
      length: 180, ctMax: 120, ctSwitch: 60, ctCurr: 30 }],
    ['ene saw', { kind: 'ene', x: x + 1200, y: y + 601, w: 0, h: 0, typ: 'saw', xx: 0, yy: 0,
      xmin: x + 1200, xmax: x + 1200, ymin: y + 601, ymax: y + 601 }],
    ['ene robot', { kind: 'ene', x: x + 1000, y: y + 601, w: 0, h: 0, typ: 'robot', xx: 0, yy: 0,
      xmin: x + 1000, xmax: x + 1000, ymin: y + 601, ymax: y + 601 }],
    ['spike', { kind: 'spike', x: x + 700, y: y + 640, w: 120, h: 60 }],
  ].filter(([k]) => need.has(k)).map(([, o]) => o);
  return exhibits.length ? box.concat(exhibits) : [];
}

/*
 * What the map must contain, checked on the finished object list rather than assumed from what
 * was placed. A generated level is the only test some of these code paths ever get.
 */
const REQUIRED = [
  ['plat', (o) => o.kind === 'plat' && !o.semi && !o.stomper],
  ['plat semi', (o) => o.kind === 'plat' && o.semi],
  ['plat stomper', (o) => o.kind === 'plat' && o.stomper],
  ['platMove', (o) => o.kind === 'platMove'],
  ['spike', (o) => o.kind === 'spike'],
  ['bomb', (o) => o.kind === 'bomb'],
  ['laser horizontal', (o) => o.kind === 'laser' && o.horizontal],
  ['laser upright', (o) => o.kind === 'laser' && !o.horizontal],
  ['ene saw', (o) => o.kind === 'ene' && o.typ === 'saw'],
  ['ene robot', (o) => o.kind === 'ene' && o.typ === 'robot'],
  ['door', (o) => o.kind === 'door'],
  ['area', (o) => o.kind === 'area'],
  ['coin', (o) => o.kind === 'coin'],
  ['colGun', (o) => o.kind === 'colGun'],
  ['bossGate', (o) => o.kind === 'bossGate'],
  ['bossRange', (o) => o.kind === 'bossRange'],
];
const coverageGaps = (objects) => REQUIRED.filter(([, t]) => !objects.some(t)).map(([n]) => n);

/*
 * Spike auto-texturing used to live here: a coarse column tiling of hazard_surface over every
 * spike rect, copied from arena.js, on the grounds that spikes are not drawn by the runtime and
 * an untextured map's only lethal surfaces are invisible.
 *
 * Removed. The generator's output is a starting point that gets textured by hand in the editor,
 * and the editor now stamps a hazard tile filling its grid cell exactly -- so the coarse version
 * was not a head start, it was art to delete before the real art could go in. arena.js keeps its
 * copy, because an arena is thrown away after one hand-play and nobody ever textures one.
 */

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
/*
 * The key is read BEFORE the value is consumed.
 *
 * It used to be read after -- `a[argv[i]...] = v` with `i` already advanced past the value by
 * `argv[++i]` -- so every flag that takes one was filed under its own VALUE and never seen:
 * `--seed 3` set `a['3']`, and `opts.seed` fell back to 1. Boolean flags worked, because nothing
 * moved `i`, which is why `--list` and `--allow-unplayed` behaved and nothing looked wrong.
 *
 * Everything shipped so far was generated at the defaults whatever was typed. That happens to be
 * what was wanted -- seed 1, six checks -- so it produced no visible symptom until `--out` was
 * asked to write somewhere other than the map it would have overwritten anyway.
 */
function parseArgs(argv) {
  const a = {};
  for (let i = 2; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].replace(/^--/, '');
    a[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return a;
}

function main() {
  const a = parseArgs(process.argv);
  const opts = {
    seed: Number(a.seed || 1),
    /*
     * Three, not six.
     *
     * The clock is the binding constraint on this map, not the geometry, and checks per band is
     * the only knob that really moves it: every extra check is another stretch of corridor on the
     * spine, and the spine is what has to be walked inside 147 seconds. What that buys, measured
     * on the eight-module library at seed 1:
     *
     *     --checks 2   17 checks   15 inside a module   the densest layout, first choice
     *     --checks 3   25 checks   15 inside a module
     *     --checks 4   33 checks    8 inside a module   clock refuses every interior module
     *     --checks 6   49 checks    8 inside a module   one gate per band and 41 corridor coins
     *
     * At six the generator was falling all the way to `interiors: 0` and the level was one room
     * per band with a long walk between them -- which is exactly the "horribly boring" complaint.
     * Three keeps most of the density and still gives 25 checks.
     *
     * This is a trade against LOCATION COUNT, which is an Archipelago-facing decision rather than
     * a level-design one, so it is a default and not a rule. It also gets better on its own: more
     * modules means more bands, and every band brings a gate check that is inside a room by
     * construction. Phase 5d's 15-25 rooms should push the count back up without spending clock.
     */
    checks: Number(a.checks || 3),
    slack: Number(a.slack || 1.6),
    allowUnplayed: !!a['allow-unplayed'],
    id: String(a.id || `generated-${a.seed || 1}`),
    name: String(a.name || `Generated seed ${a.seed || 1}`),
  };

  if (a.list) {
    const { usable, rejected } = loadLibrary(opts);
    console.log('usable modules:');
    for (const m of usable) {
      console.log(`  rung ${String(m.rung).padStart(2)}  ${m.name.padEnd(20)} ` +
        `${m.handPlayed ? 'hand-played' : 'SOLVED ONLY'}  frames=${m.frames}`);
    }
    if (rejected.length) {
      console.log('rejected:');
      for (const r of rejected) console.log(`  ${r.name.padEnd(20)} ${r.why}`);
    }
    const gated = new Set(usable.map((m) => m.rung));
    const gaps = [];
    for (let r = 1; r < LADDER.N_RUNGS; r++) if (!gated.has(r)) gaps.push(r);
    console.log(`\n${gated.size} of ${LADDER.N_RUNGS - 1} rungs can be gated. No module gates: ${gaps.join(', ')}`);
    console.log('A rung with no module is a rung with no band: the map simply will not have one,\n' +
      'which is a smaller map rather than a wrong one. Author modules at those rungs to fill it in.');
    return;
  }

  const res = generate(opts);
  const out = a.out ? String(a.out) : path.join('mapeditor', 'maps', opts.id + '.json');
  const outPath = path.isAbsolute(out) ? out : path.join(ROOT, out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(res.map, null, 1) + '\n');

  // The logic sidecar: what each check needs. It is what Phase 6 verifies and what the apworld
  // eventually consumes. Kept beside the map rather than inside it, because iniLevel reads the
  // map and has no business carrying requirements around.
  const logicPath = outPath.replace(/\.json$/, '.logic.json');
  fs.writeFileSync(logicPath, JSON.stringify({
    map: opts.id, seed: opts.seed, generatedBy: 'mapeditor/tools/generate-map.js',
    settings: SETTINGS, bands: res.bands, checks: res.checks,
  }, null, 1) + '\n');

  console.log(`${res.checks.length} checks across ${res.bands.length} bands (rungs ${res.bandRungs.join(', ')})`);
  /*
   * Which profile won, and how much of the map is playing rather than walking.
   *
   * The profile is the single most useful number here and it used to be invisible: a run that
   * fell all the way to `interiors: 0` looked exactly like one that got its first choice, so
   * "the level is boring" and "the clock refused to pay for anything better" were the same
   * output. They want different fixes.
   */
  const inMods = res.checks.filter((c) => c.module).length;
  console.log(`  layout: ${res.profile.interiors} interior modules per band allowed, ` +
    `corridors from ${res.profile.corridorMin}px` +
    (res.tried.length ? `  (${res.tried.length} denser layout${res.tried.length > 1 ? 's' : ''} ` +
      'did not fit the clock)' : '  (its first choice)'));
  console.log(`  ${inMods} of ${res.checks.length} checks are inside a module; ` +
    `${res.checks.length - inMods} are coins in a corridor`);
  for (const b of res.bands) {
    console.log(`  rung ${String(b.rung).padStart(2)}  gate ${b.gate.padEnd(18)} ` +
      `${b.checks} checks  needs time tier ${b.timeTier}`);
  }
  if (res.rejected.length) {
    console.log('modules not used:');
    for (const r of res.rejected) console.log(`  ${r.name.padEnd(20)} ${r.why}`);
  }
  console.log(`\nwrote ${path.relative(ROOT, outPath)}\n      ${path.relative(ROOT, logicPath)}`);
  console.log(
    'Nothing above is verified -- it is what this laid out, not what the map does. Measure it:\n' +
      `  node solver/verify-map.js ${path.relative(ROOT, outPath).replace(/\\/g, '/')} --quick`
  );
}

if (require.main === module) main();

module.exports = { loadLibrary, generate, buildSlot, buildCorridor, coverageGaps, REQUIRED, G };
