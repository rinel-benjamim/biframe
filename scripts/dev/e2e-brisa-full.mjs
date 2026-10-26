import { _electron as electron } from 'playwright';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = process.cwd();
const out = path.join(root, '.poc-out');
const profile = path.join(out, 'profile-brisa-full');
const outputDir = path.join(out, 'brisa-full-out');
const framesDir = path.join(out, 'brisa-full-frames');
const brisa = path.resolve(root, '..', 'Brisa · Vídeo de produto.html');

const inputBefore = await fs.readFile(brisa);
const inputHash = crypto.createHash('sha256').update(inputBefore).digest('hex').toUpperCase();
console.log('input', JSON.stringify({ size: inputBefore.length, sha256: inputHash }));

await fs.rm(profile, { recursive: true, force: true });
await fs.rm(outputDir, { recursive: true, force: true });
await fs.rm(framesDir, { recursive: true, force: true });
await fs.mkdir(outputDir, { recursive: true });
await fs.mkdir(framesDir, { recursive: true });

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

// The acceptance page uses Google Fonts. Remote resources are opt-in, so enable
// them explicitly before importing; this also exercises the real settings path.
await page.getByRole('button', { name: 'Definições' }).click();
await page.locator('#allow-remote').check();
await page.getByRole('button', { name: 'Estúdio' }).click();
await page.waitForTimeout(300);

await app.evaluate(({ dialog }, file) => {
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
}, brisa);
await page.getByRole('main').getByRole('button', { name: 'Importar HTML' }).click();
await page.waitForSelector('.studio', { timeout: 60_000 });
await page.waitForTimeout(5000);
console.log('project', await page.evaluate(() => document.querySelector('.project-card__name')?.textContent ?? ''));
await desktop('brisa-full-1-studio.png');

await page.locator('#export-output-dir').fill(outputDir);
await page.locator('#export-file-name').fill('brisa-completo.mp4');
await page.locator('#export-resolution').selectOption('720p');
await page.locator('#export-fps').selectOption('60');
await page.locator('#export-duration').fill('36.5');
await page.locator('input[name="export-quality"][value="high"]').check();
console.log('estimate', await page.locator('.estimate').innerText());

const started = Date.now();
await page.getByRole('button', { name: 'Exportar vídeo' }).click();
console.log('export started');

const progressSamples = [];
const deadline = Date.now() + 420_000;
let lastMessage = '';
while (Date.now() < deadline) {
  const text = await page.evaluate(() => document.querySelector('.sheet__scroll')?.innerText ?? '');
  const line = text.split('\n').find((l) => /capturar|codificar|validar|preparar|sequência/i.test(l));
  if (line && line !== lastMessage) {
    lastMessage = line;
    console.log('progress', ((Date.now() - started) / 1000).toFixed(1) + 's', line.trim().slice(0, 110));
    progressSamples.push({ t: Math.round((Date.now() - started) / 1000), text: line.trim().slice(0, 110) });
  }
  if ((await page.locator('.result').count()) > 0) break;
  if ((await page.locator('.notice[data-kind="error"]').count()) > 0) {
    console.log('error notice', await page.locator('.notice[data-kind="error"]').innerText());
    break;
  }
  await page.waitForTimeout(800);
}

console.log('elapsed', ((Date.now() - started) / 1000).toFixed(1), 's');
const resultCount = await page.locator('.result').count();
console.log('result', resultCount);
const sheet = await page.evaluate(() => document.querySelector('.sheet__scroll')?.innerText ?? '');
console.log('--- result sheet ---');
console.log(sheet.slice(0, 3500));
await page.waitForTimeout(1800);
await desktop('brisa-full-2-result.png');

const files = await fs.readdir(outputDir).catch(() => []);
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
    bitrate: info.format.bit_rate,
    codec: video?.codec_name, profile: video?.profile, pixFmt: video?.pix_fmt,
    width: video?.width, height: video?.height, fps: video?.r_frame_rate, frames: video?.nb_frames,
    colorRange: video?.color_range, colorSpace: video?.color_space,
  }, null, 2));

  const times = [2, 6, 14, 24, 31, 35.5];
  for (const time of times) {
    await run(path.join(root, 'node_modules', 'ffmpeg-static', 'ffmpeg.exe'), [
      '-y', '-v', 'error', '-ss', String(time), '-i', full,
      '-frames:v', '1', '-vf', 'scale=960:-2', path.join(framesDir, `frame-${String(time).replace('.', '_')}s.png`),
    ]);
  }
  console.log('frames extracted', await fs.readdir(framesDir));
}

const inputAfter = await fs.readFile(brisa);
const afterHash = crypto.createHash('sha256').update(inputAfter).digest('hex').toUpperCase();
console.log('input unchanged', JSON.stringify({ size: inputAfter.length, sha256: afterHash, same: afterHash === inputHash }));

const diagnostic = await app.evaluate(async ({ BrowserWindow }) => {
  const win = BrowserWindow.getAllWindows()[0];
  return { bounds: win?.getBounds(), title: win?.getTitle() };
});
console.log('window', JSON.stringify(diagnostic));
console.log('--- console tail ---');
console.log(logs.slice(-30).join('\n'));
await app.close();
