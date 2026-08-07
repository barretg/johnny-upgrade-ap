// Which killable hazards actually gate progress? Only those need a bit in the dedup key.
const F = require('./fastsim');
const base = {qPos:6,qVx:1,qVy:1,stride:4,phaseBucket:10,hazardPad:120,maxFrames:9000,hashBits:25,beamCap:64};
const names = {}; F.M.enes.forEach((e,i)=>names[i]=`ene${i}(${e.typ})`); for(let i=0;i<F.M.bombs.length;i++) names[F.M.enes.length+i]=`bomb${i}`;
const ref = F.search({ spdTier:10, jmpTier:10, doubleJump:true, energyTier:1, ...base });
console.log(`baseline (nothing killed): coins=${ref.coinsFound} gate=${ref.gateFrame}`);
for (const h of F.KILLABLE) {
  const r = F.search({ spdTier:10, jmpTier:10, doubleJump:true, energyTier:1, trackKills:[h], forceKill:1, ...base });
  const d = r.coinsFound - ref.coinsFound;
  console.log(`  kill ${names[h].padEnd(12)} -> coins=${r.coinsFound} (${d>=0?'+':''}${d}) gate=${r.gateFrame} ${d>0||r.gateFrame>=0?'  <== BLOCKER':''}`);
}
