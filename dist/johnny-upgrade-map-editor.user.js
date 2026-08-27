// ==UserScript==
// @name         Johnny Upgrade — Level Editor
// @namespace    johnny-upgrade-mapkit
// @version      0.2.0
// @description  Build, play and share custom Johnny Upgrade levels in the browser. Includes the custom-level runtime and level select.
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
      meta: { id: (g.meta && g.meta.id) || '', name: (g.meta && g.meta.name) || 'Untitled' },
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


/* ===== mapeditor/editor/editor-core.js ===== */
/*
 * The map editor, as a mountable module.
 *
 * Authoring is in WORLD coordinates, the same space the game's map data uses, so
 * what is saved needs no conversion beyond regrouping into the game's field
 * names. world = muralPixel - (1620, 720), which is also how the tile provenance
 * is expressed, so textures and geometry share one coordinate system.
 *
 * Internally every object is {kind, x, y, w, h, ...props} regardless of how the
 * game stores it -- the game mixes x/y/w/h rects, l/t/r/b rects and bare points
 * across its arrays, and normalising that here keeps selection, dragging and
 * resizing to a single code path. MapFormat.toGame()/fromGame() do the
 * translation, and mapkit owns that file because mapkit ships.
 *
 * WHY THIS IS A MODULE AND NOT A PAGE
 *
 * The editor runs in two places: the local dev server, where maps are files on
 * disk and textures come from tiles/extracted/, and inside the game page on
 * coolmathgames.com as a userscript, where maps live in localStorage and the
 * textures are rebuilt from the player's own copy of the artwork. Those differ
 * only in where the bytes come from, so everything environment-specific sits
 * behind one `io` object and there is exactly one copy of the editor itself.
 *
 *   MapEditor.mount({ root, io })  ->  { open, close, isOpen, destroy }
 *
 * io:
 *   listMaps()                 -> [{ id, name, modified }]
 *   loadMap(id)                -> a map file, in the game's format
 *   saveMap(id, { map, thumb })-> { ok, id }
 *   vanillaMap()               -> the stock level, as a starting point (optional)
 *   tiles()                    -> [{ name, w, h }]
 *   tileImage(name)            -> Image or Canvas, drawable once ready
 *   play(id)                   -> run the map (optional; Play hides without it)
 *   exit()                     -> leave the editor (optional; Close hides)
 *   storageKey                 -> localStorage namespace for session state
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MapEditor = factory();
}(typeof self !== 'undefined' ? self : this, function () {
'use strict';

// ---------------------------------------------------------------- object kinds
/*
 * One definition per kind drives the tool palette, drawing, the properties panel
 * and serialisation. Adding an entity type should mean adding an entry here, not
 * touching the interaction code.
 *
 *   shape 'rect'  drag to create, resizable
 *   shape 'point' click to create, fixed icon size
 *   shape 'beam'  a laser: a centred bar with a length and an orientation
 *   single: true  only one may exist (spawn, door, boss zones)
 *   path:         has a patrol range, drawn as a track with two handles
 */
const KINDS = {
  plat: { label:'Platform', shape:'rect', color:'#8ea3c0', fill:'#2a3040', order:1,
    props:{ semi:0, stomper:0 },
    fields:{
      semi:{ type:'bool', label:'One-way',
        help:'Only the top surface collides. Johnny jumps up through it and lands on top. Drawn with a cyan dashed line along the top edge.' },
      fallTo:{ type:'number', label:'Falls to', crusher:true,
        help:'World Y where it comes to rest. Fall distance is this minus the platform y. Blank uses the vanilla -60.' },
      trigX:{ type:'number', label:'Trigger x', crusher:true,
        help:'Left edge of the band that sets it off. Blank uses x+200, which is why a narrow crusher never fires in the stock game.' },
      trigW:{ type:'number', label:'Trigger width', crusher:true,
        help:'Width of that band. Blank uses 80.' },
      trigY:{ type:'number', label:'Trigger above Y', crusher:true,
        help:'Johnny must be above this Y as well. Blank uses 360.' },
      accel:{ type:'number', label:'Acceleration', crusher:true,
        help:'Downward acceleration per frame. Blank uses 0.25.' },
      damage:{ type:'number', label:'Damage', crusher:true,
        help:'Contact damage. Blank uses 10.' },
      repeat:{ type:'bool', label:'Resets', crusher:true,
        help:'Return to the start and arm again after landing. Off matches the stock game, which fires once.' },
      resetIn:{ type:'number', label:'Reset delay', crusher:true,
        help:'Frames to wait before returning, when Resets is on. Blank uses 90.' },
      stomper:{ type:'bool', label:'Crusher',
        help:'Falls when Johnny walks under it. The stock game hardcodes all of this - one crusher per map, firing once, dropping to world y = -60, triggered by an 80px band at x+200 that a crusher narrower than 200px can never reach. The runtime replaces that routine, so use as many as you like and set Falls to / Trigger / Resets below; leave a field blank to get the stock value.' },
    } },
  art: { label:'Texture', shape:'rect', color:'#c9a6ff', order:2,
    props:{ tile:'', rot:0, flipX:0, flipY:0, z:0 },
    fields:{
      tile:{ type:'text', label:'Tile', help:'Which extracted texture to draw.' },
      rot:{ type:'number', label:'Rotation', help:'Degrees, clockwise. r rotates 90 at a time.' },
      flipX:{ type:'bool', label:'Mirror X', help:'Flip horizontally (key x).' },
      flipY:{ type:'bool', label:'Mirror Y', help:'Flip vertically (key y).' },
      z:{ type:'number', label:'Z order', help:'Higher draws in front. Keys [ and ].' },
    } },
  spike: { label:'Spike', shape:'rect', color:'#e07a7a', fill:'#3a2027', order:3 },
  coin: { label:'Coin', shape:'point', color:'#e8c46a', order:4, size:24 },
  ene: { label:'Enemy', shape:'point', color:'#ff9d5c', order:5, size:40,
    props:{ typ:'robot', xx:4.8, yy:0 }, path:true,
    fields:{
      typ:{ type:'select', options:['robot','saw'], label:'Type',
        help:'robot: killable, and an Archipelago check. saw: hazard only, cannot be killed.' },
      xx:{ type:'number', label:'Speed X', help:'Horizontal patrol speed in px per frame. 0 to stay put.' },
      yy:{ type:'number', label:'Speed Y', help:'Vertical patrol speed. Vanilla enemies use 0.' },
    } },
  bomb: { label:'Bomb', shape:'point', color:'#ff7ad9', order:6, size:36,
    props:{ xxsi:-0.02, yysi:0.04, xmax:100, ymax:120 },
    fields:{
      xxsi:{ type:'number', label:'Drift rate X', help:'How fast it sweeps horizontally. It drifts on a sine wave rather than patrolling.' },
      yysi:{ type:'number', label:'Drift rate Y', help:'How fast it sweeps vertically.' },
      xmax:{ type:'number', label:'Drift width', help:'How far either side of its position it travels.' },
      ymax:{ type:'number', label:'Drift height', help:'How far above and below it travels.' },
    } },
  /*
   * A laser is a beam, not a point.
   *
   * The game creates one as a sprite anchored at its centre with a 40x180
   * collision box, then force-rotates the FIRST laser to a horizontal 590px beam
   * whatever the map says. mapkit unpins that per laser, so length and
   * orientation are genuine map data -- and since they are, they belong on the
   * canvas as a draggable beam rather than as two numbers in a panel.
   */
  laser: { label:'Laser', shape:'beam', color:'#7ae0ff', order:7, size:28,
    props:{ ctMax:100, ctSwitch:60, ctCurr:0, length:180, horizontal:0 },
    fields:{
      ctMax:{ type:'number', label:'Cycle length', help:'Frames in one on/off cycle.' },
      ctSwitch:{ type:'number', label:'Fires at', help:'Point in the cycle the beam turns on.' },
      ctCurr:{ type:'number', label:'Start phase', help:'Where in the cycle it begins. Stagger this across lasers so they do not all fire together.' },
      length:{ type:'number', label:'Beam length',
        help:'How long the beam is, centred on the emitter. Drag either end on the canvas. The stock game used 180 upright and 590 laid flat.' },
      horizontal:{ type:'bool', label:'Horizontal',
        help:'Lay the beam across instead of upright. Dragging an end past the diagonal flips this for you.' },
    } },
  platMove: { label:'Moving plat', shape:'point', color:'#64d19a', order:8, size:40,
    props:{ xx:3, yy:0 }, path:true,
    fields:{
      xx:{ type:'number', label:'Speed X', help:'Horizontal speed in px per frame. 0 for a vertical-only lift.' },
      yy:{ type:'number', label:'Speed Y', help:'Vertical speed. 0 for a horizontal-only tram.' },
    } },
  area: { label:'Camera area', shape:'rect', color:'#5c7fff', order:9,
    props:{ xx:320, yy:300, xmin:0, xmax:0, ymin:0, ymax:0 },
    note:'Entering this region changes how the camera follows Johnny, and the setting STICKS until he enters another area. Cover the map fairly continuously or the camera keeps an old offset. The violet box is the clamp: drag its handles, and drag a side onto the area edge to switch that clamp off.',
    fields:{
      xx:{ type:'number', label:'Offset X', help:'How far left of Johnny the camera sits (multiplied by 1.25). Bigger shows more of what is ahead.' },
      yy:{ type:'number', label:'Offset Y', help:'Vertical framing offset, same scaling.' },
      xmin:{ type:'number', label:'Clamp left', help:'Camera cannot scroll left of this. 0 means no clamp, not a clamp at zero.' },
      xmax:{ type:'number', label:'Clamp right', help:'Camera cannot scroll right of this. 0 means no clamp.' },
      ymin:{ type:'number', label:'Clamp top', help:'Camera cannot scroll above this. 0 means no clamp.' },
      ymax:{ type:'number', label:'Clamp bottom', help:'Camera cannot scroll below this. 0 means no clamp.' },
    } },
  door: { label:'Door', shape:'rect', color:'#b6ff5c', order:10,
    props:{ trigger:'start' },
    note:'Slides shut to block a route. Place as many as you like. The stock game only had one, always closing at level start and always stopping at y=1810.',
    fields:{
      trigger:{ type:'select', options:['start','zone','boss','never'], label:'Closes on',
        help:'start: immediately, as in the stock game. zone: when Johnny enters the trigger box. boss: when the boss fight begins. never: stays put.' },
      closeTo:{ type:'number', label:'Slides to', door:true,
        help:'World Y it stops at. Blank slides down by its own height.' },
      speed:{ type:'number', label:'Speed', door:true,
        help:'Pixels per frame. Blank uses 1, which is the stock crawl.' },
      open:{ type:'bool', label:'Opens instead', door:true,
        help:'Start shut and slide the other way when triggered.' },
      zx:{ type:'number', label:'Zone x', zone:true, help:'Trigger box, used when Closes on is zone.' },
      zy:{ type:'number', label:'Zone y', zone:true, help:' ' },
      zw:{ type:'number', label:'Zone w', zone:true, help:' ' },
      zh:{ type:'number', label:'Zone h', zone:true, help:' ' },
    } },
  bossGate: { label:'Boss gate', shape:'rect', color:'#ffd25c', order:11, single:true,
    note:'The trigger that starts the boss fight.' },
  bossRange: { label:'Boss arena', shape:'rect', color:'#ff5c5c', order:12, single:true,
    note:'Where the boss moves. Vanilla pins the boss rise to absolute Y (1810/2040/2400), so moving this needs those constants patched.' },
  sprt: { label:'Spawn', shape:'point', color:'#ffffff', order:13, size:48,
    single:true, props:{ xx:1 },
    fields:{ xx:{ type:'select', options:[1,-1], label:'Facing', help:'1 faces right, -1 faces left.' } } },
  colGun: { label:'Gun pickup', shape:'point', color:'#5cffd2', order:14, size:36, single:true,
    note:'Walking into this sends the Find the Gun check. Being armed comes from the Laser Gun item, not from this pickup.' },
};

/*
 * Patrol ranges.
 *
 * The game stores a mover as a position plus xmin/xmax and ymin/ymax bounds, and
 * oscillates each axis between them independently. Two draggable handles at the
 * opposite corners of that box express both axes at once, which is easier to
 * reason about than four numbers -- and a wrong patrol range is the classic way
 * to make a map that looks right and plays wrong.
 */
const PATH_FIELDS = ['xmin', 'ymin', 'xmax', 'ymax'];

// the game's own laser geometry: 40 across, 180 upright, 590 laid flat
const LASER_THICK = 40;
const LASER_LEN_V = 180;
const LASER_LEN_H = 590;

// ---------------------------------------------------------------- markup
const CSS = `
#mde-root { --bg:#14161c; --panel:#1c1f28; --line:#2c3040; --text:#dde1ea; --dim:#8b93a7;
  --accent:#6ea8fe; --good:#64d19a; --warn:#e8c46a; --bad:#e07a7a;
  background:var(--bg); color:var(--text); overflow:hidden;
  font:13px/1.45 ui-sans-serif,system-ui,sans-serif;
  display:grid; grid-template-columns:200px 1fr 250px; grid-template-rows:42px 1fr;
  width:100%; height:100%; }
#mde-root * { box-sizing:border-box; }
#mde-top { grid-column:1/4; background:var(--panel); border-bottom:1px solid var(--line);
  display:flex; align-items:center; gap:10px; padding:0 12px; min-width:0; }
#mde-top .mde-sp { flex:1; }
#mde-root input[type=text], #mde-root select { background:#12141a; border:1px solid var(--line);
  color:var(--text); border-radius:5px; padding:4px 7px; font:inherit; font-size:12px; }
#mde-root button { background:#262b38; border:1px solid var(--line); color:var(--text);
  border-radius:6px; padding:5px 10px; font:inherit; font-size:11px; cursor:pointer; }
#mde-root button:hover { background:#303748; }
#mde-root button.on { background:var(--accent); border-color:var(--accent); color:#0d1017; font-weight:600; }
#mde-root button.primary { background:var(--accent); border-color:var(--accent); color:#0d1017; font-weight:600; }
#mde-root aside { background:var(--panel); overflow-y:auto; min-height:0; }
#mde-left { border-right:1px solid var(--line); }
#mde-right { border-left:1px solid var(--line); }
#mde-root .sec { padding:9px 11px; border-bottom:1px solid var(--line); }
#mde-root .sec h2 { font-size:10px; text-transform:uppercase; letter-spacing:.07em; color:var(--dim);
  margin:0 0 7px; font-weight:600; }
#mde-root .tools { display:grid; grid-template-columns:1fr 1fr; gap:5px; }
#mde-root .tools button { text-align:left; padding:5px 7px; }
#mde-palette { display:grid; grid-template-columns:1fr 1fr; gap:5px; }
#mde-root .tile { background:#12141a; border:1px solid var(--line); border-radius:5px; cursor:pointer;
  padding:3px; display:grid; gap:3px; justify-items:center; }
#mde-root .tile:hover { border-color:var(--accent); }
#mde-root .tile.sel { border-color:var(--accent); background:#2b3346; }
#mde-root .tile canvas { display:block; image-rendering:pixelated; }
#mde-root .tile span { font-size:9px; color:var(--dim); max-width:78px; overflow:hidden;
  text-overflow:ellipsis; white-space:nowrap; }
#mde-stage { position:relative; overflow:hidden; background:#0d0f14; min-width:0; }
#mde-cv { position:absolute; top:0; left:0; }
/*
 * The coordinate readout. Bottom left, always on, and deliberately larger and
 * monospaced than the rest of the chrome: it is read while the mouse is moving,
 * which is exactly when small proportional digits are hardest to catch.
 */
#mde-hud { position:absolute; left:10px; bottom:10px; background:#12141aeb; border:1px solid var(--line);
  border-radius:6px; padding:6px 10px; font-size:11px; color:var(--dim); pointer-events:none;
  display:flex; gap:12px; align-items:baseline; }
#mde-hud .co { font:600 15px/1.1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  color:var(--text); font-variant-numeric:tabular-nums; }
#mde-hud .co .ax { color:var(--dim); font-weight:400; font-size:11px; }
#mde-hud .sn { font:11px/1.1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; color:var(--accent); }
#mde-hint { position:absolute; right:10px; bottom:10px; background:#12141ad9; border:1px solid var(--line);
  border-radius:6px; padding:6px 9px; font-size:11px; color:var(--dim); max-width:290px; }
#mde-root kbd { background:#262b38; border:1px solid var(--line); border-bottom-width:2px; border-radius:3px;
  padding:0 3px; font-size:10px; }
#mde-root .row2 { display:grid; grid-template-columns:70px 1fr; gap:6px; align-items:center;
  color:var(--dim); font-size:11px; margin-bottom:5px; }
#mde-root .row2 input { width:100%; background:#12141a; border:1px solid var(--line); color:var(--text);
  border-radius:4px; padding:3px 5px; font:inherit; font-size:11px; }
#mde-objs { max-height:230px; overflow-y:auto; }
#mde-root .obj { padding:4px 8px; font-size:11px; cursor:pointer; display:flex; gap:6px; align-items:center;
  border-radius:4px; }
#mde-root .obj:hover { background:#232733; }
#mde-root .obj.sel { background:#2b3346; }
#mde-root .swatch { width:8px; height:8px; border-radius:2px; flex:none; }
#mde-root .muted { color:var(--dim); font-size:10px; }
#mde-root .field { margin-bottom:8px; }
#mde-root .help { color:#6f7688; font-size:10px; line-height:1.35; margin:1px 0 0 76px; }
#mde-root .note { color:var(--warn); font-size:10px; line-height:1.4; background:#2a2519;
  border:1px solid #3d3520; border-radius:5px; padding:6px 7px; margin:0 0 9px; }
`;

const HTML = `
<div id="mde-top">
  <strong style="font-size:13px">Map Editor</strong>
  <input type="text" id="mde-mapName" placeholder="map name" style="width:170px">
  <select id="mde-mapList"><option value="">&mdash; open map &mdash;</option></select>
  <button id="mde-newMap">new</button>
  <button id="mde-fromVanilla">start from vanilla</button>
  <span class="mde-sp"></span>
  <span class="muted">grid</span>
  <select id="mde-grid">
    <option value="0" selected>free</option>
    <option value="10">10</option>
    <option value="25">25</option>
    <option value="50">50</option>
    <option value="100">100</option>
  </select>
  <button id="mde-artTop" class="on">textures on top</button>
  <button id="mde-fit">fit</button>
  <button id="mde-save">save</button>
  <button id="mde-export">export</button>
  <button id="mde-play" class="primary">play</button>
  <button id="mde-exit">close</button>
</div>

<aside id="mde-left">
  <div class="sec">
    <h2>Tools</h2>
    <div class="tools" id="mde-tools"></div>
  </div>
  <div class="sec">
    <h2>Textures</h2>
    <div id="mde-palette"></div>
  </div>
</aside>

<div id="mde-stage">
  <canvas id="mde-cv"></canvas>
  <div id="mde-hud"></div>
  <div id="mde-hint">
    <div><kbd>ctrl+click</kbd> pick object + its settings</div>
    <div><kbd>ctrl+click</kbd> blank = back to select tool</div>
    <div><kbd>alt+click</kbd> add / remove from selection</div>
    <div><kbd>drag</kbd> marquee select</div>
    <div><kbd>corner</kbd> resize &middot; <kbd>space+drag</kbd> pan</div>
    <div>many selected: box resizes &amp; rotates as one</div>
    <div>green handles = door trigger zone</div>
    <div><kbd>ctrl+z</kbd> undo &middot; <kbd>ctrl+shift+z</kbd> redo</div>
    <div><kbd>ctrl+c</kbd>/<kbd>ctrl+v</kbd> copy &middot; paste lands at cursor</div>
    <div><kbd>del</kbd> delete &middot; <kbd>ctrl+d</kbd> duplicate &middot; <kbd>esc</kbd> select tool</div>
    <div><kbd>[</kbd> <kbd>]</kbd> send back / bring forward (any object)</div>
    <div><kbd>x</kbd>/<kbd>y</kbd> mirror &middot; <kbd>r</kbd> rotate 90&deg;</div>
  </div>
</div>

<aside id="mde-right">
  <div class="sec">
    <h2>Properties</h2>
    <div id="mde-props"><span class="muted">nothing selected</span></div>
  </div>
  <div class="sec">
    <h2>Objects</h2>
    <div id="mde-objs"></div>
  </div>
</aside>
`;

// ---------------------------------------------------------------- state
let root = null, io = null, active = false, booted = false;
let map = blankMap();
let sel = [];                 // selected object ids
let tool = 'select';
let selTile = null;
let view = { x: 0, y: 0, z: 0.35 };
let grid = 0;   // free by default; per-map preference is restored on open
let nextId = 1;
let tileImgs = new Map();
let tileList = [], tileNodes = new Map();
let artStyle = { rot:0, flipX:0, flipY:0 };
let undoStack = [], redoStack = [], clipboard = [];  // reassigned when a session is restored
let lastWorld = { x:0, y:0 };
let dragging = null, spaceDown = false;
let artOnTop = true;
let rafId = null;
const listeners = [];   // [target, type, fn, opts], for destroy()

const $ = (id) => root.querySelector('#mde-' + id);
const stageEl = () => $('stage');

function blankMap() {
  return { meta:{ id:'', name:'Untitled' }, objects:[], yEnd:3000 };
}

/*
 * Undo by snapshot.
 *
 * The object model is a flat array of plain objects, so a JSON snapshot is both
 * cheap and exactly right -- no need to model each action as a reversible edit,
 * which is where hand-rolled undo usually goes wrong. The vanilla map is ~300
 * objects, so a snapshot is tens of kilobytes and the stack is capped anyway.
 *
 * pushHistory() is called BEFORE a change, so the stack holds the state to go
 * back to. Any new edit clears the redo stack, as it should.
 */
const HISTORY_MAX = 120;
// writing to storage on every keystroke of a drag would be wasteful, so coalesce
let persistTimer = null;
const schedulePersist = () => {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persistState, 400);
};
const snapshot = () => JSON.stringify({ objects: map.objects, nextId });
function pushHistory() {
  undoStack.push(snapshot());
  schedulePersist();
  if (undoStack.length > HISTORY_MAX) undoStack.shift();
  redoStack.length = 0;
}

/*
 * Lazy history, for drags.
 *
 * A mousedown that selects something also arms a move, but most of those are
 * just clicks -- committing history there would fill the stack with entries that
 * undo to an identical map, so ctrl+Z would appear to do nothing several times
 * before it did anything. Arm on mousedown, commit only once the drag actually
 * moves something.
 */
let pendingHistory = null;
const armHistory = () => { pendingHistory = snapshot(); };
function commitHistory() {
  if (pendingHistory === null) return;
  undoStack.push(pendingHistory);
  schedulePersist();
  if (undoStack.length > HISTORY_MAX) undoStack.shift();
  redoStack.length = 0;
  pendingHistory = null;
}
function restore(str) {
  const d = JSON.parse(str);
  map.objects = d.objects; nextId = d.nextId;
  sel = sel.filter((id) => map.objects.some((o) => o.id === id));
  refresh();
}
function undo() {
  if (!undoStack.length) return;
  redoStack.push(snapshot());
  restore(undoStack.pop());
}
function redo() {
  if (!redoStack.length) return;
  undoStack.push(snapshot());
  restore(redoStack.pop());
}

function copySel() {
  clipboard = selected().map((o) => JSON.parse(JSON.stringify(o)));
}
/*
 * Paste lands the copied group under the cursor rather than on top of the
 * original, which is almost always what you want when duplicating a run of
 * platforms or a cluster of coins.
 */
function paste() {
  if (!clipboard.length) return;
  pushHistory();
  let x0 = Infinity, y0 = Infinity;
  for (const c of clipboard) { x0 = Math.min(x0, c.x); y0 = Math.min(y0, c.y); }
  const dx = snap(lastWorld.x) - x0, dy = snap(lastWorld.y) - y0;
  const made = clipboard.map((c) => {
    const o = JSON.parse(JSON.stringify(c));
    o.id = nextId++;
    o.x += dx; o.y += dy;
    // a patrol range travels with the thing that patrols it
    if (o.xmin !== undefined && K(o) && K(o).path) { o.xmin += dx; o.xmax += dx; o.ymin += dy; o.ymax += dy; }
    // so does a door's trigger zone and an area's camera clamp
    if (o.kind === 'door') { o.zx = (o.zx || 0) + dx; o.zy = (o.zy || 0) + dy; }
    if (o.kind === 'area') shiftClamp(o, dx, dy);
    // singletons cannot be duplicated; paste moves the existing one instead
    if (KINDS[o.kind] && KINDS[o.kind].single) {
      const ex = map.objects.find((e) => e.kind === o.kind);
      if (ex) { ex.x = o.x; ex.y = o.y; return ex; }
    }
    map.objects.push(o);
    return o;
  });
  sel = made.map((o) => o.id);
  refresh();
}

// ---------------------------------------------------------------- game format
/*
 * Conversion lives in mapkit/mapformat.js -- mapkit owns it because mapkit ships.
 * The editor writes these files and mapkit reads them, so a second copy here
 * would drift -- the same trap the two normalise paths nearly fell into.
 */
const toGame = () => MapFormat.toGame(map);
function loadGame(g) {
  const m = MapFormat.fromGame(g, nextId);
  nextId = m.nextId;
  map = { meta: m.meta, objects: m.objects, yEnd: m.yEnd };
  sel = [];
}

// ---------------------------------------------------------------- helpers
const K = (o) => KINDS[o.kind];
const byId = (id) => map.objects.find((o) => o.id === id);
const selected = () => sel.map(byId).filter(Boolean);
const snap = (v) => grid ? Math.round(v / grid) * grid : Math.round(v);
const toWorld = (sx, sy) => ({ x:(sx - view.x) / view.z, y:(sy - view.y) / view.z });

/*
 * Pointer position in stage pixels.
 *
 * NOT e.offsetX: mousemove and mouseup are bound to the window so a drag can
 * continue outside the canvas, and offsetX is then relative to whatever element
 * the pointer happens to be over -- a side panel, a button. Measuring against
 * the stage's own rect is the only thing that is correct everywhere, and it is
 * what makes the coordinate readout trustworthy while dragging off-canvas.
 */
function stagePos(e) {
  const r = stageEl().getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}
const worldOf = (e) => { const p = stagePos(e); return toWorld(p.x, p.y); };

// a laser's beam rect: centred on the emitter, 40 across, `length` along
function laserRect(o) {
  const len = Math.max(8, Number(o.length) || (o.horizontal ? LASER_LEN_H : LASER_LEN_V));
  return o.horizontal
    ? { x:o.x - len/2, y:o.y - LASER_THICK/2, w:len, h:LASER_THICK }
    : { x:o.x - LASER_THICK/2, y:o.y - len/2, w:LASER_THICK, h:len };
}

function bounds(o) {
  const k = K(o);
  if (!k) return { x:o.x, y:o.y, w:o.w || 0, h:o.h || 0 };
  if (k.shape === 'beam') return laserRect(o);
  if (k.shape === 'point') { const s = k.size || 32; return { x:o.x - s/2, y:o.y - s/2, w:s, h:s }; }
  return { x:o.x, y:o.y, w:o.w, h:o.h };
}
function hit(o, wx, wy) {
  const b = bounds(o);
  return wx >= b.x && wx <= b.x + b.w && wy >= b.y && wy <= b.y + b.h;
}
const isReady = (im) => !!im && (im.tagName === 'CANVAS' ? im.width > 0 : im.complete && im.naturalWidth > 0);
const imgW = (im) => (im.naturalWidth || im.width || 0);
const imgH = (im) => (im.naturalHeight || im.height || 0);

/*
 * Camera clamps.
 *
 * An area carries four clamp values, and ZERO MEANS NO CLAMP -- the game
 * truthiness-tests them, so a clamp genuinely at zero is not expressible and
 * never was. That is impossible to see in four number fields, and a wrong clamp
 * only shows up as a camera that will not follow, several minutes into playing.
 *
 * So the clamp is drawn as a box alongside the area it belongs to: solid on the
 * sides that are clamped, ghosted along the area's own edge on the sides that
 * are not. Dragging a ghosted side turns that clamp on; dragging one back onto
 * the area edge snaps it off again, which is the only gesture that can express
 * "no clamp" without typing a zero.
 */
function clampBox(o) {
  const b = bounds(o);
  return {
    x0: o.xmin || b.x, x1: o.xmax || (b.x + b.w),
    y0: o.ymin || b.y, y1: o.ymax || (b.y + b.h),
    aL: !!o.xmin, aR: !!o.xmax, aT: !!o.ymin, aB: !!o.ymax,
  };
}
function shiftClamp(o, dx, dy) {
  if (o.xmin) o.xmin += dx;
  if (o.xmax) o.xmax += dx;
  if (o.ymin) o.ymin += dy;
  if (o.ymax) o.ymax += dy;
}
// clamps live in a kind that also uses xmin/xmax for patrol ranges, so both
// tests are on the kind rather than on the presence of the fields
const hasClamp = (o) => o && o.kind === 'area';
const hasZone = (o) => o && o.kind === 'door' && o.trigger === 'zone';

// ---------------------------------------------------------------- rendering
const HANDLE = 8;
const HSPOTS = [['nw',0,0],['n',.5,0],['ne',1,0],['w',0,.5],['e',1,.5],['sw',0,1],['s',.5,1],['se',1,1]];
function handlePts(o) {
  const b = bounds(o);
  return HSPOTS.map(([id,fx,fy]) => ({ id, x:b.x + b.w*fx, y:b.y + b.h*fy }));
}
/*
 * A door's trigger zone is a second rectangle attached to the object, so it
 * gets its own handles: eight to resize and one in the middle to move the whole
 * box. Typing four numbers to position a trigger is the kind of thing that gets
 * left wrong, and a wrong trigger box is invisible until you play the level.
 *
 * Ids are prefixed 'z' so the drag code can tell them from the object's own
 * resize handles. Clamp handles use 'q' and beam ends use 'b' for the same
 * reason.
 */
function zoneRect(o) {
  return { x: o.zx || 0, y: o.zy || 0, w: o.zw || 0, h: o.zh || 0 };
}
function zonePts(o) {
  if (!hasZone(o)) return [];
  const z = zoneRect(o);
  if (z.w <= 0 || z.h <= 0) return [];
  const pts = HSPOTS.map(([id, fx, fy]) => ({ id: 'z' + id, x: z.x + z.w * fx, y: z.y + z.h * fy }));
  pts.push({ id: 'zmove', x: z.x + z.w / 2, y: z.y + z.h / 2 });
  return pts;
}
/*
 * Clamp handles sit INSIDE the box on any side that has no clamp set.
 *
 * With all four clamps off the clamp box is exactly the area's own rect, so its
 * handles would land on top of the area's resize handles and one of the two
 * would be unreachable -- and since an unclamped area is the starting state,
 * that is the case that has to work. Pulling the unset ones in by a few screen
 * pixels separates them and reads correctly too: a handle floating inside the
 * area is one that has not been placed yet.
 */
const CLAMP_INSET = 13;
function clampPts(o) {
  if (!hasClamp(o)) return [];
  const c = clampBox(o);
  const w = c.x1 - c.x0, h = c.y1 - c.y0;
  const d = CLAMP_INSET / view.z;
  const pts = HSPOTS.map(([id, fx, fy]) => {
    let x = c.x0 + w * fx, y = c.y0 + h * fy;
    if (id.includes('w') && !c.aL) x += d;
    if (id.includes('e') && !c.aR) x -= d;
    if (id.includes('n') && !c.aT) y += d;
    if (id.includes('s') && !c.aB) y -= d;
    return { id: 'q' + id, x, y };
  });
  pts.push({ id: 'qmove', x: c.x0 + w / 2, y: c.y0 + h / 2 });
  return pts;
}
// the two ends of a laser beam
function beamPts(o) {
  if (!K(o) || K(o).shape !== 'beam') return [];
  const r = laserRect(o);
  return o.horizontal
    ? [{ id:'b0', x:r.x, y:o.y }, { id:'b1', x:r.x + r.w, y:o.y }]
    : [{ id:'b0', x:o.x, y:r.y }, { id:'b1', x:o.x, y:r.y + r.h }];
}
function pathPts(o) {
  if (!K(o) || !K(o).path) return [];
  return [{ id:'p0', x:o.xmin ?? o.x, y:o.ymin ?? o.y },
          { id:'p1', x:o.xmax ?? o.x, y:o.ymax ?? o.y }];
}

// Resize or move the trigger zone. Mirrors resize() but writes zx/zy/zw/zh.
function resizeZone(o, id, mx, my) {
  const z = zoneRect(o);
  if (id === 'zmove') {
    o.zx = snap(mx - z.w / 2);
    o.zy = snap(my - z.h / 2);
    refreshProps();
    return;
  }
  const side = id.slice(1);
  const right = z.x + z.w, bottom = z.y + z.h;
  let x = z.x, y = z.y, w = z.w, h = z.h;
  if (side.includes('w')) { x = Math.min(snap(mx), right - 8); w = right - x; }
  if (side.includes('e')) { w = Math.max(8, snap(mx) - x); }
  if (side.includes('n')) { y = Math.min(snap(my), bottom - 8); h = bottom - y; }
  if (side.includes('s')) { h = Math.max(8, snap(my) - y); }
  o.zx = x; o.zy = y; o.zw = w; o.zh = h;
  refreshProps();
}

/*
 * Drag a camera clamp.
 *
 * Writing 0 is how a clamp is switched off, so a side dragged back onto the
 * area's own edge (within a few pixels) is read as "no clamp on this side"
 * rather than as a clamp that happens to sit there. Everything else writes the
 * dragged coordinate straight in.
 */
const CLAMP_OFF_SNAP = 6;
function resizeClamp(o, id, mx, my) {
  const b = bounds(o);
  const c = clampBox(o);
  if (id === 'qmove') {
    shiftClamp(o, snap(mx - (c.x0 + c.x1) / 2), snap(my - (c.y0 + c.y1) / 2));
    refreshProps();
    return;
  }
  const side = id.slice(1);
  const put = (field, value, edge) => {
    o[field] = Math.abs(value - edge) <= CLAMP_OFF_SNAP / view.z ? 0 : value;
  };
  if (side.includes('w')) put('xmin', Math.min(snap(mx), c.x1 - 8), b.x);
  if (side.includes('e')) put('xmax', Math.max(snap(mx), c.x0 + 8), b.x + b.w);
  if (side.includes('n')) put('ymin', Math.min(snap(my), c.y1 - 8), b.y);
  if (side.includes('s')) put('ymax', Math.max(snap(my), c.y0 + 8), b.y + b.h);
  refreshProps();
}

/*
 * Drag one end of a laser beam.
 *
 * Length and orientation at once: the emitter stays where it is, the dragged end
 * sets the half-length, and whichever axis the pointer is further along decides
 * whether the beam stands up or lies flat. Same gesture as a patrol handle, and
 * for the same reason -- two numbers in a panel do not tell you what the hazard
 * actually covers.
 */
function dragBeam(o, mx, my) {
  const dx = mx - o.x, dy = my - o.y;
  o.horizontal = Math.abs(dx) >= Math.abs(dy) ? 1 : 0;
  const half = Math.abs(o.horizontal ? dx : dy);
  o.length = Math.max(grid || 8, snap(half * 2));
  refreshProps();
}

// ---------------------------------------------------------------- group edits
/*
 * Several objects at once.
 *
 * Handles on the union box, and every edit is computed from a snapshot taken at
 * mousedown rather than applied incrementally -- rotating by dragging means
 * crossing the same quarter-turn back and forth, and anything that accumulates
 * drifts. Recomputing from the snapshot every frame is exact and undoes itself
 * for free.
 */
function groupBox(list) {
  let x0=1e9, y0=1e9, x1=-1e9, y1=-1e9;
  for (const o of list) {
    const b = bounds(o);
    x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h);
  }
  if (x0 > x1) return null;
  return { x:x0, y:y0, w:Math.max(1, x1-x0), h:Math.max(1, y1-y0) };
}
const GROUP_ROT_OFFSET = 26;   // screen px above the box
function groupPts(list) {
  const b = groupBox(list);
  if (!b) return [];
  const pts = HSPOTS.map(([id,fx,fy]) => ({ id:'g'+id, x:b.x + b.w*fx, y:b.y + b.h*fy }));
  pts.push({ id:'grot', x:b.x + b.w/2, y:b.y - GROUP_ROT_OFFSET / view.z });
  return pts;
}
const cloneObjs = (list) => list.map((o) => ({ o, src: JSON.parse(JSON.stringify(o)) }));
function restoreObjs(pairs) {
  for (const { o, src } of pairs) {
    for (const k of Object.keys(o)) if (k !== 'id' && k !== 'kind') delete o[k];
    Object.assign(o, src);
  }
}

/*
 * Scale a group about a fixed corner. Points move, rects move and stretch, and
 * the attached boxes -- patrol range, door zone, camera clamp -- come along,
 * because a patrol range left behind by a resize is a silently broken level.
 */
function scaleObj(o, sx, sy, ox, oy) {
  const px = (x) => ox + (x - ox) * sx;
  const py = (y) => oy + (y - oy) * sy;
  const k = K(o);
  if (k && k.shape === 'rect') {
    const x1 = px(o.x + o.w), y1 = py(o.y + o.h);
    o.x = px(o.x); o.y = py(o.y);
    o.w = Math.max(1, x1 - o.x); o.h = Math.max(1, y1 - o.y);
  } else {
    if (k && k.shape === 'beam') {
      o.length = Math.max(8, Math.round((Number(o.length) || LASER_LEN_V) * (o.horizontal ? sx : sy)));
    }
    o.x = px(o.x); o.y = py(o.y);
  }
  if (k && k.path && o.xmin !== undefined) {
    const nx = [px(o.xmin), px(o.xmax)], ny = [py(o.ymin), py(o.ymax)];
    o.xmin = Math.min(nx[0], nx[1]); o.xmax = Math.max(nx[0], nx[1]);
    o.ymin = Math.min(ny[0], ny[1]); o.ymax = Math.max(ny[0], ny[1]);
  }
  if (o.kind === 'door') {
    const zx1 = px((o.zx || 0) + (o.zw || 0)), zy1 = py((o.zy || 0) + (o.zh || 0));
    o.zx = px(o.zx || 0); o.zy = py(o.zy || 0);
    o.zw = Math.max(1, zx1 - o.zx); o.zh = Math.max(1, zy1 - o.zy);
    if (typeof o.closeTo === 'number') o.closeTo = py(o.closeTo);
  }
  if (o.kind === 'plat' && o.stomper) {
    if (typeof o.fallTo === 'number') o.fallTo = py(o.fallTo);
    if (typeof o.trigX === 'number') o.trigX = px(o.trigX);
    if (typeof o.trigW === 'number') o.trigW = Math.max(1, o.trigW * sx);
  }
  if (hasClamp(o)) {
    if (o.xmin) o.xmin = px(o.xmin);
    if (o.xmax) o.xmax = px(o.xmax);
    if (o.ymin) o.ymin = py(o.ymin);
    if (o.ymax) o.ymax = py(o.ymax);
  }
}

/*
 * Quarter-turn clockwise about a point. 90 degrees at a time because the map
 * format cannot express anything else: plats, spikes, areas and boss zones are
 * axis-aligned rects in the game's own data, so a free angle would have to be
 * thrown away on save. Textures DO carry an angle, so they keep their frame and
 * take the rotation on `rot` instead, which is exactly what mapkit's renderer
 * does with it.
 */
function rotate90(o, cx, cy) {
  const rp = (x, y) => ({ x: cx + cy - y, y: cy + x - cx });
  const k = K(o);
  if (o.kind === 'art') {
    const c = rp(o.x + o.w/2, o.y + o.h/2);
    o.x = c.x - o.w/2; o.y = c.y - o.h/2;
    o.rot = (((o.rot || 0) + 90) % 360 + 360) % 360;
  } else if (k && k.shape === 'rect') {
    const a = rp(o.x, o.y), b = rp(o.x + o.w, o.y + o.h);
    o.x = Math.min(a.x, b.x); o.y = Math.min(a.y, b.y);
    o.w = Math.abs(b.x - a.x); o.h = Math.abs(b.y - a.y);
  } else {
    const c = rp(o.x, o.y);
    o.x = c.x; o.y = c.y;
    if (k && k.shape === 'beam') o.horizontal = o.horizontal ? 0 : 1;
  }
  if (k && k.path && o.xmin !== undefined) {
    const a = rp(o.xmin, o.ymin), b = rp(o.xmax, o.ymax);
    o.xmin = Math.min(a.x, b.x); o.xmax = Math.max(a.x, b.x);
    o.ymin = Math.min(a.y, b.y); o.ymax = Math.max(a.y, b.y);
  }
  if (o.kind === 'door') {
    const a = rp(o.zx || 0, o.zy || 0), b = rp((o.zx || 0) + (o.zw || 0), (o.zy || 0) + (o.zh || 0));
    o.zx = Math.min(a.x, b.x); o.zy = Math.min(a.y, b.y);
    o.zw = Math.abs(b.x - a.x); o.zh = Math.abs(b.y - a.y);
  }
  if (hasClamp(o)) {
    /*
     * Under a quarter turn the horizontal clamp comes from the vertical one and
     * vice versa, so which SIDES are clamped rotates with the box. Carrying the
     * on/off flags across is the whole point -- rotating a half-clamped area and
     * getting four clamps back would invent a camera bound that was never asked
     * for.
     */
    const c = clampBox(o);
    const nx0 = cx + cy - c.y1, nx1 = cx + cy - c.y0;
    const ny0 = cy + c.x0 - cx, ny1 = cy + c.x1 - cx;
    o.xmin = c.aB ? nx0 : 0;
    o.xmax = c.aT ? nx1 : 0;
    o.ymin = c.aL ? ny0 : 0;
    o.ymax = c.aR ? ny1 : 0;
  }
}

/*
 * Rotate a whole selection, keeping it on the grid.
 *
 * Rotating about the union centre can land the group between grid lines even
 * when every object started on one, so the group is nudged back afterwards --
 * as a group, by one shared offset, so nothing inside it shifts relative to
 * anything else.
 */
function rotateSelection(list, quarters) {
  const b = groupBox(list);
  if (!b) return;
  const cx = b.x + b.w/2, cy = b.y + b.h/2;
  const turns = ((quarters % 4) + 4) % 4;
  for (let i = 0; i < turns; i++) for (const o of list) rotate90(o, cx, cy);
  if (!grid || !turns) return;
  const nb = groupBox(list);
  const dx = snap(nb.x) - nb.x, dy = snap(nb.y) - nb.y;
  if (dx || dy) moveObjects(list, dx, dy);
}

// one shared translation, applied to positions and to every attached box
function moveObjects(list, dx, dy) {
  for (const o of list) {
    o.x += dx; o.y += dy;
    const k = K(o);
    if (k && k.path && o.xmin !== undefined) {
      o.xmin += dx; o.xmax += dx; o.ymin += dy; o.ymax += dy;
    }
    if (o.kind === 'door') {
      o.zx = (o.zx || 0) + dx; o.zy = (o.zy || 0) + dy;
      if (typeof o.closeTo === 'number') o.closeTo += dy;
    }
    if (o.kind === 'plat' && o.stomper) {
      if (typeof o.fallTo === 'number') o.fallTo += dy;
      if (typeof o.trigX === 'number') o.trigX += dx;
    }
    if (hasClamp(o)) shiftClamp(o, dx, dy);
  }
}

// ---------------------------------------------------------------- draw
/*
 * Draw order.
 *
 * Textures sit on top of everything else by default. Every other kind is drawn
 * as an outline or a marker -- editor scaffolding rather than anything the player
 * sees -- so letting those paint over the art hides the one layer that shows what
 * the map will actually look like. Selection highlights are still drawn last, so
 * whatever is selected stays visible through the art.
 *
 * The toggle drops textures back among the geometry, for when the scaffolding
 * underneath is what needs looking at.
 */
function drawRank(o) {
  if (o.kind === 'art') return artOnTop ? 1000 : 2;
  return K(o) ? K(o).order : 99;
}

/*
 * Draw order, and therefore pick order.
 *
 * z comes first so anything can be pushed behind anything else regardless of
 * kind; kind rank only breaks ties, which keeps the defaults (platforms behind,
 * textures in front) intact while every object still has z = 0.
 *
 * On non-texture objects z is purely an editing aid -- it is how you shove a big
 * platform out of the way to reach a coin underneath -- so it is NOT saved. Only
 * a texture's z means anything at runtime, and that one does persist.
 */
function drawOrder() {
  return map.objects.slice().sort((a, b) => {
    const dz = (a.z || 0) - (b.z || 0);
    if (dz !== 0) return dz;
    return drawRank(a) - drawRank(b);
  });
}

let ctx = null;
function draw() {
  rafId = requestAnimationFrame(draw);
  if (!active) return;
  const stage = stageEl(), cv = $('cv');
  const W = stage.clientWidth, H = stage.clientHeight;
  if (!W || !H) return;
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  ctx.setTransform(1,0,0,1,0,0);
  ctx.fillStyle = '#0d0f14'; ctx.fillRect(0,0,W,H);

  ctx.setTransform(view.z,0,0,view.z,view.x,view.y);
  drawGrid();

  const ordered = drawOrder();
  for (const o of ordered) drawObject(o);
  const s = selected();
  for (const o of s) drawSelection(o);
  if (s.length > 1) drawGroup(s);
  if (dragging && dragging.marquee) drawMarquee(dragging);
}

function drawGrid() {
  const stage = stageEl();
  if (!grid || view.z < 0.15) return;
  const W = stage.clientWidth / view.z, H = stage.clientHeight / view.z;
  const x0 = Math.floor(-view.x / view.z / grid) * grid, y0 = Math.floor(-view.y / view.z / grid) * grid;
  ctx.lineWidth = 1 / view.z;
  ctx.strokeStyle = 'rgba(120,140,190,0.10)';
  ctx.beginPath();
  for (let x = x0; x < x0 + W + grid; x += grid) { ctx.moveTo(x, y0); ctx.lineTo(x, y0 + H + grid); }
  for (let y = y0; y < y0 + H + grid; y += grid) { ctx.moveTo(x0, y); ctx.lineTo(x0 + W + grid, y); }
  ctx.stroke();
  // world origin
  ctx.strokeStyle = 'rgba(255,90,90,0.5)';
  ctx.beginPath(); ctx.moveTo(0, y0); ctx.lineTo(0, y0+H+grid);
  ctx.moveTo(x0, 0); ctx.lineTo(x0+W+grid, 0); ctx.stroke();
}

function drawObject(o) {
  const k = K(o); if (!k) return;
  const b = bounds(o);
  if (o.kind === 'art') return drawArt(o);
  if (k.shape === 'beam') return drawBeam(o, k);

  ctx.lineWidth = 1.5 / view.z;
  if (k.shape === 'rect') {
    if (k.fill) { ctx.fillStyle = k.fill; ctx.fillRect(b.x, b.y, b.w, b.h); }
    ctx.strokeStyle = k.color;
    ctx.strokeRect(b.x, b.y, b.w, b.h);
    if (o.kind === 'plat' && o.semi) {
      // One-way platform. The cyan edge marks the only surface that collides;
      // the chevrons point the way Johnny can pass through it.
      ctx.strokeStyle = '#7ae0ff';
      ctx.lineWidth = 3 / view.z;
      ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(b.x+b.w, b.y); ctx.stroke();
      ctx.lineWidth = 1.5 / view.z;
      const step = Math.max(30, b.w / 8), a = 7 / view.z;
      ctx.beginPath();
      for (let cx = b.x + step/2; cx < b.x + b.w; cx += step) {
        ctx.moveTo(cx - a, b.y + a*1.6); ctx.lineTo(cx, b.y + a*0.4); ctx.lineTo(cx + a, b.y + a*1.6);
      }
      ctx.stroke();
    }
  } else {
    ctx.strokeStyle = k.color;
    ctx.fillStyle = k.color + '33';
    ctx.beginPath(); ctx.arc(o.x, o.y, (k.size||32)/2, 0, Math.PI*2);
    ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(o.x-4/view.z, o.y); ctx.lineTo(o.x+4/view.z, o.y);
    ctx.moveTo(o.x, o.y-4/view.z); ctx.lineTo(o.x, o.y+4/view.z); ctx.stroke();
  }
  if (k.path) drawPath(o, k);
  if (o.kind === 'plat' && o.stomper) drawCrusher(o);
  if (o.kind === 'door') drawDoor(o);
  if (o.kind === 'area') drawClamp(o);
}

/*
 * A laser, drawn at the size it actually hurts at: the beam rect is the game's
 * own collision box, 40 across by `length` along. The emitter is marked at the
 * centre because that is the point the map stores and the point both ends move
 * around.
 */
function drawBeam(o, k) {
  const r = laserRect(o);
  ctx.fillStyle = k.color + '22';
  ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.strokeStyle = k.color;
  ctx.lineWidth = 1.5 / view.z;
  ctx.strokeRect(r.x, r.y, r.w, r.h);
  // centre line, so a long beam still reads as a beam when zoomed out
  ctx.beginPath();
  if (o.horizontal) { ctx.moveTo(r.x, o.y); ctx.lineTo(r.x + r.w, o.y); }
  else { ctx.moveTo(o.x, r.y); ctx.lineTo(o.x, r.y + r.h); }
  ctx.stroke();
  ctx.fillStyle = k.color;
  ctx.beginPath(); ctx.arc(o.x, o.y, Math.max(4, (k.size||28)/4) / 1, 0, Math.PI*2); ctx.fill();
}

/*
 * The camera clamp box. Solid where a clamp is set, ghosted where it is not --
 * a ghosted side sits on the area's own edge and means the camera is free that
 * way, which is what a 0 in the map data means.
 */
function drawClamp(o) {
  const c = clampBox(o);
  const w = c.x1 - c.x0, h = c.y1 - c.y0;
  ctx.lineWidth = 1.5 / view.z;
  ctx.fillStyle = 'rgba(150,120,255,0.05)';
  ctx.fillRect(c.x0, c.y0, w, h);
  const side = (x1, y1, x2, y2, on) => {
    ctx.strokeStyle = on ? '#a68cff' : 'rgba(166,140,255,0.30)';
    ctx.setLineDash(on ? [] : [5 / view.z, 5 / view.z]);
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    ctx.setLineDash([]);
  };
  side(c.x0, c.y0, c.x0, c.y1, c.aL);
  side(c.x1, c.y0, c.x1, c.y1, c.aR);
  side(c.x0, c.y0, c.x1, c.y0, c.aT);
  side(c.x0, c.y1, c.x1, c.y1, c.aB);
}

/*
 * A crusher hides three hardcoded numbers that decide whether it works at all,
 * so they are drawn rather than left to be discovered by playing:
 *
 *   it stops at world y = -60, so its fall distance is fixed by its own y
 *   it triggers on Johnny crossing x+200..x+280, whatever its width
 *   it also needs Johnny above y = 360
 *
 * The band not scaling with width is the trap: make one narrower than 200px and
 * the trigger sits past its right edge, so it can never fire.
 */
const CRUSHER_STOP_Y = -60;
function drawCrusher(o) {
  // mirrors the runtime defaults in mapkit/crushers.js
  const landY = (typeof o.fallTo === 'number') ? o.fallTo : CRUSHER_STOP_Y;
  ctx.lineWidth = 1.5 / view.z;

  ctx.strokeStyle = '#ff5c5c';
  ctx.setLineDash([6 / view.z, 4 / view.z]);
  ctx.strokeRect(o.x, landY, o.w, o.h);
  ctx.setLineDash([]);

  ctx.fillStyle = 'rgba(255,92,92,0.08)';
  ctx.fillRect(o.x, o.y, o.w, landY - o.y);

  const bx = (typeof o.trigX === 'number') ? o.trigX : o.x + 200;
  const bw = (typeof o.trigW === 'number') ? o.trigW : 80;
  // with configurable bands the old 'unreachable' warning only applies to the
  // default, so warn on overlap with the platform instead
  const reachable = bx + bw > o.x && bx < o.x + o.w;
  ctx.fillStyle = reachable ? 'rgba(255,210,92,0.22)' : 'rgba(255,92,92,0.30)';
  ctx.fillRect(bx, o.y, bw, Math.max(o.h, 40));
  ctx.strokeStyle = reachable ? '#ffd25c' : '#ff5c5c';
  ctx.strokeRect(bx, o.y, bw, Math.max(o.h, 40));
}

/*
 * A door hides where it ends up and what sets it off, so both are drawn.
 */
function drawDoor(o) {
  const to = (typeof o.closeTo === 'number') ? o.closeTo : o.y + o.h;
  ctx.lineWidth = 1.5 / view.z;
  ctx.strokeStyle = '#b6ff5c';
  ctx.setLineDash([6 / view.z, 4 / view.z]);
  ctx.strokeRect(o.x, to, o.w, o.h);
  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(182,255,92,0.08)';
  ctx.fillRect(o.x, Math.min(o.y, to), o.w, Math.abs(to - o.y) + o.h);
  if (o.trigger === 'zone' && o.zw > 0 && o.zh > 0) {
    ctx.fillStyle = 'rgba(182,255,92,0.13)';
    ctx.fillRect(o.zx, o.zy, o.zw, o.zh);
    ctx.strokeStyle = '#b6ff5c';
    ctx.setLineDash([4 / view.z, 3 / view.z]);
    ctx.strokeRect(o.zx, o.zy, o.zw, o.zh);
    ctx.setLineDash([]);
  }
}

/*
 * Patrol tracks. A moving platform or enemy is stored as a position plus min/max
 * bounds, which is invisible unless drawn -- and getting them wrong is the
 * easiest way to make a map that looks right and plays wrong.
 */
function drawPath(o, k) {
  const x1 = o.xmin ?? o.x, x2 = o.xmax ?? o.x;
  const y1 = o.ymin ?? o.y, y2 = o.ymax ?? o.y;
  if (x1 === x2 && y1 === y2) return;
  ctx.strokeStyle = k.color + '99';
  ctx.lineWidth = 2 / view.z;
  ctx.setLineDash([6/view.z, 5/view.z]);
  ctx.beginPath(); ctx.moveTo(x1, (y1+y2)/2); ctx.lineTo(x2, (y1+y2)/2);
  if (y1 !== y2) { ctx.moveTo((x1+x2)/2, y1); ctx.lineTo((x1+x2)/2, y2); }
  ctx.stroke(); ctx.setLineDash([]);
  const dot = (x,y) => { ctx.beginPath(); ctx.arc(x,y,5/view.z,0,Math.PI*2); ctx.fill(); };
  ctx.fillStyle = k.color;
  dot(x1,(y1+y2)/2); dot(x2,(y1+y2)/2);
}

function drawArt(o) {
  const img = tileImgs.get(o.tile);
  ctx.save();
  ctx.translate(o.x + o.w/2, o.y + o.h/2);
  if (o.rot) ctx.rotate(o.rot * Math.PI / 180);
  ctx.scale(o.flipX ? -1 : 1, o.flipY ? -1 : 1);
  if (isReady(img)) ctx.drawImage(img, -o.w/2, -o.h/2, o.w, o.h);
  else { ctx.fillStyle = '#c9a6ff33'; ctx.fillRect(-o.w/2, -o.h/2, o.w, o.h); }
  ctx.restore();
}

function drawMarquee(m) {
  const x = Math.min(m.x0, m.x1), y = Math.min(m.y0, m.y1);
  const w = Math.abs(m.x1 - m.x0), h = Math.abs(m.y1 - m.y0);
  ctx.fillStyle = 'rgba(110,168,254,0.12)';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = '#6ea8fe';
  ctx.lineWidth = 1 / view.z;
  ctx.setLineDash([4 / view.z, 3 / view.z]);
  ctx.strokeRect(x, y, w, h);
  ctx.setLineDash([]);
}

const sq = (p, size, fill, stroke) => {
  const r = size / view.z;
  ctx.fillStyle = fill; ctx.strokeStyle = stroke;
  ctx.lineWidth = 1.5 / view.z;
  ctx.beginPath(); ctx.rect(p.x - r/2, p.y - r/2, r, r); ctx.fill(); ctx.stroke();
};
const circ = (p, size, fill, stroke) => {
  const r = size / view.z;
  ctx.fillStyle = fill; ctx.strokeStyle = stroke;
  ctx.lineWidth = 2 / view.z;
  ctx.beginPath(); ctx.arc(p.x, p.y, r/2, 0, Math.PI*2); ctx.fill(); ctx.stroke();
};

function drawSelection(o) {
  const b = bounds(o);
  ctx.lineWidth = 1.5 / view.z;
  ctx.strokeStyle = '#6ea8fe';
  ctx.setLineDash([5/view.z, 4/view.z]);
  ctx.strokeRect(b.x, b.y, b.w, b.h);
  ctx.setLineDash([]);
  const one = sel.length === 1;
  // trigger-zone handles, draggable
  if (one) for (const p of zonePts(o)) {
    if (p.id === 'zmove') circ(p, HANDLE + 4, '#b6ff5c', '#b6ff5c');
    else sq(p, HANDLE, '#0d0f14', '#b6ff5c');
  }
  // camera clamp handles
  if (one) for (const p of clampPts(o)) {
    if (p.id === 'qmove') circ(p, HANDLE + 4, '#a68cff', '#a68cff');
    else sq(p, HANDLE, '#0d0f14', '#a68cff');
  }
  // laser beam ends
  if (one) for (const p of beamPts(o)) circ(p, HANDLE + 2, K(o).color, '#0d0f14');
  // patrol endpoints
  if (one) for (const p of pathPts(o)) circ(p, HANDLE + 2, K(o).color, '#0d0f14');
  if (!one || K(o).shape !== 'rect') return;
  for (const p of handlePts(o)) sq(p, HANDLE, '#0d0f14', '#6ea8fe');
}

/*
 * The group box. One frame around everything selected, with the same eight
 * resize handles a single object gets plus a rotate handle above it, so a run of
 * platforms and their coins can be scaled or turned as the one thing they are.
 */
function drawGroup(list) {
  const b = groupBox(list);
  if (!b) return;
  ctx.strokeStyle = '#ffd25c';
  ctx.lineWidth = 1.5 / view.z;
  ctx.setLineDash([9/view.z, 5/view.z]);
  ctx.strokeRect(b.x, b.y, b.w, b.h);
  ctx.setLineDash([]);
  const pts = groupPts(list);
  const rot = pts[pts.length - 1];
  ctx.strokeStyle = '#ffd25c';
  ctx.beginPath(); ctx.moveTo(b.x + b.w/2, b.y); ctx.lineTo(rot.x, rot.y); ctx.stroke();
  for (const p of pts) {
    if (p.id === 'grot') circ(p, HANDLE + 5, '#ffd25c', '#0d0f14');
    else sq(p, HANDLE + 1, '#0d0f14', '#ffd25c');
  }
}

// ---------------------------------------------------------------- interaction
const topmostAt = (wx, wy) => drawOrder().reverse().find((o) => hit(o, wx, wy));

/*
 * Which handle, if any, is under the pointer.
 *
 * Order is priority. Attached boxes -- patrol range, beam ends, trigger zone,
 * camera clamp -- come before the object's own resize handles, because they sit
 * outside or on top of its box and would otherwise be unreachable wherever the
 * two overlap. With several objects selected only the group's handles exist:
 * per-object handles in a crowd are unhittable anyway.
 */
function handleAt(sx, sy) {
  const s = selected();
  const near = (p) => Math.abs(sx - (p.x*view.z + view.x)) <= HANDLE/2+3 &&
                      Math.abs(sy - (p.y*view.z + view.y)) <= HANDLE/2+3;
  if (s.length > 1) {
    for (const p of groupPts(s)) if (near(p)) return p.id;
    return null;
  }
  if (s.length !== 1) return null;
  for (const p of pathPts(s[0])) if (near(p)) return p.id;
  for (const p of beamPts(s[0])) if (near(p)) return p.id;
  for (const p of zonePts(s[0])) if (near(p)) return p.id;
  for (const p of clampPts(s[0])) if (near(p)) return p.id;
  if (K(s[0]).shape !== 'rect') return null;
  for (const p of handlePts(s[0])) if (near(p)) return p.id;
  return null;
}

/*
 * Moving a selection snaps it AS A GROUP.
 *
 * Snapping each object to the grid separately pulls a carefully spaced run of
 * platforms apart the moment it is dragged -- everything lands on the nearest
 * line and the offsets between them are gone. So one offset is computed from the
 * object actually grabbed, snapped once, and applied to everything. With a
 * single object selected that is exactly what it always did.
 */
function beginMove(w, grabbed) {
  armHistory();
  const list = selected();
  const anchor = grabbed && list.indexOf(grabbed) >= 0 ? grabbed : list[0];
  dragging = { move:true, wx:w.x, wy:w.y, pairs:cloneObjs(list),
               ax: anchor ? anchor.x : 0, ay: anchor ? anchor.y : 0 };
}
function pick(o, additive) {
  if (additive) sel.includes(o.id) ? sel = sel.filter((i)=>i!==o.id) : sel.push(o.id);
  else if (!sel.includes(o.id)) sel = [o.id];
  refresh();
}

function onMouseDown(e) {
  const p = stagePos(e);
  const w = toWorld(p.x, p.y);
  const h = spaceDown ? null : handleAt(p.x, p.y);
  if (h) {
    armHistory();
    if (h[0] === 'g') {
      const list = selected();
      const b = groupBox(list);
      dragging = { ghandle:h, pairs:cloneObjs(list), box0:b,
        ang0: Math.atan2(w.y - (b.y + b.h/2), w.x - (b.x + b.w/2)) };
    } else {
      dragging = { handle:h, o:selected()[0] };
    }
    return;
  }
  if (spaceDown || e.button === 1) {
    dragging = { pan:true, sx:p.x, sy:p.y, vx:view.x, vy:view.y };
    return;
  }

  /*
   * Ctrl is the eyedropper, and works whatever tool is armed. On an object it
   * selects and adopts its settings; on blank space it drops back to the select
   * tool, which is the usual reason for reaching for the toolbar mid-edit.
   */
  if (e.ctrlKey || e.metaKey) {
    const under = topmostAt(w.x, w.y);
    if (under) { pick(under, false); adoptFrom(under); beginMove(w, under); }
    else { setTool('select'); sel = []; refresh(); }
    return;
  }

  /*
   * Alt adds to the selection: on an object it toggles that one in or out, on
   * blank space it marquees without clearing what is already picked.
   */
  if (e.altKey) {
    const under = topmostAt(w.x, w.y);
    if (under) { pick(under, true); beginMove(w, under); }
    else { dragging = { marquee:true, x0:w.x, y0:w.y, x1:w.x, y1:w.y, add:true }; }
    return;
  }

  if (tool !== 'select') {
    // A freshly drawn box stays live: dragging it moves it, so it can be placed
    // roughly and then nudged without a trip back to the select tool. Clicking
    // off it is what commits it and starts the next one.
    const held = selected().find((o) => hit(o, w.x, w.y));
    if (held) { beginMove(w, held); return; }
    // Clicking away from a live selection commits it and clears it. Only the
    // NEXT click places another, so a stray click never drops an object you
    // did not want.
    if (sel.length) { sel = []; refresh(); return; }
    startCreate(w);
    return;
  }

  const under = topmostAt(w.x, w.y);
  if (under) { pick(under, e.shiftKey); beginMove(w, under); return; }
  // Empty space with the select tool draws a marquee. Panning stays on
  // space+drag and the middle button, which is where it was already.
  if (!e.shiftKey) { sel = []; refresh(); }
  dragging = { marquee:true, x0:w.x, y0:w.y, x1:w.x, y1:w.y, add:e.shiftKey };
}

function startCreate(w) {
  pushHistory();
  const k = KINDS[tool];
  if (k.single) {
    const existing = map.objects.find((o) => o.kind === tool);
    if (existing) { existing.x = snap(w.x); existing.y = snap(w.y); sel = [existing.id]; refresh(); return; }
  }
  const o = { id:nextId++, kind:tool, x:snap(w.x), y:snap(w.y), w:0, h:0, ...(k.props||{}) };
  if (tool === 'art') {
    if (!selTile) return;
    o.tile = selTile.name; o.w = selTile.w; o.h = selTile.h;
    o.rot = artStyle.rot; o.flipX = artStyle.flipX; o.flipY = artStyle.flipY;
  }
  if (k.shape === 'point' || k.shape === 'beam') { o.w = 0; o.h = 0; }
  if (k.path) { o.xmin = o.x; o.xmax = o.x; o.ymin = o.y; o.ymax = o.y; }
  if (tool === 'door') { o.zx = o.x - 200; o.zy = o.y - 100; o.zw = 400; o.zh = 300; }
  map.objects.push(o);
  sel = [o.id];
  refresh();
  if (k.shape === 'rect' && tool !== 'art') dragging = { create:o, ox:o.x, oy:o.y };
}

function onMouseMove(e) {
  const w = worldOf(e);
  lastWorld = w;
  hud(w);
  if (!dragging) return;
  const p = stagePos(e);
  if (dragging.pan) {
    view.x = dragging.vx + (p.x - dragging.sx);
    view.y = dragging.vy + (p.y - dragging.sy);
  } else if (dragging.marquee) {
    dragging.x1 = w.x; dragging.y1 = w.y;
  } else if (dragging.create) {
    commitHistory();
    const o = dragging.create;
    o.x = snap(Math.min(dragging.ox, w.x)); o.y = snap(Math.min(dragging.oy, w.y));
    o.w = Math.max(grid || 1, snap(Math.abs(w.x - dragging.ox)));
    o.h = Math.max(grid || 1, snap(Math.abs(w.y - dragging.oy)));
    refreshProps();
  } else if (dragging.ghandle) {
    commitHistory();
    groupDrag(dragging, w, e.shiftKey);
  } else if (typeof dragging.handle === 'string' && dragging.handle[0] === 'z') {
    commitHistory();
    resizeZone(dragging.o, dragging.handle, w.x, w.y);
  } else if (typeof dragging.handle === 'string' && dragging.handle[0] === 'q') {
    commitHistory();
    resizeClamp(dragging.o, dragging.handle, w.x, w.y);
  } else if (dragging.handle === 'b0' || dragging.handle === 'b1') {
    commitHistory();
    dragBeam(dragging.o, w.x, w.y);
  } else if (dragging.handle === 'p0' || dragging.handle === 'p1') {
    commitHistory();
    const o = dragging.o;
    if (dragging.handle === 'p0') { o.xmin = snap(w.x); o.ymin = snap(w.y); }
    else { o.xmax = snap(w.x); o.ymax = snap(w.y); }
    refreshProps();
  } else if (dragging.handle) {
    commitHistory();
    resize(dragging.o, dragging.handle, w.x, w.y, e.shiftKey);
  } else if (dragging.move) {
    commitHistory();
    restoreObjs(dragging.pairs);
    const dx = snap(dragging.ax + (w.x - dragging.wx)) - dragging.ax;
    const dy = snap(dragging.ay + (w.y - dragging.wy)) - dragging.ay;
    moveObjects(dragging.pairs.map((q) => q.o), dx, dy);
    refreshProps();
  }
}

/*
 * Resizing or rotating the whole selection.
 *
 * Both are recomputed from the mousedown snapshot every frame rather than
 * applied on top of the last frame: a drag that goes out and comes back has to
 * land exactly where it started, and anything incremental accumulates rounding
 * until it does not.
 */
function groupDrag(d, w, shift) {
  restoreObjs(d.pairs);
  const objs = d.pairs.map((q) => q.o);
  const b = d.box0;
  const cx = b.x + b.w/2, cy = b.y + b.h/2;

  if (d.ghandle === 'grot') {
    const ang = Math.atan2(w.y - cy, w.x - cx) - d.ang0;
    rotateSelection(objs, Math.round(ang / (Math.PI / 2)));
    refreshProps();
    return;
  }

  const id = d.ghandle.slice(1);
  let ox = b.x, oy = b.y, sx = 1, sy = 1;
  if (id.includes('w')) { ox = b.x + b.w; sx = Math.max(0.02, (ox - snap(w.x)) / b.w); }
  if (id.includes('e')) { ox = b.x; sx = Math.max(0.02, (snap(w.x) - ox) / b.w); }
  if (id.includes('n')) { oy = b.y + b.h; sy = Math.max(0.02, (oy - snap(w.y)) / b.h); }
  if (id.includes('s')) { oy = b.y; sy = Math.max(0.02, (snap(w.y) - oy) / b.h); }
  // shift on a corner keeps the group's proportions
  if (shift && id.length === 2) { const s = Math.max(sx, sy); sx = s; sy = s; }
  for (const o of objs) scaleObj(o, sx, sy, ox, oy);
  refreshProps();
}

function onMouseUp() {
  pendingHistory = null;
  if (dragging?.create) { const o = dragging.create; if (o.w < 2 || o.h < 2) { o.w = grid||40; o.h = grid||40; } }
  if (dragging?.marquee) {
    const m = dragging;
    const x0 = Math.min(m.x0, m.x1), x1 = Math.max(m.x0, m.x1);
    const y0 = Math.min(m.y0, m.y1), y1 = Math.max(m.y0, m.y1);
    // a click rather than a drag: leave the selection alone
    if (Math.abs(x1 - x0) > 3 || Math.abs(y1 - y0) > 3) {
      const inside = map.objects.filter((o) => {
        const b = bounds(o);
        return b.x + b.w >= x0 && b.x <= x1 && b.y + b.h >= y0 && b.y <= y1;
      }).map((o) => o.id);
      sel = m.add ? [...new Set([...sel, ...inside])] : inside;
    }
  }
  /*
   * Only refresh if this mouseup actually ended a canvas drag.
   *
   * Refreshing unconditionally broke every control in the properties panel. A
   * checkbox fires mousedown -> mouseup -> click -> change, so an unconditional
   * rebuild here tore the panel down and recreated it from the OLD value before
   * the change handler ever ran, leaving the controls looking immutable. Text
   * fields and dropdowns had the same problem, since their change fires on blur
   * or after mouseup too.
   *
   * Nothing in the side panels ever sets `dragging` -- mousedown is bound to the
   * canvas alone -- so this is a reliable test for "was this a canvas drag".
   */
  const wasDragging = dragging !== null;
  dragging = null;
  if (wasDragging) refresh();
}

function resize(o, id, mx, my, free) {
  const b = bounds(o);
  const right = b.x + b.w, bottom = b.y + b.h;
  let x = b.x, y = b.y, w = b.w, h = b.h;
  if (id.includes('w')) { x = Math.min(snap(mx), right - 2); w = right - x; }
  if (id.includes('e')) { w = Math.max(2, snap(mx) - x); }
  if (id.includes('n')) { y = Math.min(snap(my), bottom - 2); h = bottom - y; }
  if (id.includes('s')) { h = Math.max(2, snap(my) - y); }
  // textures keep their aspect on a corner unless shift frees it
  if (o.kind === 'art' && id.length === 2 && !free) {
    const t = tileImgs.get(o.tile);
    if (isReady(t)) {
      const s = Math.max(w / imgW(t), h / imgH(t));
      const nw = Math.round(imgW(t) * s), nh = Math.round(imgH(t) * s);
      if (id.includes('w')) x = right - nw;
      if (id.includes('n')) y = bottom - nh;
      w = nw; h = nh;
    }
  }
  o.x = x; o.y = y; o.w = w; o.h = h;
  refreshProps();
}

function onWheel(e) {
  e.preventDefault();
  const p = stagePos(e);
  const before = toWorld(p.x, p.y);
  view.z = Math.max(0.05, Math.min(8, view.z * (e.deltaY < 0 ? 1.12 : 1/1.12)));
  view.x = p.x - before.x * view.z;
  view.y = p.y - before.y * view.z;
}

function onKeyDown(e) {
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
  if (e.code === 'Space') { spaceDown = true; e.preventDefault(); return; }
  const s = selected();
  const step = e.shiftKey ? (grid || 10) : 1;
  if (e.ctrlKey || e.metaKey) {
    const k = e.key.toLowerCase();
    if (k === 'z') { e.shiftKey ? redo() : undo(); e.preventDefault(); return; }
    if (k === 'y') { redo(); e.preventDefault(); return; }
    if (k === 'c') { copySel(); e.preventDefault(); return; }
    if (k === 'v') { paste(); e.preventDefault(); return; }
  }
  if (/^Arrow/.test(e.key) && !e.repeat && s.length) pushHistory();
  if (e.key === 'Escape') { setTool('select'); }
  else if (e.key === 'Delete' || e.key === 'Backspace') {
    pushHistory();
    map.objects = map.objects.filter((o) => !sel.includes(o.id)); sel = []; refresh(); e.preventDefault();
  }
  else if (e.key === 'd' && e.ctrlKey) {
    pushHistory();
    const copies = s.map((o) => ({ ...o, id:nextId++ }));
    moveObjects(copies, grid || 20, grid || 20);
    map.objects.push(...copies); sel = copies.map((c)=>c.id); refresh(); e.preventDefault();
  }
  else if (/^Arrow/.test(e.key)) {
    const d = { ArrowLeft:[-step,0], ArrowRight:[step,0], ArrowUp:[0,-step], ArrowDown:[0,step] }[e.key];
    moveObjects(s, d[0], d[1]); refresh(); e.preventDefault();
  }
  else if (e.key === '[') { if(!e.repeat) pushHistory(); s.forEach((o)=>{ o.z = (o.z||0) - 1; if(o.kind==='art') artStyle.z = o.z; }); refresh(); }
  else if (e.key === ']') { if(!e.repeat) pushHistory(); s.forEach((o)=>{ o.z = (o.z||0) + 1; if(o.kind==='art') artStyle.z = o.z; }); refresh(); }
  else if (e.key === 'x') { pushHistory(); s.forEach((o)=>{ if(o.kind==='art') { o.flipX = o.flipX?0:1; artStyle.flipX = o.flipX; } }); refresh(); }
  else if (e.key === 'y') { pushHistory(); s.forEach((o)=>{ if(o.kind==='art') { o.flipY = o.flipY?0:1; artStyle.flipY = o.flipY; } }); refresh(); }
  else if (e.key === 'r' && s.length) {
    pushHistory();
    /*
     * Textures alone keep the old behaviour -- spin in place and remember the
     * angle for the next stamp. Anything else rotates as a group about the
     * selection's centre, which is the only way a run of platforms and the coins
     * on them can be turned without coming apart.
     */
    if (s.every((o) => o.kind === 'art')) {
      s.forEach((o)=>{ o.rot = ((o.rot||0) + 90) % 360; artStyle.rot = o.rot; });
    } else {
      rotateSelection(s, 1);
    }
    refresh();
  }
}

// ---------------------------------------------------------------- panels
function setTool(t) {
  tool = t;
  [...root.querySelectorAll('#mde-tools button')].forEach((b) =>
    b.classList.toggle('on', b.dataset.tool === t));
}

function buildTools() {
  const el = $('tools');
  el.innerHTML = '';
  const mk = (id, label) => {
    const b = document.createElement('button');
    b.dataset.tool = id; b.textContent = label;
    b.onclick = () => setTool(id);
    el.appendChild(b);
  };
  mk('select', 'Select');
  Object.entries(KINDS).sort((a,b)=>a[1].order-b[1].order).forEach(([id,k]) => mk(id, k.label));
  setTool('select');
}

/*
 * The texture palette. Images come from io.tileImage, which is a PNG over HTTP
 * on the dev server and a canvas rebuilt from the player's own artwork in the
 * userscript -- both are drawable, so nothing here needs to know which it got.
 */
function buildPalette(tiles) {
  const el = $('palette');
  el.innerHTML = '';
  tileList = tiles; tileNodes.clear(); tileImgs.clear();
  for (const t of tiles) {
    const img = io.tileImage(t.name);
    tileImgs.set(t.name, img);
    const d = document.createElement('div');
    d.className = 'tile';
    const c = document.createElement('canvas');
    const f = Math.min(74 / t.w, 42 / t.h, 1);
    c.width = Math.max(1, Math.round(t.w * f)); c.height = Math.max(1, Math.round(t.h * f));
    const paint = () => { try { c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); } catch (e) {} };
    if (isReady(img)) paint(); else if (img) img.onload = paint;
    const s = document.createElement('span'); s.textContent = t.name.replace(/_/g,' ');
    d.appendChild(c); d.appendChild(s);
    d.title = t.name + '  ' + t.w + 'x' + t.h;
    d.onclick = () => pickTile(t.name);
    tileNodes.set(t.name, d);
    el.appendChild(d);
  }
}

/*
 * Select a texture in the palette, from the palette or from an object on canvas.
 */
function pickTile(name) {
  const t = tileList.find((x) => x.name === name);
  if (!t) return;
  selTile = t;
  setTool('art');
  tileNodes.forEach((n) => n.classList.remove('sel'));
  const node = tileNodes.get(name);
  if (node) { node.classList.add('sel'); node.scrollIntoView({ block:'nearest' }); }
}

/*
 * Ctrl-click picks up an object's settings as well as selecting it: the tool
 * switches to that kind, and for a texture the palette selection and its
 * rotation and mirroring come with it. That makes it an eyedropper -- click an
 * existing piece, then carry on stamping more of the same instead of hunting the
 * palette and redoing the transform each time.
 */
function adoptFrom(o) {
  if (!KINDS[o.kind]) return;
  if (o.kind === 'art') {
    artStyle = { rot:o.rot || 0, flipX:o.flipX || 0, flipY:o.flipY || 0 };
    pickTile(o.tile);
  } else {
    setTool(o.kind);
  }
}

/*
 * Properties panel.
 *
 * Rendered from each kind's field metadata rather than dumping raw numbers:
 * toggles become checkboxes, fixed choices become dropdowns, and every field
 * carries a plain-language label with the game's real field name and an
 * explanation underneath. Several of these fields are impossible to guess from
 * their names -- xx means camera offset on an area and patrol speed on a mover,
 * and a 0 clamp means no clamp rather than a clamp at zero.
 */
function refreshProps() {
  const el = $('props');
  const s = selected();
  if (!s.length) { el.innerHTML = '<span class="muted">nothing selected</span>'; return; }
  if (s.length > 1) return groupProps(el, s);
  const o = s[0], k = K(o);
  el.innerHTML = '';

  const head = document.createElement('div');
  head.className = 'muted';
  head.style.marginBottom = '7px';
  head.textContent = k.label + '  #' + o.id;
  el.appendChild(head);

  if (k.note) {
    const n = document.createElement('div');
    n.className = 'note';
    n.textContent = k.note;
    el.appendChild(n);
  }

  const addRow = (field, meta) => {
    const wrap = document.createElement('div');
    wrap.className = 'field';
    const row = document.createElement('div');
    row.className = 'row2';
    const lab = document.createElement('span');
    lab.textContent = meta.label || field;
    lab.title = 'game field: ' + field;
    row.appendChild(lab);

    let input;
    if (meta.type === 'bool') {
      input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = !!o[field];
      input.style.width = 'auto';
      input.onchange = () => {
        pushHistory();
        o[field] = input.checked ? 1 : 0;
        refreshObjs();
        // toggling Crusher changes which fields are relevant
        if (field === 'stomper') refreshProps();
      };
    } else if (meta.type === 'select') {
      input = document.createElement('select');
      for (const opt of meta.options) {
        const op = document.createElement('option');
        op.value = String(opt); op.textContent = String(opt);
        if (String(o[field]) === String(opt)) op.selected = true;
        input.appendChild(op);
      }
      input.onchange = () => {
        pushHistory();
        const v = input.value;
        o[field] = isNaN(Number(v)) ? v : Number(v);
        refreshObjs();
        if (field === 'trigger') refreshProps();
      };
    } else {
      input = document.createElement('input');
      input.type = 'text';
      input.value = o[field] ?? '';
      input.onchange = () => {
        pushHistory();
        const v = input.value;
        o[field] = (v !== '' && !isNaN(Number(v))) ? Number(v) : v;
        refreshObjs();
      };
    }
    row.appendChild(input);
    wrap.appendChild(row);
    if (meta.help) {
      const h = document.createElement('div');
      h.className = 'help';
      h.textContent = meta.help;
      wrap.appendChild(h);
    }
    el.appendChild(wrap);
  };

  addRow('x', { type:'number', label:'x' });
  addRow('y', { type:'number', label:'y' });
  if (k.shape === 'rect') {
    addRow('w', { type:'number', label:'width' });
    addRow('h', { type:'number', label:'height' });
  }
  const fields = k.fields || {};
  // crusher settings are noise on an ordinary platform, so they only appear
  // once the Crusher box is ticked
  Object.keys(k.props || {}).forEach((p) => addRow(p, fields[p] || { type:'number', label:p }));
  Object.keys(fields).forEach((p) => {
    const meta = fields[p];
    if (meta.crusher && !o.stomper) return;
    if (meta.zone && o.trigger !== 'zone') return;
    if (!meta.crusher && !meta.zone && !meta.door) return;
    addRow(p, meta);
  });
  if (o.kind !== 'art') {
    addRow('z', { type:'number', label:'Z order',
      help:'Editing aid only, and not saved. Lower it ([) to push this behind other objects so you can click what is underneath; raise it (]) to bring it forward.' });
  }

  if (k.path) {
    const sep = document.createElement('div');
    sep.className = 'note';
    sep.textContent = 'Patrol range. Drag the two round handles on the canvas, or set the bounds here. Leave them equal to the position for a stationary object.';
    el.appendChild(sep);
    PATH_FIELDS.forEach((p) => addRow(p, {
      type:'number', label:p,
      help: p.startsWith('x') ? 'Horizontal travel limit.' : 'Vertical travel limit.' }));
  }
}

/*
 * Several objects selected. The panel describes the GROUP -- what it covers and
 * what can be done to it as one -- rather than saying only how many things are
 * in it, which was all it used to say.
 */
function groupProps(el, s) {
  el.innerHTML = '';
  const b = groupBox(s);
  const head = document.createElement('div');
  head.className = 'muted';
  head.style.marginBottom = '7px';
  head.textContent = s.length + ' objects selected';
  el.appendChild(head);

  const note = document.createElement('div');
  note.className = 'note';
  note.textContent = 'Drag the yellow box to resize everything together (shift keeps the proportions), or the round handle above it to turn it. Rotation goes in quarter turns, because plats, spikes and camera areas are axis-aligned rects in the game’s own data.';
  el.appendChild(note);

  if (b) {
    const dims = document.createElement('div');
    dims.className = 'muted';
    dims.style.marginBottom = '8px';
    dims.textContent = 'x ' + Math.round(b.x) + '  y ' + Math.round(b.y) +
      '   ' + Math.round(b.w) + ' × ' + Math.round(b.h);
    el.appendChild(dims);
  }

  const row = document.createElement('div');
  row.style.display = 'flex';
  row.style.gap = '5px';
  const mk = (label, fn) => {
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.onclick = () => { pushHistory(); fn(); refresh(); };
    row.appendChild(btn);
  };
  mk('↻ rotate 90°', () => rotateSelection(selected(), 1));
  mk('↺ back 90°', () => rotateSelection(selected(), 3));
  el.appendChild(row);

  const counts = {};
  for (const o of s) counts[o.kind] = (counts[o.kind] || 0) + 1;
  const list = document.createElement('div');
  list.className = 'muted';
  list.style.marginTop = '9px';
  list.textContent = Object.entries(counts)
    .map(([k2, n]) => n + ' × ' + (KINDS[k2] ? KINDS[k2].label : k2)).join(', ');
  el.appendChild(list);
}

function refreshObjs() {
  const el = $('objs');
  el.innerHTML = '';
  const list = [...map.objects].sort((a,b)=>(K(a)?.order||99)-(K(b)?.order||99));
  for (const o of list) {
    const d = document.createElement('div');
    d.className = 'obj' + (sel.includes(o.id) ? ' sel' : '');
    const k = K(o) || { label:o.kind, color:'#888' };
    d.innerHTML = '<span class="swatch" style="background:' + k.color + '"></span>';
    d.appendChild(document.createTextNode(k.label + (o.kind==='art' ? ' · ' + o.tile.replace(/_/g,' ') : '') +
      '  (' + Math.round(o.x) + ',' + Math.round(o.y) + ')'));
    d.onclick = () => { sel = [o.id]; refresh(); };
    el.appendChild(d);
  }
}

const refresh = () => { refreshProps(); refreshObjs(); };

/*
 * The coordinate readout.
 *
 * Live on every mouse move, not just while dragging -- it used to update only
 * mid-drag, which is the one time you are looking at the thing you are dragging
 * instead. Reading a coordinate off the map before placing anything is the
 * common case: lining a new platform up with one across the level, or checking
 * what world Y a hazard sits at.
 */
let hudCo = null, hudMeta = null;
function buildHud() {
  const el = $('hud');
  el.innerHTML = '';
  hudCo = document.createElement('span'); hudCo.className = 'co';
  hudMeta = document.createElement('span'); hudMeta.className = 'sn';
  const meta2 = document.createElement('span'); meta2.className = 'muted'; meta2.id = 'mde-hudinfo';
  el.appendChild(hudCo); el.appendChild(hudMeta); el.appendChild(meta2);
}
function hud(w) {
  if (!hudCo) return;
  hudCo.innerHTML = '<span class="ax">x</span>&nbsp;' + Math.round(w.x) +
                    '&nbsp;&nbsp;<span class="ax">y</span>&nbsp;' + Math.round(w.y);
  hudMeta.textContent = grid ? 'snaps to ' + snap(w.x) + ', ' + snap(w.y) : '';
  const info = root.querySelector('#mde-hudinfo');
  if (info) {
    info.textContent = 'grid ' + (grid || 'free') + '   objects ' + map.objects.length +
      '   zoom ' + view.z.toFixed(2) + 'x' + (sel.length > 1 ? '   ' + sel.length + ' selected' : '');
  }
}

// ---------------------------------------------------------------- view helpers
function fitView() {
  const stage = stageEl();
  const b = mapBounds();
  const z = Math.min(stage.clientWidth / b.w, stage.clientHeight / b.h) * 0.92;
  view.z = Math.max(0.05, Math.min(4, z));
  view.x = stage.clientWidth/2 - (b.x + b.w/2) * view.z;
  view.y = stage.clientHeight/2 - (b.y + b.h/2) * view.z;
}
function mapBounds() {
  if (!map.objects.length) return { x:-1620, y:-720, w:5130, h:3330 };
  const b = groupBox(map.objects);
  return b || { x:-1620, y:-720, w:5130, h:3330 };
}

/*
 * Thumbnail for the level select grid: the map canvas rendered to a small PNG on
 * save, so it can never drift from the map it depicts.
 */
function thumbnail() {
  const TW = 320, TH = 200;
  const c = document.createElement('canvas'); c.width = TW; c.height = TH;
  const g = c.getContext('2d');
  g.fillStyle = '#0d0f14'; g.fillRect(0,0,TW,TH);
  const b = mapBounds();
  const z = Math.min(TW/b.w, TH/b.h) * 0.94;
  g.setTransform(z,0,0,z, TW/2 - (b.x+b.w/2)*z, TH/2 - (b.y+b.h/2)*z);
  const ordered = [...map.objects].sort((a,b2)=>(K(a)?.order||99)-(K(b2)?.order||99));
  for (const o of ordered) {
    const k = K(o); if (!k) continue;
    const bb = bounds(o);
    if (o.kind === 'art') {
      const img = tileImgs.get(o.tile);
      if (isReady(img)) { try { g.drawImage(img, bb.x, bb.y, bb.w, bb.h); continue; } catch (e) {} }
    }
    g.fillStyle = k.fill || (k.color + '55');
    g.fillRect(bb.x, bb.y, Math.max(bb.w, 4/z), Math.max(bb.h, 4/z));
  }
  try { return c.toDataURL('image/png'); } catch (e) { return null; }
}

// ---------------------------------------------------------------- io
/*
 * Rebuild the open-map dropdown. Keeps the current selection if it still
 * exists, and shows when each map was last saved so the newest is obvious.
 */
function fillMapList(maps, keep) {
  const ml = $('mapList');
  const want = keep !== undefined ? keep : ml.value;
  ml.innerHTML = '';
  const none = document.createElement('option');
  none.value = '';
  none.textContent = maps.length ? '— open map —' : '— no saved maps —';
  ml.appendChild(none);
  for (const m of maps) {
    const o = document.createElement('option');
    o.value = m.id;
    const when = m.modified ? new Date(m.modified) : null;
    o.textContent = m.name + (when && !isNaN(when) ? '  (' + when.toLocaleDateString() + ' ' +
      when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ')' : '');
    ml.appendChild(o);
  }
  if (want && maps.some((m) => m.id === want)) ml.value = want;
}

async function refreshMapList(keep) {
  try { fillMapList(await io.listMaps(), keep); }
  catch (e) { /* keep whatever is listed if the refresh fails */ }
}

/*
 * Keep the map and its undo history across a trip through the play page.
 *
 * Play opens in another tab and "back to editor" navigates that tab, so the
 * original editor page is gone by the time you return -- with it, the whole
 * in-memory history. localStorage rather than sessionStorage because those are
 * two different tabs.
 *
 * Only the last SAVED_HISTORY snapshots are kept. The full stack is capped at
 * 120, and a 300-object map serialises to tens of kilobytes, so persisting all
 * of them would run at the browser storage limit for no real benefit.
 */
const SAVED_HISTORY = 30;
const sessionKey = (id) => (io.storageKey || 'johnny-editor') + ':' + id;
const stateKey = () => sessionKey(map.meta.id || $('mapName').value || 'untitled');

function setGrid(v) {
  grid = Number(v) || 0;
  const el = $('grid');
  if (el) el.value = String(grid);
}

function persistState() {
  if (!booted) return;
  try {
    localStorage.setItem(stateKey(), JSON.stringify({
      objects: map.objects,
      nextId,
      grid,
      name: map.meta.name,
      undo: undoStack.slice(-SAVED_HISTORY),
      redo: redoStack.slice(-SAVED_HISTORY),
      at: Date.now(),
    }));
  } catch (err) { /* quota or private mode: carry on without persistence */ }
}

function restoreState(id) {
  try {
    const raw = localStorage.getItem(sessionKey(id));
    if (!raw) return false;
    const d = JSON.parse(raw);
    if (!d || !Array.isArray(d.objects)) return false;
    map.objects = d.objects;
    nextId = d.nextId || 1;
    if (d.name) map.meta.name = d.name;
    // grid is a per-map working preference, not part of the map itself, so it
    // lives with the session rather than in the saved file
    if (typeof d.grid === 'number') setGrid(d.grid);
    undoStack = d.undo || [];
    redoStack = d.redo || [];
    return true;
  } catch (err) { return false; }
}

async function openMap(id) {
  const g = await io.loadMap(id);
  if (!g || g.error) return false;
  loadGame(g);
  // A saved map is the committed state; anything edited after that save, plus
  // the history and the grid preference, comes back from local storage.
  map.meta.id = id;
  restoreState(id);
  $('mapName').value = map.meta.name;
  $('mapList').value = id;
  fitView(); refresh();
  return true;
}

async function save() {
  const name = ($('mapName').value || 'untitled').trim();
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,64) || 'untitled';
  const g = toGame();
  g.meta = { id, name };
  const btn = $('save');
  let ok = false;
  try {
    const j = await io.saveMap(id, { map:g, thumb: thumbnail() });
    ok = !!(j && j.ok);
  } catch (e) { console.error('[editor] save failed', e); }
  btn.textContent = ok ? 'saved' : 'save failed';
  // the list is built once at boot, so without this a map saved during the
  // session never appears in it until a reload
  if (ok) { map.meta.id = id; persistState(); await refreshMapList(id); }
  setTimeout(()=>{ btn.textContent = 'save'; }, 1500);
  return ok ? id : null;
}

// ---------------------------------------------------------------- boot & mount
function on(target, type, fn, opts) {
  target.addEventListener(type, fn, opts);
  listeners.push([target, type, fn, opts]);
}

async function boot() {
  if (booted) return;
  buildTools();
  buildHud();
  ctx = $('cv').getContext('2d');

  try { buildPalette(await io.tiles()); }
  catch (e) { console.warn('[editor] no textures available', e); }

  const ml = $('mapList');
  await refreshMapList();
  /*
   * The list is built once, so a map saved by someone else -- or in another tab
   * -- never appeared until a reload. Refresh it whenever the dropdown opens,
   * and again after every save.
   */
  on(ml, 'mousedown', () => { refreshMapList(ml.value); });
  ml.onchange = () => { if (ml.value) openMap(ml.value); };

  $('newMap').onclick = () => {
    map = blankMap(); sel = []; undoStack = []; redoStack = [];
    $('mapName').value = 'Untitled';
    $('mapList').value = '';
    fitView(); refresh();
  };
  const van = $('fromVanilla');
  if (io.vanillaMap) {
    van.onclick = async () => {
      loadGame(await io.vanillaMap());
      map.meta.name = 'Copy of vanilla';
      map.meta.id = '';
      $('mapName').value = map.meta.name;
      $('mapList').value = '';
      fitView(); refresh();
    };
  } else van.style.display = 'none';

  $('grid').onchange = (e) => { setGrid(Number(e.target.value)); schedulePersist(); };
  $('fit').onclick = fitView;
  $('artTop').onclick = (e) => {
    artOnTop = !artOnTop;
    e.target.classList.toggle('on', artOnTop);
  };
  $('save').onclick = save;

  // Play always saves first. The runner reads the map back out, so running a
  // stale copy of what is on screen would be worse than a moment of delay.
  const play = $('play');
  if (io.play) {
    play.onclick = async () => {
      play.textContent = 'saving…';
      const id = await save();
      play.textContent = 'play';
      if (id) io.play(id);
    };
  } else play.style.display = 'none';

  /*
   * Export is how a level leaves a browser that has no server behind it. The
   * userscript keeps maps in localStorage, so without this the only copy of a
   * level would live in one browser profile and could never be handed to anyone.
   */
  const exp = $('export');
  if (io.exportMap) {
    exp.onclick = () => {
      const name = ($('mapName').value || 'untitled').trim();
      const id = name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,64) || 'untitled';
      const g = toGame();
      g.meta = { id, name, modified: new Date().toISOString() };
      io.exportMap(id, g);
    };
  } else exp.style.display = 'none';

  const exit = $('exit');
  if (io.exit) exit.onclick = () => { persistState(); io.exit(); };
  else exit.style.display = 'none';

  $('mapName').oninput = (e) => { map.meta.name = e.target.value; };
  $('mapName').value = map.meta.name;

  booted = true;
  fitView(); refresh();
}

/*
 * Mount the editor into an element.
 *
 * Everything is bound here rather than at module scope so the userscript can put
 * the editor away again: while it is closed the key handlers are inert and the
 * draw loop does nothing, because the same keys belong to the game the rest of
 * the time.
 */
function mount(opts) {
  opts = opts || {};
  io = opts.io;
  if (!io) throw new Error('MapEditor.mount needs { io }');
  const doc = (opts.root && opts.root.ownerDocument) || document;

  if (!doc.getElementById('mde-style')) {
    const st = doc.createElement('style');
    st.id = 'mde-style';
    st.textContent = CSS;
    doc.head.appendChild(st);
  }
  root = doc.createElement('div');
  root.id = 'mde-root';
  root.innerHTML = HTML;
  /*
   * With no element to live in, the editor is an overlay over whatever page it
   * was dropped into -- which is the userscript case, where that page is the
   * running game. Fixed and above everything, including mapkit's own level
   * select at 9999.
   */
  if (!opts.root) root.style.cssText = 'position:fixed;inset:0;z-index:2147483000;';
  (opts.root || doc.body).appendChild(root);

  const stage = stageEl();
  on(stage, 'mousedown', onMouseDown);
  on(stage, 'wheel', onWheel, { passive:false });
  // move and up on the window, so a drag survives leaving the canvas
  on(window, 'mousemove', (e) => { if (active) onMouseMove(e); });
  on(window, 'mouseup', () => { if (active) onMouseUp(); });
  /*
   * Keys are captured, not merely listened for. In the page this changes
   * nothing; inside the game it is the difference between typing a map name and
   * making Johnny jump, because the game's own key handlers are bound to the
   * same window.
   */
  on(window, 'keydown', (e) => {
    if (!active) return;
    e.stopPropagation();
    onKeyDown(e);
  }, true);
  on(window, 'keyup', (e) => {
    if (!active) return;
    e.stopPropagation();
    if (e.code === 'Space') spaceDown = false;
  }, true);
  // the game grabs focus back on a click, and a held space would stick
  on(window, 'blur', () => { spaceDown = false; });
  on(window, 'beforeunload', persistState);

  const handle = {
    async open(id) {
      active = true;
      root.style.display = '';
      await boot();
      if (id) await openMap(id);
      fitView();
      return handle;
    },
    close() {
      persistState();
      active = false;
      root.style.display = 'none';
      return handle;
    },
    isOpen: () => active,
    openMap,
    save,
    mapId: () => map.meta.id,
    refreshTiles: async () => { buildPalette(await io.tiles()); },
    destroy() {
      persistState();
      active = false;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = null;
      for (const [t, type, fn, o2] of listeners) t.removeEventListener(type, fn, o2);
      listeners.length = 0;
      if (root && root.parentNode) root.parentNode.removeChild(root);
      root = null; booted = false;
    },
  };

  rafId = requestAnimationFrame(draw);
  if (opts.open !== false) handle.open(opts.map);
  else root.style.display = 'none';
  return handle;
}

/*
 * The geometry is exported so it can be exercised in node without a browser.
 * These are the parts where a wrong sign is invisible on screen until a map is
 * already broken -- four quarter turns must be the identity, and a resize must
 * carry patrol ranges and camera clamps with it.
 */
return {
  mount, KINDS,
  _geom: { rotate90, scaleObj, rotateSelection, clampBox, laserRect, groupBox, moveObjects, bounds },
  // read-only view of the live state, for driving the editor from a test page:
  // handle positions are in world space and the tests need the same transform
  // the canvas uses, which no amount of reading the panels recovers exactly
  _state: () => ({ view, grid, tool, sel: sel.slice(), objects: map.objects, handleAt, bounds }),
};
}));


/* ===== mapeditor/editor/editor-host.js ===== */
/*
 * Running the editor inside the game page.
 *
 * The other half of editor-core.js. On the dev server maps are files, textures
 * are PNGs on disk and Play opens a second tab; none of that exists on
 * coolmathgames.com, so this supplies the same five capabilities from what IS
 * there:
 *
 *   maps      localStorage, the SAME store the custom-levels script imports
 *             into -- a level saved here appears on the level select at once,
 *             and one imported there can be opened here
 *   textures  the canvases MapkitTiles rebuilt from the player's own copy of
 *             the artwork; no art is shipped, exactly as for the runtime
 *   vanilla   window.maps[1], which the page already contains
 *   play      hand the map to the runtime and start it, in place
 *   export    a downloaded .json, because a browser with no server behind it
 *             otherwise has no way to hand a level to anyone
 *
 * Nothing here is Archipelago-aware, and nothing in mapkit depends on it: this
 * is authoring tooling that happens to run in the same page.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MapEditorHost = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const STORE = 'mapkit-imported';
  const TILE_PREFIX = 'mkTile_';

  function readStore() {
    try {
      const raw = localStorage.getItem(STORE);
      const list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list : [];
    } catch (e) { return []; }
  }
  function writeStore(list) {
    try { localStorage.setItem(STORE, JSON.stringify(list)); return true; }
    catch (e) {
      /*
       * Quota is a real risk here and silence would be the wrong answer: a map
       * with a few hundred art placements plus a thumbnail is a hundred
       * kilobytes, and losing a level someone just drew because the store was
       * full would be unforgivable. Say so, and let them export instead.
       */
      alert('Could not save the level: ' + e.message +
            '\n\nUse Export to write it out as a file before you lose it.');
      return false;
    }
  }

  /*
   * Every texture the runtime rebuilt, straight out of Phaser's cache.
   *
   * The build step registers each tile as a canvas under mkTile_<name>, so the
   * palette can draw them directly -- no second extraction, no URLs, and no
   * artwork of ours anywhere in this file.
   */
  function cachedTiles(win) {
    const out = [];
    const cache = win.game && win.game.cache;
    if (!cache) return out;
    // Cache.IMAGE is 2, and is also getKeys' own default; the lookup is only
    // here so this does not depend on that default staying put
    const IMAGE = (win.Phaser && win.Phaser.Cache && win.Phaser.Cache.IMAGE) || 2;
    const keys = cache.getKeys ? cache.getKeys(IMAGE) : [];
    for (const key of keys) {
      if (key.indexOf(TILE_PREFIX) !== 0) continue;
      const c = tileCanvas(win, key);
      if (!c) continue;
      out.push({ name: key.slice(TILE_PREFIX.length), w: c.width, h: c.height });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }
  function tileCanvas(win, key) {
    try {
      const img = win.game.cache.getImage(key, true);
      const src = img && (img.data || img);
      return src && src.width ? src : null;
    } catch (e) { return null; }
  }

  function download(name, text) {
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  /*
   * make(win, hooks) -> an `io` for MapEditor.mount.
   *
   *   hooks.onSaved(entry)  a level was saved: register it with the runtime
   *   hooks.onPlay(entry)   run this level now
   *   hooks.onExit()        leave the editor
   */
  function make(win, hooks) {
    hooks = hooks || {};
    return {
      storageKey: 'johnny-editor-page',

      listMaps() {
        return readStore().map((m) => ({
          id: m.id,
          name: m.name || m.id,
          modified: (m.data && m.data.meta && m.data.meta.modified) || m.modified || null,
        }));
      },

      loadMap(id) {
        const found = readStore().find((m) => m.id === id);
        return found ? found.data : { error: 'no such map' };
      },

      saveMap(id, payload) {
        const list = readStore();
        const name = (payload.map.meta && payload.map.meta.name) || id;
        payload.map.meta = Object.assign({}, payload.map.meta,
          { id, name, modified: new Date().toISOString() });
        const rec = { id, name, data: payload.map, thumb: payload.thumb || null };
        const at = list.findIndex((m) => m.id === id);
        if (at >= 0) list[at] = rec; else list.push(rec);
        if (!writeStore(list)) return { ok: false };
        if (hooks.onSaved) hooks.onSaved(rec);
        return { ok: true, id };
      },

      /*
       * The stock level is already in the page, so it is free to start from.
       * Not win.maps[1] though -- that slot is where custom levels are loaded,
       * so after playing one it holds that level instead. The runtime keeps a
       * copy of the original taken before anything overwrote it, and hooks.
       * vanilla hands that over.
       */
      vanillaMap() {
        const stock = hooks.vanilla && hooks.vanilla();
        return JSON.parse(JSON.stringify(stock || win.maps[1]));
      },

      tiles() { return cachedTiles(win); },
      tileImage(name) { return tileCanvas(win, TILE_PREFIX + name); },

      play(id) {
        const found = readStore().find((m) => m.id === id);
        if (found && hooks.onPlay) hooks.onPlay(found);
      },

      exportMap(id, gameMap) {
        download(id + '.json', JSON.stringify(gameMap, null, 2) + '\n');
      },

      exit() { if (hooks.onExit) hooks.onExit(); },
    };
  }

  return { make, readStore, writeStore, cachedTiles, STORE, TILE_PREFIX };
}));


/* ===== mapeditor/editor/editor-play.js ===== */
/*
 * Playtest controls: the upgrade sliders, and what they mean.
 *
 * Shared by the two places a level gets test-played -- the dev server's
 * quick-run page and the userscript, where the editor hands a level straight to
 * the running game. Both need the same nine tracks, the same tier encoding and
 * the same remembered settings, and the encoding in particular is not something
 * to have two opinions about:
 *
 *   game.ldat.<track>.v is NOT a tier count. shop.js computes the real index as
 *   Math.round(v * 10) and adds 0.1 per purchase, so v = tiers * 0.1 for every
 *   track regardless of how many tiers it has. The Archipelago client writes it
 *   the same way.
 *
 * Settings are remembered across runs, and shared between the two hosts on
 * purpose: "how strong is Johnny" is a question about the player, not about the
 * level, and comparing two levels at the same stats is the usual reason to
 * switch between them.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MapEditorPlay = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const PREFS = 'johnny-quickrun-prefs';

  const UPGRADES = [
    { key:'spd',    label:'Speed',        max:10 },
    { key:'jmp',    label:'Jump power',   max:10 },
    { key:'jmp2',   label:'Double jump',  max:1  },
    { key:'tim',    label:'Time limit',   max:24 },
    { key:'nrg',    label:'Energy',       max:5  },
    { key:'wpn',    label:'Has gun',      max:1  },
    { key:'ammo',   label:'Ammo',         max:10 },
    { key:'gunpow', label:'Gun power',    max:10 },
    { key:'multi',  label:'Coin multi',   max:10 },
  ];

  function readPrefs() {
    try { return JSON.parse(localStorage.getItem(PREFS)) || {}; }
    catch (e) { return {}; }
  }
  function writePrefs(p) {
    try { localStorage.setItem(PREFS, JSON.stringify(p)); }
    catch (e) { /* quota or private mode: settings just will not stick */ }
  }

  /*
   * Start maxed, unless this browser has been here before.
   *
   * A playtest is for checking whether the level you just drew works, and
   * starting at zero upgrades means fighting the vanilla progression before you
   * can even reach most of it. Drag a slider down to test what the level asks of
   * an under-levelled player -- and it stays down next time.
   */
  function startingValues() {
    const saved = readPrefs().upgrades || {};
    const out = {};
    for (const u of UPGRADES) {
      const v = saved[u.key];
      out[u.key] = (typeof v === 'number' && v >= 0 && v <= u.max) ? v : u.max;
    }
    return out;
  }

  function saveValues(values, extra) {
    const p = readPrefs();
    p.upgrades = Object.assign({}, values);
    if (extra) Object.assign(p, extra);
    writePrefs(p);
  }

  /*
   * Write the values into the live save. Cash is floored at a level a shop trip
   * cannot exhaust, because a playtest that strands you at 3 coins is testing
   * the shop, not the level.
   */
  function apply(win, values) {
    if (!win.game || !win.game.ldat) return false;
    for (const u of UPGRADES) {
      if (!win.game.ldat[u.key]) win.game.ldat[u.key] = { v:0, u:0.1 };
      win.game.ldat[u.key].v = (values[u.key] || 0) * 0.1;
    }
    if (win.game.ldat.csh) win.game.ldat.csh.v = Math.max(win.game.ldat.csh.v, 999);
    return true;
  }

  /*
   * Build the sliders into a container. The two hosts lay out differently -- a
   * sidebar on the quick-run page, a floating box over the game in the
   * userscript -- but the controls themselves are the same, so only the frame
   * around them differs.
   */
  function buildSliders(doc, host, values, onChange) {
    const rows = {};
    for (const u of UPGRADES) {
      const lab = doc.createElement('label');
      lab.textContent = u.label;
      lab.className = 'mep-lab';
      host.appendChild(lab);

      const row = doc.createElement('div');
      row.className = 'mep-up';
      const r = doc.createElement('input');
      r.type = 'range'; r.min = 0; r.max = u.max; r.step = 1; r.value = values[u.key];
      const v = doc.createElement('span');
      v.className = 'mep-v'; v.textContent = String(values[u.key]);
      r.oninput = () => { values[u.key] = Number(r.value); v.textContent = r.value; onChange(false); };
      r.onchange = () => onChange(true);
      row.appendChild(r); row.appendChild(v);
      host.appendChild(row);
      rows[u.key] = { range:r, out:v, max:u.max };
    }
    return {
      rows,
      set(fn) {
        for (const u of UPGRADES) {
          const val = fn(u);
          values[u.key] = val;
          rows[u.key].range.value = val;
          rows[u.key].out.textContent = String(val);
        }
        onChange(true);
      },
    };
  }

  const CSS = `
  .mep-panel { position:fixed; right:12px; top:12px; z-index:2147482000; width:214px;
    background:#1c1f28f2; border:1px solid #2c3040; border-radius:9px; padding:10px 12px;
    color:#dde1ea; font:12px/1.45 ui-sans-serif,system-ui,sans-serif; }
  .mep-panel h3 { font-size:10px; text-transform:uppercase; letter-spacing:.07em; color:#8b93a7;
    margin:0 0 7px; font-weight:600; }
  .mep-panel .mep-lab { display:block; color:#8b93a7; font-size:11px; margin-top:4px; }
  .mep-panel .mep-up { display:grid; grid-template-columns:1fr 30px; gap:6px; align-items:center; }
  .mep-panel .mep-up input[type=range] { width:100%; }
  .mep-panel .mep-v { text-align:right; color:#8b93a7; font-variant-numeric:tabular-nums; font-size:11px; }
  .mep-panel button { width:100%; background:#262b38; border:1px solid #2c3040; color:#dde1ea;
    border-radius:6px; padding:5px 9px; font:inherit; font-size:11px; cursor:pointer; margin-top:6px; }
  .mep-panel button:hover { background:#303748; }
  .mep-panel button.mep-primary { background:#6ea8fe; border-color:#6ea8fe; color:#0d1017; font-weight:600; }
  .mep-panel .mep-note { color:#6f7688; font-size:10px; line-height:1.35; margin-top:7px; }
  .mep-panel .mep-min { display:none; }
  .mep-panel.mep-small .mep-lab, .mep-panel.mep-small .mep-up,
  .mep-panel.mep-small .mep-note, .mep-panel.mep-small .mep-full { display:none; }
  .mep-panel.mep-small .mep-min { display:block; }
  .mep-panel.mep-small { width:auto; }
  `;

  /*
   * The floating playtest panel, for the userscript.
   *
   * It collapses, because it sits over the game and the top-right corner of a
   * platformer is not always empty. Upgrades apply on the next level start, so
   * the restart button is right next to them rather than somewhere else.
   */
  function panel(win, opts) {
    opts = opts || {};
    const doc = win.document;
    if (!doc.getElementById('mep-style')) {
      const st = doc.createElement('style');
      st.id = 'mep-style';
      st.textContent = CSS;
      doc.head.appendChild(st);
    }
    const values = startingValues();
    const el = doc.createElement('div');
    el.className = 'mep-panel';

    const head = doc.createElement('h3');
    head.textContent = 'Playtest';
    el.appendChild(head);

    const body = doc.createElement('div');
    body.className = 'mep-full';
    el.appendChild(body);

    const sliders = buildSliders(doc, body, values, () => saveValues(values));

    const mk = (label, fn, cls, into) => {
      const b = doc.createElement('button');
      b.textContent = label;
      if (cls) b.className = cls;
      b.onclick = fn;
      (into || body).appendChild(b);
      return b;
    };
    mk('max everything', () => sliders.set((u) => u.max));
    mk('reset to zero', () => sliders.set(() => 0));
    const restart = mk('restart level', () => { apply(win, values); if (opts.onRestart) opts.onRestart(); }, 'mep-primary');
    if (opts.onExit) mk(opts.exitLabel || 'back to editor', () => opts.onExit());

    const note = doc.createElement('div');
    note.className = 'mep-note';
    note.textContent = 'Upgrades apply on the next level start — hit restart after changing them.';
    body.appendChild(note);

    // collapse, so the panel can get out of the way of the level
    const toggle = doc.createElement('button');
    toggle.className = 'mep-min';
    toggle.textContent = 'show';
    toggle.onclick = () => setSmall(false);
    el.appendChild(toggle);
    const hide = doc.createElement('button');
    hide.textContent = 'hide panel';
    hide.onclick = () => setSmall(true);
    body.appendChild(hide);
    function setSmall(on) { el.classList.toggle('mep-small', !!on); }

    head.style.cursor = 'pointer';
    head.onclick = () => setSmall(!el.classList.contains('mep-small'));

    doc.body.appendChild(el);

    return {
      el,
      values,
      apply: () => apply(win, values),
      show() { el.style.display = ''; },
      hide() { el.style.display = 'none'; },
      destroy() { if (el.parentNode) el.parentNode.removeChild(el); },
    };
  }

  return { UPGRADES, PREFS, readPrefs, writePrefs, startingValues, saveValues, apply, buildSliders, panel };
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
  var EXTEND = function (ctx) {
  var handle = null;     // the mounted editor
  var panel = null;      // the playtest panel
  var playing = null;    // the level this editor session sent to the game

  function ensure() {
    if (handle) return handle;
    var io = window.MapEditorHost.make(ctx.win, {
      onSaved: function (rec) {
        ctx.mapkit.addMap({ id: rec.id, name: rec.name, data: rec.data,
          thumb: rec.thumb || null, source: 'imported' });
      },
      onPlay: playFromEditor,
      onExit: function () { handle.close(); ctx.select.show(); },
      vanilla: function () {
        var m = ctx.mapkit.getMap('original');
        return m ? m.data : null;
      },
    });
    handle = window.MapEditor.mount({ io: io, open: false });
    return handle;
  }

  function open(id) {
    if (panel) panel.hide();
    var h = ensure();
    ctx.select.hide();
    h.open(id);
  }

  /*
   * Playtesting from the editor.
   *
   * Same deal as the dev server's quick-run page, and the same remembered
   * settings: upgrades default to maxed, because testing a level you just drew
   * against the vanilla progression means grinding before you can reach most of
   * it. The panel is created once and reused, so the sliders stay where they
   * were put across runs.
   */
  function playFromEditor(rec) {
    handle.close();
    playing = rec;
    ctx.startLevel({ id: rec.id, name: rec.name, data: rec.data });
    if (!panel) {
      panel = window.MapEditorPlay.panel(ctx.win, {
        onRestart: function () { ctx.win.levl = 1; ctx.win.newState(); },
        onExit: function () { backToEditor(); },
      });
    }
    // after startLevel, which swaps game.ldat to this level's own save
    panel.apply();
    panel.show();
  }

  function backToEditor() {
    var id = playing ? playing.id : null;
    playing = null;
    open(id);
  }

  /*
   * A level launched from the editor comes back to the EDITOR when it ends.
   *
   * Death and finishing both funnel through the shop, and the shop's home
   * button lands on the title -- which mapkit has already replaced with the
   * level select. Coming back to a grid of levels after testing your own is
   * the wrong place to be put: the reason you were playing it is that you are
   * still working on it. Levels started from the select screen still go back
   * there, which is why this hangs off who started it rather than off a
   * setting.
   *
   * Wrapping AFTER MapkitSelect.install means this runs first and the select's
   * own create() is simply not called in that case.
   */
  var origTitleCreate = ctx.win.TitleState.create;
  ctx.win.TitleState.create = function () {
    if (playing) { backToEditor(); return; }
    origTitleCreate.apply(this, arguments);
  };

  // picking from the select screen is an ordinary play: no panel, no return trip
  ctx.selectCfg.onPick = function (entry) {
    playing = null;
    if (panel) panel.hide();
    ctx.startLevel(entry);
  };

  ctx.selectCfg.buttons.push({ label: 'Level editor', onClick: function () { open(); } });
  ctx.selectCfg.onEditLevel = function (id) { open(id); };
};
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
      title: "Johnny Upgrade — Levels & Editor",
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
