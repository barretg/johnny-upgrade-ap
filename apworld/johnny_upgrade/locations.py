from typing import NamedTuple, Optional, Union

from BaseClasses import Location

from .generated_requirements import BOSS_REQUIREMENT, COIN_REQUIREMENTS, ENEMY_REQUIREMENTS, GUN_REQUIREMENT
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
#   - a (min_speed_tier, min_jump_tier, needs_double_jump, min_time_tier) tuple from the
#     reachability solver (see scratch-work/reachability-solver/)
#   - the sentinel NEEDS_GUN: accessible once "Find the Gun" is reachable
NEEDS_GUN = "needs_gun"
Requirement = Optional[Union[tuple, str]]


class LocationData(NamedTuple):
    code_offset: int
    requirement: Requirement


FIND_THE_GUN = "Find the Gun"

# Price ladders from the original shop.js -- unchanged from vanilla. These are what fund the
# shop-location pacing (see rules.py / design notes): local cash comes only from received Coin
# Bundle items now, since map coins are pure location checks.
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


_add(FIND_THE_GUN, GUN_REQUIREMENT)

# track -> tier for every shop location, so rules.py can chain "Tier N requires Tier N-1
# already checked" without parsing location name strings. The shop UI (see client) only ever
# exposes the next sequential tier for a track -- you cannot buy Tier 5 before Tier 1-4 -- so
# this dependency is real and matters to the AP generator's placement decisions, not just
# cosmetic: without it, a critical item could be placed behind a tier that's only reachable
# after affording several prior (cash-gated) purchases the logic wasn't accounting for.
SHOP_TIER_BY_LOCATION: dict[str, tuple[str, int]] = {}

for _track, _prices in SHOP_PRICES.items():
    for _tier in range(1, len(_prices) + 1):
        # Ammo / Gun Power stay hidden in the shop ("LOCKED -- find a gun to unlock!") until
        # the gun pickup has been found at least once; every other track is always visible.
        _requirement: Requirement = NEEDS_GUN if _track in (PROGRESSIVE_AMMO, PROGRESSIVE_GUN_POWER) else None
        _name = shop_location_name(_track, _tier)
        _add(_name, _requirement)
        SHOP_TIER_BY_LOCATION[_name] = (_track, _tier)

# Empirically-confirmed alternate route (see rules.py): these 8 coins normally need Jump 1 to
# reach (a small platform to the left of spawn, before the crusher), but can also be reached by
# shooting the gun to boost onto the platform (1 bullet) and again to reach its upper layer (a
# 2nd bullet) -- both collapse to the same Progressive Ammo>=1 requirement since ammo capacity
# comes in steps of 2 per tier (see rules.py's BULLET_JUMP_ALT_AMMO_TIER). Identified by
# 0-indexed coin position: cluster A's y=240 and y=160 layers (8,9,16,17,18,93) and cluster B's
# y=390/450 (237,238) -- NOT index 6 (a separate single coin), cluster A's y=80 layer, or
# cluster B's y=510, which are unaffected and keep the plain Jump 1 requirement.
BULLET_JUMP_ALT_COIN_INDICES = {8, 9, 16, 17, 18, 93, 237, 238}
BULLET_JUMP_ALT_LOCATIONS = {coin_location_name(i) for i in BULLET_JUMP_ALT_COIN_INDICES}

COIN_LOCATION_NAMES = [coin_location_name(i) for i in range(len(COIN_REQUIREMENTS))]
for _i, _req in enumerate(COIN_REQUIREMENTS):
    _add(COIN_LOCATION_NAMES[_i], _req)

ROBOT_LOCATION_NAMES = [robot_location_name(i) for i in range(len(ENEMY_REQUIREMENTS))]
for _i, _req in enumerate(ENEMY_REQUIREMENTS):
    _add(ROBOT_LOCATION_NAMES[_i], _req)

BOSS_ARENA_REQUIREMENT: Requirement = BOSS_REQUIREMENT
