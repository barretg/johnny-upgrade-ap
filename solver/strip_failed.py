"""Apply hand-testing corrections to apworld/johnny_upgrade/generated_requirements.py.

The solver proves what is physically possible; the harness in
client/johnny-upgrade-logic-test.user.js records what a person can actually execute. Some of the
solver's minimal routes are frame-perfect (clearing plat2's ledge at Speed 5 / Jump 4 leaves
6.4px of headroom inside a 7-frame window) and will never happen in real play.

The harness does not delete requirements -- it CORRECTS them. For every location it records the
stats that were actually in effect when you reached it, so a requirement the solver set too low
gets raised to what really worked, per location.

    python solver/strip_failed.py logic-test-results.json [--write]

What each harness outcome does here:
    reached with the rule's own stats   -> requirement unchanged
    reached with stronger stats         -> requirement RAISED to those stats for that location
    never reached ("Can't reach rest")  -> option dropped from that location
    skip / untested                     -> left alone

Raising and dropping both make logic STRICTER, so neither can turn a beatable seed into an
unbeatable one. Dropping a location's LAST option would make it unreachable, so that is refused
and reported for a human decision.

This edits generated_requirements.py in place because that is the file the apworld imports. It
does not touch the atlas or requirements.json, so re-running report.js would undo it -- keep the
results JSON and re-apply after any regeneration.
"""

import argparse
import importlib.util
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TARGET = ROOT / "apworld" / "johnny_upgrade" / "generated_requirements.py"

KEYS = ("speed", "jump", "double", "energy", "ammo", "time")


def load_module(path: Path):
    spec = importlib.util.spec_from_file_location("generated_requirements", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def opt_key(o: dict) -> tuple:
    """Canonical identity of a requirement object."""
    return (
        o.get("speed", 0),
        o.get("jump", 0),
        1 if o.get("double") else 0,
        o.get("energy", 1),
        o.get("ammo", 0),
        o.get("time", 0),
    )


def from_harness(r: dict) -> dict:
    """Convert the harness's compact {s,j,d,e,g,t} into a requirement object."""
    o = {"speed": r.get("s", 0)}
    if r.get("j"):
        o["jump"] = r["j"]
    if r.get("d"):
        o["double"] = True
    if r.get("e", 1) > 1:
        o["energy"] = r["e"]
    if r.get("g"):
        o["ammo"] = r["g"]
    if r.get("t"):
        o["time"] = r["t"]
    return o


def emit(o: dict) -> str:
    parts = [f'"{k}": {"True" if o[k] is True else o[k]}' for k in KEYS if k in o]
    return "{" + ", ".join(parts) + "}"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("results")
    ap.add_argument("--write", action="store_true")
    args = ap.parse_args()

    gr = load_module(TARGET)
    classes = gr.REQUIREMENT_CLASSES
    coin_ids = list(gr.COIN_REQUIREMENT_IDS)
    robot_ids = list(gr.ENEMY_REQUIREMENT_IDS)

    # Global location order must match the harness's plan indices, which come from
    # solver/locations.js: coins, then the gun, then the boss, then the robots.
    n_coins = len(coin_ids)
    order = list(coin_ids) + [gr.GUN_REQUIREMENT_ID, gr.BOSS_ARENA_REQUIREMENT_ID] + list(robot_ids)
    names = (
        [f"Coin {i + 1}" for i in range(n_coins)]
        + ["Find the Gun", "Boss Arena"]
        + [f"Robot {i + 1}" for i in range(len(robot_ids))]
    )

    payload = json.loads(Path(args.results).read_text(encoding="utf8"))
    results = payload.get("results", payload)

    # (original option key, location index) -> replacement option, or None to drop it
    edits: dict[tuple, dict | None] = {}
    n_tested = n_raised = n_dropped = 0
    for entry in results.values():
        if not entry or "req" not in entry:
            continue
        status = entry.get("status", "untested")
        if status in ("untested", "skip"):
            continue
        n_tested += 1
        original = from_harness(entry["req"])
        ok = opt_key(original)
        for li_str, stats in (entry.get("achieved") or {}).items():
            li = int(li_str)
            corrected = from_harness(stats)
            if opt_key(corrected) == ok:
                continue  # worked as specified
            edits[(ok, li)] = corrected
            n_raised += 1
        for li in entry.get("missing", []):
            if (ok, li) not in edits:
                edits[(ok, li)] = None
                n_dropped += 1

    print(f"results: {n_tested} tested rule(s) -- {n_raised} correction(s), {n_dropped} unreached")
    if not edits:
        print("nothing to change.")
        return 0

    # Resolve each location to its own option list and apply the edits, then re-deduplicate. A
    # class is shared by many locations, so correcting one of them has to split the class rather
    # than change it for everyone.
    per_loc: list[list[dict]] = []
    emptied: list[str] = []
    changed_locs = 0
    for li, cid in enumerate(order):
        opts = classes[cid]
        kept: list[dict] = []
        touched = False
        for o in opts:
            if (opt_key(o), li) in edits:
                touched = True
                repl = edits[(opt_key(o), li)]
                if repl is None:
                    continue
                if not any(opt_key(repl) == opt_key(k) for k in kept):
                    kept.append(repl)
            else:
                kept.append(o)
        if not kept:
            emptied.append(names[li])
            kept = list(opts)  # refuse to make a location unreachable
        elif touched:
            changed_locs += 1
        per_loc.append(kept)

    print(f"{changed_locs} location(s) changed")
    if emptied:
        print(f"\n!! {len(emptied)} location(s) would lose their LAST option and become unreachable.")
        print("!! Left untouched -- these need a human decision: either the map genuinely demands")
        print("!! a route nobody can execute, or those rules need re-testing with stronger stats.")
        for n in emptied[:20]:
            print("   " + n)
        if len(emptied) > 20:
            print(f"   ... and {len(emptied) - 20} more")

    # Re-deduplicate into a fresh class table.
    new_classes: list[list[dict]] = []
    index: dict[str, int] = {}
    new_ids: list[int] = []
    for opts in per_loc:
        key = json.dumps(sorted(emit(o) for o in opts))
        if key not in index:
            index[key] = len(new_classes)
            new_classes.append(opts)
        new_ids.append(index[key])
    print(f"classes: {len(classes)} -> {len(new_classes)}")

    if not args.write:
        print("\ndry run -- pass --write to update generated_requirements.py")
        return 0

    header = TARGET.read_text(encoding="utf8").split('"""')[1]
    out = ['"""' + header + '"""', ""]
    out.append("# Each entry is one alternative set (OR); each dict inside is a set of minimums (AND).")
    out.append("REQUIREMENT_CLASSES: list[list[dict]] = [")
    for i, opts in enumerate(new_classes):
        out.append(f"    # {i}")
        out.append("    [" + ", ".join(emit(o) for o in opts) + "],")
    out.append("]")
    out.append("")

    def dump(name: str, ids: list[int], labels: list[str]) -> None:
        out.append(f"{name}: list[int] = [")
        for cid, label in zip(ids, labels):
            out.append(f"    {cid},  # {label}")
        out.append("]")
        out.append("")

    dump("COIN_REQUIREMENT_IDS", new_ids[:n_coins], names[:n_coins])
    dump("ENEMY_REQUIREMENT_IDS", new_ids[n_coins + 2 :], names[n_coins + 2 :])
    out.append(f"GUN_REQUIREMENT_ID = {new_ids[n_coins]}")
    out.append(f"BOSS_ARENA_REQUIREMENT_ID = {new_ids[n_coins + 1]}")
    out.append("")

    TARGET.write_text("\n".join(out), encoding="utf8")
    print(f"\nwrote {TARGET}")
    print("re-run: python solver/validate_apworld.py")
    return 0


if __name__ == "__main__":
    sys.exit(main())
