/*
 * Multiple doors, with configurable triggers and a hitbox that actually follows.
 *
 * The stock doorCode() in js/boss.js:
 *
 *   function doorCode() {
 *     if (game.door.done) return;
 *     game.door.y += 1;
 *     if (game.door.y > game.door.ymax) {
 *       getBoundsByOffset(game.door, {l:0, t:0, r:100, b:250});
 *       game.door.y = game.door.ymax;
 *       game.door.done = true;
 *     }
 *   }
 *
 * Three problems with that:
 *
 *  1. getBoundsByOffset runs ONCE, at the end of the slide. Until then the
 *     collision box sits wherever it was last written, so the texture moves and
 *     the hitbox does not -- which is why moving the door in the editor moved
 *     the picture but nothing blocked.
 *  2. `game.door.ymax = 1810` is hardcoded in iniBoss, so the door always stops
 *     at that absolute Y no matter where the map puts it. Its size is hardcoded
 *     as 100x250 in the same call.
 *  3. game.door is a single global, so a map gets exactly one door, and it
 *     always closes the instant the level starts.
 *
 * This drives every door from map data, recomputes bounds every frame, and lets
 * each one decide when to shut. Unspecified fields fall back to the vanilla
 * behaviour.
 *
 * Per-door fields, all optional:
 *   closeTo   world Y it slides to        (default y + h)
 *   speed     px per frame                (default 1)
 *   trigger   'start' | 'zone' | 'boss' | 'never'   (default 'start')
 *   zx,zy,zw,zh   trigger zone, when trigger is 'zone'
 *   open      start closed and slide UP instead     (default false)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Doors = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);

  function build(win) {
    const ldat = win.maps[win.levl];
    if (!ldat) return [];
    // `doors` is the editor's array; fall back to the game's single `door` so a
    // vanilla map still works untouched
    let specs = ldat.doors;
    if (!specs || !specs.length) {
      specs = (ldat.door && (ldat.door.r - ldat.door.l) > 0) ? [ldat.door] : [];
    }

    const out = [];
    specs.forEach((s, i) => {
      const x = num(s.x, s.l), y = num(s.y, s.t);
      const w = num(s.w, num(s.r, 0) - num(s.l, 0)) || 100;
      const h = num(s.h, num(s.b, 0) - num(s.t, 0)) || 250;

      // iniLevel already made a sprite for the first door; reuse it so we are not
      // drawing two on top of each other
      let sprite = (i === 0 && win.game.door) ? win.game.door : null;
      if (!sprite) sprite = win.isprt.create(x, y, 'door');
      sprite.x = x; sprite.y = y;
      sprite.width = w; sprite.height = h;

      const d = {
        sprite, x, y, w, h,
        startY: y,
        closeTo: num(s.closeTo, y + h),
        speed: num(s.speed, 1),
        trigger: s.trigger || 'start',
        zone: { x: num(s.zx, 0), y: num(s.zy, 0), w: num(s.zw, 0), h: num(s.zh, 0) },
        open: !!s.open,
        armed: false,
        done: false,
      };
      // a door that opens starts shut, at the far end of its travel
      if (d.open) { sprite.y = d.closeTo; d.startY = d.closeTo; d.closeTo = y; }
      win.getBoundsByOffset(sprite, { l: 0, t: 0, r: w, b: h });
      if (win.plats.indexOf(sprite) < 0) win.plats.push(sprite);
      out.push(d);
    });
    return out;
  }

  function triggered(win, d) {
    switch (d.trigger) {
      case 'never': return false;
      case 'boss': return !!(win.boss && win.boss.stp >= 0);
      case 'zone': {
        const s = win.sprt, z = d.zone;
        if (!s || z.w <= 0 || z.h <= 0) return false;
        return s.x > z.x && s.x < z.x + z.w && s.y > z.y && s.y < z.y + z.h;
      }
      default: return true;   // 'start'
    }
  }

  function install(win) {
    let doors = [];
    let lastTick = -1;

    const origIni = win.iniLevel;
    win.iniLevel = function () {
      origIni.apply(this, arguments);
      doors = build(win);
    };

    /*
     * Drive the doors from the level loop.
     *
     * The stock doorCode() is called from exactly one place -- bossMove0(), the
     * boss rising animation -- so in normal play it never runs at all. That is
     * fine for a door that only ever exists to shut behind you on the way into
     * the boss fight, but it means any trigger other than "at level start" would
     * simply never be evaluated. Wrapping LevelState.update gives every door a
     * tick on every frame.
     *
     * bossMove0 still calls doorCode during the boss intro, so the tick is
     * guarded by timestamp to stop doors sliding at double speed on those frames.
     */
    const origUpdate = win.LevelState.update;
    win.LevelState.update = function () {
      origUpdate.apply(this, arguments);
      tick();
    };

    function tick() {
      const now = (win.game && win.game.time) ? win.game.time.now : 0;
      if (now === lastTick) return;   // already ticked this frame
      lastTick = now;
      for (const d of doors) {
        const s = d.sprite;
        if (!d.armed && triggered(win, d)) d.armed = true;

        if (d.armed && !d.done) {
          const dir = d.closeTo > s.y ? 1 : -1;
          s.y += d.speed * dir;
          if ((dir > 0 && s.y >= d.closeTo) || (dir < 0 && s.y <= d.closeTo)) {
            s.y = d.closeTo;
            d.done = true;
          }
        }

        /*
         * Every frame, not just once at the end. This is the fix for the hitbox
         * lagging the texture: collision is read off l/t/r/b, so those have to
         * track the sprite the whole way down rather than being written once the
         * slide completes.
         */
        win.getBoundsByOffset(s, { l: 0, t: 0, r: d.w, b: d.h });
      }
    };

    // bossMove0() calls doorCode() during the boss intro; point it at the same
    // guarded tick so it cannot double-advance a door
    win.doorCode = tick;

    return { count: () => doors.length, tick };
  }

  return { install, build };
}));
