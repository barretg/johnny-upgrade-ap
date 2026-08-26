# Sharing custom levels

## The two userscripts

Pick one. Both are a single file, installed in Tampermonkey.

| | what it is |
|---|---|
| `dist/johnny-upgrade-custom-levels.user.js` | play custom levels: level select, import, per-level saves |
| `dist/johnny-upgrade-map-editor.user.js` | all of that **plus the editor**, for people who want to build levels |

The editor script is a superset, so installing both just gives you two level
selects fighting over the title screen. The playing script is smaller (76KB vs
181KB) and is the right one to hand to someone who only wants to play.

Neither talks to a server. The editor script keeps levels in the browser's own
storage and moves them as files through **Export** and **Import level…**; the
hosted editor (`mapeditor/HOSTING.md`) is a separate, optional thing for a group
working on levels together.

Rebuild after changing anything in `mapkit/`:

```
node mapkit/build-userscript.js
node mapkit/build-userscript.js --maps mapeditor/maps    # bundle levels in
node mapeditor/tools/build-editor-userscript.js          # the editor build
```

Both scripts match `https://www.coolmathgames.com/0-johnny-upgrade/play*` and
nothing else. The game lives in that frame; matching the wrapper page as well
put a second copy on a page with no game in it, which polled for a minute and
then logged "game never appeared" — which reads exactly like the real failure
and is not one.

Without `--maps` it ships empty and players import their own, which is the right
default for testing: the script goes out once, levels move separately.

**No game artwork is included.** Textures are rebuilt at load time from the
player's own copy of `lvlGrfx1..6`; the script carries only a list of source
rectangles (`mapkit/tiles.json`, ~7KB). Verified byte-identical to the
build-time extraction for all 28 tiles.

**Ad breaks are untouched.** Where the page provides `cmgAdBreak` it is called
exactly as the game intends. The patcher only installs a stand-in when one is
genuinely absent — a local dev host — and no option can skip a real one.

## Handing a level to someone

Send two things:

1. the userscript, once
2. the `.json` level file, from `mapeditor/maps/`

They install the script, open Johnny Upgrade on coolmathgames.com, and use
**Import level…** on the select screen. Imported levels live in their browser
and survive reloads. Several files can be imported at once, and the grid pages
past 12 levels.

Each level keeps its **own** save — upgrades, cash and stats live under
`ldat:<id>`, so progress never leaks between levels. The ↺ on a card resets that
one level; **Reset save data** in the menu clears them all. The stock game's own
save is left alone, so normal play is unaffected.

## The level file format

A level is a single `.json` file, exactly as the editor saves it: the game's own
field names, plus two additions.

```jsonc
{
  "meta": { "id": "my-level", "name": "My Level" },

  // read directly by the game's iniLevel()
  "plats":    [{ "x": 0, "y": 0, "w": 100, "h": 20, "right": 100, "bottom": 20 }],
  "coins":    [{ "x": 50, "y": -40 }],
  "spikes":   [{ "x": 0, "y": 0, "w": 60, "h": 30 }],
  "bombs": [], "lasers": [], "enes": [], "platMove": [], "areas": [],
  "bossData": { "gate": { "l":0,"t":0,"r":0,"b":0 }, "range": { "l":0,"t":0,"r":0,"b":0 } },
  "door":     { "l": 0, "t": 0, "r": 0, "b": 0 },
  "sprt":     { "x": 0, "y": -50, "xx": 1 },
  "colGun":   { "x": 0, "y": 0 },

  // mapkit additions
  "doors": [{ "x":0,"y":0,"w":100,"h":250, "trigger":"zone", "zx":0,"zy":0,"zw":400,"zh":300 }],
  "art":   [{ "tile":"grass_surface", "x":0,"y":-34,"w":149,"h":34, "rot":0,"flipX":0,"flipY":0,"z":0 }]
}
```

`art` is the visual layer. Platforms are **invisible** in this game — in the
stock level the only thing that makes one visible is the painted background — so
without `art` a level renders as plain black boxes. `doors` supersedes the single
`door` field and supports as many as you like. `iniLevel()` ignores keys it does
not recognise, so a file carrying these extras still loads in the stock game.

### Fields that are easy to get wrong

- **`z` on art** — the LOWEST z in a map draws *behind* Johnny, everything above
  draws in front. That is how grass sits behind his feet.
- **camera `areas`** — `xx`/`yy` set how far ahead the camera looks; the four
  clamps bound it. **`0` means no clamp**, not a clamp at zero, because the game
  truthiness-tests them. Settings persist after Johnny leaves an area, so cover
  the map fairly continuously or the camera keeps an old offset.
- **crushers** (`"stomper": true` on a platform) — `fallTo`, `trigX`, `trigW`,
  `trigY`, `accel`, `damage`, `repeat`, `resetIn`. Omit any and it falls back to
  the stock constant. The stock game allowed exactly one crusher, stopping at a
  fixed `y = -60`, with a trigger band that never scaled; all of that is now per
  crusher.
- **doors** — `closeTo`, `speed`, `trigger` (`start` / `zone` / `boss` /
  `never`), `zx`/`zy`/`zw`/`zh` for the zone, `open` to slide the other way.
- **lasers** — `length` and `horizontal`. The stock game force-rotated the first
  laser to a horizontal 590px beam and gave the rest a 40x180 upright box,
  whatever the map said; both are now per laser. A map with neither field still
  gets exactly those vanilla shapes.
- **`art: []`** — an empty art layer is not the same as no art layer. A map with
  the key, empty or not, is a custom map: the vanilla mural is hidden and
  platforms are filled black. A map with no `art` key at all is the stock level,
  whose art *is* the mural.

## Building levels in the browser

With the editor script installed, the level select grows a **Level editor**
button, and every level this browser owns gets a ✎ to reopen it.

- **save** puts the level in the level select immediately — the editor and the
  select share one store
- **play** runs it right there, with a playtest panel: the nine upgrade tracks
  as sliders, defaulting to maxed, remembered between runs. Finishing or dying
  comes back to the **editor**, not to the level select, because the reason you
  were playing it is that you are still working on it
- **export** writes the `.json` out, which is how a level leaves the browser
- **start from vanilla** copies the stock level, which is already in the page

## What the player sees

Level select replaces the title screen. It shows every available level with the
thumbnail the editor rendered on save, an **Import level…** button, music and
sound toggles, and the reset controls. Finishing a level returns there.

Under Archipelago the same screen greys out locked levels with a reason. Nothing
in `mapkit` knows Archipelago exists — the client supplies a lock provider and
listens for `levelStart` / `levelComplete`.
