// Canonical location ordering shared by the runner, the atlas and the report.
//
// Index order is fixed forever *within a map* -- combo result files are plain arrays indexed by
// it. Across maps the order is per-map (a different map has different coins), which is why the
// map's identity is pinned into the atlas settings by mapsource.js/settings.js: results for one
// map can never be read as results for another.
//
// Order: coins, then gun pickups, then boss gates, then robots.

const F = require('./fastsim');

const names = [];
const kinds = [];

for (let i = 0; i < F.N_COIN; i++) {
  names.push(`Coin ${i + 1}`); // 1-based, matching scratch-work/logic.txt and the apworld
  kinds.push('coin');
}

// A rect the game would never test against, i.e. "this map has no such thing".
const isEmptyRect = (r) => !r || (!r.l && !r.t && !r.r && !r.b);
const isEmptyPoint = (p) => !p || (!p.x && !p.y);

// Gun pickups and boss gates are plural in the format (`colGuns` / `bossData.gates`) even
// though the vanilla map and the current fastsim only ever have one of each. Building the
// index lists from the map now means the multi-gun / multi-arena feature does not renumber
// every location when it lands.
//
// NOTE: fastsim's search reports a frame for the FIRST of each only; extras stay -1 until it
// learns to track them. That errs toward under-reporting reachability, which is the safe
// direction, and it is why a map should not ship extra ones before that work is done.
const GUNS = (F.M.colGuns && F.M.colGuns.length ? F.M.colGuns : [F.M.colGun]).filter(
  (g) => !isEmptyPoint(g)
);
const GATES = (F.M.bossData.gates && F.M.bossData.gates.length
  ? F.M.bossData.gates
  : [F.M.bossData.gate]
).filter((g) => !isEmptyRect(g));

const GUN_INDICES = GUNS.map((_, n) => {
  const i = names.length;
  names.push(GUNS.length === 1 ? 'Find the Gun' : `Find the Gun ${n + 1}`);
  kinds.push('gun');
  return i;
});

const GATE_INDICES = GATES.map((_, n) => {
  const i = names.length;
  names.push(GATES.length === 1 ? 'Boss Arena' : `Boss Arena ${n + 1}`);
  kinds.push('boss');
  return i;
});

// enes[] holds saws and robots; only robots are killable checks.
const ROBOT_ENE_INDICES = F.M.enes
  .map((e, i) => (e.typ === 'robot' ? i : -1))
  .filter((i) => i >= 0);
const ROBOT_INDEX0 = names.length;
ROBOT_ENE_INDICES.forEach((_, n) => {
  names.push(`Robot ${n + 1}`);
  kinds.push('robot');
});

const N_LOC = names.length;

module.exports = {
  names,
  kinds,
  N_LOC,
  GUN_INDICES,
  GATE_INDICES,
  ROBOT_INDEX0,
  ROBOT_ENE_INDICES,
};
