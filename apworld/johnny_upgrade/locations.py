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

for _track, _prices in SHOP_PRICES.items():
    for _tier in range(1, len(_prices) + 1):
        # Ammo / Gun Power stay hidden in the shop ("LOCKED -- find a gun to unlock!") until
        # the gun pickup has been found at least once; every other track is always visible.
        _requirement: Requirement = NEEDS_GUN if _track in (PROGRESSIVE_AMMO, PROGRESSIVE_GUN_POWER) else None
        _add(shop_location_name(_track, _tier), _requirement)

COIN_LOCATION_NAMES = [coin_location_name(i) for i in range(len(COIN_REQUIREMENTS))]
for _i, _req in enumerate(COIN_REQUIREMENTS):
    _add(COIN_LOCATION_NAMES[_i], _req)

ROBOT_LOCATION_NAMES = [robot_location_name(i) for i in range(len(ENEMY_REQUIREMENTS))]
for _i, _req in enumerate(ENEMY_REQUIREMENTS):
    _add(ROBOT_LOCATION_NAMES[_i], _req)

BOSS_ARENA_REQUIREMENT: Requirement = BOSS_REQUIREMENT
