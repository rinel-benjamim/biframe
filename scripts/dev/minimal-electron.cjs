const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const out = path.join(process.cwd(), '.poc-out', 'minimal');

async function main() {
  await app.whenReady();
  const win = new BrowserWindow({ width: 1000, height: 700, show: true, backgroundColor: '#ffffff' });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`
    <!doctype html><meta charset="utf-8">
    <style>
      body { font-family: 'Segoe UI', sans-serif; margin: 0; padding: 40px; background: #f0efea; }
      .sheet { background: white; border-radius: 16px; padding: 40px; height: 500px; }
      h1 { font-size: 32px; } p { color: #666; max-width: 52ch; }
      button { padding: 10px 16px; border: 1px solid #ccc; border-radius: 8px; background: #5a52ff; color: white; font-size: 14px; }
      .cards { display: flex; gap: 12px; margin-top: 60px; }
      .card { flex: 1; border: 1px solid #ddd; border-radius: 10px; padding: 16px; }
    </style>
    <div class="sheet">
      <h1>Da web para vídeo.</h1>
      <p>Páginas que se movem, exportadas como vídeo. Sem gravação de ecrã, sem pós-produção — o frame certo, no instante certo.</p>
      <button>Importar HTML</button>
      <div class="cards">
        <div class="card"><strong>Importe</strong><p>Uma página HTML ou um projeto ZIP completo.</p></div>
        <div class="card"><strong>Enquadre</strong><p>Escolha resolução, movimento e duração real.</p></div>
        <div class="card"><strong>Exporte</strong><p>MP4 H.264 validado, pronto para publicar.</p></div>
      </div>
    </div>
  `));
  fs.mkdirSync(out, { recursive: true });
  await new Promise((r) => setTimeout(r, 1500));
  let img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(out, 'min-1.png'), img.toPNG());
  win.setContentSize(1300, 800);
  await new Promise((r) => setTimeout(r, 1500));
  img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(out, 'min-2.png'), img.toPNG());
  await new Promise((r) => setTimeout(r, 1500));
  img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(out, 'min-3.png'), img.toPNG());
  app.exit(0);
}
main();
