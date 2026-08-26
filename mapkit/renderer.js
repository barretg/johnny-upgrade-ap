/*
 * Draw a custom map's visuals.
 *
 * Platforms in this game are INVISIBLE. iniLevel() builds a non-stomper platform
 * as a bare collision rect with no sprite at all -- in the vanilla level the only
 * thing that makes one visible is the hand-painted mural, six fixed background
 * images covering the whole world. A custom map has no mural, so without this a
 * level renders as empty sky with invisible walls.
 *
 * So: hide the mural, fill every platform flat black at the very back, and draw
 * the map's own art layer over it in z order.
 *
 * Textures are extracted from the player's own copy of lvlGrfx.png at load time
 * rather than shipped, so nothing copyrighted is distributed -- see
 * mapeditor/tools/extract-from-mural.js for the other half of that.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MapkitRenderer = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const KEY_PREFIX = 'mkTile_';

  /*
   * Queue every texture a map needs. Call from a preload, before the level runs.
   * `resolve(name)` turns a tile name into a URL, so the host decides where the
   * tiles come from -- a dev server, a blob built at runtime, wherever.
   */
  function preload(win, mapData, resolve) {
    const names = [...new Set(((mapData && mapData.art) || []).map((a) => a.tile).filter(Boolean))];
    for (const n of names) {
      if (win.game.cache.checkImageKey(KEY_PREFIX + n)) continue;
      win.game.load.image(KEY_PREFIX + n, resolve(n));
    }
    return names;
  }

  function draw(win) {
    const ldat = win.maps[win.levl];
    if (!ldat) return;

    /*
     * A map with no `art` KEY is the ORIGINAL level, and the mural is its art.
     *
     * Hiding the mural and filling platforms black is right for a custom map,
     * which has its own textures and would otherwise show the old level's
     * scenery behind them. Doing it to the stock level strips the only thing
     * that makes it look like anything.
     *
     * The test is the key, not whether it has anything in it. Treating an EMPTY
     * art layer as "this is the stock level" meant a level being built showed
     * the vanilla mural behind it until the first texture was placed -- so a
     * blank level looked like the last one played, and the scenery vanished the
     * moment a single tile went down. Everything the editor saves has an `art`
     * array, empty or not; the stock map has no such key at all.
     */
    if (!Array.isArray(ldat.art)) return null;

    // 1. hide the vanilla mural
    win.isprt.children.slice().forEach((c) => {
      if (c.key && /^lvlGrfx/.test(c.key)) c.visible = false;
    });

    /*
     * 2. platform bodies, flat black, furthest back.
     *
     * One graphics object for all of them rather than a sprite each: it is a
     * single draw call, and it guarantees they share a z position so no platform
     * can ever end up in front of the art.
     */
    const g = win.game.add.graphics(0, 0);
    g.beginFill(0x000000, 1);
    for (const p of ldat.plats || []) {
      // the stomper draws its own sprite, so filling it here would double up
      if (p.stomper) continue;
      g.drawRect(p.x, p.y, p.w, p.h);
    }
    g.endFill();
    win.isprt.add(g);
    win.isprt.sendToBack(g);

    // 3. the art layer, in z order
    const art = ((ldat.art) || []).slice().sort((a, b) => (a.z || 0) - (b.z || 0));
    const minZ = art.length ? (art[0].z || 0) : 0;
    const missing = [];
    const background = [];
    for (const a of art) {
      if (!a.tile) continue;
      if (!win.game.cache.checkImageKey(KEY_PREFIX + a.tile)) { missing.push(a.tile); continue; }
      const s = win.isprt.create(a.x + a.w / 2, a.y + a.h / 2, KEY_PREFIX + a.tile);
      s.anchor.setTo(0.5);
      s.width = a.w;
      s.height = a.h;
      if (a.rot) s.angle = a.rot;
      // scale carries the size, so mirroring has to preserve its magnitude
      if (a.flipX) s.scale.x = -Math.abs(s.scale.x);
      if (a.flipY) s.scale.y = -Math.abs(s.scale.y);
      s.autoCull = true;
      if ((a.z || 0) === minZ) background.push(s);
    }
    if (missing.length) {
      console.warn('[mapkit] textures not loaded: ' + [...new Set(missing)].join(', '));
    }

    /*
     * 4. put Johnny in front of the backmost art.
     *
     * Everything here is created AFTER him -- iniLevel makes the player first --
     * so by display-list order every texture would draw over the top of him. The
     * grass is the obvious case: its base is meant to sit behind his feet, and
     * instead it painted over him no matter what z it was given.
     *
     * So the art on the LOWEST z in the map is moved behind him, and anything
     * above that stays in front. That leaves the z field meaning something
     * useful: bottom z is scenery behind the player, everything else is in
     * front, and an author picks per texture which they want.
     */
    win.isprt.sendToBack(g);
    let idx = 1;                       // 0 is the black platform layer
    for (const s of background) win.isprt.setChildIndex(s, idx++);

    return g;
  }

  /*
   * Wrap iniLevel so the art is rebuilt every time a level starts.
   */
  function install(win) {
    const orig = win.iniLevel;
    win.iniLevel = function () {
      orig.apply(this, arguments);
      draw(win);
    };
  }

  return { install, draw, preload, KEY_PREFIX };
}));
