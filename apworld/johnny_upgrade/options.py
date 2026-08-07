from dataclasses import dataclass

from Options import DefaultOnToggle, PerGameCommonOptions, Range, Toggle


class DamageBoostsInLogic(DefaultOnToggle):
    """Allow routes that require deliberately taking a hit to get past a hazard.

    Taking damage grants 60 frames of invulnerability (killSprite sets sprt.inv = 60), which is
    enough to run straight through an enemy that otherwise cannot be passed. One spot on the map
    genuinely needs this: the floor robot under the low ceiling near the boss door has 200px of
    clearance above it, and the player plus the robot need 210px, so it can neither be jumped nor
    walked through.

    Any route relying on this needs at least 2 hearts (1 Progressive Energy) so the hit is not
    fatal. Turning this off removes every such route from logic; the solver confirms every
    location also has a gun-based alternative (shoot the robot -- killRobot deletes it
    permanently), so nothing becomes unreachable, but expect Progressive Ammo to become much more
    load-bearing.
    """
    display_name = "Damage Boosts In Logic"


class Coinsanity(Toggle):
    """Adds a location check for every collectible coin on the map (246 checks).

    Coins no longer grant local cash when collected -- cash instead comes from received
    Coin Bundle items -- so this purely controls whether each coin pickup is also an
    Archipelago location check.
    """
    display_name = "Coinsanity"


class Enemysanity(Toggle):
    """Adds a location check for defeating each killable enemy on the map (6 checks).

    Only the 6 "robot" enemies count -- the 2 spinning saws are indestructible hazards,
    same as the map's spikes, and are never location checks.
    """
    display_name = "Enemysanity"


class PassiveIncomeSeconds(Range):
    """Seconds of cumulative round playtime needed to earn one passive income tick.

    This is a softlock backstop: since map coins are pure location checks now (no local cash),
    a player who has spent everything and hasn't yet received a Coin Bundle item would otherwise
    have no way to ever afford another shop purchase. Lower values grant cash faster.
    """
    display_name = "Passive Income Seconds Per Tick"
    range_start = 1
    range_end = 10
    default = 3


class PassiveIncomeAmount(Range):
    """Cash granted per passive income tick (see Passive Income Seconds Per Tick).

    Higher values grant cash faster.
    """
    display_name = "Passive Income Amount Per Tick"
    range_start = 1
    range_end = 10
    default = 1


@dataclass
class JohnnyUpgradeOptions(PerGameCommonOptions):
    coinsanity: Coinsanity
    enemysanity: Enemysanity
    damage_boosts_in_logic: DamageBoostsInLogic
    passive_income_seconds: PassiveIncomeSeconds
    passive_income_amount: PassiveIncomeAmount
