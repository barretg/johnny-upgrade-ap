// The motivating case: damage-boosting through robot ene4 (the 200px-clearance chokepoint that
// gates the boss and 34 coins). At low Speed the search can only do it by exploiting the robot's
// exact patrol phase during i-frames -- which is what felt impossible in practice. Does demanding
// clearance from moving hazards remove those routes while leaving the honest ones?
const F = require('./fastsim');
const S = require('./settings');
console.log('combo (jmp5+DJ, Energy 2)   margin 0            margin 8');
for (const spd of [5, 6, 7, 8, 10]) {
  const row = [];
  for (const m of [0, 8]) {
    const r = F.search({
      ...S, spdTier: spd, jmpTier: 5, doubleJump: true, energyTier: 2, ammoTier: 0, hazardMargin: m,
    });
    row.push(`coins ${String(r.coinsFound).padStart(3)} gate ${r.gateFrame >= 0 ? 'yes' : ' NO'}`);
  }
  console.log(`spd ${String(spd).padStart(2)}                      ${row[0]}   ${row[1]}`);
}
