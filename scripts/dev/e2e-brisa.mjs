import { _electron as electron } from 'playwright';
import path from 'node:path';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = process.cwd();
const out = path.join(root, '.poc-out');
const profile = path.join(out, 'profile-brisa');
const outputDir = path.join(out, 'brisa-out');
const brisa = path.resolve(root, '..', 'Brisa · Vídeo de produto.html');
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

const imported = await page.evaluate(async (file) => {
  // Fail fast if the main process cannot open a native dialog in this harness;
  // the real UI path is exercised below with a stubbed dialog.
  return { path: file };
}, brisa);
console.log('target', JSON.stringify(imported));
await app.evaluate(({ dialog }, file) => {
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
}, brisa);
await page.getByRole('main').getByRole('button', { name: 'Importar HTML' }).click();
await page.waitForSelector('.studio', { timeout: 60_000 });
await page.waitForTimeout(4000);

async function desktop(name) {
  const b64 = await app.evaluate(async ({ desktopCapturer, screen }) => {
    const display = screen.getPrimaryDisplay();
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: display.size.width, height: display.size.height } });
    return sources[0]?.thumbnail.toPNG().toString('base64') ?? '';
  });
  if (b64) await fs.writeFile(path.join(out, name), Buffer.from(b64, 'base64'));
  console.log('screenshot', name);
}
await desktop('brisa-1-studio.png');

await page.locator('#export-output-dir').fill(outputDir);
await page.locator('#export-file-name').fill('brisa-8s.mp4');
await page.locator('#export-resolution').selectOption('720p');
await page.locator('#export-fps').selectOption('30');
await page.locator('#export-duration').fill('8');
await page.locator('input[name="export-quality"][value="balanced"]').check();

const started = Date.now();
await page.getByRole('button', { name: 'Exportar vídeo' }).click();
console.log('export started');

const deadline = Date.now() + 300_000;
let last = '';
while (Date.now() < deadline) {
  const text = await page.evaluate(() => document.querySelector('.sheet__scroll')?.innerText ?? '');
  if (text !== last) {
    last = text;
    const line = text.split('\n').find((l) => /%/.test(l));
    if (line) console.log('progress', ((Date.now() - started) / 1000).toFixed(1) + 's', line.trim().slice(0, 120));
  }
  if ((await page.locator('.result').count()) > 0) break;
  await page.waitForTimeout(700);
}
console.log('elapsed', ((Date.now() - started) / 1000).toFixed(1), 's');
console.log('result', await page.locator('.result').count());
const sheet = await page.evaluate(() => document.querySelector('.sheet__scroll')?.innerText ?? '');
console.log(sheet.slice(0, 2600));
await page.waitForTimeout(1500);
await desktop('brisa-2-result.png');

const files = await fs.readdir(outputDir);
console.log('files', files);
for (const file of files.filter((f) => f.endsWith('.mp4'))) {
  const full = path.join(outputDir, file);
  const { stdout } = await run(path.join(root, 'node_modules', 'ffprobe-static', 'bin', 'win32', 'x64', 'ffprobe.exe'), [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', full,
  ]);
  const info = JSON.parse(stdout);
  const video = info.streams.find((s) => s.codec_type === 'video');
  console.log('ffprobe', JSON.stringify({
    size: info.format.size, duration: info.format.duration, format: info.format.format_name,
    codec: video?.codec_name, profile: video?.profile, pixFmt: video?.pix_fmt,
    width: video?.width, height: video?.height, fps: video?.r_frame_rate, frames: video?.nb_frames,
  }, null, 2));
  await fs.mkdir(path.join(out, 'brisa-frames'), { recursive: true });
  await run(path.join(root, 'node_modules', 'ffmpeg-static', 'ffmpeg.exe'), [
    '-y', '-v', 'error', '-i', full,
    '-vf', 'select=\'eq(n\\,30)+eq(n\\,90)+eq(n\\,150)+eq(n\\,210)\',scale=640:-1',
    '-vsync', 'vfr', path.join(out, 'brisa-frames', 'frame-%02d.png'),
  ]);
}
console.log('--- console ---');
console.log(logs.slice(-40).join('\n'));
await app.close();
