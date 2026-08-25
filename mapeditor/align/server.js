/*
 * Local server for the tile alignment tool.
 *
 * The page needs to read the mural, the hand cuts, and provenance.json, and to
 * write provenance.json back. file:// cannot do any of that, so this serves the
 * three from disk and takes a POST to save.
 *
 * Nothing here is shipped -- it is authoring-side only, like the rest of
 * mapeditor/. Binds to localhost on a deliberately uncommon port.
 *
 * Usage: node align/server.js [--port 7731] [--sdk <path>]
 * Then open http://127.0.0.1:7731/
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const PORT = Number(arg('--port', 7731));
const ROOT = path.join(__dirname, '..');
const SDK = arg('--sdk', path.join(ROOT, '..', 'scratch-work', 'johnny-upgrade-sdk'));
const CUTS = path.join(ROOT, 'tiles', 'manual');
const MURAL = path.join(SDK, 'assets', 'pics', 'lvlGrfx.png');
const PROV = path.join(CUTS, 'provenance.json');

const send = (res, code, type, body) => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
};

function tileList() {
  const cfgPath = path.join(CUTS, 'normalize.config.json');
  const cfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {};
  return fs.readdirSync(CUTS)
    .filter((f) => f.endsWith('.png') && !f.startsWith('_'))
    .map((f) => f.replace(/\.png$/, ''))
    .filter((n) => !(cfg[n]?.exclude ?? /example/i.test(n)))
    .sort();
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = decodeURIComponent(url.pathname);

  if (req.method === 'POST' && p === '/api/save') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 4e6) req.destroy(); });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (!Array.isArray(data)) throw new Error('expected an array');
        fs.writeFileSync(PROV, JSON.stringify(data, null, 2) + '\n');
        console.log('saved ' + data.length + ' rects to provenance.json');
        send(res, 200, 'application/json', JSON.stringify({ ok: true, count: data.length }));
      } catch (e) {
        send(res, 400, 'application/json', JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (p === '/' || p === '/index.html') {
    return send(res, 200, 'text/html; charset=utf-8', fs.readFileSync(path.join(__dirname, 'index.html')));
  }

  if (p === '/api/state') {
    const prov = fs.existsSync(PROV) ? JSON.parse(fs.readFileSync(PROV, 'utf8')) : [];
    return send(res, 200, 'application/json', JSON.stringify({ tiles: tileList(), provenance: prov }));
  }

  if (p === '/mural.png') {
    if (!fs.existsSync(MURAL)) return send(res, 404, 'text/plain', 'mural not found at ' + MURAL);
    return send(res, 200, 'image/png', fs.readFileSync(MURAL));
  }

  if (p.startsWith('/cut/')) {
    const name = path.basename(p.slice(5));
    const file = path.join(CUTS, name);
    // stay inside the cuts directory
    if (!file.startsWith(CUTS) || !fs.existsSync(file)) return send(res, 404, 'text/plain', 'no such cut');
    return send(res, 200, 'image/png', fs.readFileSync(file));
  }

  send(res, 404, 'text/plain', 'not found');
});

server.listen(PORT, '127.0.0.1', () => {
  if (!fs.existsSync(MURAL)) console.warn('WARNING: no mural at ' + MURAL + ' (pass --sdk)');
  console.log('tile aligner on http://127.0.0.1:' + PORT + '/');
  console.log('  cuts:      ' + CUTS);
  console.log('  mural:     ' + MURAL);
  console.log('  saves to:  ' + PROV);
});
