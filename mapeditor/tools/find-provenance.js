/*
 * Recover where each hand-cut tile came from in the original mural.
 *
 * We cannot distribute Coolmath/Miniclip's artwork, so mapkit has to rebuild the
 * tileset at load time from the player's own copy of lvlGrfx.png. That means
 * shipping a RECIPE per tile -- a source rectangle plus the normalise params
 * already in normalize.config.json -- instead of shipping pixels.
 *
 * The hand cuts are pixel-exact crops but carry no record of where they came
 * from, so this recovers it by template matching.
 *
 * Brute force is 17M candidate offsets per tile, so instead:
 *   1. histogram the mural once, to learn how rare each colour is
 *   2. in each cut, pick the pixel whose colour is RAREST in the mural
 *   3. collect just that colour's positions in the mural
 *   4. each one implies an origin; verify those few candidates properly
 *
 * A rare colour usually leaves a handful of candidates, so this is fast and
 * exact rather than approximate.
 *
 * Usage: node tools/find-provenance.js [path-to-sdk]
 * Output: tiles/manual/provenance.json
 */
const path = require('path'), fs = require('fs');
const P = require('../lib/png.js');

const SDK = process.argv[2] || path.join(__dirname, '..', '..', 'scratch-work', 'johnny-upgrade-sdk');
const SRC = path.join(__dirname, '..', 'tiles', 'manual');
const MURAL = path.join(SDK, 'assets', 'pics', 'lvlGrfx.png');

const ART_X0 = 1620, ART_Y0 = 720; // world = art - (ART_X0, ART_Y0)

const key = (r, g, b) => (r << 16) | (g << 8) | b;

function histogram(img) {
  const h = new Map();
  const { W, H, data } = img;
  for (let i = 0, o = 0; i < W * H; i++, o += 4) {
    if (data[o + 3] < 128) continue;
    const k = key(data[o], data[o + 1], data[o + 2]);
    h.set(k, (h.get(k) || 0) + 1);
  }
  return h;
}

function positionsOf(img, k) {
  const out = [];
  const { W, H, data } = img;
  for (let i = 0, o = 0; i < W * H; i++, o += 4) {
    if (data[o + 3] < 128) continue;
    if (key(data[o], data[o + 1], data[o + 2]) === k) out.push([i % W, (i / W) | 0]);
  }
  return out;
}

// Mean absolute per-channel difference of the cut placed at (ox, oy).
// Returns Infinity as soon as it is clearly not a match, so bad candidates die fast.
function compare(mural, cut, ox, oy, bail = Infinity) {
  if (ox < 0 || oy < 0 || ox + cut.W > mural.W || oy + cut.H > mural.H) return Infinity;
  let sum = 0, n = 0;
  for (let y = 0; y < cut.H; y++) {
    for (let x = 0; x < cut.W; x++) {
      const c = (y * cut.W + x) * 4;
      if (cut.data[c + 3] < 128) continue;
      const m = ((oy + y) * mural.W + (ox + x)) * 4;
      sum += Math.abs(mural.data[m] - cut.data[c]) +
             Math.abs(mural.data[m + 1] - cut.data[c + 1]) +
             Math.abs(mural.data[m + 2] - cut.data[c + 2]);
      n += 3;
    }
    if (n && sum / n > bail) return Infinity; // give up on this candidate early
  }
  return n ? sum / n : Infinity;
}

function locate(mural, muralHist, cut, name) {
  // the cut pixel whose colour is rarest in the mural
  let best = null;
  for (let y = 0; y < cut.H; y++) for (let x = 0; x < cut.W; x++) {
    const o = (y * cut.W + x) * 4;
    if (cut.data[o + 3] < 128) continue;
    const k = key(cut.data[o], cut.data[o + 1], cut.data[o + 2]);
    const count = muralHist.get(k);
    if (!count) continue;                       // colour absent from mural
    if (!best || count < best.count) best = { x, y, k, count };
    if (count === 1) { y = cut.H; break; }      // cannot do better
  }
  if (!best) return { error: 'no cut colour appears in the mural' };

  const spots = positionsOf(mural, best.k);
  let winner = null;
  for (const [mx, my] of spots) {
    const ox = mx - best.x, oy = my - best.y;
    const d = compare(mural, cut, ox, oy, winner ? winner.diff : 24);
    if (d !== Infinity && (!winner || d < winner.diff)) winner = { ox, oy, diff: d };
    if (winner && winner.diff === 0) break;
  }
  if (!winner) return { error: 'no candidate matched (anchor colour x' + best.count + ')' };
  return { x: winner.ox, y: winner.oy, diff: winner.diff, candidates: spots.length,
    anchorRarity: best.count };
}

function main() {
  if (!fs.existsSync(MURAL)) { console.error('no mural at ' + MURAL); process.exit(1); }
  const mural = P.readPNG(MURAL);
  console.log('mural ' + mural.W + 'x' + mural.H + ', building colour histogram...');
  const hist = histogram(mural);
  console.log(hist.size.toLocaleString() + ' distinct colours\n');

  const cfgPath = path.join(SRC, 'normalize.config.json');
  const config = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {};

  const files = fs.readdirSync(SRC).filter((f) => f.endsWith('.png') && !f.startsWith('_')).sort();
  console.log('name'.padEnd(56) + 'art x,y'.padStart(13) + 'world x,y'.padStart(15) + '   size      diff  cand');
  const out = [];
  for (const f of files) {
    const name = f.replace(/\.png$/, '');
    const cfg = config[name] || {};
    if (cfg.exclude ?? /example/i.test(name)) continue;
    const cut = P.readPNG(path.join(SRC, f));
    const r = locate(mural, hist, cut, name);
    if (r.error) { console.log('  ' + name.padEnd(54) + '  ' + r.error); continue; }

    // normalize applies `crop` before anything else, so the recipe's rect is the
    // located rect moved in by that margin
    const [cl, ct, cr, cb] = cfg.crop || [0, 0, 0, 0];
    const rect = { x: r.x + cl, y: r.y + ct, w: cut.W - cl - cr, h: cut.H - ct - cb };

    out.push({ name, art: rect,
      world: { x: rect.x - ART_X0, y: rect.y - ART_Y0, w: rect.w, h: rect.h },
      exact: r.diff === 0, diff: Number(r.diff.toFixed(2)) });
    console.log('  ' + name.padEnd(54) +
      (rect.x + ',' + rect.y).padStart(13) +
      ((rect.x - ART_X0) + ',' + (rect.y - ART_Y0)).padStart(15) +
      ('  ' + rect.w + 'x' + rect.h).padStart(11) +
      r.diff.toFixed(2).padStart(9) + String(r.candidates).padStart(6) +
      (r.diff === 0 ? '' : '   INEXACT'));
  }

  fs.writeFileSync(path.join(SRC, 'provenance.json'), JSON.stringify(out, null, 2) + '\n');
  const exact = out.filter((o) => o.exact).length;
  console.log('\nlocated ' + out.length + ' tiles, ' + exact + ' pixel-exact');
  console.log('wrote tiles/manual/provenance.json');
}

main();
