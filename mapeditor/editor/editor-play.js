/*
 * Playtest controls: the upgrade sliders, and what they mean.
 *
 * Shared by the two places a level gets test-played -- the dev server's
 * quick-run page and the userscript, where the editor hands a level straight to
 * the running game. Both need the same nine tracks, the same tier encoding and
 * the same remembered settings, and the encoding in particular is not something
 * to have two opinions about:
 *
 *   game.ldat.<track>.v is NOT a tier count. shop.js computes the real index as
 *   Math.round(v * 10) and adds 0.1 per purchase, so v = tiers / 10 for every
 *   track regardless of how many tiers it has. The Archipelago client writes it
 *   the same way.
 *
 *   Divide by 10; do NOT multiply by 0.1. They differ in binary floating point
 *   at tiers 3, 6 and 7 (3 * 0.1 = 0.30000000000000004), and iniNRG counts
 *   hearts with an unrounded `for (i = 0; i < nrg.v * 10; i++)`, so multiplying
 *   draws FOUR hearts for Energy 3. Every other consumer rounds, which is why
 *   Energy is the only track where the difference shows -- and it is the track
 *   a difficulty playtest is most often reading.
 *
 * Settings are remembered across runs, and shared between the two hosts on
 * purpose: "how strong is Johnny" is a question about the player, not about the
 * level, and comparing two levels at the same stats is the usual reason to
 * switch between them.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MapEditorPlay = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const PREFS = 'johnny-quickrun-prefs';

  const UPGRADES = [
    { key:'spd',    label:'Speed',        max:10 },
    { key:'jmp',    label:'Jump power',   max:10 },
    { key:'jmp2',   label:'Double jump',  max:1  },
    { key:'tim',    label:'Time limit',   max:24 },
    { key:'nrg',    label:'Energy',       max:5  },
    { key:'wpn',    label:'Has gun',      max:1  },
    { key:'ammo',   label:'Ammo',         max:10 },
    { key:'gunpow', label:'Gun power',    max:10 },
    { key:'multi',  label:'Coin multi',   max:10 },
  ];

  function readPrefs() {
    try { return JSON.parse(localStorage.getItem(PREFS)) || {}; }
    catch (e) { return {}; }
  }
  function writePrefs(p) {
    try { localStorage.setItem(PREFS, JSON.stringify(p)); }
    catch (e) { /* quota or private mode: settings just will not stick */ }
  }

  /*
   * Start maxed, unless this browser has been here before.
   *
   * A playtest is for checking whether the level you just drew works, and
   * starting at zero upgrades means fighting the vanilla progression before you
   * can even reach most of it. Drag a slider down to test what the level asks of
   * an under-levelled player -- and it stays down next time.
   */
  function startingValues() {
    const saved = readPrefs().upgrades || {};
    const out = {};
    for (const u of UPGRADES) {
      const v = saved[u.key];
      out[u.key] = (typeof v === 'number' && v >= 0 && v <= u.max) ? v : u.max;
    }
    return out;
  }

  function saveValues(values, extra) {
    const p = readPrefs();
    p.upgrades = Object.assign({}, values);
    if (extra) Object.assign(p, extra);
    writePrefs(p);
  }

  /*
   * Write the values into the live save. Cash is floored at a level a shop trip
   * cannot exhaust, because a playtest that strands you at 3 coins is testing
   * the shop, not the level.
   */
  function apply(win, values) {
    if (!win.game || !win.game.ldat) return false;
    for (const u of UPGRADES) {
      if (!win.game.ldat[u.key]) win.game.ldat[u.key] = { v:0, u:0.1 };
      win.game.ldat[u.key].v = (values[u.key] || 0) / 10;
    }
    if (win.game.ldat.csh) win.game.ldat.csh.v = Math.max(win.game.ldat.csh.v, 999);
    return true;
  }

  /*
   * Build the sliders into a container. The two hosts lay out differently -- a
   * sidebar on the quick-run page, a floating box over the game in the
   * userscript -- but the controls themselves are the same, so only the frame
   * around them differs.
   */
  function buildSliders(doc, host, values, onChange) {
    const rows = {};
    for (const u of UPGRADES) {
      const lab = doc.createElement('label');
      lab.textContent = u.label;
      lab.className = 'mep-lab';
      host.appendChild(lab);

      const row = doc.createElement('div');
      row.className = 'mep-up';
      const r = doc.createElement('input');
      r.type = 'range'; r.min = 0; r.max = u.max; r.step = 1; r.value = values[u.key];
      const v = doc.createElement('span');
      v.className = 'mep-v'; v.textContent = String(values[u.key]);
      r.oninput = () => { values[u.key] = Number(r.value); v.textContent = r.value; onChange(false); };
      r.onchange = () => onChange(true);
      row.appendChild(r); row.appendChild(v);
      host.appendChild(row);
      rows[u.key] = { range:r, out:v, max:u.max };
    }
    return {
      rows,
      set(fn) {
        for (const u of UPGRADES) {
          const val = fn(u);
          values[u.key] = val;
          rows[u.key].range.value = val;
          rows[u.key].out.textContent = String(val);
        }
        onChange(true);
      },
    };
  }

  const CSS = `
  .mep-panel { position:fixed; right:12px; top:12px; z-index:2147482000; width:214px;
    background:#1c1f28f2; border:1px solid #2c3040; border-radius:9px; padding:10px 12px;
    color:#dde1ea; font:12px/1.45 ui-sans-serif,system-ui,sans-serif; }
  .mep-panel h3 { font-size:10px; text-transform:uppercase; letter-spacing:.07em; color:#8b93a7;
    margin:0 0 7px; font-weight:600; }
  .mep-panel .mep-lab { display:block; color:#8b93a7; font-size:11px; margin-top:4px; }
  .mep-panel .mep-up { display:grid; grid-template-columns:1fr 30px; gap:6px; align-items:center; }
  .mep-panel .mep-up input[type=range] { width:100%; }
  .mep-panel .mep-v { text-align:right; color:#8b93a7; font-variant-numeric:tabular-nums; font-size:11px; }
  .mep-panel button { width:100%; background:#262b38; border:1px solid #2c3040; color:#dde1ea;
    border-radius:6px; padding:5px 9px; font:inherit; font-size:11px; cursor:pointer; margin-top:6px; }
  .mep-panel button:hover { background:#303748; }
  .mep-panel button.mep-primary { background:#6ea8fe; border-color:#6ea8fe; color:#0d1017; font-weight:600; }
  .mep-panel .mep-note { color:#6f7688; font-size:10px; line-height:1.35; margin-top:7px; }
  .mep-panel .mep-min { display:none; }
  .mep-panel.mep-small .mep-lab, .mep-panel.mep-small .mep-up,
  .mep-panel.mep-small .mep-note, .mep-panel.mep-small .mep-full { display:none; }
  .mep-panel.mep-small .mep-min { display:block; }
  .mep-panel.mep-small { width:auto; }
  `;

  /*
   * The floating playtest panel, for the userscript.
   *
   * It collapses, because it sits over the game and the top-right corner of a
   * platformer is not always empty. Upgrades apply on the next level start, so
   * the restart button is right next to them rather than somewhere else.
   */
  function panel(win, opts) {
    opts = opts || {};
    const doc = win.document;
    if (!doc.getElementById('mep-style')) {
      const st = doc.createElement('style');
      st.id = 'mep-style';
      st.textContent = CSS;
      doc.head.appendChild(st);
    }
    const values = startingValues();
    const el = doc.createElement('div');
    el.className = 'mep-panel';

    const head = doc.createElement('h3');
    head.textContent = 'Playtest';
    el.appendChild(head);

    const body = doc.createElement('div');
    body.className = 'mep-full';
    el.appendChild(body);

    const sliders = buildSliders(doc, body, values, () => saveValues(values));

    const mk = (label, fn, cls, into) => {
      const b = doc.createElement('button');
      b.textContent = label;
      if (cls) b.className = cls;
      b.onclick = fn;
      (into || body).appendChild(b);
      return b;
    };
    mk('max everything', () => sliders.set((u) => u.max));
    mk('reset to zero', () => sliders.set(() => 0));
    const restart = mk('restart level', () => { apply(win, values); if (opts.onRestart) opts.onRestart(); }, 'mep-primary');
    if (opts.onExit) mk(opts.exitLabel || 'back to editor', () => opts.onExit());

    const note = doc.createElement('div');
    note.className = 'mep-note';
    note.textContent = 'Upgrades apply on the next level start — hit restart after changing them.';
    body.appendChild(note);

    // collapse, so the panel can get out of the way of the level
    const toggle = doc.createElement('button');
    toggle.className = 'mep-min';
    toggle.textContent = 'show';
    toggle.onclick = () => setSmall(false);
    el.appendChild(toggle);
    const hide = doc.createElement('button');
    hide.textContent = 'hide panel';
    hide.onclick = () => setSmall(true);
    body.appendChild(hide);
    function setSmall(on) { el.classList.toggle('mep-small', !!on); }

    head.style.cursor = 'pointer';
    head.onclick = () => setSmall(!el.classList.contains('mep-small'));

    doc.body.appendChild(el);

    return {
      el,
      values,
      apply: () => apply(win, values),
      show() { el.style.display = ''; },
      hide() { el.style.display = 'none'; },
      destroy() { if (el.parentNode) el.parentNode.removeChild(el); },
    };
  }

  return { UPGRADES, PREFS, readPrefs, writePrefs, startingValues, saveValues, apply, buildSliders, panel };
}));
