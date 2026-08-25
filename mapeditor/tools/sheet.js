/*
 * Generic contact sheet for any extractor output directory that has a
 * manifest.json of { name, w, h, uses? } entries.
 *
 *   node tools/sheet.js patterns 40 6
 *   node tools/sheet.js textures 48 8
 *
 * Cells are sized to the largest tile shown, so nothing is scaled or clipped --
 * important, because a scaled contact sheet hides exactly the seam and crop
 * problems you build one to find.
 */
const path = require('path'), fs = require('fs');
const P = require('../lib/png.js');

const DIR = path.join(__dirname, '..', 'tiles', process.argv[2] || 'patterns');
// extractor output carries manifest.json; hand-cut tiles carry _inspect.json
const MANIFEST = ['manifest.json', '_inspect.json']
  .map((f) => path.join(DIR, f)).find((f) => fs.existsSync(f));
if (!MANIFEST) { console.error('no manifest.json or _inspect.json in ' + DIR); process.exit(1); }
const man = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const N = Math.min(Number(process.argv[3]) || 40, man.length);
const COLS = Number(process.argv[4]) || 6;
const MAXCELL = Number(process.argv[5]) || 380;
const list = man.slice(0, N);

const CW = Math.min(MAXCELL, Math.max(...list.map((e) => e.w)) + 16);
const CH = Math.min(MAXCELL, Math.max(...list.map((e) => e.h)) + 16);
const PAD = 8;

const blank = (W, H, c) => { const d = Buffer.alloc(W * H * 4); for (let i = 0; i < d.length; i += 4) { d[i] = c[0]; d[i+1] = c[1]; d[i+2] = c[2]; d[i+3] = 255; } return { W, H, data: d }; };
function blit(dst, src, x, y) {
  for (let j = 0; j < src.H; j++) for (let i = 0; i < src.W; i++) {
    const dx = x + i, dy = y + j; if (dx < 0 || dy < 0 || dx >= dst.W || dy >= dst.H) continue;
    const s = (j * src.W + i) * 4, o = (dy * dst.W + dx) * 4, a = src.data[s + 3] / 255;
    for (let k = 0; k < 3; k++) dst.data[o + k] = Math.round(src.data[s + k] * a + dst.data[o + k] * (1 - a));
  }
}
function checker(W, H) {
  const im = blank(W, H, [64, 66, 74]);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++)
    if ((((x >> 3) + (y >> 3)) & 1)) { const o = (y * W + x) * 4; im.data[o] = 86; im.data[o+1] = 88; im.data[o+2] = 98; }
  return im;
}

const rows = Math.ceil(list.length / COLS);
const out = blank(PAD + COLS * (CW + PAD), PAD + rows * (CH + PAD), [38, 40, 48]);
const scaled = [];
list.forEach((e, i) => {
  let t = P.readPNG(path.join(DIR, e.name + '.png'));
  // Scale oversized tiles down to fit rather than cropping them -- a clipped
  // contact sheet hides the very edges you build one to inspect.
  const fit = Math.min(1, (CW - 4) / t.W, (CH - 4) / t.H);
  if (fit < 1) { t = P.scale(t, fit); scaled.push(e.name + ' @' + Math.round(fit * 100) + '%'); }
  const x = PAD + (i % COLS) * (CW + PAD), y = PAD + Math.floor(i / COLS) * (CH + PAD);
  blit(out, checker(CW, CH), x, y);
  blit(out, t, x + Math.max(0, (CW - t.W) >> 1), y + Math.max(0, (CH - t.H) >> 1));
});
if (scaled.length) console.log('scaled to fit: ' + scaled.join(', '));
P.writePNG(path.join(DIR, '_sheet.png'), out.W, out.H, out.data);
console.log('sheet: top ' + list.length + ' of ' + man.length + ', cell ' + CW + 'x' + CH +
  ' -> tiles/' + (process.argv[2] || 'patterns') + '/_sheet.png');
