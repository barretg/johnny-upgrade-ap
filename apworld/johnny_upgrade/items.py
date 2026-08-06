from typing import NamedTuple

from BaseClasses import Item, ItemClassification


class JohnnyUpgradeItem(Item):
    game = "Johnny Upgrade"


class ItemData(NamedTuple):
    code_offset: int
    classification: ItemClassification
    count: int


# Progressive upgrade items. Receiving one directly increments the matching tier in the game's
# `game.ldat` state (see client) -- it does NOT go through the in-game shop purchase, which is
# now just a location-check trigger (see locations.py / rules.py for why). Counts match each
# upgrade's number of tiers from the original shop.js price ladder.
PROGRESSIVE_SPEED = "Progressive Speed"
PROGRESSIVE_JUMP_POWER = "Progressive Jump Power"
DOUBLE_JUMP = "Double Jump"
PROGRESSIVE_TIME_LIMIT = "Progressive Time Limit"
PROGRESSIVE_ENERGY = "Progressive Energy"
PROGRESSIVE_AMMO = "Progressive Ammo"
PROGRESSIVE_GUN_POWER = "Progressive Gun Power"
PROGRESSIVE_COIN_MULTIPLIER = "Progressive Coin Multiplier"

# Filler: coin bundles grant game.ldat.csh directly when received, scaled by however many
# Progressive Coin Multiplier tiers have been received (same +50%/tier formula the vanilla
# game used for coin pickups, just applied to received bundles instead since map coins no
# longer pay out locally).
# Values are intentionally modest relative to the price ladder (which tops out at 1000) --
# playtesting found the first-draft values (20/60/250) trivially maxed out the cheap early
# tiers the moment a single bundle arrived, making early shopping decisions feel pointless.
# These lean on Progressive Coin Multiplier (received over the course of the game, up to
# +500% at tier 10) to make late-game affordability catch up rather than front-loading it into
# huge flat bundle values. Still a rough first pass -- tune further based on real play.
SMALL_COIN_BUNDLE = "Small Coin Bundle"
MEDIUM_COIN_BUNDLE = "Medium Coin Bundle"
LARGE_COIN_BUNDLE = "Large Coin Bundle"
COIN_BUNDLE_VALUES = {
    SMALL_COIN_BUNDLE: 5,
    MEDIUM_COIN_BUNDLE: 15,
    LARGE_COIN_BUNDLE: 50,
}

# Bonus/trap: adjust the active round's countdown timer directly when received.
BONUS_TIME = "Bonus Time (+5s)"
TRAP_TIME = "Trap Time (-5s)"

# NOTE on classifications below (flagged for review against real play):
#   - Progressive Energy and Progressive Coin Multiplier are "useful" rather than
#     "progression" because the current logic (rules.py) never checks them -- hazard
#     damage/energy budget isn't modeled by the reachability solver, and the coin
#     multiplier only affects the local cash economy, not reachability.
#   - Double Jump is "useful" rather than "progression" because the reachability solver
#     never required it for any of the 246 coins, 6 enemies, the gun, or the boss arena
#     with the current (documented, non-exhaustive) physics model. If real play finds a
#     spot that genuinely needs it, reclassify to progression and add a rule for it.
#   - Progressive Ammo / Progressive Gun Power are "progression" solely because of the
#     placeholder boss-goal rule in rules.py, which assumes some combat capability is
#     needed to defeat the boss. That assumption is unverified -- boss combat mechanics
#     were not reverse engineered in depth.
#
# Total item count (328) is made to exactly match total location count when coinsanity and
# enemysanity are both enabled (1 gun + 75 shop + 246 coins + 6 robots = 328); create_items()
# in __init__.py scales the filler/trap counts down when either sanity option is disabled.
item_table: dict[str, ItemData] = {
    PROGRESSIVE_SPEED: ItemData(0, ItemClassification.progression, 10),
    PROGRESSIVE_JUMP_POWER: ItemData(1, ItemClassification.progression, 10),
    DOUBLE_JUMP: ItemData(2, ItemClassification.useful, 1),
    PROGRESSIVE_TIME_LIMIT: ItemData(3, ItemClassification.progression, 24),
    PROGRESSIVE_ENERGY: ItemData(4, ItemClassification.useful, 5),
    PROGRESSIVE_AMMO: ItemData(5, ItemClassification.progression, 10),
    PROGRESSIVE_GUN_POWER: ItemData(6, ItemClassification.progression, 5),
    PROGRESSIVE_COIN_MULTIPLIER: ItemData(7, ItemClassification.useful, 10),
    SMALL_COIN_BUNDLE: ItemData(8, ItemClassification.filler, 140),
    MEDIUM_COIN_BUNDLE: ItemData(9, ItemClassification.filler, 65),
    LARGE_COIN_BUNDLE: ItemData(10, ItemClassification.filler, 17),
    BONUS_TIME: ItemData(11, ItemClassification.useful, 8),
    TRAP_TIME: ItemData(12, ItemClassification.trap, 7),
}

# Names that are always included at full count regardless of coinsanity/enemysanity (progression
# plus the fixed "useful" upgrades) vs. the filler/trap pool that gets scaled to fit.
FIXED_ITEM_NAMES = [
    PROGRESSIVE_SPEED,
    PROGRESSIVE_JUMP_POWER,
    DOUBLE_JUMP,
    PROGRESSIVE_TIME_LIMIT,
    PROGRESSIVE_ENERGY,
    PROGRESSIVE_AMMO,
    PROGRESSIVE_GUN_POWER,
    PROGRESSIVE_COIN_MULTIPLIER,
]
SCALABLE_FILLER_NAMES = [
    SMALL_COIN_BUNDLE,
    MEDIUM_COIN_BUNDLE,
    LARGE_COIN_BUNDLE,
    BONUS_TIME,
    TRAP_TIME,
]

# Tiers-per-track, used by rules.py/the client to know each progressive item's max count.
UPGRADE_TRACK_TIERS = {
    PROGRESSIVE_SPEED: 10,
    PROGRESSIVE_JUMP_POWER: 10,
    PROGRESSIVE_TIME_LIMIT: 24,
    PROGRESSIVE_ENERGY: 5,
    PROGRESSIVE_AMMO: 10,
    PROGRESSIVE_GUN_POWER: 5,
    PROGRESSIVE_COIN_MULTIPLIER: 10,
}
