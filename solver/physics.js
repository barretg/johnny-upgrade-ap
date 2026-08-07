// Frame-accurate reimplementation of Johnny Upgrade's level physics.
//
// Every function below mirrors the identically-named routine in the SDK's js/level.js (and
// js/boss.js), executed in the same order LevelState.update() runs them, so a state advanced by
// step() lands on exactly the coordinates the real game would produce for the same inputs.
// Cosmetic-only code (animations, particles, camera, sound) is omitted; nothing it does feeds
// back into simulation state.
//
// Tier -> game value: shop.js's addITM indexes its price array with Math.round(v * 10) and
// shopBtnPress adds a flat u = 0.1 per purchase, so tier T means v = T * 0.1 for every track.

const maps = require('./data/maps.js');
const M = maps[1];

const GRAVITY = 1;
const MAX_FALL = 90;
const KOL_W = 30; // sprt.kolW
const KOL_H = 90; // sprt.kolH
const COIN_KOL = 24; // coin kolSize / kolSizeY

function moveAccel(spdTier) {
  return spdTier <= 0 ? 0 : 0.8 + 0.2 * spdTier;
}
function jumpImpulse(jmpTier) {
  return jmpTier <= 0 ? null : -(1.1 * jmpTier + 12);
}
function timerSeconds(timTier) {
  return Math.round(timTier * 6 + 3);
}
// clockCode subtracts 1/60 per frame and kills at tim < 1, so a run survives F frames iff
// 6*T + 3 - F/60 >= 1.
function framesAllowed(timTier) {
  return Math.floor((timerSeconds(timTier) - 1) * 60);
}
function timeTierForFrames(frames) {
  for (let t = 0; t <= 24; t++) if (framesAllowed(t) >= frames) return t;
  return null;
}

// ---------------------------------------------------------------------------
// Static world geometry (never changes during a run)
// ---------------------------------------------------------------------------

// iniLevel pushes plain rectangles for every entry in ldat.plats. The stomper is the same kind
// of solid, it just also moves once triggered. plats[34] duplicates the boss door's geometry;
// iniBoss also pushes game.door itself into plats, but that sprite's .l/.r/.t/.b stay undefined
// until doorCode finishes, and every hit test against undefined bounds is false -- so the real
// door object is inert and only plats[34] blocks.
function buildStaticPlats() {
  const out = [];
  M.plats.forEach((ob, i) => {
    out.push({
      i,
      l: ob.x,
      t: ob.y,
      r: ob.right,
      b: ob.bottom,
      semi: ob.semi ? 1 : 0,
      stomper: !!ob.stomper,
      w: ob.w,
      h: ob.h,
    });
  });
  return out;
}

const STATIC_PLATS = buildStaticPlats();
const STOMPER_PROTO = STATIC_PLATS.find((p) => p.stomper);
// stomperCode's trigger band: game.stomper.xmin = ob.x + 200, xmax = ob.x + 280.
const STOMPER_TRIG_XMIN = STOMPER_PROTO.l + 200;
const STOMPER_TRIG_XMAX = STOMPER_PROTO.l + 280;

// Lasers. iniLevel gives the FIRST laser in the array a 90-degree rotation and a wide/short
// hitbox; the rest keep the default narrow/tall one.
const LASERS = M.lasers.map((ob, i) => {
  const off = i === 0 ? { l: -295, t: -20, r: 295, b: 20 } : { l: -20, t: -90, r: 20, b: 90 };
  return {
    l: ob.x + off.l,
    t: ob.y + off.t,
    r: ob.x + off.r,
    b: ob.y + off.b,
    ctMax: ob.ctMax,
    ctSwitch: ob.ctSwitch,
    ctCurr: ob.ctCurr,
  };
});

// laserCode: ctCurr--; noKol/invisible once ctCurr == ctSwitch; reset to ctMax (and solid
// again) once ctCurr <= 0. Closed form so a laser's state is a pure function of frame count.
function laserActive(laser, frame) {
  if (frame === 0) return true; // laserCode has not run yet on the spawn frame
  const period = laser.ctMax;
  const v = ((((laser.ctCurr - frame) % period) + period) % period) || period;
  return v > laser.ctSwitch;
}

const ENEMY_PROTOS = M.enes.map((ob, i) => ({
  i,
  typ: ob.typ,
  x0: ob.x,
  y0: ob.y,
  xx: ob.xx,
  yy: ob.yy,
  xmin: ob.xmin,
  xmax: ob.xmax,
  ymin: ob.ymin,
  ymax: ob.ymax,
  kol: ob.typ === 'robot' ? { l: -40, t: -120, r: 40, b: 0 } : { l: -30, t: -30, r: 30, b: 30 },
}));

const BOMB_PROTOS = M.bombs.map((ob, i) => ({ i, ...ob }));

const PLATMOVE_PROTOS = M.platMove.map((ob, i) => ({ i, ...ob }));

// ldat.spikes are static rectangles; lasers/enemies/bombs/boss are pushed into the same `spikes`
// array at runtime but move, so they are tracked separately.
const STATIC_SPIKES = M.spikes.map((ob) => ({
  l: ob.x,
  t: ob.y,
  r: ob.x + ob.w,
  b: ob.y + ob.h,
}));

const COINS = M.coins.map((ob, i) => ({
  i,
  x: ob.x,
  y: ob.y,
  l: ob.x - COIN_KOL,
  r: ob.x + COIN_KOL,
  t: ob.y - COIN_KOL,
  b: ob.y + COIN_KOL,
}));

const GUN = {
  l: M.colGun.x - 50,
  t: M.colGun.y - 50,
  r: M.colGun.x + 50,
  b: M.colGun.y + 50,
};

const BOSS_GATE = M.bossData.gate;
const SPAWN = { x: M.sprt.x, y: M.sprt.y };

// ---------------------------------------------------------------------------
// Time-varying world state, derived purely from the frame counter
// ---------------------------------------------------------------------------

// Every mover advances by a fixed rule per frame with no dependence on the player (the one
// exception, a moving platform carrying the player, is handled inside step()). Caching the whole
// world per frame lets the BFS share one snapshot across every state in a layer.
const worldCache = [];

function computeWorld(frame) {
  if (worldCache[frame]) return worldCache[frame];

  let prev;
  if (frame === 0) {
    prev = null;
  } else {
    prev = computeWorld(frame - 1);
  }

  if (frame === 0) {
    const w = {
      frame: 0,
      platMoves: PLATMOVE_PROTOS.map((p) => ({
        i: p.i,
        x: p.x,
        y: p.y,
        xx: p.xx,
        yy: p.yy,
        xmin: p.xmin,
        xmax: p.xmax,
        ymin: p.ymin,
        ymax: p.ymax,
        // iniLevel's initial bounds differ from platMoveGetNewBounds' (b = y+100 vs y+60);
        // platMoveCode overwrites them on frame 1 onward.
        l: p.x - 100,
        t: p.y + 4,
        r: p.x + 100,
        b: p.y + 100,
        semi: 1,
      })),
      bombs: BOMB_PROTOS.map((b) => ({
        i: b.i,
        x: b.x,
        y: b.y,
        xsi: 0,
        ysi: 0,
        l: b.x - 45,
        t: b.y - 45,
        r: b.x + 45,
        b: b.y + 45,
      })),
      enes: ENEMY_PROTOS.map((e) => ({
        i: e.i,
        x: e.x0,
        y: e.y0,
        xx: e.xx,
        yy: e.yy,
        l: e.x0 + e.kol.l,
        t: e.y0 + e.kol.t,
        r: e.x0 + e.kol.r,
        b: e.y0 + e.kol.b,
      })),
      lasers: LASERS.map((l) => ({ l: l.l, t: l.t, r: l.r, b: l.b, active: true })),
    };
    worldCache[0] = w;
    return w;
  }

  // platMoveCode
  const platMoves = prev.platMoves.map((p) => {
    const n = { ...p };
    const xDel = n.xx * 0.8;
    n.x += xDel;
    n.xDel = xDel;
    if (n.x < n.xmin || n.x > n.xmax) n.xx *= -1;
    const yDel = n.yy * 0.7;
    n.y += yDel;
    if (n.y < n.ymin) {
      n.y = n.ymin;
      n.yy *= -1;
    }
    if (n.y > n.ymax) {
      n.y = n.ymax;
      n.yy *= -1;
    }
    n.l = n.x - 100;
    n.t = n.y + 4;
    n.r = n.x + 100;
    n.b = n.y + 60;
    return n;
  });

  // bombCode
  const bombs = prev.bombs.map((b, idx) => {
    const proto = BOMB_PROTOS[idx];
    const n = { ...b };
    n.y = proto.yo + Math.sin(n.ysi) * proto.ymax;
    n.ysi += proto.yysi;
    n.x = proto.xo + Math.sin(n.xsi) * proto.xmax;
    n.xsi += proto.xxsi;
    n.l = n.x - 40;
    n.t = n.y - 40;
    n.r = n.x + 40;
    n.b = n.y + 40;
    return n;
  });

  // eneCode
  const enes = prev.enes.map((e, idx) => {
    const proto = ENEMY_PROTOS[idx];
    const n = { ...e };
    n.x += n.xx;
    if (n.x < proto.xmin || n.x > proto.xmax) n.xx *= -1;
    n.y += n.yy;
    if (n.y < proto.ymin || n.y > proto.ymax) n.yy *= -1;
    n.l = n.x + proto.kol.l;
    n.t = n.y + proto.kol.t;
    n.r = n.x + proto.kol.r;
    n.b = n.y + proto.kol.b;
    return n;
  });

  // laserCode
  const lasers = LASERS.map((l) => ({
    l: l.l,
    t: l.t,
    r: l.r,
    b: l.b,
    active: laserActive(l, frame),
  }));

  const w = { frame, platMoves, bombs, enes, lasers };
  worldCache[frame] = w;
  return w;
}

function primeWorld(maxFrame) {
  for (let f = 0; f <= maxFrame; f++) computeWorld(f);
}

// ---------------------------------------------------------------------------
// Player state + one simulation frame
// ---------------------------------------------------------------------------
//
// State fields mirror the sprt properties the physics reads:
//   x, y   feet position (sprt.position)
//   vx, vy sprt.xx / sprt.yy
//   ju     jumps consumed since last landing (sprt.ju)
//   hearts remaining nrg entries
//   inv    sprt.inv invulnerability countdown
//   scaleX facing (+1/-1), which sets the knockback direction on a hit
//   stomperY  null until triggered, then the falling crusher's y
//   stomperFall / stomperGone
//   dead   run-ending flag

function initialState(cfg) {
  return {
    x: SPAWN.x,
    y: SPAWN.y,
    vx: 0,
    vy: 1, // sprt.yy = 1 in LevelState.create
    ju: 0,
    hearts: cfg.energyTier,
    inv: 0,
    scaleX: 1,
    stomperY: STOMPER_PROTO.t,
    stomperFall: false,
    stomperGone: false,
    dead: false,
    frame: 0,
  };
}

function sprtHit(s, ob) {
  return (
    s.x - KOL_W < ob.r && s.x + KOL_W > ob.l && s.y - KOL_H < ob.b && s.y > ob.t
  );
}
function rectHit(a, b) {
  return a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t;
}

// Collect the full solid list for this frame: static rectangles, the (possibly fallen) stomper,
// and the moving platforms (which iniLevel marks semi = true).
function activePlats(s, world, out) {
  out.length = 0;
  for (let i = 0; i < STATIC_PLATS.length; i++) {
    const p = STATIC_PLATS[i];
    if (p.stomper) {
      out.push({
        l: p.l,
        t: s.stomperY,
        r: p.l + p.w,
        b: s.stomperY + p.h,
        semi: 0,
        isStomper: true,
      });
    } else {
      out.push(p);
    }
  }
  for (let i = 0; i < world.platMoves.length; i++) out.push(world.platMoves[i]);
  return out;
}

const _plats = [];

/**
 * Advance one frame. `input` is { dir: -1|0|1, jump: bool } where jump means "the jump key was
 * pressed on this exact frame" (controls() only jumps on the rising edge, via cursors.hold).
 * Mutates and returns a new state object.
 */
function step(prev, input, cfg) {
  const s = { ...prev };
  const frame = prev.frame + 1;
  s.frame = frame;
  const world = computeWorld(frame);

  // --- invCode ---
  s.inv--;
  if (s.inv <= 0) s.inv = 0;

  // --- stomperCode --- (runs before platMoveCode in update())
  if (!s.stomperGone) {
    if (!s.stomperFall && s.y <= 360 && s.x > STOMPER_TRIG_XMIN && s.x < STOMPER_TRIG_XMAX) {
      s.stomperFall = true;
      s.stomperVY = 0;
    }
    if (s.stomperFall) {
      s.stomperVY += 0.25;
      s.stomperY += Math.round(s.stomperVY);
      const box = {
        l: STOMPER_PROTO.l,
        t: s.stomperY,
        r: STOMPER_PROTO.l + STOMPER_PROTO.w,
        b: s.stomperY + STOMPER_PROTO.h,
      };
      if (sprtHit(s, box)) {
        // killSprite(stomper, 10) -- ten hearts at once, i.e. lethal at every energy tier.
        s.dead = true;
        return s;
      }
      if (s.stomperY >= -60) {
        s.stomperY = -60;
        s.stomperGone = true;
      }
    }
  }

  // --- platMoveCode --- carrying the player
  if (prev.platUnder !== undefined && prev.platUnder !== null) {
    const pm = world.platMoves[prev.platUnder];
    const prevPm = computeWorld(frame - 1).platMoves[prev.platUnder];
    s.x += pm.x - prevPm.x;
    s.y = pm.t + 4;
  }

  // --- controls() ---
  if (!s.noControl) {
    if (input.dir < 0 && cfg.spd > 0) {
      s.vx -= cfg.spd;
      s.scaleX = -1;
    } else if (input.dir > 0 && cfg.spd > 0) {
      s.vx += cfg.spd;
      s.scaleX = 1;
    }
    if (input.jump && cfg.jh !== null && s.ju < cfg.jumpMax) {
      s.vy = cfg.jh;
      s.ju++;
    }
  }

  // --- leftRightCode() ---
  s.vx *= 0.8;
  if (Math.abs(s.vx) < 0.5) s.vx = 0;
  s.x += s.vx;
  const plats = activePlats(s, world, _plats);
  {
    let newVX = s.vx;
    for (let i = 0; i < plats.length; i++) {
      const p = plats[i];
      if (p.semi) continue;
      if (sprtHit(s, p)) {
        if (s.vx > 0) {
          newVX = 0;
          s.x = p.l - KOL_W;
        }
        if (s.vx < 0) {
          newVX = 0;
          s.x = p.r + KOL_W;
        }
      }
    }
    s.vx = newVX;
  }

  // --- gravCode() ---
  s.vy += GRAVITY;
  if (s.vy > MAX_FALL) s.vy = MAX_FALL;
  s.y += s.vy;
  s.platUnder = null;
  {
    let newVY = s.vy;
    let newY = s.y;
    for (let i = 0; i < plats.length; i++) {
      const p = plats[i];
      if (sprtHit(s, p)) {
        if (s.vy >= 0) {
          if (s.y - s.vy - 5 > p.t) continue;
          s.platUnder = p.i !== undefined && p.xmin !== undefined ? p.i : null;
          if (p.t < newY) newY = p.t;
          s.ju = 0;
          newVY = 0;
        }
        if (s.vy < 0 && !p.semi) {
          s.y = p.b + KOL_H;
          newY = s.y;
          newVY = 0;
        }
      }
    }
    s.y = newY;
    s.vy = newVY;
  }
  if (s.vy > 1 && !s.ju) s.ju = 1;

  // --- spikeCode() ---
  if (s.inv <= 0) {
    const hit = hazardAt(s, world);
    if (hit) {
      // killSprite(ob, 1)
      s.ju = 9;
      if (hit.knockback) {
        s.scaleX = s.x > hit.cx ? -1 : 1;
      }
      s.vx = (s.scaleX === -1 ? -0.8 : 0.8) * -54;
      s.vy = -20;
      s.hearts--;
      if (s.hearts <= 0) {
        s.dead = true;
        return s;
      }
      s.inv = 60;
    }
  }

  // --- boss gate: touching it locks controls and railroads you into the arena ---
  if (sprtHit(s, BOSS_GATE)) s.gate = true;

  return s;
}

function hazardAt(s, world) {
  for (let i = 0; i < STATIC_SPIKES.length; i++) {
    if (sprtHit(s, STATIC_SPIKES[i])) return { knockback: false };
  }
  for (let i = 0; i < world.lasers.length; i++) {
    const l = world.lasers[i];
    if (l.active && sprtHit(s, l)) return { knockback: false };
  }
  for (let i = 0; i < world.enes.length; i++) {
    const e = world.enes[i];
    if (sprtHit(s, e)) return { knockback: true, cx: e.x };
  }
  for (let i = 0; i < world.bombs.length; i++) {
    const b = world.bombs[i];
    if (sprtHit(s, b)) return { knockback: true, cx: b.x };
  }
  return null;
}

function makeConfig({ spdTier, jmpTier, doubleJump, energyTier = 1 }) {
  return {
    spdTier,
    jmpTier,
    doubleJump: !!doubleJump,
    energyTier,
    spd: moveAccel(spdTier),
    jh: jumpImpulse(jmpTier),
    jumpMax: 1 + (doubleJump ? 0.1 : 0),
  };
}

module.exports = {
  M,
  STATIC_PLATS,
  STATIC_SPIKES,
  PLATMOVE_PROTOS,
  ENEMY_PROTOS,
  BOMB_PROTOS,
  LASERS,
  COINS,
  GUN,
  BOSS_GATE,
  SPAWN,
  KOL_W,
  KOL_H,
  STOMPER_PROTO,
  STOMPER_TRIG_XMIN,
  STOMPER_TRIG_XMAX,
  moveAccel,
  jumpImpulse,
  timerSeconds,
  framesAllowed,
  timeTierForFrames,
  computeWorld,
  primeWorld,
  initialState,
  step,
  makeConfig,
  sprtHit,
  rectHit,
};
