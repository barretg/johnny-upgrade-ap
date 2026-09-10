/*
 * Regression test for the cash ledger in johnny-upgrade-ap.user.js. Run: node client/test-cash-sync.js
 *
 * Slices ArchipelagoClient straight out of the userscript (no build step, no exports to keep in
 * sync) and drives it against a fake server that applies DataStorage `operations` in sequence,
 * the way Archipelago does. Covers the two bugs reported from live multiworlds:
 *   - cash drifting negative, from a sync issued while an earlier reply was still in flight
 *   - coin bundles silently doing nothing, from the restore assigning over the top of them
 */
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "johnny-upgrade-ap.user.js"), "utf8");
const start = src.indexOf("  class ArchipelagoClient");
const end = src.indexOf("\n  const ap = new ArchipelagoClient();");
if (start < 0 || end < 0) throw new Error("could not slice class");
const CASH_SYNC_DEBOUNCE_MS = 500;
const GAME_NAME = "Johnny Upgrade";
const log = () => {};
const ArchipelagoClient = eval("(function(){" + src.slice(start, end) + "\nreturn ArchipelagoClient;})()");

class Server {
  constructor(v) { this.store = { cash: v }; this.queue = []; }
  set(operations) { // Archipelago applies operations in sequence over the current value
    let v = this.store.cash;
    for (const op of operations) {
      if (op.operation === "add") v = v + op.value;
      else if (op.operation === "max") v = Math.max(v, op.value);
      else throw new Error("unhandled op " + op.operation);
    }
    this.store.cash = v;
    return v;
  }
}

function makeClient(server, opts = {}) {
  const c = new ArchipelagoClient();
  c.connected = true;
  c.team = 0; c.slot = 1;
  c.state = { cash: opts.localCash === undefined ? 1 : opts.localCash };
  c.getLocalCash = () => c.state.cash;
  c.onCashRestored = (a) => { c.state.cash = Math.max(0, a); };
  const inflight = [];
  c._send = (p) => {
    if (p.cmd !== "Set") return;
    const total = server.set(p.operations);
    inflight.push({ key: p.key, value: total });
  };
  c.deliver = (n) => { // deliver n queued replies in order (n omitted = all)
    const count = n === undefined ? inflight.length : n;
    for (let i = 0; i < count; i++) {
      const r = inflight.shift();
      c._handlePacket({ cmd: "SetReply", key: r.key, value: r.value });
    }
  };
  c.pending = () => inflight.length;
  return c;
}

let failures = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log((ok ? "PASS " : "FAIL ") + name + "  got=" + actual + " want=" + expected);
}

// --- 1. The negative-balance bug: sync issued while a reply is still in flight -------------
{
  const server = new Server(100);
  const c = makeClient(server);
  c._handlePacket({ cmd: "Retrieved", keys: { [c._cashKey()]: 100 } });
  check("restore sets local cash", c.state.cash, 100);
  // Shop entry sync (delta 0), reply NOT yet delivered.
  c.syncCash();
  // Player buys a 50 item, then a second 30 item; each triggers a sync before replies land.
  c.state.cash -= 50; c.syncCash();
  c.state.cash -= 30; c.syncCash();
  c.deliver();
  check("server total after 80 spent", server.store.cash, 20);
  check("local cash after 80 spent", c.state.cash, 20);
}

// --- 2. Server-side floor: a client reporting more spending than exists ---------------------
{
  const server = new Server(10);
  const c = makeClient(server);
  c._handlePacket({ cmd: "Retrieved", keys: { [c._cashKey()]: 10 } });
  c.state.cash = -75; // pretend something drove local cash into debt
  c.syncCash();
  c.deliver();
  check("server floors at 0", server.store.cash, 0);
  check("local cash floors at 0", c.state.cash, 0);
  // and the ledger self-heals: next sync reports no phantom debt
  c.syncCash(); c.deliver();
  check("no debt reappears", server.store.cash, 0);
}

// --- 3. Coin bundle granted before the stored total arrives ---------------------------------
{
  const server = new Server(200);
  const c = makeClient(server);
  // ReceivedItems replay lands first: two bundles worth 50 and 15.
  c.state.cash += 50; c.noteCashGain(50);
  c.state.cash += 15; c.noteCashGain(15);
  c._handlePacket({ cmd: "Retrieved", keys: { [c._cashKey()]: 200 } });
  check("bundles survive the restore", c.state.cash, 265);
  c.syncCash(); c.deliver();
  check("bundles reach the server once", server.store.cash, 265);
  c.syncCash(); c.deliver();
  check("bundles not re-reported", server.store.cash, 265);
}

// --- 4. Foreign spending by a second client on the same slot --------------------------------
{
  const server = new Server(300);
  const a = makeClient(server);
  const b = makeClient(server);
  a._handlePacket({ cmd: "Retrieved", keys: { [a._cashKey()]: 300 } });
  b._handlePacket({ cmd: "Retrieved", keys: { [b._cashKey()]: 300 } });
  b.state.cash -= 120; b.syncCash(); b.deliver();
  check("server sees B's spending", server.store.cash, 180);
  a.state.cash += 25; // A earned coins meanwhile
  a.syncCash(); a.deliver();
  check("A adopts B's spending, keeps its own earnings", a.state.cash, 205);
  check("server total consistent", server.store.cash, 205);
}

// --- 5. Cash earned locally after a sync goes out is not clobbered by the reply -------------
{
  const server = new Server(50);
  const c = makeClient(server);
  c._handlePacket({ cmd: "Retrieved", keys: { [c._cashKey()]: 50 } });
  c.syncCash();          // reply in flight
  c.state.cash += 9;     // passive income tick lands first
  c.deliver();
  check("earnings survive the reply", c.state.cash, 59);
  c.syncCash(); c.deliver();
  check("earnings reported once", server.store.cash, 59);
}

// --- 6. Brand-new slot (key never written) --------------------------------------------------
{
  const server = new Server(0);
  const c = makeClient(server, { localCash: 1 });
  c._handlePacket({ cmd: "Retrieved", keys: { [c._cashKey()]: null } });
  check("local cash left alone on new slot", c.state.cash, 1);
  c.syncCash(); c.deliver();
  check("new slot seeded from local", server.store.cash, 1);
}

console.log(failures === 0 ? "\nall passed" : "\n" + failures + " FAILURES");
process.exit(failures === 0 ? 0 : 1);
