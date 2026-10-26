import { _electron as electron } from 'playwright';
import path from 'node:path';
import fs from 'node:fs/promises';

const root = process.cwd();
const out = path.join(root, '.poc-out');
const profile = path.join(out, 'profile-theme');
await fs.rm(profile, { recursive: true, force: true });
await fs.mkdir(out, { recursive: true });
const app = await electron.launch({
  args: ['.'],
  cwd: root,
  env: { ...process.env, BIFRAME_USER_DATA_DIR: profile, BIFRAME_DISABLE_DEVTOOLS: '1' },
});
const page = await app.firstWindow();
await page.waitForSelector('.app', { timeout: 60_000 });
await page.waitForTimeout(2000);
console.log(await app.evaluate(({ nativeTheme, BrowserWindow }) => {
  const win = BrowserWindow.getAllWindows()[0];
  return {
    shouldUseDarkColors: nativeTheme.shouldUseDarkColors,
    themeSource: nativeTheme.themeSource,
    overlay: win.getTitleBarOverlay?.(),
    bg: win.getBackgroundColor(),
  };
}));
console.log(await page.evaluate(() => ({
  theme: document.documentElement.dataset.theme,
  mq: window.matchMedia('(prefers-color-scheme: dark)').matches,
  chrome: getComputedStyle(document.documentElement).getPropertyValue('--chrome'),
})));
await app.close();
