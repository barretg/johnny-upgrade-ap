// Diagnostic: ASCII render of where a given ability combo can actually get to.
const F = require('./fastsim');
const M = F.M;
const CELL=64, X0=-1700, Y0=-600, W=Math.ceil(5300/CELL), H=Math.ceil(3300/CELL);
const occ = { occ:new Uint8Array(W*H), CELL, X0, Y0, W, H };
const a = process.argv.slice(2).map(Number);
const [s,j,d] = a.length>=3 ? a : [10,10,1];
const r = F.search({ spdTier:s, jmpTier:j, doubleJump:!!d, qPos:6,qVx:1,qVy:1,stride:4,phaseBucket:10,hazardPad:120,maxFrames:9000,hashBits:25,beamCap:64, occ });
const grid = [];
for (let y=0;y<H;y++) grid.push(new Array(W).fill(' '));
for (const p of M.plats) {
  for (let y=Math.floor((p.y-Y0)/CELL); y<=Math.floor((p.bottom-Y0)/CELL); y++)
    for (let x=Math.floor((p.x-X0)/CELL); x<=Math.floor((p.right-X0)/CELL); x++)
      if (y>=0&&y<H&&x>=0&&x<W) grid[y][x]='#';
}
for (let i=0;i<W*H;i++) if (occ.occ[i]) { const y=Math.floor(i/W), x=i%W; grid[y][x] = grid[y][x]==='#' ? '%' : '.'; }
M.coins.forEach((c,i)=>{const x=Math.floor((c.x-X0)/CELL),y=Math.floor((c.y-Y0)/CELL); if(y>=0&&y<H&&x>=0&&x<W) grid[y][x]= r.coinFrame[i]>=0 ? 'o' : 'X';});
const g=M.bossData.gate; { const x=Math.floor((g.l-X0)/CELL),y=Math.floor((g.t-Y0)/CELL); grid[y][x]= r.gateFrame>=0?'g':'G'; }
{ const x=Math.floor((M.colGun.x-X0)/CELL),y=Math.floor((M.colGun.y-Y0)/CELL); grid[y][x]= r.gunFrame>=0?'u':'U'; }
{ const x=Math.floor((M.sprt.x-X0)/CELL),y=Math.floor((M.sprt.y-Y0)/CELL); grid[y][x]='S'; }
console.log(`combo spd${s} jmp${j} dj${d}  coins=${r.coinsFound} gun=${r.gunFrame} gate=${r.gateFrame}`);
console.log('# solid  . reachable air  % reachable+solid  o coin got  X coin missed  S spawn  G/g gate  U/u gun');
console.log('      ' + Array.from({length:W},(_,i)=> i%5===0 ? '|' : ' ').join(''));
grid.forEach((row,y)=>console.log(String(y*CELL+Y0).padStart(6)+' '+row.join('')));
