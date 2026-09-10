// ==UserScript==
// @name         Johnny Upgrade — Custom Levels
// @namespace    johnny-upgrade-mapkit
// @version      0.2.0
// @description  Play custom Johnny Upgrade levels. Adds a level select with import, per-level saves, and audio controls.
// @match        https://www.coolmathgames.com/0-johnny-upgrade/play*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
 * No game artwork is bundled. Textures are rebuilt at load time from the
 * copy of the game already running in your browser -- this script carries
 * only a list of rectangles describing where each tile lives.
 *
 * Ad breaks are left completely alone. Where the page provides cmgAdBreak,
 * it is called exactly as the game intends and never stubbed or skipped.
 */

/* ===== mapkit/api.js ===== */
/*
 * mapkit -- the runtime half of custom maps.
 *
 * Ships with the game; the editor never does. Nothing in here knows Archipelago
 * exists. The seam is inversion: mapkit ASKS whether a level is unlocked and
 * ANNOUNCES when one starts or finishes, and whoever is embedding it answers.
 * Standalone, the default answer is "everything is unlocked".
 *
 *   Mapkit.addMap({ id, name, data, thumb })
 *   Mapkit.setLockProvider(id => boolean)
 *   Mapkit.on('levelStart', fn) / on('levelComplete', fn) / on('mapsChanged', fn)
 *
 * The AP client supplies a lock provider backed by received items and listens to
 * the events to send checks. It does not need to modify a line of this file.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Mapkit = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const maps = [];
  const listeners = {};
  let lockProvider = null;

  function emit(name, payload) {
    (listeners[name] || []).forEach((fn) => {
      try { fn(payload); } catch (e) { console.error('[mapkit] listener for ' + name + ' threw', e); }
    });
  }

  const api = {
    /*
     * Register a map. `data` is a map file exactly as the editor saves it --
     * the game's own field names plus the editor's `art` layer.
     * `thumb` is any image URL, usually the PNG the editor renders on save.
     * `source` is free-form provenance ('builtin', 'imported', 'archipelago'),
     * used by the selector to group and to decide what can be deleted.
     */
    addMap(m) {
      if (!m || !m.id || !m.data) throw new Error('addMap needs { id, data }');
      const existing = maps.findIndex((x) => x.id === m.id);
      const entry = {
        id: m.id,
        name: m.name || (m.data.meta && m.data.meta.name) || m.id,
        data: m.data,
        thumb: m.thumb || null,
        source: m.source || 'builtin',
      };
      if (existing >= 0) maps[existing] = entry; else maps.push(entry);
      emit('mapsChanged', api.listMaps());
      return entry;
    },

    removeMap(id) {
      const i = maps.findIndex((m) => m.id === id);
      if (i < 0) return false;
      maps.splice(i, 1);
      emit('mapsChanged', api.listMaps());
      return true;
    },

    listMaps() {
      return maps.map((m) => Object.assign({}, m, { unlocked: api.isUnlocked(m.id) }));
    },

    getMap(id) { return maps.find((m) => m.id === id) || null; },

    /*
     * Whoever embeds mapkit decides what is playable. Everything is unlocked
     * until someone says otherwise, so the standalone build needs no provider at
     * all and a missing provider can never accidentally lock a player out.
     */
    setLockProvider(fn) { lockProvider = typeof fn === 'function' ? fn : null; },
    isUnlocked(id) {
      if (!lockProvider) return true;
      try { return !!lockProvider(id); }
      catch (e) { console.error('[mapkit] lock provider threw, treating as unlocked', e); return true; }
    },

    on(name, fn) {
      (listeners[name] = listeners[name] || []).push(fn);
      return () => api.off(name, fn);
    },
    off(name, fn) {
      const l = listeners[name];
      if (!l) return;
      const i = l.indexOf(fn);
      if (i >= 0) l.splice(i, 1);
    },
    emit,
  };

  return api;
}));


/* ===== mapkit/mapformat.js ===== */
/*
 * Translation between the editor's object model and the game's map format.
 *
 * Shared deliberately: the editor writes these files, mapkit reads them, and a
 * second implementation would drift the way the two normalise paths nearly did.
 * Pure functions, no DOM, so the round trip can be tested in node.
 *
 * The editor keeps every object as {kind, x, y, w, h, ...props}. The game does
 * not: it mixes x/y/w/h rects (plats, spikes), l/t/r/b rects (areas, door, boss
 * zones) and bare points (coins, spawn, gun) across separate arrays. Normalising
 * that on the way in keeps selection, dragging and resizing to one code path.
 *
 * Loads as a CommonJS module in node and as a plain script in the browser.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MapFormat = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const rectToGame = (o) => ({ l: o.x, t: o.y, r: o.x + o.w, b: o.y + o.h });
  const rectFromGame = (r) => ({ x: r.l, y: r.t, w: r.r - r.l, h: r.b - r.t });

  function toGame(map) {
    const by = (k) => map.objects.filter((o) => o.kind === k);
    const one = (k) => by(k)[0];
    const g = {
      plats: by('plat').map((o) => {
        const p = { x: o.x, y: o.y, w: o.w, h: o.h, right: o.x + o.w, bottom: o.y + o.h };
        // the game tests truthiness on these, and vanilla omits them entirely
        if (o.semi) p.semi = 1;
        if (o.stomper) {
          p.stomper = true;
          // Only write the crusher settings that were actually set. Anything
          // omitted falls back to the vanilla constant at runtime, so a map
          // that says nothing behaves exactly as the stock game did.
          for (const k of ['fallTo', 'trigX', 'trigW', 'trigY', 'accel', 'damage', 'resetIn']) {
            if (typeof o[k] === 'number' && isFinite(o[k])) p[k] = o[k];
          }
          if (o.repeat) p.repeat = true;
        }
        return p;
      }),
      coins: by('coin').map((o) => ({ x: o.x, y: o.y })),
      spikes: by('spike').map((o) => ({ x: o.x, y: o.y, w: o.w, h: o.h })),
      bombs: by('bomb').map((o) => ({
        x: o.x, y: o.y, xo: o.x, yo: o.y + 60,
        xxsi: o.xxsi, yysi: o.yysi, xmax: o.xmax, ymax: o.ymax,
      })),
      /*
       * Lasers carry their own length and orientation.
       *
       * iniLevel() force-rotates lasers[0] to a horizontal 590px beam whatever
       * the map says, and gives every other one the stock 40x180 upright box.
       * mapkit's patcher unpins both, but only for a laser that states what it
       * wants -- so the editor always writes them, and a map from the editor
       * never depends on which slot a laser happens to sit in.
       */
      lasers: by('laser').map((o) => ({
        x: o.x, y: o.y, ctMax: o.ctMax, ctSwitch: o.ctSwitch, ctCurr: o.ctCurr,
        horizontal: o.horizontal ? true : false,
        length: Math.max(8, Math.round(Number(o.length) || (o.horizontal ? 590 : 180))) })),
      enes: by('ene').map((o) => ({
        x: o.x, y: o.y, typ: o.typ, xx: o.xx, yy: o.yy,
        xmin: o.xmin, xmax: o.xmax, ymin: o.ymin, ymax: o.ymax })),
      platMove: by('platMove').map((o) => ({
        x: o.x, y: o.y, xx: o.xx, yy: o.yy,
        xmin: o.xmin, xmax: o.xmax, ymin: o.ymin, ymax: o.ymax })),
      areas: by('area').map((o) => Object.assign(rectToGame(o), {
        xx: o.xx, yy: o.yy, xmin: o.xmin, xmax: o.xmax, ymin: o.ymin, ymax: o.ymax })),
      bossData: {
        gate: one('bossGate') ? rectToGame(one('bossGate')) : { l: 0, t: 0, r: 0, b: 0 },
        range: one('bossRange') ? rectToGame(one('bossRange')) : { l: 0, t: 0, r: 0, b: 0 },
      },
      // The game reads a single `door`; the editor can place many. The first
      // one keeps feeding the vanilla field so boss.js still finds something,
      // and the full set rides along in `doors` for the runtime module.
      door: one('door') ? rectToGame(one('door')) : { l: 0, t: 0, r: 0, b: 0 },
      doors: by('door').map((o) => {
        const d = { x: o.x, y: o.y, w: o.w, h: o.h };
        for (const k of ['closeTo', 'speed', 'zx', 'zy', 'zw', 'zh']) {
          if (typeof o[k] === 'number' && isFinite(o[k])) d[k] = o[k];
        }
        if (o.trigger && o.trigger !== 'start') d.trigger = o.trigger;
        if (o.open) d.open = true;
        return d;
      }),
      sprt: one('sprt') ? { x: one('sprt').x, y: one('sprt').y, xx: one('sprt').xx ?? 1 }
                        : { x: 0, y: 0, xx: 1 },
      colGun: one('colGun') ? { x: one('colGun').x, y: one('colGun').y } : { x: 0, y: 0 },
    };
    if (map.yEnd !== undefined) g.yEnd = map.yEnd;
    // The art layer is the editor's addition. iniLevel() ignores unknown keys, so
    // it rides along harmlessly; mapkit is what draws it.
    g.art = by('art').slice().sort((a, b) => (a.z || 0) - (b.z || 0)).map((o) => ({
      tile: o.tile, x: o.x, y: o.y, w: o.w, h: o.h,
      rot: o.rot || 0, flipX: o.flipX ? 1 : 0, flipY: o.flipY ? 1 : 0, z: o.z || 0 }));
    if (map.meta) g.meta = map.meta;
    return g;
  }

  function fromGame(g, startId) {
    let id = startId || 1;
    const objects = [];
    const add = (kind, o) => { objects.push(Object.assign({ id: id++, kind }, o)); };

    (g.plats || []).forEach((p) => {
      const o = { x: p.x, y: p.y, w: p.w, h: p.h, semi: p.semi ? 1 : 0, stomper: p.stomper ? 1 : 0 };
      for (const k of ['fallTo', 'trigX', 'trigW', 'trigY', 'accel', 'damage', 'resetIn']) {
        if (p[k] !== undefined) o[k] = p[k];
      }
      if (p.repeat) o.repeat = 1;
      add('plat', o);
    });
    (g.coins || []).forEach((c) => add('coin', { x: c.x, y: c.y, w: 0, h: 0 }));
    (g.spikes || []).forEach((s) => add('spike', { x: s.x, y: s.y, w: s.w, h: s.h }));
    (g.bombs || []).forEach((b) => add('bomb', {
      x: b.x, y: b.y, w: 0, h: 0, xxsi: b.xxsi, yysi: b.yysi, xmax: b.xmax, ymax: b.ymax }));
    /*
     * A map that predates the length/orientation fields -- the stock level, or
     * anything the editor saved before them -- gets what the game would have
     * given it: the first laser horizontal at 590, the rest upright at 180.
     * That is the same default the patcher applies, so reading a map in and
     * writing it straight back out cannot move a beam.
     */
    (g.lasers || []).forEach((l, i) => {
      const horizontal = l.horizontal === undefined ? (i === 0) : !!l.horizontal;
      add('laser', {
        x: l.x, y: l.y, w: 0, h: 0, ctMax: l.ctMax, ctSwitch: l.ctSwitch, ctCurr: l.ctCurr,
        horizontal: horizontal ? 1 : 0,
        length: Number(l.length) || (horizontal ? 590 : 180) });
    });
    (g.enes || []).forEach((e) => add('ene', {
      x: e.x, y: e.y, w: 0, h: 0, typ: e.typ, xx: e.xx, yy: e.yy,
      xmin: e.xmin, xmax: e.xmax, ymin: e.ymin, ymax: e.ymax }));
    (g.platMove || []).forEach((m) => add('platMove', {
      x: m.x, y: m.y, w: 0, h: 0, xx: m.xx, yy: m.yy,
      xmin: m.xmin, xmax: m.xmax, ymin: m.ymin, ymax: m.ymax }));
    (g.areas || []).forEach((a) => add('area', Object.assign(rectFromGame(a), {
      xx: a.xx, yy: a.yy, xmin: a.xmin, xmax: a.xmax, ymin: a.ymin, ymax: a.ymax })));
    // prefer the multi-door array; fall back to the game's single door
    if (g.doors && g.doors.length) {
      g.doors.forEach((d) => {
        const o = { x: d.x, y: d.y, w: d.w, h: d.h };
        for (const k of ['closeTo', 'speed', 'zx', 'zy', 'zw', 'zh']) if (d[k] !== undefined) o[k] = d[k];
        o.trigger = d.trigger || 'start';
        if (d.open) o.open = 1;
        add('door', o);
      });
    } else if (g.door && (g.door.r - g.door.l) > 0) {
      add('door', Object.assign(rectFromGame(g.door), { trigger: 'start' }));
    }
    if (g.bossData && g.bossData.gate) add('bossGate', rectFromGame(g.bossData.gate));
    if (g.bossData && g.bossData.range) add('bossRange', rectFromGame(g.bossData.range));
    if (g.sprt) add('sprt', { x: g.sprt.x, y: g.sprt.y, w: 0, h: 0, xx: g.sprt.xx == null ? 1 : g.sprt.xx });
    if (g.colGun) add('colGun', { x: g.colGun.x, y: g.colGun.y, w: 0, h: 0 });
    (g.art || []).forEach((a) => add('art', Object.assign({}, a)));

    return {
      /*
       * meta comes back WHOLE, not rebuilt from the id and the name. toGame
       * forwards whatever is in it -- the map editor records which modules a map
       * was assembled from in meta.modules -- and reading a map in and writing it
       * straight back out must not lose that. iniLevel ignores meta entirely.
       */
      meta: Object.assign({}, g.meta,
        { id: (g.meta && g.meta.id) || '', name: (g.meta && g.meta.name) || 'Untitled' }),
      objects,
      yEnd: g.yEnd === undefined ? 3000 : g.yEnd,
      nextId: id,
    };
  }

  return { toGame, fromGame };
}));


/* ===== mapkit/tiles.js ===== */
/*
 * Rebuild the tileset at load time from the player's own copy of the game.
 *
 * No artwork ships. What ships is tiles.json -- a source rectangle per tile plus
 * its normalise settings -- and this replays that against the images the game
 * already loaded, so the textures come from the player's install rather than
 * from us.
 *
 * The shipped game never loads the full mural. It loads six 1710x1665 slices,
 * lvlGrfx1..6, laid out 3 across and 2 down from world (-1620, -720). A tile
 * rect can straddle up to four of them, so rects are stitched before anything
 * else happens.
 *
 * The pixel work is deliberately pure -- it takes and returns {width, height,
 * data} the same shape as ImageData -- so it runs unchanged in node and can be
 * diffed against what the build-time extractor produced. Only the glue at the
 * bottom touches canvases or Phaser.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MapkitTiles = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const luma = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
  const chroma = (r, g, b) => Math.max(r, g, b) - Math.min(r, g, b);

  const make = (w, h) => ({
    width: w, height: h,
    data: (typeof Uint8ClampedArray !== 'undefined' ? new Uint8ClampedArray(w * h * 4) : new Array(w * h * 4).fill(0)),
  });

  /*
   * Background test.
   *
   * Two rules, because one does not fit the whole set. The luma/chroma rule is
   * the general one: background is dark AND near-neutral, which protects texture
   * that is dark but coloured. Where a tile has dark internal detail even that
   * over-reaches, so `bg` matches specific colours instead -- this mural's
   * background is #000000 in most places and #202020 around the metal and rock
   * corners, and matching the colour leaves the near-black mortar alone.
   */
  function makeIsBackground(cfg, defaults) {
    if (cfg && cfg.bg) {
      const tol = cfg.tol === undefined ? 6 : cfg.tol;
      const list = cfg.bg;
      return (r, g, b) => {
        for (let i = 0; i < list.length; i++) {
          const c = list[i];
          if (Math.abs(r - c[0]) <= tol && Math.abs(g - c[1]) <= tol && Math.abs(b - c[2]) <= tol) return true;
        }
        return false;
      };
    }
    const L = (cfg && cfg.luma !== undefined) ? cfg.luma : defaults.luma;
    const C = (cfg && cfg.chroma !== undefined) ? cfg.chroma : defaults.chroma;
    return (r, g, b) => luma(r, g, b) <= L && chroma(r, g, b) <= C;
  }

  // background reachable from the border
  function backgroundMask(img, isBg) {
    const { width: W, height: H, data } = img;
    const bg = new Uint8Array(W * H);
    const stack = [];
    const push = (x, y) => {
      if (x < 0 || y < 0 || x >= W || y >= H) return;
      const i = y * W + x;
      if (bg[i]) return;
      const o = i * 4;
      if (data[o + 3] < 16) { bg[i] = 1; stack.push(i); return; }
      if (!isBg(data[o], data[o + 1], data[o + 2])) return;
      bg[i] = 1; stack.push(i);
    };
    for (let x = 0; x < W; x++) { push(x, 0); push(x, H - 1); }
    for (let y = 0; y < H; y++) { push(0, y); push(W - 1, y); }
    while (stack.length) {
      const i = stack.pop(), x = i % W, y = (i / W) | 0;
      push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1);
    }
    return bg;
  }

  /*
   * Background the border flood cannot reach. Opt-in, because the same shape
   * means opposite things: the rail's sealed band between its two bars is
   * background, the box's dark centre is texture.
   */
  function pocketMask(img, bg, isBg) {
    const { width: W, height: H, data } = img;
    const out = Uint8Array.from(bg);
    const seen = Uint8Array.from(bg);
    for (let start = 0; start < W * H; start++) {
      if (seen[start]) continue;
      const o0 = start * 4;
      if (data[o0 + 3] < 16) continue;
      if (!isBg(data[o0], data[o0 + 1], data[o0 + 2])) continue;
      const cells = [start];
      seen[start] = 1;
      for (let k = 0; k < cells.length; k++) {
        const i = cells[k], x = i % W, y = (i / W) | 0;
        const nb = [[1, 0], [-1, 0], [0, 1], [0, -1]];
        for (let n = 0; n < 4; n++) {
          const nx = x + nb[n][0], ny = y + nb[n][1];
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const j = ny * W + nx;
          if (seen[j]) continue;
          const o = j * 4;
          if (data[o + 3] < 16) { seen[j] = 1; cells.push(j); continue; }
          if (!isBg(data[o], data[o + 1], data[o + 2])) continue;
          seen[j] = 1; cells.push(j);
        }
      }
      for (let c = 0; c < cells.length; c++) out[cells[c]] = 1;
    }
    return out;
  }

  /*
   * Soften the boundary, un-mixing the black behind it.
   *
   * An edge pixel is already a blend of texture over black. Dropping its alpha
   * without touching RGB leaves a dark semi-transparent pixel that composites as
   * a halo, outlining every hole in the rope and gap in the spikes. Background is
   * black, so true = observed / alpha recovers the colour.
   */
  function feather(img, bg, lumaCut) {
    const { width: W, height: H, data } = img;
    const out = make(W, H);
    out.data.set(data);
    const MIN_A = 0.18;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x, o = i * 4;
        if (bg[i]) { out.data[o + 3] = 0; continue; }
        let touches = false;
        const nb = [[1, 0], [-1, 0], [0, 1], [0, -1]];
        for (let n = 0; n < 4; n++) {
          const nx = x + nb[n][0], ny = y + nb[n][1];
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          if (bg[ny * W + nx]) { touches = true; break; }
        }
        if (!touches) continue;
        const l = luma(data[o], data[o + 1], data[o + 2]);
        const a = Math.max(0, Math.min(1, (l - lumaCut * 0.4) / (lumaCut * 1.6)));
        out.data[o + 3] = Math.round(data[o + 3] * a);
        if (a >= MIN_A) {
          for (let k = 0; k < 3; k++) out.data[o + k] = Math.min(255, Math.round(data[o + k] / a));
        }
      }
    }
    return out;
  }

  function trim(img) {
    const { width: W, height: H, data } = img;
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (data[(y * W + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
    if (x1 < 0) return img;
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    const out = make(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const s = ((y0 + y) * W + (x0 + x)) * 4, d = (y * w + x) * 4;
      for (let k = 0; k < 4; k++) out.data[d + k] = data[s + k];
    }
    return out;
  }

  function cropMargins(img, m) {
    const w = img.width - m[0] - m[2], h = img.height - m[1] - m[3];
    if (w <= 0 || h <= 0) return img;
    const out = make(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const s = ((y + m[1]) * img.width + (x + m[0])) * 4, d = (y * w + x) * 4;
      for (let k = 0; k < 4; k++) out.data[d + k] = img.data[s + k];
    }
    return out;
  }

  // erase rectangles: for a neighbour intruding into a corner, where no colour
  // rule can help because it is real texture, just not this tile's
  function applyMasks(img, rects) {
    for (let r = 0; r < rects.length; r++) {
      const m = rects[r];
      for (let j = m[1]; j < m[1] + m[3]; j++) {
        for (let i = m[0]; i < m[0] + m[2]; i++) {
          if (i < 0 || j < 0 || i >= img.width || j >= img.height) continue;
          img.data[(j * img.width + i) * 4 + 3] = 0;
        }
      }
    }
    return img;
  }

  function normalize(img, cfg, defaults) {
    cfg = cfg || {};
    let t = img;
    if (cfg.crop) t = cropMargins(t, cfg.crop);
    if (cfg.mask) t = applyMasks(t, cfg.mask);
    if (cfg.mode === 'none') return trim(t);
    const isBg = makeIsBackground(cfg, defaults);
    let bg = backgroundMask(t, isBg);
    if (cfg.pockets) bg = pocketMask(t, bg, isBg);
    const lumaCut = cfg.bg ? defaults.luma : (cfg.luma === undefined ? defaults.luma : cfg.luma);
    return trim(feather(t, bg, lumaCut));
  }

  /*
   * Composite tiles, currently just the grass.
   *
   * The mural stamps that grass three times and the rocks cover a different part
   * of each, so a per-pixel union across all three recovers more than any single
   * copy holds. Below that every copy is occluded and nothing exists to recover,
   * so the base is continued downward from the last clean pixel in each column --
   * the band is vertical striping in two greens, so continuing it reproduces the
   * pattern rather than inventing structure.
   */
  function composite(spec, sample) {
    const W = spec.width, RECOV = spec.recovered, H = RECOV + spec.extend;
    const out = make(W, H);
    const isGrass = (r, g, b) => g >= r + 4 && g >= b + 15;
    const isLit = (r, g, b, a) => a >= 128 && luma(r, g, b) > 30;
    const lastClean = new Array(W).fill(null);
    const put = (i, j, px) => {
      const o = (j * W + i) * 4;
      out.data[o] = px[0]; out.data[o + 1] = px[1]; out.data[o + 2] = px[2]; out.data[o + 3] = 255;
    };

    for (let j = 0; j < RECOV; j++) {
      for (let i = 0; i < W; i++) {
        const samples = [];
        let occluded = false;
        for (let s = 0; s < spec.sources.length; s++) {
          const px = sample(spec.sources[s].x + i, spec.sources[s].y + j);
          if (!px || !isLit(px[0], px[1], px[2], px[3])) continue;
          if (!isGrass(px[0], px[1], px[2])) { occluded = true; continue; }
          samples.push(px);
        }
        if (!samples.length) continue;
        const med = [0, 1, 2].map((c) => {
          const v = samples.map((x) => x[c]).sort((a, b) => a - b);
          return v[v.length >> 1];
        });
        put(i, j, med);
        lastClean[i] = med;
      }
    }
    // fill pixels that were covered in every copy, from directly above
    for (let j = 0; j < RECOV; j++) {
      for (let i = 0; i < W; i++) {
        if (out.data[(j * W + i) * 4 + 3] >= 128) continue;
        let occluded = false;
        for (let s = 0; s < spec.sources.length; s++) {
          const px = sample(spec.sources[s].x + i, spec.sources[s].y + j);
          if (px && isLit(px[0], px[1], px[2], px[3]) && !isGrass(px[0], px[1], px[2])) { occluded = true; break; }
        }
        if (!occluded) continue;
        for (let k = j - 1; k >= 0; k--) {
          const p = (k * W + i) * 4;
          if (out.data[p + 3] >= 128) { put(i, j, [out.data[p], out.data[p + 1], out.data[p + 2]]); break; }
        }
      }
    }
    for (let j = RECOV; j < H; j++) {
      for (let i = 0; i < W; i++) if (lastClean[i]) put(i, j, lastClean[i]);
    }
    return out;
  }

  // ------------------------------------------------------------ browser glue
  /*
   * Stitch a mural rect out of the six slices the game actually loaded.
   */
  function makeSampler(win, recipe) {
    const s = recipe.slice;
    const canvases = s.keys.map((k) => {
      const img = win.game.cache.getImage(k, true);
      const src = img && (img.data || img);
      if (!src) return null;
      const c = win.document.createElement('canvas');
      c.width = s.w; c.height = s.h;
      c.getContext('2d').drawImage(src, 0, 0);
      return c.getContext('2d').getImageData(0, 0, s.w, s.h);
    });

    return function region(x, y, w, h) {
      const out = make(w, h);
      for (let j = 0; j < h; j++) {
        for (let i = 0; i < w; i++) {
          const X = x + i, Y = y + j;
          const col = Math.floor(X / s.w), row = Math.floor(Y / s.h);
          if (col < 0 || col >= s.cols || row < 0 || row >= s.rows) continue;
          const im = canvases[row * s.cols + col];
          if (!im) continue;
          const lx = X - col * s.w, ly = Y - row * s.h;
          const so = (ly * s.w + lx) * 4, d = (j * w + i) * 4;
          for (let k = 0; k < 4; k++) out.data[d + k] = im.data[so + k];
        }
      }
      return out;
    };
  }

  function toImage(win, img) {
    const c = win.document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const id = c.getContext('2d').createImageData(img.width, img.height);
    id.data.set(img.data);
    c.getContext('2d').putImageData(id, 0, 0);
    return c;
  }

  /*
   * Build every tile and register it in Phaser's cache under the renderer's key
   * prefix. Canvases are added directly, so there is no image decode to wait on.
   */
  function build(win, recipe, keyPrefix) {
    const region = makeSampler(win, recipe);
    const one = (x, y) => {
      const r = region(x, y, 1, 1);
      return r.data[3] === 0 && r.data[0] === 0 && r.data[1] === 0 && r.data[2] === 0
        ? [0, 0, 0, 0] : [r.data[0], r.data[1], r.data[2], r.data[3]];
    };
    const built = [];

    for (let i = 0; i < recipe.tiles.length; i++) {
      const t = recipe.tiles[i];
      const raw = region(t.rect.x, t.rect.y, t.rect.w, t.rect.h);
      const norm = normalize(raw, t.norm, recipe.defaults);
      win.game.cache.addImage(keyPrefix + t.name, '', toImage(win, norm));
      built.push(t.name);
    }
    for (let i = 0; i < (recipe.composites || []).length; i++) {
      const c = recipe.composites[i];
      const img = composite(c, one);
      win.game.cache.addImage(keyPrefix + c.name, '', toImage(win, img));
      built.push(c.name);
    }
    return built;
  }

  return {
    build, normalize, composite, makeIsBackground, backgroundMask,
    pocketMask, feather, trim, cropMargins, applyMasks, make,
  };
}));


/* ===== mapkit/crushers.js ===== */
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


/* ===== mapkit/doors.js ===== */
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


/* ===== mapkit/renderer.js ===== */
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


/* ===== mapkit/patcher.js ===== */
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
   * Host-page functions: cmgGameEvent and cmgAdBreak.
   *
   * IMPORTANT -- on coolmathgames.com these are REAL and must be left alone.
   * cmgAdBreak runs the ad that pays for the game being there; suppressing it,
   * wrapping it so it can be skipped, or faking its completion event would be
   * both a licence problem and simple theft from the host. So:
   *
   *   - if the page already defines them, we do not touch them, at all
   *   - our stand-ins are installed ONLY when they are genuinely absent, which
   *     means a local dev host or an offline build where no ad exists to run
   *   - the caller's onAdBreak hook (quick-run uses it to skip the shop) lives
   *     inside the stub, so it cannot run on a page with a real ad break
   *
   * The stub has to dispatch adBreakComplete itself because addBreak() hides the
   * sprite layer and mutes before calling out, then waits for that event to put
   * both back. Without it the game sits on a black screen forever. The real
   * implementation fires the same event when the ad finishes.
   */
  function stubHost(win, opts) {
    const realAdBreak = typeof win.cmgAdBreak === 'function';
    const realEvent = typeof win.cmgGameEvent === 'function';

    if (!realEvent) win.cmgGameEvent = function () {};
    if (!realAdBreak) {
      win.cmgAdBreak = function () {
        if (opts && opts.onAdBreak) opts.onAdBreak();
        win.document.dispatchEvent(new Event('adBreakComplete'));
      };
    } else if (opts && opts.onAdBreak) {
      console.info('[mapkit] real cmgAdBreak present; ignoring onAdBreak hook so the ad runs as intended');
    }

    return { realAdBreak, realEvent };
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
        /*
         * Length is applied whether or not the orientation changed. Skipping a
         * laser whose orientation already matched meant a map could set any
         * length it liked on an upright beam and get the stock 180 anyway --
         * the beam drawn in the editor and the beam that hurt you were then
         * different objects. Half the beam sits either side of the sprite,
         * which is anchored at its centre.
         */
        const len = Math.max(8, Number(spec.length) || (wantHorizontal ? 590 : 180));
        const half = len / 2;
        l.angle = wantHorizontal ? 90 : 0;
        l.height = len;
        win.getBoundsByOffset(l, wantHorizontal
          ? { l: -half, t: -20, r: half, b: 20 }
          : { l: -20, t: -half, r: 20, b: half });
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
    const host = stubHost(win, opts);
    allowHost(win);
    guardCamera(win);
    freeLasers(win);
    if (win.Crushers) win.Crushers.install(win);
    if (win.Doors) win.Doors.install(win);
    if (win.MapkitRenderer) win.MapkitRenderer.install(win);
    // hosts can branch on this -- e.g. do not offer "skip the shop" where a real
    // ad break has to run between levels
    return host;
  }

  return { install, stubHost, allowHost, guardCamera, freeLasers };
}));


/* ===== mapkit/saves.js ===== */
/*
 * Per-level save data.
 *
 * The stock game keeps one save under localStorage 'ldat' -- upgrades, cash,
 * stats and visited areas, all of it -- because there is only ever one level.
 * With a library of levels that is wrong twice over: progress earned in one
 * level carries into every other, and there is no way to restart a single level
 * fresh without wiping everything.
 *
 * So each map gets its own slot, 'ldat:<mapId>', and game.ldat is swapped to the
 * right one when a level starts. The game's own saveStats() is wrapped rather
 * than replaced, so anything else it does keeps happening and any future call
 * site is covered automatically.
 *
 * The stock key is left alone. A player who also plays the normal game keeps
 * that progress untouched.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MapkitSaves = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const PREFIX = 'ldat:';
  const key = (id) => PREFIX + id;

  function make(win) {
    let current = null;

    function read(id) {
      try {
        const raw = localStorage.getItem(key(id));
        return raw ? JSON.parse(raw) : null;
      } catch (e) { return null; }
    }

    function write(id, ldat) {
      try { localStorage.setItem(key(id), JSON.stringify(ldat)); }
      catch (e) { /* quota or private mode: play on, just unsaved */ }
    }

    /*
     * A fresh save has to come from the game's own iniLdat(), not a literal
     * written here -- it sets up nine upgrade tracks plus cash, xp, areas and
     * stats, and the shop and boss code read fields an approximation would miss.
     */
    function fresh() {
      win.iniLdat();
      return win.game.ldat;
    }

    const api = {
      /* Point the game at this level's save, creating one if needed. */
      use(id) {
        current = id;
        const saved = read(id);
        if (saved && saved.nrg && saved.nrg.v) win.game.ldat = saved;
        else { fresh(); write(id, win.game.ldat); }
        return win.game.ldat;
      },

      current: () => current,
      has: (id) => !!read(id),
      save() { if (current) write(current, win.game.ldat); },

      /* Wipe one level's progress. If it is the level in play, reset it live. */
      reset(id) {
        try { localStorage.removeItem(key(id)); } catch (e) { /* ignore */ }
        if (id === current) { fresh(); write(id, win.game.ldat); }
        return true;
      },

      resetAll() {
        try {
          const doomed = [];
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.indexOf(PREFIX) === 0) doomed.push(k);
          }
          doomed.forEach((k) => localStorage.removeItem(k));
        } catch (e) { /* ignore */ }
        if (current) { fresh(); write(current, win.game.ldat); }
        return true;
      },

      /*
       * Route the game's own persistence into the active level's slot. Wrapped,
       * not replaced: saveStats() is the only writer today, but wrapping means a
       * change upstream still lands in the right place.
       */
      install() {
        const orig = win.saveStats;
        win.saveStats = function () {
          if (orig) orig.apply(this, arguments);
          api.save();
        };
      },
    };

    return api;
  }

  return { make, PREFIX };
}));


/* ===== mapkit/settings.js ===== */
/*
 * Audio mute and save-data reset, outside the game's own UI.
 *
 * The stock game only exposes these from inside a level (level.js muteButtons)
 * and from the title screen -- both of which mapkit replaces or bypasses. So a
 * player who never sees the stock title has no way to mute anything or clear
 * their save. This puts the same three controls somewhere reachable.
 *
 * It drives the game's OWN state rather than inventing a parallel one:
 *
 *   game.muteMu   music muted. Applied as mu.mute, checked when tracks start.
 *   game.muteFX   sfx muted. fxPlay() is a no-op while it is set.
 *   localStorage 'ldat'   the whole save: upgrades, cash, stats, visited areas.
 *
 * The game never persists the two mute flags -- they live only on `game` and
 * reset every reload -- so they are stored here and reapplied on boot.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MapkitSettings = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const PREFS = 'mapkit-audio';
  const SAVE = 'ldat';

  function readPrefs() {
    try { return JSON.parse(localStorage.getItem(PREFS)) || {}; }
    catch (e) { return {}; }
  }
  function writePrefs(p) {
    try { localStorage.setItem(PREFS, JSON.stringify(p)); } catch (e) { /* private mode */ }
  }

  function make(win) {
    const api = {
      musicMuted: () => !!win.game.muteMu,
      sfxMuted: () => !!win.game.muteFX,

      setMusicMuted(on) {
        win.game.muteMu = !!on;
        // `mu` is the track currently loaded; muPlay carries the flag onto the next
        if (win.mu) win.mu.mute = !!on;
        if (win.setMuFXBtns) win.setMuFXBtns();
        const p = readPrefs(); p.music = !!on; writePrefs(p);
      },

      setSfxMuted(on) {
        win.game.muteFX = !!on;
        if (win.setMuFXBtns) win.setMuFXBtns();
        const p = readPrefs(); p.sfx = !!on; writePrefs(p);
      },

      toggleMusic() { api.setMusicMuted(!api.musicMuted()); return api.musicMuted(); },
      toggleSfx() { api.setSfxMuted(!api.sfxMuted()); return api.sfxMuted(); },

      /*
       * Wipe the save and rebuild it. iniLdat() is the game's own initialiser, so
       * the fresh object is exactly what a first-time player gets rather than an
       * approximation that might miss a field the shop or boss code expects.
       */
      resetSave() {
        try { localStorage.removeItem(SAVE); } catch (e) { /* ignore */ }
        if (win.iniLdat) {
          win.iniLdat();
          try { localStorage.setItem(SAVE, JSON.stringify(win.game.ldat)); } catch (e) { /* ignore */ }
        }
        return true;
      },

      // reapply stored preferences once the game object exists
      apply() {
        const p = readPrefs();
        if (p.music !== undefined) api.setMusicMuted(p.music);
        if (p.sfx !== undefined) api.setSfxMuted(p.sfx);
      },
    };
    return api;
  }

  return { make };
}));


/* ===== mapkit/select.js ===== */
/*
 * Level select.
 *
 * A DOM overlay rather than a Phaser state, for three reasons: the thumbnails
 * are already PNGs the editor renders on save, a paged responsive grid is a few
 * lines of CSS against a lot of sprite maths, and the Archipelago client is a
 * userscript on a normal web page where an overlay is the natural thing anyway.
 *
 * It shows whenever the game returns to its title screen, so "exit to main menu"
 * lands back here rather than on the stock title.
 *
 * Locking is asked of Mapkit, which asks whoever embedded it. Standalone that is
 * nobody, so everything is playable; under Archipelago a locked level renders
 * greyed with its reason, and cannot be started.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MapkitSelect = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CSS = `
  #mk-select { position:fixed; inset:0; z-index:9999; overflow:auto;
    background:#0d0f14; color:#dde1ea;
    font:13px/1.45 ui-sans-serif,system-ui,sans-serif; }
  #mk-select .mk-wrap { max-width:1100px; margin:0 auto; padding:26px 22px 34px; }
  #mk-select h1 { font-size:20px; margin:0 0 2px; letter-spacing:.01em; }
  #mk-select .mk-sub { color:#8b93a7; font-size:12px; margin-bottom:18px; }
  #mk-select .mk-bar { display:flex; gap:8px; align-items:center; margin-bottom:16px; flex-wrap:wrap; }
  #mk-select .mk-sp { flex:1; }
  #mk-select button { background:#262b38; border:1px solid #2c3040; color:#dde1ea;
    border-radius:7px; padding:7px 12px; font:inherit; font-size:12px; cursor:pointer; }
  #mk-select button:hover:not(:disabled) { background:#303748; }
  #mk-select button:disabled { opacity:.4; cursor:default; }
  #mk-select button.mk-primary { background:#6ea8fe; border-color:#6ea8fe; color:#0d1017; font-weight:600; }
  #mk-select .mk-grid { display:grid; gap:14px;
    grid-template-columns:repeat(auto-fill, minmax(210px, 1fr)); }
  #mk-select .mk-card { background:#1c1f28; border:1px solid #2c3040; border-radius:10px;
    overflow:hidden; cursor:pointer; display:flex; flex-direction:column;
    transition:border-color .12s, transform .12s; }
  #mk-select .mk-card:hover { border-color:#6ea8fe; transform:translateY(-2px); }
  #mk-select .mk-card.mk-locked { cursor:default; opacity:.45; }
  #mk-select .mk-card.mk-locked:hover { border-color:#2c3040; transform:none; }
  #mk-select .mk-thumb { aspect-ratio:16/10; background:#0d0f14 center/cover no-repeat;
    display:grid; place-items:center; color:#4d5468; font-size:11px; }
  #mk-select .mk-meta { padding:9px 11px; border-top:1px solid #2c3040; }
  #mk-select .mk-name { font-size:13px; font-weight:600; overflow:hidden;
    text-overflow:ellipsis; white-space:nowrap; }
  #mk-select .mk-tag { color:#8b93a7; font-size:10px; margin-top:2px; }
  #mk-select .mk-tag.mk-why { color:#e8c46a; }
  #mk-select .mk-settings { margin:-6px 0 16px; padding-top:12px;
    border-top:1px solid #22262f; }
  #mk-select .mk-danger { border-color:#4a2b2b; color:#e0a0a0; }
  #mk-select .mk-danger:hover:not(:disabled) { background:#3a2427; color:#f0c0c0; }
  #mk-select .mk-empty { color:#8b93a7; text-align:center; padding:60px 20px; }
  #mk-select .mk-pager { display:flex; gap:8px; align-items:center; justify-content:center;
    margin-top:20px; color:#8b93a7; font-size:12px; }
  #mk-select .mk-del { float:right; color:#8b93a7; font-size:11px; padding:0 4px; }
  #mk-select .mk-del:hover { color:#e07a7a; }
  #mk-select .mk-reset:hover { color:#e8c46a; }
  `;

  let host = null;
  let page = 0;
  let perPage = 12;
  let cfg = {};

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function ensureHost() {
    if (host) return host;
    const style = el('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    host = el('div');
    host.id = 'mk-select';
    document.body.appendChild(host);
    return host;
  }

  function render() {
    ensureHost();
    const maps = cfg.mapkit.listMaps();
    const pages = Math.max(1, Math.ceil(maps.length / perPage));
    if (page >= pages) page = pages - 1;

    host.innerHTML = '';
    const wrap = el('div', 'mk-wrap');
    wrap.appendChild(el('h1', null, cfg.title || 'Select a level'));
    wrap.appendChild(el('div', 'mk-sub',
      maps.length ? maps.length + ' level' + (maps.length === 1 ? '' : 's') + ' available'
                  : 'No levels yet'));

    // toolbar
    const bar = el('div', 'mk-bar');
    if (cfg.allowImport !== false) {
      const imp = el('button', 'mk-primary', 'Import level…');
      imp.onclick = pickFiles;
      bar.appendChild(imp);
    }
    /*
     * Extra toolbar buttons, read fresh on every render.
     *
     * Read rather than captured because whoever adds one may only exist after
     * the selector is installed -- the level editor is bundled on top of this
     * screen and registers itself once the game is up, and a captured array
     * would have been empty at that point.
     */
    for (const b of (cfg.buttons || [])) {
      const btn = el('button', b.primary ? 'mk-primary' : null, b.label);
      btn.onclick = () => b.onClick();
      bar.appendChild(btn);
    }
    bar.appendChild(el('span', 'mk-sp'));
    if (cfg.onExit) {
      const back = el('button', null, 'Back to title');
      back.onclick = () => { hide(); cfg.onExit(); };
      bar.appendChild(back);
    }
    wrap.appendChild(bar);

    /*
     * Audio and save controls.
     *
     * The stock game only offers these from inside a level or from its title
     * screen, and mapkit replaces the title. Without them here, a player who
     * never sees the stock title cannot mute anything or clear their save.
     */
    if (cfg.settings) {
      const row = el("div", "mk-bar mk-settings");
      const mkToggle = (label, isOn, toggle) => {
        const b = el("button");
        const paint = () => { b.textContent = label + ": " + (isOn() ? "off" : "on"); };
        b.onclick = () => { toggle(); paint(); };
        paint();
        return b;
      };
      row.appendChild(mkToggle("Music", () => cfg.settings.musicMuted(), () => cfg.settings.toggleMusic()));
      row.appendChild(mkToggle("Sound", () => cfg.settings.sfxMuted(), () => cfg.settings.toggleSfx()));
      row.appendChild(el("span", "mk-sp"));
      const reset = el("button", "mk-danger", "Reset save data");
      reset.onclick = () => {
        // upgrades, cash and stats are the whole of a run, so this is worth a
        // confirmation rather than a single misclick
        if (!confirm("Erase progress for EVERY level?\n\nUse the ↺ on a level to reset just that one.\nThis cannot be undone.")) return;
        cfg.settings.resetSave();
        reset.textContent = "Save cleared";
        setTimeout(() => { reset.textContent = "Reset save data"; }, 1600);
      };
      row.appendChild(reset);
      wrap.appendChild(row);
    }

    if (!maps.length) {
      wrap.appendChild(el('div', 'mk-empty',
        cfg.allowImport === false ? 'Nothing here yet.'
          : 'Import a level file to get started.'));
    } else {
      const grid = el('div', 'mk-grid');
      for (const m of maps.slice(page * perPage, (page + 1) * perPage)) grid.appendChild(card(m));
      wrap.appendChild(grid);

      if (pages > 1) {
        const pager = el('div', 'mk-pager');
        const prev = el('button', null, '‹ prev');
        prev.disabled = page === 0;
        prev.onclick = () => { page--; render(); };
        const next = el('button', null, 'next ›');
        next.disabled = page >= pages - 1;
        next.onclick = () => { page++; render(); };
        pager.appendChild(prev);
        pager.appendChild(el('span', null, 'page ' + (page + 1) + ' of ' + pages));
        pager.appendChild(next);
        wrap.appendChild(pager);
      }
    }
    host.appendChild(wrap);
  }

  function card(m) {
    const locked = !m.unlocked;
    const c = el('div', 'mk-card' + (locked ? ' mk-locked' : ''));
    const t = el('div', 'mk-thumb');
    if (m.thumb) t.style.backgroundImage = 'url("' + m.thumb + '")';
    else t.textContent = 'no preview';
    c.appendChild(t);

    const meta = el('div', 'mk-meta');
    const name = el('div', 'mk-name', m.name);
    /*
     * Per-level controls sit on the card rather than in a menu, because both
     * only ever apply to one level and 'which level does this affect' is
     * exactly the thing that goes wrong when they are elsewhere.
     */
    if (cfg.onResetLevel) {
      const rst = el('span', 'mk-del mk-reset', '↺');
      rst.title = 'Reset progress for this level only';
      rst.onclick = (e) => {
        e.stopPropagation();
        if (!confirm('Reset progress for "' + m.name + '"?\n\nOther levels keep theirs.')) return;
        cfg.onResetLevel(m.id);
        render();
      };
      name.appendChild(rst);
    }
    // Only a level this browser owns can be edited: the stock level and
    // anything bundled into the script have no editable copy to open.
    if (m.source === 'imported' && cfg.onEditLevel) {
      const ed = el('span', 'mk-del mk-reset', '✎');
      ed.title = 'Open this level in the editor';
      ed.onclick = (e) => { e.stopPropagation(); cfg.onEditLevel(m.id); };
      name.appendChild(ed);
    }
    if (m.source === 'imported' && cfg.onDelete) {
      const del = el('span', 'mk-del', '✕');
      del.title = 'Remove this imported level';
      del.onclick = (e) => { e.stopPropagation(); cfg.onDelete(m.id); render(); };
      name.appendChild(del);
    }
    meta.appendChild(name);

    // A locked level should say WHY, not just refuse. Under Archipelago that is
    // usually "you have not received the item yet".
    const reason = locked && cfg.lockReason ? cfg.lockReason(m.id) : null;
    const played = cfg.hasProgress && cfg.hasProgress(m.id) ? 'in progress' : m.source;
    meta.appendChild(el('div', 'mk-tag' + (reason ? ' mk-why' : ''), reason || played));
    c.appendChild(meta);

    if (!locked) c.onclick = () => { hide(); cfg.onPick(m); };
    return c;
  }

  /*
   * Import. Accepts one or more map files, and tolerates a whole folder being
   * dropped in, since that is how a pack tends to arrive.
   */
  function pickFiles() {
    const inp = el('input');
    inp.type = 'file';
    inp.accept = '.json,application/json';
    inp.multiple = true;
    inp.onchange = async () => {
      const results = [];
      for (const f of inp.files) {
        try {
          const data = JSON.parse(await f.text());
          if (!data.plats) throw new Error('not a map file (no plats)');
          const id = (data.meta && data.meta.id) || f.name.replace(/\.json$/i, '');
          results.push({ id, name: (data.meta && data.meta.name) || id, data });
        } catch (e) {
          console.error('[mapkit] could not import ' + f.name, e);
          alert('Could not import ' + f.name + ':\n' + e.message);
        }
      }
      if (results.length && cfg.onImport) await cfg.onImport(results);
      render();
    };
    inp.click();
  }

  function show() { ensureHost(); host.style.display = 'block'; render(); }
  function hide() { if (host) host.style.display = 'none'; }

  /*
   * Take over the title screen, so leaving a level comes back here.
   */
  function install(win, options) {
    cfg = options || {};
    if (!cfg.mapkit) throw new Error('MapkitSelect needs { mapkit }');
    perPage = cfg.perPage || perPage;

    cfg.mapkit.on('mapsChanged', () => { if (host && host.style.display !== 'none') render(); });

    /*
     * Take over the title screen.
     *
     * All three hooks, not just create(). Phaser keeps calling update() and
     * render() on the active state, and TitleState.update dereferences a `title`
     * global that only create() builds -- so skipping create alone throws
     * "can't access property c1, title is undefined" every frame behind the
     * overlay. When we replace the screen we have to silence the whole state.
     */
    if (win.TitleState) {
      const orig = {
        create: win.TitleState.create,
        update: win.TitleState.update,
        render: win.TitleState.render,
      };
      const replacing = () => cfg.replaceTitle !== false;
      win.TitleState.create = function () {
        if (!replacing()) orig.create && orig.create.apply(this, arguments);
        show();
      };
      win.TitleState.update = function () {
        if (!replacing()) orig.update && orig.update.apply(this, arguments);
      };
      win.TitleState.render = function () {
        if (!replacing()) orig.render && orig.render.apply(this, arguments);
      };
    }
    return { show, hide, render };
  }

  return { install, show, hide, render };
}));



/* ------------------------------------------------------------------ bootstrap */
(function () {
  'use strict';

  var RECIPE = {"version":1,"note":"Rebuilds the tileset from the player's own lvlGrfx1..6. No artwork included.","slice":{"w":1710,"h":1665,"cols":3,"rows":2,"keys":["lvlGrfx1","lvlGrfx2","lvlGrfx3","lvlGrfx4","lvlGrfx5","lvlGrfx6"]},"defaults":{"luma":14,"chroma":12},"tiles":[{"name":"alt_blue_surface","rect":{"x":2685,"y":1200,"w":339,"h":30},"norm":{}},{"name":"big_metal_corner","rect":{"x":1717,"y":2328,"w":83,"h":81},"norm":{"bg":[[32,32,32],[0,0,0]],"tol":6}},{"name":"blue_accent_surface","rect":{"x":2410,"y":1080,"w":100,"h":81},"norm":{"mode":"none"}},{"name":"blue_accent_surface_corner","rect":{"x":2610,"y":1080,"w":80,"h":120},"norm":{"mode":"none"}},{"name":"blue_beam_surface","rect":{"x":4632,"y":1407,"w":96,"h":4},"norm":{}},{"name":"blue_surface","rect":{"x":3970,"y":1730,"w":380,"h":40},"norm":{"luma":30,"chroma":20}},{"name":"boss_door_has_some_other_platform_edges_on_edges","rect":{"x":3599,"y":2500,"w":121,"h":30},"norm":{"bg":[[32,32,32],[0,0,0]],"tol":8,"mask":[[0,0,4,11]]}},{"name":"box","rect":{"x":4349,"y":1630,"w":101,"h":100},"norm":{"mode":"none"}},{"name":"green_accent_under_blue_beam_surface_which_should_be_trimmed","rect":{"x":1300,"y":1462,"w":170,"h":30},"norm":{}},{"name":"green_beam_surface","rect":{"x":3686,"y":2361,"w":28,"h":139},"norm":{}},{"name":"hazard_surface","rect":{"x":2070,"y":1080,"w":120,"h":80},"norm":{"bg":[[0,0,0],[32,32,32],[36,36,36]],"tol":5}},{"name":"hazard_surface_edge","rect":{"x":2190,"y":1080,"w":120,"h":80},"norm":{"bg":[[0,0,0],[32,32,32],[36,36,36]],"tol":5}},{"name":"large_metal_surface","rect":{"x":1949,"y":1571,"w":53,"h":100},"norm":{}},{"name":"large_metal_surface_alt","rect":{"x":3018,"y":1726,"w":100,"h":53},"norm":{}},{"name":"large_rock_surface","rect":{"x":1230,"y":1080,"w":100,"h":58},"norm":{}},{"name":"laser_base","rect":{"x":1700,"y":1240,"w":60,"h":42},"norm":{}},{"name":"rail","rect":{"x":3419,"y":2720,"w":161,"h":50},"norm":{"luma":40,"chroma":30,"pockets":true}},{"name":"rope","rect":{"x":2744,"y":1282,"w":21,"h":207},"norm":{"luma":40,"chroma":30,"pockets":true}},{"name":"small_metal_surface","rect":{"x":709,"y":2331,"w":25,"h":90},"norm":{}},{"name":"small_rock_filler_surface","rect":{"x":2689,"y":2677,"w":51,"h":22},"norm":{}},{"name":"small_rock_surface","rect":{"x":708,"y":1290,"w":25,"h":100},"norm":{}},{"name":"spike_with_a_little_blue_beam_that_needs_trimming","rect":{"x":4740,"y":1510,"w":40,"h":40},"norm":{"luma":46,"chroma":30}},{"name":"square_rocks_block","rect":{"x":4079,"y":1090,"w":60,"h":100},"norm":{}},{"name":"square_rocks_block_corner","rect":{"x":4139,"y":1090,"w":41,"h":100},"norm":{"bg":[[32,32,32]],"tol":3}},{"name":"steel_surface","rect":{"x":3449,"y":1727,"w":521,"h":73},"norm":{}},{"name":"wooden_platform_surface","rect":{"x":3090,"y":1489,"w":140,"h":22},"norm":{"luma":40,"chroma":30}},{"name":"x_center_surface","rect":{"x":2980,"y":2960,"w":100,"h":89},"norm":{}}],"composites":[{"name":"grass_surface","width":149,"recovered":26,"extend":8,"sources":[{"x":807,"y":994},{"x":1649,"y":1055},{"x":1061,"y":1055}],"rule":"green"}]};
  var BUNDLED = [];
  /*
   * An optional extension, injected at build time: a function (ctx) run once
   * everything is installed. The level-editor build uses it to add itself to
   * this screen. Nothing in mapkit knows what it does.
   */
  var EXTEND = null;
  var KEY_PREFIX = 'mkTile_';
  var STORE = 'mapkit-imported';

  var settings = null, saves = null, pending = null, installed = false;
  var selectCfg = null, selectHandle = null;

  function loadImported() {
    try { var r = localStorage.getItem(STORE); var l = r ? JSON.parse(r) : []; return Array.isArray(l) ? l : []; }
    catch (e) { return []; }
  }
  function saveImported(list) {
    try { localStorage.setItem(STORE, JSON.stringify(list)); }
    catch (e) { alert('Could not save imported levels: ' + e.message); }
  }

  /*
   * Wait for the game.
   *
   * We run at document-start, well before the SDK's own script tags have
   * executed, so everything we patch is still undefined. Polling is the whole
   * of it -- these are plain globals, and the splash screen gives us seconds.
   */
  var NEEDS = ['iniLevel', 'LevelState', 'TitleState', 'LoaderState', 'maps', 'newState'];
  function missing() {
    var out = [];
    for (var i = 0; i < NEEDS.length; i++) {
      if (typeof window[NEEDS[i]] === 'undefined') out.push(NEEDS[i]);
    }
    return out;
  }
  function ready() { return missing().length === 0; }

  function install() {
    if (installed) return;
    installed = true;

    /*
     * Leave the real ad break alone. On coolmathgames.com cmgAdBreak exists and
     * pays for the game being there; the patcher only ever fills in a stand-in
     * where none is present, and no option here can skip it.
     */
    window.MapkitPatcher.install(window, {});

    settings = window.MapkitSettings.make(window);
    saves = window.MapkitSaves.make(window);
    saves.install();

    /*
     * The original level, captured before anything overwrites maps[1]. Nothing
     * ships for it: the data is already in the page, and with no art layer the
     * renderer leaves its painted background alone.
     */
    try {
      window.Mapkit.addMap({ id: 'original', name: 'Original Level',
        data: JSON.parse(JSON.stringify(window.maps[1])), source: 'original' });
    } catch (e) { console.warn('[mapkit] could not read the stock level', e); }

    for (var i = 0; i < BUNDLED.length; i++) {
      window.Mapkit.addMap({ id: BUNDLED[i].id, name: BUNDLED[i].name, data: BUNDLED[i].data, source: 'builtin' });
    }
    var imported = loadImported();
    for (var j = 0; j < imported.length; j++) {
      window.Mapkit.addMap({ id: imported[j].id, name: imported[j].name, data: imported[j].data,
        thumb: imported[j].thumb || null, source: 'imported' });
    }

    selectCfg = {
      mapkit: window.Mapkit,
      title: "Johnny Upgrade — Custom Levels",
      buttons: [],
      settings: Object.assign({}, settings, {
        resetSave: function () { settings.resetSave(); saves.resetAll(); },
      }),
      onPick: startLevel,
      onResetLevel: function (id) { saves.reset(id); },
      hasProgress: function (id) { return saves.has(id); },
      onImport: function (entries) {
        var list = loadImported();
        for (var k = 0; k < entries.length; k++) {
          var e = entries[k];
          var at = -1;
          for (var n = 0; n < list.length; n++) if (list[n].id === e.id) at = n;
          var rec = { id: e.id, name: e.name, data: e.data };
          if (at >= 0) list[at] = rec; else list.push(rec);
          window.Mapkit.addMap({ id: rec.id, name: rec.name, data: rec.data, source: 'imported' });
        }
        saveImported(list);
      },
      onDelete: function (id) {
        var list = loadImported().filter(function (m) { return m.id !== id; });
        saveImported(list);
        window.Mapkit.removeMap(id);
      },
    };
    selectHandle = window.MapkitSelect.install(window, selectCfg);

    /*
     * Build the tileset once the game's own preload has finished, because that
     * is when lvlGrfx1..6 are in the cache to be read.
     */
    var origLoaderCreate = window.LoaderState.create;
    window.LoaderState.create = function () {
      origLoaderCreate.apply(this, arguments);
      try {
        var built = window.MapkitTiles.build(window, RECIPE, KEY_PREFIX);
        console.info('[mapkit] rebuilt ' + built.length + ' textures from your copy of the game');
      } catch (e) {
        console.error('[mapkit] could not rebuild textures', e);
      }
      settings.apply();
      if (window.game && window.game.btnPlay) window.game.btnPlay.destroy();
      window.levl = 0;
      window.newState();
    };

    /*
     * Level over -- by death or by finishing -- goes to the SHOP. That is the
     * game's own loop: destroySprite() sets world.doneCT, render() turns that
     * into levl = -1 and calls addBreak(). The shop's home button then sets
     * levl = 0, landing on the level select, and its play button replays the
     * level. Overriding levl here skipped the shop entirely, which is most of
     * the game.
     */
    document.addEventListener('adBreakComplete', function () {
      if (pending) window.Mapkit.emit('levelComplete', { id: pending.id, name: pending.name });
    });

    if (EXTEND) {
      try {
        EXTEND({
          win: window,
          mapkit: window.Mapkit,
          select: selectHandle,
          selectCfg: selectCfg,
          startLevel: startLevel,
          settings: settings,
          saves: saves,
          tileKeyPrefix: KEY_PREFIX,
        });
      } catch (e) { console.error('[mapkit] extension failed to install', e); }
    }

    console.info('[mapkit] custom levels ready');
  }

  function startLevel(entry) {
    pending = entry;
    window.maps[1] = entry.data;
    saves.use(entry.id);
    window.Mapkit.emit('levelStart', { id: entry.id, name: entry.name });
    window.levl = 1;
    window.newState();
  }

  var tries = 0;
  var timer = setInterval(function () {
    if (ready()) { clearInterval(timer); install(); return; }
    if (++tries > 600) { clearInterval(timer); console.warn('[mapkit] game never appeared; giving up'); }
  }, 100);
})();
