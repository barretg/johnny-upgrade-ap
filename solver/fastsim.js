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

const maps = require('./data/maps.js');
const M = maps[1];

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
let STOMPER_IDX = -1;
let STOMPER_H = 0;
let STOMPER_L = 0;
let STOMPER_R = 0;
M.plats.forEach((ob, i) => {
  PL[i * 5 + 0] = ob.x;
  PL[i * 5 + 1] = ob.y;
  PL[i * 5 + 2] = ob.right;
  PL[i * 5 + 3] = ob.bottom;
  PL[i * 5 + 4] = ob.semi ? 1 : 0;
  if (ob.stomper) {
    STOMPER_IDX = i;
    STOMPER_H = ob.h;
    STOMPER_L = ob.x;
    STOMPER_R = ob.right;
  }
});
for (let i = 0; i < N_PM; i++) PL[(N_STATIC + i) * 5 + 4] = 1; // platMoves are semi

const STOMPER_TRIG_XMIN = STOMPER_L + 200;
const STOMPER_TRIG_XMAX = STOMPER_L + 280;
const STOMPER_Y0 = M.plats[STOMPER_IDX].y;

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
      const off = i === 0 ? [-295, -20, 295, 20] : [-20, -90, 20, 90];
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
  S_SY = 5, // stomper y
  S_SVY = 6, // stomper fall velocity
  S_SF = 7, // 0 armed, 1 falling, 2 spent
  S_PU = 8, // platUnder: -1 or moving-platform index
  S_SC = 9, // facing
  S_HP = 10,
  S_INV = 11,
  S_N = 12;

const scratch = new Float64Array(S_N);

// ---------------------------------------------------------------------------
// One frame. Returns 0 = ok, 1 = dead, 2 = grabbed by the boss gate.
// Mirrors LevelState.update()'s ordering exactly.
// ---------------------------------------------------------------------------
function stepFrame(s, frame, dir, jump, spd, jh, jumpMax) {
  // invCode
  if (s[S_INV] > 0) {
    s[S_INV]--;
    if (s[S_INV] < 0) s[S_INV] = 0;
  }

  // stomperCode
  if (s[S_SF] !== 2) {
    if (
      s[S_SF] === 0 &&
      s[S_Y] <= 360 &&
      s[S_X] > STOMPER_TRIG_XMIN &&
      s[S_X] < STOMPER_TRIG_XMAX
    ) {
      s[S_SF] = 1;
      s[S_SVY] = 0;
    }
    if (s[S_SF] === 1) {
      s[S_SVY] += 0.25;
      s[S_SY] += Math.round(s[S_SVY]);
      const t = s[S_SY];
      const b = t + STOMPER_H;
      if (s[S_X] - KOL_W < STOMPER_R && s[S_X] + KOL_W > STOMPER_L && s[S_Y] - KOL_H < b && s[S_Y] > t) {
        return 1; // killSprite(stomper, 10): lethal at every energy tier
      }
      if (s[S_SY] >= -60) {
        s[S_SY] = -60;
        s[S_SF] = 2;
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
  // And the stomper's current vertical extent.
  {
    const base = STOMPER_IDX * 5;
    PL[base + 1] = s[S_SY];
    PL[base + 3] = s[S_SY] + STOMPER_H;
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
      s[S_VX] = (s[S_SC] === -1 ? -0.8 : 0.8) * -54;
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
    const o = i === 0 ? [-295, -20, 295, 20] : [-20, -90, 20, 90];
    z.push([L.x + o[0] - pad, L.y + o[1] - pad, L.x + o[2] + pad, L.y + o[3] + pad]);
  });
  for (const p of M.platMove) {
    z.push([p.xmin - 100 - pad, p.ymin - pad, p.xmax + 100 + pad, p.ymax + 60 + pad]);
  }
  const out = new Float64Array(z.length * 4);
  z.forEach((r, i) => out.set(r, i * 4));
  return out;
}

const ACT_DIR = [0, -1, 1, 0, -1, 1];
const ACT_JMP = [0, 0, 0, 1, 1, 1];

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
  const nvx = 64;
  const nvy = 256;
  const nphase = Math.ceil(o.phaseMod / o.phaseBucket) + 1;
  const nstom = 35;

  let lastPhase = 0; // set by keyOf, consumed by beamAdmit
  function keyOf(s, frame) {
    let qx = Math.round((s[S_X] + 1800) / o.qPos);
    let qy = Math.round((s[S_Y] + 800) / o.qPos);
    if (qx < 0) qx = 0;
    else if (qx >= nx) qx = nx - 1;
    if (qy < 0) qy = 0;
    else if (qy >= ny) qy = ny - 1;
    let qvx = Math.round(s[S_VX] * o.qVx) + 32;
    if (qvx < 0) qvx = 0;
    else if (qvx >= nvx) qvx = nvx - 1;
    let qvy = Math.round(s[S_VY] * o.qVy) + 64;
    if (qvy < 0) qvy = 0;
    else if (qvy >= nvy) qvy = nvy - 1;
    const ju = s[S_JU] >= 2 ? 2 : s[S_JU];
    let stom = s[S_SF] === 2 ? 2 : s[S_SF] === 0 ? 0 : 3 + Math.min(31, Math.max(0, Math.round((s[S_SY] + 440) / 20)));
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
    k = k * nstom + stom;
    k = k * nphase + phase;
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
    // Robot shootability: a bullet spawns at sprt.y - 60 and flies horizontally, dying ~1000px
    // out; it stops at the first platform. Record the earliest frame a robot is in clear line.
    for (let i = 0; i < N_ENE; i++) {
      if (shotFrame[i] >= 0) continue;
      if (M.enes[i].typ !== 'robot') continue;
      const hb = (frame * N_HAZ + i) * 4;
      const by = s[S_Y] - 60;
      if (by < HZ[hb + 1] - 12 || by > HZ[hb + 3] + 12) continue;
      const dir = HZ[hb] > s[S_X] ? 1 : -1;
      const tx = dir > 0 ? HZ[hb] : HZ[hb + 2];
      if (Math.abs(tx - s[S_X]) > 1000) continue;
      if (clearShot(s[S_X], by, tx)) shotFrame[i] = frame;
    }
  }

  function clearShot(x0, y, x1) {
    const lo = Math.min(x0, x1),
      hi = Math.max(x0, x1);
    for (let i = 0; i < N_STATIC; i++) {
      const b = i * 5;
      if (i === STOMPER_IDX) continue;
      if (lo < PL[b + 2] && hi > PL[b] && y - 12 < PL[b + 3] && y + 12 > PL[b + 1]) return false;
    }
    return true;
  }

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
  scratch[S_SY] = STOMPER_Y0;
  scratch[S_SVY] = 0;
  scratch[S_SF] = 0;
  scratch[S_PU] = -1;
  scratch[S_SC] = 1;
  scratch[S_HP] = o.energyTier;
  scratch[S_INV] = 0;
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
  };

  for (let f = 0; f + o.stride <= o.maxFrames; f += o.stride) {
    if (curN === 0) break;
    if (curN > stats.peak) stats.peak = curN;
    stats.expanded += curN;
    stats.layers++;
    nxtN = 0;
    for (let li = 0; li < curN; li++) {
      const base = li * S_N;
      for (let a = 0; a < 6; a++) {
        const dir = ACT_DIR[a];
        const jmp = ACT_JMP[a];
        if (jmp && jh === 0) continue;
        if (dir !== 0 && spd === 0) continue;
        for (let k = 0; k < S_N; k++) scratch[k] = cur[base + k];
        let ok = true;
        for (let k = 0; k < o.stride; k++) {
          const rc = stepFrame(scratch, f + k + 1, dir, jmp && k === 0 ? 1 : 0, spd, jh, jumpMax);
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

module.exports = {
  M,
  COINS,
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
