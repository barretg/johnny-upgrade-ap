const E = require('../editor/editor-core.js');
const M = require('../../mapkit/mapformat.js');
const g = E._geom;
const eq = (a,b,m) => { const s=JSON.stringify(a), t=JSON.stringify(b); if(s!==t) { console.log('FAIL',m,'\n  got',s,'\n  want',t); process.exitCode=1; } else console.log('ok  ',m); };

// four quarter turns is the identity, for every kind that carries extra boxes
const cases = [
  { id:1, kind:'plat', x:100, y:200, w:300, h:50, stomper:1, fallTo:-60, trigX:300, trigW:80 },
  { id:2, kind:'ene', x:0, y:0, w:0, h:0, typ:'robot', xx:4.8, yy:0, xmin:-100, xmax:200, ymin:-20, ymax:20 },
  { id:3, kind:'laser', x:50, y:60, w:0, h:0, length:590, horizontal:1 },
  { id:4, kind:'area', x:-100, y:-100, w:400, h:300, xx:320, yy:300, xmin:-500, xmax:0, ymin:0, ymax:900 },
  { id:5, kind:'door', x:10, y:20, w:100, h:250, trigger:'zone', zx:-50, zy:-40, zw:300, zh:200 },
  { id:6, kind:'art', x:0, y:0, w:149, h:34, tile:'grass_surface', rot:0, flipX:0, flipY:0, z:0 },
];
for (const c of cases) {
  const before = JSON.parse(JSON.stringify(c));
  for (let i=0;i<4;i++) g.rotate90(c, 37, -11);
  eq(c, before, 'rotate90 x4 identity: ' + c.kind);
}

/*
 * Rotating a SELECTION four times is the identity too, and that is the harder
 * claim: rotateSelection used to snap the rotated group box back onto the grid,
 * which for an oblong lands on a half-grid and pulls the same way every time. The
 * group crept across the map a little on every turn and nothing pulled it back.
 * It now preserves the box centre exactly instead -- an off-grid group is one drag
 * to fix, and accumulated drift is not fixable at all.
 */
{
  const group = [
    { id:20, kind:'plat', x:0,   y:0,  w:300, h:50 },
    { id:21, kind:'plat', x:350, y:0,  w:50,  h:50 },
    { id:22, kind:'coin', x:170, y:-30, w:0,  h:0 },
  ];
  const before = JSON.parse(JSON.stringify(group));
  for (let i = 0; i < 4; i++) g.rotateSelection(group, 1);
  eq(group, before, 'four quarter turns of an oblong SELECTION is the identity');
  /*
   * ...and nothing went missing on the way. There is one unreproduced report of a
   * texture being lost or shifted by one during a rotation (5b-10, H1). The
   * identity check above compares contents and would not notice a shorter list at
   * all, so the count and the ids are asserted separately.
   */
  eq(group.map((o) => o.id), before.map((o) => o.id),
     'and every object is still there, in the same order');

  const c0 = g.groupBox(group);
  g.rotateSelection(group, 1);
  const c1 = g.groupBox(group);
  eq([c1.x + c1.w/2, c1.y + c1.h/2], [c0.x + c0.w/2, c0.y + c0.h/2],
     'and one turn leaves the group on the centre it turned about');
  g.rotateSelection(group, 3);
  eq(group, before, 'a turn and three back is the identity as well');
}

/*
 * Spike autotiling. The rect is divided EVENLY rather than laid with whole tiles
 * and a clipped remainder: art objects cannot clip, only resize, so "clip the
 * remainder" means one visibly squashed column at the end of every strip. The
 * tiles must also meet exactly -- a gap between two spike strips reads as a safe
 * step and is not one.
 */
{
  const tile = { name: 'hazard_surface', w: 120, h: 80 };
  const strip = g.spikeArt({ x: 100, y: 50, w: 500, h: 80 }, tile);
  eq(strip.length, 4, 'a 500px strip takes four 120px tiles, not four and a stub');
  eq([strip[0].x, strip[0].w], [100, 125], 'each one carries an equal share of the remainder');
  const right = Math.max(...strip.map((o) => o.x + o.w));
  const left = Math.min(...strip.map((o) => o.x));
  eq([left, right], [100, 600], 'and the run covers the rect exactly, end to end');
  const xs = strip.map((o) => o.x).sort((a, b) => a - b);
  eq(xs.every((x, i) => i === 0 || Math.abs(x - (xs[i-1] + strip[0].w)) < 1e-9), true,
     'with no gap between neighbours -- a gap in a spike strip reads as a safe step');

  const tiny = g.spikeArt({ x: 0, y: 0, w: 30, h: 20 }, tile);
  eq(tiny.length, 1, 'a rect smaller than one tile still gets one tile, not none');
  eq([tiny[0].w, tiny[0].h], [30, 20], 'squeezed to fit rather than overflowing the hazard');

  const objs = [
    { kind: 'spike', x: 0, y: 0, w: 240, h: 80 },
    { kind: 'spike', x: 500, y: 0, w: 240, h: 80 },
    { kind: 'art', tile: 'hazard_surface', x: 500, y: 0, w: 240, h: 80 },
  ];
  eq(g.autotileSpikes(objs, tile).length, 2,
     'only the untextured rect is filled -- pressing it twice is a no-op, and it ' +
     'never doubles up on hand-textured work');
}

// a quarter turn takes a horizontal beam upright and keeps its length
const beam = { id:7, kind:'laser', x:0, y:0, w:0, h:0, length:590, horizontal:1 };
g.rotate90(beam, 0, 0);
eq([beam.horizontal, beam.length], [0, 590], 'beam rotates upright, length kept');
eq(g.laserRect(beam), { x:-20, y:-295, w:40, h:590 }, 'upright beam rect');

// an area rotated with only its left clamp set comes back with only a top clamp
const area = { id:8, kind:'area', x:0, y:0, w:100, h:100, xx:320, yy:300, xmin:-400, xmax:0, ymin:0, ymax:0 };
g.rotate90(area, 0, 0);
eq([area.xmin, area.xmax, area.ymin, area.ymax], [0, 0, -400, 0], 'clamp sides rotate with the box');

// scaling carries the patrol range along
const mover = { id:9, kind:'platMove', x:100, y:0, w:0, h:0, xx:3, yy:0, xmin:0, xmax:200, ymin:0, ymax:0 };
g.scaleObj(mover, 2, 1, 0, 0);
eq([mover.x, mover.xmin, mover.xmax], [200, 0, 400], 'scale carries the patrol range');

// clampBox falls back to the area's own rect where a clamp is off
eq(g.clampBox({ kind:'area', x:10, y:20, w:100, h:50, xmin:0, xmax:0, ymin:0, ymax:0 }),
   { x0:10, x1:110, y0:20, y1:70, aL:false, aR:false, aT:false, aB:false }, 'unset clamp = area rect');

// laser length and orientation survive the round trip through the game format
const map = { meta:{id:'t',name:'T'}, objects:[
  { id:1, kind:'laser', x:5, y:6, w:0, h:0, ctMax:100, ctSwitch:60, ctCurr:0, length:240, horizontal:0 },
  { id:2, kind:'laser', x:9, y:9, w:0, h:0, ctMax:100, ctSwitch:60, ctCurr:0, length:590, horizontal:1 },
], yEnd:3000 };
const back = M.fromGame(M.toGame(map), 1).objects.filter(o => o.kind === 'laser').map(o => [o.length, o.horizontal]);
eq(back, [[240,0],[590,1]], 'laser round trip');

// the stock level, which predates the fields, comes back as the game builds it
const stock = M.fromGame({ plats:[], lasers:[{x:0,y:0},{x:1,y:1}] }, 1).objects
  .filter(o => o.kind === 'laser').map(o => [o.length, o.horizontal]);
eq(stock, [[590,1],[180,0]], 'legacy lasers default to what iniLevel did');

// ---------------------------------------------------------------- modules
/*
 * The module library survives a trip through the editor.
 *
 * This is the one that matters for difficulty: a module dropped from the palette
 * and saved straight back out must come out with the SAME canonical geometry, or
 * mergeModule drops its solve record and its hand-play verdict -- a rung that cost
 * somebody a play session, thrown away by an edit that changed nothing. The
 * fixture is the real library, so a change to the editor's object model that
 * quietly alters what a module serialises to fails here rather than in a badge.
 *
 * The drop is modelled as it really happens: the objects come back with editor ids
 * and the kind's default props attached, exactly as paste() and the properties
 * panel leave them.
 */
const fs = require('fs');
const path = require('path');
const mod = E._module;
const MODDIR = path.join(__dirname, '..', 'modules');

for (const f of fs.readdirSync(MODDIR).filter((n) => n.endsWith('.json'))) {
  const src = JSON.parse(fs.readFileSync(path.join(MODDIR, f), 'utf8'));
  let id = 1;
  // what the palette drop leaves in the map: an id, and every prop the kind
  // defines, whether the file mentioned it or not
  const dropped = src.objects.map((o) =>
    Object.assign({ id: id++, kind: o.kind, w: 0, h: 0 }, E.KINDS[o.kind].props || {}, o));
  // the module is dropped somewhere in the map, not at the origin
  g.moveObjects(dropped, 1700, -240);

  const ends = mod.deriveEnds(dropped);
  const derived = {
    entry: { x: ends.entry.x - 1700, y: ends.entry.y + 240 },
    exit: { x: ends.exit.x - 1700, y: ends.exit.y + 240 },
  };
  eq([derived.entry, derived.exit], [src.entry, src.exit], 'entry/exit derived: ' + src.name);

  const rec = mod.buildModuleRecord(src.name, src.tags, dropped, ends.entry, ends.exit);
  eq(mod.geomKey(rec), mod.geomKey(src), 'geometry round trip: ' + src.name);
  eq(rec.size, src.size, 'size round trip: ' + src.name);
}

// a hand-play verdict raises the rung; it never lowers it, and a verdict below the
// solved rung is a physics bug rather than a difficulty correction
eq(mod.moduleRung({ solve:{minRung:12} }), { rung:12, played:false, conflict:false, bound:false }, 'rung: solved only');
eq(mod.moduleRung({ solve:{minRung:12}, handPlay:{minRung:22} }), { rung:22, played:true, conflict:false, bound:false }, 'rung: hand-play raises');
eq(mod.moduleRung({ solve:{minRung:12}, handPlay:{minRung:5} }), { rung:12, played:true, conflict:true, bound:false }, 'rung: hand-play below solve is a conflict, not a lowering');
eq(mod.moduleRung({}), { rung:null, played:false, conflict:false, bound:false }, 'rung: unsolved');

/*
 * An UPPER BOUND is a different claim from a solved rung, and the panel has to be
 * able to tell them apart.
 *
 * solve.exact === false means the negative that decided the rung came from a
 * beamed search that had thrown states away, so the module may be clearable lower
 * down. crusher-gate and gap-wide are both in that state in the shipped library.
 * A hand-play verdict retires it: a person clearing the module is a fact about
 * the game rather than about the beam.
 */
eq(mod.moduleRung({ solve:{minRung:17, exact:false} }),
   { rung:17, played:false, conflict:false, bound:true }, 'rung: a beamed negative is an upper bound');
eq(mod.moduleRung({ solve:{minRung:17, exact:false}, handPlay:{minRung:17} }),
   { rung:17, played:true, conflict:false, bound:false }, 'rung: and a hand-play settles it');

// which queue a module is waiting in, which is what the panel's chips count
eq(mod.moduleQueue({}), 'unsolved', 'queue: no record at all');
eq(mod.moduleQueue({ solve:{minRung:12} }), 'unplayed', 'queue: solved, never played');
eq(mod.moduleQueue({ solve:{minRung:12, exact:false} }), 'bound', 'queue: an upper bound outranks unplayed');
eq(mod.moduleQueue({ solve:{minRung:12}, handPlay:{minRung:5} }), 'conflict', 'queue: a verdict below the solve');
eq(mod.moduleQueue({ solve:{minRung:12}, handPlay:{minRung:14} }), null, 'queue: solved and played needs nothing');

// default-valued flags are stripped, real numbers are not
eq(mod.stripModuleObject({ id:3, kind:'plat', x:0, y:0, w:10, h:10, semi:0, stomper:0, z:2 }),
   { kind:'plat', x:0, y:0, w:10, h:10 }, 'strip: default plat flags and the editing-only z');
eq(mod.stripModuleObject({ id:4, kind:'ene', x:0, y:0, w:0, h:0, typ:'robot', xx:0, yy:0 }),
   { kind:'ene', x:0, y:0, w:0, h:0, typ:'robot', xx:0, yy:0 }, 'strip: an enemy keeps a speed of zero');

// ---------------------------------------------------------------- the rung reference
/*
 * The editor's copy of the ability model, held against the real one.
 *
 * moveAccel and jumpImpulse are transcribed into editor-core because physics.js
 * is node-only -- it derives its world from JU_MAP at require() time -- and the
 * editor runs in a browser. A transcription that drifts puts wrong numbers in
 * front of an author with nothing on screen to say so, which is why this is a
 * test and not a comment.
 */
const PH = require('../../solver/physics.js');
const R = E._rungs;
const L = require('../../solver/ladder.js');

let accelOk = true, impulseOk = true;
for (let t = 0; t <= 10; t++) {
  if (R.moveAccel(t) !== PH.moveAccel(t)) accelOk = false;
  // physics.js returns the impulse as a negative vy; the editor shows it as a height
  const want = PH.jumpImpulse(t);
  const got = R.jumpImpulse(t);
  if (want === null ? got !== null : got !== -want) impulseOk = false;
}
eq(accelOk, true, 'the editor\'s moveAccel matches solver/physics.js for every tier');
eq(impulseOk, true, 'and so does its jumpImpulse');

/*
 * The closed form for jump height, against a loop that just runs the frames the
 * way physics.js orders them: controls sets vy, then `vy += GRAVITY; y += vy`.
 * The closed form is what the module set's hand predictions were made with.
 */
function riseByLoop(jmp) {
  const J = PH.jumpImpulse(jmp);
  if (J === null) return 0;
  let vy = J, rise = 0;
  for (;;) {
    vy += 1;                 // GRAVITY
    if (vy >= 0) break;
    rise += -vy;
  }
  return rise;
}
let riseOk = true;
for (let t = 1; t <= 10; t++) {
  if (Math.abs(R.jumpRise(t) - riseByLoop(t)) > 1e-9) riseOk = false;
}
eq(riseOk, true, 'jumpRise matches a frame-by-frame run of the same physics');

/*
 * And against a real solved boundary. ledge-tall is a 270px step: it solves at
 * rung 14 and not at rung 13, so a double jump at rung 14 must clear 270 and one
 * at rung 13 must not. If this fails the reference is lying about the one thing
 * an author reads it for.
 */
const r13 = L.RUNGS[13], r14 = L.RUNGS[14];
eq([2 * R.jumpRise(r13.jump) >= 270, 2 * R.jumpRise(r14.jump) >= 270], [false, true],
   'the rung 13/14 boundary at ledge-tall\'s 270px step comes out where the solver put it');

/*
 * ladder.js carries the same three functions, because solve-module.js needs them to
 * decide whether a module can be walked over and cannot require physics.js without
 * binding itself to one map. Two copies, both held against the original here.
 */
let ladderOk = true;
for (let t = 0; t <= 10; t++) {
  const want = PH.jumpImpulse(t);
  if (L.moveAccel(t) !== PH.moveAccel(t)) ladderOk = false;
  if (want === null ? L.jumpImpulse(t) !== null : L.jumpImpulse(t) !== -want) ladderOk = false;
  if (t >= 1 && Math.abs(L.jumpRise(t) - riseByLoop(t)) > 1e-9) ladderOk = false;
}
eq(ladderOk, true, 'solver/ladder.js\'s copy of the ability model matches physics.js too');
eq([L.maxRise(L.RUNGS[8]) === 2 * L.jumpRise(L.RUNGS[8].jump),
    L.maxRise(L.RUNGS[7]) === L.jumpRise(L.RUNGS[7].jump)], [true, true],
   'maxRise doubles exactly where the double jump arrives (rung 8) and not before');

// ---------------------------------------------------------------- the roof check
/*
 * A module's arena is a sealed box, but the box is far above the module, so a slab
 * the player can stand on top of is a second route from entry to exit that meets
 * none of the module's hazards. Every corridor module in the library used to have
 * one, 300px up, walkable from rung 18. It changed no grade only because all of them
 * solve at 12 -- so the library passed while carrying the flaw, which is why the
 * check is here and not left to the next author to notice.
 */
const SM = require('../../solver/solve-module.js');
const roofed = fs.readdirSync(MODDIR).filter((f) => f.endsWith('.json'))
  .map((f) => [f, SM.roofRung(JSON.parse(fs.readFileSync(path.join(MODDIR, f), 'utf8')), L)])
  .filter(([, r]) => r);
eq(roofed.map(([f, r]) => f + ' @ rung ' + r.rung), [],
   'no module in the library can be walked over instead of through');

// and the check itself really fires -- a corridor with a 200px ceiling 300px up is
// exactly the shape the library shipped with, and rung 18 clears 300px
const unsealed = {
  size: { w: 2400, h: 500 }, entry: { x: 0, y: 300 }, exit: { x: 2400, y: 300 },
  objects: [{ kind: 'plat', x: 0, y: 0, w: 2400, h: 200 },
            { kind: 'plat', x: 0, y: 300, w: 2400, h: 200 }],
};
eq(SM.roofRung(unsealed, L), { rung: 18, climb: 300 },
   'and it catches the shape the corridors used to have');
// a slab that does not span the module is somewhere to land, not a way across
const island = JSON.parse(JSON.stringify(unsealed));
island.objects[0].w = 400;
eq(SM.roofRung(island, L), null, 'an island overhead is not a bypass');
