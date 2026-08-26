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
