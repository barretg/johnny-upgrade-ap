from typing import TYPE_CHECKING

from rule_builder.rules import CanReachLocation, Has, Rule

from .items import (
    DOUBLE_JUMP,
    PROGRESSIVE_AMMO,
    PROGRESSIVE_GUN_POWER,
    PROGRESSIVE_JUMP_POWER,
    PROGRESSIVE_SPEED,
    PROGRESSIVE_TIME_LIMIT,
)
from .locations import BOSS_ARENA_REQUIREMENT, FIND_THE_GUN, NEEDS_GUN, location_table

if TYPE_CHECKING:
    from . import JohnnyUpgradeWorld


def _requirement_rule(requirement) -> Rule | None:
    """Translate a (min_speed_tier, min_jump_tier, needs_double_jump, min_time_tier) tuple from
    the reachability solver into a Rule Builder rule, or None if there's no requirement at all.
    """
    if requirement is None:
        return None
    if requirement == NEEDS_GUN:
        return CanReachLocation(FIND_THE_GUN)

    min_speed, min_jump, needs_double_jump, min_time = requirement
    parts: list[Rule] = []
    if min_speed > 0:
        parts.append(Has(PROGRESSIVE_SPEED, count=min_speed))
    if min_jump > 0:
        parts.append(Has(PROGRESSIVE_JUMP_POWER, count=min_jump))
    if needs_double_jump:
        parts.append(Has(DOUBLE_JUMP))
    if min_time > 0:
        parts.append(Has(PROGRESSIVE_TIME_LIMIT, count=min_time))

    if not parts:
        return None
    rule = parts[0]
    for part in parts[1:]:
        rule = rule & part
    return rule


def set_johnny_upgrade_rules(world: "JohnnyUpgradeWorld") -> None:
    for name, data in location_table.items():
        if name not in world.location_name_to_id:
            continue
        try:
            location = world.get_location(name)
        except KeyError:
            continue  # not created this seed (e.g. coinsanity/enemysanity disabled)
        rule = _requirement_rule(data.requirement)
        if rule is not None:
            world.set_rule(location, rule)

    # Placeholder boss-defeat requirement (UNVERIFIED -- boss combat mechanics were not reverse
    # engineered in depth; this assumes the gun plus some Ammo/Gun Power is needed to beat it,
    # on top of the geometric requirement to physically reach the boss arena). Confirm against
    # real play and adjust the counts (or the whole approach, e.g. if jumping on the boss is
    # sufficient and no gun is actually required) before relying on this for generation.
    min_speed, min_jump, needs_double_jump, min_time = BOSS_ARENA_REQUIREMENT
    goal_rule = CanReachLocation(FIND_THE_GUN) & Has(PROGRESSIVE_AMMO, count=3) & Has(PROGRESSIVE_GUN_POWER, count=2)
    if min_speed > 0:
        goal_rule = goal_rule & Has(PROGRESSIVE_SPEED, count=min_speed)
    if min_jump > 0:
        goal_rule = goal_rule & Has(PROGRESSIVE_JUMP_POWER, count=min_jump)
    if needs_double_jump:
        goal_rule = goal_rule & Has(DOUBLE_JUMP)
    if min_time > 0:
        goal_rule = goal_rule & Has(PROGRESSIVE_TIME_LIMIT, count=min_time)
    world.set_completion_rule(goal_rule)
