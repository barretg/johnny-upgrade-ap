# mapeditor

Authoring tooling for custom Johnny Upgrade maps. Deliberately independent of
the Archipelago work in `apworld/` and `client/` -- this folder only knows about
the *game's* map format, so it stays useful on its own and is never shipped as
part of the AP client.

The one shared file is `../solver/data/maps.js`, the vanilla map data verbatim as
the game declares it. Nothing here imports anything AP-specific.

## The map format

Not a tilemap. `maps[1]` in `js/level.js` is one plain object literal of flat
arrays, and `iniLevel()` is the only thing that reads it:

| key        | n   | meaning                                                      |
|------------|-----|--------------------------------------------------------------|
| `plats`    | 35  | solid rects; `semi:1` one-way, `stomper:true` falling block   |
| `coins`    | 246 | points                                                        |
| `spikes`   | 8   | rects                                                         |
| `bombs`    | 3   | drifting sine-wave hazards                                    |
| `lasers`   | 4   | timed beams (index 0 is force-rotated horizontal, see below)  |
| `enes`     | 8   | 2 unkillable saws + 6 robots, patrolling between min/max      |
| `platMove` | 3   | moving platforms                                              |
| `areas`    | 15  | camera regions: center offset + clamp box                     |
| `bossData`, `door`, `sprt`, `colGun` | -- | boss gate/range, door, spawn, gun pickup |

Coordinates are free-form floats, not grid cells. Every one of these is meant to
be drag-and-droppable in the editor.

## How the art works

Platforms are **invisible**. `iniLevel()` builds a non-stomper plat as a bare
`{}` with bounds and no sprite. Everything visible is one hand-painted 5130x3330
mural, `assets/pics/lvlGrfx.png`, shipped as six 1710x1665 slices (`lvlGrfx1`..
`lvlGrfx6`) placed at fixed offsets from world `(-1620, -720)`. So art maps 1:1
to world space:

```
artPixel = worldCoord + (1620, 720)
```

Measured over the vanilla map:

- Every `plats` rect is **99.9-100% opaque** in the mural. Collision and art agree.
- Platform interiors are **90.3% pure black** below the top 60px of each large
  platform. The rest is scattered painted decoration.
- The industrial metal floor repeats at exactly **100px** (autocorrelation 1.00);
  the wooden one-way plank at 70px.
- `plat.gif` is an unused 100x100 debug block loaded by `loader.js`. That plus
  the metal floor's pitch pins 100px as the author's grid unit.
- Eight platforms (3, 6, 12, 13, 19, 27, 28, 33) have **no top decoration at
  all** -- their art is on another face. Faces must be texturable independently.

### Composition model

    black base block  (procedural #000000, any size: 100 / 50 / 25)
      + face texture  (top / wall / underside), stretched to the face
      + corner piece  at the ends of a run
      + overlay       decoration placed on top

Base blocks need no extraction -- they are just black. Surfaces are stretched to
whatever space a face gives them, rotated, and mirrored at runtime; corners are
surfaces rounded off. None of those variants are baked, because the editor
allows arbitrary transforms anyway.

## Tile pipeline

The tileset is **hand-cut**, then normalised programmatically. Automated
derivation was attempted several times and abandoned: the mural is not built
from strips, and component analysis cuts down to individual pebbles rather than
the repeated multi-stone arrangements that are the real authoring unit.

```
tiles/manual/      hand-cut PNGs (opaque rectangular crops from the mural)
  + normalize.config.json      per-tile overrides
        |  node tools/normalize-manual.js
        v
tiles/normalized/  exact, tightly-bounded, transparent-background textures
        |  node tools/sheet.js normalized 32 5 320
        v
tiles/normalized/_sheet.png    visual check
```

`normalize-manual.js` does four things:

1. **Background removal.** Flood-fills from the border, treating a pixel as
   background only if it is BOTH very dark AND near-neutral (default luma <= 14,
   chroma <= 12). Luma alone fails in both directions: a loose cut eats the rock
   tiles' dark browns and hollows `x_center_surface` through the diagonal gaps
   between its arms; a tight cut leaves the grass and spikes their whole black
   surround. Chroma separates them -- this mural's texture is coloured even when
   dark, its background is flat neutral.
2. **Enclosed pockets** (opt-in, `"pockets": true`). Background the border flood
   cannot reach. The rail is the clear case: a bracket whose band between the two
   bars is `rgba(32,32,32)` sealed in by the bars and side posts. Opt-in because
   the same shape means the opposite elsewhere -- the box is a solid unit whose
   dark centre is texture.
3. **Edge un-mixing.** An edge pixel is already a blend of texture over black.
   Dropping its alpha without touching RGB leaves a dark semi-transparent pixel
   that composites as a black halo, outlining every hole in the rope and every
   gap in the spikes. Background is black, so `true = observed / alpha` recovers
   the colour and the halo goes.
4. **Tight trim**, then removal of stale outputs for tiles since excluded.

### normalize.config.json

Tune per tile here rather than moving the global default:

```json
{ "box":  { "mode": "none" },
  "rail": { "luma": 40, "chroma": 30, "pockets": true },
  "spike_needs_bottom_and_right_trimmed": { "exclude": true } }
```

- `mode: "none"` -- trim only. For complete units that never have anything behind
  them (the box, the blue accent surfaces, whose accents were being cut into).
- `pockets` -- also strip enclosed background.
- `exclude` -- not part of the set. Auto-detected for names containing
  `example`, which are reference crops showing how the original map stretched a
  tile, not tiles themselves.
- `luma` / `chroma` -- override the two cuts of the general rule.
- `bg` / `tol` -- **exact background matching**, and the better rule wherever a
  tile has dark internal detail. This mural's background is a specific colour,
  not "anything dark": pure `#000000` in most places and `#202020` around the
  metal and rock corners. Raising `luma` enough to catch `#202020` also strips
  the near-black mortar between the rock block's stones; matching the colour
  directly removes the surround and leaves the mortar alone. Note that listing
  `[0,0,0]` alongside it defeats the point on such a tile, since the mortar is
  itself near-black -- match only the colour actually present at the edges.
- `crop: [left, top, right, bottom]` -- cut a fixed margin off before anything
  else, for when a rect caught part of a *neighbouring* object. No threshold can
  separate that, because it is real texture, just not this tile's. Authored in
  cut pixels and scaled to mural pixels by the tile's recovered scale.
- `mask: [[x, y, w, h], ...]` -- erase rectangles instead of whole margins, and
  usually the better tool. A neighbour typically intrudes into a *corner*, not
  down an entire side. The boss door is the case: the metal beside it occupies
  only columns 0-2 and rows 0-9, a 3x10 block, but `crop: [15,0,0,0]` took about
  seven columns of the door's own green off the full height to remove it. A
  `mask: [[0,0,4,11]]` takes the metal and nothing else.

  Masks are authored in the **extracted region's own pixels** -- mural pixels at
  1:1, the coordinates the aligner and `extract-from-mural.js` both work in. The
  snip path does not apply them: it works on magnified captures in a different
  pixel space, and it is a reference path now. The recipe that ships is the
  mural path.

Cut dimensions are deliberately not corrected. Several cuts are shorter than a
full run of that texture in the map, and the rope is simply tall; neither
matters, because every surface is stretched to the face it is applied to.

### Outstanding tile work

- **Grass reconciliation.** Two cuts: one has taller grass but a row of rocks
  occluding its base, the other shorter grass with a clean dirt band. Combine
  into one; keep only the result.
- **Small enclosed specks** remain on a few tiles (robot-face panels, dashes
  beside the green beam) where `pockets` is not enabled.

## Recovering where the cuts came from

We cannot distribute Coolmath/Miniclip's artwork, so `mapkit` rebuilds the
tileset at load time from the player's own `lvlGrfx.png`. That means shipping a
**recipe** per tile -- a source rectangle plus the params already in
`normalize.config.json` -- rather than pixels. It also means the tiles come out
sharper than the hand cuts, since they are re-extracted at true 1:1.

The cuts were taken with Snipping Tool, so each is a resampled screen capture at
whatever the viewer's zoom times Windows' DPI scaling happened to be -- and the
factor differs per snip. A pixel-exact crop would share 100% of its palette with
the mural; these share 3-55%, and the rope alone holds 11,145 distinct colours
against the whole mural's 12,465. So exact template matching cannot work.

### tools/locate-cuts.js

Two stages.

**Coarse: colour signature.** Colour composition is scale-invariant -- resampling
invents in-between colours but preserves the dominant ones and their proportions.
Each cut gets a signature of quantised colours (4 bits per channel) ranked by
rarity in the mural, and candidate rectangles are scored by **histogram
intersection** against it, made O(bins) by one integral image per bin.

Scoring by mean "is this a signature colour" instead was the first attempt and is
wrong: it rewards small windows sitting inside a single signature colour, biasing
every match toward the smallest window and so the largest scale. It drove every
rock tile to 3.3-4.4x. Comparing distributions fixed that, and lifted the rock
subset from 3/7 to 5/7.

**Fine: NCC.** Normalised cross correlation at full resolution around the peaks,
refining scale and offset. NCC rather than a difference metric because a screen
capture drifts in brightness and contrast.

Result on the full set: **19 of 28 above 0.80**, verified by extracting the
located rectangles and eyeballing them against the cuts.

The failures share a property -- too little information to match on.
`green_beam_surface` is a near-uniform bar, so its grayscale variance is ~0 and
NCC is undefined; `blue_beam_surface` reduces to a 9px featureless strip. No
correlation metric can place these, at any parameter setting.

### align/ -- manual alignment

So the last few are placed by hand, which is quick and certain. `align/` is a
local tool that overlays each cut on the mural to drag, nudge and scale into
place, seeded from the automated pass where that succeeded.

```
node align/server.js          # then open http://127.0.0.1:7731/
```

- **difference blend** is the trick: a correct alignment goes flat black
- live NCC readout, advisory only -- it reads `n/a` for the flat tiles, which are
  exactly the ones needing the eye
- drag to move, `alt+wheel` or `[` `]` to scale, arrows to nudge (shift = 10px)
- `j`/`k` walk the list, Enter marks a tile done
- Save writes `tiles/manual/provenance.json`

A rect marked confirmed there is never overwritten by a later `locate-cuts.js`
run -- automated matching seeds the manual work, it does not undo it.

The drag/scale/overlay canvas is deliberately the same interaction the map editor
needs, so this doubles as a prototype of it.

### tools/extract-from-mural.js

With every rect confirmed, this rebuilds the tileset from the mural at true 1:1:

```
node tools/extract-from-mural.js        # confirmed rects only
node tools/extract-from-mural.js --all  # include unconfirmed
node tools/sheet.js extracted 29 5 300
```

The result is sharper than the hand cuts, which were magnified screen captures --
these skip the resampling entirely. Normalisation runs through `lib/normalize.js`,
the same module the snip path uses, because mapkit has to reproduce it exactly;
two copies would drift. `crop` margins are authored in cut pixels and scaled to
mural pixels here.

**The shipped artefact is `provenance.json` + `normalize.config.json`.** Together
they are a complete recipe for rebuilding all 29 tiles from a player's own
`lvlGrfx.png`, so nothing copyrighted is distributed.

#### The clipping check

Each rect is tested for texture continuing past its edges. The obvious test --
does content touch the rect border -- is wrong, because a rect bounded tight to a
silhouette touches its border on every side by definition and the check just
fires constantly. What matters is what sits *immediately outside* the edge in the
mural: background means the bound is complete however tight it is, more texture
means something continues past.

Continuation along a tile's **long axis** is expected and filtered out, because
that is what makes a run a run. Which sides those are depends on orientation, not
on the name -- `green_beam_surface` and `rope` are vertical, so they continue top
and bottom exactly where a horizontal surface continues left and right. Judging
by name alone flagged every vertical surface as clipped.

What survives the filter is worth an eye: either the tile is clipped there, or it
abuts a neighbouring object. Clipped means grow the rect; abutting means the rect
is right and `crop` is the lever if the neighbour bleeds in. Neither is fixable
after extraction.

## Runtime architecture

Two packages, one-way dependency. `mapkit` must not know Archipelago exists.

```
mapeditor/     authoring only, NEVER shipped to AP
mapkit/        runtime, ships standalone AND bundles into the AP script
  renderer.js  draws base + surface + corner + overlay from map data
  patcher.js   swaps window.maps[n] before iniLevel
  select.js    level select screen
  api.js       plug-in surface
  packs/       map packs (.json)
```

The seam is inversion -- mapkit asks, AP answers:

```js
mapkit.setLockProvider(id => boolean)   // default: everything unlocked
mapkit.on('levelStart', cb)
mapkit.on('levelComplete', cb)
```

Standalone, the default provider unlocks everything. The AP client supplies a
provider backed by received items and subscribes to the events to send checks.

Map format is the vanilla object plus `art` (texture placements with transform
and z-order) and `meta` (id, name, content hash). The hash stops a client and
generator disagreeing about which map they are on.

## Hardcoded world coordinates

Baked into the game's code, not the map data. Since the boss arena and hazards
are meant to be drag-droppable, `patcher.js` has to patch these from map data:

- `js/boss.js`: `game.door.ymax = 1810`, `if (boss.y < 2040)`, `if (boss.y < 2400)`
  -- the boss rise sequence is pinned to the vanilla pit's absolute Y.
- `js/level.js` `stomperCode()`: triggers on `sprt.y <= 360`.
- `js/level.js` `iniLevel()`: `lasers[0]` is force-rotated to a horizontal 590px
  beam regardless of what the map says.
- `world.yEnd = ldat.yEnd` -- vanilla `maps[1]` has no `yEnd`, so the
  fell-out-of-the-world check never fires. A custom map should set it.

## Tools

Zero-dependency Node, no build step.

- `lib/png.js` -- minimal PNG read/write/crop/scale (uses only `zlib`).
- `tools/normalize-manual.js` -- hand-cut tiles to normalised textures.
- `tools/locate-cuts.js [--only <substr>]` -- find each cut's source rect in the
  mural (colour signature, then NCC). Merges into provenance.json.
- `tools/extract-from-mural.js [--all]` -- rebuild the tileset from the mural at
  1:1 using the confirmed rects; flags anything clipped.
- `lib/normalize.js` -- shared normalisation core, used by both tile paths.
- `align/server.js` -- manual alignment tool; serves the mural and cuts to a
  drag/scale overlay page and saves provenance.json.
- `tools/sheet.js <dir> [n] [cols] [maxcell]` -- contact sheet for any tile
  directory with a `manifest.json`. Oversized tiles scale to fit rather than
  being clipped.

`tiles/` is gitignored: it is Coolmath/Miniclip's artwork, and it regenerates
from a local SDK copy plus the hand cuts.
