import { _electron as electron } from 'playwright';
import path from 'node:path';
import fs from 'node:fs/promises';

const root = process.cwd();
const out = path.join(root, '.poc-out');
const profile = path.join(out, 'profile-flows');
const outputDir = path.join(out, 'flows-out');
await fs.rm(profile, { recursive: true, force: true });
await fs.rm(outputDir, { recursive: true, force: true });
await fs.mkdir(outputDir, { recursive: true });

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
await page.waitForTimeout(1000);

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
  console.log('screenshot', name);
}

async function waitForResult(timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await page.locator('.result').count()) > 0) return true;
    await page.waitForTimeout(500);
  }
  return false;
}

await page.getByRole('button', { name: 'Abrir exemplo' }).click();
await page.waitForSelector('.studio', { timeout: 60_000 });
await page.waitForTimeout(1500);

await page.locator('#export-output-dir').fill(outputDir);
await page.locator('#export-file-name').fill('fluxo.mp4');
await page.locator('#export-resolution').selectOption('720p');
await page.locator('#export-fps').selectOption('30');
await page.locator('#export-duration').fill('2');
await page.locator('input[name="export-quality"][value="compact"]').check();

console.log('--- first export ---');
await page.getByRole('button', { name: 'Exportar vídeo' }).click();
const first = await waitForResult();
console.log('first result', first);
const firstStat = await fs.stat(path.join(outputDir, 'fluxo.mp4')).catch(() => null);
console.log('first file', firstStat && { size: firstStat.size, mtimeMs: firstStat.mtimeMs });

console.log('--- back to studio ---');
await page.getByRole('main').getByRole('button', { name: 'Estúdio' }).click();
await page.waitForSelector('.studio', { timeout: 30_000 });
await page.waitForTimeout(800);

console.log('--- second export (expect conflict) ---');
await page.getByRole('button', { name: 'Exportar vídeo' }).click();
await page.waitForSelector('text=Já existe um ficheiro com este nome', { timeout: 30_000 });
console.log('conflict notice visible');
await desktop('flows-1-conflict.png');
const before = await fs.stat(path.join(outputDir, 'fluxo.mp4'));

console.log('--- overwrite ---');
await page.getByRole('button', { name: 'Substituir ficheiro' }).click();
const second = await waitForResult();
console.log('second result', second);
await page.waitForTimeout(1200);
const after = await fs.stat(path.join(outputDir, 'fluxo.mp4')).catch(() => null);
console.log('file after overwrite', after && { size: after.size, mtimeMs: after.mtimeMs });
console.log('replaced', Boolean(after) && after.mtimeMs !== before.mtimeMs);

console.log('--- cancel flow ---');
await page.getByRole('main').getByRole('button', { name: 'Estúdio' }).click();
await page.waitForSelector('.studio', { timeout: 30_000 });
await page.locator('#export-file-name').fill('cancelado.mp4');
await page.locator('#export-duration').fill('30');
await page.locator('#export-resolution').selectOption('1080p');
// Start, wait until capture has begun, then cancel.
await page.getByRole('button', { name: 'Exportar vídeo' }).click();
await page.waitForSelector('button:has-text("Cancelar renderização")', { timeout: 30_000 });
await page.waitForTimeout(2500);
const progressText = await page.evaluate(() => document.querySelector('.export__progress')?.innerText ?? '');
console.log('progress before cancel', JSON.stringify(progressText.slice(0, 300)));
await desktop('flows-2-capturing.png');
await page.getByRole('button', { name: 'Cancelar renderização' }).click();
await page.waitForSelector('text=Renderização cancelada', { timeout: 30_000 });
console.log('cancel notice visible');
await page.waitForTimeout(1000);
const cancelFile = await fs.stat(path.join(outputDir, 'cancelado.mp4')).catch(() => null);
console.log('cancelled file exists', Boolean(cancelFile));
console.log('view still studio', (await page.locator('.studio').count()) > 0);
console.log('export button available', (await page.getByRole('button', { name: 'Exportar vídeo' }).count()) > 0);
await desktop('flows-3-cancelled.png');
const sheetText = await page.evaluate(() => document.querySelector('.sheet__scroll')?.innerText ?? '');
console.log('sheet after cancel', JSON.stringify(sheetText.slice(0, 900)));

console.log('--- console tail ---');
console.log(logs.slice(-30).join('\n'));
await app.close();
