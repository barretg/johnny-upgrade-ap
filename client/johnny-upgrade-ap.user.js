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
 * - Coin pickups (coinCode) depend on the coinsanity option. With it ON they are pure location
 *   checks and grant no cash, so cash comes only from received Coin Bundle items (scaled by the
 *   Progressive Coin Multiplier tier: csh.v += value * (1 + 0.5 * tier)) plus passive income.
 *   With it OFF the coins are not checks at all, so vanilla payout is left completely alone and
 *   cash comes from both sources.
 * - The gun is fully decoupled from its pickup. Vanilla colgunCode sets `game.ldat.wpn.v = 0.1`
 *   and calls getGun() on contact; here contact only sends the "Find the Gun" check, and being
 *   armed comes solely from receiving the Laser Gun item. That means both directions have to be
 *   handled explicitly, because iniLevel branches on `wpn.v` and does exactly one of the two:
 *     * armed but check not yet sent -> iniLevel would skip creating the pickup entirely, making
 *       the location unreachable. So the iniLevel hook forces `wpn.v = 0` across the original
 *       call to guarantee the pickup spawns, then re-arms afterwards.
 *     * check already sent but item not received -> the pickup must not come back, and Johnny
 *       must stay unarmed. filterAlreadyCheckedSpawns() destroys it without arming.
 *   Since the badge no longer represents a gun you collect, its art is replaced with the
 *   Archipelago logo -- see installApGunSprite() and assets/make_gun_sprite.py.
 * - Shop purchases (shopBtnPress) are location-check triggers ONLY -- they no longer grant the
 *   upgrade tier themselves (that comes from receiving the matching Progressive item). See the
 *   design discussion in the apworld's rules.py/locations.py for why.
 * - Boss defeat is detected via bossHit() driving `boss.nrg` to <= 0 (boss.stp becomes 6).
 *
 * KNOWN GAPS / things that need verification against real play before trusting this fully:
 * - The exact boss combat requirement (how much Ammo/Gun Power is really needed) was not
 *   reverse engineered in depth -- see rules.py's placeholder goal rule.
 */

(function () {
  "use strict";

  const GAME_NAME = "Johnny Upgrade";
  const AP_VERSION = { major: 0, minor: 6, build: 0, class: "Version" };

  // How long a cash sync waits to coalesce a burst of shop purchases into a single delta.
  // Comfortably longer than rapid clicking, short enough that leaving the shop or closing the tab
  // right after buying still catches it.
  const CASH_SYNC_DEBOUNCE_MS = 500;

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
    '<span>Archipelago <span style="font-weight:normal;color:#889;font-size:10px;">(G to collapse, H to hide)</span></span>' +
    "<span id=\"ap-ju-toggle\">&#9660;</span></div>" +
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

  // "H" fully hides the panel (header and all), unlike the header click which just collapses the
  // body. Bound on window in the CAPTURE phase so it still works while the game canvas has focus,
  // and left to propagate afterwards since the game does nothing with H.
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "h" && e.key !== "H") return;
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      // Never swallow the letter while a field has focus, or the server address becomes untypable.
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      panel.style.display = panel.style.display === "none" ? "" : "none";
    },
    true
  );

  // "G" collapses the panel header. Bound on window in the CAPTURE phase so it still works while
  // the game canvas has focus, and left to propagate afterwards since the game does nothing with
  // G. (A listener on the header div itself never fires -- plain divs aren't keyboard-focusable.)
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "g" && e.key !== "G") return;
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      // Never swallow the letter while a field has focus, or the server address becomes untypable.
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      collapseHeader();
    },
    true
  );

  document.getElementById("ap-ju-header").addEventListener("click", () => {
    collapseHeader();
  });

  function collapseHeader() {
    const body = document.getElementById("ap-ju-body");
    const toggle = document.getElementById("ap-ju-toggle");
    const collapsed = body.style.display === "none";
    body.style.display = collapsed ? "" : "none";
    toggle.innerHTML = collapsed ? "&#9660;" : "&#9654;";
  }

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
      // Same for locations, across every game rather than just ours. Server messages talk about
      // other players' locations ("X found Y in Z"), so resolving those names needs more than our
      // own table.
      this.locationIdToNameByGame = {};
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
      if (this._cashSyncTimer) {
        clearTimeout(this._cashSyncTimer);
        this._cashSyncTimer = null;
      }
      this.locationNameToId = {};
      this.locationIdToName = {};
      this.itemIdToNameByGame = {};
      this.locationIdToNameByGame = {};
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

    // Push local cash to the server and adopt whatever total comes back.
    //
    // Cash is deliberately NOT part of the periodic sync, and is pushed as a DELTA rather than
    // written outright. Both of those are the fix for a real coin-eating race: the old code polled
    // every 2s with a "replace", and had SetNotify on its own key, so any cash the player earned
    // in the window between the server's value being read and the next poll could be overwritten
    // by an inbound SetReply carrying the older total. Coins would visibly vanish.
    //
    // "add" makes the server the ledger and this client a reporter of change, so a write can never
    // destroy value it did not know about. The baseline is the local total as of the previous
    // sync, so the delta naturally covers a whole round's earnings (coins, passive income, coin
    // bundle items) as well as shop spending, without having to instrument each of those sites.
    syncCash() {
      // A pending debounced sync is now redundant: the delta is computed from the live total, so
      // this call already covers whatever that one was scheduled for.
      if (this._cashSyncTimer) {
        clearTimeout(this._cashSyncTimer);
        this._cashSyncTimer = null;
      }
      if (!this.connected) return;
      const cash = this.getLocalCash();
      if (cash === null || this.lastSyncedCash === null) return;
      const delta = cash - this.lastSyncedCash;
      // want_reply gives back the authoritative post-add total, which is what the SetReply handler
      // then adopts locally -- that is the "pull" half of the sync.
      this._send({
        cmd: "Set",
        key: this._cashKey(),
        default: 0,
        want_reply: true,
        operations: [{ operation: "add", value: delta }],
      });
    }

    // Schedule a sync shortly from now, coalescing a burst of purchases into one packet.
    //
    // Deliberately NOT a resetting debounce: a call while one is already pending is dropped rather
    // than pushing the deadline back, so the sync still lands within CASH_SYNC_DEBOUNCE_MS of the
    // FIRST purchase in a burst. A resetting debounce would let someone buying steadily defer the
    // write indefinitely, which is the opposite of what this is for. Dropping the extra calls
    // loses nothing because syncCash reads the live total when it fires, so one packet carries the
    // whole burst's delta.
    syncCashSoon() {
      if (this._cashSyncTimer) return;
      this._cashSyncTimer = setTimeout(() => {
        this._cashSyncTimer = null;
        this.syncCash();
      }, CASH_SYNC_DEBOUNCE_MS);
    }

    _startStateSync() {
      if (this.stateSyncTimer) return;
      this.stateSyncTimer = setInterval(() => {
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
            this.locationIdToNameByGame[gameName] = Object.fromEntries(
              Object.entries(gameData.location_name_to_id).map(([name, id]) => [id, name])
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
          // SetNotify covers areas ONLY. Subscribing to the cash key meant every change echoed
          // back as a SetReply that was applied straight to game.ldat.csh.v, which is how cash
          // earned since the value was read got clobbered. Cash now changes locally only, and
          // reconciles with the server at the shop (see syncCash).
          this._send({ cmd: "SetNotify", keys: [this._areasKey()] });
          // The periodic push deliberately does NOT start here. On a fresh connection the local
          // save has just been wiped (cash back to 1, no areas), so a tick landing before the
          // Get response would push nonsense. Start syncing only once the server's values are in
          // hand -- see the Retrieved case.
          break;
        case "Retrieved":
          if (packet.keys) {
            const storedCash = packet.keys[this._cashKey()];
            if (typeof storedCash === "number") {
              this.lastSyncedCash = storedCash;
              this.onCashRestored(storedCash);
            } else {
              // Key has never been written (a brand-new slot): Get answers with null. Take 0 as
              // the baseline rather than leaving it unset, or syncCash would bail out forever and
              // this slot's cash would never reach the server at all. Local cash is left alone --
              // the first sync reports it as the delta from zero.
              this.lastSyncedCash = 0;
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
            // Only ever arrives in response to our own syncCash (the cash key is not in
            // SetNotify), so adopting it wholesale is safe: it is the post-add total that already
            // includes the delta we just reported.
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
          log(this._formatJSONMessage(packet.data));
          break;
        default:
          break;
      }
    }

    // Render a PrintJSON message for the log panel.
    //
    // The parts of a server message are NOT all plain text. For the interesting ones -- the item,
    // the location, the player -- `text` holds a numeric ID and `type` says what kind of ID it is,
    // with the name left to the client to look up from the data package. Simply concatenating
    // `text` (which is what this used to do) is why messages read like
    // "9990013 sent 9990001 to 1" instead of naming anything.
    //
    // IDs are only unique within a game, so item and location parts also carry `player`: the slot
    // whose game the ID belongs to. Resolving therefore goes ID -> that player's game -> that
    // game's table, which is why the data package is requested for every game rather than ours.
    _playerName(slot) {
      const player = this.players.find((p) => p.slot === slot);
      return (player && (player.alias || player.name)) || "Player " + slot;
    }

    _gameOfSlot(slot) {
      return this.slotInfo[slot] ? this.slotInfo[slot].game : null;
    }

    _itemNameFor(id, slot) {
      const game = this._gameOfSlot(slot);
      const names = game ? this.itemIdToNameByGame[game] : null;
      return (names && names[id]) || "Item #" + id;
    }

    _locationNameFor(id, slot) {
      const game = this._gameOfSlot(slot);
      const names = game ? this.locationIdToNameByGame[game] : null;
      return (names && names[id]) || "Location #" + id;
    }

    _formatJSONMessage(parts) {
      if (!Array.isArray(parts)) return "";
      return parts
        .map((part) => {
          const text = part.text === undefined || part.text === null ? "" : String(part.text);
          switch (part.type) {
            case "player_id":
              return this._playerName(parseInt(text, 10));
            case "item_id":
              return this._itemNameFor(parseInt(text, 10), part.player);
            case "location_id":
              return this._locationNameFor(parseInt(text, 10), part.player);
            // player_name / item_name / location_name / entrance_name / color / plain text all
            // already carry human-readable content in `text`.
            default:
              return text;
          }
        })
        .join("");
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

  function hasLaserGun() {
    return (receivedCounts["Laser Gun"] || 0) > 0;
  }

  // Load the armed sprite and turn the Ammo tiers into actual bullets. Safe to call whenever --
  // it no-ops outside a round and when already armed. (getGun itself is hooked in installHooks to
  // stop it clearing the pickup, so this doesn't have to worry about that.)
  function armGunIfNeeded() {
    if (typeof window.getGun !== "function") return;
    // dsp.ammo is created by addDSP() and only exists while a round is running; getGun() writes
    // to it unguarded, so calling this on the title/shop screen would throw.
    if (!window.sprt || !window.dsp || !window.dsp.ammo) return;
    if (window.sprt.ammo !== undefined) return; // already armed this round
    window.getGun();
  }

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
      // Two corrections here, both load-bearing:
      //
      // 1. Energy is the one track with a nonzero vanilla baseline: iniLdat starts nrg.v at 0.1,
      //    i.e. one heart, and the shop ladder counts up from there. Setting it to count * 0.1
      //    would mean 0 items = 0 hearts and 1 item = 1 heart -- and 1 heart still dies to the
      //    first hit (killSprite destroys the sprite once nrg.length hits 0). Logic requires
      //    2 hearts for the damage-boost routes, so that off-by-one would make every route the
      //    generator thinks is open with 1 Progressive Energy actually impossible.
      //
      // 2. Divide by 10 rather than multiplying by 0.1. They differ in binary floating point at
      //    tier 3 (3 * 0.1 = 0.30000000000000004), and iniNRG counts hearts with an unrounded
      //    `for (i = 0; i < nrg.v * 10; i++)`, so that value draws FOUR hearts instead of three.
      //    Vanilla has the same defect via its v += 0.1 accumulation; setting v directly lets us
      //    match the heart count the solver actually modelled.
      ldat[field].v = (field === "nrg" ? count + 1 : count) / 10;
    }
    // The Laser Gun is a plain unlock rather than a tier, and `wpn.v` drives two separate things:
    // whether the shop offers the Ammo / Gun Power tracks at all, and which branch iniLevel takes.
    // Keep it exactly in step with item ownership -- nothing else is allowed to set it any more.
    const hadGun = receivedCounts["Laser Gun"] > 0;
    const hasGun = (counts["Laser Gun"] || 0) > 0;
    receivedCounts["Laser Gun"] = counts["Laser Gun"] || 0;
    ldat.wpn.v = hasGun ? 0.1 : 0;
    if (hasGun && !hadGun) {
      log("Laser Gun received -- Ammo / Gun Power unlocked in the shop.");
      // Arm mid-round too: the current level was built on the unarmed branch, so sprt.ammo is
      // undefined and controls() would refuse to fire (`sprt.ammo && sprt.ammo > 0`) until the
      // next round otherwise.
      armGunIfNeeded();
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

  // The shop's own cash readout is a Phaser.Text built in ShopState.create and held in a local
  // var, so there is no handle on it -- but it is added to shopObj.dsp at a fixed position, which
  // is enough to find it again. Needed because the shop-entry sync resolves asynchronously, after
  // create() has already drawn the number.
  const SHOP_CASH_TEXT_POS = { x: 238, y: 21 };

  function refreshShopCashDisplay() {
    if (!window.shopObj || !window.shopObj.dsp || !window.game || !window.game.ldat) return;
    for (const child of window.shopObj.dsp.children || []) {
      if (
        child &&
        typeof child.setText === "function" &&
        child.x === SHOP_CASH_TEXT_POS.x &&
        child.y === SHOP_CASH_TEXT_POS.y
      ) {
        child.setText("$" + window.game.ldat.csh.v);
        return;
      }
    }
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

    // Double Jump and Laser Gun are unlocks applied from the full item history in
    // rebuildProgressiveState, not additively here -- so they are expected, not unknown.
    if (!(name in UPGRADE_FIELD_BY_ITEM) && name !== "Double Jump" && name !== "Laser Gun") {
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

    // Swap the pickup art before any level can build its sprite from the cache.
    installApGunSprite();

    // getGun() opens with `sprt.colGun = null`, because in vanilla the only route into it is
    // having just collected the pickup. Here the pickup is an independent location that is very
    // often still uncollected when the Laser Gun item arrives, and colgunCode early-returns on a
    // null colGun -- so an unguarded getGun() would leave the pickup sprite sitting on screen,
    // permanently uncollectable. Hooking getGun rather than each caller matters: the Level state's
    // create() calls it AGAIN right after iniLevel() (`if (game.ldat.wpn.v) { getGun(); }`), so
    // fixing it up around our own call site alone would still be undone a moment later.
    const originalGetGun = window.getGun;
    window.getGun = function () {
      const pickup = window.sprt ? window.sprt.colGun : null;
      originalGetGun.apply(this, arguments);
      if (window.sprt && pickup && pickup.game) window.sprt.colGun = pickup;
    };

    // iniLevel does `if (!game.ldat.wpn.v) { create the colGun pickup } else { getGun() }` -- one
    // or the other, never both. Since owning the Laser Gun item no longer implies having collected
    // the pickup, an armed player would otherwise never see it again and "Find the Gun" would be
    // permanently unreachable. Force the pickup branch for the original call, then re-arm.
    const originalIniLevel = window.iniLevel;
    window.iniLevel = function () {
      const ldat = window.game ? window.game.ldat : null;
      const savedWpn = ldat ? ldat.wpn.v : null;
      if (ldat) ldat.wpn.v = 0;
      try {
        originalIniLevel.apply(this, arguments);
      } finally {
        if (ldat) ldat.wpn.v = savedWpn;
      }
      if (hasLaserGun()) armGunIfNeeded();
      filterAlreadyCheckedSpawns();
    };

    // Cash reconciles with the server at the shop and nowhere else: on entering, on each purchase
    // (debounced), and on leaving. What all three have in common is that none of them happen
    // during a round -- and a round is exactly the window in which cash is earned while nothing
    // needs the server's opinion of it. Keeping the server out of it until the player comes back
    // to spend is what removes the race, because there is no longer any moment where an inbound
    // total can land on top of coins just picked up. See ArchipelagoClient.syncCash for the delta
    // scheme that makes this safe.
    //
    // Runs AFTER the original create, so the reported total is the one the shop is actually
    // showing: ShopState.create opens by flooring csh.v, and syncing first would push the
    // fractional part and then immediately drift by the rounding.
    const originalShopCreate = window.ShopState.create;
    window.ShopState.create = function () {
      originalShopCreate.apply(this, arguments);
      ap.syncCash();
    };

    // Flush on the way out too, so a session that ends in the shop (tab closed, disconnect) does
    // not leave the last visit's spending unreported -- otherwise the server still holds the
    // pre-purchase total and the player gets their cash back while keeping the checks they bought.
    // Immediate rather than debounced: this is the last chance to report.
    const originalShopLeave = window.shopLeave;
    window.shopLeave = function () {
      originalShopLeave.apply(this, arguments);
      ap.syncCash();
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
    //  2. The panel's upgrade name+description ("SPEED / increases your running speed!", ...)
    //     is baked into the `sheetShopPanelDesktop/Mobile` sprite-sheet frame image, not settable
    //     text -- so we can't replace it directly. Instead we paint a black rect over that part
    //     of the panel and put the scouted item name on top of it. Panel frames are 620x55,
    //     placed at bg.x=90; the icon occupies local x=[0,48]. Vanilla's dynamic txt1/txt2
    //     (level/price) are anchored right at local x=622 but the text itself runs LEFTWARD from
    //     there (anchor.setTo(1,0)) and can be ~150-180px wide ("level: 10/24 "), so the cover
    //     must stop well short of x=622 -- it only spans local x=[48,440], the name+description
    //     area, leaving the level/price column untouched.
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
        const panelX = 90;
        const coverX = panelX + 48;
        const coverW = 440 - 48;
        const cover = window.game.add.graphics(coverX, panelY);
        cover.beginFill(0x000000, 0.85);
        cover.drawRect(0, 0, coverW, 55);
        cover.endFill();
        window.shopObj.dsp.add(cover);
        const overlay = window.game.add.text(coverX + 6, panelY + 8, label, {
          font: "14px monospace",
          fill: "#FFEE88",
          wordWrap: true,
          wordWrapWidth: coverW - 12,
        });
        window.shopObj.dsp.add(overlay);
      }
    };

    const originalCoinCode = window.coinCode;
    window.coinCode = function () {
      // With coinsanity OFF the coins are not checks, so there is no reason to take their payout
      // away -- let vanilla behave exactly as it always did (csh.v += 1 + multi.v*5, HUD refresh,
      // fly-away animation). Cash then comes from BOTH map coins and received Coin Bundles.
      if (!(ap.slotData && ap.slotData.coinsanity)) {
        originalCoinCode.apply(this, arguments);
        return;
      }

      const before = window.coins ? window.coins.slice() : [];
      const cashBefore = window.game && window.game.ldat ? window.game.ldat.csh.v : null;
      originalCoinCode.apply(this, arguments);
      // Vanilla coinCode grants local cash per coin AND refreshes the in-level cash HUD text
      // (updateCoinTxt) using that inflated value before we get a chance to revert it. With
      // coinsanity ON map coins are pure location checks, so revert the value and refresh the
      // HUD again to match.
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

    // Replaced outright rather than wrapped. Vanilla's body is
    //   `if (!sprt.colGun) return;
    //    if (!sprt.dd && sprtHitTest(sprt.colGun)) { fxPlay(sfx.fxFanfare); game.ldat.wpn.v = 0.1;
    //                                               sprt.colGun.destroy(); getGun(); }`
    // and the last two thirds of that -- arming Johnny -- is exactly what must no longer happen on
    // contact. Wrapping it would mean letting getGun() run and then trying to unwind a texture
    // swap mid-round; reproducing the four-line hit test is both shorter and far less fragile.
    window.colgunCode = function () {
      const sprt = window.sprt;
      if (!sprt || !sprt.colGun) return;
      if (sprt.dd || !window.sprtHitTest(sprt.colGun)) return;
      if (typeof window.fxPlay === "function" && window.sfx) window.fxPlay(window.sfx.fxFanfare);
      sprt.colGun.destroy();
      sprt.colGun = null;
      ap.checkLocation("Find the Gun");
    };

    const originalShopBtnPress = window.shopBtnPress;
    window.shopBtnPress = function (e) {
      const track = shopTrackNameFromItem(e);
      const lvlBefore = e && e.lvl ? e.lvl.v : null;
      const cashBefore = window.game && window.game.ldat ? window.game.ldat.csh.v : null;
      originalShopBtnPress.apply(this, arguments);

      // Report spending as it happens rather than only at the shop door. Gated on the cash
      // actually moving, since this same handler fires for clicks that buy nothing -- a tier the
      // player cannot afford, or Double Jump, which is priced in EXP and never touches csh.v.
      const cashAfter = window.game && window.game.ldat ? window.game.ldat.csh.v : null;
      if (cashBefore !== null && cashAfter !== null && cashAfter !== cashBefore) {
        ap.syncCashSoon();
      }

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
    // The gun has no shop track of its own, so it gets a leading row on the received side only --
    // and it is the single most important thing to be able to see at a glance, since without it
    // the Ammo and Gun Power tiers you may already own do nothing.
    const upgradeLines = ["Gun: " + (hasLaserGun() ? "yes" : "no")];
    const shopLines = ["-"];
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
    // The pickup is a location like any other: once checked it stops spawning. It does NOT arm
    // Johnny -- that is the Laser Gun item's job alone (handled in rebuildProgressiveState and the
    // iniLevel hook), so deliberately no wpn.v write and no getGun() call here.
    if (window.sprt && window.sprt.colGun && ap.isLocationChecked("Find the Gun")) {
      window.sprt.colGun.destroy();
      window.sprt.colGun = null;
    }
  }

  // ---------------------------------------------------------------------------------------
  // Archipelago-branded gun pickup badge.
  //
  // The pickup is drawn from the "sheetGunSymb" spritesheet: 10 frames of 120x120, a red/orange/
  // yellow starburst with a green ray gun inside it, animated by nothing more than a vertical bob.
  // Since the gun is an Archipelago item now rather than something you collect, the badge shows
  // the Archipelago logo instead. assets/make_gun_sprite.py does the compositing offline against
  // the game's own SDK zip and prints the data URI below -- rerun it to regenerate.
  //
  // Inlining it as a data URI is what keeps this simple: no cross-origin fetch of the logo at
  // runtime, no tainted canvas, no @grant. And because "sheetGunSymb" has exactly one use site in
  // the whole game (level.js's `isprt.create(..., "sheetGunSymb")`), overwriting the cache entry
  // itself means vanilla picks the new art up with no further patching and the idle animation
  // keeps working untouched.
  // ---------------------------------------------------------------------------------------
  const AP_GUN_SPRITE_DATA_URI =
    "data:image/png;base64,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";

  let gunSpriteInstalled = false;

  function installApGunSprite() {
    if (gunSpriteInstalled) return;
    if (!window.game || !window.game.cache) return;
    gunSpriteInstalled = true;
    const img = new Image();
    img.onload = function () {
      try {
        // Phaser 2.6.2's addSpriteSheet(key, url, data, frameWidth, frameHeight) builds its
        // BaseTexture and frameData straight from the passed <img>, so no loader round trip is
        // needed. A null url is fine -- _resolveURL no-ops unless cache.autoResolveURL is set.
        window.game.cache.addSpriteSheet("sheetGunSymb", null, img, 120, 120);
        log("Gun pickup badge replaced with the Archipelago logo.");
      } catch (e) {
        // Purely cosmetic, so never let it take the rest of the client down.
        log("Could not replace the gun badge sprite: " + e);
      }
    };
    img.onerror = function () {
      log("Gun badge sprite failed to decode -- leaving the vanilla art in place.");
    };
    img.src = AP_GUN_SPRITE_DATA_URI;
  }

  function waitForGameThenInstall() {
    if (
      window.game &&
      window.iniLevel &&
      window.coinCode &&
      window.killEnemy &&
      window.shopBtnPress &&
      window.colgunCode &&
      window.sprtHitTest && // our colgunCode replacement calls it directly
      window.getGun &&
      window.bossHit &&
      window.addITM &&
      window.clockCode &&
      window.ShopState && // hooked for the shop-entry cash sync
      window.shopLeave // hooked to flush spending on the way out
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
      // Normally a no-op: this now fires on the reply to our own shop-entry sync, and the total
      // coming back already equals what we reported. Only log when it genuinely moves the number
      // -- i.e. on the initial restore, or if another session had touched the slot -- so routine
      // shop visits don't spam the panel.
      const changed = window.game.ldat.csh.v !== amount;
      window.game.ldat.csh.v = amount;
      refreshCoinDisplay();
      refreshShopCashDisplay();
      if (changed) log("Cash synced with server: " + amount);
    }
  };
  ap.onConnected = () => {
    waitForGameThenInstall();
    setConnectButtonState(true);
    renderStatus();
  };
  // Wipe the local save completely. All authoritative state lives on the server (items drive
  // every upgrade tier and the gun, checked locations drive which pickups still exist, and cash
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
