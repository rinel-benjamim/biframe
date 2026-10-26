import { _electron as electron } from 'playwright';
import path from 'node:path';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = process.cwd();
const out = path.join(root, '.poc-out');
const profile = path.join(out, 'profile-e2e');
const outputDir = path.join(out, 'e2e-out');
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
await page.waitForTimeout(1200);
await page.getByRole('button', { name: 'Abrir exemplo' }).click();
await page.waitForSelector('.studio', { timeout: 60_000 });
await page.waitForTimeout(2500);

// A clean screenshot of the studio with the live view (desktop capture).
async function desktop(name) {
  const b64 = await app.evaluate(async ({ desktopCapturer, screen }) => {
    const display = screen.getPrimaryDisplay();
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: display.size.width, height: display.size.height } });
    return sources[0]?.thumbnail.toPNG().toString('base64') ?? '';
  });
  if (b64) await fs.writeFile(path.join(out, name), Buffer.from(b64, 'base64'));
  console.log('screenshot', name);
}
await desktop('e2e-1-studio.png');

await page.locator('#export-output-dir').fill(outputDir);
await page.locator('#export-file-name').fill('exemplo-e2e.mp4');
await page.locator('#export-duration').fill('3');
await page.locator('input[name="export-quality"][value="compact"]').check();

const started = Date.now();
await page.getByRole('button', { name: 'Exportar vídeo' }).click();
console.log('clicked export at', new Date().toISOString());

// Observe progress text until the result screen appears.
const progressSamples = [];
const deadline = Date.now() + 180_000;
let lastText = '';
while (Date.now() < deadline) {
  const text = await page.evaluate(() => document.querySelector('.sheet__scroll')?.textContent ?? '');
  if (text !== lastText) {
    const match = text.match(/\d+%/g);
    if (match) progressSamples.push({ t: Date.now() - started, percent: match[match.length - 1] });
    lastText = text;
  }
  const result = await page.locator('.result').count();
  if (result > 0) break;
  await page.waitForTimeout(500);
}
console.log('progress samples', JSON.stringify(progressSamples));
console.log('elapsed', ((Date.now() - started) / 1000).toFixed(1), 's');
console.log('result count', await page.locator('.result').count());
console.log('sheet text', (await page.evaluate(() => document.querySelector('.sheet__scroll')?.innerText ?? '')).slice(0, 2000));
await page.waitForTimeout(1500);
await desktop('e2e-2-result.png');

const files = await fs.readdir(outputDir).catch(() => []);
console.log('output files', files);
for (const file of files.filter((f) => f.endsWith('.mp4'))) {
  const full = path.join(outputDir, file);
  const { stdout } = await run(path.join(root, 'node_modules', 'ffprobe-static', 'bin', 'win32', 'x64', 'ffprobe.exe'), [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', full,
  ]);
  const info = JSON.parse(stdout);
  const video = info.streams.find((s) => s.codec_type === 'video');
  console.log('ffprobe', JSON.stringify({
    size: info.format.size,
    duration: info.format.duration,
    format: info.format.format_name,
    codec: video?.codec_name,
    profile: video?.profile,
    pixFmt: video?.pix_fmt,
    width: video?.width,
    height: video?.height,
    fps: video?.r_frame_rate,
    frames: video?.nb_frames,
  }, null, 2));
}

console.log('--- console ---');
console.log(logs.slice(-80).join('\n'));
console.log('state', JSON.stringify(await app.evaluate(({ BrowserWindow }) => ({
  windows: BrowserWindow.getAllWindows().map((w) => ({ id: w.id, title: w.getTitle() })),
})), null, 2));
await app.close();
