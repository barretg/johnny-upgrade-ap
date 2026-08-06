from typing import Any

from BaseClasses import Item, Region
from worlds.AutoWorld import WebWorld, World

from .items import (
    COIN_BUNDLE_VALUES,
    FIXED_ITEM_NAMES,
    PROGRESSIVE_SPEED,
    SCALABLE_FILLER_NAMES,
    SMALL_COIN_BUNDLE,
    UPGRADE_TRACK_TIERS,
    JohnnyUpgradeItem,
    item_table,
)
from .locations import (
    COIN_LOCATION_NAMES,
    FIND_THE_GUN,
    ROBOT_LOCATION_NAMES,
    SHOP_PRICES,
    JohnnyUpgradeLocation,
    location_table,
    shop_location_name,
)
from .options import JohnnyUpgradeOptions
from .rules import set_johnny_upgrade_rules

BASE_ID = 9990000


class JohnnyUpgradeWeb(WebWorld):
    tutorials = []
    theme = "partyTime"


class JohnnyUpgradeWorld(World):
    """Johnny Upgrade: a browser platformer where you repeatedly run a single map, buying
    permanent upgrades between rounds until you're strong enough to beat the boss at the end."""

    game = "Johnny Upgrade"
    web = JohnnyUpgradeWeb()
    options_dataclass = JohnnyUpgradeOptions
    options: JohnnyUpgradeOptions

    item_name_to_id = {name: BASE_ID + data.code_offset for name, data in item_table.items()}
    location_name_to_id = {name: BASE_ID + data.code_offset for name, data in location_table.items()}

    def generate_early(self) -> None:
        # shop.js only creates the shop's Play button at all when `game.ldat.spd.v` is truthy
        # (`if (game.ldat.spd.v) { shopObj.btnPlay = ... }`) -- since Speed is now entirely
        # item-gated (no local purchase grants it directly), a player who simply hasn't
        # received their first Progressive Speed item yet would have no way to ever start a
        # round at all. Guaranteeing one copy as starting inventory closes that softlock.
        self.multiworld.push_precollected(self.create_item(PROGRESSIVE_SPEED))

    def create_regions(self) -> None:
        menu = Region("Menu", self.player, self.multiworld)
        level = Region("Level", self.player, self.multiworld)
        self.multiworld.regions.append(menu)
        self.multiworld.regions.append(level)
        menu.connect(level)

        level.add_locations({FIND_THE_GUN: self.location_name_to_id[FIND_THE_GUN]}, JohnnyUpgradeLocation)
        for track, prices in SHOP_PRICES.items():
            for tier in range(1, len(prices) + 1):
                name = shop_location_name(track, tier)
                level.add_locations({name: self.location_name_to_id[name]}, JohnnyUpgradeLocation)

        if self.options.coinsanity:
            level.add_locations(
                {name: self.location_name_to_id[name] for name in COIN_LOCATION_NAMES}, JohnnyUpgradeLocation
            )
        if self.options.enemysanity:
            level.add_locations(
                {name: self.location_name_to_id[name] for name in ROBOT_LOCATION_NAMES}, JohnnyUpgradeLocation
            )

    def create_item(self, name: str) -> Item:
        data = item_table[name]
        return JohnnyUpgradeItem(name, data.classification, BASE_ID + data.code_offset, self.player)

    def get_filler_item_name(self) -> str:
        return SMALL_COIN_BUNDLE

    def create_items(self) -> None:
        pool: list[Item] = []
        for name in FIXED_ITEM_NAMES:
            data = item_table[name]
            # One Progressive Speed copy was already pushed to starting inventory in
            # generate_early() -- don't also put it in the regular pool, or the total item
            # count would exceed the total location count by one.
            count = data.count - 1 if name == PROGRESSIVE_SPEED else data.count
            pool.extend(self.create_item(name) for _ in range(count))

        total_locations = len(self.multiworld.get_unfilled_locations(self.player))
        needed_filler = total_locations - len(pool)

        filler_pool: list[str] = []
        for name in SCALABLE_FILLER_NAMES:
            filler_pool.extend([name] * item_table[name].count)
        self.random.shuffle(filler_pool)
        if needed_filler > len(filler_pool):
            # Should only happen if item_table's counts are edited without keeping the 328
            # total in sync with coinsanity+enemysanity both enabled -- pad with basic filler
            # rather than under-filling the pool.
            filler_pool.extend([self.get_filler_item_name()] * (needed_filler - len(filler_pool)))

        for name in filler_pool[:needed_filler]:
            pool.append(self.create_item(name))

        self.multiworld.itempool += pool

    def set_rules(self) -> None:
        set_johnny_upgrade_rules(self)

    def fill_slot_data(self) -> dict[str, Any]:
        return {
            "coinsanity": bool(self.options.coinsanity),
            "enemysanity": bool(self.options.enemysanity),
            "shop_prices": SHOP_PRICES,
            "coin_bundle_values": COIN_BUNDLE_VALUES,
            "upgrade_track_tiers": UPGRADE_TRACK_TIERS,
            "passive_income_seconds": self.options.passive_income_seconds.value,
            "passive_income_amount": self.options.passive_income_amount.value,
        }
