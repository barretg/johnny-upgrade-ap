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
  #mk-select .mk-empty { color:#8b93a7; text-align:center; padding:60px 20px; }
  #mk-select .mk-pager { display:flex; gap:8px; align-items:center; justify-content:center;
    margin-top:20px; color:#8b93a7; font-size:12px; }
  #mk-select .mk-del { float:right; color:#8b93a7; font-size:11px; padding:0 4px; }
  #mk-select .mk-del:hover { color:#e07a7a; }
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
    bar.appendChild(el('span', 'mk-sp'));
    if (cfg.onExit) {
      const back = el('button', null, 'Back to title');
      back.onclick = () => { hide(); cfg.onExit(); };
      bar.appendChild(back);
    }
    wrap.appendChild(bar);

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
    meta.appendChild(el('div', 'mk-tag' + (reason ? ' mk-why' : ''), reason || m.source));
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

    if (win.TitleState) {
      const orig = win.TitleState.create;
      win.TitleState.create = function () {
        if (cfg.replaceTitle === false) orig.apply(this, arguments);
        show();
      };
    }
    return { show, hide, render };
  }

  return { install, show, hide, render };
}));
