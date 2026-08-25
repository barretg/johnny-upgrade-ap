/*
 * Reconstruct the grass texture, including the part the rocks hide.
 *
 * The mural stamps this grass three times, at (807,994), (1649,1055) and
 * (1061,1055) -- verified as the same artwork by comparing clean pixels, which
 * match to a mean absolute difference of 0 and 6.5 and 8.1. In every copy the
 * base of the grass is covered by a row of rocks, but the rocks sit at different
 * places in each, so where one copy is occluded another often is not.
 *
 * So the reconstruction is in two parts:
 *
 *   1. UNION across the three copies. For each pixel take the median of whichever
 *      copies are clean there. This recovers everything the mural actually
 *      contains -- 26 rows, three more than any single copy gives.
 *
 *   2. SYNTHESIS below that. All three copies are occluded from row 26 down, so
 *      nothing there exists to recover; it has to be invented. Measuring the base
 *      band shows it is essentially two colours, rgb(151,162,21) and
 *      rgb(115,150,7), in vertical stripes, so continuing each column downward
 *      from its last clean pixel reproduces the striping rather than inventing
 *      structure. Synthesised rows are the only guesswork here and are reported
 *      as such.
 *
 * Usage: node tools/reconstruct-grass.js [--extend 8] [--sdk <path>]
 */
const path = require('path'), fs = require('fs');
const P = require('../lib/png.js');

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? Number(argv[i + 1]) : d; };
const SDKa = argv.indexOf('--sdk');
const SDK = SDKa >= 0 ? argv[SDKa + 1] : path.join(__dirname, '..', '..', 'scratch-work', 'johnny-upgrade-sdk');
const EXTEND = arg('--extend', 8);
const OUT = path.join(__dirname, '..', 'tiles', 'extracted');

const SOURCES = [{ x: 807, y: 994 }, { x: 1649, y: 1055 }, { x: 1061, y: 1055 }];
const TW = 149;          // stamp width
const RECOVERABLE = 26;  // rows the union can actually recover

const mural = P.readPNG(path.join(SDK, 'assets', 'pics', 'lvlGrfx.png'));
const { W, H, data } = mural;
const at = (x, y) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return null;
  const o = (y * W + x) * 4;
  return [data[o], data[o + 1], data[o + 2], data[o + 3]];
};
const isLit = (r, g, b, a) => a >= 128 && (0.299 * r + 0.587 * g + 0.114 * b) > 30;

/*
 * What counts as grass, and therefore what counts as an occluder.
 *
 * Testing for "warm brown" is not enough: the occluders here are brown rocks AND
 * grey stones -- rgb(145,145,145), rgb(80,80,80), rgb(66,66,66) all sit in the
 * base band and survive a warm-only test, which left them baked into the result.
 *
 * Grass is reliably green in both its shades: rgb(151,162,21) and rgb(115,150,7)
 * both clear g >= r+4 and g >= b+15, while every grey fails the first test and
 * every brown fails it too. So the robust rule is "is it green", not "is it rock".
 */
const isGrass = (r, g, b) => g >= r + 4 && g >= b + 15;
const isOccluder = (r, g, b) => !isGrass(r, g, b);

function main() {
  const TH = RECOVERABLE + EXTEND;
  const out = Buffer.alloc(TW * TH * 4);
  const put = (i, j, px) => {
    const o = (j * TW + i) * 4;
    out[o] = px[0]; out[o + 1] = px[1]; out[o + 2] = px[2]; out[o + 3] = 255;
  };

  // --- 1. union of the three copies -------------------------------------
  let recovered = 0, holes = 0;
  const lastClean = new Array(TW).fill(null);
  for (let j = 0; j < RECOVERABLE; j++) {
    for (let i = 0; i < TW; i++) {
      const samples = [];
      let occluded = false;
      for (const s of SOURCES) {
        const px = at(s.x + i, s.y + j);
        if (!px) continue;
        const [r, g, b, a] = px;
        if (!isLit(r, g, b, a)) continue;          // empty sky: a genuine gap
        if (isOccluder(r, g, b)) { occluded = true; continue; }
        samples.push([r, g, b]);
      }
      if (!samples.length) {
        // Only fill where something was actually COVERING the grass. Where every
        // copy is empty this is a real gap between blades and must stay
        // transparent -- filling those turned the silhouette into a solid block.
        if (occluded) holes++;
        continue;
      }
      // median per channel: robust to one copy carrying an artefact
      const med = [0, 1, 2].map((c) => {
        const v = samples.map((s) => s[c]).sort((a, b) => a - b);
        return v[v.length >> 1];
      });
      put(i, j, med);
      lastClean[i] = med;
      recovered++;
    }
  }

  // --- 2. synthesise the occluded base ----------------------------------
  // Continue each column from its last clean pixel. The base band is vertical
  // striping in two colours, so this reproduces it rather than inventing shape.
  let synthesised = 0;
  for (let j = RECOVERABLE; j < TH; j++) {
    for (let i = 0; i < TW; i++) {
      if (!lastClean[i]) continue;
      put(i, j, lastClean[i]);
      synthesised++;
    }
  }
  /*
   * Fill only the pixels that were occluded in every copy, and only those --
   * a pixel where all three copies are empty is a gap between blades, not a
   * hidden one, and must stay transparent.
   */
  let filled = 0;
  for (let j = 0; j < RECOVERABLE; j++) {
    for (let i = 0; i < TW; i++) {
      const o = (j * TW + i) * 4;
      if (out[o + 3] >= 128) continue;
      let occluded = false;
      for (const s of SOURCES) {
        const px = at(s.x + i, s.y + j);
        if (px && isLit(...px) && isOccluder(px[0], px[1], px[2])) { occluded = true; break; }
      }
      if (!occluded) continue;
      for (let k = j - 1; k >= 0; k--) {
        const p = (k * TW + i) * 4;
        if (out[p + 3] >= 128) { put(i, j, [out[p], out[p + 1], out[p + 2]]); filled++; break; }
      }
    }
  }
  holes = filled;

  fs.mkdirSync(OUT, { recursive: true });
  P.writePNG(path.join(OUT, 'grass_surface.png'), TW, TH, out);

  // Register in the extracted manifest, so sheets and the editor palette see it.
  // It is a derived tile rather than a single rect, so it carries its sources
  // instead of one `art` rectangle -- mapkit replays this the same way.
  const mf = path.join(OUT, 'manifest.json');
  const man = fs.existsSync(mf) ? JSON.parse(fs.readFileSync(mf, 'utf8')) : [];
  const entry = { name: 'grass_surface', w: TW, h: TH,
    composite: { sources: SOURCES.map((s) => ({ x: s.x, y: s.y, w: TW, h: RECOVERABLE })),
      rule: 'green-union', extend: EXTEND },
    note: 'reconstructed', clipped: [] };
  const at_ = man.findIndex((m) => m.name === 'grass_surface');
  if (at_ >= 0) man[at_] = entry; else man.push(entry);
  man.sort((a, b) => a.name.localeCompare(b.name));
  fs.writeFileSync(mf, JSON.stringify(man, null, 2) + '\n');

  const total = TW * TH;
  console.log('grass_surface  ' + TW + 'x' + TH);
  console.log('  recovered from the mural : ' + recovered + ' px  (rows 0-' + (RECOVERABLE - 1) + ')');
  console.log('  synthesised base         : ' + synthesised + ' px  (rows ' + RECOVERABLE + '-' + (TH - 1) + ')');
  console.log('  holes filled by column   : ' + holes + ' px');
  console.log('  -> ' + Math.round(100 * recovered / total) + '% real, ' +
    Math.round(100 * synthesised / total) + '% invented');
  console.log('\nwrote tiles/extracted/grass_surface.png');
}

main();
