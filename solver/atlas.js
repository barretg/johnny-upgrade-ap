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

// A short synchronous sleep, so a rename can be retried without busy-spinning a core that the
// sweep would rather spend on searching.
function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Write-then-rename, so a killed process can never leave a half-parsed file for other workers.
 *
 * Two things make this harder than it looks under N parallel workers:
 *   - the planner can hand the same combo to more than one worker, so the temp name must be
 *     unique per process or they clobber each other's partial writes
 *   - on Windows a rename onto a file another process currently has open fails with EPERM, and
 *     every worker re-reads the whole atlas between combos, so that collision is routine
 *
 * Results are deterministic, so whoever lands first is as good as anyone else: if the
 * destination already exists we simply drop our copy. Returns false if the result could not be
 * stored, which is recoverable -- some later worker will just recompute that combo.
 */
function saveCombo(c, result) {
  ensureDirs();
  const dest = comboPath(c);
  const tmp = `${dest}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(result));
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      fs.renameSync(tmp, dest);
      return true;
    } catch (e) {
      if (fs.existsSync(dest)) break; // another worker already stored it
      sleepMs(25 * (attempt + 1));
    }
  }
  try {
    fs.unlinkSync(tmp);
  } catch {
    /* nothing useful to do if even the cleanup fails */
  }
  return fs.existsSync(dest);
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

// Incremental atlas cache for the worker loop.
//
// A combo result never changes once written, so re-parsing the whole directory between every
// combo is pure waste -- and at ~1,900 files it was the single biggest CPU cost in the sweep,
// paid by every worker on every iteration. A directory listing plus parsing only the files we
// have not seen turns ~830ms into a few ms.
let _cache = null;

function loadAllCached() {
  ensureDirs();
  if (!_cache) _cache = new Map();
  let names;
  try {
    names = fs.readdirSync(COMBO_DIR);
  } catch {
    return _cache;
  }
  for (const n of names) {
    if (!n.endsWith('.json')) continue; // skip other workers' in-flight .tmp files
    const id = n.slice(0, -5);
    if (_cache.has(id)) continue;
    try {
      const result = JSON.parse(fs.readFileSync(path.join(COMBO_DIR, n), 'utf8'));
      if (result && result.combo) _cache.set(id, { combo: result.combo, result });
    } catch {
      // Being written right now; it will be picked up on a later pass.
    }
  }
  return _cache;
}

/**
 * Load a second atlas from an arbitrary directory, so one process can compare arms -- e.g. the
 * default sweep against one run with the frame-perfect movement techs enabled. Returns an empty
 * map if the directory is not there.
 */
function loadAllFrom(dir) {
  const comboDir = path.join(path.resolve(dir), 'combo');
  const map = new Map();
  if (!fs.existsSync(comboDir)) return map;
  for (const c of allCombos()) {
    const p = path.join(comboDir, comboId(c) + '.json');
    if (!fs.existsSync(p)) continue;
    try {
      map.set(comboId(c), { combo: c, result: JSON.parse(fs.readFileSync(p, 'utf8')) });
    } catch {
      // half-written by a killed process; treat as absent
    }
  }
  return map;
}

/** The settings a given atlas directory was built with, or null. */
function settingsOf(dir) {
  const p = path.join(path.resolve(dir), 'settings.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}

/**
 * Fold everything known into per-combo, per-location status over the whole lattice.
 *   1 reachable   -- some A <= C reached it, so C reaches it
 *   0 unreachable -- some B >= C ran to exhaustion without reaching it, so C cannot
 *   2 unknown     -- still needs a run somewhere
 * Also carries the best (smallest) known frame count, which is what the Time Limit tier is
 * derived from.
 */
// Lattice dimensions, embedded in a dense product grid. The two arms do not fill the whole
// product (the energy arm has g = 0, the gun arm has e = 1), but the missing cells simply carry
// no data and contribute nothing, so a product sweep is still correct.
const D_S = 11, D_J = 11, D_D = 2, D_E = 5, D_G = 4;
const N_CELL = D_S * D_J * D_D * D_E * D_G;
const ST_G = 1;
const ST_E = D_G;
const ST_D = D_E * ST_E;
const ST_J = D_D * ST_D;
const ST_S = D_J * ST_J;
const cellIndex = (c) => c.s * ST_S + c.j * ST_J + c.d * ST_D + (c.e - 1) * ST_E + (c.g || 0) * ST_G;

/**
 * Fold everything known into per-combo, per-location status over the whole lattice.
 *   1 reachable   -- some A <= C reached it, so C reaches it
 *   0 unreachable -- some B >= C ran to exhaustion without reaching it, so C cannot
 *   2 unknown     -- still needs a run somewhere
 * Also carries the best (smallest) known frame count, which the Time Limit tier derives from.
 *
 * Computed as a dimension-wise sweep rather than comparing every combo against every other one.
 * Dominance here is a product order, so "some A <= C" is a prefix-OR along each axis in turn and
 * "some B >= C" is a suffix-OR -- five linear passes instead of a quadratic scan. The naive form
 * was ~950M inner operations per call, and since every worker re-plans between every combo it
 * was the sweep's real bottleneck, not the file I/O.
 */
function sweep(known, nLoc) {
  // reachDown: some A <= C reached it. bestDown: smallest frame count among those.
  const reachDown = new Uint8Array(N_CELL * nLoc);
  const bestDown = new Int32Array(N_CELL * nLoc).fill(0x7fffffff);
  // deadUp: some complete B >= C failed to reach it.
  const deadUp = new Uint8Array(N_CELL * nLoc);

  for (const { combo, result } of known.values()) {
    const base = cellIndex(combo) * nLoc;
    const af = result.frames;
    const complete = result.complete;
    for (let i = 0; i < nLoc; i++) {
      const f = af[i];
      if (f >= 0) {
        reachDown[base + i] = 1;
        if (f < bestDown[base + i]) bestDown[base + i] = f;
      } else if (complete) {
        deadUp[base + i] = 1;
      }
    }
  }

  // Prefix pass (increasing) for the "<=" direction, suffix pass (decreasing) for ">=".
  const dims = [
    [D_S, ST_S],
    [D_J, ST_J],
    [D_D, ST_D],
    [D_E, ST_E],
    [D_G, ST_G],
  ];
  for (const [size, stride] of dims) {
    for (let cell = 0; cell < N_CELL; cell++) {
      // Only sweep cells whose coordinate on this axis is > 0; the rest are pass-throughs.
      if (Math.floor(cell / stride) % size === 0) continue;
      const cur = cell * nLoc;
      const prev = (cell - stride) * nLoc;
      for (let i = 0; i < nLoc; i++) {
        if (reachDown[prev + i]) reachDown[cur + i] = 1;
        if (bestDown[prev + i] < bestDown[cur + i]) bestDown[cur + i] = bestDown[prev + i];
      }
    }
    for (let cell = N_CELL - 1; cell >= 0; cell--) {
      if (Math.floor(cell / stride) % size === size - 1) continue;
      const cur = cell * nLoc;
      const next = (cell + stride) * nLoc;
      for (let i = 0; i < nLoc; i++) if (deadUp[next + i]) deadUp[cur + i] = 1;
    }
  }

  return { reachDown, bestDown, deadUp };
}

function closure(known, nLoc) {
  const { reachDown, bestDown, deadUp } = sweep(known, nLoc);
  const reach = new Map();
  const frames = new Map();
  for (const c of allCombos()) {
    const base = cellIndex(c) * nLoc;
    const r = new Uint8Array(nLoc);
    const fr = new Int32Array(nLoc);
    for (let i = 0; i < nLoc; i++) {
      if (reachDown[base + i]) {
        r[i] = 1;
        fr[i] = bestDown[base + i];
      } else {
        r[i] = deadUp[base + i] ? 0 : 2;
        fr[i] = -1;
      }
    }
    reach.set(comboId(c), r);
    frames.set(comboId(c), fr);
  }
  return { reach, frames };
}

// Counts straight off the swept arrays. Planning only needs "how many unknowns does this combo
// still have", so materializing per-combo Maps (1,936 x 2 typed arrays, ~1M element copies) is
// wasted work on a path every worker hits between every combo.
function undetermined(known, nLoc) {
  const { reachDown, deadUp } = sweep(known, nLoc);
  const out = [];
  for (const c of allCombos()) {
    if (known.has(comboId(c))) continue;
    const base = cellIndex(c) * nLoc;
    let n = 0;
    for (let i = 0; i < nLoc; i++) if (!reachDown[base + i] && !deadUp[base + i]) n++;
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
  loadAllCached,
  loadAllFrom,
  settingsOf,
  closure,
  undetermined,
  planBatch,
};
