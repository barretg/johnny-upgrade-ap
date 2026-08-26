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
 *
 * It is also required as a module, by mapeditor's own builder, which bundles the
 * editor on top of this runtime. That is why build() takes extraModules and an
 * `extend` hook rather than knowing anything about the editor: mapkit ships into
 * the Archipelago client too, and must not depend on authoring tools.
 */
const fs = require('fs');
const path = require('path');

const HERE = __dirname;

// load order matters: select and patcher lean on the others being defined
const MODULES = [
  'api.js', 'mapformat.js', 'tiles.js', 'crushers.js', 'doors.js',
  'renderer.js', 'patcher.js', 'saves.js', 'settings.js', 'select.js',
];

const VERSION = '0.2.0';

function header(o) {
  return [
    '// ==UserScript==',
    '// @name         ' + (o.name || 'Johnny Upgrade — Custom Levels'),
    '// @namespace    johnny-upgrade-mapkit',
    '// @version      ' + (o.version || VERSION),
    '// @description  ' + (o.description ||
      'Play custom Johnny Upgrade levels. Adds a level select with import, per-level saves, and audio controls.'),
    /*
     * The game lives in the /play frame, and ONLY there.
     *
     * Matching the wrapper page as well put a second copy of this script on
     * https://www.coolmathgames.com/0-johnny-upgrade, where the SDK globals
     * never appear -- so it polled for a minute and logged "game never
     * appeared", which looks exactly like the real failure and is not one.
     * The Archipelago client has always matched only this URL, and that one is
     * confirmed working on the live site.
     */
    '// @match        https://www.coolmathgames.com/0-johnny-upgrade/play*',
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

function bootstrap() {
  return `
/* ------------------------------------------------------------------ bootstrap */
(function () {
  'use strict';

  var RECIPE = __TILE_RECIPE__;
  var BUNDLED = __BUNDLED_MAPS__;
  /*
   * An optional extension, injected at build time: a function (ctx) run once
   * everything is installed. The level-editor build uses it to add itself to
   * this screen. Nothing in mapkit knows what it does.
   */
  var EXTEND = __EXTEND__;
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
      title: __TITLE__,
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
`;
}

/*
 * Build a userscript.
 *
 *   out           where to write it
 *   mapsDir       bundle every .json map in this directory as a built-in level
 *   extraModules  [{ label, src }] concatenated after mapkit's own modules
 *   extend        source text of a function (ctx) run once mapkit is installed
 *   name/description/version/title  userscript metadata and select-screen title
 */
function build(opts) {
  opts = opts || {};
  const out = opts.out || path.join(HERE, '..', 'dist', 'johnny-upgrade-custom-levels.user.js');
  const recipe = JSON.parse(fs.readFileSync(path.join(HERE, 'tiles.json'), 'utf8'));

  const bundled = [];
  if (opts.mapsDir) {
    for (const f of fs.readdirSync(opts.mapsDir).filter((x) => x.endsWith('.json'))) {
      const data = JSON.parse(fs.readFileSync(path.join(opts.mapsDir, f), 'utf8'));
      if (!data.plats) continue;
      const id = (data.meta && data.meta.id) || f.replace(/\.json$/, '');
      bundled.push({ id, name: (data.meta && data.meta.name) || id, data });
    }
  }

  const parts = [header(opts)];
  for (const m of MODULES) {
    parts.push('/* ===== mapkit/' + m + ' ===== */\n' + fs.readFileSync(path.join(HERE, m), 'utf8') + '\n');
  }
  for (const m of (opts.extraModules || [])) {
    parts.push('/* ===== ' + m.label + ' ===== */\n' + m.src + '\n');
  }
  // replacements go in through a function, so a $& or $' inside a map's data
  // is inserted literally instead of being read as a substitution pattern
  const put = (s, token, value) => s.replace(token, () => value);
  let boot = bootstrap();
  boot = put(boot, '__TILE_RECIPE__', JSON.stringify(recipe));
  boot = put(boot, '__BUNDLED_MAPS__', JSON.stringify(bundled));
  boot = put(boot, '__TITLE__', JSON.stringify(opts.title || 'Johnny Upgrade — Custom Levels'));
  boot = put(boot, '__EXTEND__', opts.extend || 'null');
  parts.push(boot);

  const text = parts.join('\n');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, text);
  return { out, text, bundled, recipe, modules: MODULES.length + (opts.extraModules || []).length };
}

function main() {
  const argv = process.argv.slice(2);
  const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const r = build({
    out: arg('--out', undefined),
    mapsDir: arg('--maps', null),
  });
  console.log('wrote ' + path.relative(process.cwd(), r.out));
  console.log('  ' + (r.text.length / 1024).toFixed(0) + ' KB');
  console.log('  ' + r.modules + ' modules, ' + r.recipe.tiles.length + ' tile recipes, ' +
    r.bundled.length + ' bundled level' + (r.bundled.length === 1 ? '' : 's'));
  if (!r.bundled.length) console.log('  (no levels bundled -- players import their own)');
}

if (require.main === module) main();

module.exports = { build, MODULES, VERSION, header, bootstrap };
