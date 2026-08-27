/*
 * Configurable crushers.
 *
 * The stock stomperCode() in js/level.js hardcodes everything that makes a
 * crusher work, which makes "place a crusher anywhere" untrue:
 *
 *   game.stomper is a SINGLE global, so only the last stomper platform in the
 *     map ever falls -- the rest are decorative collision boxes
 *   it stops at world y = -60, so fall distance is dictated by that constant
 *   it triggers on Johnny crossing x+200..x+280, a fixed 80px band that does not
 *     scale with the platform, so anything narrower than 200px can never fire
 *   it also requires Johnny above y = 360, a leftover from the vanilla layout
 *   it fires once and is then discarded
 *
 * This replaces that function with one that drives EVERY stomper platform from
 * its own map data. Each field falls back to the vanilla constant, so a map that
 * specifies nothing behaves exactly as before.
 *
 * Per-platform fields, all optional:
 *   fallTo   world Y where it comes to rest         (default -60)
 *   trigX    left edge of the trigger band          (default x + 200)
 *   trigW    width of the trigger band              (default 80)
 *   trigY    Johnny must be above this Y            (default 360)
 *   accel    downward acceleration per frame        (default 0.25)
 *   damage   contact damage                         (default 10)
 *   repeat   return to the start after landing      (default false)
 *   resetIn  frames to wait before returning        (default 90)
 *
 * The SDK keeps its state in globals, so this reads them off the window rather
 * than taking a context object -- it has to run in the same page as the game.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Crushers = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);

  /*
   * Collect every crusher in the level.
   *
   * iniLevel() does create a sprite for each stomper platform and push it into
   * `plats` -- it only forgets about all but the last when it assigns
   * game.stomper. So the sprites are already there to be found, and their
   * collision already works; it is purely the falling logic that was limited to
   * one. Matching each sprite back to its map entry by position recovers the
   * per-crusher settings.
   */
  function collect(win) {
    const ldat = win.maps[win.levl];
    if (!ldat || !win.plats) return [];
    const specs = (ldat.plats || []).filter((p) => p.stomper);
    const out = [];
    for (const sprite of win.plats) {
      if (!sprite || !sprite.stomper) continue;
      const spec = specs.find((s) => Math.abs(s.x - sprite.l) < 1 && Math.abs(s.y - sprite.t) < 1) || {};
      out.push({
        sprite,
        startY: sprite.y,
        fallTo: num(spec.fallTo, -60),
        trigX: num(spec.trigX, sprite.l + 200),
        trigW: num(spec.trigW, 80),
        trigY: num(spec.trigY, 360),
        accel: num(spec.accel, 0.25),
        damage: num(spec.damage, 10),
        repeat: !!spec.repeat,
        resetIn: num(spec.resetIn, 90),
        vy: 0,
        falling: false,
        wait: 0,
      });
    }
    return out;
  }

  function install(win) {
    let crushers = [];

    // rebuild the list whenever a level starts
    const origIni = win.iniLevel;
    win.iniLevel = function () {
      origIni.apply(this, arguments);
      crushers = collect(win);
      // stop the stock routine touching anything: our replacement owns them all
      win.game.stomper = null;
    };

    win.stomperCode = function () {
      const sprt = win.sprt;
      if (!sprt) return;
      for (const c of crushers) {
        const s = c.sprite;

        if (c.wait > 0) {
          if (--c.wait === 0) { s.y = c.startY; c.vy = 0; win.getNewBounds(s); }
          continue;
        }

        // The stock routine arms and takes its first fall step in the SAME frame (that step
        // moves 0px, since Math.round(0.25) is 0, but everything after it is one frame earlier
        // than it would be otherwise). Falling through rather than `continue`ing here is what
        // keeps this identical to vanilla -- and identical to what solver/fastsim.js models.
        if (!c.falling && sprt.y <= c.trigY && sprt.x > c.trigX && sprt.x < c.trigX + c.trigW) {
          c.falling = true;
        }
        if (!c.falling) continue;

        c.vy += c.accel;
        s.y += Math.round(c.vy);
        win.getNewBounds(s);

        if (!sprt.dd && win.sprtHitTest(s)) win.killSprite(s, c.damage);

        if (s.y >= c.fallTo) {
          s.y = c.fallTo;
          win.getNewBounds(s);
          if (win.sfx && win.sfx.fxQuake) win.fxPlay(win.sfx.fxQuake);
          if (win.world) win.world.q = 40;   // screen shake
          c.falling = false;
          c.vy = 0;
          // A one-shot crusher simply stays where it landed, which is what the
          // stock code did by discarding it.
          c.wait = c.repeat ? c.resetIn : 0;
          if (!c.repeat) c.trigY = -Infinity;  // can never re-trigger
        }
      }
    };

    return { count: () => crushers.length };
  }

  return { install, collect };
}));
