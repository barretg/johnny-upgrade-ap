/*
 * Locate each hand-cut tile in the mural, allowing for scale.
 *
 * The cuts were taken with Snipping Tool over lvlGrfx.png, so each is a RESAMPLED
 * screen capture at whatever the viewer's zoom times Windows' DPI scaling happened
 * to be -- and, as the recovered scales show, a different factor per snip.
 * Evidence: a pixel-exact crop would share 100% of its palette with the mural, but
 * these share 3-55%, and the rope alone holds 11,145 distinct colours against the
 * whole mural's 12,465.
 *
 * What we want is not the pixels but the source RECTANGLE. Once we have it we
 * re-extract at true 1:1 from the mural -- sharper than the snip ever was -- and
 * ship the rectangle instead of the artwork, so mapkit can rebuild the tileset
 * from the player's own file and nothing copyrighted is distributed.
 *
 * COARSE STAGE: colour signature.
 *   Sliding a resampled template everywhere at every scale is slow and fragile.
 *   Colour composition, though, is scale-INVARIANT: resampling invents in-between
 *   colours but preserves the dominant ones and roughly their proportions. So
 *   each cut gets a signature of quantised colours weighted by how RARE they are
 *   in the mural (a TF-IDF weighting -- the red/yellow of the hazard stripe is
 *   worth far more than another patch of grey). That becomes a per-pixel score
 *   map over the mural, and an integral image makes the mean score of any
 *   candidate rectangle O(1). Colours absent from the signature score negative,
 *   so a region full of the right colours and nothing else wins.
 *
 * FINE STAGE: normalised cross correlation at full resolution around the peaks,
 *   refining scale and offset. NCC rather than a difference metric, because a
 *   screen capture drifts in brightness and contrast.
 *
 * Usage: node tools/locate-cuts.js [--only <substring>] [--sdk <path>]
 * Output: tiles/manual/provenance.json
 */
const path = require('path'), fs = require('fs');
const P = require('../lib/png.js');

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const ONLY = arg('--only', null);
const SDK = arg('--sdk', path.join(__dirname, '..', '..', 'scratch-work', 'johnny-upgrade-sdk'));
const SRC = path.join(__dirname, '..', 'tiles', 'manual');
const MURAL = path.join(SDK, 'assets', 'pics', 'lvlGrfx.png');

const ART_X0 = 1620, ART_Y0 = 720;
/*
 * Coarse downsample. Chosen PER TILE rather than fixed: a thin strip like
 * blue_beam_surface (16px tall) shrinks to a single coarse pixel at /4 and stops
 * being discriminative, which is why the strips all scored low. Thin cuts get a
 * finer grid; chunky ones keep /4 so the scan stays cheap.
 *
 * A tile's plausible scale is also bounded by its own size -- a 16px-tall cut
 * cannot be a 6x magnification of a 2.6px source -- so the scale list is clipped
 * per tile to keep the source at least MIN_SRC px on its short side.
 */
const MIN_SRC = 10;
const pickD = (cut) => {
  const short = Math.min(cut.W, cut.H);
  if (short < 40) return 1;
  if (short < 90) return 2;
  return 4;
};
const SCALES = [];                 // cut is SCALE x the source region
for (let s = 0.4; s <= 6.01; s += 0.1) SCALES.push(Number(s.toFixed(2)));
const PEAKS = 24;                  // coarse peaks carried into refinement
const SIG_BINS = 16;               // colours kept in a cut's signature (one integral image each)

// 4 bits per channel: coarse enough that interpolated colours land in the same
// bin as the colour they came from, fine enough to stay discriminative.
const quant = (r, g, b) => ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);

function muralHistogram(img) {
  const h = new Float64Array(4096);
  let total = 0;
  const { W, H, data } = img;
  for (let i = 0, o = 0; i < W * H; i++, o += 4) {
    if (data[o + 3] < 128) continue;
    h[quant(data[o], data[o + 1], data[o + 2])]++;
    total++;
  }
  return { h, total };
}

/*
 * A cut's signature: the bins it is actually made of, ranked by how rare they
 * are in the mural, keeping each bin's FRACTION of the cut.
 *
 * The fraction matters. Scoring a window by the mean "is this a signature
 * colour" score rewards small windows that sit entirely inside one signature
 * colour, which biases every match toward the smallest window and so toward the
 * largest scale -- it drove every rock tile to 3.3-4.4x. Comparing
 * distributions instead is genuinely scale-invariant: a window that is all one
 * colour cannot match a cut that is a spread of several.
 */
function signature(cut, mh) {
  const h = new Float64Array(4096);
  let total = 0;
  const { W, H, data } = cut;
  for (let i = 0, o = 0; i < W * H; i++, o += 4) {
    if (data[o + 3] < 128) continue;
    h[quant(data[o], data[o + 1], data[o + 2])]++;
    total++;
  }
  const bins = [];
  for (let b = 0; b < 4096; b++) {
    if (!h[b]) continue;
    const frac = h[b] / total;
    if (frac < 0.004) continue;                       // ignore stray colours
    const inMural = mh.h[b] / mh.total;
    if (inMural === 0) continue;                      // absent: carries no location
    bins.push({ b, frac, rarity: Math.log(1 / Math.max(inMural, 1e-7)) });
  }
  // rank by contribution (common in this cut, uncommon in the mural), keep fractions
  bins.sort((a, b) => b.frac * b.rarity - a.frac * a.rarity);
  return bins.slice(0, SIG_BINS);
}

/*
 * One integral image per signature bin, at 1/D, so the colour histogram of any
 * candidate rectangle is O(bins) instead of O(area).
 */
function binIntegrals(img, bins, d) {
  const w = Math.floor(img.W / d), h = Math.floor(img.H / d);
  const idx = new Int16Array(4096).fill(-1);
  bins.forEach((bn, k) => { idx[bn.b] = k; });
  const K = bins.length;
  const planes = Array.from({ length: K }, () => new Float32Array((w + 1) * (h + 1)));
  const counts = new Float32Array(K);
  for (let y = 0; y < h; y++) {
    counts.fill(0);
    for (let x = 0; x < w; x++) {
      for (let j = 0; j < d; j++) for (let i = 0; i < d; i++) {
        const sx = x * d + i, sy = y * d + j;
        if (sx >= img.W || sy >= img.H) continue;
        const o = (sy * img.W + sx) * 4;
        if (img.data[o + 3] < 128) continue;
        const k = idx[quant(img.data[o], img.data[o + 1], img.data[o + 2])];
        if (k >= 0) counts[k]++;
      }
      for (let k = 0; k < K; k++) {
        planes[k][(y + 1) * (w + 1) + x + 1] = planes[k][y * (w + 1) + x + 1] + counts[k];
      }
    }
  }
  const box = (k, x, y, bw, bh) => {
    const S = planes[k];
    return S[(y + bh) * (w + 1) + x + bw] - S[y * (w + 1) + x + bw]
      - S[(y + bh) * (w + 1) + x] + S[y * (w + 1) + x];
  };
  return { w, h, K, box };
}

// Histogram intersection in [0,1]: how much of the cut's distribution the window
// actually reproduces. Penalises both missing colour and excess of one colour.
function intersect(BI, bins, x, y, bw, bh, d) {
  const area = bw * bh * d * d;
  let score = 0;
  for (let k = 0; k < BI.K; k++) {
    const frac = BI.box(k, x, y, bw, bh) / area;
    score += Math.min(frac, bins[k].frac);
  }
  return score;
}

function grayResize(img, w, h) {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sx0 = Math.floor(x * img.W / w), sx1 = Math.max(sx0 + 1, Math.floor((x + 1) * img.W / w));
    const sy0 = Math.floor(y * img.H / h), sy1 = Math.max(sy0 + 1, Math.floor((y + 1) * img.H / h));
    let s = 0, n = 0;
    for (let sy = sy0; sy < sy1 && sy < img.H; sy++) for (let sx = sx0; sx < sx1 && sx < img.W; sx++) {
      const o = (sy * img.W + sx) * 4, a = img.data[o + 3] / 255;
      s += (0.299 * img.data[o] + 0.587 * img.data[o + 1] + 0.114 * img.data[o + 2]) * a;
      n++;
    }
    out[y * w + x] = n ? s / n : 0;
  }
  return { w, h, d: out };
}

function scoreFull(muralGray, cut, ox, oy, sw, sh) {
  if (ox < 0 || oy < 0 || ox + sw > muralGray.w || oy + sh > muralGray.h) return -1;
  const T = grayResize(cut, sw, sh);
  const n = sw * sh;
  let mt = 0, mw = 0;
  for (let i = 0; i < n; i++) mt += T.d[i];
  mt /= n;
  for (let j = 0; j < sh; j++) for (let i = 0; i < sw; i++) mw += muralGray.d[(oy + j) * muralGray.w + ox + i];
  mw /= n;
  let dot = 0, nt = 0, nw = 0;
  for (let j = 0; j < sh; j++) for (let i = 0; i < sw; i++) {
    const a = T.d[j * sw + i] - mt;
    const b = muralGray.d[(oy + j) * muralGray.w + ox + i] - mw;
    dot += a * b; nt += a * a; nw += b * b;
  }
  return (nt < 1e-6 || nw < 1e-6) ? -1 : dot / Math.sqrt(nt * nw);
}

function main() {
  if (!fs.existsSync(MURAL)) { console.error('no mural at ' + MURAL); process.exit(1); }
  const mural = P.readPNG(MURAL);
  const mh = muralHistogram(mural);
  const gray = grayResize(mural, mural.W, mural.H);
  console.log('mural ' + mural.W + 'x' + mural.H + ', coarse downsample per tile, scales ' +
    SCALES[0] + '-' + SCALES[SCALES.length - 1] + 'x\n');

  const cfgPath = path.join(SRC, 'normalize.config.json');
  const config = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {};
  let files = fs.readdirSync(SRC).filter((f) => f.endsWith('.png') && !f.startsWith('_')).sort();
  if (ONLY) files = files.filter((f) => f.includes(ONLY));

  console.log('name'.padEnd(49) + 'scale'.padStart(7) + 'art x,y'.padStart(14) +
    'world x,y'.padStart(15) + 'src w x h'.padStart(12) + '    ncc');
  const out = [];
  for (const f of files) {
    const name = f.replace(/\.png$/, '');
    const cfg = config[name] || {};
    if (cfg.exclude ?? /example/i.test(name)) continue;
    const cut = P.readPNG(path.join(SRC, f));

    const bins = signature(cut, mh);
    if (!bins.length) { console.log('  ' + name.slice(0, 46).padEnd(47) + '  no usable colour signature'); continue; }
    const D = pickD(cut);
    const maxScale = Math.max(1, Math.min(cut.W, cut.H) / MIN_SRC);
    const scales = SCALES.filter((s) => s <= maxScale);
    const BI = binIntegrals(mural, bins, D);

    // coarse: best scoring rectangles across scale and position
    let peaks = [];
    for (const s of scales) {
      const bw = Math.round(cut.W / s / D), bh = Math.round(cut.H / s / D);
      if (bw < 4 || bh < 4 || bw > BI.w || bh > BI.h) continue;
      for (let y = 0; y + bh <= BI.h; y++) for (let x = 0; x + bw <= BI.w; x++) {
        const v = intersect(BI, bins, x, y, bw, bh, D);
        if (peaks.length < PEAKS) { peaks.push({ v, s, x: x * D, y: y * D }); peaks.sort((a, b) => a.v - b.v); }
        else if (v > peaks[0].v) { peaks[0] = { v, s, x: x * D, y: y * D }; peaks.sort((a, b) => a.v - b.v); }
      }
    }
    if (!peaks.length) { console.log('  ' + name.slice(0, 46).padEnd(47) + '  no viable window'); continue; }
    peaks.reverse();

    // fine: refine scale and offset at full resolution around each peak
    let win = null;
    for (const p of peaks) {
      for (let ds = -0.12; ds <= 0.121; ds += 0.04) {
        const s = p.s * (1 + ds);
        const sw = Math.round(cut.W / s), sh = Math.round(cut.H / s);
        if (sw < 8 || sh < 8) continue;
        for (let dy = -D; dy <= D; dy += 2) for (let dx = -D; dx <= D; dx += 2) {
          const v = scoreFull(gray, cut, p.x + dx, p.y + dy, sw, sh);
          if (v > 0 && (!win || v > win.ncc)) win = { ncc: v, x: p.x + dx, y: p.y + dy, s, sw, sh };
        }
      }
    }
    if (!win) { console.log('  ' + name.slice(0, 46).padEnd(47) + '  no match'); continue; }

    const [cl, ct, cr, cb] = cfg.crop || [0, 0, 0, 0];
    const rect = {
      x: win.x + Math.round(cl / win.s), y: win.y + Math.round(ct / win.s),
      w: win.sw - Math.round((cl + cr) / win.s), h: win.sh - Math.round((ct + cb) / win.s),
    };
    out.push({ name, scale: Number(win.s.toFixed(3)), ncc: Number(win.ncc.toFixed(3)),
      art: rect, world: { x: rect.x - ART_X0, y: rect.y - ART_Y0, w: rect.w, h: rect.h } });
    console.log('  ' + name.slice(0, 46).padEnd(47) + win.s.toFixed(2).padStart(6) + 'x' +
      (rect.x + ',' + rect.y).padStart(14) +
      ((rect.x - ART_X0) + ',' + (rect.y - ART_Y0)).padStart(15) +
      (rect.w + 'x' + rect.h).padStart(12) + win.ncc.toFixed(3).padStart(9) +
      (win.ncc < 0.8 ? '  LOW' : ''));
  }

  // Merge rather than overwrite, so a --only run refines a few tiles without
  // discarding everything located in a previous full run.
  const provPath = path.join(SRC, 'provenance.json');
  let merged = out;
  if (fs.existsSync(provPath)) {
    const prev = JSON.parse(fs.readFileSync(provPath, 'utf8'));
    const byName = new Map(prev.map((p) => [p.name, p]));
    for (const o of out) {
      const old = byName.get(o.name);
      // A rect confirmed by hand in the aligner always wins. Automated matching
      // exists to seed that work, never to undo it.
      if (old && old.confirmed) continue;
      // otherwise keep whichever scored better, so a worse re-run cannot regress a tile
      if (!old || o.ncc >= old.ncc) byName.set(o.name, o);
    }
    merged = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
  fs.writeFileSync(provPath, JSON.stringify(merged, null, 2) + '\n');
  console.log('\nthis run located ' + out.length + ' tiles, ' +
    out.filter((o) => o.ncc >= 0.8).length + ' with ncc >= 0.80');
  console.log('provenance.json now holds ' + merged.length + ' tiles, ' +
    merged.filter((o) => o.ncc >= 0.8).length + ' with ncc >= 0.80');
}

main();
