/*
 * Read the harness probe out of a headless browser over CDP.
 * Node 21 has a global WebSocket, so this needs no packages.
 */
const PORT = Number(process.argv[2] || 9333);
const WAIT = Number(process.argv[3] || 20000);

async function main() {
  const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
  const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && new RegExp((process.env.JU_E2E_PORT||7749)+'/?$|127.0.0.1:'+(process.env.JU_E2E_PORT||7749)).test(t.url));
  if (!page) { console.log('no page target'); return; }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const send = (method, params) => new Promise((res) => {
    const n = ++id;
    pending.set(n, res);
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  await new Promise((r) => ws.addEventListener('open', r));
  ws.addEventListener('message', (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d.result); pending.delete(d.id); }
  });
  const evalIn = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r && r.result ? r.result.value : undefined;
  };
  await new Promise((r) => setTimeout(r, WAIT));
  if (process.argv[4]) { console.log(JSON.stringify(await evalIn(process.argv[4]), null, 1)); ws.close(); return; }
  const probe = await evalIn("document.getElementById('probe') ? document.getElementById('probe').textContent : 'NO PROBE'");
  console.log(probe);
  ws.close();
}
main().catch((e) => console.error(e.message));
