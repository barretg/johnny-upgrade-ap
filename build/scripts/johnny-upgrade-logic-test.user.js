// ==UserScript==
// @name         Johnny Upgrade Logic Test Harness
// @namespace    johnny-upgrade-ap
// @version      0.2.0
// @description  Step through every distinct logic requirement, correct the ones a human cannot actually execute, and record the stats that really worked
// @match        https://www.coolmathgames.com/0-johnny-upgrade/play
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/*
 * DO NOT run this alongside johnny-upgrade-ap.user.js or johnny-upgrade-debug.user.js -- all
 * three hook the same globals (coinCode, killEnemy, ...) and will fight each other.
 *
 * WHY THIS EXISTS
 * The solver in solver/ answers "is this physically possible", not "can a person actually do
 * it". Some of its minimal routes are frame-perfect -- clearing plat2's ledge at Speed 5 /
 * Jump 4 leaves 6.4px of headroom inside a 7-frame window -- and logic built on those generates
 * seeds that look fine and softlock in practice.
 *
 * The point is to CORRECT requirements, not delete them. Each rule loads with its solver stats;
 * if you cannot execute it, bump the stats until you can and keep playing. Every location you
 * reach records the stats that were actually in effect at that moment, and that becomes the
 * proposed replacement. Nothing is written to the logic here -- export at the end and apply it
 * with solver/strip_failed.py.
 *
 * WORKFLOW
 *   1. Load solver/out/test-plan.json with the file picker (cached, survives reloads).
 *   2. The rule's stats are filled in and the level restarts.
 *   3. Play. Each location you touch is ticked off and stamped with the ACTIVE stats.
 *   4. Too hard? Edit the stat boxes, hit "Apply + restart", try again. Later pickups get
 *      stamped with the new numbers, so a single rule can end up with different corrections
 *      for different locations.
 *   5. Everything ticked -> auto-advance. Genuinely stuck on some -> "Can't reach rest", which
 *      records what is still missing and moves on.
 *   6. "Export" when done, then: python solver/strip_failed.py <file> --write
 *
 * Checklists are ordered hardest-first (by how much of the round timer the solver needed, ⚠ at
 * 0.8+), so the risky ones surface immediately instead of after dozens of trivial coins.
 */

(function () {
  "use strict";

  const PLAN_KEY = "ju_logic_test_plan";
  const RESULTS_KEY = "ju_logic_test_results";
  const POS_KEY = "ju_logic_test_pos";

  // Field order matches the requirement objects: {s,j,d,e,g,t}.
  const STATS = [
    { k: "s", label: "Speed", max: 10 },
    { k: "j", label: "Jump", max: 10 },
    { k: "d", label: "DblJmp", max: 1 },
    { k: "e", label: "Energy", max: 5 },
    { k: "g", label: "Ammo", max: 10 },
    { k: "t", label: "Time", max: 24 },
  ];

  let plan = null;
  let results = {}; // ruleId -> { req, status, achieved: {locIndex: stats}, missing: [...] }
  let pos = 0;
  let activeStats = null; // the stats actually in effect since the last Apply + restart
  let recordingSuspended = false; // true between asking for a restart and the new level existing
  let showAllCoins = false; // when false, only the current rule's uncollected targets are drawn

  // ---------------------------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------------------------
  const panel = document.createElement("div");
  panel.id = "ju-lt-panel";
  panel.style.cssText =
    "position:fixed;top:8px;right:8px;z-index:999999;background:rgba(12,20,32,0.95);" +
    "color:#eee;font:12px monospace;padding:8px;border-radius:6px;width:360px;" +
    "box-shadow:0 2px 10px rgba(0,0,0,0.6);";
  panel.innerHTML =
    '<div style="font-weight:bold;display:flex;justify-content:space-between;">' +
    '<span>Logic Test Harness</span><span id="ju-lt-toggle" style="cursor:pointer;">&#9660;</span></div>' +
    '<div id="ju-lt-body">' +
    '<div id="ju-lt-load"><input type="file" id="ju-lt-file" accept=".json" style="width:100%;font-size:11px;"></div>' +
    '<div id="ju-lt-main" style="display:none;">' +
    '<div id="ju-lt-progress" style="margin:4px 0;"></div>' +
    '<div id="ju-lt-req" style="background:#1d2b3d;padding:4px;border-radius:3px;margin-bottom:4px;"></div>' +
    '<div id="ju-lt-stats" style="display:flex;gap:2px;margin-bottom:3px;"></div>' +
    '<div style="display:flex;gap:3px;margin-bottom:4px;">' +
    '<button id="ju-lt-apply" style="flex:2;background:#1d4d2b;color:#fff;">Apply + restart</button>' +
    '<button id="ju-lt-reset" style="flex:1;">Reset to rule</button>' +
    "</div>" +
    '<div id="ju-lt-live" style="font-size:10px;color:#7c9;margin-bottom:2px;"></div>' +
    '<div id="ju-lt-count" style="margin-bottom:2px;"></div>' +
    '<div id="ju-lt-list" style="max-height:170px;overflow-y:auto;border:1px solid #2c3e50;padding:3px;margin-bottom:4px;font-size:11px;"></div>' +
    '<div style="display:flex;gap:3px;margin-bottom:3px;">' +
    '<button id="ju-lt-done" style="flex:1;">Done (advance)</button>' +
    '<button id="ju-lt-stuck" style="flex:1;background:#7a5a12;color:#fff;">Can\'t reach rest</button>' +
    '<button id="ju-lt-skip" style="flex:1;">Skip</button>' +
    "</div>" +
    '<div style="display:flex;gap:3px;">' +
    '<button id="ju-lt-prev" style="flex:1;">&lt; Prev</button>' +
    '<input id="ju-lt-goto" placeholder="#" style="width:44px;box-sizing:border-box;">' +
    '<button id="ju-lt-untested" style="flex:1;">Next untested</button>' +
    '<button id="ju-lt-next" style="flex:1;">Next &gt;</button>' +
    "</div>" +
    '<div style="display:flex;gap:3px;margin-top:3px;">' +
    '<button id="ju-lt-export" style="flex:1;">Export corrections</button>' +
    '<button id="ju-lt-clear" style="flex:1;">Clear all results</button>' +
    "</div>" +
    '<label style="display:block;margin-top:3px;font-size:11px;color:#8ab;">' +
    '<input type="checkbox" id="ju-lt-showall"> show coins this rule is not testing</label>' +
    '<div id="ju-lt-log" style="margin-top:5px;max-height:70px;overflow-y:auto;white-space:pre-wrap;color:#9fb;"></div>' +
    "</div></div>";
  document.body.appendChild(panel);

  document.getElementById("ju-lt-stats").innerHTML = STATS.map(
    (f) =>
      `<div style="flex:1;text-align:center;"><div style="font-size:9px;color:#8ab;">${f.label}</div>` +
      `<input type="number" min="0" max="${f.max}" value="0" data-stat="${f.k}" ` +
      `style="width:100%;box-sizing:border-box;font-size:11px;"></div>`
  ).join("");

  document.getElementById("ju-lt-toggle").addEventListener("click", () => {
    const b = document.getElementById("ju-lt-body");
    const t = document.getElementById("ju-lt-toggle");
    const hidden = b.style.display === "none";
    b.style.display = hidden ? "" : "none";
    t.innerHTML = hidden ? "&#9660;" : "&#9654;";
  });

  // What the GAME actually ended up with, as opposed to what we asked for -- the two diverging
  // silently is exactly how a bad test result happens.
  let lastReadout = "";
  function updateLiveReadout() {
    const el = document.getElementById("ju-lt-live");
    if (!el || !window.game || !window.game.ldat) return;
    const d = window.game.ldat;
    const hearts = Array.isArray(window.nrg) ? window.nrg.length : "?";
    const txt =
      "live: hearts " + hearts + "  nrg.v " + d.nrg.v.toFixed(3) +
      "  spd " + Math.round(d.spd.v * 10) + "  jmp " + Math.round(d.jmp.v * 10) +
      (d.jmp2.v ? "+DJ" : "") +
      "  ammo " + (window.sprt && window.sprt.ammo !== undefined ? window.sprt.ammo : 0) +
      "  time " + (typeof window.tim === "number" ? Math.ceil(window.tim) : "?");
    if (txt === lastReadout) return; // avoid touching the DOM every frame
    lastReadout = txt;
    el.textContent = txt;
  }

  function log(msg) {
    const el = document.getElementById("ju-lt-log");
    const d = document.createElement("div");
    d.textContent = msg;
    el.appendChild(d);
    el.scrollTop = el.scrollHeight;
  }

  // ---------------------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------------------
  function loadCached() {
    try {
      const raw = localStorage.getItem(PLAN_KEY);
      if (raw) plan = JSON.parse(raw);
      const r = localStorage.getItem(RESULTS_KEY);
      if (r) results = JSON.parse(r);
      const p = localStorage.getItem(POS_KEY);
      if (p) pos = parseInt(p, 10) || 0;
    } catch (e) {
      /* a corrupt cache is not worth failing over */
    }
  }

  function save() {
    try {
      localStorage.setItem(RESULTS_KEY, JSON.stringify(results));
      localStorage.setItem(POS_KEY, String(pos));
    } catch (e) {
      log("WARNING: could not persist (storage full?)");
    }
  }

  document.getElementById("ju-lt-file").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        plan = JSON.parse(reader.result);
        localStorage.setItem(PLAN_KEY, reader.result);
        indexByName = null; // force a rebuild against the new plan
        log("Loaded plan: " + plan.rules.length + " rules.");
        showRule(pos, false);
      } catch (err) {
        log("Could not parse that file: " + err.message);
      }
    };
    reader.readAsText(file);
  });

  // ---------------------------------------------------------------------------------------
  // Stats
  // ---------------------------------------------------------------------------------------
  function readStatBoxes() {
    const q = {};
    for (const f of STATS) {
      const el = panel.querySelector('[data-stat="' + f.k + '"]');
      let v = parseInt(el.value, 10);
      if (isNaN(v) || v < 0) v = 0;
      if (v > f.max) v = f.max;
      el.value = v;
      q[f.k] = f.k === "d" ? !!v : v;
    }
    if (!q.e) q.e = 1; // energy is TOTAL hearts and the game always grants one
    return q;
  }

  function writeStatBoxes(q) {
    for (const f of STATS) {
      const el = panel.querySelector('[data-stat="' + f.k + '"]');
      const v = q[f.k];
      el.value = f.k === "d" ? (v ? 1 : 0) : v || 0;
    }
  }

  // "energy" is TOTAL hearts (nrg.v * 10 is the heart count, and 1 is the free baseline);
  // everything else is a plain tier, v = tier * 0.1.
  // tier / 10, NOT tier * 0.1. Those differ in binary floating point at tier 3
  // (3 * 0.1 = 0.30000000000000004) and iniNRG counts hearts with an unrounded
  // `for (i = 0; i < nrg.v * 10; i++)`, so 0.30000000000000004 * 10 = 3.0000000000000004 draws
  // FOUR hearts for Energy 3. Vanilla has the same defect because its shop accumulates
  // v += 0.1; setting v directly lets us match what the solver actually modelled.
  function applyStats(q) {
    if (!window.game || !window.game.ldat) return;
    const d = window.game.ldat;
    d.spd.v = (q.s || 0) / 10;
    d.jmp.v = (q.j || 0) / 10;
    d.jmp2.v = q.d ? 0.1 : 0;
    d.tim.v = (q.t || 0) / 10;
    d.nrg.v = (q.e || 1) / 10;
    d.ammo.v = (q.g || 0) / 10;
    d.wpn.v = q.g ? 0.1 : 0;
    d.gunpow.v = 0;
    d.multi.v = 0;
    d.csh.v = 0;
  }

  // The game's globals (iniLevel, coinCode, ...) exist as soon as level.js is parsed, which is
  // long before LoaderState has finished fetching assets. Starting "Level" during that window
  // gives a level with no textures -- green placeholder squares and an unresponsive game. Only
  // these states are reachable after the loader has completed.
  const LOADED_STATES = ["Title", "Level", "Shop", "GameOver"];
  function assetsReady() {
    return !!(
      window.game &&
      window.game.state &&
      LOADED_STATES.indexOf(window.game.state.current) !== -1
    );
  }

  function applyAndRestart() {
    activeStats = readStatBoxes();
    applyStats(activeStats);
    if (!assetsReady()) {
      // Stats are still applied, so whenever the player does reach a level it uses them.
      log("Stats set (waiting for the game to finish loading before restarting).");
      return;
    }
    if (window.game && window.game.state) {
      window.levl = 1;
      // Level.create() snapshots jumpMax and the round timer, so edits only take effect on a
      // fresh start -- never by poking ldat mid-round.
      window.game.state.start("Level");
      // state.start() is deferred: the current level gets at least one more update() with the
      // player still standing wherever they were. Without this, finishing a rule while touching
      // a coin would immediately record that coin against the NEXT rule. The iniLevel hook lifts
      // the suspension once the fresh level actually exists.
      recordingSuspended = true;
    }
    log("Applied " + statText(activeStats));
  }

  function statText(q) {
    const parts = ["S" + (q.s || 0), "J" + (q.j || 0)];
    if (q.d) parts.push("DJ");
    if ((q.e || 1) > 1) parts.push("E" + q.e);
    if (q.g) parts.push("A" + q.g);
    parts.push("T" + (q.t || 0));
    return parts.join(" ");
  }

  function sameStats(a, b) {
    return STATS.every((f) => {
      const av = f.k === "d" ? !!a[f.k] : a[f.k] || (f.k === "e" ? 1 : 0);
      const bv = f.k === "d" ? !!b[f.k] : b[f.k] || (f.k === "e" ? 1 : 0);
      return av === bv;
    });
  }

  // ---------------------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------------------
  function reqText(q) {
    const parts = ["Speed " + (q.s || 0)];
    if (q.j) parts.push("Jump " + q.j);
    if (q.d) parts.push("Double Jump");
    if (q.e > 1) parts.push("Energy " + q.e);
    if (q.g) parts.push("Gun+Ammo " + q.g);
    if (q.t) parts.push("Time " + q.t);
    return parts.join(" + ");
  }

  function entryFor(rule) {
    if (!results[rule.id]) {
      results[rule.id] = { req: rule.req, status: "untested", achieved: {}, missing: [] };
    }
    const e = results[rule.id];
    if (!e.achieved) e.achieved = {};
    return e;
  }

  function showRule(i, restart) {
    if (!plan) return;
    pos = Math.max(0, Math.min(plan.rules.length - 1, i));
    const rule = plan.rules[pos];
    document.getElementById("ju-lt-load").style.display = "none";
    document.getElementById("ju-lt-main").style.display = "";

    const done = Object.values(results).filter((r) => r.status === "pass").length;
    const partial = Object.values(results).filter((r) => r.status === "partial").length;
    document.getElementById("ju-lt-progress").textContent =
      "Rule " + (pos + 1) + " / " + plan.rules.length + "   (done " + done + ", partial " + partial + ")";

    const e = entryFor(rule);
    document.getElementById("ju-lt-req").innerHTML =
      "<b>" + reqText(rule.req) + "</b><br><span style='color:#8ab;'>" +
      rule.locs.length + " location(s) &middot; timer " + rule.budget + "f &middot; " + e.status + "</span>";

    writeStatBoxes(rule.req);
    renderList();
    save();
    // Restart rather than just poking ldat: Level.create() snapshots jumpMax and the round timer,
    // so stats set without a restart silently do not apply, and a level already in progress would
    // still be running the previous rule's numbers. Skipped on the very first render, where the
    // player is still on the title screen and yanking them into a level is both jarring and
    // pointless -- the stats are applied either way.
    if (restart === false) {
      activeStats = readStatBoxes();
      applyStats(activeStats);
    } else {
      applyAndRestart();
    }
  }

  function renderList() {
    const rule = plan.rules[pos];
    const e = entryFor(rule);
    const el = document.getElementById("ju-lt-list");
    el.innerHTML = "";
    for (const item of rule.locs) {
      const loc = plan.locations[item.i];
      const got = e.achieved[item.i];
      const row = document.createElement("div");
      row.style.cssText =
        "display:flex;justify-content:space-between;gap:4px;" +
        (got ? (sameStats(got, rule.req) ? "color:#6f6;" : "color:#fd7;") : "");
      const where = loc.x !== null && loc.x !== undefined ? " (" + loc.x + "," + loc.y + ")" : "";
      // `tight` is the fraction of the round timer the solver's route needed; ~1.0 means it only
      // just fits, which is where human-impossible routes cluster.
      const warn = item.tight !== null && item.tight >= 0.8 ? " ⚠" : "";
      const mark = got ? (sameStats(got, rule.req) ? "✓ " : "✓* ") : "☐ ";
      row.innerHTML =
        "<span>" + mark + loc.name + where + warn + "</span>" +
        "<span style='color:#789;white-space:nowrap;'>" + (got ? statText(got) : item.tight === null ? "" : item.tight) + "</span>";
      row.style.cursor = "pointer";
      row.title = got
        ? "reached with " + statText(got) + " -- click to clear"
        : "click to mark reached with the current active stats";
      row.addEventListener("click", () => {
        if (e.achieved[item.i]) delete e.achieved[item.i];
        else e.achieved[item.i] = Object.assign({}, activeStats || rule.req);
        save();
        renderList();
        refreshCoinVisibility();
      });
      el.appendChild(row);
    }
    const n = Object.keys(e.achieved).length;
    const corrected = rule.locs.filter(
      (l) => e.achieved[l.i] && !sameStats(e.achieved[l.i], rule.req)
    ).length;
    document.getElementById("ju-lt-count").textContent =
      "Reached " + n + " / " + rule.locs.length + (corrected ? "   (" + corrected + " need stronger stats)" : "");
  }

  // ---------------------------------------------------------------------------------------
  // Advancing
  // ---------------------------------------------------------------------------------------
  function finish(status) {
    if (!plan) return;
    const rule = plan.rules[pos];
    const e = entryFor(rule);
    e.status = status;
    e.missing = rule.locs.filter((l) => !e.achieved[l.i]).map((l) => l.i);
    e.missingNames = e.missing.map((i) => plan.locations[i].name);
    save();
    const corrected = rule.locs.filter(
      (l) => e.achieved[l.i] && !sameStats(e.achieved[l.i], rule.req)
    ).length;
    log(
      "Rule " + (pos + 1) + ": " + status +
        (corrected ? ", " + corrected + " corrected" : "") +
        (e.missing.length ? ", " + e.missing.length + " unreached" : "")
    );
    if (pos < plan.rules.length - 1) showRule(pos + 1);
    else log("End of plan.");
  }

  document.getElementById("ju-lt-apply").addEventListener("click", applyAndRestart);
  document.getElementById("ju-lt-reset").addEventListener("click", () => {
    const rule = plan.rules[pos];
    const e = entryFor(rule);
    // A true restart of this rule: put the solver's stats back AND forget what was collected, so
    // every coin respawns visible and the rule can be re-run from nothing. Recorded pickups for
    // other rules are untouched.
    const n = Object.keys(e.achieved).length;
    e.achieved = {};
    e.status = "untested";
    e.missing = [];
    writeStatBoxes(rule.req);
    save();
    renderList();
    applyAndRestart();
    log("Reset rule " + (pos + 1) + (n ? " (cleared " + n + " recorded pickup(s))" : ""));
  });
  document.getElementById("ju-lt-done").addEventListener("click", () => finish("pass"));
  document.getElementById("ju-lt-stuck").addEventListener("click", () => finish("partial"));
  document.getElementById("ju-lt-skip").addEventListener("click", () => finish("skip"));
  document.getElementById("ju-lt-prev").addEventListener("click", () => showRule(pos - 1));
  document.getElementById("ju-lt-next").addEventListener("click", () => showRule(pos + 1));
  document.getElementById("ju-lt-goto").addEventListener("change", (ev) => {
    const n = parseInt(ev.target.value, 10);
    if (!isNaN(n)) showRule(n - 1);
  });
  document.getElementById("ju-lt-untested").addEventListener("click", () => {
    if (!plan) return;
    for (let k = 1; k <= plan.rules.length; k++) {
      const idx = (pos + k) % plan.rules.length;
      const r = results[plan.rules[idx].id];
      if (!r || r.status === "untested") return showRule(idx);
    }
    log("Every rule has a result.");
  });
  document.getElementById("ju-lt-clear").addEventListener("click", () => {
    if (!confirm("Discard all recorded results?")) return;
    results = {};
    save();
    showRule(pos, false);
    log("Cleared.");
  });
  document.getElementById("ju-lt-showall").addEventListener("change", (ev) => {
    showAllCoins = ev.target.checked;
    refreshCoinVisibility();
  });
  document.getElementById("ju-lt-export").addEventListener("click", () => {
    const payload = { exported: new Date().toISOString(), results };
    const blob = new Blob([JSON.stringify(payload, null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "logic-test-results.json";
    a.click();
    URL.revokeObjectURL(a.href);
    log("Exported " + Object.keys(results).length + " result(s).");
  });

  // ---------------------------------------------------------------------------------------
  // Detection: tick a location off and stamp it with the stats actually in effect
  // ---------------------------------------------------------------------------------------
  // Built lazily and invalidated whenever a plan is loaded. Building it once inside
  // installHooks() was a bug: on a first run the hooks install before any plan exists (it
  // arrives later via the file picker), so the map stayed empty and every pickup was silently
  // dropped.
  let indexByName = null;

  function locIndex(name) {
    if (!indexByName) {
      indexByName = {};
      if (plan) plan.locations.forEach((l, i) => (indexByName[l.name] = i));
    }
    return indexByName[name];
  }

  function recordLocation(name) {
    if (!plan || recordingSuspended) return;
    const li = locIndex(name);
    if (li === undefined) return;
    const rule = plan.rules[pos];
    if (!rule.locs.some((l) => l.i === li)) return; // not on this rule's checklist
    const e = entryFor(rule);
    if (e.achieved[li]) return;
    e.achieved[li] = Object.assign({}, activeStats || rule.req);
    save();
    renderList();
    refreshCoinVisibility();
    const corrected = !sameStats(e.achieved[li], rule.req);
    log("got " + name + (corrected ? "  [" + statText(e.achieved[li]) + "]" : ""));
    if (rule.locs.every((l) => e.achieved[l.i])) {
      log("All locations reached.");
      finish("pass");
    }
  }

  // Draw only what this rule is actually asking for: its uncollected target coins. The other 200+
  // coins on the map are irrelevant to the current rule and make it impossible to tell at a
  // glance what is left, so they are hidden unless "show all" is ticked.
  //
  // iniLevel rebuilds `coins` from scratch on every restart, so this has to be re-applied each
  // time -- that is what makes a collected coin stay gone across retries within a rule while
  // reappearing as soon as the rule changes (a different rule has a different achieved set).
  // Coin location indices are the first 246 entries in the plan's location table, so a coin's
  // array index IS its location index.
  function refreshCoinVisibility() {
    if (!plan || !Array.isArray(window.coins)) return;
    const rule = plan.rules[pos];
    const e = entryFor(rule);
    const target = new Set(rule.locs.map((l) => l.i));
    for (let i = 0; i < window.coins.length; i++) {
      const c = window.coins[i];
      if (!c) continue;
      c.visible = showAllCoins ? !e.achieved[i] : target.has(i) && !e.achieved[i];
    }
  }

  // Force the heart count to exactly what the rule asks for.
  //
  // iniNRG builds the heart array with an unrounded `for (i = 0; i < nrg.v * 10; i++)`, so any
  // floating-point value a hair above the integer draws an extra heart -- 3 * 0.1 is
  // 0.30000000000000004, which yields FOUR hearts for Energy 3. Setting nrg.v = e/10 avoids that
  // for the values checked here, but the live build is not guaranteed to compute it the same
  // way, and an extra heart silently invalidates every damage-boost test. So rather than trust
  // the arithmetic, trim the array the game actually produced down to the intended count.
  // `nrg.length` is what killSprite decrements, so this is the number that really matters.
  function enforceHeartCount() {
    if (!Array.isArray(window.nrg) || !activeStats) return;
    const want = activeStats.e || 1;
    while (window.nrg.length > want) {
      const h = window.nrg.pop();
      if (h && h.destroy) h.destroy();
    }
    if (window.nrg.length !== want) {
      log("WARNING: wanted " + want + " heart(s) but the level built " + window.nrg.length);
    }
  }

  function tagLevelObjects() {
    // Tag robots with their ROBOT ordinal at level start, before anything can die. killRobot
    // splices out of `enes`, so working the ordinal out from a live array position after a kill
    // would shift and mislabel every later robot.
    if (Array.isArray(window.enes)) {
      let ord = 0;
      for (const e of window.enes) if (e.robot) e.__ltRobot = ord++;
    }
  }

  function installHooks() {
    const originalIniLevel = window.iniLevel;
    window.iniLevel = function () {
      originalIniLevel.apply(this, arguments);
      enforceHeartCount();
      tagLevelObjects();
      refreshCoinVisibility();
      // The fresh level exists and the player is back at spawn, so anything touched from here
      // genuinely belongs to the current rule.
      recordingSuspended = false;
    };
    tagLevelObjects(); // in case a level is already running when the harness loads

    // Full replacement: vanilla coinCode grants cash and removes the coin, but here a coin has
    // to stay collectable across retries so a checklist can be filled in over many attempts.
    // Since nothing is ever spliced out, the live array index IS the map index -- no tagging
    // needed, and no stale tags if the harness loads mid-level.
    window.coinCode = function () {
      if (!Array.isArray(window.coins) || !window.sprt || window.sprt.dd) return;
      if (typeof window.sprtHitTest !== "function") return;
      for (let i = 0; i < window.coins.length; i++) {
        if (window.sprtHitTest(window.coins[i])) recordLocation("Coin " + (i + 1));
      }
    };

    // Wrapped: the robot should still die so play can continue, we just also record it.
    const originalKillEnemy = window.killEnemy;
    window.killEnemy = function (e) {
      originalKillEnemy.apply(this, arguments);
      if (e && e.robot && e.__ltRobot !== undefined) {
        recordLocation("Robot " + (e.__ltRobot + 1));
      }
    };

    const originalColgunCode = window.colgunCode;
    window.colgunCode = function () {
      // Detect the transition, not "the gun sprite exists" -- the latter is true every frame
      // until pickup and would fire constantly.
      const before = !!(window.sprt && window.sprt.colGun);
      originalColgunCode.apply(this, arguments);
      const after = !!(window.sprt && window.sprt.colGun);
      if (before && !after) recordLocation("Find the Gun");
    };

    const originalClockCode = window.clockCode;
    window.clockCode = function () {
      originalClockCode.apply(this, arguments);
      updateLiveReadout();
      if (window.sprt && window.bossData && window.bossData.range) {
        const r = window.bossData.range;
        if (window.sprt.x >= r.l && window.sprt.x <= r.r && window.sprt.y >= r.t && window.sprt.y <= r.b) {
          recordLocation("Boss Arena");
        }
      }
    };

    // Purchases must never move the tiers this harness is setting.
    window.shopBtnPress = function () {};

    log("Hooks installed.");
  }

  function waitForGameThenInstall() {
    if (
      window.game &&
      window.iniLevel &&
      window.coinCode &&
      window.killEnemy &&
      window.colgunCode &&
      window.clockCode &&
      window.game.ldat
    ) {
      loadCached();
      installHooks();
      if (plan) {
        log("Restored cached plan (" + plan.rules.length + " rules).");
        showRule(pos, false);
      } else {
        log("Load solver/out/test-plan.json to begin.");
      }
      return;
    }
    setTimeout(waitForGameThenInstall, 400);
  }

  waitForGameThenInstall();
})();
