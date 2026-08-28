// The difficulty ladder: one ordered chain through the ability lattice.
//
// The generator, the module solver and the verifier all speak in rungs, and they must all mean
// the same thing by "rung 12", so the order lives here and nowhere else.
//
// A rung is a full combo (speed, jump, doubleJump, energy, ammo, gun). Rung k+1 is rung k plus
// exactly one item, so rung k+1 dominates rung k on every axis and never loses ground on any.
// That is what makes a binary search for "the first rung that clears this module" valid under
// the monotone-closure guarantee the whole solver rests on: reachable at a combo implies
// reachable at every combo above it, so the set of rungs that clear a module is an up-set and
// has exactly one boundary to find.
//
// Rung 0 is the start of a run: nothing bought. moveAccel(0) is 0 and jumpImpulse(0) is null, so
// at rung 0 Johnny can neither walk nor jump -- a module that needs any movement at all comes
// out at rung 1 or above, and only a module whose exit is already inside the spawn box solves at
// rung 0. That is intentional: it makes "rung 0 clears it" a genuine signal that a module is
// degenerate rather than easy.
//
// The item pool the logic can see, and which the 36 steps below spend exactly once each:
//   Speed 10, Jump 10, Double Jump 1, Energy 4 (5 hearts total, base 1), Laser Gun 1, Ammo 10.
//
// Loads as a CommonJS module in node and as a plain script in the browser, the same way
// mapkit/mapformat.js does. The map editor shows this table as its rung reference, and a second
// copy of the ladder -- generated, transcribed, whatever -- would be a second answer to "what
// does rung 12 mean", which is the one thing this file exists to prevent. It is pure data and
// arithmetic with no requires, so sharing it costs nothing.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Ladder = factory();
}(typeof self !== 'undefined' ? self : this, function () {
'use strict';

// The order the items are spent in. This is a design choice, not a derivation: it is the shape
// the generated map's progression will have, so it interleaves the two movement tracks, holds
// Double Jump back until a couple of tiers of each are in, and spreads Energy across the run
// rather than front-loading it.
//
// The gun and Ammo 1 are adjacent on purpose. The game gives you bullets as
// getGun() -> Math.round(ammo.v * 20), so the gun with Ammo 0 fires nothing; the simulator sees
// no difference between "no gun" and "gun, no ammo", which means a module that needs to shoot
// comes out at the Ammo 1 rung. Both stay listed because both are real items in the pool.
const TRACKS = [
  'speed', 'jump', 'speed', 'jump', 'energy',
  'speed', 'jump', 'doubleJump', 'speed', 'jump',
  'gun', 'ammo', 'speed', 'jump', 'energy',
  'ammo', 'speed', 'jump', 'ammo', 'speed',
  'jump', 'energy', 'ammo', 'speed', 'jump',
  'ammo', 'speed', 'jump', 'energy', 'ammo',
  'speed', 'jump', 'ammo', 'ammo', 'ammo', 'ammo',
];

const POOL = { speed: 10, jump: 10, doubleJump: 1, energy: 4, gun: 1, ammo: 10 };

// Fail loudly rather than generating a map against a ladder that spends the wrong items: this
// list is edited by hand and a typo in it is invisible everywhere downstream.
{
  const spent = {};
  for (const t of TRACKS) spent[t] = (spent[t] || 0) + 1;
  for (const k of Object.keys(POOL)) {
    if (spent[k] !== POOL[k]) {
      throw new Error(`ladder.js spends ${spent[k] || 0} ${k}, but the item pool has ${POOL[k]}`);
    }
  }
  for (const k of Object.keys(spent)) {
    if (!(k in POOL)) throw new Error(`ladder.js spends an item the pool does not have: ${k}`);
  }
}

// Rung 0 = nothing, then one entry per item.
const RUNGS = [];
{
  // `energy` is TOTAL hearts, matching fastsim's energyTier -- 1 is the base heart, so the four
  // Energy items take it to 5.
  const at = { speed: 0, jump: 0, doubleJump: 0, energy: 1, gun: 0, ammo: 0 };
  RUNGS.push({ index: 0, gained: null, ...at });
  TRACKS.forEach((track, n) => {
    at[track]++;
    RUNGS.push({ index: n + 1, gained: track, ...at });
  });
}

const N_RUNGS = RUNGS.length; // 37: rung 0 plus one per item

/**
 * The options a rung means to fastsim's `search`.
 *
 * `gun` does not appear: search() takes only ammoTier and treats any ammoTier > 0 as "has the
 * gun", which is exactly the game's behaviour (no ammo, no shots). A caller that wants to know
 * whether a rung has the gun item reads rung.gun.
 */
function searchOpts(rung) {
  return {
    spdTier: rung.speed,
    jmpTier: rung.jump,
    doubleJump: !!rung.doubleJump,
    energyTier: rung.energy,
    ammoTier: rung.ammo,
  };
}

/** Short human label, e.g. "12 spd4/jmp4/dj1/e2/ammo1". */
function label(rung) {
  return (
    `${rung.index} spd${rung.speed}/jmp${rung.jump}/dj${rung.doubleJump}` +
    `/e${rung.energy}/ammo${rung.ammo}`
  );
}

/**
 * Binary search for the lowest rung at which `clears(rung)` is true.
 *
 * Valid only because the ladder is a chain: `clears` must be monotone, false up to some point
 * and true from there on. `clears` returns true, false, or null for "this run could not tell"
 * (a search that hit its frame or hash cap proves nothing) -- an unknown answer aborts rather
 * than being guessed in either direction, since guessing "clears" is the direction that
 * generates an unbeatable map.
 *
 * Returns { minRung, probed } or { minRung: null, probed, unknownAt } if it could not decide.
 */
function findMinRung(clears) {
  const probed = [];
  let lo = 0; // known-or-assumed floor
  let hi = N_RUNGS - 1;
  // The top rung has every item there is; if it cannot clear the module, nothing can.
  const top = clears(RUNGS[hi]);
  probed.push(hi);
  if (top === null) return { minRung: null, probed, unknownAt: hi };
  if (top === false) return { minRung: null, probed, unclearable: true };
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const r = clears(RUNGS[mid]);
    probed.push(mid);
    if (r === null) return { minRung: null, probed, unknownAt: mid };
    if (r) hi = mid;
    else lo = mid + 1;
  }
  return { minRung: lo, probed };
}

/*
 * What a rung MEANS in world pixels.
 *
 * Transcribed from physics.js -- `moveAccel`, `jumpImpulse`, and the frame order of
 * `controls()` then `vy += GRAVITY; y += vy` -- rather than imported, because
 * physics.js derives its world from JU_MAP at require() time and so binds whatever
 * process touches it to one map. This file is pure arithmetic and is safe to load
 * anywhere: the editor's rung reference and solve-module.js's roof check both read
 * it. `tools/test-geometry.js` holds all three against the real functions.
 */
const moveAccel = (spdTier) => (spdTier <= 0 ? 0 : 0.8 + 0.2 * spdTier);
const jumpImpulse = (jmpTier) => (jmpTier <= 0 ? null : 1.1 * jmpTier + 12);

// The jump sets vy = -J and gravity is added BEFORE the move, so the first frame
// rises J-1. Summing to the apex gives n*J - n(n+1)/2 for n = floor(J).
function jumpRise(jmpTier) {
  const J = jumpImpulse(jmpTier);
  if (J === null) return 0;
  const n = Math.floor(J);
  return n * J - (n * (n + 1)) / 2;
}

/*
 * The highest a rung can get above the surface it stands on -- one jump, doubled if
 * it has the double jump. It is an OVER-estimate: it assumes the second jump is
 * spent exactly at the first apex and that nothing is in the way. Over-estimating is
 * the safe direction for the only thing it is used for, deciding whether a surface
 * is out of reach, since it can only ever say "reachable" too eagerly.
 */
const maxRise = (rung) => jumpRise(rung.jump) * (rung.doubleJump ? 2 : 1);

return { RUNGS, N_RUNGS, TRACKS, POOL, searchOpts, label, findMinRung,
         moveAccel, jumpImpulse, jumpRise, maxRise };
}));
