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
