const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const out = path.join(process.cwd(), '.poc-out', 'minimal');
const mode = process.argv[2] ?? 'var-resize';
const fonts = {
  variable: path.join(process.cwd(), 'node_modules', '@fontsource-variable', 'ibm-plex-sans', 'files', 'ibm-plex-sans-latin-wght-normal.woff2'),
  static400: path.join(process.cwd(), 'node_modules', '@fontsource', 'ibm-plex-sans', 'files', 'ibm-plex-sans-latin-400-normal.woff2'),
  static600: path.join(process.cwd(), 'node_modules', '@fontsource', 'ibm-plex-sans', 'files', 'ibm-plex-sans-latin-600-normal.woff2'),
};

function page(fontName, faces) {
  const style = faces
    .map(
      (f) =>
        `@font-face { font-family: '${fontName}'; src: url('file:///${f.file.replace(/\\/g, '/')}') format('woff2'); font-weight: ${f.weight}; font-style: normal; }`,
    )
    .join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    ${style}
    body { font-family: '${fontName}', sans-serif; margin: 0; padding: 40px; background: #f0efea; }
    .sheet { background: white; border-radius: 16px; padding: 40px; height: 500px; }
    h1 { font-size: 32px; } p { color: #666; max-width: 52ch; }
    button { padding: 10px 16px; border: 1px solid #ccc; border-radius: 8px; background: #5a52ff; color: white; font-size: 14px; }
    .cards { display: flex; gap: 12px; margin-top: 60px; }
    .card { flex: 1; border: 1px solid #ddd; border-radius: 10px; padding: 16px; }
  </style></head><body>
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
  </body></html>`;
}

async function main() {
  await app.whenReady();
  fs.mkdirSync(out, { recursive: true });
  const isStatic = mode.startsWith('static');
  const fontName = isStatic ? 'PlexStatic' : 'PlexVar';
  const faces = isStatic
    ? [
        { file: fonts.static400, weight: 400 },
        { file: fonts.static600, weight: 600 },
      ]
    : [{ file: fonts.variable, weight: '100 700' }];
  const file = path.join(out, `${mode}.html`);
  fs.writeFileSync(file, page(fontName, faces));
  const win = new BrowserWindow({ width: 1000, height: 700, show: true, backgroundColor: '#ffffff' });
  await win.loadFile(file);
  await new Promise((r) => setTimeout(r, 1200));
  if (mode.includes('resize')) win.setContentSize(1300, 800);
  await new Promise((r) => setTimeout(r, 1500));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(out, `${mode}.png`), img.toPNG());
  app.exit(0);
}
main().catch((e) => { console.error(e); app.exit(1); });
