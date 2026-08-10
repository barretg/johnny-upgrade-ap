from typing import NamedTuple, Optional, Union

from BaseClasses import Location

from .generated_requirements import (
    BOSS_ARENA_REQUIREMENT_ID,
    COIN_REQUIREMENT_IDS,
    ENEMY_REQUIREMENT_IDS,
    GUN_REQUIREMENT_ID,
    REQUIREMENT_CLASSES,
)
from .items import (
    DOUBLE_JUMP,
    PROGRESSIVE_AMMO,
    PROGRESSIVE_COIN_MULTIPLIER,
    PROGRESSIVE_ENERGY,
    PROGRESSIVE_GUN_POWER,
    PROGRESSIVE_JUMP_POWER,
    PROGRESSIVE_SPEED,
    PROGRESSIVE_TIME_LIMIT,
)


class JohnnyUpgradeLocation(Location):
    game = "Johnny Upgrade"


# A requirement is either:
#   - None: always accessible
#   - an int: index into generated_requirements.REQUIREMENT_CLASSES, produced by the physics
#     solver in solver/. Each class is a list of alternatives (OR); each alternative is a dict of
#     minimum tiers (AND). See solver/README.md for how those are derived.
#   - the sentinel NEEDS_GUN: accessible once the Laser Gun ITEM has been received (not once the
#     "Find the Gun" location is reachable -- the pickup only sends a check, see FIND_THE_GUN)
NEEDS_GUN = "needs_gun"
Requirement = Optional[Union[int, str]]


class LocationData(NamedTuple):
    code_offset: int
    requirement: Requirement


# Walking into the map's gun pickup. This is a pure location check -- it does NOT arm Johnny;
# the Laser Gun item does (see items.LASER_GUN). The client keeps the pickup spawning until this
# location is checked even for a player who already received the item, so the two never interfere.
FIND_THE_GUN = "Find the Gun"

# Price ladders from the original shop.js -- unchanged from vanilla. These fund the shop-location
# pacing: local cash comes only from received Coin Bundle items now, since map coins are pure
# location checks.
SHOP_PRICES: dict[str, list[int]] = {
    PROGRESSIVE_SPEED: [1, 2, 5, 8, 10, 20, 60, 400, 800, 1000],
    PROGRESSIVE_JUMP_POWER: [3, 10, 15, 20, 25, 50, 75, 100, 150, 200],
    DOUBLE_JUMP: [600],
    PROGRESSIVE_TIME_LIMIT: [
        10, 15, 20, 25, 30, 35, 40, 45, 50, 60, 70, 80, 90, 100, 120, 140, 160, 180, 200, 250, 300, 350, 400, 500,
    ],
    PROGRESSIVE_ENERGY: [25, 50, 150, 200, 300],
    PROGRESSIVE_AMMO: [20, 40, 70, 100, 150, 200, 250, 300, 400, 500],
    PROGRESSIVE_GUN_POWER: [25, 50, 100, 150, 200],
    PROGRESSIVE_COIN_MULTIPLIER: [20, 30, 40, 60, 80, 100, 150, 200, 250, 300],
}


def shop_location_name(track: str, tier: int) -> str:
    return f"Shop: {track} Tier {tier}"


# Pacing the shop with Progressive Coin Multiplier.
#
# Shop tiers cost cash, but cash is invisible to logic: it comes from Coin Bundle items, which are
# filler, and `state.prog_items` only tracks progression items -- so a rule literally cannot see
# them without reclassifying 222 items. With only the "Tier N-1 first" chain to go on, the
# generator therefore believed all 75 shop checks were free from the start, dumped them into
# sphere 1, and left the player resetting and waiting on passive income to actually afford them.
#
# Progressive Coin Multiplier is the natural stand-in: it is the item that actually governs cash
# throughput (+50% per tier on both bundles and passive income), so "this tier costs more, so it
# wants a better multiplier" is the real relationship rather than an arbitrary gate.
#
# Tiers are ranked by CUMULATIVE cost within their track (what you must have earned to have bought
# tiers 1..N of it) and then split into equal buckets. Ranking by cumulative cost is what keeps
# each track's gates monotonically non-decreasing, which matters: the tier chain below requires
# Tier N-1, so a later tier must never demand a LOWER multiplier than an earlier one.
#
# The top bucket is 9, not 10, so the last checks do not depend on collecting literally every
# Progressive Coin Multiplier in the pool.
SHOP_MULTIPLIER_BUCKETS = 10


def _build_shop_multiplier_gates() -> dict[str, int]:
    entries: list[tuple[int, str, int]] = []
    for track, prices in SHOP_PRICES.items():
        if track == DOUBLE_JUMP:
            continue  # priced in XP, not cash -- gated by exploration instead, see below
        cumulative = 0
        for tier, price in enumerate(prices, start=1):
            cumulative += price
            entries.append((cumulative, track, tier))
    entries.sort()
    return {
        shop_location_name(track, tier): rank * SHOP_MULTIPLIER_BUCKETS // len(entries)
        for rank, (_cumulative, track, tier) in enumerate(entries)
    }


SHOP_MULTIPLIER_GATE: dict[str, int] = _build_shop_multiplier_gates()

# Double Jump is the one shop entry not bought with cash. addITM prices it in EXP and shopBtnPress
# gates it on `getXP() >= price`, where getXP() is n*n*5 over game.ldat.ars -- the count of camera
# areas the player has ever entered, set by areaCode() purely on rectangle overlap. Nothing about
# the gun or enemies is involved.
#
# 600 EXP therefore needs n >= 11 of the map's 15 areas. Rather than model each area separately,
# this gates on the DEEPEST one (areas[12], the boss-side strip at x 2180-3412), on the grounds
# that getting there means having crossed the map. That is sound in practice because ldat.ars
# accumulates across runs and is never reset, so a player who can reach the deepest area can pick
# up the easy ones over subsequent attempts -- the hardest area is the real binding constraint.
#
# Reaching the boss arena puts the player inside that strip, so its solved requirement is reused
# directly instead of inventing a new one.
XP_SHOP_LOCATION = shop_location_name(DOUBLE_JUMP, 1)


def coin_location_name(index: int) -> str:
    return f"Coin {index + 1}"


def robot_location_name(index: int) -> str:
    return f"Robot {index + 1}"


location_table: dict[str, LocationData] = {}
_next_offset = 0


def _add(name: str, requirement: Requirement) -> None:
    global _next_offset
    location_table[name] = LocationData(_next_offset, requirement)
    _next_offset += 1


_add(FIND_THE_GUN, GUN_REQUIREMENT_ID)

# track -> tier for every shop location, so rules.py can chain "Tier N requires Tier N-1 already
# checked" without parsing location name strings. The shop UI only ever exposes the next
# sequential tier for a track -- you cannot buy Tier 5 before Tier 1-4 -- so this dependency is
# real and matters to placement, not just cosmetic.
SHOP_TIER_BY_LOCATION: dict[str, tuple[str, int]] = {}

for _track, _prices in SHOP_PRICES.items():
    for _tier in range(1, len(_prices) + 1):
        # Ammo / Gun Power stay hidden in the shop ("LOCKED -- find a gun to unlock!") until the
        # Laser Gun item has been received; every other track is always visible.
        _requirement: Requirement = (
            NEEDS_GUN if _track in (PROGRESSIVE_AMMO, PROGRESSIVE_GUN_POWER) else None
        )
        _name = shop_location_name(_track, _tier)
        _add(_name, _requirement)
        SHOP_TIER_BY_LOCATION[_name] = (_track, _tier)

COIN_LOCATION_NAMES = [coin_location_name(i) for i in range(len(COIN_REQUIREMENT_IDS))]
for _i, _req_id in enumerate(COIN_REQUIREMENT_IDS):
    _add(COIN_LOCATION_NAMES[_i], _req_id)

ROBOT_LOCATION_NAMES = [robot_location_name(i) for i in range(len(ENEMY_REQUIREMENT_IDS))]
for _i, _req_id in enumerate(ENEMY_REQUIREMENT_IDS):
    _add(ROBOT_LOCATION_NAMES[_i], _req_id)

BOSS_ARENA_REQUIREMENT: Requirement = BOSS_ARENA_REQUIREMENT_ID

__all__ = [
    "BOSS_ARENA_REQUIREMENT",
    "COIN_LOCATION_NAMES",
    "FIND_THE_GUN",
    "JohnnyUpgradeLocation",
    "NEEDS_GUN",
    "REQUIREMENT_CLASSES",
    "ROBOT_LOCATION_NAMES",
    "SHOP_MULTIPLIER_BUCKETS",
    "SHOP_MULTIPLIER_GATE",
    "SHOP_PRICES",
    "SHOP_TIER_BY_LOCATION",
    "XP_SHOP_LOCATION",
    "location_table",
    "shop_location_name",
]
