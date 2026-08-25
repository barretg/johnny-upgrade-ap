/*
 * Unpin the game's hardcoded assumptions so a custom map can put things anywhere.
 *
 * The SDK was written for exactly one level, so a surprising amount of level
 * design lives in constants rather than in map data. Each of these is a place a
 * custom map would otherwise be silently wrong:
 *
 *   loader.js  destroys the game unless the page's hostname ends in one of
 *              coolmathgames.com / coolmath-games.com / cmatgame.local
 *   level.js   sprt.area starts empty and is only filled when Johnny stands
 *              inside a camera area, so a spawn outside every area leaves
 *              scrollCode computing NaN and the level renders in a heap
 *   level.js   stomperCode drives ONE crusher, stopping at a hardcoded y = -60
 *   boss.js    doorCode runs only during the boss intro, moves ONE door to a
 *              hardcoded y = 1810, and writes its collision box once at the end
 *   level.js   lasers[0] is force-rotated to a horizontal 590px beam whatever
 *              the map says
 *
 * Crushers and doors are big enough to live in their own modules. The rest is
 * here. Everything degrades to vanilla behaviour when a map says nothing.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MapkitPatcher = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /*
   * The host page on coolmathgames.com provides these. Without them the game
   * throws every frame once a level ends, or freezes on a blank screen.
   */
  function stubHost(win, opts) {
    if (!win.cmgGameEvent) win.cmgGameEvent = function () {};
    if (!win.cmgAdBreak) {
      win.cmgAdBreak = function () {
        if (opts && opts.onAdBreak) opts.onAdBreak();
        // addBreak() hides the sprite layer and mutes, then waits for this event
        // to put both back. A stub that never fires it leaves a black screen.
        win.document.dispatchEvent(new Event('adBreakComplete'));
      };
    }
  }

  // loader.js checks the last two labels of the hostname against a whitelist
  function allowHost(win) {
    try {
      const host = win.location.hostname.split('.').splice(-2).join('.');
      if (win.arr && win.arr.indexOf(host) < 0) win.arr.push(host);
    } catch (e) { /* cross-origin or odd host: nothing useful to do */ }
  }

  /*
   * Give the camera a starting frame.
   *
   * LevelState.create sets sprt.area = {}, and only areaCode() fills it -- which
   * needs Johnny inside a camera area on frame one. In the vanilla map he always
   * is. Anywhere else, centerX stays undefined and scrollCode computes
   *   camera.x += (sprt.x - undefined - camera.x + ...) / smoothness
   * which is NaN. A NaN camera transform is what piles a whole level into the
   * corner of the screen.
   */
  function guardCamera(win) {
    const orig = win.iniLevel;
    win.iniLevel = function () {
      orig.apply(this, arguments);
      win.sprt.area = Object.assign(
        { centerX: 400, centerY: 500, xmin: 0, xmax: 0, ymin: 0, ymax: 0 },
        win.sprt.area || {}
      );
    };
  }

  /*
   * iniLevel rotates the first laser to horizontal regardless of the map:
   *   if (lasers.length == 0) { laser.height = 590; laser.angle = 90; ... }
   * That is a hand-tuned detail of the vanilla level. A map can opt out per
   * laser with horizontal:false, or opt in for any laser with horizontal:true.
   */
  function freeLasers(win) {
    const orig = win.iniLevel;
    win.iniLevel = function () {
      orig.apply(this, arguments);
      const ldat = win.maps[win.levl];
      if (!ldat || !ldat.lasers) return;
      ldat.lasers.forEach((spec, i) => {
        const l = win.lasers[i];
        if (!l) return;
        const wantHorizontal = spec.horizontal === undefined ? (i === 0) : !!spec.horizontal;
        const isHorizontal = Math.abs(l.angle) === 90;
        if (wantHorizontal === isHorizontal) return;
        if (wantHorizontal) {
          l.height = spec.length || 590;
          l.angle = 90;
          win.getBoundsByOffset(l, { l: -(spec.length || 590) / 2, t: -20, r: (spec.length || 590) / 2, b: 20 });
        } else {
          l.angle = 0;
          l.height = spec.length || 180;
          win.getBoundsByOffset(l, { l: -20, t: -(spec.length || 180) / 2, r: 20, b: (spec.length || 180) / 2 });
        }
      });
    };
  }

  /*
   * Order matters. Each of these wraps iniLevel by calling the previous one
   * first, so the LAST thing installed runs its own work LAST -- and the
   * renderer wants to run after everything that creates or moves sprites.
   */
  function install(win, opts) {
    opts = opts || {};
    stubHost(win, opts);
    allowHost(win);
    guardCamera(win);
    freeLasers(win);
    if (win.Crushers) win.Crushers.install(win);
    if (win.Doors) win.Doors.install(win);
    if (win.MapkitRenderer) win.MapkitRenderer.install(win);
  }

  return { install, stubHost, allowHost, guardCamera, freeLasers };
}));
