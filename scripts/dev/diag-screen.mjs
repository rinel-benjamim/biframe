import { _electron as electron } from 'playwright';
import path from 'node:path';
import fs from 'node:fs/promises';

const root = process.cwd();
const out = path.join(root, '.poc-out');
const profile = path.join(out, 'profile-screen');
await fs.rm(profile, { recursive: true, force: true });
await fs.mkdir(out, { recursive: true });
const app = await electron.launch({
  args: ['.'],
  cwd: root,
  env: { ...process.env, BIFRAME_USER_DATA_DIR: profile, BIFRAME_DISABLE_DEVTOOLS: '1' },
});
const page = await app.firstWindow();
await page.waitForSelector('.app', { timeout: 60_000 });
await page.waitForTimeout(2500);

async function desktop(name) {
  const b64 = await app.evaluate(async ({ desktopCapturer, screen }) => {
    const display = screen.getPrimaryDisplay();
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: display.size.width, height: display.size.height },
    });
    return sources[0]?.thumbnail.toPNG().toString('base64') ?? '';
  });
  if (b64) await fs.writeFile(path.join(out, name), Buffer.from(b64, 'base64'));
  console.log('desktop', name, b64.length);
}

await desktop('screen-empty.png');
await page.getByRole('button', { name: 'Abrir exemplo' }).click();
await page.waitForSelector('.studio', { timeout: 60_000 });
await page.waitForTimeout(5000);
await desktop('screen-studio.png');
await app.close();
