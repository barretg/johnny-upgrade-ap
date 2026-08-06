from dataclasses import dataclass

from Options import PerGameCommonOptions, Range, Toggle


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
    passive_income_seconds: PassiveIncomeSeconds
    passive_income_amount: PassiveIncomeAmount
