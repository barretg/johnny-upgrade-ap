/*
 * Normalise the hand-cut tiles into exact, tightly-bounded textures.
 *
 * The hand cuts are close but not pixel-exact: each is an opaque rectangular
 * crop straight out of the mural, so it carries a margin of the surrounding
 * black body. Black is the base-block colour, so that margin is background, not
 * texture -- but only where it is CONNECTED TO THE BORDER. Plenty of these
 * textures have legitimately black interiors (the metal surfaces, the black
 * square at the centre of x_center_surface), and a naive "make black
 * transparent" would hollow them out.
 *
 * So: flood-fill near-black inward from the border, then trim to what is left.
 *
 * Anti-aliased edges are handled by a second pass -- a pixel adjacent to removed
 * background gets partial alpha scaled by how far above the black floor it is,
 * so edges stay soft instead of developing a hard black fringe when the texture
 * is later rotated or placed over a non-black background.
 *
 * Usage: node tools/normalize-manual.js [luma-threshold] [--pad]
 *   luma-threshold  what counts as background black (default 26)
 *   --pad           pad the result to centre the art on an even-sized canvas,
 *                   for textures where symmetry matters (corners, objects)
 */
const path = require('path'), fs = require('fs');
const P = require('../lib/png.js');

const SRC = path.join(__dirname, '..', 'tiles', 'manual');
const OUT = path.join(__dirname, '..', 'tiles', 'normalized');
const THRESH = Number(process.argv.find((a) => /^\d+$/.test(a)) || 26);
const PAD = process.argv.includes('--pad');

const N = require('../lib/normalize.js');
const { luma, chroma, DEFAULT_LUMA, DEFAULT_CHROMA, makeIsBackground, backgroundMask,
  pocketMask, feather, trim, cropMargins, padEven } = N;
const loadConfig = () => N.loadConfig(SRC);

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const files = fs.readdirSync(SRC).filter((f) => f.endsWith('.png') && !f.startsWith('_')).sort();
  console.log('normalising ' + files.length + ' tiles  (default luma <= ' + DEFAULT_LUMA + ', chroma <= ' + DEFAULT_CHROMA + ')' + (PAD ? ', padded even' : '') + '\n');
  console.log('name'.padEnd(56) + '     before        after      trimmed L/T/R/B');
  const config = loadConfig();
  const manifest = [];
  for (const f of files) {
    const name = f.replace(/\.png$/, '');
    const cfg = config[name] || {};
    // Reference crops showing how the original map stretched a tile, not tiles.
    const auto = /example/i.test(name);
    if (cfg.exclude ?? auto) {
      console.log('  ' + name.padEnd(54) + '  excluded (' +
        (cfg.exclude ? 'superseded by another cut' : 'reference crop, not a tile') + ')');
      continue;
    }
    let src = P.readPNG(path.join(SRC, f));
    if (cfg.crop) src = cropMargins(src, cfg.crop);
    const lumaCut = cfg.luma ?? DEFAULT_LUMA;
    const chromaCut = cfg.chroma ?? DEFAULT_CHROMA;
    let t, removedPct = 0, note;
    if (cfg.mode === 'none') {
      t = trim(src) || src;
      note = 'trim only';
    } else {
      const isBg = makeIsBackground(cfg, lumaCut, chromaCut);
      let bg = backgroundMask(src, isBg);
      if (cfg.pockets) bg = pocketMask(src, bg, isBg);
      let bgPx = 0; for (let i = 0; i < bg.length; i++) if (bg[i]) bgPx++;
      removedPct = Math.round(100 * bgPx / (src.W * src.H));
      t = trim(feather(src, bg, lumaCut));
      note = (cfg.bg ? 'exact' + (cfg.tol!==undefined?'/t'+cfg.tol:'') : 'L' + lumaCut + '/C' + chromaCut) + (cfg.pockets ? '+pockets' : '') + (cfg.crop ? '+crop' : '') + '  bg ' + removedPct + '%';
    }
    if (!t) { console.log('  ' + name.padEnd(54) + '  ALL BACKGROUND -- skipped'); continue; }
    const cut = t.trimmed || [0, 0, 0, 0];
    if (PAD) t = padEven(t);
    P.writePNG(path.join(OUT, name + '.png'), t.W, t.H, t.data);
    manifest.push({ name, w: t.W, h: t.H, from: [src.W, src.H], trimmed: cut, removedPct, note });
    console.log('  ' + name.padEnd(54) + (src.W + 'x' + src.H).padStart(11) +
      (t.W + 'x' + t.H).padStart(12) + '   ' + cut.join('/').padEnd(14) + note);
  }
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));

  // Drop outputs left behind by tiles that have since been excluded, so the
  // directory and the sheet always reflect the current config.
  const live = new Set(manifest.map((m) => m.name + '.png'));
  let stale = 0;
  for (const f of fs.readdirSync(OUT)) {
    if (!f.endsWith('.png') || f.startsWith('_') || live.has(f)) continue;
    fs.unlinkSync(path.join(OUT, f)); stale++;
    console.log('  removed stale output ' + f);
  }
  console.log('\nwrote ' + manifest.length + ' tiles to tiles/normalized/' +
    (stale ? ' (' + stale + ' stale removed)' : ''));
}

main();
