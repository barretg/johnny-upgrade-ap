/*
 * The map editor, as a mountable module.
 *
 * Authoring is in WORLD coordinates, the same space the game's map data uses, so
 * what is saved needs no conversion beyond regrouping into the game's field
 * names. world = muralPixel - (1620, 720), which is also how the tile provenance
 * is expressed, so textures and geometry share one coordinate system.
 *
 * Internally every object is {kind, x, y, w, h, ...props} regardless of how the
 * game stores it -- the game mixes x/y/w/h rects, l/t/r/b rects and bare points
 * across its arrays, and normalising that here keeps selection, dragging and
 * resizing to a single code path. MapFormat.toGame()/fromGame() do the
 * translation, and mapkit owns that file because mapkit ships.
 *
 * WHY THIS IS A MODULE AND NOT A PAGE
 *
 * The editor runs in two places: the local dev server, where maps are files on
 * disk and textures come from tiles/extracted/, and inside the game page on
 * coolmathgames.com as a userscript, where maps live in localStorage and the
 * textures are rebuilt from the player's own copy of the artwork. Those differ
 * only in where the bytes come from, so everything environment-specific sits
 * behind one `io` object and there is exactly one copy of the editor itself.
 *
 *   MapEditor.mount({ root, io })  ->  { open, close, isOpen, destroy }
 *
 * io:
 *   listMaps()                 -> [{ id, name, modified }]
 *   loadMap(id)                -> a map file, in the game's format
 *   saveMap(id, { map, thumb })-> { ok, id }
 *   vanillaMap()               -> the stock level, as a starting point (optional)
 *   tiles()                    -> [{ name, w, h }]
 *   tileImage(name)            -> Image or Canvas, drawable once ready
 *   listModules()              -> the module library, whole records (optional)
 *   saveModule(name, mod)      -> { ok } (optional; the panel needs both)
 *   exportModule(name, mod)    -> hand a module out as a file (optional)
 *   deleteModule(name)         -> remove it, and anything derived from it
 *                                 (optional; the trash can hides without it)
 *   solveModule(name)          -> run the solver over a saved module and write the
 *                                 answer into it (optional; node only)
 *   moduleArena(name)          -> build that module's playable arena, -> { ok, id }
 *                                 (optional; node only)
 *   play(id, opts)             -> run a map; opts.module/opts.rung turn it into a
 *                                 hand-test at that rung
 *   play(id)                   -> run the map (optional; Play hides without it)
 *   exit()                     -> leave the editor (optional; Close hides)
 *   storageKey                 -> localStorage namespace for session state
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MapEditor = factory();
}(typeof self !== 'undefined' ? self : this, function () {
'use strict';

// ---------------------------------------------------------------- object kinds
/*
 * One definition per kind drives the tool palette, drawing, the properties panel
 * and serialisation. Adding an entity type should mean adding an entry here, not
 * touching the interaction code.
 *
 *   shape 'rect'  drag to create, resizable
 *   shape 'point' click to create, fixed icon size
 *   shape 'beam'  a laser: a centred bar with a length and an orientation
 *   single: true  only one may exist (spawn, door, boss zones)
 *   path:         has a patrol range, drawn as a track with two handles
 */
const KINDS = {
  plat: { label:'Platform', shape:'rect', color:'#8ea3c0', fill:'#2a3040', order:1,
    props:{ semi:0, stomper:0 },
    fields:{
      semi:{ type:'bool', label:'One-way',
        help:'Only the top surface collides. Johnny jumps up through it and lands on top. Drawn with a cyan dashed line along the top edge.' },
      fallTo:{ type:'number', label:'Falls to', crusher:true,
        help:'World Y where it comes to rest. Fall distance is this minus the platform y. Blank uses the vanilla -60.' },
      trigX:{ type:'number', label:'Trigger x', crusher:true,
        help:'Left edge of the band that sets it off. Blank uses x+200, which is why a narrow crusher never fires in the stock game.' },
      trigW:{ type:'number', label:'Trigger width', crusher:true,
        help:'Width of that band. Blank uses 80.' },
      trigY:{ type:'number', label:'Trigger above Y', crusher:true,
        help:'Johnny must be above this Y as well. Blank uses 360.' },
      accel:{ type:'number', label:'Acceleration', crusher:true,
        help:'Downward acceleration per frame. Blank uses 0.25.' },
      damage:{ type:'number', label:'Damage', crusher:true,
        help:'Contact damage. Blank uses 10.' },
      repeat:{ type:'bool', label:'Resets', crusher:true,
        help:'Return to the start and arm again after landing. Off matches the stock game, which fires once.' },
      resetIn:{ type:'number', label:'Reset delay', crusher:true,
        help:'Frames to wait before returning, when Resets is on. Blank uses 90.' },
      stomper:{ type:'bool', label:'Crusher',
        help:'Falls when Johnny walks under it. The stock game hardcodes all of this - one crusher per map, firing once, dropping to world y = -60, triggered by an 80px band at x+200 that a crusher narrower than 200px can never reach. The runtime replaces that routine, so use as many as you like and set Falls to / Trigger / Resets below; leave a field blank to get the stock value.' },
    } },
  art: { label:'Texture', shape:'rect', color:'#c9a6ff', order:2,
    props:{ tile:'', rot:0, flipX:0, flipY:0, z:0 },
    fields:{
      tile:{ type:'text', label:'Tile', help:'Which extracted texture to draw.' },
      rot:{ type:'number', label:'Rotation', help:'Degrees, clockwise. r rotates 90 at a time.' },
      flipX:{ type:'bool', label:'Mirror X', help:'Flip horizontally (key x).' },
      flipY:{ type:'bool', label:'Mirror Y', help:'Flip vertically (key y).' },
      z:{ type:'number', label:'Z order', help:'Higher draws in front. Keys [ and ].' },
    } },
  spike: { label:'Spike', shape:'rect', color:'#e07a7a', fill:'#3a2027', order:3 },
  coin: { label:'Coin', shape:'point', color:'#e8c46a', order:4, size:24 },
  ene: { label:'Enemy', shape:'point', color:'#ff9d5c', order:5, size:40,
    props:{ typ:'robot', xx:4.8, yy:0 }, path:true,
    fields:{
      typ:{ type:'select', options:['robot','saw'], label:'Type',
        help:'robot: killable, and an Archipelago check. saw: hazard only, cannot be killed.' },
      xx:{ type:'number', label:'Speed X', help:'Horizontal patrol speed in px per frame. 0 to stay put.' },
      yy:{ type:'number', label:'Speed Y', help:'Vertical patrol speed. Vanilla enemies use 0.' },
    } },
  bomb: { label:'Bomb', shape:'point', color:'#ff7ad9', order:6, size:36,
    props:{ xxsi:-0.02, yysi:0.04, xmax:100, ymax:120 },
    fields:{
      xxsi:{ type:'number', label:'Drift rate X', help:'How fast it sweeps horizontally. It drifts on a sine wave rather than patrolling.' },
      yysi:{ type:'number', label:'Drift rate Y', help:'How fast it sweeps vertically.' },
      xmax:{ type:'number', label:'Drift width', help:'How far either side of its position it travels.' },
      ymax:{ type:'number', label:'Drift height', help:'How far above and below it travels.' },
    } },
  /*
   * A laser is a beam, not a point.
   *
   * The game creates one as a sprite anchored at its centre with a 40x180
   * collision box, then force-rotates the FIRST laser to a horizontal 590px beam
   * whatever the map says. mapkit unpins that per laser, so length and
   * orientation are genuine map data -- and since they are, they belong on the
   * canvas as a draggable beam rather than as two numbers in a panel.
   */
  laser: { label:'Laser', shape:'beam', color:'#7ae0ff', order:7, size:28,
    props:{ ctMax:100, ctSwitch:60, ctCurr:0, length:180, horizontal:0 },
    fields:{
      ctMax:{ type:'number', label:'Cycle length', help:'Frames in one on/off cycle.' },
      ctSwitch:{ type:'number', label:'Fires at', help:'Point in the cycle the beam turns on.' },
      ctCurr:{ type:'number', label:'Start phase', help:'Where in the cycle it begins. Stagger this across lasers so they do not all fire together.' },
      length:{ type:'number', label:'Beam length',
        help:'How long the beam is, centred on the emitter. Drag either end on the canvas. The stock game used 180 upright and 590 laid flat.' },
      horizontal:{ type:'bool', label:'Horizontal',
        help:'Lay the beam across instead of upright. Dragging an end past the diagonal flips this for you.' },
    } },
  platMove: { label:'Moving plat', shape:'point', color:'#64d19a', order:8, size:40,
    props:{ xx:3, yy:0 }, path:true,
    fields:{
      xx:{ type:'number', label:'Speed X', help:'Horizontal speed in px per frame. 0 for a vertical-only lift.' },
      yy:{ type:'number', label:'Speed Y', help:'Vertical speed. 0 for a horizontal-only tram.' },
    } },
  area: { label:'Camera area', shape:'rect', color:'#5c7fff', order:9,
    props:{ xx:320, yy:300, xmin:0, xmax:0, ymin:0, ymax:0 },
    note:'Entering this region changes how the camera follows Johnny, and the setting STICKS until he enters another area. Cover the map fairly continuously or the camera keeps an old offset. The violet box is the clamp: drag its handles, and drag a side onto the area edge to switch that clamp off.',
    fields:{
      xx:{ type:'number', label:'Offset X', help:'How far left of Johnny the camera sits (multiplied by 1.25). Bigger shows more of what is ahead.' },
      yy:{ type:'number', label:'Offset Y', help:'Vertical framing offset, same scaling.' },
      xmin:{ type:'number', label:'Clamp left', help:'Camera cannot scroll left of this. 0 means no clamp, not a clamp at zero.' },
      xmax:{ type:'number', label:'Clamp right', help:'Camera cannot scroll right of this. 0 means no clamp.' },
      ymin:{ type:'number', label:'Clamp top', help:'Camera cannot scroll above this. 0 means no clamp.' },
      ymax:{ type:'number', label:'Clamp bottom', help:'Camera cannot scroll below this. 0 means no clamp.' },
    } },
  door: { label:'Door', shape:'rect', color:'#b6ff5c', order:10,
    props:{ trigger:'start' },
    note:'Slides shut to block a route. Place as many as you like. The stock game only had one, always closing at level start and always stopping at y=1810.',
    fields:{
      trigger:{ type:'select', options:['start','zone','boss','never'], label:'Closes on',
        help:'start: immediately, as in the stock game. zone: when Johnny enters the trigger box. boss: when the boss fight begins. never: stays put.' },
      closeTo:{ type:'number', label:'Slides to', door:true,
        help:'World Y it stops at. Blank slides down by its own height.' },
      speed:{ type:'number', label:'Speed', door:true,
        help:'Pixels per frame. Blank uses 1, which is the stock crawl.' },
      open:{ type:'bool', label:'Opens instead', door:true,
        help:'Start shut and slide the other way when triggered.' },
      zx:{ type:'number', label:'Zone x', zone:true, help:'Trigger box, used when Closes on is zone.' },
      zy:{ type:'number', label:'Zone y', zone:true, help:' ' },
      zw:{ type:'number', label:'Zone w', zone:true, help:' ' },
      zh:{ type:'number', label:'Zone h', zone:true, help:' ' },
    } },
  bossGate: { label:'Boss gate', shape:'rect', color:'#ffd25c', order:11, single:true,
    note:'The trigger that starts the boss fight.' },
  bossRange: { label:'Boss arena', shape:'rect', color:'#ff5c5c', order:12, single:true,
    note:'Where the boss moves. Vanilla pins the boss rise to absolute Y (1810/2040/2400), so moving this needs those constants patched.' },
  sprt: { label:'Spawn', shape:'point', color:'#ffffff', order:13, size:48,
    single:true, props:{ xx:1 },
    fields:{ xx:{ type:'select', options:[1,-1], label:'Facing', help:'1 faces right, -1 faces left.' } } },
  colGun: { label:'Gun pickup', shape:'point', color:'#5cffd2', order:14, size:36, single:true,
    note:'Walking into this sends the Find the Gun check. Being armed comes from the Laser Gun item, not from this pickup.' },
};

/*
 * Patrol ranges.
 *
 * The game stores a mover as a position plus xmin/xmax and ymin/ymax bounds, and
 * oscillates each axis between them independently. Two draggable handles at the
 * opposite corners of that box express both axes at once, which is easier to
 * reason about than four numbers -- and a wrong patrol range is the classic way
 * to make a map that looks right and plays wrong.
 */
const PATH_FIELDS = ['xmin', 'ymin', 'xmax', 'ymax'];

// the game's own laser geometry: 40 across, 180 upright, 590 laid flat
const LASER_THICK = 40;
const LASER_LEN_V = 180;
const LASER_LEN_H = 590;

// ---------------------------------------------------------------- markup
const CSS = `
#mde-root { --bg:#14161c; --panel:#1c1f28; --line:#2c3040; --text:#dde1ea; --dim:#8b93a7;
  --accent:#6ea8fe; --good:#64d19a; --warn:#e8c46a; --bad:#e07a7a;
  background:var(--bg); color:var(--text); overflow:hidden;
  font:13px/1.45 ui-sans-serif,system-ui,sans-serif;
  display:grid; grid-template-columns:200px 1fr 250px; grid-template-rows:42px 1fr;
  width:100%; height:100%; }
#mde-root * { box-sizing:border-box; }
#mde-top { grid-column:1/4; background:var(--panel); border-bottom:1px solid var(--line);
  display:flex; align-items:center; gap:10px; padding:0 12px; min-width:0; }
#mde-top .mde-sp { flex:1; }
#mde-root input[type=text], #mde-root select { background:#12141a; border:1px solid var(--line);
  color:var(--text); border-radius:5px; padding:4px 7px; font:inherit; font-size:12px; }
#mde-root button { background:#262b38; border:1px solid var(--line); color:var(--text);
  border-radius:6px; padding:5px 10px; font:inherit; font-size:11px; cursor:pointer; }
#mde-root button:hover { background:#303748; }
#mde-root button.on { background:var(--accent); border-color:var(--accent); color:#0d1017; font-weight:600; }
#mde-root button.primary { background:var(--accent); border-color:var(--accent); color:#0d1017; font-weight:600; }
#mde-root aside { background:var(--panel); overflow-y:auto; min-height:0; }
#mde-left { border-right:1px solid var(--line); }
#mde-right { border-left:1px solid var(--line); }
#mde-root .sec { padding:9px 11px; border-bottom:1px solid var(--line); }
#mde-root .sec h2 { font-size:10px; text-transform:uppercase; letter-spacing:.07em; color:var(--dim);
  margin:0 0 7px; font-weight:600; }
#mde-root .tools { display:grid; grid-template-columns:1fr 1fr; gap:5px; }
#mde-root .drawopt { display:flex; align-items:center; gap:6px; }
#mde-root .drawopt select { flex:1; }
#mde-root .tools button { text-align:left; padding:5px 7px; }
#mde-palette { display:grid; grid-template-columns:1fr 1fr; gap:5px; }
#mde-root .tile { background:#12141a; border:1px solid var(--line); border-radius:5px; cursor:pointer;
  padding:3px; display:grid; gap:3px; justify-items:center; }
#mde-root .tile:hover { border-color:var(--accent); }
#mde-root .tile.sel { border-color:var(--accent); background:#2b3346; }
#mde-root .tile canvas { display:block; image-rendering:pixelated; }
#mde-root .tile span { font-size:9px; color:var(--dim); max-width:78px; overflow:hidden;
  text-overflow:ellipsis; white-space:nowrap; }
#mde-stage { position:relative; overflow:hidden; background:#0d0f14; min-width:0; }
#mde-cv { position:absolute; top:0; left:0; }
/*
 * The coordinate readout. Bottom left, always on, and deliberately larger and
 * monospaced than the rest of the chrome: it is read while the mouse is moving,
 * which is exactly when small proportional digits are hardest to catch.
 */
#mde-hud { position:absolute; left:10px; bottom:10px; background:#12141aeb; border:1px solid var(--line);
  border-radius:6px; padding:6px 10px; font-size:11px; color:var(--dim); pointer-events:none;
  display:flex; gap:12px; align-items:baseline; }
#mde-hud .co { font:600 15px/1.1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  color:var(--text); font-variant-numeric:tabular-nums; }
#mde-hud .co .ax { color:var(--dim); font-weight:400; font-size:11px; }
#mde-hud .sn { font:11px/1.1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; color:var(--accent); }
#mde-hint { position:absolute; right:10px; bottom:10px; background:#12141ad9; border:1px solid var(--line);
  border-radius:6px; padding:6px 9px; font-size:11px; color:var(--dim); max-width:290px; }
#mde-root kbd { background:#262b38; border:1px solid var(--line); border-bottom-width:2px; border-radius:3px;
  padding:0 3px; font-size:10px; }
#mde-root .row2 { display:grid; grid-template-columns:70px 1fr; gap:6px; align-items:center;
  color:var(--dim); font-size:11px; margin-bottom:5px; }
#mde-root .row2 input { width:100%; background:#12141a; border:1px solid var(--line); color:var(--text);
  border-radius:4px; padding:3px 5px; font:inherit; font-size:11px; }
#mde-objs { max-height:230px; overflow-y:auto; }
#mde-root .obj { padding:4px 8px; font-size:11px; cursor:pointer; display:flex; gap:6px; align-items:center;
  border-radius:4px; }
#mde-root .obj:hover { background:#232733; }
#mde-root .obj.sel { background:#2b3346; }
#mde-root .swatch { width:8px; height:8px; border-radius:2px; flex:none; }
#mde-root .muted { color:var(--dim); font-size:10px; }
#mde-root .field { margin-bottom:8px; }
#mde-root .help { color:#6f7688; font-size:10px; line-height:1.35; margin:1px 0 0 76px; }
#mde-root .note { color:var(--warn); font-size:10px; line-height:1.4; background:#2a2519;
  border:1px solid #3d3520; border-radius:5px; padding:6px 7px; margin:0 0 9px; }
/*
 * The module library. A row is a drop target for a piece of level with a KNOWN
 * difficulty, so the rung badge is the point of the row rather than decoration --
 * it is coloured by where the number came from, because a solved-but-never-played
 * module and a hand-played one are not the same claim.
 */
#mde-modlist { display:grid; gap:4px; }
#mde-root .mod { background:#12141a; border:1px solid var(--line); border-radius:5px;
  padding:5px 7px; cursor:pointer; display:grid; gap:2px; position:relative; }
/* the one action on a card that cannot be undone, so it sits away from the rest */
#mde-root .mod .trash { position:absolute; right:4px; bottom:3px; background:none; border:0;
  color:var(--dim); font-size:11px; line-height:1; padding:1px 3px; cursor:pointer; opacity:.5; }
#mde-root .mod .trash:hover { opacity:1; color:var(--bad, #e07a7a); }
#mde-root .mod:hover { border-color:var(--accent); }
#mde-root .mod.sel { border-color:var(--accent); background:#2b3346; }
#mde-root .mod .top { display:flex; gap:6px; align-items:baseline; justify-content:space-between; }
#mde-root .mod .nm { font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
#mde-root .mod .rung { font:600 10px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  border-radius:3px; padding:0 4px; flex:none; }
#mde-root .mod .rung.played { background:#1e3a2c; color:var(--good); }
#mde-root .mod .rung.solved { background:#2b3346; color:var(--accent); }
#mde-root .mod .rung.none { background:#3a2027; color:var(--bad); }
#mde-root .mod .rung.bad { background:#3a2027; color:var(--bad); }
/*
 * An UPPER BOUND is not a fourth shade of "solved", so it does not get one.
 *
 * The solver reports exact:false when the negative that decided a rung came
 * from a beamed search that had thrown states away -- the module may well be
 * clearable lower down. That is the safe direction (a check labelled harder than
 * it is comes available early, which cannot make a seed unbeatable) but it is
 * not an answer, and a badge that reads the same as a proved rung would let it
 * pass for one. The bound is drawn with a leading tilde and a dotted underline
 * to say the number is approximate without inventing a fifth colour.
 */
#mde-root .mod .rung.bound { border-bottom:1px dotted currentColor; }

/*
 * The work queue.
 *
 * The three states that need a person -- unsolved, solved-but-never-played, and
 * a rung that is only an upper bound -- were previously visible only by opening
 * eight JSON files and reading them, which is why they went unnoticed for a
 * whole phase. Counts here, filters on click, and the action on each row.
 */
#mde-modqueue { display:flex; flex-wrap:wrap; gap:4px; margin-bottom:5px; }
#mde-modqueue button { font-size:9px; padding:2px 5px; border-radius:3px; flex:none;
  background:#12141a; border:1px solid var(--line); color:var(--dim); cursor:pointer; }
#mde-modqueue button.on { border-color:var(--accent); color:var(--fg); background:#2b3346; }
#mde-modqueue button.empty { opacity:.4; }
#mde-root .mod .act { background:#2b3346; border:1px solid var(--line); border-radius:3px;
  color:var(--fg); font-size:9px; padding:1px 5px; cursor:pointer; }
#mde-root .mod .tags { color:var(--dim); font-size:9px; overflow:hidden;
  text-overflow:ellipsis; white-space:nowrap; }
#mde-root .mod .ex { background:none; border:0; color:var(--dim); font-size:9px; padding:0;
  text-decoration:underline; cursor:pointer; }
#mde-modpanel { position:absolute; right:10px; top:10px; width:252px; z-index:5;
  background:#1c1f28f2; border:1px solid var(--line); border-radius:8px; padding:10px 11px;
  display:none; }
/*
 * The rung reference. A wide scrolling table rather than a squeezed sidebar list:
 * it is read by scanning a column -- "which rung first has jmp5" -- and a column
 * you cannot see the whole of answers nothing.
 */
#mde-rungs { position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); z-index:6;
  width:min(720px, 92%); max-height:82%; overflow:auto; display:none;
  background:#161922f5; border:1px solid var(--line); border-radius:9px; padding:0; }
#mde-rungs .hd { position:sticky; top:0; background:#1c1f28; border-bottom:1px solid var(--line);
  padding:9px 12px; display:flex; align-items:baseline; gap:10px;
  cursor:move; user-select:none; }
#mde-rungs .hd button { cursor:pointer; }
#mde-rungs .hd h3 { margin:0; font-size:12px; }
#mde-rungs .hd .mde-sp { flex:1; }
#mde-rungs table { border-collapse:collapse; width:100%;
  font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
#mde-rungs th { position:sticky; top:37px; background:#1c1f28; color:var(--dim); font-weight:600;
  text-align:right; padding:4px 8px; font-size:10px; border-bottom:1px solid var(--line); }
#mde-rungs th:first-child, #mde-rungs td:first-child { text-align:left; }
#mde-rungs td { padding:2px 8px; text-align:right; border-bottom:1px solid #21252f; }
#mde-rungs tr.got td { color:var(--text); }
#mde-rungs tr.here td { background:#2b3346; }
#mde-rungs td.gain { color:var(--good); text-align:left; }
#mde-rungs .foot { padding:9px 12px; color:var(--dim); font-size:10px; line-height:1.5;
  border-top:1px solid var(--line); }
#mde-modpanel h3 { margin:0 0 8px; font-size:11px; text-transform:uppercase;
  letter-spacing:.07em; color:var(--dim); }
#mde-modpanel .pair { display:grid; grid-template-columns:40px 1fr 12px 1fr; gap:5px;
  align-items:center; margin-bottom:5px; color:var(--dim); font-size:11px; }
#mde-modpanel .btns { display:flex; gap:6px; margin-top:9px; }
#mde-modpanel .chk { display:flex; gap:6px; align-items:flex-start; margin:8px 0 0;
  color:var(--dim); font-size:11px; line-height:1.4; }
#mde-modpanel .chk input { margin:2px 0 0; }
#mde-root .mod .rung.busy { background:#2a2519; color:var(--warn); }
`;

const HTML = `
<div id="mde-top">
  <strong style="font-size:13px">Map Editor</strong>
  <input type="text" id="mde-mapName" placeholder="map name" style="width:170px">
  <select id="mde-mapList"><option value="">&mdash; open map &mdash;</option></select>
  <button id="mde-newMap">new</button>
  <button id="mde-fromVanilla">start from vanilla</button>
  <span class="mde-sp"></span>
  <button id="mde-save">save</button>
  <button id="mde-export">export</button>
  <button id="mde-play" class="primary">play</button>
  <button id="mde-exit">close</button>
</div>

<aside id="mde-left">
  <div class="sec">
    <h2>Tools</h2>
    <div class="tools" id="mde-tools"></div>
  </div>
  <!--
    Grid, paint, fit and the texture layer are TOOL STATE, not view chrome, and
    they used to sit in the top bar at the far end of the window from the tool
    buttons they modify. The paint toggle in particular is read constantly while
    drawing, so it belongs where the eye already is.
  -->
  <div class="sec">
    <h2>Drawing</h2>
    <div class="drawopt">
      <span class="muted">grid</span>
      <select id="mde-grid">
        <option value="0" selected>free</option>
        <option value="10">10</option>
        <option value="25">25</option>
        <option value="50">50</option>
        <option value="100">100</option>
      </select>
    </div>
    <button id="mde-paint" style="width:100%;margin-top:5px" title="Paint mode. Drag across the canvas and every grid cell the cursor enters gets one stamp, snapped to the cell and never doubled up. Hold shift to lock the stroke to one axis. The whole stroke is one undo. Needs a grid; key p.">paint</button>
    <!--
      What a stroke will stamp. Reading it off the toolbar is not possible once
      the clipboard can be the brush, and a paint mode that silently stamps
      something other than the armed tool is worse than no brush at all.
    -->
    <button id="mde-brush" style="width:100%;margin-top:5px">brush: tool</button>
    <div class="tools" style="margin-top:5px">
      <button id="mde-artTop" class="on">textures on top</button>
      <button id="mde-fit">fit</button>
    </div>
    <!--
      Spikes are the only lethal thing the runtime does not draw, so an untextured
      spike rect is an invisible instant death and a map is not finished while one
      exists. A hundred clicks nobody makes, on a button.
    -->
    <button id="mde-fillspikes" style="width:100%;margin-top:5px"
      title="Cover every untextured spike rect with the hazard tile, dividing each rect evenly so no tile is visibly squashed. Spikes that already have art over them are left alone, so this is safe to press twice and safe over hand-textured work. One undo.">fill spikes</button>
  </div>
  <div class="sec">
    <h2>Textures</h2>
    <div id="mde-palette"></div>
  </div>
  <div class="sec" id="mde-modsec">
    <h2>Modules</h2>
    <div id="mde-modqueue"></div>
    <div id="mde-modlist"></div>
    <button id="mde-modsave" style="width:100%;margin-top:6px">save selection as module…</button>
    <button id="mde-rungref" style="width:100%;margin-top:5px">rung reference</button>
    <div class="muted" style="margin-top:5px" id="mde-modhint">Pick a module, then click the canvas to place it.</div>
  </div>
</aside>

<div id="mde-stage">
  <canvas id="mde-cv"></canvas>
  <div id="mde-modpanel"></div>
  <div id="mde-rungs"></div>
  <div id="mde-hud"></div>
  <div id="mde-hint">
    <div><kbd>ctrl+click</kbd> add / remove + adopt settings</div>
    <div><kbd>ctrl+drag</kbd> marquee, adds to the selection</div>
    <div><kbd>ctrl+click</kbd> blank = back to select tool</div>
    <div><kbd>drag</kbd> marquee select</div>
    <div>paint: <kbd>shift</kbd> locks the stroke to one axis</div>
    <div>paint: a copied selection is the brush</div>
    <div><kbd>alt+click</kbd> just this one, whatever else is picked</div>
    <div><kbd>ctrl+g</kbd> group &middot; <kbd>ctrl+shift+g</kbd> ungroup</div>
    <div><kbd>=</kbd>/<kbd>-</kbd> grid size up / down</div>
    <div><kbd>r</kbd> turns the shape &middot; <kbd>alt+r</kbd> turns each texture</div>
    <div><kbd>corner</kbd> resize &middot; <kbd>space+drag</kbd> pan</div>
    <div>many selected: box resizes &amp; rotates as one</div>
    <div>green handles = door trigger zone</div>
    <div><kbd>ctrl+z</kbd> undo &middot; <kbd>ctrl+shift+z</kbd> redo</div>
    <div><kbd>ctrl+c</kbd>/<kbd>ctrl+v</kbd> copy &middot; paste lands at cursor</div>
    <div><kbd>del</kbd> delete &middot; <kbd>ctrl+d</kbd> duplicate &middot; <kbd>esc</kbd> select tool</div>
    <div><kbd>[</kbd> <kbd>]</kbd> send back / bring forward (any object)</div>
    <div><kbd>x</kbd>/<kbd>y</kbd> mirror &middot; <kbd>r</kbd> rotate 90&deg;</div>
  </div>
</div>

<aside id="mde-right">
  <div class="sec">
    <h2>Properties</h2>
    <div id="mde-props"><span class="muted">nothing selected</span></div>
  </div>
  <div class="sec">
    <h2>Objects</h2>
    <div id="mde-objs"></div>
  </div>
</aside>
`;

// ---------------------------------------------------------------- state
let root = null, io = null, active = false, booted = false;
let map = blankMap();
let sel = [];                 // selected object ids
let tool = 'select';
let selTile = null;
let view = { x: 0, y: 0, z: 0.35 };
let grid = 0;   // free by default; per-map preference is restored on open
let paint = false;  // grid paint: a drag stamps one object per cell entered
let nextId = 1;
let tileImgs = new Map();
let tileList = [], tileNodes = new Map();
let artStyle = { rot:0, flipX:0, flipY:0 };
let undoStack = [], redoStack = [], clipboard = [];  // reassigned when a session is restored
let lastWorld = { x:0, y:0 };
let dragging = null, spaceDown = false;
let artOnTop = true;
let moduleLib = [];   // the library as io handed it over: whole records, stale parts already gone
let pendingModule = null; // a module armed for placement, waiting for a click on the canvas
let solving = new Set();  // module names the solver is currently running on
let modDialog = null; // an open "save as module" dialog, with its entry/exit markers on the canvas
let rafId = null;
const listeners = [];   // [target, type, fn, opts], for destroy()

const $ = (id) => root.querySelector('#mde-' + id);
const stageEl = () => $('stage');

function blankMap() {
  return { meta:{ id:'', name:'Untitled' }, objects:[], yEnd:3000 };
}

/*
 * Undo by snapshot.
 *
 * The object model is a flat array of plain objects, so a JSON snapshot is both
 * cheap and exactly right -- no need to model each action as a reversible edit,
 * which is where hand-rolled undo usually goes wrong. The vanilla map is ~300
 * objects, so a snapshot is tens of kilobytes and the stack is capped anyway.
 *
 * pushHistory() is called BEFORE a change, so the stack holds the state to go
 * back to. Any new edit clears the redo stack, as it should.
 */
const HISTORY_MAX = 120;
// writing to storage on every keystroke of a drag would be wasteful, so coalesce
let persistTimer = null;
const schedulePersist = () => {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persistState, 400);
};
const snapshot = () => JSON.stringify({ objects: map.objects, nextId });
function pushHistory() {
  undoStack.push(snapshot());
  schedulePersist();
  if (undoStack.length > HISTORY_MAX) undoStack.shift();
  redoStack.length = 0;
}

/*
 * Lazy history, for drags.
 *
 * A mousedown that selects something also arms a move, but most of those are
 * just clicks -- committing history there would fill the stack with entries that
 * undo to an identical map, so ctrl+Z would appear to do nothing several times
 * before it did anything. Arm on mousedown, commit only once the drag actually
 * moves something.
 */
let pendingHistory = null;
const armHistory = () => { pendingHistory = snapshot(); };
function commitHistory() {
  if (pendingHistory === null) return;
  undoStack.push(pendingHistory);
  schedulePersist();
  if (undoStack.length > HISTORY_MAX) undoStack.shift();
  redoStack.length = 0;
  pendingHistory = null;
}
function restore(str) {
  const d = JSON.parse(str);
  map.objects = d.objects; nextId = d.nextId;
  sel = sel.filter((id) => map.objects.some((o) => o.id === id));
  refresh();
}
function undo() {
  if (!undoStack.length) return;
  redoStack.push(snapshot());
  restore(undoStack.pop());
}
function redo() {
  if (!redoStack.length) return;
  undoStack.push(snapshot());
  restore(redoStack.pop());
}

function copySel() {
  clipboard = selected().map((o) => JSON.parse(JSON.stringify(o)));
  // copying is what arms the clipboard as the paint brush; picking a tool is what
  // puts it down again
  clipBrush = clipboard.length > 0;
  renderBrush();
}
/*
 * Paste lands the copied group under the cursor rather than on top of the
 * original, which is almost always what you want when duplicating a run of
 * platforms or a cluster of coins.
 */
function paste() {
  if (!clipboard.length) return;
  pushHistory();
  pasteObjects(clipboard);
}
/*
 * Drop a group of loose objects into the map at the cursor.
 *
 * The clipboard is one caller and the module library is the other, deliberately:
 * a module has to land with its ids allocated, its patrol ranges and trigger
 * zones carried along and its singletons collapsed exactly as a paste does, and
 * two code paths that did that differently would be two sets of bugs. History is
 * the caller's job, since a module drop wants one entry covering the provenance
 * record as well.
 */
function pasteObjects(clipboard, at, quiet) {
  const w = at || lastWorld;
  let x0 = Infinity, y0 = Infinity;
  for (const c of clipboard) { x0 = Math.min(x0, c.x); y0 = Math.min(y0, c.y); }
  const dx = snap(w.x) - x0, dy = snap(w.y) - y0;
  /*
   * Group ids are REMAPPED, not copied. A pasted platform carrying the original's
   * group id would mean clicking the copy also selected the original -- two
   * clusters on opposite sides of the map moving as one, which is the opposite of
   * what a group is for. Remapped as a batch, so a paste of two groups stays two.
   */
  const regroup = new Map();
  let nextG = newGroupId();
  const made = clipboard.map((c) => {
    const o = JSON.parse(JSON.stringify(c));
    o.id = nextId++;
    if (o.group) {
      if (!regroup.has(o.group)) regroup.set(o.group, nextG++);
      o.group = regroup.get(o.group);
    }
    o.x += dx; o.y += dy;
    // a patrol range travels with the thing that patrols it
    if (o.xmin !== undefined && K(o) && K(o).path) { o.xmin += dx; o.xmax += dx; o.ymin += dy; o.ymax += dy; }
    // so does a door's trigger zone and an area's camera clamp
    if (o.kind === 'door') { o.zx = (o.zx || 0) + dx; o.zy = (o.zy || 0) + dy; }
    if (o.kind === 'area') shiftClamp(o, dx, dy);
    // singletons cannot be duplicated; paste moves the existing one instead
    if (KINDS[o.kind] && KINDS[o.kind].single) {
      const ex = map.objects.find((e) => e.kind === o.kind);
      if (ex) { ex.x = o.x; ex.y = o.y; return ex; }
    }
    map.objects.push(o);
    return o;
  });
  // a paint stroke pastes once per cell and selects the whole run at mouseup,
  // so it asks for neither of these -- a refresh per stamp is a redraw of the
  // entire map for every cell of the stroke
  if (!quiet) { sel = made.map((o) => o.id); refresh(); }
  return made;
}

// ---------------------------------------------------------------- modules
/*
 * A module is a piece of level with a KNOWN difficulty: geometry, an entry point,
 * an exit point, and a rung on solver/ladder.js that a solver run and a hand-play
 * pass agreed on. Assembling a map out of solved modules is what makes it
 * difficulty-graded by construction, instead of needing an atlas sweep per
 * candidate map -- which is hours times a dozen workers and therefore never
 * happens.
 *
 * Three rules this end of it has to keep, all for the same reason -- stale
 * difficulty metadata is the one thing that can silently generate an unbeatable
 * map:
 *
 *   * a `solve` or `handPlay` record is DROPPED, not carried, the moment the
 *     geometry or the entry/exit it describes changes;
 *   * neither record is ever written into a map's objects. Provenance rides in
 *     map.meta.modules, which mapformat forwards and iniLevel ignores;
 *   * the number anything downstream reads is max(solve, handPlay), because a
 *     hand-play may only ever RAISE a rung. That mirrors effectiveMinRung() in
 *     solver/solve-module.js, which is where it is enforced loudly.
 *
 * Storage is io.listModules()/io.saveModule(), the same shape as the map io: on
 * the dev server those are files in mapeditor/modules/, and in the userscript they
 * are localStorage. Absent either one the whole panel hides -- the editor is
 * useful without a library.
 */

/*
 * Key-sorted stringification, byte-identical to solver/solve-module.js's
 * `canonical`. This is how the editor decides whether a re-save still describes
 * the same module, and the solver decides the same thing by hashing the same
 * string -- so the two agree without the editor needing sha1 in a browser.
 */
function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  }
  return JSON.stringify(v === undefined ? null : v);
}
const geomKey = (m) => canonical({ objects: m.objects, entry: m.entry, exit: m.exit });

/*
 * The rung a module is actually worth. Mirrors effectiveMinRung() in
 * solve-module.js: the solved rung, raised by a hand-play verdict and never
 * lowered by one. A verdict BELOW the solved rung means a person did something
 * the simulator proved impossible, i.e. a physics bug -- shown here as a conflict
 * badge and refused outright by the solver, which is where refusing belongs. The
 * editor's job is to show it, not to be the gate.
 */
function moduleRung(m) {
  const solved = m && m.solve && typeof m.solve.minRung === 'number' ? m.solve.minRung : null;
  const hand = m && m.handPlay && typeof m.handPlay.minRung === 'number' ? m.handPlay.minRung : null;
  /*
   * `bound` is the solver saying its own answer is not a proof: the negative that
   * decided the rung came from a search that had discarded states, so the module
   * may be clearable lower down. It is carried here rather than left in the file
   * because it changes what the number MEANS, and a panel that shows the number
   * without it is showing an answer where there is an estimate.
   *
   * A hand-play verdict settles it. A person clearing the module at rung r is a
   * fact about the game, not about the beam, so once played the bound stops
   * mattering to the effective rung.
   */
  const bound = !!(m && m.solve && m.solve.exact === false) && hand === null;
  if (solved === null && hand === null) return { rung: null, played: false, conflict: false, bound: false };
  if (hand === null) return { rung: solved, played: false, conflict: false, bound };
  if (solved === null) return { rung: hand, played: true, conflict: false, bound: false };
  return { rung: Math.max(solved, hand), played: true, conflict: hand < solved, bound: false };
}

/*
 * Which queue a module is in, or null if it needs nothing.
 *
 * Ordered by how much it matters that a person does something about it: an
 * unsolved module has no difficulty at all and the generator refuses it outright;
 * a conflict is a physics bug wearing a difficulty badge; an upper bound is a
 * usable number that is not yet an answer; and unplayed is the ordinary state of
 * a module that has been solved this afternoon and not yet played.
 */
function moduleQueue(m) {
  const r = moduleRung(m);
  if (r.rung === null) return 'unsolved';
  if (r.conflict) return 'conflict';
  if (r.bound) return 'bound';
  if (!r.played) return 'unplayed';
  return null;
}

/*
 * The queue filter. null shows everything; otherwise only that queue.
 *
 * Deliberately not persisted: it is a way of working through a list in one
 * sitting, and a filter that survives a reload is a library that has silently
 * lost half its modules.
 */
let modFilter = null;

const QUEUES = [
  ['unsolved', 'unsolved',
   'No difficulty is known for these at all. generate-map.js refuses them outright, and the ' +
   'editor cannot say what rung placing one would imply. Solve them first.'],
  ['conflict', 'conflict',
   'The hand-play verdict is BELOW the solved rung: a person cleared what the simulator says is ' +
   'impossible. That is a physics bug, not a difficulty correction, and solve-module.js refuses ' +
   'to write it down.'],
  ['bound', 'upper bound',
   'Solved, but the negative that decided the rung came from a beamed search that had thrown ' +
   'states away -- so the module may be clearable lower down. Safe to build with (a check ' +
   'labelled too hard comes available early, which cannot make a seed unbeatable) but it is an ' +
   'estimate, not a proof. A hand-play settles it.'],
  ['unplayed', 'unplayed',
   'Solved but never played by a person. The solver answers "physically possible" frame by ' +
   'frame; whether a human can actually do it is the other half of the answer, and only a ' +
   'hand-test gives it.'],
];

/*
 * Where a module is entered and left.
 *
 * Both are points on a top surface: the arena builder lines its entry and exit
 * ledges up with them exactly, so the module is the only thing between the spawn
 * and the coin. Leftmost surface in, rightmost surface out.
 *
 * Crushers are excluded because a falling slab is a hazard, not a floor. Ties on
 * x go to the LOWEST surface, which in a corridor is the one you walk on rather
 * than the ceiling above it -- and a module built as a corridor is exactly where
 * the tie happens.
 */
function deriveEnds(list) {
  let solid = list.filter((o) => o.kind === 'plat' && !o.stomper);
  if (!solid.length) solid = list.filter((o) => K(o) && K(o).shape === 'rect');
  if (!solid.length) {
    const b = groupBox(list);
    return b ? { entry:{ x:b.x, y:b.y }, exit:{ x:b.x + b.w, y:b.y } } : null;
  }
  const better = (a, b, right) => {
    const ax = right ? a.x + a.w : a.x, bx = right ? b.x + b.w : b.x;
    if (ax !== bx) return right ? ax > bx : ax < bx;
    return a.y > b.y;   // the tie-break: the lower surface is the floor
  };
  let inO = solid[0], outO = solid[0];
  for (const o of solid) {
    if (better(o, inO, false)) inO = o;
    if (better(o, outO, true)) outO = o;
  }
  return { entry:{ x:inO.x, y:inO.y }, exit:{ x:outO.x + outO.w, y:outO.y } };
}

/*
 * Editor-only and default-valued fields, stripped on the way into a module file.
 *
 * A module is read back by solver/arena.js and handed to MapFormat.toGame, which
 * tests these for truthiness and omits them when unset -- exactly as the vanilla
 * map does. Writing `semi: 0` on every platform would change the module's
 * canonical form without changing the level, and that alone would drop the solve
 * record of every module the editor ever touched.
 *
 * Only these. A prop whose default is a real number -- an enemy's speed, a laser's
 * cycle -- must survive, because toGame passes those straight through and
 * undefined would reach the simulator.
 */
const MODULE_OPTIONAL = {
  plat: ['semi', 'stomper', 'repeat'],
  art: ['rot', 'flipX', 'flipY', 'z'],
  door: ['open'],
};
const MODULE_KEY_ORDER = ['kind', 'x', 'y', 'w', 'h'];
function stripModuleObject(o) {
  const c = JSON.parse(JSON.stringify(o));
  delete c.id;
  // z on anything but a texture is an editing aid -- which of two overlapping
  // objects is clickable -- and is not part of the level
  if (c.kind !== 'art') delete c.z;
  // a selection group is an editing aid like z, and letting one into a module
  // record would change its geometry hash and drop the solve it already had
  delete c.group;
  for (const f of MODULE_OPTIONAL[c.kind] || []) if (!c[f]) delete c[f];
  /*
   * Fixed key order, so the same module always serialises to the same bytes.
   * Nothing depends on it for correctness -- the canonical form sorts keys -- but
   * a module file that reshuffles itself on every save turns a no-op re-save into
   * a whole-file diff, and then nobody reads the diffs that matter.
   */
  const out = {};
  for (const k of MODULE_KEY_ORDER) if (k in c) out[k] = c[k];
  for (const k of Object.keys(c)) if (!(k in out)) out[k] = c[k];
  return out;
}

/*
 * Build the module record for a selection.
 *
 * The origin shift goes through moveObjects(), the same one a drag uses, so a
 * module cannot pick up a different idea of what "move this group" means than the
 * rest of the editor -- patrol ranges, door zones, camera clamps and crusher
 * trigger bands all travel with it.
 */
function buildModuleRecord(name, tags, list, entryW, exitW) {
  const b = groupBox(list);
  if (!b) return null;
  const clones = list.map((o) => JSON.parse(JSON.stringify(o)));
  moveObjects(clones, -b.x, -b.y);
  return {
    name,
    version: 1,
    tags,
    objects: clones.map(stripModuleObject),
    size: { w: b.w, h: b.h },
    entry: { x: entryW.x - b.x, y: entryW.y - b.y },
    exit: { x: exitW.x - b.x, y: exitW.y - b.y },
  };
}

/*
 * Merge a re-save over the library's copy of the same module.
 *
 * Everything a person wrote by hand and the solver cannot regenerate -- `expect`
 * above all, which is a prediction made BEFORE the solver ever ran and is the
 * whole value of the fixture set -- is kept. The two difficulty records are kept
 * only while they still describe this geometry, and dropped otherwise. Dropped
 * rather than flagged: everything downstream treats a record as an answer.
 */
function mergeModule(next, prev) {
  if (prev === undefined) prev = moduleLib.find((m) => m.name === next.name);
  if (!prev) return next;
  const out = Object.assign({}, prev, next);
  if (geomKey(prev) !== geomKey(next)) { delete out.solve; delete out.handPlay; }
  return out;
}

/*
 * Provenance, in map.meta.modules.
 *
 * Not in the objects: a map is played by the game, and difficulty metadata inside
 * it would be read back as an answer by anything that opened the map -- including
 * after someone had edited the geometry. meta rides through mapformat untouched
 * and iniLevel ignores it, so this is a note about how the map was built and
 * nothing more. The generator writes the same field.
 */
function recordModuleUse(m, box) {
  if (!map.meta) map.meta = {};
  if (!Array.isArray(map.meta.modules)) map.meta.modules = [];
  map.meta.modules.push({ name: m.name, x: box.x, y: box.y, minRung: moduleRung(m).rung });
}

/*
 * A module is ARMED, then placed by a click on the canvas -- the same two-step
 * every other tool uses. Placing it the instant its row was clicked meant it
 * landed wherever the mouse had last been over the canvas, which is nowhere the
 * hand was looking: the pointer was on the palette.
 */
function armModule(m) {
  pendingModule = m && m.objects && m.objects.length ? m : null;
  setTool('module');
}

function placeModule(w) {
  const m = pendingModule;
  if (!m) return;
  pushHistory();
  const made = pasteObjects(m.objects.map((o) => Object.assign({}, o)), w);
  const box = groupBox(made);
  if (box) recordModuleUse(m, box);
  refresh();
}

/*
 * What is about to be placed, and where. Point kinds get their icon box and rects
 * get their real footprint, so a module whose size is its whole point -- a wide
 * gap, a tall ledge -- is judged against the map before it is committed rather
 * than after.
 */
function drawModuleGhost() {
  if (tool !== 'module' || !pendingModule || dragging) return;
  const objs = pendingModule.objects;
  let x0 = Infinity, y0 = Infinity;
  for (const o of objs) { x0 = Math.min(x0, o.x); y0 = Math.min(y0, o.y); }
  const dx = snap(lastWorld.x) - x0, dy = snap(lastWorld.y) - y0;
  ctx.save();
  ctx.globalAlpha = 0.6;
  ctx.lineWidth = 1.5 / view.z;
  ctx.setLineDash([7 / view.z, 5 / view.z]);
  for (const o of objs) {
    const k = KINDS[o.kind];
    if (!k) continue;
    const b = bounds(o);
    ctx.strokeStyle = k.color;
    ctx.strokeRect(b.x + dx, b.y + dy, Math.max(b.w, 2), Math.max(b.h, 2));
  }
  const gb = groupBox(objs);
  if (gb) {
    ctx.strokeStyle = '#6ea8fe';
    ctx.strokeRect(gb.x + dx, gb.y + dy, gb.w, gb.h);
  }
  ctx.restore();
}

/*
 * What a rung MEANS, in the numbers the game runs on.
 *
 * These three are the whole of the ability model that geometry cares about, and
 * they are transcribed from `solver/physics.js` -- `moveAccel`, `jumpImpulse`, and
 * the frame order of `controls()` then `vy += GRAVITY; y += vy`. Transcribed and
 * not imported because physics.js pulls its map in at require() time and is node
 * only; `tools/test-geometry.js` asserts these against the real functions on every
 * run, so the copy cannot drift silently.
 */
const moveAccel = (spd) => (spd <= 0 ? 0 : 0.8 + 0.2 * spd);
const jumpImpulse = (jmp) => (jmp <= 0 ? null : 1.1 * jmp + 12);
/*
 * How high one jump goes, in world pixels.
 *
 * The jump sets vy = -J, and every frame after that adds gravity BEFORE moving --
 * so the first frame rises J-1, not J. Summing until vy turns positive gives
 * n*J - n*(n+1)/2 for n = floor(J), which is the closed form the module set's
 * hand predictions were made with. Checked against a real boundary: ledge-tall is
 * a 270px step and solves at rung 14 (jmp5, rise 144.5, doubled 289) and not at
 * rung 13 (jmp4, 126.4, doubled 252.8).
 */
function jumpRise(jmp) {
  const J = jumpImpulse(jmp);
  if (J === null) return 0;
  const n = Math.floor(J);
  return n * J - (n * (n + 1)) / 2;
}

/*
 * The rung reference.
 *
 * Every number here is a FACT about a rung -- the tiers it carries and the two
 * quantities they turn into. There is deliberately no "how wide a gap this
 * clears": horizontal reach depends on run-up, ceilings and where the double jump
 * is spent, and a plausible number in a panel would be trusted at a glance. That
 * question is what solving a module answers, and what Phase 7's traversal probe
 * will answer for two points.
 */
/*
 * Drag a floating panel around the stage by its header.
 *
 * The rung reference is meant to be read WHILE editing -- "which rung first has
 * jmp5, and does the ledge I am drawing need it" -- and centred on the stage it
 * sits over the exact thing being measured. So it moves.
 *
 * It starts centred with a translate(-50%,-50%), which cannot be nudged by
 * setting left/top; the first drag converts it to plain pixel coordinates and
 * drops the transform. The position then lives on the element, so it survives
 * closing and reopening the panel, and a fresh session starts centred again.
 */
function dragPanelBy(el, handle) {
  handle.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.target.closest('button')) return;
    e.preventDefault();
    const host = el.offsetParent || el.parentElement;
    const r = el.getBoundingClientRect(), hr = host.getBoundingClientRect();
    const ox = e.clientX - r.left, oy = e.clientY - r.top;
    const move = (ev) => {
      el.style.transform = 'none';
      // kept inside the stage: a panel dragged off the edge cannot be dragged back
      const x = Math.max(0, Math.min(hr.width - 40, ev.clientX - hr.left - ox));
      const y = Math.max(0, Math.min(hr.height - 24, ev.clientY - hr.top - oy));
      el.style.left = x + 'px'; el.style.top = y + 'px';
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
}

function toggleRungRef() {
  const el = $('rungs');
  if (!el) return;
  if (el.style.display === 'block') { el.style.display = 'none'; return; }
  renderRungRef();
  el.style.display = 'block';
}

function renderRungRef() {
  const el = $('rungs');
  if (!el || typeof Ladder === 'undefined') {
    if (el) el.innerHTML = '<div class="foot">The ladder is not loaded in this build.</div>';
    return;
  }
  // the rung of whatever module is armed, so the table lands on something useful
  const here = pendingModule ? moduleRung(pendingModule).rung : null;
  const cols = [
    ['rung', (r) => r.index],
    ['gains', (r) => r.gained || '—'],
    ['spd', (r) => r.speed],
    ['jmp', (r) => r.jump],
    ['dj', (r) => (r.doubleJump ? 'yes' : '—')],
    ['hearts', (r) => r.energy],
    ['gun', (r) => (r.gun ? 'yes' : '—')],
    ['ammo', (r) => r.ammo],
    ['shots', (r) => Math.round(r.ammo * 0.1 * 20)],
    ['run px/f', (r) => (4 * moveAccel(r.speed)).toFixed(1)],
    ['jump px', (r) => (r.jump ? jumpRise(r.jump).toFixed(0) : '—')],
    ['+dj px', (r) => (r.jump && r.doubleJump ? (2 * jumpRise(r.jump)).toFixed(0) : '—')],
  ];
  const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  let html = '<div class="hd"><h3>Rung reference</h3><span class="muted">' +
    Ladder.N_RUNGS + ' rungs; each one adds exactly one item</span>' +
    '<span class="mde-sp"></span><button id="mde-rungclose">close</button></div><table><tr>' +
    cols.map((c) => '<th>' + esc(c[0]) + '</th>').join('') + '</tr>';
  for (const r of Ladder.RUNGS) {
    const cls = (r.index === here ? 'here ' : '') + (r.index > 0 ? 'got' : '');
    html += '<tr class="' + cls + '">' +
      cols.map((c, i) => '<td' + (i === 1 ? ' class="gain"' : '') + '>' + esc(c[1](r)) + '</td>').join('') +
      '</tr>';
  }
  html += '</table><div class="foot">' +
    '<b>run px/f</b> is terminal horizontal speed: velocity gains the accel each frame and keeps ' +
    '80% of it, so it settles at 4x the accel. <b>jump px</b> is how high one jump reaches from a ' +
    'standstill, and <b>+dj px</b> is that doubled -- what a second jump spent exactly at the apex ' +
    'buys, so it is a ceiling rather than a promise.<br>' +
    'There is no "gap this clears" column on purpose. Horizontal reach depends on the run-up, the ' +
    'headroom and where the double jump is spent, and a number here would be trusted at a glance. ' +
    'That is what solving a module answers.<br>' +
    '<b>shots</b> is what the gun is loaded with: the game does <code>round(ammo.v * 20)</code>, ' +
    'so the gun with Ammo 0 fires nothing and the simulator cannot tell it from having no gun.' +
    '</div>';
  el.innerHTML = html;
  const close = root.querySelector('#mde-rungclose');
  if (close) close.onclick = () => { el.style.display = 'none'; };
  const hd = el.querySelector('.hd');
  // the table is rebuilt on every open, so the handle is a new node each time
  if (hd) dragPanelBy(el, hd);
}

/*
 * Launch a hand-test.
 *
 * The arena is REBUILT first, every time. solve-module.js writes one when it
 * solves, but an arena left over from before an edit is worse than none: it would
 * hand someone the old geometry to play while the module file says something
 * else, and the verdict would be recorded against the new one. Rebuilding is
 * geometry, not simulation, so it costs nothing.
 *
 * The verdict itself is recorded on the play page rather than here -- "did I
 * actually clear that" has a short memory, and a loop that ends in another tab
 * ends with nobody writing anything down.
 */
async function handTest(m, queue) {
  const rung = moduleRung(m).rung;
  if (rung === null) return;
  let built = null;
  try { built = await io.moduleArena(m.name); }
  catch (e) { built = { ok: false, error: e.message }; }
  if (!built || !built.ok) {
    alert('Could not build the arena for "' + m.name + '".\n\n' +
          ((built && built.error) || 'no reason given'));
    return;
  }
  // the arena is a detour, not a destination: hand the play page the map that was
  // open so "back to editor" returns to the work, not to the module's test box
  io.play(built.id, {
    module: m.name,
    rung,
    from: (map.meta && map.meta.id) || '',
    // What is left to play after this one. The play page walks it itself, so a
    // session of hand-tests never comes back through this panel.
    queue: queue && queue.length ? queue : null,
  });
}

// ---------------------------------------------------------------- module panels
function moduleSectionVisible() {
  const sec = $('modsec');
  if (!sec) return false;
  const on = !!(io.listModules && io.saveModule);
  /*
   * The rung reference lives in this section and needs no library at all -- it is
   * the ladder, which is bundled -- so the section stays even where modules cannot
   * be stored. Only the parts that need io go away.
   */
  sec.style.display = (on || typeof Ladder !== 'undefined') ? '' : 'none';
  for (const id of ['modlist', 'modsave', 'modhint']) {
    const el = $(id);
    if (el) el.style.display = on ? '' : 'none';
  }
  return on;
}

/*
 * The queue bar: one chip per state that needs a person, with its count.
 *
 * A chip with nothing in it stays on screen, dimmed, rather than disappearing.
 * A row of chips that changes shape as the library changes is a row nobody can
 * learn the position of, and "0 unsolved" is worth reading -- it is the thing
 * being checked.
 */
function buildModuleQueue() {
  const el = $('modqueue');
  if (!el) return;
  el.innerHTML = '';
  if (!moduleLib.length) return;
  const counts = {};
  for (const m of moduleLib) {
    const q = moduleQueue(m);
    if (q) counts[q] = (counts[q] || 0) + 1;
  }
  const total = moduleLib.length;
  const mk = (key, label, n, title) => {
    const b = document.createElement('button');
    b.textContent = n + ' ' + label;
    b.title = title;
    b.className = (modFilter === key ? 'on ' : '') + (n ? '' : 'empty');
    b.onclick = () => { modFilter = modFilter === key ? null : key; buildModuleQueue(); buildModuleList(); };
    el.appendChild(b);
  };
  mk(null, 'all', total, 'Every module in the library.');
  for (const [key, label, why] of QUEUES) mk(key, label, counts[key] || 0, why);

  const waiting = (counts.unplayed || 0) + (counts.bound || 0);
  if (waiting && io.moduleArena && io.play) {
    const b = document.createElement('button');
    b.textContent = 'play all ' + waiting + ' \u2192';
    b.title = 'Hand-test everything waiting on a person, easiest rung first, without coming ' +
      'back here between modules. The play page walks the rest of the queue itself.';
    b.onclick = handTestQueue;
    el.appendChild(b);
  }
}

async function refreshModuleList() {
  if (!moduleSectionVisible()) return;
  try {
    const list = await io.listModules();
    moduleLib = Array.isArray(list) ? list : [];
  } catch (e) {
    console.warn('[editor] could not read the module library', e);
    moduleLib = [];
  }
  buildModuleQueue();
  buildModuleList();
}

function buildModuleList() {
  const el = $('modlist');
  if (!el) return;
  el.innerHTML = '';
  if (!moduleLib.length) {
    el.innerHTML = '<span class="muted">no modules yet</span>';
    return;
  }
  const shown = modFilter ? moduleLib.filter((m) => moduleQueue(m) === modFilter) : moduleLib;
  if (!shown.length) {
    el.innerHTML = '<span class="muted">nothing in that queue</span>';
    return;
  }
  const sorted = [...shown].sort((a, b) => {
    const ra = moduleRung(a).rung, rb = moduleRung(b).rung;
    if (ra === null && rb === null) return String(a.name).localeCompare(b.name);
    if (ra === null) return 1;
    if (rb === null) return -1;
    return ra - rb || String(a.name).localeCompare(b.name);
  });
  for (const m of sorted) {
    const r = moduleRung(m);
    const d = document.createElement('div');
    d.className = 'mod';
    const top = document.createElement('div'); top.className = 'top';
    const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = m.name;
    const badge = document.createElement('span'); badge.className = 'rung';
    if (solving.has(m.name)) { badge.classList.add('busy'); badge.textContent = 'solving…'; }
    else if (r.conflict) { badge.classList.add('bad'); badge.textContent = 'rung ' + r.rung + ' ?'; }
    else if (r.rung === null) { badge.classList.add('none'); badge.textContent = 'unsolved'; }
    else {
      badge.classList.add(r.played ? 'played' : 'solved');
      // "~" and a dotted rule: the number is real and usable, but it is a ceiling
      // rather than the answer, and it must not read like one.
      if (r.bound) badge.classList.add('bound');
      badge.textContent = 'rung ' + (r.bound ? '\u2264' : '') + r.rung;
    }
    top.appendChild(nm); top.appendChild(badge);
    d.appendChild(top);
    const tags = document.createElement('div'); tags.className = 'tags';
    tags.textContent = (m.tags || []).join(', ') +
      (m.size ? '   ' + Math.round(m.size.w) + '\u00d7' + Math.round(m.size.h) : '');
    d.appendChild(tags);
    /*
     * The badge says where the number came from, because "solved" and "trusted"
     * are different words: the solver answers physically possible, a hand-play
     * answers humanly executable, and only the second one has met a person.
     */
    d.title = m.name +
      (r.rung === null ? '\nUNSOLVED -- no difficulty is known for this module.'
        : r.conflict ? '\nrung ' + r.rung + ' -- CONFLICT: the hand-play verdict (' +
            m.handPlay.minRung + ') is BELOW the solved rung (' + m.solve.minRung +
            '). That is a physics bug, not a difficulty correction. Re-run solve-module.js.'
        : r.played ? '\nrung ' + r.rung + ', hand-played in the real game.'
        : r.bound ? '\nrung ' + r.rung + ' AT MOST -- the negative that decided it came from a ' +
            'beamed search that had discarded states, so it may be clearable lower down. Safe ' +
            'to build with, but it is an estimate. A hand-test settles it.'
        : '\nrung ' + r.rung + ' -- solved only: physically possible, never played by a person.') +
      '\n\nClick to pick it up, then click the canvas to place it.';
    d.dataset.module = m.name;
    d.onclick = () => { if (!solving.has(m.name)) armModule(m); };
    /*
     * The other half of a module's difficulty, and the only half a person can
     * answer. Offered on any module with a rung to test AT -- an unsolved one has
     * no rung to make a claim about, so it is solved first.
     */
    if (io.moduleArena && io.play && r.rung !== null) {
      const hp = document.createElement('button');
      hp.className = 'ex';
      hp.textContent = r.played ? 'hand-test again' : 'hand-test';
      hp.title = r.played
        ? 'Played at rung ' + r.rung + '. Play it again to re-record the verdict -- worth doing ' +
          'when the simulator has been corrected since.'
        : 'Play this module\'s arena at rung ' + r.rung + ' with exactly that rung\'s upgrades, ' +
          'and record whether a person can really clear it. Solved is not the same as trusted.';
      hp.onclick = (e) => { e.stopPropagation(); handTest(m); };
      d.appendChild(hp);
    }
    /*
     * Open it on its own. Offered on every module, solved or not: a module with no
     * record is exactly the one most likely to still need work.
     */
    const ed = document.createElement('button');
    ed.className = 'ex';
    ed.textContent = 'edit';
    ed.title = 'Open "' + m.name + '" on its own canvas, with its name, tags, entry and exit ' +
      'already filled in. Saving takes the whole canvas, so there is no selection to get wrong.';
    ed.onclick = (e) => { e.stopPropagation(); editModule(m); };
    d.appendChild(ed);

    /*
     * The one-click action for the queue a row is in.
     *
     * Only for unsolved and conflict: hand-testing already has its own button
     * below, and re-solving is the only thing the editor can do about either of
     * these on its own. A conflict re-solve is the RIGHT move too -- the usual
     * cause is that the simulator has been corrected since the verdict was
     * recorded, and re-running is what finds out.
     */
    const q = moduleQueue(m);
    if (io.solveModule && (q === 'unsolved' || q === 'conflict') && !solving.has(m.name)) {
      const sv = document.createElement('button');
      sv.className = 'act';
      sv.textContent = q === 'conflict' ? 're-solve' : 'solve';
      sv.title = q === 'conflict'
        ? 'Run the solver again. A hand-play below the solved rung usually means the simulator ' +
          'has been corrected since, and this is what finds out.'
        : 'Run solve-module.js over this module and write the rung into its file.';
      sv.onclick = (e) => { e.stopPropagation(); runSolver(m.name); };
      d.appendChild(sv);
    }

    if (io.exportModule) {
      const ex = document.createElement('button');
      ex.className = 'ex'; ex.textContent = 'export';
      ex.onclick = (e) => { e.stopPropagation(); io.exportModule(m.name, m); };
      d.appendChild(ex);
    }

    /*
     * Deleting a module.
     *
     * In the corner rather than in the row of actions, because it is the one
     * button here that cannot be undone by clicking it again, and it should not
     * sit next to `export` where a slip lands on it.
     *
     * The confirmation names what goes, in the order of what is hard to replace:
     * geometry can be redrawn, a solve is a machine's few minutes, and a
     * hand-play verdict is a person's time and is gone for good.
     */
    if (io.deleteModule) {
      const del = document.createElement('button');
      del.className = 'trash';
      del.textContent = '🗑';
      del.title = 'Delete "' + m.name + '" and everything recorded about it.';
      del.onclick = (e) => { e.stopPropagation(); deleteModule(m); };
      d.appendChild(del);
    }
    el.appendChild(d);
  }
}

/*
 * Play the whole queue in one sitting.
 *
 * Hand-playing is the expensive half of grading a module -- it is a person's
 * time -- and the loop was: pick a row, play, come back to the panel, find the
 * next row, play. The middle step is pure overhead, and worse, it is where a
 * session stops. So the play page is handed the REST of the queue and walks it
 * itself; the editor is not visited again until the queue is empty.
 *
 * The order is the panel's own order, which is by rung: easiest first. That is
 * the right way round for a person -- the early ones warm up the hands and the
 * hard ones come when the module set is already familiar.
 */
function handTestQueue() {
  const wait = [...moduleLib]
    .filter((m) => { const q = moduleQueue(m); return q === 'unplayed' || q === 'bound'; })
    .sort((a, b) => (moduleRung(a).rung || 0) - (moduleRung(b).rung || 0));
  if (!wait.length) return;
  handTest(wait[0], wait.slice(1).map((m) => m.name));
}

/*
 * ------------------------------------------------- editing a module directly
 *
 * A module used to be authored by dropping it into some map, editing it there,
 * marqueeing it back up and saving it over itself. Four steps, and three of them
 * are chances to get the bounding box wrong -- catch one platform too few and the
 * module silently loses a wall; catch one object too many and it gains a piece of
 * whatever map it was borrowing. Either way the geometry hash moves, the solve
 * record and the hand-play verdict are dropped, and the only sign is a badge
 * going grey.
 *
 * So: open the module on its own. The canvas holds the module and nothing else,
 * the save dialog is already open and already filled in with its name, tags,
 * entry and exit, and saving takes EVERYTHING on the canvas -- there is no
 * selection to get wrong, because there is nothing else there to select.
 *
 * Deliberately not the solved arena. solver/arena.js's box is what the module is
 * GRADED in and it is built fresh by solve-module.js every time; editing inside a
 * copy of it would put its walls and ledges on the canvas as objects, and the
 * first save would swallow them into the module. The arena stays where it
 * belongs, behind the hand-test button.
 */
/*
 * Delete a module, once someone has read what goes with it.
 *
 * The confirmation lists it rather than asking "are you sure": the module file
 * and its arena are cheap, and the solve and hand-play records inside it are
 * not. A hand-play verdict cost a person a session of playing a platformer, and
 * nothing regenerates it -- so it is named explicitly, and named last, where it
 * is the sentence someone is still reading when they decide.
 */
async function deleteModule(m) {
  if (!m || !io.deleteModule) return;
  const has = [];
  if (m.solve) has.push('its solved rung (' + m.solve.minRung + ')');
  if (m.handPlay) has.push('its HAND-PLAY verdict (rung ' + m.handPlay.minRung +
                           ') -- a person\'s time, and nothing regenerates it');
  const lines = ['Delete module "' + m.name + '"?', '',
    'This removes the module file and the arena built from it.'];
  if (has.length) lines.push('It also throws away ' + has.join(', and ') + '.');
  lines.push('', 'The geometry can be redrawn. The records cannot.');
  if (!confirm(lines.join('\n'))) return;

  // an armed module that no longer exists would place phantom geometry
  if (pendingModule && pendingModule.name === m.name) setTool('select');
  try {
    const r = await io.deleteModule(m.name);
    if (r && r.error) { alert('Could not delete "' + m.name + '": ' + r.error); return; }
  } catch (e) {
    alert('Could not delete "' + m.name + '": ' + e.message);
    return;
  }
  await refreshModuleList();
}

function editModule(m) {
  if (!m || !Array.isArray(m.objects) || !m.objects.length) return;
  /*
   * Losing an unsaved map to a click on a library row would be a bad trade for
   * the convenience. The editor persists per-map sessions to local storage, so
   * this is recoverable, but "recoverable" is not "expected".
   */
  if (map.objects.length && !confirm(
      'Open module "' + m.name + '" on its own?\n\nThe canvas is replaced by the module. ' +
      'The map you have open is saved in this browser and comes back when you open it again.')) {
    return;
  }
  closeModuleDialog();
  map = blankMap();
  map.meta.id = '';
  map.meta.name = 'module: ' + m.name;
  sel = []; undoStack = []; redoStack = []; clipboard = [];
  $('mapName').value = map.meta.name;
  $('mapList').value = '';
  // At the origin, which is where a module's own coordinates already are: what is
  // on screen then matches the numbers in the file, and the entry/exit markers
  // land where the file says rather than wherever the mouse happened to be.
  const made = pasteObjects(m.objects, { x: 0, y: 0 });
  /*
   * Nothing selected. pasteObjects leaves what it dropped selected, which is
   * right for a paste and wrong here: the module is not a thing that was just
   * pasted into a map, it is the map. Leaving it selected means the first arrow
   * key nudges the entire module off its own origin, and the first drawing tool
   * click is swallowed committing a selection nobody made.
   */
  sel = [];
  setTool('select');
  fitView();
  refresh();
  modDialog = {
    name: m.name,
    tags: (m.tags || []).join(', '),
    entry: { ...m.entry },
    exit: { ...m.exit },
    ids: made.map((o) => o.id),
    /*
     * Editing takes the whole canvas, not the ids recorded above. Anything drawn
     * from here on is part of the module -- that is the point of opening it on
     * its own -- and a list of ids captured at open time would quietly leave every
     * new object out of the save.
     */
    whole: true,
    solve: true,
    tagsTouched: true,   // they came from the module; do not re-adopt over them
  };
  renderModuleDialog();
}

/*
 * The save dialog.
 *
 * Entry and exit are derived from the selection and then left editable, as
 * numbers in the panel and as two markers on the canvas, because the derivation
 * is a guess about intent: leftmost and rightmost top surface is right for a gap
 * or a ledge and wrong the moment a module is meant to be entered from elsewhere.
 */
function openModuleDialog() {
  const list = selected();
  if (!list.length) { alert('Select the objects that make up the module first.'); return; }
  const ends = deriveEnds(list);
  if (!ends) return;
  modDialog = {
    name: '', tags: '',
    entry: { ...ends.entry }, exit: { ...ends.exit },
    ids: list.map((o) => o.id),
    solve: true,   // solving on save is the default; the checkbox is how to say no
    tagsTouched: false,
  };
  renderModuleDialog();
}
function closeModuleDialog() {
  modDialog = null;
  const el = $('modpanel');
  if (el) { el.style.display = 'none'; el.innerHTML = ''; }
}

function renderModuleDialog() {
  const el = $('modpanel');
  if (!el) return;
  if (!modDialog) return closeModuleDialog();
  /*
   * 'block', not ''. The hidden state is `display:none` in the STYLESHEET, so
   * clearing the inline value falls straight back to it and the panel stays
   * invisible -- with its canvas markers drawn, which reads as "the editor did
   * something and then refused to ask for a name".
   */
  el.style.display = 'block';
  el.innerHTML = '';
  const h = document.createElement('h3');
  h.textContent = modDialog.whole ? 'Editing module' : 'Save as module';
  el.appendChild(h);
  if (modDialog.whole) {
    const n = document.createElement('div');
    n.className = 'note';
    n.textContent = 'The canvas is this module and nothing else, so saving takes all of it -- ' +
      'anything you add here becomes part of the module. Close the dialog to go back to ' +
      'ordinary map editing without saving.';
    el.appendChild(n);
  }

  const row = (label, value, set) => {
    const r = document.createElement('div'); r.className = 'row2';
    const l = document.createElement('span'); l.textContent = label;
    const i = document.createElement('input'); i.type = 'text'; i.value = value;
    i.oninput = () => set(i.value);
    r.appendChild(l); r.appendChild(i);
    el.appendChild(r);
  };
  row('name', modDialog.name, (v) => { modDialog.name = v; adoptTags(); renderModuleWarning(); });
  row('tags', modDialog.tags, (v) => { modDialog.tags = v; modDialog.tagsTouched = true; });

  const pt = (label, which) => {
    const r = document.createElement('div'); r.className = 'pair';
    const l = document.createElement('span'); l.textContent = label;
    const mk = (axis) => {
      const i = document.createElement('input'); i.type = 'text';
      i.style.cssText = 'width:100%;background:#12141a;border:1px solid #2c3040;color:#dde1ea;' +
        'border-radius:4px;padding:3px 5px;font:inherit;font-size:11px';
      i.value = String(Math.round(modDialog[which][axis]));
      i.oninput = () => { const n = Number(i.value); if (i.value !== '' && !isNaN(n)) { modDialog[which][axis] = n; renderModuleWarning(); } };
      i.dataset.mod = which + axis;
      return i;
    };
    const ys = document.createElement('span'); ys.textContent = 'y';
    r.appendChild(l); r.appendChild(mk('x')); r.appendChild(ys); r.appendChild(mk('y'));
    el.appendChild(r);
  };
  pt('entry x', 'entry');
  pt('exit x', 'exit');

  const note = document.createElement('div');
  note.className = 'note';
  note.textContent = 'Entry and exit are points on a top surface, and the arena builder puts a ' +
    'ledge flush with each. Drag the green and red markers on the canvas, or type them here. ' +
    'The exit must be right of the entry: arenas run left to right.';
  el.appendChild(note);

  /*
   * Solve on save.
   *
   * A module with no solve record is a module the generator cannot use, and the
   * gap between saving one and remembering to run the solver is where an unsolved
   * library comes from -- so it runs by default, and the box is how to say no. It
   * appears only where solving is possible at all (the dev server; the userscript
   * has no node) and only where a solve is actually NEEDED: an unchanged module
   * keeps its record, and re-solving it would burn tens of seconds to write down
   * the same number.
   */
  if (io.solveModule) {
    const wrap = document.createElement('label');
    wrap.className = 'chk';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.id = 'mde-modsolve';
    cb.checked = modDialog.solve !== false;
    cb.onchange = () => { modDialog.solve = cb.checked; };
    const txt = document.createElement('span');
    txt.id = 'mde-modsolvetxt';
    wrap.appendChild(cb); wrap.appendChild(txt);
    el.appendChild(wrap);
  }

  const warn = document.createElement('div');
  warn.id = 'mde-modwarn';
  el.appendChild(warn);

  const btns = document.createElement('div'); btns.className = 'btns';
  const ok = document.createElement('button'); ok.className = 'primary'; ok.textContent = 'save module';
  ok.onclick = saveModuleNow;
  const no = document.createElement('button'); no.textContent = 'cancel';
  no.onclick = closeModuleDialog;
  btns.appendChild(ok); btns.appendChild(no);
  el.appendChild(btns);
  renderModuleWarning();
}

/*
 * Say up front what a save is about to throw away.
 *
 * Overwriting a module whose geometry has changed drops its solve record AND its
 * hand-play verdict -- the second of which cost somebody a play session -- so that
 * has to be visible before the button is pressed, not discovered afterwards.
 */
function renderModuleWarning() {
  const el = root && root.querySelector('#mde-modwarn');
  if (!el || !modDialog) return;
  el.innerHTML = '';
  const name = moduleName(modDialog.name);
  const prev = name && moduleLib.find((m) => m.name === name);
  const next = pendingModuleRecord();
  const same = !!prev && !!next && geomKey(prev) === geomKey(next);
  updateSolveChoice(prev, same);
  if (!prev) return;
  const had = [prev.solve && 'its solve record', prev.handPlay && 'its hand-play verdict']
    .filter(Boolean).join(' and ');
  const d = document.createElement('div');
  d.className = 'note';
  d.textContent = same
    ? 'Overwrites "' + name + '". Same geometry, so ' + (had || 'nothing') + ' is kept.'
    : 'Overwrites "' + name + '" with DIFFERENT geometry' +
      (had ? ', which drops ' + had + '.' : '.');
  el.appendChild(d);
}

/*
 * Typing the name of a module that already exists adopts its tags.
 *
 * The dialog opens empty, so overwriting a module used to blank its tags -- work
 * a person did, silently thrown away by a field they never touched. Only while
 * the field is untouched, so clearing tags on purpose still clears them.
 */
function adoptTags() {
  if (!modDialog || modDialog.tagsTouched) return;
  const prev = moduleLib.find((m) => m.name === moduleName(modDialog.name));
  const tags = prev && prev.tags ? prev.tags.join(', ') : '';
  if (tags === modDialog.tags) return;
  modDialog.tags = tags;
  const field = root && root.querySelectorAll('#mde-modpanel input')[1];
  if (field) field.value = tags;
}

const moduleName = (s) => String(s || '').trim().toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64);

function pendingModuleRecord() {
  if (!modDialog) return null;
  // `whole` is module-first editing: the canvas IS the module, so the record is
  // everything on it. Otherwise it is the selection the dialog was opened over.
  const list = modDialog.whole
    ? map.objects.slice()
    : modDialog.ids.map(byId).filter(Boolean);
  if (!list.length) return null;
  const tags = modDialog.tags.split(',').map((t) => t.trim()).filter(Boolean);
  return buildModuleRecord(moduleName(modDialog.name), tags, list, modDialog.entry, modDialog.exit);
}

/*
 * Whether saving this module will leave it without an answer, and therefore
 * whether the solver has anything to do. `keeps` means the stored record survives
 * the save, so a re-solve would spend tens of seconds writing down the number that
 * is already there.
 */
function solveNeeded(prev, sameGeometry) {
  return !(prev && sameGeometry && prev.solve);
}

function updateSolveChoice(prev, sameGeometry) {
  const cb = root && root.querySelector('#mde-modsolve');
  const txt = root && root.querySelector('#mde-modsolvetxt');
  if (!cb || !txt) return;
  const needed = solveNeeded(prev, sameGeometry);
  cb.disabled = !needed;
  if (!needed) cb.checked = false;
  else if (modDialog.solve !== false) cb.checked = true;
  txt.textContent = needed
    ? 'Solve it now. Runs solver/solve-module.js over the saved module and writes the rung ' +
      'into it -- seconds to a minute. Unticked, it saves as unsolved and the generator cannot ' +
      'use it until you solve it by hand.'
    : 'Already solved at rung ' + prev.solve.minRung + ', and this save does not change the ' +
      'geometry, so there is nothing to re-solve.';
}

/*
 * Solving runs AFTER the save and does not hold the dialog open.
 *
 * It is seconds to a minute per module, and a modal that sits there for a minute
 * gets cancelled. The row carries the state instead: the badge goes amber and says
 * "solving", and the library refreshes when the answer lands -- so a wrong rung is
 * never on screen while the right one is being computed.
 */
async function runSolver(name) {
  solving.add(name);
  buildModuleList();
  let res = null;
  try { res = await io.solveModule(name); }
  catch (e) { res = { ok: false, error: e.message }; }
  solving.delete(name);
  await refreshModuleList();
  if (!res || !res.ok) {
    alert('The solver did not produce an answer for "' + name + '", so it is saved as ' +
          'unsolved.\n\n' + ((res && (res.error || res.output)) || 'no output') +
          '\n\nRun it by hand to see the whole story:\n' +
          '  cd solver && node solve-module.js ../mapeditor/modules/' + name + '.json --write');
  }
}

async function saveModuleNow() {
  const name = moduleName(modDialog && modDialog.name);
  if (!name) { alert('The module needs a name.'); return; }
  const rec = pendingModuleRecord();
  if (!rec) { alert('The objects that were selected are gone.'); return; }
  if (rec.exit.x <= rec.entry.x) {
    alert('The exit must be right of the entry: arenas run left to right, and solver/arena.js ' +
          'refuses a module that does not.');
    return;
  }
  const full = mergeModule(rec);
  let ok = false;
  try {
    const r = await io.saveModule(name, full);
    ok = !!(r && r.ok);
  } catch (e) { console.error('[editor] module save failed', e); }
  if (!ok) { alert('Could not save the module.'); return; }
  const wantSolve = modDialog.solve !== false;
  closeModuleDialog();
  await refreshModuleList();
  // full.solve survives only when the geometry did not move, and that is exactly
  // when there is nothing to run
  if (io.solveModule && wantSolve && !full.solve) runSolver(name);
}

/*
 * The two markers, drawn only while the dialog is open. Same grab radius as every
 * other handle, and tested BEFORE the object handles so a marker sitting on a
 * platform corner is still reachable.
 */
function modMarkerAt(sx, sy) {
  if (!modDialog) return null;
  for (const which of ['entry', 'exit']) {
    const p = modDialog[which];
    if (Math.abs(sx - (p.x * view.z + view.x)) <= HANDLE / 2 + 5 &&
        Math.abs(sy - (p.y * view.z + view.y)) <= HANDLE / 2 + 5) return which;
  }
  return null;
}
function drawModuleMarkers() {
  if (!modDialog) return;
  const list = modDialog.ids.map(byId).filter(Boolean);
  const b = groupBox(list);
  if (b) {
    ctx.strokeStyle = '#64d19a';
    ctx.lineWidth = 2 / view.z;
    ctx.setLineDash([12 / view.z, 7 / view.z]);
    ctx.strokeRect(b.x, b.y, b.w, b.h);
    ctx.setLineDash([]);
  }
  const label = (p, text, color) => {
    ctx.fillStyle = color;
    ctx.font = (12 / view.z) + 'px ui-sans-serif,system-ui,sans-serif';
    ctx.fillText(text, p.x + 10 / view.z, p.y - 10 / view.z);
  };
  circ(modDialog.entry, HANDLE + 6, '#64d19a', '#0d0f14');
  label(modDialog.entry, 'entry', '#64d19a');
  circ(modDialog.exit, HANDLE + 6, '#e07a7a', '#0d0f14');
  label(modDialog.exit, 'exit', '#e07a7a');
}

// ---------------------------------------------------------------- game format
/*
 * Conversion lives in mapkit/mapformat.js -- mapkit owns it because mapkit ships.
 * The editor writes these files and mapkit reads them, so a second copy here
 * would drift -- the same trap the two normalise paths nearly fell into.
 */
const toGame = () => MapFormat.toGame(map);
function loadGame(g) {
  const m = MapFormat.fromGame(g, nextId);
  nextId = m.nextId;
  map = { meta: m.meta, objects: m.objects, yEnd: m.yEnd };
  sel = [];
}

// ---------------------------------------------------------------- helpers
const K = (o) => KINDS[o.kind];
const byId = (id) => map.objects.find((o) => o.id === id);
const selected = () => sel.map(byId).filter(Boolean);
const snap = (v) => grid ? Math.round(v / grid) * grid : Math.round(v);

/*
 * ------------------------------------------------------------------ grid paint
 *
 * Building a room out of single clicks is the reason authoring a module takes an
 * afternoon: a corridor floor is thirty platforms, and each one is a click, a
 * drag, a squint at the HUD and a nudge. Paint mode turns the same work into one
 * stroke -- every grid cell the cursor enters gets exactly one stamp of whatever
 * tool is armed, aligned to the cell by construction rather than by aim.
 *
 * Three rules, and each of them is what makes the stroke usable rather than a
 * mess to clean up afterwards:
 *
 *   SNAPPED       a stamp fills its cell exactly. Not "snapped to the nearest
 *                 grid line" -- that still lets two stamps sit a cell apart with
 *                 a hairline between them, and a hairline in a platform run is a
 *                 hole Johnny falls through.
 *   NEVER DOUBLED a cell that already holds this kind is skipped, so dragging
 *                 back over your own stroke is free and the shaky part of a fast
 *                 drag does not stack forty platforms in one cell.
 *   ONE UNDO      the whole stroke is a single history entry. A stroke that
 *                 undoes cell by cell is worse than no undo at all.
 *
 * Paint needs a grid, because a cell is the unit it works in. Selecting `free`
 * turns it off rather than guessing a size.
 */

/*
 * What can be painted: the kinds a room is BUILT out of.
 *
 * Excluded on purpose rather than by omission --
 *   single kinds (spawn, gun, boss gate, boss arena) exist once per map, so a
 *     stroke of them is a stroke of one object being dragged about;
 *   lasers are beams, whose whole geometry is the two ends, and a beam squeezed
 *     into one cell is not a laser;
 *   camera areas and doors are placed against the shape of a room, one at a
 *     time, and painting a row of them has no meaning.
 */
const PAINTABLE = ['plat', 'art', 'spike', 'coin', 'ene', 'bomb', 'platMove'];
/*
 * What a stroke stamps: the clipboard, or the armed tool.
 *
 * The clipboard wins only while it is the most recent thing you did. Copying
 * arms it, picking a tool disarms it. Letting it win outright for as long as it
 * held anything -- which is what shipped first -- made the toolbar stop meaning
 * anything, with no way back to a one-object brush except copying one object.
 */
let clipBrush = false;
const brushIsClipboard = () => clipBrush && clipboard.length > 0;

/*
 * Say which brush is armed, and offer the way back to the other one.
 *
 * An indicator rather than only a label: with the clipboard armed the toolbar no
 * longer answers "what will this stroke draw", and a paint mode that quietly
 * stamps something other than the armed tool is worse than having no brush.
 * Clicking it toggles, so re-arming a clipboard you disarmed by reaching for a
 * tool does not mean copying the same selection twice.
 */
function renderBrush() {
  const b = root && root.querySelector('#mde-brush');
  if (!b) return;
  const on = brushIsClipboard();
  b.classList.toggle('on', on);
  b.disabled = !on && clipboard.length === 0;
  b.textContent = on
    ? 'brush: clipboard (' + clipboard.length + ')'
    : 'brush: ' + (PAINTABLE.includes(tool) ? tool : 'tool');
  b.title = clipboard.length === 0
    ? 'Copy a selection (ctrl+c) and a stroke stamps that instead of the armed tool.'
    : on
      ? 'A stroke stamps the ' + clipboard.length + ' copied objects. Picking a tool puts the ' +
        'clipboard brush down; click here to pick it back up.'
      : 'A stroke stamps the armed tool. Click to go back to painting the ' + clipboard.length +
        ' objects on the clipboard.';
}
const canPaint = () => paint && grid > 0 && (brushIsClipboard() || PAINTABLE.includes(tool));

const cellOf = (w) => ({ cx: Math.floor(w.x / grid), cy: Math.floor(w.y / grid) });
const cellKey = (c) => c.cx + ',' + c.cy;

/*
 * Spikes are the only lethal thing the runtime does not draw.
 *
 * `mapkit/renderer.js` fills platforms flat black, so an untextured platform is
 * merely plain; an untextured spike rect is an invisible instant death. So a map
 * is not finished until every spike carries art, and doing that by hand is a
 * hundred clicks nobody makes.
 *
 * The tiling divides the rect EVENLY rather than laying whole tiles and clipping
 * the last one. Art objects cannot clip -- they can only be resized -- so
 * "clip the remainder" in practice means one visibly squashed column at the end
 * of every strip, which is what the generator's placeholder did. Spreading the
 * error over every tile instead makes it a percent or two of scale nobody sees.
 *
 * Natural tile size is the caller's, because the editor knows the real dimensions
 * from the palette and a node script only has the recipe.
 */
const SPIKE_TILE = { name: 'hazard_surface', w: 120, h: 80 };

function spikeArt(rect, tile) {
  const t = tile || SPIKE_TILE;
  const out = [];
  const w = Number(rect.w) || 0, h = Number(rect.h) || 0;
  if (w <= 0 || h <= 0) return out;
  const cols = Math.max(1, Math.round(w / t.w));
  const rows = Math.max(1, Math.round(h / t.h));
  const cw = w / cols, ch = h / rows;
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      out.push({ kind: 'art', tile: t.name,
                 x: rect.x + c * cw, y: rect.y + r * ch, w: cw, h: ch,
                 rot: 0, flipX: 0, flipY: 0, z: 0 });
    }
  }
  return out;
}

/*
 * Does this spike rect already have art over it?
 *
 * By centre containment, the same question `cellOccupied` asks: running "fill
 * spikes" twice should be a no-op rather than doubling every tile, and an author
 * who has textured one strip by hand should keep that work.
 */
const spikeIsCovered = (s, objs) => objs.some((o) => o.kind === 'art' &&
  o.x + o.w / 2 >= s.x && o.x + o.w / 2 <= s.x + s.w &&
  o.y + o.h / 2 >= s.y && o.y + o.h / 2 <= s.y + s.h);

/**
 * Art for every untextured spike rect in `objs`. Pure: returns what to add.
 */
function autotileSpikes(objs, tile) {
  const out = [];
  for (const s of objs) {
    if (s.kind !== 'spike') continue;
    if (spikeIsCovered(s, objs)) continue;
    out.push(...spikeArt(s, tile));
  }
  return out;
}

/*
 * Which family a texture belongs to, read off its name.
 *
 * The tileset ships as a recipe rebuilt from the player's own artwork and
 * carries no metadata beyond names, so the names are all there is. Two families
 * behave differently from ordinary decoration when stamped on a grid:
 *
 *   hazard -- the spike strip. It is the skin of a lethal rect and has to line
 *     up edge to edge with its neighbours, so it fills the cell exactly and is
 *     the one tile allowed to stretch. A letterboxed spike leaves a gap that
 *     reads as a safe step and is not one.
 *   surface -- the skin of a solid. It belongs against the face Johnny stands
 *     on, which is the tile's own top edge, so it goes flush to that edge rather
 *     than floating in the middle of the cell.
 *
 * Corner pieces are decoration: they are cut to sit at a join and have no single
 * face that is "the top".
 */
const isHazardTile = (n) => /hazard|spike/.test(n || '');
const isSurfaceTile = (n) => /surface/.test(n || '') && !/corner/.test(n || '') && !isHazardTile(n);

/*
 * Where one texture goes inside one grid cell.
 *
 * The tiles are cut from the game's own artwork at their own aspect ratios, so
 * forcing one into a square cell is the difference between a wall that looks
 * like the game and one that looks like the game in a funhouse mirror. So:
 * letterbox by the tighter axis, never scale UP past 1:1, and let the hazard
 * family above be the single exception.
 *
 * Returns the object's own (unrotated) rect, because that is what o.x/o.y/o.w/
 * o.h mean -- the renderer turns it about its centre afterwards. So the work is
 * done on the box it will actually COVER (`rotAABB`), and the corner is backed
 * out at the end.
 *
 * A surface tile's "top" rotates with it: turn a floor 90 degrees and it is a
 * wall, whose inner edge -- the face you would stand on if you stood on the wall
 * -- is now the cell's right-hand side. So which cell edge it hugs comes from
 * `rot`, and it is centred along the other axis. Anything that is not a quarter
 * turn has no meaningful edge to hug and stays centred.
 */
function placeTile(tile, cx, cy, cell, rot) {
  // a square filling the cell is a square under any rotation, so the hazard
  // case needs no frame work at all
  if (isHazardTile(tile.name)) return { x: cx, y: cy, w: cell, h: cell };

  const deg = (((rot || 0) % 360) + 360) % 360;
  const ang = deg * Math.PI / 180;
  // letterbox against the box it will COVER once turned, so a sideways tile is
  // measured against the cell sideways
  const cov = rotAABB(0, 0, tile.w, tile.h, ang);
  const f = Math.min(cell / cov.w, cell / cov.h, 1);
  const w = Math.round(tile.w * f), h = Math.round(tile.h * f);
  const a = rotAABB(0, 0, w, h, ang);

  let ax = (cell - a.w) / 2, ay = (cell - a.h) / 2;   // centred, the default
  if (isSurfaceTile(tile.name) && deg % 90 === 0) {
    if (deg === 0) ay = 0;                 // top edge up:    hug the cell top
    else if (deg === 90) ax = cell - a.w;  // top edge right: hug the right side
    else if (deg === 180) ay = cell - a.h; // upside down:    hug the bottom
    else ax = 0;                           // 270, top left:  hug the left side
  }
  // back out the object's own corner from the box it covers
  return {
    x: Math.round(cx + ax + (a.w - w) / 2),
    y: Math.round(cy + ay + (a.h - h) / 2),
    w, h,
  };
}

/*
 * Does this cell already hold one of these?
 *
 * By the cell's CENTRE rather than by an overlap test: a painted stamp fills its
 * cell, so its centre is inside exactly one cell and the test is exact for
 * anything the stroke itself laid down. For an object that was placed by hand
 * and happens to cross the cell, containing the centre is still the right
 * question -- painting over the middle of an existing platform should be a
 * no-op, painting over its edge should not.
 */
function cellOccupied(cx, cy, kind) {
  const x0 = cx * grid, y0 = cy * grid, x1 = x0 + grid, y1 = y0 + grid;
  const mx = x0 + grid / 2, my = y0 + grid / 2;
  return map.objects.some((o) => {
    if (o.kind !== kind) return false;
    const b = bounds(o);
    if (mx >= b.x && mx <= b.x + b.w && my >= b.y && my <= b.y + b.h) return true;
    /*
     * ...or the other way round. A surface tile hugs one edge of its cell rather
     * than filling it, so the cell's centre can sit in open space just above or
     * beside it -- and the centre test alone would then let a second stamp land
     * on top of the first every time the stroke came back over.
     */
    const ox = b.x + b.w / 2, oy = b.y + b.h / 2;
    return ox >= x0 && ox <= x1 && oy >= y0 && oy <= y1;
  });
}

/** One stamp, filling cell (cx, cy). Returns the object, or null if the cell was taken. */
function stampCell(cx, cy) {
  if (cellOccupied(cx, cy, tool)) return null;
  const k = KINDS[tool];
  const x = cx * grid, y = cy * grid;
  const o = { id: nextId++, kind: tool, x, y, w: 0, h: 0, ...(k.props || {}) };
  if (tool === 'art') {
    if (!selTile) return null;
    const f = placeTile(selTile, x, y, grid, artStyle.rot);
    o.x = f.x; o.y = f.y; o.w = f.w; o.h = f.h;
    o.tile = selTile.name;
    o.rot = artStyle.rot; o.flipX = artStyle.flipX; o.flipY = artStyle.flipY;
  } else if (k.shape === 'point') {
    // A point kind has no size of its own, so it goes to the middle of the cell.
    o.x = x + grid / 2; o.y = y + grid / 2;
  } else {
    o.w = grid; o.h = grid;
  }
  if (k.path) { o.xmin = o.x; o.xmax = o.x; o.ymin = o.y; o.ymax = o.y; }
  map.objects.push(o);
  return o;
}

/*
 * The clipboard as a brush.
 *
 * With something copied, a stroke stamps THAT rather than the armed tool's one
 * object -- which is the difference between filling cells with platforms and
 * tiling a motif, and tiling a motif is most of what building a room is. The
 * armed tool stays the fallback for an empty clipboard, so paint never becomes a
 * mode that quietly does nothing.
 *
 * A motif is wider than one cell, so the footprint is its bounding box rounded
 * up to whole cells, and the stroke's never-stamp-twice bookkeeping has to key
 * on every cell of that footprint rather than on the one under the cursor.
 */
const brushSize = () => {
  if (!clipboard.length) return { cols: 1, rows: 1 };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const c of clipboard) {
    const b = bounds(c);
    x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h);
  }
  return { cols: Math.max(1, Math.ceil((x1 - x0) / grid)),
           rows: Math.max(1, Math.ceil((y1 - y0) / grid)) };
};

/*
 * Has this exact motif already been stamped here?
 *
 * An exact-position test on the first object of the brush, rather than anything
 * cleverer. "Is this composition already present" needs an identity the editor
 * does not have, and a false positive -- refusing to paint where the author
 * meant to -- is worse than a duplicate they can see and undo. Restamping the
 * same cell IS exact, which is the case that actually happens: a stroke that
 * wanders back over itself.
 */
function motifOccupied(dx, dy) {
  const c = clipboard[0];
  const x = c.x + dx, y = c.y + dy;
  return map.objects.some((o) => o.kind === c.kind && o.x === x && o.y === y);
}

/** One stamp of the clipboard brush, top-left at cell (cx, cy). Ids, or null. */
function stampBrush(cx, cy) {
  const x = cx * grid, y = cy * grid;
  let x0 = Infinity, y0 = Infinity;
  for (const c of clipboard) { const b = bounds(c); x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); }
  if (motifOccupied(x - x0, y - y0)) return null;
  // paste from the bounding box's corner, so the motif lands square in the cell
  const made = pasteObjects(clipboard, { x, y }, true);
  return made.map((o) => o.id);
}

/*
 * Stamp every cell of the stroke the cursor has newly entered.
 *
 * With shift held the stroke is locked to one axis, chosen by whichever the
 * cursor has travelled furthest along since the mousedown. Straight floors and
 * straight walls are nearly everything anyone paints, and a freehand drag makes
 * neither.
 */
function paintAt(d, w, shift) {
  let c = cellOf(w);
  if (shift && d.c0) {
    const dx = Math.abs(c.cx - d.c0.cx), dy = Math.abs(c.cy - d.c0.cy);
    /*
     * The axis is LATCHED, and not until the stroke is two cells clear of where
     * it started. Deciding it fresh on every move draws an L: the first cells of
     * any stroke are diagonal-ish, so whichever axis happens to lead by one cell
     * wins for a moment and leaves a stub across the corner. Two cells is also
     * forgiving of a hand that wanders one cell the wrong way before committing.
     */
    if (!d.axis && Math.max(dx, dy) >= 2) d.axis = dx >= dy ? 'x' : 'y';
    if (!d.axis) c = d.c0;
    else c = d.axis === 'x' ? { cx: c.cx, cy: d.c0.cy } : { cx: d.c0.cx, cy: c.cy };
  }
  /*
   * A brush wider than one cell steps by its OWN footprint.
   *
   * Advancing one grid cell at a time whatever is being stamped means a
   * three-cell motif lands at every offset and overlaps itself into a mess -- the
   * never-stamp-twice rule stops the duplicates but not the ragged edge, because
   * each position is a legitimately different set of cells. So the stroke snaps
   * to a lattice of footprints laid out from where the stroke began.
   *
   * The global grid setting does not change: it is still what a cell IS, and the
   * footprint is measured in cells. This is a property of the stroke only.
   */
  const { cols, rows } = d.foot || { cols: 1, rows: 1 };
  if (d.c0 && (cols > 1 || rows > 1)) {
    c = {
      cx: d.c0.cx + Math.floor((c.cx - d.c0.cx) / cols) * cols,
      cy: d.c0.cy + Math.floor((c.cy - d.c0.cy) / rows) * rows,
    };
  }
  const keys = [];
  for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) {
    const k = cellKey({ cx: c.cx + i, cy: c.cy + j });
    if (d.done.has(k)) return false;
    keys.push(k);
  }
  for (const k of keys) d.done.add(k);
  if (d.brush) {
    const ids = stampBrush(c.cx, c.cy);
    if (ids) d.made.push(...ids);
    return !!ids;
  }
  const o = stampCell(c.cx, c.cy);
  if (o) d.made.push(o.id);
  return !!o;
}

function setPaint(v) {
  // Free means there are no cells, so there is nothing to paint into.
  paint = !!v && grid > 0;
  const el = $('paint');
  if (el) {
    el.classList.toggle('on', paint);
    el.disabled = !grid;
    el.title = grid
      ? 'Paint mode: drag and every ' + grid + 'px cell the cursor enters gets one stamp of the ' +
        'armed tool. Never doubles up, and the whole stroke is one undo. Key p.'
      : 'Paint mode needs a grid -- pick a cell size above free first. Key p.';
  }
}
const toWorld = (sx, sy) => ({ x:(sx - view.x) / view.z, y:(sy - view.y) / view.z });

/*
 * Pointer position in stage pixels.
 *
 * NOT e.offsetX: mousemove and mouseup are bound to the window so a drag can
 * continue outside the canvas, and offsetX is then relative to whatever element
 * the pointer happens to be over -- a side panel, a button. Measuring against
 * the stage's own rect is the only thing that is correct everywhere, and it is
 * what makes the coordinate readout trustworthy while dragging off-canvas.
 */
function stagePos(e) {
  const r = stageEl().getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}
const worldOf = (e) => { const p = stagePos(e); return toWorld(p.x, p.y); };

// a laser's beam rect: centred on the emitter, 40 across, `length` along
function laserRect(o) {
  const len = Math.max(8, Number(o.length) || (o.horizontal ? LASER_LEN_H : LASER_LEN_V));
  return o.horizontal
    ? { x:o.x - len/2, y:o.y - LASER_THICK/2, w:len, h:LASER_THICK }
    : { x:o.x - LASER_THICK/2, y:o.y - len/2, w:LASER_THICK, h:len };
}

/*
 * A rotated texture's box on screen.
 *
 * `rot` is applied by the renderer about the object's centre, so a 90-degree
 * turn draws a wide tile tall -- while o.w/o.h, which are the tile's size in its
 * OWN frame, say nothing about it. Every axis-aligned box in the editor is
 * derived from `bounds`, so leaving it unrotated put the hit test, the marquee
 * and the resize handles somewhere the object visibly is not: the tile could
 * only be grabbed by empty space beside it.
 *
 * So `bounds` reports what is on screen, and anything that wants to write back
 * to o.w/o.h comes out of the rotation first (`unrotSize`). Only textures carry
 * an angle -- everything else in the map format is an axis-aligned rect, and
 * rotate90 turns those by swapping w and h instead.
 */
const artAngle = (o) => (o && o.kind === 'art' && o.rot ? o.rot * Math.PI / 180 : 0);

/** The axis-aligned box a w-by-h rect at (x,y) covers once turned by `ang`. */
function rotAABB(x, y, w, h, ang) {
  const c = Math.abs(Math.cos(ang)), s = Math.abs(Math.sin(ang));
  const aw = w * c + h * s, ah = w * s + h * c;
  return { x: x + (w - aw) / 2, y: y + (h - ah) / 2, w: aw, h: ah };
}

/*
 * The inverse: what w-by-h rect, turned by `ang`, covers an aw-by-ah box.
 *
 * aw = w|cos| + h|sin| and ah = w|sin| + h|cos| is a 2x2 system, invertible
 * whenever cos^2 != sin^2 -- exactly at the diagonals, where the two equations
 * say the same thing and any rect with the right w+h fits. There the old
 * proportions are kept, since nothing in the drag says which way to split it.
 */
function unrotSize(aw, ah, ang, w0, h0) {
  const c = Math.abs(Math.cos(ang)), s = Math.abs(Math.sin(ang));
  const d = c * c - s * s;
  if (Math.abs(d) < 1e-6) {
    const sum = aw / (c + s), old = (w0 || 1) + (h0 || 1);
    return { w: sum * (w0 || 1) / old, h: sum * (h0 || 1) / old };
  }
  return { w: (aw * c - ah * s) / d, h: (ah * c - aw * s) / d };
}

function bounds(o) {
  const k = K(o);
  if (!k) return { x:o.x, y:o.y, w:o.w || 0, h:o.h || 0 };
  if (k.shape === 'beam') return laserRect(o);
  if (k.shape === 'point') { const s = k.size || 32; return { x:o.x - s/2, y:o.y - s/2, w:s, h:s }; }
  const ang = artAngle(o);
  if (ang) return rotAABB(o.x, o.y, o.w, o.h, ang);
  return { x:o.x, y:o.y, w:o.w, h:o.h };
}
function hit(o, wx, wy) {
  const b = bounds(o);
  return wx >= b.x && wx <= b.x + b.w && wy >= b.y && wy <= b.y + b.h;
}
const isReady = (im) => !!im && (im.tagName === 'CANVAS' ? im.width > 0 : im.complete && im.naturalWidth > 0);
const imgW = (im) => (im.naturalWidth || im.width || 0);
const imgH = (im) => (im.naturalHeight || im.height || 0);

/*
 * Camera clamps.
 *
 * An area carries four clamp values, and ZERO MEANS NO CLAMP -- the game
 * truthiness-tests them, so a clamp genuinely at zero is not expressible and
 * never was. That is impossible to see in four number fields, and a wrong clamp
 * only shows up as a camera that will not follow, several minutes into playing.
 *
 * So the clamp is drawn as a box alongside the area it belongs to: solid on the
 * sides that are clamped, ghosted along the area's own edge on the sides that
 * are not. Dragging a ghosted side turns that clamp on; dragging one back onto
 * the area edge snaps it off again, which is the only gesture that can express
 * "no clamp" without typing a zero.
 */
function clampBox(o) {
  const b = bounds(o);
  return {
    x0: o.xmin || b.x, x1: o.xmax || (b.x + b.w),
    y0: o.ymin || b.y, y1: o.ymax || (b.y + b.h),
    aL: !!o.xmin, aR: !!o.xmax, aT: !!o.ymin, aB: !!o.ymax,
  };
}
function shiftClamp(o, dx, dy) {
  if (o.xmin) o.xmin += dx;
  if (o.xmax) o.xmax += dx;
  if (o.ymin) o.ymin += dy;
  if (o.ymax) o.ymax += dy;
}
// clamps live in a kind that also uses xmin/xmax for patrol ranges, so both
// tests are on the kind rather than on the presence of the fields
const hasClamp = (o) => o && o.kind === 'area';
const hasZone = (o) => o && o.kind === 'door' && o.trigger === 'zone';

// ---------------------------------------------------------------- rendering
const HANDLE = 8;
const HSPOTS = [['nw',0,0],['n',.5,0],['ne',1,0],['w',0,.5],['e',1,.5],['sw',0,1],['s',.5,1],['se',1,1]];
function handlePts(o) {
  const b = bounds(o);
  return HSPOTS.map(([id,fx,fy]) => ({ id, x:b.x + b.w*fx, y:b.y + b.h*fy }));
}
/*
 * A door's trigger zone is a second rectangle attached to the object, so it
 * gets its own handles: eight to resize and one in the middle to move the whole
 * box. Typing four numbers to position a trigger is the kind of thing that gets
 * left wrong, and a wrong trigger box is invisible until you play the level.
 *
 * Ids are prefixed 'z' so the drag code can tell them from the object's own
 * resize handles. Clamp handles use 'q' and beam ends use 'b' for the same
 * reason.
 */
function zoneRect(o) {
  return { x: o.zx || 0, y: o.zy || 0, w: o.zw || 0, h: o.zh || 0 };
}
function zonePts(o) {
  if (!hasZone(o)) return [];
  const z = zoneRect(o);
  if (z.w <= 0 || z.h <= 0) return [];
  const pts = HSPOTS.map(([id, fx, fy]) => ({ id: 'z' + id, x: z.x + z.w * fx, y: z.y + z.h * fy }));
  pts.push({ id: 'zmove', x: z.x + z.w / 2, y: z.y + z.h / 2 });
  return pts;
}
/*
 * Clamp handles sit INSIDE the box on any side that has no clamp set.
 *
 * With all four clamps off the clamp box is exactly the area's own rect, so its
 * handles would land on top of the area's resize handles and one of the two
 * would be unreachable -- and since an unclamped area is the starting state,
 * that is the case that has to work. Pulling the unset ones in by a few screen
 * pixels separates them and reads correctly too: a handle floating inside the
 * area is one that has not been placed yet.
 */
const CLAMP_INSET = 13;
function clampPts(o) {
  if (!hasClamp(o)) return [];
  const c = clampBox(o);
  const w = c.x1 - c.x0, h = c.y1 - c.y0;
  const d = CLAMP_INSET / view.z;
  const pts = HSPOTS.map(([id, fx, fy]) => {
    let x = c.x0 + w * fx, y = c.y0 + h * fy;
    if (id.includes('w') && !c.aL) x += d;
    if (id.includes('e') && !c.aR) x -= d;
    if (id.includes('n') && !c.aT) y += d;
    if (id.includes('s') && !c.aB) y -= d;
    return { id: 'q' + id, x, y };
  });
  pts.push({ id: 'qmove', x: c.x0 + w / 2, y: c.y0 + h / 2 });
  return pts;
}
// the two ends of a laser beam
function beamPts(o) {
  if (!K(o) || K(o).shape !== 'beam') return [];
  const r = laserRect(o);
  return o.horizontal
    ? [{ id:'b0', x:r.x, y:o.y }, { id:'b1', x:r.x + r.w, y:o.y }]
    : [{ id:'b0', x:o.x, y:r.y }, { id:'b1', x:o.x, y:r.y + r.h }];
}
function pathPts(o) {
  if (!K(o) || !K(o).path) return [];
  return [{ id:'p0', x:o.xmin ?? o.x, y:o.ymin ?? o.y },
          { id:'p1', x:o.xmax ?? o.x, y:o.ymax ?? o.y }];
}

// Resize or move the trigger zone. Mirrors resize() but writes zx/zy/zw/zh.
function resizeZone(o, id, mx, my) {
  const z = zoneRect(o);
  if (id === 'zmove') {
    o.zx = snap(mx - z.w / 2);
    o.zy = snap(my - z.h / 2);
    refreshProps();
    return;
  }
  const side = id.slice(1);
  const right = z.x + z.w, bottom = z.y + z.h;
  let x = z.x, y = z.y, w = z.w, h = z.h;
  if (side.includes('w')) { x = Math.min(snap(mx), right - 8); w = right - x; }
  if (side.includes('e')) { w = Math.max(8, snap(mx) - x); }
  if (side.includes('n')) { y = Math.min(snap(my), bottom - 8); h = bottom - y; }
  if (side.includes('s')) { h = Math.max(8, snap(my) - y); }
  o.zx = x; o.zy = y; o.zw = w; o.zh = h;
  refreshProps();
}

/*
 * Drag a camera clamp.
 *
 * Writing 0 is how a clamp is switched off, so a side dragged back onto the
 * area's own edge (within a few pixels) is read as "no clamp on this side"
 * rather than as a clamp that happens to sit there. Everything else writes the
 * dragged coordinate straight in.
 */
const CLAMP_OFF_SNAP = 6;
function resizeClamp(o, id, mx, my) {
  const b = bounds(o);
  const c = clampBox(o);
  if (id === 'qmove') {
    shiftClamp(o, snap(mx - (c.x0 + c.x1) / 2), snap(my - (c.y0 + c.y1) / 2));
    refreshProps();
    return;
  }
  const side = id.slice(1);
  const put = (field, value, edge) => {
    o[field] = Math.abs(value - edge) <= CLAMP_OFF_SNAP / view.z ? 0 : value;
  };
  if (side.includes('w')) put('xmin', Math.min(snap(mx), c.x1 - 8), b.x);
  if (side.includes('e')) put('xmax', Math.max(snap(mx), c.x0 + 8), b.x + b.w);
  if (side.includes('n')) put('ymin', Math.min(snap(my), c.y1 - 8), b.y);
  if (side.includes('s')) put('ymax', Math.max(snap(my), c.y0 + 8), b.y + b.h);
  refreshProps();
}

/*
 * Drag one end of a laser beam.
 *
 * Length and orientation at once: the emitter stays where it is, the dragged end
 * sets the half-length, and whichever axis the pointer is further along decides
 * whether the beam stands up or lies flat. Same gesture as a patrol handle, and
 * for the same reason -- two numbers in a panel do not tell you what the hazard
 * actually covers.
 */
function dragBeam(o, mx, my) {
  const dx = mx - o.x, dy = my - o.y;
  o.horizontal = Math.abs(dx) >= Math.abs(dy) ? 1 : 0;
  const half = Math.abs(o.horizontal ? dx : dy);
  o.length = Math.max(grid || 8, snap(half * 2));
  refreshProps();
}

// ---------------------------------------------------------------- group edits
/*
 * Several objects at once.
 *
 * Handles on the union box, and every edit is computed from a snapshot taken at
 * mousedown rather than applied incrementally -- rotating by dragging means
 * crossing the same quarter-turn back and forth, and anything that accumulates
 * drifts. Recomputing from the snapshot every frame is exact and undoes itself
 * for free.
 */
function groupBox(list) {
  let x0=1e9, y0=1e9, x1=-1e9, y1=-1e9;
  for (const o of list) {
    const b = bounds(o);
    x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h);
  }
  if (x0 > x1) return null;
  return { x:x0, y:y0, w:Math.max(1, x1-x0), h:Math.max(1, y1-y0) };
}
const GROUP_ROT_OFFSET = 26;   // screen px above the box
function groupPts(list) {
  const b = groupBox(list);
  if (!b) return [];
  const pts = HSPOTS.map(([id,fx,fy]) => ({ id:'g'+id, x:b.x + b.w*fx, y:b.y + b.h*fy }));
  pts.push({ id:'grot', x:b.x + b.w/2, y:b.y - GROUP_ROT_OFFSET / view.z });
  return pts;
}
const cloneObjs = (list) => list.map((o) => ({ o, src: JSON.parse(JSON.stringify(o)) }));
function restoreObjs(pairs) {
  for (const { o, src } of pairs) {
    for (const k of Object.keys(o)) if (k !== 'id' && k !== 'kind') delete o[k];
    Object.assign(o, src);
  }
}

/*
 * Scale a group about a fixed corner. Points move, rects move and stretch, and
 * the attached boxes -- patrol range, door zone, camera clamp -- come along,
 * because a patrol range left behind by a resize is a silently broken level.
 */
function scaleObj(o, sx, sy, ox, oy) {
  const px = (x) => ox + (x - ox) * sx;
  const py = (y) => oy + (y - oy) * sy;
  const k = K(o);
  if (k && k.shape === 'rect') {
    const x1 = px(o.x + o.w), y1 = py(o.y + o.h);
    o.x = px(o.x); o.y = py(o.y);
    o.w = Math.max(1, x1 - o.x); o.h = Math.max(1, y1 - o.y);
  } else {
    if (k && k.shape === 'beam') {
      o.length = Math.max(8, Math.round((Number(o.length) || LASER_LEN_V) * (o.horizontal ? sx : sy)));
    }
    o.x = px(o.x); o.y = py(o.y);
  }
  if (k && k.path && o.xmin !== undefined) {
    const nx = [px(o.xmin), px(o.xmax)], ny = [py(o.ymin), py(o.ymax)];
    o.xmin = Math.min(nx[0], nx[1]); o.xmax = Math.max(nx[0], nx[1]);
    o.ymin = Math.min(ny[0], ny[1]); o.ymax = Math.max(ny[0], ny[1]);
  }
  if (o.kind === 'door') {
    const zx1 = px((o.zx || 0) + (o.zw || 0)), zy1 = py((o.zy || 0) + (o.zh || 0));
    o.zx = px(o.zx || 0); o.zy = py(o.zy || 0);
    o.zw = Math.max(1, zx1 - o.zx); o.zh = Math.max(1, zy1 - o.zy);
    if (typeof o.closeTo === 'number') o.closeTo = py(o.closeTo);
  }
  if (o.kind === 'plat' && o.stomper) {
    if (typeof o.fallTo === 'number') o.fallTo = py(o.fallTo);
    if (typeof o.trigX === 'number') o.trigX = px(o.trigX);
    if (typeof o.trigW === 'number') o.trigW = Math.max(1, o.trigW * sx);
  }
  if (hasClamp(o)) {
    if (o.xmin) o.xmin = px(o.xmin);
    if (o.xmax) o.xmax = px(o.xmax);
    if (o.ymin) o.ymin = py(o.ymin);
    if (o.ymax) o.ymax = py(o.ymax);
  }
}

/*
 * Quarter-turn clockwise about a point. 90 degrees at a time because the map
 * format cannot express anything else: plats, spikes, areas and boss zones are
 * axis-aligned rects in the game's own data, so a free angle would have to be
 * thrown away on save. Textures DO carry an angle, so they keep their frame and
 * take the rotation on `rot` instead, which is exactly what mapkit's renderer
 * does with it.
 */
function rotate90(o, cx, cy) {
  const rp = (x, y) => ({ x: cx + cy - y, y: cy + x - cx });
  const k = K(o);
  if (o.kind === 'art') {
    const c = rp(o.x + o.w/2, o.y + o.h/2);
    o.x = c.x - o.w/2; o.y = c.y - o.h/2;
    o.rot = (((o.rot || 0) + 90) % 360 + 360) % 360;
  } else if (k && k.shape === 'rect') {
    const a = rp(o.x, o.y), b = rp(o.x + o.w, o.y + o.h);
    o.x = Math.min(a.x, b.x); o.y = Math.min(a.y, b.y);
    o.w = Math.abs(b.x - a.x); o.h = Math.abs(b.y - a.y);
  } else {
    const c = rp(o.x, o.y);
    o.x = c.x; o.y = c.y;
    if (k && k.shape === 'beam') o.horizontal = o.horizontal ? 0 : 1;
  }
  if (k && k.path && o.xmin !== undefined) {
    const a = rp(o.xmin, o.ymin), b = rp(o.xmax, o.ymax);
    o.xmin = Math.min(a.x, b.x); o.xmax = Math.max(a.x, b.x);
    o.ymin = Math.min(a.y, b.y); o.ymax = Math.max(a.y, b.y);
  }
  if (o.kind === 'door') {
    const a = rp(o.zx || 0, o.zy || 0), b = rp((o.zx || 0) + (o.zw || 0), (o.zy || 0) + (o.zh || 0));
    o.zx = Math.min(a.x, b.x); o.zy = Math.min(a.y, b.y);
    o.zw = Math.abs(b.x - a.x); o.zh = Math.abs(b.y - a.y);
  }
  if (hasClamp(o)) {
    /*
     * Under a quarter turn the horizontal clamp comes from the vertical one and
     * vice versa, so which SIDES are clamped rotates with the box. Carrying the
     * on/off flags across is the whole point -- rotating a half-clamped area and
     * getting four clamps back would invent a camera bound that was never asked
     * for.
     */
    const c = clampBox(o);
    const nx0 = cx + cy - c.y1, nx1 = cx + cy - c.y0;
    const ny0 = cy + c.x0 - cx, ny1 = cy + c.x1 - cx;
    o.xmin = c.aB ? nx0 : 0;
    o.xmax = c.aT ? nx1 : 0;
    o.ymin = c.aL ? ny0 : 0;
    o.ymax = c.aR ? ny1 : 0;
  }
}

/*
 * Rotate a whole selection, keeping it on the grid.
 *
 * Rotating about the union centre can land the group between grid lines even
 * when every object started on one, so the group is nudged back afterwards --
 * as a group, by one shared offset, so nothing inside it shifts relative to
 * anything else.
 */
function rotateSelection(list, quarters) {
  const b = groupBox(list);
  if (!b) return;
  const cx = b.x + b.w/2, cy = b.y + b.h/2;
  const turns = ((quarters % 4) + 4) % 4;
  if (!turns) return;
  for (let i = 0; i < turns; i++) for (const o of list) rotate90(o, cx, cy);
  /*
   * Put the group back on the centre it turned about, exactly.
   *
   * This used to SNAP the rotated box to the grid instead, on the reasoning that
   * a quarter turn can land a group between grid lines even when every object
   * started on one. True, and it drifts: a turn of an oblong leaves the box on a
   * half-grid, the snap pulls it the same way every time, and nothing ever pulls
   * it back -- so a group rotated four times did not come back where it started,
   * and one rotated all afternoon walked across the map.
   *
   * Four quarter turns MUST be the identity. That is worth more than landing on
   * the grid: an off-grid group is one drag to fix and accumulated drift is not
   * fixable at all, because by the time it is visible there is no record of where
   * the thing began.
   */
  const nb = groupBox(list);
  const dx = cx - (nb.x + nb.w/2), dy = cy - (nb.y + nb.h/2);
  if (dx || dy) moveObjects(list, dx, dy);
}

// one shared translation, applied to positions and to every attached box
function moveObjects(list, dx, dy) {
  for (const o of list) {
    o.x += dx; o.y += dy;
    const k = K(o);
    if (k && k.path && o.xmin !== undefined) {
      o.xmin += dx; o.xmax += dx; o.ymin += dy; o.ymax += dy;
    }
    if (o.kind === 'door') {
      o.zx = (o.zx || 0) + dx; o.zy = (o.zy || 0) + dy;
      if (typeof o.closeTo === 'number') o.closeTo += dy;
    }
    if (o.kind === 'plat' && o.stomper) {
      if (typeof o.fallTo === 'number') o.fallTo += dy;
      if (typeof o.trigX === 'number') o.trigX += dx;
    }
    if (hasClamp(o)) shiftClamp(o, dx, dy);
  }
}

// ---------------------------------------------------------------- draw
/*
 * Draw order.
 *
 * Textures sit on top of everything else by default. Every other kind is drawn
 * as an outline or a marker -- editor scaffolding rather than anything the player
 * sees -- so letting those paint over the art hides the one layer that shows what
 * the map will actually look like. Selection highlights are still drawn last, so
 * whatever is selected stays visible through the art.
 *
 * The toggle drops textures back among the geometry, for when the scaffolding
 * underneath is what needs looking at.
 */
function drawRank(o) {
  if (o.kind === 'art') return artOnTop ? 1000 : 2;
  return K(o) ? K(o).order : 99;
}

/*
 * Draw order, and therefore pick order.
 *
 * z comes first so anything can be pushed behind anything else regardless of
 * kind; kind rank only breaks ties, which keeps the defaults (platforms behind,
 * textures in front) intact while every object still has z = 0.
 *
 * On non-texture objects z is purely an editing aid -- it is how you shove a big
 * platform out of the way to reach a coin underneath -- so it is NOT saved. Only
 * a texture's z means anything at runtime, and that one does persist.
 */
function drawOrder() {
  return map.objects.slice().sort((a, b) => {
    const dz = (a.z || 0) - (b.z || 0);
    if (dz !== 0) return dz;
    return drawRank(a) - drawRank(b);
  });
}

let ctx = null;
function draw() {
  rafId = requestAnimationFrame(draw);
  if (!active) return;
  const stage = stageEl(), cv = $('cv');
  const W = stage.clientWidth, H = stage.clientHeight;
  if (!W || !H) return;
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  ctx.setTransform(1,0,0,1,0,0);
  ctx.fillStyle = '#0d0f14'; ctx.fillRect(0,0,W,H);

  ctx.setTransform(view.z,0,0,view.z,view.x,view.y);
  drawGrid();

  const ordered = drawOrder();
  for (const o of ordered) drawObject(o);
  const s = selected();
  for (const o of s) drawSelection(o);
  if (s.length > 1) drawGroup(s);
  if (dragging && dragging.marquee) drawMarquee(dragging);
  drawModuleGhost();
  drawModuleMarkers();
}

function drawGrid() {
  const stage = stageEl();
  if (!grid || view.z < 0.15) return;
  const W = stage.clientWidth / view.z, H = stage.clientHeight / view.z;
  const x0 = Math.floor(-view.x / view.z / grid) * grid, y0 = Math.floor(-view.y / view.z / grid) * grid;
  ctx.lineWidth = 1 / view.z;
  ctx.strokeStyle = 'rgba(120,140,190,0.10)';
  ctx.beginPath();
  for (let x = x0; x < x0 + W + grid; x += grid) { ctx.moveTo(x, y0); ctx.lineTo(x, y0 + H + grid); }
  for (let y = y0; y < y0 + H + grid; y += grid) { ctx.moveTo(x0, y); ctx.lineTo(x0 + W + grid, y); }
  ctx.stroke();
  // world origin
  ctx.strokeStyle = 'rgba(255,90,90,0.5)';
  ctx.beginPath(); ctx.moveTo(0, y0); ctx.lineTo(0, y0+H+grid);
  ctx.moveTo(x0, 0); ctx.lineTo(x0+W+grid, 0); ctx.stroke();
}

function drawObject(o) {
  const k = K(o); if (!k) return;
  const b = bounds(o);
  if (o.kind === 'art') return drawArt(o);
  if (k.shape === 'beam') return drawBeam(o, k);

  ctx.lineWidth = 1.5 / view.z;
  if (k.shape === 'rect') {
    if (k.fill) { ctx.fillStyle = k.fill; ctx.fillRect(b.x, b.y, b.w, b.h); }
    ctx.strokeStyle = k.color;
    ctx.strokeRect(b.x, b.y, b.w, b.h);
    if (o.kind === 'plat' && o.semi) {
      // One-way platform. The cyan edge marks the only surface that collides;
      // the chevrons point the way Johnny can pass through it.
      ctx.strokeStyle = '#7ae0ff';
      ctx.lineWidth = 3 / view.z;
      ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(b.x+b.w, b.y); ctx.stroke();
      ctx.lineWidth = 1.5 / view.z;
      const step = Math.max(30, b.w / 8), a = 7 / view.z;
      ctx.beginPath();
      for (let cx = b.x + step/2; cx < b.x + b.w; cx += step) {
        ctx.moveTo(cx - a, b.y + a*1.6); ctx.lineTo(cx, b.y + a*0.4); ctx.lineTo(cx + a, b.y + a*1.6);
      }
      ctx.stroke();
    }
  } else {
    ctx.strokeStyle = k.color;
    ctx.fillStyle = k.color + '33';
    ctx.beginPath(); ctx.arc(o.x, o.y, (k.size||32)/2, 0, Math.PI*2);
    ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(o.x-4/view.z, o.y); ctx.lineTo(o.x+4/view.z, o.y);
    ctx.moveTo(o.x, o.y-4/view.z); ctx.lineTo(o.x, o.y+4/view.z); ctx.stroke();
  }
  if (k.path) drawPath(o, k);
  if (o.kind === 'plat' && o.stomper) drawCrusher(o);
  if (o.kind === 'door') drawDoor(o);
  if (o.kind === 'area') drawClamp(o);
}

/*
 * A laser, drawn at the size it actually hurts at: the beam rect is the game's
 * own collision box, 40 across by `length` along. The emitter is marked at the
 * centre because that is the point the map stores and the point both ends move
 * around.
 */
function drawBeam(o, k) {
  const r = laserRect(o);
  ctx.fillStyle = k.color + '22';
  ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.strokeStyle = k.color;
  ctx.lineWidth = 1.5 / view.z;
  ctx.strokeRect(r.x, r.y, r.w, r.h);
  // centre line, so a long beam still reads as a beam when zoomed out
  ctx.beginPath();
  if (o.horizontal) { ctx.moveTo(r.x, o.y); ctx.lineTo(r.x + r.w, o.y); }
  else { ctx.moveTo(o.x, r.y); ctx.lineTo(o.x, r.y + r.h); }
  ctx.stroke();
  ctx.fillStyle = k.color;
  ctx.beginPath(); ctx.arc(o.x, o.y, Math.max(4, (k.size||28)/4) / 1, 0, Math.PI*2); ctx.fill();
}

/*
 * The camera clamp box. Solid where a clamp is set, ghosted where it is not --
 * a ghosted side sits on the area's own edge and means the camera is free that
 * way, which is what a 0 in the map data means.
 */
function drawClamp(o) {
  const c = clampBox(o);
  const w = c.x1 - c.x0, h = c.y1 - c.y0;
  ctx.lineWidth = 1.5 / view.z;
  ctx.fillStyle = 'rgba(150,120,255,0.05)';
  ctx.fillRect(c.x0, c.y0, w, h);
  const side = (x1, y1, x2, y2, on) => {
    ctx.strokeStyle = on ? '#a68cff' : 'rgba(166,140,255,0.30)';
    ctx.setLineDash(on ? [] : [5 / view.z, 5 / view.z]);
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    ctx.setLineDash([]);
  };
  side(c.x0, c.y0, c.x0, c.y1, c.aL);
  side(c.x1, c.y0, c.x1, c.y1, c.aR);
  side(c.x0, c.y0, c.x1, c.y0, c.aT);
  side(c.x0, c.y1, c.x1, c.y1, c.aB);
}

/*
 * A crusher hides three hardcoded numbers that decide whether it works at all,
 * so they are drawn rather than left to be discovered by playing:
 *
 *   it stops at world y = -60, so its fall distance is fixed by its own y
 *   it triggers on Johnny crossing x+200..x+280, whatever its width
 *   it also needs Johnny above y = 360
 *
 * The band not scaling with width is the trap: make one narrower than 200px and
 * the trigger sits past its right edge, so it can never fire.
 */
const CRUSHER_STOP_Y = -60;
function drawCrusher(o) {
  // mirrors the runtime defaults in mapkit/crushers.js
  const landY = (typeof o.fallTo === 'number') ? o.fallTo : CRUSHER_STOP_Y;
  ctx.lineWidth = 1.5 / view.z;

  ctx.strokeStyle = '#ff5c5c';
  ctx.setLineDash([6 / view.z, 4 / view.z]);
  ctx.strokeRect(o.x, landY, o.w, o.h);
  ctx.setLineDash([]);

  ctx.fillStyle = 'rgba(255,92,92,0.08)';
  ctx.fillRect(o.x, o.y, o.w, landY - o.y);

  const bx = (typeof o.trigX === 'number') ? o.trigX : o.x + 200;
  const bw = (typeof o.trigW === 'number') ? o.trigW : 80;
  // with configurable bands the old 'unreachable' warning only applies to the
  // default, so warn on overlap with the platform instead
  const reachable = bx + bw > o.x && bx < o.x + o.w;
  ctx.fillStyle = reachable ? 'rgba(255,210,92,0.22)' : 'rgba(255,92,92,0.30)';
  ctx.fillRect(bx, o.y, bw, Math.max(o.h, 40));
  ctx.strokeStyle = reachable ? '#ffd25c' : '#ff5c5c';
  ctx.strokeRect(bx, o.y, bw, Math.max(o.h, 40));
}

/*
 * A door hides where it ends up and what sets it off, so both are drawn.
 */
function drawDoor(o) {
  const to = (typeof o.closeTo === 'number') ? o.closeTo : o.y + o.h;
  ctx.lineWidth = 1.5 / view.z;
  ctx.strokeStyle = '#b6ff5c';
  ctx.setLineDash([6 / view.z, 4 / view.z]);
  ctx.strokeRect(o.x, to, o.w, o.h);
  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(182,255,92,0.08)';
  ctx.fillRect(o.x, Math.min(o.y, to), o.w, Math.abs(to - o.y) + o.h);
  if (o.trigger === 'zone' && o.zw > 0 && o.zh > 0) {
    ctx.fillStyle = 'rgba(182,255,92,0.13)';
    ctx.fillRect(o.zx, o.zy, o.zw, o.zh);
    ctx.strokeStyle = '#b6ff5c';
    ctx.setLineDash([4 / view.z, 3 / view.z]);
    ctx.strokeRect(o.zx, o.zy, o.zw, o.zh);
    ctx.setLineDash([]);
  }
}

/*
 * Patrol tracks. A moving platform or enemy is stored as a position plus min/max
 * bounds, which is invisible unless drawn -- and getting them wrong is the
 * easiest way to make a map that looks right and plays wrong.
 */
function drawPath(o, k) {
  const x1 = o.xmin ?? o.x, x2 = o.xmax ?? o.x;
  const y1 = o.ymin ?? o.y, y2 = o.ymax ?? o.y;
  if (x1 === x2 && y1 === y2) return;
  ctx.strokeStyle = k.color + '99';
  ctx.lineWidth = 2 / view.z;
  ctx.setLineDash([6/view.z, 5/view.z]);
  ctx.beginPath(); ctx.moveTo(x1, (y1+y2)/2); ctx.lineTo(x2, (y1+y2)/2);
  if (y1 !== y2) { ctx.moveTo((x1+x2)/2, y1); ctx.lineTo((x1+x2)/2, y2); }
  ctx.stroke(); ctx.setLineDash([]);
  const dot = (x,y) => { ctx.beginPath(); ctx.arc(x,y,5/view.z,0,Math.PI*2); ctx.fill(); };
  ctx.fillStyle = k.color;
  dot(x1,(y1+y2)/2); dot(x2,(y1+y2)/2);
}

function drawArt(o) {
  const img = tileImgs.get(o.tile);
  ctx.save();
  ctx.translate(o.x + o.w/2, o.y + o.h/2);
  if (o.rot) ctx.rotate(o.rot * Math.PI / 180);
  ctx.scale(o.flipX ? -1 : 1, o.flipY ? -1 : 1);
  if (isReady(img)) ctx.drawImage(img, -o.w/2, -o.h/2, o.w, o.h);
  else { ctx.fillStyle = '#c9a6ff33'; ctx.fillRect(-o.w/2, -o.h/2, o.w, o.h); }
  ctx.restore();
}

function drawMarquee(m) {
  const x = Math.min(m.x0, m.x1), y = Math.min(m.y0, m.y1);
  const w = Math.abs(m.x1 - m.x0), h = Math.abs(m.y1 - m.y0);
  ctx.fillStyle = 'rgba(110,168,254,0.12)';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = '#6ea8fe';
  ctx.lineWidth = 1 / view.z;
  ctx.setLineDash([4 / view.z, 3 / view.z]);
  ctx.strokeRect(x, y, w, h);
  ctx.setLineDash([]);
}

const sq = (p, size, fill, stroke) => {
  const r = size / view.z;
  ctx.fillStyle = fill; ctx.strokeStyle = stroke;
  ctx.lineWidth = 1.5 / view.z;
  ctx.beginPath(); ctx.rect(p.x - r/2, p.y - r/2, r, r); ctx.fill(); ctx.stroke();
};
const circ = (p, size, fill, stroke) => {
  const r = size / view.z;
  ctx.fillStyle = fill; ctx.strokeStyle = stroke;
  ctx.lineWidth = 2 / view.z;
  ctx.beginPath(); ctx.arc(p.x, p.y, r/2, 0, Math.PI*2); ctx.fill(); ctx.stroke();
};

function drawSelection(o) {
  const b = bounds(o);
  ctx.lineWidth = 1.5 / view.z;
  ctx.strokeStyle = '#6ea8fe';
  ctx.setLineDash([5/view.z, 4/view.z]);
  ctx.strokeRect(b.x, b.y, b.w, b.h);
  ctx.setLineDash([]);
  const one = sel.length === 1;
  // trigger-zone handles, draggable
  if (one) for (const p of zonePts(o)) {
    if (p.id === 'zmove') circ(p, HANDLE + 4, '#b6ff5c', '#b6ff5c');
    else sq(p, HANDLE, '#0d0f14', '#b6ff5c');
  }
  // camera clamp handles
  if (one) for (const p of clampPts(o)) {
    if (p.id === 'qmove') circ(p, HANDLE + 4, '#a68cff', '#a68cff');
    else sq(p, HANDLE, '#0d0f14', '#a68cff');
  }
  // laser beam ends
  if (one) for (const p of beamPts(o)) circ(p, HANDLE + 2, K(o).color, '#0d0f14');
  // patrol endpoints
  if (one) for (const p of pathPts(o)) circ(p, HANDLE + 2, K(o).color, '#0d0f14');
  if (!one || K(o).shape !== 'rect') return;
  for (const p of handlePts(o)) sq(p, HANDLE, '#0d0f14', '#6ea8fe');
}

/*
 * The group box. One frame around everything selected, with the same eight
 * resize handles a single object gets plus a rotate handle above it, so a run of
 * platforms and their coins can be scaled or turned as the one thing they are.
 */
function drawGroup(list) {
  const b = groupBox(list);
  if (!b) return;
  ctx.strokeStyle = '#ffd25c';
  ctx.lineWidth = 1.5 / view.z;
  /*
   * Solid for a real group, dashed for an ad-hoc multi-select. They behave
   * differently on the very next click -- one comes back whole, the other does
   * not -- so they must not look the same.
   */
  const g = groupOf(list[0]);
  const whole = g && list.every((o) => groupOf(o) === g) &&
                map.objects.filter((o) => groupOf(o) === g).length === list.length;
  if (!whole) ctx.setLineDash([9/view.z, 5/view.z]);
  ctx.strokeRect(b.x, b.y, b.w, b.h);
  ctx.setLineDash([]);
  const pts = groupPts(list);
  const rot = pts[pts.length - 1];
  ctx.strokeStyle = '#ffd25c';
  ctx.beginPath(); ctx.moveTo(b.x + b.w/2, b.y); ctx.lineTo(rot.x, rot.y); ctx.stroke();
  for (const p of pts) {
    if (p.id === 'grot') circ(p, HANDLE + 5, '#ffd25c', '#0d0f14');
    else sq(p, HANDLE + 1, '#0d0f14', '#ffd25c');
  }
}

// ---------------------------------------------------------------- interaction
const topmostAt = (wx, wy) => drawOrder().reverse().find((o) => hit(o, wx, wy));

/*
 * Which handle, if any, is under the pointer.
 *
 * Order is priority. Attached boxes -- patrol range, beam ends, trigger zone,
 * camera clamp -- come before the object's own resize handles, because they sit
 * outside or on top of its box and would otherwise be unreachable wherever the
 * two overlap. With several objects selected only the group's handles exist:
 * per-object handles in a crowd are unhittable anyway.
 */
function handleAt(sx, sy) {
  const s = selected();
  const near = (p) => Math.abs(sx - (p.x*view.z + view.x)) <= HANDLE/2+3 &&
                      Math.abs(sy - (p.y*view.z + view.y)) <= HANDLE/2+3;
  if (s.length > 1) {
    for (const p of groupPts(s)) if (near(p)) return p.id;
    return null;
  }
  if (s.length !== 1) return null;
  for (const p of pathPts(s[0])) if (near(p)) return p.id;
  for (const p of beamPts(s[0])) if (near(p)) return p.id;
  for (const p of zonePts(s[0])) if (near(p)) return p.id;
  for (const p of clampPts(s[0])) if (near(p)) return p.id;
  if (K(s[0]).shape !== 'rect') return null;
  for (const p of handlePts(s[0])) if (near(p)) return p.id;
  return null;
}

/*
 * Moving a selection snaps it AS A GROUP.
 *
 * Snapping each object to the grid separately pulls a carefully spaced run of
 * platforms apart the moment it is dragged -- everything lands on the nearest
 * line and the offsets between them are gone. So one offset is computed from the
 * object actually grabbed, snapped once, and applied to everything. With a
 * single object selected that is exactly what it always did.
 */
function beginMove(w, grabbed) {
  armHistory();
  const list = selected();
  const anchor = grabbed && list.indexOf(grabbed) >= 0 ? grabbed : list[0];
  dragging = { move:true, wx:w.x, wy:w.y, pairs:cloneObjs(list),
               ax: anchor ? anchor.x : 0, ay: anchor ? anchor.y : 0 };
}
/*
 * Selection groups.
 *
 * "These forty things are one thing while I am moving them around." Deliberately
 * NOT a module: a module is a graded, reusable piece of level with an entry, an
 * exit and a rung, and treating every scenery cluster as one would fill the
 * library with ungraded rubble. A group is a fact about this map and this
 * afternoon.
 *
 * Stored as `o.group`, an integer, on the objects themselves. That makes it
 * survive undo (a snapshot is the objects), the session store (which persists
 * map.objects verbatim), and a copy-paste -- which is why a paste REMAPS the ids
 * it finds, so the copy is its own group rather than joining the original. It
 * does NOT survive a save through the game map format, which has nowhere to put
 * it; that is the honest cost of not inventing a sidecar file, and it is
 * stripped from module records for the same reason `z` is.
 */
/*
 * Group ids are derived from the map, not counted in a variable.
 *
 * A counter would have to be restored on every path that replaces map.objects --
 * open, undo, session restore, module edit -- and the one that got missed would
 * hand out an id already in use, silently welding two unrelated clusters into one
 * group. Reading the max off the objects is O(n) at the only moment it is needed
 * and cannot be wrong.
 */
const newGroupId = () => map.objects.reduce((m, o) => Math.max(m, o.group || 0), 0) + 1;
const groupOf = (o) => (o && o.group) || 0;
/** Every id in this object's group, or just its own if it is in none. */
function groupIds(o) {
  const g = groupOf(o);
  if (!g) return [o.id];
  return map.objects.filter((q) => groupOf(q) === g).map((q) => q.id);
}
/** Expand a list of ids to whole groups. */
function withGroups(ids) {
  const gs = new Set();
  for (const id of ids) { const g = groupOf(byId(id)); if (g) gs.add(g); }
  if (!gs.size) return ids.slice();
  const out = new Set(ids);
  for (const q of map.objects) if (gs.has(groupOf(q))) out.add(q.id);
  return [...out];
}
function groupSelection() {
  const list = selected();
  if (list.length < 2) return;
  pushHistory();
  // one flat group, absorbing any the selection already touched: nested groups
  // would need a way to select "the inner one", and there is no gesture for that
  const g = newGroupId();
  for (const o of list) o.group = g;
  sel = list.map((o) => o.id);
  refresh();
}
function ungroupSelection() {
  const list = selected().filter((o) => o.group);
  if (!list.length) return;
  pushHistory();
  for (const o of list) delete o.group;
  refresh();
}

function pick(o, additive) {
  const g = groupIds(o);
  if (additive) {
    // the whole group goes in or comes out together, since that is what being a
    // group means -- a half-selected group is the state it exists to prevent
    sel = sel.includes(o.id)
      ? sel.filter((i) => !g.includes(i))
      : [...new Set([...sel, ...g])];
  } else if (!sel.includes(o.id)) sel = g;
  refresh();
}

function onMouseDown(e) {
  /*
   * The canvas, and only the canvas.
   *
   * The module dialog, the rung reference and the HUD are children of the stage
   * so they can float over the map, which means a mousedown on any of them
   * bubbles here -- and with a tool armed, clicking *save module* dropped an
   * object into the world underneath the panel. The world coordinate it computed
   * was real; the click was never meant for it.
   *
   * By naming the panels rather than demanding e.target IS the canvas: an event
   * dispatched at the stage itself is a legitimate way to reach the map, and the
   * question here is only whether something floating swallowed the click.
   */
  if (e.target.closest && e.target.closest('#mde-modpanel, #mde-rungs, #mde-hud, #mde-hint')) return;
  const p = stagePos(e);
  const w = toWorld(p.x, p.y);
  // an open module dialog owns its two markers ahead of everything else on the
  // canvas -- they routinely sit exactly on a platform corner
  const mm = spaceDown ? null : modMarkerAt(p.x, p.y);
  if (mm) { dragging = { modPt: mm }; return; }
  /*
   * A paint stroke owns the drag outright, ahead of the handles and ahead of the
   * "a click on the live selection moves it" rule.
   *
   * Both of those would otherwise eat the second stroke of every session. A
   * finished stroke selects what it made, so its group handles sit exactly along
   * the edge of what was just painted -- which is where the next stroke starts.
   * Grabbing one of those and stretching the last run of platforms across the
   * room is not a plausible thing to have meant by a drag in paint mode.
   *
   * Paint is a MODE, so this is the price of it being one: while it is on, the
   * canvas paints and nothing else. Press p, or the toolbar button, to get the
   * ordinary tools back.
   */
  if (canPaint() && !spaceDown && !e.ctrlKey && !e.metaKey && !e.altKey && e.button === 0) {
    pushHistory();          // once, for the whole stroke
    sel = [];
    const useBrush = brushIsClipboard();
    // the footprint is fixed for the whole stroke: measuring it per move would
    // let a stroke change its own lattice halfway across the room
    dragging = { paint: true, done: new Set(), made: [], c0: cellOf(w),
                 brush: useBrush, foot: useBrush ? brushSize() : { cols: 1, rows: 1 } };
    paintAt(dragging, w, e.shiftKey);
    refresh();
    return;
  }

  const h = spaceDown ? null : handleAt(p.x, p.y);
  if (h) {
    armHistory();
    if (h[0] === 'g') {
      const list = selected();
      const b = groupBox(list);
      dragging = { ghandle:h, pairs:cloneObjs(list), box0:b,
        ang0: Math.atan2(w.y - (b.y + b.h/2), w.x - (b.x + b.w/2)) };
    } else {
      dragging = { handle:h, o:selected()[0] };
    }
    return;
  }
  if (spaceDown || e.button === 1) {
    dragging = { pan:true, sx:p.x, sy:p.y, vx:view.x, vy:view.y };
    return;
  }

  /*
   * Ctrl is the one "and this one too" modifier.
   *
   * It used to be two: ctrl was the eyedropper and picked exactly one object,
   * alt toggled objects in and out of the selection and marqueed additively.
   * Both mean roughly the same thing to the hand, and remembering which was
   * which was pure overhead, so ctrl now does all of it -- toggle on an object,
   * additive marquee on blank space, and it still adopts the settings of
   * whatever it lands on.
   *
   * A ctrl CLICK on blank space keeps the old shortcut of dropping back to the
   * select tool; that is decided at mouseup, where a click can be told from a
   * drag, since the drag is the additive marquee.
   */
  /*
   * Alt is "no, just this one", and it beats ctrl.
   *
   * The inverse of ctrl's "and this one too": whatever is selected, alt+click
   * reduces it to the single object -- or the single group -- under the cursor.
   * That is the gesture you want once a selection has grown past what you meant,
   * and reaching for it should not require first working out how to undo the ctrl
   * rules. Held together with ctrl, alt wins.
   */
  if (e.altKey) {
    const under = topmostAt(w.x, w.y);
    if (under) { sel = groupIds(under); adoptFrom(under); refresh(); beginMove(w, under); }
    else { sel = []; refresh(); }
    return;
  }

  if (e.ctrlKey || e.metaKey) {
    const under = topmostAt(w.x, w.y);
    if (under) {
      pick(under, true);
      adoptFrom(under);
      // only if the toggle ADDED it -- otherwise the drag would move the objects
      // that are still selected, which is not what removing one meant
      if (sel.includes(under.id)) beginMove(w, under);
    } else {
      dragging = { marquee:true, x0:w.x, y0:w.y, x1:w.x, y1:w.y, add:true, ctrlBlank:true };
    }
    return;
  }

  /*
   * An armed module follows the same rule a freshly drawn box does: a click on the
   * live selection moves it, a click away from it commits and clears, and only the
   * NEXT click stamps another. A stray click never drops a module you did not want.
   */
  if (tool === 'module') {
    if (!pendingModule) { setTool('select'); return; }
    const held = selected().find((o) => hit(o, w.x, w.y));
    if (held) { beginMove(w, held); return; }
    if (sel.length) { sel = []; refresh(); return; }
    placeModule(w);
    return;
  }

  if (tool !== 'select') {
    // A freshly drawn box stays live: dragging it moves it, so it can be placed
    // roughly and then nudged without a trip back to the select tool. Clicking
    // off it is what commits it and starts the next one.
    const held = selected().find((o) => hit(o, w.x, w.y));
    if (held) { beginMove(w, held); return; }
    // Clicking away from a live selection commits it and clears it. Only the
    // NEXT click places another, so a stray click never drops an object you
    // did not want.
    if (sel.length) { sel = []; refresh(); return; }
    startCreate(w);
    return;
  }

  const under = topmostAt(w.x, w.y);
  if (under) { pick(under, e.shiftKey); beginMove(w, under); return; }

  /*
   * Empty space INSIDE the selection's own box still drags the selection.
   *
   * The box is what the eye reads as "the thing" -- a run of platforms with gaps
   * between them is one object to look at -- so a click in one of those gaps
   * should move it, not throw it away and start a marquee. Only space outside the
   * box is blank space.
   */
  if (sel.length > 1) {
    const b = groupBox(selected());
    if (b && w.x >= b.x && w.x <= b.x + b.w && w.y >= b.y && w.y <= b.y + b.h) {
      beginMove(w, null);
      return;
    }
  }

  // Empty space with the select tool draws a marquee. Panning stays on
  // space+drag and the middle button, which is where it was already.
  if (!e.shiftKey) { sel = []; refresh(); }
  dragging = { marquee:true, x0:w.x, y0:w.y, x1:w.x, y1:w.y, add:e.shiftKey };
}

function startCreate(w) {
  pushHistory();
  const k = KINDS[tool];
  if (k.single) {
    const existing = map.objects.find((o) => o.kind === tool);
    if (existing) { existing.x = snap(w.x); existing.y = snap(w.y); sel = [existing.id]; refresh(); return; }
  }
  const o = { id:nextId++, kind:tool, x:snap(w.x), y:snap(w.y), w:0, h:0, ...(k.props||{}) };
  if (tool === 'art') {
    if (!selTile) return;
    /*
     * On a grid, a stamped texture fills one cell -- letterboxed, never
     * stretched. Off the grid it lands at its own pixel size, which is what
     * `free` means everywhere else in the editor.
     *
     * This is the same rule paint uses, and it is here as well because most
     * texturing is single clicks: a tile dropped at its native 512px next to a
     * 100px grid is a tile that has to be resized by hand every single time.
     */
    if (grid) {
      const f = placeTile(selTile, snap(w.x - grid / 2), snap(w.y - grid / 2), grid, artStyle.rot);
      o.x = f.x; o.y = f.y; o.w = f.w; o.h = f.h;
    } else {
      o.w = selTile.w; o.h = selTile.h;
    }
    o.tile = selTile.name;
    o.rot = artStyle.rot; o.flipX = artStyle.flipX; o.flipY = artStyle.flipY;
  }
  if (k.shape === 'point' || k.shape === 'beam') { o.w = 0; o.h = 0; }
  if (k.path) { o.xmin = o.x; o.xmax = o.x; o.ymin = o.y; o.ymax = o.y; }
  if (tool === 'door') { o.zx = o.x - 200; o.zy = o.y - 100; o.zw = 400; o.zh = 300; }
  map.objects.push(o);
  sel = [o.id];
  refresh();
  if (k.shape === 'rect' && tool !== 'art') dragging = { create:o, ox:o.x, oy:o.y };
}

function onMouseMove(e) {
  const w = worldOf(e);
  lastWorld = w;
  hud(w);
  if (!dragging) return;
  const p = stagePos(e);
  if (dragging.modPt) {
    if (!modDialog) return;
    modDialog[dragging.modPt] = { x: snap(w.x), y: snap(w.y) };
    // the panel shows the same value, so it has to move with the marker
    const fx = root.querySelector('[data-mod="' + dragging.modPt + 'x"]');
    const fy = root.querySelector('[data-mod="' + dragging.modPt + 'y"]');
    if (fx) fx.value = String(modDialog[dragging.modPt].x);
    if (fy) fy.value = String(modDialog[dragging.modPt].y);
    renderModuleWarning();
  } else if (dragging.pan) {
    view.x = dragging.vx + (p.x - dragging.sx);
    view.y = dragging.vy + (p.y - dragging.sy);
  } else if (dragging.paint) {
    if (paintAt(dragging, w, e.shiftKey)) refreshObjs();
  } else if (dragging.marquee) {
    dragging.x1 = w.x; dragging.y1 = w.y;
  } else if (dragging.create) {
    commitHistory();
    const o = dragging.create;
    o.x = snap(Math.min(dragging.ox, w.x)); o.y = snap(Math.min(dragging.oy, w.y));
    o.w = Math.max(grid || 1, snap(Math.abs(w.x - dragging.ox)));
    o.h = Math.max(grid || 1, snap(Math.abs(w.y - dragging.oy)));
    refreshProps();
  } else if (dragging.ghandle) {
    commitHistory();
    groupDrag(dragging, w, e.shiftKey);
  } else if (typeof dragging.handle === 'string' && dragging.handle[0] === 'z') {
    commitHistory();
    resizeZone(dragging.o, dragging.handle, w.x, w.y);
  } else if (typeof dragging.handle === 'string' && dragging.handle[0] === 'q') {
    commitHistory();
    resizeClamp(dragging.o, dragging.handle, w.x, w.y);
  } else if (dragging.handle === 'b0' || dragging.handle === 'b1') {
    commitHistory();
    dragBeam(dragging.o, w.x, w.y);
  } else if (dragging.handle === 'p0' || dragging.handle === 'p1') {
    commitHistory();
    const o = dragging.o;
    if (dragging.handle === 'p0') { o.xmin = snap(w.x); o.ymin = snap(w.y); }
    else { o.xmax = snap(w.x); o.ymax = snap(w.y); }
    refreshProps();
  } else if (dragging.handle) {
    commitHistory();
    resize(dragging.o, dragging.handle, w.x, w.y, e.shiftKey);
  } else if (dragging.move) {
    commitHistory();
    restoreObjs(dragging.pairs);
    const dx = snap(dragging.ax + (w.x - dragging.wx)) - dragging.ax;
    const dy = snap(dragging.ay + (w.y - dragging.wy)) - dragging.ay;
    moveObjects(dragging.pairs.map((q) => q.o), dx, dy);
    refreshProps();
  }
}

/*
 * Resizing or rotating the whole selection.
 *
 * Both are recomputed from the mousedown snapshot every frame rather than
 * applied on top of the last frame: a drag that goes out and comes back has to
 * land exactly where it started, and anything incremental accumulates rounding
 * until it does not.
 */
function groupDrag(d, w, shift) {
  restoreObjs(d.pairs);
  const objs = d.pairs.map((q) => q.o);
  const b = d.box0;
  const cx = b.x + b.w/2, cy = b.y + b.h/2;

  if (d.ghandle === 'grot') {
    const ang = Math.atan2(w.y - cy, w.x - cx) - d.ang0;
    rotateSelection(objs, Math.round(ang / (Math.PI / 2)));
    refreshProps();
    return;
  }

  const id = d.ghandle.slice(1);
  let ox = b.x, oy = b.y, sx = 1, sy = 1;
  if (id.includes('w')) { ox = b.x + b.w; sx = Math.max(0.02, (ox - snap(w.x)) / b.w); }
  if (id.includes('e')) { ox = b.x; sx = Math.max(0.02, (snap(w.x) - ox) / b.w); }
  if (id.includes('n')) { oy = b.y + b.h; sy = Math.max(0.02, (oy - snap(w.y)) / b.h); }
  if (id.includes('s')) { oy = b.y; sy = Math.max(0.02, (snap(w.y) - oy) / b.h); }
  // shift on a corner keeps the group's proportions
  if (shift && id.length === 2) { const s = Math.max(sx, sy); sx = s; sy = s; }
  for (const o of objs) scaleObj(o, sx, sy, ox, oy);
  refreshProps();
}

function onMouseUp() {
  pendingHistory = null;
  /*
   * A finished stroke selects what it made, so the whole run can be nudged,
   * retagged or saved as a module without marqueeing it back up by hand. A
   * stroke that painted nothing -- every cell was already taken -- leaves the
   * selection alone rather than clearing it.
   */
  if (dragging?.paint && dragging.made.length) sel = dragging.made.slice();
  if (dragging?.create) { const o = dragging.create; if (o.w < 2 || o.h < 2) { o.w = grid||40; o.h = grid||40; } }
  if (dragging?.marquee) {
    const m = dragging;
    const x0 = Math.min(m.x0, m.x1), x1 = Math.max(m.x0, m.x1);
    const y0 = Math.min(m.y0, m.y1), y1 = Math.max(m.y0, m.y1);
    // a click rather than a drag: leave the selection alone
    if (Math.abs(x1 - x0) <= 3 && Math.abs(y1 - y0) <= 3) {
      // ...except ctrl on blank space, which is still "back to the select tool"
      if (m.ctrlBlank) { setTool('select'); sel = []; }
    } else {
      const inside = map.objects.filter((o) => {
        const b = bounds(o);
        return b.x + b.w >= x0 && b.x <= x1 && b.y + b.h >= y0 && b.y <= y1;
      }).map((o) => o.id);
      // a marquee that catches part of a group takes all of it
      const grown = withGroups(inside);
      sel = m.add ? [...new Set([...sel, ...grown])] : grown;
    }
  }
  /*
   * Only refresh if this mouseup actually ended a canvas drag.
   *
   * Refreshing unconditionally broke every control in the properties panel. A
   * checkbox fires mousedown -> mouseup -> click -> change, so an unconditional
   * rebuild here tore the panel down and recreated it from the OLD value before
   * the change handler ever ran, leaving the controls looking immutable. Text
   * fields and dropdowns had the same problem, since their change fires on blur
   * or after mouseup too.
   *
   * Nothing in the side panels ever sets `dragging` -- mousedown is bound to the
   * canvas alone -- so this is a reliable test for "was this a canvas drag".
   */
  const wasDragging = dragging !== null;
  dragging = null;
  if (wasDragging) refresh();
}

function resize(o, id, mx, my, free) {
  const b = bounds(o);
  const right = b.x + b.w, bottom = b.y + b.h;
  let x = b.x, y = b.y, w = b.w, h = b.h;
  if (id.includes('w')) { x = Math.min(snap(mx), right - 2); w = right - x; }
  if (id.includes('e')) { w = Math.max(2, snap(mx) - x); }
  if (id.includes('n')) { y = Math.min(snap(my), bottom - 2); h = bottom - y; }
  if (id.includes('s')) { h = Math.max(2, snap(my) - y); }
  /*
   * The drag is in screen-axis terms, but o.w/o.h live in the texture's own
   * rotated frame, so come out of the rotation before touching them and go back
   * in afterwards. Without rotation both conversions are the identity and this
   * is the code it always was.
   */
  const ang = artAngle(o);
  let lw = w, lh = h;
  if (ang) {
    const u = unrotSize(w, h, ang, o.w, o.h);
    lw = Math.max(2, u.w); lh = Math.max(2, u.h);
  }
  // textures keep their aspect on a corner unless shift frees it
  if (o.kind === 'art' && id.length === 2 && !free) {
    const t = tileImgs.get(o.tile);
    if (isReady(t)) {
      const s = Math.max(lw / imgW(t), lh / imgH(t));
      lw = Math.round(imgW(t) * s); lh = Math.round(imgH(t) * s);
    }
  }
  const a = ang ? rotAABB(0, 0, lw, lh, ang) : { w: lw, h: lh };
  // whichever edges the drag did not move stay exactly where they were
  if (id.includes('w')) x = right - a.w;
  if (id.includes('n')) y = bottom - a.h;
  o.w = lw; o.h = lh;
  o.x = x + (a.w - lw) / 2; o.y = y + (a.h - lh) / 2;
  refreshProps();
}

function onWheel(e) {
  e.preventDefault();
  const p = stagePos(e);
  const before = toWorld(p.x, p.y);
  view.z = Math.max(0.05, Math.min(8, view.z * (e.deltaY < 0 ? 1.12 : 1/1.12)));
  view.x = p.x - before.x * view.z;
  view.y = p.y - before.y * view.z;
}

function onKeyDown(e) {
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
  if (e.code === 'Space') { spaceDown = true; e.preventDefault(); return; }
  const s = selected();
  const step = e.shiftKey ? (grid || 10) : 1;
  if (e.ctrlKey || e.metaKey) {
    const k = e.key.toLowerCase();
    if (k === 'z') { e.shiftKey ? redo() : undo(); e.preventDefault(); return; }
    if (k === 'y') { redo(); e.preventDefault(); return; }
    if (k === 'c') { copySel(); e.preventDefault(); return; }
    if (k === 'v') { paste(); e.preventDefault(); return; }
    if (k === 'g') { e.shiftKey ? ungroupSelection() : groupSelection(); e.preventDefault(); return; }
  }
  if (/^Arrow/.test(e.key) && !e.repeat && s.length) pushHistory();
  if (e.key === 'Escape') {
    const rungs = $('rungs');
    if (rungs && rungs.style.display === 'block') rungs.style.display = 'none';
    else if (modDialog) closeModuleDialog();
    else setTool('select');
  }
  else if (e.key === 'Delete' || e.key === 'Backspace') {
    pushHistory();
    map.objects = map.objects.filter((o) => !sel.includes(o.id)); sel = []; refresh(); e.preventDefault();
  }
  else if (e.key === 'd' && e.ctrlKey) {
    pushHistory();
    const copies = s.map((o) => ({ ...o, id:nextId++ }));
    moveObjects(copies, grid || 20, grid || 20);
    map.objects.push(...copies); sel = copies.map((c)=>c.id); refresh(); e.preventDefault();
  }
  else if (/^Arrow/.test(e.key)) {
    const d = { ArrowLeft:[-step,0], ArrowRight:[step,0], ArrowUp:[0,-step], ArrowDown:[0,step] }[e.key];
    moveObjects(s, d[0], d[1]); refresh(); e.preventDefault();
  }
  else if (e.key === '[') { if(!e.repeat) pushHistory(); s.forEach((o)=>{ o.z = (o.z||0) - 1; if(o.kind==='art') artStyle.z = o.z; }); refresh(); }
  else if (e.key === ']') { if(!e.repeat) pushHistory(); s.forEach((o)=>{ o.z = (o.z||0) + 1; if(o.kind==='art') artStyle.z = o.z; }); refresh(); }
  else if (e.key === 'p') { setPaint(!paint); schedulePersist(); }
  // '+' as well as '=', so it works whether or not shift is held
  else if (e.key === '=' || e.key === '+') { stepGrid(1); }
  else if (e.key === '-' || e.key === '_') { stepGrid(-1); }
  else if (e.key === 'x') { pushHistory(); s.forEach((o)=>{ if(o.kind==='art') { o.flipX = o.flipX?0:1; artStyle.flipX = o.flipX; } }); refresh(); }
  else if (e.key === 'y') { pushHistory(); s.forEach((o)=>{ if(o.kind==='art') { o.flipY = o.flipY?0:1; artStyle.flipY = o.flipY; } }); refresh(); }
  else if ((e.key === 'r' || e.key === 'R') && s.length) {
    pushHistory();
    /*
     * `r` turns the SHAPE, about the selection's centre -- the only way a run of
     * platforms and the coins on them can be turned without coming apart, and the
     * only thing that makes sense for a wall of textures too.
     *
     * `alt+r` turns each texture in place instead, spinning its own `rot` and
     * remembering the angle for the next stamp. That is right for one tile and
     * for re-facing a set of them, and it used to be what plain `r` did whenever
     * everything selected was a texture -- which meant a wall could not be turned
     * as a wall at all.
     */
    if (e.altKey) {
      s.forEach((o)=>{ if (o.kind === 'art') { o.rot = ((o.rot||0) + 90) % 360; artStyle.rot = o.rot; } });
    } else if (s.length === 1 && s[0].kind === 'art') {
      // one tile: turning it about its own centre and turning "the shape" are the
      // same gesture, and only this one keeps the angle for the next stamp
      s[0].rot = ((s[0].rot||0) + 90) % 360; artStyle.rot = s[0].rot;
    } else {
      rotateSelection(s, 1);
    }
    if (e.altKey) e.preventDefault();   // alt+letter opens the browser's own menus
    refresh();
  }
}

// ---------------------------------------------------------------- panels
function setTool(t) {
  tool = t;
  clipBrush = false;
  renderBrush();
  [...root.querySelectorAll('#mde-tools button')].forEach((b) =>
    b.classList.toggle('on', b.dataset.tool === t));
  /*
   * An armed module is a tool like any other, so switching to a real tool -- or
   * pressing escape, or ctrl-clicking blank space -- has to put it down. Anything
   * else leaves a stamp armed behind a tool that looks selected.
   */
  if (t !== 'module') pendingModule = null;
  const rows = root.querySelectorAll('#mde-modlist .mod');
  [...rows].forEach((el) =>
    el.classList.toggle('sel', !!pendingModule && el.dataset.module === pendingModule.name));
  const hint = root.querySelector('#mde-modhint');
  if (hint) {
    hint.textContent = pendingModule
      ? 'Click the canvas to place "' + pendingModule.name + '". Esc puts it down.'
      : 'Pick a module, then click the canvas to place it.';
  }
}

function buildTools() {
  const el = $('tools');
  el.innerHTML = '';
  const mk = (id, label) => {
    const b = document.createElement('button');
    b.dataset.tool = id; b.textContent = label;
    b.onclick = () => setTool(id);
    el.appendChild(b);
  };
  mk('select', 'Select');
  Object.entries(KINDS).sort((a,b)=>a[1].order-b[1].order).forEach(([id,k]) => mk(id, k.label));
  setTool('select');
}

/*
 * The texture palette. Images come from io.tileImage, which is a PNG over HTTP
 * on the dev server and a canvas rebuilt from the player's own artwork in the
 * userscript -- both are drawable, so nothing here needs to know which it got.
 */
function buildPalette(tiles) {
  const el = $('palette');
  el.innerHTML = '';
  tileList = tiles; tileNodes.clear(); tileImgs.clear();
  for (const t of tiles) {
    const img = io.tileImage(t.name);
    tileImgs.set(t.name, img);
    const d = document.createElement('div');
    d.className = 'tile';
    const c = document.createElement('canvas');
    const f = Math.min(74 / t.w, 42 / t.h, 1);
    c.width = Math.max(1, Math.round(t.w * f)); c.height = Math.max(1, Math.round(t.h * f));
    const paint = () => { try { c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); } catch (e) {} };
    if (isReady(img)) paint(); else if (img) img.onload = paint;
    const s = document.createElement('span'); s.textContent = t.name.replace(/_/g,' ');
    d.appendChild(c); d.appendChild(s);
    d.title = t.name + '  ' + t.w + 'x' + t.h;
    d.onclick = () => pickTile(t.name);
    tileNodes.set(t.name, d);
    el.appendChild(d);
  }
}

/*
 * Select a texture in the palette, from the palette or from an object on canvas.
 */
function pickTile(name) {
  const t = tileList.find((x) => x.name === name);
  if (!t) return;
  selTile = t;
  setTool('art');
  tileNodes.forEach((n) => n.classList.remove('sel'));
  const node = tileNodes.get(name);
  if (node) { node.classList.add('sel'); node.scrollIntoView({ block:'nearest' }); }
}

/*
 * Ctrl-click picks up an object's settings as well as selecting it: the tool
 * switches to that kind, and for a texture the palette selection and its
 * rotation and mirroring come with it. That makes it an eyedropper -- click an
 * existing piece, then carry on stamping more of the same instead of hunting the
 * palette and redoing the transform each time.
 */
function adoptFrom(o) {
  if (!KINDS[o.kind]) return;
  if (o.kind === 'art') {
    artStyle = { rot:o.rot || 0, flipX:o.flipX || 0, flipY:o.flipY || 0 };
    pickTile(o.tile);
  } else {
    setTool(o.kind);
  }
}

/*
 * Properties panel.
 *
 * Rendered from each kind's field metadata rather than dumping raw numbers:
 * toggles become checkboxes, fixed choices become dropdowns, and every field
 * carries a plain-language label with the game's real field name and an
 * explanation underneath. Several of these fields are impossible to guess from
 * their names -- xx means camera offset on an area and patrol speed on a mover,
 * and a 0 clamp means no clamp rather than a clamp at zero.
 */
function refreshProps() {
  const el = $('props');
  const s = selected();
  if (!s.length) { el.innerHTML = '<span class="muted">nothing selected</span>'; return; }
  if (s.length > 1) return groupProps(el, s);
  const o = s[0], k = K(o);
  el.innerHTML = '';

  const head = document.createElement('div');
  head.className = 'muted';
  head.style.marginBottom = '7px';
  head.textContent = k.label + '  #' + o.id;
  el.appendChild(head);

  if (k.note) {
    const n = document.createElement('div');
    n.className = 'note';
    n.textContent = k.note;
    el.appendChild(n);
  }

  const addRow = (field, meta) => {
    const wrap = document.createElement('div');
    wrap.className = 'field';
    const row = document.createElement('div');
    row.className = 'row2';
    const lab = document.createElement('span');
    lab.textContent = meta.label || field;
    lab.title = 'game field: ' + field;
    row.appendChild(lab);

    let input;
    if (meta.type === 'bool') {
      input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = !!o[field];
      input.style.width = 'auto';
      input.onchange = () => {
        pushHistory();
        o[field] = input.checked ? 1 : 0;
        refreshObjs();
        // toggling Crusher changes which fields are relevant
        if (field === 'stomper') refreshProps();
      };
    } else if (meta.type === 'select') {
      input = document.createElement('select');
      for (const opt of meta.options) {
        const op = document.createElement('option');
        op.value = String(opt); op.textContent = String(opt);
        if (String(o[field]) === String(opt)) op.selected = true;
        input.appendChild(op);
      }
      input.onchange = () => {
        pushHistory();
        const v = input.value;
        o[field] = isNaN(Number(v)) ? v : Number(v);
        refreshObjs();
        if (field === 'trigger') refreshProps();
      };
    } else {
      input = document.createElement('input');
      input.type = 'text';
      input.value = o[field] ?? '';
      input.onchange = () => {
        pushHistory();
        const v = input.value;
        o[field] = (v !== '' && !isNaN(Number(v))) ? Number(v) : v;
        refreshObjs();
      };
    }
    row.appendChild(input);
    wrap.appendChild(row);
    if (meta.help) {
      const h = document.createElement('div');
      h.className = 'help';
      h.textContent = meta.help;
      wrap.appendChild(h);
    }
    el.appendChild(wrap);
  };

  addRow('x', { type:'number', label:'x' });
  addRow('y', { type:'number', label:'y' });
  if (k.shape === 'rect') {
    addRow('w', { type:'number', label:'width' });
    addRow('h', { type:'number', label:'height' });
  }
  const fields = k.fields || {};
  // crusher settings are noise on an ordinary platform, so they only appear
  // once the Crusher box is ticked
  Object.keys(k.props || {}).forEach((p) => addRow(p, fields[p] || { type:'number', label:p }));
  Object.keys(fields).forEach((p) => {
    const meta = fields[p];
    if (meta.crusher && !o.stomper) return;
    if (meta.zone && o.trigger !== 'zone') return;
    if (!meta.crusher && !meta.zone && !meta.door) return;
    addRow(p, meta);
  });
  if (o.kind !== 'art') {
    addRow('z', { type:'number', label:'Z order',
      help:'Editing aid only, and not saved. Lower it ([) to push this behind other objects so you can click what is underneath; raise it (]) to bring it forward.' });
  }

  if (k.path) {
    const sep = document.createElement('div');
    sep.className = 'note';
    sep.textContent = 'Patrol range. Drag the two round handles on the canvas, or set the bounds here. Leave them equal to the position for a stationary object.';
    el.appendChild(sep);
    PATH_FIELDS.forEach((p) => addRow(p, {
      type:'number', label:p,
      help: p.startsWith('x') ? 'Horizontal travel limit.' : 'Vertical travel limit.' }));
  }
}

/*
 * Several objects selected. The panel describes the GROUP -- what it covers and
 * what can be done to it as one -- rather than saying only how many things are
 * in it, which was all it used to say.
 */
function groupProps(el, s) {
  el.innerHTML = '';
  const b = groupBox(s);
  const head = document.createElement('div');
  head.className = 'muted';
  head.style.marginBottom = '7px';
  head.textContent = s.length + ' objects selected';
  el.appendChild(head);

  const note = document.createElement('div');
  note.className = 'note';
  note.textContent = 'Drag the yellow box to resize everything together (shift keeps the proportions), or the round handle above it to turn it. Rotation goes in quarter turns, because plats, spikes and camera areas are axis-aligned rects in the game’s own data.';
  el.appendChild(note);

  if (b) {
    const dims = document.createElement('div');
    dims.className = 'muted';
    dims.style.marginBottom = '8px';
    dims.textContent = 'x ' + Math.round(b.x) + '  y ' + Math.round(b.y) +
      '   ' + Math.round(b.w) + ' × ' + Math.round(b.h);
    el.appendChild(dims);
  }

  const row = document.createElement('div');
  row.style.display = 'flex';
  row.style.gap = '5px';
  const mk = (label, fn) => {
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.onclick = () => { pushHistory(); fn(); refresh(); };
    row.appendChild(btn);
  };
  mk('↻ rotate 90°', () => rotateSelection(selected(), 1));
  mk('↺ back 90°', () => rotateSelection(selected(), 3));
  if (selected().length > 1) mk('group', groupSelection);
  if (selected().some((o) => o.group)) mk('ungroup', ungroupSelection);
  el.appendChild(row);

  const counts = {};
  for (const o of s) counts[o.kind] = (counts[o.kind] || 0) + 1;
  const list = document.createElement('div');
  list.className = 'muted';
  list.style.marginTop = '9px';
  list.textContent = Object.entries(counts)
    .map(([k2, n]) => n + ' × ' + (KINDS[k2] ? KINDS[k2].label : k2)).join(', ');
  el.appendChild(list);

  if (Object.keys(counts).length === 1) massProps(el, s, s[0].kind);
}

/*
 * Editing forty things at once.
 *
 * Only when the selection is all one kind, because a field means a different
 * thing on a different kind and "set speed on the platforms and the robots" has
 * no answer. Position is deliberately absent: setting x on forty objects stacks
 * them, and moving them together is what the drag and the arrow keys are for.
 * Size IS here -- "make all of these 50 tall" is a real thing to want and doing
 * it one at a time is where building a room stops.
 *
 * A field the selection disagrees on shows blank rather than the first object's
 * value, so nothing is silently flattened by opening the panel and closing it.
 */
function massProps(el, s, kind) {
  const k = KINDS[kind];
  if (!k) return;
  const fields = k.fields || {};
  const rows = [];
  if (k.shape === 'rect') {
    rows.push(['w', { type:'number', label:'width' }], ['h', { type:'number', label:'height' }]);
  }
  for (const p of Object.keys(k.props || {})) rows.push([p, fields[p] || { type:'number', label:p }]);
  for (const p of Object.keys(fields)) {
    const meta = fields[p];
    if (!meta.crusher && !meta.zone && !meta.door) continue;
    if (meta.crusher && !s.every((o) => o.stomper)) continue;
    if (meta.zone && !s.every((o) => o.trigger === 'zone')) continue;
    rows.push([p, meta]);
  }
  if (!rows.length) return;

  const head = document.createElement('div');
  head.className = 'note';
  head.style.marginTop = '10px';
  head.textContent = 'All ' + s.length + ' are ' + k.label +
    '. Setting a value here sets it on every one. Blank means they disagree; ' +
    'leave it blank and it stays that way.';
  el.appendChild(head);

  const apply = (field, v) => {
    pushHistory();
    for (const o of s) o[field] = v;
    refreshObjs();
    refreshProps();
  };

  for (const [field, meta] of rows) {
    const vals = [...new Set(s.map((o) => o[field]))];
    const same = vals.length === 1 ? vals[0] : undefined;
    const wrap = document.createElement('div');
    wrap.className = 'field';
    const row = document.createElement('div');
    row.className = 'row2';
    const lab = document.createElement('span');
    lab.textContent = meta.label || field;
    lab.title = 'game field: ' + field + (same === undefined ? ' (mixed)' : '');
    row.appendChild(lab);

    let input;
    if (meta.type === 'bool') {
      input = document.createElement('input');
      input.type = 'checkbox';
      input.style.width = 'auto';
      input.checked = !!same;
      // a mixed checkbox says so rather than picking a side
      input.indeterminate = same === undefined;
      input.onchange = () => apply(field, input.checked ? 1 : 0);
    } else if (meta.type === 'select') {
      input = document.createElement('select');
      const blank = document.createElement('option');
      blank.value = ''; blank.textContent = same === undefined ? '— mixed —' : '';
      input.appendChild(blank);
      for (const opt of meta.options) {
        const op = document.createElement('option');
        op.value = String(opt); op.textContent = String(opt);
        if (same !== undefined && String(same) === String(opt)) op.selected = true;
        input.appendChild(op);
      }
      if (same === undefined) input.value = '';
      input.onchange = () => {
        if (input.value === '') return;
        const v = input.value;
        apply(field, isNaN(Number(v)) ? v : Number(v));
      };
    } else {
      input = document.createElement('input');
      input.type = 'text';
      input.value = same === undefined ? '' : (same ?? '');
      input.placeholder = same === undefined ? 'mixed' : '';
      input.onchange = () => {
        const v = input.value;
        if (v === '' && same === undefined) return;   // left alone, not cleared
        apply(field, (v !== '' && !isNaN(Number(v))) ? Number(v) : v);
      };
    }
    row.appendChild(input);
    wrap.appendChild(row);
    el.appendChild(wrap);
  }
}

function refreshObjs() {
  const el = $('objs');
  el.innerHTML = '';
  const list = [...map.objects].sort((a,b)=>(K(a)?.order||99)-(K(b)?.order||99));
  for (const o of list) {
    const d = document.createElement('div');
    d.className = 'obj' + (sel.includes(o.id) ? ' sel' : '');
    const k = K(o) || { label:o.kind, color:'#888' };
    d.innerHTML = '<span class="swatch" style="background:' + k.color + '"></span>';
    d.appendChild(document.createTextNode(k.label + (o.kind==='art' ? ' · ' + o.tile.replace(/_/g,' ') : '') +
      '  (' + Math.round(o.x) + ',' + Math.round(o.y) + ')'));
    d.onclick = () => { sel = [o.id]; refresh(); };
    el.appendChild(d);
  }
}

const refresh = () => { refreshProps(); refreshObjs(); };

/*
 * The coordinate readout.
 *
 * Live on every mouse move, not just while dragging -- it used to update only
 * mid-drag, which is the one time you are looking at the thing you are dragging
 * instead. Reading a coordinate off the map before placing anything is the
 * common case: lining a new platform up with one across the level, or checking
 * what world Y a hazard sits at.
 */
let hudCo = null, hudMeta = null;
function buildHud() {
  const el = $('hud');
  el.innerHTML = '';
  hudCo = document.createElement('span'); hudCo.className = 'co';
  hudMeta = document.createElement('span'); hudMeta.className = 'sn';
  const meta2 = document.createElement('span'); meta2.className = 'muted'; meta2.id = 'mde-hudinfo';
  el.appendChild(hudCo); el.appendChild(hudMeta); el.appendChild(meta2);
}
function hud(w) {
  if (!hudCo) return;
  hudCo.innerHTML = '<span class="ax">x</span>&nbsp;' + Math.round(w.x) +
                    '&nbsp;&nbsp;<span class="ax">y</span>&nbsp;' + Math.round(w.y);
  hudMeta.textContent = grid ? 'snaps to ' + snap(w.x) + ', ' + snap(w.y) : '';
  const info = root.querySelector('#mde-hudinfo');
  if (info) {
    info.textContent = 'grid ' + (grid || 'free') + '   objects ' + map.objects.length +
      '   zoom ' + view.z.toFixed(2) + 'x' + (sel.length > 1 ? '   ' + sel.length + ' selected' : '');
  }
}

// ---------------------------------------------------------------- view helpers
function fitView() {
  const stage = stageEl();
  const b = mapBounds();
  const z = Math.min(stage.clientWidth / b.w, stage.clientHeight / b.h) * 0.92;
  view.z = Math.max(0.05, Math.min(4, z));
  view.x = stage.clientWidth/2 - (b.x + b.w/2) * view.z;
  view.y = stage.clientHeight/2 - (b.y + b.h/2) * view.z;
}
function mapBounds() {
  if (!map.objects.length) return { x:-1620, y:-720, w:5130, h:3330 };
  const b = groupBox(map.objects);
  return b || { x:-1620, y:-720, w:5130, h:3330 };
}

/*
 * Thumbnail for the level select grid: the map canvas rendered to a small PNG on
 * save, so it can never drift from the map it depicts.
 */
function thumbnail() {
  const TW = 320, TH = 200;
  const c = document.createElement('canvas'); c.width = TW; c.height = TH;
  const g = c.getContext('2d');
  g.fillStyle = '#0d0f14'; g.fillRect(0,0,TW,TH);
  const b = mapBounds();
  const z = Math.min(TW/b.w, TH/b.h) * 0.94;
  g.setTransform(z,0,0,z, TW/2 - (b.x+b.w/2)*z, TH/2 - (b.y+b.h/2)*z);
  const ordered = [...map.objects].sort((a,b2)=>(K(a)?.order||99)-(K(b2)?.order||99));
  for (const o of ordered) {
    const k = K(o); if (!k) continue;
    const bb = bounds(o);
    if (o.kind === 'art') {
      const img = tileImgs.get(o.tile);
      if (isReady(img)) { try { g.drawImage(img, bb.x, bb.y, bb.w, bb.h); continue; } catch (e) {} }
    }
    g.fillStyle = k.fill || (k.color + '55');
    g.fillRect(bb.x, bb.y, Math.max(bb.w, 4/z), Math.max(bb.h, 4/z));
  }
  try { return c.toDataURL('image/png'); } catch (e) { return null; }
}

// ---------------------------------------------------------------- io
/*
 * Rebuild the open-map dropdown. Keeps the current selection if it still
 * exists, and shows when each map was last saved so the newest is obvious.
 */
function fillMapList(maps, keep) {
  const ml = $('mapList');
  const want = keep !== undefined ? keep : ml.value;
  ml.innerHTML = '';
  const none = document.createElement('option');
  none.value = '';
  none.textContent = maps.length ? '— open map —' : '— no saved maps —';
  ml.appendChild(none);
  for (const m of maps) {
    const o = document.createElement('option');
    o.value = m.id;
    const when = m.modified ? new Date(m.modified) : null;
    o.textContent = m.name + (when && !isNaN(when) ? '  (' + when.toLocaleDateString() + ' ' +
      when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ')' : '');
    ml.appendChild(o);
  }
  if (want && maps.some((m) => m.id === want)) ml.value = want;
}

async function refreshMapList(keep) {
  try { fillMapList(await io.listMaps(), keep); }
  catch (e) { /* keep whatever is listed if the refresh fails */ }
}

/*
 * Keep the map and its undo history across a trip through the play page.
 *
 * Play opens in another tab and "back to editor" navigates that tab, so the
 * original editor page is gone by the time you return -- with it, the whole
 * in-memory history. localStorage rather than sessionStorage because those are
 * two different tabs.
 *
 * Only the last SAVED_HISTORY snapshots are kept. The full stack is capped at
 * 120, and a 300-object map serialises to tens of kilobytes, so persisting all
 * of them would run at the browser storage limit for no real benefit.
 */
const SAVED_HISTORY = 30;
const sessionKey = (id) => (io.storageKey || 'johnny-editor') + ':' + id;
const stateKey = () => sessionKey(map.meta.id || $('mapName').value || 'untitled');

/*
 * The grid ladder, and the keys that walk it.
 *
 * The same steps the dropdown offers, because two different sets of grid sizes
 * would be two answers to "what is a cell". The grid gets changed constantly
 * while drawing -- coarse to block a room out, fine to detail it -- and reaching
 * for a dropdown breaks the stroke you were in the middle of.
 */
const GRID_STEPS = [0, 10, 25, 50, 100];
function stepGrid(dir) {
  const i = GRID_STEPS.indexOf(grid);
  const at = i < 0 ? GRID_STEPS.findIndex((g) => g >= grid) : i;
  const next = Math.max(0, Math.min(GRID_STEPS.length - 1, (at < 0 ? 0 : at) + dir));
  if (GRID_STEPS[next] !== grid) { setGrid(GRID_STEPS[next]); schedulePersist(); }
}

function setGrid(v) {
  grid = Number(v) || 0;
  const el = $('grid');
  if (el) el.value = String(grid);
  // Paint works in cells; `free` has none. Re-run the toggle rather than clearing
  // the flag, so the button's enabled state and tooltip follow the grid too.
  setPaint(paint);
}

function persistState() {
  if (!booted) return;
  try {
    localStorage.setItem(stateKey(), JSON.stringify({
      objects: map.objects,
      nextId,
      grid,
      paint,
      name: map.meta.name,
      undo: undoStack.slice(-SAVED_HISTORY),
      redo: redoStack.slice(-SAVED_HISTORY),
      at: Date.now(),
    }));
  } catch (err) { /* quota or private mode: carry on without persistence */ }
}

function restoreState(id) {
  try {
    const raw = localStorage.getItem(sessionKey(id));
    if (!raw) return false;
    const d = JSON.parse(raw);
    if (!d || !Array.isArray(d.objects)) return false;
    map.objects = d.objects;
    nextId = d.nextId || 1;
    if (d.name) map.meta.name = d.name;
    // grid is a per-map working preference, not part of the map itself, so it
    // lives with the session rather than in the saved file
    if (typeof d.grid === 'number') setGrid(d.grid);
    if (typeof d.paint === 'boolean') setPaint(d.paint);
    undoStack = d.undo || [];
    redoStack = d.redo || [];
    return true;
  } catch (err) { return false; }
}

async function openMap(id) {
  const g = await io.loadMap(id);
  if (!g || g.error) return false;
  loadGame(g);
  // A saved map is the committed state; anything edited after that save, plus
  // the history and the grid preference, comes back from local storage.
  map.meta.id = id;
  restoreState(id);
  $('mapName').value = map.meta.name;
  $('mapList').value = id;
  fitView(); refresh();
  return true;
}

async function save() {
  const name = ($('mapName').value || 'untitled').trim();
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,64) || 'untitled';
  const g = toGame();
  /*
   * Merge rather than replace. meta carries map.meta.modules -- which modules a
   * map was assembled from, and at which rung -- and rebuilding meta from just
   * the id and the name silently threw that away on every save.
   */
  g.meta = Object.assign({}, map.meta, { id, name });
  const btn = $('save');
  let ok = false;
  try {
    const j = await io.saveMap(id, { map:g, thumb: thumbnail() });
    ok = !!(j && j.ok);
  } catch (e) { console.error('[editor] save failed', e); }
  btn.textContent = ok ? 'saved' : 'save failed';
  // the list is built once at boot, so without this a map saved during the
  // session never appears in it until a reload
  if (ok) { map.meta.id = id; persistState(); await refreshMapList(id); }
  setTimeout(()=>{ btn.textContent = 'save'; }, 1500);
  return ok ? id : null;
}

// ---------------------------------------------------------------- boot & mount
function on(target, type, fn, opts) {
  target.addEventListener(type, fn, opts);
  listeners.push([target, type, fn, opts]);
}

async function boot() {
  if (booted) return;
  buildTools();
  buildHud();
  ctx = $('cv').getContext('2d');

  try { buildPalette(await io.tiles()); }
  catch (e) { console.warn('[editor] no textures available', e); }

  const ml = $('mapList');
  await refreshMapList();
  /*
   * The list is built once, so a map saved by someone else -- or in another tab
   * -- never appeared until a reload. Refresh it whenever the dropdown opens,
   * and again after every save.
   */
  on(ml, 'mousedown', () => { refreshMapList(ml.value); });
  ml.onchange = () => { if (ml.value) openMap(ml.value); };

  $('newMap').onclick = () => {
    map = blankMap(); sel = []; undoStack = []; redoStack = [];
    $('mapName').value = 'Untitled';
    $('mapList').value = '';
    fitView(); refresh();
  };
  const van = $('fromVanilla');
  if (io.vanillaMap) {
    van.onclick = async () => {
      loadGame(await io.vanillaMap());
      map.meta.name = 'Copy of vanilla';
      map.meta.id = '';
      $('mapName').value = map.meta.name;
      $('mapList').value = '';
      fitView(); refresh();
    };
  } else van.style.display = 'none';

  $('grid').onchange = (e) => { setGrid(Number(e.target.value)); schedulePersist(); };
  $('paint').onclick = () => { setPaint(!paint); schedulePersist(); };
  $('brush').onclick = () => {
    if (!clipboard.length) return;
    clipBrush = !clipBrush;
    renderBrush();
  };
  renderBrush();
  $('fit').onclick = fitView;
  $('fillspikes').onclick = () => {
    // the palette knows the tile's REAL size; the constant is only the recipe's
    const t = tileList.find((x) => x.name === SPIKE_TILE.name) || SPIKE_TILE;
    const made = autotileSpikes(map.objects, t);
    if (!made.length) {
      alert('Every spike already has art over it.');
      return;
    }
    pushHistory();
    for (const o of made) { o.id = nextId++; map.objects.push(o); }
    sel = made.map((o) => o.id);
    refresh();
  };
  $('artTop').onclick = (e) => {
    artOnTop = !artOnTop;
    e.target.classList.toggle('on', artOnTop);
  };
  $('save').onclick = save;

  /*
   * The module library. Optional, like play and export: an io with no module
   * storage hides the panel rather than showing a dead one.
   */
  const modSave = $('modsave');
  if (moduleSectionVisible()) {
    modSave.onclick = openModuleDialog;
    await refreshModuleList();
  }
  /*
   * The rung reference does not need a library -- it is the ladder, which is
   * bundled -- so it survives an io with no module storage at all.
   */
  const rungBtn = $('rungref');
  if (typeof Ladder !== 'undefined') rungBtn.onclick = toggleRungRef;
  else rungBtn.style.display = 'none';

  // Play always saves first. The runner reads the map back out, so running a
  // stale copy of what is on screen would be worse than a moment of delay.
  const play = $('play');
  if (io.play) {
    play.onclick = async () => {
      play.textContent = 'saving…';
      const id = await save();
      play.textContent = 'play';
      if (id) io.play(id);
    };
  } else play.style.display = 'none';

  /*
   * Export is how a level leaves a browser that has no server behind it. The
   * userscript keeps maps in localStorage, so without this the only copy of a
   * level would live in one browser profile and could never be handed to anyone.
   */
  const exp = $('export');
  if (io.exportMap) {
    exp.onclick = () => {
      const name = ($('mapName').value || 'untitled').trim();
      const id = name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,64) || 'untitled';
      const g = toGame();
      g.meta = Object.assign({}, map.meta, { id, name, modified: new Date().toISOString() });
      io.exportMap(id, g);
    };
  } else exp.style.display = 'none';

  const exit = $('exit');
  if (io.exit) exit.onclick = () => { persistState(); io.exit(); };
  else exit.style.display = 'none';

  $('mapName').oninput = (e) => { map.meta.name = e.target.value; };
  $('mapName').value = map.meta.name;

  booted = true;
  fitView(); refresh();
}

/*
 * Mount the editor into an element.
 *
 * Everything is bound here rather than at module scope so the userscript can put
 * the editor away again: while it is closed the key handlers are inert and the
 * draw loop does nothing, because the same keys belong to the game the rest of
 * the time.
 */
function mount(opts) {
  opts = opts || {};
  io = opts.io;
  if (!io) throw new Error('MapEditor.mount needs { io }');
  const doc = (opts.root && opts.root.ownerDocument) || document;

  if (!doc.getElementById('mde-style')) {
    const st = doc.createElement('style');
    st.id = 'mde-style';
    st.textContent = CSS;
    doc.head.appendChild(st);
  }
  root = doc.createElement('div');
  root.id = 'mde-root';
  root.innerHTML = HTML;
  /*
   * With no element to live in, the editor is an overlay over whatever page it
   * was dropped into -- which is the userscript case, where that page is the
   * running game. Fixed and above everything, including mapkit's own level
   * select at 9999.
   */
  if (!opts.root) root.style.cssText = 'position:fixed;inset:0;z-index:2147483000;';
  (opts.root || doc.body).appendChild(root);

  const stage = stageEl();
  on(stage, 'mousedown', onMouseDown);
  on(stage, 'wheel', onWheel, { passive:false });
  // move and up on the window, so a drag survives leaving the canvas
  on(window, 'mousemove', (e) => { if (active) onMouseMove(e); });
  on(window, 'mouseup', () => { if (active) onMouseUp(); });
  /*
   * Keys are captured, not merely listened for. In the page this changes
   * nothing; inside the game it is the difference between typing a map name and
   * making Johnny jump, because the game's own key handlers are bound to the
   * same window.
   */
  on(window, 'keydown', (e) => {
    if (!active) return;
    e.stopPropagation();
    onKeyDown(e);
  }, true);
  on(window, 'keyup', (e) => {
    if (!active) return;
    e.stopPropagation();
    if (e.code === 'Space') spaceDown = false;
  }, true);
  // the game grabs focus back on a click, and a held space would stick
  on(window, 'blur', () => { spaceDown = false; });
  on(window, 'beforeunload', persistState);

  const handle = {
    async open(id) {
      active = true;
      root.style.display = '';
      await boot();
      if (id) await openMap(id);
      fitView();
      return handle;
    },
    close() {
      persistState();
      active = false;
      root.style.display = 'none';
      return handle;
    },
    isOpen: () => active,
    openMap,
    save,
    mapId: () => map.meta.id,
    refreshTiles: async () => { buildPalette(await io.tiles()); },
    destroy() {
      persistState();
      active = false;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = null;
      for (const [t, type, fn, o2] of listeners) t.removeEventListener(type, fn, o2);
      listeners.length = 0;
      if (root && root.parentNode) root.parentNode.removeChild(root);
      root = null; booted = false;
    },
  };

  rafId = requestAnimationFrame(draw);
  if (opts.open !== false) handle.open(opts.map);
  else root.style.display = 'none';
  return handle;
}

/*
 * The geometry is exported so it can be exercised in node without a browser.
 * These are the parts where a wrong sign is invisible on screen until a map is
 * already broken -- four quarter turns must be the identity, and a resize must
 * carry patrol ranges and camera clamps with it.
 */
return {
  mount, KINDS,
  _geom: { rotate90, scaleObj, rotateSelection, clampBox, laserRect, groupBox, moveObjects, bounds,
            placeTile, isSurfaceTile, isHazardTile, rotAABB, unrotSize,
            spikeArt, autotileSpikes, SPIKE_TILE },
  /*
   * The module half, exported for the same reason: a module that does not survive
   * a trip through the editor loses its solve record and its hand-play verdict,
   * and nothing on screen would say so. tools/test-geometry.js round-trips the
   * whole library through these.
   */
  _module: { canonical, geomKey, moduleRung, moduleQueue, deriveEnds, stripModuleObject,
             buildModuleRecord, mergeModule, MODULE_OPTIONAL },
  /*
   * The ability model, exported so test-geometry.js can hold it against the real
   * solver/physics.js. These are transcribed, not imported -- physics.js is node
   * only -- and a silent drift here would put wrong numbers in front of an author
   * with no way to notice.
   */
  _rungs: { moveAccel, jumpImpulse, jumpRise },
  // read-only view of the live state, for driving the editor from a test page:
  // handle positions are in world space and the tests need the same transform
  // the canvas uses, which no amount of reading the panels recovers exactly
  // clipboard is the LIVE array: it is the paint brush now, and a test that
  // cannot empty it cannot check the fallback to the armed tool
  _state: () => ({ view, grid, paint, tool, sel: sel.slice(), clipboard,
                   clipBrush: brushIsClipboard(),
                   objects: map.objects, meta: map.meta,
                   filter: modFilter,
                   modules: moduleLib, armed: pendingModule, dialog: modDialog, handleAt, bounds }),
};
}));
