/*
 * Local server for the map editor.
 *
 * Authoring-side only, never shipped -- like the rest of mapeditor/. It serves
 * the tile set, reads and writes map files, and hands over the vanilla map so a
 * new map can start from something real rather than an empty canvas.
 *
 * Maps are stored as one JSON file each in mapeditor/maps/, with a sibling PNG
 * thumbnail the editor renders on save. mapkit's level select reads the same
 * pair, so thumbnails stay current without anyone maintaining them.
 *
 * Usage: node editor/server.js [--port 7732] [--sdk <path>]
 * Then open http://127.0.0.1:7732/
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const PORT = Number(arg('--port', 7732));
const ROOT = path.join(__dirname, '..');
const SDK = arg('--sdk', path.join(ROOT, '..', 'scratch-work', 'johnny-upgrade-sdk'));
const TILES = path.join(ROOT, 'tiles', 'extracted');
const MAPS = path.join(ROOT, 'maps');

const send = (res, code, type, body) => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
};
const json = (res, code, obj) => send(res, code, 'application/json', JSON.stringify(obj));

function body(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 3e7) { req.destroy(); reject(new Error('too large')); } });
    req.on('end', () => resolve(b));
    req.on('error', reject);
  });
}

const safeId = (s) => /^[a-z0-9_-]{1,64}$/i.test(s);

function listMaps() {
  if (!fs.existsSync(MAPS)) return [];
  return fs.readdirSync(MAPS).filter((f) => f.endsWith('.json')).map((f) => {
    const id = f.replace(/\.json$/, '');
    let name = id, modified = null;
    try {
      const m = JSON.parse(fs.readFileSync(path.join(MAPS, f), 'utf8'));
      name = m.meta?.name || id;
      modified = m.meta?.modified || null;
    } catch (e) { /* leave the defaults; a broken map should still be listed */ }
    return { id, name, modified, thumb: fs.existsSync(path.join(MAPS, id + '.png')) };
  }).sort((a, b) => (b.modified || '').localeCompare(a.modified || ''));
}

/*
 * The vanilla map, straight from the data the solver already keeps verbatim.
 * Offered as a starting point so a new map can be built by editing something
 * that is known to work, rather than from nothing.
 */
function vanilla() {
  const p = path.join(ROOT, '..', 'solver', 'data', 'maps.js');
  delete require.cache[require.resolve(p)];
  return require(p)[1];
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = decodeURIComponent(url.pathname);

  try {
    if (req.method === 'POST' && p.startsWith('/api/map/')) {
      const id = p.slice(9);
      if (!safeId(id)) return json(res, 400, { error: 'bad map id' });
      const data = JSON.parse(await body(req));
      fs.mkdirSync(MAPS, { recursive: true });
      const map = data.map || {};
      map.meta = { ...(map.meta || {}), id, modified: new Date().toISOString() };
      fs.writeFileSync(path.join(MAPS, id + '.json'), JSON.stringify(map, null, 2) + '\n');
      // thumbnail arrives as a data URL rendered from the editor canvas
      if (typeof data.thumb === 'string' && data.thumb.startsWith('data:image/png;base64,')) {
        fs.writeFileSync(path.join(MAPS, id + '.png'),
          Buffer.from(data.thumb.slice('data:image/png;base64,'.length), 'base64'));
      }
      console.log('saved map ' + id + (data.thumb ? ' (+thumbnail)' : ''));
      return json(res, 200, { ok: true, id });
    }

    if (p === '/' || p === '/index.html') {
      return send(res, 200, 'text/html; charset=utf-8', fs.readFileSync(path.join(__dirname, 'index.html')));
    }

    if (p === '/api/state') {
      const manifest = fs.existsSync(path.join(TILES, 'manifest.json'))
        ? JSON.parse(fs.readFileSync(path.join(TILES, 'manifest.json'), 'utf8')) : [];
      return json(res, 200, { tiles: manifest.map((m) => ({ name: m.name, w: m.w, h: m.h })), maps: listMaps() });
    }

    if (p === '/api/vanilla') return json(res, 200, vanilla());

    if (p.startsWith('/api/map/')) {
      const id = p.slice(9);
      if (!safeId(id)) return json(res, 400, { error: 'bad map id' });
      const f = path.join(MAPS, id + '.json');
      if (!fs.existsSync(f)) return json(res, 404, { error: 'no such map' });
      return send(res, 200, 'application/json', fs.readFileSync(f));
    }

    /*
     * Quick-run. The page is served at /play/ and the SDK's own js/ and assets/
     * are mounted underneath it, because the game requests them with relative
     * paths ("assets/pics/...") and they have to resolve from wherever the page
     * lives.
     */
    if (p === '/play' || p === '/play/' || p === '/play/index.html') {
      return send(res, 200, 'text/html; charset=utf-8', fs.readFileSync(path.join(__dirname, 'play.html')));
    }
    if (p.startsWith('/play/js/') || p.startsWith('/play/assets/')) {
      const rel = p.slice('/play/'.length);
      const f = path.join(SDK, rel);
      if (!f.startsWith(SDK) || !fs.existsSync(f)) return send(res, 404, 'text/plain', 'no such sdk file');
      const ext = path.extname(f).toLowerCase();
      const type = { '.js':'application/javascript', '.png':'image/png', '.gif':'image/gif',
        '.jpg':'image/jpeg', '.wav':'audio/wav', '.mp3':'audio/mpeg', '.ttf':'font/ttf' }[ext] || 'application/octet-stream';
      return send(res, 200, type, fs.readFileSync(f));
    }

    /*
     * Shared modules. mapkit/ is the shipping runtime and owns anything both
     * sides need -- the editor loads it from there rather than keeping a copy,
     * because two copies of the map format would drift.
     */
    if (p.startsWith('/mapkit/') || p.startsWith('/lib/')) {
      const dir = p.startsWith('/mapkit/') ? path.join(ROOT, '..', 'mapkit') : path.join(ROOT, 'lib');
      const f = path.join(dir, path.basename(p));
      if (!f.startsWith(dir) || !fs.existsSync(f)) return send(res, 404, 'text/plain', 'no such module');
      return send(res, 200, 'application/javascript', fs.readFileSync(f));
    }

    if (p.startsWith('/tile/')) {
      const f = path.join(TILES, path.basename(p.slice(6)));
      if (!f.startsWith(TILES) || !fs.existsSync(f)) return send(res, 404, 'text/plain', 'no such tile');
      return send(res, 200, 'image/png', fs.readFileSync(f));
    }

    if (p.startsWith('/thumb/')) {
      const f = path.join(MAPS, path.basename(p.slice(7)));
      if (!f.startsWith(MAPS) || !fs.existsSync(f)) return send(res, 404, 'text/plain', 'no thumbnail');
      return send(res, 200, 'image/png', fs.readFileSync(f));
    }

    send(res, 404, 'text/plain', 'not found');
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('map editor on http://127.0.0.1:' + PORT + '/');
  console.log('  tiles: ' + TILES);
  console.log('  maps:  ' + MAPS);
  console.log('  sdk:   ' + SDK);
});
