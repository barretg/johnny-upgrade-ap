/*
 * Drive the built userscript end to end: level select -> editor -> save -> play
 * -> back to the editor.
 */
(function () {
  var out = [];
  var say = function (m) { out.push(m); document.getElementById('probe').textContent = out.join('\n'); };
  var ok = function (c, m, extra) { say((c ? 'ok   ' : 'FAIL ') + m + (extra !== undefined ? '  [' + extra + ']' : '')); };
  var $ = function (id) { return document.getElementById(id); };
  var panel = function () { return document.querySelector('.mep-panel'); };
  var pencils = function () {
    return [].slice.call(document.querySelectorAll('#mk-select .mk-name span'))
      .filter(function (n) { return n.textContent === '✎'; });
  };

  function ready() { return $('mk-select') && window.MapEditor && window.game && window.game.cache; }

  var tries = 0;
  var t = setInterval(function () {
    if (!ready()) {
      if (++tries > 300) { clearInterval(t); say('TIMEOUT: state=' + (window.game && window.game.state && window.game.state.current)); dumpLog(); }
      return;
    }
    clearInterval(t);
    setTimeout(step, 600);
  }, 100);

  function waitFor(cond, then, n) {
    n = n || 0;
    if (cond()) return then();
    if (n > 80) { say('gave up waiting'); return dumpLog(); }
    setTimeout(function () { waitFor(cond, then, n + 1); }, 100);
  }

  function dumpLog() {
    say('--- console ---');
    (window.__log || []).forEach(function (l) { say(l); });
  }

  function step() {
    try {
      ok(!!$('mk-select'), 'level select installed');
      var built = (window.__log || []).filter(function (l) { return /rebuilt \d+ textures/.test(l); });
      ok(built.length > 0, 'textures rebuilt from the page copy', built[0]);

      var btns = [].slice.call(document.querySelectorAll('#mk-select button'));
      var edit = btns.filter(function (b) { return b.textContent === 'Level editor'; })[0];
      ok(!!edit, 'the editor button is on the select screen',
         btns.map(function (b) { return b.textContent; }).join(' | '));
      if (!edit) return dumpLog();

      edit.click();
      ok(!!$('mde-root'), 'clicking it mounts the editor');
      ok($('mk-select').style.display === 'none', 'and hides the level select');

      waitFor(function () { return document.querySelectorAll('#mde-palette .tile').length > 0; }, function () {
        ok(document.querySelectorAll('#mde-palette .tile').length > 20, 'the palette is filled from the game copy',
           document.querySelectorAll('#mde-palette .tile').length);
        $('mde-fromVanilla').click();
        setTimeout(afterVanilla, 500);
      });
    } catch (e) { say('THREW: ' + e.message); dumpLog(); }
  }

  function afterVanilla() {
    try {
      var n = document.querySelectorAll('#mde-objs .obj').length;
      ok(n > 100, 'start from vanilla loads the stock level', n + ' objects');
      $('mde-mapName').value = 'Harness Level';
      $('mde-mapName').dispatchEvent(new Event('input'));
      $('mde-save').click();
      setTimeout(afterSave, 500);
    } catch (e) { say('THREW: ' + e.message); dumpLog(); }
  }

  function afterSave() {
    try {
      var store = JSON.parse(localStorage.getItem('mapkit-imported') || '[]');
      ok(store.length === 1 && store[0].id === 'harness-level', 'save writes to the shared level store',
         store.map(function (m) { return m.id; }).join(','));
      ok(!!(store[0] && store[0].thumb), 'and renders a thumbnail');
      ok(!!(store[0] && store[0].data && store[0].data.plats && store[0].data.plats.length),
         'the saved file is in the game format', store[0] && store[0].data.plats.length + ' plats');
      ok(Array.isArray(store[0].data.art), 'and always carries an art layer, even empty',
         store[0].data.art && store[0].data.art.length);
      ok(window.Mapkit.listMaps().map(function (m) { return m.id; }).indexOf('harness-level') >= 0,
         'and the runtime knows about it');

      $('mde-exit').click();
      ok($('mde-root').style.display === 'none', 'close hides the editor');
      ok($('mk-select').style.display !== 'none', 'and brings the select back');

      var cards = [].slice.call(document.querySelectorAll('#mk-select .mk-card'));
      var mine = cards.filter(function (c) { return /Harness Level/.test(c.textContent); })[0];
      ok(!!mine, 'the level has a card', cards.length + ' cards');
      ok(pencils().length === 1, 'with a pencil to reopen it in the editor');
      if (mine) mine.click();
      setTimeout(afterPick, 1500);
    } catch (e) { say('THREW: ' + e.message); dumpLog(); }
  }

  function afterPick() {
    try {
      ok(window.levl === 1, 'picking it starts the level', 'levl=' + window.levl);
      ok(!!(window.plats && window.plats.length), 'and the level built', window.plats && window.plats.length);
      ok(!!(window.lasers && window.lasers.length), 'lasers exist', window.lasers && window.lasers.length);
      if (window.lasers && window.lasers[0]) {
        var l0 = window.lasers[0], l1 = window.lasers[1];
        ok(Math.abs(l0.angle) === 90 && Math.round(l0.height) === 590,
           'laser 0 is the horizontal 590 the map asked for', l0.angle + ' / ' + l0.height);
        ok(l1 && l1.angle === 0 && Math.round(l1.height) === 180, 'laser 1 is upright at 180',
           l1 && (l1.angle + ' / ' + l1.height));
      }
      /*
       * The level saved above has an EMPTY art layer, which is what a level
       * being built looks like. It must still hide the vanilla mural: while it
       * did not, a blank custom level wore the scenery of the stock one until
       * the first texture was placed.
       */
      var mural = (window.isprt ? window.isprt.children : []).filter(function (c) {
        return c.key && /^lvlGrfx/.test(c.key);
      });
      ok(mural.length > 0 && mural.every(function (c) { return !c.visible; }),
         'an empty art layer still hides the vanilla mural',
         mural.length + ' slices, ' + mural.filter(function (c) { return c.visible; }).length + ' visible');

      ok(!panel() || panel().style.display === 'none',
         'a level picked from the select screen gets no playtest panel');
      window.levl = 0; window.newState();
      setTimeout(reopen, 600);
    } catch (e) { say('THREW: ' + e.message); dumpLog(); }
  }

  function reopen() {
    try {
      ok($('mk-select').style.display !== 'none', 'a level picked from the select comes back to the select');
      var p = pencils()[0];
      if (!p) { ok(false, 'pencil reachable'); return dumpLog(); }
      p.click();
      waitFor(function () { return $('mde-root').style.display !== 'none'; }, function () {
        $('mde-play').click();
        setTimeout(afterEditorPlay, 1500);
      });
    } catch (e) { say('THREW: ' + e.message); dumpLog(); }
  }

  function afterEditorPlay() {
    try {
      ok(!!panel() && panel().style.display !== 'none', 'playing from the editor shows the playtest panel');
      ok($('mde-root').style.display === 'none', 'and puts the editor away');
      ok(window.levl === 1, 'and starts the level', 'levl=' + window.levl);
      ok(document.querySelectorAll('.mep-panel input[type=range]').length === 9, 'nine upgrade sliders',
         document.querySelectorAll('.mep-panel input[type=range]').length);
      ok(!!(window.game.ldat.spd && Math.round(window.game.ldat.spd.v * 10) === 10),
         'with the playtest upgrades applied', window.game.ldat.spd && window.game.ldat.spd.v);
      window.levl = 0; window.newState();       // as the shop's home button does
      setTimeout(afterReturn, 900);
    } catch (e) { say('THREW: ' + e.message); dumpLog(); }
  }

  function afterReturn() {
    try {
      ok($('mde-root').style.display !== 'none', 'ending it comes back to the editor');
      ok($('mk-select').style.display === 'none', 'not to the level select');
      ok(!panel() || panel().style.display === 'none', 'and the playtest panel is put away');
      var errs = (window.__log || []).filter(function (l) { return /^ERROR/.test(l); });
      ok(errs.length === 0, 'no page errors', errs.slice(0, 2).join(' ~ '));
      dumpLog();
    } catch (e) { say('THREW: ' + e.message); dumpLog(); }
  }
})();
