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
