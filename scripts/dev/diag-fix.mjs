import { _electron as electron } from 'playwright';
import path from 'node:path';
import fs from 'node:fs/promises';

const root = process.cwd();
const out = path.join(root, '.poc-out');
const profile = path.join(out, 'profile-fix');
await fs.rm(profile, { recursive: true, force: true });
await fs.mkdir(out, { recursive: true });
const app = await electron.launch({
  args: ['.'],
  cwd: root,
  env: { ...process.env, BIFRAME_USER_DATA_DIR: profile, BIFRAME_DISABLE_DEVTOOLS: '1' },
});
const page = await app.firstWindow();
await page.waitForSelector('.app', { timeout: 60_000 });
await page.waitForTimeout(1200);

async function snap(name) {
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const img = await win.webContents.capturePage();
    return img.toPNG().toString('base64');
  });
  await fs.writeFile(path.join(out, name), Buffer.from(png, 'base64'));
  console.log('wrote', name);
}

await snap('fix-1-initial.png');

await app.evaluate(async ({ BrowserWindow }) => {
  const win = BrowserWindow.getAllWindows()[0];
  win.setContentSize(1300, 740);
});
await page.waitForTimeout(1200);
await snap('fix-2-resized.png');

await page.reload();
await page.waitForSelector('.app', { timeout: 60_000 });
await page.waitForTimeout(1800);
await snap('fix-3-reloaded.png');

await page.evaluate(() => {
  document.documentElement.style.background = '#ff00ff';
});
await page.waitForTimeout(600);
await snap('fix-4-bg.png');

await app.close();
