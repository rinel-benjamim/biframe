import { _electron as electron } from 'playwright';
import path from 'node:path';
import fs from 'node:fs/promises';

const root = process.cwd();
const profile = path.join(root, '.poc-out', 'profile-ui');
await fs.rm(profile, { recursive: true, force: true });
await fs.mkdir(path.join(root, '.poc-out'), { recursive: true });

const app = await electron.launch({
  args: ['.'],
  cwd: root,
  env: {
    ...process.env,
    BIFRAME_USER_DATA_DIR: profile,
    BIFRAME_DISABLE_DEVTOOLS: '1',
  },
});

const page = await app.firstWindow();
const logs = [];
page.on('console', (message) => logs.push(`[${message.type()}] ${message.text()}`));
page.on('pageerror', (error) => logs.push(`[pageerror] ${error.message}`));
await page.waitForSelector('.app', { timeout: 60_000 });
await page.waitForTimeout(900);
await page.screenshot({ path: path.join(root, '.poc-out', 'ui-empty.png') });
console.log('title', await page.title());

const example = page.getByRole('button', { name: 'Abrir exemplo' });
console.log('example buttons', await example.count());
if ((await example.count()) > 0) {
  await example.click();
  await page.waitForSelector('.studio', { timeout: 60_000 });
  await page.waitForTimeout(3500);
  await page.screenshot({ path: path.join(root, '.poc-out', 'ui-studio.png') });
  console.log('studio visible');
}

console.log('--- console ---');
console.log(logs.slice(-80).join('\n'));
await app.close();
