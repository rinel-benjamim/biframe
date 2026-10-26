import { _electron as electron } from 'playwright';
import path from 'node:path';
import fs from 'node:fs/promises';

const root = process.cwd();
const out = path.join(root, '.poc-out');
const profile = path.join(out, 'profile-ui2');
await fs.rm(profile, { recursive: true, force: true });
await fs.mkdir(out, { recursive: true });

const app = await electron.launch({
  args: ['.'],
  cwd: root,
  env: { ...process.env, BIFRAME_USER_DATA_DIR: profile, BIFRAME_DISABLE_DEVTOOLS: '1' },
});

const page = await app.firstWindow();
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.waitForSelector('.app', { timeout: 60_000 });
await page.waitForTimeout(1200);
await page.screenshot({ path: path.join(out, 'ui2-empty.png'), animations: 'disabled' });

await page.getByRole('button', { name: 'Abrir exemplo' }).click();
await page.waitForSelector('.studio', { timeout: 60_000 });
await page.waitForTimeout(6000);
await page.screenshot({ path: path.join(out, 'ui2-studio.png'), animations: 'disabled' });

const state = await app.evaluate(({ BrowserWindow, webContents }) => {
  const win = BrowserWindow.getAllWindows()[0];
  return {
    windows: BrowserWindow.getAllWindows().map((w) => ({ id: w.id, title: w.getTitle(), bounds: w.getBounds() })),
    contents: webContents.getAllWebContents().map((wc) => ({
      id: wc.id,
      type: wc.getType(),
      url: wc.getURL(),
      bounds: wc.hostWebContents ? undefined : undefined,
    })),
    views: (() => {
      const out = [];
      for (const w of BrowserWindow.getAllWindows()) {
        const children = w.contentView.children;
        out.push(children.map((c) => ({ type: c.constructor.name, bounds: c.getBounds(), visible: c.getVisible?.() })));
      }
      return out;
    })(),
  };
});
console.log(JSON.stringify(state, null, 2));
console.log('--- console ---');
console.log(logs.slice(-60).join('\n'));
await app.close();
