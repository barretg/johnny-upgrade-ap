// The persistent "atlas": everything the solver has learned so far about the ability lattice,
// stored on disk so no combo is ever computed twice and so a sweep can be split across as many
// processes as you like.
//
// Layout:
//   out/settings.json               the discretization the atlas was built with (results from
//                                   different settings must never be mixed)
//   out/combo/s{S}_j{J}_d{D}_e{E}.json   one completed combo: min frame per location, or -1
//
// The lattice: a combo is (spdTier, jmpTier, doubleJump, energyTier). C dominates A when it is
// >= in every component.
//
// Why monotone closure is the right thing rather than a fudge: AP's own rules are monotone by
// construction (Has(item, count >= n)), and in the real game extra ability is never forced --
// a player with Speed 10 can tap the key to move like Speed 3, and a player with 5 hearts can
// play as though they had 1. So "reached at A" implies "reached at every C >= A" is exactly the
// semantics the generator needs.
//
// That in turn makes SANDWICHING sound, which is where the compute savings come from: if
// A <= C <= B and A and B agree about a location, C's answer is forced and C never has to run.

const fs = require('fs');
const path = require('path');

const MAX_SPD = 10;
const MAX_JMP = 10;
const MAX_ENERGY = 5; // hearts; iniLdat starts the player at nrg.v = 0.1, i.e. 1 heart

// JU_ATLAS_DIR lets a second arm (e.g. one with the frame-perfect techs enabled) be swept into
// its own directory instead of colliding with the default one.
const OUT = process.env.JU_ATLAS_DIR
  ? path.resolve(process.env.JU_ATLAS_DIR)
  : path.join(__dirname, 'out');
const COMBO_DIR = path.join(OUT, 'combo');

function ensureDirs() {
  for (const d of [OUT, COMBO_DIR]) if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

// Ammo tiers modelled in the gun arm. Each tier is 2 bullets (getGun: ammo = round(ammo.v*20)).
// Three tiers is plenty: routing never needs more than a couple of kills plus a bullet-hop, and
// anything beyond that is dominated.
const MAX_AMMO = 3;

// The lattice is swept as two arms rather than a full cross product:
//   energy arm  (spd, jmp, dj, energy 1..5), no gun
//   gun arm     (spd, jmp, dj, ammo 1..3),   energy 1
// Energy and the gun are alternative answers to the same blockers, so the OR of the two arms is
// what the logic needs. Skipping the both-at-once corner can only make a requirement stricter
// (a player holding both is at least as capable as either arm), never generate an unbeatable
// seed -- and it turns 6,050 runs into 1,936.
function allCombos() {
  const out = [];
  for (let s = 0; s <= MAX_SPD; s++)
    for (let j = 0; j <= MAX_JMP; j++)
      for (let d = 0; d <= 1; d++) {
        for (let e = 1; e <= MAX_ENERGY; e++) out.push({ s, j, d, e, g: 0 });
        for (let g = 1; g <= MAX_AMMO; g++) out.push({ s, j, d, e: 1, g });
      }
  return out;
}

const comboId = (c) => `s${c.s}_j${c.j}_d${c.d}_e${c.e}_g${c.g || 0}`;
const comboPath = (c) => path.join(COMBO_DIR, comboId(c) + '.json');
const dominates = (a, b) =>
  a.s >= b.s && a.j >= b.j && a.d >= b.d && a.e >= b.e && (a.g || 0) >= (b.g || 0); // a >= b

function saveSettings(settings) {
  ensureDirs();
  const p = path.join(OUT, 'settings.json');
  if (fs.existsSync(p)) {
    const cur = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (JSON.stringify(cur) !== JSON.stringify(settings)) {
      throw new Error(
        'Atlas settings mismatch -- existing results used a different discretization:\n' +
          `  on disk: ${JSON.stringify(cur)}\n  now:     ${JSON.stringify(settings)}\n` +
          'Delete solver/out to start a fresh atlas.'
      );
    }
    return;
  }
  fs.writeFileSync(p, JSON.stringify(settings, null, 2));
}

function saveCombo(c, result) {
  ensureDirs();
  // Write-then-rename so a killed process can never leave a half-parsed file behind for the
  // other workers to trip over.
  const tmp = comboPath(c) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(result));
  fs.renameSync(tmp, comboPath(c));
}

function loadCombo(c) {
  const p = comboPath(c);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function loadAll() {
  ensureDirs();
  const map = new Map();
  for (const c of allCombos()) {
    const r = loadCombo(c);
    if (r) map.set(comboId(c), { combo: c, result: r });
  }
  return map;
}

/**
 * Fold everything known into per-combo, per-location status over the whole lattice.
 *   1 reachable   -- some A <= C reached it, so C reaches it
 *   0 unreachable -- some B >= C ran to exhaustion without reaching it, so C cannot
 *   2 unknown     -- still needs a run somewhere
 * Also carries the best (smallest) known frame count, which is what the Time Limit tier is
 * derived from.
 */
function closure(known, nLoc) {
  const combos = allCombos();
  const reach = new Map();
  const frames = new Map();
  const entries = [...known.values()];

  for (const c of combos) {
    const id = comboId(c);
    const r = new Uint8Array(nLoc).fill(2);
    const fr = new Int32Array(nLoc).fill(-1);
    for (const { combo: a, result } of entries) {
      const af = result.frames;
      if (dominates(c, a)) {
        for (let i = 0; i < nLoc; i++) {
          if (af[i] >= 0) {
            r[i] = 1;
            if (fr[i] < 0 || af[i] < fr[i]) fr[i] = af[i];
          }
        }
      }
    }
    for (const { combo: a, result } of entries) {
      if (!result.complete || !dominates(a, c)) continue;
      const af = result.frames;
      for (let i = 0; i < nLoc; i++) if (af[i] < 0 && r[i] === 2) r[i] = 0;
    }
    reach.set(id, r);
    frames.set(id, fr);
  }
  return { reach, frames };
}

function undetermined(known, nLoc) {
  const { reach } = closure(known, nLoc);
  const out = [];
  for (const c of allCombos()) {
    if (known.has(comboId(c))) continue;
    const r = reach.get(comboId(c));
    let n = 0;
    for (let i = 0; i < nLoc; i++) if (r[i] === 2) n++;
    if (n > 0) out.push({ combo: c, unknown: n });
  }
  return out;
}

/**
 * Pick combos worth running, most-informative first. Candidates that dominate (or are dominated
 * by) something already in the batch are skipped, so a batch handed to N parallel workers spreads
 * across the lattice instead of being N near-identical runs whose results mostly imply each other.
 */
function planBatch(known, nLoc, size) {
  const u = undetermined(known, nLoc);
  u.sort((a, b) => b.unknown - a.unknown || a.combo.s + a.combo.j + a.combo.e - (b.combo.s + b.combo.j + b.combo.e));
  const picked = [];
  for (const cand of u) {
    if (picked.length >= size) break;
    if (picked.some((p) => dominates(p.combo, cand.combo) || dominates(cand.combo, p.combo))) continue;
    picked.push(cand);
  }
  for (const cand of u) {
    if (picked.length >= size) break;
    if (!picked.includes(cand)) picked.push(cand);
  }
  return picked;
}

module.exports = {
  MAX_SPD,
  MAX_JMP,
  MAX_ENERGY,
  OUT,
  COMBO_DIR,
  ensureDirs,
  allCombos,
  comboId,
  comboPath,
  dominates,
  saveSettings,
  saveCombo,
  loadCombo,
  loadAll,
  closure,
  undetermined,
  planBatch,
};
