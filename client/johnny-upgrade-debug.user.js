// ==UserScript==
// @name         Johnny Upgrade Logic Debug Sandbox
// @namespace    johnny-upgrade-ap
// @version      0.1.0
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
 * instead of guessing from map coordinates. Specifically:
 *   - Every stat (Speed, Jump Power, Double Jump, Time Limit, Energy, Ammo, Gun Power, Coin
 *     Multiplier, Has Gun) is directly settable from a panel, applied live (including the two
 *     known per-round snapshot values -- jumpMax and the live round timer -- so changes take
 *     effect immediately instead of waiting for the next round).
 *   - Coins never despawn when collected (no cash granted, no removal, no fly-away animation) --
 *     instead each logs its 1-indexed coin number and (x,y) position, throttled to once per 5
 *     seconds per coin while standing on it, so you can correlate what you see on screen with
 *     the solver's coin indices without the log spamming every frame.
 *   - Shop button clicks are a full no-op (they don't call into the real purchase logic at all)
 *     so they can't interfere with the stats you're setting manually from this panel.
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
    "color:#eee;font:12px monospace;padding:8px;border-radius:6px;width:280px;" +
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
    ldat[key].v = tier * 0.1;
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
  // Hooks
  // ---------------------------------------------------------------------------------------
  const COIN_LOG_THROTTLE_MS = 5000;
  const lastCoinLogAt = new Map(); // coin index -> timestamp of last log

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
    // coin away on hit, neither of which we want here. Throttled per coin rather than deduped
    // forever: standing on the same coin continuously only logs once every 5 seconds, but
    // leaving and coming back later (including a fresh round) logs again immediately, since
    // enough time will have naturally passed.
    window.coinCode = function () {
      if (!Array.isArray(window.coins) || !window.sprt || window.sprt.dd) return;
      const now = Date.now();
      for (const c of window.coins) {
        if (typeof window.sprtHitTest === "function" && window.sprtHitTest(c)) {
          const last = lastCoinLogAt.get(c.__debugIndex) || 0;
          if (now - last >= COIN_LOG_THROTTLE_MS) {
            lastCoinLogAt.set(c.__debugIndex, now);
            log("Coin " + (c.__debugIndex + 1) + " touched at (" + Math.round(c.x) + ", " + Math.round(c.y) + ")");
          }
        }
      }
    };

    // Full no-op -- purchases must not touch ldat values set manually from this panel.
    window.shopBtnPress = function () {};

    log("Debug hooks installed. No Archipelago connection is used in this mode.");
  }

  function waitForGameThenInstall() {
    if (window.game && window.iniLevel && window.coinCode && window.shopBtnPress && window.sprtHitTest) {
      installHooks();
    } else {
      setTimeout(waitForGameThenInstall, 200);
    }
  }

  waitForGameThenInstall();
})();
