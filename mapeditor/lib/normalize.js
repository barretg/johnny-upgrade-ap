/*
 * Shared normalisation core.
 *
 * Used by BOTH paths that produce textures:
 *   tools/normalize-manual.js   -- from the hand-cut snips
 *   tools/extract-from-mural.js -- from located rectangles, at true 1:1
 *
 * They must behave identically: the whole point of provenance is that mapkit can
 * replay the same recipe against the player's own lvlGrfx.png and get the same
 * tile. Two copies of this logic would drift, so there is one.
 */
const path = require('path'), fs = require('fs');
const luma = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

/*
 * Deciding background by luma alone does not work on this set, in either
 * direction. A low cut leaves the grass and spike tiles their black surround; a
 * border-adaptive cut eats the rock tiles' genuinely dark browns and hollows
 * x_center_surface, whose black centre reaches the border through the diagonal
 * gaps between its arms.
 *
 * So the rule here is deliberately conservative, and wrong-but-recoverable
 * rather than destructive: a pixel is background only if it is BOTH very dark
 * AND near-neutral. Real texture in this mural is chromatic even when dark --
 * browns, dark blues, dark greens -- so requiring low chroma protects it, while
 * the mural's true background is a flat neutral black.
 *
 * Where that still gets it wrong, fix it per tile in
 * tiles/manual/normalize.config.json rather than by moving the global default:
 *
 *   { "x_center_surface": { "mode": "none" },
 *     "grass_...":        { "luma": 60, "chroma": 40 } }
 *
 *   mode "none"  -- trim only, strip nothing (for tiles whose background is
 *                   indistinguishable from their art)
 *   mode "auto"  -- the default
 *   luma/chroma  -- per-tile override of the two cuts
 */
const DEFAULT_LUMA = 14;
const DEFAULT_CHROMA = 12;

const chroma = (r, g, b) => Math.max(r, g, b) - Math.min(r, g, b);

/*
 * Two ways to decide a pixel is background.
 *
 * The luma/chroma rule is the general one. It is loose by nature, and on tiles
 * with dark internal detail it over-reaches: raising the cut enough to catch the
 * #202020 surround on square_rocks_block_corner also strips the dark mortar
 * between its stones, changing 2293 pixels that should have stayed identical.
 *
 * The exact rule is tighter and closer to the truth: this mural's background is
 * a specific colour, not "anything dark". Two values cover it -- pure #000000
 * and #202020. Matching those within a small tolerance removes the surround and
 * leaves genuinely dark texture alone. Prefer it wherever a tile has dark detail.
 *
 *   "bg": [[32,32,32],[0,0,0]], "tol": 6
 */
function makeIsBackground(cfg, lumaCut, chromaCut) {
  if (cfg.bg) {
    const tol = cfg.tol ?? 6;
    const list = cfg.bg;
    return (r, g, b) => list.some(([br, bg_, bb]) =>
      Math.abs(r - br) <= tol && Math.abs(g - bg_) <= tol && Math.abs(b - bb) <= tol);
  }
  return (r, g, b) => luma(r, g, b) <= lumaCut && chroma(r, g, b) <= chromaCut;
}


/*
 * Note that several cuts are shorter than a full run of that texture in the map,
 * and some (the rope) are simply tall. Neither is corrected: every surface is
 * stretched to whatever face it is applied to, so a cut's dimensions carry no
 * meaning beyond being enough pixels to stretch from.
 */

// Flood-fill background from the border: very dark AND near-neutral only.
function backgroundMask(t, isBg) {
  const { W, H, data } = t;
  const bg = new Uint8Array(W * H);
  const stack = [];
  const push = (x, y) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = y * W + x;
    if (bg[i]) return;
    const o = i * 4;
    if (data[o + 3] < 16) { bg[i] = 1; stack.push(i); return; } // already transparent
    const r = data[o], g = data[o + 1], b = data[o + 2];
    if (!isBg(r, g, b)) return;
    bg[i] = 1; stack.push(i);
  };
  for (let x = 0; x < W; x++) { push(x, 0); push(x, H - 1); }
  for (let y = 0; y < H; y++) { push(0, y); push(W - 1, y); }
  while (stack.length) {
    const i = stack.pop(), x = i % W, y = (i / W) | 0;
    push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1);
  }
  return bg;
}

/*
 * Background enclosed by the texture, unreachable from the border.
 *
 * The rail is the clear case: it is a bracket with two horizontal bars and two
 * side posts, and the band between the bars is background black at rgba(32,32,32)
 * that the border flood cannot reach. Whether such a pocket is background or art
 * is a per-tile question -- the box is a solid unit whose dark centre is texture
 * and must be kept -- so this is opt-in via "pockets": true.
 */
function pocketMask(t, bg, isBg) {
  const { W, H, data } = t;
  const out = Uint8Array.from(bg);
  const seen = Uint8Array.from(bg);
  for (let start = 0; start < W * H; start++) {
    if (seen[start]) continue;
    const o0 = start * 4;
    const r0 = data[o0], g0 = data[o0 + 1], b0 = data[o0 + 2];
    if (data[o0 + 3] < 16) continue;
    if (!isBg(r0, g0, b0)) continue;
    // flood this pocket
    const cells = [start];
    seen[start] = 1;
    for (let k = 0; k < cells.length; k++) {
      const i = cells[k], x = i % W, y = (i / W) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const j = ny * W + nx;
        if (seen[j]) continue;
        const o = j * 4;
        if (data[o + 3] < 16) { seen[j] = 1; cells.push(j); continue; }
        const r = data[o], g = data[o + 1], b = data[o + 2];
        if (!isBg(r, g, b)) continue;
        seen[j] = 1; cells.push(j);
      }
    }
    for (const i of cells) out[i] = 1;
  }
  return out;
}

/*
 * Soften the boundary so no hard edge survives a rotation.
 *
 * The subtlety: an edge pixel in the source is already a BLEND of the texture
 * and the black background behind it. Lowering its alpha without touching its
 * RGB leaves a dark, semi-transparent pixel, which composites as a black halo --
 * very visible on tiles with internal transparency like the rope and the spikes,
 * where every hole gets outlined.
 *
 * So un-mix it. The background is black, so an observed pixel is
 *     observed = true * a + 0 * (1 - a)
 * and the original colour is recovered by dividing:
 *     true = observed / a
 * That restores the edge to full brightness before the alpha is applied, and the
 * halo disappears.
 */
function feather(t, bg, lumaCut) {
  const { W, H, data } = t;
  const out = Buffer.from(data);
  const MIN_A = 0.18; // below this the recovered colour is pure noise
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, o = i * 4;
    if (bg[i]) { out[o + 3] = 0; continue; }
    let touches = false;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      if (bg[ny * W + nx]) { touches = true; break; }
    }
    if (!touches) continue;
    const l = luma(data[o], data[o + 1], data[o + 2]);
    const a = Math.max(0, Math.min(1, (l - lumaCut * 0.4) / (lumaCut * 1.6)));
    out[o + 3] = Math.round(data[o + 3] * a);
    if (a >= MIN_A) {
      for (let k = 0; k < 3; k++) out[o + k] = Math.min(255, Math.round(data[o + k] / a));
    }
  }
  return { W, H, data: out };
}

function trim(t) {
  let x0 = t.W, y0 = t.H, x1 = -1, y1 = -1;
  for (let y = 0; y < t.H; y++) for (let x = 0; x < t.W; x++)
    if (t.data[(y * t.W + x) * 4 + 3] > 8) {
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  if (x1 < 0) return null;
  const w = x1 - x0 + 1, h = y1 - y0 + 1, d = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const s = ((y0 + y) * t.W + (x0 + x)) * 4, o = (y * w + x) * 4;
    d[o] = t.data[s]; d[o + 1] = t.data[s + 1]; d[o + 2] = t.data[s + 2]; d[o + 3] = t.data[s + 3];
  }
  return { W: w, H: h, data: d, trimmed: [x0, y0, t.W - 1 - x1, t.H - 1 - y1] };
}

/*
 * Cut a fixed margin off before anything else, as [left, top, right, bottom].
 *
 * For when a hand cut caught part of a NEIGHBOURING object, which no threshold
 * can separate because it is real texture, just not this tile's. The boss door
 * is the case: the platform edge beside it occupies x0-7 solidly and overlaps to
 * x14, so the door is only clean from x15.
 */
function cropMargins(t, [l, tp, r, b]) {
  const w = t.W - l - r, h = t.H - tp - b;
  if (w <= 0 || h <= 0) throw new Error('crop removes the whole tile');
  const d = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const s = ((y + tp) * t.W + (x + l)) * 4, o = (y * w + x) * 4;
    d[o] = t.data[s]; d[o + 1] = t.data[s + 1]; d[o + 2] = t.data[s + 2]; d[o + 3] = t.data[s + 3];
  }
  return { W: w, H: h, data: d };
}

function padEven(t) {
  const w = t.W + (t.W & 1), h = t.H + (t.H & 1);
  if (w === t.W && h === t.H) return t;
  const d = Buffer.alloc(w * h * 4);
  const ox = (w - t.W) >> 1, oy = (h - t.H) >> 1;
  for (let y = 0; y < t.H; y++) for (let x = 0; x < t.W; x++) {
    const s = (y * t.W + x) * 4, o = ((y + oy) * w + (x + ox)) * 4;
    d[o] = t.data[s]; d[o + 1] = t.data[s + 1]; d[o + 2] = t.data[s + 2]; d[o + 3] = t.data[s + 3];
  }
  return { W: w, H: h, data: d };
}

module.exports = { luma, chroma, DEFAULT_LUMA, DEFAULT_CHROMA, makeIsBackground,
  backgroundMask, pocketMask, feather, trim, cropMargins, padEven,
  loadConfig: (dir) => {
    const p = path.join(dir, 'normalize.config.json');
    if (!fs.existsSync(p)) return {};
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
    catch (e) { console.error('bad normalize.config.json: ' + e.message); return {}; }
  },
};
