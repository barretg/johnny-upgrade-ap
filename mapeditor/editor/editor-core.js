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
        help:'Falls when Johnny walks under it. There is no fall-distance field: it drops from its own y and stops at world y = -60, so distance = -60 minus y. The trigger band is x+200 to x+280 regardless of width, so a crusher narrower than 200px can never be set off. Only ONE crusher works per map, and it fires once. All of these are hardcoded and need patching per map.' },
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
`;

const HTML = `
<div id="mde-top">
  <strong style="font-size:13px">Map Editor</strong>
  <input type="text" id="mde-mapName" placeholder="map name" style="width:170px">
  <select id="mde-mapList"><option value="">&mdash; open map &mdash;</option></select>
  <button id="mde-newMap">new</button>
  <button id="mde-fromVanilla">start from vanilla</button>
  <span class="mde-sp"></span>
  <span class="muted">grid</span>
  <select id="mde-grid">
    <option value="0" selected>free</option>
    <option value="10">10</option>
    <option value="25">25</option>
    <option value="50">50</option>
    <option value="100">100</option>
  </select>
  <button id="mde-artTop" class="on">textures on top</button>
  <button id="mde-fit">fit</button>
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
  <div class="sec">
    <h2>Textures</h2>
    <div id="mde-palette"></div>
  </div>
</aside>

<div id="mde-stage">
  <canvas id="mde-cv"></canvas>
  <div id="mde-hud"></div>
  <div id="mde-hint">
    <div><kbd>ctrl+click</kbd> pick object + its settings</div>
    <div><kbd>ctrl+click</kbd> blank = back to select tool</div>
    <div><kbd>alt+click</kbd> add / remove from selection</div>
    <div><kbd>drag</kbd> marquee select</div>
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
let nextId = 1;
let tileImgs = new Map();
let tileList = [], tileNodes = new Map();
let artStyle = { rot:0, flipX:0, flipY:0 };
let undoStack = [], redoStack = [], clipboard = [];  // reassigned when a session is restored
let lastWorld = { x:0, y:0 };
let dragging = null, spaceDown = false;
let artOnTop = true;
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
}
/*
 * Paste lands the copied group under the cursor rather than on top of the
 * original, which is almost always what you want when duplicating a run of
 * platforms or a cluster of coins.
 */
function paste() {
  if (!clipboard.length) return;
  pushHistory();
  let x0 = Infinity, y0 = Infinity;
  for (const c of clipboard) { x0 = Math.min(x0, c.x); y0 = Math.min(y0, c.y); }
  const dx = snap(lastWorld.x) - x0, dy = snap(lastWorld.y) - y0;
  const made = clipboard.map((c) => {
    const o = JSON.parse(JSON.stringify(c));
    o.id = nextId++;
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
  sel = made.map((o) => o.id);
  refresh();
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

function bounds(o) {
  const k = K(o);
  if (!k) return { x:o.x, y:o.y, w:o.w || 0, h:o.h || 0 };
  if (k.shape === 'beam') return laserRect(o);
  if (k.shape === 'point') { const s = k.size || 32; return { x:o.x - s/2, y:o.y - s/2, w:s, h:s }; }
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
  for (let i = 0; i < turns; i++) for (const o of list) rotate90(o, cx, cy);
  if (!grid || !turns) return;
  const nb = groupBox(list);
  const dx = snap(nb.x) - nb.x, dy = snap(nb.y) - nb.y;
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
  ctx.setLineDash([9/view.z, 5/view.z]);
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
function pick(o, additive) {
  if (additive) sel.includes(o.id) ? sel = sel.filter((i)=>i!==o.id) : sel.push(o.id);
  else if (!sel.includes(o.id)) sel = [o.id];
  refresh();
}

function onMouseDown(e) {
  const p = stagePos(e);
  const w = toWorld(p.x, p.y);
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
   * Ctrl is the eyedropper, and works whatever tool is armed. On an object it
   * selects and adopts its settings; on blank space it drops back to the select
   * tool, which is the usual reason for reaching for the toolbar mid-edit.
   */
  if (e.ctrlKey || e.metaKey) {
    const under = topmostAt(w.x, w.y);
    if (under) { pick(under, false); adoptFrom(under); beginMove(w, under); }
    else { setTool('select'); sel = []; refresh(); }
    return;
  }

  /*
   * Alt adds to the selection: on an object it toggles that one in or out, on
   * blank space it marquees without clearing what is already picked.
   */
  if (e.altKey) {
    const under = topmostAt(w.x, w.y);
    if (under) { pick(under, true); beginMove(w, under); }
    else { dragging = { marquee:true, x0:w.x, y0:w.y, x1:w.x, y1:w.y, add:true }; }
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
    o.tile = selTile.name; o.w = selTile.w; o.h = selTile.h;
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
  if (dragging.pan) {
    view.x = dragging.vx + (p.x - dragging.sx);
    view.y = dragging.vy + (p.y - dragging.sy);
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
  if (dragging?.create) { const o = dragging.create; if (o.w < 2 || o.h < 2) { o.w = grid||40; o.h = grid||40; } }
  if (dragging?.marquee) {
    const m = dragging;
    const x0 = Math.min(m.x0, m.x1), x1 = Math.max(m.x0, m.x1);
    const y0 = Math.min(m.y0, m.y1), y1 = Math.max(m.y0, m.y1);
    // a click rather than a drag: leave the selection alone
    if (Math.abs(x1 - x0) > 3 || Math.abs(y1 - y0) > 3) {
      const inside = map.objects.filter((o) => {
        const b = bounds(o);
        return b.x + b.w >= x0 && b.x <= x1 && b.y + b.h >= y0 && b.y <= y1;
      }).map((o) => o.id);
      sel = m.add ? [...new Set([...sel, ...inside])] : inside;
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
  // textures keep their aspect on a corner unless shift frees it
  if (o.kind === 'art' && id.length === 2 && !free) {
    const t = tileImgs.get(o.tile);
    if (isReady(t)) {
      const s = Math.max(w / imgW(t), h / imgH(t));
      const nw = Math.round(imgW(t) * s), nh = Math.round(imgH(t) * s);
      if (id.includes('w')) x = right - nw;
      if (id.includes('n')) y = bottom - nh;
      w = nw; h = nh;
    }
  }
  o.x = x; o.y = y; o.w = w; o.h = h;
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
  }
  if (/^Arrow/.test(e.key) && !e.repeat && s.length) pushHistory();
  if (e.key === 'Escape') { setTool('select'); }
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
  else if (e.key === 'x') { pushHistory(); s.forEach((o)=>{ if(o.kind==='art') { o.flipX = o.flipX?0:1; artStyle.flipX = o.flipX; } }); refresh(); }
  else if (e.key === 'y') { pushHistory(); s.forEach((o)=>{ if(o.kind==='art') { o.flipY = o.flipY?0:1; artStyle.flipY = o.flipY; } }); refresh(); }
  else if (e.key === 'r' && s.length) {
    pushHistory();
    /*
     * Textures alone keep the old behaviour -- spin in place and remember the
     * angle for the next stamp. Anything else rotates as a group about the
     * selection's centre, which is the only way a run of platforms and the coins
     * on them can be turned without coming apart.
     */
    if (s.every((o) => o.kind === 'art')) {
      s.forEach((o)=>{ o.rot = ((o.rot||0) + 90) % 360; artStyle.rot = o.rot; });
    } else {
      rotateSelection(s, 1);
    }
    refresh();
  }
}

// ---------------------------------------------------------------- panels
function setTool(t) {
  tool = t;
  [...root.querySelectorAll('#mde-tools button')].forEach((b) =>
    b.classList.toggle('on', b.dataset.tool === t));
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
  el.appendChild(row);

  const counts = {};
  for (const o of s) counts[o.kind] = (counts[o.kind] || 0) + 1;
  const list = document.createElement('div');
  list.className = 'muted';
  list.style.marginTop = '9px';
  list.textContent = Object.entries(counts)
    .map(([k2, n]) => n + ' × ' + (KINDS[k2] ? KINDS[k2].label : k2)).join(', ');
  el.appendChild(list);
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

function setGrid(v) {
  grid = Number(v) || 0;
  const el = $('grid');
  if (el) el.value = String(grid);
}

function persistState() {
  if (!booted) return;
  try {
    localStorage.setItem(stateKey(), JSON.stringify({
      objects: map.objects,
      nextId,
      grid,
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
  g.meta = { id, name };
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
  $('fit').onclick = fitView;
  $('artTop').onclick = (e) => {
    artOnTop = !artOnTop;
    e.target.classList.toggle('on', artOnTop);
  };
  $('save').onclick = save;

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
      g.meta = { id, name, modified: new Date().toISOString() };
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
  _geom: { rotate90, scaleObj, rotateSelection, clampBox, laserRect, groupBox, moveObjects, bounds },
  // read-only view of the live state, for driving the editor from a test page:
  // handle positions are in world space and the tests need the same transform
  // the canvas uses, which no amount of reading the panels recovers exactly
  _state: () => ({ view, grid, tool, sel: sel.slice(), objects: map.objects, handleAt, bounds }),
};
}));
