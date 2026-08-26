/*
 * Build the editor's texture palette from the shipped recipe.
 *
 * tools/extract-from-mural.js needs tiles/manual/ -- the hand cuts, provenance
 * and normalise config -- none of which is in the repo, because it is all either
 * artwork or derived from it. That makes it useless on a fresh checkout, which
 * is exactly the situation a container starts in.
 *
 * mapkit/tiles.json IS the recipe, though, and it is tracked: source rectangles
 * plus normalise settings, no artwork. This replays it against a local copy of
 * the game and writes tiles/extracted/, so a container can build its own palette
 * from nothing but the SDK the operator mounted.
 *
 * It also runs the exact code the browser runs (mapkit/tiles.js), so what the
 * editor shows and what a player sees cannot drift.
 *
 * Usage: node tools/build-tiles-from-recipe.js [--sdk <path>]
 */
const path = require('path');
const fs = require('fs');
const P = require('../lib/png.js');
const T = require('../../mapkit/tiles.js');

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const ROOT = path.join(__dirname, '..');
const SDK = arg('--sdk', process.env.JU_SDK || path.join(ROOT, '..', 'scratch-work', 'johnny-upgrade-sdk'));
const RECIPE = path.join(ROOT, '..', 'mapkit', 'tiles.json');
const OUT = path.join(ROOT, 'tiles', 'extracted');

// png.js speaks {W,H,data}; mapkit/tiles.js speaks ImageData's {width,height,data}
const toPng = (img) => ({ W: img.width, H: img.height, data: Buffer.from(img.data) });

function main() {
  if (!fs.existsSync(RECIPE)) {
    console.error('no recipe at ' + RECIPE);
    process.exit(1);
  }
  const recipe = JSON.parse(fs.readFileSync(RECIPE, 'utf8'));
  const S = recipe.slice;

  const slicePaths = S.keys.map((k) => path.join(SDK, 'assets', 'pics', k + '.png'));
  const missing = slicePaths.filter((p) => !fs.existsSync(p));
  if (missing.length) {
    console.error('missing game artwork:');
    for (const m of missing) console.error('  ' + m);
    console.error('\nPoint --sdk (or JU_SDK) at a copy of the game.');
    process.exit(1);
  }
  const slices = slicePaths.map((p) => P.readPNG(p));

  /*
   * Stitch a mural rect out of the six slices. The shipped game never loads the
   * whole mural, only lvlGrfx1..6 laid out 3 across and 2 down, and a rect can
   * straddle up to four of them.
   */
  function region(x, y, w, h) {
    const out = T.make(w, h);
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const X = x + i, Y = y + j;
        const col = Math.floor(X / S.w), row = Math.floor(Y / S.h);
        if (col < 0 || col >= S.cols || row < 0 || row >= S.rows) continue;
        const im = slices[row * S.cols + col];
        if (!im) continue;
        const lx = X - col * S.w, ly = Y - row * S.h;
        if (lx < 0 || ly < 0 || lx >= im.W || ly >= im.H) continue;
        const so = (ly * im.W + lx) * 4, d = (j * w + i) * 4;
        for (let k = 0; k < 4; k++) out.data[d + k] = im.data[so + k];
      }
    }
    return out;
  }
  const one = (x, y) => {
    const r = region(x, y, 1, 1);
    return [r.data[0], r.data[1], r.data[2], r.data[3]];
  };

  fs.mkdirSync(OUT, { recursive: true });
  const manifest = [];

  for (const t of recipe.tiles) {
    const img = T.normalize(region(t.rect.x, t.rect.y, t.rect.w, t.rect.h), t.norm, recipe.defaults);
    const png = toPng(img);
    P.writePNG(path.join(OUT, t.name + '.png'), png.W, png.H, png.data);
    manifest.push({ name: t.name, w: png.W, h: png.H, art: t.rect });
  }
  for (const c of recipe.composites || []) {
    const img = T.composite(c, one);
    const png = toPng(img);
    P.writePNG(path.join(OUT, c.name + '.png'), png.W, png.H, png.data);
    manifest.push({ name: c.name, w: png.W, h: png.H, composite: true });
  }

  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log('built ' + manifest.length + ' tiles into tiles/extracted/ from mapkit/tiles.json');
}

main();
