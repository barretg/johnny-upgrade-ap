#!/usr/bin/env node
/*
 * Cover every spike rect in a map with the hazard texture.
 *
 * Spikes are the only lethal thing the runtime does not draw. `mapkit/renderer.js`
 * fills platforms flat black, so an untextured platform is merely plain -- an
 * untextured spike rect is an invisible instant death. A map is not finished while
 * one exists.
 *
 * The tiling itself lives in editor-core (`_geom.autotileSpikes`), so this and the
 * editor's "fill spikes" button are the same code. Two implementations of "where
 * do the spike tiles go" would be two sets of gaps, and a gap between two spike
 * strips reads as a safe step and is not one.
 *
 *   node mapeditor/tools/autotile-spikes.js mapeditor/maps/generated-1.json
 *   node mapeditor/tools/autotile-spikes.js <map> --dry     # count, write nothing
 *
 * Idempotent: a spike rect that already has art over its centre is left alone, so
 * this is safe to run twice and safe over hand-textured work.
 */
const fs = require('fs');
const path = require('path');

const { _geom } = require('../editor/editor-core.js');
const MapFormat = require('../../mapkit/mapformat.js');

function main(argv) {
  const args = argv.slice(2);
  const dry = args.includes('--dry');
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) {
    console.error('usage: autotile-spikes.js <map.json> [--dry]');
    process.exit(2);
  }
  const full = path.resolve(file);
  const game = JSON.parse(fs.readFileSync(full, 'utf8'));

  /*
   * Round-tripped through MapFormat rather than poked at directly: a map file is
   * the GAME's shape (flat parallel arrays), and the editor's object list is what
   * the tiler understands. fromGame/toGame is the one place that conversion is
   * written down, and doing it a second time here by hand is how the two drift.
   */
  const m = MapFormat.fromGame(game, 1);
  const made = _geom.autotileSpikes(m.objects, _geom.SPIKE_TILE);

  const spikes = m.objects.filter((o) => o.kind === 'spike').length;
  if (!made.length) {
    console.log(path.basename(full) + ': ' + spikes + ' spike rects, all already textured');
    return;
  }
  console.log(path.basename(full) + ': ' + spikes + ' spike rects -> ' +
              made.length + ' tiles' + (dry ? ' (dry run, nothing written)' : ''));
  if (dry) return;

  let id = m.nextId;
  for (const o of made) { o.id = id++; m.objects.push(o); }
  const out = MapFormat.toGame({ meta: m.meta, objects: m.objects, yEnd: m.yEnd });
  fs.writeFileSync(full, JSON.stringify(out, null, 1) + '\n');
  console.log('wrote ' + path.relative(process.cwd(), full));
}

if (require.main === module) main(process.argv);
module.exports = { main };
