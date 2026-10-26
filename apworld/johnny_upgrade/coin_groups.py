"""Coin groups for the Coin Group Unlocks option.

A group is one visually distinct cluster of coins on the vanilla map, unlocked by its own named
item. The clusters were derived once from solver/data/maps.js by single-linkage clustering on coin
position (two coins share a cluster when they are within 130px; authored spacing is 60-90px), then
adjusted and named by hand: the far-left column is one group despite its wide spacing, and the
second-bomb and timed-laser areas each merge several small clusters. The table is frozen rather
than recomputed so item ids and group membership can never shift under existing seeds.

Each group is (item name, 1-based coin numbers). The numbers are map-data indices (coin N is
`maps[1].coins[N-1]`), which is what location ids are derived from, and they are listed in naming
order: left to right, ties broken top first. A coin's location name is its group's name with a
running number, so "Left spawn coin 1" is the leftmost coin of "Left spawn coins". Rows are ordered
by lowest coin, and that order fixes the item ids, so append new groups at the end rather than
inserting.

Location names were "Coin N" before this table existed. Ids did not change, so older seeds still
use those names; the client falls back to them when slot_data carries no coin_location_names.
"""

COIN_GROUP_TABLE: list[tuple[str, list[int]]] = [
    # x -530..-310, y 220..300
    ("Left spawn coins", [8, 7, 6, 5, 1]),
    # x 40..200, y 300
    ("Right spawn coins", [2, 3, 4]),
    # x -850..-600, y 80..240
    ("Spawn ledge coins", [97, 94, 19, 96, 18, 17, 95, 10, 9]),
    # x 480, y 300
    ("Crusher coin", [11]),
    # x 1060..1420, y 190..310
    ("Over spikes coins 1", [12, 16, 15, 14, 13]),
    # x 2780..3300, y 740..960
    ("Below laser coins", [20, 21, 22, 23, 32, 26, 25, 24, 27, 28, 33, 31, 30, 29]),
    # x 430, y 840..1560
    ("Pit elevator coins", [34, 37, 38, 39, 40, 41, 42, 43, 44, 45]),
    # x 720..1280, y 1200..1430
    ("Pit coins", [72, 35, 36, 188, 73, 46, 47, 189, 74, 48, 49, 190, 75, 50, 51, 191, 76, 52, 53, 192, 77, 54, 55, 193, 78, 56, 57, 194, 79, 58, 59]),
    # x 1170..1730, y 610..710
    ("Rafter coins", [80, 81, 182, 82, 83, 183, 68, 69, 184, 70, 71, 64, 65, 187, 66, 67, 185, 60, 61, 186, 62, 63]),
    # x -420..120, y 880..970
    ("Below gun coins", [90, 89, 91, 88, 87, 92, 86, 85, 93, 84]),
    # x 790..870, y 230..300
    ("Right of crusher coins", [98, 100, 99]),
    # x 1670..1740, y 110..180
    ("Over spikes coins 2", [104, 102, 103, 101]),
    # x 1900..1970, y 40..180
    ("First bomb coins", [109, 106, 105, 110, 108, 107]),
    # x 2300..2530, y 180..310
    ("Second bomb coins", [111, 112, 113, 114]),
    # x 2760..2830, y 540
    ("Above laser coins", [115, 116]),
    # x 1880..2300, y 900
    ("Sawblade coins", [123, 121, 122, 119, 120, 117, 118]),
    # x -235..310, y 610..690
    ("Timed laser coins", [129, 128, 127, 124, 126, 125]),
    # x -450..-270, y 1670..1850
    ("Four squares coins", [131, 133, 130, 134, 132]),
    # x -830..-500, y 1270..2030
    ("Big corner coins", [135, 143, 151, 159, 167, 179, 139, 147, 155, 163, 171, 181, 229, 230, 136, 144, 152, 160, 168, 180, 140, 148, 156, 164, 172, 137, 145, 153, 161, 169, 141, 149, 157, 165, 138, 146, 154, 162, 170, 142, 150, 158, 166, 175, 173, 174]),
    # x -360, y 1270..1430
    ("Third bomb coins", [178, 177, 176]),
    # x 520..1430, y 1840..1920
    ("Before boss coins", [196, 195, 197, 199, 198, 200, 202, 201, 203, 205, 204, 206, 208, 207, 209, 211, 210, 213, 212, 214, 216, 215, 217, 219, 218, 220, 222, 221, 223, 225, 224, 226, 228, 227]),
    # x 140..350, y 1880..1980
    ("Below spikes coins", [231, 232, 233, 236, 234, 237, 235]),
    # x -1255, y 390..1920
    ("Chute coins", [238, 239, 240, 241, 242, 243, 244, 245, 246]),
]

COIN_GROUP_ITEM_NAMES: list[str] = [name for name, _coins in COIN_GROUP_TABLE]

COIN_GROUPS: list[list[int]] = [coins for _name, coins in COIN_GROUP_TABLE]

# The cluster directly left of the spawn point. Always precollected while the option is on, so a
# fresh seed has coins to collect in sphere 1. It is still a real item so this can change later.
STARTING_COIN_GROUP_ITEM = "Left spawn coins"

# Location name stem per group. Groups whose item name already ends in a number put the running
# number after "coin" instead, and a single-coin group gets no number at all.
_LOCATION_STEM_OVERRIDES = {
    "Over spikes coins 1": "Over spikes 1 coin",
    "Over spikes coins 2": "Over spikes 2 coin",
}


def _location_stem(group_name: str) -> str:
    if group_name in _LOCATION_STEM_OVERRIDES:
        return _LOCATION_STEM_OVERRIDES[group_name]
    return group_name[:-1] if group_name.endswith("coins") else group_name


# Coin number (1-based map index) -> location name.
COIN_LOCATION_NAME_BY_COIN: dict[int, str] = {}
for _name, _coins in COIN_GROUP_TABLE:
    for _i, _n in enumerate(_coins):
        _stem = _location_stem(_name)
        COIN_LOCATION_NAME_BY_COIN[_n] = _stem if len(_coins) == 1 else f"{_stem} {_i + 1}"

# Coin number (1-based) -> its group's item name.
COIN_GROUP_ITEM_BY_COIN: dict[int, str] = {
    n: COIN_GROUP_ITEM_NAMES[g] for g, coins in enumerate(COIN_GROUPS) for n in coins
}
