import { _electron as electron } from 'playwright';
import path from 'node:path';
import fs from 'node:fs/promises';

const root = process.cwd();
const out = path.join(root, '.poc-out');
const profile = path.join(out, 'profile-diag');
await fs.rm(profile, { recursive: true, force: true });
await fs.mkdir(out, { recursive: true });

const app = await electron.launch({
  args: ['.'],
  cwd: root,
  env: { ...process.env, BIFRAME_USER_DATA_DIR: profile, BIFRAME_DISABLE_DEVTOOLS: '1' },
});

const page = await app.firstWindow();
await page.waitForSelector('.app', { timeout: 60_000 });
await page.waitForTimeout(1500);

const metrics = await page.evaluate(() => ({
  dpr: window.devicePixelRatio,
  inner: [window.innerWidth, window.innerHeight],
  outer: [window.outerWidth, window.outerHeight],
  screen: [window.screen.width, window.screen.height],
  fonts: [...document.fonts].map((f) => `${f.family} ${f.weight} ${f.status}`),
  h1: (() => {
    const el = document.querySelector('h1');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return { text: el.textContent, rect: [r.x, r.y, r.width, r.height], font: cs.fontFamily, size: cs.fontSize, weight: cs.fontWeight, opacity: cs.opacity, transform: cs.transform };
  })(),
  bodyBg: getComputedStyle(document.body).backgroundColor,
  htmlBg: getComputedStyle(document.documentElement).backgroundColor,
}));
console.log(JSON.stringify(metrics, null, 2));

await page.screenshot({ path: path.join(out, 'diag-pw.png'), animations: 'disabled' });

const native = await app.evaluate(async ({ BrowserWindow }) => {
  const win = BrowserWindow.getAllWindows()[0];
  const image = await win.webContents.capturePage();
  const size = image.getSize();
  return { size, png: image.toPNG().toString('base64') };
});
await fs.writeFile(path.join(out, 'diag-native.png'), Buffer.from(native.png, 'base64'));
console.log('native size', native.size);

const info = await app.evaluate(({ BrowserWindow, screen }) => {
  const win = BrowserWindow.getAllWindows()[0];
  return {
    bounds: win.getBounds(),
    contentBounds: win.getContentBounds(),
    displayScale: screen.getDisplayMatching(win.getBounds()).scaleFactor,
    displaySize: screen.getDisplayMatching(win.getBounds()).size,
  };
});
console.log('window', JSON.stringify(info));
await app.close();
