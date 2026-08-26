/*
 * Build the tile recipe that ships with mapkit.
 *
 * We cannot distribute Coolmath/Miniclip's artwork, so what ships is a set of
 * INSTRUCTIONS for rebuilding the tiles from the player's own copy of the game:
 * a source rectangle per tile plus the normalise settings it needs. A few KB of
 * numbers instead of a folder of PNGs.
 *
 * One wrinkle the recipe has to carry: the shipped game never loads the full
 * 5130x3330 mural. It loads six 1710x1665 slices, lvlGrfx1..6, laid out 3 across
 * and 2 down. So the runtime stitches rects out of those, and a rect can span up
 * to four of them. Verified byte-identical against the mural for all 29 tiles.
 *
 * Usage: node tools/build-tile-recipe.js
 * Output: mapkit/tiles.json
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const CUTS = path.join(ROOT, 'tiles', 'manual');
const OUT = path.join(ROOT, '..', 'mapkit', 'tiles.json');

const SLICE_W = 1710;
const SLICE_H = 1665;

function main() {
  const prov = JSON.parse(fs.readFileSync(path.join(CUTS, 'provenance.json'), 'utf8'));
  const cfgAll = JSON.parse(fs.readFileSync(path.join(CUTS, 'normalize.config.json'), 'utf8'));

  const tiles = [];
  for (const p of prov) {
    const cfg = cfgAll[p.name] || {};
    if (cfg.exclude) continue;
    if (!p.confirmed) {
      console.warn('  skipping unconfirmed rect: ' + p.name);
      continue;
    }
    // only the fields the runtime normaliser actually reads
    const norm = {};
    for (const k of ['mode', 'luma', 'chroma', 'bg', 'tol', 'pockets', 'crop', 'mask']) {
      if (cfg[k] !== undefined) norm[k] = cfg[k];
    }
    tiles.push({ name: p.name, rect: p.art, norm });
  }

  /*
   * Composite tiles are not a single rect.
   *
   * grass_surface is a union across three copies of the same stamp -- the mural
   * repeats it, and the rocks occlude a different part of each -- plus eight rows
   * synthesised below, because all three are covered there and nothing exists to
   * recover. See tools/reconstruct-grass.js for how that was derived.
   */
  const composites = [{
    name: 'grass_surface',
    width: 149,
    recovered: 26,
    extend: 8,
    sources: [{ x: 807, y: 994 }, { x: 1649, y: 1055 }, { x: 1061, y: 1055 }],
    rule: 'green',      // a pixel counts as grass when g >= r+4 and g >= b+15
  }];

  const recipe = {
    version: 1,
    note: 'Rebuilds the tileset from the player\'s own lvlGrfx1..6. No artwork included.',
    slice: { w: SLICE_W, h: SLICE_H, cols: 3, rows: 2, keys: ['lvlGrfx1','lvlGrfx2','lvlGrfx3','lvlGrfx4','lvlGrfx5','lvlGrfx6'] },
    defaults: { luma: 14, chroma: 12 },
    tiles,
    composites,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(recipe, null, 2) + '\n');

  const bytes = fs.statSync(OUT).size;
  console.log('wrote mapkit/tiles.json');
  console.log('  ' + tiles.length + ' rect tiles, ' + composites.length + ' composite');
  console.log('  ' + (bytes / 1024).toFixed(1) + ' KB, no artwork');
  const spanning = tiles.filter((t) => {
    const r = t.rect;
    return Math.floor(r.x / SLICE_W) !== Math.floor((r.x + r.w - 1) / SLICE_W)
        || Math.floor(r.y / SLICE_H) !== Math.floor((r.y + r.h - 1) / SLICE_H);
  });
  console.log('  ' + spanning.length + ' tiles span a slice boundary and need stitching');
}

main();
