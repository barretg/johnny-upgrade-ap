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
| `lasers`   | 4   | timed beams; length + orientation are map data (see below)    |
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

## The editor runs in two places

One editor, two hosts. `editor/editor-core.js` is the whole thing -- object
model, canvas, panels, history -- and it knows nothing about where maps or
textures come from. Everything environment-specific goes in behind one `io`
object:

```
editor/editor-core.js   the editor. Shared verbatim by both hosts.
editor/index.html       host 1: the dev server. Maps are files, modules are
                        files in modules/, textures are PNGs from
                        tiles/extracted/, Play opens /play.
editor/editor-host.js   host 2: inside the game page. Maps live in
                        localStorage, textures come from the canvases mapkit
                        rebuilt out of the player's own artwork, Play hands the
                        level straight to the running game.
editor/editor-play.js   playtest controls (the upgrade sliders and what the
                        tier encoding means), shared by quick-run and host 2.
```

`MapEditor.mount({ root, io })` returns `{ open, close, isOpen, openMap,
destroy }`. In the page it is mounted once and always open; in the game it is an
overlay that opens over the level select, which is why `close()` exists and why
the key handlers are inert while it is shut -- the same keys belong to the game
the rest of the time.

The second host is the shareable one:

```
node mapeditor/tools/build-editor-userscript.js
  -> dist/johnny-upgrade-map-editor.user.js
```

That file is **completely self-contained**: no server, ours or anyone's. It is a
superset of the custom-levels script -- same runtime, same level select, plus an
editor -- so install one or the other, not both. Levels are saved into the same
localStorage store the level select imports into, so saving one publishes it to
the select screen immediately, and **Export** writes a `.json` to hand to
someone else. Hosting (`HOSTING.md`) remains the multi-person option; it is now
a preference rather than a requirement.

## Editing gestures

Anything the map stores as numbers that decide where a hazard *reaches* is
draggable, because those are the fields that look right in a panel and play
wrong in the level.

- **Patrol ranges** -- two round handles at the corners of the min/max box.
- **Laser beams** -- a laser is drawn at the size it actually hurts at (the
  game's own 40px-wide collision box), with a handle at each end. Dragging one
  sets the length; dragging it past the diagonal stands the beam up or lays it
  flat. The emitter stays where it is, since the map stores the centre.
- **Camera clamps** -- drawn as a box beside the area it belongs to, solid on
  the sides that are clamped and ghosted along the area's own edge on the sides
  that are not. **Zero means no clamp**, never a clamp at zero, because the game
  truthiness-tests them -- so dragging a side back onto the area edge is how a
  clamp is switched off, and the unset handles sit slightly inside the box so
  they do not land on top of the area's own resize handles.
- **Door trigger zones** -- green handles, eight to resize and one to move.
- **Several objects at once** -- the selection gets one box with the usual eight
  resize handles plus a rotate handle above it. Rotation goes in quarter turns
  because the map format cannot express anything else: plats, spikes, areas and
  boss zones are axis-aligned rects in the game's own data. Textures do carry an
  angle, so they keep their frame and take the rotation on `rot`. Everything
  attached comes along -- patrol ranges, trigger zones, clamp boxes, crusher
  landing lines -- and a rotated camera clamp keeps which SIDES were clamped.
- **Grid snapping applies to the selection, not to each object.** One offset is
  computed from the object actually under the cursor, snapped once, and applied
  to everything. Snapping each object separately pulls a carefully spaced run of
  platforms onto the nearest lines and destroys the spacing that was drawn.
- **The coordinate readout** sits bottom left and follows the mouse whether or
  not anything is being dragged; with a grid set it also shows where the next
  click would land.
- **Module entry/exit markers** -- while the save-as-module panel is open, two
  round markers sit on the canvas. They are hit-tested *before* every other
  handle, because they routinely land exactly on a platform corner.
- **Ctrl is the one "and this one too" modifier.** On an object it toggles that
  object in or out of the selection and adopts its settings; a ctrl+drag on blank
  space marquees *additively*; a ctrl *click* on blank space drops back to the
  select tool. Alt used to do the selection half and ctrl the eyedropper half,
  which was two modifiers for one idea and one more thing to remember.
- **A rotated texture has a rotated box.** `rot` is applied by the renderer about
  the object's centre, so a quarter-turned tile draws at right angles to the w/h
  it stores. Hit-testing, the marquee and the resize handles all work from the box
  on SCREEN; a resize comes back out of the rotation before it writes w/h. Until
  Phase 5b-8 they did not, and a turned tile could only be grabbed by the empty
  space beside it.
- **The floating panels are not the canvas.** The module dialog and the rung
  reference sit over the stage, so their mousedown bubbles to the canvas handler
  underneath; a click that lands on one of them is ignored rather than dropping an
  object into the world behind it.

### Paint mode

A room is thirty platforms, and thirty platforms used to be thirty clicks, thirty
drags and thirty squints at the coordinate readout. **Paint** (the toolbar button,
or `p`) turns a drag into a stroke: every grid cell the cursor enters gets one
stamp.

**What gets stamped is the clipboard, if there is one.** Copy a selection and a
stroke tiles *that* -- which is the difference between filling cells with
platforms and tiling a motif, and tiling a motif is most of what building a room
is. The footprint is the copied group's bounding box rounded up to whole cells, so
the never-stamp-twice rule keys on the whole footprint rather than one cell. An
empty clipboard falls back to the armed tool, so paint is never a mode that
quietly does nothing.

**Shift locks the stroke to one axis.** Straight floors and straight walls are
nearly everything anyone paints and a freehand drag makes neither. The axis is
latched once the stroke is two cells clear of where it began: deciding it fresh
every move draws an L, because the first cells of any stroke are diagonal-ish and
whichever axis leads by one wins for a moment.

Three rules, and each is what makes a stroke usable rather than work to clean up
afterwards:

- **A stamp fills its cell exactly.** Not "snapped to the nearest grid line" --
  that still lets two stamps sit a cell apart with a hairline between them, and a
  hairline in a platform run is a hole Johnny falls through.
- **A cell is never stamped twice.** Dragging back over your own stroke is free,
  and the shaky part of a fast drag does not stack forty platforms in one place.
- **The whole stroke is one undo.** A stroke that undoes cell by cell is worse
  than no undo at all.

Paint needs a grid, since a cell is the unit it works in; picking `free` turns it
off rather than guessing a size. It is a **mode**: while it is on the canvas
paints and does nothing else, because a finished stroke leaves its own group
handles lying exactly where the next stroke starts, and stretching the last run of
platforms across the room is not a plausible thing to have meant.

Paintable kinds are the ones a room is built out of -- platforms, textures,
spikes, coins, enemies, bombs, moving platforms. Singletons (spawn, gun pickup,
boss gate, boss arena) are excluded because a stroke of them is one object being
dragged about; lasers because a beam squeezed into one cell is not a laser; camera
areas and doors because they are placed against the shape of a room, one at a
time.

**Textures size themselves to one grid cell**, painted or clicked, letterboxed and
never stretched: scaled by the tighter axis and never scaled *up* past 1:1. The
tiles are cut from the game's own artwork at their own aspect ratios, so a
stretched tile is the difference between a wall that looks like the game and a wall
that looks like the game in a funhouse mirror. Off the grid they land at their
native pixel size, which is what `free` means everywhere else.

Where inside the cell depends on what the tile IS, read off its name, since the
tileset is a recipe rebuilt from the player's own artwork and carries no other
metadata:

- **`*_surface`** -- the skin of a solid, so it goes flush against the face that
  gets walked on rather than floating in the middle of the cell. Which face that
  is turns with the tile: a floor's top edge is the cell's top, and the same tile
  turned 90 degrees is a wall whose "top" is its inner edge, so it hugs the cell's
  right-hand side. Corner pieces are excluded -- they are cut to sit at a join and
  have no single face that is the top.
- **hazard / spike** -- fills the grid square exactly, and is the one tile allowed
  to stretch. A letterboxed spike leaves a gap between one strip and the next that
  reads as a safe step and is not one.
- **everything else** -- centred in the leftover, as before.

`tools/generate-map.js` used to auto-texture every spike rect with a coarse column
tiling of `hazard_surface`. That is gone: the generator's output is textured by
hand, and a coarse pass was art to delete before the real art could go in.
`solver/arena.js` keeps its copy, because an arena is thrown away after one
hand-play and nobody textures one.

## The module library

A **module** is a piece of level with a known difficulty: geometry, an entry
point, an exit point and a rung on `solver/ladder.js`. Assembling a map out of
solved modules is what makes it difficulty-graded *by construction*, instead of
needing an atlas sweep per candidate map -- which is hours times a dozen workers,
and therefore never happens. `modules/README.md` is the format and the solving
side; this is the authoring side.

The left panel lists the library, lowest rung first, and the badge is the point
of the row:

| badge | means |
|---|---|
| `rung 12` green | hand-played in the real game at that rung |
| `rung 12` blue | solved only -- physically possible, never played by a person |
| `unsolved` red | no difficulty is known; the generator cannot use it |
| `rung 12 ?` red | the hand-play verdict is **below** the solved rung, which is a physics bug rather than a difficulty correction |

A module is a **tool**, not a button: clicking a row *arms* it -- the row
highlights, the tool palette clears, and a ghost of what will be placed follows
the cursor -- and the click on the **canvas** is what puts it down. It follows the
editor's own placement rule from there: a click away from the group it just
placed commits and clears, and only the next click stamps another, so a stray
click never drops a module. Escape or any other tool puts it down. Placement goes
through the same `paste()` path the clipboard uses, so ids, patrol ranges, trigger
zones and singletons behave exactly as they do for a copy.

**Save selection as module...** does the reverse:
the selection's bounding box becomes the origin, entry and exit default to the
leftmost and rightmost top surface, and both are draggable on the canvas (green
and red) or typeable in the panel.

Three rules hold this together, all of them the same rule -- **stale difficulty
metadata is the one thing that can silently generate an unbeatable map**:

- A `solve` record or a `handPlay` verdict is **dropped, not carried**, the moment
  the geometry or the entry/exit it describes changes. The panel says so before
  the save, because a hand-play verdict cost somebody a play session. Everything
  a tool cannot regenerate -- `expect` above all, which is a prediction written
  *before* the solver ever ran -- is kept either way.
- Neither record is ever written into a map's objects. Provenance rides in
  `map.meta.modules` as `{ name, x, y, minRung }`, which `mapformat` forwards and
  `iniLevel()` ignores.
- The number anything downstream reads is `max(solve, handPlay)`, because a
  hand-play may only ever **raise** a rung. That mirrors `effectiveMinRung()` in
  `solver/solve-module.js`, which is where a verdict below the solved rung is
  refused loudly. The editor shows the conflict; it is not the gate.

Whether a stored record still describes its module is decided by the *canonical*
form of `{objects, entry, exit}` -- key-sorted, byte-identical to the string
`solve-module.js` hashes -- so the two sides agree without the editor needing
sha1 in a browser. Two consequences worth knowing:

- Default-valued flags (`semi: 0`, `stomper: 0`, an `art` object's `rot`/`flip`/`z`)
  are stripped on the way out, and object keys are written in a fixed order.
  Without that, a module that had merely been opened would serialise differently
  and lose its rung. A prop whose default is a real number -- an enemy's speed, a
  laser's cycle -- is **not** stripped: `toGame` passes those straight through and
  `undefined` would reach the simulator.
- A no-op re-save is byte-identical to the file on disk, matching
  `solve-module.js --write`'s own formatting, so a real diff is always a real
  change.

### The work queue

Three states need a person, and until they were counted in the panel the only way
to find out was to open eight JSON files and read them -- which is how an upper
bound sat unnoticed in the library for a whole phase. The chips above the list
count each one and filter to it on click:

| chip | what it means |
|---|---|
| **unsolved** | no difficulty at all. `generate-map.js` refuses these outright. One click runs the solver. |
| **conflict** | the hand-play verdict is *below* the solved rung: a person cleared what the simulator says is impossible. That is a physics bug, not a difficulty correction, and `solve-module.js` refuses to write it down. One click re-solves, which is usually the right move -- the cause is normally that the simulator has been corrected since. |
| **upper bound** | solved, but the negative that decided the rung came from a beamed search that had thrown states away, so the module may be clearable lower down. Badged `rung ≤N` rather than `rung N`, because it is a ceiling and not an answer. Safe to build with -- a check labelled too hard comes available early, which cannot make a seed unbeatable -- and a hand-play settles it. |
| **unplayed** | solved but never played by a person. |

**play all →** hand-tests everything waiting, easiest rung first, without coming
back to the panel between modules. See below.

### Editing a module on its own

A module used to be authored by dropping it into some map, editing it there,
marqueeing it back up and saving it over itself. Four steps, three of which are
chances to get the bounding box wrong: catch one platform too few and the module
silently loses a wall, one too many and it swallows a piece of whatever map it was
borrowing. Either way the geometry hash moves, the solve record and the hand-play
verdict are dropped, and the only sign is a badge going grey.

**edit** on a module row opens it on its own instead. The canvas holds the module
and nothing else, at the origin, so what is on screen matches the numbers in the
file. The save dialog is already open and already filled in with the module's
name, tags, entry and exit, and saving takes **everything on the canvas** -- there
is no selection to get wrong, because there is nothing else there to select.
Anything drawn afterwards is part of the module.

It is deliberately *not* the solved arena. `solver/arena.js`'s box is what a module
is graded in and `solve-module.js` builds it fresh every time; editing inside a copy
of it would put its walls and ledges on the canvas as objects, and the first save
would swallow them. The arena stays where it belongs, behind the hand-test button.

### Solving on save

A module with no `solve` record is a module the generator cannot use, and the gap
between saving one and remembering to solve it is where an unsolved library comes
from -- so the save dialog runs the solver by default, and the checkbox is how to
say no. It appears only where solving is possible (the dev server: solving is
node, and the userscript has none) and it is disabled where a solve is not
*needed* -- an unchanged module keeps its record, and re-solving would spend tens
of seconds writing down the number already in the file.

The solve runs **after** the save and does not hold the dialog open: it is seconds
to a minute per module, and a modal that sits there for a minute gets cancelled.
The row carries the state instead -- the badge turns amber and reads `solving...`,
and the library refreshes when the answer lands, so a stale rung is never on
screen while the right one is being computed. The endpoint is
`POST /api/solve/<name>`, which is `node solver/solve-module.js <file> --write`
spawned asynchronously; the answer is read back out of the module file rather than
from the exit code, because `solve-module.js` exits non-zero on a *disagreement
with `expect`* as well as on a failure, and a disagreement is the interesting
output rather than an error. A solve that produces nothing is reported as a
failure and the module stays unsolved -- never guessed in either direction.

### Hand-testing: how a module gets marked as played by a person

The solver answers *physically possible*. A person answers *humanly executable*,
and until someone has, a module is solved but not trusted. The **hand-test**
button on a module's row is that loop:

1. It **rebuilds the arena** from the module's current geometry -- `solve-module.js`
   writes one whenever it solves, but an arena left over from before an edit is
   worse than none, since it would hand you the old geometry to play while the
   verdict got recorded against the new one. Rebuilding is geometry, not
   simulation, so it is free.
2. It opens that arena in the quick-run page with the sliders **pinned to the
   rung**: `spd`, `jmp`, `jmp2`, `nrg`, `wpn` and `ammo` straight off
   `solver/ladder.js`, and the three tracks the ladder does not carry pinned to
   what keeps the test honest -- **Time Limit maxed** (the timer is the map-level
   budget Phase 4 spends, not an ability; a test the clock ended would be a test of
   the clock), **Gun Power 0** (it scales the bullet's collision box and the solver
   models the base one, so more would make a must-shoot route easier than the run
   that was solved) and **Coin Multiplier 0**. Moving a slider *voids* the test
   until it is put back -- a verdict is a claim about a rung.
3. You play it, and record the verdict **there**, next to the act: "did I actually
   clear that" is a question with a short memory, and a loop that ends in a
   different tab ends with nobody writing anything down.

**Failing is not the same as impossible**, and the bar is built around that. Three
buttons: *cleared it on attempt N*, *that attempt failed -- try again* (which
counts the attempt and restarts, staying on the rung), and *give up on rung N --
move to rung N+1*. Only the last one moves, and only when you have decided the
rung genuinely is not enough: a rung raised on the first death grades the module
harder than it is, a library of over-graded modules builds a map padded with
upgrades nobody needed, and a verdict can never be lowered afterwards.

The attempt count is **manual**. A restart is not reliably a failure -- you restart
to re-run an approach, or to look at something again -- and a number inferred from
ambiguous events would be worse than your own claim. What gets written is
`handPlay.attempts` and `handPlay.triedBelow`, the rungs tried and given up on
along the way. A module cleared first go and one cleared on the twentieth try are
the same rung and are not the same module.

The **rules are enforced by the server**, not the browser, because the server is
what writes the file: a rung off the ladder is refused, and a verdict *below* the
solved rung is refused loudly -- that would mean a person did what the simulator
proved impossible, which is a physics bug rather than a difficulty correction. The
block is written fresh each time rather than edited, so `playedAt` always names
the day the rung in the file was actually played, and it carries the **geometry**
hash so correcting the simulator cannot wipe it.

None of this exists in the userscript: there is no server to record against, so a
module played on coolmathgames has to be recorded from the dev server.

#### Playing the whole queue in one sitting

Hand-playing is the expensive half of grading a module -- it is a person's time --
and the old loop spent a chunk of it walking back to the panel to find the next
module. **play all →** hands the play page the rest of the queue, and the play page
walks it: record a verdict, press *next*, and the following module's arena is built
and loaded without the editor being visited at all. There is a *skip* alongside it
for a module you cannot make progress on today; skipping records nothing, so it
stays in the queue.

Names travel in the queue, **not rungs**. Each module's rung is read from the
library at the moment it is loaded, because recording a verdict can *raise* a
module's effective rung, and a queue that had pinned the old number would play the
next module at a rung the library no longer agrees with.

Easiest rung first, which is the right way round for a person: the early ones warm
up the hands and the hard ones arrive when the module set is already familiar.

#### Deleting a module

A trash can in the bottom-right corner of each module card, away from the row of
actions because it is the one button on a card that clicking again does not undo.

The confirmation **names what goes with it**, in the order of what is hard to
replace: the module file and its arena, then the solved rung, then the hand-play
verdict. Geometry can be redrawn and a solve is a machine's few minutes; a
hand-play verdict is a person's time and nothing regenerates it, so it is the
sentence someone is still reading when they decide.

The server deletes the module JSON and the arena map built from it -- the arena is
derived and rebuilt on every hand-test, so one left behind would be a playable map
of geometry the library no longer has. The solve and hand-play records live inside
the module file and go with it. In the userscript there is no arena to clean up,
because building one is node.

### The rung reference

The **rung reference** button opens the whole of `solver/ladder.js` as a table: 37
rungs, what each one adds, and the tiers it carries -- speed, jump, double jump,
hearts, gun, ammo and the shots that ammo actually loads. Plus the two quantities
those tiers turn into: terminal run speed in px per frame, and how high one jump
reaches (and that doubled, for a second jump spent at the apex).

It **drags by its header**. It is meant to be read *while* editing -- "does the
ledge I am drawing need jmp5" -- and centred on the stage it covers the exact thing
being measured. It starts centred with a transform; the first drag converts that to
plain pixel coordinates, and the position then lives on the element, so it survives
closing and reopening and resets to centre on a fresh session.

There is deliberately **no "gap this clears" column**. Horizontal reach depends on
the run-up, the headroom and where the double jump is spent, and a plausible
number in a panel would be trusted at a glance -- that is what solving a module
answers, and what Phase 7's two-point probe will answer for two points.

The ladder is the **real solver file**, UMD-wrapped and either served from
`/solver/ladder.js` or bundled into the userscript. A transcription would be a
second answer to "what does rung 12 mean", which is the one thing that file exists
to prevent. The two derived numbers *are* transcribed from `solver/physics.js`
(which is node-only, since it pulls its map in at require time), and
`tools/test-geometry.js` holds them against the real `moveAccel`/`jumpImpulse` on
every run, plus against a solved boundary: `ledge-tall` is a 270px step that
solves at rung 14 and not at rung 13, and the table's jump numbers have to land on
the same side of that.

### Storage

`io.listModules()` / `io.saveModule()` / `io.solveModule()`, alongside the map io.
On the dev server those are the files in `mapeditor/modules/`, served through the
solver's own `readModule()` so a record that has gone stale is already gone before
it reaches a badge. In the userscript the first two are localStorage and the third
is absent, plus an **export** link per module -- nothing in a browser can *solve* a
module, so one saved in the game page stays unsolved until its file reaches
`solver/solve-module.js`.

## Generating a whole map from the library

`tools/generate-map.js` assembles the module library into a complete, playable level whose
difficulty is known **by construction** rather than measured afterwards. Solving a candidate map
is unaffordable -- a full atlas sweep is hours times a dozen workers -- so nothing here is solved:
every obstacle in the output is a module that was already solved against `solver/ladder.js`, and
the layout is arranged so that the rung a check needs is a fact about the geometry.

```
node mapeditor/tools/generate-map.js --list
node mapeditor/tools/generate-map.js --seed 1 --checks 6 --out mapeditor/maps/generated-1.json
```

`--list` is the first thing to run: it prints what the library can gate and, more usefully, what
it cannot. A rung with no module is a rung with no band, which makes the map smaller rather than
wrong, and the list is the authoring queue.

Left to right: a start corridor, then one band per gateable rung in ascending order, then the boss
room. A band is `=gate slot= --corridor-- =interior slot= --corridor--`, where the gate is a module
whose rung IS the band's and interiors are any module at or below it.

Three properties carry the difficulty claim, and each is geometry rather than intent:

1. **A gate is a hole in a wall.** Every module sits in its own sealed box -- the same box
   `solver/arena.js` solved it in, ledge for ledge, with the same lethal pit and the same headroom
   -- and the only openings are two 200px doorways at ledge height. There is no over, no under and
   no around, so being east of a gate means having crossed it. `tools/test-generate.js` asserts the
   box against `buildArena` platform for platform, and asserts that each side wall is exactly two
   pieces with one doorway between them.
2. **Bands ascend.** Band k is east of every lower band, so its checks inherit every gate below.
   The requirement for a check is its own band's rung, not a union to be computed.
3. **Nothing outside a module is dangerous.** Corridors are flat sealed tubes at walkway height.
   A corridor coin is free to whoever got into the corridor, which is the point -- it inherits the
   gate's requirement and adds nothing of its own.

**The clock is the binding constraint, not the geometry.** Johnny replays one map per round against
a countdown that tops out at 147 seconds (`solver/timer.js`), so the layout is *tried* rather than
computed: lay it out, price the walk to the far end, and if a band wants more time than the game
sells, throw it away and lay it out tighter. Compactness is spent where it hurts least -- interior
modules first, since the gate is what grades the band, then corridor length, which is only walking.
The estimate is deliberately pessimistic (module frames come from the solver's run at that module's
*minimum* rung, corridors are walked at terminal speed with no credit for acceleration, and a slack
factor covers the rest): over-estimating buys a bigger timer than needed, under-estimating puts a
check behind a clock that cannot reach it.

**The display case.** The coverage assertion requires the map to contain one of every obstacle the
SDK can make, so that a generated level exercises every path through `iniLevel()` rather than only
the ones the library happens to use. But an obstacle dropped on the spine is an *ungraded* obstacle,
which is the one thing this pipeline exists to prevent -- so the missing kinds go in a sealed box
under the start corridor, created and ticked by the game and reachable by nobody. It holds only what
the map lacks: a conformance crusher beside a band already gated by a crusher module is not free,
because every crusher costs the solver's dedup key a factor of three on a map this wide.

**Output** is the map plus a `.logic.json` sidecar naming each check, its band, its rung and the
time tier it needs. The sidecar is what Phase 6's `verify-map.js` checks and what the apworld
eventually consumes; it stays beside the map rather than inside it, because `iniLevel` reads the map
and has no business carrying requirements around.

**Nothing the generator emits is verified.** It lays out something worth verifying and refuses to
emit one it can already tell is wrong. Whether a check really does first become reachable at the
rung it was laid out for is `solver/verify-map.js`'s question.

## Runtime architecture

Two packages, one-way dependency. `mapkit` must not know Archipelago exists, and
it must not know the editor exists either -- `build-userscript.js` takes extra
modules and one `extend` hook, and the editor's builder is what passes them in.

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
  beam regardless of what the map says, and every other laser gets the stock
  40x180 box. `patcher.js` applies each laser's own `length` and `horizontal`
  instead; a map that says nothing still gets exactly the vanilla shapes.
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
- `tools/build-editor-userscript.js [--out <path>] [--maps <dir>]` -- bundle the
  editor and the runtime into one Tampermonkey script.
- `tools/generate-map.js [--list] [--seed N] [--checks N] [--out <path>]` -- build a
  whole level out of the solved module library. See above.
- `../solver/verify-map.js <map> [--quick]` -- run a generated map through the
  simulator and check that each band gates what its `.logic.json` sidecar says it
  gates. Not in this folder, but it is the thing to run after generating. See
  below.

## Tests

Three, in rising order of how much they prove and how much they cost.

```
node mapeditor/tools/test-geometry.js        # pure geometry, no browser
node mapeditor/tools/test-generate.js        # the generated map's structural claims
msedge --headless=new --dump-dom mapeditor/tools/uicheck.html   # the editor UI
node solver/verify-map.js mapeditor/maps/generated-1.json --quick   # what the map really gates
node mapeditor/tools/e2e/server.js           # the shipped userscript + the game
```

`uicheck.html` needs `--virtual-time-budget=9000` alongside `--dump-dom`: its
assertions run behind timers, and without it the page is dumped before any of them
have fired. That is safe here and *not* safe for `e2e/` -- virtual time freezes
`requestAnimationFrame`, which is Phaser's entire game loop, so the e2e rig has to
drive the devtools protocol instead.

- **test-geometry.js** exercises the parts where a wrong sign is invisible until
  a map is already broken: four quarter turns must be the identity for every
  kind, a resize must carry patrol ranges and camera clamps along, and a laser
  must survive the round trip through the game's format.
  It also round-trips **the real module library**: every module in
  `mapeditor/modules/` is dropped as the palette drops it (ids and default props
  attached), saved back, and checked for identical canonical geometry and
  identical derived entry/exit. A change to the object model that quietly alters
  what a module serialises to fails here, rather than by silently dropping a rung
  that a person spent a play session establishing.
- **test-generate.js** asserts the three properties the generated map's difficulty rests
  on, as facts about the object list: a slot is `buildArena`'s box platform for
  platform with two doorways cut in it, bands ascend in both rung and space, every
  check carries its own band's rung and lies inside it, every band fits the clock,
  the same seed gives the same map byte for byte, and the coverage assertion
  notices a missing obstacle kind. What it deliberately does not check is whether
  the rungs are *right* -- that is `solver/verify-map.js` in Phase 6, and these
  exist so that when it disagrees, the layout is not what is in question.
- **uicheck.html** drives the editor itself with synthetic mouse events -- handle
  hit-testing, beam dragging, clamp switching, group rotate/resize, group
  snapping, the coordinate readout, and the module drop/save round trip with its
  difficulty records. Open it in a browser, or dump the DOM headless and read the
  panel it prints. It needs no server and no tiles.
- **e2e/** runs the built `dist/*.user.js` against the real SDK in a real
  browser, the way Tampermonkey would, and drives the whole loop: level select ->
  editor -> save -> play -> back to the editor. See the comment at the top of
  `e2e/server.js`; headless needs the devtools protocol rather than `--dump-dom`,
  because `--virtual-time-budget` freezes requestAnimationFrame and Phaser's
  entire game loop is requestAnimationFrame.

`tiles/` is gitignored: it is Coolmath/Miniclip's artwork, and it regenerates
from a local SDK copy plus the hand cuts.
