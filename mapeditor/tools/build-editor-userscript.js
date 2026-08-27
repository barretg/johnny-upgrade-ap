/*
 * Bundle the map editor into a single Tampermonkey userscript.
 *
 * The hosted editor and this are the same editor: editor-core.js is shared
 * verbatim, and only the `io` differs -- files and HTTP on the dev server,
 * localStorage and the page's own game here. Two copies of a 2,000-line editor
 * would drift within a week, so there is one.
 *
 * The result is COMPLETELY SELF-CONTAINED. It talks to no server, ours or
 * anyone's: maps live in the player's localStorage, textures are rebuilt from
 * the copy of the game their browser already loaded, and levels move between
 * people as .json files through Export and Import. The hosted editor stays
 * private, and nothing in this script knows it exists.
 *
 * It is a superset of the custom-levels script -- same level select, same
 * per-level saves, same runtime -- with the editor added on top through the
 * extension hook mapkit's builder provides. Installing both would give you two
 * copies of the level select, so install one or the other.
 *
 * Usage: node mapeditor/tools/build-editor-userscript.js [--out <path>] [--maps <dir>]
 */
const fs = require('fs');
const path = require('path');
const mapkit = require('../../mapkit/build-userscript.js');

const HERE = __dirname;
const EDITOR = path.join(HERE, '..', 'editor');

/*
 * The extension, as source text.
 *
 * It runs once mapkit has installed itself, and gets a ctx with the level
 * select's config object and the function that starts a level. Everything it
 * adds is on that screen: a toolbar button for a new level, and a pencil on
 * every level this browser owns.
 *
 * The editor is mounted lazily and then kept. Mounting costs a full palette
 * build, and closing the editor to test a level and reopening it is the loop
 * this whole thing exists for -- so it is hidden rather than destroyed, which
 * also keeps the undo history alive across a play.
 */
const EXTEND = `function (ctx) {
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
}`;

function main() {
  const argv = process.argv.slice(2);
  const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };

  const r = mapkit.build({
    out: arg('--out', path.join(HERE, '..', '..', 'dist', 'johnny-upgrade-map-editor.user.js')),
    mapsDir: arg('--maps', null),
    name: 'Johnny Upgrade — Level Editor',
    description: 'Build, play and share custom Johnny Upgrade levels in the browser. Includes the custom-level runtime and level select.',
    title: 'Johnny Upgrade — Levels & Editor',
    extraModules: [
      /*
       * The difficulty ladder, verbatim from the solver. It is pure data and
       * arithmetic with no requires, and bundling the real file rather than a
       * transcription is the point: "rung 12" has to mean one thing, and the
       * editor's rung reference is the place someone would read it from.
       */
      { label: 'solver/ladder.js', src: fs.readFileSync(path.join(HERE, '..', '..', 'solver', 'ladder.js'), 'utf8') },
      { label: 'mapeditor/editor/editor-core.js', src: fs.readFileSync(path.join(EDITOR, 'editor-core.js'), 'utf8') },
      { label: 'mapeditor/editor/editor-host.js', src: fs.readFileSync(path.join(EDITOR, 'editor-host.js'), 'utf8') },
      { label: 'mapeditor/editor/editor-play.js', src: fs.readFileSync(path.join(EDITOR, 'editor-play.js'), 'utf8') },
    ],
    extend: EXTEND,
  });

  console.log('wrote ' + path.relative(process.cwd(), r.out));
  console.log('  ' + (r.text.length / 1024).toFixed(0) + ' KB');
  console.log('  ' + r.modules + ' modules, ' + r.recipe.tiles.length + ' tile recipes, ' +
    r.bundled.length + ' bundled level' + (r.bundled.length === 1 ? '' : 's'));
  console.log('  no server, no artwork: maps go in localStorage, textures rebuild from the player\'s own copy');
}

main();
