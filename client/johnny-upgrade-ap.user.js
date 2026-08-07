// ==UserScript==
// @name         Johnny Upgrade Archipelago Client
// @namespace    johnny-upgrade-ap
// @version      0.1.0
// @description  Archipelago multiworld integration for Johnny Upgrade on coolmathgames.com
// @match        https://www.coolmathgames.com/0-johnny-upgrade/play
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/*
 * ARCHITECTURE NOTES (read before modifying):
 *
 * The live coolmathgames.com version of Johnny Upgrade is NOT Flash -- it's a plain HTML5/JS
 * rewrite using the Phaser framework, loaded as ordinary <script> tags into this page (see
 * scratch-work/johnny-upgrade-sdk/). Everything below hooks the page's own global functions and
 * the global `game` Phaser instance directly (monkey-patching), the same way the Cookie Clicker
 * Archipelago client works -- there is no separate emulator layer to go through.
 *
 * Key facts this file depends on (reverse engineered from js/level.js, js/shop.js, js/boss.js):
 *
 * - `game.ldat.<field>.v` is NOT a raw tier count. shop.js's addITM computes
 *   `Math.round(levl.v * 10)` and uses THAT as the actual index into the upgrade's price array,
 *   and shopBtnPress increments it by a flat `+= 0.1` per purchase. So v = tierCount * 0.1,
 *   for every upgrade track regardless of how many tiers it has (10, 24, 5, or 1). When we
 *   grant a progressive item here, we set `.v = receivedCount * 0.1` directly.
 * - Fields: spd (Speed), jmp (Jump Power), jmp2 (Double Jump, single tier), tim (Time Limit,
 *   in whole SECONDS remaining -- confirmed by `tim -= 1/60` per frame in clockCode), nrg
 *   (Energy), ammo (Ammo), gunpow (Gun Power), multi (Coin Multiplier), csh (cash).
 * - The runtime `coins` array is rebuilt every round in iniLevel() as
 *   `ldat.coins.map(ob => spriteFromOb(ob))`, in the exact index order of the static map data
 *   (scratch-work/reachability-solver/maps_literal.js: maps[1].coins). We rely on that fixed
 *   order to map "Coin N" (1-based) location names to array index N-1.
 * - The runtime `enes` array is built the same way from `ldat.enes`, which mixes 2 unkillable
 *   "saw" hazards and 6 killable "robot" enemies in a FIXED order. Only the robot entries, at
 *   original indices [2,3,4,5,6,7], are Archipelago locations ("Robot 1".."Robot 6"), because
 *   killEnemy() only has damage-response branches for `e.robot`/`e.bomb`, never `e.saw`.
 * - Coin pickups (coinCode) no longer grant cash directly per the agreed design -- they're pure
 *   location checks. Cash instead comes from received Coin Bundle items, scaled by the
 *   Progressive Coin Multiplier tier using the same +50%/tier formula the vanilla game used for
 *   coin pickups (game.ldat.csh.v += value * (1 + 0.5 * multiplierTier)).
 * - Finding the gun (colgunCode) sets `game.ldat.wpn.v = 0.1` exactly once and is its own
 *   location ("Find the Gun"), independent of any received item.
 * - Shop purchases (shopBtnPress) are location-check triggers ONLY -- they no longer grant the
 *   upgrade tier themselves (that comes from receiving the matching Progressive item). See the
 *   design discussion in the apworld's rules.py/locations.py for why.
 * - Boss defeat is detected via bossHit() driving `boss.nrg` to <= 0 (boss.stp becomes 6).
 *
 * KNOWN GAPS / things that need verification against real play before trusting this fully:
 * - The exact boss combat requirement (how much Ammo/Gun Power is really needed) was not
 *   reverse engineered in depth -- see rules.py's placeholder goal rule.
 * - This file has not been run against the live game. Function/field names were all confirmed
 *   by reading js/*.js directly (see scratch-work/johnny-upgrade-sdk/), but runtime behavior
 *   (timing of when `window.game`/functions become available, whether Phaser wraps these in a
 *   closure instead of leaving them as plain globals, etc.) should be spot-checked in a real
 *   browser session.
 */

(function () {
  "use strict";

  const GAME_NAME = "Johnny Upgrade";
  const AP_VERSION = { major: 0, minor: 6, build: 0, class: "Version" };

  const UPGRADE_FIELD_BY_ITEM = {
    "Progressive Speed": "spd",
    "Progressive Jump Power": "jmp",
    "Progressive Time Limit": "tim",
    "Progressive Energy": "nrg",
    "Progressive Ammo": "ammo",
    "Progressive Gun Power": "gunpow",
    "Progressive Coin Multiplier": "multi",
  };

  // Fallback only -- the real values come from ap.slotData.coin_bundle_values (see items.py for
  // why these are deliberately modest relative to the price ladder).
  const COIN_BUNDLE_DEFAULT_VALUES = {
    "Small Coin Bundle": 5,
    "Medium Coin Bundle": 15,
    "Large Coin Bundle": 50,
  };

  // ---------------------------------------------------------------------------------------
  // Small UI: a floating connect panel + log, independent of the game's own canvas.
  // ---------------------------------------------------------------------------------------
  const panel = document.createElement("div");
  panel.id = "ap-ju-panel";
  panel.style.cssText =
    "position:fixed;top:8px;right:8px;z-index:999999;background:rgba(20,20,24,0.92);" +
    "color:#eee;font:12px monospace;padding:8px;border-radius:6px;width:320px;" +
    "box-shadow:0 2px 8px rgba(0,0,0,0.5);";
  panel.innerHTML =
    '<div id="ap-ju-header" style="font-weight:bold;margin-bottom:4px;cursor:pointer;display:flex;justify-content:space-between;">' +
    "<span>Archipelago</span><span id=\"ap-ju-toggle\">&#9660;</span></div>" +
    '<div id="ap-ju-body">' +
    '<input id="ap-ju-server" placeholder="archipelago.gg:38281" style="width:100%;margin-bottom:2px;box-sizing:border-box;">' +
    '<input id="ap-ju-slot" placeholder="Slot name" style="width:100%;margin-bottom:2px;box-sizing:border-box;">' +
    '<input id="ap-ju-password" placeholder="Password (optional)" type="password" style="width:100%;margin-bottom:4px;box-sizing:border-box;">' +
    '<button id="ap-ju-connect" style="width:100%;">Connect</button>' +
    '<div style="display:flex;gap:8px;margin-top:6px;">' +
    '<div style="flex:1;"><div style="font-weight:bold;">Upgrades</div><div id="ap-ju-upgrades" style="white-space:pre-wrap;"></div></div>' +
    '<div style="flex:1;"><div style="font-weight:bold;">Shop bought</div><div id="ap-ju-shop" style="white-space:pre-wrap;"></div></div>' +
    "</div>" +
    '<div id="ap-ju-log" style="margin-top:6px;max-height:100px;overflow-y:auto;white-space:pre-wrap;"></div>' +
    "</div>";
  document.body.appendChild(panel);

  document.getElementById("ap-ju-header").addEventListener("click", () => {
    const body = document.getElementById("ap-ju-body");
    const toggle = document.getElementById("ap-ju-toggle");
    const collapsed = body.style.display === "none";
    body.style.display = collapsed ? "" : "none";
    toggle.innerHTML = collapsed ? "&#9660;" : "&#9654;";
  });

  function log(message) {
    const el = document.getElementById("ap-ju-log");
    const line = document.createElement("div");
    line.textContent = message;
    el.appendChild(line);
    el.scrollTop = el.scrollHeight;
    console.log("[AP-JU]", message);
  }

  // ---------------------------------------------------------------------------------------
  // Minimal Archipelago network client (hand-rolled against docs/network protocol.md rather
  // than a bundled library, to keep this userscript self-contained with no external fetch).
  // ---------------------------------------------------------------------------------------
  class ArchipelagoClient {
    constructor() {
      this.socket = null;
      this.connected = false;
      this.locationNameToId = {};
      this.locationIdToName = {};
      this.itemIdToNameByGame = {}; // gameName -> {itemId -> itemName}
      this.checkedLocationIds = new Set();
      this.slotData = null;
      this.team = null;
      this.slot = null;
      this.players = [];
      this.slotInfo = {};
      this.storageKey = null;
      this.scoutedItemDisplay = {}; // location name -> display string, once resolved
      this.dataPackageReady = false;
      this.stateSyncTimer = null;
      this.lastSyncedCash = null;
      this.lastSyncedAreas = null;
      this.onConnected = () => {};
      this.onDisconnected = () => {};
      this.onItemsReceived = () => {}; // (allItemNamesSoFar, newAdditiveNamesThisUpdate)
      this.onCheckedLocationsUpdated = () => {}; // (Set of newly-checked ids this update)
      this.onScoutsUpdated = () => {}; // () -- called whenever scoutedItemDisplay gains entries
      this.onOwnCheckSent = () => {}; // (locationName) -- called whenever WE send a new check
      this.onCashRestored = () => {}; // (amount) -- server-stored cash retrieved/updated
      this.getLocalCash = () => null; // provided by the caller, reads window.game.ldat.csh.v
      this.onAreasRestored = () => {}; // (bitmask) -- server-stored visited areas retrieved/updated
      this.getLocalAreas = () => null; // provided by the caller, reads window.game.ldat.ars
    }

    connect(address, slotName, password) {
      if (this.socket) this.disconnect(); // clean up any previous connection first
      this.slotName = slotName;
      this.password = password || "";
      this.storageKey = "ap_ju_" + address + "_" + slotName;

      // Try TLS first, then fall back to plaintext. Hosted rooms (archipelago.gg) are wss-only,
      // and a page served over HTTPS -- which coolmathgames.com is -- is not allowed to open an
      // insecure ws:// socket at all: the browser blocks it as mixed content before the request
      // ever leaves. Plain ws:// is really only for a self-hosted server with no certificate,
      // so it belongs second. An address typed with an explicit scheme is always honoured as-is.
      const explicit = /^wss?:\/\//i.test(address);
      const urls = explicit ? [address] : ["wss://" + address, "ws://" + address];
      this._attemptId = (this._attemptId || 0) + 1;
      this._openSocket(urls, 0, this._attemptId);
    }

    _openSocket(urls, index, attemptId) {
      // A newer connect() (or a disconnect) superseded this attempt while it was in flight.
      if (attemptId !== this._attemptId) return;

      const url = urls[index];
      const isLast = index >= urls.length - 1;
      log("Connecting to " + url + " ...");

      let socket;
      try {
        socket = new WebSocket(url);
      } catch (e) {
        // Mixed-content blocking can throw synchronously rather than firing an error event.
        log("Could not open " + url + ": " + (e && e.message ? e.message : e));
        if (!isLast) {
          this._openSocket(urls, index + 1, attemptId);
        } else {
          this._failed(urls);
        }
        return;
      }
      this.socket = socket;

      let opened = false;
      socket.onopen = () => {
        opened = true;
        log("Socket open, waiting for RoomInfo...");
      };
      // WebSocket error events carry no useful detail by design (the spec deliberately hides
      // why, to avoid leaking cross-origin information), so there is nothing worth logging here
      // -- onclose below is what decides whether to retry or report.
      socket.onerror = () => {};
      socket.onclose = () => {
        if (attemptId !== this._attemptId) return;
        if (!opened) {
          // Never established, so this scheme is simply not what the server speaks.
          if (!isLast) {
            this._openSocket(urls, index + 1, attemptId);
            return;
          }
          this._failed(urls);
          return;
        }
        log("Disconnected.");
        this._teardown();
      };
      socket.onmessage = (event) => {
        const packets = JSON.parse(event.data);
        for (const packet of packets) this._handlePacket(packet);
      };
    }

    _failed(urls) {
      log("Could not connect (tried " + urls.join(", ") + ").");
      if (location.protocol === "https:" && urls.some((u) => u.startsWith("ws://"))) {
        log("Note: this page is HTTPS, so plain ws:// is blocked by the browser.");
      }
      this._teardown();
    }

    // Explicit user-initiated disconnect (as opposed to the socket closing on its own, which
    // still routes through the same cleanup via socket.onclose above).
    disconnect() {
      // Invalidate any in-flight connect attempt so its close handler cannot resurrect things
      // by falling back to the next scheme after the user has already asked to stop.
      this._attemptId = (this._attemptId || 0) + 1;
      if (this.socket) {
        this.socket.onclose = null; // avoid double-teardown via the close event too
        this.socket.close();
      }
      this._teardown();
    }

    _teardown() {
      if (this.stateSyncTimer) {
        clearInterval(this.stateSyncTimer);
        this.stateSyncTimer = null;
      }
      this.socket = null;
      this.connected = false;
      this.locationNameToId = {};
      this.locationIdToName = {};
      this.itemIdToNameByGame = {};
      this.checkedLocationIds = new Set();
      this.slotData = null;
      this.team = null;
      this.slot = null;
      this.players = [];
      this.slotInfo = {};
      this.scoutedItemDisplay = {};
      this.dataPackageReady = false;
      this.lastSyncedCash = null;
      this.lastSyncedAreas = null;
      this.onDisconnected();
    }

    _send(packet) {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
      this.socket.send(JSON.stringify([packet]));
    }

    _cashKey() {
      return "johnny_upgrade_cash_" + this.team + "_" + this.slot;
    }

    // Visited camera areas (game.ldat.ars) as a bitmask. getXP() is n*n*5 over that array and is
    // what prices Double Jump in the shop, and unlike cash there is no other server-side record
    // of it -- without this, disconnecting would permanently cost the player their EXP progress.
    _areasKey() {
      return "johnny_upgrade_areas_" + this.team + "_" + this.slot;
    }

    _startStateSync() {
      if (this.stateSyncTimer) return;
      this.stateSyncTimer = setInterval(() => {
        const cash = this.getLocalCash();
        if (cash !== null && cash !== this.lastSyncedCash) {
          this.lastSyncedCash = cash;
          this._send({
            cmd: "Set",
            key: this._cashKey(),
            default: 0,
            want_reply: false,
            operations: [{ operation: "replace", value: cash }],
          });
        }
        const areas = this.getLocalAreas();
        if (areas !== null && areas !== this.lastSyncedAreas) {
          this.lastSyncedAreas = areas;
          // "or", not "replace": areas are only ever gained, so a union is both the correct merge
          // across sessions and structurally safe -- a client that has just wiped its save sends
          // 0 and cannot clobber what the server already knows.
          this._send({
            cmd: "Set",
            key: this._areasKey(),
            default: 0,
            want_reply: false,
            operations: [{ operation: "or", value: areas }],
          });
        }
      }, 2000);
    }

    _handlePacket(packet) {
      switch (packet.cmd) {
        case "RoomInfo":
          // Request every game's data package (not just ours), since items placed in our own
          // shop locations can belong to any player's game and we want to be able to resolve
          // their names for the shop's scouted-item display later.
          this._send({ cmd: "GetDataPackage" });
          this._send({
            cmd: "Connect",
            password: this.password,
            game: GAME_NAME,
            name: this.slotName,
            uuid: "johnny-upgrade-ap-client",
            version: AP_VERSION,
            items_handling: 0b111,
            tags: [],
            slot_data: true,
          });
          break;
        case "DataPackage": {
          for (const [gameName, gameData] of Object.entries(packet.data.games)) {
            this.itemIdToNameByGame[gameName] = Object.fromEntries(
              Object.entries(gameData.item_name_to_id).map(([name, id]) => [id, name])
            );
            if (gameName === GAME_NAME) {
              this.locationNameToId = gameData.location_name_to_id;
              this.locationIdToName = Object.fromEntries(
                Object.entries(this.locationNameToId).map(([name, id]) => [id, name])
              );
            }
          }
          this.dataPackageReady = true;
          if (this.slotData) this._scoutShopLocations(); // Connected may have already happened
          break;
        }
        case "ConnectionRefused":
          log("Connection refused: " + JSON.stringify(packet.errors));
          break;
        case "Connected":
          this.connected = true;
          this.team = packet.team;
          this.slot = packet.slot;
          this.checkedLocationIds = new Set(packet.checked_locations);
          this.slotData = packet.slot_data || {};
          this.players = packet.players || [];
          this.slotInfo = packet.slot_info || {};
          log("Connected as slot " + packet.slot + ".");
          this._loadReceivedIndex();
          this.onConnected(this.slotData, this.checkedLocationIds);
          this._send({ cmd: "StatusUpdate", status: 20 }); // CLIENT_PLAYING
          if (this.dataPackageReady) this._scoutShopLocations(); // DataPackage may have already arrived
          // Restore cash from server-side data storage (so it survives a disconnect/reload,
          // since it otherwise only lives in the page's in-memory game.ldat.csh.v), and keep
          // pushing local changes to it periodically so it stays backed up while playing.
          this._send({ cmd: "Get", keys: [this._cashKey(), this._areasKey()] });
          this._send({ cmd: "SetNotify", keys: [this._cashKey(), this._areasKey()] });
          // The periodic push deliberately does NOT start here. On a fresh connection the local
          // save has just been wiped (cash back to 1, no areas), so a tick landing before the
          // Get response would "replace" the server's stored cash with 1 and destroy it. Start
          // syncing only once the server's values are in hand -- see the Retrieved case.
          break;
        case "Retrieved":
          if (packet.keys) {
            const storedCash = packet.keys[this._cashKey()];
            if (storedCash !== null && storedCash !== undefined) {
              this.lastSyncedCash = storedCash;
              this.onCashRestored(storedCash);
            }
            const storedAreas = packet.keys[this._areasKey()];
            if (storedAreas !== null && storedAreas !== undefined) {
              this.lastSyncedAreas = storedAreas;
              this.onAreasRestored(storedAreas);
            }
            this._startStateSync();
          }
          break;
        case "SetReply":
          if (packet.key === this._cashKey()) {
            this.lastSyncedCash = packet.value;
            this.onCashRestored(packet.value);
          } else if (packet.key === this._areasKey()) {
            this.lastSyncedAreas = packet.value;
            this.onAreasRestored(packet.value);
          }
          break;
        case "LocationInfo":
          this._handleLocationInfo(packet.locations);
          break;
        case "ReceivedItems":
          this._handleReceivedItems(packet);
          break;
        case "RoomUpdate":
          if (packet.checked_locations) {
            const fresh = new Set();
            for (const id of packet.checked_locations) {
              if (!this.checkedLocationIds.has(id)) fresh.add(id);
              this.checkedLocationIds.add(id);
            }
            if (fresh.size > 0) this.onCheckedLocationsUpdated(fresh);
          }
          break;
        case "PrintJSON":
          log(packet.data.map((part) => part.text || "").join(""));
          break;
        default:
          break;
      }
    }

    // Archipelago replays the FULL item history from index 0 on every fresh connection (not
    // just the first one) -- there is no "resume from where I left off" on the wire. That's
    // fine for idempotent effects (setting a progressive tier directly is safe to redo), but
    // additive effects (granting cash, adjusting the round timer) must only ever be applied
    // once per item. So we keep two different kinds of state:
    //   - this.allReceivedItemNames: the full history as understood so far, rebuilt fresh from
    //     whatever the server sends -- used to recompute progressive tiers from scratch, safe
    //     to over-process.
    //   - this.lastAdditiveIndex (persisted in localStorage, since a page reload opens a brand
    //     new connection that will replay everything again): how much of that history has
    //     already had its ADDITIVE effects (coin bundles, time traps) applied.
    _loadReceivedIndex() {
      const raw = localStorage.getItem(this.storageKey + "_lastAdditiveIndex");
      this.lastAdditiveIndex = raw ? parseInt(raw, 10) : 0;
      this.allReceivedItemNames = [];
    }

    _saveReceivedIndex() {
      localStorage.setItem(this.storageKey + "_lastAdditiveIndex", String(this.lastAdditiveIndex));
    }

    _handleReceivedItems(packet) {
      if (packet.index === 0) this.allReceivedItemNames = [];
      const ownItemNames = this.itemIdToNameByGame[GAME_NAME] || {};
      for (let i = 0; i < packet.items.length; i++) {
        const absoluteIndex = packet.index + i;
        const name = ownItemNames[packet.items[i].item] || String(packet.items[i].item);
        this.allReceivedItemNames[absoluteIndex] = name;
      }
      const newAdditiveNames = [];
      for (let i = this.lastAdditiveIndex; i < this.allReceivedItemNames.length; i++) {
        newAdditiveNames.push(this.allReceivedItemNames[i]);
      }
      this.lastAdditiveIndex = this.allReceivedItemNames.length;
      this._saveReceivedIndex();
      this.onItemsReceived(this.allReceivedItemNames, newAdditiveNames);
    }

    // Scout every not-yet-checked shop location up front (rather than one at a time as the
    // player buys through a track) so the shop UI already has a name to show as soon as it's
    // built, instead of racing a LocationScouts round trip on every purchase. Only called once
    // both the (all-games) DataPackage and the Connected packet's slot_data have arrived, so
    // item names are resolvable as soon as the LocationInfo response comes back.
    _scoutShopLocations() {
      const shopPrices = this.slotData && this.slotData.shop_prices;
      if (!shopPrices) return;
      const ids = [];
      for (const [track, prices] of Object.entries(shopPrices)) {
        for (let tier = 1; tier <= prices.length; tier++) {
          const name = "Shop: " + track + " Tier " + tier;
          if (this.isLocationChecked(name)) continue;
          const id = this.locationNameToId[name];
          if (id !== undefined) ids.push(id);
        }
      }
      if (ids.length > 0) this._send({ cmd: "LocationScouts", locations: ids });
    }

    _handleLocationInfo(networkItems) {
      let changed = false;
      for (const info of networkItems) {
        const locationName = this.locationIdToName[info.location];
        if (!locationName) continue;
        const receivingPlayer = this.players.find((p) => p.slot === info.player);
        const receivingGame = this.slotInfo[info.player] ? this.slotInfo[info.player].game : null;
        const itemNames = receivingGame ? this.itemIdToNameByGame[receivingGame] : null;
        const itemName = (itemNames && itemNames[info.item]) || "Item #" + info.item;
        const isOwnItem = info.player === this.slot;
        this.scoutedItemDisplay[locationName] = isOwnItem
          ? itemName
          : itemName + " (" + (receivingPlayer ? receivingPlayer.alias : "P" + info.player) + ")";
        changed = true;
      }
      if (changed) this.onScoutsUpdated();
    }

    checkLocation(locationName) {
      if (!this.connected) return; // hooks stay installed but idle while disconnected
      const id = this.locationNameToId[locationName];
      if (id === undefined) {
        log("Unknown location name (data package not loaded yet?): " + locationName);
        return;
      }
      if (this.checkedLocationIds.has(id)) return; // already checked, don't resend needlessly
      this.checkedLocationIds.add(id);
      this._send({ cmd: "LocationChecks", locations: [id] });
      this.onOwnCheckSent(locationName);
    }

    isLocationChecked(locationName) {
      const id = this.locationNameToId[locationName];
      return id !== undefined && this.checkedLocationIds.has(id);
    }

    sendGoalComplete() {
      this._send({ cmd: "StatusUpdate", status: 30 }); // CLIENT_GOAL
    }
  }

  const ap = new ArchipelagoClient();

  // ---------------------------------------------------------------------------------------
  // Progressive item / filler application onto game.ldat.
  // ---------------------------------------------------------------------------------------
  const receivedCounts = {}; // item name -> total count received so far (for progressive tracks)
  // Additive items waiting on the game to finish loading. NOTE: lastAdditiveIndex is persisted
  // (and advanced) as soon as a packet is processed, regardless of whether the game exists yet
  // -- so if the page is closed/reloaded in the small window before waitForGameThenInstall
  // fires, anything still sitting in this queue is lost rather than re-granted on reconnect.
  // Low-probability given the game usually loads within a couple seconds, but a known gap.
  let pendingAdditiveNames = [];

  // Hooks are installed exactly once (see hooksInstalled), so this has to live out here rather
  // than inside installHooks() -- otherwise it would stay true across a disconnect and a later
  // session could never report its goal.
  let goalSent = false;

  // Rebuild every progressive tier from the FULL item history (safe to call repeatedly, e.g.
  // once per ReceivedItems packet including replays after a reconnect) since setting `.v`
  // directly is idempotent.
  function rebuildProgressiveState(allNames) {
    if (!window.game || !window.game.ldat) return;
    const ldat = window.game.ldat;
    const counts = {};
    for (const name of allNames) {
      if (name === undefined) continue; // sparse slot never filled (shouldn't normally happen)
      counts[name] = (counts[name] || 0) + 1;
    }
    for (const [name, field] of Object.entries(UPGRADE_FIELD_BY_ITEM)) {
      const count = counts[name] || 0;
      if (count !== receivedCounts[name]) log("Set " + field + " to tier " + count + " (" + name + ")");
      receivedCounts[name] = count;
      // Energy is the one track with a nonzero vanilla baseline: iniLdat starts nrg.v at 0.1,
      // i.e. one heart, and the shop ladder counts up from there. Setting it to count * 0.1
      // would mean 0 items = 0 hearts and 1 item = 1 heart -- and 1 heart still dies to the
      // first hit (killSprite destroys the sprite once nrg.length hits 0). Logic requires
      // 2 hearts for the damage-boost routes, so that off-by-one would make every route the
      // generator thinks is open with 1 Progressive Energy actually impossible.
      ldat[field].v = (field === "nrg" ? count + 1 : count) * 0.1;
    }
    const doubleJumpCount = counts["Double Jump"] || 0;
    if (doubleJumpCount > 0 && ldat.jmp2.v === 0) log("Double Jump unlocked.");
    ldat.jmp2.v = doubleJumpCount > 0 ? 0.1 : 0;
    receivedCounts["Double Jump"] = doubleJumpCount;
    // `jumpMax` (the actual cap on jumps-before-landing, checked as `sprt.ju < jumpMax`) is
    // NOT read live from ldat.jmp2.v -- it's a snapshot taken once in the Level state's
    // create(), so receiving Double Jump mid-round previously had no effect until the next
    // round started. Set the live global directly so it takes effect immediately.
    if (typeof window.jumpMax !== "undefined") window.jumpMax = doubleJumpCount > 0 ? 2 : 1;
    renderStatus();
  }

  // dsp.cns (the in-level cash HUD text) only exists while a round is actually active -- it's
  // created fresh each time a level starts and doesn't exist in the shop/title screens, so this
  // must stay guarded rather than called unconditionally.
  function refreshCoinDisplay() {
    if (window.dsp && window.dsp.cns && typeof window.updateCoinTxt === "function") {
      window.updateCoinTxt();
    }
  }

  // Additive items (grant cash / adjust the live round timer) -- must only ever run once per
  // item, unlike the progressive tiers above.
  function applyAdditiveItems(names) {
    for (const name of names) applyAdditiveItem(name);
  }

  function applyAdditiveItem(name) {
    if (!window.game || !window.game.ldat) {
      pendingAdditiveNames.push(name);
      return;
    }
    const ldat = window.game.ldat;

    if (name in COIN_BUNDLE_DEFAULT_VALUES) {
      const base = (ap.slotData && ap.slotData.coin_bundle_values && ap.slotData.coin_bundle_values[name]) ||
        COIN_BUNDLE_DEFAULT_VALUES[name];
      const multiplierTier = receivedCounts["Progressive Coin Multiplier"] || 0;
      const amount = base * (1 + 0.5 * multiplierTier);
      ldat.csh.v += amount;
      refreshCoinDisplay();
      log("Received " + name + ": +" + amount.toFixed(0) + " cash");
      return;
    }

    if (name === "Bonus Time (+5s)") {
      if (typeof window.tim === "number") window.tim += 5;
      log("Bonus Time: +5s");
      return;
    }

    if (name === "Trap Time (-5s)") {
      if (typeof window.tim === "number") window.tim = Math.max(0, window.tim - 5);
      log("Trap Time: -5s");
      return;
    }

    if (!(name in UPGRADE_FIELD_BY_ITEM) && name !== "Double Jump") {
      log("Don't know how to apply item: " + name);
    }
  }

  // ---------------------------------------------------------------------------------------
  // Passive income backstop: without this, a player who has spent all their cash and hasn't
  // yet received a Coin Bundle item (map coins no longer pay out directly) has no way to ever
  // afford another shop purchase -- a real softlock risk. Grants a configurable amount of cash
  // per configurable number of cumulative seconds of actual round playtime -- both read from
  // the player's own YAML options via slot_data ("Passive Income Seconds Per Tick" and
  // "Passive Income Amount Per Tick", 1-10 each, defaults 3 and 1) -- tracked via
  // game.ldat.stats.t, which the game already increments once per frame during clockCode and
  // persists across rounds as part of its own local save.
  // ---------------------------------------------------------------------------------------
  const PASSIVE_INCOME_DEFAULT_SECONDS = 3; // fallback only, before slot_data has arrived
  const PASSIVE_INCOME_DEFAULT_AMOUNT = 1; // fallback only, before slot_data has arrived
  let passiveIncomeBaselineThreshold = null; // set on first check, so pre-existing playtime isn't retroactively paid out

  function passiveIncomeIntervalFrames() {
    const seconds = (ap.slotData && ap.slotData.passive_income_seconds) || PASSIVE_INCOME_DEFAULT_SECONDS;
    return seconds * 60;
  }

  function passiveIncomeAmount() {
    return (ap.slotData && ap.slotData.passive_income_amount) || PASSIVE_INCOME_DEFAULT_AMOUNT;
  }

  function grantPassiveIncomeIfDue() {
    if (!window.game || !window.game.ldat || !window.game.ldat.stats) return;
    const currentThreshold = Math.floor(window.game.ldat.stats.t / passiveIncomeIntervalFrames());
    if (passiveIncomeBaselineThreshold === null) {
      passiveIncomeBaselineThreshold = currentThreshold;
      return;
    }
    if (currentThreshold <= passiveIncomeBaselineThreshold) return;
    const intervalsElapsed = currentThreshold - passiveIncomeBaselineThreshold;
    passiveIncomeBaselineThreshold = currentThreshold;
    const multiplierTier = receivedCounts["Progressive Coin Multiplier"] || 0;
    window.game.ldat.csh.v += passiveIncomeAmount() * intervalsElapsed * (1 + 0.5 * multiplierTier);
    refreshCoinDisplay();
  }

  // ---------------------------------------------------------------------------------------
  // Game hooks. We wait for the Phaser `game` global (and its `ldat`, set up once a round
  // starts) before patching, since the game's own <script> tags must run first to define these
  // as plain globals.
  // ---------------------------------------------------------------------------------------
  function coinLocationName(index) {
    return "Coin " + (index + 1);
  }
  function robotLocationName(index) {
    return "Robot " + (index + 1);
  }

  let hooksInstalled = false;

  function installHooks() {
    if (hooksInstalled) return; // installHooks() can now run again after a disconnect/reconnect
    // cycle on the same page load -- without this guard, every hook below would get wrapped a
    // second time (double-sent checks, double passive income, etc.) since each reinstall would
    // capture the ALREADY-wrapped function as its "original".
    hooksInstalled = true;

    const originalIniLevel = window.iniLevel;
    window.iniLevel = function () {
      originalIniLevel.apply(this, arguments);
      filterAlreadyCheckedSpawns();
    };

    const originalClockCode = window.clockCode;
    window.clockCode = function () {
      originalClockCode.apply(this, arguments);
      grantPassiveIncomeIfDue();
    };

    // addITM renders one shop panel per upgrade track. Two problems to fix here:
    //  1. It computes both the shown price AND the "level: X/Y" text from `levl.v`, which our
    //     shopBtnPress hook deliberately keeps frozen at the AP-driven value (see below) --
    //     without correction the shop would show the same price/tier forever. We temporarily
    //     feed it the REAL next-unchecked-tier index (derived from server-authoritative checked
    //     state, same pattern as everywhere else) just for this call, then restore afterward.
    //  2. The panel's upgrade name ("MULTIPLIER", "GUN POWER", ...) is baked into the
    //     `sheetShopPanelDesktop/Mobile` sprite-sheet frame image, not settable text -- so we
    //     can't replace it directly. Instead we add a small text overlay on top of the panel
    //     showing the scouted item this location actually sends. Exact positioning is a first
    //     guess (txt1/txt2 in vanilla sit right-aligned at x=622; this uses the left side) and
    //     will likely need visual tweaking once seen in the real browser layout.
    const originalAddITM = window.addITM;
    window.addITM = function (nam, dsc, levl, priceArr) {
      const track = SHOP_DISPLAY_TO_TRACK_NAME[nam];
      if (!track || !priceArr || priceArr.length === 0) {
        originalAddITM.apply(this, arguments);
        return;
      }
      const maxTier = priceArr.length;
      const nextTier = nextUncheckedShopTier(track, maxTier); // 1-based, or null if all bought
      const displayIndex = nextTier === null ? maxTier : nextTier - 1; // matches Math.round(v*10)
      const savedV = levl.v;
      levl.v = displayIndex * 0.1;
      const panelY = window.shopObj ? window.shopObj.yy : null;
      originalAddITM.apply(this, arguments);
      levl.v = savedV;

      if (window.shopObj && panelY !== null && window.game) {
        const label = ap.scoutedItemDisplay["Shop: " + track + " Tier " + (nextTier || maxTier)] || "...";
        const overlay = window.game.add.text(10, panelY + 8, label, {
          font: "14px monospace",
          fill: "#FFEE88",
          backgroundColor: "rgba(0,0,0,0.85)",
          wordWrap: true,
          wordWrapWidth: 300,
          padding: { x: 4, y: 2 },
        });
        window.shopObj.dsp.add(overlay);
      }
    };

    const originalCoinCode = window.coinCode;
    window.coinCode = function () {
      const before = window.coins ? window.coins.slice() : [];
      const cashBefore = window.game && window.game.ldat ? window.game.ldat.csh.v : null;
      originalCoinCode.apply(this, arguments);
      // Vanilla coinCode grants local cash per coin (`csh.v += 1 + multi.v*5`) AND refreshes the
      // in-level cash HUD text (updateCoinTxt) using that inflated value, before we get a
      // chance to revert it -- per the agreed design, map coins are pure location checks now
      // and grant no local cash (cash instead comes only from received Coin Bundle items and
      // passive income), so revert the value and refresh the HUD again to match.
      if (cashBefore !== null) {
        window.game.ldat.csh.v = cashBefore;
        refreshCoinDisplay();
      }
      const after = window.coins || [];
      if (after.length < before.length) {
        for (const c of before) {
          if (after.indexOf(c) === -1 && c.__apIndex !== undefined) {
            ap.checkLocation(coinLocationName(c.__apIndex));
          }
        }
      }
    };

    const originalKillEnemy = window.killEnemy;
    window.killEnemy = function (e, b) {
      originalKillEnemy.apply(this, arguments);
      if (e && e.robot && e.__apIndex !== undefined) {
        ap.checkLocation(robotLocationName(e.__apIndex));
      }
    };

    const originalColgunCode = window.colgunCode;
    window.colgunCode = function () {
      const before = window.game && window.game.ldat ? window.game.ldat.wpn.v : 0;
      originalColgunCode.apply(this, arguments);
      const after = window.game && window.game.ldat ? window.game.ldat.wpn.v : 0;
      if (!before && after) ap.checkLocation("Find the Gun");
    };

    const originalShopBtnPress = window.shopBtnPress;
    window.shopBtnPress = function (e) {
      const track = shopTrackNameFromItem(e);
      const lvlBefore = e && e.lvl ? e.lvl.v : null;
      originalShopBtnPress.apply(this, arguments);
      if (track && lvlBefore !== null) {
        // Vanilla shopBtnPress advances e.lvl.v itself -- per the agreed design, only received
        // Progressive items should move this (see rebuildProgressiveState), so revert it and
        // instead derive "which tier was just bought" from server-authoritative checked state,
        // the same pattern used for coins/enemies. This also means re-clicking an
        // already-checked tier (e.g. after a page reload) is a harmless no-op.
        e.lvl.v = lvlBefore;
        const maxTier = (ap.slotData && ap.slotData.upgrade_track_tiers && ap.slotData.upgrade_track_tiers[track]) || 1;
        const tier = nextUncheckedShopTier(track, maxTier);
        if (tier !== null) ap.checkLocation("Shop: " + track + " Tier " + tier);
      }
    };

    const originalBossHit = window.bossHit;
    window.bossHit = function (p) {
      originalBossHit.apply(this, arguments);
      if (!goalSent && window.boss && window.boss.nrg <= 0) {
        goalSent = true;
        ap.sendGoalComplete();
        log("Boss defeated -- goal complete!");
      }
    };

    // Apply whatever state we already know about now that the game (and game.ldat) exists.
    rebuildProgressiveState(ap.allReceivedItemNames || []); // also calls renderStatus()
    if (pendingAdditiveNames.length > 0) {
      applyAdditiveItems(pendingAdditiveNames);
      pendingAdditiveNames = [];
    }
    filterAlreadyCheckedSpawns();
    renderStatus();

    log("Game hooks installed.");
  }

  // Map a shop UI element back to its upgrade track's Archipelago-facing name. shop.js's addITM
  // is called once per track with the display name ("Speed", "Jump Power", ...); we match on
  // that display name since it's stored on the item entry.
  const SHOP_DISPLAY_TO_TRACK_NAME = {
    Speed: "Progressive Speed",
    "Jump Power": "Progressive Jump Power",
    "Double Jump": "Double Jump",
    "Time Limit": "Progressive Time Limit",
    Energy: "Progressive Energy",
    Ammo: "Progressive Ammo",
    "Gun Power": "Progressive Gun Power",
    Multiplier: "Progressive Coin Multiplier",
  };
  // NOTE: shop.js stores the display name on the button as `.itm` (set via `bg.itm = nam` in
  // addITM), not `.nam`. Also worth flagging: addITM gates the "Double Jump" button on
  // `getXP() >= price` (XP derived from `game.ldat.ars`) instead of the cash check every other
  // track uses -- that resource was not reverse engineered here. Since Double Jump isn't
  // required by any current logic rule, this is left as a caveat rather than solved.
  function shopTrackNameFromItem(e) {
    return e && e.itm ? SHOP_DISPLAY_TO_TRACK_NAME[e.itm] || null : null;
  }

  function nextUncheckedShopTier(track, maxTier) {
    for (let n = 1; n <= maxTier; n++) {
      if (!ap.isLocationChecked("Shop: " + track + " Tier " + n)) return n;
    }
    return null; // every tier for this track has already been checked
  }

  // ---------------------------------------------------------------------------------------
  // Status panel: shows the two things that can genuinely diverge -- how many of each upgrade
  // you've actually RECEIVED (drives real in-game ability) vs. how many shop tiers you've
  // PURCHASED (i.e. checked -- just sends items elsewhere, doesn't grant the ability itself).
  // ---------------------------------------------------------------------------------------
  const TRACK_DISPLAY_ORDER = [
    ["Progressive Speed", "Speed"],
    ["Progressive Jump Power", "Jump Power"],
    ["Double Jump", "Double Jump"],
    ["Progressive Time Limit", "Time Limit"],
    ["Progressive Energy", "Energy"],
    ["Progressive Ammo", "Ammo"],
    ["Progressive Gun Power", "Gun Power"],
    ["Progressive Coin Multiplier", "Coin Multiplier"],
  ];

  function maxTierFor(itemName) {
    if (itemName === "Double Jump") return 1;
    return (ap.slotData && ap.slotData.upgrade_track_tiers && ap.slotData.upgrade_track_tiers[itemName]) || 1;
  }

  function shopPurchasedCount(track, maxTier) {
    let count = 0;
    for (let n = 1; n <= maxTier; n++) {
      if (ap.isLocationChecked("Shop: " + track + " Tier " + n)) count++;
    }
    return count;
  }

  function renderStatus() {
    const upgradesEl = document.getElementById("ap-ju-upgrades");
    const shopEl = document.getElementById("ap-ju-shop");
    if (!upgradesEl || !shopEl) return;
    const upgradeLines = [];
    const shopLines = [];
    for (const [itemName, label] of TRACK_DISPLAY_ORDER) {
      const maxTier = maxTierFor(itemName);
      const received = itemName === "Double Jump" ? (receivedCounts[itemName] > 0 ? 1 : 0) : receivedCounts[itemName] || 0;
      upgradeLines.push(label + ": " + received + "/" + maxTier);
      shopLines.push(label + ": " + shopPurchasedCount(itemName, maxTier) + "/" + maxTier);
    }
    upgradesEl.textContent = upgradeLines.join("\n");
    shopEl.textContent = shopLines.join("\n");
  }

  // Tag each coin/robot sprite with its original array index (needed since coinCode/killEnemy
  // only give us the sprite object, not its index), then remove any whose location has already
  // been checked so it never spawns in for a player who already has that check.
  function filterAlreadyCheckedSpawns() {
    if (Array.isArray(window.coins)) {
      window.coins.forEach((c, i) => {
        c.__apIndex = i;
      });
      if (ap.slotData && ap.slotData.coinsanity) {
        // filter() alone only stops these from being hit-tested again -- the sprite was already
        // added to the display list by iniLevel's isprt.create(), so it keeps rendering unless
        // we also destroy() it here.
        const toRemove = window.coins.filter((c) => ap.isLocationChecked(coinLocationName(c.__apIndex)));
        window.coins = window.coins.filter((c) => !ap.isLocationChecked(coinLocationName(c.__apIndex)));
        for (const c of toRemove) c.destroy();
      }
    }
    if (Array.isArray(window.enes)) {
      let robotOrdinal = 0;
      window.enes.forEach((e) => {
        if (e.robot) {
          e.__apIndex = robotOrdinal;
          robotOrdinal++;
        }
      });
      if (ap.slotData && ap.slotData.enemysanity) {
        const toRemove = window.enes.filter(
          (e) => e.robot && ap.isLocationChecked(robotLocationName(e.__apIndex))
        );
        for (const e of toRemove) {
          const ci = window.enes.indexOf(e);
          if (ci !== -1) window.enes.splice(ci, 1);
          const si = window.spikes ? window.spikes.indexOf(e) : -1;
          if (si !== -1) window.spikes.splice(si, 1);
          e.destroy();
        }
      }
    }
    if (window.sprt && window.sprt.colGun && ap.isLocationChecked("Find the Gun")) {
      window.sprt.colGun.destroy();
      window.sprt.colGun = null;
      if (window.game && window.game.ldat) window.game.ldat.wpn.v = 0.1;
    }
  }

  function waitForGameThenInstall() {
    if (
      window.game &&
      window.iniLevel &&
      window.coinCode &&
      window.killEnemy &&
      window.shopBtnPress &&
      window.colgunCode &&
      window.bossHit &&
      window.addITM &&
      window.clockCode
    ) {
      installHooks();
    } else {
      setTimeout(waitForGameThenInstall, 200);
    }
  }

  // ---------------------------------------------------------------------------------------
  // Wire up UI. The Connect button doubles as Disconnect once connected -- previously clicking
  // it again while already connected just opened a second, uncoordinated WebSocket without
  // tearing down the first, which is exactly the kind of thing ArchipelagoClient.connect() now
  // guards against too (it calls disconnect() on any existing socket before opening a new one).
  // ---------------------------------------------------------------------------------------
  function setConnectButtonState(connected) {
    const btn = document.getElementById("ap-ju-connect");
    btn.textContent = connected ? "Disconnect" : "Connect";
    for (const id of ["ap-ju-server", "ap-ju-slot", "ap-ju-password"]) {
      document.getElementById(id).disabled = connected;
    }
  }

  ap.getLocalCash = () => (window.game && window.game.ldat ? window.game.ldat.csh.v : null);

  // game.ldat.ars is a sparse array indexed by the map's area order (areaCode does
  // `ldat.ars[areas.indexOf(area)] = 1`), so a bitmask over those indices is a faithful and
  // compact representation -- and it lets the server merge sessions with a bitwise "or".
  ap.getLocalAreas = () => {
    if (!window.game || !window.game.ldat || !window.game.ldat.ars) return null;
    const ars = window.game.ldat.ars;
    let mask = 0;
    for (let i = 0; i < ars.length && i < 31; i++) if (ars[i]) mask |= 1 << i;
    return mask;
  };
  ap.onAreasRestored = (mask) => {
    if (!window.game || !window.game.ldat || !mask) return;
    const ars = window.game.ldat.ars || (window.game.ldat.ars = []);
    let restored = 0;
    for (let i = 0; i < 31; i++) {
      if (mask & (1 << i)) {
        if (!ars[i]) restored++;
        ars[i] = 1;
      }
    }
    if (restored > 0) {
      // getXP() is n*n*5 over this array, so report the EXP the restore is actually worth.
      let n = 0;
      for (let i = 0; i < ars.length; i++) if (ars[i]) n++;
      log("Restored " + restored + " visited area(s) from server (EXP now " + n * n * 5 + ")");
      if (typeof window.saveStats === "function") window.saveStats();
    }
  };
  ap.onCashRestored = (amount) => {
    if (window.game && window.game.ldat) {
      window.game.ldat.csh.v = amount;
      refreshCoinDisplay();
      log("Restored cash from server: " + amount);
    }
  };
  ap.onConnected = () => {
    waitForGameThenInstall();
    setConnectButtonState(true);
    renderStatus();
  };
  // Wipe the local save completely. All authoritative state lives on the server (items drive
  // every upgrade tier, checked locations drive the gun and which pickups still exist, and cash
  // is mirrored to DataStorage under _cashKey), so a disconnected client should hold nothing.
  //
  // This reuses the game's own reset -- title.js's confirm-reset button runs exactly
  // `iniLdat(); saveStats(); newState();` -- rather than clearing fields by hand. Hand-clearing
  // is what left cash, wpn (gun found), ars (visited areas, which price Double Jump in EXP) and
  // stats.t (accumulated playtime, which drives passive income) behind, and it would drift from
  // vanilla's defaults over time. iniLdat() rebuilds ldat from scratch and saveStats() overwrites
  // the persisted copy, so nothing survives a page reload either.
  function resetGameSave() {
    if (typeof window.iniLdat === "function") {
      window.iniLdat();
      if (typeof window.saveStats === "function") window.saveStats();
    } else if (window.game && window.game.ldat) {
      // Fallback for the window before the game's own script has defined iniLdat.
      for (const field of Object.values(UPGRADE_FIELD_BY_ITEM)) window.game.ldat[field].v = 0;
      window.game.ldat.nrg.v = 0.1; // vanilla baseline: one heart, never zero
      window.game.ldat.jmp2.v = 0;
      window.game.ldat.wpn.v = 0;
      window.game.ldat.csh.v = 1;
      window.game.ldat.ars = [];
      window.game.ldat.stats = { t: 0, s: 0 };
    }
  }

  ap.onDisconnected = () => {
    setConnectButtonState(false);
    resetGameSave();

    // Client-side bookkeeping that shadows the wiped save has to go with it.
    for (const name of Object.keys(receivedCounts)) receivedCounts[name] = 0;
    pendingAdditiveNames = [];
    goalSent = false;
    // stats.t is back to 0, so a stale high baseline would suppress passive income until
    // playtime climbed past the old total. null makes it re-baseline on the next check.
    passiveIncomeBaselineThreshold = null;

    if (window.game && window.game.state) window.game.state.start("Title");
    renderStatus();
  };
  ap.onItemsReceived = (allNames, newAdditiveNames) => {
    rebuildProgressiveState(allNames); // also calls renderStatus()
    applyAdditiveItems(newAdditiveNames);
  };
  ap.onCheckedLocationsUpdated = () => {
    if (window.iniLevel) filterAlreadyCheckedSpawns();
    renderStatus();
  };
  ap.onOwnCheckSent = () => renderStatus();

  document.getElementById("ap-ju-connect").addEventListener("click", () => {
    if (ap.connected) {
      ap.disconnect();
      return;
    }
    const server = document.getElementById("ap-ju-server").value.trim();
    const slot = document.getElementById("ap-ju-slot").value.trim();
    const password = document.getElementById("ap-ju-password").value;
    if (!server || !slot) {
      log("Server and slot name are required.");
      return;
    }
    ap.connect(server, slot, password);
  });
})();
