// The synthetic arena: a module, wrapped in just enough level to be solved and to be played.
//
// A module on its own is a handful of platforms and hazards with no context. To ask "which rung
// clears this?" it has to become a real map: something to stand on before it, something to land
// on after it, a sealed box so nothing walks off the edge of the world, and one coin to act as
// the finish line. That is all this file does, and it is deliberately the ONLY place that does
// it -- Phase 7's two-point traversal probe wraps its endpoints the same way, and two arena
// builders that disagreed would mean the probe and the module solver answered different
// questions while looking like they answered the same one.
//
// Shape, left to right:
//
//     [wall]  entry ledge  [ the module ]  exit ledge  [wall]
//                spawn                       coin
//     ---------------- lethal spike floor, well below ----------------
//
// Three things are load-bearing:
//
//   * The floor is SPIKES, not ground. If the pit were survivable, every gap module would be
//     clearable at rung 0 by dropping in and walking, and the whole library would grade as
//     trivial. A module is allowed to provide its own safe floor if that is what it is about.
//   * The box is sealed. Neither simulator has a fall-out-of-the-world death, so a state that
//     leaves the map keeps falling forever and burns the frame budget.
//   * "Reached the exit" means "collected the one coin", which is the game's own 24px-radius
//     pickup test against the player's 30x90 box -- already implemented, already frame-exact,
//     and the same rule everywhere. Nothing here invents a proximity radius of its own.
//
// Output is game format, via mapkit/mapformat's toGame -- the single translator in the repo --
// so the arena the solver ran is a file the map editor opens and the real game plays.

const MapFormat = require('../mapkit/mapformat');

const DEFAULTS = {
  ledge: 400, // how much flat ground sits before and after the module
  runUp: 240, // how far left of the entry point the player spawns
  pit: 700, // drop from the lowest thing in the arena to the spike floor
  headroom: 1400, // clear air above the highest thing, so a full jump is never clipped
  wall: 100, // thickness of the side walls, floor and ceiling
  ledgeThickness: 200,
  spikeHeight: 60,
  coinOffsetX: 150, // how far along the exit ledge the coin sits
  coinOffsetY: 45,
};

/**
 * Wrap a module in an arena.
 *
 * `mod` is { name, objects, entry: {x, y}, exit: {x, y} } in module-local coordinates -- the
 * same coordinates the module file stores, with its bounding box's top-left at the origin.
 * Entry and exit are points on top surfaces: the ledges are built so their tops line up with
 * them exactly, which is what makes "the module" the only thing between spawn and coin.
 *
 * Returns { map, spawn, coin, bounds } where `map` is game format, ready to be written and
 * pointed at with JU_MAP.
 */
function buildArena(mod, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const objects = mod.objects || [];
  const entry = mod.entry;
  const exit = mod.exit;
  if (!entry || !exit) throw new Error(`module ${mod.name}: needs both entry and exit points`);
  if (exit.x <= entry.x) {
    throw new Error(
      `module ${mod.name}: exit x (${exit.x}) must be right of entry x (${entry.x}); ` +
        'arenas run left to right'
    );
  }

  // Extent of everything the arena has to contain.
  let top = Math.min(entry.y, exit.y);
  let bottom = Math.max(entry.y, exit.y);
  for (const ob of objects) {
    top = Math.min(top, ob.y);
    bottom = Math.max(bottom, ob.y + (ob.h || 0));
  }

  const xMin = entry.x - o.ledge;
  const xMax = exit.x + o.ledge;
  const yTop = top - o.headroom;
  const yBot = bottom + o.pit;

  const plat = (x, y, w, h) => ({ kind: 'plat', x, y, w, h });
  const out = [];

  // Sealed box. The floor is solid so nothing falls forever; the spikes on top of it are what
  // actually end a run that misses.
  out.push(plat(xMin - o.wall, yBot, xMax - xMin + 2 * o.wall, o.wall));
  out.push({
    kind: 'spike',
    x: xMin - o.wall,
    y: yBot - o.spikeHeight,
    w: xMax - xMin + 2 * o.wall,
    h: o.spikeHeight,
  });
  out.push(plat(xMin - o.wall, yTop - o.wall, xMax - xMin + 2 * o.wall, o.wall));
  out.push(plat(xMin - o.wall, yTop, o.wall, yBot - yTop));
  out.push(plat(xMax, yTop, o.wall, yBot - yTop));

  // Entry and exit ledges, tops flush with the module's entry and exit points.
  out.push(plat(xMin, entry.y, o.ledge, o.ledgeThickness));
  out.push(plat(exit.x, exit.y, o.ledge, o.ledgeThickness));

  // The module itself, verbatim.
  for (const ob of objects) out.push({ ...ob });

  // Spawn on the entry ledge, with a run-up. The game stands the player one pixel above the
  // surface (vanilla spawns at y 359 on ground whose top is 360).
  out.push({ kind: 'sprt', x: entry.x - o.runUp, y: entry.y - 1, w: 0, h: 0, xx: 1 });

  // The finish line.
  const coin = { x: exit.x + o.coinOffsetX, y: exit.y - o.coinOffsetY };
  out.push({ kind: 'coin', x: coin.x, y: coin.y, w: 0, h: 0 });

  // One camera area over the whole arena. The solver ignores areas entirely, but scrollCode
  // computes NaN outside them, so an arena without one is unplayable in the real game -- and
  // being playable is the entire point of writing these out.
  out.push({
    kind: 'area',
    x: xMin - o.wall,
    y: yTop - o.wall,
    w: xMax - xMin + 2 * o.wall,
    h: yBot - yTop + 2 * o.wall,
    xx: 400,
    yy: 300,
    xmin: 0,
    xmax: 0,
    ymin: 0,
    ymax: 0,
  });

  const id = 'module-' + String(mod.name || 'unnamed').toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
  const map = MapFormat.toGame({
    meta: {
      id,
      name: `Module: ${mod.name}`,
      // Provenance, so an arena found in the maps folder is obviously generated and obviously
      // belongs to a module. iniLevel ignores meta entirely.
      generatedBy: 'solver/arena.js',
      module: mod.name,
    },
    yEnd: Math.round(yBot + 400),
    objects: out,
  });

  return { id, map, spawn: { x: entry.x - o.runUp, y: entry.y - 1 }, coin, bounds: { xMin, xMax, yTop, yBot } };
}

module.exports = { buildArena, DEFAULTS };
