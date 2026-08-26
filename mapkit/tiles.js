/*
 * Rebuild the tileset at load time from the player's own copy of the game.
 *
 * No artwork ships. What ships is tiles.json -- a source rectangle per tile plus
 * its normalise settings -- and this replays that against the images the game
 * already loaded, so the textures come from the player's install rather than
 * from us.
 *
 * The shipped game never loads the full mural. It loads six 1710x1665 slices,
 * lvlGrfx1..6, laid out 3 across and 2 down from world (-1620, -720). A tile
 * rect can straddle up to four of them, so rects are stitched before anything
 * else happens.
 *
 * The pixel work is deliberately pure -- it takes and returns {width, height,
 * data} the same shape as ImageData -- so it runs unchanged in node and can be
 * diffed against what the build-time extractor produced. Only the glue at the
 * bottom touches canvases or Phaser.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MapkitTiles = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const luma = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
  const chroma = (r, g, b) => Math.max(r, g, b) - Math.min(r, g, b);

  const make = (w, h) => ({
    width: w, height: h,
    data: (typeof Uint8ClampedArray !== 'undefined' ? new Uint8ClampedArray(w * h * 4) : new Array(w * h * 4).fill(0)),
  });

  /*
   * Background test.
   *
   * Two rules, because one does not fit the whole set. The luma/chroma rule is
   * the general one: background is dark AND near-neutral, which protects texture
   * that is dark but coloured. Where a tile has dark internal detail even that
   * over-reaches, so `bg` matches specific colours instead -- this mural's
   * background is #000000 in most places and #202020 around the metal and rock
   * corners, and matching the colour leaves the near-black mortar alone.
   */
  function makeIsBackground(cfg, defaults) {
    if (cfg && cfg.bg) {
      const tol = cfg.tol === undefined ? 6 : cfg.tol;
      const list = cfg.bg;
      return (r, g, b) => {
        for (let i = 0; i < list.length; i++) {
          const c = list[i];
          if (Math.abs(r - c[0]) <= tol && Math.abs(g - c[1]) <= tol && Math.abs(b - c[2]) <= tol) return true;
        }
        return false;
      };
    }
    const L = (cfg && cfg.luma !== undefined) ? cfg.luma : defaults.luma;
    const C = (cfg && cfg.chroma !== undefined) ? cfg.chroma : defaults.chroma;
    return (r, g, b) => luma(r, g, b) <= L && chroma(r, g, b) <= C;
  }

  // background reachable from the border
  function backgroundMask(img, isBg) {
    const { width: W, height: H, data } = img;
    const bg = new Uint8Array(W * H);
    const stack = [];
    const push = (x, y) => {
      if (x < 0 || y < 0 || x >= W || y >= H) return;
      const i = y * W + x;
      if (bg[i]) return;
      const o = i * 4;
      if (data[o + 3] < 16) { bg[i] = 1; stack.push(i); return; }
      if (!isBg(data[o], data[o + 1], data[o + 2])) return;
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
   * Background the border flood cannot reach. Opt-in, because the same shape
   * means opposite things: the rail's sealed band between its two bars is
   * background, the box's dark centre is texture.
   */
  function pocketMask(img, bg, isBg) {
    const { width: W, height: H, data } = img;
    const out = Uint8Array.from(bg);
    const seen = Uint8Array.from(bg);
    for (let start = 0; start < W * H; start++) {
      if (seen[start]) continue;
      const o0 = start * 4;
      if (data[o0 + 3] < 16) continue;
      if (!isBg(data[o0], data[o0 + 1], data[o0 + 2])) continue;
      const cells = [start];
      seen[start] = 1;
      for (let k = 0; k < cells.length; k++) {
        const i = cells[k], x = i % W, y = (i / W) | 0;
        const nb = [[1, 0], [-1, 0], [0, 1], [0, -1]];
        for (let n = 0; n < 4; n++) {
          const nx = x + nb[n][0], ny = y + nb[n][1];
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const j = ny * W + nx;
          if (seen[j]) continue;
          const o = j * 4;
          if (data[o + 3] < 16) { seen[j] = 1; cells.push(j); continue; }
          if (!isBg(data[o], data[o + 1], data[o + 2])) continue;
          seen[j] = 1; cells.push(j);
        }
      }
      for (let c = 0; c < cells.length; c++) out[cells[c]] = 1;
    }
    return out;
  }

  /*
   * Soften the boundary, un-mixing the black behind it.
   *
   * An edge pixel is already a blend of texture over black. Dropping its alpha
   * without touching RGB leaves a dark semi-transparent pixel that composites as
   * a halo, outlining every hole in the rope and gap in the spikes. Background is
   * black, so true = observed / alpha recovers the colour.
   */
  function feather(img, bg, lumaCut) {
    const { width: W, height: H, data } = img;
    const out = make(W, H);
    out.data.set(data);
    const MIN_A = 0.18;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x, o = i * 4;
        if (bg[i]) { out.data[o + 3] = 0; continue; }
        let touches = false;
        const nb = [[1, 0], [-1, 0], [0, 1], [0, -1]];
        for (let n = 0; n < 4; n++) {
          const nx = x + nb[n][0], ny = y + nb[n][1];
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          if (bg[ny * W + nx]) { touches = true; break; }
        }
        if (!touches) continue;
        const l = luma(data[o], data[o + 1], data[o + 2]);
        const a = Math.max(0, Math.min(1, (l - lumaCut * 0.4) / (lumaCut * 1.6)));
        out.data[o + 3] = Math.round(data[o + 3] * a);
        if (a >= MIN_A) {
          for (let k = 0; k < 3; k++) out.data[o + k] = Math.min(255, Math.round(data[o + k] / a));
        }
      }
    }
    return out;
  }

  function trim(img) {
    const { width: W, height: H, data } = img;
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (data[(y * W + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
    if (x1 < 0) return img;
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    const out = make(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const s = ((y0 + y) * W + (x0 + x)) * 4, d = (y * w + x) * 4;
      for (let k = 0; k < 4; k++) out.data[d + k] = data[s + k];
    }
    return out;
  }

  function cropMargins(img, m) {
    const w = img.width - m[0] - m[2], h = img.height - m[1] - m[3];
    if (w <= 0 || h <= 0) return img;
    const out = make(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const s = ((y + m[1]) * img.width + (x + m[0])) * 4, d = (y * w + x) * 4;
      for (let k = 0; k < 4; k++) out.data[d + k] = img.data[s + k];
    }
    return out;
  }

  // erase rectangles: for a neighbour intruding into a corner, where no colour
  // rule can help because it is real texture, just not this tile's
  function applyMasks(img, rects) {
    for (let r = 0; r < rects.length; r++) {
      const m = rects[r];
      for (let j = m[1]; j < m[1] + m[3]; j++) {
        for (let i = m[0]; i < m[0] + m[2]; i++) {
          if (i < 0 || j < 0 || i >= img.width || j >= img.height) continue;
          img.data[(j * img.width + i) * 4 + 3] = 0;
        }
      }
    }
    return img;
  }

  function normalize(img, cfg, defaults) {
    cfg = cfg || {};
    let t = img;
    if (cfg.crop) t = cropMargins(t, cfg.crop);
    if (cfg.mask) t = applyMasks(t, cfg.mask);
    if (cfg.mode === 'none') return trim(t);
    const isBg = makeIsBackground(cfg, defaults);
    let bg = backgroundMask(t, isBg);
    if (cfg.pockets) bg = pocketMask(t, bg, isBg);
    const lumaCut = cfg.bg ? defaults.luma : (cfg.luma === undefined ? defaults.luma : cfg.luma);
    return trim(feather(t, bg, lumaCut));
  }

  /*
   * Composite tiles, currently just the grass.
   *
   * The mural stamps that grass three times and the rocks cover a different part
   * of each, so a per-pixel union across all three recovers more than any single
   * copy holds. Below that every copy is occluded and nothing exists to recover,
   * so the base is continued downward from the last clean pixel in each column --
   * the band is vertical striping in two greens, so continuing it reproduces the
   * pattern rather than inventing structure.
   */
  function composite(spec, sample) {
    const W = spec.width, RECOV = spec.recovered, H = RECOV + spec.extend;
    const out = make(W, H);
    const isGrass = (r, g, b) => g >= r + 4 && g >= b + 15;
    const isLit = (r, g, b, a) => a >= 128 && luma(r, g, b) > 30;
    const lastClean = new Array(W).fill(null);
    const put = (i, j, px) => {
      const o = (j * W + i) * 4;
      out.data[o] = px[0]; out.data[o + 1] = px[1]; out.data[o + 2] = px[2]; out.data[o + 3] = 255;
    };

    for (let j = 0; j < RECOV; j++) {
      for (let i = 0; i < W; i++) {
        const samples = [];
        let occluded = false;
        for (let s = 0; s < spec.sources.length; s++) {
          const px = sample(spec.sources[s].x + i, spec.sources[s].y + j);
          if (!px || !isLit(px[0], px[1], px[2], px[3])) continue;
          if (!isGrass(px[0], px[1], px[2])) { occluded = true; continue; }
          samples.push(px);
        }
        if (!samples.length) continue;
        const med = [0, 1, 2].map((c) => {
          const v = samples.map((x) => x[c]).sort((a, b) => a - b);
          return v[v.length >> 1];
        });
        put(i, j, med);
        lastClean[i] = med;
      }
    }
    // fill pixels that were covered in every copy, from directly above
    for (let j = 0; j < RECOV; j++) {
      for (let i = 0; i < W; i++) {
        if (out.data[(j * W + i) * 4 + 3] >= 128) continue;
        let occluded = false;
        for (let s = 0; s < spec.sources.length; s++) {
          const px = sample(spec.sources[s].x + i, spec.sources[s].y + j);
          if (px && isLit(px[0], px[1], px[2], px[3]) && !isGrass(px[0], px[1], px[2])) { occluded = true; break; }
        }
        if (!occluded) continue;
        for (let k = j - 1; k >= 0; k--) {
          const p = (k * W + i) * 4;
          if (out.data[p + 3] >= 128) { put(i, j, [out.data[p], out.data[p + 1], out.data[p + 2]]); break; }
        }
      }
    }
    for (let j = RECOV; j < H; j++) {
      for (let i = 0; i < W; i++) if (lastClean[i]) put(i, j, lastClean[i]);
    }
    return out;
  }

  // ------------------------------------------------------------ browser glue
  /*
   * Stitch a mural rect out of the six slices the game actually loaded.
   */
  function makeSampler(win, recipe) {
    const s = recipe.slice;
    const canvases = s.keys.map((k) => {
      const img = win.game.cache.getImage(k, true);
      const src = img && (img.data || img);
      if (!src) return null;
      const c = win.document.createElement('canvas');
      c.width = s.w; c.height = s.h;
      c.getContext('2d').drawImage(src, 0, 0);
      return c.getContext('2d').getImageData(0, 0, s.w, s.h);
    });

    return function region(x, y, w, h) {
      const out = make(w, h);
      for (let j = 0; j < h; j++) {
        for (let i = 0; i < w; i++) {
          const X = x + i, Y = y + j;
          const col = Math.floor(X / s.w), row = Math.floor(Y / s.h);
          if (col < 0 || col >= s.cols || row < 0 || row >= s.rows) continue;
          const im = canvases[row * s.cols + col];
          if (!im) continue;
          const lx = X - col * s.w, ly = Y - row * s.h;
          const so = (ly * s.w + lx) * 4, d = (j * w + i) * 4;
          for (let k = 0; k < 4; k++) out.data[d + k] = im.data[so + k];
        }
      }
      return out;
    };
  }

  function toImage(win, img) {
    const c = win.document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const id = c.getContext('2d').createImageData(img.width, img.height);
    id.data.set(img.data);
    c.getContext('2d').putImageData(id, 0, 0);
    return c;
  }

  /*
   * Build every tile and register it in Phaser's cache under the renderer's key
   * prefix. Canvases are added directly, so there is no image decode to wait on.
   */
  function build(win, recipe, keyPrefix) {
    const region = makeSampler(win, recipe);
    const one = (x, y) => {
      const r = region(x, y, 1, 1);
      return r.data[3] === 0 && r.data[0] === 0 && r.data[1] === 0 && r.data[2] === 0
        ? [0, 0, 0, 0] : [r.data[0], r.data[1], r.data[2], r.data[3]];
    };
    const built = [];

    for (let i = 0; i < recipe.tiles.length; i++) {
      const t = recipe.tiles[i];
      const raw = region(t.rect.x, t.rect.y, t.rect.w, t.rect.h);
      const norm = normalize(raw, t.norm, recipe.defaults);
      win.game.cache.addImage(keyPrefix + t.name, '', toImage(win, norm));
      built.push(t.name);
    }
    for (let i = 0; i < (recipe.composites || []).length; i++) {
      const c = recipe.composites[i];
      const img = composite(c, one);
      win.game.cache.addImage(keyPrefix + c.name, '', toImage(win, img));
      built.push(c.name);
    }
    return built;
  }

  return {
    build, normalize, composite, makeIsBackground, backgroundMask,
    pocketMask, feather, trim, cropMargins, applyMasks, make,
  };
}));
