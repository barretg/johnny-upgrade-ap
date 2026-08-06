from dataclasses import dataclass

from Options import PerGameCommonOptions, Toggle


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


@dataclass
class JohnnyUpgradeOptions(PerGameCommonOptions):
    coinsanity: Coinsanity
    enemysanity: Enemysanity
