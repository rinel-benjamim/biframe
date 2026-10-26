// Diagnostic: does Google Fonts load in a bare Electron window on this machine?
// Usage: npx electron scripts/dev/font-net-test.cjs [show] [offscreen] [persist]
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const show = process.argv[2] === 'show';
const offscreen = process.argv[3] === 'offscreen';
const persist = process.argv[4] === 'persist';
const out = path.join(process.cwd(), '.poc-out');
const events = [];

const html = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@700;800&family=JetBrains+Mono:wght@500;700&family=Plus+Jakarta+Sans:wght@400;500;700;800&display=swap">
<style>
body{margin:0;background:#062b63;color:#fff;font-family:'Plus Jakarta Sans',sans-serif}
h1{font-family:'Bricolage Grotesque',sans-serif;font-weight:800;font-size:72px;margin:40px}
p{font-family:'Plus Jakarta Sans',sans-serif;font-size:28px;margin:40px}
code{font-family:'JetBrains Mono',monospace;font-size:24px;margin:40px;display:block}
</style></head><body>
<h1>Facturação leve como a brisa.</h1>
<p>Crie produtos, venda no POS e emita facturas em segundos.</p>
<code>BIF-2026-0001 · 570.000,00 Kz</code>
</body></html>`;

async function main() {
  await app.whenReady();
  fs.writeFileSync(path.join(out, 'font-test.html'), html);
  const partition = persist ? 'persist:font-test' : `font-test-${Date.now()}`;
  const ses = session.fromPartition(partition);
  ses.webRequest.onErrorOccurred((d) => events.push({ kind: 'error', url: d.url.slice(0, 120), error: d.error, type: d.resourceType }));
  ses.webRequest.onCompleted((d) => events.push({ kind: 'done', url: d.url.slice(0, 120), status: d.statusCode, type: d.resourceType }));

  const win = new BrowserWindow({
    width: 1280, height: 720, show, useContentSize: true,
    webPreferences: { offscreen, sandbox: true, contextIsolation: true, nodeIntegration: false, session: ses, backgroundThrottling: false },
  });
  win.webContents.on('console-message', (e) => events.push({ kind: 'console', level: e.level, message: String(e.message).slice(0, 200) }));
  await win.loadFile(path.join(out, 'font-test.html'));
  await new Promise((r) => setTimeout(r, 4000));
  const state = await win.webContents.executeJavaScript(`(async () => {
    await document.fonts.ready;
    const check = (f) => document.fonts.check("800 72px '" + f + "'");
    const c = document.createElement('canvas').getContext('2d');
    const width = (font) => { c.font = "72px '" + font + "'"; return c.measureText('Facturação leve como a brisa.').width; };
    return {
      status: document.fonts.status,
      bricolage: check('Bricolage Grotesque'),
      jakarta: check('Plus Jakarta Sans'),
      jetbrains: check('JetBrains Mono'),
      widths: { bricolage: width('Bricolage Grotesque'), fallback: width('sans-serif'), jakarta: width('Plus Jakarta Sans') },
      fonts: [...document.fonts].map((f) => ({ family: f.family, weight: f.weight, status: f.status })),
      resources: performance.getEntriesByType('resource').filter((e) => e.name.includes('font')).map((e) => ({ name: e.name.slice(0, 100), duration: e.duration, size: e.transferSize })),
    };
  })()`, true);
  console.log(JSON.stringify({ show, offscreen, persist, state, events }, null, 2));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(out, `font-test-${show ? 'show' : 'hide'}-${offscreen ? 'off' : 'on'}.png`), img.toPNG());
  win.destroy();
  app.exit(0);
}
main().catch((e) => { console.error(e); app.exit(1); });
