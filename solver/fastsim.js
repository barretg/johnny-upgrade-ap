// Optimized frame-accurate simulator + reachability search for Johnny Upgrade.
//
// Same physics as physics.js (which stays as the readable reference implementation and is what
// test-physics.js checks against); this file is the version the sweep actually runs, restructured
// so a frame-step costs no allocations:
//   * player state lives in a flat Float64Array (struct-of-arrays for layers, a scratch row for
//     stepping), so no per-frame object churn
//   * the whole time-varying world (moving platforms, saws, robots, bombs, laser on/off) is
//     precomputed once into Float64Arrays indexed by frame, shared across every state
//   * coins are bucketed into a uniform grid, so collection checks touch ~1 cell instead of all 246
//   * `visited` is an open-addressed Float64Array hash set rather than a Set<number>
//
// Search shape is unchanged: a frame-layered BFS where layer f is every distinct state reachable
// at frame f. Minimum frames to a location therefore falls straight out of the layer index, and
// "time lost dodging a saw" or "time spent riding a lift" is paid for as real elapsed frames.

// The map under test: vanilla unless JU_MAP names another one (see mapsource.js).
const M = require('./mapsource').load();

const KOL_W = 30;
const KOL_H = 90;
const COIN_KOL = 24;
const GRAVITY = 1;
const MAX_FALL = 90;

// ---------------------------------------------------------------------------
// Tier -> value conversions (shop.js: index = Math.round(v*10), increment u = 0.1)
// ---------------------------------------------------------------------------
const moveAccel = (t) => (t <= 0 ? 0 : 0.8 + 0.2 * t);
const jumpImpulse = (t) => (t <= 0 ? null : -(1.1 * t + 12));
const timerSeconds = (t) => Math.round(t * 6 + 3);
const framesAllowed = (t) => Math.floor((timerSeconds(t) - 1) * 60);
function timeTierForFrames(f) {
  for (let t = 0; t <= 24; t++) if (framesAllowed(t) >= f) return t;
  return null;
}

// ---------------------------------------------------------------------------
// Static geometry
// ---------------------------------------------------------------------------
const N_STATIC = M.plats.length;
const N_PM = M.platMove.length;
const N_PLAT = N_STATIC + N_PM;

// PL[i*5 + 0..4] = l, t, r, b, semi
const PL = new Float64Array(N_PLAT * 5);
M.plats.forEach((ob, i) => {
  PL[i * 5 + 0] = ob.x;
  PL[i * 5 + 1] = ob.y;
  PL[i * 5 + 2] = ob.right;
  PL[i * 5 + 3] = ob.bottom;
  PL[i * 5 + 4] = ob.semi ? 1 : 0;
});
for (let i = 0; i < N_PM; i++) PL[(N_STATIC + i) * 5 + 4] = 1; // platMoves are semi

// Crushers.
//
// mapkit/crushers.js drives EVERY stomper platform from its own map data, defaulting per field
// to the vanilla constant. The solver has to model whatever the runtime will actually do, so it
// reads the same fields with the same defaults -- a vanilla map, which states none of them,
// still gets exactly the stock trigger band (x + 200, 80 wide, y <= 360), 0.25 accel and a
// resting y of -60. physics.js reads the same table.
//
// A map may have any number of them, or none. With none, every crusher branch below is simply
// skipped; the per-crusher state that used to be three scalars is now three per crusher (see
// S_CR0), and how finely the dedup key tells crusher positions apart is decided per run in
// search() against the 53-bit key budget.
const cnum = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
const CRUSHER_SPECS = [];
M.plats.forEach((ob, i) => {
  if (!ob.stomper) return;
  const trigXmin = cnum(ob.trigX, ob.x + 200);
  CRUSHER_SPECS.push({
    idx: i,
    y0: ob.y,
    h: ob.h,
    l: ob.x,
    r: ob.right,
    trigXmin,
    trigXmax: trigXmin + cnum(ob.trigW, 80),
    trigY: cnum(ob.trigY, 360),
    accel: cnum(ob.accel, 0.25),
    fallTo: cnum(ob.fallTo, -60),
    // A repeating crusher climbs back to its start after resting `resetIn` frames and can then
    // fire again; a one-shot one stays where it landed forever (Crushers.install sets its
    // trigY to -Infinity, and the stock stomperCode simply discards it).
    repeat: !!ob.repeat,
    resetIn: cnum(ob.resetIn, 90),
  });
});
const N_CR = CRUSHER_SPECS.length;

// Flat mirrors so the per-frame loop never reads an object property.
const CR_IDX = new Int32Array(N_CR);
const CR_Y0 = new Float64Array(N_CR);
const CR_H = new Float64Array(N_CR);
const CR_L = new Float64Array(N_CR);
const CR_R = new Float64Array(N_CR);
const CR_TXMIN = new Float64Array(N_CR);
const CR_TXMAX = new Float64Array(N_CR);
const CR_TY = new Float64Array(N_CR);
const CR_ACCEL = new Float64Array(N_CR);
const CR_FALLTO = new Float64Array(N_CR);
const CR_REPEAT = new Uint8Array(N_CR);
const CR_RESET = new Float64Array(N_CR);
// Which static platform rows are crushers, for the bullet wall test.
const IS_CRUSHER = new Uint8Array(N_STATIC);
CRUSHER_SPECS.forEach((c, n) => {
  CR_IDX[n] = c.idx;
  CR_Y0[n] = c.y0;
  CR_H[n] = c.h;
  CR_L[n] = c.l;
  CR_R[n] = c.r;
  CR_TXMIN[n] = c.trigXmin;
  CR_TXMAX[n] = c.trigXmax;
  CR_TY[n] = c.trigY;
  CR_ACCEL[n] = c.accel;
  CR_FALLTO[n] = c.fallTo;
  CR_REPEAT[n] = c.repeat ? 1 : 0;
  CR_RESET[n] = c.resetIn;
  IS_CRUSHER[c.idx] = 1;
});

// Static spike rectangles (ldat.spikes). Lasers/enemies/bombs join `spikes` at runtime but move,
// so they live in the per-frame hazard table instead.
const N_SPIKE = M.spikes.length;
const SP = new Float64Array(N_SPIKE * 4);
M.spikes.forEach((ob, i) => {
  SP[i * 4 + 0] = ob.x;
  SP[i * 4 + 1] = ob.y;
  SP[i * 4 + 2] = ob.x + ob.w;
  SP[i * 4 + 3] = ob.y + ob.h;
});

// ---------------------------------------------------------------------------
// Per-frame world tables
// ---------------------------------------------------------------------------
const N_ENE = M.enes.length;
const N_BOMB = M.bombs.length;
const N_LASER = M.lasers.length;

// Laser hitboxes.
//
// iniLevel() force-rotates the FIRST laser in the array to a horizontal 590px beam and gives
// every other one the stock 40x180 upright box -- a hand-tuned detail of the vanilla level.
// mapkit/patcher.js's freeLasers unpins both per laser, so the solver has to read the same
// fields with the same fallbacks or it models a beam of a different shape than the one that
// will actually hurt the player. A laser that states nothing keeps the stock behaviour, so
// vanilla is untouched. Half the beam sits either side of the sprite, which is anchored at
// its centre.
function laserOffset(spec, i) {
  const horizontal = spec.horizontal === undefined ? i === 0 : !!spec.horizontal;
  const half = Math.max(8, Number(spec.length) || (horizontal ? 590 : 180)) / 2;
  return horizontal ? [-half, -20, half, 20] : [-20, -half, 20, half];
}
const N_HAZ = N_ENE + N_BOMB + N_LASER;

let MAXF = 0;
let PMX, PMY; // moving platform positions per frame: [f*N_PM + i]
let HZ; // hazard boxes per frame: [(f*N_HAZ + i)*4 + 0..3] = l,t,r,b
let HZK; // 1 if this hazard knocks back (enemy/bomb), 0 for spikes/lasers
const OFF_BLOCK = 1e9;

function buildWorld(maxFrames) {
  if (MAXF >= maxFrames && PMX) return;
  MAXF = maxFrames;
  const F = maxFrames + 4;
  PMX = new Float64Array(F * N_PM);
  PMY = new Float64Array(F * N_PM);
  HZ = new Float64Array(F * N_HAZ * 4);
  HZK = new Uint8Array(N_HAZ);
  for (let i = 0; i < N_ENE + N_BOMB; i++) HZK[i] = 1;

  // moving platforms
  const pmx = M.platMove.map((p) => p.x);
  const pmy = M.platMove.map((p) => p.y);
  const pmvx = M.platMove.map((p) => p.xx);
  const pmvy = M.platMove.map((p) => p.yy);
  // enemies
  const ex = M.enes.map((e) => e.x);
  const ey = M.enes.map((e) => e.y);
  const evx = M.enes.map((e) => e.xx);
  const evy = M.enes.map((e) => e.yy);
  const ekol = M.enes.map((e) =>
    e.typ === 'robot' ? [-40, -120, 40, 0] : [-30, -30, 30, 30]
  );
  // bombs
  const bxsi = M.bombs.map(() => 0);
  const bysi = M.bombs.map(() => 0);

  for (let f = 0; f < F; f++) {
    if (f > 0) {
      for (let i = 0; i < N_PM; i++) {
        const p = M.platMove[i];
        pmx[i] += pmvx[i] * 0.8;
        if (pmx[i] < p.xmin || pmx[i] > p.xmax) pmvx[i] *= -1;
        pmy[i] += pmvy[i] * 0.7;
        if (pmy[i] < p.ymin) {
          pmy[i] = p.ymin;
          pmvy[i] *= -1;
        }
        if (pmy[i] > p.ymax) {
          pmy[i] = p.ymax;
          pmvy[i] *= -1;
        }
      }
      for (let i = 0; i < N_ENE; i++) {
        const e = M.enes[i];
        ex[i] += evx[i];
        if (ex[i] < e.xmin || ex[i] > e.xmax) evx[i] *= -1;
        ey[i] += evy[i];
        if (ey[i] < e.ymin || ey[i] > e.ymax) evy[i] *= -1;
      }
    }
    for (let i = 0; i < N_PM; i++) {
      PMX[f * N_PM + i] = pmx[i];
      PMY[f * N_PM + i] = pmy[i];
    }
    for (let i = 0; i < N_ENE; i++) {
      const k = (f * N_HAZ + i) * 4;
      HZ[k] = ex[i] + ekol[i][0];
      HZ[k + 1] = ey[i] + ekol[i][1];
      HZ[k + 2] = ex[i] + ekol[i][2];
      HZ[k + 3] = ey[i] + ekol[i][3];
    }
    for (let i = 0; i < N_BOMB; i++) {
      const b = M.bombs[i];
      let bx, by;
      if (f === 0) {
        bx = b.x;
        by = b.y;
        // iniLevel's initial bounds are +/-45; bombCode overwrites with +/-40 from frame 1.
        const k = (f * N_HAZ + N_ENE + i) * 4;
        HZ[k] = bx - 45;
        HZ[k + 1] = by - 45;
        HZ[k + 2] = bx + 45;
        HZ[k + 3] = by + 45;
        continue;
      }
      by = b.yo + Math.sin(bysi[i]) * b.ymax;
      bysi[i] += b.yysi;
      bx = b.xo + Math.sin(bxsi[i]) * b.xmax;
      bxsi[i] += b.xxsi;
      const k = (f * N_HAZ + N_ENE + i) * 4;
      HZ[k] = bx - 40;
      HZ[k + 1] = by - 40;
      HZ[k + 2] = bx + 40;
      HZ[k + 3] = by + 40;
    }
    for (let i = 0; i < N_LASER; i++) {
      const L = M.lasers[i];
      const off = laserOffset(L, i);
      // laserCode: ctCurr--, goes noKol at ctSwitch, resets to ctMax at <=0.
      let active;
      if (f === 0) active = true;
      else {
        const per = L.ctMax;
        const v = ((((L.ctCurr - f) % per) + per) % per) || per;
        active = v > L.ctSwitch;
      }
      const k = (f * N_HAZ + N_ENE + N_BOMB + i) * 4;
      if (active) {
        HZ[k] = L.x + off[0];
        HZ[k + 1] = L.y + off[1];
        HZ[k + 2] = L.x + off[2];
        HZ[k + 3] = L.y + off[3];
      } else {
        HZ[k] = OFF_BLOCK;
        HZ[k + 1] = OFF_BLOCK;
        HZ[k + 2] = OFF_BLOCK + 1;
        HZ[k + 3] = OFF_BLOCK + 1;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Targets: coins, gun pickup, boss gate, robot kill positions
// ---------------------------------------------------------------------------
const COINS = M.coins.map((c, i) => ({ i, x: c.x, y: c.y }));
const N_COIN = COINS.length;
const CX = new Float64Array(N_COIN);
const CY = new Float64Array(N_COIN);
COINS.forEach((c, i) => {
  CX[i] = c.x;
  CY[i] = c.y;
});

// Uniform grid over coin positions so a collection test looks at a couple of buckets.
const CELL = 128;
const GX0 = -1800;
const GY0 = -800;
const GW = Math.ceil(5600 / CELL);
const GH = Math.ceil(3800 / CELL);
const gridBuckets = new Array(GW * GH);
for (let i = 0; i < N_COIN; i++) {
  const gx = Math.floor((CX[i] - GX0) / CELL);
  const gy = Math.floor((CY[i] - GY0) / CELL);
  const id = gy * GW + gx;
  (gridBuckets[id] || (gridBuckets[id] = [])).push(i);
}
// Flatten to typed arrays for cache-friendly iteration.
const GSTART = new Int32Array(GW * GH + 1);
{
  let n = 0;
  for (let i = 0; i < GW * GH; i++) {
    GSTART[i] = n;
    if (gridBuckets[i]) n += gridBuckets[i].length;
  }
  GSTART[GW * GH] = n;
}
const GITEM = new Int32Array(GSTART[GW * GH]);
{
  let n = 0;
  for (let i = 0; i < GW * GH; i++) {
    if (gridBuckets[i]) for (const c of gridBuckets[i]) GITEM[n++] = c;
  }
}

const GUN_BOX = [M.colGun.x - 50, M.colGun.y - 50, M.colGun.x + 50, M.colGun.y + 50];
const GATE = M.bossData.gate;
const SPAWN_X = M.sprt.x;
const SPAWN_Y = M.sprt.y;

// ---------------------------------------------------------------------------
// Open-addressed hash set of 48-bit keys
// ---------------------------------------------------------------------------
class KeySet {
  constructor(bits) {
    this.mask = (1 << bits) - 1;
    this.keys = new Float64Array(1 << bits);
    this.used = new Uint8Array(1 << bits);
    this.size = 0;
    this.cap = Math.floor((1 << bits) * 0.72);
  }
  // Returns true if newly inserted.
  add(k) {
    const m = this.mask;
    // Fibonacci-ish mix on the low/high halves of the 48-bit key.
    const lo = k % 4294967296;
    const hi = (k - lo) / 4294967296;
    let i = ((lo ^ (hi * 2654435761)) >>> 0) & m;
    const keys = this.keys;
    const used = this.used;
    for (;;) {
      if (!used[i]) {
        used[i] = 1;
        keys[i] = k;
        this.size++;
        return true;
      }
      if (keys[i] === k) return false;
      i = (i + 1) & m;
    }
  }
  get full() {
    return this.size >= this.cap;
  }
}

// ---------------------------------------------------------------------------
// State layout
// ---------------------------------------------------------------------------
const S_X = 0,
  S_Y = 1,
  S_VX = 2,
  S_VY = 3,
  S_JU = 4,
  S_PU = 5, // platUnder: -1 or moving-platform index
  S_SC = 6, // facing
  S_HP = 7,
  S_INV = 8,
  S_AMMO = 9, // bullets left (getGun: round(ammo.v * 20) = 2 per tier)
  S_KILL = 10, // bitmask of hazards shot dead this run; killRobot/hitBomb are permanent
  // Three slots per crusher, in CRUSHER_SPECS order:
  //   +0  y           current top edge
  //   +1  vy / wait   fall velocity while falling, frames left while waiting to reset
  //   +2  flag        0 armed, 1 falling, 2 at rest, 3 waiting to reset (repeat only)
  S_CR0 = 11,
  S_N = S_CR0 + 3 * N_CR;

const scratch = new Float64Array(S_N);

// Which per-frame hazard slots a bullet can actually destroy. killEnemy() only handles
// e.robot, e.bomb and e.boss -- saws and lasers just absorb the shot.
const KILLABLE = [];
M.enes.forEach((e, i) => {
  if (e.typ === 'robot') KILLABLE.push(i);
});
for (let i = 0; i < N_BOMB; i++) KILLABLE.push(N_ENE + i);

const ROBOT_HAZARDS = M.enes.map((e, i) => (e.typ === 'robot' ? i : -1)).filter((i) => i >= 0);

// ---------------------------------------------------------------------------
// One frame. Returns 0 = ok, 1 = dead, 2 = grabbed by the boss gate.
// Mirrors LevelState.update()'s ordering exactly.
// ---------------------------------------------------------------------------
// Bit index within S_KILL for a given hazard slot, or -1 if this run does not track it.
// Only hazards that actually gate progress are tracked; carrying all 9 bits would blow the
// 53-bit budget the packed dedup key has to fit in.
let KILL_BIT = new Int8Array(N_HAZ).fill(-1);
// Set by search(): called with (hazardSlot, frame) whenever a bullet actually connects, so robot
// kills are recorded as real events. A robot can ONLY die to a bullet -- killRobot() is reachable
// from bulletHitEnemy() and nowhere else -- so enemysanity checks are gun-gated by construction.
let KILL_RECORDER = null;

// Movement techs that are real but frame-perfect, so they belong behind yaml settings rather
// than in default logic. Set per search() call from opts.
//
// These gate the player's CHOICE OF DIRECTION, not the existence of the shove. Vanilla always
// replaces vx on a hit and on a shot; what takes skill is arranging to be facing the way that
// makes the shove carry you forward instead of back. Switching a tech off therefore forces the
// direction to the one that penalises you -- it does not delete the impulse. Deleting it made
// every forced hit CHEAPER than vanilla (a heart bought clean passage with no lost ground),
// which is the too-loose direction, and it is what made spike-corridor solve at rung 5.
let ALLOW_RECOIL_BOOST = true;
let ALLOW_KNOCKBACK_BOOST = true;

/**
 * The horizontal impulse an opposite-the-facing kick gives, with the tech switched off.
 *
 * `mag` is the vanilla magnitude (43.2 for a hit, 6.4 for a shot). The facing is pinned to the
 * direction of TRAVEL, so the kick always opposes the motion and can never be aimed.
 *
 * Standing still returns 0 rather than kicking along s[S_SC]. Facing really is "the last direction
 * pressed", and the search can press a direction without moving -- held against a wall, or at the
 * apex of a deceleration -- so reading S_SC here would hand back the whole trick: stand in a spike
 * holding left, get flung right every 60 frames. Dropping the impulse instead removes a launch,
 * and removing launches under-reports reachability, which is the safe direction. It is the one
 * place this model is deliberately stricter than the game rather than equal to it.
 */
function honestKick(s, mag) {
  if (!s[S_VX]) return 0;
  return s[S_VX] > 0 ? -mag : mag;
}

// A "hazard clearance margin" was tried here and removed: inflating the player's damage box makes
// contact MORE likely, and with spare hearts each extra contact is a free 43.2px/frame knockback
// launch. Measured effect was the opposite of the intent -- a 16px margin let spd7/jmp3/DJ/e5
// reach 238 coins instead of 224. Keeping frame-perfect play out of logic is the time margin's
// job (report.js) plus disabling the boosts below.

/**
 * Fire a bullet and resolve it immediately.
 *
 * Resolving on the spot rather than carrying bullets in the state is sound here, not just
 * cheap: a bullet moves 20px/frame and the player at most 4*spd = 11.2px/frame, so the bullet
 * always reaches a target before the player could, whichever way either is moving. There is no
 * way for the player to benefit from a kill "early".
 */
function fireBullet(s, frame) {
  const dirX = s[S_SC] >= 0 ? 1 : -1;
  let bx = s[S_X] + dirX * 20;
  const by = s[S_Y] - 60;
  for (let step = 0; step < 60; step++) {
    bx += dirX * 20;
    const f = Math.min(MAXF, frame + step);
    const bl = bx - 12,
      br = bx + 12,
      bt = by - 12,
      bb = by + 12;
    // bulletHitWall: any solid stops it.
    for (let i = 0; i < N_STATIC; i++) {
      const b = i * 5;
      if (IS_CRUSHER[i]) continue;
      if (bl < PL[b + 2] && br > PL[b] && bt < PL[b + 3] && bb > PL[b + 1]) return;
    }
    // bulletHitEnemy: iterates `spikes`, so static spikes/lasers/saws absorb the shot too.
    for (let i = 0; i < N_SPIKE; i++) {
      const b = i * 4;
      if (bl < SP[b + 2] && br > SP[b] && bt < SP[b + 3] && bb > SP[b + 1]) return;
    }
    const base = f * N_HAZ * 4;
    for (let i = 0; i < N_HAZ; i++) {
      const bit = KILL_BIT[i];
      if (bit >= 0 && s[S_KILL] & (1 << bit)) continue; // already dead
      const b = base + i * 4;
      if (bl < HZ[b + 2] && br > HZ[b] && bt < HZ[b + 3] && bb > HZ[b + 1]) {
        if (bit >= 0) s[S_KILL] |= 1 << bit;
        if (KILL_RECORDER) KILL_RECORDER(i, f);
        return;
      }
    }
  }
}

function stepFrame(s, frame, dir, jump, spd, jh, jumpMax, shoot) {
  // invCode
  if (s[S_INV] > 0) {
    s[S_INV]--;
    if (s[S_INV] < 0) s[S_INV] = 0;
  }

  // stomperCode, once per crusher. Ordering matches the stock routine: a crusher that arms this
  // frame also takes its first fall step this frame (which moves it 0px, since round(0.25) = 0).
  for (let c = 0; c < N_CR; c++) {
    const cb = S_CR0 + c * 3;
    const fl = s[cb + 2];
    if (fl === 2) continue; // one-shot, already landed: inert for the rest of the run
    if (fl === 3) {
      // Resting before it climbs back. It is still solid at fallTo the whole time, and the
      // frame it resets it cannot also re-trigger.
      if (--s[cb + 1] <= 0) {
        s[cb] = CR_Y0[c];
        s[cb + 1] = 0;
        s[cb + 2] = 0;
      }
      continue;
    }
    if (fl === 0) {
      if (s[S_Y] <= CR_TY[c] && s[S_X] > CR_TXMIN[c] && s[S_X] < CR_TXMAX[c]) {
        s[cb + 2] = 1;
        s[cb + 1] = 0;
      }
    }
    if (s[cb + 2] === 1) {
      s[cb + 1] += CR_ACCEL[c];
      s[cb] += Math.round(s[cb + 1]);
      const t = s[cb];
      const b = t + CR_H[c];
      if (s[S_X] - KOL_W < CR_R[c] && s[S_X] + KOL_W > CR_L[c] && s[S_Y] - KOL_H < b && s[S_Y] > t) {
        return 1; // killSprite(stomper, 10): lethal at every energy tier
      }
      if (s[cb] >= CR_FALLTO[c]) {
        s[cb] = CR_FALLTO[c];
        if (CR_REPEAT[c]) {
          s[cb + 2] = 3;
          s[cb + 1] = CR_RESET[c];
        } else {
          s[cb + 2] = 2;
        }
      }
    }
  }

  // platMoveCode carrying the player
  const pu = s[S_PU];
  if (pu >= 0) {
    const cur = PMX[frame * N_PM + pu];
    const prv = PMX[(frame - 1) * N_PM + pu];
    s[S_X] += cur - prv;
    s[S_Y] = PMY[frame * N_PM + pu] + 8; // platMove.t = y + 4, then sprt.y = t + 4
  }

  // Refresh moving-platform rows in the platform table for this frame.
  for (let i = 0; i < N_PM; i++) {
    const px = PMX[frame * N_PM + i];
    const py = PMY[frame * N_PM + i];
    const base = (N_STATIC + i) * 5;
    PL[base] = px - 100;
    PL[base + 1] = py + 4;
    PL[base + 2] = px + 100;
    PL[base + 3] = py + 60;
  }
  // And each crusher's current vertical extent. They are solid in every state, resting or not.
  for (let c = 0; c < N_CR; c++) {
    const base = CR_IDX[c] * 5;
    const y = s[S_CR0 + c * 3];
    PL[base + 1] = y;
    PL[base + 3] = y + CR_H[c];
  }

  // controls()
  if (dir < 0 && spd > 0) {
    s[S_VX] -= spd;
    s[S_SC] = -1;
  } else if (dir > 0 && spd > 0) {
    s[S_VX] += spd;
    s[S_SC] = 1;
  }
  if (jump && jh !== 0 && s[S_JU] < jumpMax) {
    s[S_VY] = jh;
    s[S_JU]++;
  }
  // controls(): firing comes after the jump handler, so a same-frame jump eats the !ju case and
  // the shot gives no lift. The -12 boost only happens from a standing start, once per landing.
  if (shoot && s[S_AMMO] > 0) {
    s[S_AMMO]--;
    if (!s[S_JU]) {
      s[S_VY] -= 12;
      s[S_JU]++;
    }
    // Recoil REPLACES vx with 8 in the direction opposite your facing. At low Speed that is
    // faster than you can run, so turning around and shooting is a genuine movement tech --
    // neat, but frame-perfect and not beginner level, hence the switch. The vertical bullet-hop
    // above is unaffected.
    //
    // With the tech off the recoil still fires, it just fires BACKWARDS: firing on the move costs
    // you your run speed in vanilla, and a model that let you shoot and keep running would make
    // every must-shoot route cheaper than the real game.
    s[S_VX] = ALLOW_RECOIL_BOOST
      ? (s[S_SC] === -1 ? -0.8 : 0.8) * -8
      : honestKick(s, 0.8 * 8);
    fireBullet(s, frame);
  }

  // leftRightCode()
  s[S_VX] *= 0.8;
  if (s[S_VX] < 0.5 && s[S_VX] > -0.5) s[S_VX] = 0;
  s[S_X] += s[S_VX];
  {
    const vx = s[S_VX];
    let newVX = vx;
    for (let i = 0; i < N_PLAT; i++) {
      const b = i * 5;
      if (PL[b + 4]) continue; // semi platforms do not block horizontally
      if (
        s[S_X] - KOL_W < PL[b + 2] &&
        s[S_X] + KOL_W > PL[b] &&
        s[S_Y] - KOL_H < PL[b + 3] &&
        s[S_Y] > PL[b + 1]
      ) {
        if (vx > 0) {
          newVX = 0;
          s[S_X] = PL[b] - KOL_W;
        } else if (vx < 0) {
          newVX = 0;
          s[S_X] = PL[b + 2] + KOL_W;
        }
      }
    }
    s[S_VX] = newVX;
  }

  // gravCode()
  s[S_VY] += GRAVITY;
  if (s[S_VY] > MAX_FALL) s[S_VY] = MAX_FALL;
  s[S_Y] += s[S_VY];
  s[S_PU] = -1;
  {
    const vy = s[S_VY];
    let newVY = vy;
    let newY = s[S_Y];
    for (let i = 0; i < N_PLAT; i++) {
      const b = i * 5;
      if (
        s[S_X] - KOL_W < PL[b + 2] &&
        s[S_X] + KOL_W > PL[b] &&
        s[S_Y] - KOL_H < PL[b + 3] &&
        s[S_Y] > PL[b + 1]
      ) {
        if (vy >= 0) {
          if (s[S_Y] - vy - 5 > PL[b + 1]) continue;
          if (i >= N_STATIC) s[S_PU] = i - N_STATIC;
          if (PL[b + 1] < newY) newY = PL[b + 1];
          s[S_JU] = 0;
          newVY = 0;
        }
        if (vy < 0 && !PL[b + 4]) {
          s[S_Y] = PL[b + 3] + KOL_H;
          newY = s[S_Y];
          newVY = 0;
        }
      }
    }
    s[S_Y] = newY;
    s[S_VY] = newVY;
  }
  if (s[S_VY] > 1 && !s[S_JU]) s[S_JU] = 1;

  // spikeCode()
  if (s[S_INV] <= 0) {
    const l = s[S_X] - KOL_W,
      r = s[S_X] + KOL_W,
      t = s[S_Y] - KOL_H,
      bo = s[S_Y];
    let hitK = -1;
    for (let i = 0; i < N_SPIKE; i++) {
      const b = i * 4;
      if (l < SP[b + 2] && r > SP[b] && t < SP[b + 3] && bo > SP[b + 1]) {
        hitK = -2;
        break;
      }
    }
    if (hitK === -1) {
      const base = frame * N_HAZ * 4;
      for (let i = 0; i < N_HAZ; i++) {
        const bit = KILL_BIT[i];
        if (bit >= 0 && s[S_KILL] & (1 << bit)) continue; // shot dead earlier this run
        const b = base + i * 4;
        if (l < HZ[b + 2] && r > HZ[b] && t < HZ[b + 3] && bo > HZ[b + 1]) {
          hitK = i;
          break;
        }
      }
    }
    if (hitK !== -1) {
      s[S_HP]--;
      if (s[S_HP] <= 0) return 1;
      s[S_JU] = 9;
      if (hitK >= 0 && HZK[hitK]) {
        const b = frame * N_HAZ * 4 + hitK * 4;
        const cx = (HZ[b] + HZ[b + 2]) / 2;
        s[S_SC] = s[S_X] > cx ? -1 : 1;
      }
      // Knockback REPLACES vx with 43.2 opposite the facing -- roughly 4x max run speed.
      //
      // For an enemy or a bomb, killSprite sets the facing from which side of the hazard you are
      // on (just above), so the shove always points away from it: vanilla, not choosable, and
      // applied whatever the settings say.
      //
      // For a spike or a laser the facing is your own, and turning around on the hit so the shove
      // carries you forward is the tech. With it off the facing is pinned to your direction of
      // travel, so the shove always costs you ground. It is NOT removed: tanking a hit through a
      // spike strip costs a heart AND distance in the real game, and modelling it as a free heart
      // is what let this simulator walk spike-corridor at 2 hearts when a person needs 4.
      s[S_VX] =
        ALLOW_KNOCKBACK_BOOST || (hitK >= 0 && HZK[hitK])
          ? (s[S_SC] === -1 ? -0.8 : 0.8) * -54
          : honestKick(s, 0.8 * 54);
      s[S_VY] = -20;
      s[S_INV] = 60;
    }
  }

  // Boss gate: bossSleep() takes control away and railroads you into the arena.
  if (
    s[S_X] - KOL_W < GATE.r &&
    s[S_X] + KOL_W > GATE.l &&
    s[S_Y] - KOL_H < GATE.b &&
    s[S_Y] > GATE.t
  ) {
    return 2;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------
const DEFAULTS = {
  stride: 3,
  maxFrames: 5400,
  qPos: 3,
  qVx: 2,
  qVy: 2,
  phaseMod: 100,
  phaseBucket: 5,
  hazardPad: 240,
  hashBits: 24,
  energyTier: 1,
  ammoTier: 0,
  // Per-cell beam. Without it the high-mobility combos generate tens of millions of states that
  // are just "the same spot at every conceivable velocity", and the search drowns before it gets
  // anywhere. Capping how many distinct velocity/jump states survive per (position cell, hazard
  // phase) bounds the whole search at roughly cells * cap. Raise until results stop moving.
  beamCell: 16,
  beamCap: 64,
};

function buildHazardZones(pad) {
  const z = [];
  for (const e of M.enes) {
    const k = e.typ === 'robot' ? [-40, -120, 40, 0] : [-30, -30, 30, 30];
    z.push([e.xmin + k[0] - pad, e.ymin + k[1] - pad, e.xmax + k[2] + pad, e.ymax + k[3] + pad]);
  }
  for (const b of M.bombs) {
    z.push([
      b.xo - b.xmax - 40 - pad,
      b.yo - b.ymax - 40 - pad,
      b.xo + b.xmax + 40 + pad,
      b.yo + b.ymax + 40 + pad,
    ]);
  }
  M.lasers.forEach((L, i) => {
    const o = laserOffset(L, i);
    z.push([L.x + o[0] - pad, L.y + o[1] - pad, L.x + o[2] + pad, L.y + o[3] + pad]);
  });
  for (const p of M.platMove) {
    z.push([p.xmin - 100 - pad, p.ymin - pad, p.xmax + 100 + pad, p.ymax + 60 + pad]);
  }
  const out = new Float64Array(z.length * 4);
  z.forEach((r, i) => out.set(r, i * 4));
  return out;
}

const ACT_DIR = [0, -1, 1, 0, -1, 1, 0, -1, 1];
const ACT_JMP = [0, 0, 0, 1, 1, 1, 0, 0, 0];
const ACT_SHOOT = [0, 0, 0, 0, 0, 0, 1, 1, 1];

function search(opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const spd = moveAccel(o.spdTier);
  const jhRaw = jumpImpulse(o.jmpTier);
  const jh = jhRaw === null ? 0 : jhRaw;
  const jumpMax = 1 + (o.doubleJump ? 0.1 : 0);

  buildWorld(o.maxFrames + o.stride + 4);
  const ZONES = buildHazardZones(o.hazardPad);
  const NZ = ZONES.length / 4;

  const nx = Math.ceil(5600 / o.qPos);
  const ny = Math.ceil(3800 / o.qPos);
  // vx normally tops out at 4*spd = 11.2. A damage knockback sets it to +/-43.2, so runs that
  // can survive a hit need a much wider bucket range; runs at 1 heart never see those values and
  // keeping their key narrow is what leaves room for the gun's ammo/kill bits under the 53-bit
  // budget the packed key has to fit in.
  const nvx = (o.energyTier > 1 ? Math.ceil(44 * o.qVx) : Math.ceil(13 * o.qVx)) * 2 + 4;
  const nvxOff = nvx >> 1;
  const nvy = Math.ceil(95 * o.qVy) + Math.ceil(25 * o.qVy) + 4;
  const nvyOff = Math.ceil(25 * o.qVy) + 2;
  const nphase = Math.ceil(o.phaseMod / o.phaseBucket) + 1;
  // Energy only widens the state space when there is more than one heart to spend: at tier 1 any
  // contact is fatal, so hearts and i-frames are constants and stay out of the key.
  const trackDamage = o.energyTier > 1;
  const nhp = trackDamage ? o.energyTier + 1 : 1;
  const ninv = trackDamage ? 9 : 1;

  // Gun arm. ammoTier 0 means the player has never picked the gun up.
  ALLOW_RECOIL_BOOST = o.recoilBoost !== false;
  ALLOW_KNOCKBACK_BOOST = o.knockbackBoost !== false;
  const hasGun = (o.ammoTier || 0) > 0;
  const startAmmo = hasGun ? o.ammoTier * 2 : 0; // getGun(): Math.round(ammo.v * 20)
  KILL_BIT = new Int8Array(N_HAZ).fill(-1);
  // Only robots get a kill bit. which-blockers.js shows ene4 is the single hazard that gates
  // anything, and bombs oscillate rather than patrol so they can always be waited out; a bullet
  // that hits an untracked hazard still spends the ammo but leaves the hazard standing, which
  // errs strict rather than permissive.
  const tracked = o.trackKills || (hasGun ? ROBOT_HAZARDS : []);
  tracked.forEach((h, bit) => {
    KILL_BIT[h] = bit;
  });
  const nkill = 1 << tracked.length;
  const nammo = hasGun ? startAmmo + 1 : 1;

  // --- crusher resolution in the dedup key ---------------------------------------------------
  //
  // The simulation always carries each crusher's exact y; this only decides how finely two
  // states that differ *only* in where a crusher is get told apart. Coarser buckets merge
  // states, which can remove routes but never invent them -- the safe direction, and the same
  // trade every other quantization knob here makes. What is NOT safe is dropping crusher state
  // from the key altogether: that makes "stand still and wait for it to fall" a fixed point and
  // silently deletes the routes that depend on waiting, so every crusher keeps at least its
  // armed / falling / at-rest distinction no matter how tight the budget gets.
  //
  // Digit layout per crusher, chosen to reproduce the single-crusher encoding exactly so a
  // vanilla atlas built before this stays valid:
  //   0                     armed
  //   1                     falling, when bf is 0 -- otherwise unused
  //   2                     at rest (one-shot landed, or a repeater sitting at fallTo)
  //   3 .. 3+bf-1           falling, bucketed by how far it has fallen
  //   3+bf .. 3+bf+bw-1     waiting to reset (repeating crushers only)
  // Radix 3 + bf + bw, i.e. 35 at bf = 32 with no repeat, which is what the old code used, and
  // 3 at the floor -- armed / falling / at rest, the distinction that must never be given up.
  //
  // The whole key must stay under 2^53 to be an exact integer, so the crusher digits get
  // whatever is left after position, velocity, jump count, hazard phase, hearts/i-frames and
  // ammo/kills have taken their share. bf is turned down uniformly until the product fits.
  const keyBase =
    nx * ny * nvx * nvy * 3 * nphase *
    (trackDamage ? nhp * ninv : 1) *
    (hasGun ? nammo * nkill : 1);
  const crusherRoom = Math.pow(2, 53) / keyBase;
  let bf = 32;
  const bwFor = (b) => Math.min(8, b);
  const radixProduct = (b) => {
    let prod = 1;
    for (let c = 0; c < N_CR; c++) prod *= 3 + b + (CR_REPEAT[c] ? bwFor(b) : 0);
    return prod;
  };
  while (bf > 0 && radixProduct(bf) > crusherRoom) bf--;
  if (N_CR && radixProduct(bf) > crusherRoom) {
    throw new Error(
      'This map has ' + N_CR + ' crushers; at this combo the dedup key has room for at most ' +
        Math.floor(Math.log(crusherRoom) / Math.log(3)) + '. Each one costs a factor of 3 even ' +
        'with its position fully merged (armed / falling / at rest is the least that can be ' +
        'tracked without turning "wait for it to fall" into a fixed point), and the packed key ' +
        'must stay under 2^53. Use fewer crushers, or shrink another key dimension in settings.js.'
    );
  }
  const CR_BF = new Int32Array(N_CR);
  const CR_BW = new Int32Array(N_CR);
  const CR_RADIX = new Int32Array(N_CR);
  const CR_KBASE = new Float64Array(N_CR); // y of fall bucket 0's lower edge
  const CR_KSTEP = new Float64Array(N_CR);
  for (let c = 0; c < N_CR; c++) {
    CR_BF[c] = bf;
    CR_BW[c] = CR_REPEAT[c] ? bwFor(bf) : 0;
    CR_RADIX[c] = 3 + CR_BF[c] + CR_BW[c];
    // 20px buckets, widened only when the fall is too long to cover at that size. Vanilla's
    // 420px-tall slab falling from -420 to -60 keeps the original 20px/-440 grid exactly.
    CR_KBASE[c] = CR_Y0[c] - 20;
    CR_KSTEP[c] = CR_BF[c] ? Math.max(20, Math.ceil((CR_FALLTO[c] - CR_Y0[c] + 40) / CR_BF[c])) : 1;
  }

  let lastPhase = 0; // set by keyOf, consumed by beamAdmit
  function keyOf(s, frame) {
    let qx = Math.round((s[S_X] + 1800) / o.qPos);
    let qy = Math.round((s[S_Y] + 800) / o.qPos);
    if (qx < 0) qx = 0;
    else if (qx >= nx) qx = nx - 1;
    if (qy < 0) qy = 0;
    else if (qy >= ny) qy = ny - 1;
    let qvx = Math.round(s[S_VX] * o.qVx) + nvxOff;
    if (qvx < 0) qvx = 0;
    else if (qvx >= nvx) qvx = nvx - 1;
    let qvy = Math.round(s[S_VY] * o.qVy) + nvyOff;
    if (qvy < 0) qvy = 0;
    else if (qvy >= nvy) qvy = nvy - 1;
    const ju = s[S_JU] >= 2 ? 2 : s[S_JU];
    let phase = 0;
    for (let i = 0; i < NZ; i++) {
      const b = i * 4;
      if (s[S_X] > ZONES[b] && s[S_X] < ZONES[b + 2] && s[S_Y] > ZONES[b + 1] && s[S_Y] < ZONES[b + 3]) {
        phase = 1 + Math.floor((frame % o.phaseMod) / o.phaseBucket);
        break;
      }
    }
    lastPhase = phase;
    let k = qx;
    k = k * ny + qy;
    k = k * nvx + qvx;
    k = k * nvy + qvy;
    k = k * 3 + ju;
    for (let c = 0; c < N_CR; c++) {
      const cb = S_CR0 + c * 3;
      const fl = s[cb + 2];
      let d;
      if (fl === 0) d = 0;
      else if (fl === 2) d = 2;
      else if (fl === 1) {
        if (CR_BF[c] === 0) d = 1; // no room to bucket the fall; "falling" is one state
        else {
          let q = Math.round((s[cb] - CR_KBASE[c]) / CR_KSTEP[c]);
          if (q < 0) q = 0;
          else if (q >= CR_BF[c]) q = CR_BF[c] - 1;
          d = 3 + q;
        }
      } else {
        // Waiting to climb back: the remaining wait, coarsely, so a repeater's cycle is not a
        // fixed point. With no wait buckets it collapses to "at rest", which merges states.
        if (CR_BW[c] === 0) d = 2;
        else {
          let q = Math.floor((s[cb + 1] * CR_BW[c]) / CR_RESET[c]);
          if (q < 0) q = 0;
          else if (q >= CR_BW[c]) q = CR_BW[c] - 1;
          d = 3 + CR_BF[c] + q;
        }
      }
      k = k * CR_RADIX[c] + d;
    }
    k = k * nphase + phase;
    if (trackDamage) {
      k = k * nhp + s[S_HP];
      k = k * ninv + (s[S_INV] >= 64 ? 8 : s[S_INV] >> 3);
    }
    if (hasGun) {
      k = k * nammo + s[S_AMMO];
      k = k * nkill + s[S_KILL];
    }
    return k;
  }

  const visited = new KeySet(o.hashBits);

  // Beam bookkeeping: how many states have already been admitted for each (coarse cell, phase).
  const bw = Math.ceil(5600 / o.beamCell);
  const bh = Math.ceil(3800 / o.beamCell);
  const beamCount = new Uint16Array(bw * bh * nphase);
  function beamAdmit(s, phase) {
    let bx = Math.floor((s[S_X] + 1800) / o.beamCell);
    let by = Math.floor((s[S_Y] + 800) / o.beamCell);
    if (bx < 0) bx = 0;
    else if (bx >= bw) bx = bw - 1;
    if (by < 0) by = 0;
    else if (by >= bh) by = bh - 1;
    const idx = (by * bw + bx) * nphase + phase;
    if (beamCount[idx] >= o.beamCap) return false;
    beamCount[idx]++;
    return true;
  }

  // Results
  const coinFrame = new Int32Array(N_COIN).fill(-1);
  let coinsFound = 0;
  let gunFrame = -1;
  let gateFrame = -1;
  // Sampled positions where the player stood, used afterwards for robot line-of-fire checks.
  const shotFrame = new Int32Array(N_ENE).fill(-1);

  // Optional diagnostic: mark a coarse occupancy grid so map.js can draw where the search
  // actually got to. Off unless the caller passes one in.
  const occ = o.occ || null;

  function record(s, frame) {
    if (occ) {
      const gx = Math.floor((s[S_X] - occ.X0) / occ.CELL);
      const gy = Math.floor((s[S_Y] - occ.Y0) / occ.CELL);
      if (gx >= 0 && gx < occ.W && gy >= 0 && gy < occ.H) occ.occ[gy * occ.W + gx] = 1;
    }
    const l = s[S_X] - KOL_W,
      r = s[S_X] + KOL_W,
      t = s[S_Y] - KOL_H,
      b = s[S_Y];
    let gx0 = Math.floor((l - COIN_KOL - GX0) / CELL);
    let gx1 = Math.floor((r + COIN_KOL - GX0) / CELL);
    let gy0 = Math.floor((t - COIN_KOL - GY0) / CELL);
    let gy1 = Math.floor((b + COIN_KOL - GY0) / CELL);
    if (gx0 < 0) gx0 = 0;
    if (gy0 < 0) gy0 = 0;
    if (gx1 >= GW) gx1 = GW - 1;
    if (gy1 >= GH) gy1 = GH - 1;
    for (let gy = gy0; gy <= gy1; gy++) {
      const row = gy * GW;
      for (let gx = gx0; gx <= gx1; gx++) {
        const cell = row + gx;
        const end = GSTART[cell + 1];
        for (let p = GSTART[cell]; p < end; p++) {
          const c = GITEM[p];
          if (coinFrame[c] >= 0) continue;
          if (l < CX[c] + COIN_KOL && r > CX[c] - COIN_KOL && t < CY[c] + COIN_KOL && b > CY[c] - COIN_KOL) {
            coinFrame[c] = frame;
            coinsFound++;
          }
        }
      }
    }
    if (gunFrame < 0 && l < GUN_BOX[2] && r > GUN_BOX[0] && t < GUN_BOX[3] && b > GUN_BOX[1]) {
      gunFrame = frame;
    }
  }

  // A bullet stops on anything in `spikes`, but killEnemy() only actually kills robots, bombs and
  // the boss -- a saw just eats the shot. Only robot hits are enemysanity checks.
  KILL_RECORDER = (haz, frame) => {
    if (haz < N_ENE && M.enes[haz].typ === 'robot' && shotFrame[haz] < 0) shotFrame[haz] = frame;
  };

  // Layers are struct-of-arrays Float64Arrays, grown as needed.
  let cap = 1 << 16;
  let cur = new Float64Array(cap * S_N);
  let nxt = new Float64Array(cap * S_N);
  let curN = 0,
    nxtN = 0;

  // Initial state (LevelState.create + iniLevel)
  scratch[S_X] = SPAWN_X;
  scratch[S_Y] = SPAWN_Y;
  scratch[S_VX] = 0;
  scratch[S_VY] = 1;
  scratch[S_JU] = 0;
  for (let c = 0; c < N_CR; c++) {
    scratch[S_CR0 + c * 3] = CR_Y0[c];
    scratch[S_CR0 + c * 3 + 1] = 0;
    scratch[S_CR0 + c * 3 + 2] = 0;
  }
  scratch[S_PU] = -1;
  scratch[S_SC] = 1;
  scratch[S_HP] = o.energyTier;
  scratch[S_INV] = 0;
  scratch[S_AMMO] = startAmmo;
  scratch[S_KILL] = o.forceKill || 0;
  cur.set(scratch, 0);
  curN = 1;
  visited.add(keyOf(scratch, 0));
  record(scratch, 0);

  const stats = {
    peak: 0,
    expanded: 0,
    layers: 0,
    truncated: false,
    hitFrameLimit: false,
    beamRejected: 0,
    // How much of the key budget the crushers got. 32 is full resolution; lower means this
    // combo's key was tight enough that crusher positions are being merged more coarsely.
    crusherFallBuckets: N_CR ? bf : 0,
  };

  for (let f = 0; f + o.stride <= o.maxFrames; f += o.stride) {
    if (curN === 0) break;
    if (curN > stats.peak) stats.peak = curN;
    stats.expanded += curN;
    stats.layers++;
    nxtN = 0;
    for (let li = 0; li < curN; li++) {
      const base = li * S_N;
      for (let a = 0; a < ACT_DIR.length; a++) {
        const dir = ACT_DIR[a];
        const jmp = ACT_JMP[a];
        const sht = ACT_SHOOT[a];
        if (jmp && jh === 0) continue;
        if (dir !== 0 && spd === 0) continue;
        if (sht && !hasGun) continue;
        if (sht && cur[base + S_AMMO] <= 0) continue;
        for (let k = 0; k < S_N; k++) scratch[k] = cur[base + k];
        let ok = true;
        for (let k = 0; k < o.stride; k++) {
          const rc = stepFrame(
            scratch,
            f + k + 1,
            dir,
            jmp && k === 0 ? 1 : 0,
            spd,
            jh,
            jumpMax,
            sht && k === 0 ? 1 : 0
          );
          if (rc === 1) {
            ok = false;
            break;
          }
          record(scratch, f + k + 1);
          if (rc === 2) {
            if (gateFrame < 0) gateFrame = f + k + 1;
            ok = false;
            break;
          }
        }
        if (!ok) continue;
        if (!visited.add(keyOf(scratch, f + o.stride))) continue;
        if (!beamAdmit(scratch, lastPhase)) {
          stats.beamRejected++;
          continue;
        }
        if (nxtN >= cap) {
          const ncap = cap * 2;
          const g = new Float64Array(ncap * S_N);
          g.set(nxt);
          nxt = g;
          const g2 = new Float64Array(ncap * S_N);
          g2.set(cur);
          cur = g2;
          cap = ncap;
        }
        nxt.set(scratch, nxtN * S_N);
        nxtN++;
      }
    }
    if (visited.full) {
      stats.truncated = true;
      break;
    }
    const tmp = cur;
    cur = nxt;
    nxt = tmp;
    curN = nxtN;
  }

  // Left the loop with states still queued => the frame budget cut the search short, so this
  // run cannot prove anything UNreachable.
  if (curN > 0 && !stats.truncated) stats.hitFrameLimit = true;
  stats.visited = visited.size;
  return { coinFrame, coinsFound, gunFrame, gateFrame, shotFrame, stats };
}

// Enough of the internals for test-physics.js to step this simulator frame-for-frame beside
// physics.js and check they still agree. Nothing else should reach in here.
const _internals = {
  stepFrame,
  buildWorld,
  // The techs are module-level state that only search() normally writes. The cross-check has to
  // be able to step BOTH settings, because "tech off" is no longer a path that skips the impulse
  // -- it is a different direction for it, and that is exactly the arithmetic worth checking
  // against physics.js.
  setTechs({ recoilBoost = true, knockbackBoost = true } = {}) {
    ALLOW_RECOIL_BOOST = recoilBoost !== false;
    ALLOW_KNOCKBACK_BOOST = knockbackBoost !== false;
  },
  N_CR,
  CRUSHER_SPECS,
  SPAWN_X,
  SPAWN_Y,
  S_X, S_Y, S_VX, S_VY, S_JU, S_PU, S_SC, S_HP, S_INV, S_AMMO, S_KILL, S_CR0, S_N,
  newState() {
    const s = new Float64Array(S_N);
    s[S_X] = SPAWN_X;
    s[S_Y] = SPAWN_Y;
    s[S_VY] = 1;
    s[S_PU] = -1;
    s[S_SC] = 1;
    for (let c = 0; c < N_CR; c++) {
      s[S_CR0 + c * 3] = CR_Y0[c];
      s[S_CR0 + c * 3 + 2] = 0;
    }
    return s;
  },
};

module.exports = {
  M,
  _internals,
  COINS,
  KILLABLE,
  N_COIN,
  N_ENE,
  search,
  moveAccel,
  jumpImpulse,
  timerSeconds,
  framesAllowed,
  timeTierForFrames,
  DEFAULTS,
};
