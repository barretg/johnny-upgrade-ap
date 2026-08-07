// Atlas progress: how much of the lattice is settled, and what is still open.
const A = require('./atlas');
const L = require('./locations');
const known = A.loadAll();
const all = A.allCombos();
const u = A.undetermined(known, L.N_LOC);
const settled = all.length - known.size - u.length;
console.log(`combos: ${all.length} total | ${known.size} run | ${settled} settled by sandwiching | ${u.length} still need a run`);
const { reach } = A.closure(known, L.N_LOC);
let unk=0, yes=0, no=0;
for (const c of all) { const r = reach.get(A.comboId(c)); for (let i=0;i<L.N_LOC;i++) r[i]===2?unk++:r[i]===1?yes++:no++; }
console.log(`(combo,location) pairs: ${yes} reachable | ${no} unreachable | ${unk} unknown  (${(100*(yes+no)/(yes+no+unk)).toFixed(1)}% determined)`);
if (u.length) { console.log('\nnext most informative:'); A.planBatch(known, L.N_LOC, 8).forEach(p=>console.log(`  ${A.comboId(p.combo)}  unknown=${p.unknown}`)); }
