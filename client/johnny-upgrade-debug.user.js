// ==UserScript==
// @name         Johnny Upgrade Logic Debug Sandbox
// @namespace    johnny-upgrade-ap
// @version      0.2.0
// @description  Offline sandbox for manually exploring Johnny Upgrade's reachability logic -- no Archipelago connection at all
// @match        https://www.coolmathgames.com/0-johnny-upgrade/play
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/*
 * DO NOT run this alongside johnny-upgrade-ap.user.js -- both hook the same global functions
 * (coinCode, shopBtnPress, etc.) and will fight each other. Disable one before using the other.
 *
 * Purpose: let you manually set every upgrade tier directly (bypassing Archipelago entirely) so
 * you can walk the map and empirically determine what's actually reachable with what stats,
 * instead of guessing from map coordinates. Workflow:
 *   1. Set the stat panel to whatever combination you want to test.
 *   2. Click "Record" -- this snapshots the current settings and starts tracking every location
 *      (coin, robot, gun, boss arena) you touch from this point forward.
 *   3. Play through the level.
 *   4. Click "Record" again with new settings to start the next trial (this automatically ends
 *      the previous one), or click "Export" to download everything gathered so far as a text
 *      file, grouped by location, showing every settings combination that reached it.
 *
 * Other behavior:
 *   - Coins never despawn when collected (no cash granted, no removal, no fly-away animation).
 *   - Shop button clicks are a full no-op so they can't interfere with stats set from this panel.
 */

(function () {
  "use strict";

  const UPGRADE_FIELDS = [
    { key: "spd", label: "Speed", max: 10 },
    { key: "jmp", label: "Jump Power", max: 10 },
    { key: "tim", label: "Time Limit", max: 24 },
    { key: "nrg", label: "Energy", max: 5 },
    { key: "ammo", label: "Ammo", max: 10 },
    { key: "gunpow", label: "Gun Power", max: 5 },
    { key: "multi", label: "Coin Multiplier", max: 10 },
  ];

  // ---------------------------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------------------------
  const panel = document.createElement("div");
  panel.id = "ju-debug-panel";
  panel.style.cssText =
    "position:fixed;top:8px;right:8px;z-index:999999;background:rgba(40,10,10,0.92);" +
    "color:#eee;font:12px monospace;padding:8px;border-radius:6px;width:300px;" +
    "box-shadow:0 2px 8px rgba(0,0,0,0.5);";

  const rows = UPGRADE_FIELDS.map(
    (f) =>
      `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:2px;">` +
      `<label style="flex:1;">${f.label} (0-${f.max})</label>` +
      `<input type="number" min="0" max="${f.max}" value="0" data-field="${f.key}" data-max="${f.max}" style="width:50px;">` +
      `</div>`
  ).join("");

  panel.innerHTML =
    '<div style="font-weight:bold;margin-bottom:4px;">JU Debug Sandbox (no AP)</div>' +
    rows +
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:2px;">' +
    '<label style="flex:1;">Double Jump</label><input type="checkbox" data-field="jmp2"></div>' +
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">' +
    '<label style="flex:1;">Has Gun</label><input type="checkbox" data-field="wpn"></div>' +
    '<div style="font-size:11px;color:#ccc;margin-bottom:4px;">Shop clicks are a no-op.</div>' +
    '<div style="display:flex;gap:4px;margin-bottom:4px;">' +
    '<button id="ju-debug-record" style="flex:1;">Record</button>' +
    '<button id="ju-debug-export" style="flex:1;">Export</button>' +
    "</div>" +
    '<div id="ju-debug-current" style="font-size:11px;color:#ccc;margin-bottom:4px;">Not recording.</div>' +
    '<div id="ju-debug-log" style="max-height:220px;overflow-y:auto;white-space:pre-wrap;border-top:1px solid #555;padding-top:4px;"></div>';
  document.body.appendChild(panel);

  function log(message) {
    const el = document.getElementById("ju-debug-log");
    const line = document.createElement("div");
    line.textContent = message;
    el.appendChild(line);
    el.scrollTop = el.scrollHeight;
    console.log("[JU-DEBUG]", message);
  }

  function applyField(key, rawValue) {
    if (!window.game || !window.game.ldat) return;
    const ldat = window.game.ldat;
    if (key === "jmp2") {
      ldat.jmp2.v = rawValue ? 0.1 : 0;
      if (typeof window.jumpMax !== "undefined") window.jumpMax = rawValue ? 2 : 1;
      return;
    }
    if (key === "wpn") {
      ldat.wpn.v = rawValue ? 0.1 : 0;
      if (window.sprt) window.sprt.ammo = Math.round(ldat.ammo.v * 20);
      return;
    }
    const field = UPGRADE_FIELDS.find((f) => f.key === key);
    const max = field ? field.max : 10;
    const tier = Math.max(0, Math.min(max, rawValue));
    // tier / 10, NOT tier * 0.1 -- they differ in binary floating point at tier 3
    // (3 * 0.1 = 0.30000000000000004), and iniNRG counts hearts with an unrounded
    // `for (i = 0; i < nrg.v * 10; i++)`, which then draws FOUR hearts for Energy 3.
    ldat[key].v = tier / 10;
    if (key === "tim" && typeof window.tim === "number") {
      window.tim = Math.round(ldat.tim.v * 10 * 6 + 3);
    }
    if (key === "ammo" && window.sprt) {
      window.sprt.ammo = Math.round(ldat.ammo.v * 20);
    }
  }

  panel.addEventListener("input", (e) => {
    const field = e.target.getAttribute("data-field");
    if (!field) return;
    const value = e.target.type === "checkbox" ? e.target.checked : parseInt(e.target.value, 10) || 0;
    applyField(field, value);
    log("Set " + field + " = " + value);
  });

  // ---------------------------------------------------------------------------------------
  // Recording
  // ---------------------------------------------------------------------------------------
  // Each recording is one trial: a snapshot of the panel's settings at the moment "Record" was
  // pressed, plus every location touched from then until the next "Record" press (or export).
  const recordings = []; // [{ settings: {..}, locations: Set<string> }]
  let current = null;

  function readCurrentSettings() {
    const settings = {};
    for (const f of UPGRADE_FIELDS) {
      settings[f.label] = parseInt(document.querySelector('[data-field="' + f.key + '"]').value, 10) || 0;
    }
    settings["Double Jump"] = document.querySelector('[data-field="jmp2"]').checked ? 1 : 0;
    settings["Has Gun"] = document.querySelector('[data-field="wpn"]').checked ? 1 : 0;
    return settings;
  }

  function settingsToString(settings) {
    return Object.entries(settings)
      .map(([k, v]) => k + "=" + v)
      .join(" ");
  }

  function startRecording() {
    const settings = readCurrentSettings();
    current = { settings, locations: new Set() };
    recordings.push(current);
    document.getElementById("ju-debug-current").textContent = "Recording: " + settingsToString(settings);
    log("=== Recording started: " + settingsToString(settings) + " ===");
  }

  function recordLocation(name) {
    if (!current) return;
    if (current.locations.has(name)) return;
    current.locations.add(name);
    log("[recorded] " + name + " (" + settingsToString(current.settings) + ")");
  }

  function exportRecordings() {
    // Group by location across all recordings, listing every settings combo that reached it.
    const byLocation = new Map(); // location name -> [settingsString, ...]
    for (const rec of recordings) {
      const settingsStr = settingsToString(rec.settings);
      for (const loc of rec.locations) {
        if (!byLocation.has(loc)) byLocation.set(loc, []);
        byLocation.get(loc).push(settingsStr);
      }
    }
    const locationNames = Array.from(byLocation.keys()).sort((a, b) => {
      // Sort coins/robots numerically by their trailing number, everything else alphabetically.
      const na = a.match(/(\d+)$/), nb = b.match(/(\d+)$/);
      if (na && nb && a.replace(na[1], "") === b.replace(nb[1], "")) return parseInt(na[1]) - parseInt(nb[1]);
      return a.localeCompare(b);
    });
    let out = "Exported " + recordings.length + " trial(s), " + byLocation.size + " distinct location(s) touched.\n\n";
    for (const loc of locationNames) {
      out += loc + ":\n";
      for (const s of byLocation.get(loc)) out += "  " + s + "\n";
    }
    if (locationNames.length === 0) out += "(nothing recorded yet -- press Record, then play, then Export)\n";

    const blob = new Blob([out], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "johnny_upgrade_debug_recordings.txt";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    log("Exported " + recordings.length + " trial(s) to johnny_upgrade_debug_recordings.txt");
  }

  document.getElementById("ju-debug-record").addEventListener("click", startRecording);
  document.getElementById("ju-debug-export").addEventListener("click", exportRecordings);

  // ---------------------------------------------------------------------------------------
  // Hooks
  // ---------------------------------------------------------------------------------------
  function installHooks() {
    const originalIniLevel = window.iniLevel;
    window.iniLevel = function () {
      originalIniLevel.apply(this, arguments);
      if (Array.isArray(window.coins)) {
        window.coins.forEach((c, i) => {
          c.__debugIndex = i;
        });
      }
      if (Array.isArray(window.enes)) {
        window.enes.forEach((e, i) => {
          e.__debugIndex = i;
        });
      }
    };

    // Full replacement, not a wrapper -- vanilla coinCode grants cash and removes/animates the
    // coin away on hit, neither of which we want here.
    window.coinCode = function () {
      if (!Array.isArray(window.coins) || !window.sprt || window.sprt.dd) return;
      for (const c of window.coins) {
        if (typeof window.sprtHitTest === "function" && window.sprtHitTest(c)) {
          recordLocation("Coin " + (c.__debugIndex + 1));
        }
      }
    };

    // Wrapped, not replaced -- we still want the robot to actually die (so you can keep moving/
    // testing), just also record it. killEnemy is only called on an already-successful hit.
    const originalKillEnemy = window.killEnemy;
    window.killEnemy = function (e, b) {
      originalKillEnemy.apply(this, arguments);
      if (e && e.robot && e.__debugIndex !== undefined) {
        recordLocation("Robot " + (e.__debugIndex + 1));
      }
    };

    const originalColgunCode = window.colgunCode;
    window.colgunCode = function () {
      // BUG (fixed): checking only "did the gun sprite exist before this call" is true on
      // EVERY frame until the gun is actually collected, regardless of player position -- it
      // recorded "Find the Gun" on every single frame of every trial. Must check the actual
      // transition (existed, then destroyed this call), which only happens on real pickup.
      const hadGunBefore = !!(window.sprt && window.sprt.colGun);
      originalColgunCode.apply(this, arguments);
      const hasGunAfter = !!(window.sprt && window.sprt.colGun);
      if (hadGunBefore && !hasGunAfter) recordLocation("Find the Gun");
    };

    // Boss arena isn't a single touchable object -- approximate "reached it" as standing within
    // the boss's floor range, checked every frame the round is active.
    const originalClockCode = window.clockCode;
    window.clockCode = function () {
      originalClockCode.apply(this, arguments);
      if (window.sprt && window.bossData && window.bossData.range) {
        const r = window.bossData.range;
        if (window.sprt.x >= r.l && window.sprt.x <= r.r && window.sprt.y >= r.t && window.sprt.y <= r.b) {
          recordLocation("Boss Arena");
        }
      }
    };

    // Full no-op -- purchases must not touch ldat values set manually from this panel.
    window.shopBtnPress = function () {};

    log("Debug hooks installed. No Archipelago connection is used in this mode.");
  }

  function waitForGameThenInstall() {
    if (
      window.game &&
      window.iniLevel &&
      window.coinCode &&
      window.killEnemy &&
      window.colgunCode &&
      window.clockCode &&
      window.shopBtnPress &&
      window.sprtHitTest
    ) {
      installHooks();
    } else {
      setTimeout(waitForGameThenInstall, 200);
    }
  }

  waitForGameThenInstall();
})();
