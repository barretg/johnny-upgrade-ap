from typing import TYPE_CHECKING, Optional

from rule_builder.rules import CanReachLocation, Has, Rule

from .items import (
    DOUBLE_JUMP,
    LASER_GUN,
    PROGRESSIVE_AMMO,
    PROGRESSIVE_COIN_MULTIPLIER,
    PROGRESSIVE_ENERGY,
    PROGRESSIVE_GUN_POWER,
    PROGRESSIVE_JUMP_POWER,
    PROGRESSIVE_SPEED,
    PROGRESSIVE_TIME_LIMIT,
)
from .locations import (
    BOSS_ARENA_REQUIREMENT,
    NEEDS_GUN,
    REQUIREMENT_CLASSES,
    SHOP_MULTIPLIER_GATE,
    SHOP_TIER_BY_LOCATION,
    XP_SHOP_LOCATION,
    location_table,
    shop_location_name,
)

if TYPE_CHECKING:
    from . import JohnnyUpgradeWorld


# Boss fight requirements. Reaching the arena is handled by BOSS_ARENA_REQUIREMENT (solved
# geometrically like every other location); these are the combat requirements on top of it.
#
# boss.nrgMax is 2 and bossHit() subtracts game.ldat.gunpow.v (tier * 0.1) per hit, while
# early-returning unless boss.stp == 4 and immediately setting stp = 5 -- so it is one hit per
# vulnerability cycle, and the cycles are long. Rather than depend on a simulation of that fight,
# these are set deliberately generously: max Gun Power (fewest hits needed), plenty of ammo, and
# enough timer for the fight to actually play out.
BOSS_GUN_POWER_TIER = 5  # all of them
BOSS_AMMO_TIER = 5
BOSS_TIME_TIER = 18


def _option_rule(option: dict) -> Optional[Rule]:
    """Translate one alternative (a dict of minimum tiers, ANDed) into a Rule."""
    parts: list[Rule] = []

    speed = option.get("speed", 0)
    if speed > 0:
        parts.append(Has(PROGRESSIVE_SPEED, count=speed))

    jump = option.get("jump", 0)
    if jump > 0:
        parts.append(Has(PROGRESSIVE_JUMP_POWER, count=jump))

    if option.get("double"):
        parts.append(Has(DOUBLE_JUMP))

    # "energy" is TOTAL hearts. Every run starts with one heart for free (iniLdat sets
    # nrg.v = 0.1), so N hearts costs N-1 Progressive Energy items.
    energy = option.get("energy", 1)
    if energy > 1:
        parts.append(Has(PROGRESSIVE_ENERGY, count=energy - 1))

    # Any alternative that fires a bullet needs the Laser Gun item as well as the Ammo tiers --
    # getGun() is what turns Ammo into actual bullets, and it now runs off the received item
    # rather than off walking into the map's pickup. Reaching the pickup is irrelevant here.
    ammo = option.get("ammo", 0)
    if ammo > 0:
        parts.append(Has(LASER_GUN) & Has(PROGRESSIVE_AMMO, count=ammo))

    time = option.get("time", 0)
    if time > 0:
        parts.append(Has(PROGRESSIVE_TIME_LIMIT, count=time))

    if not parts:
        return None
    rule = parts[0]
    for part in parts[1:]:
        rule = rule & part
    return rule


def _allowed(option: dict, allow: dict) -> bool:
    """Whether a single alternative survives the player's difficulty settings."""
    # Needing more than the one free heart means tanking a hit for the i-frames.
    if option.get("energy", 1) > 1 and not allow["damage"]:
        return False
    tech = option.get("tech")
    if tech is not None and not allow.get(tech, False):
        return False
    return True


def _options_rule(options: list[dict], allow: dict) -> Optional[Rule]:
    """Translate a list of alternatives (ORed) into a Rule.

    Returns None when they impose no requirement at all, i.e. some alternative is satisfiable
    with nothing.
    """
    # The solver guarantees every location keeps at least one alternative with no damage boost
    # and no movement tech, so no combination of these settings can empty a class. Fall back to
    # the unfiltered list rather than produce an unfillable location if that ever regresses.
    filtered = [o for o in options if _allowed(o, allow)]
    if filtered:
        options = filtered

    rule: Optional[Rule] = None
    for option in options:
        option_rule = _option_rule(option)
        if option_rule is None:
            return None  # this alternative is free, so the whole OR is free
        rule = option_rule if rule is None else (rule | option_rule)
    return rule


def _class_rule(class_id: int, allow: dict) -> Optional[Rule]:
    """Translate one solver-produced requirement class into a Rule."""
    return _options_rule(REQUIREMENT_CLASSES[class_id], allow)


def set_johnny_upgrade_rules(world: "JohnnyUpgradeWorld") -> None:
    # Which categories of advanced play this player's yaml puts in logic. Every one of these
    # only ever ADDS alternatives, so turning them all off yields the strictest possible logic
    # and can never make a seed unbeatable.
    allow = {
        "damage": bool(world.options.damage_boosts_in_logic),
        "recoil": bool(world.options.recoil_boosts_in_logic),
        "knockback": bool(world.options.knockback_boosts_in_logic),
    }

    # 254 locations share only ~200 distinct requirement classes, so build each rule once and
    # reuse the object rather than reconstructing thousands of near-identical rule trees.
    rule_cache: dict[int, Optional[Rule]] = {}

    def rule_for(class_id: int) -> Optional[Rule]:
        if class_id not in rule_cache:
            rule_cache[class_id] = _class_rule(class_id, allow)
        return rule_cache[class_id]

    for name, data in location_table.items():
        if name not in world.location_name_to_id:
            continue
        try:
            location = world.get_location(name)
        except KeyError:
            continue  # not created this seed (e.g. coinsanity/enemysanity disabled)

        requirement = data.requirement
        if requirement is None:
            rule = None
        elif requirement == NEEDS_GUN:
            rule = Has(LASER_GUN)
        elif isinstance(requirement, list):
            # Spelled-out alternatives rather than a solver class id (the bombs). Not cached: the
            # cache is keyed by class id, and there are only a handful of these.
            rule = _options_rule(requirement, allow)
        else:
            rule = rule_for(requirement)

        # Shop tiers must be bought in order -- the shop UI only ever exposes the next sequential
        # tier for a track, so checking Tier N for real requires Tier N-1 already checked.
        track_tier = SHOP_TIER_BY_LOCATION.get(name)
        if track_tier is not None:
            if track_tier[1] > 1:
                chain_rule = CanReachLocation(shop_location_name(track_tier[0], track_tier[1] - 1))
                rule = chain_rule if rule is None else rule & chain_rule
            # Pace the shop across the run instead of leaving all 75 checks in sphere 1 -- see
            # SHOP_MULTIPLIER_GATE in locations.py for why the multiplier is the right stand-in
            # for affordability.
            gate = SHOP_MULTIPLIER_GATE.get(name, 0)
            if gate > 0:
                gate_rule = Has(PROGRESSIVE_COIN_MULTIPLIER, count=gate)
                rule = gate_rule if rule is None else rule & gate_rule

            # Double Jump is bought with EXP, not cash, and EXP is the count of camera areas ever
            # entered -- so it is gated on exploration reaching the deepest area rather than on
            # the multiplier. See XP_SHOP_LOCATION in locations.py.
            if name == XP_SHOP_LOCATION:
                xp_rule = _class_rule(BOSS_ARENA_REQUIREMENT, allow)
                if xp_rule is not None:
                    rule = xp_rule if rule is None else rule & xp_rule

        if rule is not None:
            world.set_rule(location, rule)

    goal_rule = (
        Has(LASER_GUN)
        & Has(PROGRESSIVE_GUN_POWER, count=BOSS_GUN_POWER_TIER)
        & Has(PROGRESSIVE_AMMO, count=BOSS_AMMO_TIER)
        & Has(PROGRESSIVE_TIME_LIMIT, count=BOSS_TIME_TIER)
    )
    arena_rule = _class_rule(BOSS_ARENA_REQUIREMENT, allow)
    if arena_rule is not None:
        goal_rule = goal_rule & arena_rule
    world.set_completion_rule(goal_rule)
