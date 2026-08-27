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
eq(mod.moduleRung({ solve:{minRung:12} }), { rung:12, played:false, conflict:false }, 'rung: solved only');
eq(mod.moduleRung({ solve:{minRung:12}, handPlay:{minRung:22} }), { rung:22, played:true, conflict:false }, 'rung: hand-play raises');
eq(mod.moduleRung({ solve:{minRung:12}, handPlay:{minRung:5} }), { rung:12, played:true, conflict:true }, 'rung: hand-play below solve is a conflict, not a lowering');
eq(mod.moduleRung({}), { rung:null, played:false, conflict:false }, 'rung: unsolved');

// default-valued flags are stripped, real numbers are not
eq(mod.stripModuleObject({ id:3, kind:'plat', x:0, y:0, w:10, h:10, semi:0, stomper:0, z:2 }),
   { kind:'plat', x:0, y:0, w:10, h:10 }, 'strip: default plat flags and the editing-only z');
eq(mod.stripModuleObject({ id:4, kind:'ene', x:0, y:0, w:0, h:0, typ:'robot', xx:0, yy:0 }),
   { kind:'ene', x:0, y:0, w:0, h:0, typ:'robot', xx:0, yy:0 }, 'strip: an enemy keeps a speed of zero');
