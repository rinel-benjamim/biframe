import { _electron as electron } from 'playwright';
import path from 'node:path';
import fs from 'node:fs/promises';

const root = process.cwd();
const out = path.join(root, '.poc-out');
const profile = path.join(out, 'profile-brisa');
const app = await electron.launch({ args: ['.'], cwd: root, env: { ...process.env, BIFRAME_USER_DATA_DIR: profile, BIFRAME_DISABLE_DEVTOOLS: '1' } });
const page = await app.firstWindow();
await page.waitForSelector('.app', { timeout: 60_000 });
await page.waitForTimeout(3000);
const state = await page.evaluate(async () => {
  const b = await window.biframe.app.getBootstrap();
  return {
    ok: b.ok,
    engine: b.ok ? b.data?.engine : b.error,
    theme: b.ok ? b.data?.effectiveTheme : null,
    settingsTheme: b.ok ? b.data?.settings.theme : null,
    project: b.ok ? b.data?.project?.name : null,
    themeAttr: document.documentElement.dataset.theme,
    titlebar: document.querySelector('.engine-dot')?.getAttribute('data-state'),
    text: document.querySelector('.engine-dot')?.textContent,
  };
});
console.log(JSON.stringify(state, null, 2));
console.log('panel notice', await page.locator('.export .notice').count());
await app.close();
