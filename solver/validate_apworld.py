"""Validate the generated requirement data and the rules.py translation without needing a full
Archipelago install: the AP modules the package imports are stubbed, and Has/CanReachLocation are
replaced with recording fakes so the built rule trees can be evaluated against synthetic
inventories.

Run from the repo root:  python solver/validate_apworld.py
"""

import importlib.util
import itertools
import sys
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PKG = ROOT / "apworld" / "johnny_upgrade"


# --- stub Archipelago -------------------------------------------------------------------
class _Rule:
    def __and__(self, other):
        return _And(self, other)

    def __or__(self, other):
        return _Or(self, other)


class _And(_Rule):
    def __init__(self, a, b):
        self.a, self.b = a, b

    def test(self, inv):
        return self.a.test(inv) and self.b.test(inv)


class _Or(_Rule):
    def __init__(self, a, b):
        self.a, self.b = a, b

    def test(self, inv):
        return self.a.test(inv) or self.b.test(inv)


class _Has(_Rule):
    def __init__(self, item, count=1):
        self.item, self.count = item, count

    def test(self, inv):
        return inv.get(self.item, 0) >= self.count


class _CanReach(_Rule):
    def __init__(self, name):
        self.name = name

    def test(self, inv):
        return inv.get("__reach__", {}).get(self.name, True)


class _ItemClassification:
    progression = "progression"
    useful = "useful"
    filler = "filler"
    trap = "trap"


for _name, _attrs in {
    "BaseClasses": ["Item", "Location", "Region"],
    "worlds": [],
    "worlds.AutoWorld": ["World", "WebWorld"],
    "Options": ["PerGameCommonOptions", "Range", "Toggle", "DefaultOnToggle"],
}.items():
    _m = types.ModuleType(_name)
    for _a in _attrs:
        setattr(_m, _a, type(_a, (), {}))
    sys.modules[_name] = _m
sys.modules["BaseClasses"].ItemClassification = _ItemClassification

_rb = types.ModuleType("rule_builder")
_rbr = types.ModuleType("rule_builder.rules")
_rbr.Rule, _rbr.Has, _rbr.CanReachLocation = _Rule, _Has, _CanReach
_rb.rules = _rbr
sys.modules["rule_builder"] = _rb
sys.modules["rule_builder.rules"] = _rbr


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


# The package uses relative imports, so give it a real package identity.
pkg = types.ModuleType("johnny_upgrade")
pkg.__path__ = [str(PKG)]
sys.modules["johnny_upgrade"] = pkg
gr = _load("johnny_upgrade.generated_requirements", PKG / "generated_requirements.py")
items = _load("johnny_upgrade.items", PKG / "items.py")
locations = _load("johnny_upgrade.locations", PKG / "locations.py")
rules = _load("johnny_upgrade.rules", PKG / "rules.py")

fail = []


def check(cond, msg):
    print(("  ok   " if cond else "  FAIL ") + msg)
    if not cond:
        fail.append(msg)


print("generated data")
CLASSES = gr.REQUIREMENT_CLASSES
check(len(CLASSES) > 0, f"{len(CLASSES)} requirement classes, {sum(len(c) for c in CLASSES)} total terms")
check(len(gr.COIN_REQUIREMENT_IDS) == 246, f"246 coin ids (got {len(gr.COIN_REQUIREMENT_IDS)})")
check(len(gr.ENEMY_REQUIREMENT_IDS) == 6, f"6 robot ids (got {len(gr.ENEMY_REQUIREMENT_IDS)})")

all_ids = list(gr.COIN_REQUIREMENT_IDS) + list(gr.ENEMY_REQUIREMENT_IDS)
all_ids += [gr.GUN_REQUIREMENT_ID, gr.BOSS_ARENA_REQUIREMENT_ID]
check(all(0 <= i < len(CLASSES) for i in all_ids), "every class id is in range")
check(all(len(c) > 0 for c in CLASSES), "no class is empty")

ALLOWED = {"speed", "jump", "double", "energy", "ammo", "time"}
check(all(set(o) <= ALLOWED for c in CLASSES for o in c), "no unknown requirement keys")

print("\ntiers fit the item pool")
TIERS = items.UPGRADE_TRACK_TIERS
worst = {k: max((o.get(k, 0) for c in CLASSES for o in c), default=0) for k in ALLOWED}
check(worst["speed"] <= TIERS[items.PROGRESSIVE_SPEED], f"max speed {worst['speed']} <= {TIERS[items.PROGRESSIVE_SPEED]}")
check(worst["jump"] <= TIERS[items.PROGRESSIVE_JUMP_POWER], f"max jump {worst['jump']} <= {TIERS[items.PROGRESSIVE_JUMP_POWER]}")
check(worst["time"] <= TIERS[items.PROGRESSIVE_TIME_LIMIT], f"max time {worst['time']} <= {TIERS[items.PROGRESSIVE_TIME_LIMIT]}")
check(worst["ammo"] <= TIERS[items.PROGRESSIVE_AMMO], f"max ammo {worst['ammo']} <= {TIERS[items.PROGRESSIVE_AMMO]}")
# energy is TOTAL hearts; the item cost is hearts - 1
check(worst["energy"] - 1 <= TIERS[items.PROGRESSIVE_ENERGY], f"max energy {worst['energy']} hearts costs {worst['energy']-1} items <= {TIERS[items.PROGRESSIVE_ENERGY]}")
check(rules.BOSS_GUN_POWER_TIER <= TIERS[items.PROGRESSIVE_GUN_POWER], f"boss gun power {rules.BOSS_GUN_POWER_TIER} <= {TIERS[items.PROGRESSIVE_GUN_POWER]}")
check(rules.BOSS_AMMO_TIER <= TIERS[items.PROGRESSIVE_AMMO], f"boss ammo {rules.BOSS_AMMO_TIER} <= {TIERS[items.PROGRESSIVE_AMMO]}")
check(rules.BOSS_TIME_TIER <= TIERS[items.PROGRESSIVE_TIME_LIMIT], f"boss time {rules.BOSS_TIME_TIER} <= {TIERS[items.PROGRESSIVE_TIME_LIMIT]}")

print("\ndamage boosts disabled")
no_dmg = [i for i, c in enumerate(CLASSES) if not [o for o in c if o.get("energy", 1) <= 1]]
check(not no_dmg, f"every class keeps a route without damage boosts (bad: {no_dmg[:5]})")

print("\nrule translation")
MAXED = {
    items.PROGRESSIVE_SPEED: 10,
    items.PROGRESSIVE_JUMP_POWER: 10,
    items.DOUBLE_JUMP: 1,
    items.PROGRESSIVE_TIME_LIMIT: 24,
    items.PROGRESSIVE_ENERGY: 5,
    items.PROGRESSIVE_AMMO: 10,
    items.PROGRESSIVE_GUN_POWER: 5,
}
EMPTY = {items.PROGRESSIVE_SPEED: 1}  # generate_early guarantees one Progressive Speed

for allow in (True, False):
    built = [rules._class_rule(i, allow) for i in range(len(CLASSES))]
    label = "damage on " if allow else "damage off"
    check(all(r is None or r.test(MAXED) for r in built), f"{label}: every class satisfiable with all items")
    trivial = sum(1 for r in built if r is None or r.test(EMPTY))
    check(trivial < len(CLASSES), f"{label}: {trivial}/{len(CLASSES)} classes free at start (not all)")

# Turning damage boosts off must never make a rule EASIER.
on = [rules._class_rule(i, True) for i in range(len(CLASSES))]
off = [rules._class_rule(i, False) for i in range(len(CLASSES))]
looser = []
for i, (a, b) in enumerate(zip(on, off)):
    for combo in itertools.product([0, 2, 5, 10], repeat=3):
        inv = {
            items.PROGRESSIVE_SPEED: combo[0],
            items.PROGRESSIVE_JUMP_POWER: combo[1],
            items.PROGRESSIVE_AMMO: combo[2],
            items.PROGRESSIVE_ENERGY: 5,
            items.PROGRESSIVE_TIME_LIMIT: 24,
            items.DOUBLE_JUMP: 1,
        }
        ta = True if a is None else a.test(inv)
        tb = True if b is None else b.test(inv)
        if tb and not ta:
            looser.append((i, combo))
            break
check(not looser, f"disabling damage boosts never loosens a rule (bad: {looser[:3]})")

print("\nspot checks against hand-derived logic")
COIN = gr.COIN_REQUIREMENT_IDS


def opts(coin_no):
    return CLASSES[COIN[coin_no - 1]]


def has_opt(coin_no, **kw):
    for o in opts(coin_no):
        if all(o.get(k, 1 if k == "energy" else 0) == v for k, v in kw.items()):
            return True
    return False


check(opts(2) == [{"speed": 1}], "Coin 2 is Speed 1 only")
check(has_opt(5, speed=1, jump=1), "Coin 5 keeps the Jump 1 route")
check(has_opt(5, speed=1, ammo=1), "Coin 5 has the bullet-hop (Ammo 1) alternative")
check(has_opt(11, speed=2), "Coin 11 is reachable at Speed 2")
check(has_opt(12, speed=5, time=1), "Coin 12 is Speed 5 + Time 1")
check(all(o.get("ammo", 0) > 0 for i in gr.ENEMY_REQUIREMENT_IDS for o in CLASSES[i]), "every robot check requires ammo")
check(all(o.get("ammo", 0) == 0 for o in CLASSES[gr.GUN_REQUIREMENT_ID]), "Find the Gun never requires the gun")

print("\nshop pacing (Progressive Coin Multiplier gates)")
GATES = locations.SHOP_MULTIPLIER_GATE
# Double Jump is priced in EXP, not cash, so it is deliberately absent from the cash-cost ranking.
check(len(GATES) == 74, f"74 cash-priced shop locations have a gate (got {len(GATES)})")
check(locations.XP_SHOP_LOCATION not in GATES, "Double Jump is excluded from the cash-cost ranking")
check(locations.XP_SHOP_LOCATION in locations.location_table, "the EXP shop location exists")
check(
    max(GATES.values()) <= TIERS[items.PROGRESSIVE_COIN_MULTIPLIER],
    f"max gate {max(GATES.values())} <= {TIERS[items.PROGRESSIVE_COIN_MULTIPLIER]} multiplier items in pool",
)
check(
    max(GATES.values()) < TIERS[items.PROGRESSIVE_COIN_MULTIPLIER],
    "top gate leaves at least one spare multiplier item",
)
sphere1 = [n for n, g in GATES.items() if g == 0]
check(len(sphere1) > 0, f"{len(sphere1)} shop checks still available with no multiplier")
check(len(sphere1) < 74, f"only {len(sphere1)}/74 shop checks are ungated (not all sphere 1)")

# The EXP shop entry must end up strictly harder than a bare multiplier gate: it should demand
# the same movement the deepest area does.
xp_rule = rules._class_rule(locations.BOSS_ARENA_REQUIREMENT, True)
check(xp_rule is not None, "the deepest-area requirement is a real (non-empty) rule")
check(not xp_rule.test({items.PROGRESSIVE_SPEED: 1}), "Double Jump is not reachable at game start")
check(xp_rule.test(MAXED), "Double Jump is reachable with everything")

# The tier chain requires Tier N-1, so a later tier demanding a HIGHER multiplier is fine but a
# LOWER one would be dead weight -- and a non-monotonic gate would mean the chain can never be
# satisfied in order.
nonmono = []
for track, prices in locations.SHOP_PRICES.items():
    prev = -1
    for tier in range(1, len(prices) + 1):
        g = GATES.get(locations.shop_location_name(track, tier), 0)
        if g < prev:
            nonmono.append((track, tier))
        prev = g
check(not nonmono, f"gates are monotonic within every track (bad: {nonmono[:3]})")

spread = {}
for g in GATES.values():
    spread[g] = spread.get(g, 0) + 1
check(len(spread) >= 8, f"gates span {len(spread)} distinct multiplier levels")
print("       distribution: " + ", ".join(f"{g}:{spread[g]}" for g in sorted(spread)))
check(
    items.item_table[items.PROGRESSIVE_COIN_MULTIPLIER].classification is _ItemClassification.progression,
    "Progressive Coin Multiplier is progression (else logic cannot see it)",
)

print("\nlocation table")
check(len(locations.COIN_LOCATION_NAMES) == 246, "246 coin locations")
check(len(locations.ROBOT_LOCATION_NAMES) == 6, "6 robot locations")
check(len(locations.location_table) == 1 + 75 + 246 + 6, f"328 locations total (got {len(locations.location_table)})")
offsets = [d.code_offset for d in locations.location_table.values()]
check(len(set(offsets)) == len(offsets), "location code offsets are unique")

print()
if fail:
    print(f"{len(fail)} CHECK(S) FAILED")
    sys.exit(1)
print("all checks passed")
