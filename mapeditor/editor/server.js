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
const { spawn } = require('child_process');

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
const MODULES = path.join(ROOT, 'modules');

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
 * The module library.
 *
 * Read through the solver's own readModule(), not with JSON.parse, so the editor is
 * handed exactly what solve-module.js would be handed: a `solve` record whose
 * geometry or settings have moved on is DROPPED before it ever reaches a badge,
 * and so is a `handPlay` verdict whose geometry has. Two readers with two ideas of
 * when a record is stale is how a rung that no longer describes anything ends up
 * on screen -- and stale difficulty metadata is the one thing that can silently
 * generate an unbeatable map.
 *
 * The solver is a sibling directory rather than a dependency, so its absence
 * degrades to a plain read instead of taking the editor down with it.
 */
function moduleReader() {
  try {
    const sm = require(path.join(ROOT, '..', 'solver', 'solve-module.js'));
    const settings = require(path.join(ROOT, '..', 'solver', 'settings.js'));
    return (f) => sm.readModule(f, settings);
  } catch (e) {
    console.log('  ! no solver alongside; module records are served unchecked (' + e.message + ')');
    return (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
  }
}

function listModules() {
  if (!fs.existsSync(MODULES)) return [];
  const read = moduleReader();
  return fs.readdirSync(MODULES).filter((f) => f.endsWith('.json')).map((f) => {
    const file = path.join(MODULES, f);
    let mod;
    try { mod = read(file); }
    catch (e) { return { name: f.replace(/\.json$/, ''), objects: [], error: e.message }; }
    // readModule's own bookkeeping is not part of the record
    for (const k of ['file', 'hash', 'geometryHash']) delete mod[k];
    if (mod.staleSolve || mod.staleHandPlay) mod.stale = true;
    delete mod.staleSolve; delete mod.staleHandPlay;
    if (!mod.solve) delete mod.solve;
    if (!mod.handPlay) delete mod.handPlay;
    if (!mod.name) mod.name = f.replace(/\.json$/, '');
    return mod;
  }).sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

/*
 * Run the solver over one module and write the answer into its file.
 *
 * This is `node solver/solve-module.js <file> --write`, no more: the same tool, the
 * same rules, the same output. It is spawned rather than required because
 * solve-module.js derives its world from JU_MAP at require() time and would bind
 * this server to one arena forever, and it is spawned ASYNCHRONOUSLY because a
 * module takes seconds to tens of seconds and spawnSync would wedge the editor
 * along with it.
 *
 * A solve that fails is reported as a failure, never as an absent record: the
 * module file keeps whatever it had, and the editor shows the module as unsolved.
 * Guessing in either direction is how an unbeatable map gets generated.
 */
const SOLVER = path.join(ROOT, '..', 'solver');
const SOLVE_TIMEOUT_MS = 10 * 60 * 1000;

function solveModule(name) {
  return new Promise((resolve) => {
    const file = path.join(MODULES, name + '.json');
    if (!fs.existsSync(file)) return resolve({ ok: false, error: 'no such module' });
    const script = path.join(SOLVER, 'solve-module.js');
    if (!fs.existsSync(script)) return resolve({ ok: false, error: 'no solver alongside the editor' });

    const child = spawn(process.execPath, [script, file, '--write'],
      { cwd: SOLVER, encoding: 'utf8' });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => { child.kill(); }, SOLVE_TIMEOUT_MS);
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const text = (out + err).trim();
      /*
       * solve-module.js exits non-zero on a DISAGREEMENT with expect as well as on a
       * failure -- that is the interesting output, not an error -- so the answer is
       * read out of the module file rather than out of the exit code. No record
       * written means it genuinely could not solve it.
       */
      let mod = null;
      try { mod = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { /* reported below */ }
      const solved = mod && mod.solve && typeof mod.solve.minRung === 'number';
      console.log('solved module ' + name + ': ' + (solved ? 'rung ' + mod.solve.minRung : 'no answer') +
        ' (exit ' + code + ')');
      resolve({
        ok: !!solved,
        minRung: solved ? mod.solve.minRung : null,
        exit: code,
        output: text.split('\n').slice(-6).join('\n'),
      });
    });
  });
}

/*
 * Build a module's arena and write it where the level list can find it.
 *
 * `solve-module.js` already writes one every time it solves, but a module that has
 * never been solved has none -- and an arena left over from before an edit is
 * WORSE than none, because it would hand someone the old geometry to hand-test
 * while the module file says something else. So this rebuilds from the module's
 * current objects every time, and it is cheap: arena.js is geometry, not
 * simulation.
 */
function buildModuleArena(name) {
  const file = path.join(MODULES, name + '.json');
  if (!fs.existsSync(file)) return { ok: false, error: 'no such module' };
  try {
    const { buildArena } = require(path.join(ROOT, '..', 'solver', 'arena.js'));
    const mod = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!mod.name) mod.name = name;
    const { id, map } = buildArena(mod);
    fs.mkdirSync(MAPS, { recursive: true });
    fs.writeFileSync(path.join(MAPS, id + '.json'), JSON.stringify(map, null, 1) + '\n');
    console.log('built arena ' + id + ' for module ' + name);
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/*
 * Record that a person played this module and cleared it at a rung.
 *
 * The other half of the difficulty answer, and the half no simulator can give.
 * Three rules, all enforced here rather than in the browser, because this is what
 * actually writes the file:
 *
 *   * A verdict may only ever RAISE a rung. One BELOW the solved rung would mean a
 *     person did what the simulator proved impossible -- a physics bug, not a
 *     difficulty correction -- and quietly lowering a rung is how an unbeatable map
 *     gets generated. Refused, loudly, with the reason.
 *   * The hash covers GEOMETRY only, never settings. A person played the real game,
 *     and the real game does not change when a discretization knob does. Hashing
 *     settings here would throw away every verdict at the moment the solver was
 *     corrected, which is when they are worth most.
 *   * The block is written fresh, never edited, so `playedAt` always names the day
 *     the rung in the file was actually played.
 */
async function recordHandPlay(name, verdict) {
  const file = path.join(MODULES, name + '.json');
  if (!fs.existsSync(file)) return { ok: false, error: 'no such module' };

  let sm, ladder;
  try {
    sm = require(path.join(ROOT, '..', 'solver', 'solve-module.js'));
    ladder = require(path.join(ROOT, '..', 'solver', 'ladder.js'));
  } catch (e) {
    return { ok: false, error: 'no solver alongside the editor: ' + e.message };
  }

  const rung = Number(verdict && verdict.minRung);
  if (!Number.isInteger(rung) || rung < 0 || rung >= ladder.N_RUNGS) {
    return { ok: false, error: 'minRung must be a rung between 0 and ' + (ladder.N_RUNGS - 1) };
  }

  const mod = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!mod.name) mod.name = name;
  const solved = mod.solve && typeof mod.solve.minRung === 'number' ? mod.solve.minRung : null;
  if (solved !== null && rung < solved) {
    return {
      ok: false,
      error: 'Rung ' + rung + ' is BELOW the solved rung of ' + solved + '. That would mean a ' +
        'person cleared what the simulator proved impossible, which is a bug in the physics ' +
        'rather than a difficulty correction. Hand-play may only ever raise a rung -- fix the ' +
        'simulator, or re-solve the module, before recording this.',
    };
  }

  /*
   * `attempts` and `trail` are the part of a verdict a rung alone cannot carry.
   *
   * A module cleared first go and one cleared on the twentieth try are the same
   * rung and are not the same module, and the rungs that were tried and given up
   * on are what makes the number trustworthy: they say the person walked up to it
   * rather than starting there. Both are the person's own count -- nothing here
   * infers an attempt from a death or a restart, because a restart is not
   * reliably a failure.
   */
  const attempts = Number(verdict && verdict.attempts);
  const trail = Array.isArray(verdict && verdict.trail)
    ? verdict.trail
        .filter((t) => t && Number.isInteger(Number(t.rung)))
        .map((t) => ({ rung: Number(t.rung), attempts: Number(t.attempts) || 0, cleared: false }))
    : [];
  mod.handPlay = {
    hash: sm.geometryHash(mod),
    playedAt: new Date().toISOString().slice(0, 10),
    minRung: rung,
    why: String((verdict && verdict.why) || '').trim() ||
      ('Played the module arena at rung ' + rung + ' and cleared it.'),
  };
  if (Number.isInteger(attempts) && attempts > 0) mod.handPlay.attempts = attempts;
  if (trail.length) mod.handPlay.triedBelow = trail;
  fs.writeFileSync(file, JSON.stringify(mod, null, 1) + '\n');
  console.log('hand-play recorded for ' + name + ': rung ' + rung +
    (solved !== null && rung > solved ? ' (raised from the solved ' + solved + ')' : ''));
  return { ok: true, name, minRung: rung, solved };
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

    /*
     * Modules are written with the same shape and indentation solve-module.js
     * uses, because that tool rewrites these files too -- matching it keeps a
     * --write pass from showing up as a whole-file diff.
     */
    if (req.method === 'POST' && p.startsWith('/api/module/')) {
      const name = p.slice('/api/module/'.length);
      if (!safeId(name)) return json(res, 400, { error: 'bad module name' });
      const mod = JSON.parse(await body(req));
      if (!mod || !Array.isArray(mod.objects) || !mod.entry || !mod.exit) {
        return json(res, 400, { error: 'a module needs objects, entry and exit' });
      }
      mod.name = name;
      fs.mkdirSync(MODULES, { recursive: true });
      fs.writeFileSync(path.join(MODULES, name + '.json'), JSON.stringify(mod, null, 1) + '\n');
      console.log('saved module ' + name + ' (' + mod.objects.length + ' objects' +
        (mod.solve ? ', solve kept' : '') + (mod.handPlay ? ', hand-play kept' : '') + ')');
      return json(res, 200, { ok: true, name });
    }

    if (p === '/api/modules') return json(res, 200, listModules());

    if (req.method === 'POST' && p.startsWith('/api/arena/')) {
      const name = p.slice('/api/arena/'.length);
      if (!safeId(name)) return json(res, 400, { error: 'bad module name' });
      return json(res, 200, buildModuleArena(name));
    }

    if (req.method === 'POST' && p.startsWith('/api/handplay/')) {
      const name = p.slice('/api/handplay/'.length);
      if (!safeId(name)) return json(res, 400, { error: 'bad module name' });
      return json(res, 200, await recordHandPlay(name, JSON.parse(await body(req))));
    }

    if (req.method === 'POST' && p.startsWith('/api/solve/')) {
      const name = p.slice('/api/solve/'.length);
      if (!safeId(name)) return json(res, 400, { error: 'bad module name' });
      console.log('solving module ' + name + '...');
      return json(res, 200, await solveModule(name));
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
    /*
     * The ladder, straight out of the solver. The editor's rung reference reads the
     * real file rather than a transcription, so "rung 12" cannot come to mean two
     * different things in two places.
     */
    if (p === '/solver/ladder.js') {
      const f = path.join(SOLVER, 'ladder.js');
      if (!fs.existsSync(f)) return send(res, 404, 'text/plain', 'no ladder');
      return send(res, 200, 'application/javascript', fs.readFileSync(f));
    }

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
  console.log('  modules:   ' + MODULES);
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
