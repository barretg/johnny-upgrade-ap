/*
 * End-to-end test rig for the SHIPPED userscript.
 *
 * Everything else in this repo tests pieces. This runs the actual built
 * dist/*.user.js against the actual game, in a real browser, the way
 * Tampermonkey would: the script is loaded before the SDK's own script tags,
 * exactly as @run-at document-start does, and then driver.js drives the whole
 * loop -- level select, editor, save, play, back to the editor -- and prints
 * what happened into the page.
 *
 * That matters here more than usual. The userscript is the one artefact that
 * cannot be checked by reading: it depends on the SDK's load order, on Phaser's
 * cache, on globals appearing in a particular sequence. It shipped once having
 * never been run anywhere.
 *
 *   node mapeditor/tools/e2e/server.js [--sdk <path>] [--script <path>] [--port 7749]
 *   # then open http://127.0.0.1:7749/ and read the panel in the corner,
 *   # or drive it headless:
 *   msedge --headless=new --remote-debugging-port=9333 http://127.0.0.1:7749/
 *   node --experimental-websocket mapeditor/tools/e2e/cdp.js 9333 30000
 *
 * Headless needs the debugger rather than --dump-dom: under
 * --virtual-time-budget requestAnimationFrame does not advance, and Phaser's
 * whole game loop is rAF, so the game never leaves its first frame.
 *
 * Two things this page does that the real site does not have to:
 *
 *   - main.js only calls game.state.start("Main") when the hostname's last two
 *     labels are whitelisted, and `arr` is declared inside main.js itself, so
 *     the list cannot be widened before that check runs. On coolmathgames.com
 *     the check simply passes.
 *   - a headless page reports itself hidden, and Phaser pauses when it is.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const ROOT = path.join(__dirname, '..', '..', '..');
const SDK = path.resolve(arg('--sdk', process.env.JU_SDK || path.join(ROOT, 'scratch-work', 'johnny-upgrade-sdk')));
const SCRIPT = path.resolve(arg('--script', path.join(ROOT, 'dist', 'johnny-upgrade-map-editor.user.js')));
const PORT = Number(arg('--port', 7749));

const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Johnny Upgrade e2e</title>
<script>
  window.__log = [];
  ['log','info','warn','error'].forEach(function (k) {
    var o = console[k].bind(console);
    console[k] = function () { window.__log.push(k + ': ' + [].join.call(arguments, ' ')); o.apply(null, arguments); };
  });
  window.addEventListener('error', function (e) { window.__log.push('ERROR: ' + e.message + ' @' + e.filename + ':' + e.lineno); });
</script>
<script src="/userscript.js"></script>
<script src="js/phaser.js"></script><script src="js/loader.js"></script>
<script src="js/title.js"></script><script src="js/level.js"></script>
<script src="js/shop.js"></script><script src="js/boss.js"></script>
<script src="js/gameOver.js"></script>
<style>body{margin:0;background:#000;width:800px}</style>
</head><body>
<script src="js/main.js"></script>
<script>
  // stand in for being on a whitelisted host, and for the page being visible
  if (window.game) {
    if (window.game.dd) {
      arr.push(location.hostname.split('.').splice(-2).join('.'));
      game.state.start('Main');
    }
    if (game.stage) game.stage.disableVisibilityChange = true;
    game.paused = false;
    setInterval(function () { game.paused = false; }, 250);
  }
</script>
<pre id="probe" style="position:fixed;right:0;top:0;z-index:99999999;background:#fff;color:#000;font:11px monospace"></pre>
<script src="/driver.js"></script>
</body></html>`;

const TYPES = { '.js':'application/javascript', '.png':'image/png', '.gif':'image/gif',
  '.jpg':'image/jpeg', '.wav':'audio/wav', '.mp3':'audio/mpeg', '.ttf':'font/ttf' };

http.createServer((req, res) => {
  const p = req.url.split('?')[0];
  const send = (type, body) => {
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(body);
  };
  if (p === '/' || p === '/index.html') return send('text/html; charset=utf-8', PAGE);
  if (p === '/userscript.js') return send('application/javascript', fs.readFileSync(SCRIPT));
  if (p === '/driver.js') return send('application/javascript', fs.readFileSync(path.join(__dirname, 'driver.js')));

  const f = path.join(SDK, p.replace(/^\//, ''));
  if (!f.startsWith(SDK) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
    res.writeHead(404); return res.end('not found');
  }
  send(TYPES[path.extname(f).toLowerCase()] || 'application/octet-stream', fs.readFileSync(f));
}).listen(PORT, '127.0.0.1', () => {
  console.log('e2e rig on http://127.0.0.1:' + PORT + '/');
  console.log('  script: ' + SCRIPT);
  console.log('  sdk:    ' + SDK);
  if (!fs.existsSync(path.join(SDK, 'js', 'phaser.js'))) console.log('  ! no SDK there; pass --sdk <path>');
  if (!fs.existsSync(SCRIPT)) console.log('  ! no userscript there; build it first');
});
