/*
 * Rebuild tiles from the mural using the located rectangles.
 *
 * This is the step the whole provenance effort exists for. We cannot distribute
 * Coolmath/Miniclip's artwork, so the shipped artefact is a RECIPE -- a source
 * rectangle plus the params in normalize.config.json -- and mapkit replays it
 * against the player's own lvlGrfx.png at load time.
 *
 * It also produces better tiles than the hand cuts. The snips are resampled
 * screen captures; these are cut at true 1:1 from the source, so they are sharper
 * and carry none of the interpolation the captures introduced.
 *
 * The normalisation is deliberately the SAME code the snip path uses
 * (lib/normalize.js), because mapkit has to reproduce it exactly.
 *
 * Note on `crop`: those margins are expressed in CUT pixels, but here we are in
 * mural pixels, so they are scaled by the tile's recovered scale factor.
 *
 * Usage: node tools/extract-from-mural.js [--all] [--sdk <path>]
 *   --all   include unconfirmed rects too (default: confirmed only)
 */
const path = require('path'), fs = require('fs');
const P = require('../lib/png.js');
const N = require('../lib/normalize.js');

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const ALL = argv.includes('--all');
const SDK = arg('--sdk', path.join(__dirname, '..', '..', 'scratch-work', 'johnny-upgrade-sdk'));
const CUTS = path.join(__dirname, '..', 'tiles', 'manual');
const OUT = path.join(__dirname, '..', 'tiles', 'extracted');
const MURAL = path.join(SDK, 'assets', 'pics', 'lvlGrfx.png');

function crop(src, x, y, w, h) {
  const d = Buffer.alloc(w * h * 4);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const sx = x + i, sy = y + j, o = (j * w + i) * 4;
    if (sx < 0 || sy < 0 || sx >= src.W || sy >= src.H) { d[o + 3] = 0; continue; }
    src.data.copy(d, o, (sy * src.W + sx) * 4, (sy * src.W + sx) * 4 + 4);
  }
  return { W: w, H: h, data: d };
}

/*
 * Is the rect cutting the texture off?
 *
 * The obvious test -- does content touch the rect's border -- is wrong. A rect
 * bounded deliberately tight to a texture's silhouette touches its border on
 * every side by definition, so that test just fires constantly and gets ignored.
 *
 * The question is not what is INSIDE the edge, it is what is immediately OUTSIDE
 * it in the mural. If the pixels just beyond are background, the bound is
 * complete and nothing was lost, however tight it is. If they are more texture,
 * something continues past the rect -- either the tile is clipped, or it abuts a
 * neighbouring object. Both want an eye on them; neither is fixable afterwards.
 */
function continuesPast(mural, rect, isBg) {
  const at = (x, y) => {
    if (x < 0 || y < 0 || x >= mural.W || y >= mural.H) return null;
    const o = (y * mural.W + x) * 4;
    if (mural.data[o + 3] < 128) return null;                    // transparent: background
    return isBg(mural.data[o], mural.data[o + 1], mural.data[o + 2]) ? null : true;
  };
  // sample two pixels out, to step over the anti-aliased boundary itself
  const frac = (pts) => {
    const seen = pts.filter((p) => p !== undefined);
    return seen.length ? seen.filter(Boolean).length / seen.length : 0;
  };
  const span = (n, f) => Array.from({ length: n }, (_, i) => f(i));
  const { x, y, w, h } = rect;
  const sides = [];
  if (frac(span(w, (i) => at(x + i, y - 2))) > 0.25) sides.push('top');
  if (frac(span(w, (i) => at(x + i, y + h + 1))) > 0.25) sides.push('bottom');
  if (frac(span(h, (i) => at(x - 2, y + i))) > 0.25) sides.push('left');
  if (frac(span(h, (i) => at(x + w + 1, y + i))) > 0.25) sides.push('right');
  return sides;
}

/*
 * Erase rectangles from the extracted region before normalisation.
 *
 * `crop` takes a margin off a whole side, which is the wrong shape of fix when a
 * neighbouring object only intrudes into a CORNER. The boss door is exactly that:
 * the metal beside it occupies columns 0-2 and rows 0-9 only, a 3x10 block, but
 * cropping 15 cut-pixels off the left removed roughly seven columns of the door's
 * own green all the way down.
 *
 * Masks are authored in the extracted region's own pixels -- that is, mural
 * pixels at 1:1, the coordinates this tool and the aligner both work in. Note the
 * snip path (normalize-manual.js) does not apply them: it operates on magnified
 * captures in a different pixel space, and it is a reference path now. The recipe
 * that ships is this one.
 */
function applyMasks(t, rects) {
  for (const [mx, my, mw, mh] of rects) {
    for (let j = my; j < my + mh; j++) {
      for (let i = mx; i < mx + mw; i++) {
        if (i < 0 || j < 0 || i >= t.W || j >= t.H) continue;
        t.data[(j * t.W + i) * 4 + 3] = 0;
      }
    }
  }
  return t;
}

function main() {
  const provPath = path.join(CUTS, 'provenance.json');
  if (!fs.existsSync(provPath)) { console.error('no provenance.json -- run the aligner first'); process.exit(1); }
  if (!fs.existsSync(MURAL)) { console.error('no mural at ' + MURAL); process.exit(1); }

  const prov = JSON.parse(fs.readFileSync(provPath, 'utf8'));
  const picked = ALL ? prov : prov.filter((p) => p.confirmed);
  if (!picked.length) {
    console.error('nothing to extract: ' + (ALL ? 'provenance is empty' :
      'no rects are marked confirmed (pass --all to use unconfirmed ones)'));
    process.exit(1);
  }

  fs.mkdirSync(OUT, { recursive: true });
  const mural = P.readPNG(MURAL);
  const config = N.loadConfig(CUTS);

  console.log('extracting ' + picked.length + (ALL ? '' : ' confirmed') + ' of ' + prov.length + ' tiles at 1:1\n');
  console.log('name'.padEnd(48) + 'mural rect'.padStart(17) + '   extracted' + '     from snip   delta');
  const manifest = [];
  for (const p of picked) {
    const cfg = config[p.name] || {};
    // Honour exclusions here too, not just in the snip path -- a tile dropped
    // because another cut supersedes it must not reappear in the shipped set.
    if (cfg.exclude ?? /example/i.test(p.name)) {
      console.log('  ' + p.name.slice(0, 46).padEnd(46) + '  excluded');
      continue;
    }
    let t = crop(mural, p.art.x, p.art.y, p.art.w, p.art.h);

    // crop margins are in cut pixels; convert to mural pixels
    if (cfg.crop) {
      const s = p.scale || 1;
      const m = cfg.crop.map((v) => Math.round(v * s));
      if (m.some((v) => v > 0)) {
        try { t = N.cropMargins(t, m); } catch (e) { console.error('  ' + p.name + ': ' + e.message); continue; }
      }
    }

    if (cfg.mask) t = applyMasks(t, cfg.mask);

    const lumaCut = cfg.luma ?? N.DEFAULT_LUMA;
    const chromaCut = cfg.chroma ?? N.DEFAULT_CHROMA;
    const isBg = N.makeIsBackground(cfg, lumaCut, chromaCut);
    const clipped = continuesPast(mural, p.art, isBg);
    let out, note;
    if (cfg.mode === 'none') {
      out = N.trim(t) || t;
      note = 'trim only';
    } else {
      let bg = N.backgroundMask(t, isBg);
      if (cfg.pockets) bg = N.pocketMask(t, bg, isBg);
      out = N.trim(N.feather(t, bg, lumaCut));
      note = cfg.bg ? 'exact' : 'L' + lumaCut + '/C' + chromaCut;
    }
    if (!out) { console.log('  ' + p.name.slice(0, 46).padEnd(46) + '  ALL BACKGROUND -- check the rect'); continue; }

    P.writePNG(path.join(OUT, p.name + '.png'), out.W, out.H, out.data);

    // compare against what the snip produced, as a sanity check on the rect
    const snipPath = path.join(__dirname, '..', 'tiles', 'normalized', p.name + '.png');
    let cmp = '—', delta = '';
    if (fs.existsSync(snipPath)) {
      const s = P.readPNG(snipPath);
      cmp = s.W + 'x' + s.H;
      // the snip is magnified, so compare aspect rather than size
      const ar1 = out.W / out.H, ar2 = s.W / s.H;
      const pct = Math.abs(ar1 - ar2) / ar2 * 100;
      delta = 'aspect ' + (pct < 3 ? 'ok' : pct.toFixed(0) + '% off');
    }
    manifest.push({ name: p.name, w: out.W, h: out.H, art: p.art, scale: p.scale, note, clipped });
    console.log('  ' + p.name.slice(0, 46).padEnd(46) +
      (p.art.x + ',' + p.art.y + ' ' + p.art.w + 'x' + p.art.h).padStart(19) +
      ('  ' + out.W + 'x' + out.H).padStart(12) + cmp.padStart(13) + '   ' +
      (clipped.length ? 'continues: ' + clipped.join('+') : delta));
  }

  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log('\nwrote ' + manifest.length + ' tiles to tiles/extracted/');

  /*
   * Which clipping actually matters depends on what the tile is.
   *
   * A SURFACE is cut from a longer run and gets stretched to whatever face it is
   * applied to, so its texture continuing past the left and right edges is
   * expected -- flagging it would be noise. Its top and bottom are the real
   * silhouette and must be contained.
   *
   * A corner or a discrete object has a silhouette on every side, so any edge
   * contact is suspect.
   */
  const isRun = (n) => /surface|beam|block|rail|rope/.test(n) && !/corner/.test(n);
  const real = manifest
    .map((m) => {
      // A run continues along its LONG axis -- that is what makes it a run. Which
      // sides those are depends on orientation, not on the name: green_beam_surface
      // and rope are vertical, so their run continues top and bottom, exactly where
      // a horizontal surface continues left and right. Judging by name alone flagged
      // every vertical surface as clipped.
      const along = m.w >= m.h ? ['left', 'right'] : ['top', 'bottom'];
      const sides = m.clipped.filter((s) => !(isRun(m.name) && along.includes(s)));
      return { name: m.name, sides };
    })
    .filter((m) => m.sides.length);

  if (!real.length) {
    console.log('\nevery rect is bounded by background -- nothing is being cut off.');
    return;
  }
  console.log('\n' + real.length + ' rect(s) have texture continuing past an edge:');
  for (const r of real) console.log('  ' + r.name.slice(0, 46).padEnd(48) + r.sides.join(' + '));
  console.log('\nEither the tile is clipped there, or it abuts a neighbouring object.');
  console.log('Clipped -> grow the rect. Abutting -> the rect is right, and `crop` is the');
  console.log('lever if the neighbour bleeds in. Neither is fixable after extraction.');
}

main();
