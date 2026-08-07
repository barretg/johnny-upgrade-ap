// The persistent "atlas": everything the solver has learned so far about the ability lattice,
// stored on disk so no combo is ever computed twice and so a sweep can be split across as many
// processes as you like.
//
// Layout:
//   out/settings.json            the discretization the atlas was built with (results computed
//                                under different settings must not be mixed)
//   out/combo/s{S}_j{J}_d{D}.json  one completed combo: min frame per location, or -1
//   out/resume/s{S}_j{J}_d{D}.bin  frontier dump for a run that hit a limit before exhausting
//
// The lattice: a combo is (spdTier, jmpTier, doubleJump). C dominates A when it is >= in every
// component. Reachability, after monotone closure, is monotone in that order -- a player who
// owns more Speed can always tap the key to move like a slower one, and AP's own rules
// (Has(item, count >= n)) are monotone by construction, so the closure is what the generator
// needs regardless. That makes sandwiching sound: if A <= C <= B and A and B agree about a
// location, C's answer is forced and C never has to run.

const fs = require('fs');
const path = require('path');

const MAX_SPD = 10;
const MAX_JMP = 10;

const OUT = path.join(__dirname, 'out');
const COMBO_DIR = path.join(OUT, 'combo');
const RESUME_DIR = path.join(OUT, 'resume');

function ensureDirs() {
  for (const d of [OUT, COMBO_DIR, RESUME_DIR]) if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

function allCombos() {
  const out = [];
  for (let s = 0; s <= MAX_SPD; s++)
    for (let j = 0; j <= MAX_JMP; j++)
      for (let d = 0; d <= 1; d++) out.push({ s, j, d });
  return out;
}

const comboId = (c) => `s${c.s}_j${c.j}_d${c.d}`;
const comboPath = (c) => path.join(COMBO_DIR, comboId(c) + '.json');
const dominates = (a, b) => a.s >= b.s && a.j >= b.j && a.d >= b.d; // a >= b

function saveSettings(settings) {
  ensureDirs();
  const p = path.join(OUT, 'settings.json');
  if (fs.existsSync(p)) {
    const cur = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (JSON.stringify(cur) !== JSON.stringify(settings)) {
      throw new Error(
        'Atlas settings mismatch. Existing results were computed with different discretization:\n' +
          `  on disk: ${JSON.stringify(cur)}\n  now:     ${JSON.stringify(settings)}\n` +
          'Delete scratch-work/sim/out to start a fresh atlas.'
      );
    }
    return;
  }
  fs.writeFileSync(p, JSON.stringify(settings, null, 2));
}

function loadSettings() {
  const p = path.join(OUT, 'settings.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}

function saveCombo(c, result) {
  ensureDirs();
  fs.writeFileSync(comboPath(c), JSON.stringify(result));
}

function loadCombo(c) {
  const p = comboPath(c);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null; // half-written by a killed process; treat as absent
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
 * Fold everything known into per-location bounds over the whole lattice.
 *
 * For each location L and combo C:
 *   lower[C][L] = true  -- some A <= C is known to reach L, so C reaches L
 *   upper[C][L] = false -- some B >= C ran to completion without reaching L, so C cannot
 * A combo/location pair with neither bound set is still undetermined and needs a run.
 */
function closure(known, nLoc) {
  const combos = allCombos();
  const reach = new Map(); // comboId -> Uint8Array(nLoc): 1 reachable, 0 unreachable, 2 unknown
  const frames = new Map(); // comboId -> Int32Array: best known min frame, -1 if none

  for (const c of combos) {
    reach.set(comboId(c), new Uint8Array(nLoc).fill(2));
    frames.set(comboId(c), new Int32Array(nLoc).fill(-1));
  }

  for (const c of combos) {
    const r = reach.get(comboId(c));
    const fr = frames.get(comboId(c));
    for (const { combo: a, result } of known.values()) {
      const af = result.frames;
      if (dominates(c, a)) {
        // Anything a weaker combo reached, this one reaches (post-closure).
        for (let i = 0; i < nLoc; i++) {
          if (af[i] >= 0) {
            r[i] = 1;
            if (fr[i] < 0 || af[i] < fr[i]) fr[i] = af[i];
          }
        }
      }
      if (dominates(a, c) && result.complete) {
        // A stronger combo explored exhaustively and never got there, so neither can this one.
        for (let i = 0; i < nLoc; i++) if (af[i] < 0 && r[i] !== 1) r[i] = 0;
      }
    }
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
 * Pick the next combos worth running, most-informative first. Ties break toward cheap combos
 * (low speed/jump explore a smaller state space and finish fast), so early rounds are quick and
 * still collapse large parts of the lattice.
 */
function planBatch(known, nLoc, size) {
  const u = undetermined(known, nLoc);
  u.sort((a, b) => b.unknown - a.unknown || a.combo.s + a.combo.j - (b.combo.s + b.combo.j));
  // Spread the batch across the lattice instead of handing out 8 near-identical combos: greedily
  // skip a candidate if the batch already holds something that dominates it or that it dominates.
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
  OUT,
  COMBO_DIR,
  RESUME_DIR,
  ensureDirs,
  allCombos,
  comboId,
  comboPath,
  dominates,
  saveSettings,
  loadSettings,
  saveCombo,
  loadCombo,
  loadAll,
  closure,
  undetermined,
  planBatch,
};
