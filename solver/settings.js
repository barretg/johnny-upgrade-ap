// Discretization the atlas is built with. Every combo result on disk was computed with these
// exact values; atlas.js refuses to mix results across different settings.
//
// Chosen empirically (see README): results are identical at qPos 6 vs 8, stride 3/4/5, and
// beamCap 32/64/128/256, so the search is converged rather than discretization-limited. qPos 3
// was actually WORSE -- it drowned in near-duplicate states and truncated before exploring.
//
// Every one of these knobs errs toward under-reporting reachability (merging states can only
// remove routes, never invent them), which makes derived requirements stricter. That is the safe
// direction for AP logic: a too-strict rule delays a check, a too-loose one can generate an
// unbeatable seed.

// Env overrides let a second arm be swept without editing this file. Pair them with
// JU_ATLAS_DIR so each arm gets its own atlas -- atlas.js refuses to mix results computed under
// different settings, which is exactly the protection you want here.
const num = (k, d) => (process.env[k] !== undefined ? Number(process.env[k]) : d);
const bool = (k, d) => (process.env[k] !== undefined ? !/^(0|false|no)$/i.test(process.env[k]) : d);

module.exports = {
  // --- human-execution knobs -------------------------------------------------------------
  // These decide what counts as a route a person could actually pull off, as opposed to one that
  // is merely physically possible. They change results, so they are part of the atlas identity.

  // Clearance (px) required from MOVING hazards only: robots, saws, bombs. Static spikes and
  // lasers are excluded -- fixed geometry can be learned exactly, a moving dodge is a timing read
  // the search always wins. Also what stops the search walking through a patrolling robot on the
  // exact frames its i-frames and patrol phase align.
  hazardMargin: num('JU_HAZARD_MARGIN', 8),

  // Gun recoil sets |vx| to 8 opposite your facing -- faster than you can run at low Speed, so
  // turning around and shooting is a real but frame-perfect speed tech. Off by default.
  recoilBoost: bool('JU_RECOIL_BOOST', false),

  // Damage knockback sets |vx| to 43.2 away from the hazard -- ~4x max run speed. Turning around
  // on the hit to aim that across a gap is a separate trick from tanking a hit for the i-frames,
  // which stays available either way. Off by default.
  knockbackBoost: bool('JU_KNOCKBACK_BOOST', false),

  // Input granularity: a direction is held for this many frames, with an optional single jump tap
  // on the first of them. Also models the fact that a human is not frame-perfect.
  stride: 4,

  // Dedup quantization. Position in px; velocity keys are round(v * qV).
  qPos: 6,
  qVx: 1,
  qVy: 1,

  // Hazard-phase bucketing. States standing inside a moving hazard's swept area carry a coarse
  // frame phase so the same spot can be occupied at different points in a laser/saw/robot cycle
  // -- without this, "wait for the gap" is impossible because standing still is a fixed point.
  phaseMod: 100, // the laser period
  phaseBucket: 10,
  hazardPad: 120,

  // Per-cell beam: at most this many distinct velocity/jump states per (16px cell, phase).
  beamCell: 16,
  beamCap: 64,

  // 9000 frames covers Time Limit tier 24 (147s). Every combo measured so far exhausts its
  // reachable state space long before this, so runs end naturally rather than being cut off.
  maxFrames: 9000,

  // 2^25 slots in the visited hash (~300MB). Heaviest combo measured used 8.4M.
  hashBits: 25,
};
