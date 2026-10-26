import { _electron as electron } from 'playwright';
import path from 'node:path';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = process.cwd();
const out = path.join(root, '.poc-out');
const profile = path.join(out, 'profile-docs');
const outputDir = path.join(out, 'docs-out');
const assets = path.join(root, 'docs', 'assets');
await fs.rm(profile, { recursive: true, force: true });
await fs.rm(outputDir, { recursive: true, force: true });
await fs.mkdir(outputDir, { recursive: true });
await fs.mkdir(assets, { recursive: true });

const app = await electron.launch({
  args: ['.'],
  cwd: root,
  env: { ...process.env, BIFRAME_USER_DATA_DIR: profile, BIFRAME_DISABLE_DEVTOOLS: '1' },
});
const page = await app.firstWindow();
const logs = [];
page.on('console', (message) => logs.push(`[${message.type()}] ${message.text()}`));
page.on('pageerror', (error) => logs.push(`[pageerror] ${error.message}`));

try {
  await page.waitForSelector('.app', { timeout: 60_000 });
  await page.waitForTimeout(1200);

  // The live preview is a `WebContentsView`, a real child window that a page
  // screenshot cannot see. The documentation shots are therefore captured as
  // whole windows, with the window stretched past the display so the panels
  // below the fold appear too.
  async function shoot(name, height) {
    await app.evaluate(
      ({ BrowserWindow }, target) => {
        const window = BrowserWindow.getAllWindows()[0];
        if (!window) return;
        const [width] = window.getSize();
        window.setSize(width, target);
      },
      height,
    );
    await page.waitForTimeout(1600);
    const b64 = await app.evaluate(async ({ desktopCapturer, BrowserWindow }, target) => {
      const window = BrowserWindow.getAllWindows()[0];
      const [width, windowHeight] = window ? window.getSize() : [1366, target];
      const sources = await desktopCapturer.getSources({
        types: ['window'],
        thumbnailSize: { width, height: windowHeight },
      });
      const source = sources.find((item) => item.name.startsWith('Biframe')) ?? sources[0];
      return source?.thumbnail.toPNG().toString('base64') ?? '';
    }, height);
    if (!b64) throw new Error('window capture returned no data for ' + name);
    await fs.writeFile(path.join(assets, name), Buffer.from(b64, 'base64'));
    console.log('wrote docs/assets/' + name, height);
  }

  await page.getByRole('button', { name: 'Abrir exemplo' }).click();
  await page.waitForSelector('.studio', { timeout: 60_000 });
  await page.locator('.stage__live[data-live="true"]').waitFor({ state: 'visible', timeout: 60_000 });
  await page.waitForTimeout(2500);
  await shoot('studio.png', 1100);

  // Export under a normal-sized window: a window taller than the display
  // costs the compositor real time, and the capture rate must reflect an
  // ordinary session rather than the screenshot rig.
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window) window.setSize(1366, 768);
  });
  await page.waitForTimeout(800);

  await page.locator('#export-output-dir').fill(outputDir);
  await page.locator('#export-file-name').fill('exemplo-documentacao.mp4');
  // Automatic duration, exactly like the sheet in the README describes: the
  // page declares its own length and the export stops there.
  await page.getByRole('button', { name: 'Automática' }).click();
  await page.waitForTimeout(300);
  console.log('estimate', await page.locator('.estimate').innerText());

  await page.getByRole('button', { name: 'Exportar vídeo' }).click();
  await page.locator('.result').waitFor({ state: 'visible', timeout: 240_000 });
  await page.waitForFunction(
    "Array.from(document.querySelectorAll('.filmstrip img')).length === 5 && Array.from(document.querySelectorAll('.filmstrip img')).every((image) => image.complete && image.naturalWidth > 0)",
    undefined,
    { timeout: 60_000 },
  );
  await page.waitForTimeout(1500);
  await shoot('result.png', 1283);

  const outputPath = path.join(outputDir, 'exemplo-documentacao.mp4');
  const ffprobe = path.join(root, 'node_modules', 'ffprobe-static', 'bin', 'win32', 'x64', 'ffprobe.exe');
  const { stdout } = await run(ffprobe, [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', outputPath,
  ]);
  const info = JSON.parse(stdout);
  const video = info.streams.find((stream) => stream.codec_type === 'video');
  const stat = await fs.stat(outputPath);
  console.log('output', JSON.stringify({
    duration: info.format.duration,
    size: stat.size,
    codec: video?.codec_name,
    profile: video?.profile,
    pixFmt: video?.pix_fmt,
    width: video?.width,
    height: video?.height,
    fps: video?.r_frame_rate,
    frames: video?.nb_frames,
  }));
} finally {
  await app.close().catch(() => undefined);
}
