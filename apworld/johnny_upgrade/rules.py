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
from .locations import (
    BOSS_ARENA_REQUIREMENT,
    BULLET_JUMP_ALT_LOCATIONS,
    FIND_THE_GUN,
    NEEDS_GUN,
    SHOP_TIER_BY_LOCATION,
    location_table,
    shop_location_name,
)

if TYPE_CHECKING:
    from . import JohnnyUpgradeWorld


# Jump 10 + Double Jump is NOT an alternate way to survive the crusher -- it's a separate
# sequence break: a tunnel out of spawn that skips almost the entire map and lands you near the
# boss door. It does NOT lead to the spike-gauntlet coins or anything else gated by the crusher
# floor (min_speed==5 locations), so it must NOT be OR'd into the general per-location crusher
# requirement -- that was wrong and has been removed. It only applies to the boss goal rule (see
# set_johnny_upgrade_rules), and possibly to specific coins/enemies actually near the boss door
# if any are confirmed reachable via the tunnel (none confirmed yet -- ask before assuming).
TUNNEL_ALT_JUMP_TIER = 10

# Empirically-confirmed alternate route (see locations.py's BULLET_JUMP_ALT_COIN_INDICES): 8
# coins on a small platform left of spawn normally need Jump 1, but can also be reached by
# shooting the gun to boost up (1 bullet for the platform, a 2nd bullet for its upper layer).
# Ammo capacity comes in steps of 2 per tier (Math.round(ammo.v*20), i.e. tier*2), so both "1
# bullet" and "2 bullets" collapse to the same Progressive Ammo>=1 requirement -- there's no
# tier that grants exactly 1. This only replaces the JUMP portion of the requirement; Speed is
# still needed to actually walk over there regardless of route.
BULLET_JUMP_ALT_AMMO_TIER = 1


def _requirement_rule(requirement, location_name: str | None = None) -> Rule | None:
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
        if location_name is not None and location_name in BULLET_JUMP_ALT_LOCATIONS:
            parts.append(
                Has(PROGRESSIVE_JUMP_POWER, count=min_jump)
                | (CanReachLocation(FIND_THE_GUN) & Has(PROGRESSIVE_AMMO, count=BULLET_JUMP_ALT_AMMO_TIER))
            )
        else:
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
        rule = _requirement_rule(data.requirement, location_name=name)

        # Shop tiers must be bought in order -- the shop UI only ever exposes the next
        # sequential tier for a track (see client), so checking Tier N for real requires
        # Tier N-1 already checked. Without this, the generator could place something logic-
        # critical behind a tier that looks immediately accessible but actually needs several
        # prior (cash-gated) purchases first.
        track_tier = SHOP_TIER_BY_LOCATION.get(name)
        if track_tier is not None and track_tier[1] > 1:
            chain_rule = CanReachLocation(shop_location_name(track_tier[0], track_tier[1] - 1))
            rule = chain_rule if rule is None else rule & chain_rule

        if rule is not None:
            world.set_rule(location, rule)

    # Placeholder boss-defeat requirement (UNVERIFIED -- boss combat mechanics were not reverse
    # engineered in depth; this assumes the gun plus some Ammo/Gun Power is needed to beat it,
    # on top of physically reaching the boss arena). Confirm against real play and adjust the
    # counts (or the whole approach, e.g. if jumping on the boss is sufficient and no gun is
    # actually required) before relying on this for generation. The gun itself is unaffected by
    # either route below -- it sits well left of spawn, needing neither the crusher nor the
    # tunnel to reach.
    goal_rule = CanReachLocation(FIND_THE_GUN) & Has(PROGRESSIVE_AMMO, count=3) & Has(PROGRESSIVE_GUN_POWER, count=2)

    # Two independent ways to physically reach the boss arena: the normal route (crusher, then
    # whatever the spike gauntlet/geometry demands -- BOSS_ARENA_REQUIREMENT), or the tunnel
    # sequence break (Jump 10 + Double Jump), which skips the crusher and spike gauntlet
    # entirely and lands you near the boss door directly. These are NOT interchangeable for
    # other locations (see TUNNEL_ALT_JUMP_TIER note above) -- this OR only belongs on the goal.
    normal_route = _requirement_rule(BOSS_ARENA_REQUIREMENT)
    tunnel_route = Has(PROGRESSIVE_JUMP_POWER, count=TUNNEL_ALT_JUMP_TIER) & Has(DOUBLE_JUMP)
    movement_rule = tunnel_route if normal_route is None else (normal_route | tunnel_route)
    goal_rule = goal_rule & movement_rule
    world.set_completion_rule(goal_rule)
