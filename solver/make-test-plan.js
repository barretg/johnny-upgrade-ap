// Build the human-execution test plan: every DISTINCT requirement object in the generated logic,
// paired with the locations it claims to make reachable.
//
// The solver answers "is this physically possible", not "can a person actually do it". Some of
// its routes are frame-perfect. This produces a checklist so each requirement object can be
// played by hand and either confirmed or marked too hard; strip-failed.js then removes the failed
// ones from every class that uses them and regenerates the logic.
//
//   node make-test-plan.js        -> out/test-plan.json

const fs = require('fs');
const path = require('path');
const F = require('./fastsim');
const A = require('./atlas');
const L = require('./locations');

const REQ = path.join(A.OUT, 'requirements.json');
if (!fs.existsSync(REQ)) {
  console.error('Run report.js first (needs out/requirements.json).');
  process.exit(1);
}
const perLoc = JSON.parse(fs.readFileSync(REQ, 'utf8'));

const keyOf = (o) => JSON.stringify([o.s, o.j, o.d ? 1 : 0, o.e, o.g, o.t]);

// object key -> { req, locations: Set<locIndex> }
const objects = new Map();
perLoc.forEach((loc, li) => {
  if (!loc.reachable) return;
  for (const o of loc.options) {
    const k = keyOf(o);
    if (!objects.has(k)) objects.set(k, { req: o, locs: new Set() });
    objects.get(k).locs.add(li);
  }
});

// Min frames come from the combo the object names, so the checklist can be ordered by how
// time-critical each location is under exactly those stats.
const comboCache = new Map();
function framesFor(o) {
  const id = A.comboId({ s: o.s, j: o.j, d: o.d ? 1 : 0, e: o.e, g: o.g });
  if (!comboCache.has(id)) {
    const r = A.loadCombo({ s: o.s, j: o.j, d: o.d ? 1 : 0, e: o.e, g: o.g });
    comboCache.set(id, r ? r.frames : null);
  }
  return comboCache.get(id);
}

const rules = [];
for (const { req, locs } of objects.values()) {
  const frames = framesFor(req);
  const budget = F.framesAllowed(req.t);
  const items = [...locs].map((li) => {
    const f = frames ? frames[li] : -1;
    return {
      i: li,
      // Fraction of the round timer this location eats. Anything near 1 is the tight stuff and
      // is what the tester should try first.
      tight: f >= 0 ? Math.round((f / budget) * 100) / 100 : null,
      f,
    };
  });
  // Hardest first: most time-critical, then deepest into the level.
  items.sort((a, b) => (b.tight || 0) - (a.tight || 0) || b.f - a.f);
  rules.push({ req, budget, locs: items });
}

// Order the plan so the cheapest stat sets come first -- those are quick to test and get the
// tester warmed up before the long, deep runs.
rules.sort(
  (a, b) =>
    a.req.s - b.req.s ||
    a.req.j - b.req.j ||
    (a.req.d ? 1 : 0) - (b.req.d ? 1 : 0) ||
    a.req.e - b.req.e ||
    a.req.g - b.req.g ||
    a.req.t - b.req.t
);
rules.forEach((r, i) => {
  r.id = i;
});

const plan = {
  generated: new Date().toISOString(),
  // Shared table so each rule can reference locations by index instead of repeating names.
  locations: perLoc.map((p) => ({ name: p.name, kind: p.kind, x: p.x, y: p.y })),
  rules,
};

A.ensureDirs();
const out = path.join(A.OUT, 'test-plan.json');
fs.writeFileSync(out, JSON.stringify(plan));
const sizes = rules.map((r) => r.locs.length).sort((a, b) => a - b);
const q = (p) => sizes[Math.floor(sizes.length * p)];
console.log(`rules (distinct requirement objects): ${rules.length}`);
console.log(`locations per rule: min ${sizes[0]}  p50 ${q(0.5)}  p90 ${q(0.9)}  max ${sizes[sizes.length - 1]}`);
console.log(`total location-checks to perform: ${sizes.reduce((a, b) => a + b, 0)}`);
console.log(`wrote ${out} (${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);
