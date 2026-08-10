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


class Coinsanity(DefaultOnToggle):
    """Adds a location check for every collectible coin on the map (246 checks).

    ON: each coin is an Archipelago check and grants no local cash when collected. Cash comes
    from received Coin Bundle items and passive income instead.

    OFF: the coins are not checks, so they keep their normal vanilla payout and top up your cash
    exactly as they always did (on top of Coin Bundles and passive income).
    """
    display_name = "Coinsanity"


class Enemysanity(DefaultOnToggle):
    """Adds a location check for destroying each killable hazard on the map (9 checks).

    That is the 6 patrolling "robot" enemies plus the 3 floating bombs. The 2 saws are not
    included because they cannot be destroyed at all -- killEnemy() only has branches for
    e.robot, e.bomb and e.boss, so a saw simply absorbs the shot.

    All 9 require shooting. A robot can only ever die to a bullet. A bomb can also be set off by
    walking into it, but that does not count as the check -- destroying one with your body just
    clears it for the rest of that round (it is back next run). Both send their check from
    killEnemy(), which is only reached from the bullet collision loop.

    Robots and bombs are NOT removed from the map once checked, unlike collected coins -- they are
    hazards as well as checks, and deleting them would make the map progressively easier than the
    one the logic was derived from.
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


class RecoilBoostsInLogic(Toggle):
    """Allow routes that use the laser gun's recoil as a movement tech.

    shoot() sets your horizontal speed to 8 in the direction OPPOSITE your facing, replacing
    whatever it was. Below about Speed 4 that is faster than you can run, so turning around and
    firing is a genuine speed boost -- but it needs a frame-perfect turnaround, which is not
    something to expect of a first-time player.

    Off by default. The solver found this only opens ~40 shortcuts across the map, and every
    location it touches is reachable without it, so enabling this simply gives the generator
    cheaper alternatives rather than unlocking anything new.
    """
    display_name = "Recoil Boosts In Logic"


class KnockbackBoostsInLogic(Toggle):
    """Allow routes that use damage knockback to launch across gaps (a BLJ-style trick).

    killSprite sets your horizontal speed to 43.2 away from whatever hit you -- roughly four
    times max run speed. Turning around on the hit so "away" points where you want to go throws
    you across gaps that are otherwise out of reach. It is frame-perfect and quite advanced.

    This is SEPARATE from Damage Boosts In Logic: that one is about tanking a hit for the
    invulnerability frames to walk through an enemy, which stays available either way. This is
    specifically about weaponising the knockback velocity for distance.

    Off by default. It is by far the bigger of the two techs -- roughly 1,300 shortcuts across
    187 locations -- but again, nothing depends on it exclusively.
    """
    display_name = "Knockback Boosts In Logic"


@dataclass
class JohnnyUpgradeOptions(PerGameCommonOptions):
    coinsanity: Coinsanity
    enemysanity: Enemysanity
    damage_boosts_in_logic: DamageBoostsInLogic
    recoil_boosts_in_logic: RecoilBoostsInLogic
    knockback_boosts_in_logic: KnockbackBoostsInLogic
    passive_income_seconds: PassiveIncomeSeconds
    passive_income_amount: PassiveIncomeAmount
