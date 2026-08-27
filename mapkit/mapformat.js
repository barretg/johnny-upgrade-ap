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
