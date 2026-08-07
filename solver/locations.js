// Canonical location ordering shared by the runner, the atlas and the report.
// Index order is fixed forever -- combo result files are plain arrays indexed by it.

const F = require('./fastsim');

const names = [];
const kinds = [];

for (let i = 0; i < F.N_COIN; i++) {
  names.push(`Coin ${i + 1}`); // 1-based, matching scratch-work/logic.txt and the apworld
  kinds.push('coin');
}
const GUN_INDEX = names.length;
names.push('Find the Gun');
kinds.push('gun');

const GATE_INDEX = names.length;
names.push('Boss Arena');
kinds.push('boss');

// enes[] holds 2 saws and 6 robots; only robots are killable checks.
const ROBOT_ENE_INDICES = F.M.enes
  .map((e, i) => (e.typ === 'robot' ? i : -1))
  .filter((i) => i >= 0);
const ROBOT_INDEX0 = names.length;
ROBOT_ENE_INDICES.forEach((_, n) => {
  names.push(`Robot ${n + 1}`);
  kinds.push('robot');
});

const N_LOC = names.length;

module.exports = { names, kinds, N_LOC, GUN_INDEX, GATE_INDEX, ROBOT_INDEX0, ROBOT_ENE_INDICES };
