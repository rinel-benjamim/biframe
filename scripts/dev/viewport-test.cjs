const { app, BrowserWindow, screen } = require('electron');
const path = require('node:path');

async function main() {
  await app.whenReady();
  console.log('display', JSON.stringify(screen.getPrimaryDisplay(), null, 2));
  const win = new BrowserWindow({
    show: false, width: 1280, height: 720, useContentSize: true, frame: false,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, disableDialogs: true },
  });
  win.webContents.debugger.attach('1.3');
  await win.loadURL('about:blank');
  const send = (m, p) => win.webContents.debugger.sendCommand(m, p);
  await send('Page.enable');
  const before = await win.webContents.executeJavaScript('({iw:innerWidth,ih:innerHeight,dpr:devicePixelRatio})');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false, screenOrientation: { type: 'landscapePrimary', angle: 0 } });
  const after = await win.webContents.executeJavaScript('({iw:innerWidth,ih:innerHeight,dpr:devicePixelRatio})');
  const file = path.join(process.cwd(), '.poc-out', 'viewport-test.html');
  require('node:fs').writeFileSync(file, '<!doctype html><style>html,body{margin:0;height:100%;background:#123}</style><h1 id=x>test</h1>');
  await win.loadFile(file);
  const loaded = await win.webContents.executeJavaScript('({iw:innerWidth,ih:innerHeight,dpr:devicePixelRatio,screen:[screen.width,screen.height],outer:[outerWidth,outerHeight]})');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false, screenOrientation: { type: 'landscapePrimary', angle: 0 } });
  const fixed = await win.webContents.executeJavaScript('({iw:innerWidth,ih:innerHeight,dpr:devicePixelRatio,screen:[screen.width,screen.height],outer:[outerWidth,outerHeight]})');
  console.log(JSON.stringify({ bounds: win.getBounds(), content: win.getContentSize(), zoom: win.webContents.getZoomFactor(), before, after, loaded, fixed }, null, 2));
  win.destroy();
  app.exit(0);
}
main().catch((e) => { console.error(e); app.exit(1); });
