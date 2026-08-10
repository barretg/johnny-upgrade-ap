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

ALLOWED = {"speed", "jump", "double", "energy", "ammo", "time", "tech"}
check(all(set(o) <= ALLOWED for c in CLASSES for o in c), "no unknown requirement keys")

print("\ntiers fit the item pool")
TIERS = items.UPGRADE_TRACK_TIERS
# "tech" is a string tag, not a tier, so it stays out of the numeric maxima below.
NUMERIC = ALLOWED - {"tech", "double"}
worst = {k: max((o.get(k, 0) for c in CLASSES for o in c), default=0) for k in NUMERIC}
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

print("\nmovement-tech tagging")
ALL_ON = {"damage": True, "recoil": True, "knockback": True}
ALL_OFF = {"damage": False, "recoil": False, "knockback": False}
tech_terms = [o for c in CLASSES for o in c if o.get("tech")]
kinds = {}
for o in tech_terms:
    kinds[o["tech"]] = kinds.get(o["tech"], 0) + 1
check(bool(tech_terms), f"tech-tagged alternatives exist: {kinds}")
check(
    set(kinds) <= {"recoil", "knockback"},
    f"only known tech names are used (got {sorted(set(kinds))})",
)
# The whole point of these being off by default: nothing may depend on them exclusively.
orphan = [
    i for i, c in enumerate(CLASSES) if not [o for o in c if not o.get("tech") and o.get("energy", 1) <= 1]
]
check(not orphan, f"every class keeps a tech-free, damage-free alternative (bad: {orphan[:5]})")

print("\nrule translation")
MAXED = {
    items.LASER_GUN: 1,
    items.PROGRESSIVE_SPEED: 10,
    items.PROGRESSIVE_JUMP_POWER: 10,
    items.DOUBLE_JUMP: 1,
    items.PROGRESSIVE_TIME_LIMIT: 24,
    items.PROGRESSIVE_ENERGY: 5,
    items.PROGRESSIVE_AMMO: 10,
    items.PROGRESSIVE_GUN_POWER: 5,
    items.PROGRESSIVE_COIN_MULTIPLIER: 10,
}
EMPTY = {items.PROGRESSIVE_SPEED: 1}  # generate_early guarantees one Progressive Speed

SETTING_COMBOS = [
    ("all off (strictest)", ALL_OFF),
    ("damage only", {**ALL_OFF, "damage": True}),
    ("recoil only", {**ALL_OFF, "recoil": True}),
    ("knockback only", {**ALL_OFF, "knockback": True}),
    ("all on (loosest)", ALL_ON),
]
for label, allow in SETTING_COMBOS:
    built = [rules._class_rule(i, allow) for i in range(len(CLASSES))]
    check(
        all(r is None or r.test(MAXED) for r in built),
        f"{label}: every class satisfiable with all items",
    )
    trivial = sum(1 for r in built if r is None or r.test(EMPTY))
    check(trivial < len(CLASSES), f"{label}: {trivial}/{len(CLASSES)} classes free at start (not all)")


def inventories():
    """A spread of plausible item states to compare rules over."""
    for c in itertools.product([0, 2, 5, 10], repeat=3):
        for energy in (0, 4):
            yield {
                # The gun is always present here: these inventories exist to compare a rule
                # against ITSELF under different difficulty settings, so withholding the gun would
                # only make both sides trivially false and stop the comparison saying anything.
                items.LASER_GUN: 1,
                items.PROGRESSIVE_SPEED: c[0],
                items.PROGRESSIVE_JUMP_POWER: c[1],
                items.PROGRESSIVE_AMMO: c[2],
                items.PROGRESSIVE_ENERGY: energy,
                items.PROGRESSIVE_TIME_LIMIT: 24,
                items.DOUBLE_JUMP: 1,
            }


def truth(rule, inv):
    return True if rule is None else rule.test(inv)


# Every setting only ever ADDS alternatives, so turning one on must never make a rule harder and
# turning one off must never make it easier. Check each toggle independently against "all off".
strict = [rules._class_rule(i, ALL_OFF) for i in range(len(CLASSES))]
for label, allow in SETTING_COMBOS[1:]:
    loosened = [rules._class_rule(i, allow) for i in range(len(CLASSES))]
    bad = []
    for i, (s, l) in enumerate(zip(strict, loosened)):
        for inv in inventories():
            if truth(s, inv) and not truth(l, inv):
                bad.append(i)
                break
    check(not bad, f"enabling '{label}' never makes a rule harder (bad: {bad[:3]})")

# ...and the strictest setting must still be satisfiable everywhere, which is what makes all
# three safe to default off.
check(
    all(r is None or r.test(MAXED) for r in strict),
    "with every setting off, all classes remain satisfiable",
)

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
# Coin 11 sits inside the crusher's trigger band, so the fast route grabs it and then dies -- fine,
# because the client sends the check on pickup. It used to show a bare "Speed 2", but the 1.35x
# execution margin no longer fits that inside the 3-second base timer, so the no-Time alternative
# now costs more Speed. Assert the shape rather than the exact tier, which the margin can move.
check(has_opt(11, speed=1, time=1), "Coin 11 reachable at Speed 1 + Time 1")
check(
    any(o.get("time", 0) == 0 for o in opts(11)),
    f"Coin 11 still has a no-Time alternative (got {opts(11)})",
)
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
xp_rule = rules._class_rule(locations.BOSS_ARENA_REQUIREMENT, ALL_ON)
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

print("\ngun-locked shop tracks")
# shop.js only calls addITM for Ammo / Gun Power when game.ldat.wpn.v is set; otherwise both
# slots render as "LOCKED -- find a gun to unlock!" with an EMPTY price array, so no tier of
# either track can be bought. The client now keeps wpn.v in step with the Laser Gun ITEM rather
# than with the pickup, so these tiers are gated on receiving that item.
GUN_LOCKED = (items.PROGRESSIVE_AMMO, items.PROGRESSIVE_GUN_POWER)
for track in GUN_LOCKED:
    tiers = len(locations.SHOP_PRICES[track])
    names = [locations.shop_location_name(track, t) for t in range(1, tiers + 1)]
    check(
        all(locations.location_table[n].requirement == locations.NEEDS_GUN for n in names),
        f"all {tiers} '{track}' shop tiers are gated on the gun",
    )
other = [
    locations.shop_location_name(tr, t)
    for tr, pr in locations.SHOP_PRICES.items()
    if tr not in GUN_LOCKED
    for t in range(1, len(pr) + 1)
]
check(
    not [n for n in other if locations.location_table[n].requirement == locations.NEEDS_GUN],
    "no other shop track is gun-gated",
)

# And confirm it survives rule construction: gun-gated tiers must be unreachable without the
# Laser Gun item, even with every other item in the pool.
no_gun = {**MAXED, items.LASER_GUN: 0}
built = {}
for track in GUN_LOCKED:
    for t in range(1, len(locations.SHOP_PRICES[track]) + 1):
        name = locations.shop_location_name(track, t)
        r = _Has(items.LASER_GUN)
        gate = locations.SHOP_MULTIPLIER_GATE.get(name, 0)
        if gate:
            r = r & _Has(items.PROGRESSIVE_COIN_MULTIPLIER, count=gate)
        built[name] = r
check(
    all(not r.test(no_gun) for r in built.values()),
    "gun-gated tiers stay unreachable without the Laser Gun item",
)
check(
    all(r.test(MAXED) for r in built.values()),
    "gun-gated tiers become reachable once the Laser Gun is received",
)

# The gun is now an item, so no rule anywhere may still be reaching for the pickup LOCATION --
# that would silently re-couple the two and reintroduce "you must go get it yourself".
gun_rules = [rules._class_rule(i, ALL_ON) for i in range(len(CLASSES))]
gun_rules += [rules._option_rule({"ammo": 1}), _Has(items.LASER_GUN)]


def _mentions_reach(rule, name):
    if isinstance(rule, _CanReach):
        return rule.name == name
    if isinstance(rule, (_And, _Or)):
        return _mentions_reach(rule.a, name) or _mentions_reach(rule.b, name)
    return False


check(
    not [r for r in gun_rules if r is not None and _mentions_reach(r, locations.FIND_THE_GUN)],
    "no requirement rule depends on reaching the 'Find the Gun' location",
)

# Nothing that needs bullets may be satisfiable without the gun -- the guarantee that makes the
# item, not the pickup, the real key.
ammo_classes = [i for i, c in enumerate(CLASSES) if all(o.get("ammo", 0) > 0 for o in c)]
check(bool(ammo_classes), f"{len(ammo_classes)} classes need bullets on every alternative")
check(
    all(rules._class_rule(i, ALL_ON).test(no_gun) is False for i in ammo_classes),
    "bullet-only classes are unsatisfiable without the Laser Gun",
)

print("\nthe Laser Gun item itself")
check(
    items.item_table[items.LASER_GUN].classification is _ItemClassification.progression,
    "Laser Gun is progression (else logic cannot see it)",
)
check(items.item_table[items.LASER_GUN].count == 1, "exactly one Laser Gun in the pool")
check(items.LASER_GUN in items.FIXED_ITEM_NAMES, "Laser Gun is always placed, never scaled away")
check(
    items.LASER_GUN not in items.UPGRADE_TRACK_TIERS,
    "Laser Gun is an unlock, not a shop-purchasable tier track",
)
item_offsets = [d.code_offset for d in items.item_table.values()]
check(len(set(item_offsets)) == len(item_offsets), "item code offsets are unique")
fixed_total = sum(items.item_table[n].count for n in items.FIXED_ITEM_NAMES)
check(
    fixed_total <= len(locations.location_table),
    f"{fixed_total} always-placed items fit in {len(locations.location_table)} locations",
)

print("\nhand-derived bomb requirements")
# These are NOT solver output -- they reuse a reference coin's class and add the ammo the shot
# costs (see BOMB_REQUIREMENTS in locations.py). The properties the sweep guarantees for generated
# classes therefore have to be asserted for these separately.
BOMBS = locations.BOMB_REQUIREMENTS
check(len(BOMBS) == 3, f"3 bomb requirement sets (got {len(BOMBS)})")
check(all(len(b) > 0 for b in BOMBS), "no bomb requirement is empty")
check(
    all(set(o) <= ALLOWED for b in BOMBS for o in b),
    "bomb alternatives use no unknown requirement keys",
)
# Gun-gated by construction: every route must fire a bullet, or the check would be obtainable in
# logic without the gun and the ammo gating would be meaningless.
check(
    all(o.get("ammo", 0) > 0 for b in BOMBS for o in b),
    "every bomb alternative requires ammo (so all are gun-gated)",
)
check(
    max(o.get("ammo", 0) for b in BOMBS for o in b) <= TIERS[items.PROGRESSIVE_AMMO],
    "bomb ammo requirements fit the item pool",
)
# Same guarantee the generated classes carry: nothing may depend exclusively on a difficulty
# toggle, or turning the toggles off would strand the check.
check(
    all([o for o in b if not o.get("tech") and o.get("energy", 1) <= 1] for b in BOMBS),
    "every bomb keeps a tech-free, damage-free alternative",
)
for _i, _opts in enumerate(BOMBS):
    _rule = rules._options_rule(_opts, ALL_OFF)
    check(_rule is not None and _rule.test(MAXED), f"Bomb {_i + 1} is satisfiable with all items")
    check(not _rule.test({**MAXED, items.LASER_GUN: 0}), f"Bomb {_i + 1} needs the Laser Gun")
    check(not _rule.test({**MAXED, items.PROGRESSIVE_AMMO: 0}), f"Bomb {_i + 1} needs Progressive Ammo")
    check(not _rule.test(EMPTY), f"Bomb {_i + 1} is not free at game start")
# Enabling a toggle must not make a bomb harder, exactly as for the swept classes.
for _label, _allow in SETTING_COMBOS[1:]:
    _bad = []
    for _i, _opts in enumerate(BOMBS):
        _s, _l = rules._options_rule(_opts, ALL_OFF), rules._options_rule(_opts, _allow)
        for _inv in inventories():
            if truth(_s, _inv) and not truth(_l, _inv):
                _bad.append(_i)
                break
    check(not _bad, f"enabling '{_label}' never makes a bomb harder (bad: {_bad[:3]})")

print("\nlocation table")
check(len(locations.COIN_LOCATION_NAMES) == 246, "246 coin locations")
check(len(locations.ROBOT_LOCATION_NAMES) == 6, "6 robot locations")
check(len(locations.BOMB_LOCATION_NAMES) == 3, "3 bomb locations")
check(
    len(locations.location_table) == 1 + 75 + 246 + 6 + 3,
    f"331 locations total (got {len(locations.location_table)})",
)
# Bombs were appended last so existing ids keep their offsets.
check(
    min(locations.location_table[n].code_offset for n in locations.BOMB_LOCATION_NAMES)
    > max(locations.location_table[n].code_offset for n in locations.ROBOT_LOCATION_NAMES),
    "bomb offsets come after every pre-existing location",
)
offsets = [d.code_offset for d in locations.location_table.values()]
check(len(set(offsets)) == len(offsets), "location code offsets are unique")

print()
if fail:
    print(f"{len(fail)} CHECK(S) FAILED")
    sys.exit(1)
print("all checks passed")
