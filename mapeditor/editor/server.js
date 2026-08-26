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
/*
 * Flags win over environment, environment over defaults. Containers pass
 * settings as env vars far more naturally than as argv, and a Portainer stack
 * is nothing but a list of environment variables.
 */
const arg = (k, envKey, d) => {
  const i = argv.indexOf(k);
  if (i >= 0) return argv[i + 1];
  if (envKey && process.env[envKey] !== undefined && process.env[envKey] !== '') return process.env[envKey];
  return d;
};
const PORT = Number(arg('--port', 'JU_PORT', 7732));
/*
 * Bind address. Localhost by default -- the editor writes files and has no
 * concept of users, so it should not be reachable from anywhere else unless
 * that is asked for deliberately. Pass --host 0.0.0.0 to share it on a private
 * network, and --token to put a shared secret in front of it.
 */
const HOST = arg('--host', 'JU_HOST', '127.0.0.1');
const TOKEN = arg('--token', 'JU_TOKEN', null);
const ROOT = path.join(__dirname, '..');
const SDK = arg('--sdk', 'JU_SDK', path.join(ROOT, '..', 'scratch-work', 'johnny-upgrade-sdk'));
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

/*
 * Shared-secret gate, for when this is hosted somewhere other than localhost.
 *
 * Deliberately simple: one token, passed as ?token= once and then kept in a
 * cookie. This is a lock on a door for a group of friends, not authentication --
 * anyone with the token can edit and overwrite every map. Do not put it on the
 * public internet.
 */
function authorised(req, res, url) {
  if (!TOKEN) return true;
  const given = url.searchParams.get('token');
  if (given === TOKEN) {
    res.setHeader('Set-Cookie', 'mapedit=' + encodeURIComponent(TOKEN) + '; Path=/; SameSite=Lax; Max-Age=2592000');
    return true;
  }
  const cookie = (req.headers.cookie || '').split(';')
    .map((c) => c.trim().split('='))
    .find((c) => c[0] === 'mapedit');
  return !!cookie && decodeURIComponent(cookie[1] || '') === TOKEN;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = decodeURIComponent(url.pathname);

  if (!authorised(req, res, url)) {
    return send(res, 401, 'text/html; charset=utf-8',
      '<body style="background:#0d0f14;color:#dde1ea;font:14px system-ui;padding:40px">' +
      '<h2>Map editor</h2><p>Append <code>?token=…</code> to the URL to get in.</p></body>');
  }

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

    // the editor itself, shared with the userscript build
    if (p === '/editor-core.js' || p === '/editor-host.js' || p === '/editor-play.js') {
      const f = path.join(__dirname, path.basename(p));
      if (!fs.existsSync(f)) return send(res, 404, 'text/plain', 'no such module');
      return send(res, 200, 'application/javascript', fs.readFileSync(f));
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
    // standalone game host: level select, then play whatever is picked
    if (p === '/game' || p === '/game/') {
      return send(res, 200, 'text/html; charset=utf-8',
        fs.readFileSync(path.join(ROOT, '..', 'mapkit', 'host.html')));
    }

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

/*
 * Startup checks.
 *
 * Both of these fail in ways that look like editor bugs rather than missing
 * setup -- an empty texture palette, or a quick-run that 404s on phaser.js -- so
 * they are worth saying out loud at boot.
 */
function preflight() {
  const problems = [];
  if (!fs.existsSync(path.join(SDK, 'js', 'phaser.js'))) {
    problems.push('No game SDK at ' + SDK +
      '\n      Quick-run and the level select need it. Pass --sdk <path>.');
  }
  if (!fs.existsSync(path.join(TILES, 'manifest.json'))) {
    problems.push('No extracted tiles at ' + TILES +
      '\n      The texture palette will be empty. Build them with:' +
      '\n        node tools/extract-from-mural.js' +
      '\n        node tools/reconstruct-grass.js');
  }
  return problems;
}

server.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log('map editor on http://' + shown + ':' + PORT + '/' + (TOKEN ? '?token=' + TOKEN : ''));
  console.log('  editor     /');
  console.log('  level list /game');
  console.log('  tiles:     ' + TILES);
  console.log('  maps:      ' + MAPS);
  console.log('  sdk:       ' + SDK);

  if (HOST !== '127.0.0.1' && HOST !== 'localhost') {
    console.log('');
    if (TOKEN) {
      console.log('  reachable from the network, behind a shared token.');
    } else {
      console.log('  WARNING: reachable from the network with NO token.');
      console.log('  Anyone who can reach this port can read, edit and overwrite every map.');
      console.log('  Pass --token <secret> unless the network is genuinely trusted.');
    }
  }

  const problems = preflight();
  if (problems.length) {
    console.log('');
    for (const p of problems) console.log('  ! ' + p);
  }
});
