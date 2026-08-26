/*
 * Bundle mapkit into a single Tampermonkey userscript.
 *
 * Everything goes in one file: the runtime modules, the tile recipe, and the
 * bootstrap. No @require, no external fetches -- partly so it survives the
 * page's CSP, mostly so sharing it is sending someone one file.
 *
 * What it does NOT contain is artwork. Tiles are rebuilt at load time from the
 * player's own copy of lvlGrfx1..6, using the rectangles in tiles.json. Verified
 * byte-identical to the build-time extraction for all 28 tiles.
 *
 * Usage: node mapkit/build-userscript.js [--out <path>] [--maps <dir>]
 *   --maps  bundle every .json map in a directory as a built-in level.
 *           Omit it and the script ships empty, with players importing their own.
 */
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const HERE = __dirname;
const OUT = arg('--out', path.join(HERE, '..', 'dist', 'johnny-upgrade-custom-levels.user.js'));
const MAPS_DIR = arg('--maps', null);

// load order matters: select and patcher lean on the others being defined
const MODULES = [
  'api.js', 'mapformat.js', 'tiles.js', 'crushers.js', 'doors.js',
  'renderer.js', 'patcher.js', 'saves.js', 'settings.js', 'select.js',
];

const VERSION = '0.1.0';

function header() {
  return [
    '// ==UserScript==',
    '// @name         Johnny Upgrade — Custom Levels',
    '// @namespace    johnny-upgrade-mapkit',
    '// @version      ' + VERSION,
    '// @description  Play custom Johnny Upgrade levels. Adds a level select with import, per-level saves, and audio controls.',
    '// @match        https://www.coolmathgames.com/0-johnny-upgrade/play*',
    '// @match        https://www.coolmathgames.com/0-johnny-upgrade*',
    '// @run-at       document-start',
    '// @grant        none',
    '// ==/UserScript==',
    '',
    '/*',
    ' * No game artwork is bundled. Textures are rebuilt at load time from the',
    ' * copy of the game already running in your browser -- this script carries',
    ' * only a list of rectangles describing where each tile lives.',
    ' *',
    ' * Ad breaks are left completely alone. Where the page provides cmgAdBreak,',
    ' * it is called exactly as the game intends and never stubbed or skipped.',
    ' */',
    '',
  ].join('\n');
}

function bootstrap(bundledMaps) {
  return `
/* ------------------------------------------------------------------ bootstrap */
(function () {
  'use strict';

  var RECIPE = __TILE_RECIPE__;
  var BUNDLED = __BUNDLED_MAPS__;
  var KEY_PREFIX = 'mkTile_';
  var STORE = 'mapkit-imported';

  var settings = null, saves = null, pending = null, installed = false;

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
  function ready() {
    return typeof window.iniLevel === 'function' &&
           typeof window.LevelState === 'object' &&
           typeof window.TitleState === 'object' &&
           typeof window.LoaderState === 'object' &&
           typeof window.maps !== 'undefined';
  }

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
      window.Mapkit.addMap({ id: imported[j].id, name: imported[j].name, data: imported[j].data, source: 'imported' });
    }

    window.MapkitSelect.install(window, {
      mapkit: window.Mapkit,
      title: 'Johnny Upgrade — Custom Levels',
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
    });

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
`;
}

function main() {
  const recipe = JSON.parse(fs.readFileSync(path.join(HERE, 'tiles.json'), 'utf8'));

  const bundled = [];
  if (MAPS_DIR) {
    for (const f of fs.readdirSync(MAPS_DIR).filter((x) => x.endsWith('.json'))) {
      const data = JSON.parse(fs.readFileSync(path.join(MAPS_DIR, f), 'utf8'));
      if (!data.plats) continue;
      const id = (data.meta && data.meta.id) || f.replace(/\.json$/, '');
      bundled.push({ id, name: (data.meta && data.meta.name) || id, data });
    }
  }

  const parts = [header()];
  for (const m of MODULES) {
    const src = fs.readFileSync(path.join(HERE, m), 'utf8');
    parts.push('/* ===== mapkit/' + m + ' ===== */\n' + src + '\n');
  }
  parts.push(
    bootstrap()
      .replace('__TILE_RECIPE__', JSON.stringify(recipe))
      .replace('__BUNDLED_MAPS__', JSON.stringify(bundled))
  );

  const out = parts.join('\n');
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, out);

  console.log('wrote ' + path.relative(process.cwd(), OUT));
  console.log('  ' + (out.length / 1024).toFixed(0) + ' KB');
  console.log('  ' + MODULES.length + ' modules, ' + recipe.tiles.length + ' tile recipes, ' +
    bundled.length + ' bundled level' + (bundled.length === 1 ? '' : 's'));
  if (!bundled.length) console.log('  (no levels bundled -- players import their own)');
}

main();
