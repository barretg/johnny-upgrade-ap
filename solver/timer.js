// The countdown, and nothing else.
//
// Johnny replays ONE map per round against a clock, so "can this be reached" and "can this be
// reached in time" are different questions and the second one is often the binding constraint.
// The formula is the game's:
//
//   level.js  tim = Math.round(game.ldat.tim.v * 10 * 6 + 3)   -- seconds = tier*6 + 3
//   clockCode subtracts 1/60 per frame and kills the run at tim < 1
//
// so a run survives F frames iff 6*T + 3 - F/60 >= 1.
//
// It lives on its own because physics.js and fastsim.js each had a copy, and everything that
// wants to price a route in time -- report.js, the module solver, the map generator -- otherwise
// has to require one of those two, which derive their whole world from JU_MAP at require() time
// and so bind the process to a single map. This file is three lines of arithmetic and binds
// nothing.

const MAX_TIME_TIER = 24; // what the shop sells: 24 upgrades over the base 3 seconds

const timerSeconds = (timTier) => Math.round(timTier * 6 + 3);
const framesAllowed = (timTier) => Math.floor((timerSeconds(timTier) - 1) * 60);

/** The cheapest tier that survives `frames`, or null if no tier does. */
function timeTierForFrames(frames) {
  for (let t = 0; t <= MAX_TIME_TIER; t++) if (framesAllowed(t) >= frames) return t;
  return null;
}

module.exports = { MAX_TIME_TIER, timerSeconds, framesAllowed, timeTierForFrames };
