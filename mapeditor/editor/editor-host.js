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
 *   modules   localStorage again, and export per module: nothing in a browser
 *             can SOLVE one, so a module saved here is unsolved until its file
 *             reaches solver/solve-module.js
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
  const MODULE_STORE = 'mapkit-modules';
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
   * The module library, in the page.
   *
   * Nothing here can solve a module -- the solver is node -- so a module saved in
   * the game page is an UNSOLVED one until its file reaches solver/solve-module.js.
   * That is exactly how the badge reads it: `solve` is a record this side never
   * writes, only carries. Which is also why export exists per module rather than
   * only per map: without a server, a module saved here would otherwise be stuck
   * in one browser profile and could never be solved at all.
   */
  function readModules() {
    try {
      const raw = localStorage.getItem(MODULE_STORE);
      const list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list : [];
    } catch (e) { return []; }
  }
  function writeModules(list) {
    try { localStorage.setItem(MODULE_STORE, JSON.stringify(list)); return true; }
    catch (e) {
      alert('Could not save the module: ' + e.message +
            '\n\nExport it as a file before you lose it.');
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

      listModules() { return readModules(); },

      saveModule(name, mod) {
        const list = readModules();
        const at = list.findIndex((m) => m.name === name);
        if (at >= 0) list[at] = mod; else list.push(mod);
        return writeModules(list) ? { ok: true, name } : { ok: false };
      },

      // one indentation apart from the server's writer, deliberately: this is the
      // file that gets dropped into mapeditor/modules/ and solved
      exportModule(name, mod) {
        download(name + '.json', JSON.stringify(mod, null, 1) + '\n');
      },

      exit() { if (hooks.onExit) hooks.onExit(); },
    };
  }

  return { make, readStore, writeStore, cachedTiles, STORE, TILE_PREFIX };
}));
