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

module.exports = {
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
